# PR A 设计冻结：单件视频「AI 找这件物品」

状态：FROZEN（实现以本文件为准；只允许向后兼容增字段）
上游：PR #89 已合入的单件视频留证/票据/归属/删除/孤儿清理合同。
范围：只处理**已有单条视频证据**的目标物品定位与用户确认高亮；不做场景扫描、不做跨视频聚合、不做物理身份自动合并。

## 1. 数据与边界

- `video_evidence` 行内嵌高亮，不新增集合，不新增云文件，不改变票据/删除/孤儿清理路径。
- 高亮只在用户明确确认候选后写入。AI 候选只存在详情页内存，离页/取消即清空。
- 持久化字段：
  ```js
  highlights: [{
    start_ms: Number,   // integer, >= 0
    end_ms: Number,     // integer, > start_ms, <= duration_ms
    box: {x1,y1,x2,y2} | null, // 可空；null=仅时间窗无框；有框时 0..1 相对完整视频帧
    frame_ms: Number?,         // 可选，框对应的观察帧；缺省按 start_ms 读取
    source: "user_confirmed"
  }],
  highlight_version: Number,          // 初始 0，每次确认保存成功 +1
  highlight_updated_at: String,       // ISO
  highlight_update_id: String         // 幂等键；不存 AI 原文/目标名/候选 id/置信度
  ```
- 单行 1..8 条，服务端按 `start_ms`、`end_ms` 升序规范化；`[start_ms,end_ms)`。
- `box` 必填但允许 null；有框才校验 0..1 与 x1<x2/y1<y2。`frame_ms` 可选，携带时须 `start_ms <= frame_ms < end_ms`；缺省读取按 start_ms（PR B 来源帧兼容字段）。
- 读侧 `videoEvidenceGet` 每行返回 `highlights`、`highlight_version`；旧行/非法行分别返回 `[]`/`0`。读侧不返回 AI candidate，也不区分「候选/确认」——能读到的高亮都是用户确认过的。
- 删除视频、删除物品、票据清理仍只按原 `file_id`/证据行处理；高亮随行删除，不产生孤儿。

## 2. 写接口：`itemsApi.videoEvidenceHighlightSave`

写类 action，继承现有共享家庭写入硬门和用户归属派生。

请求：
```ts
{
  action: "videoEvidenceHighlightSave";
  item_id: string;
  evidence_id: string;
  expected_highlight_version: number; // 读到的 highlight_version；初始 0
  highlight_update_id: string;        // 8..64，客户端 uuid；只做幂等
  highlights: Array<{
    start_ms: number;
    end_ms: number;
    box: { x1: number; y1: number; x2: number; y2: number } | null;
    frame_ms?: number; // 可选，[start_ms,end_ms)
  }>;
}
```

响应：
```ts
{
  ok: true;
  evidence_id: string;
  highlights: VideoEvidenceHighlight[];
  highlight_version: number;
  duplicated: boolean; // true = 同 update_id 重放，未再次递增版本
}
```

校验与并发：
- `item_id` / `evidence_id`/update id/版本/1..8 条/highlights 字段形状先做输入门。
- item 必须 `household_id=当前家庭 && deleted=false`；evidence 必须属于当前 household + item；否则 `NOT_FOUND`/`INVALID_INPUT`，零写入。
- 物品级锁与 attach/删除物品共用；锁忙返回 `VIDEO_ITEM_BUSY`。
- 在锁内重读 evidence，绑定 `expected_highlight_version` CAS；版本不符返回 `VERSION_CONFLICT`。
- 同 `highlight_update_id` 重放：返回当前值 + `duplicated:true`，不重复递增版本；同 id 内容不一致视为输入冲突，零写入。
- 服务端固定写入 `source:"user_confirmed"`；客户端不传 source，也不传 confidence/候选 id/目标名。
- 删除视频/物品期间不复活证据：写入前 item/evidence 必须存活，行更新使用 `_id` 条件更新；拿不到锁或行被删则失败。

## 3. 识别接口：`extractDraft.videoTargetRecognize`

无状态、只走现有 VL 三件套，不接 DeepSeek，不读云存储、不落库。

请求：
```ts
{
  action: "videoTargetRecognize";
  target_name: string;  // trim 后 1..40 code points
  image_base64: string; // 裸 base64，1..4,000,000 chars
  img_w: number;        // integer 1..10000
  img_h: number;        // integer 1..10000
}
```

响应：
```ts
{ ok: true; hit: boolean; box: {x1,y1,x2,y2} | null; confidence: "high"|"mid"|"low" }
```
- 模型固定输出 `{found, confidence, box:[x1,y1,x2,y2]}`，box 唯一合法量纲为 0..1000 整数，服务端严格归一为 0..1。`found=true` 但框非法 → 该帧 `hit:false, box:null`，不产生可确认候选。
- 模型坏 JSON/字段形状失败：带错误重试一次；仍失败或引擎抛错 → `{ok:false,error:"AI_UNAVAILABLE",manual_fallback:true}`。VL 未配置同码。
- 输入不合法 → `{ok:false,error:"INVALID_INPUT"}`。
- 时间不由服务端提供；客户端候选的 `time_ms` 唯一来源是抽帧计划请求的 seek 目标时间。
- 日志只允许 `action/elapsedMs/engine/hit/targetLen/error/reason`，绝不记 `target_name`、base64、模型原文、物品名。

## 4. 客户端抽帧原语：`miniprogram/utils/video-target.ts`

对外通用原语（PR B 可复用）：
```ts
createVideoFrameSession(source, options?): VideoFrameSession
interface VideoFrameSession {
  captureAt(timeMs: number, frameIndex?: number): Promise<{
    path: string; width: number; height: number; timeMs: number; frameIndex: number; base64: string;
  }>;
  cancel(): Promise<void>;
  readonly cancelled: boolean;
}
```
`captureAt` 内部按需打开一次 decoder；每次 seek 后取帧、JPEG 输出并读裸 base64。结果 base64 仅内存交给当次识别，调用方用完即弃；`cancel()` 关闭 decoder 并拒绝后续 capture。PR A target 识别只在此原语上编排，不另藏私有 captureAt。

Constants:
- `VIDEO_TARGET_FRAME_LONG_EDGE_MAX = 1024`
- `VIDEO_TARGET_BASE64_MAX_CHARS = 4000000`
- initial 4 samples at duration fractions `0.10, 0.35, 0.65, 0.90`
- progressive 4 samples at `0.225, 0.50, 0.775, 0.975`
- 首 4 帧中出现 `high/mid` 命中即停止；没有命中或只有 low 时继续后 4 帧。总帧数 4..8。
- 抽帧串行；每帧 JPEG quality 0.72，输出长边 ≤1024；单帧 base64 超 4,000,000 字符则中止为降级，不发起调用。
- `time_ms` = 计划 seek 目标整数时间；窗口 `start=max(0,time_ms-750)`，`end=min(duration,time_ms+750)`，并保证 `start<end`。
- Candidate 逐帧独立保留，不按名称/相邻帧/相似框合并：
  ```ts
  { frameIndex, timeMs, windowStartMs, windowEndMs, box, confidence, framePath, frameW, frameH }
  ```
  `framePath` 仅内存临时文件，用于候选预览；base64 用完即丢，不写入 storage/云/服务端。
- 每次 AI 查找使用一个 `VideoFrameSession`；取消按钮、`onHide`、`onUnload` 均 `cancel()` 并清候选。抽帧/识别每个 await 边界检查 session.cancelled。
- 降级 kind：`cancelled | unsupported | disabled | extract_failed | recognize_unavailable | bad_response | too_large`。页面只展示如实不可用/未找到文案，视频普通回放不受影响，默认不自动播放。
- 可关闭开关：`VIDEO_TARGET_FEATURE_ENABLED` 常量 + `videoTargetEntryState()` 能力探测；关闭/不支持时入口显示「AI 查找暂不可用，可正常回放」，不发起抽帧。

## 5. 详情页交互

- 只在已有最新视频的展开态显示入口「🔎 AI 找这件物品」。
- 点击后：进度（抽帧/识别第 N/M 帧）→ 候选缩略图（独立卡片，框叠加）→ 用户勾选（默认全不选，低置信不自动勾选）→ 确认保存。
- 保存只写用户选中的时间窗/框；候选本身不持久化。成功后刷新 videoEvidence；失败零写并给出可重试文案。
- 无命中：明确显示「这段视频里没找到『物品名』」，可回放或重拍；不宣称准确率。
- 取消/离页：立即失效当前 session，停止后续识别，清理本地帧临时文件。

## 6. 实现记录（Lead 集成）

- 后端：`itemsApi.videoEvidenceHighlightSave`、`videoEvidenceGet` 高亮字段、`videoEvidenceDelete` 与高亮保存共用物品锁、`extractDraft.videoTargetRecognize` 已实现；定向测试见 `tests/video-highlight.test.js`、`tests/video-target-recognize.test.js`、`tests/video-target-glue.test.js`。
- 客户端原语：`miniprogram/utils/video-target.ts` 提供通用 `createVideoFrameSession`、4→8 帧计划、可取消的串行目标识别编排、时间/框展示纯函数；测试见 `tests/video-target.test.js`。
- 详情页：已有视频展开态增加「AI 找这件物品」；候选缩略图带框、默认不选、用户确认后保存；保存成功展示已确认高亮时间点；未找到/不支持/超限/取消均有降级；onHide/onUnload/删除视频/收起卡片会取消 session 并清理临时帧。
- 未验证：真实 iOS/Android `VideoDecoder` + OffscreenCanvas + `canvasToTempFilePath` 设备链路、单帧实际 base64 载荷上限、8 帧总耗时、弱网/取消耗时。未完成这些真机验证前不得宣称识别准确率或全机型可用。
