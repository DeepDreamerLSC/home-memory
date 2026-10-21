"use strict";
// D1 读侧合同(issue #94,D1-IMPLEMENTATION.md §2.3/§3):
// locationScanLatest(位置页「上次清点」):无记录 scan:null、字段投影、
// 已删物品差额(items 只列存活而 confirmed_count 保持原始数)、换链失败
// video_url:"" 不废查询、跨家庭隔离、非 active 行不返回、入参形状门。
// locationScanContext(确认页匹配池):子树投影含自身且不含子树外、
// subtree_items 只含子树内挂载、household_items 全量倒序截断 200 + truncated、
// 跨家庭 NOT_FOUND、home 根 INVALID_INPUT。
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH_A = "hh_11111111111111111111111111111111";
const HH_B = "hh_22222222222222222222222222222222";
const DURATION = 12000;

let GLOBAL_SEQ = 1000;

function makeDeps(db, opts) {
  opts = opts || {};
  let clock = 1760000000000;
  const state = { failTempUrl: opts.failTempUrl === true };
  return {
    db,
    state,
    householdId: opts.householdId || HH_A,
    householdShared: false,
    scopeRevision: null,
    now: () => new Date(clock).toISOString(),
    advance: (ms) => { clock += ms; },
    genId: () => { GLOBAL_SEQ += 1; return "n" + String(GLOBAL_SEQ).padStart(12, "0"); },
    getTempFileUrls: async (ids) => {
      if (state.failTempUrl === true) throw new Error("temp url down");
      return {
        fileList: ids.map((fileID) => ({ fileID, tempFileURL: "https://tmp.example/" + encodeURIComponent(fileID) })),
      };
    },
    deleteCloudFiles: async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID, status: 0, errMsg: "ok" })),
    }),
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
      data: Object.assign({ household_id: householdId, name_norm: n.name }, n),
    });
  }
  return nodes;
}

async function seedItem(db, householdId, id, extra) {
  const doc = Object.assign({
    _id: id,
    household_id: householdId,
    name: "物品" + id,
    name_norm: "物品" + id,
    location_text: "书房 / 书柜",
    note: "",
    version: 1,
    deleted: false,
    operation_id: "op-" + id,
    created_at: "2026-10-19T00:00:00.000Z",
    updated_at: "2026-10-19T00:00:00.000Z",
  }, extra || {});
  await db.collection("items").add({ data: doc });
  return doc;
}

async function seedScan(db, householdId, scanId, locationId, extra) {
  const doc = Object.assign({
    _id: "ls_" + scanId,
    household_id: householdId,
    scan_id: scanId,
    location_id: locationId,
    location_path_snapshot: ["书房", "书柜"],
    location_text_snapshot: "书房 / 书柜",
    file_id: "cloud://bucket/v.mp4",
    asset_id: "va_" + scanId,
    upload_ticket: "vt_" + scanId,
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
    candidate_count: 6,
    confirmed_count: 4,
    confirmed_item_ids: [],
    created_at: "2026-10-18T09:30:00.000Z",
    updated_at: "2026-10-18T09:31:00.000Z",
    status: "active",
  }, extra || {});
  await db.collection("location_scans").add({ data: doc });
  return doc;
}

test("LATEST-EMPTY:无记录 → scan:null 且 ok", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const res = await handler({ action: "locationScanLatest", location_id: "lc_shelf" }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.scan, null);
  assert.equal(res.video_url, "");
  assert.deepEqual(res.items, []);
});

test("LATEST-PROJECTION:最新 active scan 投影 + 存活清单 + 换链", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  await seedItem(db, HH_A, "it_alive", { location_node_id: "lc_layer" });
  await seedItem(db, HH_A, "it_gone", { deleted: true });
  // 两行 scan:created_at 更新的才是「上次清点」
  await seedScan(db, HH_A, "scan-old", "lc_shelf", { created_at: "2026-10-15T08:00:00.000Z" });
  await seedScan(db, HH_A, "scan-new", "lc_shelf", {
    confirmed_item_ids: ["it_alive", "it_gone", "it_alive"],
  });
  const res = await handler({ action: "locationScanLatest", location_id: "lc_shelf" }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.scan.scan_id, "scan-new");
  assert.equal(res.scan.location_id, "lc_shelf");
  assert.equal(res.scan.created_at, "2026-10-18T09:30:00.000Z");
  assert.equal(res.scan.candidate_count, 6);
  assert.equal(res.scan.confirmed_count, 3, "原始确认数按 confirmed_item_ids 长度(含重复防御)");
  assert.equal(res.scan.duration_ms, DURATION);
  assert.equal(res.video_url.indexOf("https://tmp.example/") === 0, true);
  // 已删物品不进清单,但 confirmed_count 保持原始数 → 客户端显示「1 件已删」
  assert.deepEqual(res.items.map((r) => r.item_id), ["it_alive"]);
  assert.equal(res.items[0].name, "物品it_alive");
});

test("LATEST-URL-FAIL:换链失败 video_url:\"\" 不废查询", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db, { failTempUrl: true });
  await seedScan(db, HH_A, "scan-url", "lc_shelf");
  const res = await handler({ action: "locationScanLatest", location_id: "lc_shelf" }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.scan.scan_id, "scan-url");
  assert.equal(res.video_url, "");
});

test("LATEST-STATUS:非 active 行不返回(位置删除后摘要消失)", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  await seedScan(db, HH_A, "scan-marked", "lc_shelf", {
    status: "location_deleted",
    location_deleted_at: "2026-10-19T00:00:00.000Z",
  });
  const res = await handler({ action: "locationScanLatest", location_id: "lc_shelf" }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.scan, null);
});

test("LATEST-CROSS-HH:他家庭 location_id 查不到自家 scan(隔离)", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const depsA = makeDeps(db);
  const depsB = makeDeps(db, { householdId: HH_B });
  await seedScan(db, HH_A, "scan-a", "lc_shelf");
  const res = await handler({ action: "locationScanLatest", location_id: "lc_shelf" }, depsB);
  assert.equal(res.ok, true);
  assert.equal(res.scan, null, "B 家庭读不到 A 家庭的 scan 行");
  const resA = await handler({ action: "locationScanLatest", location_id: "lc_shelf" }, depsA);
  assert.equal(resA.scan.scan_id, "scan-a");
});

test("LATEST-SHAPE:入参形状门(缺/超长 location_id → INVALID_INPUT)", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  assert.equal((await handler({ action: "locationScanLatest" }, deps)).error, "INVALID_INPUT");
  assert.equal((await handler({ action: "locationScanLatest", location_id: "" }, deps)).error, "INVALID_INPUT");
  assert.equal(
    (await handler({ action: "locationScanLatest", location_id: "x".repeat(129) }, deps)).error,
    "INVALID_INPUT",
  );
});

test("CONTEXT-SUBTREE:子树投影含自身、不含子树外;只读零写", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const before = (await db.collection("locations").where({}).get()).data.length;
  const res = await handler({ action: "locationScanContext", location_id: "lc_shelf" }, deps);
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.subtree.map((n) => n.location_id),
    ["lc_shelf", "lc_layer"],
    "含自身且不含子树外(书房本层/厨房/根都不在)",
  );
  assert.deepEqual(res.subtree[0].path, ["书房", "书柜"]);
  assert.deepEqual(res.subtree[0].parent_id, "lc_study");
  assert.equal(res.subtree_items.length, 0);
  assert.deepEqual(res.household_items, []);
  assert.equal(res.household_truncated, false);
  const after = (await db.collection("locations").where({}).get()).data.length;
  assert.equal(after, before, "只读 action 零写入");
});

test("CONTEXT-POOLS:subtree_items 只含子树内挂载;全家庭池含未挂载", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  await seedItem(db, HH_A, "it_in_layer", { location_node_id: "lc_layer", updated_at: "2026-10-19T03:00:00.000Z" });
  await seedItem(db, HH_A, "it_in_shelf", { location_node_id: "lc_shelf", updated_at: "2026-10-19T02:00:00.000Z" });
  await seedItem(db, HH_A, "it_in_kitchen", { location_node_id: "lc_kitchen", updated_at: "2026-10-19T05:00:00.000Z" });
  await seedItem(db, HH_A, "it_unmounted", { location_node_id: "", updated_at: "2026-10-19T04:00:00.000Z" });
  await seedItem(db, HH_A, "it_deleted", { deleted: true, location_node_id: "lc_layer" });
  const res = await handler({ action: "locationScanContext", location_id: "lc_shelf" }, deps);
  assert.deepEqual(
    res.subtree_items.map((r) => r.item_id).sort(),
    ["it_in_layer", "it_in_shelf"],
    "子树池:挂在书柜本层与第一层的两件;厨房/未挂载/已删不在",
  );
  const shelfRow = res.subtree_items.find((r) => r.item_id === "it_in_shelf");
  assert.equal(shelfRow.version, 1);
  assert.equal(shelfRow.location_node_id, "lc_shelf");
  // 全家庭池按 updated_at 倒序,未删全量
  assert.deepEqual(
    res.household_items.map((r) => r.item_id),
    ["it_in_kitchen", "it_unmounted", "it_in_layer", "it_in_shelf"],
  );
  assert.equal(res.household_truncated, false);
});

test("CONTEXT-TRUNCATED:全家庭超 200 截断 + truncated 标志", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  for (let i = 0; i < 205; i++) {
    await seedItem(db, HH_A, "it_bulk_" + i, {
      location_node_id: i < 3 ? "lc_layer" : "lc_kitchen",
      updated_at: new Date(1760000000000 + i * 1000).toISOString(),
    });
  }
  const res = await handler({ action: "locationScanContext", location_id: "lc_shelf" }, deps);
  assert.equal(res.household_items.length, 200);
  assert.equal(res.household_truncated, true);
  assert.equal(res.household_items[0].item_id, "it_bulk_204", "updated_at 倒序,最新在前");
  assert.equal(res.subtree_items.length, 3, "子树池不受全家庭截断影响");
});

test("CONTEXT-CROSS-HH:他家庭 location_id → NOT_FOUND", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const depsB = makeDeps(db, { householdId: HH_B });
  const res = await handler({ action: "locationScanContext", location_id: "lc_shelf" }, depsB);
  assert.equal(res.ok, false);
  assert.equal(res.error, "NOT_FOUND");
});

test("CONTEXT-ROOT-GUARD:home 根 INVALID_INPUT(清点入口只在非根层)", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const res = await handler({ action: "locationScanContext", location_id: "lc_root" }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "INVALID_INPUT");
  assert.equal((await handler({ action: "locationScanContext", location_id: "lc_missing" }, deps)).error, "NOT_FOUND");
  assert.equal((await handler({ action: "locationScanContext" }, deps)).error, "INVALID_INPUT");
});

test("CONTEXT-INTEGRATION:commit 落的 scan 能被 latest 读回(读侧与写侧同一集合)", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeDeps(db);
  const scanId = "scan-read-integ-01";
  const begin = await handler({
    action: "videoUploadBegin",
    purpose: "scene",
    scene_id: scanId,
    ext: "mp4",
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
  }, deps);
  const fileId = "cloud://bucket/" + begin.upload_path;
  await handler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId }, deps);
  const commit = await handler({
    action: "videoSceneCommit",
    scene_id: scanId,
    upload_ticket: begin.upload_ticket,
    asset_id: begin.asset_id,
    file_id: fileId,
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
    consent_version: "v1",
    items: [{
      draft_key: "d1",
      target: "new",
      operation_id: "op-read-integ",
      name: "读侧联动件",
      location_text: "书房 / 书柜",
      highlights: [{ start_ms: 0, end_ms: 1200, box: null }],
    }],
    location: {
      location_id: "lc_shelf",
      scan_id: scanId,
      path_snapshot: ["书房", "书柜"],
      text_snapshot: "书房 / 书柜",
    },
    candidate_count: 2,
  }, deps);
  assert.equal(commit.ok, true, JSON.stringify(commit));
  const latest = await handler({ action: "locationScanLatest", location_id: "lc_shelf" }, deps);
  assert.equal(latest.scan.scan_id, scanId);
  assert.equal(latest.scan.candidate_count, 2);
  assert.equal(latest.scan.confirmed_count, 1);
  assert.equal(latest.items.length, 1);
  assert.equal(latest.items[0].name, "读侧联动件");
  assert.equal(latest.video_url !== "", true);
  // context 同一眼看到新物品挂载
  const ctx = await handler({ action: "locationScanContext", location_id: "lc_shelf" }, deps);
  assert.deepEqual(ctx.subtree_items.map((r) => r.name), ["读侧联动件"]);
});
