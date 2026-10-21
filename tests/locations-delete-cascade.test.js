"use strict";
// D1 删除位置三按钮服务端合同(#94 验收 11/12/13/15,docs/design/video-ai/D1-IMPLEMENTATION.md §5/§7):
// deletePreview 影响面计数;deleteLocation migrate(重挂上一级/根拒/顶层房间拒/冲突中止/
// 证据与云文件零动/scan 标 location_deleted 幂等)与 purge(仍有活物品拒 + 当前清单/
// scan 升级 deleted/并发 linkItem 补偿);根位置双动作硬拒。
var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("node:crypto");

var locHandler = require("../cloudfunctions/locations/lib/handler").handler;
var itemsHandler = require("../cloudfunctions/itemsApi/lib/handler").handler;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

var HOUSEHOLD_A = "hh_11111111111111111111111111111111";
var HOUSEHOLD_B = "hh_22222222222222222222222222222222";

function digest16(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

var GLOBAL_SEQ = 0;

function makeDeps(db, householdId) {
  var clock = 1760000000000;
  return {
    db: db,
    householdId: householdId || HOUSEHOLD_A,
    householdShared: false,
    scopeRevision: null,
    now: function () {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    genId: function () {
      GLOBAL_SEQ += 1;
      return "n" + GLOBAL_SEQ;
    },
    digest: digest16,
    logger: { log: function () {} }
  };
}

function freshDb() {
  return createMemoryDb({
    uniqueIndexes: {
      locations: [["household_id", "parent_id", "name_norm"]],
      location_scans: [["household_id", "scan_id"]],
      video_evidence: [["household_id", "item_id", "file_id"]]
    }
  });
}

function fresh() {
  var db = freshDb();
  return { db: db, deps: makeDeps(db) };
}

async function rawDocs(db, name) {
  var res = await db.collection(name).where({}).get();
  return res.data;
}

async function ensurePath(deps, segments) {
  var res = await locHandler({ action: "ensurePath", path: segments, created_from: "manual" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
}

async function createItem(deps, opId, name, locationText) {
  var res = await itemsHandler(
    { action: "create", operation_id: opId, name: name, location_text: locationText },
    deps
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.item.item_id;
}

async function linkItem(deps, itemId, nodeId, version, updateId) {
  var res = await locHandler(
    { action: "linkItem", item_id: itemId, node_id: nodeId, expected_version: version, update_id: updateId },
    deps
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
}

/** 直接注入 scan 行(不走 itemsApi,只依赖 location_id/status 结构事实) */
async function seedScan(db, scanId, locationId, status, extra) {
  var doc = Object.assign({
    _id: "ls_" + scanId,
    household_id: HOUSEHOLD_A,
    scan_id: scanId,
    location_id: locationId,
    location_path_snapshot: ["书房"],
    location_text_snapshot: "书房",
    file_id: "cloud://bucket/video-evidence/" + HOUSEHOLD_A + "/" + scanId + ".mp4",
    asset_id: "va_" + scanId,
    upload_ticket: "vt_" + scanId,
    duration_ms: 12000,
    video_w: 1280,
    video_h: 720,
    candidate_count: 3,
    confirmed_count: 1,
    confirmed_item_ids: [],
    created_at: "2026-10-18T00:00:00.000Z",
    updated_at: "2026-10-18T00:00:00.000Z",
    status: status || "active"
  }, extra || {});
  await db.collection("location_scans").add({ data: doc });
  return doc;
}

async function seedEvidence(db, evidenceId, itemId) {
  await db.collection("video_evidence").add({ data: {
    _id: evidenceId,
    household_id: HOUSEHOLD_A,
    item_id: itemId,
    file_id: "cloud://bucket/video-evidence/" + HOUSEHOLD_A + "/" + evidenceId + ".mp4",
    asset_id: "va_" + evidenceId,
    duration_ms: 12000,
    video_w: 1280,
    video_h: 720,
    captured_location_text: "书房 / 书柜",
    consent_version: "v1",
    upload_ticket: "vt_" + evidenceId,
    source: "scene",
    scan_id: "scan-seed-" + evidenceId,
    highlights: [],
    highlight_version: 1,
    created_at: "2026-10-18T00:00:00.000Z"
  } });
}

/**
 * 并发窗口注入(locations.test.js sabotageMountDb 同款思路):在目标物品的
 * 条件挂载更新落库前先执行 sabotage(模拟 itemsApi.update 抢先推进版本),
 * 使本次 CAS 失配,驱动 0 命中回查三态分流。
 */
function sabotageMountDb(db, targetItemId, sabotage) {
  var fired = false;
  return {
    collection: function (name) {
      var col = db.collection(name);
      if (name !== "items") return col;
      return {
        where: function (cond) {
          var inner = col.where(cond);
          function wrap(q) {
            return {
              get: function (o) { return q.get(o); },
              skip: function (n) { return wrap(q.skip(n)); },
              limit: function (n) { return wrap(q.limit(n)); },
              update: function (options) {
                if (
                  !fired &&
                  cond._id === targetItemId &&
                  cond.version !== undefined &&
                  options && options.data && "location_node_id" in options.data
                ) {
                  fired = true;
                  return Promise.resolve().then(sabotage).then(function () {
                    return q.update(options);
                  });
                }
                return q.update(options);
              }
            };
          }
          return wrap(inner);
        },
        doc: col.doc.bind(col),
        add: col.add.bind(col)
      };
    }
  };
}

/**
 * 并发挂载窗口注入:第 1 次 items 全量读(purge 的 remaining 检查/migrate 的
 * 循环首读)看不到 extraItemId(模拟 linkItem 尚未发生),之后的读(victims
 * 补偿扫描)能看到——extra 物品真实存在于库中,补偿条件更新可以命中。
 */
function raceLinkDb(db, extraItemId) {
  var itemsGets = 0;
  return {
    collection: function (name) {
      var col = db.collection(name);
      if (name !== "items") return col;
      return {
        where: function (cond) {
          var inner = col.where(cond);
          function wrap(q) {
            return {
              get: function () {
                itemsGets += 1;
                return q.get().then(function (res) {
                  if (itemsGets === 1) {
                    return {
                      data: (res.data || []).filter(function (d) { return d._id !== extraItemId; })
                    };
                  }
                  return res;
                });
              },
              skip: function (n) { return wrap(q.skip(n)); },
              limit: function (n) { return wrap(q.limit(n)); },
              update: function (o) { return q.update(o); },
              remove: function () { return q.remove(); }
            };
          }
          return wrap(inner);
        },
        doc: col.doc.bind(col),
        add: col.add.bind(col)
      };
    }
  };
}

/** 标准三层树:书房/书柜 + 厨房;甲挂书柜、乙挂厨房 */
async function setupTree(t) {
  var study = await ensurePath(t.deps, ["书房"]);
  var shelf = await ensurePath(t.deps, ["书房", "书柜"]);
  await ensurePath(t.deps, ["厨房"]);
  var nodes = await rawDocs(t.db, "locations");
  var byName = {};
  for (var i = 0; i < nodes.length; i++) byName[nodes[i].name + "|" + nodes[i].path.length] = nodes[i];
  return {
    rootId: nodes.find(function (n) { return n.parent_id === ""; })._id,
    studyId: study.nodes[0].location_id,
    shelfId: shelf.nodes[shelf.nodes.length - 1].location_id,
    kitchenId: nodes.find(function (n) { return n.name === "厨房"; })._id
  };
}

test("ROOT-GUARD:deletePreview / deleteLocation 对根位置一律 INVALID_INPUT,树零变化", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var before = (await rawDocs(t.db, "locations")).length;

  var preview = await locHandler({ action: "deletePreview", node_id: ids.rootId }, t.deps);
  assert.equal(preview.ok, false);
  assert.equal(preview.error, "INVALID_INPUT");

  var migrate = await locHandler({ action: "deleteLocation", node_id: ids.rootId, mode: "migrate" }, t.deps);
  assert.equal(migrate.ok, false);
  assert.equal(migrate.error, "INVALID_INPUT");

  var purge = await locHandler({ action: "deleteLocation", node_id: ids.rootId, mode: "purge" }, t.deps);
  assert.equal(purge.ok, false);
  assert.equal(purge.error, "INVALID_INPUT");

  assert.equal((await rawDocs(t.db, "locations")).length, before, "根位置拒删:节点零变化");
  // 非法 mode / 缺 node_id 同样拒绝
  var badMode = await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "nuke" }, t.deps);
  assert.equal(badMode.ok, false);
  assert.equal(badMode.error, "INVALID_INPUT");
  var crossHouse = await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "purge" }, makeDeps(t.db, HOUSEHOLD_B));
  assert.equal(crossHouse.ok, false);
  assert.equal(crossHouse.error, "NOT_FOUND", "跨家庭查不到节点");
});

test("DELETE-PREVIEW:影响面计数 node/item/video/scan + migrate_available", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var inner = await ensurePath(t.deps, ["书房", "书柜", "第一层"]);
  var layerId = inner.nodes[inner.nodes.length - 1].location_id;

  var a = await createItem(t.deps, "op-preview-a", "字典", "书房 / 书柜");
  await linkItem(t.deps, a, ids.shelfId, 1, "u-preview-a");
  var b = await createItem(t.deps, "op-preview-b", "相册", "书房 / 书柜 / 第一层");
  await linkItem(t.deps, b, layerId, 1, "u-preview-b");
  var c = await createItem(t.deps, "op-preview-c", "锅", "厨房");
  await linkItem(t.deps, c, ids.kitchenId, 1, "u-preview-c");

  await seedEvidence(t.db, "ve_prev_a1", a);
  await seedEvidence(t.db, "ve_prev_a2", a);
  await seedEvidence(t.db, "ve_prev_b1", b);
  await seedScan(t.db, "scan-prev-shelf", ids.shelfId);
  await seedScan(t.db, "scan-prev-layer", layerId);
  await seedScan(t.db, "scan-prev-kitchen", ids.kitchenId);

  var preview = await locHandler({ action: "deletePreview", node_id: ids.shelfId }, t.deps);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.node_count, 2, "子树含自身:书柜+第一层");
  assert.equal(preview.item_count, 2, "厨房的锅不计入");
  assert.equal(preview.video_count, 3, "这些物品的 video_evidence 行数");
  assert.equal(preview.scan_count, 2, "子树内 active scan 数");
  assert.equal(preview.migrate_available, true, "父不是 home 根");

  var roomPreview = await locHandler({ action: "deletePreview", node_id: ids.studyId }, t.deps);
  assert.equal(roomPreview.ok, true);
  assert.equal(roomPreview.node_count, 3);
  assert.equal(roomPreview.migrate_available, false, "顶层房间父为 home 根,migrate 不可用");

  var missing = await locHandler({ action: "deletePreview", node_id: "lc_nope" }, t.deps);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "NOT_FOUND");
});

test("MIGRATE-FULL:物品条件重挂到上一级,子树硬删,scan 标 location_deleted;location_text 不改写", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var inner = await ensurePath(t.deps, ["书房", "书柜", "第一层"]);
  var layerId = inner.nodes[inner.nodes.length - 1].location_id;

  var a = await createItem(t.deps, "op-mig-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.shelfId, 1, "u-mig-a");
  var b = await createItem(t.deps, "op-mig-b", "相册", "书柜第一层");
  await linkItem(t.deps, b, layerId, 1, "u-mig-b");
  await seedEvidence(t.db, "ve_mig_a", a);
  await seedScan(t.db, "scan-mig-shelf", ids.shelfId);
  await seedScan(t.db, "scan-mig-layer", layerId);
  await seedScan(t.db, "scan-mig-kitchen", ids.kitchenId);
  var evidenceBefore = JSON.parse(JSON.stringify(await rawDocs(t.db, "video_evidence")));

  var res = await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "migrate" }, t.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.deleted_nodes, 2);
  assert.equal(res.remounted, 2);
  assert.equal(res.compensated, 0);
  assert.equal(res.scans_marked, 2);

  var items = await rawDocs(t.db, "items");
  var docA = items.find(function (d) { return d._id === a; });
  var docB = items.find(function (d) { return d._id === b; });
  assert.equal(docA.location_node_id, ids.studyId, "重挂到上一级(书房)");
  assert.equal(docB.location_node_id, ids.studyId, "子树深处的物品同样重挂到上一级");
  assert.equal(docA.version, 3, "linkItem v1→2 后 migrate 条件重挂 v2→3");
  assert.equal(docA.last_update_id, "locmigrate:" + digest16(ids.shelfId + ":" + a));
  assert.equal(docA.location_text, "书房的书柜", "迁移只改挂载,不改写用户话语(location_text)");
  assert.equal(docA.deleted, false);

  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.shelfId; }), false, "书柜硬删");
  assert.equal(nodes.some(function (n) { return n._id === layerId; }), false, "第一层硬删");
  assert.equal(nodes.some(function (n) { return n._id === ids.studyId; }), true, "书房保留");

  var scans = await rawDocs(t.db, "location_scans");
  var byScan = {};
  for (var i = 0; i < scans.length; i++) byScan[scans[i].scan_id] = scans[i];
  assert.equal(byScan["scan-mig-shelf"].status, "location_deleted");
  assert.ok(byScan["scan-mig-shelf"].location_deleted_at, "记录 location_deleted_at");
  assert.equal(byScan["scan-mig-layer"].status, "location_deleted");
  assert.equal(byScan["scan-mig-kitchen"].status, "active", "子树外 scan 不动");

  assert.deepEqual(await rawDocs(t.db, "video_evidence"), evidenceBefore, "MIGRATE-KEEPS:证据行零变化");
  assert.equal(items.length, 2, "物品一个不删");

  // 重试(整体成功后响应丢失):节点已删 → NOT_FOUND,库状态稳定
  var retry = await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "migrate" }, t.deps);
  assert.equal(retry.ok, false);
  assert.equal(retry.error, "NOT_FOUND");
  assert.equal((await rawDocs(t.db, "location_scans")).length, 3);
});

test("MIGRATE-KEEPS-RETRY:scan 状态迁移按 status 条件更新幂等;已 location_deleted 的时间戳不被改写", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-migk-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.shelfId, 1, "u-migk-a");

  // 预置:一条已 location_deleted(带旧时间戳) + 一条 active
  await seedScan(t.db, "scan-migk-done", ids.shelfId, "location_deleted", {
    location_deleted_at: "2026-10-01T00:00:00.000Z"
  });
  await seedScan(t.db, "scan-migk-live", ids.shelfId);

  var res = await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "migrate" }, t.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.scans_marked, 1, "只迁移 active 行");

  var scans = await rawDocs(t.db, "location_scans");
  var done = scans.find(function (s) { return s.scan_id === "scan-migk-done"; });
  var live = scans.find(function (s) { return s.scan_id === "scan-migk-live"; });
  assert.equal(done.location_deleted_at, "2026-10-01T00:00:00.000Z", "已迁移行时间戳不被重试改写(幂等)");
  assert.equal(done.status, "location_deleted");
  assert.equal(live.status, "location_deleted");
  assert.notEqual(live.location_deleted_at, "2026-10-01T00:00:00.000Z");
});

test("MIGRATE-CONFLICT:重挂条件更新被并发修改抢先 → VERSION_CONFLICT + conflicted 清单,零删除", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var m1 = await createItem(t.deps, "op-migc-1", "酱油", "书房的书柜");
  await linkItem(t.deps, m1, ids.shelfId, 1, "u-migc-1");
  var m2 = await createItem(t.deps, "op-migc-2", "醋", "书房的书柜");
  await linkItem(t.deps, m2, ids.shelfId, 1, "u-migc-2");

  var trapDb = sabotageMountDb(t.db, m2, function () {
    return t.db.collection("items").doc(m2).update({
      data: { version: 4, note: "并发改动" } // 模拟 itemsApi.update 在 migrate 读版本(v2)之后推进
    });
  });
  var trapDeps = Object.assign({}, t.deps, { db: trapDb });
  var aborted = await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "migrate" }, trapDeps);
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error, "VERSION_CONFLICT");
  assert.equal(aborted.detail.conflicted[0].item_id, m2);
  assert.equal(aborted.detail.conflicted[0].current_version, 4);

  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.shelfId; }), true, "中止时零删除");
  var items = await rawDocs(t.db, "items");
  var docM2 = items.find(function (d) { return d._id === m2; });
  assert.equal(docM2.location_node_id, ids.shelfId, "冲突件挂载不动");
  assert.equal(docM2.version, 4, "版本不回拨");

  // 无竞态重试:收敛完成
  var converge = await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "migrate" }, t.deps);
  assert.equal(converge.ok, true, JSON.stringify(converge));
  var docM2After = (await rawDocs(t.db, "items")).find(function (d) { return d._id === m2; });
  assert.equal(docM2After.location_node_id, ids.studyId);
});

test("MIGRATE-TOP-ROOM:顶层房间(父为 home 根)migrate 被拒——物品不能直接挂「我的家」", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-room-a", "台灯", "书房");
  await linkItem(t.deps, a, ids.studyId, 1, "u-room-a");
  var res = await locHandler({ action: "deleteLocation", node_id: ids.studyId, mode: "migrate" }, t.deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "INVALID_INPUT");
  assert.ok(res.message.indexOf("我的家") !== -1, "结构规则来自 linkItem 的 isHomeRoot 拒绝");
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.studyId; }), true, "零删除");
  var doc = (await rawDocs(t.db, "items")).find(function (d) { return d._id === a; });
  assert.equal(doc.location_node_id, ids.studyId, "物品挂载不动");
});

test("PURGE-GUARD:仍有未删物品挂载在子树 → NODE_NOT_EMPTY + 当前清单,可补删后重试收敛", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-pg-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.shelfId, 1, "u-pg-a");
  var b = await createItem(t.deps, "op-pg-b", "相册", "书房的书柜");
  await linkItem(t.deps, b, ids.shelfId, 1, "u-pg-b");
  await seedScan(t.db, "scan-pg", ids.shelfId);

  // 客户端先删 a;b 删除中断放弃 → purge 拒绝并给出剩余清单
  var delA = await itemsHandler({ action: "delete", item_id: a }, t.deps);
  assert.equal(delA.ok, true, JSON.stringify(delA));
  var refused = await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "purge" }, t.deps);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "NODE_NOT_EMPTY");
  assert.deepEqual(refused.detail.remaining_items, [{ item_id: b, current_version: 2 }]);
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.shelfId; }), true, "零删除");
  var scans = await rawDocs(t.db, "location_scans");
  assert.equal(scans[0].status, "active", "scan 不动");

  // 补删 b 后 purge 收敛;已删物品重复删除返回 NOT_FOUND(客户端视为完成)
  var delAgain = await itemsHandler({ action: "delete", item_id: a }, t.deps);
  assert.equal(delAgain.ok, false);
  assert.equal(delAgain.error, "NOT_FOUND");
  var delB = await itemsHandler({ action: "delete", item_id: b }, t.deps);
  assert.equal(delB.ok, true, JSON.stringify(delB));
  var ok = await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "purge" }, t.deps);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.deleted_nodes, 1);
  assert.equal(ok.scans_marked, 1);
  scans = await rawDocs(t.db, "location_scans");
  assert.equal(scans[0].status, "deleted");
  assert.ok(scans[0].deleted_at);
});

test("PURGE-UPGRADE:已 location_deleted 的 scan 在 purge 中升级为 deleted", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  await seedScan(t.db, "scan-up-live", ids.shelfId, "active");
  await seedScan(t.db, "scan-up-migrated", ids.shelfId, "location_deleted", {
    location_deleted_at: "2026-10-01T00:00:00.000Z"
  });
  var res = await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "purge" }, t.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.scans_marked, 2, "active 与 location_deleted 都升级");
  var scans = await rawDocs(t.db, "location_scans");
  for (var i = 0; i < scans.length; i++) {
    assert.equal(scans[i].status, "deleted");
    assert.ok(scans[i].deleted_at);
  }
});

test("PURGE-CONCURRENT-LINK:删除期间并发挂载 → 删除后补偿扫描摘除悬挂挂载", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-race-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.shelfId, 1, "u-race-a");
  var late = await createItem(t.deps, "op-race-late", "迟到者", "书房的书柜");
  await linkItem(t.deps, late, ids.studyId, 1, "u-race-late"); // 先挂在书房(子树外)

  // purge 前置:子树内物品 a 已按流程删除
  var delA = await itemsHandler({ action: "delete", item_id: a }, t.deps);
  assert.equal(delA.ok, true, JSON.stringify(delA));

  // 并发窗口:remaining 检查读不到 late 已被改挂到书柜的写入,删除后补偿扫描才看到
  await t.db.collection("items").doc(late).update({
    data: { location_node_id: ids.shelfId, version: 3, last_update_id: "u-race-late-2" }
  });
  var lateDoc = (await rawDocs(t.db, "items")).find(function (d) { return d._id === late; });
  var raceDb = raceLinkDb(t.db, late);
  var wrappedDeps = Object.assign({}, t.deps, { db: raceDb });

  var res = await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "purge" }, wrappedDeps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.deleted_nodes, 1);
  assert.equal(res.compensated, 1, "悬挂挂载被补偿摘除");
  assert.equal(res.compensated_skipped, 0);

  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.shelfId; }), false);
  var docLate = (await rawDocs(t.db, "items")).find(function (d) { return d._id === late; });
  assert.equal(docLate.location_node_id, null, "补偿置 null,回到未挂载(根层「尚未归类」可见)");
  assert.equal(docLate.version, lateDoc.version + 1, "compensate 条件更新推进版本");
  assert.equal(docLate.deleted, false, "补偿只摘挂载,绝不删物品");
});
