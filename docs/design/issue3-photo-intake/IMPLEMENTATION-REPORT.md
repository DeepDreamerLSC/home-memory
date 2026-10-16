# 拍照识物 · 实现报告(#3 / #65)

- 分支:`feat/issue3-photo-intake`,`origin/main..HEAD` 共 **12 个提交**(a6d9369 → ac7ba8b,`git log --oneline origin/main..HEAD` 实测);
- 差异面:`git diff --stat origin/main..HEAD` 共 54 个文件、+15671 / -38 行;
- 验证实测(2026-10-17,本报告撰写时):`npm test` **725 项全绿**(0 fail,pretest 先跑 `npm run build:mp`),`npm run typecheck` 通过(零输出退出);
- 设计合同:issue #65 正文 V0.4(六项边界冻结);工程说明:同目录 `IMPLEMENTATION.md`(V0.4.2 对齐版);交互基准:同目录 `prototype.html` 六屏。

---

## 1. 实现了什么(功能面)

一句话链路(与 IMPLEMENTATION.md §0 一致,已全部落地):

> 拍照 → 本地压缩(长边 ≤1280/JPEG q70)→ **base64 直传** `extractDraft.vlRecognize` 识别(候选+框;**确认前照片不上云**)→ 拍照确认页 `pages/photo`(三态候选+语音受限编辑+圈选补识别)→ 用户最终确认 → `wx.cloud.uploadFile` 上传**同一张压缩图**得 file_id → `itemsApi.photoCommit` 批量建档+落 `photo_evidence` 证据行 → 详情页 `itemsApi.photoEvidenceGet` 回放历史证据;首页搜索结果行按需出证据缩略。

按屏对照(原型六屏 → 生产页面):

| 原型屏 | 生产落地 |
| --- | --- |
| ① 识别确认 | `pages/photo/photo.ts` confirm 模式:照片默认折叠证据条、框三语义(墨实线=AI 预选/黄虚线=低可信/红虚线=圈选)、位置栏(批次默认+按住说位置+快捷)、「一条记录=一件可查找的物品」横幅、三态清单+36px 步进器、按住说话胶囊+小号保存 |
| ② 按住说话中 | voice-entry/voice 既有手势机(真实松手/上滑取消/最短按压 250ms),photo 页只做宿主(`photo.ts:828` 起按住说话区,`routeExtract` 旁路 `photo.ts:851`) |
| ③ 松手→逐项裁决 | diff sheet:头卡「你说」+原话回放(InnerAudioContext)、按内容锁定 `#d{n}` 提示、intent 五分支(edit/add/batch_location/needs_pick/none)、逐字段勾选应用、N=0 禁用、「念错了,当我没说」零改动 |
| ④ 手动编辑 | `photo.ts:1190` `openEditSheet`:改一下·#d{n}+来源行(置信度)、名称候选点选区(一键改类)、数量步进、位置例外、提醒日期 picker;终态 done 行只读门(ac7ba8b:onRowTap/openEditSheet/onEditConfirmTap 三处拦截) |
| ⑤ 圈选补识别 | circle 模式:hintbar+红点、触点画框(`containPointToNormalized` 反算 0-1)、松手 `vlRecognize(mode:"region")`、结果卡「不是,重圈」/「加进清单(候选)」——点加入才入列 |
| ⑥ 找东西·历史证据 | `pages/item/item.ts:1991` 起证据卡:onShow 按需 `photoEvidenceGet`、折叠证据条/展开等比 contain+黄环脉冲框、「拍摄于 X 日·当时记录」角标、「位置已变更」灰标(以文字为准)、换链失败重试、「更早的照片 N 张」列表、「📸 去补拍」入口;首页搜索结果行证据缩略(dbb6b56:查询后批量 `photoEvidenceGet` ≤10,有留证行照片替代首字+「留证」角标) |

其余功能面:

- **拍照会话**:中途退出保留(TTL 24h、作用域隔离、只留最新一个),首页 `onShow` 恢复横幅「上次拍照的 N 件没记完,继续核对 ›」(`pages/index/index.ts:581`);确认前 `fileId` 恒 null、base64 绝不入会话存储;
- **降级全链**:VL 不可用 → modal「拍照识别暂不可用,可手动添加」仍进页手动添加(云端零残留);相机权限拒绝 → 「去设置」/「从相册选」兜底;压缩失败原图如实直传(云函数 10MB 门兜底);确认后上传失败整批不提交可重试;photoCommit 逐件失败行标红单行重试(operation_id 幂等);
- **done 终态门**(ac7ba8b,对应 issue #65 评论「#65 终态行编辑」):已入库行只读查看、面板开着落终态后确认零改动零假回执。

## 2. 文件与 API 清单

### 2.1 新增云函数侧

| 文件 | 内容 |
| --- | --- |
| `cloudfunctions/extractDraft/lib/vl.js`(224 行) | VL 引擎客户端:环境变量三件套 `VL_BASE`/`VL_TOKEN`/`VL_MODEL`(可选 `VL_TIMEOUT_MS` 默认 30000,`vl.js:36-38,78`)、`isVlConfigured()`(`vl.js:46`)、`callVlModel`(OpenAI 兼容 chat/completions,data URL 内嵌 base64)、`normalizeVlBox`(0-1000 整数门→0-1,任一条件不满足整框丢弃为 null,`vl.js:92-106`,`BOX_SCALE=1000` `vl.js:32`) |
| `cloudfunctions/extractDraft/lib/handler.js`(+588 行) | `vlRecognize`(`handler.js:436`)+ `draftEditParse`(`handler.js:750`)两分支与 prompt/validate;既有提取路径零改动 |
| `cloudfunctions/itemsApi/lib/handler.js`(+321 行) | `photo_evidence` 集合常量(`handler.js:2042`)、`photoCommitItem`(`handler.js:2165`)、`photoEvidenceGetItem`(`handler.js:2274`)、ACTIONS 注册(`handler.js:2343-2344`)、photoCommit 进 WRITE_ACTIONS(`handler.js:2370`) |

### 2.2 新增客户端文件

| 文件 | 职责 |
| --- | --- |
| `miniprogram/pages/photo/photo.ts/.wxml/.wxss/.json`(1692+356+1157 行) | 拍照识物确认页(屏①-⑤,confirm/circle 两模式) |
| `miniprogram/utils/photo-vl.ts`(421 行) | 客户端识别封装:压缩→实测宽高→base64→`recognizeWithVl`(`photo-vl.ts:323` 起调 extractDraft,超时 70s)→降级映射(unavailable/invalid_photo/image_info_failed) |
| `miniprogram/utils/intake-draft.ts`(425 行) | 候选三态状态机纯函数:`rowStateOf`(`:195`)、`makeAiRow`(high 才预选,`:105-119`)、`makeCircleRow`/`makeVoiceAddedRow`/`makeManualRow`、`applyDraftEdits`(只应用勾选字段,`:264`)、`deriveSaveConfirm`(例外只含已勾选件,`:390`)、`composeNote`/`parseIntakeQtyNote`(数量备注单一来源) |
| `miniprogram/utils/photo-box.ts`(124 行) | 坐标换算纯函数:`containRect`(`:75`)/`coverRect`(`:90`)/`containPointToNormalized`(`:107`) |
| `miniprogram/utils/photo-intake.ts`(394 行) | 拍照编排:`takePhoto`(`:218`)、`commitPhotoBatch`(`:350`,确认后**先** uploadFile 再 photoCommit)、`ensurePhotoAuth`(`:247`)、`photoCloudPath`(`:265`,`photo-evidence/{scope}/{yyyyMM}/{uuid}.jpg`) |
| `miniprogram/utils/photo-session.ts`(201 行) | 批会话:作用域隔离存储键、TTL 24h、`getUnfinishedPhotoSession`(`:178`) |
| `miniprogram/utils/evidence-view.ts`(140 行) | 证据回放视图映射:`mapEvidenceView`(`:96`,角标/位置已变更语义/无证据降级 null)、`pickEvidenceUrls`(`:117`) |

### 2.3 改动文件

| 文件 | 改动 |
| --- | --- |
| `cloudfunctions/extractDraft/index.js` | action 路由(vlRecognize/draftEditParse);`isVlConfigured()` 为 true 才注入 `deps.callVL`(`index.js:42`);**不注入 downloadFile**(隐私红线) |
| `cloudfunctions/extractDraft/config.json` | timeout 30 → **60** |
| `cloudfunctions/itemsApi/index.js` | deps 注入 `getTempFileUrls`(`index.js:73`,getTempFileURL 换临时链接) |
| `cloudfunctions/itemsApi/config.json` | timeout 10 → **20** |
| `miniprogram/utils/api.ts` | `callItemsApi` 加 photoCommit(进 `ITEMS_MUTATING_ACTIONS` 自动双 marker,`:331-338`)与 photoEvidenceGet(`:262-278` 分支、`:417-422` captureHouseholdId 收口)、`callDraftEditParse`(`:564`)、响应形状门。⚠️ 与 IMPLEMENTATION.md §4.2 的一处偏差见 §7 |
| `miniprogram/types.ts` | +198 行:`VlCandidate`/`VlRecognizeEvent/Response`/`DraftEditParseEvent/Response`/`PhotoEvidenceRow`/`PhotoCommitItemInput`/`PhotoCandidate` 等联合扩展 |
| `miniprogram/pages/index/index.ts/.wxml/.wxss` | 两处入口(常态胶囊 `index.wxml:35`「📷 拍照记一抽屉」、H0 次级链接 `index.wxml:84`)+ 会话恢复横幅(`index.ts:581`)+ 搜索结果行证据缩略 |
| `miniprogram/pages/item/item.ts/.wxml/.wxss` | 详情页证据回放卡(§1 屏⑥,data 字段 `item.ts:211-219`,拉取 `item.ts:1991`) |
| `miniprogram/utils/voice-entry.ts` / `voice.ts` | `VoiceEntryHost` 新增**可选** `routeExtract`(`voice-entry.ts:106`,声明则走旁路 `:260-261`,未声明走既有 extractText 现状锁);`onStop`/`onTranscript` 追加可选 `audioTempPath` |
| `miniprogram/app.json` | pages 数组加 `pages/photo/photo` |

### 2.4 测试文件(12 个新文件 + 1 个扩展,共 +4813 行)

`tests/photo-vl.test.js`(707 行,服务端)/ `tests/photo-vl-client.test.js`(300 行,含隐私红线静态守卫 `:157-160`:编译产物不得含 `uploadFile(`/`downloadFile(`)/ `tests/photo-draft-edit.test.js`(494)/ `tests/photo-commit.test.js`(709)/ `tests/intake-draft.test.js`(367)/ `tests/photo-box.test.js`(142)/ `tests/photo-intake.test.js`(320)/ `tests/photo-session.test.js`(186)/ `tests/photo-page.test.js`(1110)/ `tests/item-evidence.test.js`(334)/ `tests/index-evidence-thumb.test.js`(278)/ `tests/evidence-view.test.js`(176);`tests/voice-entry.test.js` +90 行(routeExtract 旁路两例 + 现状锁回归)。

### 2.5 API 清单(4 个新云函数动作)

| 动作 | 归属 | 服务端入口 | 客户端封装 |
| --- | --- | --- | --- |
| `vlRecognize` | extractDraft | `cloudfunctions/extractDraft/lib/handler.js:436` | `miniprogram/utils/photo-vl.ts` `recognizeWithVl`/`recognizePhotoFile`(70s 超时) |
| `draftEditParse` | extractDraft | `cloudfunctions/extractDraft/lib/handler.js:750` | `miniprogram/utils/api.ts:564` `callDraftEditParse`(30s) |
| `photoCommit` | itemsApi(WRITE_ACTIONS) | `cloudfunctions/itemsApi/lib/handler.js:2165` | `miniprogram/utils/api.ts`(ITEMS_MUTATING_ACTIONS `:338`)+ `utils/photo-intake.ts:350` `commitPhotoBatch` |
| `photoEvidenceGet` | itemsApi(只读) | `cloudfunctions/itemsApi/lib/handler.js:2274` | `miniprogram/utils/api.ts:278` 分支 |

契约细节(event/响应形状、校验门、幂等语义)以 `IMPLEMENTATION.md` §1.1-§1.4 为准,本报告不重复;服务端实现与该文档逐条对齐(本报告撰写时抽验了量纲门、三件套门、WRITE_ACTIONS 注册、唯一索引收敛等关键锚点,见 §3)。

## 3. V0.4 六项边界逐条对照(合同:issue #65「二、六项边界(冻结)」)

| # | 合同边界 | 落地位置 | 对照说明 |
| --- | --- | --- | --- |
| 1 | **候选与事实(三态)**:候选→保留→已确认;AI 只预选,禁「已确认」用语;置信度仅排序 | 状态机 `miniprogram/utils/intake-draft.ts:195` `rowStateOf`(candidate/keep/done 三态);AI 预选规则 `intake-draft.ts:116`(`checked: item.confidence === "high"`,仅 high 预选,mid/low 不勾);框标签前缀随行状态 `intake-draft.ts:205` `boxTagPrefix`(「已记住·/保留·/候选·」);计数一处来源 `intake-draft.ts:320` `intakeCounts`;done 终态只读门 `pages/photo/photo.ts:1190` `openEditSheet` 三处拦截 | 触达 item_id 仅发生在 done(photoCommit 成功后 `markRowSaved` `intake-draft.ts:244`);UI 无任何「已确认」自动用语 |
| 2 | **数量冻结**:`items` 不引入 `quantity`,数量仅草稿备注 | `grep -c quantity cloudfunctions/itemsApi/lib/handler.js` = **0**(实测,零出现);数量=note 文本:客户端拼接 `intake-draft.ts:90` `composeNote`(`×{qty} {suffix}` 单一来源,步进器只改这份草稿);服务端 photoCommit 只收 `note` 字段(`itemsApi/lib/handler.js:2156` 起 photo 形状门无数量项);photo_evidence schema 同样无数量字段(IMPLEMENTATION.md §2);页面横幅「电池×24 也只记一条」(photo.wxml) | 入库后数量只存在于 items.note 文本,无库存/取用/剩余语义(见 §8 已知限制) |
| 3 | **批次位置**:区域确认→默认继承→逐件例外→保存前最终确认弹层;不新建位置模型 | 批次位置+例外状态:`IntakeRow.exc`(`intake-draft.ts:40` 起);例外不改批次、批次改动不动已设例外行(`applyDraftEdits` 只改勾选字段 `intake-draft.ts:264`);保存前最终确认:`deriveSaveConfirm`(`intake-draft.ts:390`,例外**只汇总已勾选件**、#d 序号、保留 N/丢弃 M 文案)→ `pages/photo/photo.ts:1393` 弹层 → 「确认,记住了」才走 `commitPhotoBatch`(`photo.ts:1422`);位置事实仍写 `location_text`(photoCommit 逐件传 `location_text`,`itemsApi/lib/handler.js:2165` 起直接复用既有 createItem),不产生照片位置模型 | 「确认,记住了」是本批唯一进入写链路的触发点 |
| 4 | **照片证据链**:Photo Capture→Visual Drafts→确认→Items;Photo Evidence 独立关联不充当现址;服务端派生作用域 | 证据行落库:`itemsApi/lib/handler.js:2165` `photoCommitItem`(建档成功后才 add 证据行,`_id="pe_"+genId`,唯一索引 (household_id,item_id,file_id) 冲突回查收敛);回放:`handler.js:2274` `photoEvidenceGetItem`(服务端解析 household_id 过滤,每件 created_at 降序前 3,`PHOTO_EVIDENCE_PER_ITEM` `handler.js:2048`);「不充当现址」:`evidence-view.ts:96` `mapEvidenceView` 派生「位置已变更」灰标——`captured_location_text ≠ 当前 locationText` 时以文字为准,旧照片仅作证据;一张照片关联多件:每件独立证据行共享同一 file_id | 证据只增不删(删除物品不级联,悬挂行按 item_id 查询天然查不到,IMPLEMENTATION.md §11) |
| 5 | **权限与隐私**:授权前不上传云端;真实家庭影像不进仓库 | 确认前零上云:识别走 base64 直传(`utils/photo-vl.ts:338` event 只带 image_base64/img_w/img_h;**静态守卫** `tests/photo-vl-client.test.js:157-160` 断言编译产物不含 `uploadFile(`/`downloadFile(`);服务端 `cloudfunctions/extractDraft/index.js` 不注入 downloadFile,旧式 file_id 事件 INVALID_INPUT);唯一上云动作=用户点「确认,记住了」后 `commitPhotoBatch` 先 `wx.cloud.uploadFile` 再 photoCommit(`utils/photo-intake.ts:350` 起,上传失败整批不提交、云端零残留);会话 `fileId` 确认前恒 null、base64 绝不落存储(`utils/photo-session.ts:30`);集合权限「所有用户不可读不可写」、household_id 一律服务端解析(`itemsApi/lib/handler.js:2039` 注释+实现);跨成员读照片一律走云函数 getTempFileURL 换临时链接(`itemsApi/index.js:73`),不直接用 fileID 渲染;真实抽屉照片不随仓库分发(README.md「怎么 看」节) | 红线由测试+静态扫描双保险,不是口头约定 |
| 6 | **坐标格式**:适配层显式声明量纲(禁按最大值猜)→存 0-1+原图宽高→前端变换→不可信框宁可不显示 | 量纲唯一声明=提示词逐字写 0-1000(IMPLEMENTATION.md §1.1,handler `buildVlPrompt`);云函数适配层 `vl.js:92` `normalizeVlBox`:四值有限整数 ∈[0,1000] 且 x2>x1/y2>y1 才 `/1000` 归一,**任一不满足整框丢弃为 null(物品行保留)**,绝不舍入钳制;存储与 API 一律 0-1+`img_w`/`img_h` 随行(photo_evidence schema §2);客户端变换 `utils/photo-box.ts`(`containRect:75`/`coverRect:90`/圈选反算 `containPointToNormalized:107`),容器 aspect-ratio=img_w/img_h 等比零裁切;云函数不解析图片二进制、不猜量纲 | 「宁可不显示」落在 box=null 合法且只显照片不画框(photo 页与详情证据卡同语义) |

## 4. 如何本地验证

### 4.1 自动化(本报告撰写时实测)

```
npm test          # 725 项全绿(0 fail;pretest 先 npm run build:mp)——2026-10-17 实测
npm run typecheck # tsc -p miniprogram --noEmit 通过(零输出)——2026-10-17 实测
```

离线纪律:测试零网络、零外部依赖;VL 的 HTTP 集成用例走 127.0.0.1 stub server(`tests/photo-vl.test.js`,仿 `extractDraft-local-llm.test.js`);itemsApi 侧用 `tests/helpers/memoryDb.js`(已配 photo_evidence 唯一索引)。

### 4.2 页面手测路径(开发者工具真机预览,全链走查)

1. **入口**:首页常态胶囊「📷 拍照记一抽屉」(或首用态「📷 拍照记」)→ 进 photo 页;
2. **拍照识别**:相机或相册选一张 → 观察 VL 识别出候选清单(需 §5 的 VL 网关配置;未配置应弹「拍照识别暂不可用,可手动添加」,确认后仍进页,可「+ 手动添加物品」);
3. **屏①核对**:照片条折叠/展开+框脉冲;三态勾选(候选/保留/已记住);步进器改数量看备注文案同步;横幅在;位置栏填批次位置;
4. **语音编辑**:按住底部胶囊说话(如「第 3 个是品客的薯片罐,已经空了,放厨房去」)→ diff sheet:按内容锁定提示、逐字段勾选、应用 N 处/禁用、「念错了」零改动;按住位置胶囊说「这批都在客厅电视柜」→ intent=batch_location;
5. **屏④**:点行开编辑 sheet(名称点选区一键改类/数量/位置例外/提醒日期);已入库(done)行点按只读不开面板;
6. **屏⑤圈选**:照片展开后进圈选模式画红框 → 结果卡 → 「加进清单(候选)」→ 计数联动;
7. **保存**:「存 n 件」→ 最终确认弹层(批次位置/例外清单只含勾选件/保留 N 丢弃 M)→「确认,记住了」→ 此刻才发生上传+建档 → 行变「已记住」、toast「都记住了 · N 件已入库」;
8. **回放**:首页搜索该物品 → 结果行有「留证」缩略 → 点进详情页 → 证据卡展开:黄环脉冲框、「拍摄于 X 日·当时记录」角标;改该物品位置后再看 →「位置已变更」灰标+以文字为准;
9. **会话恢复**:photo 页中途退出 → 回首页看「上次拍照的 N 件没记完,继续核对 ›」横幅 → 点回继续;
10. **降级抽测**:拒绝相机权限 → 「去设置/从相册选」兜底;飞行模式点保存 → 如实失败可重试。

## 5. 部署清单(上线前逐项打勾;以 IMPLEMENTATION.md §10 为准)

1. **控制台建集合 `photo_evidence`**:权限「**所有用户不可读不可写**」(与 household 系列同纪律,读写只在云函数侧);索引两条:查询 `(household_id, item_id)`、唯一 `(household_id, item_id, file_id)`;
2. **extractDraft 云函数重新上传部署**:环境变量新增 `VL_BASE`(含 `/v1` 基址)、`VL_TOKEN`(Bearer)、`VL_MODEL`(模型路径),可选 `VL_TIMEOUT_MS`(默认 30000)——三件套缺任一,vlRecognize 返回 `AI_UNAVAILABLE/vl_not_configured`(客户端降级手动添加);`config.json` timeout 已随代码改 60;与既有 DEEPSEEK/LOCAL_LLM 环境变量并存互不影响;
3. **itemsApi 云函数重新上传部署**:`config.json` timeout 已随代码改 20;无新环境变量;
4. **云存储**:保持默认权限(仅创建者可读写)**不改**——跨成员读照片一律走 photoEvidenceGet 换临时链接;上传路径规则 `photo-evidence/{householdScopeId()}/{yyyyMM}/{uuid}.jpg`(scopeId 未捕获用 "default");上传时机仅限用户确认后、photoCommit 之前;
5. **小程序端发版**:app.json 新增页面 `pages/photo/photo`。

## 6. 已知限制(如实)

1. **数量备注不入库为结构化字段**(合同边界 2 的代价):`×{qty} {suffix}` 只存 items.note 文本,搜索/提醒/统计拿不到数量语义;photo_evidence 也无数量字段;
2. **VL 依赖本地网关配置**:识别走本机 Qwen3-VL-8B 网关(OpenAI 兼容端点),未配置三件套或网络不通 → 全量降级为「手动添加」,**无 DeepSeek 兜底**(deepseek-flash 无视觉模型,合同明确不接);意味着没有本地网关的环境(纯云部署)拍照识别功能不可用,只有手动链路;
3. **临时链接时效**:photoEvidenceGet 换得的 https 临时链接约 2h 有效,当次会话够用;换链失败该行 `photo_url:""` 需重试,不废整个查询;
4. **证据只增不删**:物品删除后证据行成悬挂行保留(历史事实,按 item_id 查询天然查不到,不级联清理);
5. **每件证据回放上限 3 条**:photoEvidenceGet 每件取 created_at 降序前 3(`itemsApi/lib/handler.js:2048`),更早照片不回传;
6. **一屏一照**:不做连拍/多照片批,多照=多次拍照分批(合同 §11);
7. **会话恢复受小程序临时文件生命周期约束**:退出后 localPath 可能被系统回收,恢复时文件不存在则如实提示重拍(base64 不落存储的代价,不编造);
8. **draftEditParse 单意图**:一句话含多类操作只取最主要一类,其余在 matched_word 外如实丢弃(IMPLEMENTATION.md §1.2 ⚖️ 拍板)。

## 7. 与 IMPLEMENTATION.md 的差异(诚实记录)

- **`callVlRecognize` 未在 api.ts 另做薄封装**:IMPLEMENTATION.md §4.2 计划 api.ts 加薄封装但注明「调用封装已由 utils/photo-vl.ts 提供;api.ts 若另做薄封装,形状必须一致」——实现选择了不重复封装,vlRecognize 的 callFunction/超时/降级/形状校验全部在 `utils/photo-vl.ts`(`:323` 起),api.ts 只加了 `callDraftEditParse`(`:564`)与 callItemsApi 两 action 扩展。形状与 §1.1 契约一致;
- **测试文件数超计划**:计划 4 个新测试文件 + voice-entry 补 2 例,实际 12 个新文件(多出 photo-intake/photo-session/photo-page/item-evidence/index-evidence-thumb/evidence-view 六个,覆盖编排、会话、页面、详情卡、首页缩略、视图映射),总测试 725 项(基线 542,本分支净增 183 项)——超出计划属加强,无缺项;
- **无其他偏差**:六项边界、4 个 API 契约、坐标契约、部署面均与 IMPLEMENTATION.md 对齐(本报告 §3 抽验锚点均为当前分支实测行号)。
