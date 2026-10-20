"use strict";
// D1 位置级视频清点服务端合同(issue #94,docs/design/video-ai/D1-IMPLEMENTATION.md §2/§7):
// videoSceneCommit 的可选 location 上下文:子树校验零写、跨家庭 NOT_FOUND、
// location_scans 幂等落库与部分失败重试自愈、零确认也落 scan、scan_id 关联
// evidence、B 零感知(无 location 参数 = 无 scan 字段、签名不变)。
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH_A = "hh_11111111111111111111111111111111";
const HH_B = "hh_22222222222222222222222222222222";
const DURATION = 12000;

// genId 用全局计数器:真实环境 _id 全局唯一,若每个 deps 各自从 1 起,
// 同库双家庭的测试会产生相同 _id(生产不可能),票据/物品会互相串门
let GLOBAL_SEQ = 0;

function makeDeps(db, opts) {
  opts = opts || {};
  let clock = 1760000000000;
  const cloudDeleted = [];
  const state = { failDelete: opts.failDelete === true };
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
    getTempFileUrls: async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID, tempFileURL: "https://tmp.example/" + encodeURIComponent(fileID) })),
    }),
    deleteCloudFiles: async (ids) => {
      if (state.failDelete === true) return { fileList: ids.map((fileID) => ({ fileID, status: -1 })) };
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

/** 直接注入位置节点(不走 locations 函数,测试只依赖 parent_id/path 结构事实) */
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

/** B 家自己的树(id 与 A 家不重叠) */
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

function newItem(draftKey, opId, name, highlights, nodeId, locationText) {
  const out = {
    draft_key: draftKey,
    target: "new",
    operation_id: opId,
    name,
    location_text: locationText || "书房 / 书柜",
    highlights,
  };
  if (nodeId !== undefined) out.node_id = nodeId;
  return out;
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

/** 直接注入已挂载物品(模拟旧数据/并发窗口,不走 itemsApi) */
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

test("D1-COMMIT-FULL:位置上下文落库,新物品挂载默认/子节点,scan 行字段齐全", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const scanId = "scan-commit-full-01";
  const ticket = await sceneTicket(deps, scanId);
  const ev = commitEvent(ticket, [
    newItem("d-deep", "op-d1-deep", "螺丝刀", [hl(0, 1200, box(), 0)], "lc_layer", "书房 / 书柜 / 第一层"),
    newItem("d-room", "op-d1-room", "闹钟", [hl(2000, 3200, null, 2000)]),
  ], {
    scene_id: scanId,
    location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]),
    candidate_count: 5,
  });
  const res = await handler(ev, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ticket_state, "bound");
  assert.ok(res.scan, "location 存在时响应必须带 scan");
  assert.equal(res.scan.scan_id, scanId);
  assert.equal(res.scan.location_id, "lc_shelf");
  assert.equal(res.scan.status, "active");
  assert.equal(res.scan.confirmed_count, 2);
  assert.deepEqual(res.scan.evidence_failed, []);

  const byDraft = Object.fromEntries(res.results.map((r) => [r.draft_key, r]));
  assert.equal(byDraft["d-deep"].node_id, "lc_layer");
  assert.equal(byDraft["d-deep"].mounted, true);
  assert.equal(byDraft["d-room"].node_id, "lc_shelf");
  assert.equal(byDraft["d-room"].mounted, true);

  const items = await rawDocs(db, "items");
  assert.equal(items.length, 2);
  const deep = items.find((d) => d.operation_id === "op-d1-deep");
  const room = items.find((d) => d.operation_id === "op-d1-room");
  assert.equal(deep.location_node_id, "lc_layer");
  assert.equal(deep.location_text, "书房 / 书柜 / 第一层");
  assert.equal(deep.version, 2, "建档 v1 后 d1mount 挂载 → v2");
  assert.equal(deep.last_update_id, "d1mount:" + sha256(scanId + ":" + deep._id));
  assert.equal(room.location_node_id, "lc_shelf");
  assert.equal(room.version, 2);

  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 2);
  for (const row of evidence) {
    assert.equal(row.scan_id, scanId, "evidence 行必须关联 scan_id");
    assert.equal(row.asset_id, ticket.begin.asset_id);
    assert.equal(row.file_id, ticket.fileId);
    assert.equal(row.source, "scene");
  }
  const deepRow = evidence.find((r) => r.item_id === deep._id);
  assert.equal(deepRow.captured_location_text, "书房 / 书柜 / 第一层", "captured_location_text = 目标节点路径");

  const scans = await rawDocs(db, "location_scans");
  assert.equal(scans.length, 1);
  const scan = scans[0];
  assert.equal(scan.scan_id, scanId);
  assert.equal(scan.household_id, HH_A);
  assert.equal(scan.location_id, "lc_shelf");
  assert.deepEqual(scan.location_path_snapshot, ["书房", "书柜"], "落库以服务端查到的节点 path 为准");
  assert.equal(scan.location_text_snapshot, "书房 / 书柜");
  assert.equal(scan.file_id, ticket.fileId);
  assert.equal(scan.asset_id, ticket.begin.asset_id);
  assert.equal(scan.upload_ticket, ticket.begin.upload_ticket);
  assert.equal(scan.duration_ms, DURATION);
  assert.equal(scan.video_w, 1280);
  assert.equal(scan.video_h, 720);
  assert.equal(scan.candidate_count, 5);
  assert.equal(scan.confirmed_count, 2);
  assert.deepEqual(scan.confirmed_item_ids, [deep._id, room._id].sort());
  assert.equal(scan.status, "active");
  assert.ok(scan._id.indexOf("ls_") === 0);

  const got = await handler({ action: "videoEvidenceGet", item_ids: [deep._id, room._id] }, deps);
  assert.equal(got.ok, true);
  assert.equal(got.evidence.length, 2);
  for (const row of got.evidence) assert.equal(row.scan_id, scanId, "读侧投影携带 scan_id");
});

test("D1-SUBTREE:件选子树外节点 → INVALID_INPUT + out_of_subtree,整批零写", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const scanId = "scan-subtree-01";
  const ticket = await sceneTicket(deps, scanId);
  const bad = commitEvent(ticket, [
    newItem("d-out", "op-subtree-out", "锅", [hl(0, 1000, null, 0)], "lc_kitchen", "厨房"),
    newItem("d-in", "op-subtree-in", "闹钟", [hl(2000, 3000, null, 2000)]),
  ], {
    scene_id: scanId,
    location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]),
  });
  const res = await handler(bad, deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "INVALID_INPUT");
  assert.deepEqual(res.detail.out_of_subtree, ["d-out"]);
  assert.equal((await rawDocs(db, "items")).length, 0, "零写:不建物品");
  assert.equal((await rawDocs(db, "video_evidence")).length, 0, "零写:不写证据");
  assert.equal((await rawDocs(db, "location_scans")).length, 0, "零写:不落 scan");

  // move_to_node_id 越界同样拒绝
  await seedItem(db, HH_A, "it_move_out", { location_node_id: "lc_kitchen" });
  const badMove = commitEvent(ticket, [
    { draft_key: "d-move-out", target: "existing", item_id: "it_move_out", move_to_node_id: "lc_kitchen", expected_version: 1, highlights: [hl(0, 1000, null, 0)] },
  ], {
    scene_id: scanId,
    location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]),
  });
  const resMove = await handler(badMove, deps);
  assert.equal(resMove.ok, false);
  assert.equal(resMove.error, "INVALID_INPUT");
  assert.deepEqual(resMove.detail.out_of_subtree, ["d-move-out"]);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);

  // target:"new" 的 location_text ≠ 目标节点路径 → INVALID_INPUT 零写
  const badText = commitEvent(ticket, [
    newItem("d-text", "op-subtree-text", "剪刀", [hl(0, 1000, null, 0)], "lc_layer", "随便写的地方"),
  ], {
    scene_id: scanId,
    location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]),
  });
  const resText = await handler(badText, deps);
  assert.equal(resText.ok, false);
  assert.equal(resText.error, "INVALID_INPUT");
  assert.deepEqual(resText.detail.location_text_mismatch, ["d-text"]);
  assert.equal((await rawDocs(db, "items")).length, 1, "仅剩前置用例注入的物品,本批零建");

  // 根位置不可作为清点上下文(入口只在非根层)
  const badRoot = commitEvent(ticket, [
    newItem("d-root", "op-subtree-root", "闹钟", [hl(0, 1000, null, 0)]),
  ], {
    scene_id: scanId,
    location: locationBlock(scanId, "lc_root", ["我的家"]),
  });
  const resRoot = await handler(badRoot, deps);
  assert.equal(resRoot.ok, false);
  assert.equal(resRoot.error, "INVALID_INPUT");
  assert.equal((await rawDocs(db, "location_scans")).length, 0);
});

test("D1-CROSS-HOUSEHOLD:用他家 location_id → NOT_FOUND,零写", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  await seedTreeB(db); // B 家自己的树(id 与 A 家不重叠)
  const depsA = makeDeps(db);
  const depsB = makeDeps(db, { householdId: HH_B });
  const scanId = "scan-cross-01";
  const ticket = await sceneTicket(depsB, scanId);
  const ev = commitEvent(ticket, [
    newItem("d-cross", "op-cross-b", "水杯", [hl(0, 1000, null, 0)]),
  ], {
    scene_id: scanId,
    location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]), // A 家节点
  });
  const res = await handler(ev, depsB);
  assert.equal(res.ok, false);
  assert.equal(res.error, "NOT_FOUND", "跨家庭查不到节点,与 findNodeById 同语义");
  assert.equal((await rawDocs(db, "items")).length, 0);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
  assert.equal((await rawDocs(db, "location_scans")).length, 0);

  // 不存在的 location_id 同样 NOT_FOUND
  const depsA2 = makeDeps(db);
  const ticket2 = await sceneTicket(depsA2, "scan-cross-02");
  const resMissing = await handler(commitEvent(ticket2, [
    newItem("d-missing", "op-cross-a", "水杯", [hl(0, 1000, null, 0)]),
  ], {
    scene_id: "scan-cross-02",
    location: locationBlock("scan-cross-02", "lc_nope", ["书房"]),
  }), depsA2);
  assert.equal(resMissing.ok, false);
  assert.equal(resMissing.error, "NOT_FOUND");
  assert.equal((await rawDocs(db, "location_scans")).length, 0);
});

test("D1-B-COMPAT:无 location 参数 = B 现行为——响应无 scan 字段、evidence 无 scan_id;混合模式重试被签名硬门拒绝", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);

  // 纯 B 载荷:无 scan 字段、evidence 行不带 scan_id
  const plain = await sceneTicket(deps, "scene-bcompat-01");
  const plainRes = await handler(commitEvent(plain, [
    newItem("d-plain", "op-bcompat-plain", "胶带", [hl(0, 1000, null, 0)]),
  ], { scene_id: "scene-bcompat-01" }), deps);
  assert.equal(plainRes.ok, true, JSON.stringify(plainRes));
  assert.equal(plainRes.scan, undefined, "无 location → 响应无 scan 字段");
  const plainRows = await rawDocs(db, "video_evidence");
  assert.equal(plainRows.length, 1);
  assert.equal(plainRows[0].scan_id, undefined, "B 证据行不带 scan_id 字段");
  assert.equal((await rawDocs(db, "location_scans")).length, 0);

  // B 载荷成功后,同一票据改带 location 重试 → 签名失配 → OPERATION_CONFLICT
  const withLocation = commitEvent(plain, [
    newItem("d-plain", "op-bcompat-plain", "胶带", [hl(0, 1000, null, 0)]),
  ], {
    scene_id: "scene-bcompat-01",
    location: locationBlock("scene-bcompat-01", "lc_shelf", ["书房", "书柜"]),
  });
  const mixed = await handler(withLocation, deps);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.error, "OPERATION_CONFLICT");
  assert.equal((await rawDocs(db, "video_evidence")).length, 1, "混合模式零新增写入");

  // 反向:先 D1 成功,再退回无 location 重试 → 同样被拒
  const d1 = await sceneTicket(deps, "scan-bcompat-02");
  const d1Event = commitEvent(d1, [
    newItem("d-d1", "op-bcompat-d1", "胶带", [hl(0, 1000, null, 0)]),
  ], {
    scene_id: "scan-bcompat-02",
    location: locationBlock("scan-bcompat-02", "lc_shelf", ["书房", "书柜"]),
  });
  const d1Res = await handler(d1Event, deps);
  assert.equal(d1Res.ok, true, JSON.stringify(d1Res));
  const stripped = JSON.parse(JSON.stringify(d1Event));
  delete stripped.location;
  const strippedRes = await handler(stripped, deps);
  assert.equal(strippedRes.ok, false);
  assert.equal(strippedRes.error, "OPERATION_CONFLICT");
  assert.equal((await rawDocs(db, "video_evidence")).length, 2);
  assert.equal((await rawDocs(db, "location_scans")).length, 1, "只留 D1 那一条 scan");
});

test("D1-IDEMPOTENT:同冻结载荷重试 → 证据/物品/scan 全部 duplicated 收敛,计数不漂移", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const scanId = "scan-idem-01";
  const ticket = await sceneTicket(deps, scanId);
  const ev = commitEvent(ticket, [
    newItem("d-a", "op-idem-a", "钥匙", [hl(0, 900, null, 0)]),
    newItem("d-b", "op-idem-b", "门卡", [hl(1000, 1900, null, 1000)]),
  ], {
    scene_id: scanId,
    location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]),
    candidate_count: 4,
  });
  const first = await handler(ev, deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  deps.advance(3000);
  const retry = await handler(ev, deps);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.ticket_state, "bound");
  assert.equal(retry.scan.confirmed_count, 2);
  for (const row of retry.results) {
    assert.equal(row.ok, true);
    assert.equal(row.evidence_duplicated, true, "重试证据 duplicated");
    assert.equal(row.mounted, true, "挂载经三重重放识别收敛");
  }
  assert.equal((await rawDocs(db, "items")).length, 2, "不重复建档");
  assert.equal((await rawDocs(db, "video_evidence")).length, 2, "不重复证据");
  const scans = await rawDocs(db, "location_scans");
  assert.equal(scans.length, 1, "(household_id, scan_id) 幂等键");
  assert.equal(scans[0].confirmed_count, 2);
  assert.equal(scans[0].candidate_count, 4);
  const items = await rawDocs(db, "items");
  for (const it of items) assert.equal(it.version, 2, "挂载重放不再推进版本");
});

test("D1-PARTIAL-HEAL:单件移动版本冲突 → 该件无证据;刷新版本同载荷重试 → scan 计数自愈", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const stale = await seedItem(db, HH_A, "it_heal_stale", { version: 2, location_node_id: "lc_kitchen" });
  const scanId = "scan-heal-01";
  const ticket = await sceneTicket(deps, scanId);
  const buildEvent = (expectedVersion) => commitEvent(ticket, [
    {
      draft_key: "d-stale",
      target: "existing",
      item_id: stale._id,
      move_to_node_id: "lc_shelf",
      expected_version: expectedVersion,
      highlights: [hl(0, 800, null, 0)],
    },
    newItem("d-fresh", "op-heal-fresh", "新到的剪刀", [hl(1000, 1800, null, 1000)]),
  ], {
    scene_id: scanId,
    location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]),
    candidate_count: 3,
  });

  // 第一遍:stale 件 expected_version=1(实际 v2,模拟并发 itemsApi.update 已推进)→ VERSION_CONFLICT
  const first = await handler(buildEvent(1), deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.ticket_state, "bound", "其余件证据成功即 bound(B 部分失败语义)");
  const firstRows = Object.fromEntries(first.results.map((r) => [r.draft_key, r]));
  assert.equal(firstRows["d-stale"].ok, false);
  assert.equal(firstRows["d-stale"].error, "VERSION_CONFLICT");
  assert.equal(firstRows["d-stale"].moved, false);
  assert.equal(firstRows["d-fresh"].ok, true);
  assert.equal(first.scan.confirmed_count, 1, "scan 只计入成功件");
  assert.deepEqual(first.scan.evidence_failed, ["d-stale"]);
  let evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 1, "冲突件不写证据");
  assert.equal(evidence[0].item_id, firstRows["d-fresh"].item_id);

  // 客户端刷新物品版本后整批同载荷重试(expected_version 不进签名,签名稳定)
  deps.advance(2000);
  const retry = await handler(buildEvent(2), deps);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  const retryRows = Object.fromEntries(retry.results.map((r) => [r.draft_key, r]));
  assert.equal(retryRows["d-stale"].ok, true);
  assert.equal(retryRows["d-stale"].move, "moved");
  assert.equal(retryRows["d-fresh"].evidence_duplicated, true, "已成功件 duplicated 收敛");
  assert.equal(retry.scan.confirmed_count, 2, "scan 计数自愈:补齐的证据计入");

  evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 2);
  const scans = await rawDocs(db, "location_scans");
  assert.equal(scans.length, 1);
  assert.equal(scans[0].confirmed_count, 2);
  assert.deepEqual(scans[0].confirmed_item_ids, [stale._id, retryRows["d-fresh"].item_id].sort());
  const staleDoc = (await rawDocs(db, "items")).find((d) => d._id === stale._id);
  assert.equal(staleDoc.location_node_id, "lc_shelf");
  assert.equal(staleDoc.location_text, "书房 / 书柜");
  assert.equal(staleDoc.version, 3, "v2 → 移动后 v3");
  assert.equal(staleDoc.last_update_id, "d1move:" + sha256(scanId + ":" + stale._id));
});

test("D1-ZERO-CONFIRMED:全部件失败也落 scan(confirmed_count:0);取消时 scan 引用保住云文件", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const scanId = "scan-zero-01";
  const ticket = await sceneTicket(deps, scanId);
  const res = await handler(commitEvent(ticket, [
    { draft_key: "d-gone", target: "existing", item_id: "it_not_exists", highlights: [hl(0, 800, null, 0)] },
  ], {
    scene_id: scanId,
    location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]),
    candidate_count: 2,
  }), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ticket_state, "partial", "零证据成功 → partial(B 现行为)");
  assert.equal(res.scan.confirmed_count, 0, "零确认也落 scan");
  const scans = await rawDocs(db, "location_scans");
  assert.equal(scans.length, 1);
  assert.equal(scans[0].confirmed_count, 0);
  assert.deepEqual(scans[0].confirmed_item_ids, []);

  // 用户放弃 → 取消:scan 存在即视为有引用,不删云文件,bound 态保留(§2.4/§2.5)
  const cancel = await handler({ action: "videoUploadCancel", upload_ticket: ticket.begin.upload_ticket }, deps);
  assert.equal(cancel.ok, true, JSON.stringify(cancel));
  assert.equal(cancel.state, "bound");
  assert.equal(cancel.scan_retained, true);
  assert.deepEqual(deps.cloudDeleted, [], "scan 的回看视频绝不因取消被删");
  const ticketDoc = (await db.collection("video_upload_tickets").doc(ticket.begin.upload_ticket).get()).data;
  assert.equal(ticketDoc.status, "bound");
});

test("D1-SHARE:多件共享 file/asset 各持独立 highlights 与 scan_id;scan 行唯一", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const scanId = "scan-share-01";
  const ticket = await sceneTicket(deps, scanId);
  const res = await handler(commitEvent(ticket, [
    newItem("d0", "op-d1-share-0", "同款螺丝刀", [hl(0, 500, null, 0)], undefined, "书房 / 书柜 / 第一层"),
    newItem("d1", "op-d1-share-1", "同款螺丝刀", [hl(600, 1100, box(), 600)], undefined, "书房 / 书柜 / 第一层"),
    newItem("d2", "op-d1-share-2", "同款螺丝刀", [hl(1200, 1700, null, 1200)], undefined, "书房 / 书柜 / 第一层"),
  ], {
    scene_id: scanId,
    location: locationBlock(scanId, "lc_layer", ["书房", "书柜", "第一层"]),
    candidate_count: 6,
  }), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.scan.confirmed_count, 3);
  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 3);
  const fileIds = new Set(evidence.map((r) => r.file_id));
  const assetIds = new Set(evidence.map((r) => r.asset_id));
  assert.equal(fileIds.size, 1, "一次保存的正确物品共享 file_id");
  assert.equal(assetIds.size, 1, "一次保存的正确物品共享 asset_id");
  for (const row of evidence) {
    assert.equal(row.scan_id, scanId);
    assert.equal(row.highlight_version, 1);
    assert.equal(row.highlights.length, 1, "每个物品有自己的确认高亮");
  }
  assert.notDeepEqual(evidence[0].highlights, evidence[1].highlights);
  assert.equal((await rawDocs(db, "location_scans")).length, 1, "scan 行唯一");
});

test("D1-SHAPE:位置参数形状非法 → INVALID_INPUT 整批零写", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const scanId = "scan-shape-01";
  const ticket = await sceneTicket(deps, scanId);
  const items = [newItem("d-shape", "op-shape", "尺子", [hl(0, 1000, null, 0)])];
  const cases = [
    { location: { location_id: "lc_shelf", scan_id: "different-scene-id", path_snapshot: ["书房", "书柜"], text_snapshot: "书房 / 书柜" } },
    { location: { location_id: "lc_shelf", scan_id: scanId, path_snapshot: ["书房", "书柜"], text_snapshot: "书房/书柜" } },
    { location: { location_id: "lc_shelf", scan_id: scanId, path_snapshot: [], text_snapshot: "" } },
    { location: { location_id: "lc_shelf", scan_id: scanId, path_snapshot: ["书房", "书柜", "第一层", "第二层", "第三层", "第四层", "第五层"], text_snapshot: "书房 / 书柜 / 第一层 / 第二层 / 第三层 / 第四层 / 第五层" } },
    { location: { location_id: "lc_shelf", scan_id: scanId, path_snapshot: ["书房", "  "], text_snapshot: "书房 /  " } },
    { location: "not-an-object" },
    { candidate_count: 501, location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]) },
    { candidate_count: -1, location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]) },
    { candidate_count: 3 },
  ];
  // 带合法 location,但 items 里的 D1 字段组合非法
  const validExtra = { location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]) };
  const badFieldCases = [
    { items: [{ draft_key: "d-x", target: "existing", item_id: "it_shape", node_id: "lc_layer", highlights: [hl(0, 500, null, 0)] }], extra: validExtra },
    { items: [{ draft_key: "d-x", target: "existing", item_id: "it_shape", move_to_node_id: "lc_shelf", highlights: [hl(0, 500, null, 0)] }], extra: validExtra },
    { items: [{ draft_key: "d-x", target: "existing", item_id: "it_shape", expected_version: 1, highlights: [hl(0, 500, null, 0)] }], extra: validExtra },
    { items: [{ draft_key: "d-x", target: "existing", item_id: "it_shape", move_to_node_id: "lc_shelf", expected_version: 0, highlights: [hl(0, 500, null, 0)] }], extra: validExtra },
    { items: [Object.assign(newItem("d-x", "op-shape-new", "尺子", [hl(0, 500, null, 0)]), { move_to_node_id: "lc_shelf", expected_version: 1 })], extra: validExtra },
  ];
  for (const c of cases) {
    const ev = commitEvent(ticket, items, Object.assign({ scene_id: scanId }, c));
    const res = await handler(ev, deps);
    assert.equal(res.ok, false, "形状非法必须拒绝: " + JSON.stringify(c));
    assert.equal(res.error, "INVALID_INPUT");
  }
  for (const c of badFieldCases) {
    const ev = commitEvent(ticket, c.items, Object.assign({ scene_id: scanId }, c.extra));
    const res = await handler(ev, deps);
    assert.equal(res.ok, false, "字段组合非法必须拒绝");
    assert.equal(res.error, "INVALID_INPUT");
  }
  assert.equal((await rawDocs(db, "items")).length, 0, "零写");
  assert.equal((await rawDocs(db, "video_evidence")).length, 0, "零写");
  assert.equal((await rawDocs(db, "location_scans")).length, 0, "零写");
});

test("D1-SCAN-REUSE:scan_id 复用到另一段视频 → OPERATION_CONFLICT 硬门", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const scanId = "scan-reuse-01";
  const first = await sceneTicket(deps, scanId);
  const res1 = await handler(commitEvent(first, [
    newItem("d-1", "op-reuse-1", "扳手", [hl(0, 1000, null, 0)]),
  ], {
    scene_id: scanId,
    location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]),
  }), deps);
  assert.equal(res1.ok, true, JSON.stringify(res1));

  const second = await sceneTicket(deps, scanId); // 同 scan_id 当 scene_id 再开一段视频
  const res2 = await handler(commitEvent(second, [
    newItem("d-2", "op-reuse-2", "钳子", [hl(0, 1000, null, 0)]),
  ], {
    scene_id: scanId,
    location: locationBlock(scanId, "lc_shelf", ["书房", "书柜"]),
  }), deps);
  assert.equal(res2.ok, false);
  assert.equal(res2.error, "OPERATION_CONFLICT", "scan_id 被复用到另一段视频,客户端 bug 硬门");
  const scans = await rawDocs(db, "location_scans");
  assert.equal(scans.length, 1, "scan 行仍只有第一条视频的");
  assert.equal(scans[0].file_id, first.fileId);
});
