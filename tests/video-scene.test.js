"use strict";
// PR B 场景批量提交离线合同：多 item 共用同一 file_id/asset_id、各自 highlights、
// 同名不自动合并、幂等重试与输入/归属硬门。
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH_A = "hh_11111111111111111111111111111111";
const HH_B = "hh_22222222222222222222222222222222";
const DURATION = 12000;

function makeDeps(db, opts) {
  opts = opts || {};
  let seq = 0;
  let clock = 1760000000000;
  const cloudDeleted = [];
  return {
    db,
    cloudDeleted,
    householdId: opts.householdId || HH_A,
    householdShared: false,
    scopeRevision: null,
    now: () => new Date(clock).toISOString(),
    advance: (ms) => { clock += ms; },
    genId: () => { seq += 1; return "n" + String(seq).padStart(12, "0"); },
    getTempFileUrls: async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID, tempFileURL: "https://tmp.example/" + encodeURIComponent(fileID) })),
    }),
    deleteCloudFiles: opts.deleteCloudFiles || (async (ids) => {
      cloudDeleted.push.apply(cloudDeleted, ids);
      return { fileList: ids.map((fileID) => ({ fileID, status: 0, errMsg: "ok" })) };
    }),
    logger: { log: () => {} },
  };
}

function freshDb() {
  return createMemoryDb({
    uniqueIndexes: { video_evidence: [["household_id", "item_id", "file_id"]] },
  });
}

async function rawDocs(db, name) {
  const res = await db.collection(name).where({}).get();
  return res.data || [];
}

function box() {
  return { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.7 };
}

function hl(start, end, candidateBox, frameMs) {
  const out = { start_ms: start, end_ms: end, box: candidateBox === undefined ? null : candidateBox };
  if (frameMs !== undefined) out.frame_ms = frameMs;
  return out;
}

async function sceneTicket(deps, sceneId) {
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
  assert.ok(begin.asset_id.indexOf("va_") === 0);
  const fileId = "cloud://bucket/" + begin.upload_path;
  const receipt = await handler({
    action: "videoUploadReceipt",
    upload_ticket: begin.upload_ticket,
    file_id: fileId,
  }, deps);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  return { begin, fileId };
}

function newItem(draftKey, opId, name, highlights) {
  return {
    draft_key: draftKey,
    target: "new",
    operation_id: opId,
    name,
    location_text: "书房 · 右侧抽屉",
    highlights,
  };
}

function commitEvent(ticket, items, extra) {
  return Object.assign({
    action: "videoSceneCommit",
    scene_id: ticket.begin.scene_id || "scene-0001",
    upload_ticket: ticket.begin.upload_ticket,
    asset_id: ticket.begin.asset_id,
    file_id: ticket.fileId,
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
    consent_version: "v1",
    items,
  }, extra || {});
}

async function createItem(deps, op, name) {
  const res = await handler({
    action: "create",
    operation_id: op,
    name,
    location_text: "书房 · 右侧抽屉",
  }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.item.item_id;
}

test("SCENE-COMMIT:两个同名新物品仍建两件，共用 file/asset，各有独立 highlights", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const sceneId = "scene-same-name-01";
  const ticket = await sceneTicket(deps, sceneId);
  const ev = commitEvent(ticket, [
    newItem("d1", "op-same-a", "黑色耳机", [hl(1000, 2500, box(), 1000)]),
    newItem("d2", "op-same-b", "黑色耳机", [hl(6000, 7500, null, 6000)]),
  ], { scene_id: sceneId });
  const res = await handler(ev, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ticket_state, "bound");
  assert.equal(res.results.length, 2);
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[1].ok, true);
  assert.notEqual(res.results[0].item_id, res.results[1].item_id);

  const items = await rawDocs(db, "items");
  assert.equal(items.length, 2);
  assert.equal(items[0].name, "黑色耳机");
  assert.equal(items[1].name, "黑色耳机");
  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 2);
  assert.notEqual(evidence[0].item_id, evidence[1].item_id);
  assert.equal(evidence[0].file_id, evidence[1].file_id);
  assert.equal(evidence[0].asset_id, evidence[1].asset_id);
  assert.equal(evidence[0].source, "scene");
  assert.equal(evidence[0].highlight_version, 1);
  assert.deepEqual(evidence[0].highlights[0].box, box());
  assert.equal(evidence[1].highlights[0].box, null);
  assert.equal(evidence[1].highlights[0].source, "user_confirmed");

  const got = await handler({ action: "videoEvidenceGet", item_ids: [res.results[0].item_id, res.results[1].item_id] }, deps);
  assert.equal(got.ok, true);
  assert.equal(got.evidence.length, 2);
  const first = got.evidence.find((r) => r.item_id === res.results[0].item_id);
  const second = got.evidence.find((r) => r.item_id === res.results[1].item_id);
  assert.equal(first.highlights.length, 1);
  assert.equal(second.highlights.length, 1);
  assert.notDeepEqual(first.highlights, second.highlights);
  assert.ok(first.video_url.length > 0);
  assert.ok(second.video_url.length > 0);
});

test("SCENE-IDEMPOTENT:同载荷重试不重复建档/证据；不同载荷 OPERATION_CONFLICT", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const sceneId = "scene-idempotent-01";
  const ticket = await sceneTicket(deps, sceneId);
  const event = commitEvent(ticket, [
    newItem("d1", "op-idem-a", "螺丝刀", [hl(1000, 2500, box(), 1000)]),
  ], { scene_id: sceneId });
  const first = await handler(event, deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  const retry = await handler(event, deps);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.results[0].evidence_duplicated, true);
  assert.equal((await rawDocs(db, "items")).length, 1);
  assert.equal((await rawDocs(db, "video_evidence")).length, 1);

  const changed = JSON.parse(JSON.stringify(event));
  changed.items[0].highlights = [hl(3000, 4000, box(), 3000)];
  const conflict = await handler(changed, deps);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "OPERATION_CONFLICT");
  assert.equal((await rawDocs(db, "video_evidence")).length, 1);
});

test("SCENE-EXISTING:只能显式 item_id 关联；不按名称自动匹配", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const existingId = await createItem(deps, "op-existing", "黑色耳机");
  const sceneId = "scene-existing-01";
  const ticket = await sceneTicket(deps, sceneId);
  const res = await handler(commitEvent(ticket, [
    {
      draft_key: "d-existing",
      target: "existing",
      item_id: existingId,
      highlights: [hl(500, 1800, box(), 500)],
    },
  ], { scene_id: sceneId }), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal((await rawDocs(db, "items")).length, 1);
  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].item_id, existingId);

  // 同名但 target:new 必须新建第二件，绝不能按名称复用 existingId。
  const scene2 = "scene-existing-02";
  const ticket2 = await sceneTicket(deps, scene2);
  const res2 = await handler(commitEvent(ticket2, [
    newItem("d-new", "op-new-same-name", "黑色耳机", [hl(500, 1800, box(), 500)]),
  ], { scene_id: scene2 }), deps);
  assert.equal(res2.ok, true, JSON.stringify(res2));
  assert.notEqual(res2.results[0].item_id, existingId);
  assert.equal((await rawDocs(db, "items")).length, 2);
});

test("SCENE-VALIDATION:box:null 合法；空/越界/非法 source 或超过 12 件整体 INVALID_INPUT 零写", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const sceneId = "scene-validation-01";
  const ticket = await sceneTicket(deps, sceneId);
  const base = commitEvent(ticket, [
    newItem("d-ok", "op-valid-a", "药盒", [hl(0, 1000, null, 0)]),
  ], { scene_id: sceneId });
  const ok = await handler(base, deps);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal((await rawDocs(db, "video_evidence")).length, 1);

  const badEvents = [];
  const bad1 = commitEvent(ticket, [newItem("d-bad1", "op-bad-1", "坏1", [])], { scene_id: "other-scene" });
  badEvents.push(bad1);
  const bad2 = commitEvent(ticket, [newItem("d-bad2", "op-bad-2", "坏2", [hl(1000, 1000, null, 1000)])], { scene_id: sceneId });
  badEvents.push(bad2);
  const bad3 = commitEvent(ticket, [newItem("d-bad3", "op-bad-3", "坏3", [hl(0, 20000, null, 0)])], { scene_id: sceneId });
  badEvents.push(bad3);
  const many = [];
  for (let i = 0; i < 13; i++) many.push(newItem("d-many-" + i, "op-many-" + i, "物品" + i, [hl(0, 100, null, 0)]));
  badEvents.push(commitEvent(ticket, many, { scene_id: sceneId }));
  for (const ev of badEvents) {
    const res = await handler(ev, deps);
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal((await rawDocs(db, "video_evidence")).length, 1);
  }
});

test("SCENE-OWNERSHIP:跨家庭、purpose/ticket/asset/path 不匹配均零写", async () => {
  const db = freshDb();
  const depsA = makeDeps(db);
  const depsB = makeDeps(db, { householdId: HH_B });
  const sceneId = "scene-ownership-01";
  const ticket = await sceneTicket(depsA, sceneId);
  const good = commitEvent(ticket, [
    newItem("d-own", "op-own", "水杯", [hl(0, 1000, null, 0)]),
  ], { scene_id: sceneId });
  const cross = await handler(good, depsB);
  assert.equal(cross.ok, false);
  assert.equal(cross.error, "FILE_NOT_OWNED");

  const wrongAsset = JSON.parse(JSON.stringify(good));
  wrongAsset.asset_id = "va_forged";
  const assetRes = await handler(wrongAsset, depsA);
  assert.equal(assetRes.ok, false);
  assert.equal(assetRes.error, "FILE_NOT_OWNED");

  const wrongFile = JSON.parse(JSON.stringify(good));
  wrongFile.file_id = "cloud://bucket/video-evidence/" + HH_A + "/forged.mp4";
  const fileRes = await handler(wrongFile, depsA);
  assert.equal(fileRes.ok, false);
  assert.equal(fileRes.error, "FILE_NOT_OWNED");
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);

  const itemBegin = await handler({
    action: "videoUploadBegin",
    item_id: await createItem(depsA, "op-item-ticket", "水杯"),
    ext: "mp4",
  }, depsA);
  const itemFile = "cloud://bucket/" + itemBegin.upload_path;
  await handler({ action: "videoUploadReceipt", upload_ticket: itemBegin.upload_ticket, file_id: itemFile }, depsA);
  const itemTicketRes = await handler({
    action: "videoSceneCommit",
    scene_id: sceneId,
    upload_ticket: itemBegin.upload_ticket,
    asset_id: itemBegin.asset_id,
    file_id: itemFile,
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
    consent_version: "v1",
    items: [newItem("d-item-ticket", "op-item-ticket-2", "水杯", [hl(0, 1000, null, 0)])],
  }, depsA);
  assert.equal(itemTicketRes.ok, false);
  assert.equal(itemTicketRes.error, "INVALID_INPUT");
});

test("SCENE-ASSET-LOCK:asset 锁忙时 commit 不得写 evidence，且不删锁", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const sceneId = "scene-lock-01";
  const ticket = await sceneTicket(deps, sceneId);
  await db.collection("video_item_locks").add({ data: {
    _id: "val_" + ticket.begin.asset_id,
    household_id: HH_A,
    asset_id: ticket.begin.asset_id,
    owner_token: "other",
    purpose: "scene_commit",
    expires_at: "2099-01-01T00:00:00.000Z",
  } });
  const res = await handler(commitEvent(ticket, [
    newItem("d-lock", "op-lock", "锁测试", [hl(0, 1000, null, 0)]),
  ], { scene_id: sceneId }), deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "VIDEO_ITEM_BUSY");
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
  const locks = await rawDocs(db, "video_item_locks");
  assert.equal(locks.length, 1);
});

test("SCENE-CANCEL:无 evidence 时删文件；已有任一 evidence 时返回 bound 并列 linked_item_ids", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const sceneId = "scene-cancel-01";
  const pendingTicket = await sceneTicket(deps, sceneId);
  const cancelled = await handler({ action: "videoUploadCancel", upload_ticket: pendingTicket.begin.upload_ticket }, deps);
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(cancelled.state, "cancelled");
  const pendingDoc = (await db.collection("video_upload_tickets").doc(pendingTicket.begin.upload_ticket).get()).data;
  assert.equal(pendingDoc.status, "cancelled");

  const scene2 = "scene-cancel-02";
  const ticket2 = await sceneTicket(deps, scene2);
  const commit = await handler(commitEvent(ticket2, [
    newItem("d-cancel", "op-cancel", "水杯", [hl(0, 1000, null, 0)]),
  ], { scene_id: scene2 }), deps);
  assert.equal(commit.ok, true, JSON.stringify(commit));
  const beforeDeletes = deps.cloudDeleted.length;
  const bound = await handler({ action: "videoUploadCancel", upload_ticket: ticket2.begin.upload_ticket }, deps);
  assert.equal(bound.ok, true, JSON.stringify(bound));
  assert.equal(bound.state, "bound");
  assert.deepEqual(bound.linked_item_ids, [commit.results[0].item_id]);
  assert.equal(deps.cloudDeleted.length, beforeDeletes);
  const ticketDoc = (await db.collection("video_upload_tickets").doc(ticket2.begin.upload_ticket).get()).data;
  assert.equal(ticketDoc.status, "bound");
});

test("SCENE-WRITE-GATE:共享家庭 scene begin/commit 缺双 marker 时零写入", async () => {
  const db = freshDb();
  const base = makeDeps(db);
  const shared = Object.assign({}, base, { householdShared: true, scopeRevision: 7 });
  const begin = await handler({
    action: "videoUploadBegin",
    purpose: "scene",
    scene_id: "scene-gate-01",
    ext: "mp4",
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
  }, shared);
  assert.equal(begin.ok, false);
  assert.equal(begin.error, "FAMILY_SWITCHED");
  const commit = await handler({
    action: "videoSceneCommit",
    scene_id: "scene-gate-01",
    upload_ticket: "vt_missing_01",
    asset_id: "va_missing",
    file_id: "cloud://bucket/video-evidence/" + HH_A + "/missing.mp4",
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
    consent_version: "v1",
    items: [newItem("d-gate", "op-gate", "物品", [hl(0, 1000, null, 0)])],
  }, shared);
  assert.equal(commit.ok, false);
  assert.equal(commit.error, "FAMILY_SWITCHED");
  assert.equal((await rawDocs(db, "video_upload_tickets")).length, 0);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
});

test("SCENE-PRA-INTEGRATION:scene evidence 读回 highlights/version；PR A highlightSave 可从 version 1 CAS 到 2", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const sceneId = "scene-pra-int-01";
  const ticket = await sceneTicket(deps, sceneId);
  const commit = await handler(commitEvent(ticket, [
    newItem("d-int", "op-int", "整合测试", [hl(1000, 2000, null, 1000)]),
  ], { scene_id: sceneId }), deps);
  assert.equal(commit.ok, true, JSON.stringify(commit));
  assert.equal(commit.results[0].ok, true);
  const got = await handler({ action: "videoEvidenceGet", item_ids: [commit.results[0].item_id] }, deps);
  assert.equal(got.ok, true);
  assert.equal(got.evidence.length, 1);
  assert.equal(got.evidence[0].asset_id, ticket.begin.asset_id);
  assert.equal(got.evidence[0].source, "scene");
  assert.equal(got.evidence[0].highlight_version, 1);
  assert.equal(got.evidence[0].highlights.length, 1);
  const save = await handler({
    action: "videoEvidenceHighlightSave",
    item_id: commit.results[0].item_id,
    evidence_id: got.evidence[0].evidence_id,
    expected_highlight_version: 1,
    highlight_update_id: "upd_scene_001",
    highlights: [hl(500, 2500, box(), 800), hl(6000, 8000, null, 6000)],
  }, deps);
  assert.equal(save.ok, true, JSON.stringify(save));
  assert.equal(save.highlight_version, 2);
  assert.equal(save.highlights.length, 2);
});

test("SCENE-PARTIAL:单件运行期失败不拦其他件；至少一条 evidence 成功即 bound 并保留 evidence_failed", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  await createItem(deps, "op-partial-conflict", "旧名字");
  const sceneId = "scene-partial-01";
  const ticket = await sceneTicket(deps, sceneId);
  const res = await handler(commitEvent(ticket, [
    newItem("d-conflict", "op-partial-conflict", "新名字", [hl(0, 1000, null, 0)]),
    newItem("d-success", "op-partial-ok", "正常物品", [hl(2000, 3000, null, 2000)]),
  ], { scene_id: sceneId }), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results.length, 2);
  assert.equal(res.results[0].ok, false);
  assert.equal(res.results[1].ok, true);
  assert.equal(res.ticket_state, "bound");
  assert.deepEqual(res.evidence_failed, ["d-conflict"]);
  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].item_id, res.results[1].item_id);
  const ticketDoc = (await db.collection("video_upload_tickets").doc(ticket.begin.upload_ticket).get()).data;
  assert.equal(ticketDoc.status, "bound");
  assert.equal(ticketDoc.scene_evidence_count, 1);
});
