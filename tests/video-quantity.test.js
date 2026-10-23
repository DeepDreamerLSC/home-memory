"use strict";

/**
 * Q1 基础数量(videoSceneCommit,issue #102 / Q0-CONTRACT §4.4/§9):
 * 覆盖反例矩阵 §12-D1(6 帧 ≠ 6,缺省 1)、§12-D5(existing 禁携数量)、
 * §12-D6(confirmed_count 数条数不数总量)、§12-G5(同票据重试改数量签名失配)、
 * §12-G6(不带数量的载荷签名与现行一致)。
 * 红绿纪律:本文件在未实现数量的代码上必须失败,实现后全绿。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH_A = "hh_11111111111111111111111111111111";
const DURATION = 12000;

function makeDeps(db, opts) {
  opts = opts || {};
  let seq = 0;
  let clock = 1760000000000;
  return {
    db,
    householdId: opts.householdId || HH_A,
    householdShared: false,
    scopeRevision: null,
    now: () => new Date(clock).toISOString(),
    advance: (ms) => { clock += ms; },
    genId: () => { seq += 1; return "n" + String(seq).padStart(12, "0"); },
    getTempFileUrls: async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID, tempFileURL: "https://tmp.example/" + encodeURIComponent(fileID) })),
    }),
    deleteCloudFiles: async (ids) => ({ fileList: ids.map((fileID) => ({ fileID, status: 0, errMsg: "ok" })) }),
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
  const fileId = "cloud://bucket/" + begin.upload_path;
  const receipt = await handler({
    action: "videoUploadReceipt",
    upload_ticket: begin.upload_ticket,
    file_id: fileId,
  }, deps);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  return { begin, fileId };
}

function newItem(draftKey, opId, name, highlights, over) {
  return Object.assign({
    draft_key: draftKey,
    target: "new",
    operation_id: opId,
    name,
    location_text: "书房 / 书柜",
    highlights,
  }, over || {});
}

function commitEvent(ticket, items, extra) {
  return Object.assign({
    action: "videoSceneCommit",
    scene_id: ticket.begin.scene_id,
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

function locationBlock(scanId, nodeId, pathSegments) {
  return {
    location_id: nodeId,
    scan_id: scanId,
    path_snapshot: pathSegments,
    text_snapshot: pathSegments.join(" / "),
  };
}

/** 直接注入位置节点(同 location-scan-commit.test.js 手法) */
async function seedTree(db, householdId) {
  const nodes = [
    { _id: "lc_root", parent_id: "", name: "我的家", path: [] },
    { _id: "lc_study", parent_id: "lc_root", name: "书房", path: ["书房"] },
    { _id: "lc_shelf", parent_id: "lc_study", name: "书柜", path: ["书房", "书柜"] },
  ];
  for (const n of nodes) {
    await db.collection("locations").add({ data: Object.assign({ household_id: householdId, name_norm: n.name }, n) });
  }
  return nodes;
}

test("VIDEO-D1 一件东西 6 个同名 observation 合并草稿,数量控件未动(quantity 缺席)→ 落 quantity=1,绝不 6", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ticket = await sceneTicket(deps, "scene-q1-d1");
  const highlights = [
    hl(0, 800, box(), 0),
    hl(1600, 2400, box(), 1600),
    hl(3200, 4000, box(), 3200),
    hl(4800, 5600, box(), 4800),
    hl(6400, 7200, box(), 6400),
    hl(8000, 8800, box(), 8000),
  ];
  const res = await handler(commitEvent(ticket, [
    newItem("d-1", "op-vq-d1", "螺丝刀", highlights),
  ]), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results[0].ok, true);
  const items = await rawDocs(db, "items");
  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, 1, "6 帧高亮绝不赋值数量;缺省=1");
  assert.equal(items[0].unit, "件");
});

test("VIDEO-Q1 target:new 携 quantity/unit → 透传 createItem 落库;非法值整批零写带 detail.index", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ticket = await sceneTicket(deps, "scene-q1-new");
  const res = await handler(commitEvent(ticket, [
    newItem("d-1", "op-vq-n1", "棉柔巾", [hl(0, 1000)], { quantity: 3, unit: "包" }),
    newItem("d-2", "op-vq-n2", "纸巾", [hl(2000, 3000)]),
  ]), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const items = await rawDocs(db, "items");
  const withQty = items.find((d) => d.operation_id === "op-vq-n1");
  const without = items.find((d) => d.operation_id === "op-vq-n2");
  assert.equal(withQty.quantity, 3);
  assert.equal(withQty.unit, "包");
  assert.equal(without.quantity, 1);
  assert.equal(without.unit, "件");

  // 非法:0(新建恒 ≥1)
  const t2 = await sceneTicket(deps, "scene-q1-new-bad");
  const bad = await handler(commitEvent(t2, [
    newItem("d-1", "op-vq-bad", "A", [hl(0, 1000)], { quantity: 0 }),
  ]), deps);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "INVALID_INPUT");
  assert.equal(bad.detail && bad.detail.reason, "QUANTITY_OUT_OF_RANGE");
  assert.equal(bad.detail && bad.detail.index, 0);

  const t3 = await sceneTicket(deps, "scene-q1-new-bad2");
  const badUnit = await handler(commitEvent(t3, [
    newItem("d-0", "op-vq-ok", "A", [hl(0, 1000)]),
    newItem("d-1", "op-vq-badu", "B", [hl(2000, 3000)], { quantity: 2, unit: "箱" }),
  ]), deps);
  assert.equal(badUnit.ok, false);
  assert.equal(badUnit.detail && badUnit.detail.reason, "UNIT_UNSUPPORTED");
  assert.equal(badUnit.detail && badUnit.detail.index, 1);
});

test("VIDEO-D5 target:existing 携带 quantity → INVALID(QUANTITY_ON_EXISTING_TARGET)整批零写", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const created = await handler({
    action: "create", operation_id: "op-vq-e5", name: "扳手", location_text: "书房 / 书柜",
  }, deps);
  assert.equal(created.ok, true);
  const ticket = await sceneTicket(deps, "scene-q1-d5");
  const res = await handler(commitEvent(ticket, [
    { draft_key: "d-x", target: "existing", item_id: created.item.item_id, highlights: [hl(0, 1000)], quantity: 1 },
  ]), deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "INVALID_INPUT");
  assert.equal(res.detail && res.detail.reason, "QUANTITY_ON_EXISTING_TARGET");
  assert.equal(res.detail && res.detail.index, 0);
  const items = await rawDocs(db, "items");
  assert.equal(items.length, 1, "整批零写:existing 件未被关联,无新物品");
  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 0, "零写:证据行也未落");
});

test("VIDEO-D5b target:existing 携 unit(哪怕 quantity 缺席)同样拒绝", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const created = await handler({
    action: "create", operation_id: "op-vq-e5b", name: "扳手", location_text: "书房 / 书柜",
  }, deps);
  const ticket = await sceneTicket(deps, "scene-q1-d5b");
  const res = await handler(commitEvent(ticket, [
    { draft_key: "d-x", target: "existing", item_id: created.item.item_id, highlights: [hl(0, 1000)], unit: "件" },
  ]), deps);
  assert.equal(res.ok, false);
  assert.equal(res.detail && res.detail.reason, "QUANTITY_ON_EXISTING_TARGET");
});

test("VIDEO-D6 提交 2 条新物品(quantity 5 与 3)→ scan.confirmed_count=2(数条数不数总量)", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const scanId = "scan-q1-d6";
  const ticket = await sceneTicket(deps, scanId);
  const res = await handler(commitEvent(ticket, [
    newItem("d-1", "op-vq-d6a", "棉柔巾", [hl(0, 1000)], { quantity: 5, unit: "包" }),
    newItem("d-2", "op-vq-d6b", "抽纸", [hl(2000, 3000)], { quantity: 3, unit: "盒" }),
  ], {
    scene_id: scanId,
    location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]),
    candidate_count: 2,
  }), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.scan, "location 上下文必须落 scan");
  assert.equal(res.scan.confirmed_count, 2, "confirmed_count 数确认条数,不是数量总和 8");
  const items = await rawDocs(db, "items");
  assert.equal(items.length, 2);
  const a = items.find((d) => d.operation_id === "op-vq-d6a");
  assert.equal(a.quantity, 5);
});

test("VIDEO-G5 同票据重试改 items[0].quantity 3→4 → 签名失配 OPERATION_CONFLICT", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ticket = await sceneTicket(deps, "scene-q1-g5");
  const first = await handler(commitEvent(ticket, [
    newItem("d-1", "op-vq-g5", "棉柔巾", [hl(0, 1000)], { quantity: 3, unit: "包" }),
  ]), deps);
  assert.equal(first.ok, true);
  const retry = await handler(commitEvent(ticket, [
    newItem("d-1", "op-vq-g5", "棉柔巾", [hl(0, 1000)], { quantity: 4, unit: "包" }),
  ]), deps);
  assert.equal(retry.ok, false);
  assert.equal(retry.error, "OPERATION_CONFLICT", "数量进 scene_payload_sig,改数量=新载荷=同票据签名失配");
});

test("VIDEO-G6 不带数量的载荷重试 → 与现行签名逐字节一致,正常收敛(零感知)", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ticket = await sceneTicket(deps, "scene-q1-g6");
  const payload = [newItem("d-1", "op-vq-g6", "螺丝刀", [hl(0, 1000)])];
  const first = await handler(commitEvent(ticket, payload), deps);
  assert.equal(first.ok, true);
  assert.equal(first.results[0].created, true);
  // 未完成重试路径用完全相同的冻结载荷(不带数量)再提交同票据
  const retry = await handler(commitEvent(ticket, payload), deps);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.results[0].ok, true);
  assert.equal(retry.results[0].duplicated, true, "旧形态载荷重试仍幂等收敛");
});

test("VIDEO-G6b 同票据先无数量后有数量(或反之)→ 签名失配 OPERATION_CONFLICT", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ticket = await sceneTicket(deps, "scene-q1-g6b");
  const first = await handler(commitEvent(ticket, [
    newItem("d-1", "op-vq-g6b", "螺丝刀", [hl(0, 1000)]),
  ]), deps);
  assert.equal(first.ok, true);
  const retry = await handler(commitEvent(ticket, [
    newItem("d-1", "op-vq-g6b", "螺丝刀", [hl(0, 1000)], { quantity: 2, unit: "件" }),
  ]), deps);
  assert.equal(retry.ok, false);
  assert.equal(retry.error, "OPERATION_CONFLICT", "混合模式重试(无数量→有数量)签名必须失配");
});
