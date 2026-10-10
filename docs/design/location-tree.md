# Location Tree MVP 设计合同(issue #18)

本文是 issue #18(Location Tree MVP:从文本位置到可浏览家庭空间)的实现设计合同,落地到字段、action、错误码与测试点。实现分支 `feat/issue-18-location-tree`(基于 `origin/main`)。本文档为评审后修订版,修订内容见文末「修订记录」。

依据的现行实现(均已在开工时通读):
- `cloudfunctions/itemsApi/index.js:21-24`(household_id 派生: `"hh_" + sha256(openid).slice(0,32)`)、`index.js:35-59`(薄胶水层,身份只取 `cloud.getWXContext().OPENID`)
- `cloudfunctions/itemsApi/lib/handler.js:275-309`(update 乐观并发:条件更新 `version === expected_version`,0 命中后回查区分 VERSION_CONFLICT / NOT_FOUND)、`handler.js:297-307`(update_id 重放识别三重条件:版本恰为 expected+1、last_update_id 相同、last_update_fingerprint 一致)、`handler.js:67-75`(changesFingerprint)、`handler.js:81-85,196-216`(E11000 并发兜底)、`handler.js:316-328`(软删除抹空内容)、`handler.js:335-352`(fetchActiveItems 分页拉全量)、`handler.js:459-478`(日志只记 action/error/ms/count)
- `cloudfunctions/extractDraft/index.js:18-32`(DEEPSEEK_API_KEY 只走环境变量,缺失返回 AI_UNAVAILABLE)、`lib/handler.js:19-57`(SYSTEM_PROMPT 组织与【用户输入】标记)、`lib/handler.js:103-116`(坏 JSON 带错误重试一次)、`lib/validate.js:44-61`(容忍 markdown 围栏的 JSON 提取)、`lib/validate.js:117-122`(certain=false 强制空位置的幻觉防护)、`lib/deepseek.js:16-38`(deepseek-flash、temperature 0.1、thinking disabled、response_format json_object)
- `cloudfunctions/itemsApi/lib/normalize.js:30-42`(normalizeName)
- 前端:`miniprogram/pages/index/index.ts:32-89`(Page 双泛型写法)、`miniprogram/pages/confirm/confirm.ts:24,46-51,119-125`(operation_id 幂等键)、`miniprogram/utils/api.ts:28-31`(客户端超时放宽原则:服务端 20s / 客户端 30s,优先让服务端错误回来)、`miniprogram/types.ts`、`miniprogram/app.wxss:2-58`(CSS 变量清单)、`miniprogram/app.json:2-6`(页面注册)
- 测试:`tests/helpers/memoryDb.js:60-75`(唯一索引 E11000 模拟)、`tests/itemsApi.test.js:19-20,222-245`(双 household 交叉越权)、`tests/extractDraft.test.js`(mock callLLM 驱动 handler)

---

## 0. 目标与不动量

### 验收标准 → 设计映射

| issue #18 验收标准 | 本设计的落实 |
| --- | --- |
| 1. 已有自然语言位置可稳定生成树结构 | `scanHousehold` 批量解析(未挂载物品增量池、块间近义提示)→ 向导逐支确认 → `applyScan` 一次调用入库挂载(§5.9、§5.10、§7.3) |
| 2. 用户可以浏览房间 → 家具 → 容器 → 物品 | `list` action + `pages/locations` 逐层下钻,节点页=子节点+该层物品;常驻「生成/更新空间树」入口 + 未归位计数让浏览面持续对齐真实库存(§5.1、§7.1、§7.3) |
| 3. 编辑位置不会破坏历史记录 | 节点编辑**绝不改写** items 的 `location_text`/`name`/`note`;一切挂载变更(含 merge/applyScan)一律走 items 既有版本链的**条件更新**,绝不无条件改写 version(§5.5-5.8、§5.10、§6.4) |
| 4. AI 不确定时必须请求确认,而不是自动创建错误空间 | `parseLocation`/`scanHousehold` **零写库**;只有 `ensurePath`(经 ensurePath 或 applyScan 内部)能建节点且只由用户确认后的客户端调用;低置信段、未锚定段、**错序段**一律强制 `need_confirm=true`(§6.4) |

### 明确不动量(防回归)

- `cloudfunctions/itemsApi` 与 `cloudfunctions/extractDraft` 代码**零改动**(README 部署章节增补除外,见 §11);录入链路(首页 → extractDraft → 确认页 → itemsApi.create)行为不变。
- items 既有字段语义不变;`itemsApi` 的投影 `project()`(`handler.js:128-137`)不变,旧客户端无感知。
- 「一句话多件拆分」(issue #14)链路不变。

### MVP 之外(明确划出)

- **语音修改位置**(issue Phase 3 的语音入口):后续设计,本 MVP 只做页面操作。
- 户型图建模、AR 定位、自动收纳规划、视频空间扫描(issue 明确排除)。
- 多家庭/家庭共享(现行合同「一个微信用户等于一个私人家庭空间」不变)。
- 节点排序自定义、节点图标、物品在节点间的拖拽手势。
- 录入确认页(pages/confirm)内嵌挂载:记一件的保存链路保持 3 步不变,挂载回流由常驻向导入口与详情页「挂到空间」承担(§7.3、§7.4)。

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
| `name_norm` | string | `normalizeName(name)`,与 itemsApi 同款算法(副本纪律见 §4.2) |
| `type` | string | 枚举 `"home" \| "room" \| "furniture" \| "container"` |
| `path` | string[] | 从根(不含 home 根)到本节点(含)的名字数组;home 根为 `[]`;例:桌子节点 `["书房"]`,抽屉节点 `["书房","桌子","右边第二个抽屉"]` |
| `created_from` | string | 枚举 `"bootstrap"`(home 根)\|`"scan"`(向导 applyScan)\|`"parse"`(单条解析)\|`"manual"`(页面手建);merge 不产生新节点故无此来源 |
| `created_at` / `updated_at` | string | ISO 字符串,`deps.now()` |

**home 根节点**:每个 household 恰一个,type=`"home"`,name 固定 `"我的家"`,`path=[]`、`parent_id=""`。由 `ensurePath`/首次 `list` 惰性创建(`created_from:"bootstrap"`);**不可改名、不可移动、不可合并、不可删除**(服务端对这些操作校验 type 后拒绝,错误码 `INVALID_INPUT`)。物品不允许直接挂在 home 根上(`linkItem`/`applyScan` 校验目标 type≠home)。统一「非根节点必有父」的语义,节点页与面包屑有稳定锚点。

**深度约束**:`path.length` ∈ [1,6](1=room,2=furniture,≥3=container;container 允许嵌套,如「抽屉里的盒子」,封顶 6 层防失控)。

**删除语义:硬删除**。与 items 的软删除不同,理由:(a) items 软删除是为 operation_id 重放与内容抹空;位置节点的「历史」由 items 的 `location_text` 原始话语承载,节点只是派生结构;(b) 软删除会占据 `(household_id, parent_id, name_norm)` 唯一索引槽位,导致「删掉书房后无法重建书房」;(c) 删除有空节点保护 + 摘除补偿(§5.7),悬挂挂载有读侧容忍兜底(§5.8)。

**挂载不变量(如实表述,非绝对保证)**:目标不变量是「任何未删除 item 的 `location_node_id` 指向存在的节点」。在无跨文档事务的前提下,系统以三层机制**尽力维护**该不变量:① 删除保护(有物品挂载的子树删不掉);② 删除/merge 的**收尾补偿扫描**(删后同一次调用内摘除悬挂挂载,§5.6/§5.7);③ **读侧容忍**(list/scanHousehold 遇到悬挂挂载按未挂载处理并如实计数上报)。补偿扫描与并发 linkItem 之间仍存在极窄的理论窗口,详见 §12.1——本设计**不宣称**该不变量在并发下绝对成立,只承诺单线程语义下成立(测试 TS-INV)+ 并发下可自愈(读侧容忍)。

**唯一索引(人工步骤,写进 PR 描述与 README)**:`locations` 集合 → 索引管理 → 组合唯一索引 `household_id`(升序)+ `parent_id`(升序)+ `name_norm`(升序)。作用:并发同名兄弟创建时数据库层兜底,`ensurePath` 捕获 E11000 后回查复用(照抄 itemsApi `handler.js:196-216` 的模式)。home 根唯一性由该索引自然覆盖(`("", 我的家norm)` 每 household 唯一)。

**权限(人工步骤)**:`locations` 集合 → 权限设置 → 「所有用户不可读不可写」。理由同 README 部署步骤 4②(`docs/security-evidence.md` 证据 1:默认权限实测可被任意客户端直读)。

### 1.2 `items` 集合(增量,不改既有字段)

- 新增**可空**字段 `location_node_id`:string | 缺失。缺失/null = 未挂载。旧文档无此字段,读侧按缺失处理。
- **唯一写入方是 locations 云函数**(`linkItem`/`unlinkItem`/merge 重挂载/applyScan 批量挂载);itemsApi 对该字段一律忽略(其 update 只组装 name/location_text/note 的 `changes`,见 `handler.js:239-260`,天然不触碰未知字段;投影亦不含它)。
- **写入方式统一为版本条件更新**:任何写 `location_node_id` 的路径都以「读到的当前 version 为条件」做条件更新并 +1,与 `itemsApi.update`(`handler.js:275-283`)完全同构;无任何无条件 version 改写(merge 也不例外,见 §5.6)。
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
| `VERSION_CONFLICT` | 物品内容已被修改,已为你刷新,请重试 | linkItem/unlinkItem 的 expected_version 不匹配且非重放;merge 重挂载中物品被并发修改而中止 |
| `NODE_NOT_EMPTY` | 这里还有东西,先移走物品和子位置才能删除 | delete 保护(含 force 下子树仍有物品) |
| `NODE_CONFLICT` | 目标位置已有同名节点,或不能移动到自己下面 | rename/move 撞同级同名;move 到自身后代;merge 双方有同名子节点;merge 自己到自己 |
| `AI_UNAVAILABLE` | AI 暂时不可用,可稍后重试或手动选择位置 | LLM 调用失败/超时/输出校验两次失败;附 `manual_fallback:true` |

统一响应形态与 itemsApi 相同:`{ ok:true, ... }` 或 `{ ok:false, error:CODE, message }`;业务错误可附 `detail`(结构化补充,如冲突清单、计数,名称允许出现在 detail 中——它是用户自己的数据回给本人,但**绝不允许进入日志**)。基础设施异常照抄 itemsApi `handler.js:498-503`:记日志(仅 action/error/ms)后原样上抛,绝不静默、绝不假装业务成功。

---

## 4. 云函数结构:`cloudfunctions/locations/`

### 4.1 目录结构与分层

```
cloudfunctions/locations/
  index.js        # 胶水层:照抄 itemsApi/index.js + DEEPSEEK_API_KEY 检查(仅 LLM action 需要)
  config.json     # { "timeout": 60 }
  package.json    # 除 wx-server-sdk 外零依赖
  lib/
    handler.js    # action 路由 + db 类 action(list/ensurePath/rename/move/merge/delete/linkItem/unlinkItem/applyScan)
    parse.js      # LLM 类 action 编排(parseLocation/scanHousehold:prompt 构造、并行分块、重试一次、近义提示调用)
    validate.js   # LLM 输出 schema 校验(parseLocation/scanHousehold 共用,含有序锚定校验)
    tree.js       # 纯函数:子树收集、path 级联重写、同级同名校验、深度计算
    normalize.js  # 与 cloudfunctions/itemsApi/lib/normalize.js 逐字节同源的副本(纪律见 §4.2)
    deepseek.js   # 与 cloudfunctions/extractDraft/lib/deepseek.js 逐字节同源的副本(纪律见 §4.2)
```

### 4.2 副本同源纪律

微信云函数是独立部署单元,`require("../itemsApi/...")` 在云端部署后目录不存在,因此 `normalize.js` 与 `deepseek.js` 以**逐字节同源副本**的形式放进 `cloudfunctions/locations/lib/`(仓库先例:transcribe 自带 `lib/tc3.js`、itemsApi 自带 `lib/normalize.js`)。纪律:

1. 两份副本文件头注释必须标明「与 `cloudfunctions/<源函数>/lib/<文件>` 逐字节同源,修改任一份必须双向同步」;
2. 离线测试 TS-SRC(§9)用 `fs` 逐字节比对副本与源文件,漂移即测试失败;
3. 若未来需要第三份副本,必须先评估把共享逻辑下沉为各函数打包脚本(超出本 MVP,记入风险清单不实施)。

### 4.3 deps 注入与 items 分页

- **deps 注入**(离线可测的关键):`handler(event, deps)`,`deps = { db, now(), genId(), digest(s), householdId, logger, callLLM? }`。`digest(s)` 返回 sha256(s) 十六进制前 16 位,供内部派生标识使用(§5.8「内部派生标识规格」;index.js 以 node:crypto 实现,离线测试注入确定性实现,如直接 `crypto.createHash` 同款或固定映射)。`callLLM` 仅 LLM 类 action(parseLocation/scanHousehold)使用;离线测试注入 mock(照抄 `tests/extractDraft.test.js` 的 `seqMock`/`mockFromSample` 形态)。db 类 action(含 applyScan)不依赖 callLLM,未注入也可测。
- **items 分页拉取**:照抄 `fetchActiveItems`(`itemsApi/handler.js:335-352`)的 skip/limit 逐页模式与 MAX_PAGES 护栏,落在 locations/lib/handler.js(scan、list 的挂载物品统计都要全量)。

---

## 5. action 契约(逐个)

通用:event = `{ action, ... }`;所有节点 id 参数(`parent_id`/`node_id`/`source_node_id`/`target_node_id`)均为 `location_id`(即 locations 文档 `_id`);物品 id 为 items 文档 `_id`。

### 5.1 `list` —— 树浏览(纯读,含一次惰性建根)

- **请求**:`{ action:"list", parent_id?: string }`。省略/空串 = home 根(房间层)。
- **语义**:返回 parent 节点(或根)的直接子节点与**直接挂载**于该节点的未删物品。`item_count` 为**整棵子树**(该节点自身+全部后代)挂载的未删物品数,child_count 为直接子节点数——两个计数都需全量拉 nodes 与 items 后在内存计算(家庭规模下可行,与 itemsApi query 的内存匹配模式同构)。
- **home 根惰性创建**:请求根层且 home 根不存在时,先创建 home 根(`created_from:"bootstrap"`),再查子节点(通常为空列表)。这是唯一会在 `list` 里发生的写,幂等(唯一索引 + E11000 回查复用)。
- **未归位计数(统一定义,全文档唯一口径)**:`unmounted_count` = 该家庭未删除且**未挂载**的物品数,「未挂载」= location_node_id **缺失、null,或指向不存在的节点**(悬挂,来源见 §12.1;悬挂件同时计入 `unmounted_count` 与 `dangling_mounts` 两个计数,后者单独标示其中多少是悬挂)。该定义同时是 scanHousehold 增量扫描池的取数口径(§5.9)——悬挂件因此**回流扫描池**,§12.1「经向导重挂自愈」的通道由此在公式上成立,而不是仅靠口头承诺。它是首页/节点页「生成/更新空间树」常驻入口的诚实数据源(§7.1)。
- **读侧容忍(挂载不变量兜底,§1.1 第③层)**:计算挂载物品时,若某物品的 `location_node_id` 指向不存在的节点(悬挂,仅可能来自 §12.1 的并发残余窗口),**按未挂载处理**(即 §5.1 的统一「未挂载」定义)并计入 `dangling_mounts` 字段如实上报——浏览面永不因悬挂而丢物品或报错,运维可见异常计数。
- **响应**:
```json
{ "ok": true,
  "node": { "location_id":"lc_..", "name":"我的家", "type":"home", "path":[], "item_count":12, "child_count":3, "created_from":"bootstrap", "updated_at":".." },
  "children": [ { "location_id":"lc_..", "name":"书房", "type":"room", "path":["书房"], "item_count":5, "child_count":2, "created_from":"scan", "updated_at":".." } ],
  "items": [ { "item_id":"it_..", "name":"..", "location_text":"..", "note":"..", "version":3, "updated_at":".." } ],
  "unmounted_count": 4, "dangling_mounts": 0 }
```
  根层请求时 `node` 即 home 根;`children` 按 item_count 降序、同数按 name 升序;`items` 按 updated_at 降序。parent 不存在/跨家庭 → `NOT_FOUND`。
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
    "order_violation": false,
    "merge_suggestions": [ { "segment_index":0, "existing_location_id":"lc_..", "existing_name":"书房", "reason":"同名" } ] } }
```
- **服务端校验与修正**(validate.js,规则可执行):
  - JSON 提取容忍围栏/前后废话(照抄 `extractDraft/lib/validate.js:44-61`);解析失败带错误重试一次,仍失败 `AI_UNAVAILABLE`(照抄 `handler.js:103-116`)。
  - segments 数组 1-6 项;name 去空白 1-30 字;confidence ∈ [0,1];type 必须按深度映射(depth1=room、depth2=furniture、depth≥3=container),不符即修正为按深度映射的类型(仅此一处允许修正,其余一律拒绝)。
  - **有序不重叠锚定校验**(「位置必须来自原文」的服务端兜底,防编造**且防错序/错切**):对每段在 `normalizeName(text)` 中求匹配区间,要求**按段序单调递增且互不重叠**(第 i+1 段的匹配起点必须大于第 i 段的匹配终点;实现为顺序游标——首段从头找,后续段从前一段区间之后找)。例:「书房桌子右边第二个抽屉」若被输出为「桌子,书房」,「书房」无法在「桌子」区间之后锚定 → 整条 `order_violation:true` 并强制 `need_confirm=true`。锚定同时防高置信错序:置信度再高,顺序违规也不许默认勾选入库。
  - merge_suggestions 中的 existing_location_id 必须属于本家庭且存在,否则**丢弃该条**(不失败);`reason` 由模型给出(「同名」/「近义」),服务端对 name_norm 完全相等的同级节点自动补全同名建议(不依赖模型)。
  - **need_confirm 置真规则(任一即真)**:任一段 confidence < 0.8(服务端常量 `SEGMENT_CONFIDENT_MIN`);或锚定校验未通过(含顺序违规,另置 `order_violation:true`);或该段未通过锚定且无 merge_suggestion 覆盖;或模型自报不确定。need_confirm=true 时该响应只是候选,客户端必须让用户核对后才可进入 ensurePath。confidence ≥ 阈值也仍是草稿(全流程只有用户点保存才算确认),UI 上低置信段标黄、顺序违规整条标黄强调。
- **错误码**:INVALID_INPUT、AI_UNAVAILABLE。

### 5.3 `ensurePath` —— 确认后沿路径建缺失节点(唯一建节点的入口,幂等)

- **请求**:`{ action:"ensurePath", path: ["书房","桌子","右边第二个抽屉"], created_from: "scan"|"parse"|"manual" }`。path 1-6 段,每段去空白 1-30 字;created_from 缺省 `"manual"`(applyScan 内部复用本逻辑时传 `"scan"`)。
- **语义**:先确保 home 根存在;自根逐段下钻:查 `(household_id, parent_id, name_norm)` 命中即复用,未命中则创建(type 按深度映射,path = 父 path + name)。**只创建,不改任何已存在节点,不碰 items**。
- **幂等**:按路径天然幂等——同一 path 重复调用返回相同节点序列,第二段起 `created:false`。并发同名竞态:唯一索引拒绝第二笔插入,捕获 E11000(识别逻辑照抄 `itemsApi/handler.js:81-85`)后回查复用,绝不双建。无需 operation_id(路径本身就是幂等键)。
- **响应**:`{ ok:true, nodes:[LocationNodeSummary...], created:[true,false,false] }`(nodes 与 path 等长,含复用节点;LocationNodeSummary 字段同 list.children)。
- **错误码**:INVALID_INPUT(path 层数/长度/类型不符)。

### 5.4 `rename` —— 节点改名(path 级联)

- **请求**:`{ action:"rename", node_id, name }`。
- **校验**:node 存在且属本家庭(否则 NOT_FOUND);type≠home(否则 INVALID_INPUT);新名去空白 1-30 字;**同级重名检查**——同一 parent 下其他子节点 name_norm 相同 → `NODE_CONFLICT`。
- **级联**:更新本节点 name/name_norm/updated_at,并把本节点与**全部后代**的 path 逐个重写(后代 path 中本节点位置的名字替换;tree.js 收集子树:`parent_id` 链全量拉取后内存过滤)。节点文档无版本号,级联为无条件批量 update(节点无并发编辑不变量,见 §12.6)。
- **不碰 items**:物品的 location_text 保持原始话语;挂载关系(location_node_id)引用的是节点 id,改名不影响。
- **响应**:`{ ok:true, node: LocationNodeSummary }`(更新后)。
- **错误码**:INVALID_INPUT、NOT_FOUND、NODE_CONFLICT。

### 5.5 `move` —— 节点移动(path 级联)

- **请求**:`{ action:"move", node_id, new_parent_id }`。
- **校验**:两节点存在且属本家庭(NOT_FOUND);node type≠home、new_parent type≠home(INVALID_INPUT);new_parent 不是 node 自身及其后代(否则 `NODE_CONFLICT`,message「不能移动到自己下面」);新家同级无 name_norm 重名(`NODE_CONFLICT`);移动后 node 子树最大深度 ≤ 6(否则 INVALID_INPUT,message「层级太深了」)。
- **级联**:node.parent_id 更新 + node 与全部后代 path 整体重写(新前缀 = new_parent.path + [node.name])。不碰 items。
- **响应**:`{ ok:true, node: LocationNodeSummary }`。
- **错误码**:INVALID_INPUT、NOT_FOUND、NODE_CONFLICT。

### 5.6 `merge` —— 合并重复节点(物品条件重挂载,不破坏版本链)

- **请求**:`{ action:"merge", source_node_id, target_node_id }`。
- **校验**:两节点存在且属本家庭;source ≠ target(`NODE_CONFLICT`);二者 type 相同(否则 INVALID_INPUT,message「只能合并同类型的位置」);target 不是 source 的后代(否则 NODE_CONFLICT);**source 的直接子节点与 target 的直接子节点无 name_norm 重名**(有则 `NODE_CONFLICT`,响应附 `detail:{ clashing_names:[..] }` 供客户端展示——名称出现在响应里合法,出现在日志里违规)。
- **执行顺序(逐件条件更新 + 冲突即中止 + 可重试收敛)**:
  1. **物品阶段**:逐件处理直接挂在 source 上的未删物品。每件:读当前 version `v` → 条件更新 `where({ _id, household_id, deleted:false, version:v })` 置 `{ location_node_id: target._id, version: v+1, updated_at, last_update_id: "merge:"+digest(source_id+"→"+target_id+":"+item_id)(派生标识,规格见 §5.8), last_update_fingerprint }`。**0 命中**(并发修改,如 itemsApi.update 或另一 linkItem)→ 重读一次:若该件 `location_node_id` 已等于 target(本次或上次 merge 已完成)则视为已完成继续下一件;否则**中止整个 merge**,返回 `{ ok:false, error:"VERSION_CONFLICT", message:"部分物品刚被修改,请重试", detail:{ conflicted:[{item_id, current_version}] } }`——**绝不无条件改写 version**,绝不覆盖并发修改。中止时已成功重挂的件**保持已挂 target**(语义无损,version 已正确 +1),source 未动,重试安全(重放识别靠派生标识的确定性:同 source/target/item 输入恒得同标识,与 §5.10 收敛语义一致)。
  2. **后置校验(收窄 linkItem(source) 并发窗口)**:物品阶段完成后、删除 source 之前,再查一次 source 的直接挂载物品;若并发冒出新挂物品,对其执行同款条件重挂(0 命中且非已挂 → 同样中止);确认为空才继续。
  3. **结构阶段**:source 的直接子节点 parent_id 改指 target(其自身及后代 path 重写)。source 后代节点 **id 不变**,因此挂在后代上的物品无需任何改动——这是「merge 级联不破坏版本链」的关键。
  4. **硬删除 source,随即补偿扫描**(§1.1 第②层):查 `location_node_id = source._id` 的未删物品(后置校验之后仍可能有并发 linkItem 落进极窄窗口),命中则逐件条件摘除(置 null、version+1),计入响应 `compensated`。补偿本身 0 命中(又被并发修改)则跳过该件并计入 `compensated_skipped`——读侧容忍(§5.1)兜底,重进向导可再挂。
- **不破坏历史**:items 的 name/location_text/note 一字不动;重挂载只动 location_node_id 与版本元数据,且全部为条件更新。
- **响应**:`{ ok:true, node: LocationNodeSummary(target 更新后), remounted: 2, compensated: 0 }`。
- **错误码**:INVALID_INPUT、NOT_FOUND、NODE_CONFLICT、VERSION_CONFLICT(物品阶段冲突中止)。
- **收敛语义(替代旧「部分完成」表述)**:merge 非原子,但每一步都以「已完成件保持、未完成件可重入」的方式推进——重试同一 merge 时,已挂 target 的件识别为已完成跳过,结构阶段幂等(子节点已指向 target 则不再改),source 已删则返回 `ok:true, detail:{ already_merged:true }`。不存在需要人工修复的半完成状态(悬挂由补偿+读侧容忍兜底,见 §12.1)。

### 5.7 `delete` —— 删除节点(空节点保护 + 摘除补偿)

- **请求**:`{ action:"delete", node_id, force?: boolean }`。
- **校验与语义**:
  - node 存在且属本家庭;type≠home(否则 INVALID_INPUT)。
  - 统计子树(自身+后代)挂载的未删物品数 `item_count`、后代节点数 `descendant_count`。
  - `force` 缺省/false:`item_count > 0 || descendant_count > 0` → `NODE_NOT_EMPTY`(响应附 `detail:{ item_count, descendant_count }`,客户端展示「这里还有 N 件物品、M 个子位置」)。
  - `force=true`(用户在 UI 二次确认后):若子树内**仍有任何未删物品** → 依旧 `NODE_NOT_EMPTY`(物品永远不能被结构操作丢弃,必须先移走);无物品但有空的后代分支 → 允许删除,整支空分支一并硬删除。
  - **删除后补偿扫描**(§1.1 第②层):对被删节点 id 集合查 `location_node_id ∈ ids` 的未删物品(拦截「计数时为 0 → 并发 linkItem 写入 → 硬删」交错),命中则逐件**条件**摘除(置 null、version+1、updated_at、last_update_id="compensate:"+digest(node_id+":"+item_id)(派生标识,规格见 §5.8)、fingerprint 同款),计入响应 `compensated`。补偿件是用户可见行为:UI 在结果里如实展示「N 件刚挂上来的物品已自动摘除,可重新挂载」;被摘除件回到 §5.1 统一定义的「未挂载」口径,下次进向导即可重挂。
- **响应**:`{ ok:true, deleted_nodes: 3, compensated: 0 }`(deleted_nodes 含自身)。
- **错误码**:INVALID_INPUT、NOT_FOUND、NODE_NOT_EMPTY。
- 残余窗口(补偿扫描之后、响应返回之前的并发 linkItem)无法在无事务下封死,由读侧容忍兜底,见 §12.1——**本节不宣称绝对闭环**。

### 5.8 `linkItem` / `unlinkItem` —— 物品挂载/摘除(复用 items 版本机制)

核心决策:**不绕开、不另造** items 的版本不变量,也不让 itemsApi 感知树。两 action 对 items 文档执行的更新与 `itemsApi.update`(`handler.js:275-309`)完全同构——同一版本计数器、同一 last_update_id/last_update_fingerprint 回写、同一三重条件重放识别——实现为 locations/lib/handler.js 内的同语义代码(云函数间无法共享模块,副本纪律见 §4.2),fingerprint 用同款 changesFingerprint 算法(键排序 JSON,`handler.js:67-75`)、仅覆盖 `{ location_node_id }`。**单一版本链原则:一件物品一个 version,itemsApi 与 locations 的所有写入方(含 merge/applyScan)一律条件更新它,任何一方过期即 VERSION_CONFLICT,系统内不存在对 items 的无条件 version 改写。** 交叉完整性由离线测试在同一 memoryDb 上同时驱动两个 handler 验证(§9 TS-LK1/LK3)。

- **内部派生标识规格(merge/compensate/applyScan 的服务端写入统一遵守)**:locations 内部批量写入(§5.6 merge 重挂载、§5.7 补偿摘除、§5.10 applyScan)不接收客户端 update_id,改用**确定性派生标识**写入 `last_update_id`:`"<op>:" + digest(拼接串)`,`op ∈ merge|compensate|scan`,`digest(s)` 为 sha256(s) 十六进制前 16 位(经 deps 注入,见 §4.3),拼接串分别为 `source_id+"→"+target_id+":"+item_id`、`node_id+":"+item_id`、`operation_id+":"+item_id`。派生标识**恒 ≤27 字符**,与客户端 update_id 的「非空 ≤64」同档,可直接复用同款 validUpdateId 形状校验,不存在压线或超限;重放识别只做**相等比较**(与 itemsApi `handler.js:302` 一致,长度仅是写入纪律),确定性哈希保证同输入恒得同标识——这是 §5.6/§5.10 收敛式重试的前提。派生标识不要求可逆解析出原文 id。
- **`linkItem` 请求**:`{ action:"linkItem", item_id, node_id, expected_version, update_id }`;**`unlinkItem` 请求**:`{ action:"unlinkItem", item_id, expected_version, update_id }`。
  - `expected_version`:正整数;`update_id`:非空 ≤64(客户端每次逻辑操作生成 uuid,失败重试同内容复用——照抄 `pages/item/item.ts:36-44` 的 pendingRetry 语义)。
- **校验**:node 存在、属本家庭、type≠home(NOT_FOUND/INVALID_INPUT);item 存在、属本家庭、deleted=false(否则 NOT_FOUND);item 当前 `location_node_id` 已等于 node_id 且版本匹配 → 视为内容变化仅版本元数据的正常更新(照常 +1;不做「无变化短路」,保持与 itemsApi.update 相同语义)。
- **执行**:条件更新 `where({ _id:item_id, household_id, deleted:false, version:expected_version })` 置 `{ location_node_id: node_id(或 null), version: expected_version+1, updated_at, last_update_id, last_update_fingerprint }`。命中 → `{ ok:true, item:{ item_id, version, updated_at } }`。0 命中 → 回查(同 itemsApi):三重条件(版本恰为 expected+1、last_update_id 相同、fingerprint 相同)成立 → `{ ok:true, replayed:true, item }`;存在但条件不符 → `VERSION_CONFLICT`;不存在/已删/跨家庭 → `NOT_FOUND`。
- **错误码**:INVALID_INPUT、NOT_FOUND、VERSION_CONFLICT。
- **并发竞态如实声明**:linkItem「校验节点存在」与「写 items」之间,存在与 delete(force)/merge 硬删该节点交错的窗口。该窗口由三层机制**收窄与兜底**(删除保护的计数、删除/merge 的后置校验与补偿扫描、读侧容忍),但补偿之后仍有理论残余窗口,无法在无跨文档事务时绝对封死(§12.1)。**本设计不宣称「不变量闭环」**,承诺的是:单线程语义下不变量成立(TS-INV),并发下最坏产生悬挂挂载且读侧按未挂载容忍、计数可见、可经向导重挂自愈。

### 5.9 `scanHousehold` —— Phase 1 整户增量扫描(纯草案,零写库)

- **请求**:`{ action:"scanHousehold" }`。
- **取数规则(显式增量池,与 §5.1 unmounted_count 同一口径)**:拉取本家庭未删除且**未挂载**的物品——「未挂载」= location_node_id 缺失、null,**或指向不存在的节点**(悬挂件回流池,自愈通道成立);updated_at 降序,上限 **30** 件。**不排除 location_text 为空的件**:空位置件同样进池并占用 30 的名额,但不送 LLM,直接归入 `skipped`(reason:"位置为空")——三处口径(unmounted_count、扫描池、skipped)因此完全对齐,常驻入口的「N 件未归位」里每一件都能在向导里看到归属(可挂载 / 空位置待补),计数不是假信号。已挂载物品不进池——向导天然增量:扫完挂载后重进向导,扫到的就是「此后新录入的树外物品」,与 §7.1 常驻入口闭环(录入链路持续产生树外物品 → 计数上升 → 入口可见 → 向导增量归位)。`scanned` = 本次进池的 30 件(= mounts + skipped 件数),`unmounted_total` = 池总数。
- **LLM 编排(并行分块 + 归并后近义提示,预算见下)**:
  - 30 件分 **3 块并行**(每块 10 件,**仅含 location_text 非空的件**;空位置件不送 LLM,服务端直接归入 skipped),每块独立 prompt(含【既有空间树】上下文,同 parseLocation);单块 LLM 超时 15s,坏 JSON 带错误重试一次(照抄 `extractDraft/lib/handler.js:103-116`)。
  - 任一块最终失败 → 整体 `AI_UNAVAILABLE`(不部分成功——草案必须完整才好确认,响应无半成品)。
  - **归并后近义提示调用(第 4 次 LLM 调用,块间近义的兜底)**:并行块的每一块只看得到 DB 既有树,看不到其他块已抽出的分段(「主卧」与「主人房」分属两块时,块内无法互见)。因此服务端把全部块的分段归并成候选树后,再发起**一次**轻量近义比对调用:输入仅为候选树**各层的名字列表**(不含用户原文,token 极小),输出近义组;超时 10s、重试一次。该调用失败 → 整体 `AI_UNAVAILABLE`(近义提示是 issue 验收「同义位置能够合并或提示」的必要组成,不做无提示的半成品)。
  - **耗时预算(串行界定明确,杜绝超上限)**:并行 3 块,单块最坏 15s×2(重试)≈ 30s;近义调用最坏 10s×2 = 20s,**串行加在并行之后**:总最坏 ≈ 50s < 60s(函数 config.json 上限);常态(每块 3-8s + 近义 2s)≈ 10s。客户端超时 70s,**严格大于**服务端函数上限,保证服务端错误先于客户端到点返回(照抄 `utils/api.ts:30-31` 的放宽原则)。
- **语义**:各块返回逐件分层分段 → 服务端归并成**整棵候选树**(同层 name_norm 相等去重)→ 近义组标注为块间/树内 `synonym_groups` → 与既有树比对生成 merge_hints。**绝不写库**(TS-NC2 断言)。
- **响应**:
```json
{ "ok": true, "scan": {
  "scanned": 30, "unmounted_total": 47, "truncated": true,
  "candidate_tree": [ { "name":"书房", "type":"room", "confidence":0.9, "need_confirm":false, "children":[ { "name":"桌子", "type":"furniture", "confidence":0.85, "need_confirm":false, "children":[ "..container.." ] } ] } ],
  "synonym_groups": [ { "level":0, "names":["主卧","主人房"], "reason":"近义" } ],
  "mounts": [ { "item_id":"it_..", "name":"充电宝", "location_text":"书房桌子右边第二个抽屉", "version":3, "path":["书房","桌子","右边第二个抽屉"], "confidence":0.8, "need_confirm":false } ],
  "skipped": [ { "item_id":"it_..", "name":"护照", "reason":"位置为空" } ] } }
```
  - candidate_tree 由服务端从全部 mounts 的 segments 归并生成(同层 name_norm 去重),**结构一致性由构造保证**,不依赖模型自洽。
  - `synonym_groups`:近义组(同层、跨块或块内),来自归并后近义比对调用;服务端对同层 name_norm 相等的组不需要 LLM(去重已消)。UI 呈现「“主人房”与“主卧”可能是同一个?〔合并〕〔分开〕」,用户裁决后合并进同一条 path。
  - mounts 带该物品**当前 version**,供 applyScan 作为 expected_version(提交时冲突 → 该件按 `conflict` 跳过并如实报告,绝不静默覆盖)。
  - skipped:**位置为空**(location_text 为空,不送 LLM、服务端直接归类,UI 引导「去详情页补个位置」后再挂载)或 LLM 判定**分段为空**的物品。两类都在向导里可见、可点进详情页处理,绝不静默消失。
  - `truncated:true` 时向导明示「未归位共 47 件,本次扫描最近 30 件」,不做假完整;其余未扫件下次进向导自然扫到(增量池)。
  - 每层的 need_confirm 规则同 parseLocation(置信 <0.8 / 有序锚定未通过 / 无合并覆盖),由服务端在归并时计算。
  - merge_hints 内嵌在 candidate_tree 节点上:`{ existing_location_id, existing_name, reason }`(同层 name_norm 相等由服务端自动判定;与既有树的近义由模型标注、服务端校验存在性)。
- **锚定**:每件物品的每个分段按 §5.2 的**有序不重叠**规则锚定于该物品自己的 location_text,未锚定或顺序违规 → 该件 need_confirm=true 且 `order_violation:true`。
- **错误码**:AI_UNAVAILABLE。

### 5.10 `applyScan` —— 向导确认结果的一次性服务端提交(收敛式幂等)

向导「确认入库」是批量操作;纯客户端逐条编排(数十次云函数往返、中途退出无恢复)既慢又违反零静默,因此提供本 action:客户端把**用户确认后的草案**(可改名、可合并近义组之后的最终形态)一次性提交,服务端在一个函数调用内完成建支与挂载。

- **请求**:
```json
{ "action":"applyScan", "operation_id":"uuid(≤64)",
  "branches":[ { "path":["书房","桌子"] }, { "path":["主卧"] } ],
  "mounts":[ { "item_id":"it_..", "expected_version":3, "path":["书房","桌子","右边第二个抽屉"] } ] }
```
  `operation_id`:本次向导提交的幂等键(uuid),失败重试/恢复时**原样复用**。**branches 与 mounts 是两个独立的确认单元,无前缀约束**:branches 是「建结构、暂无物品挂载」的纯结构确认(0-30 条,可为空数组,每条 path 1-6 段);**mounts 逐件(1-30 件),mount.path 即该件的完整确认路径**——向导 UI 上逐件草案展示并勾选的就是完整路径(含容器末段,如上例 mount 深于 branch),末段节点由本 action 自己沿路径创建,不要求(也不依赖)任何 branch 先建到该层。
- **参数校验(执行前,零写入)**:operation_id 非空 ≤64;branches/mounts 数量与各 path 结构(1-6 段、每段去空白 1-30 字)不合法 → `INVALID_INPUT`,此时**任何写入都不发生**。
- **执行(串行,全部条件更新)**:
  1. 对每条 branch 执行 ensurePath 同款逻辑(created_from:"scan"),得到每条的节点 id 序列;
  2. 对每件 mount:先对该件的**完整 path** 执行 ensurePath 同款逻辑(沿路径 find-or-create 到容器末段,created_from:"scan",幂等——重放时已建节点全部复用),取**末段节点 id** 为挂载目标;再条件更新 `where({ _id, household_id, deleted:false, version:expected_version })` 置 `{ location_node_id, version:+1, updated_at, last_update_id: 派生标识(见 §5.8「内部派生标识规格」:"scan:"+digest(operation_id+":"+item_id)), last_update_fingerprint }`;0 命中 → 回查:三重条件成立(版本恰为 expected+1、last_update_id 等于派生标识、fingerprint 一致)→ `already`(上次已完成的重放);`location_node_id` 已等于目标 → `already`;否则 `conflict`(并发修改,跳过不覆盖);物品文档不存在/已删/跨家庭 → `not_found`。挂载目标节点在 ensure 之后被并发删除的窗口,由 §5.8 已声明的残余窗口机制兜底(读侧容忍+向导重挂),不单列 status。
- **响应(逐件状态,零静默)**:
```json
{ "ok": true, "result": {
  "branches":[ { "path":["书房","桌子"], "created":[false,true], "location_ids":["lc_..","lc_.."] } ],
  "mounts":[ { "item_id":"it_..", "status":"mounted", "version":4 }, { "item_id":"it_..", "status":"conflict", "current_version":7 }, { "item_id":"it_..", "status":"already" }, { "item_id":"it_..", "status":"not_found" } ] } }
```
  `status ∈ mounted | already | conflict | not_found`。conflict/not_found 件由 UI 引导去详情页手动处理(挂载操作照常可用),绝不静默丢弃。
- **收敛式幂等(如实定义,非快照式)**:applyScan 不落库存储执行结果,幂等由「路径幂等(ensurePath,branch 与 mount 完整 path 皆然)+ 派生标识重放识别(§5.8 规格的 "scan:"+digest,三重条件同 linkItem)」实现——同一 operation_id 同一请求体重放时,已完成件识别为 `already`、未完成件继续执行,**收敛到全部完成**。因此重放的响应可能不同于首次响应(例:首调 `conflict` 的件,用户随后改了物品,重放可能变成 `mounted`)——这是收敛语义而非快照回放,文档与 UI 文案均按「重试会继续完成剩余挂载」表述,不承诺返回首次结果。
- **耗时预算**:无 LLM;≤30 件 × (读+条件写) + ≤30 条 branch × ≤6 段 ensurePath ≈ 最坏 ~100 次 DB 往返,常态 <15s,60s 函数上限内;客户端超时 70s(同 §5.9 理由,服务端错误优先)。
- **错误码**:INVALID_INPUT(参数结构校验失败,此时**零写入**);逐件失败不产生整体错误码,走 status。基础设施异常照 §3 上抛(部分完成状态可重放收敛,同 §5.6 语义)。

---

## 6. LLM 契约细节(parseLocation / scanHousehold 共用)

### 6.1 SYSTEM_PROMPT 要点(照 extractDraft 的组织方式,`lib/handler.js:19-32`)

「你是家庭位置结构解析器。用户给出物品的位置描述(单条或一批),你只负责拆解层级,不负责回答或闲聊。」规则:1) 每条位置拆成 1-6 段,顺序从大到小(房间→家具→容器);2) 每段名字必须**逐字取自原文且按原文顺序**,禁止改写、概括、推理、调序;3) 每段给 confidence(0-1),拿不准就给低分,**宁可低分不可编造**;4) 与【既有空间树】中同层同名或近义(如「主卧」与「主人房」)的段,在 merge_suggestions 里给出建议;5) 只输出一个 JSON 对象,无任何其他文字或围栏。字段 schema:parseLocation 为 `{ segments:[{name,type,confidence}], merge_suggestions:[{segment_index,name,reason}], uncertain:bool }`;scan 每块为 `{ results:[{ index, segments:[...], uncertain }] }`(index 对应块内序号)。type 仅做模型参考输出,服务端一律按深度修正。

### 6.2 近义比对 prompt(scanHousehold 归并后专用)

输入:候选树各层的名字列表(如 `层1: [书房, 主卧, 主人房, 客厅]`),**不含用户原文**;要求输出 `{ groups:[{ level, names:[..] }] }`,只把「很可能指同一处」的归组,拿不准不归。输出经校验:names 必须全部来自输入列表、组内 ≥2 个、去重;非法项丢弃。该调用结果只作提示,合并与否永远由用户裁决。

### 6.3 调用参数

deepseek.js 副本同款(纪律 §4.2):model `deepseek-flash`、temperature 0.1、`thinking disabled`、`response_format json_object`、API key 仅入参、不打印请求内容(`extractDraft/lib/deepseek.js:16-38`)。

### 6.4 防火墙不变量(可测试)

1. parseLocation / scanHousehold 执行前后 locations 与 items 两集合**文档内容零变化**(测试直查 memoryDb 断言)。
2. 全系统只有 ensurePath(含 applyScan 内部复用)创建节点,且只能由客户端在用户确认后调用(向导确认按钮 / 详情页挂载确认);模型输出永远是候选。
3. need_confirm=true 的草案,客户端 UI 必须呈现待核对状态(默认不勾选/标黄),用户逐项确认后才能提交;**有序锚定保证高置信但错序/错切的输出也强制 need_confirm**(order_violation),默认勾选只发生在「全部段高置信 + 有序锚定通过 + 无近义待裁决」时。
4. 对 items 的一切挂载写入(linkItem/unlinkItem/merge/applyScan/补偿摘除)都是**版本条件更新**,系统内不存在对 items 文档 version 的无条件改写。

---

## 7. 页面与流程

新增页面注册(`miniprogram/app.json:2-6` 的 pages 数组追加):`"pages/locations/locations"`、`"pages/locationScan/locationScan"`。全部 .ts 改动经 `npm run build:mp` 出同名 .js 成对提交(铁律 2)。样式只用 `app.wxss:2-58` 的 CSS 变量与既有全局类(.card/.item-row/.btn/.banner 等),不新增硬编码颜色;深浅色自动跟随。Page 自定义属性在第二个泛型里声明(照 `pages/index/index.ts:32-89`)。

### 7.1 `pages/locations` —— 我的家(树浏览 + 节点管理)

- **入口参数**:`?node_id=<location_id>`(缺省=根层)与 `?picker=1&exclude=..&type=..`(选择模式,§7.1 末)。onLoad/onShow 调 `list`。
- **结构**:面包屑(path 渲染:「我的家 / 书房 / 桌子」)+ 子节点列表(item-row 样式,右侧显示 `item_count` 件 + chevron 下钻)+ 该层物品列表(直接挂载;显示物品名与原始 location_text 小字;点击进 pages/item 详情)。
- **「生成/更新空间树」常驻入口(非空态限定)**:根层页头常驻一行入口——空树时呈现为主引导卡(「还没建过空间,从已录入物品生成」),已有房间时呈现为次级行「生成 / 更新空间树 · N 件未归位」(N=list 响应的 `unmounted_count`,N=0 时显示「全部已归位」)。入口永久可用:录入链路持续产生树外物品,该入口是浏览面与真实库存持续对齐的回流通道(扫描池=未挂载物品,§5.9)。`dangling_mounts>0` 时入口行附如实提示「N 件挂载异常,建议重新挂载」。
- **手动添加房间**:次级入口(showModal editable 输入名称 → ensurePath created_from:"manual"),任何层级可用(建子节点)。
- **节点管理**(子节点行点「⋯」或长按 → wx.showActionSheet):改名(wx.showModal editable)/移动/合并/删除。移动与合并进入**选择模式**:本页以 `picker=1&exclude=<node_id>&type=<type>` 参数重入自身,仅高亮可选节点(移动排除自身子树、合并仅列同 type),选中后回传(页面栈或 EventChannel)执行 move/merge。删除:先调 delete 试探,`NODE_NOT_EMPTY` 时弹 detail 数字让用户选择「去移动物品」或(无物品仅空分支)`force` 二次确认;响应含 `compensated>0` 时如实 toast「N 件刚挂上来的物品已自动摘除」。
- **物品移动**:物品行「⋯」→「移动到…」→ 选择模式(linkItem,冲突按 VERSION_CONFLICT 提示刷新)或「从这里摘除」(unlinkItem)。
- 所有危险操作(force 删除、merge)二次确认;所有失败如实展示 errorMessage,不静默。

### 7.2 首页次级行入口

`pages/index/index.wxml` 在「顺手记一件」卡片与「最近记住的」之间插入一张次级卡:标题「我的家」,一行 item-row「按空间浏览:房间 → 家具 → 抽屉」+ chevron,点击 `wx.navigateTo /pages/locations/locations`。样式复用 .card/.item-row/.chevron(次级视觉,不抢「按住说话」主强调面);不显示任何假数据(首页不预取数量,计数展示留给 locations 页)。index.ts 仅新增一个 `onHomeTreeTap()` 方法与泛型声明。

### 7.3 `pages/locationScan` —— 从已录入物品生成/更新空间树(向导,可重复进入)

1. **扫描**:进入即调 `scanHousehold`(扫描池=未挂载物品,增量),loading 如实展示;AI_UNAVAILABLE → 错误态 + 重试按钮 + 「先手动建房间」引导(去 locations 页)。truncated 时顶部黄条明示「未归位共 47 件,本次扫描最近 30 件」。
2. **候选树确认**:candidate_tree 分支渲染(可折叠);置信分支默认勾选、need_confirm 分支默认**不勾选**且标黄「AI 不太确定,请核对」(order_violation 件标「顺序可疑」);每个节点可改名(inline 输入,只影响本草案)。`synonym_groups` 呈现为「“主人房”与“主卧”可能是同一个?〔合并〕〔分开〕」,合并=统一段名。merge_hints 呈现为「与已有的“书房”是同一个?〔用已有〕〔保留新建〕」。
3. **挂载草案**:逐件列出 品名 → 候选路径(need_confirm 件默认不勾,可改选其他已确认分支或跳过)。**skipped 区单列**(不做假消失):空位置件显示「没记过位置——去详情页补一句,下次扫描就能归位」并给「去详情页」按钮;分段为空件显示「这次没解析出位置,可手动选择位置」给 locations 选择模式入口。
4. **提交(单次服务端调用)**:点击「确认入库」→ 组装 branches(勾选后的去重路径)+ mounts(勾选件,expected_version 用 scan 时 version)→ **一次** `applyScan`(operation_id = uuid,本次提交全程复用);loading 明示「正在入库…」。网络失败/超时/进程被杀 → 同 operation_id 同参数重放(收敛式,§5.10)。
5. **中断恢复**:确认清单(applyScan 完整请求参数 + operation_id)在提交前写入 `wx.setStorage`(键 `location_scan_pending`);onLoad 检测到未清除的记录 → 弹「上次有未完成的挂载,继续完成?」〔继续〕=重放 applyScan 并按响应渲染结果,〔放弃〕=清除记录(已完成的件保持,不做假回滚)。提交成功(拿到响应)后清除记录。
6. **结果页**:逐件渲染 status——mounted(成功)、already(上次已完成)、conflict(内容已变化,引导「去详情页重新挂载」)、not_found(已删除,如实说明);失败重试 = 重放同 operation_id(只推进未完成件)。零静默:每个状态都可展开看清单。

### 7.4 物品详情页「挂到空间」(parseLocation 的单条入口)

`pages/item/item` 详情操作区新增次级入口「挂到空间」:调 `parseLocation(text=该物品当前 location_text)` → 弹层展示候选分段(可改、need_confirm/order_violation 标黄)→ 用户确认 → `ensurePath(created_from:"parse")` + `linkItem(expected_version=当前详情版本)`;VERSION_CONFLICT 走详情页既有刷新逻辑(refreshLatest 后重填表单重试)。AI_UNAVAILABLE → fallback:直接进入 locations 选择模式手动选节点。item.ts 改动仅追加方法与状态,不改既有保存/删除逻辑。

### 7.5 语音修改

明确 **MVP 之外**(issue 原文「进入后续设计」),不在本分支实现;页面不出现任何语音改位置的入口或占位。

---

## 8. 前端类型与 API 封装(types.ts / utils/api.ts 增量)

- `types.ts` 新增:`LocationType`、`LocationNodeSummary`、`MountDraft`、`ScanResult`(含 synonym_groups)、`ParseResult`(含 order_violation)、`ApplyScanEvent`/`ApplyScanResult`、`LocationsApiEvent`(11 个 action 的判别联合)、各 ok 响应接口、`LocationsApiErrorCode`(§3 七码)、`LocationsApiErrorResponse`;`ItemRecord` 补可选 `location_node_id?: string | null`(投影不含,仅文档类型注释)。
- `utils/api.ts` 新增 `callLocationsApi` 重载族(照 `callItemsApi` 的 callCloudFunction/超时/toServerError/结构校验模式):函数名 `"locations"`;超时——parseLocation 30s、scanHousehold 70s、applyScan 70s(均**严格大于**服务端对应预算/上限,优先让服务端错误回来,照 `utils/api.ts:30-31` 原则)、其余 15s;`LOCATIONS_API_MESSAGES` 中文兜底表。

---

## 9. 测试计划(tests/locations.test.js,node --test,中文断言)

通用:零外部依赖;只 require `cloudfunctions/locations/lib`、`cloudfunctions/itemsApi/lib`(交叉验证版本链)与 `tests/helpers`;绝不 require wx-server-sdk。memoryDb 需**小扩展**:支持对 locations 集合声明唯一键 `(household_id, parent_id, name_norm)` 的 E11000 模拟(现只硬编码 items 的 `(household_id, operation_id)`,`memoryDb.js:60-75` 改为按集合可配置,items 行为不变——这是对既有 helper 的增量改动,属提交 2)。LLM mock 照 `tests/extractDraft.test.js` 的 seqMock 形态注入 `deps.callLLM`(scanHousehold 的 mock 按调用序返回 3 个块响应 + 1 个近义响应)。

必测点(ask 指定六项加粗):

| 编号 | 测试点 | 断言要点 |
| --- | --- | --- |
| TS-ISO | **跨家庭隔离** | 同一 memoryDb 两个 householdId:A 建树后 B 的 list 为空(children=[]);B 对 A 的节点 rename/move/merge/delete/linkItem/applyScan 一律 NOT_FOUND 且 A 数据原样(raw 直查断言);B 的 parseLocation prompt 里不含 A 的节点名 |
| TS-EP | **ensurePath 幂等** | 同 path 调两次:第二次 nodes 同 id、created 全 false;部分存在的路径只补缺失段;并发 E11000(memoryDb 唯一索引模拟)→ 回查复用,不双建;跨家庭 ensurePath 同名互不影响 |
| TS-NC1 | **need_confirm 阻止静默建节点** | mock 低置信输出 → parseLocation 返回 need_confirm=true **且** locations/items 两集合文档数与内容零变化;未锚定段(编造名)强制 need_confirm;**错序段**(「桌子,书房」:每段都是子串但顺序违规)→ order_violation=true 且 need_confirm=true;merge_suggestions 引用不存在节点 id 被丢弃 |
| TS-NC2 | scanHousehold 零写库 | mock 3 块 + 近义响应 → scan 成功返回后两集合零变化;任一块失败或近义调用失败 → 整体 AI_UNAVAILABLE 且零写入;truncated/unmounted_total 计数正确;扫描池=§5.1 统一「未挂载」口径(已挂载件不进 mounts;**悬挂挂载件回流池**——注入悬挂后重扫,该件出现在 mounts 草案中);**空位置件**(location_text 为空)进池、不送 LLM(callLLM mock 断言收到的件数不含它)、归入 skipped(reason="位置为空") |
| TS-MG | **merge 级联** | 全部条件重挂载成功:path 级联重写;source 直接物品 location_node_id → target、version+1、location_text/name/note 不变;source 后代节点 id 不变、其上物品 version 不变;source 消失;**并发冲突中止**:memoryDb 预置一件在 merge 读版本后被改的物品(测试内先读后改再触发)→ VERSION_CONFLICT 中止、source 仍在、已重挂件保持、重试收敛到完成;同名子节点 → NODE_CONFLICT 且带 clashing_names、数据零变化;source=target、跨 type、target 为 source 后代 → 拒绝 |
| TS-DL | **delete 保护** | 有物品 → NODE_NOT_EMPTY(带 item_count);force 且子树有物品 → 仍 NODE_NOT_EMPTY;空分支 force → 整支删除且 deleted_nodes 计数;删后重建同名节点可行(硬删除语义);home 根删除 → INVALID_INPUT;**补偿**:直接往 memoryDb 注入「location_node_id 指向待删节点的物品」模拟交错 → delete 后该件被条件摘除(version+1)、compensated 计数如实 |
| TS-LK1 | **linkItem 不破坏版本链** | itemsApi.create 建 v1 → locations.linkItem(v1)→ v2;**再用 itemsApi.update(v2) 改 note → v3 且 location_node_id 保留**;反之 linkItem 后 itemsApi.update 用旧版本 → VERSION_CONFLICT;**merge/applyScan 的重挂载同样以 itemsApi.update 验证交叉**(任一写入方过期即冲突,version 永不被无条件回写) |
| TS-LK2 | linkItem 重放识别 | 响应丢失重试(同 update_id 同内容,expected_version 仍为旧值)→ replayed:true;同 update_id 不同 node → VERSION_CONFLICT(不吞新意图) |
| TS-LK3 | unlinkItem | linkItem→unlinkItem→null;对未挂载物品 unlink 照常版本 +1;越权/已删 → NOT_FOUND |
| TS-AS | applyScan 收敛幂等 | 首调:branches 建树(created 标志正确)+ mounts 逐件 mounted;**mount 深于 branch 的正路径**(branch=["书房","桌子"],mount=["书房","桌子","右边第二个抽屉"])→ mount 完整 path 被建到末段、末段节点存在且该件 status=mounted(scan→向导→入库主路径);**同 operation_id 重放**:已完成件 already、冲突件不被覆盖(version 不回拨)、结果收敛;conflict 件(预置版本推进)→ status=conflict 且该件 location_node_id 不变;参数结构非法(path 7 段/空段名/超量)→ INVALID_INPUT 且零写入;派生标识(last_update_id)≤64 且重放相等;跨家庭 → NOT_FOUND/逐件 not_found |
| TS-SCAN | 扫描编排 | 3 块并行 mock 各自返回不同件 → mounts 归并正确、candidate_tree 同层去重;块 1 抽「主卧」块 2 抽「主人房」+ 近义调用归组 → synonym_groups 含该组(**块间近义可见性**);近义调用返回非法组(名字不在输入列表)→ 丢弃;每块只看到既有树(prompt 断言不含其他块的物品原文) |
| TS-RN | rename 级联 | 改中层名,自身与全部后代 path 更新、items 的 location_text 不动;同级重名 → NODE_CONFLICT;home 根 → INVALID_INPUT |
| TS-MV | move 防环 | move 到自身后代 → NODE_CONFLICT;移动后子树深度 >6 → INVALID_INPUT;成功后 path 前缀整体替换 |
| TS-LST | list | 根层惰性建 home 根且幂等;item_count 含后代;unmounted_count 按 §5.1 统一定义计数(含悬挂挂载件与空位置件,与 dangling_mounts 并存:悬挂件同时计入两者);dangling_mounts 如实计数;跨家庭 parent → NOT_FOUND;children 排序稳定 |
| TS-INV | 挂载不变量(单线程) | 全部操作序列后扫描 items:每个未删物品的 location_node_id 都指向存在节点;**读侧容忍与口径统一**:手动注入悬挂挂载(直接改 memoryDb)→ list 按统一定义把该件计入 unmounted_count、dangling_mounts=1、不报错不丢件,且 scanHousehold 把它带回 mounts 草案(自愈通道断言) |
| TS-LOG | 日志脱敏 | 捕获 logger 注入的 entry:字段仅 action/error/ms/count(或 LLM 类的计量字段),断言不含任何节点名/物品名/原文子串 |
| TS-SRC | 副本同源 | normalize.js 与 deepseek.js 副本和 itemsApi/extractDraft 原文件逐字节一致(fs 比对,防漂移);副本文件头含「同源/双向同步」注释(读文件断言) |

既有回归:`npm test` 全绿(itemsApi/extractDraft/transcribe/voice/glue 不受影响)。

并发说明(如实):TS-INV 只覆盖单线程不变量;§12.1 的并发残余窗口(补偿后与 linkItem 交错)无跨文档事务不可离线复现,不在测试承诺内,可离线验证的部分(补偿、读侧容忍)已由 TS-DL/TS-INV 覆盖。

---

## 10. 提交切分(实现 PR 共 4 个提交)

| # | 提交 | 内容 |
| --- | --- | --- |
| 1 | `docs: issue #18 Location Tree 设计合同` | 本文档(已提交;本次评审修订为同文件新 commit) |
| 2 | `feat: locations 云函数与离线测试(issue #18)` | `cloudfunctions/locations/**`(index/config/package/lib 全部,11 个 action 含 applyScan)、`tests/locations.test.js`、`tests/helpers/memoryDb.js` 唯一索引可配置化增量 |
| 3 | `feat: 空间浏览与生成向导前端(issue #18)` | `pages/locations/*`(常驻向导入口、选择模式)、`pages/locationScan/*`(applyScan 单次提交 + storage 中断恢复)、`pages/index` 入行、`pages/item` 挂到空间、`app.json` 注册、`types.ts`/`utils/api.ts` 增量;**npm run build:mp 后 .ts/.js 成对提交** |
| 4 | `docs: API 契约与部署手册增补(issue #18)` | `docs/API_CONTRACT.md`(§11 清单)、`README.md` 部署章节(locations 集合/索引/权限/环境变量/超时 60s) |

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
3. **「身份与隔离」段**:补一句 locations 同款派生与「items 增 location_node_id 且唯一写入方为 locations 函数,一切写入均为版本条件更新」。
4. **「items 集合文档」段**:补可空字段 `location_node_id`(缺失=未挂载;itemsApi 忽略与投影不含)。
5. **新增「locations 集合文档」段**:§1.1 全部字段、home 根、深度限制、硬删除语义、挂载不变量的如实表述(尽力维护三层机制)、唯一索引。
6. **新增「locations 协议」段**:§3 错误码表 + §5 十一个 action 的请求/响应/幂等/级联契约(逐条照本文,含 applyScan 的收敛式幂等定义)。
7. **新增「parseLocation / scanHousehold LLM 契约」段**:§6(prompt 要点、输出 schema、有序不重叠锚定、need_confirm/order_violation 规则、并行分块与近义比对调用、零写库、30 件增量池、耗时预算与客户端 70s 放宽)。
8. **「离线测试规范」段**:补 §9 测试点与「locations 与 itemsApi 在同一 memoryDb 上交叉驱动」要求、并发窗口不可离线复现的如实说明。
9. **「小程序流程」段**:补 pages/locations(常驻向导入口)、pages/locationScan(applyScan 提交与中断恢复)、首页入口、详情页挂到空间、语音修改不在 MVP。

---

## 12. 开放风险(留给实现评审)

1. **删除/merge 补偿后的残余并发窗口**:CloudBase 文档数据库无跨文档事务,「补偿扫描完成 → 响应返回前」与并发 linkItem 交错仍可能产生悬挂挂载(location_node_id 指向已删节点)。设计采用三层机制(删除保护计数、后置校验+补偿摘除、读侧容忍+计数上报)把窗口压到最窄并保证自愈,但**不宣称绝对消除**;彻底封死需事务或 items 写入时反向校验节点存在(跨集合条件更新,数据库不支持)。读侧容忍保证用户数据永不丢失,悬挂件经向导重挂自愈。
2. **applyScan/merge 的收敛式幂等非快照式**:重放返回的是当前收敛状态,可能与首次响应不同(status 迁移);UI 文案按「继续完成剩余」表述,若评审认为需要快照式幂等,须引入执行记录集合(超出 MVP,未设计)。
3. **scan 的 LLM 成本与 30 件上限**:30 件/3 块并行 + 1 次近义比对是 MVP 经验值,耗时预算最坏 ~50s(函数 60s 上限内、客户端 70s);真实家庭未归位物品更多时向导分次增量进入(增量池保证不重扫),一次性扩容需再评估。
4. **近义提示质量**:块间与树内近义依赖第 4 次轻量 LLM 调用,`name_norm` 相等才是确定规则;错误建议最坏后果是用户看到一条多余提示(合并永远用户裁决),不会自动改数据。
5. **wx.showModal editable** 依赖基础库 2.17.1+;降级路径(页面内联输入)未设计,实现时若需兼容旧库再补。
6. **节点文档无版本号**(单用户家庭无并发编辑者):双设备同用户对同一节点 rename/move 竞态最坏表现为 path 短暂不一致、下次 list 自愈;items 侧不受影响(挂载走版本条件更新)。实现评审可复议是否加轻量版本。
7. **items/nodes 全量拉取护栏**:沿用 MAX_PAGES=100(1 万条)护栏,超限抛错不静默,与 itemsApi 同款取舍。

---

## 13. v4 修订(2026-10-11,架构初审采纳)

架构初审结论:方向 GO、接近合并,四项待回应。本节逐项落位;行号指本分支 `cloudfunctions/locations/lib/handler.js`(提交「位置变更历史预留与扫描分块修复」时的版本)。

### 13.1 删除语义:物品位置事实在任何删除路径都不丢

初审要求确认「删除节点时的数据保护语义」。核实现有实现**严于**初审建议的「移到父/标未知/合并」三选一兜底,维持现状:

- 拒绝条件(`deleteAction`,L844):子树内挂有**任何**未删物品(`itemCount > 0`)时删除一律 `NODE_NOT_EMPTY`——**force 也拦**(force 仅放行「有后代节点但无物品」的空分支)。不存在「force 删书房导致充电宝/U 盘失去位置」的路径;想删必须先把物品移走。
- force 边界:无物品的空分支整支硬删(L853-855),`deleted_nodes` 含自身;删后重建同名可行(硬删除语义,§5.7)。
- 并发交错补偿(L856-867):硬删后同一次调用内重查悬挂挂载,逐件**条件摘除**(`compensateUnmount`,L415-428:location_node_id 置 null、version+1、派生标识),计入 `compensated`/`compensated_skipped`;被摘除件回流 §5.1「未挂载」口径,经向导重挂自愈。
- items 的 `location_text` 原始话语在一切路径不改写(§1.2);即便物品被补偿摘除,事实话语仍在——「失去的」只是结构化投影,且可重挂。

结论:三选一兜底允许删除发生、只是给物品找下家;本设计直接**禁止删除发生**。语义更强,不引入额外兜底分支。TS-DL 已覆盖(force 拦截、空分支整支删、补偿摘除、删后重建)。

### 13.2 合并策略:V1 无自动合并、无 embedding,近义只作候选

初审建议把合并策略写入设计合同。裁定如下,现行实现正是此行为,无代码改动:

- **V1 不做自动合并**:同义/近义(parseLocation 的 `merge_suggestions`、scanHousehold 的 `synonym_groups` 与 merge_hints)永远只是**候选提示**,合并与否由用户逐项裁决(向导〔合并〕〔分开〕、详情页〔用已有〕〔保留新建〕)。错误建议的最坏后果是多一条待裁决提示,绝不自动改数据(§12.4)。
- **V1 不引入 embedding**:近义判定 = 服务端 name_norm 相等(确定规则,§5.2)+ 归并后一次轻量 LLM 名单比对(§6.2,输入仅各层名字列表),不做向量检索。
- **理由**:空间树是长期资产,**错误合并一次的损害大于重复一次**——合并会改挂两支物品,事后难以凭直觉发现与撤销;重复节点无害且可逆,用 merge 四件套(§5.6)事后清理即可。

### 13.3 §5.11 位置变更历史(item_location_history,append-only 预留层)

采纳初审建议「V1 可不展示,但数据层别丢」,作为 §5.10 applyScan 之后的第十一节契约落位:

- **集合与字段**:新集合 `item_location_history`,每行 `{ household_id(服务端派生,随写入隔离), item_id, from_node_id(可 null), to_node_id(可 null), changed_at(ISO), source }`;`source` 枚举五个值,与五个挂载写入方一一对应:`"link"` / `"unlink"` / `"merge"`(重挂)/ `"apply_scan"` / `"compensate"`(删除与 merge 的补偿摘除)。
- **append-only**:只插入、不更新不删除,追加日志语义,无唯一索引需求;**唯一写入方是 locations 云函数**——所有挂载写入在 `conditionalMountUpdate` 收口,真实变更(from ≠ to)顺带追加一行(L385-402);itemsApi 对此集合无任何写入。权限与其他集合同款「所有用户不可读不可写」(README 部署步骤 4)。
- **不记与不阻断**:from == to 的空变更不记;update_id/派生标识重放走版本条件更新的 0 命中回查分支,不进入历史写入,天然不重复;**历史写失败 try/catch 吞掉,不阻断挂载主流程**——挂载结果是事实,历史是预留审计层。
- **V1 无读取入口**:无查询 action、无 UI;API 契约不承诺任何查询接口(见 docs/API_CONTRACT.md locations 段增补)。「这东西上周还在书房」类时间线以此数据为基础另行设计,不在本 MVP。
- 测试:TS-HIST1(五 source 全覆盖、重放不记、空变更不记、household_id 逐行隔离)、TS-HIST2(双家庭历史行不串扰)。

### 13.4 入口定位:自然入口在详情页,扫描是低频批处理

- **单件详情页「挂到空间」(§7.4)= 高频自然入口**:录入时位置一句话必填,记完一件顺手挂上是「录入 → 归位」的最短路径;parseLocation 单条解析即为此入口服务。
- **整户扫描向导(§7.3)= 低频批处理工具**:面向存量物品批量归位;locations 页常驻入口的 `unmounted_count` 是它的诚实触发器(计数涨 → 进向导批量归位 → 计数落),不追求常驻高频使用。
- **录入时的自然入口钩子 = 后续**:待 PR #17(一句话多件拆分)合并、统一确认页形态稳定后,再评估在确认页挂「录入即挂载」钩子;两 PR 已在 index 页/api.ts/types.ts 重叠,不在本 PR 叠加确认页改动(合并顺序:#17 先合,本 PR rebase main 后合)。

---

## 修订记录

- **v4(架构初审修订)**:① §13.1 删除语义裁定:子树内有未删物品时 force 也拒(NODE_NOT_EMPTY),物品位置事实在任何删除路径都不丢,严于「移到父/标未知/合并」三选一兜底,维持现状;② §13.2 合同落位:V1 无自动合并、无 embedding,近义只作候选、用户逐项裁决,错误合并损害大于重复故宁留重复事后 merge 清理;③ 新增 §5.11(§13.3)位置变更历史 `item_location_history`:append-only、仅 locations 函数写入、from≠to 才记、重放不记、写失败不阻断,V1 无读取入口;④ §13.4 入口定位:详情页「挂到空间」= 高频自然入口,扫描向导 = 低频批处理,录入确认页钩子待 #17 合并后另议;⑤ splitChunks 的 size 上限修复(原 size 为死参数,SCAN_CHUNK_SIZE=10 从未生效;当前常量 30 件/target 3/size 10 行为与旧版逐位一致,超限自动增块,40 件 → 4 块 × ≤10),补 TS-CHUNK。
- **v3(二轮评审修订)**:① §5.10 消除自相矛盾:去掉「mount.path 须以 branch 为前缀」约束,branches(纯结构确认,可空)与 mounts(逐件完整确认路径)改为**独立确认单元**,执行步骤 2 对 mount **完整 path** 复用 ensurePath 建到容器末段(修复「mount 深于 branch 必然 not_found」但示例却是 mounted 的矛盾),TS-AS 补该正路径用例;② 「未挂载」定义全文统一为「location_node_id 缺失、null **或指向不存在的节点**」(§5.1/§5.9/TS-INV/TS-LST 同一口径),悬挂件回流扫描池,§12.1「向导重挂自愈」与 §5.6「重进向导可再挂」在公式上成立;③ scanHousehold 取数**不再排除空位置件**:空位置件进池、不送 LLM、归入 skipped(reason:"位置为空"),消除「skipped 示例有它但取数规则挡它」与「unmounted_count 含它但向导永远看不见它」两处口径冲突,§7.3 加 skipped 分流引导(去详情页补位置);④ §5.8 新增「内部派生标识规格」:`<op>:"+digest(拼接串)`(sha256 前 16 hex,恒 ≤27 字符,与外部 update_id ≤64 同档),替换 merge/compensate/applyScan 三处原文拼接式派生 id(原 89/66/恰 64 字符),deps 增 `digest(s)` 注入(§4.3)。
- **v2(评审修订)**:① §5.6 merge 重挂载由「读版本后无条件 +1」改为逐件**条件更新 + 冲突中止 + 收敛重试**,与 §5.8 单一版本链一致(原两节矛盾);② §5.7/§5.8 删除与 linkItem 的并发竞态改为如实表述:删除保护 + 后置校验 + 补偿摘除 + 读侧容忍三层机制,残余窗口列入 §12.1,不再宣称「闭环」;③ §5.9 增加归并后**近义比对 LLM 调用**与 synonym_groups,修复并行分块下块间近义不可见(issue 验收「同义位置能够合并或提示」);④ §5.9 明确**并行分块**并给出耗时预算(最坏 ~50s < 函数 60s),客户端超时改为严格大于服务端的 70s;⑤ 新增 **applyScan** action(§5.10)承接向导提交:一次调用、逐件条件更新、收敛式幂等、storage 中断恢复,替代数十次客户端编排;⑥ 向导入口由「空态限定」改为 **locations 页常驻入口** + unmounted_count,扫描池显式定义为未挂载物品(增量);⑦ 锚定校验由「子串」升级为**有序不重叠锚定**,错序/错切强制 need_confirm + order_violation;⑧ §4 拆出 §4.1/§4.2/§4.3,修复「§4.2」失实自引用。
- v1:初版设计合同(提交 7f49dda)。
