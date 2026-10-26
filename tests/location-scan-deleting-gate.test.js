"use strict";
// PR-B(issue #116,D0-CONTRACT.md v4 §3.1 入口清单 itemsApi 半边):
// D1 videoSceneCommit 挂载(node_id 与 move_to_node_id,经 resolveLocationContext)
// 上溯祖先链 deleting 校验——目标自身无标记、祖先在删(终审 P0-1 场景)也拒绝;
// 整批零写;子树外照常;B 页(无 location 上下文)在 main 无挂载代码,随 PR-A 合并后补。
var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("node:crypto");
var handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

var HH_A = "hh_11111111111111111111111111111111";
var DURATION = 12000;
let GLOBAL_SEQ = 1000;

function makeDeps(db, opts) {
  opts = opts || {};
  let clock = 1760000000000;
  return {
    db,
    householdId: opts.householdId || HH_A,
    householdShared: false,
    scopeRevision: null,
    now: () => new Date(clock).toISOString(),
    genId: () => { GLOBAL_SEQ += 1; return "n" + String(GLOBAL_SEQ).padStart(12, "0"); },
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

/** 树:书房(带 deleting 检查点,unmount 中断态)/书柜/第一层 + 厨房 */
async function seedTree(db, householdId) {
  const nodes = [
    { _id: "lc_root", parent_id: "", name: "我的家", path: [] },
    { _id: "lc_study", parent_id: "lc_root", name: "书房", path: ["书房"] },
    { _id: "lc_shelf", parent_id: "lc_study", name: "书柜", path: ["书房", "书柜"] },
    { _id: "lc_layer", parent_id: "lc_shelf", name: "第一层", path: ["书房", "书柜", "第一层"] },
    { _id: "lc_kitchen", parent_id: "lc_root", name: "厨房", path: ["厨房"] },
  ];
  for (const n of nodes) {
    await db.collection("locations").add({
      data: Object.assign({ household_id: householdId, name_norm: n.name, updated_at: "2026-10-18T00:00:00.000Z" }, n)
    });
  }
  return nodes;
}

async function markDeleting(db, nodeId, subtreeIds) {
  await db.collection("locations").doc(nodeId).update({
    data: {
      deleting: {
        op_id: "unmount:" + crypto.createHash("sha256").update(nodeId, "utf8").digest("hex").slice(0, 16),
        node_id: nodeId,
        subtree_node_ids: subtreeIds,
        phase: "nodes",
        counts: { unmounted: 0, compensated: 0, conflicts: 0 },
        created_at: "2026-10-21T00:00:00.000Z",
        status: "pending",
      },
      updated_at: "2026-10-21T00:00:01.000Z",
    },
  });
}

function box() { return { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.7 }; }
function hl(start, end) { return { start_ms: start, end_ms: end, box: null }; }

async function sceneTicket(deps, sceneId) {
  const begin = await handler({
    action: "videoUploadBegin", purpose: "scene", scene_id: sceneId,
    ext: "mp4", duration_ms: DURATION, video_w: 1280, video_h: 720,
  }, deps);
  assert.equal(begin.ok, true, JSON.stringify(begin));
  const fileId = "cloud://bucket/" + begin.upload_path;
  const receipt = await handler({
    action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId,
  }, deps);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  return { begin, fileId, sceneId };
}

function commitEvent(ticket, items, extra) {
  return Object.assign({
    action: "videoSceneCommit",
    // videoUploadBegin 响应不回传 scene_id,提交必须用发起时的 scanId(与引用基线一致)
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

function locationBlock(scanId, nodeId, pathSegments) {
  return {
    location_id: nodeId,
    scan_id: scanId,
    path_snapshot: pathSegments,
    text_snapshot: pathSegments.join(" / "),
  };
}

test("D1-DELETING-GATE-NODE:书房在删、目标=第二层抽屉(自身无标记)→ INVALID_INPUT({reason:deleting}),整批零写", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  await markDeleting(db, "lc_study", ["lc_study", "lc_shelf", "lc_layer"]);
  const deps = makeDeps(db);
  const ticket = await sceneTicket(deps, "scan-d1-gate-node");
  const ev = commitEvent(ticket, [
    {
      draft_key: "d-gate", target: "new", operation_id: "op-d1-gate",
      name: "螺丝刀", location_text: "书房 / 书柜 / 第一层", node_id: "lc_layer",
      highlights: [hl(0, 1200)],
    },
  ], {
    location: locationBlock("scan-d1-gate-node", "lc_shelf", ["书房", "书柜"]),
    candidate_count: 3,
  });
  const res = await handler(ev, deps);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "INVALID_INPUT");
  assert.deepEqual(res.detail, { reason: "deleting" }, "拒绝语义与 locations 侧同码同义");
  assert.equal((await rawDocs(db, "items")).length, 0, "零物品写入");
  assert.equal((await rawDocs(db, "video_evidence")).length, 0, "零证据写入");
  assert.equal((await rawDocs(db, "location_scans")).length, 0, "零 scan 写入");
});

test("D1-DELETING-GATE-DEFAULT-TARGET:无 node_id 时默认挂 location 根——location 根在删 → 拒绝", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  await markDeleting(db, "lc_shelf", ["lc_shelf", "lc_layer"]); // 清点位置=书柜,自身即 deleting 根
  const deps = makeDeps(db);
  const ticket = await sceneTicket(deps, "scan-d1-gate-default");
  const ev = commitEvent(ticket, [
    {
      draft_key: "d-gate2", target: "new", operation_id: "op-d1-gate-2",
      name: "螺丝刀", location_text: "书房 / 书柜",
      highlights: [hl(0, 1200)],
    },
  ], {
    location: locationBlock("scan-d1-gate-default", "lc_shelf", ["书房", "书柜"]),
    candidate_count: 3,
  });
  const res = await handler(ev, deps);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "INVALID_INPUT");
  assert.deepEqual(res.detail, { reason: "deleting" });
  assert.equal((await rawDocs(db, "items")).length, 0);
});

test("D1-DELETING-GATE-MOVE:existing 显式移动 move_to_node_id 指向 deleting 子树后代 → 拒绝", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  await markDeleting(db, "lc_study", ["lc_study", "lc_shelf", "lc_layer"]);
  const deps = makeDeps(db);
  await db.collection("items").add({ data: {
    _id: "it-move-1", household_id: HH_A, name: "扳手", name_norm: "扳手",
    location_text: "厨房", note: "", version: 1, deleted: false,
    operation_id: "op-seed-move-1", created_at: "2026-10-19T00:00:00.000Z",
    updated_at: "2026-10-19T00:00:00.000Z",
  } });
  const ticket = await sceneTicket(deps, "scan-d1-gate-move");
  const ev = commitEvent(ticket, [
    {
      draft_key: "d-move", target: "existing", item_id: "it-move-1",
      move_to_node_id: "lc_layer", expected_version: 1,
      highlights: [hl(0, 1000)],
    },
  ], {
    location: locationBlock("scan-d1-gate-move", "lc_shelf", ["书房", "书柜"]),
    candidate_count: 2,
  });
  const res = await handler(ev, deps);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "INVALID_INPUT");
  assert.deepEqual(res.detail, { reason: "deleting" });
  const item = (await rawDocs(db, "items")).find((d) => d._id === "it-move-1");
  assert.equal(item.location_node_id, undefined, "既有物品挂载零改动");
  assert.equal(item.version, 1);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0, "不写证据");
});

test("D1-DELETING-GATE-OUTSIDE-OK:厨房(冻结子树外)照常提交——门不误伤", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  await markDeleting(db, "lc_study", ["lc_study", "lc_shelf", "lc_layer"]);
  const deps = makeDeps(db);
  const ticket = await sceneTicket(deps, "scan-d1-gate-ok");
  const ev = commitEvent(ticket, [
    {
      draft_key: "d-ok", target: "new", operation_id: "op-d1-gate-ok",
      name: "汤勺", location_text: "厨房",
      highlights: [hl(0, 900)],
    },
  ], {
    location: locationBlock("scan-d1-gate-ok", "lc_kitchen", ["厨房"]),
    candidate_count: 1,
  });
  const res = await handler(ev, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const items = await rawDocs(db, "items");
  assert.equal(items.length, 1);
  assert.equal(items[0].location_node_id, "lc_kitchen");
});

test("D1-DELETING-GATE-CONTAINMENT:链断裂(父已删)的后代凭检查点清单仍拒——包含关系判定兜链上溯", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  // 模拟阶段二半途:书柜已删,第一层成孤儿(parent 链断),但检查点清单仍含第一层
  await db.collection("locations").doc("lc_shelf").remove();
  await markDeleting(db, "lc_study", ["lc_study", "lc_layer"]);
  const deps = makeDeps(db);
  const ticket = await sceneTicket(deps, "scan-d1-gate-orphan");
  const ev = commitEvent(ticket, [
    {
      draft_key: "d-orphan", target: "new", operation_id: "op-d1-gate-orphan",
      name: "螺丝刀", location_text: "书房 / 第一层", node_id: "lc_layer",
      highlights: [hl(0, 1200)],
    },
  ], {
    location: locationBlock("scan-d1-gate-orphan", "lc_study", ["书房"]),
    candidate_count: 3,
  });
  const res = await handler(ev, deps);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "INVALID_INPUT");
  assert.deepEqual(res.detail, { reason: "deleting" }, "链上溯断在已删父——清单包含关系兜住");
  assert.equal((await rawDocs(db, "items")).length, 0);
});
