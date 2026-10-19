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
    deleteCloudFiles: opts.deleteCloudFiles || (async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID: fileID, status: 0, errMsg: "ok" })),
    })),
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

async function attachWithReceipt(ticket, deps, fileId) {
  const receipt = await handler({
    action: "videoUploadReceipt",
    upload_ticket: ticket.upload_ticket,
    file_id: fileId,
  }, deps);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  return handler(attachEvent(ticket, fileId), deps);
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

  const attached = await attachWithReceipt(begin, deps, fileId);
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

  const receipt = await handler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: goodFile }, depsA);
  assert.equal(receipt.ok, true);
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
  assert.equal(expiredRes.error, "VIDEO_TICKET_EXPIRED");

  const cancelled = await handler(beginEvent(itemId), deps);
  const cancel = await handler({ action: "videoUploadCancel", upload_ticket: cancelled.upload_ticket }, deps);
  assert.equal(cancel.ok, true);
  const cancelledRes = await handler(attachEvent(cancelled, "cloud://bucket/" + cancelled.upload_path), deps);
  assert.equal(cancelledRes.ok, false);
  assert.equal(cancelledRes.error, "VIDEO_TICKET_EXPIRED");
});

test("VIDEO-DELETE:手动删除先删云文件再删证据行;云删除失败则保留", async () => {
  const db = freshDb();
  let failDelete = false;
  const deleted = [];
  const deps = makeDeps(db, {
    deleteCloudFiles: async (ids) => {
      if (failDelete) throw new Error("cloud fail");
      deleted.push.apply(deleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID: fileID, status: 0, errMsg: "ok" })) };
    },
  });
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  const attached = await attachWithReceipt(begin, deps, fileId);
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
    deleteCloudFiles: async (ids) => {
      if (failDelete) throw new Error("cloud fail");
      return { fileList: ids.map((fileID) => ({ fileID: fileID, status: 0, errMsg: "ok" })) };
    },
  });
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  await attachWithReceipt(begin, deps, fileId);

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
  const tickets = await rawDocs(db, "video_upload_tickets");
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].status, "deleted");
  const gone = await handler({ action: "get", item_id: itemId }, deps);
  assert.equal(gone.ok, false);
  assert.equal(gone.error, "NOT_FOUND");
});

test("VIDEO-READ:读侧家庭隔离;换链失败仍返回证据但 video_url 为空", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  await attachWithReceipt(begin, deps, "cloud://bucket/" + begin.upload_path);

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
  const deps = makeDeps(db, { deleteCloudFiles: async (ids) => {
    deleted.push.apply(deleted, ids);
    return { fileList: ids.map((fileID) => ({ fileID: fileID, status: 0, errMsg: "ok" })) };
  } });
  const itemId = await createItem(deps, "op-a");
  const one = await handler(beginEvent(itemId), deps);
  await attachWithReceipt(one, deps, "cloud://bucket/" + one.upload_path);
  const two = await handler(beginEvent(itemId), deps);
  assert.ok(one.upload_ticket !== two.upload_ticket);
  await attachWithReceipt(two, deps, "cloud://bucket/" + two.upload_path);
  const res = await handler({ action: "videoEvidenceDelete", item_id: itemId }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.deleted, 2);
  assert.equal(deleted.length, 2);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
});

test("VIDEO-DELETE-PARTIAL:逐文件失败时只删成功行,失败行保留并可重试", async () => {
  const db = freshDb();
  const statusById = Object.create(null);
  const deps = makeDeps(db, {
    deleteCloudFiles: async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID: fileID, status: statusById[fileID] === undefined ? 0 : statusById[fileID], errMsg: "" })),
    }),
  });
  const itemId = await createItem(deps, "op-a");
  const one = await handler(beginEvent(itemId), deps);
  const fileOne = "cloud://bucket/" + one.upload_path;
  await attachWithReceipt(one, deps, fileOne);
  const two = await handler(beginEvent(itemId), deps);
  const fileTwo = "cloud://bucket/" + two.upload_path;
  await attachWithReceipt(two, deps, fileTwo);

  statusById[fileTwo] = -1;
  const failed = await handler({ action: "videoEvidenceDelete", item_id: itemId }, deps);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "VIDEO_DELETE_FAILED");
  assert.equal(failed.deleted, 1);
  assert.deepEqual(failed.failed_file_ids, [fileTwo]);
  const left = await rawDocs(db, "video_evidence");
  assert.equal(left.length, 1);
  assert.equal(left[0].file_id, fileTwo);

  statusById[fileTwo] = -503003; // 已不存在等同删除成功,重试收敛
  const retried = await handler({ action: "videoEvidenceDelete", item_id: itemId }, deps);
  assert.equal(retried.ok, true);
  assert.equal(retried.deleted, 1);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
});

test("VIDEO-TICKET-NO-REUSE:同物品连续 begin 返回不同票据和路径", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-a");
  const one = await handler(beginEvent(itemId), deps);
  const two = await handler(beginEvent(itemId), deps);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.ok(one.upload_ticket !== two.upload_ticket);
  assert.ok(one.upload_path !== two.upload_path);
  const tickets = await rawDocs(db, "video_upload_tickets");
  assert.equal(tickets.length, 2);
  assert.equal(tickets[0].status, "pending");
  assert.equal(tickets[1].status, "pending");
});

test("VIDEO-RECEIPT:回执幂等;不同文件路径拒绝;未回执不能 attach", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  const receipt = await handler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId }, deps);
  assert.equal(receipt.ok, true);
  const receiptAgain = await handler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId }, deps);
  assert.equal(receiptAgain.ok, true);
  const forged = await handler({
    action: "videoUploadReceipt",
    upload_ticket: begin.upload_ticket,
    file_id: "cloud://bucket/video-evidence/" + HH_A + "/forged.mp4",
  }, deps);
  assert.equal(forged.ok, false);
  assert.equal(forged.error, "FILE_NOT_OWNED");

  const noReceiptBegin = await handler(beginEvent(itemId), deps);
  const noReceipt = await handler(attachEvent(noReceiptBegin, "cloud://bucket/" + noReceiptBegin.upload_path), deps);
  assert.equal(noReceipt.ok, false);
  assert.equal(noReceipt.error, "INVALID_INPUT");
});

test("VIDEO-CLEANUP-PENDING:删除物品时清理已回执但未绑定的视频", async () => {
  const db = freshDb();
  const deleted = [];
  const deps = makeDeps(db, {
    deleteCloudFiles: async (ids) => {
      deleted.push.apply(deleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID: fileID, status: 0, errMsg: "ok" })) };
    },
  });
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  const receipt = await handler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId }, deps);
  assert.equal(receipt.ok, true);
  const removed = await handler({ action: "delete", item_id: itemId }, deps);
  assert.equal(removed.ok, true);
  assert.deepEqual(deleted, [fileId]);
  const tickets = await rawDocs(db, "video_upload_tickets");
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].status, "deleted");
});

test("VIDEO-CASCADE-PARTIAL:已绑定删除失败时先不动 pending 票据,重试一起收敛", async () => {
  const db = freshDb();
  const statusById = Object.create(null);
  const calls = [];
  const deps = makeDeps(db, {
    deleteCloudFiles: async (ids) => {
      calls.push(ids.slice());
      return { fileList: ids.map((fileID) => ({ fileID: fileID, status: statusById[fileID] === undefined ? 0 : statusById[fileID] })) };
    },
  });
  const itemId = await createItem(deps, "op-a");
  const bound = await handler(beginEvent(itemId), deps);
  const boundFile = "cloud://bucket/" + bound.upload_path;
  await attachWithReceipt(bound, deps, boundFile);
  const pending = await handler(beginEvent(itemId), deps);
  const pendingFile = "cloud://bucket/" + pending.upload_path;
  await handler({ action: "videoUploadReceipt", upload_ticket: pending.upload_ticket, file_id: pendingFile }, deps);

  statusById[boundFile] = -1;
  const blocked = await handler({ action: "delete", item_id: itemId }, deps);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "VIDEO_DELETE_FAILED");
  assert.deepEqual(calls[0], [boundFile]);
  let tickets = await rawDocs(db, "video_upload_tickets");
  const pendingTicket = tickets.find((x) => x._id === pending.upload_ticket);
  assert.equal(pendingTicket.status, "pending");

  statusById[boundFile] = 0;
  const removed = await handler({ action: "delete", item_id: itemId }, deps);
  assert.equal(removed.ok, true);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
  tickets = await rawDocs(db, "video_upload_tickets");
  assert.equal(tickets.find((x) => x._id === pending.upload_ticket).status, "deleted");
});

test("VIDEO-B9-REPAIR:已有证据但票据仍 pending 时,attach 重试修复 bound", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  const first = await attachWithReceipt(begin, deps, fileId);
  assert.equal(first.ok, true);

  // 模拟「证据已写入,但票据状态更新失败」
  await db.collection("video_upload_tickets").doc(begin.upload_ticket).update({ data: { status: "pending" } });
  const receiptRetry = await handler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId }, deps);
  assert.equal(receiptRetry.ok, true);
  const retried = await handler(attachEvent(begin, fileId), deps);
  assert.equal(retried.ok, true);
  assert.equal(retried.duplicated, true);
  const ticket = (await db.collection("video_upload_tickets").doc(begin.upload_ticket).get()).data;
  assert.equal(ticket.status, "bound");
  assert.equal(ticket.evidence_id, first.evidence.evidence_id);
});

test("VIDEO-B10-CANCEL-BOUND:绑定成功票据即使 pending,取消也只修复不删文件", async () => {
  const db = freshDb();
  const deleted = [];
  const deps = makeDeps(db, {
    deleteCloudFiles: async (ids) => {
      deleted.push.apply(deleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID: fileID, status: 0 })) };
    },
  });
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  const attached = await attachWithReceipt(begin, deps, fileId);
  await db.collection("video_upload_tickets").doc(begin.upload_ticket).update({ data: { status: "pending" } });

  const cancelled = await handler({ action: "videoUploadCancel", upload_ticket: begin.upload_ticket }, deps);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.state, "bound");
  assert.equal(cancelled.evidence.evidence_id, attached.evidence.evidence_id);
  assert.deepEqual(deleted, []);
  assert.equal((await rawDocs(db, "video_evidence")).length, 1);
  const ticket = (await db.collection("video_upload_tickets").doc(begin.upload_ticket).get()).data;
  assert.equal(ticket.status, "bound");
});

test("VIDEO-B11-CANCEL:取消 pending 必须先逐文件删除;失败保留票据可回收", async () => {
  const db = freshDb();
  const deleted = [];
  let fail = true;
  const deps = makeDeps(db, {
    deleteCloudFiles: async (ids) => {
      deleted.push.apply(deleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID: fileID, status: fail ? -1 : 0 })) };
    },
  });
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  const receipt = await handler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId }, deps);
  assert.equal(receipt.ok, true);

  const failed = await handler({ action: "videoUploadCancel", upload_ticket: begin.upload_ticket }, deps);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "VIDEO_DELETE_FAILED");
  let ticket = (await db.collection("video_upload_tickets").doc(begin.upload_ticket).get()).data;
  assert.equal(ticket.status, "pending");

  fail = false;
  const ok = await handler({ action: "videoUploadCancel", upload_ticket: begin.upload_ticket }, deps);
  assert.equal(ok.ok, true);
  assert.equal(ok.state, "cancelled");
  ticket = (await db.collection("video_upload_tickets").doc(begin.upload_ticket).get()).data;
  assert.equal(ticket.status, "cancelled");
  assert.deepEqual(deleted, [fileId, fileId]);
});

test("VIDEO-CAS-BUSY:票据处于 binding 时 attach/cancel 都不得并发操作", async () => {
  const db = freshDb();
  let deleteCalls = 0;
  const deps = makeDeps(db, { deleteCloudFiles: async (ids) => {
    deleteCalls += 1;
    return { fileList: ids.map((fileID) => ({ fileID: fileID, status: 0 })) };
  } });
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  await handler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId }, deps);
  await db.collection("video_upload_tickets").doc(begin.upload_ticket).update({ data: { status: "binding" } });

  const attached = await handler(attachEvent(begin, fileId), deps);
  assert.equal(attached.ok, false);
  assert.equal(attached.error, "VIDEO_TICKET_BUSY");
  const cancelled = await handler({ action: "videoUploadCancel", upload_ticket: begin.upload_ticket }, deps);
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error, "VIDEO_TICKET_BUSY");
  assert.equal(deleteCalls, 0);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
});

test("VIDEO-B14-RECEIPT-CAS:取消后 receipt 不得把 file_id 写回已取消票据", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;

  const cancel = await handler({ action: "videoUploadCancel", upload_ticket: begin.upload_ticket }, deps);
  assert.equal(cancel.ok, true);
  assert.equal(cancel.state, "cancelled");
  const receipt = await handler({
    action: "videoUploadReceipt",
    upload_ticket: begin.upload_ticket,
    file_id: fileId,
  }, deps);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error, "VIDEO_TICKET_EXPIRED");
  const ticket = (await db.collection("video_upload_tickets").doc(begin.upload_ticket).get()).data;
  assert.equal(ticket.status, "cancelled");
  assert.equal(ticket.file_id, undefined, "已取消票据绝不能被 receipt 写回 file_id");
});

test("VIDEO-B14-BOUND-RECEIPT:已绑定票据 receipt 幂等成功", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  await attachWithReceipt(begin, deps, fileId);
  const receipt = await handler({
    action: "videoUploadReceipt",
    upload_ticket: begin.upload_ticket,
    file_id: fileId,
  }, deps);
  assert.equal(receipt.ok, true);
  const ticket = (await db.collection("video_upload_tickets").doc(begin.upload_ticket).get()).data;
  assert.equal(ticket.status, "bound");
});

test("VIDEO-B13-ITEM-LOCK:删除与 attach 共用物品锁;未过期锁拒绝双方", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  await handler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId }, deps);
  await db.collection("video_item_locks").add({
    data: {
      _id: "vil_" + itemId,
      household_id: HH_A,
      item_id: itemId,
      owner_token: "other",
      purpose: "attach",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  });

  const attachBlocked = await handler(attachEvent(begin, fileId), deps);
  assert.equal(attachBlocked.ok, false);
  assert.equal(attachBlocked.error, "VIDEO_ITEM_BUSY");
  const deleteBlocked = await handler({ action: "delete", item_id: itemId }, deps);
  assert.equal(deleteBlocked.ok, false);
  assert.equal(deleteBlocked.error, "VIDEO_ITEM_BUSY");
  const alive = await handler({ action: "get", item_id: itemId }, deps);
  assert.equal(alive.ok, true);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
});

test("VIDEO-B13-LOCK-TTL:过期物品锁可被 attach 接管并在成功后释放", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  await handler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId }, deps);
  await db.collection("video_item_locks").add({
    data: {
      _id: "vil_" + itemId,
      household_id: HH_A,
      item_id: itemId,
      owner_token: "stale",
      purpose: "attach",
      expires_at: "2020-01-01T00:00:00.000Z",
    },
  });
  const attached = await handler(attachEvent(begin, fileId), deps);
  assert.equal(attached.ok, true, JSON.stringify(attached));
  assert.equal((await rawDocs(db, "video_item_locks")).length, 0);
  const removed = await handler({ action: "delete", item_id: itemId }, deps);
  assert.equal(removed.ok, true);
  assert.equal((await rawDocs(db, "video_item_locks")).length, 0);
});

test("VIDEO-B15-CANCEL-FRESH:抢到 cancelling 后重读票据,补删竞态中新增的 file_id", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-a");
  const begin = await handler(beginEvent(itemId), deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  await handler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId }, deps);
  const deleted = [];
  deps.deleteCloudFiles = async (ids) => {
    deleted.push.apply(deleted, ids);
    return { fileList: ids.map((fileID) => ({ fileID: fileID, status: 0 })) };
  };

  // 第一次读取票据时返回「receipt 前」的旧快照(没有 file_id),模拟 read 与 CAS 交错。
  let firstTicketRead = true;
  const realDb = db;
  deps.db = {
    collection(name) {
      const real = realDb.collection(name);
      if (name !== "video_upload_tickets") return real;
      return {
        doc(id) {
          const d = real.doc(id);
          return {
            get: async () => {
              const r = await d.get();
              if (firstTicketRead && r.data) {
                firstTicketRead = false;
                const copy = JSON.parse(JSON.stringify(r.data));
                delete copy.file_id;
                delete copy.receipt_at;
                return { data: copy };
              }
              return r;
            },
            update: d.update.bind(d),
          };
        },
        where: real.where.bind(real),
        add: real.add.bind(real),
      };
    },
  };

  const res = await handler({ action: "videoUploadCancel", upload_ticket: begin.upload_ticket }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.state, "cancelled");
  assert.deepEqual(deleted, [fileId], "必须使用 CAS 后重读的票据 file_id 删除");
  const ticket = (await realDb.collection("video_upload_tickets").doc(begin.upload_ticket).get()).data;
  assert.equal(ticket.status, "cancelled");
});

test("VIDEO-B16-BEGIN-LOCK:持物品锁时 begin 拒绝且不创建票据", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-a");
  await db.collection("video_item_locks").add({
    data: {
      _id: "vil_" + itemId,
      household_id: HH_A,
      item_id: itemId,
      owner_token: "other",
      purpose: "delete",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  });
  const begin = await handler(beginEvent(itemId), deps);
  assert.equal(begin.ok, false);
  assert.equal(begin.error, "VIDEO_ITEM_BUSY");
  assert.equal((await rawDocs(db, "video_upload_tickets")).length, 0);
  assert.equal((await rawDocs(db, "video_item_locks")).length, 1);
});

test("VIDEO-B16-DELETE-INTERMEDIATE:删除物品清理 pending/binding/cleaning/cancelling/bound 全部票据", async () => {
  const db = freshDb();
  const deleted = [];
  const deps = makeDeps(db, {
    deleteCloudFiles: async (ids) => {
      deleted.push.apply(deleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID: fileID, status: 0 })) };
    },
  });
  const itemId = await createItem(deps, "op-a");
  const statuses = ["pending", "binding", "cleaning", "cancelling", "bound"];
  for (let i = 0; i < statuses.length; i++) {
    await db.collection("video_upload_tickets").add({
      data: {
        _id: "vt_mid_" + i,
        household_id: HH_A,
        item_id: itemId,
        cloud_path: "video-evidence/" + HH_A + "/mid-" + i + ".mp4",
        file_id: "cloud://bucket/video-evidence/" + HH_A + "/mid-" + i + ".mp4",
        status: statuses[i],
        created_at: "2026-10-19T00:00:00.000Z",
        expires_at: "2026-10-19T00:15:00.000Z",
      },
    });
  }
  const res = await handler({ action: "delete", item_id: itemId }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(deleted.length, statuses.length);
  const tickets = await rawDocs(db, "video_upload_tickets");
  assert.equal(tickets.length, statuses.length);
  for (const t of tickets) assert.equal(t.status, "deleted");
  assert.equal((await rawDocs(db, "video_item_locks")).length, 0);
  const gone = await handler({ action: "get", item_id: itemId }, deps);
  assert.equal(gone.ok, false);
  assert.equal(gone.error, "NOT_FOUND");
});

test("VIDEO-B16-DELETE-INTERMEDIATE-FAIL:中间态文件删除失败时物品与票据保留,锁释放", async () => {
  const db = freshDb();
  const deps = makeDeps(db, {
    deleteCloudFiles: async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID: fileID, status: -1 })),
    }),
  });
  const itemId = await createItem(deps, "op-a");
  await db.collection("video_upload_tickets").add({
    data: {
      _id: "vt_binding_fail",
      household_id: HH_A,
      item_id: itemId,
      cloud_path: "video-evidence/" + HH_A + "/fail.mp4",
      file_id: "cloud://bucket/video-evidence/" + HH_A + "/fail.mp4",
      status: "binding",
      created_at: "2026-10-19T00:00:00.000Z",
      expires_at: "2026-10-19T00:15:00.000Z",
    },
  });
  const res = await handler({ action: "delete", item_id: itemId }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "VIDEO_DELETE_FAILED");
  const alive = await handler({ action: "get", item_id: itemId }, deps);
  assert.equal(alive.ok, true);
  const ticket = (await db.collection("video_upload_tickets").doc("vt_binding_fail").get()).data;
  assert.equal(ticket.status, "binding");
  assert.equal((await rawDocs(db, "video_item_locks")).length, 0);
});
