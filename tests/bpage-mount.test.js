"use strict";
// PR A(#116,docs/design/location-tree-wave1/D0-CONTRACT.md v2 §1/§4):B 页场景扫描
// 的可选显式挂载——videoSceneCommit 无 location 上下文时 items[i] 可携带 node_id。
// 反例矩阵(B 页挂载部分,冻结):
// - 选已有非根节点 → 挂载成功且 location_text === 服务端权威节点路径;
// - 不选 node_id → 纯文本,行为与现状逐字节一致(旧载荷签名逐字节不变);
// - 窗口一(不存在/跨家庭/home 根/形状非法)→ 整批零写;
// - 窗口二(校验后节点被并发删 / 挂载 CAS 失败)→ 物品保留 + mounted:false +
//   mount_error,响应不显完整成功(绝不删物品/证据);
// - 同票据重放换 node_id → 签名失配 OPERATION_CONFLICT。
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH_A = "hh_11111111111111111111111111111111";
const HH_B = "hh_22222222222222222222222222222222";
const DURATION = 12000;
const HIGHLIGHT_SOURCE = "user_confirmed";

let GLOBAL_SEQ = 0;

function makeDeps(db, opts) {
  opts = opts || {};
  let clock = 1760000000000;
  const state = { failDelete: false };
  return {
    db,
    householdId: opts.householdId || HH_A,
    householdShared: false,
    scopeRevision: null,
    now: () => new Date(clock).toISOString(),
    advance: (ms) => { clock += ms; },
    genId: () => { GLOBAL_SEQ += 1; return "n" + String(GLOBAL_SEQ).padStart(12, "0"); },
    // onTempUrls:窗口二注入点——verifyFile 在窗口一静态校验之后、建档/挂载之前
    // 调用 getTempFileUrls,在此时机改动 DB 即模拟「校验后、提交中」的并发。
    getTempFileUrls: async (ids) => {
      if (opts.onTempUrls) await opts.onTempUrls();
      return { fileList: ids.map((fileID) => ({ fileID, tempFileURL: "https://tmp.example/" + encodeURIComponent(fileID) })) };
    },
    deleteCloudFiles: async (ids) => {
      if (state.failDelete === true) return { fileList: ids.map((fileID) => ({ fileID, status: -1 })) };
      return { fileList: ids.map((fileID) => ({ fileID, status: 0, errMsg: "ok" })) };
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

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

async function seedTree(db, householdId) {
  const nodes = [
    { _id: "lc_root", parent_id: "", name: "我的家", path: [] },
    { _id: "lc_study", parent_id: "lc_root", name: "书房", path: ["书房"] },
    { _id: "lc_shelf", parent_id: "lc_study", name: "书柜", path: ["书房", "书柜"] },
    { _id: "lc_layer", parent_id: "lc_shelf", name: "第一层", path: ["书房", "书柜", "第一层"] },
    { _id: "lc_kitchen", parent_id: "lc_root", name: "厨房", path: ["厨房"] },
  ];
  for (const n of nodes) {
    await db.collection("locations").add({ data: Object.assign({ household_id: householdId, name_norm: n.name }, n) });
  }
  return nodes;
}

async function seedTreeB(db) {
  const nodes = [
    { _id: "lc_b_root", parent_id: "", name: "我的家", path: [] },
    { _id: "lc_b_balcony", parent_id: "lc_b_root", name: "阳台", path: ["阳台"] },
  ];
  for (const n of nodes) {
    await db.collection("locations").add({ data: Object.assign({ household_id: HH_B, name_norm: n.name }, n) });
  }
  return nodes;
}

function hl(start, end, frameMs) {
  const out = { start_ms: start, end_ms: end, box: null };
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
  return { begin, fileId, sceneId };
}

function newItem(draftKey, opId, name, highlights, nodeId, locationText) {
  const out = {
    draft_key: draftKey,
    target: "new",
    operation_id: opId,
    name,
    location_text: locationText || "书房 / 书柜 / 第一层",
    note: "",
    highlights,
  };
  if (nodeId !== undefined) out.node_id = nodeId;
  return out;
}

function commitEvent(ticket, items, extra) {
  return Object.assign({
    action: "videoSceneCommit",
    scene_id: ticket.sceneId,
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

/** 直接注入物品(模拟并发窗口/旧数据) */
async function seedItem(db, householdId, id, extra) {
  const doc = Object.assign({
    _id: id,
    household_id: householdId,
    name: "物品" + id,
    name_norm: "物品" + id,
    location_text: "厨房",
    note: "",
    version: 1,
    deleted: false,
    operation_id: "op-seed-" + id,
    created_at: "2026-10-19T00:00:00.000Z",
    updated_at: "2026-10-19T00:00:00.000Z",
  }, extra || {});
  await db.collection("items").add({ data: doc });
  return doc;
}

async function assertZeroWrite(db) {
  assert.equal((await rawDocs(db, "items")).length, 0, "零写:不建物品");
  assert.equal((await rawDocs(db, "video_evidence")).length, 0, "零写:不写证据");
  assert.equal((await rawDocs(db, "location_scans")).length, 0, "零写:不落 scan");
  const tickets = (await rawDocs(db, "video_upload_tickets")).filter((t) => t.scene_payload_sig !== "");
  assert.equal(tickets.length, 0, "零写:票据不落签名");
}

// ---------------------------------------------------------------------------
// 挂载成功
// ---------------------------------------------------------------------------

test("B-MOUNT-OK:B 页显式 node_id 选已有非根节点 → 挂载成功,location_text=服务端权威路径", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const sceneId = "scene-bmount-ok-01";
  const ticket = await sceneTicket(deps, sceneId);
  const res = await handler(commitEvent(ticket, [
    newItem("d-mount", "op-bmount-ok", "螺丝刀", [hl(0, 1200, 0)], "lc_layer", "书房 / 书柜 / 第一层"),
    newItem("d-plain", "op-bmount-plain", "胶带", [hl(2000, 3200, 2000)]),
  ]), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ticket_state, "bound");
  assert.equal(res.scan, undefined, "B 页无 location 上下文 → 响应无 scan 字段");

  const byDraft = Object.fromEntries(res.results.map((r) => [r.draft_key, r]));
  assert.equal(byDraft["d-mount"].ok, true);
  assert.equal(byDraft["d-mount"].node_id, "lc_layer");
  assert.equal(byDraft["d-mount"].mounted, true);
  assert.equal(byDraft["d-mount"].mount_error, undefined);
  assert.equal(byDraft["d-plain"].node_id, undefined, "未携带 node_id 的件零增量字段");
  assert.equal(byDraft["d-plain"].mounted, undefined);

  const items = await rawDocs(db, "items");
  assert.equal(items.length, 2);
  const mounted = items.find((d) => d.operation_id === "op-bmount-ok");
  const plain = items.find((d) => d.operation_id === "op-bmount-plain");
  assert.equal(mounted.location_node_id, "lc_layer");
  assert.equal(mounted.location_text, "书房 / 书柜 / 第一层", "location_text === 服务端权威节点路径");
  assert.equal(mounted.version, 2, "建档 v1 后挂载 → v2");
  assert.equal(mounted.last_update_id, "d1mount:" + sha256(sceneId + ":" + mounted._id), "B 页复用 D1 挂载机器(scene_id 与 D1 scan_id 同一幂等键)");
  assert.equal(plain.location_node_id, undefined, "未选 node_id 的件不挂载(现状行为)");
  assert.equal(plain.version, 1);

  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 2);
  for (const row of evidence) assert.equal(row.scan_id, undefined, "B 页证据行不带 scan_id");
  assert.equal((await rawDocs(db, "location_scans")).length, 0, "B 页不落 location_scans");
});

test("B-MOUNT-IDEMPOTENT:同载荷重试 → 挂载三重重放识别收敛,版本不再推进", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const ticket = await sceneTicket(deps, "scene-bmount-idem-01");
  const ev = commitEvent(ticket, [
    newItem("d-a", "op-bmount-idem", "钥匙", [hl(0, 900, 0)], "lc_shelf", "书房 / 书柜"),
  ]);
  const first = await handler(ev, deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  deps.advance(3000);
  const retry = await handler(ev, deps);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.results[0].mounted, true);
  assert.equal(retry.results[0].evidence_duplicated, true);
  const items = await rawDocs(db, "items");
  assert.equal(items.length, 1);
  assert.equal(items[0].version, 2, "挂载重放不再推进版本");
  assert.equal(items[0].location_node_id, "lc_shelf");
});

// ---------------------------------------------------------------------------
// 窗口一:提交前静态校验(整批零写)
// ---------------------------------------------------------------------------

test("B-MOUNT-WIN1:B 页窗口一——不存在/跨家庭/home 根/形状非法 → 整批零写", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  await seedTreeB(db);
  const deps = makeDeps(db);
  const ticket = await sceneTicket(deps, "scene-bmount-win1-01");

  // 节点不存在 → NOT_FOUND
  const resMissing = await handler(commitEvent(ticket, [
    newItem("d-1", "op-win1-missing", "锅", [hl(0, 1000, 0)], "lc_nope", "不存在的地方"),
  ]), deps);
  assert.equal(resMissing.ok, false);
  assert.equal(resMissing.error, "NOT_FOUND");
  await assertZeroWrite(db);

  // 跨家庭节点(B 家的树)→ NOT_FOUND(household 过滤天然跨家庭)
  const depsCross = makeDeps(db, { householdId: HH_B });
  const ticketCross = await sceneTicket(depsCross, "scene-bmount-win1-02");
  const resCross = await handler(commitEvent(ticketCross, [
    newItem("d-2", "op-win1-cross", "水杯", [hl(0, 1000, 0)], "lc_shelf", "书房 / 书柜"),
  ]), depsCross);
  assert.equal(resCross.ok, false);
  assert.equal(resCross.error, "NOT_FOUND", "他家节点按查不到处理(findNodeById 同语义)");
  assert.equal((await rawDocs(db, "items")).length, 0);

  // home 根 → INVALID_INPUT(§2 根禁挂,B 页出生即走统一判定;W6 反例)
  const depsRoot = makeDeps(db);
  const ticketRoot = await sceneTicket(depsRoot, "scene-bmount-win1-03");
  const resRoot = await handler(commitEvent(ticketRoot, [
    newItem("d-3", "op-win1-root", "闹钟", [hl(0, 1000, 0)], "lc_root", "我的家"),
  ]), depsRoot);
  assert.equal(resRoot.ok, false);
  assert.equal(resRoot.error, "INVALID_INPUT");
  await assertZeroWrite(db);

  // 形状非法:数字 / 空串 → INVALID_INPUT(parseSceneCommitItems 输入门)
  const depsShape = makeDeps(db);
  const ticketShape = await sceneTicket(depsShape, "scene-bmount-win1-04");
  for (const badNodeId of [123, ""]) {
    const ev = commitEvent(ticketShape, [newItem("d-4", "op-win1-shape", "尺子", [hl(0, 1000, 0)])]);
    ev.items[0].node_id = badNodeId;
    const res = await handler(ev, depsShape);
    assert.equal(res.ok, false, "node_id 形状非法必须拒绝: " + JSON.stringify(badNodeId));
    assert.equal(res.error, "INVALID_INPUT");
  }
  await assertZeroWrite(db);

  // location_text ≠ 目标节点路径(服务端权威,消除双份真相)→ INVALID_INPUT 零写
  const depsText = makeDeps(db);
  const ticketText = await sceneTicket(depsText, "scene-bmount-win1-05");
  const resText = await handler(commitEvent(ticketText, [
    newItem("d-5", "op-win1-text", "剪刀", [hl(0, 1000, 0)], "lc_layer", "随手写的地方"),
  ]), depsText);
  assert.equal(resText.ok, false);
  assert.equal(resText.error, "INVALID_INPUT");
  assert.deepEqual(resText.detail.location_text_mismatch, ["d-5"]);
  await assertZeroWrite(db);

  // 整批语义:批内一件非法 → 整批零写(合法件也不建)
  const depsBatch = makeDeps(db);
  const ticketBatch = await sceneTicket(depsBatch, "scene-bmount-win1-06");
  const resBatch = await handler(commitEvent(ticketBatch, [
    newItem("d-good", "op-win1-good", "胶带", [hl(0, 800, 0)], "lc_shelf", "书房 / 书柜"),
    newItem("d-bad", "op-win1-bad", "锅", [hl(900, 1600, 900)], "lc_nope", "不存在"),
  ]), depsBatch);
  assert.equal(resBatch.ok, false);
  assert.equal(resBatch.error, "NOT_FOUND");
  await assertZeroWrite(db);
});

// ---------------------------------------------------------------------------
// 窗口二:提交中并发(如实降级,不回滚)
// ---------------------------------------------------------------------------

test("B-MOUNT-WIN2-DELETE:校验后节点被并发删 → 物品保留+mounted:false+mount_error,证据保留", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  // verifyFile(窗口一之后)回调里删目标节点:模拟校验通过后、挂载前的并发删除
  const deps = makeDeps(db, {
    onTempUrls: async () => {
      await db.collection("locations").where({ _id: "lc_layer", household_id: HH_A }).remove();
    },
  });
  const ticket = await sceneTicket(deps, "scene-bmount-win2-01");
  const res = await handler(commitEvent(ticket, [
    newItem("d-cc", "op-win2-delete", "螺丝刀", [hl(0, 1200, 0)], "lc_layer", "书房 / 书柜 / 第一层"),
  ]), deps);
  assert.equal(res.ok, true, JSON.stringify(res), "顶层仍逐件语义(B 部分失败语义)");
  const row = res.results[0];
  assert.equal(row.ok, true);
  assert.equal(row.evidence_saved, true, "证据保留");
  assert.equal(row.node_id, "lc_layer");
  assert.equal(row.mounted, false, "挂载失败必须如实降级 mounted:false");
  assert.equal(row.mount_error, "NOT_FOUND");

  const items = await rawDocs(db, "items");
  assert.equal(items.length, 1, "物品保留,绝不因挂载失败删除");
  assert.equal(items[0].location_text, "书房 / 书柜 / 第一层");
  assert.equal(items[0].location_node_id, undefined, "节点已删 → 不写悬挂挂载");
  assert.equal(items[0].version, 1, "未发生挂载写");
  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 1, "证据保留");
  assert.equal((await rawDocs(db, "location_scans")).length, 0);
});

test("B-MOUNT-WIN2-CAS:挂载 CAS 失败(物品版本已被并发推进)→ mounted:false+VERSION_CONFLICT,建档+证据保留", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  // 预置同 operation_id 且内容一致的既有物品、版本已推进到 3(模拟建档与挂载之间
  // 被并发编辑):createItem 按 operation_id 幂等重放命中既有行,applyScanMount 的
  // version=1 条件必然 0 命中 → 真实 VERSION_CONFLICT 降级路径。
  await seedItem(db, HH_A, "it_win2_cas", {
    name: "扳手",
    name_norm: "扳手",
    operation_id: "op-win2-cas",
    version: 3,
    location_text: "书房 / 书柜",
    note: "",
  });
  const ticket = await sceneTicket(deps, "scene-bmount-win2-02");
  const res = await handler(commitEvent(ticket, [
    newItem("d-cas", "op-win2-cas", "扳手", [hl(0, 1200, 0)], "lc_shelf", "书房 / 书柜"),
  ]), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = res.results[0];
  assert.equal(row.ok, true);
  assert.equal(row.duplicated, true, "建档按 operation_id 幂等重放");
  assert.equal(row.evidence_saved, true);
  assert.equal(row.mounted, false);
  assert.equal(row.mount_error, "VERSION_CONFLICT");

  const items = await rawDocs(db, "items");
  assert.equal(items.length, 1);
  assert.equal(items[0].version, 3, "CAS 失败不写物品(版本不动)");
  assert.equal(items[0].location_node_id, undefined);
  assert.equal((await rawDocs(db, "video_evidence")).length, 1, "证据保留");
});

// ---------------------------------------------------------------------------
// 签名(显式携带才进 canonical;旧载荷逐字节不变)
// ---------------------------------------------------------------------------

test("B-MOUNT-SIG-PLAIN:不选 node_id → 纯文本,行为与现状逐字节一致(签名值逐字节锁定)", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const ticket = await sceneTicket(deps, "scene-bmount-sig-01");
  const highlights = [hl(0, 1000, 0)];
  const res = await handler(commitEvent(ticket, [
    newItem("d-sig", "op-bmount-sig", "胶带", highlights, undefined, "厨房"),
  ]), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results[0].node_id, undefined);
  assert.equal(res.results[0].mounted, undefined);

  // 旧载荷签名逐字节锁定:与 D0 之前的 canonical 结构(无 node_id 键)完全一致
  const ticketDoc = (await db.collection("video_upload_tickets").doc(ticket.begin.upload_ticket).get()).data;
  // canonicalSceneItems 同构(键序即序列化序):draft_key, target, highlights,
  // operation_id, name, location_text, note(B 无 location 时到此为止)
  const legacyCanonical = [{
    draft_key: "d-sig",
    target: "new",
    highlights: highlights.map((h) => Object.assign(
      { start_ms: h.start_ms, end_ms: h.end_ms, box: h.box },
      h.frame_ms !== undefined ? { frame_ms: h.frame_ms } : {},
      { source: HIGHLIGHT_SOURCE },
    )),
    operation_id: "op-bmount-sig",
    name: "胶带",
    location_text: "厨房",
    note: "",
  }].sort(function (a, b) { return a.draft_key < b.draft_key ? -1 : 1; });
  assert.equal(ticketDoc.scene_payload_sig, sha256(JSON.stringify(legacyCanonical)), "旧载荷签名输入逐字节不变");
});

test("B-MOUNT-SIG-REPLAY:同票据重放换 node_id → 签名失配 OPERATION_CONFLICT,零新增写", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const ticket = await sceneTicket(deps, "scene-bmount-replay-01");
  const first = await handler(commitEvent(ticket, [
    newItem("d-r", "op-bmount-replay", "钳子", [hl(0, 1000, 0)], "lc_shelf", "书房 / 书柜"),
  ]), deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  const itemsBefore = await rawDocs(db, "items");
  const evidenceBefore = await rawDocs(db, "video_evidence");

  // 同票据同 scene 换 node_id 重试 → node_id 进 canonical → 签名失配
  const swapped = await handler(commitEvent(ticket, [
    newItem("d-r", "op-bmount-replay", "钳子", [hl(0, 1000, 0)], "lc_layer", "书房 / 书柜 / 第一层"),
  ]), deps);
  assert.equal(swapped.ok, false);
  assert.equal(swapped.error, "OPERATION_CONFLICT");
  assert.equal((await rawDocs(db, "items")).length, itemsBefore.length, "零新增写入");
  assert.equal((await rawDocs(db, "video_evidence")).length, evidenceBefore.length, "零新增写入");

  // 同票据去掉 node_id 重试(换回纯文本)→ 同样失配(显式携带才进签名=携带即承诺)
  const stripped = commitEvent(ticket, [
    newItem("d-r", "op-bmount-replay", "钳子", [hl(0, 1000, 0)], undefined, "书房 / 书柜"),
  ]);
  const strippedRes = await handler(stripped, deps);
  assert.equal(strippedRes.ok, false);
  assert.equal(strippedRes.error, "OPERATION_CONFLICT");
});
