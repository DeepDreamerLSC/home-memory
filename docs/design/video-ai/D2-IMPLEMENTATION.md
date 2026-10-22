# D2 一期实现契约:清点记录管理(issue #96)

状态:**实现契约冻结**(架构 GO 裁定评论四条约束已逐条映射,见 §0)。上游:D1 已上线收口(merge `36f2c85`,真机验收 2026-10-22 通过,`docs/design/video-ai/D1-IMPLEMENTATION-REPORT.md`);本文是 D2 一期(历史列表 / 用户删除单次清点 / 0 确认视频 30 天到期回收 / 边界收口)的唯一实现契约,实现 PR 的服务端行为、字段、错误码、测试矩阵以此为准。

基线事实(本文引用的代码都在 main HEAD `3ebbeac`):

- scan 落库与自愈:`cloudfunctions/itemsApi/lib/video.js:1416-1470`(`upsertLocationScan`);scan 引用复核(现行「任意行存在即引用」语义):`video.js:1477-1487`(`locationScanRefExists`,videoUploadCancel 用)与 `cloudfunctions/videoCleanup/lib/handler.js:68-82`(`scanRefsTicket`)。
- 证据删除与末引用纪律:`video.js:297-299`(`isCloudDeleteSuccess`,status 0/-503003 为成功)、`video.js:301-330`(`deleteFilesStrict`)、`video.js:339-360`(`evidenceRowsForFile`)、`video.js:420-528`(`removeEvidenceRows`,item 锁 → asset 锁升序 → 锁内复核 → 云删成功才删行)。
- Latest/Context 只读 action:`video.js:1526-1573` / `video.js:1583-1640`;commit 主流程与插入点:`video.js:1697-1986`。
- 位置删除流程的 scan 状态迁移:`cloudfunctions/locations/lib/handler.js:1263-1280`(`markSubtreeScans`),migrate → `location_deleted`+`location_deleted_at`,purge → `deleted`+`deleted_at`(`handler.js:1462-1466`)。
- 孤儿回收 worker:`videoCleanup/lib/handler.js:113-177`(中间态恢复)、`:179-230`(24h pending 回收);`deps.now` 可注入(可控时钟,`tests/video-cleanup.test.js:7,44-49` 先例)。
- 测试基建:`tests/helpers/memoryDb.js`——where 为 AND 等值匹配、**缺失字段不等于任何值**(matches 严格 `!==`,`memoryDb.js:44-52`),无 orderBy(排序一律函数内),get 未显式 limit 最多 100 条,唯一索引按集合配置模拟 E11000(`memoryDb.js:76-136`);location_scans 的 `(household_id, scan_id)` 唯一索引已在 D1 测试声明(`tests/location-scan-read.test.js:56-61`)。
- 位置页读侧现状:`miniprogram/pages/locations/locations.ts:376-400`(`loadScanSummary`,requestSeq 迟到守卫)、`locations.wxml:120-132`(入口卡);README 步骤 4⑨(`README.md:173-182`)。

---

## 0. 架构裁定四条约束 → 本文落点

| 裁定约束(原文见 issue #96 GO 评论) | 本文落点 |
| --- | --- |
| 1.「审计行存在」与「云文件仍被引用」分开;终态 deleted 与已回收 scan 不占引用;location_deleted 零确认行到期处置;不破坏 D1 migrate 语义 | §1 引用语义矩阵;§3 字段;§5 到期回收(候选含 location_deleted) |
| 2. 共享资产删除锁内末引用复核;bound 票据不算独立引用;复用 video_item_locks asset 锁;逐文件 status=0/-503003;禁 video-evidence/ 前缀 TTL;云删失败可重试不假报成功 | §1 矩阵;§4 scanDelete;§5 回收 |
| 3. 先云删成功再终结状态;已有其他引用只终结当前 scan;用户删不动物品/evidence;回收不动 created_at/candidate_count/confirmed_count;29/30 天可控时钟钉住 | §4 scanDelete;§5 回收;§7 测试矩阵 |
| 4. 旧提交重试/并发删除/位置删除收敛;upsert 防复活;latest 降级;dangling;跨家庭拒绝;位置页只查当前 location_id,首页不增入口 | §6 防复活;§2 历史;§7 测试矩阵;§8 客户端 |

一期范围之外(不做,沿用 #94/#96 边界):差异盘点/判断缺失/自动盘点/自动移动/自动合并/自动建树/首页清点历史/AI 语音查询。

---

## 1. (a) 视频引用语义矩阵(全部共享文件判定统一用这一张表)

一个云视频文件(`video-evidence/<household_id>/<ticket>.<ext>`)「仍被引用」= 以下任一持有者存在。判定键统一为 `(household_id, asset_id)` 命中 + `(household_id, file_id)` 回退(旧行无 asset_id,`evidenceRowsForFile` 同款双查去重,`video.js:339-360`)。

| # | 持有者 | 判定 | 何时释放 |
| --- | --- | --- | --- |
| R1 | 活 evidence 行 | 该 household 下 `video_evidence` 按 asset/file 命中任一行 | 行被证据删除/物品删除级联删除(既有路径) |
| R2 | **仍保留该视频的 scan** | `location_scans` 按 asset/file 命中,且 `status ∈ {active, location_deleted}` **且 `video_reclaimed_at` 未置位**(§3) | scan 终结为 `deleted`,或 0 确认到期回收置位 `video_reclaimed_at` |
| R3 | 实际未结算票据 | `video_upload_tickets` 按 asset/file 命中,且 `status ∈ {pending, binding, cleaning, cancelling}` | 票据进入终态 bound/cancelled/deleted(bound 的保护由 R1/R2 接管) |

**明确不算引用的**:终态 `deleted` 的 scan 行(审计行,不占文件);已回收(`video_reclaimed_at` 置位)的 scan 行;`bound`/`cancelled`/`deleted` 票据——**bound 票据是同一 scan/asset 的生命周期索引,不是独立引用**。若把 bound 算独立引用,0 确认 scan(commit 后票据必为 bound)的回收条件永远无法满足,约束 2 点名的「0 确认回收不可达」即由此而来。

**矩阵统一替换两处 D1 的「任意 scan 行存在即引用」**:`itemsApi video.js` 的 `locationScanRefExists`(videoUploadCancel 用)与 `videoCleanup` 的 `scanRefsTicket` 都收紧为 R2 语义。收紧后的行为差:scan 已终结/已回收时,cancel 与孤儿回收不再被审计行挡住——文件是否保住改由 R1/R3 与矩阵其余部分裁定,与用户可见状态(历史不再显示该行/显示「已过期回收」)一致。

**evidence 删除路径维持 D1『末引用判定不含 scan 行』(显式决定,不随矩阵改动)**:`removeEvidenceRows`/`cleanupForItem`(`video.js:420-528,537-621`)的锁内末引用复核继续只看 evidence 行,不看 scan。论证:

1. 若改含 scan 行:confirmed scan(`confirmed_count ≥ 1`)的行随位置走,audit 行**永不删除**(migrate 后也是 location_deleted,仍持有 R2 引用)——删物品时「最后一条 evidence」永远不是末引用,云文件永远不删,**confirmed scan 的文件将无人回收**(用户只能逐条手删 scan 才能释放,与「删物品即释放其视频」的 D1 已验收语义冲突)。
2. 维持不含的代价是 **dangling**(scan 在、其全部 evidence 行已被逐件删光 → 云文件已被 evidence 路径删除,scan 的回看断链),兜底为两级:读侧降级(`video_url:""`,客户端显示「视频已随物品证据删除」,D1 已实现)+ 0 确认到期回收(§5,处理 confirmed_count=0 的存量滞留视频)。dangling 属可显示的降级态,不是数据损坏。
3. 禁止对 `video-evidence/` 前缀配 TTL 的既有红线(README 步骤 4⑧ 原文)继续有效;0 确认到期回收是**按 scan 行逐条判定**的选择性回收,不是前缀 TTL。

---

## 2. (d) `locationScanHistory` 契约(新只读 action,itemsApi)

```
{ action:"locationScanHistory", location_id }        // location_id 形状门同 Latest(1-128)
→ { ok:true,
    scans: [                                           // ≤ 20 行
      { scan_id, created_at, candidate_count, confirmed_count,
        duration_ms, video_reclaimed:boolean, video_url }
    ],
    has_more: boolean }                                // 本位置 active 行数 > 20 时 true
```

- **只列本位置 active**:查询 `location_scans` where `{ household_id(服务端派生), location_id, status:"active" }`,**精确 location_id 匹配、不含子树**(子位置的清点在各自页面看);函数内按 `created_at` 倒序(`h.byCreatedDesc`,不依赖端上 orderBy——memoryDb 无 orderBy,真实库同理收口在函数内,Latest 同款纪律 `video.js:1537`)。无记录 → `{ scans:[], has_more:false }`。
- **limit 20 + 截断标注**:`HISTORY_LIMIT = 20` 冻结常量;函数内取前 20,`has_more = 总行数 > 20`;一期**单页**,不做翻页(客户端在 `has_more:true` 时显示「仅显示最近 20 次」)。
- **逐行视频降级,不废列表**:对未回收行批量 `getTempFileUrls`(一次批量,≤20 个 file_id,`videoEvidenceGet` 30 链接批量先例 `video.js:2001-2017`);`video_reclaimed_at` 置位的行不参与换链,`video_url:""` + `video_reclaimed:true`(客户端显示「视频已过期回收」,不给回看入口);换链异常/单链接失败 → 该行 `video_url:""`(dangling 同款降级),列表与其余行照常。
- **投影不含**:`confirmed_item_ids`、`file_id`、`asset_id`、`upload_ticket`、位置快照、任何内部字段——回看用行内 `video_url`,清点明细仍走 `locationScanLatest`(最新一条的物品清单)。日志只记行数与 has_more。
- **跨家庭**:household 服务端派生天然隔离,他家 location_id → 空列表(与 Latest 同语义,不返回 NOT_FOUND)。
- **不进 `WRITE_ACTIONS`**(纯读,与 Latest/Context 同款,`itemsApi/lib/handler.js:2628-2630` 路由位)。

`locationScanLatest` 同步增补:投影增 `video_reclaimed:boolean`(`video_reclaimed_at` 置位时 true,缺省 false);置位时不调 getTempFileUrls、`video_url:""`——「上次清点」摘要与历史列表对最新一条的回收态显示一致。

---

## 3. (b) `location_scans` 字段增补

在 D1 字段全集(`video.js:1422-1441`,18 字段)之上**只增不改**:

| 字段 | 类型/取值 | 写者 | 语义 |
| --- | --- | --- | --- |
| `video_reclaimed_at` | ISO 时间串;缺省/空 = 视频仍在 | 仅 videoCleanup 到期回收 | 视频在/已回收的唯一判定字段(R2);置位后该行不再持有文件引用 |
| `video_reclaim_reason` | 冻结词表,一期仅 `"zero_confirm_expired"` | 仅 videoCleanup | 回收原因 |
| `deleted_by` | `"user"` | 仅 itemsApi `scanDelete` | 用户删除标记。**缺省即非用户删**:位置流程(purge)与 D1 存量行都不写此字段,`location_deleted_at`(migrate)与 `deleted_at`(purge/用户删共用的终结时间戳)沿用不动——用户删 = `deleted_at`+`deleted_by:"user"` 两条同现;位置流程删 = 仅 `deleted_at`(或 `location_deleted_at`);三者可区分,locations 函数零改动 |

**不可变字段**:`created_at`、`candidate_count`、`confirmed_count` 对 D2 全部新路径(scanDelete/到期回收)**绝不写入**。唯一例外是 `upsertLocationScan` 的 D1 自愈分支(`video.js:1459-1468`):它更新 `confirmed_item_ids/confirmed_count`(活证据重查)与 `candidate_count`(max)——这是 D1 已验收的部分失败重试自愈语义,原样保留;D2 只给它加 §6 的状态门(仅仍持有视频的 active 行可自愈)。`updated_at` 允许维护性更新。

**状态机(D2 后全景)**:

```
active ──(scanDelete,用户)──────────────→ deleted + deleted_at + deleted_by:"user"
active ──(deleteLocation migrate)───────→ location_deleted + location_deleted_at   [D1 既有]
active ──(deleteLocation purge)─────────→ deleted + deleted_at                      [D1 既有]
location_deleted ──(deleteLocation purge)→ deleted + deleted_at                     [D1 既有]
active / location_deleted ──(0确认满30天)──→ 状态不变,置 video_reclaimed_at + reason  [D2 新,status 不迁移]
```

用户删除与到期回收都不物理删行(审计保留);`location_deleted`/`deleted` 行不可用户删(§4 门)。

---

## 4. (c) `scanDelete` 契约(新写 action,itemsApi)

```
{ action:"scanDelete", scan_id }        // scan_id 8-64(与 scene_id 同款形状门)
→ 成功:{ ok:true, replayed?:true, video_deleted:boolean }
```

进 `ACTIONS` 且进 `WRITE_ACTIONS`(F2 双 marker 硬门,与 `videoEvidenceDelete` 同族;共享家庭须带 `expected_household_id`+`expected_scope_revision`,缺/不一致 → FAMILY_SWITCHED/FAMILY_STALE_SCOPE 零写入,既有统一裁定,不另起炉灶)。

**执行序列(单 asset 锁,全序列 finally 释放)**:

1. **形状门**:`scan_id` 非 8-64 字符串 → `INVALID_INPUT`。查 `location_scans` where `{ household_id(服务端派生), scan_id }`;查无 → **`NOT_FOUND`(跨家庭同语义,他家 scan_id 在本家庭查询里天然查无)**。
2. **状态门**:仅 `status === "active"` 可删。
   - `location_deleted` / `deleted` 且非用户删 → `NOT_FOUND`(对用户是不可见行,随位置删除流程终结,权限与可见性一致);
   - `deleted` 且 `deleted_by === "user"` → **幂等重放**:`{ ok:true, replayed:true, video_deleted:false }`。**冻结口径**:replayed 响应不重演首删的文件判定,`video_deleted` 固定 `false`(首删成功的 `video_deleted:true` 只在首响返回;响应丢失后客户端据 replayed 收敛即可,不据它二次提示)——重放只保证「同一操作重试幂等成功」,不承诺复原首次的附属信息。
3. **asset 锁**:`acquireAssetLock(deps, asset_id, "scan_delete")`(`video_item_locks` 的 `_id=val_<asset_id>` 复用,`video.js:143-147`);asset_id 缺失/空的防御分支用 `lockKeyForEvidence` 同款 legacy 键(`video.js:76-80`)。抢锁失败 → `VIDEO_ITEM_BUSY`(客户端提示稍后再试)。**只持 asset 锁不持 item 锁**——scanDelete 不写任何 item/evidence,锁序纪律(item 升序 → asset 升序)在「无 item 锁」时天然满足。
4. **锁内重读 + 末引用复核**(矩阵 §1,锁内防「读后改」):重读 scan 行,若状态已非 active → 回到第 2 步三分支收敛。然后按 `(asset_id, file_id)` 双查:
   - R1 活 evidence 行(`evidenceRowsForFile` 同款)任一存在 → **有引用**;
   - R2 其他仍保留视频的 scan(同 asset/file、`_id ≠ 本行`、status ∈ {active, location_deleted} 且未回收)存在 → **有引用**(现网两 scan 不共享文件——每次 begin 签发独立 asset/路径——此检查是防御位,护未来共享);
   - R3 未结算票据(pending/binding/cleaning/cancelling,按 asset/file 命中)存在 → **有引用**(例:同一段提交仍在途重试)。
5. **无引用 → 先云删文件,成功才终结**:`deleteFilesStrict(deps, [file_id])`(status 0 或 **-503003 均为成功**,dangling 文件不存在按成功,幂等);失败 → **scan 保持 active 不落任何状态**,返回 `VIDEO_DELETE_FAILED` + `failed_file_ids`,客户端可重试(整序列无状态残留,重试从第 1 步重跑)。
6. **终结(条件更新)**:`where({ _id, household_id, status:"active" }).update({ status:"deleted", deleted_at: now, deleted_by:"user", updated_at: now })`;0 命中(并发 deleteLocation 抢先迁移)→ 重读走第 2 步三分支(location_deleted → NOT_FOUND;已用户删 → replayed)。
7. **best-effort 票据收口**:终结成功后,将 scan 的 `upload_ticket`(bound 态)`markTicketsDeleted(reason:"scan_deleted")`(`video.js:395-411` 既有函数,best-effort,失败不回滚不假报——票据残留 bound 无害:矩阵 R 中 bound 不占引用,旧提交重试被 §6 门拒)。
8. **绝不动物品/evidence/其他 scan**:全序列对 `items`/`video_evidence`/其他 scan 行零写入(§7 有断言测试钉住)。删除影响面 = scan 审计行状态 + (无引用时)云文件,仅此而已。

**确认弹层影响面预告文案(客户端,冻结自 issue #96)**:「只删这条清点记录,不影响已录入的物品和它们的视频证据;若这段视频没有其他引用,将一并删除视频文件。」

---

## 5. (e) `videoCleanup` 0 确认到期回收契约(增补第三阶段)

在既有两阶段(`recoverIntermediate` → `cleanupExpiredPending`,`handler.js:232-253`)之后新增 `reclaimZeroConfirmScans(deps, now)`,同一 `deps.now` 可控时钟。

**候选查询**(分页护栏同 `collectByStatus`:页 100 × 至多 100 页):

- where 仅按 `status ∈ {"active", "location_deleted"}`(**两条各查一次后合并**;status 等值匹配在 memoryDb(严格 `!==`,缺失不匹配)与真实库语义一致,可安全入 where)。
- **以下过滤一律函数内做,不进 where**(memoryDb 与真实库对字段缺失/数值零的等值查询语义有实现差异面,memoryDb `matches` 是严格全等 `memoryDb.js:44-52`;函数内过滤两端行为恒一致,`markSubtreeScans` 函数内子树过滤先例 `locations/lib/handler.js:1270-1271`):
  - `Number.isInteger(confirmed_count) && confirmed_count === 0`;
  - `video_reclaimed_at` 缺失或空串(等值查询表达不了「不存在」);
  - `Date.parse(created_at) <= nowMs - RETAIN_MS`,**`RETAIN_MS = 30 × 24h`(裁定采纳的默认阈值,改阈值由 Owner 另裁)**——恰好满 30 天即候选,**29 天不收**(边界含端点,§7 可控时钟钉住);
  - `file_id` 为非空字符串(无文件行的 scan 无从回收,跳过)。
- **`deleted` 行不进候选集**(一期冻结范围:active 与 location_deleted;purge 终态行的文件处置见 §9 开放问题)。

**单候选处理序列(逐行串行)**:

1. **单轮批上限 `RECLAIM_BATCH_MAX = 50`**(冻结常量):超出的候选留给下一次每日运行——保证 20 秒函数超时(README 既有口径)内完成(每行 1 锁 + ≤5 次查询 + ≤1 次云删,50 行最坏仍在秒级)。
2. **asset 锁**:videoCleanup 与 itemsApi 是两个部署包,不能 require `video.js`——在 `videoCleanup/lib/` 内做一份 `acquireNamedLock` 等价实现(≤40 行,同 `video_item_locks` 集合、同 `_id=val_<asset_id>`、同 owner_token+60s TTL CAS 语义;两份实现互指注释,已知双实现债务,与 itemsApi 子树副本同款处理,D1 报告 §7.1 先例)。asset_id 缺失用 file_id 稳定摘要 legacy 键。抢锁失败 → 计 skipped,下一行。
3. **锁内重读复核**:scan 行仍为候选状态(原 status、仍 0 确认、仍超期、未回收、file_id 未变)——挡「候选查询与抢锁之间被 scanDelete 删除/被 commit 自愈改计数」。复核不过 → 跳过。
4. **锁内末引用复核**(矩阵 §1):R1 任一 evidence 行 / R2 其他仍保留视频的 scan(排除本行)/ R3 未结算票据 → **有引用,跳过**(行原样,不计失败——例:同文件提交仍在途,留下次)。
5. **无引用 → 先云删**:`deleteStrict(file_id)`(既有逐文件助手,status 0/-503003 成功,`handler.js:16-31`);失败 → **留待下次**(scan 不落任何标记,计 failed,继续下一行;不假报成功)。
6. **云删成功 → 条件置回收标记**:`where({ _id, household_id, status: <原 status> }).update({ video_reclaimed_at: now, video_reclaim_reason:"zero_confirm_expired", updated_at: now })`——**status 不迁移、`created_at`/`candidate_count`/`confirmed_count` 一概不动**(约束 3;行保留 = 清点发生过的事实保留)。0 命中(并发状态迁移)→ 跳过不追改。
7. best-effort:scan 的 bound 票据置 `deleted` + `cleanup_reason:"scan_reclaimed"`(失败不影响回收事实,理由同 §4 第 7 步)。

**读侧呈现**:回收后行仍在历史/Latest(status 未变),`video_reclaimed:true` + `video_url:""`,客户端显示「视频已过期回收」(§2、§8)。

**`scanRefsTicket` 同步收紧**(§1):24h 孤儿回收与中间态恢复的 scan 引用复核从「任意行存在」改为 R2 语义——0 确认 scan 未到期(绝大多数)仍持引用、行为与 D1 测试期望一致;已终结/已回收行不再永久挡住文件回收。**fail-closed 纪律不变**:引用查询抛异常 → 视为有引用,不删(现有 try/catch 语义,`handler.js:127-134`)。

---

## 6. (f) `upsertLocationScan` 防复活规则(约束 4)

**问题**:`video.js:1459-1468` 的自愈分支对已有 scan 无条件更新计数——用户已删/位置已终结/视频已回收的 scan 会被旧 sceneCommit 重试重新「激活」(写 updated_at、回复计数),且若未来自愈扩展,存在重新引用已删文件的面。**两道门,收敛到同一裁定**:

1. **早门(commit 主流程,票据 CAS 之前的零写段,与 `resolveLocationContext` 同段)**:`event.location` 存在时,按 `(household_id, scan_id)` 查 scan;查得且(`status !== "active"` **或** `video_reclaimed_at` 已置位)→ **整批零写返回 `OPERATION_CONFLICT`**(与 scan_id 复用硬门 `video.js:1452-1458` 同码同义:scan_id 的生命周期已终结,旧提交不得复活)。查无或正常 active → 照常。
2. **锁内兜底门(`upsertLocationScan` 自身)**:进入自愈分支前重判 `status === "active" && 未回收`;不满足 → `OPERATION_CONFLICT`(挡「早门与落库之间」的并发删除/回收)。满足 → D1 自愈行为**逐字节不变**(confirmed 重查活证据、candidate 取 max、duplicated:true)——D1 已验收的重试收敛(`D1-IDEMPOTENT`/`D1-PARTIAL-HEAL`)零回归。

**返回什么(冻结)**:两类重试遇到已终结/已回收 scan 一律 `OPERATION_CONFLICT`(客户端把该会话视为不可重试,丢弃 pending 会话;不返回 NOT_FOUND——scan_id 存在但生命周期冲突,与「复用到另一段视频」的硬门同族)。

**并发收敛推演**(实现须以 §7 测试钉住):scanDelete 与旧 commit 重试争同一 scan——commit 早门在无锁段,可能读到 active 放行,随后 scanDelete 抢到 asset 锁完成删除;commit 后续在锁内(与 scanDelete 同一把 asset 锁互斥)落 scan 时撞兜底门 → `OPERATION_CONFLICT`,此前已幂等的 item/evidence 写入均为重放(duplicated),无新增文件引用;若 commit 先持锁,scanDelete 排队后仍从 status 门收敛。**结果唯一:scan 不复活、文件不被已删 scan 重新引用。**

**ticket 侧自然收敛**:scanDelete/回收把 bound 票据置 deleted 后,`claimSceneTicket` 对 cancelled/deleted 直接 `VIDEO_TICKET_EXPIRED`(`video.js:1148-1149`),旧重试在票据段即被拒——best-effort 收口是复活路径上的又一层冗余防御,不是唯一防线。

---

## 7. (g) 反例测试矩阵(逐条可测;文件与命名沿用 D1 风格)

离线单测(复用 `tests/helpers/memoryDb.js`;location_scans 唯一索引声明已在 `freshDb()` 先例);可控时钟:itemsApi 测试用 `makeDeps` 的 `advance`(`tests/location-scan-read.test.js:28-30`),videoCleanup 用 `now: () => NOW` 注入(`tests/video-cleanup.test.js:44-49`)。

**A. 历史列表(`tests/location-scan-history.test.js` 新文件)**

| 用例 | 断言要点 |
| --- | --- |
| HIST-BASIC | 多行 created_at 倒序;投影字段白名单(无 file_id/asset_id/upload_ticket/confirmed_item_ids) |
| HIST-SCOPE | 只列本 location_id:子位置与其他位置的 scan 不出现 |
| HIST-STATUS | 只列 active:location_deleted/deleted 行不出现 |
| HIST-LIMIT | 第 21 行起截断:scans=20、has_more:true;恰好 20 行 → has_more:false |
| HIST-RECLAIMED | video_reclaimed_at 置位行:`video_reclaimed:true` + `video_url:""` 且不参与换链调用 |
| HIST-URL-DEGRADE | getTempFileUrls 抛异常/单链接缺失:仅该行 `video_url:""`,列表与其余行照常(不废列表) |
| HIST-EMPTY | 无记录 → `{ scans:[], has_more:false }`;他家 location_id → 空列表(隔离) |
| HIST-SHAPE | location_id 缺失/超长 → INVALID_INPUT |

**B. 用户删除(`tests/location-scan-delete.test.js` 新文件)**

| 用例 | 断言要点 |
| --- | --- |
| DEL-NO-REF-FILE-GONE | 全无引用:云删 status 0 → 文件被删、scan → deleted+deleted_at+deleted_by:"user";`video_deleted:true` |
| DEL-REF-EVIDENCE | 有活 evidence 行:只标 scan,云文件不删、evidence 行零变化 |
| DEL-REF-OTHER-SCAN | 有其他仍保留视频的 scan:同上(防御位) |
| DEL-REF-UNSETTLED-TICKET | 有 pending/binding 票据:只终结 scan,文件留下次由票据路径收敛 |
| DEL-DANGLING | 文件已随物品证据删除(-503003):按成功,scan 终结;重放 `replayed:true` |
| DEL-CLOUD-FAIL | 云删返回 -1:scan 保持 active 零字段变化,VIDEO_DELETE_FAILED + failed_file_ids;重试(修好删除)后成功 |
| DEL-IDEMPOTENT-REPLAY | 成功后同参重试:`replayed:true`;双击并发第二请求收敛到 replayed |
| DEL-STATUS-GATE | location_deleted / purge-deleted 行 → NOT_FOUND;不存在的 scan_id → NOT_FOUND |
| DEL-CROSS-HOUSEHOLD | 他家 scan_id(在本家庭查无)→ NOT_FOUND,零写入 |
| DEL-NO-COLLATERAL | 删除前后 items/video_evidence/其他 scan 文档逐字段 diff 为空(绝不动物品/evidence/其他 scan) |
| DEL-BUSY | asset 锁被占 → VIDEO_ITEM_BUSY,scan 原样 |
| DEL-LATEST-SKIP | 删除最新一条后 locationScanLatest 跳到下一条 active;全删完 → scan:null |
| DEL-RECLAIMED-THEN-DELETE | 已回收(active+video_reclaimed_at)行删除:走 dangling 分支成功终态 |
| DEL-CONCURRENT-LOCATION | scanDelete vs deleteLocation 交错:条件更新收敛,二者必有一胜、无中间态 |

**C. 0 确认到期回收(`tests/video-cleanup.test.js` 增例)**

| 用例 | 断言要点 |
| --- | --- |
| RC-29D / RC-30D | 恰好 29 天不收、恰好 30 天收(可控时钟 `created_at = now - 29d/30d`,边界含端点) |
| RC-CONFIRMED | confirmed_count ≥ 1:永不进候选(哪怕超期) |
| RC-NO-DOUBLE | 已置 video_reclaimed_at:不重复处理 |
| RC-KEEP-ROW-AND-COUNTS | 回收后:行仍在、status 不变(active 或 location_deleted 均验)、created_at/candidate_count/confirmed_count 逐字节不变,仅新增 video_reclaimed_at/video_reclaim_reason/updated_at |
| RC-REF-EVIDENCE / RC-REF-OTHER-SCAN / RC-REF-TICKET | 有 R1/R2/R3 引用:跳过不删文件、不置标记(留下次) |
| RC-CLOUD-FAIL | 云删失败:scan 无任何标记,计 failed;下一轮(时钟再进)重试成功 |
| RC-LOC-DELETED | location_deleted 0 确认超期行:同策回收(页面不可见不滞留) |
| RC-DELETED-EXCLUDED | 终态 deleted 行:不进候选(冻结范围) |
| RC-BATCH-CAP | 51 条候选:单轮只处理 50,stats 如实计剩余 |
| RC-LOCK-BUSY | asset 锁被占:skipped,下一行;行原样 |
| RC-B-REGRESSION | 既有 9 例(CLEANUP-*)全绿;scan 未到期时 D1 三例(D1-SCAN/FILE-ONLY/NO-SCAN)行为不变 |

**D. 防复活(`tests/location-scan-commit.test.js` 增例)**

| 用例 | 断言要点 |
| --- | --- |
| RES-USER-DELETED | 用户已删 scan 的旧 commit 重试:OPERATION_CONFLICT,scan 不复活(deleted_by 仍 "user"、updated_at 不被改写)、不重新引用文件 |
| RES-RECLAIMED | 已回收 scan 的旧重试:OPERATION_CONFLICT,video_reclaimed_at 不被清 |
| RES-LOC-DELETED | location_deleted scan 的旧重试:OPERATION_CONFLICT 零写 |
| RES-PARTIAL-AFTER-DELETE | 部分失败 commit → scanDelete → 旧重试:已成功件全 duplicated、不新增 evidence 引用已删 scan 的文件、scan 终态保持 |
| RES-NORMAL-HEAL-KEPT | 正常 active 未回收 scan 的部分失败重试:D1 自愈行为不变(D1-PARTIAL-HEAL 复跑不红) |
| RES-EARLY-GATE-ZERO-WRITE | 早门命中:items/evidence/tickets/scan 全集合零写入 |

**E. 读侧与 Latest 降级(`tests/location-scan-read.test.js` 增例)**

| 用例 | 断言要点 |
| --- | --- |
| LATEST-RECLAIMED | Latest 对已回收最新行:video_reclaimed:true + video_url:""(不调换链) |
| LATEST-DANGLING | evidence 全删光的 scan:LATEST/HIST 换链失败 `video_url:""` 不废查询(D1 行为 + 历史同款,钉住) |
| LATEST-CROSS-HH | 他家 location_id:scan:null(既有)+ 历史空列表 |

**F. B/D1 零感知回归(硬门)**:`tests/video-scene*.test.js` 四件零修改通过;`npm test` 基线 986 + 本矩阵全绿;`npm run typecheck`、改 `.ts` 后 `npm run build:mp`。

---

## 8. 客户端契约(位置页增量;首页零改动)

- **历史入口**:入口卡(`locations.wxml:120-132`)第二行摘要区新增「历史」入口(browse 且非根层、有 scan 摘要时可见;具体为摘要行右侧文字按钮或点摘要展开,实现 PR 定,冻结的是行为:点开 → 半屏弹层加载 `locationScanHistory`,requestSeq 迟到守卫复用 `loadScanSummary` 同款)。
- **列表**:每行 时间 / 候选 N / 确认 M / 回看;`has_more:true` 顶部标「仅显示最近 20 次」;空态文案「这里还没有清点记录」;行删除入口(行内「删」,实现 PR 定样式)。
- **回看**:行内 `video_url` 直接播放(不自动播放,复用回看交互);`video_reclaimed:true` → 行显示「视频已过期回收」,无回看入口;`video_url:""` 且未回收 → 「视频已随物品证据删除」,无回看入口——两种降级都不废列表。
- **删除确认弹层**:自定义半屏弹层(deleteLayer 先例,`locations.wxml:134-156` 风格),文案冻结为 §4 影响面预告;确认 → `scanDelete`。
- **失败重试提示**:`VIDEO_DELETE_FAILED` → toast「删除失败,请重试」+ 行保留可再删;`VIDEO_ITEM_BUSY` → 「操作冲突,请稍后再试」;`NOT_FOUND`(他端已删/位置流程已终结)→ 刷新列表收敛,不报错。
- **首页零改动**(`pages/index` 空 diff 断言,沿用 D1 验收口径)。
- **实现纪律(仓库已知坑)**:改 `.ts` 必须 `npm run build:mp` 产同名 `.js` 一并提交;Page 类字段与 `data` 双块新增状态字段加对位置;wxml 标签严格配对(历史两次 view 误闭 button 致包编译被拒——改 wxml 必过 `cli upload` 编译);几何尺寸 JS 计算 px 喂 inline,不用 aspect-ratio/min/calc/vh。

---

## 9. (h) 部署清单与开放问题

**部署(人工收口,开发 agent 只开 PR)**:

1. **itemsApi 重部署**(scanDelete、locationScanHistory、Latest 的 video_reclaimed 投影、upsert 防复活两道门、`locationScanRefExists` 收紧)——建议 10 秒超时维持。
2. **videoCleanup 重部署**(第三阶段到期回收、`scanRefsTicket` 收紧、包内 asset 锁副本)——20 秒超时维持(批上限 50 保证)。**顺序:先 itemsApi 后 videoCleanup**(防复活门先于回收标记上线,旧 itemsApi 不认识 `video_reclaimed_at` 的窗口不存在——回收只在 itemsApi 已含门之后开始置位)。
3. **locations 不动**(`markSubtreeScans`/`deleteLocation` 零改动;`deleted_by` 缺省即非用户删的口径使然)。
4. **小程序包整传**(位置页 wxml/wxss/ts/js + types/api 增量;`.ts` 先 `build:mp`)。
5. **无新集合、无新索引、无新环境变量**:历史查询复用既有非唯一索引 `(household_id, location_id, created_at)`(函数内倒序+截断);回收候选查询按 status 全表分页(与 `collectByStatus` 同款,量级 = scan 行数,远小于票据;真扛不住再评估增补索引,不在本期)。
6. **README 步骤 4⑨ 口径同步**:「0 确认 scan 的视频不会被 videoCleanup 的 24h 孤儿回收……scan 的用户主动删除与清点历史列表留 D2」一句改为 D2 后事实——0 确认视频保留 30 天后由 videoCleanup 到期回收(行保留、计数不动);scan 可在位置页历史中用户删除;其余(集合/索引/权限步骤)零变化。

**开放问题(留 Owner 裁决,实现不擅自处理)**:

1. **purge 终态 `deleted` 的 0 确认行视频文件**:一期回收候选冻结为 active 与 location_deleted(裁定原文枚举);purge 已把行置 deleted 后,其 0 确认视频(无 evidence、票据 bound、无持有 scan)在任何路径下都不会被删——是一处已知滞留。若 Owner 要求收口,只需把回收候选的 status 集扩到 `deleted`(同一序列零新逻辑),本文 §5/§7 各加一行即可。

**工作流约束(裁定原文,重申)**:零新增模型调用;不扩张通用事务框架;只开 PR,不合并、不部署;验收门禁 = 本契约 + 反例测试先行,随后最小实现,全量 `npm test`/`typecheck`/`build:mp` + 小程序编译 + 真实云端删除/回收 + 真机历史/弱网逐项报数(不能仅凭离线测试上线)。
