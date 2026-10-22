# 我靠东西呢(home-memory · 家庭物品记忆助手)

用一句话记录物品位置(如「降压药放在厨房第二个抽屉」):AI 只负责从这句话提取**待确认草稿**,你确认后才入库;之后随时按名称查询位置,可修改、可删除。AI 绝不直接写事实,不确定时禁止猜测,任何失败绝不静默写入。

**PR1 范围(文字闭环)**:一句话记录 → AI 提取草稿 → 用户确认入库 → 按名查询 → 修改 → 删除,全流程可用。语音录入属 PR2,真实家庭试用属 PR3(见 [docs/PR1.md](docs/PR1.md))。PR1 中一个微信用户即一个私人家庭空间,不做多成员共享。

技术栈与行为契约见 **[docs/API_CONTRACT.md](docs/API_CONTRACT.md)**(唯一事实源,本 README 只讲怎么跑起来)。

## 技术栈

- **小程序端**:微信原生小程序,TypeScript(`miniprogram/tsconfig.json` 为 strict 模式)。**采用预编译**:修改 `.ts` 后运行 `npm run build:mp`(即 `tsc -p miniprogram`)在源码旁产出 `.js`,开发者工具与 CLI preview/upload 直接使用编译产物。不使用 `useCompilerPlugins`(实测部分版本在 CLI/preview 构建路径上不产出 JS,导致「未找到 pages/xxx.js」);类型检查用 `npm run typecheck`。
- **服务端**:微信云开发 Node.js 云函数(JavaScript CommonJS,除 `wx-server-sdk` 外零 npm 依赖),小程序通过 `wx.cloud.callFunction` 调用。
- **数据库**:CloudBase 文档数据库,`items`、`locations`、`item_location_history`、`reminders`、`remind_subscriptions`、`video_evidence`、`video_upload_tickets`、`video_item_locks` 与 `location_scans` 九个集合(issue #18 起位置沉淀为可浏览的空间树;item_location_history 是只追加的位置变更历史预留层,best-effort 写入、不承诺完整审计,仅 locations 云函数写入,无需人工维护;reminders 为 issue #36 独立提醒实体,仅 itemsApi 写入;remind_subscriptions 为 #36 V1.5 到期微信提醒的订阅记录,仅 remindNotify 云函数读写)。
- **AI**:DeepSeek Chat Completions(model `deepseek-flash`,显式禁用思考模式),**仅服务端调用**,API key 只走云函数环境变量。
- 不引入 Redis、向量库、FastAPI、自研队列。

## 目录结构

```
project.config.json      小程序工程配置(appid 为占位符,见下方部署步骤 1)
package.json             根脚本:test / typecheck / samples:live
miniprogram/             小程序端(TypeScript,strict)
  config.ts              云环境 ID 配置(cloudEnv,占位 YOUR_ENV_ID)
  types.ts               与契约一致的领域类型
  utils/api.ts           云函数调用封装、超时与错误映射、operation_id 的 uuid
  utils/locations-api.ts locations 云函数调用封装(issue #18 空间树)
  pages/index            首页:记一件(AI 提取)/ 找东西(查询)/ 最近记录 / 我的家入口
  pages/confirm          确认页:AI 草稿确认与手动录入
  pages/item             详情页:查看 / 修改 / 删除 / 挂到空间
  pages/locations        我的家:空间树逐层浏览 + 节点管理 + 位置选择模式
  pages/locationScan     生成空间树向导:候选树确认 → 一次 applyScan 入库
cloudfunctions/
  itemsApi/              items 集合的 create/update/delete/get/query/list + reminders 提醒实体(issue #36)
    index.js             薄适配层(wx-server-sdk 胶水,可信家庭解析,注入写硬门上下文)
    lib/handler.js       纯函数业务逻辑(依赖注入,可离线测试)
    lib/normalize.js     名称归一化(NFC/全角转半角/小写/去空白/去标点)
    lib/household.js     可信家庭三向解析 + 写入硬门(三副本同源,测试强制不漂移)
  extractDraft/          一句话 → 物品位置草稿
    index.js             胶水层(读环境变量 DEEPSEEK_API_KEY)
    lib/handler.js       纯函数:prompt 构造、坏 JSON 重试一次、结果分流
    lib/deepseek.js      DeepSeek HTTP 客户端(Node 内置 https,20 秒超时)
    lib/validate.js      服务端草稿校验(幻觉防护、needs_split、长度规则)
  locations/             空间树(issue #18):浏览/建节点/编辑/挂载/整户扫描
    index.js             胶水层(可信家庭解析与 itemsApi 同款;LLM action 检查 DEEPSEEK_API_KEY)
    config.json          超时 60 秒(整户扫描最坏 ~50 秒)
    lib/handler.js       db 类 action:list/ensurePath/rename/move/merge/delete/linkItem/unlinkItem/applyScan
    lib/parse.js         LLM 类 action:parseLocation/scanHousehold(并行分块 + 近义比对)
    lib/validate.js      LLM 输出校验 + 有序不重叠锚定(防编造、防错序)
    lib/tree.js          纯函数:子树收集 / path 级联重写 / 深度计算
    lib/normalize.js     与 itemsApi 逐字节同源的副本(测试强制不漂移)
    lib/deepseek.js      与 extractDraft 逐字节同源的副本(测试强制不漂移)
    lib/household.js     与 itemsApi 逐字节同源的副本(测试强制不漂移)
  households/            共享家庭生命周期(issue #34 P1-A):创建/邀请/加入/退出/移除/解散/状态
    index.js             胶水层(OPENID→member_key、三向解析、令牌生成与哈希注入)
    config.json          超时 10 秒
    lib/handler.js       纯函数 action 路由(依赖注入,可离线测试)
    lib/household.js     与 itemsApi 逐字节同源的副本(测试强制不漂移)
  remindNotify/          到期微信提醒推送(issue #36 V1.5):订阅落库 + 每日 08:00 扫描发送
    index.js             胶水层(OPENID→member_key、三向解析、cloud.openapi 订阅消息注入)
    config.json          超时 20 秒;timer 触发器 dailyExpiryNotify(cron 每天 08:00)
  videoCleanup/          孤儿视频回收:恢复超时中间态 + 扫描超过 24h 仍 pending 且已回执 file_id 的票据
    lib/handler.js       recordSubscription 落库 + 每日扫描(窗口过滤/聚合/资格复核/幂等/发送)
    lib/aggregate.js     纯函数:上海时区自然日、到期窗口、按家庭聚合卡片四字段(20 码点截断)
    lib/eligibility.js   纯函数:发送前资格复核(member_key 重算/在册未解散/个人家庭派生)与幂等
    lib/household.js     与 itemsApi 逐字节同源的副本(测试强制不漂移)
tests/                   离线测试(node:test + node:assert,零外部依赖)
  helpers/memoryDb.js    内存版 CloudBase 语义(含云函数端 get() 单次 100 条上限、唯一索引 E11000 模拟)
  itemsApi.test.js       itemsApi 契约测试
  extractDraft.test.js   extractDraft 契约测试
  locations.test.js      locations 契约测试(隔离/幂等/版本链交叉/扫描编排/分块/位置变更历史等 21 项)
  transcribe.test.js     语音识别云函数契约测试
  glue.test.js           云函数入口胶水层测试(stub wx-server-sdk 真实加载)
  voice.test.js          语音控制器与会话守卫测试
  household.test.js      可信家庭三向解析 + 写入硬门 + 三副本同源(issue #34)
  households.test.js     共享家庭生命周期/邀请/修订号/失败关闭/日志脱敏(issue #34 P1-A)
  samples-live.js        真实调用 DeepSeek 的样例集验证脚本
  fixtures/samples/      16 条中文样例(s01–s16,覆盖八类情形)
docs/
  API_CONTRACT.md        接口契约(唯一事实源)
  design/location-tree.md issue #18 Location Tree 设计合同
  PR1.md                 PR1 交付说明
```

## 本地离线验证(不需要微信开发者工具、不需要 API key)

环境要求:Node.js 21 及以上(在 v26 上验证通过;测试脚本依赖 `node:test` 与 glob 文件匹配)。

```bash
npm install          # 仅安装 typescript 与 miniprogram-api-typings 两个 devDependencies
npm test             # 离线全量测试:202 项全部通过(itemsApi/extractDraft/locations/voice/transcribe/胶水层 + household 22 + households 19,issue #34)
npm run typecheck    # miniprogram 的 tsc --noEmit,严格模式类型检查
npm run samples:live # 真实样例试运行,见下文「真实样例试运行」
```

- 测试只 require `cloudfunctions/*/lib` 与 `tests/helpers`,绝不 require `wx-server-sdk`,不连网。
- `tests/helpers/memoryDb.js` 模拟 CloudBase 语义,包括云函数端 `get()` 单次最多 100 条的真实上限,因此「文档超过 100 条后查询被静默截断」这类缺陷在离线测试中即可发现。

## 部署到微信云开发

按顺序完成以下步骤。1–4 在微信开发者工具中操作,5–7 在云开发控制台中操作。

### 1. 替换 appid 并导入项目

`project.config.json` 里的 `appid` 是占位符 `touristappid`。请先把它替换为你自己的小程序 AppID(注册见微信公众平台,也可导入后在开发者工具「详情 → 本地设置」中覆盖),再用微信开发者工具「导入项目」打开本仓库根目录。

### 2. 开通云开发

开发者工具顶部「云开发」→ 开通并创建一个云环境,记下**环境 ID**(形如 `cloud1-xxxx`)。

### 3. 替换 cloudEnv

把 `miniprogram/config.ts` 里的 `cloudEnv = "YOUR_ENV_ID"` 替换为你的环境 ID。未替换时小程序启动会弹窗如实提示(见 `miniprogram/app.ts`),云函数调用无法成功。

### 4. 创建集合、唯一索引与权限(必做,缺一不可)

云开发控制台 → 数据库 → 分别创建集合 `items`、`locations`、`item_location_history`、`reminders`、`remind_subscriptions`、`video_evidence`、`video_upload_tickets` 与 `video_item_locks`(locations 为 issue #18 空间树;item_location_history 为位置变更历史预留层,见 ④;reminders 为 issue #36 提醒实体,见 ⑥;remind_subscriptions 为 #36 V1.5 到期微信提醒订阅记录,见 ⑦;视频留证三个集合见 ⑧)。随后完成配置:

**① items 组合唯一索引**:

> items 集合 → 索引管理 → 添加索引:字段一 `household_id`(升序)+ 字段二 `operation_id`(升序),勾选「**唯一**」。

**为什么必须建**:`create` 的幂等在代码层是「先查后插 + 同键同内容比对」(`cloudfunctions/itemsApi/lib/handler.js` 的 `createItem`),对先后到达的重放有效;但对**并发**重放(两笔同 `operation_id` 的请求几乎同时到达)不是原子的。唯一索引在数据库层兜底:第二笔插入被数据库拒绝后,服务端捕获该错误回查并返回稳定结果(同内容 `duplicated: true`;异内容或命中已删文档 `OPERATION_CONFLICT`),绝不静默双写。

**② locations 组合唯一索引**:

> locations 集合 → 索引管理 → 添加索引:字段一 `household_id`(升序)+ 字段二 `parent_id`(升序)+ 字段三 `name_norm`(升序),勾选「**唯一**」。

作用:同一层下并发创建同名位置(如两次同时从扫描向导确认「书房」)时,数据库拒绝第二笔插入,服务端捕获后回查复用已有节点,绝不双建;home 根节点的每家庭唯一性也由该索引自然覆盖。

**③ 权限设置(安全必做,所有集合都要)**:

> 全部集合 → 权限设置 → 均选「**所有用户不可读不可写**」(或自定义安全规则 `{"read": false, "write": false}`)。

**为什么必须改**:所有业务访问都经云函数(管理端身份,不受权限规则约束),客户端不需要任何直连权限。默认权限曾实测允许任意客户端直读全集合(见 `docs/security-evidence.md` 证据 1)——不改等于向所有用户开放全部家庭数据。

**④ item_location_history(位置变更历史预留层)**:

> 按上文创建集合并把权限并入 ③(「所有用户不可读不可写」)即可;**无需建任何索引**。

该集合是 append-only 的预留审计层:locations 云函数在每次真实挂载变更(挂上/摘除/合并重挂/向导入库/补偿摘除)后追加一行,只插不改不删,V1 没有读取入口。除「创建集合 + 设权限」外无需任何人工维护。

**⑤ 家庭共享元数据集合(issue #34 P0+P1-A:household_members、active_household、households、household_invites;先建集合再部署 itemsApi/locations/households,缺集合时对家庭解析失败关闭并返回 HOUSEHOLD_UNAVAILABLE)**:

> 创建集合 `household_members`、`active_household`、`households` 与 `household_invites`,权限全部并入 ③(「所有用户不可读不可写」),然后建索引:
>
> - `household_members` → 索引管理 → 添加索引:字段一 `household_id`(升序)+ 字段二 `member_key`(升序),勾选「**唯一**」。
> - `active_household` → 索引管理 → 添加索引:字段 `member_key`(升序),勾选「**唯一**」。
> - `households` → 无需额外索引(`_id` 天然唯一,household_id 即 `_id`)。
> - `household_invites` → 索引管理 → 添加索引:字段 `token_hash`(升序),勾选「**唯一**」;另建议加 `household_id`(升序)普通索引(邀请列表查询性能,非唯一)。

作用(issue #34):itemsApi 与 locations 每次请求先按 `member_key = sha256(OPENID)` 查 `active_household`——无记录则回退原有个人家庭(单人用户零感知);有记录则做三向验证(active 指针 → `household_members` 会员行 → `households` 未解散),孤儿指针、已解散家庭或任何查询异常一律失败关闭(HOUSEHOLD_UNAVAILABLE),绝不把任一家庭的数据错写进另一个家庭。P1-A 起新增 `households` 云函数写入这四个集合(创建共享家庭/邀请/加入/退出/移除/解散);邀请库中只存 `sha256(令牌)`,裸令牌绝不落库。单人用户不触发共享家庭路径,`households` 集合只在有活跃共享指针时才被查询,晚建不影响单人使用,但启用家庭共享前必须建齐。

**⑥ reminders 提醒实体集合(issue #36 二阶段)**:

> 按上文创建集合并把权限并入 ③(「所有用户不可读不可写」)即可;**无需建任何索引**。

该集合是独立提醒实体(itemsApi 的 `create` 可选 reminder 参数写入、`remindList`/`remindComplete`/`remindClear`/`remindSet` 读写):每条 active 提醒内部关联一个 item,物品删除时其 active 提醒级联硬删,done 历史行保留;集合内另有每物品一条 `slot_` 前缀的生命周期权威文档(status 固定 "slot",单调轮次权威 rev + 跨操作欠账声明,与提醒行的 active/done 查询天然隔离)。「每 item 至多一条 active、轮次单调绝不重用、清除不复活」由 slot 条件更新(CAS)+ 行级轮次条件更新 + 确定性 _id 三层维持(并发/多设备交错下成立),数据库层无唯一索引。**需要重新部署 `itemsApi` 云函数后这些 action 才存在**(部署方式见步骤 6)。

**⑦ remind_subscriptions 到期提醒订阅记录(issue #36 V1.5;先建集合再部署 remindNotify,缺集合时订阅落库失败,推送不可用)**:

> 按上文创建集合并把权限并入 ③(「所有用户不可读不可写」)即可;**无需建任何索引**(订阅文档用 `"rsub_"+household_id+"_"+member_key` 确定性 _id,集合 _id 唯一性天然防并发双写)。

该集合是「谁授权了到期微信提醒」的记录(仅 `remindNotify` 云函数读写):小程序端在保存带提醒的物品时经 `wx.requestSubscribeMessage` 请求授权,用户同意后 `recordSubscription` 落一条(openid、household_id、member_key、template_id、updated_at、last_sent_date);每日 08:00 timer 扫描「今天/明天到期」的 active 提醒,按家庭聚合成一条订阅消息卡片发送给该家庭全部合格订阅者。**落 openid 的原因**:微信订阅消息 `touser` 只接受 openid,云函数侧无 openid 即无法发送;隔离措施:集合权限对所有用户不可读不可写(仅云函数管理端可访问),云函数日志绝不落 openid/member_key,发送前逐条资格复核(订阅后被移出家庭/家庭解散即停止推送)。安全披露详见对应 PR 描述。

**⑧ video_evidence / video_upload_tickets(单件视频留证;先建集合再部署 itemsApi)**:

> 创建 `video_upload_tickets`、`video_evidence` 与 `video_item_locks` 三个集合,权限全部并入 ③(「所有用户不可读不可写」)。`video_evidence` 建组合唯一索引:字段一 `household_id`(升序)+ 字段二 `item_id`(升序)+ 字段三 `file_id`(升序),勾选「**唯一**」;`video_upload_tickets` 与 `video_item_locks` 无需额外索引(`_id` 天然唯一)。`video_item_locks` 是物品级 attach/delete 互斥锁,60s 过期可接管。
>
> 用途:用户在物品详情页明确选择**一件**物品后,申请服务端上传票据 -> 客户端按票据路径上传原视频 -> 凭票据绑定证据。服务端校验票据属于当前家庭与该物品、文件路径与票据完全一致、文件可通过云函数换临时链接;读取端只按家庭 + 未删物品返回。一个视频只绑定用户当前确认的一件物品;首版不做批量识物、不自动合并同名实物、不自动生成高亮框。
>
> 保留与删除:视频默认折叠,用户点击后才播放;删除视频时逐文件确认云存储删除成功后才删证据行;删除物品与 attach 共用 `video_item_locks` 物品锁,清理 bound 证据与已回执 file_id 的 pending 票据,云删除失败则物品删除失败并保持可重试。上传成功后客户端立即回执 file_id 并保留本地 pending。**禁止对整个 `video-evidence/` 前缀配置统一 24h 生命周期删除**;孤儿回收只由 `videoCleanup` 按数据库票据 file_id 选择性执行,并会恢复超时卡在 binding/cleaning/cancelling 的票据。

**⑨ location_scans(位置级视频清点,issue #94/D1;先建集合与索引,再部署 itemsApi/locations/videoCleanup)**:

> 创建 `location_scans` 集合,权限并入 ③(「所有用户不可读不可写」)。索引两条(索引管理,人工步骤):
>
> - 唯一索引:字段一 `household_id`(升序)+ 字段二 `scan_id`(升序),勾选「**唯一**」——`(household_id, scan_id)` 是清点落库的幂等硬门,不建则并发/重试可能双写 scan 行;
> - 非唯一索引:`household_id`(升序)+ `location_id`(升序)+ `created_at`(升序)——位置页「上次清点」最新一条查询(`locationScanLatest`)。
>
> 另:`video_evidence` 建议增补非唯一索引 `household_id` + `scan_id`(D1 只写不查,影响后续 join 效率,缺失不破坏正确性)。
>
> 用途:位置页「📹 拍视频清点这里」——对某位置录 5–20 秒视频,本地抽帧 + AI 逐帧识别候选物品,用户逐件确认(可新建/关联已有/移动到当前位置)后批量建物品并共享同一段视频证据;每次拍摄落一条 scan 记录(候选/确认计数、视频回看链接),位置页底部显示「上次清点」,首页不展示清点记录。写侧分工:itemsApi 写创建/lifetime 计数,locations 写删除级联的状态标记(见 `docs/API_CONTRACT.md`)。
>
> D2 已落地(issue #96):位置页提供**清点历史列表**(`locationScanHistory`,最近 20 次,只列本位置未终结记录)与**用户删除单次清点**(`scanDelete`,只删 scan 审计行;若视频没有其他引用则一并删除云文件,绝不影响已录入物品与它们的证据);**0 确认 scan 的视频不会被 videoCleanup 的 24h 孤儿回收**(视频是清点记录的一部分),保留满 30 天后由每日 `videoCleanup` 到期回收——云文件删除、scan 行保留并标记「视频已过期回收」(计数与创建时间不动),用户确认过(≥ 1 件)的视频永不自动回收;位置被清空(purge)后终态的 0 确认记录同样在 30 天后回收,用户手动删除的记录已在删除当场结算、不重复回收。

### 5. 为 extractDraft 与 locations 配置 DEEPSEEK_API_KEY

云开发控制台 → 云函数 → extractDraft → 配置 → 环境变量,添加 `DEEPSEEK_API_KEY`,值为你在 DeepSeek 开放平台(https://platform.deepseek.com)创建的 API Key。**locations 云函数需要配置同名同值的环境变量**(空间树的位置解析要用同一个 Key)。

- Key **只**从云函数环境变量读取(`cloudfunctions/extractDraft/index.js` 与 `cloudfunctions/locations/index.js`),绝不出现在代码、小程序端或日志中。
- 未配置时 extractDraft 一律返回 `AI_UNAVAILABLE` 并提示「可手动录入」,locations 的解析/整户扫描同样返回 `AI_UNAVAILABLE` 并提示「可手动选择位置」——这是设计内行为,不是故障。
- itemsApi 不需要任何环境变量。

### 6. 部署云函数

在微信开发者工具的资源管理器中,分别右键 `cloudfunctions/itemsApi`、`cloudfunctions/extractDraft`、`cloudfunctions/locations`、`cloudfunctions/households`、`cloudfunctions/remindNotify` 与 `cloudfunctions/videoCleanup` →「**上传并部署:云端安装依赖**」。六个云函数除 `wx-server-sdk` 外没有其他 npm 依赖,部署很快。

部署后在控制台调整**函数超时**(默认 3 秒不够用):云开发控制台 → 云函数 → 各自进入「函数配置」→ 编辑 → 超时时间:**extractDraft 改 30 秒**(要等 DeepSeek 推理),**itemsApi 建议 10 秒**(避免冷启动偶发超时),**locations 必须改 60 秒**(整户扫描最坏 ~50 秒:三块并行解析 + 一次近义比对;代码内 `config.json` 已写 60,以控制台为准),**households 建议 10 秒**(普通数据库操作,`config.json` 已写 10),**remindNotify 建议 20 秒**(每日扫描 + 逐订阅发送,`config.json` 已写 20),**videoCleanup 建议 20 秒**(`config.json` 已写 20)。也可用 CLI 部署:`cli cloud functions deploy --env <环境ID> --names itemsApi extractDraft locations households remindNotify videoCleanup --project <项目根> -r`;注意 CLI 部署**不会**应用 `config.json` 的超时设置,超时只能在控制台调。

**timer 触发器**:
- remindNotify:`dailyExpiryNotify`(cron `0 0 8 * * * *`,每天 08:00,北京时间);
- videoCleanup:`dailyVideoCleanup`(cron `0 0 4 * * * *`,每天 04:00,北京时间),先恢复超时卡在 binding/cleaning/cancelling 的票据,再删除超过 24h 仍为 pending 且已回执 `file_id` 的孤儿视频,不触碰 bound 证据。

开发者工具上传部署会带 `config.json` 里的 triggers;若用 CLI 部署后发现触发器缺失,在控制台手动新建对应触发器,并可在控制台「手动执行」一次验证。

issue #34 P1-A 起,`itemsApi`、`locations`、`households` 与 `remindNotify` 四个函数持有逐字节同源的家庭解析副本,**升级时四者必须一起部署**(避免「items 写共享域、locations 写私人域」的 split-brain);extractDraft/transcribe 不涉及家庭解析,无此约束。

### 7. 小程序里验证

编译运行小程序(工具内即可):首页输入「降压药放在厨房第二个抽屉」→ 点击提取 → 确认页应出现 AI 草稿 → 保存 → 首页「找东西」输入「降压药」应查到位置。空间树:首页「我的家」→ 进入生成向导把已录入物品的位置整理成「房间 → 家具 → 抽屉」的树,确认入库后即可在「我的家」里逐层浏览物品。自动化端到端:`node tests/e2e/smoke.js`、`node tests/e2e/full-loop.js`、`node tests/e2e/locations.js`(需先开自动化端口,见各文件头注释);其中 locations.js 覆盖「录入 → 生成向导 → 确认入库 → 逐层下钻到物品」的完整闭环——未配置 DEEPSEEK_API_KEY 或超时仍为默认 3 秒时,向导扫描会如实报「AI 暂时不可用」,两项控制台配置(上文步骤 5、6)完成后重跑 `node tests/e2e/locations.js` 即可补全向导全流程验证。

### 8. 语音录入(可选,需腾讯云语音识别)

首页「记一件」支持语音模式(按住说话,松开识别,自动提取)。采用**原生录音 + 腾讯云一句话识别**(微信「同声传译」插件不支持个人主体,故未采用):

1. [腾讯云控制台](https://console.cloud.tencent.com) → 搜索「语音识别」→ 开通(有免费额度)
2. 右上角头像 → 访问管理 → API 密钥管理 → 新建密钥(SecretId / SecretKey)
3. 云开发控制台 → 云函数 → `transcribe` → 配置 → 环境变量:添加 `TENCENT_SECRET_ID` 与 `TENCENT_SECRET_KEY`
4. 部署 `transcribe` 云函数(同步骤 6 的方式,或 CLI:`cli cloud functions deploy --env <环境ID> --names transcribe --project <项目根> -r`)

未配密钥时语音如实返回「识别暂不可用」并引导文字输入;麦克风授权(`scope.record`)首次使用会弹窗,后台「用户隐私保护指引」需声明麦克风用途(提审前必办)。语音耗时埋点见 `docs/PR2.md`。

### 9. 单件视频留证(受控试验)

首版只做「单件物品的视频历史证据 + 查找后主动回放」:

1. 打开某件物品详情,点「🎬 给这件物品拍一段视频留证」;
2. 明确同意视频保存/删除说明后,拍摄或选择视频;
3. 客户端先调 `itemsApi.videoUploadBegin` 申请服务端上传票据,再按票据路径 `wx.cloud.uploadFile`;
4. 上传成功后先调 `videoUploadReceipt` 回执 fileID,再调 `videoEvidenceAttach` 绑定该物品;服务端校验票据归属、文件路径与文件可用性,并以 CAS 与清理/取消互斥;
5. 绑定成功后详情页出现折叠视频卡;默认不播放,用户明确点击后展开并用原生 `<video>` 播放;
6. 搜索命中物品时结果行显示「▶ 视频」角标,用于提示可回看;
7. 删除待关联视频由服务端 `videoUploadCancel` 判断:若已绑定则只修复状态不删文件;未绑定才逐文件确认删除,失败保留 pending 与回收责任。

首版明确不做:批量抽屉识物、跨帧同名自动合并、自动高亮框、默认自动播放。上传成功但绑定失败会留在「视频待关联」状态,可重试或删除;不会以 toast 宣告保存成功。

## 真实样例试运行(npm run samples:live)

`tests/fixtures/samples/` 下有 16 条中文样例(每条 `{ id, text, expect }`),覆盖典型一句话、带限定语、多件需拆分、口语化模糊位置、无位置信息、可容忍别字、长度边界与无法提取名称。两种运行方式:

```bash
npm run samples:live                                # 未设 DEEPSEEK_API_KEY:打印操作指引,退出码 0
export DEEPSEEK_API_KEY=sk-xxxxxxxx                 # 换成你自己的 Key(仅当前终端会话有效)
npm run samples:live                                # 逐条真实调用 DeepSeek,与 expect 逐字段对比
```

真实调用完成后,Markdown 结果表写入 `docs/samples-evidence.md`(样例、类别、成功/失败、差异);存在失败样例时退出码为 1。注意此脚本在**本机**直接调用 DeepSeek API(不经云函数),用于验证提取质量;云函数侧的行为已由离线测试覆盖。

## 隐私与安全

- **日志只记元数据,不记内容**:itemsApi 的日志只含 `action`、错误码、耗时、计数(`lib/handler.js` 的 `logResult`);extractDraft 的日志只含文本长度、耗时、错误码(`lib/handler.js`);households 的日志只含 `action`、错误码、耗时、计数(`lib/handler.js`,邀请令牌绝不进日志)。各套测试有专门用例断言日志不出现物品名、位置、原文、身份、openid/member_key、裸令牌/令牌哈希、家庭名与 operation_id 原文。
- **身份不下库、不上传**:云函数用 `getWXContext().OPENID` 取身份,落库的是 `household_id = "hh_" + sha256(openid) 前 32 位`,不存裸 openid;家庭共享(issue #34)的会员表/活跃指针/邀请表同样只存服务端派生的 `member_key = sha256(openid)` 全文摘要与 `sha256(邀请令牌)`;邀请裸令牌只在 inviteCreate 响应出现一次;客户端不信任、不上传任何身份字段,服务端对 event 里的身份字段一律忽略。
- **软删除抹内容**:删除不是打标记了事,而是同时把 `name`、`name_norm`、`location_text`、`note` 全部抹成空字符串,文档里不再残留隐私内容;查询与列表永远过滤已删除文档。
- **密钥只走环境变量**:DeepSeek API key 只存在于云函数环境变量中,代码、样例、测试、小程序端与日志里都没有;`lib/deepseek.js` 只接受调用方传参,不读环境变量、不打印请求内容。

## 常见问题

**Q:`npm test` 报 `Could not find ... tests/**/*.test.js` 之类错误?**
测试脚本用 glob 匹配测试文件,需要 Node.js 21+。运行 `node --version` 确认;建议用 nvm 切换到新版 Node。

**Q:小程序一启动就弹「请先配置云环境」?**
`miniprogram/config.ts` 的 `cloudEnv` 还是占位符 `YOUR_ENV_ID`,按部署步骤 3 替换为你的云环境 ID。

**Q:提取按钮总是提示「AI 暂时不可用,可手动录入」?**
按设计这是可用的降级路径,但根因通常是 extractDraft 未配置环境变量 `DEEPSEEK_API_KEY`(部署步骤 5)。配置后无需重新部署代码,但云函数可能有短暂缓存,必要时重试或重新部署该函数。

**Q:同一条记录保存了一次却出现两条?**
确认 items 集合已建 `(household_id, operation_id)` 组合唯一索引(部署步骤 4)。代码层的先查后插已挡住先后到达的重放;唯一索引挡住并发重放。

**Q:查「充电线」查不到「iPhone 充电线」?**
能查到:查询词与名称都会归一化(全角转半角、忽略大小写、去空白与标点),且支持前缀与包含匹配——输入「iphone」是前缀命中,输入「电线」是包含命中。若确实查无此物,返回空列表是正常结果,不是错误。

**Q:保存时提示「内容已被修改,已为你刷新,请重试」?**
两个客户端同时改同一条记录触发了乐观并发保护(至多一笔成功)。页面已自动拉取最新内容,基于刷新后的内容再点一次保存即可。

**Q:删除的记录还能恢复吗?**
不能。软删除会抹掉全部内容字段,页面上也不再出现;这是隐私设计,没有恢复入口。

**Q:想看真实 API 的提取效果?**
见上文「真实样例试运行」,设置 `DEEPSEEK_API_KEY` 后运行 `npm run samples:live`,结果表在 `docs/samples-evidence.md`。
