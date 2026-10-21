"use strict";
// D1 全部删除(purge)端到端合同(#94 验收 14,docs/design/video-ai/D1-IMPLEMENTATION.md §5.2/§7):
// 客户端逐件 itemsApi.delete(级联在 itemsApi:末引用才删云文件、共享文件有其他
// 物品引用时保留),全部删完后 locations.deleteLocation(purge) 收口并标 scan
// deleted;单件删除失败中途放弃 → 续删收敛;scan 行保留审计。
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const itemsHandler = require("../cloudfunctions/itemsApi/lib/handler").handler;
const locHandler = require("../cloudfunctions/locations/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH_A = "hh_11111111111111111111111111111111";
const DURATION = 12000;

function digest16(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

let GLOBAL_SEQ = 0;

function makeDeps(db, opts) {
  opts = opts || {};
  let clock = 1760000000000;
  const cloudDeleted = [];
  const state = { failDelete: opts.failDelete === true };
  const base = {
    db,
    cloudDeleted,
    state,
    householdId: HH_A,
    householdShared: false,
    scopeRevision: null,
    now: () => new Date(clock).toISOString(),
    advance: (ms) => { clock += ms; },
    genId: () => { GLOBAL_SEQ += 1; return "n" + String(GLOBAL_SEQ).padStart(12, "0"); },
    digest: digest16,
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
  return base;
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

function hl(start, end) {
  return { start_ms: start, end_ms: end, box: null, frame_ms: start };
}

async function sceneTicket(deps, sceneId) {
  const begin = await itemsHandler({
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
  const receipt = await itemsHandler({
    action: "videoUploadReceipt",
    upload_ticket: begin.upload_ticket,
    file_id: fileId,
  }, deps);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  return { begin, fileId };
}

/** D1 提交:位置=书柜,件清单可混 new/existing(link-only) */
async function d1Commit(deps, scanId, items) {
  const ticket = await sceneTicket(deps, scanId);
  const res = await itemsHandler({
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
    candidate_count: items.length + 1,
    location: {
      location_id: "lc_shelf",
      scan_id: scanId,
      path_snapshot: ["书房", "书柜"],
      text_snapshot: "书房 / 书柜",
    },
  }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  return { ticket, res };
}

test("PURGE-E2E:共享文件有其他物品引用时保留,最后引用才删云文件;scan 标 deleted 留审计", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);

  // 书房外的既有物品 A(挂厨房,link-only 不移动):与书柜新物品 B 共享同一段视频
  const createdA = await itemsHandler({
    action: "create",
    operation_id: "op-purge-a",
    name: "备用灯泡",
    location_text: "厨房 抽屉",
  }, deps);
  assert.equal(createdA.ok, true, JSON.stringify(createdA));
  await db.collection("items").doc(createdA.item.item_id).update({
    data: { location_node_id: "lc_kitchen", version: 2 },
  });

  const scanId = "scan-purge-e2e-1";
  const { ticket, res } = await d1Commit(deps, scanId, [
    { draft_key: "d-a", target: "existing", item_id: createdA.item.item_id, highlights: [hl(0, 900)] },
    { draft_key: "d-b", target: "new", operation_id: "op-purge-b", name: "说明书", location_text: "书房 / 书柜", highlights: [hl(1000, 1900)] },
  ]);
  assert.equal(res.scan.confirmed_count, 2);
  const itemB = res.results.find((r) => r.draft_key === "d-b").item_id;
  assert.equal((await rawDocs(db, "video_evidence")).length, 2, "A、B 各一行,共享 file/asset");

  // purge 前置:逐件删除子树内物品(B);A 在子树外,不在 purge 清单
  const delB = await itemsHandler({ action: "delete", item_id: itemB }, deps);
  assert.equal(delB.ok, true, JSON.stringify(delB));
  assert.deepEqual(deps.cloudDeleted, [], "SHARE-CASCADE 模式:A 仍引用共享文件,云文件保留");
  let evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 1, "只删 B 的证据行");
  assert.equal(evidence[0].item_id, createdA.item.item_id);

  // 收口:deleteLocation(purge)
  const purge = await locHandler({ action: "deleteLocation", node_id: "lc_shelf", mode: "purge" }, deps);
  assert.equal(purge.ok, true, JSON.stringify(purge));
  assert.equal(purge.deleted_nodes, 1);
  assert.equal(purge.scans_marked, 1);
  const scans = await rawDocs(db, "location_scans");
  assert.equal(scans.length, 1, "scan 行保留审计");
  assert.equal(scans[0].status, "deleted");
  assert.ok(scans[0].deleted_at);
  assert.deepEqual(deps.cloudDeleted, [], "locations 函数绝不级联云文件/证据/物品");

  // A 随后被用户删除 → 末引用 → 云文件才删
  const delA = await itemsHandler({ action: "delete", item_id: createdA.item.item_id }, deps);
  assert.equal(delA.ok, true, JSON.stringify(delA));
  assert.deepEqual(deps.cloudDeleted, [ticket.fileId], "最后引用才删云文件");
  evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 0);
  const ticketDoc = (await db.collection("video_upload_tickets").doc(ticket.begin.upload_ticket).get()).data;
  assert.equal(ticketDoc.status, "deleted");
});

test("PURGE-RETRY:单件删除失败中途放弃 → 续删收敛后 purge 成功", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db, { failDelete: true });
  const scanId = "scan-purge-retry-1";
  const { res } = await d1Commit(deps, scanId, [
    { draft_key: "d-c", target: "new", operation_id: "op-purge-c", name: "旧充电线", location_text: "书房 / 书柜", highlights: [hl(0, 800)] },
    { draft_key: "d-d", target: "new", operation_id: "op-purge-d", name: "坏耳机", location_text: "书房 / 书柜", highlights: [hl(1000, 1800)] },
  ]);
  const itemC = res.results.find((r) => r.draft_key === "d-c").item_id;
  const itemD = res.results.find((r) => r.draft_key === "d-d").item_id;

  // 先删 D:共享文件仍有 C 引用 → 不触云删除,成功
  const delD = await itemsHandler({ action: "delete", item_id: itemD }, deps);
  assert.equal(delD.ok, true, JSON.stringify(delD));
  assert.deepEqual(deps.cloudDeleted, []);

  // 云删除故障:删 C(末引用)失败——物品保留、证据保留、可重试
  const failC = await itemsHandler({ action: "delete", item_id: itemC }, deps);
  assert.equal(failC.ok, false);
  assert.equal(failC.error, "VIDEO_DELETE_FAILED");
  assert.equal((await rawDocs(db, "video_evidence")).length, 1);
  const alive = await itemsHandler({ action: "get", item_id: itemC }, deps);
  assert.equal(alive.ok, true, "删除失败的物品原样保留");

  // 中途放弃 → purge 拒绝并给出剩余清单(收敛式)
  const refused = await locHandler({ action: "deleteLocation", node_id: "lc_shelf", mode: "purge" }, deps);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "NODE_NOT_EMPTY");
  assert.deepEqual(refused.detail.remaining_items.map((r) => r.item_id), [itemC]);

  // 修复后续删:重试删 C 成功(末引用 → 云文件删除)→ purge 收敛
  deps.state.failDelete = false;
  const delC = await itemsHandler({ action: "delete", item_id: itemC }, deps);
  assert.equal(delC.ok, true, JSON.stringify(delC));
  assert.equal((await rawDocs(db, "video_evidence")).length, 0, "证据行随物品级联删除");
  const ok = await locHandler({ action: "deleteLocation", node_id: "lc_shelf", mode: "purge" }, deps);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const scans = await rawDocs(db, "location_scans");
  assert.equal(scans.length, 1);
  assert.equal(scans[0].status, "deleted", "scan 标 deleted");
  assert.equal(scans[0].scan_id, scanId);
});

test("PURGE-PARTIAL-HEAL-SOURCE:purge 前一次提交部分失败,同票据重试补齐证据后删除级联完整", async () => {
  const db = freshDb();
  await seedTree(db);
  const deps = makeDeps(db);
  // 子树外物品 E(挂厨房):移动失败件的对照组
  const createdE = await itemsHandler({
    action: "create",
    operation_id: "op-purge-e",
    name: "工具箱",
    location_text: "厨房 地柜",
  }, deps);
  await db.collection("items").doc(createdE.item.item_id).update({
    data: { location_node_id: "lc_kitchen", version: 7 },
  });

  const scanId = "scan-purge-heal-1";
  const ticket = await sceneTicket(deps, scanId);
  const buildEvent = (expectedVersion) => ({
    action: "videoSceneCommit",
    scene_id: scanId,
    upload_ticket: ticket.begin.upload_ticket,
    asset_id: ticket.begin.asset_id,
    file_id: ticket.fileId,
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
    consent_version: "v1",
    candidate_count: 3,
    location: {
      location_id: "lc_shelf",
      scan_id: scanId,
      path_snapshot: ["书房", "书柜"],
      text_snapshot: "书房 / 书柜",
    },
    items: [
      { draft_key: "d-e", target: "existing", item_id: createdE.item.item_id, move_to_node_id: "lc_shelf", expected_version: expectedVersion, highlights: [hl(0, 700)] },
      { draft_key: "d-f", target: "new", operation_id: "op-purge-f", name: "新扳手", location_text: "书房 / 书柜", highlights: [hl(900, 1600)] },
    ],
  });
  // 第一遍:E 的 expected_version 过期 → 冲突不写证据;F 成功
  const first = await itemsHandler(buildEvent(1), deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.results.find((r) => r.draft_key === "d-e").error, "VERSION_CONFLICT");
  assert.equal(first.scan.confirmed_count, 1);
  // 客户端刷新版本后同票据同载荷重试(expected_version 不进签名)→ E 移动+证据补齐
  const second = await itemsHandler(buildEvent(7), deps);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.results.find((r) => r.draft_key === "d-e").move, "moved");
  assert.equal(second.scan.confirmed_count, 2, "scan 计数自愈");
  assert.equal((await rawDocs(db, "video_evidence")).length, 2);

  // purge:删 E、F → 末引用删云文件 → deleteLocation 收口
  const itemF = second.results.find((r) => r.draft_key === "d-f").item_id;
  for (const id of [createdE.item.item_id, itemF]) {
    const del = await itemsHandler({ action: "delete", item_id: id }, deps);
    assert.equal(del.ok, true, JSON.stringify(del));
  }
  assert.deepEqual(deps.cloudDeleted, [ticket.fileId], "两行都级联后云文件删除一次");
  const purge = await locHandler({ action: "deleteLocation", node_id: "lc_shelf", mode: "purge" }, deps);
  assert.equal(purge.ok, true, JSON.stringify(purge));
  const scans = await rawDocs(db, "location_scans");
  assert.equal(scans[0].status, "deleted");
  assert.equal(scans[0].confirmed_count, 2, "审计保留补齐后的计数");
});
