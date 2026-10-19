"use strict";
// 单件视频留证离线合同测试:上传票据、路径归属、幂等绑定、删除清理。
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH_A = "hh_11111111111111111111111111111111";
const HH_B = "hh_22222222222222222222222222222222";

function makeDeps(db, opts) {
  opts = opts || {};
  let seq = 0;
  let clock = 1760000000000;
  const deps = {
    db: db,
    householdId: opts.householdId || HH_A,
    householdShared: false,
    scopeRevision: null,
    now: () => new Date(clock).toISOString(),
    advance: (ms) => { clock += ms; },
    genId: () => { seq += 1; return "n" + String(seq).padStart(12, "0"); },
    getTempFileUrls: opts.getTempFileUrls || (async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID: fileID, tempFileURL: "https://tmp.example/" + encodeURIComponent(fileID) })),
    })),
    deleteCloudFiles: opts.deleteCloudFiles || (async () => ({ fileList: [] })),
    logger: { log: () => {} },
  };
  return deps;
}

function freshDb() {
  return createMemoryDb({
    uniqueIndexes: {
      video_evidence: [["household_id", "item_id", "file_id"]],
    },
  });
}

async function rawDocs(db, name) {
  const res = await db.collection(name).where({}).get();
  return res.data || [];
}

async function createItem(deps, op, name) {
  const res = await handler({
    action: "create",
    operation_id: op,
    name: name || "黑色耳机",
    location_text: "书房 · 右侧抽屉",
  }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.item.item_id;
}

function beginEvent(itemId) {
  return { action: "videoUploadBegin", item_id: itemId, ext: "mp4" };
}

function attachEvent(ticket, fileId) {
  return {
    action: "videoEvidenceAttach",
    upload_ticket: ticket.upload_ticket,
    file_id: fileId,
    duration_ms: 12000,
    video_w: 1280,
    video_h: 720,
    consent_version: "v1",
  };
}

test("VIDEO-TICKET:申请票据 -> 上传文件 -> 绑定证据 -> 幂等读取", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  assert.equal(begin.ok, true, JSON.stringify(begin));
  assert.ok(begin.upload_ticket.indexOf("vt_") === 0);
  assert.ok(begin.upload_path.indexOf("video-evidence/" + HH_A + "/") === 0);
  const fileId = "cloud://bucket/" + begin.upload_path;

  const attached = await handler(attachEvent(begin, fileId), deps);
  assert.equal(attached.ok, true, JSON.stringify(attached));
  assert.equal(attached.duplicated, false);
  assert.equal(attached.evidence.consent_version, "v1");
  assert.equal(attached.evidence.item_id, itemId);

  const retry = await handler(attachEvent(begin, fileId), deps);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicated, true);
  assert.equal((await rawDocs(db, "video_evidence")).length, 1);

  const got = await handler({ action: "videoEvidenceGet", item_ids: [itemId] }, deps);
  assert.equal(got.ok, true);
  assert.equal(got.evidence.length, 1);
  assert.equal(got.evidence[0].evidence_id, attached.evidence.evidence_id);
  assert.ok(got.evidence[0].video_url.indexOf("https://tmp.example/") === 0);
});

test("VIDEO-OWNERSHIP:票据路径、家庭和文件可用性都必须匹配", async () => {
  const db = freshDb();
  const depsA = makeDeps(db, { householdId: HH_A });
  const itemId = await createItem(depsA, "op-a");
  const begin = await handler(beginEvent(itemId), depsA);
  const goodFile = "cloud://bucket/" + begin.upload_path;

  const mismatch = await handler(attachEvent(begin, "cloud://bucket/video-evidence/" + HH_A + "/forged.mp4"), depsA);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, "FILE_NOT_OWNED");

  const depsB = makeDeps(db, { householdId: HH_B });
  const crossHome = await handler(attachEvent(begin, goodFile), depsB);
  assert.equal(crossHome.ok, false);
  assert.equal(crossHome.error, "FILE_NOT_OWNED");

  const noFileDeps = makeDeps(db, { getTempFileUrls: async () => ({ fileList: [] }) });
  const unavailable = await handler(attachEvent(begin, goodFile), noFileDeps);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, "VIDEO_NOT_AVAILABLE");
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
});

test("VIDEO-EXPIRY:过期或已取消票据不能绑定", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-a");
  const expired = await handler(beginEvent(itemId), deps);
  deps.advance(16 * 60 * 1000);
  const expiredRes = await handler(attachEvent(expired, "cloud://bucket/" + expired.upload_path), deps);
  assert.equal(expiredRes.ok, false);
  assert.equal(expiredRes.error, "INVALID_INPUT");

  const cancelled = await handler(beginEvent(itemId), deps);
  const cancel = await handler({ action: "videoUploadCancel", upload_ticket: cancelled.upload_ticket }, deps);
  assert.equal(cancel.ok, true);
  const cancelledRes = await handler(attachEvent(cancelled, "cloud://bucket/" + cancelled.upload_path), deps);
  assert.equal(cancelledRes.ok, false);
  assert.equal(cancelledRes.error, "INVALID_INPUT");
});

test("VIDEO-DELETE:手动删除先删云文件再删证据行;云删除失败则保留", async () => {
  const db = freshDb();
  let failDelete = false;
  const deleted = [];
  const deps = makeDeps(db, {
    deleteCloudFiles: async (ids) => {
      if (failDelete) throw new Error("cloud fail");
      deleted.push.apply(deleted, ids);
    },
  });
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  const attached = await handler(attachEvent(begin, fileId), deps);
  assert.equal(attached.ok, true);

  failDelete = true;
  const failed = await handler({ action: "videoEvidenceDelete", item_id: itemId, evidence_id: attached.evidence.evidence_id }, deps);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "VIDEO_DELETE_FAILED");
  assert.equal((await rawDocs(db, "video_evidence")).length, 1);

  failDelete = false;
  const ok = await handler({ action: "videoEvidenceDelete", item_id: itemId, evidence_id: attached.evidence.evidence_id }, deps);
  assert.equal(ok.ok, true);
  assert.equal(ok.deleted, 1);
  assert.deepEqual(deleted, [fileId]);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
});

test("VIDEO-CASCADE:删除物品前清理视频;云删除失败时物品保持可重试", async () => {
  const db = freshDb();
  let failDelete = false;
  const deps = makeDeps(db, {
    deleteCloudFiles: async () => {
      if (failDelete) throw new Error("cloud fail");
    },
  });
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  await handler(attachEvent(begin, fileId), deps);

  failDelete = true;
  const blocked = await handler({ action: "delete", item_id: itemId }, deps);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "VIDEO_DELETE_FAILED");
  const alive = await handler({ action: "get", item_id: itemId }, deps);
  assert.equal(alive.ok, true);

  failDelete = false;
  const removed = await handler({ action: "delete", item_id: itemId }, deps);
  assert.equal(removed.ok, true);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
  const gone = await handler({ action: "get", item_id: itemId }, deps);
  assert.equal(gone.ok, false);
  assert.equal(gone.error, "NOT_FOUND");
});

test("VIDEO-READ:读侧家庭隔离;换链失败仍返回证据但 video_url 为空", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  await handler(attachEvent(begin, "cloud://bucket/" + begin.upload_path), deps);

  const otherHome = makeDeps(db, { householdId: HH_B });
  const hidden = await handler({ action: "videoEvidenceGet", item_ids: [itemId] }, otherHome);
  assert.deepEqual(hidden.evidence, []);

  const noUrl = makeDeps(db, { getTempFileUrls: async () => ({ fileList: [] }) });
  const got = await handler({ action: "videoEvidenceGet", item_ids: [itemId] }, noUrl);
  assert.equal(got.ok, true);
  assert.equal(got.evidence.length, 1);
  assert.equal(got.evidence[0].video_url, "");
});

test("VIDEO-DELETE-ALL:不加 evidence_id 时清理该物品全部视频", async () => {
  const db = freshDb();
  const deleted = [];
  const deps = makeDeps(db, { deleteCloudFiles: async (ids) => { deleted.push.apply(deleted, ids); } });
  const itemId = await createItem(deps, "op-a");
  const one = await handler(beginEvent(itemId), deps);
  await handler(attachEvent(one, "cloud://bucket/" + one.upload_path), deps);
  const two = await handler(beginEvent(itemId), deps);
  assert.ok(one.upload_ticket !== two.upload_ticket);
  await handler(attachEvent(two, "cloud://bucket/" + two.upload_path), deps);
  const res = await handler({ action: "videoEvidenceDelete", item_id: itemId }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.deleted, 2);
  assert.equal(deleted.length, 2);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
});
