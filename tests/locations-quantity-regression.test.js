"use strict";

/**
 * Q1 数量 × locations 函数族回归(Q0-CONTRACT I2:挂载/移动写路径是部分字段
 * 条件更新,绝不触碰 quantity/unit/quantity_confirmed_at)。
 * 覆盖写入口总表 E12:linkItem(挂载)/unlinkItem(摘除)后数量字段原样存活。
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
