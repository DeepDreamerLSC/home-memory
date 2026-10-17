# 拍照识物 · 实现说明(#3,IMPLEMENTATION)

本文是设计合同(docs/design/issue3-photo-intake/README.md,V0.4.2)与原型 prototype.html(交互行为基准)的**工程落地说明**。后续四个实现工程师只依据本文工作,不需要再做任何设计决策;所有开放点均已拍板,拍板处标 ⚖️。
基线:分支 `feat/issue3-photo-intake`,`npm test` 542 项全绿、`npm run typecheck` 通过(2026-10-17 实测)。

阅读约定:
- 「屏①-⑥」指 prototype.html 的六个 screen;原型 script 部分(prototype.html:484-750)是交互行为的逐条基准,验收对照第 9 节清单。
- 代码引用 `路径:行` 均为当前分支实际行号。

---

## 0. 范围与总架构

一句话:拍照 → 本地压缩 → **base64 直传** `extractDraft.vlRecognize` 识别(候选+框;**确认前不持久化、不写云存储;识别需临时传输(传输即处理,不落盘),首次使用需用户授权**)→ 拍照确认页(photo 页,三态候选+语音受限编辑+圈选补识别)→ 用户最终确认 → `wx.cloud.uploadFile` 上传**同一张压缩图**得 file_id → `itemsApi.photoCommit` 批量建档+落 `photo_evidence` 证据行 → 详情页 `itemsApi.photoEvidenceGet` 回放历史证据。

四个新云函数动作、一个新集合、一个新页面、若干新 utils(photo-box / intake-draft / photo-vl / photo-session)、若干既有文件的最小侵入扩展。

**不引入 `items.quantity`**(数量冻结为 note 文本,设计合同 V0.4);**不改 confirm 文字链路任何行为**(现状锁);**VL 链路不接 DeepSeek 降级**(deepseek-flash 无视觉模型,只走本地 VL 引擎);**照片在用户最终确认保存之前不持久化、不写云存储**(#65 V0.4 合同第五项边界;PR #67 B4 措辞精确化:识别走 callFunction 载荷把本地压缩图 base64 **临时传输**到云函数处理——传输即处理、内存态、不落盘,与 `utils/voice.ts` 音频 base64 → transcribe 同款先例,**首次使用需用户授权**(photo 页一次性授权弹窗,拒绝则本次不识别只走手动/语音);确认前不产生任何云端文件,放弃/识别失败零云端残留)。

---

## 1. API 契约(4 个新动作)

### 1.0 归属与理由(⚖️ 维持任务建议的归属)

| 动作 | 归属云函数 | 理由 |
| --- | --- | --- |
| `vlRecognize` | extractDraft | extractDraft 定位是**无状态 LLM 服务**(`cloudfunctions/itemsApi/lib/household.js:5-6` 头注释明确「extractDraft/transcribe 为无状态服务,不引入家庭解析」);vlRecognize 同样无 DB、无身份依赖、**不读云存储**(图片经 event.image_base64 直传)。复用其 LLM 客户端形态(`lib/local-llm.js` 的围栏剥离/UA/超时纪律)与「调用→校验→JSON 失败重试一次」链路(`lib/handler.js:204-233`)。不新建云函数 = 不新增部署单元。 |
| `draftEditParse` | extractDraft | 纯文本解析,复用既有 local→DeepSeek 双引擎降级链(`lib/handler.js:235-250`)与 validate 模式;无状态、无 DB。 |
| `photoCommit` | itemsApi | 写 items + 必须过 `resolveActiveHousehold` 失败关闭与共享家庭写硬门(`cloudfunctions/itemsApi/lib/handler.js:2053-2060`);逐件建档**直接复用既有 `createItem`**(`lib/handler.js:892-1051`,幂等/提醒 slot 全套白拿),证据行与 items 同作用域。 |
| `photoEvidenceGet` | itemsApi | 读侧同样必须按服务端解析的 household_id 过滤(itemsApi 现有 query/list 同款纪律);且需要云函数侧 `getTempFileURL` 换临时链接(见 §6)。 |

部署面(两个云函数都要重新上传,详见 §10)。

### 1.1 `extractDraft` · `vlRecognize`(视觉识别)

**event**(`miniprogram` → 云函数,经 `wx.cloud.callFunction`;客户端封装 `utils/photo-vl.ts`):

```jsonc
{
  "action": "vlRecognize",
  "image_base64": "/9j/4AAQ…",       // 必填,本地压缩图(长边 ≤1280/JPEG q70)的裸 base64(无 data: 前缀/空白),长度 ≤4,000,000 字符、解码 ≥1B
  "img_w": 1280,                    // 必填,客户端 wx.getImageInfo 实测**压缩后**那张图的宽(px),正整数 ≤10000
  "img_h": 960,                     // 必填,同上
  "mode": "full",                   // 可选,"full"(默认)| "region"
  "region": { "x1":0.06,"y1":0.69,"x2":0.29,"y2":0.93 }  // mode="region" 必带:0-1 相对压缩后整图(用户圈选)
}
```

**隐私红线**:识别**不经云存储**——没有 file_id、没有 downloadFile 路径(服务端刻意不留旁路,旧式 file_id 事件按 INVALID_INPUT 拒绝);图片只在本次调用载荷里经过云函数内存,不落任何持久层;**识别=把照片临时传输到云端处理(传输即处理,不落盘),首次使用需用户授权**(photo 页一次性授权弹窗,PR #67 B4)。确认后的上传(§1.3 photoCommit 的 `photo.file_id`)上传的是**同一张压缩图**,坐标基准(img_w/img_h)全程一致。

校验(任一不过 → `{ok:false,error:"INVALID_INPUT",message:"照片参数不合法"}`):
- `image_base64` 非空裸 base64 字符串;长度 ≤ **4,000,000 字符**(PR #67 B5:callFunction 事件整体上限 5MB,4,000,000 字符 ≈3.83MB 为事件 JSON 外壳留余量;原 10MB 解码门在 5MB 事件上限下形同虚设,已废除——超出字符门直接拒绝不解码;解码后 ≥1B 门保留),超出 → 客户端提示「照片过大,请靠近重拍」;
- `img_w`/`img_h` 正整数 ≤10000;
- `mode="region"` 时 `region` 四值均为有限数 ∈[0,1] 且 `x2>x1`、`y2>y1`。

**执行链**(handler 新增分支,依赖全部注入便于离线测试):
1. 形状校验与大小门(上述);
2. `deps.callVL(promptText, imageBase64)`(`lib/vl.js`,见下;imageBase64 为 event 原样,服务端不二次编码)——**未注入时直接返回**:
   ```jsonc
   { "ok": false, "error": "AI_UNAVAILABLE", "message": "拍照识别暂不可用,可手动添加",
     "manual_fallback": true, "reason": "vl_not_configured", "engine": "vl-local" }
   ```
   (任务要求「环境变量缺 VL_MODEL 时返回 engine unavailable」的具体形态;三件套缺任一同款,见 lib/vl.js 的 isVlConfigured。参数门先于引擎门:未配置时超限图片仍是 INVALID_INPUT。)
3. 输出经 `validateVlOutput` 校验(JSON 解析失败带错误重试一次,同 `runEngineChain` 的 retryable 口径);仍败 → AI_UNAVAILABLE(engine:"vl-local",manual_fallback:true)。**无降级引擎**。

**lib/vl.js(新文件,~150 行)**,纪律与 `lib/local-llm.js` 逐条对齐:
- 环境变量三件套:`VL_BASE`(含 `/v1` 基址)、`VL_TOKEN`(Bearer)、`VL_MODEL`(模型路径);可选 `VL_TIMEOUT_MS`(默认 **30000**)。`isVlConfigured()`:三件套任一缺失 → false(index.js 据此不注入 callVL)。
- `callVlModel(promptText, imageBase64, timeoutMs)`:POST `{base}/chat/completions`,请求体:
  ```jsonc
  { "model": VL_MODEL, "temperature": 0.1, "max_tokens": 2000,
    "chat_template_kwargs": { "enable_thinking": false },
    "messages": [ { "role": "user", "content": [
      { "type": "text", "text": promptText },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64," + imageBase64 } }
    ] } ] }
  ```
- 自定义 `User-Agent: home-memory-cloudfn/1.0`(Cloudflare 边缘检测,同 local-llm.js:31);响应围栏剥离**复用 local-llm.js:62-73 `stripResponseFence` 同款逻辑**(vl.js 内复制一份,两函数族互不 require——仓库现有 extractDraft/locations 的 deepseek.js 就是逐字节副本纪律);content 空/缺失/HTTP 非 200/网络错/超时 → reject(错误只带错误码,绝不带 token/地址/图片数据)。

**提示词(prompt 要点,组装在 handler 里)**:
- 角色:家庭物品识别器;照片是家中一个收纳空间(抽屉/柜子)的照片;找出全部可辨认识的物品。
- 每件输出:`name`(中文 ≤50 字)、`qty_note`(数量线索原样,如「约2根」「」)、`confidence` ∈ "high"|"mid"|"low"、`box`。
- **坐标量纲(必须逐字写进提示词,这是唯一的量纲声明)**:`box` 为 `[x1,y1,x2,y2]` 四个 0-1000 的整数,归一化到图片宽高,(0,0) 在左上角,x1<x2,y1<y2。看不清的也输出,confidence 给 "low"。
- `mode="region"` 时追加:用户圈出的区域(0-1000 坐标)`x1,y1,x2,y2`,请优先识别该区域内的物品,结合整张照片一起判断(原型屏⑤「你圈的框 + 整张抽屉照片一起看」)。
- 只输出一个 JSON 对象 `{"items":[…],}`,≤10 件,无其他文字/围栏。

**响应 ok**:

```jsonc
{
  "ok": true,
  "engine": "vl-local",
  "items": [
    { "name": "黄色薯片罐", "qty_note": "", "confidence": "mid",
      "box": { "x1": 0.273, "y1": 0.389, "x2": 0.593, "y2": 0.507 } }
  ],
  "img_w": 1024, "img_h": 768
}
```

- `items` ≤10 项;`name` 非空 ≤50 码点;`qty_note` ≤40 码点(可空串);`confidence` 词表外按 "low";**`box` 为 null 或缺省合法**(=该件无框,整照关联)。
- 超过 10 件只取前 10(如实截断,响应加 `"truncated": true` ⚖️)。

**日志纪律**:只记 `{action, elapsedMs, engine, itemcount, error?}`,绝不落 base64、识别结果、prompt 原文。

### 1.2 `extractDraft` · `draftEditParse`(语音受限编辑解析)

**event**:

```jsonc
{
  "action": "draftEditParse",
  "text": "第3个是品客的薯片罐,已经空了,放厨房去",  // 必填,去空白后 1-200 码点(短指令,超限 INVALID_INPUT)
  "batch_location": "玄关柜 · 第二层抽屉",              // 必填,当前批次默认位置(给模型看),≤200
  "candidates": [                                      // 必填,1-12 项
    { "draft_id": "c3f8…", "name": "黄色薯片罐" }       // draft_id ≤32;name 1-50
  ]
}
```

**响应 ok**(五分支,`intent` 是判别字段):

```jsonc
// ① intent="edit":按内容词锁定了唯一候选,逐字段修改(0-3 项)
{ "ok": true, "engine": "local", "intent": "edit",
  "target": { "draft_id": "c3f8…", "matched_word": "品客的薯片罐" },
  "edits": [
    { "field": "name",     "old": "黄色薯片罐", "new": "品客薯片罐" },
    { "field": "qty_note", "old": "(数量不确定)", "new": "(空罐)" },
    { "field": "location", "old": "玄关柜·第二层", "new": "厨房" }
  ],
  "needs_pick": false, "picks": [] }

// ② intent="add":补遗漏(用户说了清单里没有的物品)
{ "ok": true, "engine": "local", "intent": "add",
  "added": { "name": "五号电池", "qty_note": "还有几节" },
  "needs_pick": false, "picks": [] }

// ③ intent="batch_location":改批次默认位置(如「这批都在客厅电视柜」)
{ "ok": true, "engine": "local", "intent": "batch_location",
  "new_location": "客厅电视柜", "needs_pick": false, "picks": [] }

// ④ needs_pick=true:歧义(指代对上多个候选 / 模型给的 draft_id 不在清单),绝不执行
{ "ok": true, "engine": "local", "intent": "edit",
  "target": null, "edits": [],
  "needs_pick": true, "picks": [ { "draft_id": "…", "name": "黑色小盒子" }, … ] }

// ⑤ intent="none":没解析出任何操作(闲聊/无关/信息不足)
{ "ok": true, "engine": "local", "intent": "none", "needs_pick": false, "picks": [] }
```

**提示词要点**:你是照片候选清单的语音编辑解析器;只解析、不回答;按**内容词**把用户话里的物品对到 candidates 的某一件(name 相近即可,如「品客的薯片罐」→「黄色薯片罐」),**绝不按「第N个」这类行号/顺序锁定**(用户删行重排后行号会漂移,原型 V0.4 表格「第3个行号漂移」条);三类操作(改候选字段 / 补遗漏新物品 / 改批次位置)一句话可能同时含多类时**只取最主要的一类**,其余忽略并在 `matched_word` 外如实丢弃(⚖️ 单意图返回,diff 弹层一次处理一个意图,契约简单可测);对不上唯一候选时 `needs_pick=true` 并把可能的候选放进 picks;只输出 JSON。

**服务端硬门**(handler 校验,不信任模型输出):
- `edits[].field` ∈ {"name","qty_note","location"} 白名单,`new` 非空 ≤200 码点,`old` ≤200(仅展示用);数组 ≤3 项,超出截断到 3(⚖️);
- `intent="edit"` 时 `target.draft_id` 必须 ∈ `candidates`,**不在 → 服务端强制改判 `needs_pick=true`、`picks=candidates 全量`、`edits=[]`**(「没对上就不改,让你点选」);
- `intent="add"` 时 `added.name` 非空 ≤50;`intent="batch_location"` 时 `new_location` 非空 ≤200;
- `needs_pick=true` 时 `edits` 必须为空、`target` 必须为 null(形状互斥,客户端不做二次判断);
- **绝不触 itemsApi 写**:本函数无 DB 客户端、无 openid 依赖(结构上不可能写,红线再写一遍);返回的 edits 只作用于客户端本地拍照草稿。

**引擎链**:复用 extractDraft 现有 local→DeepSeek 降级(handler 里与提取共用 runEngineChain 形态;DeepSeek 是合法兜底,纯文本任务)。失败 → AI_UNAVAILABLE,客户端 toast 不弹 diff。

**日志纪律**:只记 `{action, textLength, candidateCount, elapsedMs, engine, intent, error?}`,绝不记原文/候选名/edits。

### 1.3 `itemsApi` · `photoCommit`(批量建档 + 证据行)

**event**(写类 action,进 `WRITE_ACTIONS`,`miniprogram/utils/api.ts` 的 `ITEMS_MUTATING_ACTIONS` 自动拼双 marker):

```jsonc
{
  "action": "photoCommit",
  "batch_id": "b7e2…",                     // 客户端 uuid,8-64,仅日志聚合
  "expected_household_id": "hh_…",          // 会话开批时捕获的家庭(PR #67 B1):服务端与当前派生家庭
                                             // 不一致 → SCOPE_MISMATCH 零写入;api 层自动 marker 不覆盖显式携带值
  "items": [                                // 1-10 件,超出 INVALID_INPUT
    {
      "operation_id": "…uuid…",             // 行内固定幂等键(重试沿用;内容改后仍沿用,服务端同键同内容幂等/异内容冲突)
      "name": "品客薯片罐",                  // 1-50
      "location_text": "厨房",               // 1-200(批次位置或该件例外,客户端已合成)
      "note": "×1 (空罐)",                   // 可选 ≤200(数量备注,客户端拼 "×{qty} {suffix}")
      "reminder": { "due_date": "2026-11-20", "kind": "有效期", "quote": "…", "remind_converted": false },  // 可选,与 create 完全同形状
      "photo": {                             // 可选(该行绑了照片证据才有)
        "file_id": "cloud://…",              // 用户点「确认,记住了」后才 uploadFile 得到(确认前不存在;上传的是识别用的同一张压缩图)
        "img_w": 1024, "img_h": 768,         // 该压缩图实测宽高(与 vlRecognize 上送值一致)
        "box": { "x1":0.27,"y1":0.39,"x2":0.59,"y2":0.51 },   // null 合法(无框/手动行)
        "source": "vl"                       // "vl" | "circle"
      }
    }
  ]
}
```

**响应**:

```jsonc
{ "ok": true,
  "results": [
    { "index": 0, "ok": true, "item_id": "it_…", "duplicated": false, "evidence_saved": true,
      "version": 1 },                    // #65 ③:建档后版本(duplicated 重放时为既有文档当前版本),
                                        // 客户端随后 ensureAndLink 挂树的 expected_version 取它;旧客户端忽略
    { "index": 1, "ok": false, "error": "OPERATION_CONFLICT", "message": "…" }
  ],
  "evidence_failed": ["it_…"]   // PR #67 C3:证据写入失败(物品已建)的 item_id 列表;
                                // 缺省/空 = 全部证据关联成功。证据写失败不回滚不掩盖、
                                // 不废整批——部分成功语义,客户端走 photoEvidenceRetry 幂等重试(§1.5/§7.9)
}
```

**实现**(lib/handler.js 新增 `photoCommitItem`,~80 行):
1. 整体校验:items 数组 1-10、batch_id 形状;逐件先做**纯参数校验**(name/location_text/note/reminder 与 photo 形状,复用 `cleanRequired`/`cleanOptional`/`parseReminderInput`,photo.box 四值 ∈[0,1] 且 x2>x1/y2>y1 或 null)——任一件参数非法 → **整批 INVALID_INPUT,零写入**(与服务端「校验失败绝不写入」纪律一致;参数错误是客户端 bug,不是运行期冲突)⚖️;**file_id 归属验证(PR #67 B2)**:解析 fileID 携带的云存储路径,前缀 ≠ `photo-evidence/<当前派生家庭>/` → **FILE_NOT_OWNED 整批零写入**;路径解析不出的 file_id(非 cloud:// 形态/无路径段/路径穿越)一律 INVALID_INPUT;
2. 逐件执行:构造 `{operation_id, name, location_text, note, reminder, remind_vague_quote: undefined}` **直接调用既有 `createItem(event, deps)`**(`lib/handler.js:892`)——幂等(operation_id 同键同内容 duplicated)、并发重放收敛、提醒 slot 全套语义白拿;
3. createItem 返回 ok → 若带 photo:查 `photo_evidence` 已有 `(household_id, item_id, file_id)` 行,有 → 跳过(`evidence_saved:false`,重放幂等);无 → add 证据行(§2 schema,`_id = "pe_" + deps.genId()`),`captured_location_text` 取**本件刚提交的 location_text**;
4. createItem 返回 ok:false(OPERATION_CONFLICT 等)→ 该件进 results 的失败项,**不拦其余件**(「一次确认不是数据库原子事务」,与 `miniprogram/utils/batch-save.ts` 逐行哲学一致;原型保存前已有最终确认弹层过目);**证据写入失败同理(PR #67 C3)**:savePhotoEvidence 抛错(非唯一索引冲突的基础设施错误)→ 物品**不回滚**、失败不掩盖、不拦其余件,该 item_id 进响应 `evidence_failed`,全部建完后整体 `ok:true` 返回——重试整批 photoCommit 虽会撞同键 duplicated 不重建物品,但 evidence_failed 才是如实的收敛出口;
5. 证据行 add 抛唯一索引冲突(E11000)→ 回查确认存在即当已保存(并发孪生收敛,同 createItem 的 isDuplicateKeyError 模式);
6. 日志:`{action:"photoCommit", error, ms, count}`(count=成功件数),绝不落物品名/位置/batch 内明细。

### 1.4 `itemsApi` · `photoEvidenceGet`(按 item_ids 查证据)

**event**:`{ "action": "photoEvidenceGet", "item_ids": ["it_…"] }`(1-10 个,形状非法 INVALID_INPUT)。只读,不进 WRITE_ACTIONS。

**响应**:

```jsonc
{ "ok": true,
  "household_id": "hh_…",            // 作用域回显(api.ts captureHouseholdId 用,与 list/remindList 同款)
  "scope_revision": 3,               // 共享家庭才有
  "evidence": [
    { "item_id": "it_…", "file_id": "cloud://…", "photo_url": "https://…",   // getTempFileURL 临时链接,换链失败为 ""
      "box": {…}|null, "img_w": 1024, "img_h": 768,
      "captured_location_text": "客厅电视柜 · 第一层", "source": "vl", "created_at": "2026-10-17T…" }
  ] }
```

**实现**(~60 行):
- 逐 item_id 等值查询 `where({household_id, item_id, })`(AND 等值,**不引入 `db.command.in`**——保持与 `tests/helpers/memoryDb.js` 的等值匹配语义兼容,离线测试零改动;≤10 次查询成本可忽略),每件取 created_at 降序前 3(全量拉回内存排序,同 itemsApi list 的 `byUpdatedDesc` 模式,`lib/handler.js:235-240`);
- 汇总去重 file_id 后 `deps.getTempFileUrls(fileIds)`(index.js 注入 `cloud.getTempFileURL({ fileList })`)换临时链接;单文件换链失败 → 该行 `photo_url:""`(file_id 照返,客户端可重试),**绝不因换链失败废整个查询**;
- 投影绝不包含 household_id 内部字段之外的任何内部态。

### 1.5 `itemsApi` · `photoEvidenceRetry`(证据幂等重试关联,PR #67 C3)

**event**(写类 action,进 `WRITE_ACTIONS`,api 层自动拼双 marker):

```jsonc
{
  "action": "photoEvidenceRetry",
  "file_id": "cloud://…",              // photoCommit 已取得的本批照片 fileID(不再上传)
  "img_w": 1024, "img_h": 768,          // 与 photoCommit 同一组宽高(坐标反算基准)
  "items": [                            // 1-10 件:photoCommit 响应 evidence_failed 里的 item_id
    { "item_id": "it_…", "box": { "x1":0.27,"y1":0.39,"x2":0.59,"y2":0.51 }, "source": "vl" }
  ]                                     // box 可 null(整照关联);source 缺省 "vl"
}
```

**响应**:

```jsonc
{ "ok": true,
  "results": [
    { "index": 0, "item_id": "it_…", "ok": true, "evidence_saved": true },   // false=已存在(唯一索引幂等)
    { "index": 1, "item_id": "it_…", "ok": false, "error": "NOT_FOUND", "message": "…" }  // 跨家/已删/不存在
  ] }
```

**实现**(lib/handler.js `photoEvidenceRetryItem`):
1. **file_id 归属验证**(B2 同款,任何写入之前):路径前缀 ≠ `photo-evidence/<当前派生家庭>/` → FILE_NOT_OWNED 整批零写入;路径解析不出 → INVALID_INPUT;items 形状(item_id 非空、box 四值 ∈[0,1] 或 null、source 词表、1-10 件)非法 → 整批 INVALID_INPUT 零写入;
2. **逐件重验作用域内存活**:item 在当前派生家庭且 deleted:false 才继续,否则该件 NOT_FOUND 失败项(不拦其余件);`captured_location_text` 取该件当前 items.location_text(重验时已读到,客户端无须重传);
3. **逐条插 photo_evidence**(复用 savePhotoEvidence:唯一索引 `(household_id, item_id, file_id)` 冲突 E11000 回查收敛 = 已存在 = 成功,幂等——重复点击、中断重放都收敛,绝不重复落证据行);
4. 单件证据写入失败(非唯一索引冲突的基础设施错误)只进该件失败项(`EVIDENCE_WRITE_FAILED`),不拦其余件;整体 `ok:true` 逐件返回。
无新集合/索引/环境变量(§10 部署清单不变;photo_evidence 唯一索引即幂等依据)。

### 1.6 保存成功后的位置挂树(issue #65 V0.4 第③条;复用 locations.ensureAndLink,无新云函数动作)

**需求**:拍照识物确认位置后,批次位置与逐件例外**像语音录入确认流程一样**挂到位置节点树,用户不必再去主界面二次确认归属。**不新建位置模型/集合**:完全衔接现有 `location_text` / `locations.ensureAndLink` 机制;照片本身不产生位置事实(位置来源仍是用户在确认页明示的文本)。

**机制**(与语音流程同源):语音链路里确认页保存时,`utils/batch-save.ts` 的 `saveRowWithMount` 在 create 成功后对该行调 `locations.ensureAndLink`(建缺失路径 + 按版本条件更新挂上,`created_from="parse"`——路径段逐字取自原话提取的 mount_path)。拍照流程复用**同一个 ensureAndLink API**(`utils/photo-intake.ts` 新增 `mountPhotoItems`,经 `callLocationsApi` 走同一封装/超时/作用域 marker/缓存失效),差异只有两点:

1. **路径段来源**:拍照流程没有 extractDraft 的 mount_path 提取环节,位置是用户手输文本(确认页手动改位置在语音链路 = 清空路径不挂靠;`parseLocation` 是 LLM 候选 + 逐段人工核对的交互式机制)——两处都不是「文本→路径段」的确定性机制,故**新增最小确定性分段工具 `splitLocationSegments`**(新增决策,`utils/photo-intake.ts`):按 `·` `/` `-` `的` 与空白切分,逐段 trim、空段丢弃,**单段=单层**(如「玄关」直接挂根下房间节点);
2. **`created_from="manual"`**(不是 `parse`):路径段来自用户手输位置的确定性拆分,不是原话提取;建出的节点与手动整理位置同源。

**分段形状门**(与 batch-save/服务端 `cleanPathSegments` 同限,限值常量从 batch-save 导出共用):切分后 1-6 段、每段 1-30 码点;超限(如 7 段、单段 31 字)**一律不挂**——返回空数组,绝不静默丢段/截断改名造错误路径(`location_text` 原文已随 photoCommit 落库,查件不受影响)。

**编排**(`pages/photo/photo.ts` `onSaveGoTap` 成功路径 → `runPhotoMounts`,`utils/photo-intake.ts` `planPhotoMounts` 纯函数下沉):
1. 本批唯一位置清单 = 批次位置 + 各已保存件的例外位置(按 trim 后文本去重);每件有效位置 = 例外优先、批次兜底(与 `buildPhotoCommitItems` 的 `location_text` 合成完全同款);
2. 逐位置分段一次,对该位置下**本轮 photoCommit 成功的件**(item_id + version 齐备)逐件 `ensureAndLink`:`{ item_id, path, expected_version: 回执 version, update_id: "photo:"+行内 operationId, created_from: "manual" }`;
3. fire-and-forget:终态(已记住/证据链路)先落,挂树在后,不阻塞任何 UI。

**幂等**(绝不重复挂):
- `update_id = "photo:" + 行内 operationId`——行内 operationId 失败重试/会话恢复全程沿用,同一件无论多少轮都用同一挂树键;服务端 ensureAndLink 本身幂等(tests/locations.test.js TS-EAL-1 锁定:重复同路径 `already:true` 且 version 不再 +1,同 update_id 重放收敛),客户端再以稳定键 + 稳定版本双保险;
- 已 done 行绝不重挂:挂树只发生在保存成功路径、只针对**本轮**回执;会话恢复后 `pending = checked && !done` 天然排除已入库件(PP-MOUNT-3 锁定);`evidenceRetry`(photoEvidenceRetry)与挂树无关,不触发挂树;
- 回执缺 `version`(旧云函数窗口)→ 该件**跳过挂树不误报失败**,计入未挂件数如实轻提示。

**失败语义**(挂树失败**不回滚不阻断**):网络/VERSION_CONFLICT(他人在主界面同时整理)/跨家庭 NOT_FOUND 等任何挂树失败——物品已保存、`location_text` 已落库、行仍是「已确认记住」终态,件照常在「尚未归类」;只轻提示「N 件的位置树没挂上,主界面可补」(N = 失败件 + 无法挂树件),绝不影响保存流程与证据关联。跨家庭安全:ensureAndLink 服务端按当前派生家庭解析物品,他家的 item_id → NOT_FOUND 零写入,共享家庭另受双 marker 硬门。

**测试**:PI-14/15(分段:分隔符/空段/单段/恰 6 段/超 6 段/超 30 码点/空文本)、PI-16(计划:去重分组/例外优先/幂等键确定性/失败件与缺版本件不进/形状不合法计入 skipped)、PI-17(逐件 ensureAndLink 参数与失败计数不抛)、PP-MOUNT-1..4(页面级:参数逐项正确/失败终态不受影响+轻提示/恢复会话已 done 不重挂/旧窗口零调用)、PC-COMMIT-1 与 PC-IDEM(回执 version 字段与重放稳定)。

---

## 2. `photo_evidence` 集合 schema

新集合 `photo_evidence`(控制台人工创建,权限「**所有用户不可读不可写**」,与 household 系列集合同纪律;读写只发生在云函数侧):

```jsonc
{
  "_id": "pe_" + 24hex,                  // deps.genId()(itemsApi/index.js:61-64 同款)
  "household_id": "hh_…",                // 服务端解析,作用域硬隔离(绝不来自 event)
  "item_id": "it_…",                     // 关联物品(写入时已建档)
  "file_id": "cloud://…",                // 云存储 fileID
  "box": { "x1":0.27,"y1":0.39,"x2":0.59,"y2":0.51 },  // 0-1 相对原图左上角;null = 无框(整照关联/手动行)
  "img_w": 1024,                         // 原图像素宽(坐标反算基准,客户端上传时 wx.getImageInfo 实测)
  "img_h": 768,
  "source": "vl",                        // "vl" = AI 识别框 | "circle" = 用户圈选
  "captured_location_text": "客厅电视柜 · 第一层",  // 证据写入时该件的位置文本(回放比对「位置已变更」)
  "created_at": "2026-10-17T08:00:00.000Z"          // deps.now() ISO
}
```

索引(控制台人工建):
- 查询:`(household_id, item_id)` 组合索引;
- 唯一:`(household_id, item_id, file_id)`(photoCommit 重放/并发防重;离线测试在 memoryDb 配 `uniqueIndexes: { photo_evidence: [["household_id","item_id","file_id"]] }`)。

**不引入 `items.quantity`**——数量只存在于 items.note 文本(客户端拼 `×{qty} {suffix}`),photo_evidence 同样无数量字段。

---

## 3. 坐标契约(端到端)

### 3.1 量纲与信任链(⚖️ 核心红线,原型 V0.4 表格「坐标按最大值猜量纲」条)

1. **提示词显式声明 0-1000**(§1.1)——这是模型输出唯一合法量纲;适配层不做任何「看值域像像素就除以宽高」的启发式猜测(禁按最大值猜);
2. **云函数是适配层**:`normalizeVlBox(box1000)` 纯函数(lib/vl.js 导出):
   - 四值均为有限数且 ∈ [0,1000] 且 `x2>x1`、`y2>y1`(面积 >0)→ 各 `/1000` 得 0-1(double),即存储/传输形态;
   - **任一条件不满足 → 整框丢弃:该件 `box=null`,物品候选保留**(越界=不可信=丢框,物品行不丢,只是没有框);
   - 模型给小数/负数/NaN/Infinity/像素值(>1000)一视同仁判不可信,绝不舍入钳制后继续用;
3. **存储与 API 一律 0-1 + 原图宽高**:photo_evidence.box 与所有响应中的 box 都是 0-1;`img_w`/`img_h` 恒随行携带,是唯一的反算基准;
4. `img_w`/`img_h` 来源:客户端 `wx.getImageInfo` 实测**压缩后那张图**(`utils/photo-vl.ts` preparePhotoForVl:压缩产物再实测,压缩器未必精确命中目标尺寸),随 vlRecognize event 传入;确认后上传的是同一文件,photoCommit 带同一组宽高——坐标基准全程一致;云函数**不解析图片二进制**(避免引入 JPEG 解析器,也不猜);
5. 客户端圈选(屏⑤)反向:触点画框 → `containPointToNormalized`(§3.2)得 0-1 → 随 `vlRecognize(mode:"region")` 复用同一份 base64 上送,服务端 ×1000 写进提示词。

### 3.2 客户端换算(新文件 `miniprogram/utils/photo-box.ts`,纯函数)

```ts
export interface Box { x1: number; y1: number; x2: number; y2: number; }   // 0-1
export interface Rect { left: number; top: number; width: number; height: number; }  // 显示 px

/** contain / aspectFit(本功能默认;photo 页与详情页证据卡都用等比完整显示,零裁切) */
export function containRect(box: Box, imgW: number, imgH: number, dispW: number, dispH: number): Rect;
/** cover / aspectFill(预留:若未来用满宽裁切布局) */
export function coverRect(box: Box, imgW: number, imgH: number, dispW: number, dispH: number): Rect;
/** 反向:显示区触点(px)→ 原图 0-1(contain 语义;触点落在信箱边外时 clamp 到 [0,1]) */
export function containPointToNormalized(px: number, py: number, imgW: number, imgH: number, dispW: number, dispH: number): { x: number; y: number };
```

数学(两函数同一套):
- contain:`scale = min(dispW/imgW, dispH/imgH)`;显示图尺寸 `dw2 = imgW*scale, dh2 = imgH*scale`;偏移 `ox = (dispW-dw2)/2, oy = (dispH-dh2)/2`;
- 框矩形:`left = ox + box.x1*dw2`,`top = oy + box.y1*dh2`,`width = (box.x2-box.x1)*dw2`,`height = (box.y2-box.y1)*dh2`;
- cover:`scale = max(...)`,偏移同公式(负值,框允许越出显示区,容器 `overflow:hidden` 裁掉);
- 容器宽高比纪律:photo 页与详情证据卡的图片容器 `aspect-ratio` 一律设 `img_w/img_h`(原型 prototype.html:494-495 同款「等比零裁剪」),从根上避免裁切错位;photo-box.ts 是数学兜底与圈选反算的依据。

---

## 4. 客户端文件清单

### 4.1 新增文件

| 文件 | 职责 |
| --- | --- |
| `miniprogram/pages/photo/photo.ts/.wxml/.wxss/.json` | **拍照识物确认页**(屏①-⑤)。拍照入口后的唯一页面,两模式:`confirm`(默认,候选清单)与 `circle`(圈选补识别)。承载:证据条折叠/展开+全部框、位置栏、横幅、三态清单+步进器、按住说话(recsheet 浮层)、diff sheet(屏③)、编辑 sheet(屏④)、保存最终确认 sheet、圈选画框与结果卡;**首次识别授权弹窗**(PR #67 B4:一次性,同意落 `home-memory:photo-vl-auth` 记忆,拒绝本次不识别、圈选入口灰化提示重新进入会再询问)。json:`{"navigationBarTitleText":"拍照识物"}`,无 usingComponents。生命周期纪律见 §7.6。 |
| `miniprogram/utils/photo-intake.ts` | 拍照编排(页面侧粘合,薄层):① `takePhoto()`:chooseMedia(`count:1, sourceType:["camera","album"], sizeType:["compressed"]`)→ 授权失败分类(§7.3)→ 交给 `utils/photo-vl.ts` 的 `recognizePhotoFile(tempPath)`(压缩→实测宽高→base64→vlRecognize;**不上传**,prepared 只存页面内存);② 候选行状态机一律调 `utils/intake-draft.ts`(本文件不再重复实现);③ `commitPhotoBatch`:用户点「确认,记住了」后**先** `wx.cloud.uploadFile(prepared.path, cloudPath 规则 §10.4)` 得 file_id(本批首次且唯一的上云动作;上传失败 → 整批不提交、如实提示可重试、云端零残留),**再**调 photoCommit 并逐件落行(失败行保留 operation_id 可重试);④ `ensurePhotoAuth()`。测试钩子 `__setPhotoIntakeDepsForTest`(wx API 全注入)。 |
| `miniprogram/utils/photo-vl.ts` | **客户端识别封装(已实现)**:`preparePhotoForVl(tempPath)`(wx.getImageInfo 取原尺寸 → wx.compressImage 长边 ≤1280/quality 70,失败则原样如实 → 对压缩产物再实测宽高 = img_w/img_h 唯一来源 → readFile 裸 base64;产物只在内存)、`recognizeWithVl(prepared, {mode, region})`(callFunction extractDraft vlRecognize,超时 70s;响应最小结构校验,形状非法整体 bad_response 绝不半带;圈选复用同一 prepared 不重复读盘)、`recognizePhotoFile(tempPath)` 一步式。降级:AI_UNAVAILABLE/网络错/超时 → `kind:"unavailable", manualFallback:true`;INVALID_INPUT → `kind:"invalid_photo"`「照片太大,请重拍」;取不到宽高 → `image_info_failed`(不猜)。wx 依赖全注入(partial 覆盖);静态守卫:编译产物不含 uploadFile/downloadFile 调用。 |
| `miniprogram/utils/intake-draft.ts` | **候选三态状态机纯函数(已实现)**:`IntakeRow = PhotoCandidate + done/failMsg`;`parseIntakeQtyNote`/`composeNote`(qty 1-99 + suffix 单一来源);入列工厂 `makeAiRow`(high 默认勾选)/`makeCircleRow`(圈选入列默认未勾选、沿用用户圈选框)/`makeVoiceAddedRow`;`toggleRowChecked`(done 终态 no-op)/`setRowsChecked`(不动 done)/`stepRowQty`/`markRowSaved`/`markRowFailed`;`applyDraftEdits(row, edits, pickedFields)`(只应用勾选字段、0 勾选不执行、绝不改勾选态、应用后 src=voice);`intakeCounts`/`intakeCountView`(头部与保存按钮文案单一来源);`deriveSaveConfirm(rows, batchLocation)`(例外只含已勾选件、#d 序号、summary/exception 文案)。全部纯函数,draftId/operationId 全程稳定。 |
| `miniprogram/utils/photo-box.ts` | §3.2 坐标换算纯函数(零 wx 依赖;**已实现**)。 |
| `miniprogram/utils/photo-session.ts` | **拍照批会话**(仿 `utils/draft-session.ts` 逐条纪律):存储键 `"home-memory:photo-session" + householdScopeSuffix()`(作用域隔离,F3 同款)、TTL 24h、只留最新一个、photo 页中途退出保留、全部入库/放弃时清除、`getUnfinishedPhotoSession()` 供首页恢复横幅。载荷:`{ batchId, file:{ localPath, imgW, imgH, fileId: string|null }, batchLocation, rows: IntakeRow[], createdAt }`——`fileId` 在用户确认上传前恒为 null(确认前云端零残留);`localPath` 为本地临时文件路径(小程序临时文件可能被回收:恢复时若文件已不存在,如实提示重拍,不编造);**base64 绝不入会话存储**(只在页面内存,恢复后按 localPath 重新 prepare)。`PhotoCandidate`/`IntakeRow` 形状见 types.ts 与 utils/intake-draft.ts。 |
| `tests/photo-vl.test.js` | lib/vl.js + handler vlRecognize 分支(依赖注入):isVlConfigured 三件套、normalizeVlBox(0-1000→0-1/越界丢框/小数 NaN Infinity 像素值全丢)、围栏剥离、坏 JSON 重试一次、未配置返回 vl_not_configured、image_base64 形状/大小门(data: 前缀/空白/非 base64/解码 0 字节/超 4,000,000 字符不解码直接拒,B5)、客户端 base64 原样直传不二次编码、**红线守卫**(deps/stub 的 downloadFile 一旦被调用即抛错;旧式 file_id 事件 INVALID_INPUT)、日志纪律。仿 `tests/extractDraft-local-llm.test.js` 模式(127.0.0.1 stub server 扮演 VL 端点)。 |
| `tests/photo-vl-client.test.js` | utils/photo-vl.ts(wx 全注入):压缩目标尺寸(长边 1280/q70、小图不放大、极端比夹 ≥1)、img_w/img_h 取压缩后实测、base64 读压缩产物、压缩失败原样如实、取不到宽高/读文件失败各自 kind、event 形状(无 file_id/mode)、region 透传与非法 region 不调云函数、圈选复用同一 base64、响应映射与硬形状 bad_response、unavailable/invalid_photo 降级、一步式透传、**静态红线守卫**(编译产物不含 uploadFile/downloadFile 调用)。 |
| `tests/intake-draft.test.js` | utils/intake-draft.ts 全状态机:数量拆分/拼接边界、三类入列工厂(AI 预选/圈选默认未勾选/语音补录)、三态流转与 done 终态、框标签前缀同步、全选清空不动 done、步进上下限、语音应用全勾/部分勾/0 勾不执行/勾选态不变/白名单外跳过、保存结果落行、计数单一来源与圈选联动、保存确认例外只含已勾选、入参不被改动、全链路 draftId 稳定。 |
| `tests/photo-draft-edit.test.js` | draftEditParse:三类 intent、field 白门、非法 draft_id 强制 needs_pick、needs_pick 与 edits 互斥、>200 字 INVALID_INPUT、local→deepseek 降级、日志不含原文。 |
| `tests/photo-commit.test.js` | itemsApi handler + memoryDb:photoCommit 逐件建档/幂等重放(operation_id 同键 duplicated 且证据行不重)/证据行唯一索引冲突回查收敛/参数非法整批零写入/部分失败不拦其余件/共享家庭双 marker 硬门(FAMILY_SWITCHED)/photoEvidenceGet 作用域过滤+内存降序+每件≤3;index.js 胶水(stub wx-server-sdk)真加载。仿 `tests/remind-notify.test.js` 模式。 |
| `tests/photo-box.test.js` | contain/cover 数学、反向换算 clamp、退化尺寸(宽或高为 0 的 box)。 |

### 4.2 改动文件

| 文件 | 改动 |
| --- | --- |
| `cloudfunctions/extractDraft/index.js` | ① event 带 `action` 时路由(`"vlRecognize"`/`"draftEditParse"`);不带 action(旧调用/语音提取)走既有提取,**逐字节一致(现状锁)**;② **不注入 downloadFile**(vlRecognize 只收 image_base64,红线:识别仅临时传输、无云存储读取路径);③ `vl.isVlConfigured()` 为 true 时注入 `deps.callVL = vl.callVlModel`,否则不注入(handler 返回 vl_not_configured);④ VL 环境变量与 DEEPSEEK/LOCAL_LLM 并存,互不影响。 |
| `cloudfunctions/extractDraft/lib/handler.js` | 新增 `vlRecognize`/`draftEditParse` 两个分支与各自 prompt/validate(约 +260 行);既有提取路径零改动。 |
| `cloudfunctions/extractDraft/lib/vl.js` | 新文件(§1.1)。 |
| `cloudfunctions/extractDraft/config.json` | `timeout: 30 → 60`(vlRecognize = VL 推理,本地 Qwen3-VL-8B@1024 实测可达 30s+;无下载步骤;客户端超时 70s 严格大于服务端,见 §4.3)。 |
| `cloudfunctions/itemsApi/lib/handler.js` | 新增 `photoCommitItem`/`photoEvidenceGetItem` + ACTIONS 注册(photoCommit 进 WRITE_ACTIONS);`photo_evidence` 集合常量。既有 action 零改动。 |
| `cloudfunctions/itemsApi/index.js` | deps 注入 `getTempFileUrls: (fileIds) => cloud.getTempFileURL({ fileList: fileIds })`(photoEvidenceGet 用;查询异常按 §1.4 降级空链接)。 |
| `cloudfunctions/itemsApi/config.json` | `timeout: 10 → 20`(photoCommit 10 件×约 4 次 DB 往返,留余量;可选但建议一起上)。 |
| `miniprogram/utils/api.ts` | ① `callVlRecognize(event)`:event 为 `{action:"vlRecognize", image_base64, img_w, img_h, mode?, region?}`(调用封装已由 `utils/photo-vl.ts` 提供——含 70s 超时、降级映射与结构校验;api.ts 若另做薄封装,形状必须一致;`callCloudFunction(EXTRACT_DRAFT_FUNCTION, …, 70000)`);响应最小结构校验(items 数组、name/box 形状,非法整体抛 CLIENT_BAD_RESPONSE——与 photo-vl 的 bad_response 同口径);② `callDraftEditParse(event)`:超时 30000(服务端 LLM 20s+ 余量,与 callExtractDraft 同款),intent 五分支结构校验;③ `callItemsApi` 重载加 `photoCommit`(进 `ITEMS_MUTATING_ACTIONS`,自动双 marker)与 `photoEvidenceGet`(读,响应后 `captureHouseholdId(result.household_id, result.scope_revision)`——与 list/remindList 同款收口);④ `validateItemsOkResponse` 加两 action 的形状门。 |
| `miniprogram/types.ts` | 新类型:`VlConfidence`/`VlCandidate`、`VlRecognizeEvent/Response`、`DraftEditParseEvent/Response`(intent 联合)、`PhotoEvidenceRow`、`PhotoCommitItemInput/Response`、`PhotoCandidate`(与 photo-session 同形状,放这里供页面与 utils 共用;前两者已随纯函数阶段落地);`ItemsApiEvent`/`ItemsApiOkResponse` 联合扩两员;`ExtractDraftErrorCode` 不变(AI_UNAVAILABLE 复用)。 |
| `miniprogram/pages/index/index.ts/.wxml/.wxss` | ① 入口两处:H0 首用态「用文字记」(index.wxml:65)旁加「📷 拍照记」次级链接;常态根层视图 brand 区下加常驻胶囊「📷 拍照记一抽屉」(容器视图层/搜索态不显示,`isRootView && !queried` 门控),样式用 app.wxss 既有令牌(白卡细描边胶囊,不做新颜色);两入口都 `wx.navigateTo /pages/photo/photo`;② photo 会话恢复横幅:`onShow` 里 `ensureScopeVerified().then(...)` 后读 `getUnfinishedPhotoSession()`,非空显示次行横幅「上次拍照的 N 件没记完,继续核对 ›`(与既有 resumeSession 横幅并存,点进 photo 页带 `?resume=1`)。 |
| `miniprogram/pages/item/item.ts/.wxml/.wxss` | 详情页照片证据回放卡(§6):data 加 `evidence` 区字段;`onShow` 拉取(作用域代数守卫,失败静默);wxml 折叠证据条+展开回放;「去补拍」按钮 navigateTo photo 页。 |
| `miniprogram/utils/voice-entry.ts` + `miniprogram/utils/voice.ts` | ① `VoiceEntryHost` 新增**可选** `routeExtract?(text: string, binding: ExtractBinding): Promise<void>`:onStop 有效转写且绑定复核通过后,**presser 声明了 routeExtract 就调它**(voice-entry 不做三选门、不建 confirm 会话、不跳页;photo 页用它接 draftEditParse);未声明 → 走既有 `extractText`(**逐字节一致,现状锁**,voice-entry.test.js 补回归例);② `voice.ts` 的 `VoiceControllerCallbacks.onStop(text)` 追加可选第二参 `audioTempPath`(controller 在 `deps.recorder.onStop` 处已有 `res.tempFilePath`,顺手传递);`VoiceEntryHost.onTranscript(text)` 同样追加可选 `audioTempPath`,photo 页存下供 diff sheet 回放(InnerAudioContext);默认实现忽略新参,零回归。 |
| `miniprogram/app.json` | pages 数组加 `"pages/photo/photo"`(排在 pages/confirm/confirm 之后)。 |

---

## 5. 语音受限编辑契约(屏②③ 的完整行为)

**链路**:photo 页底部按住胶囊(真实手势:按住出 recsheet 浮层、松手去核对、上滑取消、最短按压 250ms——全部由 voice-entry/voice 既有手势机提供,photo 页只做宿主)→ 转写 → `presser.routeExtract`(新管线)→ `callDraftEditParse` → diff sheet。

**diff sheet(屏③,photo 页内)**:
1. 头卡:「你说」+ 转写文本(引用部分高亮)+ 「🎧 原话已保留 · 可回放」(InnerAudioContext.src = 本次 audioTempPath;文件为小程序临时文件,本次启动内有效,播放失败如实置灰该按钮);
2. 锁定提示:`intent="edit"` 且非 needs_pick → 「已锁定候选 **#d{n} {name}**——按内容锁定,不按行号;没对上就不改,让你点选。」(#d{n} 为该候选在当前清单里的序号,展示用,**锁定依据永远是 draftId**);
3. `intent="edit"`:逐字段勾选行(默认全勾),每行 `字段名 / old(删除线,红)→ new(高亮)`,字段名固定文案:name→「名称」、qty_note→「数量备注」、location→「位置(例外,不继承批次)」;底部按钮「应用勾选的 N 处」,**N=0 时禁用**(原型 prototype.html:650-654);「念错了,当我没说」= 关 sheet 零改动;
4. 应用 = 对该候选的**对应字段逐个赋值**(name/qty(从 new 再过 parseIntakeQtyNote)/exc=new),**绝不改它的勾选(保留)状态**(V0.4.1 修复项);应用后 `src="voice"`、行与框标签同步重渲染;
5. `intent="add"`:sheet 显示「补一件:{name}」,确认 → 清单追加未勾选候选(src="voice",无框或绑本批照片 box=null);
6. `intent="batch_location"`:sheet 显示「本批默认位置:{old} → {new}」,确认 → 改批次位置;**已设例外的候选不受影响**(例外仍是例外);
7. `needs_pick=true`:sheet 显示「对不上是哪一件,点一下:」+ picks 行列表,点选后**把本次转写文本与所选 draftId 重新调一次 draftEditParse**(⚖️ 显式点选 = 新的明确输入,不做客户端本地模糊匹配);期间不执行任何修改;
8. `intent="none"`:toast「没听懂这句,换个说法或手动改」,不弹 sheet;
9. AI_UNAVAILABLE/超时:toast「没听懂,可手动点行编辑」,不弹 sheet;
10. **绝不在本链路触任何 itemsApi 写**——photoCommit 只能由「保存」按钮经最终确认弹层触发(§7 与设计合同)。

**「按住说位置」(位置栏胶囊)**:同链路,但 prompt 上下文就是 batch_location;实现上复用 draftEditParse(intent 大概率 batch_location;若模型解析成别的 intent,按对应分支处理,不做特殊通道)⚖️。

---

## 6. 找物回放(详情页优先)

**方案**:不做独立「找东西照片结果页」。首页搜索(H1b,`pages/index/index.ts:438-476`)保持纯文字结果;点结果进详情页,照片证据作为详情页的**增强卡**回放。

**详情页(pages/item)证据卡**:
1. 拉取:`onShow` → `ensureScopeVerified()` → 捕获 `captureScopeGeneration()` → `callItemsApi({action:"photoEvidenceGet", item_ids:[itemId]})` → 响应回来 `isScopeGenerationCurrent` 复核(在途家庭切换不上屏,`fetchReminderRow` 同款纪律,`pages/item/item.ts:1352-1367`);失败**静默**(证据是增强露出,绝不打扰详情主体,`refreshDueBanner` 同款);`applySummary`/update 后不自动重拉(onShow 再拉);
2. 渲染(取 evidence 里 created_at 最新一条;无 → 整卡不渲染):
   - 折叠态:照片条(高 ~120px,暗化)+「📍 点开看拍照留证」;
   - 展开态:等比 contain 全幅(aspect-ratio = img_w/img_h)+ 黄环脉冲框(hitring 动画,box 非 null 时;`containRect` 换算)+ 角标「📷 拍摄于 {MM-DD} · 当时记录:{captured_location_text}」;
   - **「位置已变更」判定(纯客户端)**:`captured_location_text.trim() !== 当前 locationText.trim()` → 显示灰底徽标「位置已变更」+ 副文案「现在:{locationText}(以文字为准);旧照片仅作证据」(原型屏⑥围巾案例)。相等 → 副文案「照片与当前记录一致」;
   - `photo_url === ""`(换链失败)→ 照片区显示「照片加载失败,点按重试」,file_id 仍在(重试 = 重新调 photoEvidenceGet);
   - box=null 的证据行 → 只显照片不画框;
3. 照片显示用 photo_url(临时 https 链接,有效期约 2h,当次会话够用);**不直接用 fileID 渲染 image**(云存储默认「仅创建者可读写」,家人看不到别人的 cloud:// 文件——跨成员读一律走云函数换链,部署面 §10);
4. 「📸 去补拍」(无证据行时显示,对应原型屏⑥ nocard「去补拍」):`wx.navigateTo /pages/photo/photo`(不带恢复参数,新批);
5. 证据行 >1(同物品多次拍照)时展开态下方给「更早的照片 N 张」收起列表(全部平铺,created_at 降序;最新一条默认展示)⚖️。

---

## 7. 降级与边界(第 7 点全文)

1. **VL 不可用**(三件套缺任一 / 网络错 / 超时 / 坏 JSON 重试仍败)→ 服务端 AI_UNAVAILABLE + manual_fallback:true(客户端网络错/超时同款 UX)→ 客户端 modal「拍照识别暂不可用,可手动添加」,确认后**仍进 photo 页**:照片仍只是本地临时文件(未上传,**云端零残留**),候选清单为空,提供「+ 手动添加物品」行(手输名称/数量/位置,box=null 整照关联,保存时才首次上传,photoCommit 照常);取消则返回首页(**云端无任何残留**,本地临时文件随小程序生命周期自然回收)。
2. **draftEditParse 不可用** → toast「没听懂,可手动点行编辑」,不弹 diff(§5.9)。
3. **无照片/相机权限**:`chooseMedia` fail 且 errMsg 含 "auth" → showModal「需要相机权限」(confirmText「去设置」→ `wx.openSetting`;cancelText「从相册选」→ 重新 chooseMedia 只带 album);相册本身无需授权,用户拒绝相机时始终有相册兜底;两次都取消 → 返回上一页。
4. **图片超限/压缩失败(PR #67 B5 修订)**:`wx.compressImage` 失败 → 原图 base64 原样直传识别(如实);大小门两侧对齐 **4,000,000 字符**(callFunction 事件整体上限 5MB 留外壳余量):客户端压缩后仍超限 → 直接失败提示「照片过大,请靠近重拍」不发起 callFunction;服务端字符门超出 → INVALID_INPUT → 同款提示并留在入口;目标压缩:长边 ≤1280 JPEG quality 70(§4.1)。`wx.getImageInfo` 失败 → 中止本次拍照并 toast(没有宽高就没有坐标契约,不猜)。
5. **圈选识别失败** → 结果卡显示失败文案+「不是,重圈」重试;已有候选零影响(原型 resetCircle 语义,prototype.html:733-738)。
6. **确认后上传失败 / 部分保存失败**:确认后首先 `wx.cloud.uploadFile` 同一张压缩图(本批唯一上云动作),失败 → 整批不提交 photoCommit、如实 toast 可重试(云端零残留,会话保留);上传成功后 photoCommit 逐件结果:失败行标红+可单行重试(operation_id 沿用,同键同内容幂等收敛;内容改过仍沿用原键,服务端异内容 OPERATION_CONFLICT 兜底),已成功行不动(§1.3,batch-save 哲学);file_id 一旦取得随会话保留,重试不重复上传。
7. **家庭切换在途 + 会话归属家庭(PR #67 B1 修订)**:photo 会话存储键带作用域后缀(§4.1 photo-session),换家庭后旧批不可达、回切恢复(F3 同款);photo 页所有上屏前作用域代数复核(§6.1 同款);photoCommit 经 api.ts 自动双 marker,共享家庭 FAMILY_SWITCHED/FAMILY_STALE_SCOPE 由服务端硬门拦下,客户端如实 toast 服务端文案。**会话归属家庭在开批时捕获**(photo-session 载荷 `scope` 字段):保存时把该 `expected_household_id` 随 photoCommit 上送(api 层显式携带优先于自动 marker),服务端与当前派生家庭不一致 → **SCOPE_MISMATCH 零写入**(先于通用双 marker 硬门裁定);客户端保存前置复核漂移、收到 SCOPE_MISMATCH 同款终局:终止会话(按会话自己的作用域键清除)、toast「家庭已切换,本批未保存」、返回首页,**绝不重试写另一个家**。服务端拒绝路径上照片文件可能已在云存储(用户确认后先上传再 commit):该孤儿文件不产生任何 items/证据行,与「确认后上传失败整批不提交」的取消路径同语义(云存储无事务,孤儿文件可接受),不回收。**会话绑定时序(C1 修订)**:会话作用域在**拍照流程入口**(照片在手、发起识别前)捕获——识别/授权等待期间家庭从 A 切到 B 时,识别返回后复核入口作用域与当前不一致 → 不建会话、候选不上屏,toast「家庭已切换,本次拍照未保存」返回首页(与 SCOPE_MISMATCH 终局同款语义);同 householdId 仅作用域代数/修订前进不算漂移照常;保存时的 B1 漂移复核与服务端硬门保持最后防线。
8. **页面生命周期**:photo 页 onHide/onUnload → `voiceEntry.invalidate()`(作废在途录音/识别/编辑解析,防幽灵录音与迟到 diff 上屏;与 index 页同纪律,`pages/index/index.ts:331-343`)。
9. **证据写入失败=部分成功语义+幂等重试(PR #67 C3)**:photoCommit 里 createItem 成功后 savePhotoEvidence 抛错(基础设施错误)→ **物品不回滚、失败不掩盖、不拦其余件**:该 item_id 进响应 `evidence_failed`(§1.3),全部建完后整体 ok:true 返回——重试整批 photoCommit 会撞同键 duplicated(物品不重建)但可能再次证据失败,入库件数口径只认 results+evidence_failed。客户端:evidence_failed 非空 → 行照常落 done 终态,终态提示「已入库 N 件,其中 M 件照片待关联」+「重试关联」入口(结果区按钮),点击调 `photoEvidenceRetry`(§1.5):服务端重验 file_id 归属(B2 同款)与逐件作用域内存活后补插证据行,唯一索引冲突=已存在=成功(幂等);全部关联成功 → 清提示;部分失败/调用失败 → 载荷保留可再点(NOT_FOUND 的件=item 已删,读取侧本就过滤,不再无意义重试)。续联载荷 `{fileId, imgW, imgH, items:[{item_id, box, source}]}` 随 photo 会话保留(§2 同款持久化),**直至重试成功或用户离开**;重试不再上传照片(fileId 复用)。

---

## 8. photo 页屏级行为基准(对照原型,验收清单)

以下每条左侧是原型锚点,**行为基准以原型 script 为准**,生产实现语义一致(样式令牌:奶油白底 #faf8f2、白卡细描边 #e8e3d6、明黄 #ffe15a 唯一强调、墨底黄字 CTA+硬投影,全部取自 app.wxss 与 voice-bar.wxss,不新造颜色):

**屏① 识别确认**(prototype.html:226-318, script 486-673)
- [ ] 照片默认折叠为证据条(暗化+模糊,框隐藏);点 evChip 或点候选行 → 展开 + 该框脉冲高亮 + 行高亮(586-588, 574-578);
- [ ] 框三语义:墨实线=AI 预选候选、黄虚线=低可信(confidence="low")、红虚线=用户圈选;框标签前缀随行状态:「已记住·/保留·/候选·」(559-565 syncTag);
- [ ] 位置栏:批次默认位置 +「🎤 按住说位置」+ 常用快捷(取 locations-cache 最近的 2 个房间,失败隐藏)+「＋新建」;提示文案「候选默认继承这个位置,例外在编辑里逐件改;保存前会再让你确认一次」;
- [ ] 横幅:「一条记录 = 一件可查找的物品:电池×24 也只记一条,数量是备注,不做库存管理。数量为 AI 估计,核对更稳」;
- [ ] 三态:未勾=「候选」、勾选=「保留」(黄标)、photoCommit 成功=「已记住」(墨底黄字标,行边框墨色);计数一处来源:「保留 n / N(待核对)」;有 done 行时头部改「已确认记住 n 件 · 本批完成」、保存按钮「✓ 已入库」(566-573);
- [ ] AI 预选:confidence="high" 默认勾选(V0.4「AI 预选 3 件如实标注」的规则化);mid/low 默认不勾;
- [ ] 步进器 36px 热区、qty+suffix 单一来源(改 qty 即改行备注文案,屏幕数字与草稿同一份数据,579-585);
- [ ] 底部:按住胶囊撑满左侧 + 小号保存「存 n 件」(44px 热区);0 勾选禁用;
- [ ] 「全选 / 清空」链接(原型 alert 占位 → 生产:全选/清空 checked,不动 done 行)。

**屏② 按住说话中**(script 591-645):recsheet 浮层(recback+recsheet,复刻 voice-bar 现有样式)、真实松手→去核对、上滑 >60px 进取消态、滑回恢复、最短按压 250ms toast「按太快了,不算数」——**全部由 voice-entry/voice 既有手势机提供**,photo 页只渲染浮层与接 routeExtract。

**屏③ diff sheet**:§5 全文。

**屏④ 手动编辑 sheet**(374-406):点行(非勾选区)打开;「改一下 · #d{n}」+ 来源行(「来源:照片识别 · 置信度 {62%|高|中|低}」);名称候选点选区 = 当前清单全部候选名 + 「保持:{现名}」(一键改类,棉柔巾案例);数量步进器(备注语义标注);位置(默认继承批次,不同才改,进 locations 选择器选或手输 ⚖️ 手输,复用 confirm 页位置输入形态);提醒日期(可选,picker mode=date,进 photoCommit 的 reminder,kind 默认「下次维护」可选词表);「就这么改」。

**屏⑤ 圈选补识别**(408-437, 710-738):hintbar「用手指在照片上画一个框」+ 红点闪烁;touchstart/move/end 画红虚线框(containPointToNormalized 反算 0-1);松手 → 调 vlRecognize(mode:"region");结果卡:「{name} {置信度}」+ 依据说明 + 「不是,重圈」/「加进清单(候选)」;**点「加进清单」才入列**,入列 = 未勾选候选(src="circle",红框保留在照片上),保存计数联动(698-700)。

**保存最终确认 sheet**(298-315, 669-695, V0.4.1/V0.4.2):点「存 n 件」弹出;三卡:① 本批位置;② 位置例外——**只汇总本次实际勾选件的例外**(未保留候选不进清单,675-680);③ 最终保存「保留 N 件写入 · 未勾选 M 件不保存」;「再看看」/「确认,记住了」;确认 → 上传压缩图(首次且唯一的上云动作,§7.6)→ commitPhotoBatch → 成功行 done、框标签同步、计数更新、toast「都记住了 · N 件已入库」;失败行标红可重试。**全部入库或用户放弃离开时清 photo 会话**。

---

## 9. 测试与验收

命令(与仓库现有口径一致):
- `npm test`(pretest 先 `npm run build:mp`;含全部新测试文件);
- `npm run typecheck`。

新测试清单见 §4.1 表格(4 个新文件 + voice-entry.test.js 补 2 例:声明 routeExtract 的宿主走自己的管线 / 未声明走 confirm 链现状锁;onTranscript 第二参透传)。
位置挂树(#65 ③,机制见 §1.6):PI-14/15/16/17(photo-intake.test.js:分段/计划/幂等键/挂树编排)、PP-MOUNT-1..4(photo-page.test.js:页面级参数/失败语义/恢复不重挂/旧窗口)、PC-COMMIT-1 与 PC-IDEM 补验回执 `version` 字段。
离线纪律:零网络、零外部依赖、绝不 require wx-server-sdk(各测试文件头注释声明,`tests/remind-notify.test.js:19-20` 同款);VL 的 HTTP 集成用例走 127.0.0.1 stub server(`tests/extractDraft-local-llm.test.js` 同款);itemsApi 侧用 `tests/helpers/memoryDb.js` 并配置 photo_evidence 唯一索引(§2)。

验收门槛:全绿 + typecheck 通过 + 人工走查 §8 清单(开发者工具真机预览,拍照→识别→语音改→圈选→保存→详情回放全链)。

---

## 10. 部署清单(人工步骤,上线前逐项打勾)

1. **控制台建集合 `photo_evidence`**:权限「所有用户不可读不可写」;索引:查询 `(household_id, item_id)`、唯一 `(household_id, item_id, file_id)`。
2. **extractDraft 云函数**:上传部署;环境变量新增 `VL_BASE`、`VL_TOKEN`、`VL_MODEL`(可选 `VL_TIMEOUT_MS`,默认 30000);`config.json` timeout 改 60(随代码上传)。
3. **itemsApi 云函数**:上传部署;`config.json` timeout 改 20(随代码上传);无新环境变量。
4. **云存储**:保持默认权限(仅创建者可读写)——**不改**;跨成员读照片一律走 photoEvidenceGet 云函数 getTempFileURL(§6.3)。**上传时机:仅在用户点「确认,记住了」之后、photoCommit 之前**(确认前零上传;识别链路 base64 直传 vlRecognize,不经云存储)。上传路径规则(PR #67 B2 修订):`photo-evidence/{会话开批家庭 household_id}/{时间戳}-{随机}.jpg`——scopeId 段是服务端 photoCommit **file_id 归属验证**的依据(前缀 ≠ 当前派生家庭 → FILE_NOT_OWNED 零写入;路径解析不出的 file_id 一律 INVALID_INPUT);会话开批时未捕获作用域才回退 "default"(该回退前缀会被服务端归属门拒绝,入口页均先验证作用域,理论边路)。
5. 小程序端发版(app.json 新页面)。

---

## 11. 明确不做(边界)

- 不引入 `items.quantity` 或任何库存语义(数量=note 文本,一条记录=最小建档单位);
- 不做独立找物照片结果页(详情页优先,首页搜索纯文字);
- VL 不接 DeepSeek 降级(无视觉模型);vlRecognize/draftEditParse 不引入家庭解析(无状态红线);
- 不改 confirm 文字链路、不改语音→提取→确认页既有链路任何行为(routeExtract 是可选旁路,现状锁);
- 不做实时取景/连拍/多照片批(一屏一照;多照=多次拍照分批);
- 照片在用户最终确认保存之前不持久化、不写云存储(#65 V0.4 合同第五项边界;PR #67 B4 措辞精确化:识别=本地压缩 base64 **临时传输**(传输即处理,不落盘),首次使用需用户授权;确认前零云端残留);确认后上传成功但 photoCommit 单件失败的行,file_id 随会话保留供重试收敛,不回收(除此之外无任何云端残留)。
- photo_evidence 不做删除/编辑(证据只增;物品删除后证据行成为悬挂行——删除物品时不级联清证据 ⚖️,与 reminders 级联不同:证据是历史事实,保留成本为零。PR #67 B2 修订:photoEvidenceGet 返回证据行前按 item_ids 反查 items(作用域内 deleted:false),**已删/不存在物品的证据行静默过滤**,悬挂行不再回到任何回放入口)。
