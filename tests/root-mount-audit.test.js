"use strict";
// PR A(#116,D0-CONTRACT v2 §2/§4):根节点禁挂物品的收口审计(W1-W6 + ensureAndLink)。
// 每条路径「物品挂根 → 拒绝」各一反例:
//   W1 D1 位置清点(videoSceneCommit 带 location 上下文,itemsApi)
//   W2 deleteLocation migrate(locations;根拒绝 + 顶层房间迁移目标为根的拒绝)
//   W3 ensureAndLink(空路径/纯空白拒绝;路径至少一段 → 目标天然非根)
//   W4 linkItem(locations)
//   W5 merge(locations)
//   W6 B 页新增路径(videoSceneCommit 无 location,node_id 直指根)
// 全部为只读既有 handler 行为的钉住测试:locations 包零改动是本 PR 冻结红线,
// 此文件不修改任何被测代码,只冻结现状语义。
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const locHandler = require("../cloudfunctions/locations/lib/handler").handler;
const itemsHandler = require("../cloudfunctions/itemsApi/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH_A = "hh_11111111111111111111111111111111";
const DURATION = 12000;

let GLOBAL_SEQ = 0;

function makeLocDeps(db, householdId) {
  let clock = 1760000000000;
  return {
    db,
    householdId: householdId || HH_A,
    now: () => { clock += 1000; return new Date(clock).toISOString(); },
    genId: () => { GLOBAL_SEQ += 1; return "n" + String(GLOBAL_SEQ).padStart(12, "0"); },
    digest: (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex").slice(0, 16),
    logger: { log: () => {} },
  };
}

function makeItemsDeps(db, householdId) {
  let clock = 1760000000000;
  return {
    db,
    householdId: householdId || HH_A,
    householdShared: false,
    scopeRevision: null,
    now: () => new Date(clock).toISOString(),
    genId: () => { GLOBAL_SEQ += 1; return "n" + String(GLOBAL_SEQ).padStart(12, "0"); },
    getTempFileUrls: async (ids) => ({ fileList: ids.map((f) => ({ fileID: f, tempFileURL: "https://tmp.example/" + f })) }),
    deleteCloudFiles: async (ids) => ({ fileList: ids.map((f) => ({ fileID: f, status: 0, errMsg: "ok" })) }),
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

/** 建两层树:客厅(顶层房间)/ 沙发(客厅下),返回含 home 根的节点表 */
async function seedTree(db, householdId) {
  const nodes = [
    { _id: "ra_root", parent_id: "", name: "我的家", path: [] },
    { _id: "ra_living", parent_id: "ra_root", name: "客厅", path: ["客厅"] },
    { _id: "ra_sofa", parent_id: "ra_living", name: "沙发", path: ["客厅", "沙发"] },
  ];
  for (const n of nodes) {
    await db.collection("locations").add({ data: Object.assign({ household_id: householdId, name_norm: n.name }, n) });
  }
  return nodes;
}

async function createItem(deps, opId, name, locationText) {
  const res = await itemsHandler(
    { action: "create", operation_id: opId, name, location_text: locationText, note: "" },
    deps,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
}

// ---------------------------------------------------------------------------
// W1:D1 位置清点(videoSceneCommit 带 location)物品挂根 → 拒绝
// ---------------------------------------------------------------------------

test("W1-ROOT-D1:D1 提交件选 home 根 → INVALID_INPUT 零写", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeItemsDeps(db);
  const sceneId = "scene-w1-root-01";
  const begin = await itemsHandler({
    action: "videoUploadBegin", purpose: "scene", scene_id: sceneId, ext: "mp4",
    duration_ms: DURATION, video_w: 1280, video_h: 720,
  }, deps);
  assert.equal(begin.ok, true);
  const fileId = "cloud://bucket/" + begin.upload_path;
  await itemsHandler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId }, deps);
  const location = { location_id: "ra_sofa", scan_id: sceneId, path_snapshot: ["客厅", "沙发"], text_snapshot: "客厅 / 沙发" };
  const ev = {
    action: "videoSceneCommit", scene_id: sceneId, upload_ticket: begin.upload_ticket,
    asset_id: begin.asset_id, file_id: fileId, duration_ms: DURATION, video_w: 1280, video_h: 720,
    consent_version: "v1", location,
    items: [{
      draft_key: "d-root", target: "new", operation_id: "op-w1-root", name: "闹钟",
      location_text: "我的家", node_id: "ra_root",
      highlights: [{ start_ms: 0, end_ms: 1000, box: null, frame_ms: 0 }],
    }],
  };
  const res = await itemsHandler(ev, deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "INVALID_INPUT", "根不在任何清点子树内 → out_of_subtree 同门拒绝");
  assert.deepEqual(res.detail.out_of_subtree, ["d-root"]);
  assert.equal((await rawDocs(db, "items")).length, 0, "零写");
  assert.equal((await rawDocs(db, "video_evidence")).length, 0, "零写");
});

// ---------------------------------------------------------------------------
// W2:deleteLocation migrate(根拒绝;顶层房间迁移目标为根的拒绝)
// ---------------------------------------------------------------------------

test("W2-ROOT-MIGRATE:deleteLocation migrate 根/顶层房间 → INVALID_INPUT,物品绝不落根", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeLocDeps(db);

  // home 根两模式一律拒绝
  for (const mode of ["migrate", "purge"]) {
    const rootRes = await locHandler({ action: "deleteLocation", node_id: "ra_root", mode }, deps);
    assert.equal(rootRes.ok, false, "home 根不可删(" + mode + ")");
    assert.equal(rootRes.error, "INVALID_INPUT");
  }

  // 顶层房间(父为 home 根)migrate → 迁移目标是根 → 拒绝
  const created = await createItem(makeItemsDeps(db), "op-w2-item", "抱枕", "客厅");
  const linked = await locHandler({
    action: "linkItem", item_id: created.item.item_id, node_id: "ra_living",
    expected_version: 1, update_id: "w2-link-1",
  }, deps);
  assert.equal(linked.ok, true, JSON.stringify(linked));

  const preview = await locHandler({ action: "deletePreview", node_id: "ra_living" }, deps);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.migrate_available, false, "顶层房间迁移目标为根 → 不可迁移");

  const migrateRes = await locHandler({ action: "deleteLocation", node_id: "ra_living", mode: "migrate" }, deps);
  assert.equal(migrateRes.ok, false);
  assert.equal(migrateRes.error, "INVALID_INPUT");
  const items = await rawDocs(db, "items");
  assert.equal(items[0].location_node_id, "ra_living", "拒绝后物品原样挂客厅,绝不落根");
  assert.equal((await rawDocs(db, "locations")).length, 3, "节点零删除");
});

// ---------------------------------------------------------------------------
// W3:ensureAndLink 空路径/纯空白拒绝;路径至少一段 → 目标天然非根
// ---------------------------------------------------------------------------

test("W3-ROOT-ENSUREANDLINK:空路径/纯空白段 → INVALID_INPUT 零写;合法路径挂末段非根", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeLocDeps(db);
  const itemsDeps = makeItemsDeps(db);
  const created = await createItem(itemsDeps, "op-w3-item", "遥控器", "客厅");
  const rootBefore = (await rawDocs(db, "locations")).find((n) => n.parent_id === "");

  // 空路径与纯空白段(仅空白无有效段)→ INVALID_INPUT,零写入
  for (const badPath of [[], ["   "], ["客厅", "  \t "]]) {
    const res = await locHandler({
      action: "ensureAndLink", item_id: created.item.item_id,
      path: badPath, expected_version: 1, update_id: "w3-bad-" + JSON.stringify(badPath).length,
    }, deps);
    assert.equal(res.ok, false, "空路径/纯空白必须拒绝: " + JSON.stringify(badPath));
    assert.equal(res.error, "INVALID_INPUT");
  }
  assert.equal((await rawDocs(db, "locations")).length, 3, "零写入:一个节点都不建");

  // 合法路径(≥1 段):目标 = 末段节点,天然非根(路径至少一段 ⇒ 挂载永不落 home 根)
  const ok = await locHandler({
    action: "ensureAndLink", item_id: created.item.item_id,
    path: ["客厅", "沙发"], expected_version: 1, update_id: "w3-ok-1",
  }, deps);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const items = await rawDocs(db, "items");
  assert.equal(items[0].location_node_id, ok.location_ids[1]);
  assert.notEqual(items[0].location_node_id, rootBefore._id, "挂载目标天然非 home 根");
  const target = (await rawDocs(db, "locations")).find((n) => n._id === items[0].location_node_id);
  assert.deepEqual(target.path, ["客厅", "沙发"]);
});

// ---------------------------------------------------------------------------
// W4:linkItem 物品挂根 → 拒绝
// ---------------------------------------------------------------------------

test("W4-ROOT-LINKITEM:linkItem node_id=home 根 → INVALID_INPUT", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeLocDeps(db);
  const created = await createItem(makeItemsDeps(db), "op-w4-item", "钥匙", "客厅");
  const res = await locHandler({
    action: "linkItem", item_id: created.item.item_id, node_id: "ra_root",
    expected_version: 1, update_id: "w4-root-1",
  }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "INVALID_INPUT");
  const items = await rawDocs(db, "items");
  assert.equal(items[0].location_node_id, undefined, "拒绝后零挂载写");
});

// ---------------------------------------------------------------------------
// W5:merge 物品重挂目标(或来源)为根 → 拒绝
// ---------------------------------------------------------------------------

test("W5-ROOT-MERGE:merge source/target=home 根 → INVALID_INPUT", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeLocDeps(db);
  const created = await createItem(makeItemsDeps(db), "op-w5-item", "杂志", "客厅 / 沙发");
  await locHandler({
    action: "linkItem", item_id: created.item.item_id, node_id: "ra_sofa",
    expected_version: 1, update_id: "w5-link-1",
  }, deps);
  for (const ev of [
    { action: "merge", source_node_id: "ra_root", target_node_id: "ra_sofa" },
    { action: "merge", source_node_id: "ra_sofa", target_node_id: "ra_root" },
  ]) {
    const res = await locHandler(ev, deps);
    assert.equal(res.ok, false, "merge 任一端为根必须拒绝: " + JSON.stringify(ev));
    assert.equal(res.error, "INVALID_INPUT");
  }
  const items = await rawDocs(db, "items");
  assert.equal(items[0].location_node_id, "ra_sofa", "拒绝后物品原样");
  assert.equal((await rawDocs(db, "locations")).length, 3, "树零变更");
});

// ---------------------------------------------------------------------------
// W6:B 页新增路径(videoSceneCommit 无 location,node_id 直指根)→ 拒绝
// ---------------------------------------------------------------------------

test("W6-ROOT-BPAGE:B 页提交 node_id=home 根 → INVALID_INPUT 整批零写", async () => {
  const db = freshDb();
  await seedTree(db, HH_A);
  const deps = makeItemsDeps(db);
  const sceneId = "scene-w6-root-01";
  const begin = await itemsHandler({
    action: "videoUploadBegin", purpose: "scene", scene_id: sceneId, ext: "mp4",
    duration_ms: DURATION, video_w: 1280, video_h: 720,
  }, deps);
  assert.equal(begin.ok, true);
  const fileId = "cloud://bucket/" + begin.upload_path;
  await itemsHandler({ action: "videoUploadReceipt", upload_ticket: begin.upload_ticket, file_id: fileId }, deps);
  const res = await itemsHandler({
    action: "videoSceneCommit", scene_id: sceneId, upload_ticket: begin.upload_ticket,
    asset_id: begin.asset_id, file_id: fileId, duration_ms: DURATION, video_w: 1280, video_h: 720,
    consent_version: "v1",
    items: [{
      draft_key: "d-root", target: "new", operation_id: "op-w6-root", name: "闹钟",
      location_text: "我的家", node_id: "ra_root",
      highlights: [{ start_ms: 0, end_ms: 1000, box: null, frame_ms: 0 }],
    }],
  }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "INVALID_INPUT", "B 页出生即走统一 isHomeRoot 判定");
  assert.equal((await rawDocs(db, "items")).length, 0, "零写");
  assert.equal((await rawDocs(db, "video_evidence")).length, 0, "零写");
  assert.equal((await rawDocs(db, "location_scans")).length, 0, "零写");
});
