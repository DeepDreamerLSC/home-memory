# D1 实现报告:位置级视频清点与多物品录入(issue #94)

状态:**已上线收口**——离线验证全绿(986/986 + typecheck);PR #95 已合入 main(merge `36f2c85`);三函数(itemsApi/locations/videoCleanup)与包 0.10.0 已从 main 部署/上传;**真机验收通过(2026-10-22,体验包 0.10.0,用户确认,见 §8)**;issue #94 已关闭(收口评论 6318560953)。原始实现 commit:`2a4b818`(服务端动作 + 删除三按钮)、`384a1bb`(客户端 + 读侧 action)、`6108eee`(wxml 标签笔误修复)。设计依据 `docs/design/video-ai/D1-IMPLEMENTATION.md`(实现蓝图),契约增补已落 `docs/API_CONTRACT.md:89-98`;部署/操作步骤已并入 `README.md` 步骤 4 ⑨。

本文落笔时(2026-10-20)在本仓库实测:

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 全量测试 | `npm test` | **986/986 通过,0 失败** |
| 类型检查 | `npm run typecheck` | **通过(exit 0)** |
| B 四件回归(B 零感知硬门) | `node --test tests/video-scene.test.js tests/video-scene-share.test.js tests/video-scene-client.test.js tests/video-scene-page.test.js` | **25/25 通过** |
| B 四件零修改 | `git diff --stat 969298c..HEAD -- tests/video-scene.test.js tests/video-scene-share.test.js tests/video-scene-client.test.js tests/video-scene-page.test.js` | **空 diff(逐字节未动)** |
| 首页与 B 页零改动 | `git diff --stat 969298c..HEAD -- miniprogram/pages/index/ miniprogram/pages/video-scan/` | **空 diff** |
| D1 测试文件 | `node --test tests/location-scan-commit.test.js tests/location-scan-move.test.js tests/location-scan-purge.test.js tests/locations-delete-cascade.test.js tests/item-match.test.js tests/location-scan-read.test.js tests/location-scan-page.test.js tests/video-cleanup.test.js` | **73/73 通过**(7 个新文件 64 例 + video-cleanup 全件 9 例,其中 D1 增例 3) |

真机/e2e(`node tests/e2e/*.js`,需开发者工具自动化端口)**未运行**——见 §8。

---

## 1. 功能面(用户能看到什么)

1. **位置页底部入口卡**(仅 browse 模式且非根层):「📹 拍视频清点这里」+ 第二行「上次清点:M-D · 确认 N 件(x 件已删)」摘要(有记录才显示),点整卡进拍摄、点「回看」进回放(`miniprogram/pages/locations/locations.wxml:120-132`;根层不显示——物品不允许挂 home 根)。首页零改动(#94「首页不展示」红线,空 diff 实证)。
2. **位置级视频清点页**(新页 `pages/location-video-scan`):选视频 → AI 场景扫描出候选(同名线索分组)→ 确认页(固定位置头卡「清点:我的家 / X / Y」+ 逐件子位置选择器(只含当前子树)+ 每件「找已有物品」五级匹配建议面板)→ 上传提交。阶段机与 B 同名同义:`idle → scanning → review → uploading → committing → partial/done/failed`(`location-video-scan.ts:49-57`)。
3. **已有物品关联语义**:建议只提示绝不自动选中;点选后——挂载已在当前子树内 → 只补视频证据;挂载在子树外 → ActionSheet 三选「只关联,保留原位置 / 移动到当前位置并关联」,取消不切 target(`location-video-scan.ts:857-900`)。
4. **回看模式**(`mode=last`):视频播放器(不自动播放,wxml 无 autoplay 属性)+ 仍存活确认物品清单,按 item_id 直查详情(`location-video-scan.ts:1207-1218`)。
5. **删除位置三按钮**:「⋯ → 删除」改走 `deletePreview` 影响面弹层(「当前及子位置共 N 个,物品 M 件,关联视频 K 条」+ 含 S 次视频清点记录)→ 取消(零调用)/ 删位置并迁移物品 / 全部删除(二次确认,逐件 itemsApi.delete 后 deleteLocation(purge),NODE_NOT_EMPTY 收敛重试)(`locations.ts:820-1009`)。旧 `delete`/force 路径保留不动。
6. **服务端能力**:`videoSceneCommit` 可选位置上下文(缺省 = B 零感知)、`location_scans` 幂等落库与部分失败自愈、两个只读 action、取消与孤儿回收的 scan 引用感知、删除位置两模式(迁移/清空)。

## 2. 文件与 API 清单

### 2.1 服务端

| 文件 | 内容 | 关键位置 |
| --- | --- | --- |
| `cloudfunctions/itemsApi/lib/video.js` | D1 全部服务端逻辑:常量(`LS`/`SCAN_CANDIDATE_MAX` 等)、`parseLocationContext` 形状门、`subtreeNodesById`(collectSubtree 等价副本)、`resolveLocationContext`(归属+子树校验)、`applyScanMove`(d1move 三态)、`applyScanMount`(d1mount)、`upsertLocationScan`(幂等落库)、`locationScanRefExists`/`retainTicketForScan`(取消保留)、`locationScanLatest`/`locationScanContext`(只读)、commit 主流程插入点 | 常量 `video.js:27-37`;形状门 `video.js:1185-1214`;子树 `video.js:1241-1265`;归属校验 `video.js:1276-1309`;移动 `video.js:1330-1365`;挂载 `video.js:1373-1405`;scan 落库 `video.js:1416-1470`;取消保留 `video.js:922-928,964-974,1489-1501`;latest `video.js:1526-1573`;context `video.js:1583-1640`;commit 插入 `video.js:1714-1748,1843-1876,1899-1911,1915-1976`;签名扩展 `video.js:997-1042`;evidence `scan_id` 写入/查重 `video.js:1059,1083,1099`;投影 `video.js:267-268` |
| `cloudfunctions/itemsApi/lib/handler.js` | 路由表挂两个只读 action(不进 WRITE_ACTIONS) | `handler.js:2629-2630` |
| `cloudfunctions/locations/lib/handler.js` | `deletePreviewAction`(只读计数)、`deleteLocationAction`(migrate/purge)、`markSubtreeScans`(条件状态迁移)、`migrateRemountPhase`(条件重挂+guard);`deleteLocation` 进 `WRITE_DB_ACTIONS` 走 F2 双 marker 硬门 | 计数 `handler.js:1288-1331`;状态迁移 `handler.js:1263-1280`;重挂 `handler.js:1340-1380`;删除 `handler.js:1394-1476`;路由 `handler.js:1493-1494`;写门 `handler.js:1520` |
| `cloudfunctions/videoCleanup/lib/handler.js` | 证据引用复核旁增补 `location_scans` 按 asset/file 查询(fail-closed:查询失败视为有引用不删) | `handler.js:8-10,62-80,127-135,193-202` |

### 2.2 API 增量(契约全文见 `docs/API_CONTRACT.md:89-98`)

| API | 类型 | 语义 |
| --- | --- | --- |
| `itemsApi.videoSceneCommit` 增量参数 | 写(可选) | `event.location = { location_id, scan_id, path_snapshot, text_snapshot }`、`event.candidate_count`(0-500)、`items[i].node_id`(仅 new)、`items[i].move_to_node_id + expected_version`(仅 existing,同进同出)。形状门先于一切读写;子树越界 → `INVALID_INPUT + detail.out_of_subtree` 整批零写;跨家庭 location_id → `NOT_FOUND`;new 的 `location_text` 必须逐字 === 目标节点路径文本 |
| `itemsApi.locationScanLatest` | 只读 | `{ location_id }` → 最新 active scan 投影 + `video_url`(换链失败 `""` 不废查询)+ 仍存活确认物品清单(`confirmed_count` 保持原始数) |
| `itemsApi.locationScanContext` | 只读 | `{ location_id }` → `{ subtree(含自身、绝不含子树外), subtree_items, household_items(updated_at 倒序截断 200), household_truncated }` |
| `locations.deletePreview` | 只读 | `{ node_id }` → `{ node_count, item_count, video_count, scan_count, migrate_available }`;根 → INVALID_INPUT |
| `locations.deleteLocation` | 写(F2 硬门) | `{ node_id, mode:"migrate"\|"purge" }`;migrate:条件重挂上一级(冲突 VERSION_CONFLICT 零删除)→ 硬删子树 → 补偿悬挂挂载 → scan 标 `location_deleted`;purge:仍有活物品 → `NODE_NOT_EMPTY + detail.remaining_items`(补删后重试),否则收口子树并把 scan(active 与 location_deleted)升级 `deleted` |
| `videoUploadCancel` / `videoCleanup` | 行为增量 | 增补 scan 引用复核:任一 scan 行存在即不删云文件(cancel 返回 `{ state:"bound", scan_retained:true }`);cancel-before-commit(scan 尚不存在)行为与 B 一致 |

### 2.3 客户端

| 文件 | 内容 |
| --- | --- |
| `miniprogram/pages/location-video-scan/*`(新页,`app.json:9` 注册) | 页面 5 件(wxml 229 行/wxss 142 行);状态机、会话存储(scope+node_id 键,24h TTL,`location-scan.ts:22-28`)、`onHide` 取消抽帧会话并存会话(`location-video-scan.ts:287-298`)、上传序列 begin(scene)→ `wx.cloud.uploadFile` → receipt → commit → partial 重试/放弃(`location-video-scan.ts:993-1140`) |
| `miniprogram/utils/item-match.ts`(新) | 五级匹配纯函数:`normalizeForMatch`(trim→NFKC→小写→删空白→删标点)、`editDistance`、`buildItemMatchSuggestions`(子树严格同名→子树模糊→全家庭同名→全家庭模糊→无建议;级别升序+同级字典序,截断 5;同名并列绝不合并) |
| `miniprogram/utils/location-scan.ts`(新) | `buildLocationScanCommitItems`(客户端形状纪律先拦)、`lastScanSummaryText`、`subtreeOptionViews`、会话 key/TTL |
| `miniprogram/pages/locations/*`(增量) | 入口卡 + 摘要(迟到守卫 `locations.ts:376-400`)+ 三按钮删除流程(`locations.ts:820-1009`) |
| `miniprogram/types.ts` | `LocationScan*`/`LocationsDelete*` 类型与联合扩员(`types.ts:439-440,840-841,1252-1395`) |
| `miniprogram/utils/api.ts` / `locations-api.ts` | 两 action 的响应校验/错误归一(`api.ts:464,492`;`locations-api.ts:203,215,304`) |

复用不改动:`utils/video-scene.ts`(扫描/草稿原语)、`utils/video-target.ts`(抽帧)、`utils/photo-vl.ts`(识别)、`utils/video-attach.ts`(选视频);`pages/video-scan`(B 页)与 `pages/index`(首页)零改动(空 diff 实证)。

## 3. 两个技术点定案与理由(#94「待实现时确认」)

### 定案 ①:`location_scans` 独立集合(evidence 只增写一个 `scan_id` 字段)

**实现**:`LS = "location_scans"`(`video.js:29`);evidence 行仅在 doc 上增普通字段 `scan_id`(`video.js:1083`),读侧投影兼容旧行为 `""`(`video.js:267-268`)。scan 文档 18 字段全集见 `video.js:1422-1441`,与 `docs/API_CONTRACT.md:90` 一致。

**理由**(设计文档 §1 定案①,代码印证):
1. **基数不同**:evidence 行键是 `(household_id, item_id, file_id)`(一行=一件物品的一段证据);一次清点 = 1 scan 对 N 行 evidence。`candidate_count/confirmed_count/status` 是每视频属性,内嵌要复制到 N 行且删位置时翻状态要重新穿一遍 item 锁/asset 锁——违反 B 已冻结的锁序(item 升序 → asset)。独立集合里删除位置只是一次按索引的条件 update(`markSubtreeScans`,`handler.js:1263-1280`)。
2. **零确认会话无处可嵌**:用户录了视频但一件没确认时 evidence 行数为 0,内嵌方案该记录不存在;独立集合天然覆盖(测试 `D1-ZERO-CONFIRMED`)。
3. **生命周期不同**:evidence 行随物品软删级联;scan 行随位置走(`active → location_deleted/deleted`)。
4. **不复用 `video_upload_tickets`**:票据是 15 分钟 TTL 的操作状态机,由 videoCleanup 每日回收翻转状态,产品记录塞进去保不住审计字段。

### 定案 ②:`scan_id` 客户端生成 + 服务端 `(household_id, scan_id)` 幂等

**实现**:客户端开拍会话生成 uuid 同时作 `scene_id`(`location-video-scan.ts` 的 `scanId` 贯穿 begin/commit);服务端形状门强制 `location.scan_id === event.scene_id`(`video.js:1194-1199`),票据侧第二方校验既有(`video.js:1756`);落库按 `(household_id, scan_id)` 查重,add 撞唯一索引(E11000)→ 回查走已存在分支(`video.js:1442-1450`)。

**理由**:
1. B 的幂等链已经这样工作(`scene_id` 客户端生成、绑进票据、commit 三方一致);D1 的 scan 与 scene 是同一次拍摄的两个视角,服务端生成会引入第二个 id 与额外往返,且无法覆盖「上传中断后客户端携冻结载荷重试收敛」——幂等键必须在客户端手里。
2. 落库幂等复用仓库既有模式(唯一索引拒绝并发插入 → 回查复用):同键同内容 → `duplicated:true` 稳定返回;同键异 file/asset/location → `OPERATION_CONFLICT`(`video.js:1452-1458`,scan_id 被复用到另一段视频的硬门,测试 `D1-SCAN-REUSE`)。
3. `location_scans._id` 仍为服务端 `ls_ + genId()`(`video.js:1423`),与「票据 `_id` 服务端生成 / `scene_id` 客户端生成」同构。

**随文定案的其余两点**(已同样落实):子位置只从现有位置树选(服务端逐件子树硬校验 `video.js:1286-1307`,客户端选择器数据面只渲染子树);结构性操作(rename/move/merge/删除迁移)永不改写 `items.location_text`——migrate 重挂只写 `location_node_id` 不碰文本(`handler.js:1338` 注释 + `conditionalMountUpdate`),`location_text` 只在用户显式声明时更新(D1 移动 `video.js:1339-1341` / itemsApi.update)。

## 4. #94 验收清单逐条对照(实现位置 + 测试名)

验收条目取自 #94(与 `D1-IMPLEMENTATION.md` §7 的 16 条一致)。测试名后括号为 `tests/` 下文件名缩写:commit=`location-scan-commit.test.js`,move=`location-scan-move.test.js`,purge=`location-scan-purge.test.js`,cascade=`locations-delete-cascade.test.js`,match=`item-match.test.js`,read=`location-scan-read.test.js`,page=`location-scan-page.test.js`,cleanup=`video-cleanup.test.js`。

| # | 验收标准 | 实现位置 | 测试 |
| --- | --- | --- | --- |
| 1 | 任意层级位置可进入拍摄 | 入口卡仅 browse 非根层 `locations.ts:343-368`,带 node_id 进新页 `locations.ts:403-414`;新页 onLoad `location-video-scan.ts:270-285` | `D1P-ENTRY`(page:165)、`D1P-SCAN-CTX`(page:369) |
| 2 | 默认位置正确,逐件子位置仅限当前子树 | 服务端子树硬校验 `video.js:1276-1309`(越界 → INVALID_INPUT + out_of_subtree 整批零写);客户端选择器只渲染 `locationScanContext.subtree` `location-video-scan.ts:376-391`,缺省挂本层 `location-scan.ts:109` | `D1-SUBTREE`(commit:258)、`D1P-SCAN-CTX`(page:369) |
| 3 | 新物品能正确归档到目标位置 | 建档后 `applyScanMount`(d1mount,expected_version=1)`video.js:1373-1405`,调用点 `video.js:1902-1909`;挂载冲突仅降级 `mounted:false` 绝不删物品 | `D1-MOUNT`(move:136)、`D1-MOUNT-REPLAY`(move:195)、`D1-COMMIT-FULL`(commit:180) |
| 4 | 关联已有物品不自动改变位置 | 服务端仅在 `move_to_node_id` 存在时移动(`video.js:1847`);客户端子树内点选 → 只关联 toast `location-video-scan.ts:879-884` | `D1-LINK-ONLY`(move:225,断言物品文档零字段变化)、`D1P-MOVE-INSIDE`(page:441) |
| 5 | 异位置已有物品必须显式选择「移动」 | 移动先于证据(冲突件不写证据、绝不静默降级)`video.js:1843-1876`;客户端三选 ActionSheet `location-video-scan.ts:885-900` | `D1-MOVE-EXPLICIT`(move:254)、`D1-MOVE-CONFLICT`(move:344)、`D1P-MOVE-CHOICES`(page:457) |
| 6 | 同名物品默认分开,模糊匹配只提示 | `item-match.ts:124-192` 纯函数,输出只是建议列表 | `MATCH-NO-AUTO`(match:193)、`MATCH-LEVELS`(match:113)、`MATCH-NORMALIZE`(match:50)、`MATCH-LEV`(match:75)、`MATCH-MAX5`(match:159)等 9 例 |
| 7 | 一次保存的正确物品共享 file_id/asset_id | 同一票据逐件 `saveSceneEvidence` `video.js:1044-1107` | `D1-SHARE`(commit:530)、`D1-COMMIT-FULL`(commit:180) |
| 8 | 每个物品有自己的确认高亮 | 每行独立 `highlights` 字段 `video.js:1078` | `D1-SHARE`(断言各持独立 highlights 与 scan_id)、`D1-COMMIT-FULL` |
| 9 | location_scan 有候选数/确认数/确认物品列表/位置快照 | `upsertLocationScan` doc 全集 `video.js:1422-1441` | `D1-COMMIT-FULL`、`D1-ZERO-CONFIRMED`(commit:499,零确认也落 scan)、`D1-IDEMPOTENT`(commit:402)、`D1-PARTIAL-HEAL`(commit:438,重试后计数自愈) |
| 10 | 位置页底部显示最新清点 | `loadScanSummary`(迟到守卫,失败静默)`locations.ts:376-400`;wxml `locations.wxml:120-132`;首页零改动(空 diff) | `D1P-ENTRY`、`D1P-LAST`(page:225)、`D1P-REG`(page:146);服务端半边 `LATEST-PROJECTION/STATUS/URL-FAIL/EMPTY`(read:115-174) |
| 11 | 删除位置三个按钮语义正确 | `deletePreviewAction` `handler.js:1288-1331`;`deleteLocationAction` `handler.js:1394-1476`;客户端三按钮弹层 `locations.ts:830-1009` | `D1P-DELETE-PREVIEW`(page:241,取消不调接口)、`D1P-DELETE-MIGRATE`(page:277)、`DELETE-PREVIEW`(cascade:263)、`MIGRATE-FULL`(cascade:301)、`PURGE-GUARD`(cascade:431) |
| 12 | 根位置无法删除 | 服务端 `isHomeRoot` 双动作硬拒 `handler.js:1296-1298,1405-1407`;客户端根无「⋯」入口 | `ROOT-GUARD`(cascade:236)、`D1P-ROOT-GUARD`(page:359) |
| 13 | 删位置并迁移物品保留证据和 scan,标 location_deleted | migrate 流程 `handler.js:1413-1426` + `markSubtreeScans` 条件迁移;不删证据/云文件/物品、不改 location_text | `MIGRATE-FULL`(cascade:301)、`MIGRATE-KEEPS-RETRY`(cascade:357,幂等重试)、`MIGRATE-CONFLICT`(cascade:382,冲突零删除)、`MIGRATE-TOP-ROOM`(cascade:416,顶层房间拒迁移) |
| 14 | 全部删除最后引用才删云文件,失败可重试 | 客户端逐件 itemsApi.delete(B 级联资产)→ purge 收口 `locations.ts:925-1009`;服务端 NODE_NOT_EMPTY 收敛清单 `handler.js:1428-1442` | `PURGE-E2E`(purge:129,共享文件他家引用保留)、`PURGE-RETRY`(purge:184,中途放弃续删收敛)、`PURGE-PARTIAL-HEAL-SOURCE`(purge:228)、`PURGE-UPGRADE`(cascade:467)、`D1P-DELETE-PURGE`(page:298)、`D1P-DELETE-PURGE-CANCEL`(page:342) |
| 15 | 跨家庭、跨子树、并发删除、部分提交失败 | 见各自实现位置 | `D1-CROSS-HOUSEHOLD`(commit:319)、`D1-SUBTREE`、`PURGE-CONCURRENT-LINK`(cascade:484,删除期并发挂载补偿)、`MIGRATE-CONFLICT`、`D1-MOVE-CONFLICT`(移动 vs itemsApi.update)、`D1-PARTIAL-HEAL`、`LATEST-CROSS-HH`(read:175)、`CONTEXT-CROSS-HH`(read:263) |
| 16 | 真机验证抽帧、耗时、弱网、切后台和内存 | **不可离线,未做**——见 §8 | 无(离线测试不能替代,门禁沿用 #94「不能仅凭离线测试上线」) |
| — | B 零感知回归(本实现硬门) | `event.location` 缺省时签名逐字节同 B(`video.js:1031-1033`);新逻辑全在 location 分支内 | `D1-B-COMPAT`(commit:354,无 location → 响应无 scan 字段、evidence 无 scan_id、混合模式重试被签名拒);B 四件测试文件零修改 + 25/25 通过(§0 表) |

另有读侧/清理侧补充用例:`LATEST-SHAPE`(read:188)、`CONTEXT-TRUNCATED`(read:246,200 截断)、`CONTEXT-ROOT-GUARD`(read:272)、`CONTEXT-INTEGRATION`(read:283,写读同集合)、`D1-SHAPE`(commit:562)、`D1-SCAN-REUSE`(commit:606)、`D1-MOVE-REPLAY/ALREADY`(move:302/326)、`CLEANUP-D1-SCAN / CLEANUP-D1-SCAN-FILE-ONLY / CLEANUP-D1-NO-SCAN`(cleanup:254/283/305,孤儿回收的 scan 引用感知与 B 零回归)。

## 5. 如何本地验证

```bash
# 1. 全量离线测试(不需要微信开发者工具、不需要 API key)
npm test                    # 实测 986/986 通过

# 2. 类型检查(小程序 TS strict)
npm run typecheck           # 实测通过(exit 0)

# 3. B 零感知回归单独跑(四件必须零修改通过)
node --test tests/video-scene.test.js tests/video-scene-share.test.js \
  tests/video-scene-client.test.js tests/video-scene-page.test.js   # 实测 25/25

# 4. D1 全部用例单独跑
node --test tests/location-scan-commit.test.js tests/location-scan-move.test.js \
  tests/location-scan-purge.test.js tests/locations-delete-cascade.test.js \
  tests/item-match.test.js tests/location-scan-read.test.js \
  tests/location-scan-page.test.js tests/video-cleanup.test.js       # 实测 73/73

# 5.(可选)确认 B 测试文件与首页/B 页未被改动
git diff --stat 969298c..HEAD -- tests/video-scene*.test.js miniprogram/pages/index/ miniprogram/pages/video-scan/
# 实测输出为空 = 零改动
```

改过 `.ts` 后先 `npm run build:mp`(预编译产出 `.js`;当前工作区 clean,编译产物已提交)。需要 UI 的验证(选视频、抽帧、匹配面板)只能在微信开发者工具/真机进行;e2e 脚本(`node tests/e2e/*.js`)需先开自动化端口(README 步骤 7),**本次未运行**。

## 6. 部署清单

### 6.1 数据库(先建,再部署函数)

云开发控制台 → 数据库:

1. **新建集合 `location_scans`**,权限并入既有口径:**「所有用户不可读不可写」**(README 步骤 4 ③;一切读写走云函数)。契约与所有权分工(itemsApi 写创建/计数,locations 写状态标记)见 `docs/API_CONTRACT.md:90`。
2. **索引**(location_scans 索引管理,人工步骤):
   - 唯一索引:`household_id`(升序)+ `scan_id`(升序),勾选「**唯一**」——`(household_id, scan_id)` 是幂等硬门,不建则并发/重试可能双写 scan 行;
   - 非唯一索引:`household_id` + `location_id` + `created_at`——「上次清点」最新一条查询(`locationScanLatest` 按 location 过滤后函数内倒序)。
3. **`video_evidence` 增补非唯一索引** `household_id` + `scan_id`(D1 只写不查,影响后续 join 效率;缺失不破坏正确性)。
4. 既有集合(`items`/`locations`/`video_evidence` 唯一索引 `(household_id,item_id,file_id)` 等)无变化。

### 6.2 云函数(三个需重部署)

右键「上传并部署:云端安装依赖」或 CLI(`cli cloud functions deploy --env <环境ID> --names itemsApi locations videoCleanup --project <项目根> -r`):

| 函数 | 改动 | 超时建议 |
| --- | --- | --- |
| `itemsApi` | videoSceneCommit 位置上下文、locationScanLatest/locationScanContext、取消的 scan 引用复核 | 维持现状(README 建议 10 秒;commit 内多了 locations/scan 读写,最坏 12 件 + 子树校验,量级不变) |
| `locations` | deletePreview/deleteLocation(migrate 含逐件条件重挂 + guard ≤5 轮) | 维持 60 秒(README 既有口径) |
| `videoCleanup` | scan 引用复核(fail-closed) | 维持 20 秒 |

`households`/`remindNotify` **无需随 D1 重部署**:README 的「四函数必须一起部署」约束针对共享家庭解析副本(`lib/household.js`)的变化;本次两个 commit 的 diff 未触及任何 `household.js`(实测 `git diff 969298c..HEAD --stat -- cloudfunctions/itemsApi/lib/household.js cloudfunctions/locations/lib/household.js` 为空)。部署顺序:**先建集合与索引,再部署函数**——缺集合时带 location 的 commit 会在 scan 落库一步失败(参照 README 步骤 ⑤ 的「先建集合再部署」先例)。

### 6.3 小程序包

整个 `miniprogram` 重新上传(开发者工具「上传」):新增页面 `pages/location-video-scan`(含 app.json 注册)、位置页 wxml/wxss/js 改动、新 utils(item-match/location-scan)与 types/api 增量。编译产物 `.js` 已随源码提交;若部署前又改过 `.ts`,先 `npm run build:mp` 再上传。

## 7. 已知限制(如实,设计文档 §8 + 代码注释印证)

1. **子树算法两份实现**:itemsApi 的 `subtreeNodesById`(`video.js:1241-1265`)是 `locations/lib/tree.js` `collectSubtree` 的等价副本(两个独立部署包不能互相 require);等价性靠行为级测试保证,树算法演进时两处需同步(注释已互相指认)。
2. **两函数共写 `location_scans`**:itemsApi 写创建/lifetime 计数,locations 写状态标记;分工已写入 `docs/API_CONTRACT.md:90`。
3. **purge 客户端编排无原子性**:每步幂等 + `NODE_NOT_EMPTY` 收敛清单把风险压到「中途放弃留半删状态,可随时续删」;弱网真机用例必须覆盖(§8)。
4. **0 确认 scan 的视频不再被 24h 孤儿回收**(有意为之,`video.js:922-928`):视频成为清点记录的一部分;scan 的用户主动删除留 D2。
5. **「scan 存在、其全部 evidence 行已被逐件删光」的边界**:云文件可能已被末引用删除,`locationScanLatest` 返回 `video_url:""`(客户端显示「视频已随物品证据删除」),scan 行保留审计;D1 只读不写,D2 做 scan 管理时再收口。
6. **移动目标固定为进入的位置**:逐件子位置选择只作用于新物品;#94 只定义「移动到当前位置」,不支持移到子位置。
7. **匹配池有截断**:`household_items` 按 updated_at 倒序截断 200 并附 `household_truncated`(客户端如实标注「物品较多,建议只参考同名精确匹配」);物品超 200 时模糊建议可能漏旧的。
8. **建议质量依赖归一化**:五级匹配是纯客户端启发式(NFKC + 标点/空白删除 + 编辑距离),不做语义/拼音/别名匹配;错名较多时建议为空,用户走新建。

## 8. 真机验收项(#94 验收 16,不可离线)

**已于 2026-10-22 由用户在真机验收通过(体验包 0.10.0,覆盖真录像抽帧、弱网、切后台、移动三选弹层交互)**,#94 门禁「不能仅凭离线测试上线」满足,issue 已关闭。原验收清单留档如下:

1. **抽帧**:对典型时长视频(建议 30s/60s/120s 各一)实测场景扫描的抽帧会话耗时与帧数;`onHide` 时抽帧会话取消是否及时(`location-video-scan.ts:287-291`)。
2. **耗时**:扫描 → 确认 → 上传 → commit 全链路各阶段耗时;commit(12 件上限)在服务端的响应时间(云函数日志核对)。
3. **弱网**:上传中断 → cancel 后重拍零残留;commit 网络失败 → partial 态用同一冻结载荷重试收敛(不重复建物品/证据/scan);purge 中途断网 → 续删收敛。
4. **切后台**:扫描中/确认中/上传中切后台再回——会话按 scope+node_id 恢复、24h TTL 过期丢弃重拍;`pendingUpload` 恢复后「重试/放弃」两条路都收敛。
5. **内存**:帧会话+候选缩略图的内存峰值与释放(长视频、多候选场景);回看模式播放器的内存表现。
6. **交互真机风格**:三选移动 ActionSheet、删除三按钮半屏弹层在真机的呈现与误触;`household_truncated` 提示文案的可读性。
