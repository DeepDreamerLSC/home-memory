# PR B 设计：视频场景扫描与多物品候选确认

**状态**：设计预研 · PROVISIONAL（等 PR A 接口冻结后再实施）
**设计分支**：`design/video-scene-scan`
**范围**：只讨论设计、schema、编排、状态机、测试与验收，不写生产代码。

## 0. 一页结论

1. 用户录一段抽屉/柜子视频。**原视频在用户最终确认前不上传云存储**；客户端按 PR A 的抽帧能力抽取 4+4 帧，逐帧调用现有 `extractDraft.vlRecognize`（未知目标、多物品、单帧 VL），识别结果只在客户端内存中短暂存在。
2. AI 每帧输出只是“观察线索”，不是物品事实。跨帧同名线索只做展示分组，**绝不自动合并物理身份**；只有用户显式勾选/合并/拆分后产生的 `draft` 才可提交。
3. 每件待确认物品有自己的草稿 key、独立 `operation_id`、独立 `item_id`、独立 highlights。即使名字完全相同，默认也分别建档；只有用户显式“关联到已有物品”时才按 `item_id` 绑定。
4. 最终确认后上传**一份原视频**，服务端新增一个批量写 action，把同一 `file_id` 写成多条 `video_evidence`（每 item 一行），并逐行写入该行自己的 highlights。所有行共享服务端签发的 `asset_id`，用于同文件引用和删除串行化。
5. 删除/物品删除/清理必须改成**按文件引用判断**：同一文件仍有其他 item evidence 时只删当前行，最后一条引用消失时才删云文件。这是 PR B 对 #89 单件假设的必改点。
6. 不新建集合；复用 #89 的 `video_upload_tickets`、`video_evidence`、`video_item_locks`。只给既有文档加字段，复用 `video_item_locks` 的 `val_<asset_id>` 逻辑锁。

## 1. 范围与非目标

### 1.1 本 PR 范围

- 场景视频录制/选择，抽屉/柜子多物品 AI 候选。
- 候选保留：来源帧、时间、0-1 框、置信度（仅确认前展示，不持久化 AI 原始字段）。
- 用户逐件勾选、改名、把同名线索拆成多件、把多条线索显式合并为一件、补一件没识别到的物品。
- 同一原视频给多个 item 各建证据；每件有独立、用户确认后的 highlights。
- 部分帧失败、取消、离页、进程中断、弱网、票据过期与恢复。
- 与 #89 票据/CAS/清理/家庭隔离合同兼容。
- 同名物理身份隔离与共享文件删除安全。

### 1.2 非目标（本 PR 不承诺）

- 不做全屋自动巡检、不自动判断物品数量、不自动合并同名物品。
- 不把 AI 候选或 confidence 写入事实/数据库；不按 AI 结果自动建档。
- 不把同一文件抽出的所有 item 合并成“一个共享 evidence + 多绑定”的新实体；保持每 item 一行的读侧兼容。
- 不自动播放，不在详情页默认展开视频。
- 不做视频内容审核、跨家庭共享、长期对象存储生命周期策略。
- 不保证低端机/微信解码器全部可用；不支持时降级为手动添加或放弃。

## 2. 依赖与不能并行的点

### 2.1 main 上已合入的 #89 合同

必须沿用：

- upload begin → 云直传 → receipt → attach；上传路径由服务端签发，路径完全匹配才可绑定。
- `video_upload_tickets` 状态 CAS：`pending → binding`、`pending → cancelling`；receipt 只写 `pending`；删除/取消/清理先核对 evidence 引用再删文件。
- 家庭只由服务端派生；所有写 action 走 `WRITE_ACTIONS` 与共享家庭双 marker 硬门。
- `videoEvidenceGet` 返回临时播放 URL；单行换链失败 `video_url:""` 不废整次查询。
- 删除云文件按 `cloud.deleteFile.fileList[].status` 严格判定，`0`/`-503003` 才可删行。
- 不缓存永久链接、不自动播放、日志不记物品名/位置/base64。

### 2.2 PR A（PROVISIONAL）

PR A 当前草案：

- 客户端：`miniprogram/utils/video-target.ts`，抽帧长边 ≤1024、JPEG q≈0.72、单帧 base64 ≤4,000,000 字符、最多 8 帧、取消/离页 generation 失效；每帧候选独立保留。
- 服务端：`extractDraft.videoTargetRecognize`，输入目标名 + 单帧，输出 hit/box/confidence；时间由客户端附带。
- 数据：`video_evidence.highlights: [{start_ms,end_ms,box,source:"user_confirmed"}]`，行内 `highlight_version`；`videoEvidenceHighlightSave` 以 `expected_highlight_version` CAS 保存。
- `videoEvidenceGet` 行返回 `highlights` / `highlight_version`；旧行 `[]` / `0`。

**PR B 复用方式**：

- 场景扫描是“未知目标、单帧多物品”，因此**不调用** target 专用的 `videoTargetRecognize`；逐帧调用已有的 `extractDraft.vlRecognize`。该 action 的提示词本来就是抽屉/柜子多物品识别，服务端已有形状校验、0-1 框归一、日志脱敏。
- PR B 只使用 PR A 的**抽帧原语和取消语义**，自己实现场景帧计划与客户端聚合；不会修改 PR A 的 target 识别、进度 UI 或单件详情页。
- 为保持 highlights 合同兼容，场景 highlight 的 `start_ms` 直接取“代表帧时间”；box 若存在则对应该帧，**box 允许 `null` = 仅时间窗、无框**；`end_ms = min(duration_ms, start_ms + 1500)`，因此不需要给 PR A schema 增加 `frame_ms`。如果 PR A 最终提供可选 `frame_ms`，场景代码可在该字段存在时透传，不作为阻塞条件。
- README/实现报告中须注明：`videoTargetRecognize` 的目标名、time_ms 不在服务端信任；场景扫描的 frame time 同样由客户端时间计划提供，用于展示和回放定位，不冒充媒体真实 pts 校验。

**PR A 合入后必须复核的接口**（任一未满足则 PR B 实施阻塞）：

| 依赖 | 用途 | 未满足时 |
|---|---|---|
| `createVideoTargetSession()` 暴露可复用的 `captureAt(source,timeMs,opts)` 与 `cancel()` | 场景逐帧抽取、取消、长边/质量/大小上限一致 | 不能并行改 `video-target.*`；等 PR A 冻结后由 PR B 增加导出，或复制常量并加同源测试 |
| `VideoFrameCandidate` 形状含 framePath/width/height/timeMs/frameIndex | 场景 observation 需要来源帧与框坐标基准 | 阻塞，不能用猜测的 pts 或 canvas 尺寸代替 |
| `videoEvidenceGet` 每行返回 highlights/highlight_version，旧行默认 `[]`/`0` | 场景提交后读回与 PR C 兼容 | 阻塞高亮读回验收 |
| highlights 校验：0≤start<end≤duration、box 为 null 或 0-1 有效框、source 固定 `user_confirmed`、1..8 条 | 场景提交同一形状，避免第二套高亮合同 | 阻塞；名称/框/时间必须同一个 schema |

### 2.3 不能并行的文件/工作

PR A 当前声明独占：

- `miniprogram/types.ts`
- `miniprogram/utils/api.ts`
- `cloudfunctions/extractDraft/index.js` 与 `lib/handler.js`
- `cloudfunctions/itemsApi/lib/handler.js` 与 `lib/video.js`
- `miniprogram/pages/item/*`
- 新增 `miniprogram/utils/video-target.*`
- PR A 的设计与测试文件

因此 **PR B 的实施不得与 PR A 同时改上述文件**。PR B 设计阶段只写本文件；实施阶段必须等 PR A 合入或明确冻结后，从最新 main 新建分支，避免在 PR A 基础上重复/冲突实现 `videoEvidenceGet`、highlights 和 `video.js` 的删除路径。

PR C 可以并行做设计，但其回放实现必须等 PR B 的数据 schema 和 PR A 的读侧字段冻结；本设计保证 `videoEvidenceGet` 仍是扁平行、按 `item_id` 隔离。

## 3. 用户流程

1. 入口：用户点击“拍一段，找抽屉里的东西”（新页面 `pages/video-scene/video-scene`，入口位置由产品最终定，不在本 PR 改首页信息架构）。
2. 首次说明与授权：原视频确认前不上传；抽帧会临时发送给云端 AI；确认后保存原视频和每件高亮；视频只作历史证据，不冒充当前位置；默认不自动播放。
3. 录制/选择一段 5–30 秒抽屉/柜子视频（客户端 `chooseMedia` 上限 30s；服务端沿用 #89 的 10 分钟上限保护，但场景流程主动限制）。
4. 客户端按 10%/35%/65%/90% 先抽 4 帧；每帧串行识别。完成后可继续补 22.5%/50%/77.5%/97.5% 共 4 帧（总 ≤8），不因某一帧命中就提前结束——目标是找多件，不是找单件。
5. 识别结果以“观察线索卡”展示：缩略图、AI 名称、时间、框、high confidence/低 confidence、来源帧。同名线索只加“同名线索 N 帧”标签，不是物品合并结果。
6. 用户把选中的线索生成草稿：每张草稿是一“件”待确认物品。用户可：
   - 勾选/取消；
   - 改名（AI 名只是建议）；
   - 显式“把这几条线索当作同一件”；
   - 对同一簇同名线索“拆成多件”，每件有独立草稿 key；
   - “补一件”：从已抽帧中选一帧并选时间窗；可框选，也可显式选择“仅时间、不画框”；
   - 对每件确认 highlights（可选择/取消该件关联的帧，至少 1 条，最多 8 条）；
   - 新物品填名称与位置；已有物品显式从物品选择器选 `item_id`，不按名字自动关联。
7. 点击“保存这些物品和视频证据” → 客户端本地最终校验并冻结提交载荷 → 获取场景上传票据 → 上传**一份**原视频 → receipt 写入 file_id → `videoSceneCommit`。
8. 服务端逐件幂等建档/关联并写同一 `file_id`、同一 `asset_id` 的 per-item evidence。成功返回逐件结果；部分失败保留已成功项和文件，支持同载荷重试。
9. 完成后展示“已为 N 件物品保存视频证据”；清空本地场景会话。可从每件物品详情页进入回放；视频默认折叠，点击才播放。

## 4. 客户端抽帧与识别编排

### 4.1 为什么是客户端驱动

- 视频原文件在确认前只在本地，不上传云存储；服务端无法取到云文件。
- 微信 `callFunction` 单次事件上限约 5MB；8 帧 base64 不能安全塞进一个事件。
- 因此采用 **客户端串行调度 + 服务端逐帧无状态执行 + 服务端批量提交**：
  1. 客户端抽出单帧、压缩、读 base64；
  2. 调用现有 `extractDraft.vlRecognize({image_base64,img_w,img_h,mode:"full"})`；
  3. 收到响应后立即丢弃 base64，只保留纯元数据/缩略图本地路径；
  4. 所有 frame 完成后，由确认页产生最终草稿；
  5. 最终才上传原视频并调用 `itemsApi.videoSceneCommit`。

### 4.2 帧计划

新增纯函数（客户端单元可测，不依赖 wx）：

```ts
interface SceneFramePlanItem { index: number; timeMs: number; phase: "initial" | "supplemental"; }
export function planSceneFrames(durationMs: number): SceneFramePlanItem[];
```

- 初始相位：`0.10, 0.35, 0.65, 0.90`，共 4 帧。
- 补扫相位：`0.225, 0.50, 0.775, 0.975`，共 4 帧。
- `timeMs = clamp(0, durationMs - 1, floor(durationMs * ratio))`。
- 短于约 1200ms 的视频按时间去重；若只剩 1 帧则只扫 1 帧并在结果中标注“视频太短，识别覆盖有限”。
- 顺序：先按 initial 顺序执行；用户没有取消时才执行 supplemental。总帧数硬上限 8。
- 每帧候选输出：

```ts
interface SceneObservation {
  obsId: string;            // 客户端 uuid，本次会话内唯一；不持久化到服务端
  frameIndex: number;
  timeMs: number;           // 只表示计划/seek 时间，不冒充媒体 pts
  windowStartMs: number;    // max(0,timeMs-750)
  windowEndMs: number;      // min(durationMs,timeMs+750)
  framePath: string;        // 本地临时缩略图/原帧路径，供用户看与画框
  frameW: number;
  frameH: number;
  name: string;             // AI 建议名
  confidence: "high" | "mid" | "low";
  box: Box | null;          // 现有 vlRecognize 输出；null = 无框候选，可确认成仅时间高亮
}
```

- 不按跨帧同名/相邻帧/框重叠自动合并；不保存 AI `qty_note` 到事实。必要时只作为 UI 提示。
- 客户端对所有候选做最小形状校验；任一行坏掉则该帧整体判失败，不半带异常候选。

### 4.3 取消、离页、部分帧失败

- `createSceneScanSession()` 维护 `generation`。取消/onHide/onUnload 后，所有在途 `await` 边界检查 generation；迟到响应只丢，不上屏、不写会话。
- 每帧独立失败：记录 `{frameIndex,timeMs,errorKind}`，继续后续帧。可用其他成功帧进入确认页；横幅显示“已分析 X/Y 帧，Z 帧失败”，不显示“全部识别完成”。
- 0 帧成功：
  - 若有可用本地帧：进入“补件”模式；用户可手动画框或只设时间窗（box=null），AI 不可用不阻塞用户手动填加。
  - 若抽帧本身不可用：本次 AI 扫描降级失败；用户可放弃，或走已有 #89 单件视频留证入口；不伪造结果。
- 取消/离页在确认前：本地取消，云存储零写入、数据库零写入；基础帧和 base64 释放。完成过的 observation/draft 可按 4.4 存本地会话，但不含 base64。
- 部分帧失败不自动重试无限循环；用户可点“重新扫描”开启新 generation（最多仍 8 帧），旧结果全部作废。

### 4.4 本地会话（只存本地）

- 键：`home-memory:video-scene-session:<household-scope>`，TTL 24h，只保留 1 个未完成场景。
- 保存：`sceneId`、scope 快照、视频临时路径、duration/w/h、已完成帧元数据、observations、drafts、phase。
- 不保存：任何 base64、VL 原始响应原文、临时 URL、家庭名/物品 ID 之外的服务端身份。
- 恢复时用文件系统接口校验视频/缩略图临时路径；失效则保留可读草稿文本，但明确提示“本地视频已失效，需重拍”；不得用坏路径上传或展示伪缩略图。
- 完成、取消、放弃、票据过期且无 pending 时清空；家庭切换通过 scope key 天然不可达。

## 5. 数据 schema

### 5.1 `video_evidence`（扩展现有集合，不新建集合）

每件物品一行；同一原视频的 N 件物品有 N 行，`file_id` 相同，`asset_id` 相同，highlights 各自独立。

```js
{
  _id: "ve_<random>",
  household_id: "hh_...",
  item_id: "it_...",
  file_id: "cloud://.../video-evidence/<hh>/<ticket>.mp4",
  asset_id: "va_<random>",           // 新增：同一上传票据/物理文件逻辑组
  upload_ticket: "vt_...",           // #89 已有；同一场景 N 行相同
  duration_ms: 12000,
  video_w: 1280,
  video_h: 720,
  captured_location_text: "书房 · 右侧抽屉",
  consent_version: "v1",
  source: "scene",                    // 新增："manual"(旧/单件) | "scene"
  highlights: [                       // 逐 item 独立
    {
      start_ms: 3200,                 // 代表帧时间；box 对应这一帧
      end_ms: 4700,                   // [start,end), 场景默认 start+1500，clamp 到时长
      box: { x1: 0.12, y1: 0.20, x2: 0.48, y2: 0.55 }, // 也允许 null = 仅时间窗无框
      source: "user_confirmed"
    }
  ],
  highlight_version: 1,               // 场景首次确认即 1；旧 #89 行为 0
  highlight_updated_at: "2026-10-19T...",
  highlight_update_id: "vs_<optional deterministic>", // 可缺省；仅幂等
  created_at: "2026-10-19T..."
}
```

规则：

- 现有唯一索引 `(household_id, item_id, file_id)` 保持；新增非唯一索引 `(household_id, asset_id)` 供引用查询。不改集合权限（所有用户不可读写）。
- `asset_id` 缺失的旧行按 `file_id` 归为同一逻辑文件；旧行 `highlights` 缺失读作 `[]`，`highlight_version` 缺失读作 `0`。
- 场景提交写入的 highlights 必须 1..8 条、升序、无重复完全相同的 `(start_ms,end_ms,box)`；`box` 可为 `null`（仅时间窗，UI 明确标注“无框”），非 null 时必须是四值 finite ∈[0,1] 且 x2>x1、y2>y1。服务端只接受并保存最终确认字段，不保存 AI candidate/draft/confidence。
- `source` 只写 `user_confirmed`。服务端补 `confirmed_at` 若后续 schema 采纳；当前不新增 PR A 未冻结的字段。
- 同一 `item_id + file_id` 绝不会因重试生成两行；同 item 已有但 highlights 不同 → `OPERATION_CONFLICT`，不静默覆盖。
- `videoEvidenceGet` 仍返回扁平数组，每行至少包含现有字段 + `asset_id?`、`source?`、`highlights`、`highlight_version`。按 `item_id` 天然隔离；**不能把同一 file_id 其他行的 highlights 合并到当前行**。

### 5.2 `video_upload_tickets`（扩展现有集合）

```js
{
  _id: "vt_<random>",
  household_id: "hh_...",
  purpose: "item" | "scene",          // 缺省 = "item"，旧数据零回归
  scene_id: "<uuid>",                 // 仅 scene
  asset_id: "va_<random>",            // begin 时生成；item 模式也写入，便于统一清理
  item_id: "it_...",                  // 仅 item 模式
  duration_ms: 12000,                 // scene begin 时必须先存，commit 必须一致
  video_w: 1280,
  video_h: 720,
  cloud_path: "video-evidence/<hh>/<ticket>.mp4",
  ext: "mp4",
  status: "pending" | "binding" | "bound" | "cleaning" | "cancelling" | "cancelled" | "deleted",
  file_id: "cloud://...",             // receipt 后写入
  scene_payload_sig: "",              // scene commit 首次写入的 64 位 sha256；"" 表示未认领
  scene_evidence_count: 0,
  created_at, expires_at,            // 沿用 15 分钟
  binding_at, bound_at,
  scene_partial_at?
}
```

- 场景提交只允许同一 `scene_id` 和同一 `scene_payload_sig` 重试；不同载荷返回 `OPERATION_CONFLICT`。
- scene ticket 的 `evidence_id` 不再表示单条证据；用 `scene_evidence_count`/按 asset 查询代替。旧 item ticket 的 `evidence_id` 语义不变。
- 票据状态和 evidence 引用检查必须按 `household_id + asset_id`（旧票/旧行回退 `file_id`）查全部 item，不能只按 `ticket.item_id`。

### 5.3 锁与并发

- 继续用 `video_item_locks` 集合，不新建锁集合。
- 新增逻辑 asset 锁：`_id = "val_" + asset_id`，TTL 60s，文档带 `asset_id` 与 `purpose`。
- 统一锁序：**所有涉及的 item 锁按 item_id 升序获取 → 最后获取 asset 锁**。`videoSceneCommit`、`videoEvidenceDelete`、`videoCleanup` 的单文件处理、物品删除都遵循此顺序。
- 新建物品在锁外先通过现有 `createItem` 幂等建档；拿到 item_id 后再统一抢 item 锁，抢锁后重查物品存活，再写 evidence。进程中断在“建档后、证据写入前”的窗口由本地 pending 会话重试收敛，详见 §8。
- `videoSceneCommit` 是写类 action，必须加入 `WRITE_ACTIONS` 与 `ITEMS_MUTATING_ACTIONS`，走 `lib/household.js` 双 marker 硬门。

## 6. 服务端接口与编排

### 6.1 扩展 `itemsApi.videoUploadBegin`（场景模式）

现有 item 调用完全不变：

```js
{ action:"videoUploadBegin", item_id, ext? }
```

新增场景分支：

```js
{
  action: "videoUploadBegin",
  purpose: "scene",
  scene_id: "uuid",        // 8-64，客户端本次场景会话稳定 ID
  ext: "mp4"|"mov"|"m4v",
  duration_ms: 12000,      // 1..600000
  video_w: 1280,           // 1..10000
  video_h: 720
}
```

返回在原字段基础上增加：

```js
{
  ok:true,
  upload_ticket:"vt_...",
  upload_path:"video-evidence/<hh>/<ticket>.mp4",
  expires_at:"...",
  asset_id:"va_..."
}
```

服务端：

- 纯参数校验；scene 模式下 item_id 不存在也合法，但 ticket 明确 `purpose:"scene"`。
- 校验 `scene_id`、duration/w/h 合法；生成 `vt_` 与 `va_`，路径同 #89。
- 不锁具体 item；insert ticket 为 `pending`，15 分钟过期。
- 旧 item 分支保持 begin 抢 item 锁、复核 item 存活、每次新票、不回退旧 pending 的 #89 行为。

### 6.2 复用 `videoUploadReceipt`

入参不变：`{action:"videoUploadReceipt",upload_ticket,file_id}`。

- item ticket：完全沿用 #89 item 锁 + CAS。
- scene ticket：无 item 锁；校验 ticket 家庭、purpose、路径完全匹配、file_id 等价，CAS `status:"pending"` 写 `file_id`/`receipt_at`。
- 与取消的竞争沿用 #89 的 “CAS cancelling 后强制重读最新 ticket” 规则；receipt 只写 pending，不把 file_id 写回 cancelled/cancelling。
- receipt 失败不创建任何 evidence；本地保存 pending，可重试或取消。

### 6.3 新增 `itemsApi.videoSceneCommit`

```js
{
  action: "videoSceneCommit",
  scene_id: "uuid",
  upload_ticket: "vt_...",
  file_id: "cloud://...",
  duration_ms: 12000,
  video_w: 1280,
  video_h: 720,
  consent_version: "v1",
  items: [
    // 新物品：一件一个 operation_id；同名不同件必须不同 operation_id
    {
      draft_key: "draft-a",
      target: "new",
      operation_id: "uuid-op-a",
      name: "黑色耳机",
      location_text: "书房 · 右侧抽屉",
      note: "",                        // 可选，≤200
      highlights: [
        { start_ms: 3200, end_ms: 4700, box: { x1:0.12,y1:0.20,x2:0.48,y2:0.55 }, source:"user_confirmed" }
      ]
    },
    // 已有物品：只显式按 item_id 关联，不用名字匹配
    {
      draft_key: "draft-b",
      target: "existing",
      item_id: "it_...",
      highlights: [ /* 1..8 */ ]
    }
  ]
}
```

校验硬门（全部在任一写入前完成）：

- `scene_id` 8-64、`upload_ticket`/`file_id` 形状、consent_version 必须 `v1`。
- `items` 1..12；`draft_key` 唯一且 1-64；新物品 operation_id 唯一、名称 1-50、位置 1-200；已有 item_id 唯一且形状合法。
- duration/w/h 与 scene ticket begin 时一致，异常 `INVALID_INPUT`。
- highlights 1..8、整数、`0≤start<end≤duration`、`box` 为 `null` 或四值 finite ∈[0,1] 且 `x2>x1,y2>y1`、`source:"user_confirmed"`；升序；完全相同项去重后仍 ≥1 且 ≤8。`box:null` 合法，语义是“仅时间窗、无框”；服务端不得把 null 伪造为整帧框。
- 票据存在、属当前家庭、purpose 为 scene、`file_id` 路径与票据完全一致；`getTempFileURL` 可用；否则 `VIDEO_NOT_AVAILABLE`。
- pending 且 `expires_at` 已过 → `VIDEO_TICKET_EXPIRED`。binding/bound 的同哈希重试可视作恢复路径，不重复上传。
- **纯参数错误整批零写入**；运行期单件失败走部分成功结果。

提交编排：

1. 计算 `scene_payload_sig = sha256(canonical(最终 items + highlights))`（通过新增 `deps.sha256` 注入，测试可注入；票据只存哈希，不存 AI 原文/候选名）。
2. 认领票据：
   - `pending`：CAS `{_id,household_id,status:"pending"}` → `{status:"binding",binding_at,scene_payload_sig,scene_evidence_count:0}`。CAS 失败则重读；哈希不同 → `OPERATION_CONFLICT`，相同继续。
   - `binding`/`bound`：只允许 `scene_payload_sig` 与本次完全相同；否则 `OPERATION_CONFLICT`。
   - 其他状态 → `VIDEO_TICKET_BUSY`/`VIDEO_TICKET_EXPIRED`。
3. 对每个 item：
   - `new`：复用 `createItem` 幂等建档/重放；同名不同 operation_id 会得到不同 item_id，服务端不得按 name/name_norm 查重。
   - `existing`：只使用 event.item_id；服务端复核家庭、未删、存活；不做名字匹配。
4. 收集所有成功 item_id，按升序抢 item 锁；任何一把忙 → `VIDEO_ITEM_BUSY`，此时已建物品保持（客户端可用同载荷重试），不写 evidence。
5. 抢 `val_<asset_id>` asset 锁。
6. 锁内逐件重查 item 存活，写入 evidence：
   - 先按 `(household_id,item_id,file_id)` 查重。
   - 不存在：add 一行；`_id = "ve_"+genId()`；`asset_id` 来自 ticket；`source:"scene"`；`highlights` 只写最终确认字段；`highlight_version:1`；`highlight_updated_at:now`；`upload_ticket` 同票。
   - 已存在：比较 `duration_ms`、box/highlight canonical 内容；完全一致 = duplicated 成功；不同 = 该件 `OPERATION_CONFLICT`，绝不覆盖。
   - E11000 并发插入 → 回查 `(household,item,file_id)`，存在则收敛。
7. 更新 ticket：
   - 至少一条 evidence 成功：`status:"bound"`，`scene_evidence_count` 为当前 asset 引用数；即使其他件失败也保护文件。
   - 所有件都成功：`bound` 且 `scene_partial_at` 清除。
   - 零 evidence 成功：ticket 保持 `binding`（已有 `binding_at`）以便同载荷重试和清理态恢复；返回逐件失败，不假装成功。

响应：

```js
{
  ok: true,
  scene_id,
  asset_id,
  ticket_state: "bound" | "partial",
  results: [
    { draft_key, ok:true, item_id, created:true, duplicated:false, evidence_saved:true, evidence_duplicated:false }
    // 或 { draft_key, ok:false, error:"...", message:"..." }
  ],
  evidence_failed: ["draft-key..."]   // 仅证据写入失败/未完成件，供 UI 显示可重试
}
```

- 网络丢响应后，客户端用**完全相同的 scene_id/upload_ticket/file_id/items/highlights** 重试；物品和 evidence 通过 operation_id / unique index 收敛。
- 一旦进入上传/提交，UI 冻结载荷；改名字/框/选择后哈希不同，服务端拒绝，必须整批重新走新票据，不能与已成功部分混写。

### 6.4 扩展 `videoUploadCancel`（场景 ticket）

入参不变：`{action:"videoUploadCancel",upload_ticket}`。

- 先按 ticket 的 `asset_id`（缺省按 `file_id`）查是否有任何 evidence 引用。
- 有引用：修复票据为 `bound`，返回 `{ok:true,state:"bound",linked_item_ids:[...]}`（保留现有单件 `evidence` 字段形态；场景可另带列表）。**绝不删文件**。
- 无引用且 `pending`：CAS `pending→cancelling`，成功后强制重读最新 ticket，再查一次 evidence，按最新 file_id 逐文件删除；成功置 `cancelled`；失败恢复 `pending` 并返回 `VIDEO_DELETE_FAILED`。
- `binding`/`cleaning`/`cancelling` → `VIDEO_TICKET_BUSY`；`cancelled`/`deleted` → `{state:"cancelled"}`。
- 取消与 commit 的竞争由票据 CAS 决定；如果 commit 已写入任意 evidence，取消一定返回 bound，不破坏已确认物品。

### 6.5 识别接口（不新增）

- 每帧复用 `extractDraft.vlRecognize`，不在服务端持有跨帧会话，不落候选。
- 客户端串行调用；服务端日志保持现有纪律。场景层新增日志仅允许：`action:"videoSceneCommit"`、`framesFinished`、`frameFailures`、`candidateCount`、`confirmedCount`、`evidenceSavedCount`、`error`；不得出现 framePath/base64/物品名/位置/draft 内容。
- `vlRecognize` 返回 `truncated:true` 时，客户端逐帧显示“该帧只保留前 10 件，可能漏件”，不当作完整扫描。

## 7. 同一文件多 item 的删除与清理（必须改 #89）

### 7.1 引用判定

新增内部 helper：

```js
// 查询当前 household 下所有引用同一逻辑文件的 evidence 行。
// 先按 asset_id；没有 asset_id 的旧行回退按 file_id 合并。分页拉全，去重 _id。
async function evidenceRowsForAsset(deps, assetId, fileId): Promise<row[]>
```

> **实施硬门槛（Lead 补充，不可降级）**：同一 `file_id` 被多个 evidence 引用时，删除必须做引用检查/最后引用判定；普通 `videoEvidenceDelete` 与删除物品级联都必须遵守。只有最后一条 evidence 删除时才允许删云文件。

任何云文件删除前，必须在 asset 锁内再查询一次。**有任意其他 evidence 行 → 只删目标行，不删云文件。**

测试门槛：`VS-SHARE-02`、`VS-SHARE-03`、`VS-SHARE-04`、`VS-SHARE-05`、`VS-SHARE-07` 必须全绿；任一失败不得合并 PR B。

### 7.2 单条视频删除 / 物品删除

- `videoEvidenceDelete`：
  - 仍按 item 归属取目标 evidence 行（指定 `evidence_id` 或该 item 全部）。
  - 抢 item 锁，再按 asset_id 升序抢对应 asset 锁。
  - 每个文件组：若有组外引用，删当前行即可；若当前行是最后引用，先 `cloud.deleteFile`，仅 status 0/-503003 后删当前行；失败保留行并返回 `VIDEO_DELETE_FAILED`。
  - 返回 `{ok:true,deleted:n}`，可选 `files_deleted`；不改变原有单件删除的成功路径。
- 删除物品（`cleanupForItem`）：
  - 删除物品已有 item 锁内逐 asset 处理；仍有其他 item 引用时只删本物品 evidence，云文件保留。
  - 最后引用才删云文件；删除失败则物品不删、证据/票据保留、可重试。
  - 场景 ticket 仍 bound 时不清成 deleted，除非该文件的最后一条 evidence 已删且云文件已成功清理。
- 单件 `videoEvidenceDelete` 和物品删除都不得用 `ticket.item_id` 作为“文件只属于这件”的依据。

### 7.3 清理 worker

修改 `videoCleanup`：

- `evidenceRefsTicket` 改为按 `(household_id,asset_id)` 查全部 item；旧票/缺 asset_id 回退 `(household_id,file_id)`。
- `binding/cleaning/cancelling` 恢复逻辑：有任一行 evidence → 修复 `bound`，禁止删共享文件；无 evidence 才走原来的 pending/删除流程。
- 过期 pending scene ticket：若已有 evidence（例如部分 commit 后异常），只修 bound；没有才删文件。
- bound scene ticket 永不进入过期清理集。
- 保留逐文件删除 status 判定、10min 中间态恢复、24h pending 回收和“禁止整个 video-evidence 前缀生命周期删除”的 #89 约束。

### 7.4 残余风险

- 云开发无跨文档事务。`videoSceneCommit` 可能“物品已建、部分 evidence 未写”；依靠幂等重试和本地 pending 收敛，不能承诺单次原子。
- 进程在收到响应前被杀时，服务端可能已建了部分物品/证据；本地会话丢失时用户会看到已确认的物品但可能缺视频证据。票据清理会删除无引用文件，但不会回滚已建物品。这是必须明示的残余风险。
- 多 item 共享文件在删除时有并发窗口；通过 item 锁 + asset 锁 + 删除前二次查询消除本设计范围内可复现的竞态，不承诺无锁环境下的强事务。

## 8. 确认页状态机

### 8.1 核心对象

```ts
type ScenePhase =
  | "idle"        // 入口
  | "scanning"    // 选视频、抽帧、逐帧识别
  | "review"      // 候选/草稿编辑
  | "uploading"   // begin + uploadFile + receipt
  | "committing"  // videoSceneCommit 中
  | "partial"     // 已部分写入，载荷冻结，可同载荷重试
  | "done"
  | "failed"
  | "cancelled";

interface SceneDraft {
  draftKey: string;                 // uuid，会话内稳定
  observationIds: string[];         // 显式分配给本件的线索，可为空（补件）
  name: string;                     // 可编辑；AI 名只是初值
  target: "new" | "existing";
  operationId: string;              // 仅 new；创建草稿时生成，提交重试不变
  itemId?: string;                  // 仅 existing；必须由用户显式选择
  locationText: string;             // 仅 new；可从批次位置继承/逐件改
  note: string;
  highlights: Highlight[];          // 最终每条 = 至少 1
  checked: boolean;                 // 用户显式确认这件要保存
}
```

- `SceneDraft` 只能由用户操作产生；系统可以显示同名簇作为浏览分组，但不能直接变成同一个已确认 draft。
- `operationId` 在草稿创建/拆分时生成；用户改名不改 operationId；一旦开始上传/提交，载荷冻结，不允许编辑。
- 相同名字的两个 draft 永远是两个 item，不会因为 name/name_norm 相同被服务端合并。
- `target:"existing"` 只能由用户在物品选择器选中已有 item 后设置；禁止按名字自动匹配。

### 8.2 状态转移

| 当前 | 事件 | 下一状态/动作 |
|---|---|---|
| idle | 同意隐私说明并选视频 | scanning：生成 `sceneId`，启动抽帧 session |
| scanning | 单帧识别成功 | 追加 observation，progress+1；不自动勾选 |
| scanning | 单帧失败 | 记录失败帧；继续其余帧 |
| scanning | 全部 initial/补充帧结束 | review；0 成功也进 review（允许手动补件） |
| scanning | 取消/onUnload | cancelled；停止 generation、丢在途回包、释放 base64；清本地或保留已完成的纯元数据 |
| review | 勾选/改名/显式合并/拆分/补件 | review；每次变更写本地会话（不含 base64） |
| review | 点保存 | 本地校验：至少 1 个 checked draft；每件 highlights 1..8；新物品 name/location 合法；existing item 唯一且非空；全部通过才进 uploading |
| uploading | begin 成功 + upload 成功 + receipt 成功 | committing |
| uploading | 上传/回执失败 | failed 或退回 review；保留 pending（ticket/fileId），可重试关联或删除待关联视频 |
| committing | 全部/部分成功响应 | done（全部成功）或 partial（部分失败，载荷冻结） |
| committing | 网络错误/超时 | partial/pending：用完全相同的冻结载荷重试；不重新生成 scene_id/operation_id/highlight 内容 |
| partial | 用户点“重试失败件” | committing（同载荷） |
| partial | 用户退出 | 本地保留 pending；已成功的 item/evidence 不回滚；不提供“假撤销” |
| done | 页面结束 | 清空本地场景会话 |
| failed | 用户重拍/取消 | idle/cancelled；如存在票据调用 scene cancel，绝不直接删云文件 |

### 8.3 同名拆分/合并规则

- 视图层可把归一化同名（沿用 `normalizeName` 显示口径）的 observations 显示在一组，标签必须写“同名线索，不代表同一件”。
- 默认不生成任何“已合并”草稿。用户点击“把选中的同名线索视为一件”才创建一个 draft，并把这组 observationIds 放进同一 draft。
- 对同一草稿点“拆成多件”：
  - 若草稿含 N 条 observation，可拆成 1..N 个新草稿；
  - 每个新草稿生成新的 `draftKey` + `operationId`；
  - observationIds 按用户分组，不能重复；
  - highlights 由各自 observation 重新生成，原草稿作废；
  - 同名是允许的，保存后是两个 `item_id` 和两行 evidence，各自独立 highlights。
- 合并草稿必须用户显式操作；合并只合并草稿和该件多个观察点，不把不同名字的实体自动归并。
- 补件：
  - 新草稿默认 `observationIds: []`；
  - 用户从已抽帧中选一帧并生成 1 条 highlight；可手动画 0-1 框，也可显式选择“仅时间、不画框”；
  - 若 AI 没给出框（observation.box=null），用户可直接确认成 `box:null` 的仅时间高亮，或在 UI 中补画框；两种语义必须在确认页明确区分，不得把 null 渲染成整帧框。
  - 补件的 name/location 必填；可显式关联已有物品。

### 8.4 离页与进程中断

- scanning/review 阶段：`onHide/onUnload` 取消在途抽帧/识别 generation；只把纯本地会话写 storage。没有云上传，因此云侧零残留。
- 点击保存后的关键顺序：
  1. 先把冻结载荷与 `sceneId` 写本地 pending；
  2. 再 begin；
  3. upload 成功后立刻 receipt；
  4. commit。
- 进程在大步骤之间被杀：重进页面检测 pending；若有 `fileId` 且票据未过期，使用同一冻结载荷重试 receipt+commit；若票据过期，提示重新上传或删除待关联视频（scene cancel）。
- 页面 `onUnload` 不承诺取消已经发出的云请求；通过 scene generation 只忽略迟到 UI 回包，靠票据 CAS + 幂等键收敛。
- 取消/离开时若已经有 evidence，服务端返回 bound；UI 必须展示“已保存部分”，不能显示“已全部取消”。

## 9. 隐私与安全边界

1. **确认前零云存储**：选视频、抽帧、逐帧 VL 均不把原视频写入云存储；单帧 base64 只临时传给云函数，函数不落库、不落盘、不写日志。
2. **AI 原始输出不落库**：observations、candidate id、confidence、qty_note、模型原文只在本地内存/本地会话短暂存在；数据库只保存用户确认后的最终 item 名称/位置和 highlights。
3. **原视频只在最终确认后上传**：使用 #89 服务端签发票据、路径完全匹配、receipt、家庭隔离；不能由客户端自选云路径。
4. **跨家庭隔离**：handle 中 household_id 只来自服务端解析；scene commit 的 item_id/file_id/asset 全部要在当前 household 下复核；跨家庭统一 NOT_FOUND/FILE_NOT_OWNED。
5. **日志脱敏**：itemsApi 和 extractDraft 的日志不得出现 base64、framePath、物品名、位置、location_text、highlights 坐标、scene payload。只允许 action/error/count/耗时/engine。
6. **播放**：详情回放仍默认折叠，用户点击后才加载/播放；临时链接不持久化；换链失败如实显示并可重试，不把旧链接长期缓存。
7. **保留/删除**：用户删除某件证据只解除该 item 的引用；同文件仍被其他 item 使用时保留文件。全部引用删除后才删云文件。删除失败保留证据行并返回可重试错误，不出现“UI 已删、云文件还在”的静默状态。
8. **本地会话**：按家庭作用域隔离、TTL 24h、不含 base64；清空失败不假装成功，靠 TTL/形状门失效。

## 10. 测试矩阵

以下测试均要求零外网、stub wx/云函数、使用 `tests/helpers/memoryDb.js`；新增文件建议 `tests/video-scene-*.test.js`，并在 `tests/video-evidence.test.js` 补共享文件/引用用例。

### 10.1 帧计划与客户端扫描

| ID | 场景 | 断言 |
|---|---|---|
| VS-PLAN-01 | 10s 视频 | 8 个唯一时间点，initial 4 个顺序正确，supplemental 4 个在合法范围 |
| VS-PLAN-02 | 300ms/1200ms 短视屏 | 去重后时间唯一、clamp 到 [0,duration-1]、不产生 8 个重复点 |
| VS-PLAN-03 | duration 非法 | 纯函数拒绝，不进入 wx 调用 |
| VS-SCAN-01 | 4 帧成功 + 4 帧成功 | 逐帧串行，observation 带 frameIndex/timeMs/box/frameW/H，总调用 ≤8 |
| VS-SCAN-02 | 第 3 帧 VL 失败 | 其余帧结果仍在，失败帧计数/错误可展示，不抛出整批失败 |
| VS-SCAN-03 | 0 帧成功但抽帧可用 | 进手动补件路径；不伪造 AI 候选 |
| VS-SCAN-04 | 抽帧不可用 | 可展示降级，不发起云上传、不写 evidence |
| VS-SCAN-05 | 取消/onUnload | generation 失效后迟到响应零上屏、零 storage 写入、base64 不持久化 |
| VS-SCAN-06 | 单帧 base64 超 4M/压缩失败 | 该帧如实失败；不把超限 base64 发到 callFunction |
| VS-SCAN-07 | vlRecognize 返回 truncated | UI 有“该帧可能漏件”提示，不宣称完整 |
| VS-LOG-01 | 扫描/失败日志 | 不含 base64、framePath、物品名、位置、坐标 |

### 10.2 确认页状态机与同名规则

| ID | 场景 | 断言 |
|---|---|---|
| VS-STATE-01 | 两条同名 observation | 不自动变成同一 draft；显示同名线索提示 |
| VS-STATE-02 | 用户显式合并两条同名 | 一个 draft 含两条 observation；保存后一个 item 多个 highlights |
| VS-STATE-03 | 一个含 3 observation 的 draft 拆 3 件 | 3 个不同 draftKey/operationId，observation 不重复，保存后 3 个 item_id、3 行 evidence、各自 highlights |
| VS-STATE-04 | 两个同名 draft | 生成两个独立 item；不得按 name_norm 合并；两行 evidence 共享 file_id/asset_id |
| VS-STATE-05 | 改名 | 不改变 draftKey/operationId；未提交前只影响最终 name |
| VS-STATE-06 | 补件 + 手动画框 | 新 draft 有独立 operationId、至少 1 条 confirmed highlight（box 非 null） |
| VS-STATE-07 | AI box=null 且用户不画框 | 允许保存为仅时间 confirmed highlight；提交 `box:null`，UI 明示“无框”，不得伪造整帧框 |
| VS-STATE-07b | 无框候选后来补画框/清除框 | 切换只改当前 draft 的 highlight 载荷；提交前不写服务端 |
| VS-STATE-08 | 提交冻结后改名字/框 | UI 拒绝编辑；同载荷重试哈希一致 |
| VS-STATE-09 | 扫描中 onHide/onUnload | 无云写入；已完成的本地元数据按 scope TTL 恢复，不把 base64 写 storage |
| VS-STATE-10 | uploading 中进程中断 | 本地 pending 可恢复；同载荷重试不重复建 item/evidence |

### 10.3 服务端场景提交

| ID | 场景 | 断言 |
|---|---|---|
| VS-API-01 | 合法 2 件同名但不同 operation_id | 返回 2 个不同 item_id；video_evidence 2 行同 file_id/asset_id、不同 item_id/highlights |
| VS-API-02 | 已有 item 显式关联 | 不新建 item；只为该 item 写 evidence |
| VS-API-03 | 同名但只按名字找已有 item | 服务端不按 name 自动关联；仍创建新 item |
| VS-API-04 | highlights 边界 | start=0/end=duration 合法；box=null 合法且原样读回；start≥end、越界、box 非 null 但非 0-1、source 非 user_confirmed 均 INVALID_INPUT 零写入 |
| VS-API-05 | 1..12 件/1..8 highlights | 超上限 INVALID_INPUT；空 highlights INVALID_INPUT |
| VS-API-06 | 纯参数错误 | 整批 INVALID_INPUT，零 item/evidence/ticket 变更 |
| VS-API-07 | 跨家庭 ticket/item/file_id | NOT_FOUND/FILE_NOT_OWNED，零写入 |
| VS-API-08 | 路径不匹配/文件不可换链 | FILE_NOT_OWNED/VIDEO_NOT_AVAILABLE，零 item/evidence 写入 |
| VS-API-09 | 过期 pending scene ticket | VIDEO_TICKET_EXPIRED，零写入 |
| VS-API-10 | 不同 scene_id 重试 | OPERATION_CONFLICT，不混写 |
| VS-API-11 | 同载荷重试 | createItem duplicated、evidence duplicated；无新增行 |
| VS-API-12 | 同 scene/payload 但改 highlights 重试 | OPERATION_CONFLICT；原行不变 |
| VS-API-13 | createItem 成功但 evidence 写失败 | 响应逐件失败/evidence_failed；已有 evidence 保留；同载荷重试只补失败件 |
| VS-API-14 | payload 仅含 AI 额外字段（confidence/candidate_id/qty_note） | 服务端白名单丢弃，不落库、不回显 |
| VS-API-15 | 日志 | 无 item 名称/位置/base64/highlights 坐标 |

### 10.4 共享文件删除、换链与清理

| ID | 场景 | 断言 |
|---|---|---|
| VS-SHARE-01 | 同一 file_id 两 item | `videoEvidenceGet([A,B])` 各返回自己行；file_id 相同、highlights 不串 |
| VS-SHARE-02 | 删 A 的 evidence | A 行删除；云文件未删；B 行/URL/高亮不变 |
| VS-SHARE-03 | 再删 B（最后引用） | 才调用 deleteFile；成功后两行消失；文件删除失败则 B 行保留、返回 VIDEO_DELETE_FAILED |
| VS-SHARE-04 | 删除物品 A | 只清 A 的视频引用；B 文件保留；物品 A 删除成功 |
| VS-SHARE-05 | 删除物品 A 且 A 是最后引用 | 文件删除成功后 A 行/票收口；失败时物品 A 保持可重试 |
| VS-SHARE-06 | 删除物品时同票多资产 | 一个失败不破坏其他已成功清理的幂等重试 |
| VS-SHARE-07 | 旧 #89 行无 asset_id | 回退按 file_id 判定引用；单件行为零回归 |
| VS-SHARE-08 | scene ticket 清理遇到共享 evidence | 修 bound，不删文件；无引用才允许删 |
| VS-SHARE-09 | cleanup 恢复 stale binding/cleaning/cancelling | 有 evidence 修复 bound；无 evidence 按 #89 状态机收敛 |
| VS-SHARE-10 | getTempFileURL 单行失败 | 该行 video_url=""，其他 item 行照常播放；不因共享文件废整次查询 |

### 10.5 PR A 集成回归

| ID | 场景 | 断言 |
|---|---|---|
| VS-PRA-01 | 旧 evidence 行无 highlights | 读作 [] / version 0，客户端不崩 |
| VS-PRA-02 | scene evidence 行高亮版本 | 首次 commit 为 version 1；后续 PR A highlightSave 的 CAS 可正常工作 |
| VS-PRA-03 | scene commit 的 highlights 形状 | 与 `videoEvidenceHighlightSave` 使用同一校验；不存在第二套高亮 schema |
| VS-PRA-04 | 视频详情页高亮 | 只展示当前 item 行的 highlights，不拿同 file_id 其他 item 的高亮 |
| VS-PRA-05 | PR A 单件 attach 零回归 | 旧 item upload/attach/get/delete/cancel 测试全绿 |

### 10.6 真机验收（离线测试不能替代）

- iOS + Android 各一台，竖屏 + 横屏；抽屉/柜子各录一次。
- 4 帧初扫 + 4 帧补扫：进度、取消、页面切后台/回前台、离开再进入。
- 弱网/超时/解码器不支持：明确降级，不自动写事实。
- 确认后上传时杀进程、重进恢复 pending、重试/删除待关联视频。
- 两件同名物品拆开保存后，详情页和搜索都不串高亮；删其中一件不破坏另一件视频。
- 确认未对 `video-evidence/` 前缀配置统一生命周期删除；清理任务只清无引用 pending 票据。

## 11. PR B 可执行验收标准

以下为实施 PR 必须满足的硬验收（设计已定义，实施时逐项打勾）：

1. `npm run build:mp`、`npm run typecheck`、`npm test` 全部通过；新增 `video-scene-*` 测试均零外网、零真实 wx。
2. 同一原视频提交后存在 N 条 `video_evidence`，N = 用户确认件数；每行 `item_id` 唯一，`file_id`/`asset_id` 相同，`highlights` 行内独立且 `source==="user_confirmed"`。
3. 两个确认名完全相同的物品仍是两个 `item_id`；不存在用 name_norm / 同名自动合并的代码路径；UI 仅展示同名提示，拆分后两个 operation_id 不同。
4. 每条 highlight 能通过 `videoEvidenceGet` 读回：时间在 duration 内，box 为 null 或 0-1 有效框，且只属于对应 item；旧行缺省 `[]`/0 不报错。
5. 确认提交前，数据库没有 item/evidence、云存储没有本次视频；上传但未提交的票可在取消后按 #89 严格删除，删除失败保留票。
6. 单帧 VL 失败不阻断其他帧；0 帧成功时仍可手动补件或如实降级；不得出现无来源帧/框的 AI 确认高亮。
7. 取消/离页/进程中断不会把 base64 写入 storage/数据库/日志；已上传未完成票据由本地 pending + 服务端 15min/24h 清理兜底，重试幂等。
8. 共享文件删除：删 A 不删文件，删 B（最后引用）才删文件；两块云删除失败路径都保留可重试证据行并返回 `VIDEO_DELETE_FAILED`。
9. `videoSceneCommit` 同载荷重试不重复建档/证据；不同载荷返回 OPERATION_CONFLICT，已写行不被覆盖。
10. `videoEvidenceGet` 仍支持旧 #89 单件行为；PR A 的 highlightSave 与 scene commit 共用同一 highlights schema。
11. 日志抽检无物品名、位置、base64、框坐标、candidate 原文。
12. 真机验收清单（§10.6）在 PR B 合并前完成；未完成时 PR 保持 HOLD，不部署真实家庭。

## 12. 待确认问题

1. **PR A highlight schema 的最终版本**：本设计不依赖额外 `frame_ms`，但要求 `source:"user_confirmed"`、box 为 null 或 0-1 有效框、start<end≤duration、旧行 []/0 与 `videoEvidenceHighlightSave` 同一校验。若 PR A 最终去掉/改名这些字段，本设计需同步调整。
2. **最终件数上限**：本设计取 12 件（每次场景确认）；超过时 UI 明确要求分批/合并，不得后台静默截断。若产品期望更大批量，需要重新评估 itemsApi 20/60s 超时与 UI 性能。
3. **场景上传票据是否复用 `videoUploadBegin` 的 `purpose:"scene"` 分支**：本设计建议复用，减少 action 面；若 PR A 实现已改动该 action 签名，需在冻结时锁定兼容写法。
4. **itemsApi 超时**：12 件串行建档+证据写入可能超过当前 20s 云函数/15s 客户端预算。实施前需用本地/测试环境测时；若不达标，scene commit 使用独立客户端 70s 预算并评估将 itemsApi 云函数 timeout 调到 60s（部署配置变更，需 Lead 批准）。
5. **场景入口位置**：新页面入口（首页拍照入口下方的“拍视频找多件” vs 物品列表页）待产品定；不影响本设计数据/接口。

---

**结论**：本设计以最小增量复用 #89 和 PR A：不新建集合、不引入第二套高亮 schema、不把 AI 候选落库；只扩展票据的 scene 分支、evidence 的 asset_id/highlights、共享文件引用删除和确认页状态机。PR B 的实施前提是 PR A 合入/冻结，且不得在 PR A 独占文件上与 PR A 并行修改。
