"use strict";
// D2 用户删除单次清点合同(issue #96,docs/design/video-ai/D2-IMPLEMENTATION.md §1/§4/§6/§7 矩阵 B+D):
// itemsApi.scanDelete(新写 action,进 ACTIONS + WRITE_ACTIONS):形状门 8-64、
// 查无/跨家庭 NOT_FOUND、仅 active 可删、幂等重放 replayed、asset 锁、锁内重读 +
// 引用矩阵末复核(R1 活 evidence / R2 其他保留视频的 scan / R3 未结算票据;
// bound 票据与终态/已回收 scan 不占引用)、无引用先云删成功(0/-503003)才终结、
// 云删失败零状态残留可重试、绝不写 items/video_evidence/其他 scan;
// upsert 防复活两道门:终态/已回收 scan 的旧 sceneCommit 重试一律 OPERATION_CONFLICT
// 零写,正常 active 未回收行的 D1 自愈重试行为不变。
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const itemsHandler = require("../cloudfunctions/itemsApi/lib/handler").handler;
const locHandler = require("../cloudfunctions/locations/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH_A = "hh_11111111111111111111111111111151";
const HH_B = "hh_22222222222222222222222222222252";
const DURATION = 12000;

let GLOBAL_SEQ = 9000;

function digest16(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

function makeDeps(db, opts) {
  opts = opts || {};
  let clock = 1760000000000;
  const cloudDeleted = [];
  const state = { failDelete: opts.failDelete === true, dangling: opts.dangling === true };
  return {
    db,
    cloudDeleted,
    state,
    householdId: opts.householdId || HH_A,
    householdShared: false,
    scopeRevision: null,
    now: () => new Date(clock).toISOString(),
    advance: (ms) => { clock += ms; },
    genId: () => { GLOBAL_SEQ += 1; return "n" + String(GLOBAL_SEQ).padStart(12, "0"); },
    digest: digest16,
    getTempFileUrls: async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID, tempFileURL: "https://tmp.example/" + encodeURIComponent(fileID) })),
    }),
    deleteCloudFiles: async (ids) => {
      if (state.failDelete === true) return { fileList: ids.map((fileID) => ({ fileID, status: -1 })) };
      cloudDeleted.push.apply(cloudDeleted, ids);
      const status = state.dangling === true ? -503003 : 0; // dangling:文件已不存在按成功
      return { fileList: ids.map((fileID) => ({ fileID, status, errMsg: "ok" })) };
    },
    logger: { log: () => {} },
  };
}

function freshDb() {
  return createMemoryDb({
    uniqueIndexes: {
      video_evidence: [["household_id", "item_id", "file_id"]],
      location_scans: [["household_id", "scan_id"]],
      locations: [["household_id", "parent_id", "name_norm"]],
    },
  });
}

async function rawDocs(db, name) {
  const res = await db.collection(name).where({}).get();
  return res.data || [];
}

async function scanRow(db, scanId) {
  const rows = await rawDocs(db, "location_scans");
  return rows.find((r) => r.scan_id === scanId) || null;
}

/** 全库快照(按集合名分组、_id 升序),用于零写/零附带影响断言 */
async function dumpDb(db, names) {
  const out = {};
  for (const name of names) {
    out[name] = (await rawDocs(db, name)).slice().sort((a, b) => (a._id < b._id ? -1 : 1));
  }
  return out;
}

async function seedTree(db) {
  const nodes = [
    { _id: "lc_root", parent_id: "", name: "我的家", path: [] },
    { _id: "lc_study", parent_id: "lc_root", name: "书房", path: ["书房"] },
    { _id: "lc_shelf", parent_id: "lc_study", name: "书柜", path: ["书房", "书柜"] },
    { _id: "lc_layer", parent_id: "lc_shelf", name: "第一层", path: ["书房", "书柜", "第一层"] },
    { _id: "lc_kitchen", parent_id: "lc_root", name: "厨房", path: ["厨房"] },
  ];
  for (const n of nodes) {
    await db.collection("locations").add({ data: Object.assign({ household_id: HH_A, name_norm: n.name }, n) });
  }
}

function hl(start, end) {
  return { start_ms: start, end_ms: end, box: null, frame_ms: start };
}

async function sceneTicket(deps, sceneId) {
  const begin = await itemsHandler({
    action: "videoUploadBegin",
    purpose: "scene",
    scene_id: sceneId,
    ext: "mp4",
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
  }, deps);
  assert.equal(begin.ok, true, JSON.stringify(begin));
  const fileId = "cloud://bucket/" + begin.upload_path;
  const receipt = await itemsHandler({
    action: "videoUploadReceipt",
    upload_ticket: begin.upload_ticket,
    file_id: fileId,
  }, deps);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  return { begin, fileId };
}

function commitEvent(ticket, scanId, items, extra) {
  return Object.assign({
    action: "videoSceneCommit",
    scene_id: scanId,
    upload_ticket: ticket.begin.upload_ticket,
    asset_id: ticket.begin.asset_id,
    file_id: ticket.fileId,
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
    consent_version: "v1",
    items,
    candidate_count: items.length,
    location: {
      location_id: "lc_shelf",
      scan_id: scanId,
      path_snapshot: ["书房", "书柜"],
      text_snapshot: "书房 / 书柜",
    },
  }, extra || {});
}

/** 直接注入 location_scans 行(file_id 逐行独立);默认 0 确认、active */
async function seedScan(db, scanId, extra) {
  const doc = Object.assign({
    _id: "ls_" + scanId,
    household_id: HH_A,
    scan_id: scanId,
    location_id: "lc_shelf",
    location_path_snapshot: ["书房", "书柜"],
    location_text_snapshot: "书房 / 书柜",
    file_id: "cloud://bucket/video-evidence/" + HH_A + "/" + scanId + ".mp4",
    asset_id: "va_" + scanId,
    upload_ticket: "vt_" + scanId,
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
    candidate_count: 5,
    confirmed_count: 0,
    confirmed_item_ids: [],
    created_at: "2026-10-10T00:00:00.000Z",
    updated_at: "2026-10-10T00:00:00.000Z",
    status: "active",
  }, extra || {});
  await db.collection("location_scans").add({ data: doc });
  return doc;
}

/** 直接注入票据(默认 bound,commit 后现实态;媒体三字段与 commit 事件一致,
 *  使合成票据能通过 videoSceneCommit 的票据形状复核) */
async function seedTicket(db, id, extra) {
  await db.collection("video_upload_tickets").add({
    data: Object.assign({
      _id: id,
      household_id: HH_A,
      item_id: "",
      purpose: "scene",
      scene_id: id.replace(/^vt_/, "scene-"),
      cloud_path: "video-evidence/seed/" + id + ".mp4",
      status: "bound",
      created_at: "2026-10-10T00:00:00.000Z",
      expires_at: "2026-10-10T00:15:00.000Z",
      duration_ms: DURATION,
      video_w: 1280,
      video_h: 720,
    }, extra || {}),
  });
}

/** 直接注入 video_evidence 行(R1 活引用) */
async function seedEvidence(db, id, fileId, assetId, itemId) {
  await db.collection("video_evidence").add({
    data: {
      _id: id,
      household_id: HH_A,
      item_id: itemId || "it_seed",
      file_id: fileId,
      asset_id: assetId,
      scan_id: "",
      source: "manual",
      duration_ms: DURATION,
      video_w: 1280,
      video_h: 720,
      captured_location_text: "书房",
      consent_version: "v1",
      created_at: "2026-10-10T00:00:00.000Z",
    },
  });
}

/** 直接注入 asset 锁(val_<asset_id>,与 video_item_locks 同集合/同键) */
async function holdAssetLock(db, assetId, deps) {
  await db.collection("video_item_locks").add({
    data: {
      _id: "val_" + assetId,
      household_id: HH_A,
      lock_kind: "asset",
      owner_token: "held-by-other",
      purpose: "scene_commit",
      asset_id: assetId,
      created_at: deps.now(),
      expires_at: new Date(Date.parse(deps.now()) + 60 * 1000).toISOString(),
    },
  });
}

// ---------- 矩阵 B:scanDelete ----------

test("DEL-NO-REF-FILE-GONE:全无引用(含本行 bound 票据)→ 云删成功才终结,video_deleted:true", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  const scanId = "scandel-noref-1"; // 14 字符,8-64 形状内
  // 真实流:零确认提交(目标物品不存在,零证据)→ 取消把票据收敛为 bound(D1 语义)
  const ticket = await sceneTicket(deps, scanId);
  const commit = await itemsHandler(commitEvent(ticket, scanId, [
    { draft_key: "d-gone", target: "existing", item_id: "it_not_exists", highlights: [hl(0, 800)] },
  ]), deps);
  assert.equal(commit.ok, true, JSON.stringify(commit));
  assert.equal(commit.scan.confirmed_count, 0);
  const cancel = await itemsHandler({ action: "videoUploadCancel", upload_ticket: ticket.begin.upload_ticket }, deps);
  assert.equal(cancel.ok, true, JSON.stringify(cancel));
  assert.equal(cancel.state, "bound");

  const res = await itemsHandler({ action: "scanDelete", scan_id: scanId }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.video_deleted, true, "全无引用:bound 票据不算独立引用(§1),文件一并删除");
  assert.deepEqual(deps.cloudDeleted, [ticket.fileId]);
  const row = await scanRow(db, scanId);
  assert.equal(row.status, "deleted");
  assert.ok(row.deleted_at);
  assert.equal(row.deleted_by, "user");
  assert.equal(row.file_id, ticket.fileId, "审计行其余字段不动");
  const ticketDoc = (await db.collection("video_upload_tickets").doc(ticket.begin.upload_ticket).get()).data;
  assert.equal(ticketDoc.status, "deleted", "best-effort 票据收口");
  assert.equal(ticketDoc.cleanup_reason, "scan_deleted");
});

test("DEL-REF-EVIDENCE:有活 evidence 行 → 只标 scan,云文件不删、evidence 行零变化", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const scan = await seedScan(db, "scandel-ref-ev");
  await seedTicket(db, scan.upload_ticket, { asset_id: scan.asset_id, file_id: scan.file_id });
  await seedEvidence(db, "ve_ref_1", scan.file_id, scan.asset_id);
  const before = await dumpDb(db, ["video_evidence"]);
  const res = await itemsHandler({ action: "scanDelete", scan_id: "scandel-ref-ev" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.video_deleted, false, "R1 引用:文件保留");
  assert.deepEqual(deps.cloudDeleted, []);
  assert.deepEqual(await dumpDb(db, ["video_evidence"]), before, "evidence 行逐字段零变化");
  const row = await scanRow(db, "scandel-ref-ev");
  assert.equal(row.status, "deleted");
  assert.equal(row.deleted_by, "user");
});

test("DEL-REF-OTHER-SCAN / 终态与已回收 scan 不占引用:其他保留视频的 scan 保护文件;终态/已回收行不保护", async () => {
  // a) R2:另一 active 且未回收的 scan 共享文件 → 文件保留,另一行零变化
  const dbA = freshDb();
  const depsA = makeDeps(dbA);
  const sharedFile = "cloud://bucket/video-evidence/" + HH_A + "/shared-two-scans.mp4";
  await seedScan(dbA, "scandel-share-a", { file_id: sharedFile, asset_id: "va_shared_pair" });
  const sibling = await seedScan(dbA, "scandel-share-b", { file_id: sharedFile, asset_id: "va_shared_pair", location_id: "lc_layer" });
  const beforeSibling = JSON.parse(JSON.stringify(sibling));
  const resA = await itemsHandler({ action: "scanDelete", scan_id: "scandel-share-a" }, depsA);
  assert.equal(resA.ok, true, JSON.stringify(resA));
  assert.equal(resA.video_deleted, false, "R2:其他仍保留视频的 scan 是引用");
  assert.deepEqual(depsA.cloudDeleted, []);
  const siblingAfter = await scanRow(dbA, "scandel-share-b");
  assert.deepEqual(siblingAfter, beforeSibling, "其他 scan 行零变化");

  // b) 兄弟行是终态 deleted(位置流程 purge)→ 不占引用 → 文件删除
  const dbB = freshDb();
  const depsB = makeDeps(dbB);
  const fileB = "cloud://bucket/video-evidence/" + HH_A + "/shared-terminal.mp4";
  await seedScan(dbB, "scandel-term-a", { file_id: fileB, asset_id: "va_term_pair" });
  await seedScan(dbB, "scandel-term-b", {
    file_id: fileB, asset_id: "va_term_pair", location_id: "lc_layer",
    status: "deleted", deleted_at: "2026-10-12T00:00:00.000Z",
  });
  const resB = await itemsHandler({ action: "scanDelete", scan_id: "scandel-term-a" }, depsB);
  assert.equal(resB.ok, true, JSON.stringify(resB));
  assert.equal(resB.video_deleted, true, "终态 deleted 的 scan 行是审计行,不占引用(§1)");
  assert.deepEqual(depsB.cloudDeleted, [fileB]);

  // c) 兄弟行已回收(active + video_reclaimed_at)→ 不占引用 → 文件删除
  const dbC = freshDb();
  const depsC = makeDeps(dbC);
  const fileC = "cloud://bucket/video-evidence/" + HH_A + "/shared-reclaimed.mp4";
  await seedScan(dbC, "scandel-rc-a", { file_id: fileC, asset_id: "va_rc_pair" });
  await seedScan(dbC, "scandel-rc-b", {
    file_id: fileC, asset_id: "va_rc_pair", location_id: "lc_layer",
    video_reclaimed_at: "2026-11-09T00:00:00.000Z", video_reclaim_reason: "zero_confirm_expired",
  });
  const resC = await itemsHandler({ action: "scanDelete", scan_id: "scandel-rc-a" }, depsC);
  assert.equal(resC.ok, true, JSON.stringify(resC));
  assert.equal(resC.video_deleted, true, "已回收(video_reclaimed_at 置位)的 scan 不占引用");
  assert.deepEqual(depsC.cloudDeleted, [fileC]);
});

test("DEL-REF-UNSETTLED-TICKET:有未结算票据 → 只终结 scan,文件与该票据留给票据路径收敛", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const scan = await seedScan(db, "scandel-ref-tk");
  await seedTicket(db, scan.upload_ticket, { asset_id: scan.asset_id, file_id: scan.file_id });
  // 同文件的在途票据(pending 未过期,24h 孤儿回收也不碰):R3 引用
  await seedTicket(db, "vt_inflight_same_file", {
    status: "pending",
    asset_id: "",
    file_id: scan.file_id,
    expires_at: "2999-01-01T00:00:00.000Z",
  });
  const res = await itemsHandler({ action: "scanDelete", scan_id: "scandel-ref-tk" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.video_deleted, false, "R3:未结算票据持有文件,留下次收敛");
  assert.deepEqual(deps.cloudDeleted, []);
  const inflight = (await db.collection("video_upload_tickets").doc("vt_inflight_same_file").get()).data;
  assert.equal(inflight.status, "pending", "他件票据绝不被 scanDelete 改写");
  const row = await scanRow(db, "scandel-ref-tk");
  assert.equal(row.status, "deleted");
});

test("DEL-DANGLING:文件已随物品证据删除(-503003)→ 按成功终结;重放 replayed:true", async () => {
  const db = freshDb();
  const deps = makeDeps(db, { dangling: true });
  const scan = await seedScan(db, "scandel-dangling");
  await seedTicket(db, scan.upload_ticket, { asset_id: scan.asset_id, file_id: scan.file_id });
  const res = await itemsHandler({ action: "scanDelete", scan_id: "scandel-dangling" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.video_deleted, true, "dangling:文件不存在(-503003)等同删除成功,幂等");
  const row = await scanRow(db, "scandel-dangling");
  assert.equal(row.status, "deleted");
  assert.equal(row.deleted_by, "user");
  const replay = await itemsHandler({ action: "scanDelete", scan_id: "scandel-dangling" }, deps);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.replayed, true);
  assert.equal(replay.video_deleted, false, "重放不重演首删的文件判定(§4 冻结口径)");
});

test("DEL-CLOUD-FAIL:云删返回 -1 → scan 保持 active 零字段变化,VIDEO_DELETE_FAILED 可重试", async () => {
  const db = freshDb();
  const deps = makeDeps(db, { failDelete: true });
  const scan = await seedScan(db, "scandel-cloudfail");
  await seedTicket(db, scan.upload_ticket, { asset_id: scan.asset_id, file_id: scan.file_id });
  const before = await scanRow(db, "scandel-cloudfail");
  const res = await itemsHandler({ action: "scanDelete", scan_id: "scandel-cloudfail" }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "VIDEO_DELETE_FAILED");
  assert.deepEqual(res.failed_file_ids, [scan.file_id]);
  assert.deepEqual(await scanRow(db, "scandel-cloudfail"), before, "整序列无状态残留(§4 第 5 步)");
  const ticketDoc = (await db.collection("video_upload_tickets").doc(scan.upload_ticket).get()).data;
  assert.equal(ticketDoc.status, "bound", "票据收口只在终结成功后,失败不动");

  // 修好云删后重试从第 1 步重跑,成功
  deps.state.failDelete = false;
  const retry = await itemsHandler({ action: "scanDelete", scan_id: "scandel-cloudfail" }, deps);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.video_deleted, true);
  assert.deepEqual(deps.cloudDeleted, [scan.file_id]);
  assert.equal((await scanRow(db, "scandel-cloudfail")).status, "deleted");
});

test("DEL-IDEMPOTENT-REPLAY:成功后同参重试 replayed:true 行稳定;并发第二请求收敛(BUSY 或 replayed)", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const scan = await seedScan(db, "scandel-replay-1");
  await seedTicket(db, scan.upload_ticket, { asset_id: scan.asset_id, file_id: scan.file_id });
  const first = await itemsHandler({ action: "scanDelete", scan_id: "scandel-replay-1" }, deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.video_deleted, true);
  const afterFirst = await scanRow(db, "scandel-replay-1");
  const replay = await itemsHandler({ action: "scanDelete", scan_id: "scandel-replay-1" }, deps);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.replayed, true);
  assert.equal(replay.video_deleted, false);
  assert.deepEqual(await scanRow(db, "scandel-replay-1"), afterFirst, "重放不二次改写审计行");

  // 双击并发:两个同时进的 scanDelete,胜者按 §4 返回首删响应(ok + video_deleted:true,
  // 无 replayed——replayed 仅属幂等重放,DEL-NO-REF-FILE-GONE 钉死);败者只可能是
  // BUSY(锁内)或 replayed(收敛)。终态唯一为 deleted,云文件只删一次。
  const scan2 = await seedScan(db, "scandel-replay-2");
  await seedTicket(db, scan2.upload_ticket, { asset_id: scan2.asset_id, file_id: scan2.file_id });
  const [x1, x2] = await Promise.all([
    itemsHandler({ action: "scanDelete", scan_id: "scandel-replay-2" }, deps),
    itemsHandler({ action: "scanDelete", scan_id: "scandel-replay-2" }, deps),
  ]);
  let winners = 0;
  for (const r of [x1, x2]) {
    const converged = (r.ok === true && r.replayed === true) || (r.ok === false && r.error === "VIDEO_ITEM_BUSY");
    const isWinner = r.ok === true && r.video_deleted === true;
    assert.equal(converged || isWinner, true, "并发响应必须是胜者首删/败者收敛(replayed 或 BUSY): " + JSON.stringify(r));
    if (isWinner) winners += 1;
  }
  assert.equal(winners, 1, "恰好一个胜者真正执行删除(终态唯一,云文件只删一次)");
  const row2 = await scanRow(db, "scandel-replay-2");
  assert.equal(row2.status, "deleted");
  assert.equal(row2.deleted_by, "user");
  assert.deepEqual(deps.cloudDeleted, [scan.file_id, scan2.file_id], "每个文件只被真正删除一次(重放不重删)");
  const third = await itemsHandler({ action: "scanDelete", scan_id: "scandel-replay-2" }, deps);
  assert.equal(third.ok, true);
  assert.equal(third.replayed, true);
});

test("DEL-STATUS-GATE:location_deleted / purge-deleted / 不存在 → NOT_FOUND;形状非法 → INVALID_INPUT", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  await seedScan(db, "scandel-gate-loc", {
    status: "location_deleted", location_deleted_at: "2026-10-12T00:00:00.000Z",
  });
  await seedScan(db, "scandel-gate-purge", {
    status: "deleted", deleted_at: "2026-10-12T00:00:00.000Z", // 位置流程删:仅 deleted_at,无 deleted_by
  });
  // 阳性对照:合法形状但查无的 scan_id → NOT_FOUND(未知 action 会在这里暴露为 INVALID_INPUT)
  assert.equal((await itemsHandler({ action: "scanDelete", scan_id: "scandel-gate-none" }, deps)).error, "NOT_FOUND");
  const locRes = await itemsHandler({ action: "scanDelete", scan_id: "scandel-gate-loc" }, deps);
  assert.equal(locRes.ok, false);
  assert.equal(locRes.error, "NOT_FOUND", "location_deleted 行对用户不可见,随位置流程终结");
  const purgeRes = await itemsHandler({ action: "scanDelete", scan_id: "scandel-gate-purge" }, deps);
  assert.equal(purgeRes.ok, false);
  assert.equal(purgeRes.error, "NOT_FOUND", "非用户删的终态行不可再删");
  // 形状门:scan_id 8-64
  assert.equal((await itemsHandler({ action: "scanDelete", scan_id: "short7" }, deps)).error, "INVALID_INPUT");
  assert.equal((await itemsHandler({ action: "scanDelete", scan_id: "x".repeat(65) }, deps)).error, "INVALID_INPUT");
  assert.equal((await itemsHandler({ action: "scanDelete" }, deps)).error, "INVALID_INPUT");
  // 两行原样未动
  assert.equal((await scanRow(db, "scandel-gate-loc")).status, "location_deleted");
  assert.equal((await scanRow(db, "scandel-gate-purge")).deleted_by, undefined);
});

test("DEL-CROSS-HOUSEHOLD:他家 scan_id → NOT_FOUND,全库零写入", async () => {
  const db = freshDb();
  const depsA = makeDeps(db);
  const depsB = makeDeps(db, { householdId: HH_B });
  await seedScan(db, "scandel-cross-1");
  const before = await dumpDb(db, ["location_scans", "video_evidence", "items", "video_upload_tickets"]);
  const res = await itemsHandler({ action: "scanDelete", scan_id: "scandel-cross-1" }, depsB);
  assert.equal(res.ok, false);
  assert.equal(res.error, "NOT_FOUND", "他家 scan_id 在本家庭查询里天然查无(§4 第 1 步)");
  assert.deepEqual(await dumpDb(db, ["location_scans", "video_evidence", "items", "video_upload_tickets"]), before);
});

test("DEL-NO-COLLATERAL:删除前后 items/video_evidence/其他 scan 逐字段 diff 为空;不可变字段不动", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  await db.collection("items").add({
    data: {
      _id: "it_keep", household_id: HH_A, name: "螺丝刀", name_norm: "螺丝刀",
      location_text: "书房 / 书柜", note: "", version: 3, deleted: false,
      operation_id: "op-keep", created_at: "2026-10-10T00:00:00.000Z", updated_at: "2026-10-10T00:00:00.000Z",
    },
  });
  const scan = await seedScan(db, "scandel-collateral");
  await seedTicket(db, scan.upload_ticket, { asset_id: scan.asset_id, file_id: scan.file_id });
  await seedScan(db, "scandel-bystander", { location_id: "lc_layer" });
  await seedEvidence(db, "ve_keep_1", "cloud://bucket/video-evidence/" + HH_A + "/unrelated.mp4", "va_unrelated", "it_keep");
  const beforeItems = await dumpDb(db, ["items", "video_evidence"]);
  const beforeOtherScans = (await rawDocs(db, "location_scans")).filter((r) => r.scan_id !== "scandel-collateral");

  const res = await itemsHandler({ action: "scanDelete", scan_id: "scandel-collateral" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(await dumpDb(db, ["items", "video_evidence"]), beforeItems, "绝不动物品/evidence(§4 第 8 步)");
  const afterOtherScans = (await rawDocs(db, "location_scans")).filter((r) => r.scan_id !== "scandel-collateral");
  assert.deepEqual(afterOtherScans, beforeOtherScans.sort((a, b) => (a._id < b._id ? -1 : 1)), "其他 scan 行零变化");

  const row = await scanRow(db, "scandel-collateral");
  assert.equal(row.status, "deleted");
  assert.equal(row.deleted_by, "user");
  // 不可变字段(§3):created_at / candidate_count / confirmed_count 绝不写入
  assert.equal(row.created_at, scan.created_at);
  assert.equal(row.candidate_count, scan.candidate_count);
  assert.equal(row.confirmed_count, scan.confirmed_count);
  assert.equal(row.file_id, scan.file_id);
  assert.equal(row.asset_id, scan.asset_id);
});

test("DEL-BUSY:asset 锁被占 → VIDEO_ITEM_BUSY 行原样;锁过期后重试成功", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const scan = await seedScan(db, "scandel-busy-1");
  await holdAssetLock(db, scan.asset_id, deps);
  const before = await scanRow(db, "scandel-busy-1");
  const res = await itemsHandler({ action: "scanDelete", scan_id: "scandel-busy-1" }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "VIDEO_ITEM_BUSY");
  assert.deepEqual(await scanRow(db, "scandel-busy-1"), before, "抢锁失败零写入");
  assert.deepEqual(deps.cloudDeleted, []);
  // 60s TTL 过期后可接管重试
  deps.advance(61 * 1000);
  const retry = await itemsHandler({ action: "scanDelete", scan_id: "scandel-busy-1" }, deps);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.video_deleted, true);
});

test("DEL-LATEST-SKIP:删最新一条后 Latest 降级到下一条 active;全删完 → scan:null", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  await seedScan(db, "scandel-latest-old", { created_at: "2026-10-10T00:00:00.000Z" });
  await seedScan(db, "scandel-latest-new", { created_at: "2026-10-11T00:00:00.000Z" });
  const latest1 = await itemsHandler({ action: "locationScanLatest", location_id: "lc_shelf" }, deps);
  assert.equal(latest1.scan.scan_id, "scandel-latest-new");
  const del = await itemsHandler({ action: "scanDelete", scan_id: "scandel-latest-new" }, deps);
  assert.equal(del.ok, true, JSON.stringify(del));
  const latest2 = await itemsHandler({ action: "locationScanLatest", location_id: "lc_shelf" }, deps);
  assert.equal(latest2.ok, true, JSON.stringify(latest2));
  assert.equal(latest2.scan.scan_id, "scandel-latest-old", "删最新后降级到下一条 active");
  const del2 = await itemsHandler({ action: "scanDelete", scan_id: "scandel-latest-old" }, deps);
  assert.equal(del2.ok, true, JSON.stringify(del2));
  const latest3 = await itemsHandler({ action: "locationScanLatest", location_id: "lc_shelf" }, deps);
  assert.equal(latest3.ok, true);
  assert.equal(latest3.scan, null, "全删完 → scan:null");
});

test("DEL-RECLAIMED-THEN-DELETE:已回收(active+video_reclaimed_at)行删除 → dangling 分支成功终态", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const scan = await seedScan(db, "scandel-rc-del", {
    video_reclaimed_at: "2026-11-09T00:00:00.000Z", video_reclaim_reason: "zero_confirm_expired",
  });
  await seedTicket(db, scan.upload_ticket, { asset_id: scan.asset_id, file_id: scan.file_id });
  const res = await itemsHandler({ action: "scanDelete", scan_id: "scandel-rc-del" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.video_deleted, true, "本行已回收不占引用:无引用走云删(此时文件已不在,0 也按成功)");
  assert.deepEqual(deps.cloudDeleted, [scan.file_id]);
  const row = await scanRow(db, "scandel-rc-del");
  assert.equal(row.status, "deleted");
  assert.equal(row.deleted_by, "user");
  assert.equal(row.video_reclaimed_at, "2026-11-09T00:00:00.000Z", "回收事实不被删除改写");
});

test("DEL-CONCURRENT-LOCATION:scanDelete 与 deleteLocation 交错,条件更新收敛无中间态", async () => {
  // a) 位置 migrate 先赢:scan → location_deleted,scanDelete → NOT_FOUND
  const dbA = freshDb();
  await seedTree(dbA);
  const depsA = makeDeps(dbA);
  await seedScan(dbA, "scandel-race-a", { location_id: "lc_layer" });
  const migrate = await locHandler({ action: "deleteLocation", node_id: "lc_shelf", mode: "migrate" }, depsA);
  assert.equal(migrate.ok, true, JSON.stringify(migrate));
  assert.equal(migrate.scans_marked, 1);
  const delA = await itemsHandler({ action: "scanDelete", scan_id: "scandel-race-a" }, depsA);
  assert.equal(delA.ok, false);
  assert.equal(delA.error, "NOT_FOUND", "状态门收敛:location_deleted 不可用户删");
  const rowA = await scanRow(dbA, "scandel-race-a");
  assert.equal(rowA.status, "location_deleted");
  assert.equal(rowA.deleted_by, undefined, "无中间态:不混入用户删标记");

  // b) scanDelete 先赢:行终态 deleted+deleted_by:"user",purge 不得改写(二者必有一胜)
  const dbB = freshDb();
  await seedTree(dbB);
  const depsB = makeDeps(dbB);
  await seedScan(dbB, "scandel-race-b", { location_id: "lc_layer" });
  const delB = await itemsHandler({ action: "scanDelete", scan_id: "scandel-race-b" }, depsB);
  assert.equal(delB.ok, true, JSON.stringify(delB));
  const before = await scanRow(dbB, "scandel-race-b");
  const purge = await locHandler({ action: "deleteLocation", node_id: "lc_shelf", mode: "purge" }, depsB);
  assert.equal(purge.ok, true, JSON.stringify(purge));
  assert.equal(purge.scans_marked, 0, "终态 deleted 行不在 purge 迁移集合");
  assert.deepEqual(await scanRow(dbB, "scandel-race-b"), before, "用户删终态不被位置流程改写");
  assert.equal((await scanRow(dbB, "scandel-race-b")).deleted_by, "user");
});

// ---------- 矩阵 D:upsert 防复活(§6) ----------

test("RES-USER-DELETED:用户已删 scan 的旧 commit 重试 → OPERATION_CONFLICT,不复活不重引用", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  const scanId = "scanres-userdel-1";
  const ticket = await sceneTicket(deps, scanId);
  const ev = commitEvent(ticket, scanId, [
    { draft_key: "d-1", target: "new", operation_id: "op-res-user", name: "扳手", location_text: "书房 / 书柜", highlights: [hl(0, 900)] },
  ]);
  const commit = await itemsHandler(ev, deps);
  assert.equal(commit.ok, true, JSON.stringify(commit));
  assert.equal(commit.scan.confirmed_count, 1);

  const del = await itemsHandler({ action: "scanDelete", scan_id: scanId }, deps);
  assert.equal(del.ok, true, JSON.stringify(del));
  assert.equal(del.video_deleted, false, "R1 活证据保护文件");
  const afterDelete = await scanRow(db, scanId);
  const itemsBefore = await dumpDb(db, ["items", "video_evidence"]);

  const retry = await itemsHandler(ev, deps);
  assert.equal(retry.ok, false, JSON.stringify(retry));
  assert.equal(retry.error, "OPERATION_CONFLICT", "旧提交不得复活已删 scan(§6,同 scan_id 复用硬门同族)");
  assert.deepEqual(await scanRow(db, scanId), afterDelete, "scan 不复活:deleted_by 仍 user、updated_at 不被改写");
  assert.deepEqual(await dumpDb(db, ["items", "video_evidence"]), itemsBefore, "不新增 evidence 引用已删 scan 的文件");
});

test("RES-RECLAIMED:已回收 scan 的旧重试 → OPERATION_CONFLICT,video_reclaimed_at 不被清", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  const scanId = "scanres-reclaim1";
  // 真实提交(0 确认):票据经 CAS 已带匹配载荷签名(0 确认停在 binding),scan active;
  // 随后 videoCleanup 到期回收把行置 video_reclaimed_at(此处直接改行模拟该事实)
  const ticket = await sceneTicket(deps, scanId);
  const ev = commitEvent(ticket, scanId, [
    { draft_key: "d-gone", target: "existing", item_id: "it_not_exists", highlights: [hl(0, 800)] },
  ]);
  const commit = await itemsHandler(ev, deps);
  assert.equal(commit.ok, true, JSON.stringify(commit));
  assert.equal(commit.scan.confirmed_count, 0);
  await db.collection("location_scans").where({ household_id: HH_A, scan_id: scanId }).update({
    data: { video_reclaimed_at: "2026-11-09T00:00:00.000Z", video_reclaim_reason: "zero_confirm_expired" },
  });
  const before = await dumpDb(db, ["location_scans", "video_evidence", "items", "video_upload_tickets"]);

  const retry = await itemsHandler(ev, deps);
  assert.equal(retry.ok, false, JSON.stringify(retry));
  assert.equal(retry.error, "OPERATION_CONFLICT", "已回收 scan 生命周期已终结,旧重试整批零写");
  assert.deepEqual(await dumpDb(db, ["location_scans", "video_evidence", "items", "video_upload_tickets"]), before);
  const row = await scanRow(db, scanId);
  assert.equal(row.video_reclaimed_at, "2026-11-09T00:00:00.000Z", "回收标记不被清");
  assert.equal(row.status, "active", "回收不迁移 status,重试也不得改");
});

test("RES-LOC-DELETED:location_deleted scan 的旧重试 → OPERATION_CONFLICT 零写", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  const scanId = "scanres-locdel-1";
  const ticket = await sceneTicket(deps, scanId);
  const ev = commitEvent(ticket, scanId, [
    { draft_key: "d-1", target: "new", operation_id: "op-res-loc", name: "尺子", location_text: "书房 / 书柜", highlights: [hl(0, 900)] },
  ]);
  const commit = await itemsHandler(ev, deps);
  assert.equal(commit.ok, true, JSON.stringify(commit));
  // 位置 migrate 先终结 scan(直接改行模拟 deleteLocation 交错)
  await db.collection("location_scans").where({ household_id: HH_A, scan_id: scanId }).update({
    data: { status: "location_deleted", location_deleted_at: deps.now() },
  });
  const before = await dumpDb(db, ["location_scans", "video_evidence", "items", "video_upload_tickets"]);

  const retry = await itemsHandler(ev, deps);
  assert.equal(retry.ok, false, JSON.stringify(retry));
  assert.equal(retry.error, "OPERATION_CONFLICT");
  assert.deepEqual(await dumpDb(db, ["location_scans", "video_evidence", "items", "video_upload_tickets"]), before, "早门命中全集合零写入");
});

test("RES-PARTIAL-AFTER-DELETE:部分失败 commit → scanDelete → 旧重试被拒,已成功件零重放、终态保持", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  const scanId = "scanres-partial-1";
  await db.collection("items").add({
    data: {
      _id: "it_res_stale", household_id: HH_A, name: "旧充电线", name_norm: "旧充电线",
      location_text: "厨房", note: "", version: 2, deleted: false, location_node_id: "lc_kitchen",
      operation_id: "op-res-stale", created_at: "2026-10-10T00:00:00.000Z", updated_at: "2026-10-10T00:00:00.000Z",
    },
  });
  const ticket = await sceneTicket(deps, scanId);
  const buildEvent = (expectedVersion) => commitEvent(ticket, scanId, [
    { draft_key: "d-stale", target: "existing", item_id: "it_res_stale", move_to_node_id: "lc_shelf", expected_version: expectedVersion, highlights: [hl(0, 700)] },
    { draft_key: "d-fresh", target: "new", operation_id: "op-res-fresh", name: "新扳手", location_text: "书房 / 书柜", highlights: [hl(900, 1600)] },
  ]);
  const first = await itemsHandler(buildEvent(1), deps); // 版本冲突 → 部分失败
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.scan.confirmed_count, 1);
  const freshItem = first.results.find((r) => r.draft_key === "d-fresh").item_id;

  const del = await itemsHandler({ action: "scanDelete", scan_id: scanId }, deps);
  assert.equal(del.ok, true, JSON.stringify(del));
  assert.equal(del.video_deleted, false, "R1:成功件的证据仍引用文件");
  const afterDelete = await dumpDb(db, ["location_scans", "items", "video_evidence"]);

  const retry = await itemsHandler(buildEvent(2), deps);
  assert.equal(retry.ok, false, JSON.stringify(retry));
  assert.equal(retry.error, "OPERATION_CONFLICT", "旧重试不复活已删 scan");
  assert.deepEqual(await dumpDb(db, ["location_scans", "items", "video_evidence"]), afterDelete, "不新增证据引用已删 scan 的文件,失败件不被移动");
  const stale = (await rawDocs(db, "items")).find((r) => r._id === "it_res_stale");
  assert.equal(stale.location_node_id, "lc_kitchen");
  assert.equal((await rawDocs(db, "video_evidence")).filter((r) => r.item_id === freshItem).length, 1, "已成功件证据恰好一行");
});

test("RES-NORMAL-HEAL-KEPT:正常 active 未回收 scan 的同载荷重试 → D1 幂等自愈行为不变", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  const scanId = "scanres-normal-1";
  const ticket = await sceneTicket(deps, scanId);
  const ev = commitEvent(ticket, scanId, [
    { draft_key: "d-1", target: "new", operation_id: "op-res-normal", name: "胶带", location_text: "书房 / 书柜", highlights: [hl(0, 900)] },
  ]);
  const first = await itemsHandler(ev, deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  deps.advance(2000);
  const retry = await itemsHandler(ev, deps);
  assert.equal(retry.ok, true, JSON.stringify(retry), "防复活门不得过宽:active 未回收行照常幂等重试");
  assert.equal(retry.scan.confirmed_count, 1);
  for (const row of retry.results) assert.equal(row.evidence_duplicated, true, "已成功件 duplicated 收敛");
  assert.equal((await rawDocs(db, "video_evidence")).length, 1);
  assert.equal((await rawDocs(db, "location_scans")).length, 1);
});

test("RES-EARLY-GATE-ZERO-WRITE:早门命中(用户已删 scan)→ 全集合零写入", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  const scanId = "scanres-zerowrite";
  // 真实提交后直接把行置为用户删终态(模拟一次已完成的 scanDelete)
  const ticket = await sceneTicket(deps, scanId);
  const ev = commitEvent(ticket, scanId, [
    { draft_key: "d-1", target: "new", operation_id: "op-res-zw", name: "锤子", location_text: "书房 / 书柜", highlights: [hl(0, 900)] },
  ]);
  const commit = await itemsHandler(ev, deps);
  assert.equal(commit.ok, true, JSON.stringify(commit));
  await db.collection("location_scans").where({ household_id: HH_A, scan_id: scanId }).update({
    data: { status: "deleted", deleted_at: deps.now(), deleted_by: "user" },
  });
  const before = await dumpDb(db, ["location_scans", "video_evidence", "items", "video_upload_tickets", "locations"]);

  const retry = await itemsHandler(ev, deps);
  assert.equal(retry.ok, false, JSON.stringify(retry));
  assert.equal(retry.error, "OPERATION_CONFLICT");
  assert.deepEqual(await dumpDb(db, ["location_scans", "video_evidence", "items", "video_upload_tickets", "locations"]), before, "票据 CAS 之前的零写段整批拒绝");
});
