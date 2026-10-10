# Location Tree MVP 设计合同(issue #18)

本文是 issue #18(Location Tree MVP:从文本位置到可浏览家庭空间)的实现设计合同,落地到字段、action、错误码与测试点。实现分支 `feat/issue-18-location-tree`(基于 `origin/main`)。

依据的现行实现(均已在开工时通读):
- `cloudfunctions/itemsApi/index.js:21-24`(household_id 派生: `"hh_" + sha256(openid).slice(0,32)`)、`index.js:35-59`(薄胶水层,身份只取 `cloud.getWXContext().OPENID`)
- `cloudfunctions/itemsApi/lib/handler.js:275-309`(update 乐观并发:条件更新 `version === expected_version`,0 命中后回查区分 VERSION_CONFLICT / NOT_FOUND)、`handler.js:297-307`(update_id 重放识别三重条件:版本恰为 expected+1、last_update_id 相同、last_update_fingerprint 一致)、`handler.js:67-75`(changesFingerprint)、`handler.js:81-85,196-216`(E11000 并发兜底)、`handler.js:316-328`(软删除抹空内容)、`handler.js:335-352`(fetchActiveItems 分页拉全量)、`handler.js:459-478`(日志只记 action/error/ms/count)
- `cloudfunctions/extractDraft/index.js:18-32`(DEEPSEEK_API_KEY 只走环境变量,缺失返回 AI_UNAVAILABLE)、`lib/handler.js:19-57`(SYSTEM_PROMPT 组织与【用户输入】标记)、`lib/handler.js:103-116`(坏 JSON 带错误重试一次)、`lib/validate.js:44-61`(容忍 markdown 围栏的 JSON 提取)、`lib/validate.js:117-122`(certain=false 强制空位置的幻觉防护)、`lib/deepseek.js:16-38`(deepseek-flash、temperature 0.1、thinking disabled、response_format json_object)
- `cloudfunctions/itemsApi/lib/normalize.js:30-42`(normalizeName)
- 前端:`miniprogram/pages/index/index.ts:32-89`(Page 双泛型写法)、`miniprogram/pages/confirm/confirm.ts:24,46-51,119-125`(operation_id 幂等键)、`miniprogram/utils/api.ts`(类型化云函数封装)、`miniprogram/types.ts`、`miniprogram/app.wxss:2-58`(CSS 变量清单)、`miniprogram/app.json:2-6`(页面注册)
- 测试:`tests/helpers/memoryDb.js:60-75`(唯一索引 E11000 模拟)、`tests/itemsApi.test.js:19-20,222-245`(双 household 交叉越权)、`tests/extractDraft.test.js`(mock callLLM 驱动 handler)

---

## 0. 目标与不动量

### 验收标准 → 设计映射

| issue #18 验收标准 | 本设计的落实 |
| --- | --- |
| 1. 已有自然语言位置可稳定生成树结构 | `scanHousehold` 批量解析 + 向导逐支确认入库(§5.9、§7.3) |
| 2. 用户可以浏览房间 → 家具 → 容器 → 物品 | `list` action + `pages/locations` 逐层下钻,节点页=子节点+该层物品(§5.1、§7.1) |
| 3. 编辑位置不会破坏历史记录 | 节点编辑**绝不改写** items 的 `location_text`/`name`/`note`;挂载变更走 items 既有版本链(§5.5-5.8、§6.3) |
| 4. AI 不确定时必须请求确认,而不是自动创建错误空间 | `parseLocation`/`scanHousehold` **零写库**;只有 `ensurePath` 能建节点且只由用户确认后的客户端调用;低置信段强制 `need_confirm=true`(§6.4) |

### 明确不动量(防回归)

- `cloudfunctions/itemsApi` 与 `cloudfunctions/extractDraft` 代码**零改动**(README 部署章节增补除外,见 §11);录入链路(首页 → extractDraft → 确认页 → itemsApi.create)行为不变。
- items 既有字段语义不变;`itemsApi` 的投影 `project()`(`handler.js:128-137`)不变,旧客户端无感知。
- 「一句话多件拆分」(issue #14)链路不变。

### MVP 之外(明确划出)

- **语音修改位置**(issue Phase 3 的语音入口):后续设计,本 MVP 只做页面操作。
- 户型图建模、AR 定位、自动收纳规划、视频空间扫描(issue 明确排除)。
- 多家庭/家庭共享(现行合同「一个微信用户等于一个私人家庭空间」不变)。
- 节点排序自定义、节点图标、物品在节点间的拖拽手势。
- 录入确认页(pages/confirm)内嵌挂载:记一件的保存链路保持 3 步不变,挂载由事后操作(详情页「挂到空间」/批量向导)完成。理由:保存是核心链路,不叠加第二次 LLM 延迟与失败面;`parseLocation` 的单条入口放在物品详情页(§7.4)。

---

## 1. 数据模型

### 1.1 `locations` 集合(新集合)

文档结构(全部字段必填,除特别注明):

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | `"lc_" + genId()`(24 hex,同 itemsApi `index.js:53` 的 genId 形态),对外投影为 `location_id` |
| `household_id` | string | 服务端派生,客户端不可见不可传 |
| `parent_id` | string | 父节点 `_id`;home 根节点为空字符串 `""`(根哨兵) |
| `name` | string | 去首尾空白后 1-30 字(码点) |
| `name_norm` | string | `normalizeName(name)`,与 itemsApi 同款算法(副本见 §4.2) |
| `type` | string | 枚举 `"home" \| "room" \| "furniture" \| "container"` |
| `path` | string[] | 从根(不含 home 根)到本节点(含)的名字数组;home 根为 `[]`;例:桌子节点 `["书房"]`,抽屉节点 `["书房","桌子","右边第二个抽屉"]` |
| `created_from` | string | 枚举 `"bootstrap"`(home 根)|`"scan"`(向导)|`"parse"`(单条解析)|`"manual"`(页面手建);merge 不产生新节点故无此来源 |
| `created_at` / `updated_at` | string | ISO 字符串,`deps.now()` |

**home 根节点**:每个 household 恰一个,type=`"home"`,name 固定 `"我的家"`,`path=[]`、`parent_id=""`。由 `ensurePath`/首次 `list` 惰性创建(`created_from:"bootstrap"`);**不可改名、不可移动、不可合并、不可删除**(服务端对这些操作校验 type 后拒绝,错误码 `INVALID_INPUT`)。物品不允许直接挂在 home 根上(`linkItem` 校验 type≠home)。统一「非根节点必有父」的语义,节点页与面包屑有稳定锚点。

**深度约束**:`path.length` ∈ [1,6](1=room,2=furniture,≥3=container;container 允许嵌套,如「抽屉里的盒子」,封顶 6 层防失控)。

**删除语义:硬删除**。与 items 的软删除不同,理由:(a) items 软删除是为 operation_id 重放与内容抹空;位置节点的「历史」由 items 的 `location_text` 原始话语承载,节点只是派生结构;(b) 软删除会占据 `(household_id, parent_id, name_norm)` 唯一索引槽位,导致「删掉书房后无法重建书房」;(c) 删除有空节点保护(§5.7),无悬挂挂载。配套不变量:**任何未删除 item 的 `location_node_id` 必指向存在的节点**(由删除保护 + merge 先重挂载保证,见各 action 与测试点 TS-INV)。

**唯一索引(人工步骤,写进 PR 描述与 README)**:`locations` 集合 → 索引管理 → 组合唯一索引 `household_id`(升序)+ `parent_id`(升序)+ `name_norm`(升序)。作用:并发同名兄弟创建时数据库层兜底,`ensurePath` 捕获 E11000 后回查复用(照抄 itemsApi `handler.js:196-216` 的模式)。home 根唯一性由该索引自然覆盖(`("", 我的家norm)` 每 household 唯一)。

**权限(人工步骤)**:`locations` 集合 → 权限设置 → 「所有用户不可读不可写」。理由同 README 部署步骤 4②(`docs/security-evidence.md` 证据 1:默认权限实测可被任意客户端直读)。

### 1.2 `items` 集合(增量,不改既有字段)

- 新增**可空**字段 `location_node_id`:string | 缺失。缺失/null = 未挂载。旧文档无此字段,读侧按缺失处理。
- **唯一写入方是 locations 云函数**(`linkItem`/`unlinkItem`/merge 重挂载);itemsApi 对该字段一律忽略(其 update 只组装 name/location_text/note 的 `changes`,见 `handler.js:239-260`,天然不触碰未知字段;投影亦不含它)。
- 挂载不影响 `location_text`:用户的原始话语(「书房桌子右边第二个抽屉的蓝色盒子」)是不可变历史,树挂载是它的结构化投影。物品删除(`deleteItem`)不清理 `location_node_id`(文档已 deleted,挂载计数永远过滤 `deleted:false`,不可见即无害)。

---

## 2. 身份、隔离与日志红线(全 action 统一)

- **身份**:`cloudfunctions/locations/index.js` 照抄 `cloudfunctions/itemsApi/index.js:35-59` 胶水层——`cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })`;只取 `cloud.getWXContext().OPENID`,缺失返回 `UNAUTHORIZED`;`household_id = "hh_" + sha256(openid).slice(0,32)`(与 itemsApi 完全同款,保证两函数落到同一家庭);event 里任何身份字段(household_id/openid)一律忽略不读。
- **隔离**:locations 的每一次读写(where 条件)都必须带 `household_id: deps.householdId`;对 items 的读写同样带(items 文档本就有 household_id)。跨家庭访问统一表现为 `NOT_FOUND`(与 itemsApi `handler.js:222-245` 越权测试语义一致)。
- **日志红线**:沿用 itemsApi `logResult`(`handler.js:459-478`)——entry 只含 `{ action, error, ms, count }`;LLM 类 action 额外只记 `{ text_length, items_scanned, chunks, elapsed_ms, error }`。**绝不记录**:用户原文、物品名、位置名、path、prompt 内容、LLM 原始输出、任何身份字段。密钥 `DEEPSEEK_API_KEY` 只从云函数环境变量读取(`extractDraft/index.js:18-28` 同款),缺失时 LLM 类 action 返回 `AI_UNAVAILABLE` 且 `manual_fallback:true`,绝不打印 key。

---

## 3. 错误码(固定 7 个,全部附中文 message)

| 错误码 | 中文 message | 触发场景 |
| --- | --- | --- |
| `INVALID_INPUT` | 输入不合法,请检查后重试 | 未知 action、字段缺失/超长/类型错误、对 home 根的非法编辑、路径超 6 层 |
| `NOT_FOUND` | 没有找到这个位置 | 节点不存在 / 跨家庭 / 已删;linkItem 的物品不存在或跨家庭 |
| `UNAUTHORIZED` | 请先登录 | OPENID 缺失(index.js 层) |
| `VERSION_CONFLICT` | 物品内容已被修改,已为你刷新,请重试 | linkItem/unlinkItem 的 expected_version 不匹配且非重放 |
| `NODE_NOT_EMPTY` | 这里还有东西,先移走物品和子位置才能删除 | delete 保护(含 force 下子树仍有物品) |
| `NODE_CONFLICT` | 目标位置已有同名节点,或不能移动到自己下面 | rename/move 撞同级同名;move 到自身后代;merge 双方有同名子节点;merge 自己到自己 |
| `AI_UNAVAILABLE` | AI 暂时不可用,可稍后重试或手动选择位置 | LLM 调用失败/超时/输出校验两次失败;附 `manual_fallback:true` |

统一响应形态与 itemsApi 相同:`{ ok:true, ... }` 或 `{ ok:false, error:CODE, message }`。基础设施异常照抄 itemsApi `handler.js:498-503`:记日志(仅 action/error/ms)后原样上抛,绝不静默、绝不假装业务成功。

---

## 4. 云函数结构:`cloudfunctions/locations/`

```
cloudfunctions/locations/
  index.js        # 胶水层:照抄 itemsApi/index.js + DEEPSEEK_API_KEY 检查(仅 LLM action 需要)
  config.json     # { "timeout": 60 }
  package.json    # 除 wx-server-sdk 外零依赖
  lib/
    handler.js    # action 路由 + db 类 action(list/ensurePath/rename/move/merge/delete/linkItem/unlinkItem)
    parse.js      # LLM 类 action 编排(parseLocation/scanHousehold:prompt 构造、分块、重试一次)
    validate.js   # LLM 输出 schema 校验(parseLocation/scanHousehold 共用)
    tree.js       # 纯函数:子树收集、path 级联重写、同级同名校验、深度计算
    normalize.js  # 与 cloudfunctions/itemsApi/lib/normalize.js 逐字节同源的副本
    deepseek.js   # 与 cloudfunctions/extractDraft/lib/deepseek.js 逐字节同源的副本
```

- **为什么复制而不共享**:微信云函数是独立部署单元,`require("../itemsApi/...")` 在云端部署后目录不存在。仓库先例:transcribe 自带 `lib/tc3.js`、itemsApi 自带 `lib/normalize.js`。两个副本文件头注释标明「与 XXX 同源,修改须双向同步」,测试里加同源校验(§9 TS-SRC:逐字节比对两份文件)。
- **deps 注入**(离线可测的关键):`handler(event, deps)`,`deps = { db, now(), genId(), householdId, logger, callLLM? }`。`callLLM` 仅 LLM 类 action 使用;离线测试注入 mock(照抄 `tests/extractDraft.test.js` 的 `seqMock`/`mockFromSample` 形态)。db 类 action 不依赖 callLLM,未注入也可测。
- **items 分页拉取**:照抄 `fetchActiveItems`(`itemsApi/handler.js:335-352`)的 skip/limit 逐页模式与 MAX_PAGES 护栏,落在 locations/lib/handler.js(scan、list 的挂载物品统计都要全量)。

---

## 5. action 契约(逐个)

通用:event = `{ action, ... }`;所有节点 id 参数(`parent_id`/`node_id`/`source_node_id`/`target_node_id`)均为 `location_id`(即 locations 文档 `_id`);物品 id 为 items 文档 `_id`。

### 5.1 `list` —— 树浏览(纯读)

- **请求**:`{ action:"list", parent_id?: string }`。省略/空串 = home 根(房间层)。
- **语义**:返回 parent 节点(或根)的直接子节点与**直接挂载**于该节点的未删物品。`item_count` 为**整棵子树**(该节点自身+全部后代)挂载的未删物品数,child_count 为直接子节点数——两个计数都需全量拉 nodes 与 items 后在内存计算(家庭规模下可行,与 itemsApi query 的内存匹配模式同构)。
- **home 根惰性创建**:请求根层且 home 根不存在时,先创建 home 根(`created_from:"bootstrap"`),再查子节点(通常为空列表)。这是唯一会在 `list` 里发生的写,幂等(唯一索引 + E11000 回查复用)。
- **响应**:
```json
{ "ok": true,
  "node": { "location_id":"lc_..", "name":"我的家", "type":"home", "path":[], "item_count":12, "child_count":3, "created_from":"bootstrap", "updated_at":".." },
  "children": [ { "location_id":"lc_..", "name":"书房", "type":"room", "path":["书房"], "item_count":5, "child_count":2, "created_from":"scan", "updated_at":".." } ],
  "items": [ { "item_id":"it_..", "name":"..", "location_text":"..", "note":"..", "version":3, "updated_at":".." } ] }
```
  根层请求时 `node` 即 home 根;`children` 按 item_count 降序、同名按 name 升序;`items` 按 updated_at 降序。parent 不存在/跨家庭 → `NOT_FOUND`。
- **错误码**:NOT_FOUND。

### 5.2 `parseLocation` —— 单条位置文本 → 层级候选(LLM,零写库)

- **请求**:`{ action:"parseLocation", text }`,text 去空白后 1-200 字(与 items.location_text 同限)。
- **语义**:服务端自取该家庭既有树(≤120 节点,超出只送前两层)序列化进 prompt;LLM 输出层级分段 + 每段置信度 + 与既有同级同名/近义节点的合并建议。**本 action 绝不写库**(测试 TS-NC1 断言两个集合文档数不变)。
- **响应**:
```json
{ "ok": true,
  "parse": {
    "segments": [ { "name":"书房", "type":"room", "confidence":0.95 }, { "name":"桌子", "type":"furniture", "confidence":0.9 }, { "name":"右边第二个抽屉", "type":"container", "confidence":0.6 } ],
    "need_confirm": true,
    "merge_suggestions": [ { "segment_index":0, "existing_location_id":"lc_..", "existing_name":"书房", "reason":"同名" } ] } }
```
- **服务端校验与修正**(validate.js,规则可执行):
  - JSON 提取容忍围栏/前后废话(照抄 `extractDraft/lib/validate.js:44-61`);解析失败带错误重试一次,仍失败 `AI_UNAVAILABLE`(照抄 `handler.js:103-116`)。
  - segments 数组 1-6 项;name 去空白 1-30 字;confidence ∈ [0,1];type 必须按深度映射(depth1=room、depth2=furniture、depth≥3=container),不符即修正为按深度映射的类型(仅此一处允许修正,其余一律拒绝)。
  - **锚定校验**:`normalizeName(seg.name)` 必须是 `normalizeName(text)` 的子串,否则该段强制视为不可信(见下)。这是「位置必须来自原文」的服务端兜底(比 extractDraft 更强,因为分段天然是原文切片)。
  - merge_suggestions 中的 existing_location_id 必须属于本家庭且存在,否则**丢弃该条**(不失败);`reason` 由模型给出(「同名」/「近义」),服务端对 name_norm 完全相等的同级节点自动补全同名建议(不依赖模型)。
  - **need_confirm 置真规则(任一即真)**:任一段 confidence < 0.8(服务端常量 `SEGMENT_CONFIDENT_MIN`);或任一段未通过锚定校验且无 merge_suggestion 覆盖;或模型自报不确定。need_confirm=true 时该响应只是候选,客户端必须让用户核对后才可进入 ensurePath。confidence ≥ 阈值也仍是草稿(全流程只有用户点保存才算确认),UI 上低置信段标黄强调。
- **错误码**:INVALID_INPUT、AI_UNAVAILABLE。

### 5.3 `ensurePath` —— 确认后沿路径建缺失节点(唯一建节点的入口,幂等)

- **请求**:`{ action:"ensurePath", path: ["书房","桌子","右边第二个抽屉"], created_from: "scan"|"parse"|"manual" }`。path 1-6 段,每段去空白 1-30 字;created_from 缺省 `"manual"`。
- **语义**:先确保 home 根存在;自根逐段下钻:查 `(household_id, parent_id, name_norm)` 命中即复用,未命中则创建(type 按深度映射,path = 父 path + name)。**只创建,不改任何已存在节点,不碰 items**。
- **幂等**:按路径天然幂等——同一 path 重复调用返回相同节点序列,第二段起 `created:false`。并发同名竞态:唯一索引拒绝第二笔插入,捕获 E11000(识别逻辑照抄 `itemsApi/handler.js:81-85`)后回查复用,绝不双建。无需 operation_id(路径本身就是幂等键)。
- **响应**:`{ ok:true, nodes:[LocationNodeSummary...], created:[true,false,false] }`(nodes 与 path 等长,含复用节点;LocationNodeSummary 字段同 list.children)。
- **错误码**:INVALID_INPUT(path 层数/长度/类型不符)。

### 5.4 `rename` —— 节点改名(path 级联)

- **请求**:`{ action:"rename", node_id, name }`。
- **校验**:node 存在且属本家庭(否则 NOT_FOUND);type≠home(否则 INVALID_INPUT);新名去空白 1-30 字;**同级重名检查**——同一 parent 下其他子节点 name_norm 相同 → `NODE_CONFLICT`。
- **级联**:更新本节点 name/name_norm/updated_at,并把本节点与**全部后代**的 path 逐个重写(后代 path 中本节点位置的名字替换;tree.js 收集子树:`parent_id` 链全量拉取后内存过滤)。节点文档无版本号,级联为无条件批量 update(where deleted 不适用——硬删除,where `_id in ids`;memoryDb 逐条 update 亦可,实现以批量等价为准)。
- **不碰 items**:物品的 location_text 保持原始话语;挂载关系(location_node_id)引用的是节点 id,改名不影响。
- **响应**:`{ ok:true, node: LocationNodeSummary }`(更新后)。
- **错误码**:INVALID_INPUT、NOT_FOUND、NODE_CONFLICT。

### 5.5 `move` —— 节点移动(path 级联)

- **请求**:`{ action:"move", node_id, new_parent_id }`。
- **校验**:两节点存在且属本家庭(NOT_FOUND);node type≠home、new_parent type≠home(INVALID_INPUT);new_parent 不是 node 自身及其后代(否则 `NODE_CONFLICT`,message「不能移动到自己下面」);新家同级无 name_norm 重名(`NODE_CONFLICT`);移动后 node 子树最大深度 ≤ 6(否则 INVALID_INPUT,message「层级太深了」)。
- **级联**:node.parent_id 更新 + node 与全部后代 path 整体重写(新前缀 = new_parent.path + [node.name])。不碰 items。
- **响应**:`{ ok:true, node: LocationNodeSummary }`。
- **错误码**:INVALID_INPUT、NOT_FOUND、NODE_CONFLICT。

### 5.6 `merge` —— 合并重复节点(物品重挂载,不破坏版本链)

- **请求**:`{ action:"merge", source_node_id, target_node_id }`。
- **校验**:两节点存在且属本家庭;source ≠ target(`NODE_CONFLICT`);二者 type 相同(否则 INVALID_INPUT,message「只能合并同类型的位置」);target 不是 source 的后代(否则 NODE_CONFLICT);**source 的直接子节点与 target 的直接子节点无 name_norm 重名**(有则 `NODE_CONFLICT`,响应附 `detail:{ clashing_names:[..] }` 供客户端展示——名称出现在响应里合法,出现在日志里违规)。
- **执行顺序**:
  1. source 的直接子节点 parent_id 改指 target(其自身及后代 path 重写)。source 后代节点**id 不变**,因此挂在后代上的物品无需任何改动——这是「merge 级联不破坏版本链」的关键。
  2. **直接挂在 source 上的物品重挂载到 target**:对每件物品做 `location_node_id = target._id`、`version = version+1`、`updated_at = deps.now()`(服务端读当前版本后无条件 +1:merge 是用户显式确认的结构性操作,逐件 expected_version 会使 merge 无法操作;版本 +1 保证持有旧版本的客户端下次保存收到 VERSION_CONFLICT 并刷新,绝不静默丢修改——与 itemsApi 语义自洽)。
  3. 硬删除 source 节点。
- **不破坏历史**:items 的 name/location_text/note 一字不动;重挂载只动 location_node_id 与版本元数据。
- **响应**:`{ ok:true, node: LocationNodeSummary(target 更新后), remounted: 2 }`(重挂载物品数)。
- **错误码**:INVALID_INPUT、NOT_FOUND、NODE_CONFLICT。
- **已知取舍(记入开放风险)**:步骤 2 与用户并发编辑同一物品时,后提交者按既有 VERSION_CONFLICT 语义被拒,无数据丢失;merge 本身非事务,中途基础设施异常会留下部分完成的级联(子节点已移、物品未挂),但不变量「未删物品的 location_node_id 指向存在节点」不破(物品只会在 source 被删前完成重挂;若在步骤 2 与 3 之间异常,source 仍在,挂载仍有效,重试 merge 幂等完成)。

### 5.7 `delete` —— 删除节点(空节点保护)

- **请求**:`{ action:"delete", node_id, force?: boolean }`。
- **校验与语义**:
  - node 存在且属本家庭;type≠home(否则 INVALID_INPUT)。
  - 统计子树(自身+后代)挂载的未删物品数 `item_count`、后代节点数 `descendant_count`。
  - `force` 缺省/false:`item_count > 0 || descendant_count > 0` → `NODE_NOT_EMPTY`(响应附 `detail:{ item_count, descendant_count }`,客户端展示「这里还有 N 件物品、M 个子位置」)。
  - `force=true`(用户在 UI 二次确认后):若子树内**仍有任何未删物品** → 依旧 `NODE_NOT_EMPTY`(物品永远不能被结构操作丢弃,必须先移走);无物品但有空的后代分支 → 允许删除,整支空分支一并硬删除。
- **响应**:`{ ok:true, deleted_nodes: 3 }`(含自身)。
- **错误码**:INVALID_INPUT、NOT_FOUND、NODE_NOT_EMPTY。
- 不变量保障:有物品挂载的节点删不掉 → 不存在悬挂 location_node_id。

### 5.8 `linkItem` / `unlinkItem` —— 物品挂载/摘除(复用 items 版本机制)

核心决策:**不绕开、不另造** items 的版本不变量,也不让 itemsApi 感知树。两 action 对 items 文档执行的更新与 `itemsApi.update`(`handler.js:275-309`)完全同构——同一版本计数器、同一 last_update_id/last_update_fingerprint 回写、同一三重条件重放识别——实现为 locations/lib/handler.js 内的同语义代码(云函数间无法共享模块,副本纪律同 §4.2),fingerprint 用同款 changesFingerprint 算法(键排序 JSON,`handler.js:67-75`)、仅覆盖 `{ location_node_id }`。**单一版本链原则:一件物品一个 version,itemsApi 与 locations 两个写入方都条件更新它,任何一方过期即 VERSION_CONFLICT。** 交叉完整性由离线测试在同一 memoryDb 上同时驱动两个 handler 验证(§9 TS-LK3)。

- **`linkItem` 请求**:`{ action:"linkItem", item_id, node_id, expected_version, update_id }`;**`unlinkItem` 请求**:`{ action:"unlinkItem", item_id, expected_version, update_id }`。
  - `expected_version`:正整数;`update_id`:非空 ≤64(客户端每次逻辑操作生成 uuid,失败重试同内容复用——照抄 `pages/item/item.ts:36-44` 的 pendingRetry 语义)。
- **校验**:node 存在、属本家庭、type≠home(NOT_FOUND/INVALID_INPUT);item 存在、属本家庭、deleted=false(否则 NOT_FOUND);item 当前 `location_node_id` 已等于 node_id 且版本匹配 → 视为内容变化仅版本元数据的正常更新(照常 +1;不做「无变化短路」,保持与 itemsApi.update 相同语义)。
- **执行**:条件更新 `where({ _id:item_id, household_id, deleted:false, version:expected_version })` 置 `{ location_node_id: node_id(或 null), version: expected_version+1, updated_at, last_update_id, last_update_fingerprint }`。命中 → `{ ok:true, item:{ item_id, version, updated_at } }`。0 命中 → 回查(同 itemsApi):三重条件(版本恰为 expected+1、last_update_id 相同、fingerprint 相同)成立 → `{ ok:true, replayed:true, item }`;存在但条件不符 → `VERSION_CONFLICT`;不存在/已删/跨家庭 → `NOT_FOUND`。
- **错误码**:INVALID_INPUT、NOT_FOUND、VERSION_CONFLICT。
- 并发竞态说明:linkItem 校验节点存在与写 items 之间节点被删的窗口,被 delete 的物品计数保护封死(delete 前必先移走物品,移走即 unlink 修改 version,linkItem 的条件更新自然失效),不变量闭环。

### 5.9 `scanHousehold` —— Phase 1 整户扫描(纯草案,零写库)

- **请求**:`{ action:"scanHousehold" }`。
- **语义**:拉取本家庭未删物品(updated_at 降序,上限 **30** 件、且 location_text 非空);分块(每块 10 件)调 LLM,每块返回逐件的层级分段;服务端合并分段成**整棵候选树** + **逐件挂载草案**;与既有树比对生成合并提示。**绝不写库**(TS-NC2 断言)。
- **LLM 编排**:每块独立 prompt(含【既有空间树】上下文,同 parseLocation);单块超时 15s;任一块失败整体返回 `AI_UNAVAILABLE`(不部分成功——草案必须完整才好确认;响应无半成品)。
- **响应**:
```json
{ "ok": true, "scan": {
  "scanned": 30, "total_items": 47, "truncated": true,
  "candidate_tree": [ { "name":"书房", "type":"room", "confidence":0.9, "need_confirm":false, "children":[ { "name":"桌子", "type":"furniture", "confidence":0.85, "need_confirm":false, "children":[ "..container.." ] } ] } ],
  "mounts": [ { "item_id":"it_..", "name":"充电宝", "location_text":"书房桌子右边第二个抽屉", "version":3, "path":["书房","桌子","右边第二个抽屉"], "confidence":0.8, "need_confirm":false } ],
  "skipped": [ { "item_id":"it_..", "name":"护照", "reason":"位置为空" } ] } }
```
  - candidate_tree 由服务端从全部 mounts 的 segments 归并生成(同层 name_norm 去重),**结构一致性由构造保证**,不依赖模型自洽。
  - mounts 带该物品**当前 version**,供向导提交时作为 linkItem 的 expected_version(提交时冲突 → 跳过并如实报告,绝不静默覆盖)。
  - skipped:位置为空(certain=false 录入)或分段为空的物品。
  - `truncated:true` 时向导明示「本次扫描最近 30 件,还有 17 件未扫」,不做假完整。
  - 每层的 need_confirm 规则同 parseLocation(置信 <0.8 / 未锚定 / 无合并覆盖),由服务端在归并时计算。
  - merge_hints 内嵌在 candidate_tree 节点上:`{ existing_location_id, existing_name, reason }`(同层 name_norm 相等由服务端自动判定;近义由模型标注、服务端校验存在性)。
- **锚定**:每件物品的每个分段 name 必须锚定于该物品自己的 location_text(同 §5.2 规则),未锚定段 → 该件 need_confirm=true。
- **错误码**:AI_UNAVAILABLE。

---

## 6. LLM 契约细节(parseLocation / scanHousehold 共用)

### 6.1 SYSTEM_PROMPT 要点(照 extractDraft 的组织方式,`lib/handler.js:19-32`)

「你是家庭位置结构解析器。用户给出物品的位置描述(单条或一批),你只负责拆解层级,不负责回答或闲聊。」规则:1) 每条位置拆成 1-6 段,顺序从大到小(房间→家具→容器);2) 每段名字必须**逐字取自原文**,禁止改写、概括、推理;3) 每段给 confidence(0-1),拿不准就给低分,**宁可低分不可编造**;4) 与【既有空间树】中同层同名或近义(如「主卧」与「主人房」)的段,在 merge_suggestions 里给出建议;5) 只输出一个 JSON 对象,无任何其他文字或围栏。字段schema:parseLocation 为 `{ segments:[{name,type,confidence}], merge_suggestions:[{segment_index,name,reason}], uncertain:bool }`;scan 每块为 `{ results:[{ index, segments:[...], uncertain }] }`(index 对应块内序号)。type 仅做模型参考输出,服务端一律按深度修正。

### 6.2 调用参数

deepseek.js 副本同款:model `deepseek-flash`、temperature 0.1、`thinking disabled`、`response_format json_object`、API key 仅入参、不打印请求内容(`extractDraft/lib/deepseek.js:16-38`)。

### 6.3 既有树序列化

`书房/桌子/右边第二个抽屉` 一行一个节点(缩进或斜线路径 + type)。≤120 节点;超限只送前两层并在 prompt 说明「深层位置略」。该上下文让「合并建议」有依据,同时控制 token。

### 6.4 防火墙不变量(可测试)

1. parseLocation / scanHousehold 执行前后 locations 与 items 两集合**文档内容零变化**(测试直查 memoryDb 断言)。
2. 全系统只有 ensurePath 创建节点,且 ensurePath 只能由客户端在用户确认后调用(向导保存按钮 / 详情页挂载确认);模型输出永远是候选。
3. need_confirm=true 的草案,客户端 UI 必须呈现待核对状态(默认不勾选/标黄),用户逐项确认后才能提交。

---

## 7. 页面与流程

新增页面注册(`miniprogram/app.json:2-6` 的 pages 数组追加):`"pages/locations/locations"`、`"pages/locationScan/locationScan"`。全部 .ts 改动经 `npm run build:mp` 出同名 .js 成对提交(铁律 2)。样式只用 `app.wxss:2-58` 的 CSS 变量与既有全局类(.card/.item-row/.btn/.banner 等),不新增硬编码颜色;深浅色自动跟随。Page 自定义属性在第二个泛型里声明(照 `pages/index/index.ts:32-89`)。

### 7.1 `pages/locations` —— 我的家(树浏览 + 节点管理)

- **入口参数**:`?node_id=<location_id>`(缺省=根层)。onLoad/onShow 调 `list`。
- **结构**:面包屑(path 渲染:「我的家 / 书房 / 桌子」)+ 子节点列表(item-row 样式,右侧显示 `item_count` 件 + chevron 下钻)+ 该层物品列表(直接挂载;显示物品名与原始 location_text 小字;点击进 pages/item 详情)。
- **空态**:根层无房间时显示引导卡「从已录入物品生成空间树」入口(主按钮)+「手动添加房间」次级入口(showModal editable 输入名称 → ensurePath created_from:"manual")。
- **节点管理**(子节点行点「⋯」或长按 → wx.showActionSheet):改名(wx.showModal editable)/移动/合并/删除。移动与合并进入**选择模式**:本页以 `picker=1&exclude=<node_id>&type=<type>` 参数重入自身,仅高亮可选节点(移动排除自身子树、合并仅列同 type),选中后回传(页面栈或 EventChannel)执行 move/merge。删除:先调 delete 试探,`NODE_NOT_EMPTY` 时弹 detail 数字让用户选择「去移动物品」或(无物品仅空分支)`force` 二次确认。
- **物品移动**:物品行「⋯」→「移动到…」→ 选择模式(linkItem,冲突按 VERSION_CONFLICT 提示刷新)或「从这里摘除」(unlinkItem)。
- 所有危险操作(force 删除、merge)二次确认;所有失败如实展示 errorMessage,不静默。

### 7.2 首页次级行入口

`pages/index/index.wxml` 在「顺手记一件」卡片与「最近记住的」之间插入一张次级卡:标题「我的家」,一行 item-row「按空间浏览:房间 → 家具 → 抽屉」+ chevron,点击 `wx.navigateTo /pages/locations/locations`。样式复用 .card/.item-row/.chevron(次级视觉,不抢「按住说话」主强调面);不显示任何假数据(不预取数量)。index.ts 仅新增一个 `onHomeTreeTap()` 方法与泛型声明。

### 7.3 `pages/locationScan` —— 从已录入物品生成空间树(向导)

1. **扫描**:进入即调 `scanHousehold`,loading 如实展示;AI_UNAVAILABLE → 错误态 + 重试按钮 + 「先手动建房间」引导(去 locations 页)。truncated 时顶部黄条明示「已扫最近 30 件 / 共 47 件」。
2. **候选树确认**:candidate_tree 分支渲染(可折叠);置信分支默认勾选、need_confirm 分支默认**不勾选**且标黄「AI 不太确定,请核对」;每个节点可改名(inline 输入,只影响本草案)。merge_hints 呈现为「“主卧”与已有的“主人房”是同一个?〔用已有〕〔保留新建〕」。
3. **挂载草案**:逐件列出 品名 → 候选路径(need_confirm 件默认不勾,可下拉改选其他已确认分支或跳过)。
4. **提交**(用户点击「确认入库」):对勾选后的**去重路径**逐条 `ensurePath`(created_from:"scan");成功后逐件 `linkItem`(expected_version 用 scan 时的 version,update_id 每件 uuid);`VERSION_CONFLICT` 的件**跳过并计数**(内容已被改过,不静默覆盖);`NOT_FOUND` 同样跳过。
5. **结果页**:成功 N 件、跳过 M 件(原因:已变化/已删除,可到详情页手动挂载)、失败 K 件(重试仅重试失败件,复用同 update_id)。零静默:每个数字都可展开看清单。

### 7.4 物品详情页「挂到空间」(parseLocation 的单条入口)

`pages/item/item` 详情操作区新增次级入口「挂到空间」:调 `parseLocation(text=该物品当前 location_text)` → 弹层展示候选分段(可改、need_confirm 标黄)→ 用户确认 → `ensurePath(created_from:"parse")` + `linkItem(expected_version=当前详情版本)`;VERSION_CONFLICT 走详情页既有刷新逻辑(refreshLatest 后重填表单重试)。AI_UNAVAILABLE → fallback:直接进入 locations 选择模式手动选节点。item.ts 改动仅追加方法与状态,不改既有保存/删除逻辑。

### 7.5 语音修改

明确 **MVP 之外**(issue 原文「进入后续设计」),不在本分支实现;页面不出现任何语音改位置的入口或占位。

---

## 8. 前端类型与 API 封装(types.ts / utils/api.ts 增量)

- `types.ts` 新增:`LocationType`、`LocationNodeSummary`、`MountDraft`、`ScanResult`、`ParseResult`、`LocationsApiEvent`(9 个 action 的判别联合)、各 ok 响应接口、`LocationsApiErrorCode`(§3 七码)、`LocationsApiErrorResponse`;`ItemRecord` 补可选 `location_node_id?: string | null`(投影不含,仅文档类型注释)。
- `utils/api.ts` 新增 `callLocationsApi` 重载族(照 `callItemsApi` 的 callCloudFunction/超时/toServerError/结构校验模式):函数名 `"locations"`;超时——parseLocation 30s、scanHousehold 60s、其余 15s;`LOCATIONS_API_MESSAGES` 中文兜底表。

---

## 9. 测试计划(tests/locations.test.js,node --test,中文断言)

通用:零外部依赖;只 require `cloudfunctions/locations/lib`、`cloudfunctions/itemsApi/lib`(交叉验证版本链)与 `tests/helpers`;绝不 require wx-server-sdk。memoryDb 需**小扩展**:支持对 locations 集合声明唯一键 `(household_id, parent_id, name_norm)` 的 E11000 模拟(现只硬编码 items 的 `(household_id, operation_id)`,`memoryDb.js:60-75` 改为按集合可配置,items 行为不变——这是对既有 helper 的增量改动,属提交 2)。LLM mock 照 `tests/extractDraft.test.js` 的 seqMock 形态注入 `deps.callLLM`。

必测点(ask 指定六项加粗):

| 编号 | 测试点 | 断言要点 |
| --- | --- | --- |
| TS-ISO | **跨家庭隔离** | 同一 memoryDb 两个 householdId:A 建树后 B 的 list 为空(children=[]);B 对 A 的节点 rename/move/merge/delete/linkItem 一律 NOT_FOUND 且 A 数据原样(raw 直查断言);B 的 parseLocation prompt 里不含 A 的节点名 |
| TS-EP | **ensurePath 幂等** | 同 path 调两次:第二次 nodes 同 id、created 全 false;部分存在的路径只补缺失段;并发 E11000(memoryDb 唯一索引模拟)→ 回查复用,不双建;跨家庭 ensurePath 同名互不影响 |
| TS-NC1 | **need_confirm 阻止静默建节点** | mock 低置信输出 → parseLocation 返回 need_confirm=true **且** locations/items 两集合文档数与内容零变化;未锚定段(编造名)同样强制 need_confirm;merge_suggestions 引用不存在节点 id 被丢弃 |
| TS-NC2 | scanHousehold 零写库 | mock 分块输出 → scan 成功返回后两集合零变化;重复 scan 结果一致;任一块 LLM 失败 → 整体 AI_UNAVAILABLE 且零写入;truncated 计数正确 |
| TS-MG | **merge 级联** | source 子节点重挂 target、path 全体重写;source 直接物品 location_node_id → target 且 version+1、location_text/name/note 不变;source 后代节点 id 不变、其上物品 version 不变;source 消失;同名子节点 → NODE_CONFLICT 且带 clashing_names、数据零变化;source=target 与跨 type → 拒绝 |
| TS-DL | **delete 保护** | 有物品 → NODE_NOT_EMPTY(带 item_count);force 且子树有物品 → 仍 NODE_NOT_EMPTY;空分支 force → 整支删除且 deleted_nodes 计数;删后重建同名节点可行(硬删除语义);home 根删除 → INVALID_INPUT |
| TS-LK1 | **linkItem 不破坏版本链** | itemsApi.create 建 v1 → locations.linkItem(v1)→ v2;**再用 itemsApi.update(v2) 改 note → v3 且 location_node_id 保留**;反之 linkItem 后 itemsApi.update 用旧版本 → VERSION_CONFLICT |
| TS-LK2 | linkItem 重放识别 | 响应丢失重试(同 update_id 同内容,expected_version 仍为旧值)→ replayed:true;同 update_id 不同 node → VERSION_CONFLICT(不吞新意图) |
| TS-LK3 | unlinkItem | linkItem→unlinkItem→null;对未挂载物品 unlink 照常版本 +1;越权/已删 → NOT_FOUND |
| TS-RN | rename 级联 | 改中层名,自身与全部后代 path 更新、items 的 location_text 不动;同级重名 → NODE_CONFLICT;home 根 → INVALID_INPUT |
| TS-MV | move 防环 | move 到自身后代 → NODE_CONFLICT;移动后子树深度 >6 → INVALID_INPUT;成功后 path 前缀整体替换 |
| TS-LST | list | 根层惰性建 home 根且幂等;item_count 含后代;跨家庭 parent → NOT_FOUND;children 排序稳定 |
| TS-INV | 挂载不变量 | 全部操作后扫描 items:每个未删物品的 location_node_id 都指向存在节点 |
| TS-LOG | 日志脱敏 | 捕获 logger 注入的 entry:字段仅 action/error/ms/count(或 LLM 类的计量字段),断言不含任何节点名/物品名/原文子串 |
| TS-SRC | 副本同源 | normalize.js 与 deepseek.js 副本和 itemsApi/extractDraft 原文件逐字节一致(fs 比对,防漂移) |

既有回归:`npm test` 全绿(itemsApi/extractDraft/transcribe/voice/glue 不受影响)。

---

## 10. 提交切分(实现 PR 共 4 个提交)

| # | 提交 | 内容 |
| --- | --- | --- |
| 1 | `docs: issue #18 Location Tree 设计合同` | 本文档 `docs/design/location-tree.md`(**本次任务只交付此提交**) |
| 2 | `feat: locations 云函数与离线测试(issue #18)` | `cloudfunctions/locations/**`(index/config/package/lib 全部)、`tests/locations.test.js`、`tests/helpers/memoryDb.js` 唯一索引可配置化增量 |
| 3 | `feat: 空间浏览与生成向导前端(issue #18)` | `pages/locations/*`、`pages/locationScan/*`(4 件套 ×2)、`pages/index` 入行、`pages/item` 挂到空间、`app.json` 注册、`types.ts`/`utils/api.ts` 增量;**npm run build:mp 后 .ts/.js 成对提交** |
| 4 | `docs: API 契约与部署手册增补(issue #18)` | `docs/API_CONTRACT.md`(§11 清单)、`README.md` 部署章节(locations 集合/索引/权限/环境变量/超时) |

纪律:只 `git add` 上表明确文件,禁 `git add -A`;不触碰工作区里 `.gitignore` 本地改动与 `scripts/` 实验线。

**PR 描述必含的人工步骤**(代码不管、描述必须写):
1. 云开发控制台创建 `locations` 集合;
2. 权限设为「所有用户不可读不可写」;
3. 组合唯一索引 `household_id + parent_id + name_norm`(唯一);
4. 部署 locations 云函数并配置环境变量 `DEEPSEEK_API_KEY`(与 extractDraft 同名同值),超时调 60 秒。

---

## 11. docs/API_CONTRACT.md 增补段落清单

1. **「技术栈」段**:集合清单由「仅一个 items 集合」改为「items 与 locations 两个集合」。
2. **「目录结构」段**:补 `cloudfunctions/locations/`(index.js、lib/handler.js、lib/parse.js、lib/validate.js、lib/tree.js、lib/normalize.js 副本、lib/deepseek.js 副本)、`tests/locations.test.js`、`pages/locations`、`pages/locationScan`。
3. **「身份与隔离」段**:补一句 locations 同款派生与「items 增 location_node_id 且唯一写入方为 locations 函数」。
4. **「items 集合文档」段**:补可空字段 `location_node_id`(缺失=未挂载;itemsApi 忽略与投影不含)。
5. **新增「locations 集合文档」段**:§1.1 全部字段、home 根、深度限制、硬删除语义、唯一索引。
6. **新增「locations 协议」段**:§3 错误码表 + §5 九个 action 的请求/响应/幂等/级联契约(逐条照本文)。
7. **新增「parseLocation / scanHousehold LLM 契约」段**:§6(prompt 要点、输出 schema、锚定校验、need_confirm 规则、零写库、分块与 30 件上限、超时)。
8. **「离线测试规范」段**:补 §9 测试点与「locations 与 itemsApi 在同一 memoryDb 上交叉驱动」要求。
9. **「小程序流程」段**:补 pages/locations、pages/locationScan、首页入口、详情页挂到空间、语音修改不在 MVP。

---

## 12. 开放风险(留给实现评审)

1. **merge 非事务**:多文档级联无跨文档事务(CloudBase 文档数据库),失败留半成品但不变量不破(§5.6);实现时按「先子节点、再物品、最后删 source」顺序把可重试性做到最大。
2. **scan 的 LLM 成本与上限**:30 件 × 分块是 MVP 经验值;真实家庭物品更多时需分次向导或增量扫描(后续 issue)。
3. **近义合并建议质量**:`name_norm` 相等是确定规则,近义完全依赖模型且必须用户裁决;错误建议最坏后果是用户看到一条多余提示,不会自动改数据。
4. **wx.showModal editable** 依赖基础库 2.17.1+;降级路径(页面内联输入)未设计,实现时若需兼容旧库再补。
5. **items 分页护栏**:locations 全量拉 items/nodes 复用 MAX_PAGES=100(1 万条)护栏,超限抛错不静默,与 itemsApi 同款取舍。
