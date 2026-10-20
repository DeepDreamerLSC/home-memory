"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../cloudfunctions/videoCleanup/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const NOW = "2026-10-20T00:00:00.000Z";

function ticket(id, extra) {
  return Object.assign({
    _id: id,
    household_id: "hh_a",
    item_id: "it_a",
    cloud_path: "video-evidence/hh_a/" + id + ".mp4",
    status: "pending",
    created_at: "2026-10-18T00:00:00.000Z",
    expires_at: "2026-10-18T00:15:00.000Z",
  }, extra || {});
}

async function seeded(rows) {
  const db = createMemoryDb({});
  for (const r of rows) await db.collection("video_upload_tickets").add({ data: r });
  return db;
}

test("CLEANUP:只清理超过 24h 的 pending;bound 和未过期不碰", async () => {
  const rows = [
    ticket("vt_old_file", { file_id: "cloud://bucket/video-evidence/hh_a/a.mp4" }),
    ticket("vt_old_nofile"),
    ticket("vt_old_bound", {
      file_id: "cloud://bucket/video-evidence/hh_a/b.mp4",
      status: "bound",
      evidence_id: "ve_1",
    }),
    ticket("vt_fresh", {
      file_id: "cloud://bucket/video-evidence/hh_a/c.mp4",
      expires_at: "2026-10-19T23:00:00.000Z",
    }),
  ];
  const db = await seeded(rows);
  const deleted = [];
  const res = await handler({
    db,
    now: () => NOW,
    deleteCloudFiles: async (ids) => {
      deleted.push.apply(deleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID, status: 0 })) };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.scanned, 2);
  assert.equal(res.cleaned, 2);
  assert.equal(res.cancelled_without_file, 1);
  assert.equal(res.failed, 0);
  assert.deepEqual(deleted, ["cloud://bucket/video-evidence/hh_a/a.mp4"]);
  const after = (await db.collection("video_upload_tickets").where({}).get()).data;
  const byId = Object.fromEntries(after.map((x) => [x._id, x]));
  assert.equal(byId.vt_old_file.status, "cancelled");
  assert.equal(byId.vt_old_nofile.status, "cancelled");
  assert.equal(byId.vt_old_bound.status, "bound");
  assert.equal(byId.vt_fresh.status, "pending");
});

test("CLEANUP:逐文件删除失败时票继续保持 pending;文件已不存在视为成功", async () => {
  const rows = [
    ticket("vt_fail", { file_id: "cloud://bucket/video-evidence/hh_a/fail.mp4" }),
    ticket("vt_missing", { file_id: "cloud://bucket/video-evidence/hh_a/missing.mp4" }),
  ];
  const db = await seeded(rows);
  const res = await handler({
    db,
    now: () => NOW,
    deleteCloudFiles: async (ids) => ({
      fileList: ids.map((fileID) => ({
        fileID,
        status: fileID.indexOf("missing") === -1 ? -1 : -503003,
      })),
    }),
  });
  assert.equal(res.scanned, 2);
  assert.equal(res.cleaned, 1);
  assert.equal(res.failed, 1);
  const after = (await db.collection("video_upload_tickets").where({}).get()).data;
  const byId = Object.fromEntries(after.map((x) => [x._id, x]));
  assert.equal(byId.vt_fail.status, "pending");
  assert.equal(byId.vt_missing.status, "cancelled");
});

test("CLEANUP-B9:删除前核对证据引用;正式证据存在时只修复票据不删文件", async () => {
  const db = await seeded([
    ticket("vt_bound_late", { file_id: "cloud://bucket/video-evidence/hh_a/bound.mp4" }),
  ]);
  await db.collection("video_evidence").add({
    data: {
      _id: "ve_bound",
      household_id: "hh_a",
      item_id: "it_a",
      file_id: "cloud://bucket/video-evidence/hh_a/bound.mp4",
      duration_ms: 12000,
      video_w: 1280,
      video_h: 720,
      captured_location_text: "书房",
      consent_version: "v1",
      created_at: "2026-10-19T00:00:00.000Z",
    },
  });
  const deleted = [];
  const res = await handler({
    db,
    now: () => NOW,
    deleteCloudFiles: async (ids) => {
      deleted.push.apply(deleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID, status: 0 })) };
    },
  });
  assert.equal(res.scanned, 1);
  assert.equal(res.repaired_bound, 1);
  assert.equal(res.cleaned, 0);
  assert.deepEqual(deleted, []);
  const after = (await db.collection("video_upload_tickets").doc("vt_bound_late").get()).data;
  assert.equal(after.status, "bound");
  assert.equal(after.evidence_id, "ve_bound");
});

test("CLEANUP-RACE:已进入 binding 的票据不进入清理集合", async () => {
  const db = await seeded([
    ticket("vt_binding", {
      file_id: "cloud://bucket/video-evidence/hh_a/binding.mp4",
      status: "binding",
    }),
  ]);
  let calls = 0;
  const res = await handler({
    db,
    now: () => NOW,
    deleteCloudFiles: async () => { calls += 1; return { fileList: [] }; },
  });
  assert.equal(res.scanned, 0);
  assert.equal(calls, 0);
  const after = (await db.collection("video_upload_tickets").doc("vt_binding").get()).data;
  assert.equal(after.status, "binding");
});

test("CLEANUP-B12:超时 binding/cleaning 无证据恢复后同轮清理;有证据修复 bound", async () => {
  const db = await seeded([
    ticket("vt_stale_binding", {
      status: "binding",
      binding_at: "2026-10-19T23:00:00.000Z",
      file_id: "cloud://bucket/video-evidence/hh_a/b.mp4",
    }),
    ticket("vt_stale_cleaning", {
      status: "cleaning",
      cleaning_at: "2026-10-19T23:00:00.000Z",
      file_id: "cloud://bucket/video-evidence/hh_a/c.mp4",
    }),
    ticket("vt_stale_binding_bound", {
      status: "binding",
      binding_at: "2026-10-19T23:00:00.000Z",
      file_id: "cloud://bucket/video-evidence/hh_a/d.mp4",
    }),
    ticket("vt_fresh_binding", {
      status: "binding",
      binding_at: "2026-10-19T23:59:00.000Z",
      file_id: "cloud://bucket/video-evidence/hh_a/e.mp4",
    }),
  ]);
  await db.collection("video_evidence").add({
    data: {
      _id: "ve_d", household_id: "hh_a", item_id: "it_a",
      file_id: "cloud://bucket/video-evidence/hh_a/d.mp4",
      duration_ms: 1, video_w: 1, video_h: 1,
      captured_location_text: "", consent_version: "v1",
      created_at: "2026-10-19T23:00:00.000Z",
    },
  });
  const deleted = [];
  const res = await handler({
    db, now: () => NOW,
    deleteCloudFiles: async (ids) => {
      deleted.push.apply(deleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID, status: 0 })) };
    },
  });
  assert.equal(res.recovery.scanned, 3);
  assert.equal(res.recovery.to_pending, 2);
  assert.equal(res.recovery.to_bound, 1);
  assert.deepEqual(deleted.sort(), [
    "cloud://bucket/video-evidence/hh_a/b.mp4",
    "cloud://bucket/video-evidence/hh_a/c.mp4",
  ]);
  const byId = Object.fromEntries((await db.collection("video_upload_tickets").where({}).get()).data.map((x) => [x._id, x]));
  assert.equal(byId.vt_stale_binding.status, "cancelled");
  assert.equal(byId.vt_stale_cleaning.status, "cancelled");
  assert.equal(byId.vt_stale_binding_bound.status, "bound");
  assert.equal(byId.vt_stale_binding_bound.evidence_id, "ve_d");
  assert.equal(byId.vt_fresh_binding.status, "binding");
});

test("CLEANUP-B12:超时 cancelling 删除成功收敛 cancelled,失败恢复 pending", async () => {
  const db = await seeded([
    ticket("vt_cancel_ok", {
      status: "cancelling",
      cancelling_at: "2026-10-19T23:00:00.000Z",
      file_id: "cloud://bucket/video-evidence/hh_a/ok.mp4",
    }),
    ticket("vt_cancel_fail", {
      status: "cancelling",
      cancelling_at: "2026-10-19T23:00:00.000Z",
      file_id: "cloud://bucket/video-evidence/hh_a/fail.mp4",
    }),
  ]);
  const res = await handler({
    db, now: () => NOW,
    deleteCloudFiles: async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID, status: fileID.indexOf("fail") === -1 ? 0 : -1 })),
    }),
  });
  assert.equal(res.recovery.to_cancelled, 1);
  assert.equal(res.recovery.failed, 1);
  const byId = Object.fromEntries((await db.collection("video_upload_tickets").where({}).get()).data.map((x) => [x._id, x]));
  assert.equal(byId.vt_cancel_ok.status, "cancelled");
  assert.equal(byId.vt_cancel_fail.status, "pending");
});

// ---------- D1(issue #94):location_scans 引用复核 ----------

/** 直接注入 location_scans 行(按 asset/file 引用视频) */
async function seedScan(db, scanId, extra) {
  await db.collection("location_scans").add({
    data: Object.assign({
      _id: "ls_" + scanId,
      household_id: "hh_a",
      scan_id: scanId,
      location_id: "lc_shelf",
      location_path_snapshot: ["书房", "书柜"],
      location_text_snapshot: "书房 / 书柜",
      file_id: "cloud://bucket/video-evidence/hh_a/scan.mp4",
      asset_id: "va_scan_asset",
      upload_ticket: "vt_scan_zero",
      duration_ms: 12000,
      video_w: 1280,
      video_h: 720,
      candidate_count: 2,
      confirmed_count: 0,
      confirmed_item_ids: [],
      created_at: "2026-10-19T00:00:00.000Z",
      updated_at: "2026-10-19T00:00:00.000Z",
      status: "active"
    }, extra || {})
  });
}

test("CLEANUP-D1-SCAN:过期 pending 票据有 location_scans 引用 → 不删文件,修复 bound", async () => {
  const db = await seeded([
    ticket("vt_scan_zero", {
      purpose: "scene",
      scene_id: "scan-zero-01",
      asset_id: "va_scan_asset",
      file_id: "cloud://bucket/video-evidence/hh_a/scan.mp4",
    }),
  ]);
  await seedScan(db, "scan-zero-01");
  const deleted = [];
  const res = await handler({
    db,
    now: () => NOW,
    deleteCloudFiles: async (ids) => {
      deleted.push.apply(deleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID, status: 0 })) };
    },
  });
  assert.equal(res.scanned, 1);
  assert.equal(res.repaired_bound, 1, "scan 存在 → 视为有引用,修复 bound");
  assert.equal(res.cleaned, 0);
  assert.deepEqual(deleted, [], "commit 已落 scan 但 0 件证据成功:视频是 scan 的回看内容,绝不回收");
  const after = (await db.collection("video_upload_tickets").doc("vt_scan_zero").get()).data;
  assert.equal(after.status, "bound");
  const scans = (await db.collection("location_scans").where({}).get()).data;
  assert.equal(scans.length, 1, "scan 行原样保留");
});

test("CLEANUP-D1-SCAN-FILE-ONLY:旧行无 asset_id 时按 file_id 命中 scan 引用", async () => {
  const db = await seeded([
    ticket("vt_scan_file_only", {
      file_id: "cloud://bucket/video-evidence/hh_a/scan.mp4",
    }),
  ]);
  await seedScan(db, "scan-file-only-01", { asset_id: "" });
  const deleted = [];
  const res = await handler({
    db,
    now: () => NOW,
    deleteCloudFiles: async (ids) => {
      deleted.push.apply(deleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID, status: 0 })) };
    },
  });
  assert.equal(res.repaired_bound, 1);
  assert.deepEqual(deleted, []);
  const after = (await db.collection("video_upload_tickets").doc("vt_scan_file_only").get()).data;
  assert.equal(after.status, "bound");
});

test("CLEANUP-D1-NO-SCAN:无 scan 引用的过期票据照旧回收(B 行为零回归)", async () => {
  const db = await seeded([
    ticket("vt_no_scan", {
      file_id: "cloud://bucket/video-evidence/hh_a/no-scan.mp4",
    }),
  ]);
  const deleted = [];
  const res = await handler({
    db,
    now: () => NOW,
    deleteCloudFiles: async (ids) => {
      deleted.push.apply(deleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID, status: 0 })) };
    },
  });
  assert.equal(res.cleaned, 1);
  assert.deepEqual(deleted, ["cloud://bucket/video-evidence/hh_a/no-scan.mp4"]);
});
