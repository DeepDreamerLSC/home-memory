# D1 实现说明:位置级视频清点与多物品录入(issue #94)

状态:实现蓝图(架构定案)。上游:#94 产品决策已冻结;PR B(#91,分支 `feat/issue94-d1-location-scan` = B head,commit `969298c`)为本实现的代码基线。本文把 #94 的合同落成可执行说明,并对其「待实现时确认的技术点」逐条定案。

基线事实(本文引用的代码都在 B head):
- B 的场景提交链路:`cloudfunctions/itemsApi/lib/video.js:1138`(`videoSceneCommit`),票据 `videoUploadBegin` scene 分支 `video.js:610-664`,共享证据删除与锁序 `video.js:407-515`(`removeEvidenceRows`)、`video.js:524-608`(`cleanupForItem`)。
- B 的客户端原语:`miniprogram/utils/video-scene.ts`(`scanSceneVideo`/draft/split/merge/`buildSceneCommitItems`),确认页 `miniprogram/pages/video-scan/video-scan.ts`。
- 位置域:`cloudfunctions/locations/lib/handler.js`(list/ensurePath/rename/move/merge/delete/linkItem/unlinkItem/applyScan/ensureAndLink),子树工具 `cloudfunctions/locations/lib/tree.js:39`(`collectSubtree`),物品挂载的版本条件更新纪律 `locations/lib/handler.js:379-422`(`conditionalMountUpdate`,三重重放识别 `handler.js:109-115`)。
- 位置页(即 #94 所说「位置页」):`miniprogram/pages/locations/locations.ts`(browse/pick 双模式;根层有「生成 / 更新空间树」入口指向 A/C 时代的 `pages/locationScan/locationScan` 语音整理向导——那是**位置树生成**入口,不是 D1 的视频清点入口;D1 新入口独立新增,不复用该页)。
- 物品软删级联(证据行删除 + 末引用才删云文件 + 提醒级联):`cloudfunctions/itemsApi/lib/handler.js:1161-1210`(`deleteItem` → `cleanupForItem`);`cloudfunctions/videoCleanup/lib/handler.js`(票据回收的引用复核)。
- 基线测试:本分支 `node --test tests/video-scene.test.js tests/video-scene-share.test.js tests/video-scene-client.test.js tests/video-scene-page.test.js` 25/25 通过(2026-10-20 实测)。这四件是 D1「不带位置参数 = B 零感知」的回归护栏,实现 PR 必须保持其零修改通过。

---

## 1. 两个技术点定案(#94「待实现时确认」)

### 定案 ①:`location_scans` 独立集合(不内嵌 evidence、不复用票据)

**结论:新建独立集合 `location_scans`,evidence 行只增写一个普通字段 `scan_id` 做关联。**

理由(基于 B 的 evidence 实际形态):

1. **基数不同**。B 的 `video_evidence` 行键是 `(household_id, item_id, file_id)`(`tests/video-scene.test.js:28` 的唯一索引声明),一行 = 一件物品的一段证据;一次位置清点 = 一条 scan 对 N 行 evidence(每件确认物品一行,`video.js:1012-1029` `saveSceneEvidence`)。`candidate_count`/`confirmed_count`/`confirmed_item_ids`/`status` 是**每视频**属性,内嵌意味着同值字段复制到 N 行,且位置删除时要把状态翻新写进 N 行——而那 N 行分属不同 item、受 item 锁与 highlight CAS 保护(`video.js:1340-1448`),批量改写等于在删除位置流程里重新穿一遍锁序,违反 B 已冻结的锁序决议(docs/design/video-ai/PR-B-DESIGN.md L254:所有 item 锁升序 → asset 锁)。
2. **零确认会话无处可嵌**。#94 要求「每次位置拍摄生成一条 `location_scan` 记录」;用户录了视频、AI 有候选但一件都没确认时 evidence 行数为 0,内嵌方案该记录不存在。独立集合天然覆盖。
3. **生命周期不同**。evidence 行的删除受末引用规则约束(删物品才级联);scan 行的生命周期跟**位置**走(`active → location_deleted / deleted`),由删除位置流程按 `location_id` 子树批量标记——独立集合里这是一次按索引的条件 update,内嵌则无解。
4. **不复用 `video_upload_tickets`**。scene 票据已有 `scene_id/asset_id/duration_ms/video_w/video_h/scene_evidence_count`(`video.js:639-655`),但它是 15 分钟 TTL 的**操作状态机**(pending/binding/bound/cancelled/deleted,由 `videoCleanup` 每日回收),把产品记录塞进会被清理翻转状态的文档里,审计字段保不住。

新增索引(生产环境随实现 PR 的部署说明一并创建):
- `location_scans` 唯一索引 `(household_id, scan_id)`(幂等键,见定案②;memoryDb 测试里按 `tests/helpers/memoryDb.js` 的 `uniqueIndexes` 声明);
- `location_scans` 非唯一 `(household_id, location_id, created_at)`(位置页「上次清点」最新一条查询);
- `video_evidence` 增补非唯一 `(household_id, scan_id)`(后续 AI 语音查询 join 用,D1 只写不查)。

### 定案 ②:`scan_id` 客户端生成 + 服务端幂等(与 B 的 commit 幂等键对齐)

**结论:客户端在开拍会话生成一个 uuid 作为 `scan_id`,它同时就是 B 票据的 `scene_id`;服务端以 `(household_id, scan_id)` 为幂等键落 `location_scans`。**

理由:

1. B 的幂等链已经这样工作:`scene_id` 由客户端生成(8-64,`video.js:23-24`),在 `videoUploadBegin(purpose:"scene")` 时绑进票据(`video.js:643`),commit 时服务端校验 `ticket.scene_id !== event.scene_id → OPERATION_CONFLICT`(`video.js:1161`)。D1 的 scan 与 scene 是同一次拍摄的两个视角,再用服务端生成会引入第二个 id 与一次额外的往返对齐,且服务端生成无法覆盖「客户端上传中断后重试收敛」——B 用本地 pending 会话(`video-scan.ts:34-35` 的 storage key)携带冻结载荷重试,幂等键必须在客户端手里。
2. 落库幂等复用仓库既有模式:`ensureHomeRoot`/`createItem` 的「唯一索引拒绝并发插入 → E11000 回查复用」(`locations/lib/handler.js:170-206`、`itemsApi/lib/handler.js` createItem 的 catch 分支);同键同内容 → `duplicated:true` 稳定返回,同键异内容 → `OPERATION_CONFLICT`,与 B 的 `scene_payload_sig` 语义(`video.js:1176-1177`)一致。
3. `location_scans._id` 仍为服务端 `ls_ + genId()`(#94 字段表如此),客户端 `scan_id` 是幂等键字段,两者并存——与「票据 `_id=vt_...` 服务端生成 / `scene_id` 客户端生成」完全同构。

#94 其余两个待确认点随文定案:
- **子位置选择必须从现有位置树选**(服务端逐件校验 node 在 `location_id` 子树内,见 §2);D1 不落「只有文本快照的悬空位置」——位置树已是系统内唯一结构事实源(`locations` 唯一建节点入口 `ensurePathSegments`),允许文本悬空会重造「未归位」问题。
- **location_text 最终一致性策略**:物品的 `location_text` 是「用户最近一次明确声明的位置文本」——只在用户显式改口时更新(D1 视频移动、itemsApi.update),结构性操作(rename/move/merge/删除迁移)**永不改写**它(现状即如此:`locations` 的 rename/move/merge 注释明确「绝不碰 items」);物品「当前在哪」的真值是挂载 `location_node_id` 的树路径,历史位置只活在证据行的 `captured_location_text`(创建时冻结,`video.js:829/1021`)。

---

## 2. 服务端契约(itemsApi 增量,全部为可选参数、不带即 B 现行为)

### 2.1 `videoSceneCommit` 增量参数

```
event.location = {                      // 可选;缺省 = B 现行为,全部新逻辑零感知
  location_id: string,                  // lc_...,必填
  scan_id: string,                      // 8-64 客户端 uuid;必须 === event.scene_id === ticket.scene_id
  path_snapshot: string[],              // 1-6 段,每段去首尾空白 1-30 码点(形状门;落库以服务端查到的节点 path 为准)
  text_snapshot: string                 // 必须 === path_snapshot.join(" / ")
}
event.candidate_count: number           // 可选,0-500 整数;客户端观察线索数,落 scan 行
items[i].node_id: string                // 可选,仅 target:"new";新物品目标节点,缺省 = location.location_id
items[i].move_to_node_id: string        // 可选,仅 target:"existing";用户显式选择「移动到当前位置」
items[i].expected_version: number       // 必填当且仅当 move_to_node_id 出现(来自匹配列表读到的物品版本)
```

规则:

1. **形状校验先于一切读写**(B 同款「纯参数错误整批零写」)。`location` 存在时:`scene_id` 三方一致、`text_snapshot === join(path_snapshot)`、`node_id/move_to_node_id` 形状合法、`expected_version` 正整数。
2. **location_id 归属与子树校验**(读 DB,仍在票据 CAS 之前,保证非法输入零写):按 `{ _id, household_id }` 查 `locations` 集合(跨家庭查不到 → `NOT_FOUND`,与 `findNodeById` 同语义 `locations/lib/handler.js:216-220`);拉本家庭全部节点,`collectSubtree` 同款算法(在 itemsApi 内做一份 ≤30 行的等价实现,理由:两个函数各自独立部署包,不能互相 require;`locations` 读 `items` 集合的先例已存在 `locations/lib/handler.js:162-164`,反向对称;算法等价性由 §7 的测试保证);逐件校验 `node_id`/`move_to_node_id` ∈ subtree(location_id)(含自身)。任何一件越界 → `INVALID_INPUT` + `detail:{ out_of_subtree: [draft_key...] }`,整批零写。
3. **target:"new" 的 `location_text` 改为服务端权威**:D1 行要求客户端传的 `location_text` === 目标节点 path.join(" / ")(校验不一致 → `INVALID_INPUT` 零写)。B 的字段形状不变,但来源从自由文本变为树路径,消除双份真相。
4. **载荷签名扩展**:`scenePayloadSignature`(`video.js:988`)的 canonical 输入在 `location` 存在时追加 `{ location_id, scan_id, path_snapshot, node_id[], move_to_node_id[] }`;**`location` 缺省时签名逐字节与 B 相同**(B 客户端永远不发 `location`,其票据签名与重试收敛行为不变——这是「零感知」的硬保证,由回归测试锁定)。同一票据先无位置后有位置(或反之)→ 签名失配 → `OPERATION_CONFLICT`,杜绝混合模式重试。

### 2.2 commit 主流程增量(在 B 既有骨架上的插入点)

B 的流程(`video.js:1138-1294`)保持不变:校验 → 票据可用性(`verifyFile`)→ 签名 → `claimSceneTicket` → 逐件建档/解析 → item 锁(item_id 升序)→ asset 锁 → 逐件 `saveSceneEvidence` → 票据 bound 收口。D1 插入:

1. **evidence 行增写 `scan_id`**(`saveSceneEvidence` 的 doc 增一个字段,`video.js:1012-1029`;`same` 判定 `video.js:1000-1008` 增补 `scan_id` 相等条件——同 item+file 但 scan_id 不同 → 维持现 `OPERATION_CONFLICT` 路径)。读侧投影 `projectEvidence`(`video.js:249-267`)增 `scan_id`(可 `""`,旧行无此字段)。
2. **target:"existing" 且带 `move_to_node_id`(显式移动)→ 移动先于证据**。顺序理由:#94 把「移动到当前位置并关联」定义为一个用户批准的捆绑动作;若先存证据再移动失败,结果是用户未同意的「只关联」,违背显式确认原则。实现:持 item 锁后(锁内重读物品,`video.js:1242-1247` 同款),做一次 `itemsApi.update` 同构的版本条件更新(参照 `itemsApi/lib/handler.js:1072-1158` 的 CAS + 三重重放识别,以及 `locations` 的 `conditionalMountUpdate` 纪律):写 `{ location_text: 目标节点 path.join(" / "), location_node_id, version: expected+1, updated_at, last_update_id, last_update_fingerprint }`;`update_id = "d1move:" + sha256Hex(scan_id + ":" + item_id)`(确定性,响应丢失重试可被重放识别);fingerprint 只覆盖两个内容字段。0 命中回查三态:已在目标节点(幂等收敛,`already`)/ 三重条件命中(`replayed`)/ 否则 `VERSION_CONFLICT`——冲突时**该件不写 evidence**,results 行 `{ ok:false, error:"VERSION_CONFLICT", moved:false }`,其余件照常(B 的部分失败语义天然支持);客户端刷新物品版本后整批同载荷重试,已成功件 `duplicated` 收敛。
3. **target:"new" → 建档后挂载**。`h.createItem`(B 语义不变,operation_id 幂等)得到 version=1 的新物品后,用同款条件更新挂 `location_node_id = node_id`(`update_id = "d1mount:" + sha256Hex(scan_id + ":" + item_id)`,expected_version=1)。与移动的差别:新物品是本请求刚建的,挂载失败(并发编辑的理论窗口)不推翻「物品已按正确 location_text 建档 + 证据已存」的事实——evidence 照存,results 行标 `mounted:false, mount_error:"VERSION_CONFLICT"`,用户可后续手动挂载;绝不删物品。**验收「新物品能正确归档到目标位置」由挂载实现**:不挂载的新物品会掉进根层「尚未归类」(`locations` list 的 unmounted 口径,`locations/lib/handler.js:507-508`),与 D1 目标相悖。
4. **`location_scans` 落库(锁内、逐件循环之后)**。按 `(household_id, scan_id)` 查已有:
   - 无 → add。文档字段(#94 全集 + 实现增补):
     ```
     _id: "ls_" + genId(), household_id,
     scan_id(客户端 uuid,幂等键),
     location_id, location_path_snapshot(服务端查到的节点 path), location_text_snapshot,
     file_id, asset_id, upload_ticket, duration_ms, video_w, video_h,
     candidate_count, confirmed_count, confirmed_item_ids[],
     created_at, updated_at, status: "active"
     ```
     E11000(唯一索引并发)→ 回查走下一分支。
   - 已有且 `file_id/asset_id/location_id` 一致 → **以活证据自愈式更新**:`confirmed_item_ids` 不取自载荷,而是重新查询 `evidenceRowsForFile(ticket.file_id, ticket.asset_id)`(`video.js:326-347`)中 scan_id 相等、且 item_id ∈ 本次提交 item 集合的行——部分失败重试后第二次 commit 会把补齐的证据计入,`confirmed_count` 自然收敛;`candidate_count` 取 `max(旧值, 新值)`。返回 `duplicated:true`。
   - 已有但 `file_id/asset_id/location_id` 不一致 → `OPERATION_CONFLICT`(scan_id 被复用到另一段视频,客户端 bug 硬门)。
   - 零确认件也落 scan(`confirmed_count:0`)——「每次位置拍摄生成一条记录」;此时票据 `scene_partial_at` 分支(`video.js:1274-1277`)不变。
5. **响应增量**(仅 `location` 存在时):顶层 `scan: { scan_id, location_id, status:"active", confirmed_count, evidence_failed }`;results 行增 `node_id`、`mounted?`、`move?: "moved"|"already"|"replayed"`。

### 2.3 新只读 action:`locationScanLatest`(itemsApi)

```
{ action:"locationScanLatest", location_id }
→ { ok, scan: { scan_id, location_id, created_at, candidate_count, confirmed_count,
                confirmed_item_ids, duration_ms },
    video_url,                      // getTempFileUrls 临时链接;换链失败 "" 不废查询(B 同款)
    items: [{ item_id, name, location_text }] }   // 只列仍存活的确认物品;scan.confirmed_count 仍是原始数
```
查询:`location_scans` where `{ household_id, location_id, status:"active" }` 按 `created_at` 倒序取 1。无记录 → `{ ok:true, scan:null }`。位置页「上次清点」摘要与回看共用这一次调用(不进 `locations.list`,避免树接口背视频依赖;`getTempFileUrls` 只在 itemsApi 有 dep 先例 `video.js:883-894`)。

### 2.4 删除路径对 scan 的引用感知(沿用 B 锁序)

- `videoUploadCancel`(`video.js:896-958`)与 `videoCleanup` 的「证据引用复核」(`videoCleanup/lib/handler.js:36-58` `evidenceRefsTicket`)各**增补一次 `location_scans` 按 `asset_id`/`file_id` 的查询**:任一 scan 行存在即视为有引用,不删云文件。理由:commit 已落 scan 但 0 件证据成功的会话,其视频就是该 scan 的回看内容,24h 孤儿回收不得删它。反之 cancel 发生在 commit 之前(scan 尚不存在)→ 行为与 B 完全一致。
- 物品删除/证据删除(`removeEvidenceRows`/`cleanupForItem`)的末引用判定**不含** scan 行:evidence 行才是物品-文件关系;scan 行随位置删除流程终结(§5)。边界情形「scan 存在、其全部 evidence 行已被逐件删光」→ 云文件可能已被末引用删除,`locationScanLatest` 换链失败返回 `video_url:""`,客户端显示「视频已随物品证据删除」,scan 行保留审计。此边界在 D1 只读不写,D2 若做 scan 管理再收口。

### 2.5 幂等与部分失败重试语义(汇总)

| 场景 | 语义 |
| --- | --- |
| commit 网络失败,客户端同冻结载荷重试 | 票据签名一致 → 放行;建档 `operation_id` 幂等;evidence `saveSceneEvidence` duplicated;移动/挂载 `last_update_id` 三重重放识别;scan `(household_id, scan_id)` duplicated + 计数自愈 |
| 同票据换载荷重试 | `scene_payload_sig` 失配 → `OPERATION_CONFLICT`(B 现行为,签名扩展后覆盖位置上下文) |
| 单件移动版本冲突 | 该件 `{ok:false, VERSION_CONFLICT}`、不写 evidence;其余件照常;票据至少一条证据成功即 bound(B 现行为) |
| 进程死于「证据已写、scan 未写」 | 重试补 scan;若永不重试,evidence 行存在 → 文件不会被回收(§2.4),scan 缺失只是「上次清点」不显示,无数据损坏 |
| 全部件失败、用户放弃 | `videoUploadCancel`:无 scan(未写)→ 按 B 删文件;有 scan → bound 态保留 |

---

## 3. 已有物品匹配:五级顺序 + 归一化(纯客户端,新增 `miniprogram/utils/item-match.ts`)

**匹配池来源**:D1 页面 onLoad 一次调用新只读 action `locationScanContext { location_id }`(itemsApi,复用 §2.2 的子树实现),返回:
```
{ subtree: [{ location_id, name, path, parent_id }],          // collectSubtree 投影,含自身
  subtree_items: [{ item_id, name, location_node_id, location_text, version }],   // 挂载在子树内的未删物品
  household_items: [...同投影],                                // 全家庭未删物品,updated_at 倒序截断 200,附 truncated 标志
}
```
`truncated:true` 时匹配建议列表顶部如实标注「物品较多,建议只参考同名精确匹配」。纯服务端读取,无写门。

**归一化(与 `locations/lib/normalize.js` 的精神一致,但客户端独立实现,不改云函数)**:
```
normalizeForMatch(s) = s.trim()
  → Unicode NFKC(全半角统一)
  → 转小写
  → 去空白字符(\s 全部删除,与 B 的 nameKeyOf 同款 video-scene.ts:218-220)
  → 去常见标点 ,,、。·.-_/()()[]【】: :
```

**匹配级别**(对每个候选/草稿名 `q`,归一化后记 `nq`):
1. `subtree_items` 中 `norm(item.name) === nq`(严格/规范化同名);
2. `subtree_items` 中模糊:包含(`nq ⊆ norm(name)` 或反向)或编辑距离 `lev(nq, norm(name)) ≤ (len ≤ 4 ? 1 : 2)`;
3. `household_items` 严格同名(排除已出现在 1 的);
4. `household_items` 模糊(排除已出现的);
5. 无建议 → 保持「新建物品」;**任何级别都不自动关联、不自动合并**(点选才切 target:"existing")。

输出:按级别升序、同级按名称字典序,截断 **5** 条;每条 `{ item_id, name, location_display, level, mounted_in_subtree }`。`location_display` = 挂载节点的完整 path.join(" / ")(从 `locationScanContext.subtree` + household pool 的挂载信息拼;未挂载/悬挂 → 回退 `location_text` 并标「未归位」)。`mounted_in_subtree` 决定选中后是否弹移动三选(§4)。

实现纪律:纯函数(输入池 + 名字 → 建议),不触网络/storage,与 `video-scene.ts` 的纯函数原语同风格,单独测试文件覆盖。

---

## 4. 移动语义(显式三选)

用户在匹配建议中点选一件已有物品后:

- **物品当前挂载在当前子树内**(含恰好挂在 `location_id` 本层):只关联视频证据,不改位置。UI 文案:「已在当前位置范围内,只补视频证据」。
- **物品挂载在子树外**(其他房间/未归位):弹 `wx.showActionSheet` 三选——
  - `只关联，保留原位置`:草稿 `target:"existing"`,不带 `move_to_node_id`;
  - `移动到当前位置并关联`:草稿记 `move_to_node_id = location_id` + 匹配池里的 `version`;移动目标**固定为进入的位置**(逐件子位置选择只作用于新物品;#94 只定义了「移动到当前位置」,不提供移到子位置);
  - `取消`:不切 target,草稿保持新建。
- **移动的落库** = §2.2 第 2 条:一次版本条件更新同时写 `location_text`(新位置路径文本)与 `location_node_id`;**旧证据一律不动**——`captured_location_text` 在证据创建时已冻结(`video.js:829/1021`),天然满足「旧照片/视频保留原 captured_location_text 作为历史证据;不迁移、不删除旧证据」。本次新证据行的 `captured_location_text` 取移动后物品的 `location_text`(新位置),即「新证据写当前位置」。
- 移动冲突(他端并发改动)→ 该件失败不写证据(§2.2),客户端刷新版本后重试;绝不静默降级为「只关联」。

---

## 5. 删除位置:三按钮(locations 域新增,替换现有删除交互)

### 5.1 新 action:`locations.deletePreview`(只读)

```
{ action:"deletePreview", node_id }
→ { ok, node_count,          // 子树含自身
    item_count,              // 挂载在子树内的未删物品数
    video_count,             // 这些物品的 video_evidence 行数(逐 item 查询,受页数护栏)
    scan_count,              // 子树内 active location_scans 数
    migrate_available }      // node.path.length ≥ 2(父不是 home 根)
```
根节点 → `INVALID_INPUT`(根不在 children 列表、无「⋯」入口,双重防删)。弹窗辅助文案由客户端拼:`当前及子位置共 {node_count} 个,物品 {item_count} 件,关联视频 {video_count} 条`(#94 原文格式)。

### 5.2 新 action:`locations.deleteLocation`(写类,进 `WRITE_DB_ACTIONS` 走作用域硬门)

```
{ action:"deleteLocation", node_id, mode: "migrate" | "purge" }
```

**mode:"migrate"(删位置并迁移物品)**,全在 locations 函数内:
1. 根 → `INVALID_INPUT`;`migrate_available === false`(顶层房间,父为 home 根)→ `INVALID_INPUT`「物品不能直接挂『我的家』,请先移动物品或改用全部删除」(结构规则来自 `linkItemAction` 的 `isHomeRoot` 拒绝,`locations/lib/handler.js:964-966`);
2. 逐件把挂载在子树内的物品条件重挂到上一级(`mergeRemountPhase` 同款循环 + guard + 确定性 `update_id = "locmigrate:" + digest(node_id + ":" + item_id)`,`locations/lib/handler.js:696-737` 模式):冲突 → `VERSION_CONFLICT` + `detail:{ conflicted:[{item_id, current_version}] }`,零删除、可重试;已重挂/已删 → continue(幂等);
3. 硬删子树全部节点(与现 delete 相同的逐节点 remove);补偿扫描摘除悬挂挂载(`compensateUnmount`);
4. `location_scans`:子树 location_id 且 `status:"active"` → `status:"location_deleted"` + `location_deleted_at`(条件 update,幂等重试安全);**不删任何证据行/云文件/物品**;
5. 响应 `{ ok, deleted_nodes, remounted, compensated, compensated_skipped }`。
   注:迁移只改挂载,不改 `location_text`(§1 定案的结构操作纪律);物品显示的「当前位置」= 新挂载路径。

**mode:"purge"(全部删除),客户端编排两阶段,服务端各步幂等**:
1. 客户端按 preview 的 item 清单**逐件调 `itemsApi.delete`**(顺序执行 + 进度提示)。理由:物品软删的级联(证据行删除、末引用才删云文件、提醒清理)全部硬化在 itemsApi(`itemsApi/lib/handler.js:1161-1210` + `video.js:524-608`),锁序(item 锁 → asset 锁升序 + 锁内引用复核)是 B 已验收资产;在 locations 函数里重写一遍必然复制锁序与提醒级联,违背「不扩大 B」的门禁。每件失败可单独重试(软删后重删返回 NOT_FOUND,视为完成)。
2. 全部物品删完后调 `locations.deleteLocation(purge)`:若仍有**未删**物品挂载在子树(删除期间并发挂载/新增)→ `NODE_NOT_EMPTY` + 当前清单,客户端补删后重试(收敛式);否则硬删子树节点、补偿悬挂挂载,并把子树内 scan 全部 `status:"deleted"` + `deleted_at`(#94 允许「删除或标记」,取标记保留审计字段);已 `location_deleted` 的也升级为 `deleted`。
3. 二次确认:purge 在 preview 弹窗(三按钮)之上再弹一次确认(#94「必须二次确认」);migrate 不需要(可逆性高——物品都在)。

**按钮与入口**:
- `取消`:不调任何接口。
- 现有 `wx.showModal` 只支持两按钮,三选改为自定义半屏弹层(或 `wx.showActionSheet` 三项,按真机风格定;实现 PR 里统一,倾向 ActionSheet:`取消 / 删位置并迁移物品 / 全部删除` + 上方影响面文案用 `locations.wxml` 弹层呈现)。
- 根位置:无删除入口(现状如此,根不在子节点列表);`deleteLocation`/`deletePreview` 服务端再拦一层。
- 现有 `delete` action 与「空分支 force 删除」路径**保留不动**(旧交互兜底与其他调用方零回归);D1 页面把「⋯ → 删除」改走 preview + 三按钮新流程。

---

## 6. 客户端

### 6.1 位置页(`pages/locations`)增量

- **底部入口卡**(仅 browse 模式且**非根层**;根层不显示——物品不允许挂 home 根(`locations/lib/handler.js:964`),「清点我的家整体」没有可归档目标):
  ```
  📹 拍视频清点这里
  上次清点:10-18 · 确认 4 件(2 件已删)    ← 有 scan 时第二行;点整卡拍摄,点「回看」进回放
  ```
  数据:列表渲染成功后 fire-and-forget 调 `locationScanLatest`(requestSeq 同款迟到守卫,失败静默隐藏第二行);**首页不做任何改动**(#94「首页不展示」)。
- 回看:复用 D1 新页的 `mode=last`(下条),展示视频播放器(不自动播放)+ 确认物品清单(可跳物品详情)。
- 删除入口改三按钮流程(§5)。

### 6.2 新页面 `pages/location-video-scan`(app.json 注册)

参数 `node_id`;会话 storage key 独立于 B(`home-memory:location-scan-session:<scope>:<node_id>`,24h TTL,同 B 的 scope 隔离纪律 `video-scan.ts:34-36`)。**不复用/不改动 `pages/video-scan`**(B 已冻结,避免扩大 B),复用的是它的可共享层:

| 复用(直接 import) | 新增 |
| --- | --- |
| `utils/video-scene.ts`:`scanSceneVideo`/`SceneObservation`/draft 系列/`splitSceneDraft`/`mergeSceneDrafts`/`buildDraftHighlights`/`sceneConfidenceText` | 位置上下文头卡(固定位置,不可全局改) |
| `utils/video-target.ts`:抽帧会话/`boxPercentStyle`/`videoTimeText` | 逐件子位置选择器(§6.3) |
| `utils/photo-vl.ts`:`recognizeWithVl` | 匹配建议面板(§3,`utils/item-match.ts`) |
| `utils/video-attach.ts`:选视频 + 扩展名 | 移动三选交互(§4) |
| 上传/提交状态机的**序列**(begin(scene) → uploadFile → receipt → commit → partial 重试/放弃):同 B `video-scan.ts:804-1007` 的调用次序,页面内重写(~150 行)并带 `location`/`candidate_count` 增量参数 | pending 会话按 node_id 键存取 |
| consent 弹窗文案(B 版 + 一句「归入:我的家 / X / Y」) | 完成页「上次清点」联动提示 |

页面阶段机:`idle → scanning → review → uploading → committing → partial/done/failed`,与 B 同名同义。

### 6.3 确认页固定位置 + 逐件子树内子位置

- 头卡:`位置:我的家 / 书房 / 书柜(固定)`+ 提示「新物品默认归这里,可逐件改到范围内更细的位置」。
- 逐件子位置选择:页内弹层渲染 `locationScanContext.subtree` 缩进列表(选择即写 `items[i].node_id`);**数据面天然不允许出子树**(列表里只有子树节点),服务端 §2.2 第 2 条再做硬校验(不依赖客户端)。
- 默认值:房间层(子树有子节点)→ 默认挂房间本层,允许改子位置;叶子层 → 固定本层,选择器隐藏。两种情况都不出现其他房间(无跨房间数据,无跨房间校验需求)。

### 6.4 types.ts 增量

`VideoSceneCommitEvent` 增可选 `location/candidate_count`;`VideoSceneCommitItem` 增可选 `node_id/move_to_node_id/expected_version`;新增 `LocationScan*`、`LocationScanContext*`、`LocationsDeletePreview*`、`LocationsDeleteLocation*` 类型;`ItemsApiEvent/OkResponse`、`LocationsApiEvent/OkResponse` 联合扩员。

---

## 7. 测试清单(逐条映射 #94 验收标准)

| # | #94 验收标准 | 测试(files/case) |
| --- | --- | --- |
| 1 | 任意层级位置可进入拍摄 | `tests/location-scan-page.test.js`:位置页非根层渲染入口、根层不渲染;子层/柜子/抽屉层逐层可进(node_id 传参) |
| 2 | 默认位置正确,逐件子位置仅限当前子树 | 服务端 `tests/location-scan-commit.test.js` D1-SUBTREE:件选子树外节点 → INVALID_INPUT + out_of_subtree、零写;客户端 page 测试:选择器仅含子树节点 |
| 3 | 新物品能正确归档到目标位置 | `tests/location-scan-move.test.js` D1-MOUNT:新物品挂载到 node_id、location_text=节点路径;挂载冲突仅降级标 mounted:false 不删物品 |
| 4 | 关联已有物品不自动改变位置 | `tests/location-scan-move.test.js` D1-LINK-ONLY:existing 无 move_to_node_id → 物品文档零字段变化(version 不动) |
| 5 | 异位置已有物品必须显式选择「移动」 | `tests/location-scan-move.test.js` D1-MOVE-EXPLICIT / D1-MOVE-CONFLICT:移动先于证据、冲突不写证据;客户端 item-match 测试:建议不自动选中 |
| 6 | 同名物品默认分开,模糊匹配只提示 | `tests/item-match.test.js`:同名不合并(复用 B SCENE-NO-AUTO-MERGE 精神)、五级排序、上限 5、归一化用例表(全半角/标点/空白/包含/编辑距离边界) |
| 7 | 一次保存的正确物品共享 file_id/asset_id | `tests/location-scan-commit.test.js` D1-SHARE:多件同 asset_id/file_id(断言与 B SCENE-COMMIT 同构)+ scan 行唯一 |
| 8 | 每个物品有自己的确认高亮 | 复用 B 断言模式:每行 highlights 独立(D1-COMMIT 内一并断言 scan_id 写入) |
| 9 | location_scan 有候选数/确认数/确认物品列表/位置快照 | `tests/location-scan-commit.test.js` D1-SCAN-FIELDS + D1-ZERO-CONFIRMED(零确认也有 scan 行) |
| 10 | 位置页底部显示最新清点 | `tests/location-scan-page.test.js`:locationScanLatest 渲染摘要、失败静默、首页(index)零改动断言 |
| 11 | 删除位置三个按钮语义正确 | `tests/locations-delete-cascade.test.js` MIGRATE-*/PURGE-*:迁移挂到上一级、purge 拒仍有活物品、scan 状态迁移 |
| 12 | 根位置无法删除 | 同上 ROOT-GUARD:deletePreview/deleteLocation 对根 INVALID_INPUT |
| 13 | 删位置并迁移物品保留证据和 scan,标 location_deleted | 同上 MIGRATE-KEEPS:Evidence 行/云文件/物品零变化;scan active→location_deleted(重试幂等);顶层房间 migrate 被拒 |
| 14 | 全部删除最后引用才删云文件,失败可重试 | `tests/location-scan-purge.test.js`:复用 itemsApi.delete 级联,共享文件有他家物品引用时保留(SHARE-CASCADE 模式);单件删除失败中途放弃 → 续删收敛;scan 标 deleted |
| 15 | 跨家庭、跨子树、并发删除、部分提交失败都有测试 | 跨家庭:commit 用他家 location_id → NOT_FOUND 零写;并发:deleteLocation vs linkItem(补偿)、commit 移动 vs itemsApi.update(VERSION_CONFLICT);部分失败:单件证据失败票据 partial + 重试 scan 计数自愈(D1-PARTIAL-HEAL) |
| 16 | 真机验证抽帧、耗时、弱网、切后台和内存 | 不可离线:实现 PR 附真机验收清单(抽帧耗时报数、弱网重试、onHide 会话保存/恢复、内存峰值),门禁沿用 #94「不能仅凭离线测试上线」 |
| — | B 零感知回归(本实现的硬门) | `tests/video-scene*.test.js` 四件**零修改**通过(本文落笔时基线 25/25,前述命令实测);另加 `tests/location-scan-commit.test.js` D1-B-COMPAT:无 location 参数的 commit 响应无 scan 字段、签名不变 |

补充:memoryDb 需为 `location_scans` 声明唯一索引 `(household_id, scan_id)`(`tests/helpers/memoryDb.js` 用法);`videoCleanup` 的 scan 引用复核进 `tests/video-cleanup.test.js` 增例(scan 存在 → 不删文件)。

---

## 8. 风险与边界

- **两函数共写 `location_scans`**:itemsApi 写 create/lifetime 计数,locations 写状态标记。集合权限沿用「所有用户不可读不可写」;所有权分工写进 `docs/API_CONTRACT.md` 增量段落(实现 PR 一并更新)。
- **itemsApi 内的子树算法副本**:与 `locations/lib/tree.js` 的等价性靠测试对拍(同输入同输出断言);若后续树算法演进,两处同步是已知债务(注释互相指认)。
- **purge 客户端编排无原子性**:每步幂等 + `NODE_NOT_EMPTY` 收敛清单已把风险压到「中途放弃留下半删状态,可随时续删」;真机弱网用例必须覆盖(#94 验收 16)。
- **0 确认 scan 会让孤儿视频不再被 24h 回收**(§2.4 有意为之):视频成为清点记录的一部分;scan 的用户主动删除留 D2。
- **B 不扩大**:除 `video.js` 的 D1 插入点(全部在 `event.location` 存在的分支内)与 evidence 行新字段外,不改 B 既有函数语义;`pages/video-scan` 零改动。
