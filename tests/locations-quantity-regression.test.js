"use strict";

/**
 * Q1 数量 × locations 函数族回归(Q0-CONTRACT I2:挂载/移动写路径是部分字段
 * 条件更新,绝不触碰 quantity/unit/quantity_confirmed_at)。
 * 覆盖写入口总表 E12:linkItem(挂载)/unlinkItem(摘除)/merge(合并重挂)/
 * applyScan mounts(扫描确认挂载)/deleteLocation migrate(删位置迁移重挂)
 * 后数量字段原样存活。
 * 红绿纪律:本文件在未实现数量的代码上必须失败,实现后全绿。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("node:crypto");

var locHandler = require("../cloudfunctions/locations/lib/handler").handler;
var itemsHandler = require("../cloudfunctions/itemsApi/lib/handler").handler;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

var HOUSEHOLD_A = "hh_11111111111111111111111111111111";

var GLOBAL_SEQ = 0;

function makeDeps(db, householdId) {
  var clock = 1760000000000;
  return {
    db: db,
    householdId: householdId || HOUSEHOLD_A,
    now: function () {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    genId: function () {
      GLOBAL_SEQ += 1;
      return "n" + GLOBAL_SEQ;
    },
    digest: function (s) {
      return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
    },
    logger: { log: function () {} }
  };
}

function fresh() {
  var db = createMemoryDb({
    uniqueIndexes: { locations: [["household_id", "parent_id", "name_norm"]] }
  });
  return { db: db, deps: makeDeps(db) };
}

async function rawDocs(db, name) {
  var res = await db.collection(name).where({}).get();
  return res.data;
}

test("E12/I2 linkItem 挂载后 quantity/unit/quantity_confirmed_at 原样存活;unlinkItem 摘除亦然", async function () {
  var t = fresh();
  // 建带数量的物品(3 包)
  var created = await itemsHandler(
    {
      action: "create",
      operation_id: "op-i2",
      name: "棉柔巾",
      location_text: "书房书柜第二层",
      quantity: 3,
      unit: "包"
    },
    t.deps
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.item.quantity, 3);
  var confirmedAt = created.item.quantity_confirmed_at;

  var path = await locHandler({ action: "ensurePath", path: ["书房", "书柜"] }, t.deps);
  assert.equal(path.ok, true);
  var shelfId = path.nodes[1].location_id;

  // 挂载(部分字段条件更新):版本推进但数量字段一字不动
  var linked = await locHandler(
    {
      action: "linkItem",
      item_id: created.item.item_id,
      node_id: shelfId,
      expected_version: 1,
      update_id: "u-i2-link"
    },
    t.deps
  );
  assert.equal(linked.ok, true, JSON.stringify(linked));
  var got = await itemsHandler({ action: "get", item_id: created.item.item_id }, t.deps);
  assert.equal(got.ok, true);
  assert.equal(got.item.quantity, 3, "挂载后数量存活");
  assert.equal(got.item.unit, "包");
  assert.equal(got.item.quantity_confirmed_at, confirmedAt, "挂载不是数量确认,不刷新确认时间");
  assert.equal(got.item.version, 2, "挂载推进版本(挂载写路径本身)");

  // 摘除:数量同样不动
  var unlinked = await locHandler(
    {
      action: "unlinkItem",
      item_id: created.item.item_id,
      expected_version: 2,
      update_id: "u-i2-unlink"
    },
    t.deps
  );
  assert.equal(unlinked.ok, true, JSON.stringify(unlinked));
  var docs = await rawDocs(t.db, "items");
  assert.equal(docs[0].quantity, 3, "摘除后数量存活");
  assert.equal(docs[0].unit, "包");
  assert.equal(docs[0].quantity_confirmed_at, confirmedAt);
});

test("E12/I2 merge 合并重挂后 quantity/unit/quantity_confirmed_at 原样存活(Q1 复审补锁)", async function () {
  var t = fresh();
  var created = await itemsHandler(
    {
      action: "create",
      operation_id: "op-i2-merge",
      name: "垃圾袋",
      location_text: "厨房",
      quantity: 2,
      unit: "盒"
    },
    t.deps
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  var confirmedAt = created.item.quantity_confirmed_at;
  var src = await locHandler({ action: "ensurePath", path: ["厨房"] }, t.deps);
  var tgt = await locHandler({ action: "ensurePath", path: ["杂物间"] }, t.deps);
  var linked = await locHandler(
    {
      action: "linkItem",
      item_id: created.item.item_id,
      node_id: src.nodes[0].location_id,
      expected_version: 1,
      update_id: "u-i2-mg-link"
    },
    t.deps
  );
  assert.equal(linked.ok, true, JSON.stringify(linked));

  var merged = await locHandler(
    { action: "merge", source_node_id: src.nodes[0].location_id, target_node_id: tgt.nodes[0].location_id },
    t.deps
  );
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(merged.remounted, 1, "直挂 source 的物品条件重挂到 target");
  var doc = (await rawDocs(t.db, "items"))[0];
  assert.equal(doc.quantity, 2, "merge 重挂后数量存活");
  assert.equal(doc.unit, "盒");
  assert.equal(doc.quantity_confirmed_at, confirmedAt, "merge 不是数量确认,不刷新确认时间");
  assert.equal(doc.version, 3, "linkItem v1→2 后 merge 条件重挂 v2→3(版本推进但数量字段一字不动)");
});

test("E12/I2 applyScan mounts 扫描挂载后 quantity/unit/quantity_confirmed_at 原样存活(Q1 复审补锁)", async function () {
  var t = fresh();
  var created = await itemsHandler(
    {
      action: "create",
      operation_id: "op-i2-scan",
      name: "雨伞",
      location_text: "玄关",
      quantity: 5,
      unit: "只"
    },
    t.deps
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  var confirmedAt = created.item.quantity_confirmed_at;

  var applied = await locHandler(
    {
      action: "applyScan",
      operation_id: "op-i2-apply",
      branches: [],
      mounts: [{ item_id: created.item.item_id, expected_version: 1, path: ["玄关", "伞桶"] }]
    },
    t.deps
  );
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.result.mounts[0].status, "mounted");
  var doc = (await rawDocs(t.db, "items"))[0];
  assert.equal(doc.quantity, 5, "applyScan 挂载后数量存活");
  assert.equal(doc.unit, "只");
  assert.equal(doc.quantity_confirmed_at, confirmedAt);
  assert.equal(doc.version, 2, "挂载推进版本(挂载写路径本身)");
});

test("E12/I2 deleteLocation migrate 迁移重挂后 quantity/unit/quantity_confirmed_at 原样存活(Q1 复审补锁)", async function () {
  var t = fresh();
  var created = await itemsHandler(
    {
      action: "create",
      operation_id: "op-i2-migrate",
      name: "字典",
      location_text: "书房的书柜",
      quantity: 4,
      unit: "本"
    },
    t.deps
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  var confirmedAt = created.item.quantity_confirmed_at;
  var tree = await locHandler({ action: "ensurePath", path: ["书房", "书柜"] }, t.deps);
  var shelfId = tree.nodes[1].location_id;
  var linked = await locHandler(
    {
      action: "linkItem",
      item_id: created.item.item_id,
      node_id: shelfId,
      expected_version: 1,
      update_id: "u-i2-mig-link"
    },
    t.deps
  );
  assert.equal(linked.ok, true, JSON.stringify(linked));

  var migrated = await locHandler({ action: "deleteLocation", node_id: shelfId, mode: "migrate" }, t.deps);
  assert.equal(migrated.ok, true, JSON.stringify(migrated));
  assert.equal(migrated.remounted, 1, "物品条件重挂到上一级(书房)");
  var doc = (await rawDocs(t.db, "items"))[0];
  assert.equal(doc.quantity, 4, "migrate 重挂后数量存活");
  assert.equal(doc.unit, "本");
  assert.equal(doc.quantity_confirmed_at, confirmedAt);
  assert.equal(doc.deleted, false, "删位置绝不删物品");
  assert.equal(doc.version, 3, "linkItem v1→2 后 migrate 条件重挂 v2→3");
});
