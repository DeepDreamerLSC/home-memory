"use strict";
// D1 移动语义合同(#94 验收 3/4/5,docs/design/video-ai/D1-IMPLEMENTATION.md §4/§7):
// 新物品挂载到 node_id、挂载冲突仅降级 mounted:false 不删物品;existing 无
// move_to_node_id → 物品文档零字段变化;显式移动先于证据、冲突不写证据;
// 移动重放/已在目标节点收敛;旧证据 captured_location_text 冻结不动。
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH_A = "hh_11111111111111111111111111111111";
const DURATION = 12000;

let GLOBAL_SEQ = 0;

function makeDeps(db, opts) {
  opts = opts || {};
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
    genId: () => { GLOBAL_SEQ += 1; return "n" + String(GLOBAL_SEQ).padStart(12, "0"); },
    getTempFileUrls: async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID, tempFileURL: "https://tmp.example/" + encodeURIComponent(fileID) })),
    }),
    deleteCloudFiles: async (ids) => {
      cloudDeleted.push.apply(cloudDeleted, ids);
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

async function seedTree(db) {
  const nodes = [
    { _id: "lc_root", parent_id: "", name: "我的家", path: [] },
    { _id: "lc_study", parent_id: "lc_root", name: "书房", path: ["书房"] },
    { _id: "lc_shelf", parent_id: "lc_study", name: "书柜", path: ["书房", "书柜"] },
    { _id: "lc_kitchen", parent_id: "lc_root", name: "厨房", path: ["厨房"] },
  ];
  for (const n of nodes) {
    await db.collection("locations").add({ data: Object.assign({ household_id: HH_A, name_norm: n.name }, n) });
  }
}

async function seedItem(db, id, extra) {
  const doc = Object.assign({
    _id: id,
    household_id: HH_A,
    name: "物品" + id,
    name_norm: "物品" + id,
    location_text: "厨房 台面",
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

function hl(start, end) {
  return { start_ms: start, end_ms: end, box: null, frame_ms: start };
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

function commitEvent(ticket, items, scanId) {
  return {
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
    location: {
      location_id: "lc_shelf",
      scan_id: scanId,
      path_snapshot: ["书房", "书柜"],
      text_snapshot: "书房 / 书柜",
    },
  };
}

test("D1-MOUNT:新物品建档后挂载到 node_id;挂载冲突仅降级 mounted:false,绝不删物品", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  const scanId = "scan-mount-01";
  const ticket = await sceneTicket(deps, scanId);

  // 冲突窗口模拟:同 operation_id 的物品已存在且 version=2(首次提交建档后
  // 响应丢失、又被并发编辑),createItem 幂等返回 duplicated,挂载 CAS(expected=1)失配
  await seedItem(db, "it_mount_stale", {
    operation_id: "op-mount-stale",
    name: "充电宝",
    location_text: "书房 / 书柜",
    version: 2,
  });
  const res = await handler(commitEvent(ticket, [
    {
      draft_key: "d-mount",
      target: "new",
      operation_id: "op-mount-stale",
      name: "充电宝",
      location_text: "书房 / 书柜",
      node_id: "lc_shelf",
      highlights: [hl(0, 900)],
    },
  ], scanId), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results[0].ok, true, "挂载失败不推翻建档+证据");
  assert.equal(res.results[0].duplicated, true, "createItem 幂等命中已有物品");
  assert.equal(res.results[0].node_id, "lc_shelf");
  assert.equal(res.results[0].mounted, false, "挂载 CAS 失配 → mounted:false 如实上报");
  assert.equal(res.results[0].mount_error, "VERSION_CONFLICT");

  const items = await rawDocs(db, "items");
  assert.equal(items.length, 1, "绝不重复建档,绝不删物品");
  const doc = items[0];
  assert.equal(doc._id, "it_mount_stale");
  assert.equal(doc.version, 2, "挂载失败版本不动");
  assert.equal(doc.location_node_id, undefined, "挂载未生效");
  assert.equal(doc.deleted, false);
  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 1, "证据照存");
  assert.equal(evidence[0].item_id, "it_mount_stale");
  assert.equal(evidence[0].scan_id, scanId);
  const scans = await rawDocs(db, "location_scans");
  assert.equal(scans.length, 1);
  assert.equal(scans[0].confirmed_count, 1, "证据已存的物品计入确认数");

  // 后续手动挂载(用户在位置页确认)收敛:location_node_id 落位
  const manual = await handler({
    action: "update",
    item_id: "it_mount_stale",
    expected_version: 2,
    location_text: "书房 / 书柜",
    update_id: "manual-mount-retry",
  }, deps);
  assert.equal(manual.ok, true, JSON.stringify(manual));
});

test("D1-MOUNT-REPLAY:响应丢失后同载荷重试,挂载经三重重放识别收敛且版本不再推进", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  const scanId = "scan-mount-02";
  const ticket = await sceneTicket(deps, scanId);
  const ev = commitEvent(ticket, [
    {
      draft_key: "d-mount2",
      target: "new",
      operation_id: "op-mount-02",
      name: "备用电池",
      location_text: "书房 / 书柜",
      node_id: "lc_shelf",
      highlights: [hl(0, 700)],
    },
  ], scanId);
  const first = await handler(ev, deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.results[0].mounted, true);
  const retry = await handler(ev, deps);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.results[0].mounted, true, "重放识别后仍报 mounted:true");
  assert.equal(retry.results[0].duplicated, true);
  const doc = (await rawDocs(db, "items"))[0];
  assert.equal(doc.version, 2, "重试不重复挂载,版本停在 2");
  assert.equal(doc.last_update_id, "d1mount:" + sha256(scanId + ":" + doc._id));
  assert.equal((await rawDocs(db, "location_scans")).length, 1);
});

test("D1-LINK-ONLY:existing 不带 move_to_node_id → 只补视频证据,物品文档零字段变化", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  await seedItem(db, "it_link", {
    location_node_id: "lc_kitchen",
    location_text: "厨房 台面",
    version: 3,
    note: "别动我",
    updated_at: "2026-10-01T00:00:00.000Z",
  });
  const before = (await rawDocs(db, "items"))[0];
  const scanId = "scan-link-01";
  const ticket = await sceneTicket(deps, scanId);
  const res = await handler(commitEvent(ticket, [
    { draft_key: "d-link", target: "existing", item_id: "it_link", highlights: [hl(0, 900)] },
  ], scanId), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = res.results[0];
  assert.equal(row.ok, true);
  assert.equal(row.move, undefined, "只关联不带 move 字段");
  const after = (await rawDocs(db, "items"))[0];
  assert.deepEqual(after, before, "关联已有物品不自动改变位置:物品文档零字段变化(version 不动)");
  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].captured_location_text, "厨房 台面", "证据冻结物品当前位置文本");
  assert.equal(evidence[0].scan_id, scanId);
});

test("D1-MOVE-EXPLICIT:移动先于证据;一次条件更新同写 location_text+node;旧证据冻结不动", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  const item = await seedItem(db, "it_move", { location_node_id: "lc_kitchen", location_text: "厨房 台面", version: 1 });
  // 旧证据:此前在厨房拍的视频(captured_location_text 是历史事实)
  await db.collection("video_evidence").add({ data: {
    _id: "ve_old_kitchen",
    household_id: HH_A,
    item_id: "it_move",
    file_id: "cloud://bucket/video-evidence/" + HH_A + "/old-kitchen.mp4",
    asset_id: "va_old_kitchen",
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
    captured_location_text: "厨房 台面",
    consent_version: "v1",
    upload_ticket: "vt_old_kitchen",
    source: "scene",
    highlights: [hl(0, 500)],
    highlight_version: 1,
    created_at: "2026-10-01T00:00:00.000Z",
  } });
  const oldRowBefore = JSON.parse(JSON.stringify((await rawDocs(db, "video_evidence"))[0]));

  const scanId = "scan-move-01";
  const ticket = await sceneTicket(deps, scanId);
  const res = await handler(commitEvent(ticket, [
    { draft_key: "d-move", target: "existing", item_id: "it_move", move_to_node_id: "lc_shelf", expected_version: 1, highlights: [hl(1000, 2000)] },
  ], scanId), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results[0].move, "moved");

  const doc = (await rawDocs(db, "items")).find((d) => d._id === "it_move");
  assert.equal(doc.location_node_id, "lc_shelf", "移动到当前位置并关联");
  assert.equal(doc.location_text, "书房 / 书柜", "一次条件更新同时写新位置路径文本");
  assert.equal(doc.version, 2);
  assert.equal(doc.last_update_id, "d1move:" + sha256(scanId + ":" + item._id));

  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 2);
  const newRow = evidence.find((r) => r._id !== "ve_old_kitchen");
  assert.equal(newRow.scan_id, scanId);
  assert.equal(newRow.captured_location_text, "书房 / 书柜", "新证据写当前位置(移动后)");
  const oldRow = evidence.find((r) => r._id === "ve_old_kitchen");
  assert.deepEqual(oldRow, oldRowBefore, "旧证据保留原 captured_location_text:不迁移、不删除");
});

test("D1-MOVE-REPLAY:响应丢失后同载荷重试 → move:replayed,版本与证据零漂移", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  await seedItem(db, "it_replay", { location_node_id: "lc_kitchen", version: 1 });
  const scanId = "scan-replay-01";
  const ticket = await sceneTicket(deps, scanId);
  const ev = commitEvent(ticket, [
    { draft_key: "d-replay", target: "existing", item_id: "it_replay", move_to_node_id: "lc_shelf", expected_version: 1, highlights: [hl(0, 800)] },
  ], scanId);
  const first = await handler(ev, deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.results[0].move, "moved");
  deps.advance(2000);
  const retry = await handler(ev, deps);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.results[0].move, "replayed", "d1move 派生标识三重重放识别");
  assert.equal(retry.results[0].evidence_duplicated, true);
  const doc = (await rawDocs(db, "items")).find((d) => d._id === "it_replay");
  assert.equal(doc.version, 2, "重放不再推进版本");
  assert.equal((await rawDocs(db, "video_evidence")).length, 1);
  assert.equal((await rawDocs(db, "location_scans")).length, 1);
});

test("D1-MOVE-ALREADY:已在目标节点的过期请求 → move:already 收敛,版本不回拨", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  // 物品已被挂到书柜且版本推进到 5;客户端拿到的还是 v3 的旧版本
  await seedItem(db, "it_already", { location_node_id: "lc_shelf", location_text: "书房 / 书柜", version: 5 });
  const scanId = "scan-already-01";
  const ticket = await sceneTicket(deps, scanId);
  const res = await handler(commitEvent(ticket, [
    { draft_key: "d-already", target: "existing", item_id: "it_already", move_to_node_id: "lc_shelf", expected_version: 3, highlights: [hl(0, 600)] },
  ], scanId), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results[0].move, "already", "已在目标节点:幂等收敛");
  const doc = (await rawDocs(db, "items")).find((d) => d._id === "it_already");
  assert.equal(doc.version, 5, "already 不推进版本");
  assert.equal((await rawDocs(db, "video_evidence")).length, 1, "证据照存");
});

test("D1-MOVE-CONFLICT:移动与 itemsApi.update 并发 → 该件 VERSION_CONFLICT 不写证据,其余件照常", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  // 物品先建(v1),随后被并发 itemsApi.update 推到 v2;匹配列表读到的是 v1
  const created = await handler({
    action: "create",
    operation_id: "op-move-conflict",
    name: "电钻",
    location_text: "厨房 台面",
  }, deps);
  assert.equal(created.ok, true, JSON.stringify(created));
  const itemId = created.item.item_id;
  const bumped = await handler({
    action: "update",
    item_id: itemId,
    expected_version: 1,
    note: "并发改名窗口",
    update_id: "u-race-1",
  }, deps);
  assert.equal(bumped.ok, true, JSON.stringify(bumped));

  const scanId = "scan-moveconf-01";
  const ticket = await sceneTicket(deps, scanId);
  const res = await handler(commitEvent(ticket, [
    { draft_key: "d-conflict", target: "existing", item_id: itemId, move_to_node_id: "lc_shelf", expected_version: 1, highlights: [hl(0, 800)] },
    { draft_key: "d-bystander", target: "new", operation_id: "op-moveconf-new", name: " bystander 卷尺", location_text: "书房 / 书柜", highlights: [hl(1000, 1600)] },
  ], scanId), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const rows = Object.fromEntries(res.results.map((r) => [r.draft_key, r]));
  assert.equal(rows["d-conflict"].ok, false);
  assert.equal(rows["d-conflict"].error, "VERSION_CONFLICT");
  assert.equal(rows["d-conflict"].moved, false);
  assert.equal(rows["d-bystander"].ok, true, "其余件照常(B 部分失败语义)");
  assert.equal(res.scan.confirmed_count, 1);

  const doc = (await rawDocs(db, "items")).find((d) => d._id === itemId);
  assert.equal(doc.location_node_id, undefined, "冲突件位置不动");
  assert.equal(doc.version, 2, "版本保持并发方的推进结果");
  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 1, "冲突件不写证据");
  assert.notEqual(evidence[0].item_id, itemId);
});
