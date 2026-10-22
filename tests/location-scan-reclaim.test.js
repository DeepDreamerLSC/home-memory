"use strict";
// D2 0 确认到期回收合同(issue #96,docs/design/video-ai/D2-IMPLEMENTATION.md §1/§5/§7 矩阵 C):
// videoCleanup 第三阶段 reclaimZeroConfirmScans(同一 deps.now 可控时钟):
// 30 天边界恰好含端点(29 天不收/恰满 30 天收)、confirmed_count>0 永不进候选、
// 已回收不重复处理、行保留与 created_at/计数逐字节不动、R1/R2/R3 引用跳过、
// 云删失败留待下次不假报、location_deleted 同策、终态 deleted 不进候选、
// 无 file_id 行跳过、单轮批上限 50、asset 锁忙跳过;§1 收紧:终态/已回收 scan
// 行不再永久挡住 24h 孤儿回收(矩阵 R2 语义替换「任意行存在即引用」)。
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../cloudfunctions/videoCleanup/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const NOW_MS = Date.parse("2026-10-20T00:00:00.000Z");
const NOW = new Date(NOW_MS).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;
const RETAIN_MS = 30 * DAY_MS; // §5 冻结阈值
const RECLAIM_BATCH_MAX = 50; // §5 冻结单轮批上限
const HH = "hh_a";

/** 可控时钟:n 天前的 created_at(毫秒构造,无真时钟依赖) */
function daysAgo(n) {
  return new Date(NOW_MS - n * DAY_MS).toISOString();
}

/** 直接注入 location_scans 行;默认 active、0 确认、已超期、file_id 独立 */
async function seedScan(db, scanId, extra) {
  const doc = Object.assign({
    _id: "ls_" + scanId,
    household_id: HH,
    scan_id: scanId,
    location_id: "lc_shelf",
    location_path_snapshot: ["书房", "书柜"],
    location_text_snapshot: "书房 / 书柜",
    file_id: "cloud://bucket/video-evidence/hh_a/" + scanId + ".mp4",
    asset_id: "va_" + scanId,
    upload_ticket: "vt_" + scanId,
    duration_ms: 12000,
    video_w: 1280,
    video_h: 720,
    candidate_count: 5,
    confirmed_count: 0,
    confirmed_item_ids: [],
    created_at: daysAgo(40),
    updated_at: daysAgo(40),
    status: "active",
  }, extra || {});
  await db.collection("location_scans").add({ data: doc });
  return doc;
}

/** 直接注入票据(默认 bound;pending 场景须显式改 status/expires_at) */
async function seedTicket(db, id, extra) {
  await db.collection("video_upload_tickets").add({
    data: Object.assign({
      _id: id,
      household_id: HH,
      item_id: "it_a",
      purpose: "scene",
      scene_id: id.replace(/^vt_/, "scene-"),
      cloud_path: "video-evidence/hh_a/" + id + ".mp4",
      status: "bound",
      created_at: daysAgo(40),
      expires_at: daysAgo(40),
    }, extra || {}),
  });
}

async function seedEvidence(db, id, fileId, assetId) {
  await db.collection("video_evidence").add({
    data: {
      _id: id,
      household_id: HH,
      item_id: "it_a",
      file_id: fileId,
      asset_id: assetId,
      scan_id: "",
      source: "manual",
      duration_ms: 12000,
      video_w: 1280,
      video_h: 720,
      captured_location_text: "书房",
      consent_version: "v1",
      created_at: daysAgo(40),
    },
  });
}

/** 占住 asset 锁(video_item_locks,_id=val_<asset_id>,与 itemsApi 同键同语义) */
async function holdAssetLock(db, assetId) {
  await db.collection("video_item_locks").add({
    data: {
      _id: "val_" + assetId,
      household_id: HH,
      lock_kind: "asset",
      owner_token: "held-by-itemsapi",
      purpose: "scene_commit",
      asset_id: assetId,
      created_at: NOW,
      expires_at: new Date(NOW_MS + 60 * 1000).toISOString(),
    },
  });
}

function makeDeps(db, opts) {
  opts = opts || {};
  const deleted = [];
  const failIds = opts.failIds || [];
  return {
    db,
    now: () => NOW,
    deleted,
    deleteCloudFiles: async (ids) => {
      deleted.push.apply(deleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID, status: failIds.indexOf(fileID) === -1 ? 0 : -1 })) };
    },
    logger: { log: () => {} },
  };
}

async function scansOf(db) {
  return (await db.collection("location_scans").where({}).get()).data || [];
}

test("RC-29-30:恰好 29 天不收,恰好满 30 天即收(边界含端点)", async () => {
  const db = createMemoryDb({ uniqueIndexes: { location_scans: [["household_id", "scan_id"]] } });
  const scan29 = await seedScan(db, "scanrc-29d", { created_at: daysAgo(29) });
  const scan30 = await seedScan(db, "scanrc-30d", { created_at: new Date(NOW_MS - RETAIN_MS).toISOString() });
  await seedTicket(db, "vt_scanrc-30d", { asset_id: scan30.asset_id, file_id: scan30.file_id }); // bound 不占引用
  const deps = makeDeps(db);
  const res = await handler(deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const rows = Object.fromEntries((await scansOf(db)).map((r) => [r.scan_id, r]));
  assert.equal(rows["scanrc-30d"].video_reclaimed_at, NOW, "恰满 30 天即候选(含端点),回收时间 = deps.now()");
  assert.equal(rows["scanrc-30d"].video_reclaim_reason, "zero_confirm_expired");
  assert.equal(rows["scanrc-30d"].status, "active", "回收不迁移 status(§5 第 6 步)");
  assert.equal(rows["scanrc-29d"].video_reclaimed_at, undefined, "29 天不收");
  assert.equal(rows["scanrc-29d"].status, "active");
  assert.deepEqual(deps.deleted, [scan30.file_id], "只有到期行的文件被删");
  assert.equal(deps.deleted.indexOf(scan29.file_id), -1);
});

test("RC-CONFIRMED / 边界行:confirmed_count≥1 或非整数计数哪怕超期不收;无 file_id 无从回收", async () => {
  const db = createMemoryDb({ uniqueIndexes: { location_scans: [["household_id", "scan_id"]] } });
  const confirmed = await seedScan(db, "scanrc-confirmed", {
    confirmed_count: 2, confirmed_item_ids: ["it_x", "it_y"],
  });
  const strZero = await seedScan(db, "scanrc-strzero", { confirmed_count: "0" }); // 非整数:Number.isInteger 门挡下
  const noFile = await seedScan(db, "scanrc-nofile", { file_id: "" });
  const deps = makeDeps(db);
  const res = await handler(deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const rows = Object.fromEntries((await scansOf(db)).map((r) => [r.scan_id, r]));
  assert.equal(rows["scanrc-confirmed"].video_reclaimed_at, undefined, "confirmed_count ≥ 1 永不自动回收");
  assert.equal(rows["scanrc-confirmed"].status, "active");
  assert.equal(rows["scanrc-strzero"].video_reclaimed_at, undefined, "候选过滤是 Number.isInteger 且 ===0(§5),字符串零不收");
  assert.equal(rows["scanrc-nofile"].video_reclaimed_at, undefined, "file_id 非空字符串才进候选(§5)");
  assert.deepEqual(deps.deleted, [], "三类边界行的文件都不动");
  assert.equal(deps.deleted.indexOf(confirmed.file_id), -1);
});

test("RC-NO-DOUBLE:已置 video_reclaimed_at 的行不重复处理", async () => {
  const db = createMemoryDb({ uniqueIndexes: { location_scans: [["household_id", "scan_id"]] } });
  const scan = await seedScan(db, "scanrc-dbl", {
    video_reclaimed_at: daysAgo(1),
    video_reclaim_reason: "zero_confirm_expired",
    updated_at: daysAgo(1),
  });
  const deps = makeDeps(db);
  const res = await handler(deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(deps.deleted, [], "已回收不重复删文件(文件早已不在,也不得再次尝试)");
  const row = (await scansOf(db))[0];
  assert.equal(row.video_reclaimed_at, daysAgo(1), "回收标记保持原值");
  assert.equal(row.updated_at, daysAgo(1), "不重复改写");
});

test("RC-KEEP-ROW-AND-COUNTS:回收后行仍在,created_at/计数逐字节不变,仅新增回收标记", async () => {
  const db = createMemoryDb({ uniqueIndexes: { location_scans: [["household_id", "scan_id"]] } });
  const scan = await seedScan(db, "scanrc-keep", {
    candidate_count: 7, confirmed_count: 0, confirmed_item_ids: [],
  });
  await seedTicket(db, scan.upload_ticket, { asset_id: scan.asset_id, file_id: scan.file_id });
  const deps = makeDeps(db);
  const res = await handler(deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = (await scansOf(db))[0];
  assert.equal(row.status, "active", "status 不迁移");
  assert.equal(row.created_at, scan.created_at, "created_at 逐字节不变(约束 3)");
  assert.equal(row.candidate_count, 7, "candidate_count 不动");
  assert.equal(row.confirmed_count, 0, "confirmed_count 不动");
  assert.deepEqual(row.confirmed_item_ids, []);
  assert.equal(row.video_reclaimed_at, NOW);
  assert.equal(row.video_reclaim_reason, "zero_confirm_expired");
  assert.equal(row.updated_at, NOW, "允许维护性更新 updated_at");
  assert.deepEqual(deps.deleted, [scan.file_id]);
  const ticket = (await db.collection("video_upload_tickets").doc(scan.upload_ticket).get()).data;
  assert.equal(ticket.status, "deleted", "best-effort:bound 票据置 deleted");
  assert.equal(ticket.cleanup_reason, "scan_reclaimed");
});

test("RC-REF-EVIDENCE / RC-REF-OTHER-SCAN / RC-REF-TICKET:有 R1/R2/R3 引用 → 跳过不删文件不置标记", async () => {
  const db = createMemoryDb({ uniqueIndexes: { location_scans: [["household_id", "scan_id"]] } });
  // R1:同 asset/file 的活 evidence 行
  const r1 = await seedScan(db, "scanrc-ref-ev");
  await seedEvidence(db, "ve_rc_1", r1.file_id, r1.asset_id);
  // R2:候选行(默认 40 天超期)的文件同时被另一仍保留视频的 scan 持有(active、未回收)
  const r2File = "cloud://bucket/video-evidence/hh_a/shared-rc.mp4";
  const r2 = await seedScan(db, "scanrc-ref-scan", { file_id: r2File, asset_id: "va_rc_shared" });
  await seedScan(db, "scanrc-ref-holder", { file_id: r2File, asset_id: "va_rc_shared", created_at: daysAgo(2) });
  // R3:同文件的未结算票据(pending 未过期,24h 孤儿回收也不碰)
  const r3 = await seedScan(db, "scanrc-ref-ticket");
  await seedTicket(db, "vt_rc_inflight", {
    status: "pending", asset_id: "", file_id: r3.file_id, expires_at: "2999-01-01T00:00:00.000Z",
  });
  const deps = makeDeps(db);
  const res = await handler(deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const rows = Object.fromEntries((await scansOf(db)).map((x) => [x.scan_id, x]));
  for (const id of ["scanrc-ref-ev", "scanrc-ref-scan", "scanrc-ref-ticket"]) {
    assert.equal(rows[id].video_reclaimed_at, undefined, id + ":有引用跳过,留下次");
    assert.equal(rows[id].video_reclaim_reason, undefined);
    assert.equal(rows[id].status, "active", "跳过不改任何字段");
  }
  assert.deepEqual(deps.deleted, [], "三处文件都不删");
  const inflight = (await db.collection("video_upload_tickets").doc("vt_rc_inflight").get()).data;
  assert.equal(inflight.status, "pending", "在途票据不被回收路径动");
});

test("RC-CLOUD-FAIL:云删失败 → scan 零标记计 failed;下一轮重试成功", async () => {
  const db = createMemoryDb({ uniqueIndexes: { location_scans: [["household_id", "scan_id"]] } });
  const scan = await seedScan(db, "scanrc-cloudfail");
  const failDeps = makeDeps(db, { failIds: [scan.file_id] });
  const res = await handler(failDeps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = (await scansOf(db))[0];
  assert.equal(row.video_reclaimed_at, undefined, "云删失败不置回收标记,不假报成功");
  assert.equal(row.status, "active");
  assert.deepEqual(failDeps.deleted, [scan.file_id], "删除调用确实发出过");
  // 下一轮(时钟再进,此处时钟不变即仍超期)修好后重试成功
  const okDeps = makeDeps(db);
  const res2 = await handler(okDeps);
  assert.equal(res2.ok, true, JSON.stringify(res2));
  const row2 = (await scansOf(db))[0];
  assert.equal(row2.video_reclaimed_at, NOW, "下一轮重试成功才置标记");
  assert.equal(row2.video_reclaim_reason, "zero_confirm_expired");
});

test("RC-LOC-DELETED:location_deleted 的 0 确认超期行同策回收(页面不可见不滞留)", async () => {
  const db = createMemoryDb({ uniqueIndexes: { location_scans: [["household_id", "scan_id"]] } });
  const scan = await seedScan(db, "scanrc-locdel", {
    status: "location_deleted",
    location_deleted_at: daysAgo(35),
    created_at: daysAgo(36),
  });
  await seedTicket(db, scan.upload_ticket, { asset_id: scan.asset_id, file_id: scan.file_id });
  const deps = makeDeps(db);
  const res = await handler(deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = (await scansOf(db))[0];
  assert.equal(row.status, "location_deleted", "回收不迁移 status,location_deleted 原样");
  assert.equal(row.created_at, daysAgo(36), "created_at 不动");
  assert.equal(row.video_reclaimed_at, NOW);
  assert.equal(row.video_reclaim_reason, "zero_confirm_expired");
  assert.deepEqual(deps.deleted, [scan.file_id]);
});

test("RC-DELETED-EXCLUDED:终态 deleted 行不进候选(一期冻结范围)", async () => {
  const db = createMemoryDb({ uniqueIndexes: { location_scans: [["household_id", "scan_id"]] } });
  const scan = await seedScan(db, "scanrc-terminal", {
    status: "deleted", deleted_at: daysAgo(35),
  });
  const deps = makeDeps(db);
  const res = await handler(deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = (await scansOf(db))[0];
  assert.equal(row.video_reclaimed_at, undefined);
  assert.equal(row.status, "deleted");
  assert.deepEqual(deps.deleted, [], "终态行文件处置是 §9 开放问题,一期不碰");
});

test("RC-BATCH-CAP:51 条候选单轮只处理 50,下一轮补齐", async () => {
  const db = createMemoryDb({ uniqueIndexes: { location_scans: [["household_id", "scan_id"]] } });
  for (let i = 0; i < 51; i++) {
    await seedScan(db, "scanrc-cap-" + String(i).padStart(2, "0"));
  }
  const deps1 = makeDeps(db);
  const res1 = await handler(deps1);
  assert.equal(res1.ok, true, JSON.stringify(res1));
  let reclaimed = (await scansOf(db)).filter((r) => r.video_reclaimed_at !== undefined);
  assert.equal(reclaimed.length, RECLAIM_BATCH_MAX, "RECLAIM_BATCH_MAX=50 冻结常量,超出留下次");
  const deps2 = makeDeps(db);
  const res2 = await handler(deps2);
  assert.equal(res2.ok, true, JSON.stringify(res2));
  reclaimed = (await scansOf(db)).filter((r) => r.video_reclaimed_at !== undefined);
  assert.equal(reclaimed.length, 51, "下一轮每日运行补齐剩余");
  assert.equal(deps1.deleted.length, 50);
  assert.equal(deps2.deleted.length, 1);
});

test("RC-LOCK-BUSY:asset 锁被占 → skipped 下一行;行原样", async () => {
  const db = createMemoryDb({ uniqueIndexes: { location_scans: [["household_id", "scan_id"]] } });
  const locked = await seedScan(db, "scanrc-locked");
  await holdAssetLock(db, locked.asset_id);
  const free = await seedScan(db, "scanrc-free");
  const deps = makeDeps(db);
  const res = await handler(deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const rows = Object.fromEntries((await scansOf(db)).map((r) => [r.scan_id, r]));
  assert.equal(rows["scanrc-locked"].video_reclaimed_at, undefined, "锁忙跳过,行原样");
  assert.equal(rows["scanrc-locked"].status, "active");
  assert.equal(rows["scanrc-free"].video_reclaimed_at, NOW, "锁忙不阻塞后续行");
  assert.deepEqual(deps.deleted, [free.file_id]);
});

test("RC-LEGACY-NO-ASSET:旧行无 asset_id 按 file_id 判定与回收", async () => {
  const db = createMemoryDb({ uniqueIndexes: { location_scans: [["household_id", "scan_id"]] } });
  const scan = await seedScan(db, "scanrc-legacy", { asset_id: "" });
  const deps = makeDeps(db);
  const res = await handler(deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = (await scansOf(db))[0];
  assert.equal(row.video_reclaimed_at, NOW, "无 asset_id 的 0 确认超期行照常回收(file_id 回退)");
  assert.deepEqual(deps.deleted, [scan.file_id]);
});

// ---------- §1 收紧:scanRefsTicket 从「任意行存在」改为 R2 语义 ----------

test("RC-SCANREF-TIGHTEN:active 未回收 scan 仍挡孤儿回收;终态/已回收行不再永久挡住", async () => {
  // a) active 未回收(未到期):24h 孤儿回收仍被 scan 引用挡住(D1 行为不变)
  const dbA = createMemoryDb({});
  const fileA = "cloud://bucket/video-evidence/hh_a/tighten-active.mp4";
  await seedScan(dbA, "scanrc-tighten-a", {
    file_id: fileA, asset_id: "va_tighten_a", created_at: daysAgo(1), confirmed_count: 0,
  });
  await seedTicket(dbA, "vt_tighten_a", {
    status: "pending", asset_id: "va_tighten_a", file_id: fileA, expires_at: daysAgo(2),
  });
  const depsA = makeDeps(dbA);
  const resA = await handler(depsA);
  assert.equal(resA.ok, true, JSON.stringify(resA));
  assert.equal(resA.repaired_bound, 1, "R2:仍保留视频的 scan 持有引用,票据修复 bound");
  assert.deepEqual(depsA.deleted, [], "0 确认未到 30 天:视频是 scan 回看内容,绝不回收");
  assert.equal((await dbA.collection("video_upload_tickets").doc("vt_tighten_a").get()).data.status, "bound");

  // b) scan 行已终结(purge deleted):不再占引用,孤儿回收放行
  const dbB = createMemoryDb({});
  const fileB = "cloud://bucket/video-evidence/hh_a/tighten-terminal.mp4";
  await seedScan(dbB, "scanrc-tighten-b", {
    file_id: fileB, asset_id: "va_tighten_b", created_at: daysAgo(1),
    status: "deleted", deleted_at: daysAgo(1),
  });
  await seedTicket(dbB, "vt_tighten_b", {
    status: "pending", asset_id: "va_tighten_b", file_id: fileB, expires_at: daysAgo(2),
  });
  const depsB = makeDeps(dbB);
  const resB = await handler(depsB);
  assert.equal(resB.ok, true, JSON.stringify(resB));
  assert.deepEqual(depsB.deleted, [fileB], "终态 deleted 的审计行不占引用(§1 收紧)");
  assert.equal((await dbB.collection("video_upload_tickets").doc("vt_tighten_b").get()).data.status, "cancelled");

  // c) scan 行已回收(active + video_reclaimed_at):不再占引用
  const dbC = createMemoryDb({});
  const fileC = "cloud://bucket/video-evidence/hh_a/tighten-reclaimed.mp4";
  await seedScan(dbC, "scanrc-tighten-c", {
    file_id: fileC, asset_id: "va_tighten_c", created_at: daysAgo(1),
    video_reclaimed_at: daysAgo(1), video_reclaim_reason: "zero_confirm_expired",
  });
  await seedTicket(dbC, "vt_tighten_c", {
    status: "pending", asset_id: "va_tighten_c", file_id: fileC, expires_at: daysAgo(2),
  });
  const depsC = makeDeps(dbC);
  const resC = await handler(depsC);
  assert.equal(resC.ok, true, JSON.stringify(resC));
  assert.deepEqual(depsC.deleted, [fileC], "已回收的 scan 行不占引用(§1 收紧)");
  assert.equal((await dbC.collection("video_upload_tickets").doc("vt_tighten_c").get()).data.status, "cancelled");
});
