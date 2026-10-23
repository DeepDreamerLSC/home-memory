# R0 实现契约:视频逐帧线索收拢——候选组确认与安全拆分(issue #101)

状态:**实现契约冻结**。本文是 issue #101 R0(纯前端候选组收拢)的唯一实现契约;实现 PR 的组件接口、状态推导、文案、测试矩阵与验收口径以此为准。R1(Qwen3-VL 多帧判定建议)与 #100(V-JEPA,已 STOP)不在本期,本文任何条款不得被解读为对它们的授权。

范围铁律(issue #101 边界,重申):**纯前端 PR**——不改 `cloudfunctions/` 任何文件、不改后端 schema/权限/引用回收;首页、搜索、D2 历史列表不改;不新增 npm 依赖;开发 agent 只开 PR 不合并不部署。

---

## 0. 证据基线(本文引用的代码事实,均在 main HEAD `944bef3`)

- 逐帧观察与扫描:`miniprogram/utils/video-scene.ts:93-95`(`planSceneFrames` 至多 8 帧;`tests/video-scene-client.test.js:44-55` 钉住帧时间唯一)、`video-scene.ts:157-176`(每帧每候选一条 `SceneObservation`,带 `obsId/frameIndex/timeMs/box/name/confidence/qtyNote`)。
- 既有原语:`video-scene.ts:212-234`(`groupSceneObservations` 按 `nameKeyOf` 归组,`video-scene.ts:218-220` 仅 trim+小写+去空白)、`video-scene.ts:236-249`(`newSceneDraft`,uuid 独立 draftKey/operationId)、`video-scene.ts:256-288`(`createDraftsFromObservations`,默认一条一草稿)、`video-scene.ts:291-313`(`mergeSceneDrafts`,保留首个 draftKey/operationId、observationIds 去重)、`video-scene.ts:319-342`(`splitSceneDraft`)、`video-scene.ts:367-380`(`observationHighlight`)、`video-scene.ts:382-410`(`buildDraftHighlights`,全 observationIds 逐条成高亮、JSON 键去重、升序)、`video-scene.ts:416-458`(`buildSceneCommitItems`:≤12 件、单件 1..8 条高亮硬门)。
- 常量:`video-scene.ts:28-30`——`SCENE_ITEMS_MAX=12`、`SCENE_HIGHLIGHTS_MAX=8`、`SCENE_HIGHLIGHT_WINDOW_MS=1500`。
- 两消费页:`miniprogram/pages/video-scan/video-scan.ts:313-330` 与 `miniprogram/pages/location-video-scan/location-video-scan.ts:418-435` 各自 `renderObservations` 全量展开逐帧列表;`video-scan.wxml:38-58` / `location-video-scan.wxml:71-90` 各自渲染组+全部行;同名开关 `video-scan.wxml:59-62` / `location-video-scan.wxml:92-94`;生成按钮 `video-scan.wxml:63` / `location-video-scan.wxml:95`。
- 归一化口径:`miniprogram/utils/item-match.ts:49-63`(`normalizeForMatch`:trim → NFKC → 小写 → 删全部空白 → 删 `item-match.ts:21-43` 的标点集),`tests/item-match.test.js` 已冻结。
- 会话持久化:`video-scan.ts:96-111`(`StoredSceneSession` version 1)、`video-scan.ts:180-200`(`makeSession`,不含 `selectedObsIds`/`mergeSameName`——选择态本就不持久化)、`location-video-scan.ts:112-127`(`StoredScanSession` version 1)。
- 提交链路(不动):`video-scan.ts:789-805` / `location-video-scan.ts:953-975` → `buildSceneCommitItems` / `location-scan.ts:60-142`(`buildLocationScanCommitItems`,`candidateCount=observations.length` 在 `location-scan.ts:140`)→ `videoSceneCommit`。载荷类型 `miniprogram/types.ts:1143-1150`、`types.ts:1251`。
- 测试基线:本文撰写时在 worktree `feat/issue101-r0-observation-groups`(基于 `944bef3`)实测 `npm --prefix /tmp/hm-r0 test` → **tests 1044 / pass 1044 / fail 0**,且 `pretest` 的 `build:mp` 对已提交 `.js` 零 diff。既有页面接线断言:`tests/video-scene-page.test.js:23-43`(方法注册表)、`tests/location-scan-page.test.js:146-161`(D1P-REG,含 `video-scan.wxml` 不得出现 `location-video-scan`)。
- 既有缺陷(本次发现,证据见 §5.4):`location-video-scan.wxml:135` 用 `data-index` 绑 `onDraftMergeSelectTap`,而处理器 `location-video-scan.ts:675-677` 读 `dataset.key` → 恒为空串提前返回,**D1 页「选去合并」当前是死按钮**。

---

## 1. (a) 组模型

### 1.1 组构建规则(升级 `groupSceneObservations`,单点改键)

- **分组键 = `normalizeForMatch(name)`**(从 `item-match.ts` 导入,与五级匹配建议同一口径;`video-scene.ts` 的 `nameKeyOf` 改为委托它,`groupSceneObservations` 与 `createDraftsFromObservations(mergeSameName:true)` 的 `video-scene.ts:263-279` 分支随之同键——「同名」只有一种定义)。效果:全角/半角(`Ｍａｇ`≡`Mag`)、空白与常见标点差异(`充电器、`≡`充电器`)归同组。这是字符级规范化,**不是同义词归并**;模糊匹配(`isFuzzyMatch`)不进分组。
- 键为空(名称仅由标点/空白构成,规范化后为空)→ 回退 `obs.obsId`,各成单条组(沿用 `video-scene.ts:225` 回退语义)。
- **组 label = 组内首条观察的原始 `name`**(沿用 `video-scene.ts:228`);组内每行仍展示各自原始 `name`(现状 `video-scan.wxml:54`),规范化永不改写观察数据。
- **顺序确定性**:组序 = 观察数组中的首现序(Map 插入序,现状行为);组内观察 = 扫描序(帧序、帧内候选序),不重排。同一 `observations` 输入产出逐字节确定的分组。
- **组 ≠ 物品**:组仅是线索容器;组内观察永不因分组而被修改、删除或预归属。名称稍变归同组时,原观察逐条保留(§8 SG-GROUP-NFKC 钉住)。
- 推导不变量(由 8 帧上限得出,用于测试与告警):**单组观察数 > 8 ⟹ 组内必存在同帧同名重复**(§3.1 的风险信号)。

### 1.2 组确认态(最少态集:三态 + 一个正交风险标志)

组态**不存储,由 `observations + drafts` 推导**(§6)。推导规则写死:

- 归属(claim):观察 O 归属草稿 D ⟺ `D.observationIds` 含 `O.obsId`。归属与草稿 `checked`、`target`、名称无关。
- **待确认(pending)**:组内存在未归属观察。卡片主提示「待确认有几件」;若组内已有部分归属,加注「已确认 1 件/N 件,剩 X 条线索」。
- **就 1 件(single)**:组内全部观察归属**同一个**草稿。卡片显示「已按 1 件确认 → {草稿名}」。
- **多件(multi)**:组内全部观察归属 ≥2 个草稿。卡片显示「已按 N 件确认」。

部分归属(1 ≤ 归属数 < 全组且草稿数=1)归入「待确认」+ 剩余数注记,不设第四态——组内剩余观察仍需用户裁决,组卡留在待确认流里,这是最少且无歧义的态集。**sameFrameRisk(§3)是正交布尔标志**,可与任一态叠加显示。

---

## 2. (b) 三个确认动作的精确语义

前置:三动作只出现在组卡上,两页同一组件同一语义;`phase !== "review"` 或页面 `busy` 时禁用。

### 2.1 「就 1 件」(生成聚合草稿的唯一入口)

- **确认集** = 组内**未归属**观察中,用户在展开态勾选的子集;展开态勾选为空或折叠态直接点击 → **整组未归属观察**。已归属观察行显示「已用于:{草稿名}」且不可勾选(§2.4 归属唯一不变式)。确认集为空(全组已归属)→ 按钮禁用。
- **生成**:`newSceneDraft({ observationIds: 确认集(扫描序,无重复), name: 组 label, locationText: 页面位置(video-scan 用 `batchLocation`;location-video-scan 用进入位置路径文本并按 `location-video-scan.ts:656` 同款补 `nodeId`), checked: true })`。draftKey/operationId 由 `newSceneDraft` 的 uuid 独立生成(`video-scene.ts:238,243`),与其他草稿、其他组绝不共享。
- **高亮**:确认时不计算、不截断任何高亮;高亮仍由保存时 `buildDraftHighlights` 从全部 `observationIds` 逐条构建(`video-scene.ts:382-410`)。单件 ≤8 条的既有硬门不动(`video-scene.ts:431`):确认集 >8 条时允许生成草稿,但组卡与草稿卡显示警示「线索 N 条,单件最多 8 条高亮,保存前需减到 ≤8」,保存被既有门拦截——**绝不静默截断**(截断=丢证据,禁止)。
- **同帧风险二次确认**:组 `sameFrameRisk=true` 时,首次点击弹 `wx.showModal`:标题「可能有多件」,内容冻结「这一组在第 {代表帧时间} 的同一帧里出现了两条同名线索,可能是两件同名物品。确定只有 1 件吗?」,确认 → 生成;取消 → 无任何变更。风险为假时无弹窗。
- 确认后组卡自动折叠,推导态切到「就 1 件」;**撤销路径 = 既有草稿「移除」**(`onDraftRemoveTap`)→ 观察回到未归属,组回到待确认;事后改判多件 = 既有「拆成多件」(`onDraftSplitTap`)。

### 2.2 「有多件或需拆开」(进入逐条分配,不产生草稿)

- 语义:该组切换到**逐条模式**(展开 + 行级勾选 + 组内「勾选线索各成一件」按钮)。**不生成任何草稿、不改任何归属**——它是交互态,不是数据态,因此不持久化(§6)。
- 分配机制 = 既有原语的组合,零新合并语义:勾选子集 → `createDraftsFromObservations(..., { mergeSameName:false })` 一条一草稿;要「这几条其实是一件」就用既有「选择合并」+「合并选中的新建物品草稿」(`mergeSceneDrafts`);漏了的用「＋ 补一件」;归属已有物品用既有「找已有物品/关联已有物品」入口。所有入口保留、语义不变。
- 同帧风险组点「有多件」是推荐路径(风险标志文案即引导),但不强制。

### 2.3 「暂不确定」(保持折叠)

- 语义:折叠该组卡,无任何数据变更。它是三选一里的显式「不裁决」,让用户先把别的组确认完;组保留在待确认列表与统计里。无确认弹窗、无状态写入。

### 2.4 归属唯一不变式(R0 新增的硬规则,服务于「证据不丢、状态不飘」)

同一会话的草稿集合中,**一个 obsId 至多归属一个草稿**:

- 组卡勾选集天然排除已归属观察(§2.1)。
- 既有全局生成路径 `onGenerateDraftsTap`(收敛为组内作用域,§7)加同一道门:勾选中含已归属观察 → toast 阻塞「第 {序号} 条线索已用于「{草稿名}」,先移除该草稿或拆分后再操作」,不生成。
- `mergeSceneDrafts`/`splitSceneDraft` 是对已归属集合的并/划分,天然保持不变式(`video-scene.ts:299` 已做组内去重)。
- 该不变式同时满足 issue 验收「生成、拆分和保存的 observationIds 集合无丢失或重复」。

---

## 3. (c) 同帧同名风险与代表帧(确定性规则,写死)

### 3.1 同帧同名检测

- 判定:组内存在 `frameIndex` 值 f 使 `count(obs where obs.frameIndex === f) ≥ 2` → `sameFrameRisk = true`。依据:一帧识别对每个候选框产一条观察(`video-scene.ts:157-176`),同帧同名两条 = 模型在同一帧画了两个框——issue #101 点名的唯一确定性多件信号。
- 展示:风险组默认标注「**可能有多件,需拆分核对**」(组卡固定文案);「就 1 件」须过 §2.1 二次确认;**绝不自动合并**(组态推导、草稿生成均不含任何合并动作)。
- 跨帧同名:不预判件数——不默认「多件」也不暗示「一件」,交给三动作。
- **禁用证据清单(冻结)**:任何 R0 代码路径不得以 box IoU/重叠度、模型自报 `confidence`、字符串相等(规范化相等仅限分组容器,不是实体身份)、或模型自报 `qtyNote`(数量提示,类同 confidence 的自报信号)作为**件数或实体身份**的判据。`confidence` 只透传既有展示文案(`sceneConfidenceText`,`video-scene.ts:461-465`);`qtyNote` 维持现状:保留在观察上、不展示、不参与判定。

### 3.2 代表帧(仅默认展示,绝不丢弃其他来源高亮)

- 规则写死:**代表观察 = 组内 `timeMs` 最大者;并列(同帧多条)取 `box` 非 null 者;仍并列取 `obsId` 字典序最小者**。三键均可从 `SceneObservation` 推导,输出确定。
- 用途仅限:折叠卡缩略图 + 时间(`videoTimeText`/`boxPercentStyle` 组装,`video-target.ts:837-842,848-856`)、点缩略图 `wx.previewImage`(current=代表帧,urls=组内全部 framePath——今天是展开后组内预览的同款语义,`video-scan.ts:514-524`)。
- 高亮与代表帧解耦:保存时高亮永远来自全部 `observationIds`(§2.1);展开态可浏览全部观察原图、框、时间点(规则 1),代表帧不删除、不遮蔽任何来源高亮。

---

## 4. (d) 统计口径(三数分立,冻结文案)

| 数 | 定义 | 展示位置(两页同文案) |
| --- | --- | --- |
| 线索数 N | `observations.length` | review 卡顶部行首 |
| 待确认组数 M | 组内存在未归属观察的组数 | 顶部行 `AI 线索 {N} 条 → {M} 组待确认` |
| 用户确认物品数 | 草稿总数 `drafts.length`(一件草稿=用户确认的一件;`checked` 只是本次是否提交) | 草稿区标题「待确认物品({N_d})」(现状保留)+ 顶部行尾注 `,已确认 {N_d} 件` |

- 顶部行完整形态:`AI 线索 {N} 条 → {M} 组待确认,已确认 {N_d} 件`(全部组已确认即 M=0 时显示 `AI 线索 {N} 条,已全部确认 {N_d} 件`),下挂固定注「**组数不是物品件数;同名线索不会被自动合并**」(合并两页现有 hint:`video-scan.wxml` hero/组标题区、`location-video-scan.wxml:69`)。
- 已完全确认的组不计入 M。**不另设「已确认组数 K」第四个数字**(与「已确认 {N_d} 件」并列展示会引入口径混淆);已确认组在自身卡片上带「已按 1 件/N 件确认」徽标即可。
- 保存按钮:video-scan 现文案「确认并保存 {{draftViews.length}} 件」(`video-scan.wxml:97`)计入未勾选草稿,与实际提交集(`buildSceneCommitItems` 只取 `checked`)不符——改为「确认并保存 {X} 件」,X=checked 草稿数;location-video-scan 维持「保存本次清点」(无计数,无不误导)。
- 扫描完成 `resultText` 维持「已发现 {N} 条线索;同名线索只是提示,不会被自动合并」(`video-scan.ts:489`、`location-video-scan.ts:602` 同款)——已经是线索口径,不改。
- **任何新增/改动文案不得出现「找到 N 件」类混称**(§8 SGP-COPY 静态断言两页 wxml)。

---

## 5. (e) 共享实现方案

### 5.1 `miniprogram/utils/scene-groups.ts`(新,纯函数,零 wx.* 依赖)

与 `video-scene.ts`/`item-match.ts` 同风格(node 可直接 require 测试)。职责:

1. `buildSceneGroupViews(observations, drafts)`:内部调升级后的 `groupSceneObservations`,产出组视图模型 `{ nameKey, label, countText, state, stateText, remainingCount, sameFrameRisk, repFrame:{framePath,boxStyle,timeText}, observations: ObsView[](含 claimed/claimText/checked) }`。
2. `groupStats(observations, drafts)`:§4 的 N/M/N_d/X 与顶部行文案串。
3. `confirmSingleSet(group, checkedIds | null)`:§2.1 确认集计算(含归属过滤)。
4. `claimGuard(observations, drafts, selectedIds)`:§2.4 阻塞判定,返回首个冲突(观察+草稿名)。
5. `representativeObservation(group)`:§3.2 规则。

依赖方向无环:`scene-groups.ts` → `video-scene.ts`(类型+分组)+ `item-match.ts`(归一化);`video-scene.ts` → `item-match.ts`(仅 `normalizeForMatch`)。**不新增 npm 依赖**。

### 5.2 `miniprogram/components/scene-group-card/`(新组件,两页唯一组卡呈现)

- 挂载:两页 json 增 `usingComponents`(先例 `miniprogram/pages/locations/locations.json:4-6`);`video-scan.json`/`location-video-scan.json` 现无 usingComponents。
- 职责:渲染**一张**组卡(折叠:label/线索数/代表帧与时间/状态与风险文案/三动作;展开:全部观察行=原图缩略+框+时间+置信文案+勾选/归属标签+逐条生成按钮)。组件内持有:展开态(默认折叠)、组内勾选态(均不持久化,§6)。
- 接口冻结:properties `{ group: Object, busy: Boolean }`;events `expand` / `obsToggle {obsId}` / `obsPreview {obsId}` / `confirmSingle {obsIds}` / `confirmMulti` / `defer` / `generatePerObs {obsIds}`。二次确认弹窗放**页面**(wx.showModal 在页面层,组件只发事件)——组件保持可离线桩测(`tests/voice-bar.test.js:36` 的 Component 桩先例)。
- 页面侧接线:两页 `renderObservations` 改为 `buildSceneGroupViews` + setData(方法名保留 `renderObservations`/`onObservationToggle`/`onGenerateDraftsTap` 等,`tests/video-scene-page.test.js:37` 的注册表断言不破);草稿变更后重算组视图(归属/统计随草稿实时推导)。

### 5.3 为什么不整页组件化

两页在入口上下文(自由 batchLocation vs 固定位置+nodeId+五级匹配+mode=last)、同意文案、pendingUpload 字段上不同,且 D1 页受 `D1-IMPLEMENTATION.md` 冻结约束;把整页合成一个组件会触碰已冻结契约与两份状态机。**组卡 + 纯函数 helper 是最小共享面**:规则 4 要求的「同一呈现/状态逻辑」全部落在 `scene-groups.ts`(状态推导、风险、代表帧、统计、文案)+ `scene-group-card`(呈现与交互),两页零复制。D1 页头注「不复用/不改动 pages/video-scan」(`location-video-scan.ts:12`)自 R0 起在**线索卡区域**由本契约修订:共享经由 `components/`+`utils/`,两页互不引用,`tests/location-scan-page.test.js:158-160` 的「video-scan.wxml 不含 location-video-scan」断言持续成立。

### 5.4 顺带修复(1 行,纳入 R0,理由:两入口一致是验收项)

`location-video-scan.wxml:135` 的 `data-index` 改 `data-key="{{ item.draftKey }}"`,与 `location-video-scan.ts:675-677` 读 `dataset.key` 对齐(video-scan 侧 `video-scan.wxml:88` 本就正确)。不修则 D1 页合并流死按钮,「两个视频入口行为一致」验收无法通过。加一条页面断言(§8 SGP-MERGE-FIX)。

---

## 6. (f) 持久化与会话恢复(零新增 storage 字段)

- **组态、风险、代表帧、统计全部由 `observations + drafts` 推导**(§1.2/§3),`StoredSceneSession`(`video-scan.ts:96-111`)与 `StoredScanSession`(`location-video-scan.ts:112-127`)**零字段增改,version 维持 1**。推导只读 `observationIds`,兼容一切存量会话——包括 R0 之前保存的旧草稿(旧草稿的归属同样参与组态推导)。
- 恢复会话(`onLoad`/`restoreSession`)后:组卡默认折叠(规则 1);组态按推导呈现;**组内进行中的勾选、展开态丢失**——与现状 `selectedObsIds` 不入 `makeSession`(`video-scan.ts:180-200` 不含该字段)的既有纪律一致,不新增持久化。
- 撤销/拆分/恢复后原始观察可找回的保证链:观察全量在 session;归属是草稿对 obsId 的引用;移除草稿=解除引用;`splitSceneDraft` 划分引用;无一路径删除观察。
- 不新增任何 storage key;不改 `locationScanSessionKey`/scope/TTL 纪律。

---

## 7. (g) 与既有「同名线索生成一件」开关及逐条勾选的关系

- **旧开关移除**:两页 wxml 的 `switch`(`video-scan.wxml:59-62`、`location-video-scan.wxml:92-94`)与 `onMergeSameNameChange` 处理器删除;`createDraftsFromObservations` 的 `mergeSameName` **纯函数参数保留**(冻结 API,`tests/video-scene-client.test.js:104-117` 继续钉住「默认分开、显式才归组」)。理由:组卡「就 1 件」严格覆盖开关语义且更安全(组内作用域、归属过滤、风险二次确认);两套并存 = 两份规则,违背规则 4。该移除是用户可见变更,已在本文冻结,Owner 可在 PR review 一票否决回退(回退=恢复 3 行 wxml+1 个 handler)。
- **逐条勾选收敛进组卡**:全局跨组勾选列表与全局「把勾选线索生成待确认物品」按钮(`video-scan.wxml:63`、`location-video-scan.wxml:95`)移除;勾选只存在于组卡展开/逐条模式内,生成按钮作用于该组(方法名沿用 `onGenerateDraftsTap`,载荷改为组内 obsIds)。这是「首屏不滚动几十条」的来源:默认折叠后首屏条目 = 组数(≤ 名称种类数),不再是观察总数。
- **保留入口清单(零语义变化)**:手动补件(`onAddManualDraftTap`,两页)、草稿合并(`onMergeDraftsTap`+选择合并)、草稿拆分(`onDraftSplitTap`)、已有物品关联(video-scan 的 `onDraftTargetTap` 三选、location 页的五级匹配面板与三选移动)、草稿移除、重拍、partial 重试/放弃。issue 规则 2 点名保留的全部入口。
- 首页、搜索、D2 历史列表零改动(§8 SGP-NONCHANGE 复跑既有断言)。

---

## 8. (h) 反例测试矩阵(逐条;先于实现落地)

**A. `tests/scene-groups.test.js`(新,纯函数)**

| 用例 | 断言要点 |
| --- | --- |
| SG-GROUP-NFKC | `Ｍａｇ`/`Mag`、`充电器、`/`充电器` 归同组;组内每条观察 name/obsId/frameIndex/box 原样保留,计数=输入数(名称稍变不丢观察) |
| SG-GROUP-PUNCT-EMPTY | 仅标点差异归同组;规范化后为空的名称各成单条组(key=obsId) |
| SG-GROUP-ORDER | 组序=首现序、组内=扫描序;同输入两次调用输出逐字节相等 |
| SG-STATE-PENDING | 无草稿 → 全组待确认;文案「待确认有几件」 |
| SG-STATE-SINGLE | 全部 obsId 落同一草稿(含已改名/切 existing)→ 就 1 件,显示草稿名 |
| SG-STATE-MULTI | obsId 分属 ≥2 草稿 → 多件,N=草稿数 |
| SG-STATE-PARTIAL-UNDO | 部分归属 → 待确认+剩余数正确;移除草稿 → 回 pending(撤销找回);拆分草稿 → 转 multi 且 obsId 集合与拆前相等 |
| SG-NO-BURST | 同名跨 6 帧、零用户动作 → drafts 为空、组 pending(不默认生 6 草稿) |
| SG-RISK-SAME-FRAME | 组内两条同 frameIndex → risk=true+固定文案;跨帧同名 → false;9 条组必 risk(8 帧上限推导);risk 不改变组态、不生成草稿 |
| SG-RISK-EVIDENCE-BAN | helper 对 box 重叠/confidence/qtyNote 的输入变化不改变组态与 risk(仅同 frameIndex 触发);源码无 IoU 计算 |
| SG-REP-FRAME | 代表帧=timeMs 最大 → 并列取有 box → 仍并列 obsId 字典序最小;代表帧不进 `buildDraftHighlights`,后者仍含全部 observationIds 高亮 |
| SG-CLAIM-UNIQUE | confirmSingleSet 排除已归属;claimGuard 命中冲突返回观察+草稿名;merge/split 后一 obsId 仍至多一草稿 |
| SG-SINGLE-DRAFT-SHAPE | 就 1 件草稿:observationIds=确认集(扫描序无重复)、draftKey/operationId 全场唯一、name=组 label、locationText=页面位置、checked=true;保存链 `buildSceneCommitItems` 通过且 highlights 逐条对应 |
| SG-HIGHLIGHT-CAP | 确认集 9 条(同帧重复构造)→ 草稿可生成但 `buildSceneCommitItems` 以 8 条门拒绝(沿用 `video-scene.ts:431`);组卡警示文案含「8」;无静默截断 |
| SG-STATS | N/M/N_d/X 定义逐项断言;顶部行文案串与 §4 冻结串逐字相等;M 不含已确认组 |

**B. `tests/scene-group-card.test.js`(新,Component 桩,`tests/voice-bar.test.js:36` 先例)**

| 用例 | 断言要点 |
| --- | --- |
| SGC-DEFAULT-COLLAPSED | 初始 data 折叠;折叠态渲染要素=label/线索数/代表帧/状态文案/三动作;不含全部观察行 |
| SGC-EXPAND | expand 事件后渲染全部观察行(原图/框样式/时间/勾选);obsToggle/obsPreview 事件载荷正确 |
| SGC-ACTIONS | confirmSingle/confirmMulti/defer/generatePerObs 事件与载荷;busy=true 时动作禁用;已归属行不可勾、显示「已用于:{草稿名}」 |
| SGC-RISK-BADGE | risk 组显示「可能有多件,需拆分核对」;risk 与任一组态可叠加 |

**C. 页面接线(`tests/video-scene-page.test.js` / `tests/location-scan-page.test.js` 增例,或新 `tests/scene-group-page.test.js`)**

| 用例 | 断言要点 |
| --- | --- |
| SGP-SHARE | 两页 wxml 均挂 scene-group-card 且无内联组列表;两页 renderObservations 均产出 scene-groups 视图;video-scan.wxml 不含 "location-video-scan"(D1P-REG 持续绿) |
| SGP-SINGLE-FLOW | 就 1 件:无风险组直生成 1 草稿;风险组先弹 modal(桩捕获),取消 → drafts 不变,确认 → 生成 |
| SGP-MULTI-FLOW | 有多件 → 无草稿生成;组内勾选 2 条 → generatePerObs → 2 独立草稿(mergeSameName:false 语义) |
| SGP-DEFER | 暂不确定 → 折叠、零数据变更 |
| SGP-CLAIM-BLOCK | 勾选已归属观察 → toast 阻塞、不生成(§2.4) |
| SGP-LEGACY-REMOVED | 两页 wxml 无 mergeSameName switch;onMergeSameNameChange 移除;`onGenerateDraftsTap`/`onObservationToggle`/`onAddManualDraftTap` 等注册表断言不破 |
| SGP-MERGE-FIX | location 页「选去合并」行带 data-key(§5.4),点选后 mergeSelectedKeys 更新 |
| SGP-SESSION-RESTORE | 造 R0 前格式的 version:1 存量会话(含旧草稿)→ 恢复后组态正确推导;session 对象字段集与旧版完全一致(无新键) |
| SGP-COPY | 两页 wxml 不含「找到」混称;保存按钮计数=checked 数(video-scan);顶部统计行文案冻结串 |
| SGP-NONCHANGE | 首页/D2 历史列表零改动(复跑 D1P-REG/首页相关既有断言) |

**D. 回归硬门**:`tests/video-scene-client.test.js`、`tests/video-scene.test.js`、`tests/video-scene-share.test.js`、`tests/item-match.test.js`、`tests/location-scan-*.test.js` 零修改通过;全量 `npm test` = 基线 1044 + 本矩阵全绿;`npm run typecheck`、改 `.ts` 后 `npm run build:mp` 产同名 `.js` 一并提交。

---

## 9. (i) 真机验收项(不可离线部分;验收至少一组同名不同件真机例)

1. **首屏减负**:两入口各录一段 ≥6 帧、含多组同名线索的真实抽屉/柜子视频 → 默认首屏不滚动几十条即可开始确认(折叠态条目=组数)。
2. **组卡交互**:折叠/展开流畅;展开可见全部观察原图、框、时间;点缩略图 previewImage 正常;代表帧缩略图与框渲染正确。
3. **同名不同件例**:同一帧两件同名物品 → 组卡默认「可能有多件,需拆分核对」,「就 1 件」弹二次确认;按多件拆开保存后为两个 item_id、两行 evidence、高亮互不串扰。
4. **就 1 件例**:跨帧同名一件 → 「就 1 件」后一个草稿、保存后一件物品、高亮含各来源帧。
5. **入口一致**:同一视频分别在 `pages/video-scan` 与 `pages/location-video-scan` 走组卡流程,行为与文案一致(位置上下文差异除外)。
6. **弱网/失败韧性**:部分帧识别失败仍可进入确认并手动补件;上传/提交失败走既有 partial 重试,重试幂等。
7. **会话恢复**:确认中途杀进程重进 → 组态/草稿/归属找回,组卡默认折叠。
8. **人效对照(issue #101 验收)**:用 #85 冻结的三抽屉固定帧与人工 Gold(先核对同类多件身份标注覆盖,不足仅补该项)做同输入前后对照,报数:首屏条目数、总交互次数、净确认耗时、正确入库件数、漏件/错误合并、来源证据可找回率。**禁止以「候选卡变少」单独声称识别效果提升**;效果不显著可回退为仅折叠(§7 开关/按钮移除项回退)。
9. 微信包编译通过(wxml 标签严格配对;`build:mp` 后整传)。

---

## 10. (j) API_CONTRACT / 后端零变化声明

- `cloudfunctions/` 全目录零文件改动;`docs/API_CONTRACT.md` 零改动;`items`、`video_evidence`、`location_scans` 的 schema、权限、引用/回收策略零变化。
- `videoSceneCommit` 载荷形状零变化(`VideoSceneCommitItem`,类型 `types.ts:1251`):R0 只改变**前端草稿的组成方式**(组卡确认替代逐条勾选),提交的 items/highlights/operation_id 幂等语义与 D1/D2 完全一致;`location-scan.ts:60-142` 的 `candidateCount` 仍= `observations.length`(线索数,不是组数——组数不进后端)。
- 无新集合、无新索引、无新环境变量、无新 npm 依赖;AI 原始候选/confidence/组态仍是页内内存+本地会话,不写云。
- R1(Qwen3-VL 多帧建议)未获批:本文不含任何额外模型调用;`callRecognize` 逐帧单图调用面不变。

---

## 11. 开放问题(留 Owner 裁决)

1. **§9.8 人效对照的执行口径**:前后对照的基线在 main 上取还是 PR 分支上取、由谁执行、以及「效果不显著」的判定阈值(触发回退为仅折叠的具体数字),需 Owner 在 R0 PR 验收时裁定;离线测试不阻塞 PR 开立。

---

## 12. 实现纪律(仓库已知坑,PR 自查清单)

- 一切命令在 worktree `/tmp/hm-r0`、分支 `feat/issue101-r0-observation-groups`;commit 前确认分支;绝不 push main、绝不 gh pr merge、绝不执行微信 devtools cli / tcb 命令。
- 改 `.ts` 必须 `npm --prefix /tmp/hm-r0 run build:mp` 产出同名 `.js` 一并提交(组件 `.ts` 同样在 `miniprogram/tsconfig.json` include 内);npm 命令一律 `--prefix /tmp/hm-r0` 形式。
- Page 的 ts 若有类字段与 data 双块,新字段加对位置(两页现有 `scanSession`/`scanEpoch` 先例);组件用 `Component<Data, Props, Methods, Custom>` 四参泛型(voice-bar 先例)。
- wxml 标签严格配对(历史两次 view 误闭 button 致包编译被拒);几何一律 JS 算 px/rpx 喂 inline 或固定 rpx 盒(现有 `obs-img-wrap` 130rpx 先例),不用 aspect-ratio/min/calc/vh。
- 测试先于实现(§8 矩阵先行);全量 `npm test`(基线 1044+新增)、`npm run typecheck`、`build:mp` 全绿才可开 PR。
