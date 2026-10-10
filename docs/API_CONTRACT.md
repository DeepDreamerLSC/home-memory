# API 契约(home-memory PR1 文字闭环)

## 产品与范围
用户用一句话记录物品位置(如「降压药放在厨房第二个抽屉」),AI 提取草稿,用户确认后入库;之后按名称查询位置;可修改位置、删除。核心原则:AI 只生成待确认草稿,绝不直接写事实;不确定时禁止猜测;任何失败绝不静默写入。

## 技术栈(固定)
微信原生小程序(TypeScript,由开发者工具内置 tsc 编译,project.config.json 已配 useCompilerPlugins 为 ["typescript"])→ wx.cloud.callFunction → 微信云开发 Node.js 云函数(JavaScript CommonJS,除 wx-server-sdk 外零 npm 依赖)→ CloudBase 文档数据库,仅一个 items 集合。不引入 Redis、向量库、FastAPI、自研队列。DeepSeek API 仅服务端调用。

## 目录结构(固定)
- project.config.json(miniprogramRoot 为 "miniprogram/",cloudfunctionRoot 为 "cloudfunctions/",appid 占位 "touristappid")
- miniprogram/:app.ts/app.json/app.wxss、sitemap.json、tsconfig.json、config.ts、types.ts、utils/api.ts、pages/index、pages/confirm、pages/item(每个页面 4 件套:.ts/.json/.wxml/.wxss)
- cloudfunctions/itemsApi/:index.js(薄适配层)、lib/handler.js(纯函数,依赖注入)、lib/normalize.js、package.json
- cloudfunctions/extractDraft/:index.js、lib/handler.js、lib/deepseek.js、lib/validate.js、package.json
- tests/:helpers/memoryDb.js、itemsApi.test.js、extractDraft.test.js、samples-live.js、fixtures/samples/ 下若干 JSON 样例
- docs/:API_CONTRACT.md(本文件)、PR1.md(文档阶段编写)
- 根 package.json:scripts 为 test 等于 "node --test tests/"、typecheck 等于 "tsc -p miniprogram --noEmit"、samples:live 等于 "node tests/samples-live.js";devDependencies 仅 typescript 与 miniprogram-api-typings

## 身份与隔离
云函数用 cloud.getWXContext().OPENID 取身份;household_id 等于 "hh_" 拼接 sha256(openid) 十六进制的前 32 位(避免裸 openid 落库)。客户端传来的 household_id/openid 一律忽略;itemsApi 的 handler 不得从 event 读取任何身份字段,身份只来自 deps.householdId(由 index.js 从 OPENID 派生),缺失时返回 UNAUTHORIZED。所有读写都必须带服务端派生的 household_id 条件。一个微信用户等于一个私人家庭空间。README 需说明建议为 (household_id, operation_id) 建唯一索引;代码中先查后插实现幂等。

## items 集合文档
字段:_id(等于 "it_" 加服务端随机串)、household_id、name(去空白后 1-50 字)、name_norm、location_text(去空白后 1-200 字)、note(≤200,可空字符串)、version(从 1 起)、deleted(false)、operation_id(创建幂等键,非空 ≤64)、last_update_id(可选,最近一次带 update_id 的成功更新回写的标识,≤64)、last_update_fingerprint(可选,该次更新内容字段的稳定指纹:键排序 JSON 字符串,重放识别用)、created_at(ISO 字符串)、updated_at(ISO 字符串)。所有面向客户端的响应只给投影字段 { item_id, name, location_text, note, version, updated_at },绝不包含内部字段。

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
event = { text },text 去空白后 1-500 字,否则 INVALID_INPUT。服务端调用 DeepSeek Chat Completions(地址 https://api.deepseek.com/chat/completions),model 为 "deepseek-flash",temperature 0.1,请求体显式包含 "thinking":{"type":"disabled"} 禁用思考,要求只输出 JSON,超时 20 秒。API key 只从云函数环境变量 DEEPSEEK_API_KEY 读取,绝不硬编码、绝不出现在小程序端与日志。
system prompt 要点:家庭物品位置提取器;从一句话提取一件物品的名称与位置;位置必须来自原文,禁止猜测编造,不肯定时 certain 为 false 且 location_text 为空字符串;「右边」「第二个」「最下层」等限定语放 qualifiers;一句话含多件物品时 needs_split 为 true;只输出 JSON,字段:name(≤50)、location_text(≤200,可为空)、certain(布尔)、qualifiers(字符串数组,每项 ≤20 字,最多 5 个)、needs_split(布尔,默认 false)。
服务端校验 validateDraft:JSON 解析失败则把错误提示回传 LLM 重试一次,仍失败返回 AI_UNAVAILABLE;needs_split 为 true 返回 { ok:true, needs_split:true, message:"一次只记一件物品,请分开说" };certain 为 false 时强制 location_text 为空字符串;certain 为 true 但 location_text 为空则按不肯定处理;name 去空白后为空返回 AI_UNAVAILABLE;长度与类型不符按上述规则拒绝,仅允许对 qualifiers 数量截断。callLLM 抛错、超时、HTTP 非 200 返回 { ok:false, error:"AI_UNAVAILABLE", message:"AI 暂时不可用,可手动录入", manual_fallback:true }。成功返回 { ok:true, draft:{ name, location_text, certain, qualifiers } }。handler 为纯函数,deps = { callLLM(text), logger }。日志只记:文本长度、耗时、错误码;禁止记录原文与提取结果。

## 小程序流程(TypeScript)
- config.ts 导出 cloudEnv(占位 "YOUR_ENV_ID",README 说明替换);app.ts 中 wx.cloud.init({ env: cloudEnv, traceUser:false })。
- utils/api.ts:类型化封装 callItemsApi/callExtractDraft,统一超时与错误映射(错误码到用户可读中文);包含 operation_id 的 uuid 生成。
- pages/index(首页):「记一件」textarea 输入一句话后调 extractDraft:needs_split 则 toast 提示拆分;AI_UNAVAILABLE 则弹确认后带 manual=true 进确认页;成功则带草稿进确认页。「找东西」输入名称调 itemsApi query,结果列表显示名称、位置、更新时间,点击进详情页。下方「最近记录」用 list。
- pages/confirm(确认页):标识「AI 草稿,请确认」;名称、位置、备注可编辑,位置为空时提示必填;manual 模式为空白表单;保存调 create(operation_id 用 uuid),成功 toast「已记住」返回首页;OPERATION_CONFLICT 时弹窗引导「去详情页」(携带服务端下发的 existing)或留在本页,绝不静默;其余失败如实提示。
- pages/item(详情页):查看与修改名称、位置、备注,保存带 expected_version 与 update_id(uuid;同样内容的失败重试复用同一 update_id,内容一变即换新);VERSION_CONFLICT 则提示并以 get 按 id 刷新版本号与元数据(保留用户未保存的编辑,绝不无提示覆盖),由用户检查后重试;删除需 wx.showModal 确认,删除后返回。
- UI 全中文、样式简洁;不信任也不传 household_id。

## 离线测试规范
全部 node:test 加 node:assert,CommonJS,零外部依赖;测试只 require cloudfunctions 下各 lib 与 tests/helpers,绝不 require wx-server-sdk。memoryDb 模拟 CloudBase 语义:collection(name).add(doc);.where(cond).get()(AND 等值匹配);.where(cond).update(data) 返回 { stats:{ updated:n } };.doc(id).get() 与 .doc(id).update()。验收十场景:首次录入、同名不同件、移动、纠正、模糊别名、AI 失败、查无此物、越权、重试并发、删除——除「AI 失败」外均属 itemsApi 测试,「AI 失败」与拆分、不肯定、幻觉防护、坏 JSON 重试、空名称等属 extractDraft 测试;两套身份(两个 openid 派生的 householdId)交叉越权用例必须存在。

## 样例集
tests/fixtures/samples/ 下至少 15 条中文样例 JSON,每条 { id, text, expect },expect 为 { draft:{...} } 或 { needs_split:true } 或 { error:"AI_UNAVAILABLE" };覆盖典型一句话、带限定语、多件需拆分、口语化模糊位置、无位置信息、可容忍别字、长度边界。extractDraft.test.js 用样例驱动 mock callLLM。samples-live.js:未设 DEEPSEEK_API_KEY 时打印操作指引并以退出码 0 结束;设置后真调 API,逐条与 expect 对比,结果表写入 docs/samples-evidence.md。
