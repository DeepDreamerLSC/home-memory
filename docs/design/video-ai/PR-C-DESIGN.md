# PR C 设计：搜索命中后定位到用户确认的视频片段

**状态**：设计预研（PROVISIONAL，待 PR A highlights/read contract 冻结、Lead 确认）
**范围**：搜索/详情入口、最佳已确认高亮时间窗定位、时间轴证据点、多证据与多 item 降级、测试矩阵与验收标准。
**非范围**：生产代码、云函数部署、PR A 的 AI 候选确认流程、PR B 的多物品扫描流程、自动播放、自动把候选写成事实。

## 0. 结论摘要

1. 搜索角标和详情定位只使用 `video_evidence.highlights` 中 `source:"user_confirmed"` 的数据；AI candidate、confidence、target name 不进入读模型，也不参与排序或文案。
2. 搜索行保留普通“进详情”入口；有视频时另给一个可独立点击的视频角标。角标只携带 `evidence_id + start/end` 提示，详情页重新拉取并校验，不携带临时 URL、框或任何未经服务端确认的数据。
3. 所有入口首屏仍折叠，不自动展开、不自动 seek、不调用 `play()`。用户点折叠条只展开到目标时间附近的暂停画面；真正播放只能由用户点原生播放器按钮触发。时间点 chip、切换证据视频同理，只 seek/换源，不开始播放。
4. “最佳片段”采用确定性、可解释的降级链：显式且有效的搜索提示优先；否则取该 item 最新一行的可播放证据中含用户确认 highlights 的最新一条；没有确认高亮则回退同一条视频 0s；只有不可播放行时显示重试，不伪造时间窗。
5. 同一 `file_id` 可能因 PR B 对应多个 item 的多行证据。PR C 全部按 `item_id` 隔离，且按 `evidence_id` 区分行；绝不按 `file_id` 把别的 item 的 highlights 合并或复用。
6. 不新增播放侧写接口。PR C 依赖 PR A 在 `videoEvidenceGet` 行投影中返回 `highlights`/`highlight_version`；PR B 继续返回 flat `evidence[]`、每行 `item_id` 和各自 highlights，即可兼容。

## 1. 基线与依赖

### 1.1 main / PR #89 已有能力

- `videoEvidenceGet` 一次最多查 10 个 `item_id`，每个 item 最多返回最新 3 条证据行，flat `evidence[]`；临时播放链接逐文件换取，单条换链失败时该行 `video_url:""`，不废整次查询。
- 详情页有视频卡时默认 `videoOpen=false`；用户点击折叠条后才渲染原生 `<video>`，当前实现无高亮、无定位、无自动播放。
- 搜索结果查询成功后会异步调用 `attachQueryVideo`，当前只给每件物品补 `hasVideo:true` 角标；角标没有独立点击目标。
- 搜索结果普通行通过 `data=<summary>` 打开详情；详情页 `onShow` 会重新拉视频证据并以折叠态展示。

### 1.2 PR A（video-ai-target）计划中的 highlights 合同

以下按 PR A owner 于设计期给出的 **PROVISIONAL** 草案，最终以 `docs/design/video-ai/PR-A-DESIGN.md` 和代码冻结结果为准：

- 用户确认后，highlights 嵌在 `video_evidence` 行内，不建独立集合：
  `highlights: [{ start_ms, end_ms, box:{x1,y1,x2,y2}, source:"user_confirmed" }]`。
- 行另有 `highlight_version:number`（初始 0）。当前不写 `highlight_id`、`candidate_id`、`confidence`、`target_name`、模型原文或“候选/确认态”；读到的 highlights 即用户确认数据。
- 时间窗为整数、左闭右开 `[start_ms,end_ms)`，`0 ≤ start_ms < end_ms ≤ duration_ms`；box 相对完整视频帧、左上原点、0–1；单行 1..8 条，按 `start_ms,end_ms` 升序。
- `videoEvidenceGet` 每行返回 highlights 和 `highlight_version`；旧行/异常行分别 `[]` / `0`。AI 候选只存在于详情页内存，用户离页/取消即丢弃，不落库。
- 写接口计划为 `videoEvidenceHighlightSave`，整体替换该 evidence 的 highlights，并用 `highlight_version` CAS；PR C 只读，不调用该接口。

### 1.3 PR B（video-scene-scan）计划中的多 item 证据

以下按 PR B owner 的设计期草案，最终以其设计文档为准：

- 同一物理视频仍表示为“每个 item 一行 `video_evidence`”，同批行 `file_id` 相同；计划新增可选 `asset_id` 做逻辑分组。
- 每行的 highlights 属于该行 `item_id`，绝不跨 item 合并；`videoEvidenceGet` 返回形状不变，仍是 flat `evidence[]`，客户端按 item 分组。
- 搜索角标仍按 `item_id -> 该 item 的有效行`；选中 A 物品时不得播放/展示 B 物品的 highlights。
- 同一物理文件的云删除需要引用计数/最后引用才删；PR C 只读，若换链为空则按行级失败降级。

## 2. 不变量与设计原则

### 2.1 事实边界

- **只读 user_confirmed**：读模型只接受 `source === "user_confirmed"` 的 highlight。其他 source、缺失 source、confidence/模型字段一律不参与定位。
- **候选不落读链路**：搜索/详情不请求、不缓存、不展示 AI candidate；即使服务端误带 `candidate`/`confidence`，客户端也不使用。
- **视频仍是历史证据**：所有文案继续说明视频只表示拍摄当时记录在哪；位置可能已变化时以当前文字位置为准。
- **用户确认不等于现实仍然如此**：时间窗和框只说明“用户当时确认过这段画面”，不能写成“现在就在这里”。

### 2.2 播放边界

- 页面首次进入、`onShow` 刷新、搜索 badge 深链、切换证据、点时间点、重试换链，都不得调用 `play()`。
- 折叠态不渲染原生 `<video>`（或至少不加载/不播放）；只有用户点击折叠条后才渲染播放器。
- 程序只允许 `seek`。`seek` 前后若视频原本暂停，则保持暂停；若用户已经在播放，点时间点可以继续播放，但页面不能主动开始播放。
- WXML 中不得出现 `autoplay="{{ true }}"`。真正的播放起点只能是原生播放器按钮/用户手势。

### 2.3 身份与作用域边界

- 所有 row/highlight 选择都同时匹配：当前家庭作用域、当前 `item_id`、该行 `consent_version === "v1"`、有效 highlights 合同。
- 不按 `file_id` 合并 items；`file_id` 仅用于换链和说明“同一原视频”，不作为归属键。
- 搜索异步补角标继续使用捕获的家庭 scope generation；旧家庭/收起搜索/换新查询的响应不得回写。
- 深链参数只是定位提示，不是事实来源；必须用新拉取的服务端行二次校验后才可 seek。

## 3. 读模型与客户端投影

### 3.1 期望的 `videoEvidenceGet` 行形状

```ts
interface VideoHighlight {
  start_ms: number;
  end_ms: number;
  box?: { x1: number; y1: number; x2: number; y2: number } | null;
  source: "user_confirmed";
}

interface VideoEvidenceRow {
  evidence_id: string;
  item_id: string;
  file_id: string;
  asset_id?: string;          // PR B 可选，仅用于未来分组，PR C 不用它合并 highlights
  video_url: string;          // "" = 本次换链失败，行仍保留
  duration_ms: number;
  video_w: number;
  video_h: number;
  captured_location_text: string;
  consent_version: string;    // 只展示 v1
  highlights?: VideoHighlight[]; // 旧服务端缺省视为 []
  highlight_version?: number;    // 旧服务端缺省视为 0
  created_at: string;
}
```

PR A 当前计划 box 必填；PR C 为兼容历史/未来无框已确认窗口，可把 `box` 缺失或 null 当作“只跳时间、不画框”。**绝不自行补框或把模型候选框填进来。**

### 3.2 客户端 highlight 规范化

PR C 视图层（`miniprogram/utils/video-evidence.ts`）统一做纯函数规范化；API 层负责行级结构门，单条 highlight 的字段由视图层逐条校验。这样一条坏 highlight 不会把同视频其他合法片段或普通回放一起判死：

- `highlights` 缺省 → `[]`；不是数组 → 整行按 0 条处理；数组内某条结构非法 → 只丢弃该条，不能崩溃，保留同 row 其他合法项。
- 单条合法条件：
  - `source === "user_confirmed"`；
  - `Number.isSafeInteger(start_ms/end_ms)` 且 `0 ≤ start_ms < end_ms`；
  - `duration_ms > 0` 时 `end_ms ≤ duration_ms`；
  - box 为 null/缺省 → 时间窗有效、无框；
  - box 存在时四个坐标均为 0–1 的有限数，且 `x1 < x2`、`y1 < y2`；否则该条丢弃。
- 对合法项按 `start_ms`、`end_ms` 升序稳定排序（防服务端顺序漂移）；key 使用 row 内 `evidence_id + start_ms + end_ms + 序号`，只作页面会话 ID，不写入或回传服务端。
- `highlight_version` 仅校验为可选非负整数并保留展示/调试上下文；PR C 不写它。
- `consent_version !== "v1"` 的 row 不进入播放候选。

### 3.3 视图投影

保留现有 `VideoEvidenceView` 字段，并追加：

```ts
interface PlaybackHighlightView {
  key: string;
  startMs: number;
  endMs: number;
  /** 0–100，用于叠加框；null = 只有时间点 */
  box: { left: number; top: number; width: number; height: number } | null;
  timeLabel: string;          // "00:12"
  rangeLabel: string;         // "00:12–00:15"
}

interface PlaybackEvidenceView extends VideoEvidenceView {
  evidenceId: string;
  assetId?: string;           // PR B 可选，仅用于展示分组提示
  playable: boolean;          // video_url !== "" 且 duration_ms > 0
  highlights: PlaybackHighlightView[];
}
```

`VideoEvidenceCollectionView` 继续保留 `latest/older/olderCount`，另提供按 `created_at` 降序的 `all`（≤3 行）供多证据 chip 使用。现有调用方不受破坏；搜索行仍只使用一个 item 的投影。

### 3.4 “最佳已确认时间窗”的选择算法

输入：当前 item 的 rows（API 最多 3 条）、可选的深链 hint、当前 item_id。输出：

```ts
type PlaybackFallbackReason =
  | "none"
  | "explicit_not_found"
  | "explicit_highlight_missing"
  | "explicit_url_failed"
  | "no_confirmed_highlight"
  | "all_urls_failed";

interface PlaybackTarget {
  mode: "highlight" | "video" | "unavailable" | "none";
  itemId: string;
  evidenceId: string | null;
  highlightKey: string | null;
  startMs: number;           // mode=highlight 时为窗口起点；mode=video 时为 0
  fallbackReason: PlaybackFallbackReason;
}
```

确定性规则，按顺序：

1. **行过滤**：只留 `item_id === 当前 item` 且 `consent_version === "v1"` 的行；不按 `file_id` 去重，不吸收其他 item 的 row。
2. **显式 hint 优先（且必须可验证）**：
   - hint 的 `evidence_id` 必须命中当前 item 的某一行；
   - 若 hint 带 `start_ms/end_ms`，必须在同一行合法 highlights 中精确命中同一个左闭右开窗口；
   - 该行 `playable === true` 才可直接采用。
   - 任一条件不满足 → 记录 fallback reason，进入默认选择；绝不拿 query 中的时间直接 seek。
3. **默认“含确认高亮的可播放行”**：
   - 只在 `playable === true` 的行中找含至少一条合法 user_confirmed highlight 的行；
   - 按 `created_at` 降序取最新；非法时间视为最旧；同时间保持服务端返回顺序。
4. **默认无高亮回退**：若没有任何可播放行含确认高亮，但有可播放行，取最新可播放行，`mode:"video"`、`startMs:0`。
5. **全部换链失败**：若只有不可播放行，取最新行，`mode:"unavailable"`、不 seek、不画框；详情卡显示重试。
6. **行内高亮默认点**：在选中行的合法 highlights 中：
   - 先优先有 box 的（更具体的视觉定位）；
   - 再按 `start_ms` 升序、`end_ms` 升序；
   - 取第一条作为默认定位点。
   这不是 AI 置信度排序，也不宣称“唯一正确片段”；该行所有合法 points 仍显示在时间点条中，用户可切换。

> “最佳”的边界：PR A 没有 `highlight_id`/`primary` 字段，所以客户端只能用上述确定性默认点。若 Lead 决定增加“用户指定的最佳/主片段”字段，选择器应优先该字段，但仍不改变“不自动播放”约束。

### 3.5 搜索侧投影

新增纯函数（名称示意）：

```ts
pickVideoPlaybackHints(
  rows: VideoEvidenceRow[],
  itemIds: string[],
): Record<string, {
  evidenceId: string;
  startMs: number | null;
  endMs: number | null;
  playable: boolean;
  badgeText: string; // "▶ 00:12" | "▶ 视频" | "▶ 暂不可播"
}>
```

- 以 `item_id` 分组，每件只用自己的 rows，复用 §3.4 的选择算法。
- 有合法确认高亮且可播：badge `▶ 00:12`。
- 只有可播普通视频：badge `▶ 视频`。
- 有证据行但本次全部 `video_url:""`：badge `▶ 暂不可播`（不伪装成可播放；点击仍可进详情重试）。
- 读取失败/无证据行：不补角标，不 toast，保持普通文字行，与 #89 增强露出纪律一致。
- `evidenceId/startMs/endMs` 只作为详情页校验 hint；不在搜索 URL 中放 `video_url`、box、confidence 或名称。

## 4. 搜索入口与详情深链

### 4.1 搜索结果行交互

搜索结果保持现有的整行“打开详情”行为；视频角标升级为可独立点击的子目标：

- 整行点击：`openItem(data)`，不带视频 hint；详情页仍会自行选择该 item 的默认最佳片段。
- 视频角标点击：用 `catchtap` 阻止冒泡，跳同一详情页并附加只读 hint。
- 角标文案来自 §3.5；`▶ 00:12` 表示“该 item 有一条已确认片段”，不是 AI 找到的结果。
- 同一原视频对应多个 item 时，每行的 badge 由自己的 item 行计算；A 的 badge 不显示 B 的时间窗。

WXML 语义示意（只是设计，不是生产代码）：

```xml
<view class="result-row" bindtap="onResultTap" data-index="{{index}}">
  ...
  <text wx:if="{{item.videoHint}}" class="video-badge"
        catchtap="onResultVideoTap" data-index="{{index}}">
    {{item.videoHint.badgeText}}
  </text>
</view>
```

### 4.2 详情页 query hint 合同

视频角标跳转可附：

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `video_entry` | 是 | 固定 `search_badge`；仅用于一次性 scroll/强调，不改变折叠/播放边界 |
| `video_evidence_id` | 否 | 搜索角标选中的 `evidence_id`，长度受限，只作候选定位 |
| `video_hint_start_ms` | 否 | 合法确认高亮起点；必须与 `video_hint_end_ms` 成对 |
| `video_hint_end_ms` | 否 | 合法确认高亮终点；与 start 一起精确匹配服务端 highlights |

以上参数是**不可信导航提示**：不复用临时 URL、不传 box、不传 confidence、不传候选文案。详情页必须：

1. 严格解析（已知值、非空、非负安全整数、start < end、成对出现）；非法即忽略，不阻断详情主体。
2. 先 `ensureScopeVerified`，再以 `item_id` 调 `videoEvidenceGet` 拉新数据。
3. 以新数据做 §3.4 校验；只有精确命中的 row + user_confirmed highlight 才可用于 seek。
4. hint 失效（证据被删、链接失败、highlights 被新版本整体替换、跨 item/跨家庭）时回退默认目标，并只在用户确实从 badge 入口来时给出非阻断提示，例如：
   “原来的视频片段不可用了，已回到这段视频的普通回放。”
5. 临时播放 URL 只存在当前页面内存，绝不写 storage 或拼进 URL。

### 4.3 详情页进入后的首屏行为

- 普通入口（搜索结果整行、直接打开详情）：拉取成功后视频卡默认折叠；若有确认高亮，折叠条显示“🎬 你确认过的片段 00:12–00:15 · 点开回看”；没有高亮显示“🎬 点开当时视频”。
- search badge 入口：仍然默认折叠；拉取后滚动到视频卡并高亮折叠条（一次性），不展开、不 seek、不播放。用户下一次点击折叠条才进入暂停的目标画面。
- 如果 badge 入口拉取失败，提供一条可重试的轻量失败提示；普通入口拉取失败继续静默整卡不渲染（视频是增强露出）。
- 首次成功定位后 `video_entry` hint 的 scroll/强调只消费一次；`onShow` 返回时不得重复滚动或自动展开。
- `onShow` 重拉时先收起播放器/清空旧 URL；保留当前 item 作用域校验，绝不把上个 item/家庭的目标上屏。

## 5. 详情播放状态与 UI

### 5.1 折叠态

- 视频存在且可播放：一张折叠卡，展示目标片段的确认时间（若有）、拍摄日期/当时位置、操作说明。
- 视频存在但全部不可播放：折叠卡显示“🎬 视频暂时无法加载 · 点按重试”，点击触发重新拉取；不展开空播放器。
- 无证据：沿用 #89 当前“给这件物品拍一段视频留证”入口；PR C 不凭空造卡。
- 折叠态仅为文字卡；不挂载 `<video>`，避免无意加载和播放。

### 5.2 展开态

用户点击折叠条后：

- 设置 `videoOpen=true`，只渲染原生 `<video controls show-center-play-btn>`，`autoplay=false`。
- 目标定位：设置 `initial-time = max(0, target.startMs/1000 - 0.3)`（0.3s 预卷，给用户看到事件前的上下文）；没有高亮则 0。
- 在 `loadedmetadata`/首次可 seek 时再 `seek` 一次兜底，保证不同基础库都停在同一目标；仍不调用 `play()`。
- 若用户在暂停态打开，则保持暂停；若用户点原生播放，才从当前目标位置开始播放。
- 视频比例继续用 `video_w / video_h` 的 aspect-ratio 容器；box 使用完整视频帧坐标百分比叠加，`object-fit:contain` 下不裁切，保证框对齐。
- 显示“视频只说明当时记录在哪，不冒充当前位置；你确认过的片段也可能有偏差”的说明。不得出现“AI 精确找到”之类事实化文案。

### 5.3 时间轴证据点

微信原生 `<video>` 不提供稳定、可无障碍操作的自定义进度条 overlay。PR C 采用播放器下方的“已确认时间点”条，不与原生控制条抢手势：

- 当前选中 evidence 行中的所有合法 user_confirmed highlights 都显示为可点击 chip，例如 `00:12–00:15`、`00:35–00:37`；若框存在可带小方块图标。
- 点 chip 只执行 `videoContext.seek(max(0, startMs/1000 - 0.3))`；暂停时仍暂停，正在播放时可继续播放。不得调用 `play()`。
- 点 chip 后默认选中该点；`bindtimeupdate` 计算当前毫秒：
  - 若落在某合法 highlight 的 `[start_ms,end_ms)` 且该 highlight 有框 → 叠加该框；
  - 离开区间 → 移除框；
  - 多个重叠时取排序后的第一条，避免多框叠加。
- 时间点条的每个 chip 必须有可读文字和时间，点击目标至少约 32px 高，不依赖纯色小刻度；2 秒内相邻点多时横向滚动，不互相覆盖。
- 默认选中的 chip 是 §3.4 的默认点；用户切换 chip 只改变页面选中状态和 seek 位置，不修改 highlights、不写 highlight_version。

### 5.4 多证据选择

- 详情卡展开后，如果该 item 有 2–3 条证据行，显示“留证视频”选择 chip：日期 + 是否含确认片段。默认选中 §3.4 的目标 evidence。
- 切换到另一条 evidence：
  - 只采用该 `evidence_id` 对应行的 URL 和 highlights；
  - 重新计算该行默认 point；播放器重新进入暂停态并定位；
  - 不调用 `play()`，不沿用上一条视频的当前时间/框。
- `video_url:""` 的 evidence chip 仍可见并标“暂不可播”；点选后显示重试，不默默跳到别行。若默认目标因最新行换链失败而落到更早可播放行，展开态显示一句如实说明：“最新一条视频暂时无法加载，当前查看更早的一条留证。”
- 删除/重拍不在 PR C 增加任何新写动作；沿用 #89 的删除入口和确认文案。PR B 共享文件引用计数由 PR B 负责。

### 5.5 用户可见文案纪律

| 状态 | 允许的文案 | 禁止的文案 |
| --- | --- | --- |
| 有确认高亮 | “你确认过的片段 · 00:12–00:15” | “AI 已定位”“准确找到” |
| 无高亮 | “这段视频还没有你确认过的命中时刻” | “AI 没找到/没有这件东西” |
| 换链失败 | “视频暂时无法加载，点按重试” | “视频不存在/已删除”（未验证前） |
| 视频内容 | “拍摄当时记录在哪” | “现在就在这里” |
| 框 | “你确认过的画面范围” | “物品当前位置框” |

## 6. 降级矩阵

| 场景 | 搜索行 | 详情/播放 | 定位行为 |
| --- | --- | --- | --- |
| 无任何证据 | 无视频角标 | 沿用“拍视频留证”入口 | 无 |
| 有视频、无合法 highlights | `▶ 视频` 或 `▶ 暂不可播` | 折叠普通视频卡 | 点击展开后从 0s 暂停；无框；无时间点 |
| 有确认 highlights、链接可播 | `▶ 00:12` | 折叠时显示默认片段 | 点击展开到 start‑0.3s 暂停；时间点可切换 |
| 最新行无 highlights、旧行有 | 按旧行确认片段显示 | 默认选旧行确认片段；多行时可见行选择 | 不自动改写数据；如实显示更早留证 |
| 最新行 `video_url:""`、旧行可播 | 若有旧行确认片段显示其时间；否则 `▶ 视频` | 默认落旧行并提示最新暂不可播 | 不 seek 到无链接行 |
| 全部行 `video_url:""` | `▶ 暂不可播` | 显示重试卡，不渲染空播放器 | 不 seek、不画框 |
| 播放器运行期 `binderror` | 已显示的角标保留 | 原位置显示“加载失败，点按重试” | 保留目标；重试成功后重新定位且保持暂停 |
| 显式 search hint 失效 | 不影响搜索页 | 回退默认目标；badge 入口给非阻断说明 | 不用 query 时间直接 seek |
| 同一 file_id、多 item | 各 item 独立 badge | 只取当前 item 行/高亮 | 不按 file_id 合并；不显示他 item 的时间点 |
| PR B 共享文件被错误提前删除 | 受影响行显示 `▶ 暂不可播` | 行级换链失败/重试 | 其他 item 行若仍有 URL 仍可独立播放 |
| 旧云端未返回 highlights 字段 | `▶ 视频` | 普通视频回放 | `[]` 兼容，不报错 |
| 响应含非 user_confirmed / 非法时间窗 | 该条被忽略；有其它合法项则正常 | 无框/无点或回退 0s | 不把候选当事实 |
| `videoEvidenceGet` 整体失败 | 不补角标、无 toast | 普通入口静默；badge 入口给一次性失败/重试提示 | 无 |
| `onShow` 时家庭/作用域已变 | 旧结果不回写 | 先清旧视频状态；作用域校验后再上屏 | 旧目标不复用 |

## 7. 与 PR A 的兼容/冻结要求

PR C 实施前置门槛：

1. `VideoEvidenceRow` 至少含 `highlights` 与 `highlight_version`，且 `videoEvidenceGet` 返回它们；旧行返回 `[]`/`0`。
2. 读出的 highlights 只含用户确认数据，`source:"user_confirmed"`；服务端 write action 已做 item 归属、时间窗、box、整体替换和版本 CAS 校验。
3. API 客户端 validator 接受合法 highlights，不因新增字段把整次读判坏；滚动部署期缺字段按空数组兼容。
4. PR A 的时间窗边界按左闭右开写清，PR C seek/框显示使用同一语义。
5. PR C 不调用 `videoEvidenceHighlightSave`，不写 `highlight_version`，不做追加高亮或候选合并。

## 8. 与 PR B 的兼容/集成门槛

- PR B 保持 flat `evidence[]`、每行 `item_id` 和独立 highlights；PR C 无需服务端新接口。
- 客户端按 `item_id` 和 `evidence_id` 双键隔离；`asset_id` 即使存在也不用于跨 item 合并。展示层如需说明“同一原视频”，只能做文字提示，不能把多个 item 的框/时间点混在一起。
- 搜索 badge、详情默认目标、多证据选择均按当前 item 的行集合计算。
- PR B 的 `frame_ms`（若加入）PR C 可忽略；未来若要精确帧级框再接，不在本 PR 引入依赖。
- 共享 `file_id` 的删除范围/引用计数是 PR B 的实现门槛：删一个 item 的证据不能提前删掉仍被其他 item 引用的云文件。PR C 只负责在最终拿到 `video_url:""` 时安全降级，不负责引用计数。
- 若 PR B 最终改为共享 evidence 单文档 + 多 item 绑定，则必须保持 `videoEvidenceGet` 对客户端输出“每 item 独立、行内 highlights 只属该 item”的 flat 投影；否则 PR C 的兼容假设不成立，应重新评审。

## 9. 安全、隐私与性能

- 播放链接只在当前页面内存；不写入 storage、深链、日志或分享参数。
- 详情页在换链前继续 `ensureScopeVerified` + scope generation 双检；搜索异步补角标保留现有 scope/查询代际守卫。
- 深链 hint 只接受白名单参数和长度上限；绝不由 query 构造 box、URL、source 或高亮文案。
- PR C 不调用 VL/模型，不上传帧，不转发视频；只读 #89/PR A 已有临时链接。
- 请求规模保持有界：搜索一次 `videoEvidenceGet`（≤10 item），详情一次（当前 item），每 item 最多 3 行；PR A 每行最多 8 highlights。时间更新只更新当前播放位置与框，不产生网络请求。
- 若 `bindtimeupdate` 频繁触发，框 overlay 可缓存当前 highlight key，只在进入/离开区间时更新，避免无意义 setData。

## 10. 测试矩阵

### 10.1 纯函数：`video-evidence` / 选择器

| ID | 输入 | 期望 |
| --- | --- | --- |
| C-P1 | 一行合法 user_confirmed highlight + box | 映射出时间标签、百分比框；target start 正确；end 为排他边界 |
| C-P2 | 非 user_confirmed、缺 source、confidence-only、非法 start/end、非法 box | 非法 highlight 被丢弃；其余合法项仍可用；不崩溃 |
| C-P3 | 最新行无 highlights，旧行有 highlights | 选旧行确认点；不选择最新普通行作为首选 |
| C-P4 | 同一行多个 highlights，有的有框 | 默认选有框且 start 最早者；所有合法点按 start 出现 |
| C-P5 | 有确认高亮但最新行 `video_url:""`，旧行可播 | 选旧可播行并产生“最新暂不可播”的 fallback notice |
| C-P6 | 全部行 `video_url:""` | target=unavailable；无 start/seek；不伪造时间窗 |
| C-P7 | 显式 hint 精确匹配 | 选 hint 的 evidence/highlight |
| C-P8 | 显式 hint evidence 不存在、时间窗不存在、start/end 不成对或跨 item | 回退默认目标；fallback reason 正确；不使用 hint 时间直接 seek |
| C-P9 | 同一 file_id 两个 item 各有不同 highlights | 每个 item 只得到自己的 row/highlight/时间点；无跨 item 泄漏 |
| C-P10 | 旧行缺 highlights/highlight_version | 投影为 `[]`/0；仍可普通回放 |
| C-P11 | 超过 10 个 item / 超过 3 行 | 搜索 hint 只处理 API 返回的 top 范围且不串 item；不请求额外网络 |
| C-P12 | 深链 hint 含超长/NaN/负值/倒置时间 | 解析拒绝或安全忽略，不阻断详情主体 |

### 10.2 服务端读合同（在 PR A 合入后）

| ID | 场景 | 期望 |
| --- | --- | --- |
| C-S1 | `videoEvidenceGet` 返回 PR A 行 | 每行带 highlights 和 highlight_version；排序/时间窗符合合同 |
| C-S2 | 旧行无 highlights | 返回 `highlights:[]`、`highlight_version:0`，不被过滤 |
| C-S3 | 同 file_id、两个 item，各一行不同 highlights | 两行独立返回；家庭隔离仍生效；无跨 item 合并 |
| C-S4 | 单文件换链失败 | 该行 `video_url:""` 但 highlights/其他行仍返回 |
| C-S5 | 非法 item_ids / 跨家庭 item | 按现有合同 fail/空结果；不能借播放 hint 绕过归属 |
| C-S6 | 未确认候选误入读模型 | 读端不返回 candidate/confidence；客户端也不消费 |

### 10.3 首页搜索页（`pages/index`）

| ID | 场景 | 期望 |
| --- | --- | --- |
| C-I1 | 查询结果含视频 + 确认高亮 | 一次 `videoEvidenceGet`；行 badge=`▶ 00:12`；无 toast/modal |
| C-I2 | 有视频无 highlights | badge=`▶ 视频` |
| C-I3 | 有行但全部换链失败 | badge=`▶ 暂不可播`，不是普通可播样式 |
| C-I4 | 视频查询失败/无证据 | 无 badge；搜索文字结果不变；零 toast |
| C-I5 | 点击 badge | 导航带 `video_entry=search_badge` 和只读 hint；不带 URL/box/confidence |
| C-I6 | 点击整行 | 普通详情导航；不把 badge hint 强行塞进普通入口 |
| C-I7 | 同 file_id 两个 item | 两个 badge 各自来自自己的 highlights |
| C-I8 | 查询在途切换家庭/收起/换关键词 | 旧视频响应不回写；无旧家庭 badge |
| C-I9 | 结果超过 10 件 | 只查前 10，与现有 API 上限一致；其余保持纯文字 |

### 10.4 详情页（`pages/item`）

| ID | 场景 | 期望 |
| --- | --- | --- |
| C-D1 | 普通进入有视频 | `videoOpen=false`；`<video>` 未挂载；不调用 `play()` |
| C-D2 | 普通进入有确认高亮 | 折叠条显示默认范围；仅用户点折叠后才展开 |
| C-D3 | search badge 进入 | 拉取后滚动/强调视频卡，但仍折叠；不 seek、不 play；只滚动一次 |
| C-D4 | 点击折叠条 | `videoOpen=true`；`initial-time` 为目标 start‑0.3s；无 `play()` 调用 |
| C-D5 | 无高亮点击展开 | 从 0s 暂停；无点条/无框；文案如实“尚未确认命中时刻” |
| C-D6 | 点时间点 chip | 只 `seek`；暂停时不开始播放；时间更新进入区间后显示框、离开后移除 |
| C-D7 | 切换多证据 | 重绑该行 URL/highlights，暂停并定位；不沿用旧时间/框；不 play |
| C-D8 | 多证据中某行换链失败 | 该行可重试/标不可播；其他行仍可选；不自动静默播放另一行 |
| C-D9 | 首次进入 `video_url:""` | 展示重试卡；不渲染空 video、不 seek、不 play |
| C-D10 | 运行期播放器 `binderror` | 失败提示可重试；保留目标；重试成功后定位且保持暂停 |
| C-D11 | hint 失效或跨 item | 回退当前 item 默认目标；提示非阻断；不使用 query 时间 seek |
| C-D12 | 同 file_id 多 item | 当前详情只显示当前 item 的时间点/框；无其他 item 数据上屏 |
| C-D13 | 家庭切换/旧 scope 响应 | 旧家庭视频不上屏；新 family scope 下重新拉取 |
| C-D14 | PR A 整体替换 highlights 后从旧 hint 进入 | 精确匹配失败 → 回退；不把已删除的时间窗当成事实 |
| C-D15 | WXML/代码静态检查 | 无 `autoplay=true`；播放相关路径无程序化 `play()`；折叠态不挂载 video |

### 10.5 手工/真机验收（实施 PR 必做）

- iOS + Android 各一台；竖屏和横屏视频各一段。
- 进入详情默认折叠且不自动播放；点击折叠条后停在目标前 0.3s，原生播放按钮由用户点击才开始播放。
- 时间点条点击只 seek：暂停时保持暂停，播放时继续播放；框在 `[start,end)` 内对齐、离开即消失。
- 多条证据、无高亮、最新链接失败、播放中链接失败/重试、旧 hint 失效各走一次。
- PR B 同一原视频绑定两个 item 后：分别搜索两个 item，只看到各自时间点；A 的片段不因 B 的视频/文件而串台。
- 弱网/临时链接过期后重进或重试，不显示假成功、不自动播放；页面无崩溃。
- 搜索 badge 点击后只滚动/强调折叠卡，不展开、不播放。
- 未登录/家庭切换/退出家庭后看不到上一家庭视频。

### 10.6 实施 PR 的自动验证命令

```bash
npm test
npm run typecheck
npm run build:mp
```

其中 `npm test` 的 pretest 会先编译 miniprogram。页面测试继续使用现有“`Page` 桩 + `setData` 真语义 + `wx.cloud.callFunction` 路由桩”模式，至少新增：

- `tests/video-playback.test.js`（纯选择/投影/深链参数）；
- `tests/index-video-playback.test.js`（搜索 badge、hint 导航、失败静默）；
- `tests/item-video-playback.test.js`（折叠、无自动播放、seek/框、多证据、换链失败、多 item 隔离）；
- 服务端读合同在 `tests/video-evidence.test.js` 增补。

## 11. 验收标准

PR C 实施 PR 必须全部满足：

1. **只认用户确认**：搜索时间角标、默认目标、时间点、框都只来自 `highlight.source === "user_confirmed"`；代码中没有任何 confidence/候选排序或候选展示。
2. **绝不自动播放**：所有正常/深链/刷新/切换/重试路径首屏折叠；无 `autoplay`、无程序化 `play()`；实际播放只能由原生播放器上的用户手势开始。
3. **定位正确且有限**：有效 hint 精确命中后展开位置为 `max(0,start_ms-300ms)`；无高亮从 0s；非法/过期 hint 安全回退；所有 seek 时间都重新以服务端当前行为准。
4. **默认最佳策略可解释**：按“显式 hint > 最新含确认高亮的可播放行 > 最新可播放行 > 不可播放重试”工作；同行内“有框优先、start/end 升序”；结果不依赖 AI confidence。
5. **多证据与多 item 不串台**：按 `item_id + evidence_id` 隔离；同 file_id 不同 item 的 highlights 不合并；换链失败只影响对应行。
6. **降级如实**：无高亮、全部换链失败、运行期换链失败、旧云函数缺字段、整体读失败都有明确、非误导的 UI/静默策略；不把失败说成无视频/没有物品。
7. **兼容 PR A/B**：PR A 的 highlights/highlight_version 读取契约冻结且测试通过；PR B flat 多 item 行可被正确按 item 分组；PR C 不写 highlights、不写产品数据。
8. **回归与真机**：`npm test`、`npm run typecheck`、`npm run build:mp` 全绿；§10.5 真机清单完成并留证据；不部署云端、不创建产品 PR 前的设计阶段只提交本设计文档。

## 12. 后续实施改动面（仅供拆分，不在本设计 PR 实施）

- `miniprogram/types.ts`：补 VideoHighlight/高亮读取字段；保持旧行字段可选。
- `miniprogram/utils/api.ts`：扩展 `validVideoEvidenceRow`，严格校验 highlights，兼容缺省。
- `miniprogram/utils/video-evidence.ts`：高亮规范化、视图投影、最佳 target/搜索 hint 纯函数。
- `miniprogram/pages/index/index.ts|wxml|wxss`：`DisplayItem.videoHint`、独立 badge catchtap、hint 导航、异步补值守卫。
- `miniprogram/pages/item/item.ts|wxml|wxss`：hint 解析/校验、折叠态、播放器定位事件、时间点条、多证据切换、换链重试、无自动播放。
- `tests/*`：按 §10 增补；服务端读合同归 PR A 合入后的测试扩展。
- PR B 的共享删除引用计数与可选 frame_ms 属 PR B 文件/合同，PR C 不越界修改。

## 13. 待 Lead 确认的问题

1. **默认点选择**：PR A 没有 `highlight_id`/`primary`。是否接受 PR C 的“有框优先 + start/end 升序”作为同一 evidence 内默认点，并让用户通过时间点条切换？若需要“用户指定最佳片段”，建议 PR A 以后向兼容字段增加，但不阻塞 PR C。
2. **搜索 badge 首屏**：本设计选择“badge 点击也只滚动到折叠视频卡，仍不展开、不 seek、不播放”。是否同意这一最严格口径，还是希望 badge 点击展开到暂停态（仍不自动播放）？
3. **默认搜索范围**：沿用当前 `videoEvidenceGet` 每 item 最多 3 条证据；第 4 条及更早视频不参与搜索最佳定位。是否接受，还是需 PR A/B 扩读接口？
4. **换链失败回退**：显式 badge 指向的行 URL 失败、但同 item 有更早可播行时，本设计回退到更早行并提示。是否同意“回退可播行”而不是“停留在原行只给重试”？
5. **box 可空与 frame_ms**：PR A 当前计划 box 必填；PR C 容错按“无框仅时间窗”处理。PR B 可能新增可选 frame_ms，PR C 计划忽略。请确认兼容边界。
6. **PR B 共享文件删除前置**：请确认共享 `file_id` 的引用计数/最后引用才删云文件是 PR B 的实施门槛；否则 PR C 只能按行级换链失败降级，不能保证 A 删除不影响 B。
