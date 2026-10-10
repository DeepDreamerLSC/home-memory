# API 契约(home-memory PR1 文字闭环 + issue #18 Location Tree)

## 产品与范围
用户用一句话记录物品位置(如「降压药放在厨房第二个抽屉」),AI 提取草稿,用户确认后入库;之后按名称查询位置;可修改位置、删除。核心原则:AI 只生成待确认草稿,绝不直接写事实;不确定时禁止猜测;任何失败绝不静默写入。issue #18 起位置沉淀为可浏览的递归空间树(locations 集合 + pages/locations 浏览 + 生成向导),物品经挂载字段关联到树节点,原始 location_text 永不改写。

## 技术栈(固定)
微信原生小程序(TypeScript 预编译:改动 .ts 后 npm run build:mp 在源码旁产出同名 .js,.ts 与 .js 成对提交;不用 useCompilerPlugins,实测部分版本 CLI 构建不产出 JS)→ wx.cloud.callFunction → 微信云开发 Node.js 云函数(JavaScript CommonJS,除 wx-server-sdk 外零 npm 依赖)→ CloudBase 文档数据库,items 与 locations 两个集合。不引入 Redis、向量库、FastAPI、自研队列。DeepSeek API 仅服务端调用。

## 目录结构(固定)
- project.config.json(miniprogramRoot 为 "miniprogram/",cloudfunctionRoot 为 "cloudfunctions/",appid 占位 "touristappid")
- miniprogram/:app.ts/app.json/app.wxss、sitemap.json、tsconfig.json、config.ts、types.ts、utils/api.ts、utils/locations-api.ts、pages/index、pages/confirm、pages/item、pages/locations、pages/locationScan(每个页面 4 件套:.ts/.json/.wxml/.wxss)
- cloudfunctions/itemsApi/:index.js(薄适配层)、lib/handler.js(纯函数,依赖注入)、lib/normalize.js、package.json
- cloudfunctions/extractDraft/:index.js、lib/handler.js、lib/deepseek.js、lib/validate.js、package.json
- cloudfunctions/locations/:index.js(胶水层 + DEEPSEEK_API_KEY 检查)、config.json(超时 60 秒)、lib/handler.js(db 类 action 路由)、lib/parse.js(parseLocation/scanHousehold LLM 编排)、lib/validate.js(LLM 输出校验 + 有序锚定)、lib/tree.js(纯函数:子树收集/path 级联/深度)、lib/normalize.js(与 itemsApi 逐字节同源副本)、lib/deepseek.js(与 extractDraft 逐字节同源副本)、package.json
- tests/:helpers/memoryDb.js、itemsApi.test.js、extractDraft.test.js、locations.test.js、transcribe.test.js、glue.test.js、voice.test.js、samples-live.js、fixtures/samples/ 下若干 JSON 样例
- docs/:API_CONTRACT.md(本文件)、design/location-tree.md(issue #18 设计合同)、PR1.md(文档阶段编写)
- 根 package.json:scripts 为 test 等于 "node --test tests/"、typecheck 等于 "tsc -p miniprogram --noEmit"、samples:live 等于 "node tests/samples-live.js";devDependencies 仅 typescript 与 miniprogram-api-typings

## 身份与隔离
云函数用 cloud.getWXContext().OPENID 取身份;household_id 等于 "hh_" 拼接 sha256(openid) 十六进制的前 32 位(避免裸 openid 落库)。客户端传来的 household_id/openid 一律忽略;itemsApi 与 locations 的 handler 不得从 event 读取任何身份字段,身份只来自 deps.householdId(由 index.js 从 OPENID 派生),缺失时返回 UNAUTHORIZED。locations 的 household_id 派生与 itemsApi 完全同款,保证两个函数落到同一家庭。所有读写都必须带服务端派生的 household_id 条件;跨家庭访问统一表现为 NOT_FOUND。一个微信用户等于一个私人家庭空间。README 需说明建议为 items 建 (household_id, operation_id) 唯一索引、为 locations 建 (household_id, parent_id, name_norm) 唯一索引;代码中先查后插 + E11000 回查实现幂等。items 增可空字段 location_node_id 且唯一写入方为 locations 函数,一切写入均为版本条件更新(见下)。

## items 集合文档
字段:_id(等于 "it_" 加服务端随机串)、household_id、name(去空白后 1-50 字)、name_norm、location_text(去空白后 1-200 字)、note(≤200,可空字符串)、version(从 1 起)、deleted(false)、operation_id(创建幂等键,非空 ≤64)、last_update_id(可选,最近一次带 update_id 的成功更新回写的标识,≤64)、last_update_fingerprint(可选,该次更新内容字段的稳定指纹:键排序 JSON 字符串,重放识别用)、created_at(ISO 字符串)、updated_at(ISO 字符串)、location_node_id(可空,issue #18 新增:挂载的 locations 节点 _id;缺失/null = 未挂载;指向不存在节点 = 悬挂,读侧按未挂载容忍。itemsApi 对该字段一律忽略、投影不含;唯一写入方是 locations 云函数,且一切写入均为「以读到的当前 version 为条件」的条件更新并 +1——与 itemsApi.update 完全同构的单一版本链,系统内不存在对 version 的无条件改写)。所有面向客户端的响应只给投影字段 { item_id, name, location_text, note, version, updated_at },绝不包含内部字段。

## normalizeName(s)
NFC 归一 → 全角转半角 → 小写 → 去所有空白字符 → 去中英文标点。name_norm 与查询词都经过它。

## itemsApi 协议
event 形如 { action, ... };统一响应 { ok:true, ... } 或 { ok:false, error:CODE, message(中文,可直接给用户看) }。错误码:INVALID_INPUT、NOT_FOUND、VERSION_CONFLICT、UNAUTHORIZED、OPERATION_CONFLICT。
- create:入参 { action:"create", operation_id, name, location_text, note? }。校验:operation_id 非空 ≤64;name 去空白后 1-50;location_text 去空白后 1-200;note ≤200。校验失败返回 INVALID_INPUT 且绝不写入。**幂等只对「同键同内容」成立**:查 (household_id, operation_id, deleted:false) 已有——name/location_text/note 与本次一致则返回 { ok:true, item(投影), duplicated:true };内容不同则返回 { ok:false, error:"OPERATION_CONFLICT", message:"这条已保存过且内容与当前填写不同,请到详情页修改", existing(投影,已删时不下发) },绝不静默返回旧数据。并发下唯一索引拒绝第二笔插入时:捕获重复键错误后回查,按上述同款规则返回稳定结果(同内容 duplicated;异内容或命中已删文档 OPERATION_CONFLICT,已删变体 message 说明已删除)。新插入 version=1、deleted=false,返回 { ok:true, item(投影), duplicated:false }。
- update:入参 { action:"update", item_id, expected_version, update_id?, location_text?, name?, note? }。update_id 可选(非空 ≤64),标识同一次逻辑修改,用于响应丢失后的重试重放。至少一个可变字段,字段校验同上。条件更新:where(_id 等于 item_id 且 household_id 匹配且 deleted 为 false 且 version 等于 expected_version)更新字段、version 加一、updated_at 刷新(name 变则 name_norm 重算;带 update_id 时回写 last_update_id 与 last_update_fingerprint——指纹只覆盖内容字段,不含版本元数据)。命中 1 条返回 { ok:true, item(投影) };命中 0 条再查该 _id 与 household_id 且未删:存在且**三重条件同时成立**(version 恰为 expected_version+1、last_update_id 等于本次 update_id、last_update_fingerprint 等于本次内容指纹)判定为「自己刚写入但响应丢失」的重放,返回 { ok:true, item(投影), replayed:true };相同 update_id 但内容不同一律 VERSION_CONFLICT,绝不把新内容当重放吞掉;其余存在即 VERSION_CONFLICT,不存在即 NOT_FOUND。
- delete:入参 { action:"delete", item_id }。条件更新 where(_id 且 household_id 且 deleted 为 false)置 deleted 为 true 并把 name、name_norm、location_text、note 全部抹成空字符串。返回 { ok:true };查无则 NOT_FOUND。查询与列表永远过滤 deleted 为 false。
- get:入参 { action:"get", item_id }。按 id 单查(where _id 且 household_id 且 deleted 为 false),返回 { ok:true, item(投影) };查无或越权均 NOT_FOUND。用于详情页冲突刷新等场景,不受 list 分页截断影响。
- query:入参 { action:"query", q }。q 去空白后非空否则 INVALID_INPUT。nq 为 normalizeName(q);按 name_norm 精确匹配优先、其次前缀匹配、最后包含匹配,各自按 updated_at 降序,合并去重,最多 20 条,返回 { ok:true, items:[{item_id,name,location_text,note,version,updated_at}], match_type:"exact" 或 "prefix" 或 "contains" 或 "none" }。无结果是正常结果(items 为空数组)。
- list:入参 { action:"list", limit? }。deleted 为 false,updated_at 降序,limit 默认 50、最大 50,返回 { ok:true, items:[同上] }。
- 未知 action、缺必填字段一律 INVALID_INPUT。
- handler 是纯函数:handler(event, deps),deps = { db, now(), genId(), householdId, logger },依赖注入以便离线测试;index.js 只做 wx-server-sdk 胶水。logger 只输出 action、错误码、耗时、计数,绝不输出原文、身份、物品名、位置。

## extractDraft 协议
### v2 多件拆分协议(Issue #14,2026-10-10)
event = { text, protocol: 2 }:显式 protocol:2 时走多件拆分;不带 protocol 的旧客户端完全维持 v1 单件行为(兼容硬门,旧客户端不受影响)。v2 prompt 要求把一句话里的 1-5 件物品逐件输出到 items 数组,每件含 name/location_text/certain/qualifiers/source_quote;多件共用位置合法(按原文归属,不确定则该件 certain=false);source_quote 必须是原话逐字子串(去空白比对),不是则服务端置空字符串(确认页标「来源不充分」,不废整件);items 为空或超 5 件返回 AI_UNAVAILABLE(重试机制兜底);某件名称等硬校验失败整次拒绝(不静默丢件)。位置锚定校验:certain=true 时 location_text 必须出现在该件 source_quote 内(证据为空时以整句原话为锚),否则降级 certain=false 并清空位置(交用户补填,不废件);anchor_shared 标记该件证据片段同时含其他物品名称(典型:整句原话)——归属无法确定性排除交叉配对,前端默认不勾选、标「位置请核对」。has_more 透传 truncated(超 5 件),且前端对恰好 5 件也显示核对提示(不信任模型自报)。成功返回 { ok:true, drafts:[{ name, location_text, certain, qualifiers, source_quote, anchor_shared }], original_text, truncated },单件时 drafts 长度为 1。前端:草稿经 utils/draft-session 会话传给确认页(URL 只带 sid;持久层只存最新一个会话,24 小时恢复窗口),确认页列表式批量确认,逐行走 create(行内固定 operation_id,失败单行重试幂等,已保存行不再提交);保存中行状态逐行回写会话,中途退出/进程回收后首页显示「继续核对」恢复入口——沿用原 operation_id 与已保存状态,已保存行不再提交,不重复建档;全部完成或放弃离场即清会话。

### v1 单件协议(旧)
event = { text },text 去空白后 1-500 字,否则 INVALID_INPUT。服务端调用 DeepSeek Chat Completions(地址 https://api.deepseek.com/chat/completions),model 为 "deepseek-flash",temperature 0.1,请求体显式包含 "thinking":{"type":"disabled"} 禁用思考,要求只输出 JSON,超时 20 秒。API key 只从云函数环境变量 DEEPSEEK_API_KEY 读取,绝不硬编码、绝不出现在小程序端与日志。
system prompt 要点:家庭物品位置提取器;从一句话提取一件物品的名称与位置;位置必须来自原文,禁止猜测编造,不肯定时 certain 为 false 且 location_text 为空字符串;「右边」「第二个」「最下层」等限定语放 qualifiers;一句话含多件物品时 needs_split 为 true;只输出 JSON,字段:name(≤50)、location_text(≤200,可为空)、certain(布尔)、qualifiers(字符串数组,每项 ≤20 字,最多 5 个)、needs_split(布尔,默认 false)。
服务端校验 validateDraft:JSON 解析失败则把错误提示回传 LLM 重试一次,仍失败返回 AI_UNAVAILABLE;needs_split 为 true 返回 { ok:true, needs_split:true, message:"一次只记一件物品,请分开说" };certain 为 false 时强制 location_text 为空字符串;certain 为 true 但 location_text 为空则按不肯定处理;name 去空白后为空返回 AI_UNAVAILABLE;长度与类型不符按上述规则拒绝,仅允许对 qualifiers 数量截断。callLLM 抛错、超时、HTTP 非 200 返回 { ok:false, error:"AI_UNAVAILABLE", message:"AI 暂时不可用,可手动录入", manual_fallback:true }。成功返回 { ok:true, draft:{ name, location_text, certain, qualifiers } }。handler 为纯函数,deps = { callLLM(text), logger }。日志只记:文本长度、耗时、错误码;禁止记录原文与提取结果。

## locations 集合文档(issue #18)
字段:_id(等于 "lc_" 加 24 hex)、household_id(服务端派生,客户端不可见不可传)、parent_id(父节点 _id;home 根为空字符串)、name(去首尾空白后 1-30 码点)、name_norm(normalizeName 同款)、type("home" | "room" | "furniture" | "container",按深度映射:depth1=room、2=furniture、≥3=container)、path(从根不含 home 根到本节点含的名字数组;home 根为 [])、created_from("bootstrap" | "scan" | "parse" | "manual")、created_at、updated_at(ISO)。
- **home 根节点**:每 household 恰一个,type=home、name 固定「我的家」、path=[]、parent_id="",由 list 根层请求/ensurePath 惰性创建;不可改名、不可移动、不可合并、不可删除(INVALID_INPUT);物品不允许直接挂 home 根(linkItem/applyScan 校验)。
- **深度约束**:path.length ∈ [1,6],container 允许嵌套封顶 6 层。
- **删除语义:硬删除**(与 items 软删除不同:节点只是派生结构,历史由 items.location_text 承载;软删除会占唯一索引槽导致「删掉书房后无法重建书房」)。空节点保护 + 删除后补偿摘除(见 locations 协议 delete)。
- **挂载不变量(如实表述)**:目标不变量是「任何未删 item 的 location_node_id 指向存在的节点」;无跨文档事务下以三层机制尽力维护——① 删除保护(有物品挂载的子树删不掉);② 删除/merge 的收尾补偿扫描(同一次调用内条件摘除悬挂挂载);③ 读侧容忍(list/scanHousehold 遇悬挂按未挂载处理并计入 dangling_mounts 如实上报)。补偿与并发 linkItem 之间仍有极窄理论窗口,不宣称并发下绝对成立,承诺单线程语义成立 + 并发下可自愈(悬挂件回流扫描池)。
- **唯一索引(人工步骤)**:(household_id, parent_id, name_norm) 组合唯一;并发同名兄弟创建由数据库拒绝,E11000 捕获后回查复用,绝不双建。
- **权限(人工步骤)**:「所有用户不可读不可写」(全部访问走云函数)。

## locations 协议(issue #18)
event = { action, ... };节点 id 参数均为 location_id(文档 _id),物品 id 为 items 文档 _id。统一响应 { ok:true, ... } 或 { ok:false, error:CODE, message(中文) };业务错误可附 detail(结构化补充,如冲突清单、计数——用户自己的数据回给本人,绝不进日志)。错误码固定 7 个:INVALID_INPUT(未知 action/字段非法/对 home 根非法编辑/路径超 6 层)、NOT_FOUND(节点或物品不存在/跨家庭/已删)、UNAUTHORIZED、VERSION_CONFLICT(挂载的乐观并发冲突,含 merge 物品阶段中止)、NODE_NOT_EMPTY(删除保护,附 detail:{ item_count, descendant_count })、NODE_CONFLICT(同级同名/移动到自身后代/合并冲突,附 detail:{ clashing_names })、AI_UNAVAILABLE(附 manual_fallback:true)。日志只记 action/error/ms/count(LLM 类另记 text_length/items_scanned/chunks/elapsed_ms),绝不记录位置名/物品名/原文/身份/模型输出。
- **list**:入参 { action:"list", parent_id? }(缺省 = home 根层,惰性建根,幂等)。返回 { ok:true, node, children, items, unmounted_count, dangling_mounts }:node/children 为节点摘要 { location_id, name, type, path, item_count(整棵子树未删物品数), child_count, created_from, updated_at };items 为直接挂载该节点的未删物品投影;unmounted_count = 未删且未挂载(缺失/null/悬挂)物品数,dangling_mounts 为其中悬挂件数;children 按 item_count 降序、同数按 name 升序,items 按 updated_at 降序。parent 不存在/跨家庭 → NOT_FOUND。
- **ensurePath**(全系统唯一建节点入口):入参 { action:"ensurePath", path:[1-6 段,每段去空白 1-30 码点], created_from?("scan"|"parse"|"manual",缺省 manual) }。自 home 根逐段 find-or-create(type/path 按深度映射),只创建不改已存在节点、不碰 items;按路径幂等(同 path 重复调用返回相同节点序列);并发 E11000 回查复用。返回 { ok:true, nodes(与 path 等长的摘要), created(布尔数组) }。
- **rename**:入参 { node_id, name }。校验存在、type≠home、新名 1-30 码点、同级 name_norm 不重名(NODE_CONFLICT)。更新自身并把全部后代 path 级联重写;绝不碰 items(location_text 原始话语不变,挂载引用节点 id 不受影响)。返回 { ok:true, node }。
- **move**:入参 { node_id, new_parent_id }。校验两节点存在、双方 type≠home、new_parent 非自身及其后代(NODE_CONFLICT「不能移动到自己下面」)、新家同级不重名(NODE_CONFLICT)、移动后子树深度 ≤6(否则 INVALID_INPUT「层级太深了」)。parent_id 更新 + 子树 path 前缀整体重写,不碰 items。返回 { ok:true, node }。
- **merge**:入参 { source_node_id, target_node_id }。校验双方存在、source≠target、双方 type≠home、type 相同、target 非 source 后代、双方直接子节点无 name_norm 重名(NODE_CONFLICT 附 clashing_names)。执行顺序:① 物品阶段——逐件条件重挂载到 target(version 条件更新 + 派生 last_update_id,0 命中回查:已挂 target/重放识别则视为完成,否则中止整单返回 VERSION_CONFLICT 附 detail:{ conflicted },已成功件保持、重试安全);② 后置校验循环直至 source 直接挂载物品清空;③ 结构阶段——source 直接子节点 parent_id 改指 target(id 不变,挂在后代上的物品零改动);④ 硬删 source + 补偿扫描摘除悬挂挂载(计入 compensated)。返回 { ok:true, node, remounted, compensated, compensated_skipped }。收敛语义:重试时已完成件识别跳过;source 已删则 { ok:true, detail:{ already_merged:true } }。
- **delete**:入参 { node_id, force? }。统计子树(自身+后代)未删物品数与后代节点数:force 缺省/false 时非空即 NODE_NOT_EMPTY(附 detail 计数);force=true 时子树仍有任何未删物品依旧 NODE_NOT_EMPTY(物品永远不能被结构操作丢弃),无物品的空分支整支硬删除。删除后补偿扫描:对被删节点 id 集合查悬挂挂载并逐件条件摘除(置 null、version+1、派生标识),计入 compensated,UI 如实展示。返回 { ok:true, deleted_nodes(含自身), compensated, compensated_skipped }。删后重建同名节点可行(硬删除语义)。
- **linkItem / unlinkItem**:入参 { item_id, node_id(仅 linkItem;type≠home)/-, expected_version(正整数), update_id(非空 ≤64,失败重试同内容复用) }。与 itemsApi.update 完全同构:条件更新 where(_id 且 household 且 deleted:false 且 version=expected_version)置 { location_node_id, version:+1, updated_at, last_update_id, last_update_fingerprint };命中返回 { ok:true, item:{ item_id, version, updated_at } };0 命中回查三重条件(版本恰为 expected+1、last_update_id 相同、指纹一致)成立返回 { ok:true, replayed:true, item },否则 VERSION_CONFLICT / NOT_FOUND。内部批量写入(merge 重挂/补偿摘除/applyScan)不用客户端 update_id,改用确定性派生标识 "<op>:" + sha256 前 16 hex(≤27 字符),同输入恒同值,是收敛式重试的前提。
- **parseLocation**(LLM,零写库):入参 { text }(去空白 1-200 码点)。既有树(≤120 节点,超出只送前两层)序列化进 prompt;返回 { ok:true, parse:{ segments:[{ name, type, confidence }](1-6 项), need_confirm, order_violation, merge_suggestions:[{ segment_index, existing_location_id, existing_name, reason }] } }。need_confirm 置真(任一):任一段 confidence<0.8;有序锚定未通过(含顺序违规,另置 order_violation);某段未锚定且无合并建议覆盖;模型自报不确定。本 action 绝不写库,响应永远是候选。
- **scanHousehold**(LLM,零写库):入参 { action:"scanHousehold" }。扫描池 = 未删除且未挂载(缺失/null/悬挂——悬挂件回流自愈)物品,updated_at 降序取前 30(增量:已挂载件不进池);空位置件进池、不送 LLM、归入 skipped(reason:"位置为空")。其余按 3 块并行(每块 ≤10 件,单块超时 15s,坏 JSON 重试一次),归并成候选树(同层 name_norm 去重,结构由构造保证)后追加一次轻量近义比对调用(输入仅各层名字列表,超时 10s 重试一次);任一块或近义调用失败 → 整体 AI_UNAVAILABLE(不部分成功)。返回 { ok:true, scan:{ scanned, unmounted_total, truncated, candidate_tree(节点含 confidence/need_confirm/children/merge_hints), synonym_groups:[{ level, names, reason }], mounts:[{ item_id, name, location_text, version, path, confidence, need_confirm, order_violation }](version 供 applyScan 作 expected_version), skipped:[{ item_id, name, reason }] } }。
- **applyScan**(向导确认结果的一次性提交,收敛式幂等):入参 { operation_id(非空 ≤64,失败重试/恢复原样复用), branches:[{ path }](纯结构确认,0-30 条), mounts:[{ item_id, expected_version, path }](逐件完整确认路径,1-30 件,branches 与 mounts 相互独立、无前缀约束,mount 完整 path 由本 action 沿路径建到容器末段) }。参数结构校验失败 → INVALID_INPUT 且零写入。执行:每条 branch 与每件 mount 的完整 path 复用 ensurePath 同款逻辑(created_from:"scan")取末段节点,再版本条件更新挂载(派生标识 "scan:"+digest(operation_id+":"+item_id));逐件 0 命中回查:重放识别或已挂目标 → already,否则 conflict(绝不静默覆盖),物品不存在/已删/跨家庭 → not_found。返回 { ok:true, result:{ branches:[{ path, created, location_ids }], mounts:[{ item_id, status("mounted"|"already"|"conflict"|"not_found"), version?, current_version? }] } }。幂等为收敛式而非快照式:重放返回当前收敛状态,可能与首次响应不同(status 迁移),UI 按「继续完成剩余件」表述。
- **item_location_history(位置变更历史预留层,issue #18 v4)**:独立集合,append-only——只插入、不更新不删除,无唯一索引需求。字段:household_id(服务端派生,随写入隔离)、item_id、from_node_id(可 null)、to_node_id(可 null)、changed_at(ISO)、source("link" | "unlink" | "merge" | "apply_scan" | "compensate",与五个挂载写入方一一对应)。**唯一写入方是 locations 云函数**:全部挂载写入在版本条件更新处统一收口,真实变更(from ≠ to)追加一行;from == to 空变更不记;update_id/派生标识重放不进入历史写入,天然不重复;历史写失败不阻断挂载主流程(预留审计层,挂载结果才是事实)。V1 无读取 UI、无查询 action,**本契约不承诺任何查询接口**;权限与其他集合同款「所有用户不可读不可写」(README 部署步骤 4)。

## parseLocation / scanHousehold LLM 契约(issue #18)
- system prompt 要点:家庭位置结构解析器;每条位置拆 1-6 段从大到小;每段名字必须逐字取自原文且按原文顺序,禁止改写概括调序;每段给 confidence(0-1),拿不准给低分、宁可低分不可编造;与【既有空间树】同层同名或近义的段在 merge_suggestions 给建议;只输出一个 JSON 对象。近义比对 prompt 只归「很可能指同一处」的名字组,拿不准不归。
- 服务端校验:JSON 提取容忍围栏(照 extractDraft 手法),坏 JSON 带错误重试一次仍失败 AI_UNAVAILABLE;segments 1-6 项、name 1-30 码点、confidence ∈ [0,1]、type 一律按深度修正;merge_suggestions 引用不存在节点则丢弃该条不失败,服务端对同名命中自动补全建议。
- **有序不重叠锚定**:每段在 normalizeName(text) 中求匹配区间,要求按段序单调递增且互不重叠;违规 → order_violation:true 且强制 need_confirm(高置信错序也不许默认勾选入库)。
- 防火墙不变量:两 action 执行前后 locations/items 集合零变化(离线测试直查断言);全系统只有 ensurePath(含 applyScan 内部复用)创建节点且只由用户确认后的客户端调用;need_confirm 草案 UI 必须呈现待核对状态(默认不勾选/标黄)。
- 耗时与超时:scanHousehold 最坏 ≈50s(3 块并行各 15s×2 + 近义 10s×2 串行)< 函数 60s 上限;客户端超时 parseLocation 30s、scanHousehold/applyScan 70s,均严格大于服务端对应预算,优先让服务端错误回来。模型 deepseek-flash、temperature 0.1、thinking disabled、response_format json_object;密钥只走云函数环境变量 DEEPSEEK_API_KEY(与 extractDraft 同名同法),缺失返回 AI_UNAVAILABLE 且 manual_fallback:true。

## 小程序流程(TypeScript)
- config.ts 导出 cloudEnv(占位 "YOUR_ENV_ID",README 说明替换);app.ts 中 wx.cloud.init({ env: cloudEnv, traceUser:false })。
- utils/api.ts:类型化封装 callItemsApi/callExtractDraft,统一超时与错误映射(错误码到用户可读中文);包含 operation_id 的 uuid 生成。utils/locations-api.ts:callLocationsApi 重载族(11 个 action,函数名 "locations";超时 parseLocation 30s、scanHousehold/applyScan 70s、其余 15s,均大于服务端预算;中文兜底文案表;LocationsApiError 保留服务端 detail 供删除保护/合并冲突分支展示)。
- pages/index(首页):「记一件」textarea 输入一句话后调 extractDraft:needs_split 则 toast 提示拆分;AI_UNAVAILABLE 则弹确认后带 manual=true 进确认页;成功则带草稿进确认页。「找东西」输入名称调 itemsApi query,结果列表显示名称、位置、更新时间,点击进详情页。下方「最近记录」用 list。次级卡「我的家」一行入口 → pages/locations(不抢语音主视觉,首页不预取计数)。
- pages/confirm(确认页):标识「AI 草稿,请确认」;名称、位置、备注可编辑,位置为空时提示必填;manual 模式为空白表单;保存调 create(operation_id 用 uuid),成功 toast「已记住」返回首页;OPERATION_CONFLICT 时弹窗引导「去详情页」(携带服务端下发的 existing)或留在本页,绝不静默;其余失败如实提示。
- pages/item(详情页):查看与修改名称、位置、备注,保存带 expected_version 与 update_id(uuid;同样内容的失败重试复用同一 update_id,内容一变即换新);VERSION_CONFLICT 则提示并以 get 按 id 刷新版本号与元数据(保留用户未保存的编辑,绝不无提示覆盖),由用户检查后重试;删除需 wx.showModal 确认,删除后返回。支持 ?item_id= 按 id 直接打开(get 单查)。次级按钮「挂到空间」:parseLocation 出候选分段(可逐段改,need_confirm/order_violation 标黄,同名提示「入库会直接用已有位置」)→ 用户确认后 ensurePath(created_from:"parse")+linkItem(expected_version=当前版本);AI_UNAVAILABLE 兜底为 locations 选择模式手动选;VERSION_CONFLICT 走既有刷新逻辑。
- pages/locations(我的家,树浏览):?node_id= 逐层下钻(面包屑 + 子节点列表显示整棵子树物品数 + 该层直接挂载物品列表,物品点进详情);根层常驻「生成/更新空间树」入口(unmounted_count 计数、dangling_mounts 如实提示,空库存时诚实提示先去记东西);手动添加位置(showModal editable → ensurePath created_from:"manual");节点「⋯」→ 改名/移动/合并/删除(移动与合并以 ?picker=1 选择模式重入自身:移动排除自身子树、合并仅列同 type,选中经 EventChannel 回传后执行 move/merge;删除先试探,NODE_NOT_EMPTY 按 detail 分流——有物品引导进去移走、空分支 force 二次确认;compensated>0 如实 toast);物品「⋯」→ 移动到…(linkItem,冲突提示刷新)/从这里摘除(unlinkItem,原始 location_text 保留)。
- pages/locationScan(生成向导,可重复进入):进入即 scanHousehold(增量池);AI_UNAVAILABLE → 错误态 + 重试 + 「先手动建房间」引导;truncated 顶部明示「未归位共 N 件,本次扫描最近 30 件」。候选树拍平渲染(need_confirm 分支默认不勾选且标黄、可改名、勾选级联整条分支;与既有同名分支提示「入库会直接用已有位置」);synonym_groups 呈现「〔合并〕〔分开〕」由用户裁决(合并 = 选保留名后同层归并);mounts 逐件勾选(need_confirm/order_violation 默认不勾并标黄);skipped 区单列(空位置/分段为空,给「去详情页」引导,绝不假消失)。确认入库 = 单次 applyScan(operation_id 全程复用),提交前完整请求写入 storage(键 location_scan_pending),onLoad 检测未清除记录则弹「继续完成?」(继续 = 同 operation_id 重放,放弃 = 清记录不做假回滚);结果逐件渲染 mounted/already/conflict(引导去详情页)/not_found,零静默。
- 语音修改位置不在本 MVP(issue #18 Phase 3 后续设计),页面无任何语音改位置的入口或占位。
- UI 全中文、样式只用 app.wxss 的 CSS 变量(跟随系统深浅色);不信任也不传 household_id。

## 离线测试规范
全部 node:test 加 node:assert,CommonJS,零外部依赖;测试只 require cloudfunctions 下各 lib 与 tests/helpers,绝不 require wx-server-sdk。memoryDb 模拟 CloudBase 语义:collection(name).add(doc);.where(cond).get()(AND 等值匹配);.where(cond).update(data) 返回 { stats:{ updated:n } };.doc(id).get() 与 .doc(id).update(),并按集合可配置唯一索引(items 的 (household_id, operation_id) 与 locations 的 (household_id, parent_id, name_norm))模拟 E11000。验收十场景:首次录入、同名不同件、移动、纠正、模糊别名、AI 失败、查无此物、越权、重试并发、删除——除「AI 失败」外均属 itemsApi 测试,「AI 失败」与拆分、不肯定、幻觉防护、坏 JSON 重试、空名称等属 extractDraft 测试;两套身份(两个 openid 派生的 householdId)交叉越权用例必须存在。locations.test.js 覆盖:跨家庭隔离(TS-ISO)、ensurePath 幂等与 E11000 回查(TS-EP)、parseLocation 零写库与 need_confirm/错序强制(TS-NC1)、scanHousehold 零写库/增量池口径/空位置件 skipped(TS-NC2)、merge 级联与冲突中止收敛(TS-MG)、delete 保护与补偿(TS-DL)、linkItem/unlinkItem 不破坏 itemsApi 版本链与重放识别(TS-LK1/LK2/LK3,与 itemsApi 在同一 memoryDb 上交叉驱动)、applyScan 收敛幂等(TS-AS)、扫描编排与块间近义(TS-SCAN)、rename/move 级联与防环(TS-RN/TS-MV)、list 计数口径(TS-LST)、挂载不变量与读侧容忍(TS-INV)、日志脱敏(TS-LOG)、副本逐字节同源(TS-SRC)。并发残余窗口(补偿后与 linkItem 交错)无跨文档事务不可离线复现,不在测试承诺内,可离线验证的部分(补偿、读侧容忍)已覆盖。

## 样例集
tests/fixtures/samples/ 下至少 15 条中文样例 JSON,每条 { id, text, expect },expect 为 { draft:{...} } 或 { needs_split:true } 或 { error:"AI_UNAVAILABLE" };覆盖典型一句话、带限定语、多件需拆分、口语化模糊位置、无位置信息、可容忍别字、长度边界。extractDraft.test.js 用样例驱动 mock callLLM。samples-live.js:未设 DEEPSEEK_API_KEY 时打印操作指引并以退出码 0 结束;设置后真调 API,逐条与 expect 对比,结果表写入 docs/samples-evidence.md。

## transcribe 协议(PR2 新增,提请评审确认)
微信「同声传译」插件不支持个人主体,语音转文字改为独立云函数:原生录音(mp3/16k/单声道/24kbps,≤60 秒,约 180KB)→ base64 → 腾讯云一句话识别(请求含官方条件必填的 DataLen)→ 文字。这回到 issue #1 最初的模型最窄入口设计 transcribe(audio)→text,与 extract_items(text) 分离;无状态、不落库、输入输出即焚。

event = { audio_base64(非空,base64 后 ≤3MB,官方限额), voice_format(字母数字,如 "mp3") }。
- 校验失败 → { ok:false, error:"INVALID_INPUT", message(中文) },绝不发起调用
- 密钥(TENCENT_SECRET_ID/TENCENT_SECRET_KEY)缺失或 ASR 调用失败/超时(15s) → { ok:false, error:"ASR_UNAVAILABLE", message:"语音识别暂不可用…", manual_fallback:true },客户端回退文字输入
- 成功 → { ok:true, text(已 trim) }
- 日志只记:音频字符数、格式、耗时、错误码;绝不打印音频数据与识别结果。密钥仅云函数环境变量,绝不入库/入码/入日志。
- 超时 20 秒(config.json);除 wx-server-sdk 外零 npm 依赖(TC3 签名手写纯函数)。
