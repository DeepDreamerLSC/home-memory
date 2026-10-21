"use strict";
// PR B 共享文件删除硬门槛：同一 file_id/asset_id 多行 evidence 时，
// 普通 videoEvidenceDelete 与 deleteItem 级联都必须锁内复核引用；
// 有引用只删当前行，最后引用才删云文件；云删除失败保留行可重试。
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH = "hh_11111111111111111111111111111111";
const DURATION = 12000;

function makeDeps(db, opts) {
  opts = opts || {};
  let seq = 0;
  let clock = 1760000000000;
  const cloudDeleted = [];
  const state = { failDelete: opts.failDelete === true };
  return {
    db,
    cloudDeleted,
    state,
    householdId: HH,
    householdShared: false,
    scopeRevision: null,
    now: () => new Date(clock).toISOString(),
    genId: () => { seq += 1; return "n" + String(seq).padStart(12, "0"); },
    getTempFileUrls: async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID, tempFileURL: "https://tmp.example/" + encodeURIComponent(fileID) })),
    }),
    deleteCloudFiles: async (ids) => {
      if (state.failDelete === true) return { fileList: ids.map((fileID) => ({ fileID, status: -1 })) };
      cloudDeleted.push.apply(cloudDeleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID, status: 0 })) };
    },
    logger: { log: () => {} },
  };
}

function freshDb() {
  return createMemoryDb({ uniqueIndexes: { video_evidence: [["household_id", "item_id", "file_id"]] } });
}

async function rawDocs(db, name) {
  const res = await db.collection(name).where({}).get();
  return res.data || [];
}

function hl(start, end) {
  return { start_ms: start, end_ms: end, box: null, frame_ms: start };
}

async function setupSharedScene(deps, sceneId, count) {
  const begin = await handler({
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
  await handler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId }, deps);
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push({
      draft_key: "d" + i,
      target: "new",
      operation_id: "op-shared-" + sceneId + "-" + i,
      name: "同名物品",
      location_text: "抽屉",
      highlights: [hl(i * 1000, i * 1000 + 500)],
    });
  }
  const commit = await handler({
    action: "videoSceneCommit",
    scene_id: sceneId,
    upload_ticket: begin.upload_ticket,
    asset_id: begin.asset_id,
    file_id: fileId,
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
    consent_version: "v1",
    items,
  }, deps);
  assert.equal(commit.ok, true, JSON.stringify(commit));
  assert.equal(commit.ticket_state, "bound");
  const evidence = await rawDocs(deps.db, "video_evidence");
  return { begin, fileId, items: commit.results, evidence, sceneId };
}

test("SHARE-DELETE:删 A 只删自己行且云文件保留，删 B 最后引用才删云文件", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ctx = await setupSharedScene(deps, "scene-share-del-01", 2);
  const rowA = ctx.evidence.find((r) => r.item_id === ctx.items[0].item_id);
  const rowB = ctx.evidence.find((r) => r.item_id === ctx.items[1].item_id);
  assert.ok(rowA);
  assert.ok(rowB);

  const deleteA = await handler({ action: "videoEvidenceDelete", item_id: rowA.item_id, evidence_id: rowA._id }, deps);
  assert.equal(deleteA.ok, true, JSON.stringify(deleteA));
  assert.equal(deleteA.deleted, 1);
  assert.deepEqual(deps.cloudDeleted, []);
  let rows = await rawDocs(db, "video_evidence");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_id, rowB.item_id);
  let ticket = (await rawDocs(db, "video_upload_tickets"))[0];
  assert.equal(ticket.status, "bound", "仍有其他 item 引用时票据必须保持 bound");

  const deleteB = await handler({ action: "videoEvidenceDelete", item_id: rowB.item_id, evidence_id: rowB._id }, deps);
  assert.equal(deleteB.ok, true, JSON.stringify(deleteB));
  assert.equal(deleteB.deleted, 1);
  assert.deepEqual(deps.cloudDeleted, [ctx.fileId]);
  rows = await rawDocs(db, "video_evidence");
  assert.equal(rows.length, 0);
  ticket = (await rawDocs(db, "video_upload_tickets"))[0];
  assert.equal(ticket.status, "deleted");
});

test("SHARE-CASCADE:删除物品 A 只清 A 引用；删除最后引用物品才删云文件", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ctx = await setupSharedScene(deps, "scene-share-del-02", 2);
  const idA = ctx.items[0].item_id;
  const idB = ctx.items[1].item_id;

  const delA = await handler({ action: "delete", item_id: idA }, deps);
  assert.equal(delA.ok, true, JSON.stringify(delA));
  assert.deepEqual(deps.cloudDeleted, []);
  let rows = await rawDocs(db, "video_evidence");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_id, idB);
  const aliveB = await handler({ action: "get", item_id: idB }, deps);
  assert.equal(aliveB.ok, true);

  const delB = await handler({ action: "delete", item_id: idB }, deps);
  assert.equal(delB.ok, true, JSON.stringify(delB));
  assert.deepEqual(deps.cloudDeleted, [ctx.fileId]);
  rows = await rawDocs(db, "video_evidence");
  assert.equal(rows.length, 0);
  const ticket = (await rawDocs(db, "video_upload_tickets"))[0];
  assert.equal(ticket.status, "deleted");
});

test("SHARE-DELETE-FAIL:最后引用云删除失败时行/物品保留，修复后可重试", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ctx = await setupSharedScene(deps, "scene-share-del-03", 2);
  const rowA = ctx.evidence.find((r) => r.item_id === ctx.items[0].item_id);
  const rowB = ctx.evidence.find((r) => r.item_id === ctx.items[1].item_id);

  const deleteA = await handler({ action: "videoEvidenceDelete", item_id: rowA.item_id, evidence_id: rowA._id }, deps);
  assert.equal(deleteA.ok, true);
  deps.state.failDelete = true;
  const failed = await handler({ action: "videoEvidenceDelete", item_id: rowB.item_id, evidence_id: rowB._id }, deps);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "VIDEO_DELETE_FAILED");
  let rows = await rawDocs(db, "video_evidence");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_id, rowB.item_id);

  deps.state.failDelete = false;
  const retry = await handler({ action: "videoEvidenceDelete", item_id: rowB.item_id, evidence_id: rowB._id }, deps);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.deepEqual(deps.cloudDeleted, [ctx.fileId]);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
});

test("SHARE-ASSET-LOCK:asset 锁忙时不删行/不删云文件，返回 VIDEO_ITEM_BUSY", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ctx = await setupSharedScene(deps, "scene-share-lock-01", 2);
  const rowA = ctx.evidence.find((r) => r.item_id === ctx.items[0].item_id);
  await db.collection("video_item_locks").add({ data: {
    _id: "val_" + ctx.begin.asset_id,
    household_id: HH,
    asset_id: ctx.begin.asset_id,
    owner_token: "other",
    purpose: "evidence_delete",
    expires_at: "2099-01-01T00:00:00.000Z",
  } });
  const res = await handler({ action: "videoEvidenceDelete", item_id: rowA.item_id, evidence_id: rowA._id }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "VIDEO_ITEM_BUSY");
  assert.equal((await rawDocs(db, "video_evidence")).length, 2);
  assert.deepEqual(deps.cloudDeleted, []);

  // 物品级联删除同样必须先取 asset 锁；锁忙时物品保持存活。
  const cascade = await handler({ action: "delete", item_id: rowA.item_id }, deps);
  assert.equal(cascade.ok, false);
  assert.equal(cascade.error, "VIDEO_ITEM_BUSY");
  const alive = await handler({ action: "get", item_id: rowA.item_id }, deps);
  assert.equal(alive.ok, true);
  assert.equal((await rawDocs(db, "video_evidence")).length, 2);
});

test("SHARE-LEGACY:旧行无 asset_id 时按 file_id 复核引用，不误删共享文件", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemA = (await handler({ action: "create", operation_id: "op-legacy-a", name: "A", location_text: "抽屉" }, deps)).item.item_id;
  const itemB = (await handler({ action: "create", operation_id: "op-legacy-b", name: "B", location_text: "抽屉" }, deps)).item.item_id;
  const fileId = "cloud://bucket/video-evidence/" + HH + "/legacy.mp4";
  await db.collection("video_evidence").add({ data: {
    _id: "ve_legacy_a", household_id: HH, item_id: itemA, file_id: fileId,
    duration_ms: DURATION, video_w: 1280, video_h: 720, captured_location_text: "抽屉",
    consent_version: "v1", source: "manual", highlights: [], highlight_version: 0,
    created_at: "2026-10-19T00:00:00.000Z",
  } });
  await db.collection("video_evidence").add({ data: {
    _id: "ve_legacy_b", household_id: HH, item_id: itemB, file_id: fileId,
    duration_ms: DURATION, video_w: 1280, video_h: 720, captured_location_text: "抽屉",
    consent_version: "v1", source: "manual", highlights: [], highlight_version: 0,
    created_at: "2026-10-19T00:00:00.000Z",
  } });
  const deleteA = await handler({ action: "videoEvidenceDelete", item_id: itemA, evidence_id: "ve_legacy_a" }, deps);
  assert.equal(deleteA.ok, true, JSON.stringify(deleteA));
  assert.deepEqual(deps.cloudDeleted, []);
  const rows = await rawDocs(db, "video_evidence");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_id, itemB);
});

test("SHARE-CLEANUP:scene ticket 过期清理必须先按 asset/file 查全部 item 引用", async () => {
  const cleanupHandler = require("../cloudfunctions/videoCleanup/lib/handler").handler;
  const db = freshDb();
  const fileId = "cloud://bucket/video-evidence/" + HH + "/scene-cleanup.mp4";
  await db.collection("video_upload_tickets").add({ data: {
    _id: "vt_scene_cleanup",
    household_id: HH,
    purpose: "scene",
    scene_id: "scene-cleanup-01",
    asset_id: "va_cleanup_asset",
    status: "pending",
    file_id: fileId,
    cloud_path: "video-evidence/" + HH + "/scene-cleanup.mp4",
    created_at: "2026-10-18T00:00:00.000Z",
    expires_at: "2026-10-18T00:15:00.000Z",
  } });
  await db.collection("video_evidence").add({ data: {
    _id: "ve_scene_cleanup_b",
    household_id: HH,
    item_id: "it_cleanup_b",
    file_id: fileId,
    asset_id: "va_cleanup_asset",
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
    consent_version: "v1",
    highlights: [],
    highlight_version: 0,
    created_at: "2026-10-19T00:00:00.000Z",
  } });
  const deleted = [];
  const res = await cleanupHandler({
    db,
    now: () => "2026-10-20T00:00:00.000Z",
    deleteCloudFiles: async (ids) => {
      deleted.push.apply(deleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID, status: 0 })) };
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(deleted, []);
  const ticket = (await db.collection("video_upload_tickets").doc("vt_scene_cleanup").get()).data;
  assert.equal(ticket.status, "bound");
  assert.equal((await rawDocs(db, "video_evidence")).length, 1);
});
