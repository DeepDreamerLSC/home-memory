"use strict";

/**
 * itemsApi 离线合同测试(docs/API_CONTRACT.md「离线测试规范」)。
 * 覆盖验收十场景中与数据层相关的九个(「AI 失败」属 extractDraft 测试):
 * 首次录入、同名不同件、移动、纠正、模糊别名、查无此物、两身份交叉越权、
 * 重试并发、删除;外加字段校验边界、日志脱敏与分页回归检查。
 * 零依赖:node:test + node:assert,只 require cloudfunctions/itemsApi/lib 与 tests/helpers。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
var normalizeName = require("../cloudfunctions/itemsApi/lib/normalize").normalizeName;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

// 模拟两个由不同 openid 派生出的 householdId(身份只来自 deps,与线上派生规则同构)
var HOUSEHOLD_A = "hh_11111111111111111111111111111111";
var HOUSEHOLD_B = "hh_22222222222222222222222222222222";

function makeDeps(db, householdId) {
  var seq = 0;
  var clock = 1760000000000;
  return {
    db: db,
    householdId: householdId,
    now: function () {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    genId: function () {
      seq += 1;
      return "n" + seq;
    },
    logger: { log: function () {} }
  };
}

function fresh(householdId) {
  var db = createMemoryDb();
  return { db: db, deps: makeDeps(db, householdId || HOUSEHOLD_A) };
}

function createEvent(opId, name, locationText, note) {
  var event = {
    action: "create",
    operation_id: opId,
    name: name,
    location_text: locationText
  };
  if (note !== undefined) {
    event.note = note;
  }
  return event;
}

function rawItems(db) {
  // where({}) 的 AND 等值匹配在空条件下命中全部文档
  return db.collection("items").where({}).get();
}

test("normalizeName:NFC/全角/大小写/空白/标点归一", function () {
  assert.equal(normalizeName("降压药"), "降压药");
  assert.equal(normalizeName("ｉＰｈｏｎｅ"), "iphone"); // 全角转半角 + 小写
  assert.equal(normalizeName("Iphone 充 电 线"), "iphone充电线"); // 去所有空白
  assert.equal(normalizeName("iphone充电线!"), "iphone充电线"); // 去中英文标点
  assert.equal(normalizeName("「充电线」"), "充电线"); // 去中文标点
  // 全角感叹号先转半角再按标点去除,与半角感叹号归一到同一结果
  assert.equal(normalizeName("充电线!"), normalizeName("充电线!"));
});

// 场景 1:首次录入
test("首次录入:create 后 query 按名可查到位置", async function () {
  var t = fresh();
  var res = await handler(
    createEvent("op-1", "降压药", "厨房第二个抽屉", "早晚各一片"),
    t.deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.duplicated, false);
  assert.equal(res.item.version, 1);
  assert.equal(res.item.deleted, false);
  assert.equal(res.item.household_id, HOUSEHOLD_A);
  assert.equal(res.item.name_norm, "降压药");
  assert.ok(res.item._id.indexOf("it_") === 0, "_id 应以 it_ 开头");

  var q = await handler({ action: "query", q: "降压药" }, t.deps);
  assert.equal(q.ok, true);
  assert.equal(q.match_type, "exact");
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].item_id, res.item._id);
  assert.equal(q.items[0].name, "降压药");
  assert.equal(q.items[0].location_text, "厨房第二个抽屉");
  assert.equal(q.items[0].note, "早晚各一片");
  assert.equal(q.items[0].version, 1);
});

// 场景 2:同名不同件
test("同名不同件:两件同名不同位置,query 都能查到", async function () {
  var t = fresh();
  var r1 = await handler(createEvent("op-a", "充电器", "客厅电视柜第一层"), t.deps);
  var r2 = await handler(createEvent("op-b", "充电器", "卧室床头插座"), t.deps);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.notEqual(r1.item._id, r2.item._id);

  var q = await handler({ action: "query", q: "充电器" }, t.deps);
  assert.equal(q.ok, true);
  assert.equal(q.items.length, 2);
  var locations = q.items.map(function (i) { return i.location_text; }).sort();
  assert.deepEqual(locations, ["卧室床头插座", "客厅电视柜第一层"]);
});

// 场景 3:移动
test("移动:update 位置后 query 返回新位置且 version 加一", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-move", "户口本", "客厅抽屉"), t.deps);
  var upd = await handler(
    {
      action: "update",
      item_id: created.item._id,
      expected_version: 1,
      location_text: "卧室保险柜"
    },
    t.deps
  );
  assert.equal(upd.ok, true);
  assert.equal(upd.item.version, 2);
  assert.equal(upd.item.location_text, "卧室保险柜");
  assert.notEqual(upd.item.updated_at, upd.item.created_at);

  var q = await handler({ action: "query", q: "户口本" }, t.deps);
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].location_text, "卧室保险柜");
  assert.equal(q.items[0].version, 2);

  var raw = await rawItems(t.db);
  assert.equal(raw.data.length, 1);
  assert.equal(raw.data[0].version, 2);
});

// 场景 4:纠正(先错后改)
test("纠正:录错位置后 update 修正,query 返回正确位置", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-fix", "护照", "厨房碗柜"), t.deps);
  assert.equal(created.item.location_text, "厨房碗柜");

  var upd = await handler(
    {
      action: "update",
      item_id: created.item._id,
      expected_version: 1,
      location_text: "书房文件盒"
    },
    t.deps
  );
  assert.equal(upd.ok, true);

  var q = await handler({ action: "query", q: "护照" }, t.deps);
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].location_text, "书房文件盒");

  // 名称也可纠正:改名后按新名可查、按旧名查不到,name_norm 重算
  var rename = await handler(
    {
      action: "update",
      item_id: created.item._id,
      expected_version: 2,
      name: "港澳通行证"
    },
    t.deps
  );
  assert.equal(rename.ok, true);
  assert.equal(rename.item.name_norm, "港澳通行证");
  var byOld = await handler({ action: "query", q: "护照" }, t.deps);
  assert.equal(byOld.items.length, 0);
  var byNew = await handler({ action: "query", q: "港澳通行证" }, t.deps);
  assert.equal(byNew.items.length, 1);
});

// 场景 5:模糊别名(全角/大小写/带空格的查询词经归一化仍命中)
test("模糊别名:全角、大小写、带空格的查询词归一化后仍命中", async function () {
  var t = fresh();
  await handler(createEvent("op-alias", "iPhone 充电线", "玄关抽屉"), t.deps);

  var qFull = await handler({ action: "query", q: "ｉＰｈｏｎｅ充电线" }, t.deps); // 全角字母
  assert.equal(qFull.ok, true);
  assert.equal(qFull.match_type, "exact");
  assert.equal(qFull.items.length, 1);

  var qUpper = await handler({ action: "query", q: "IPHONE 充电线" }, t.deps); // 大写 + 空格
  assert.equal(qUpper.items.length, 1);
  assert.equal(qUpper.items[0].location_text, "玄关抽屉");

  var qSpaces = await handler({ action: "query", q: "  iphone   充 电线  " }, t.deps); // 首尾与中间空白
  assert.equal(qSpaces.items.length, 1);

  var qPrefix = await handler({ action: "query", q: "iphone" }, t.deps); // 前缀匹配
  assert.equal(qPrefix.match_type, "prefix");
  assert.equal(qPrefix.items.length, 1);

  var qContains = await handler({ action: "query", q: "电线" }, t.deps); // 包含匹配
  assert.equal(qContains.match_type, "contains");
  assert.equal(qContains.items.length, 1);
});

// 场景 6:查无此物
test("查无此物:空结果是正常结果,不是错误", async function () {
  var t = fresh();
  await handler(createEvent("op-6", "体温计", "药箱"), t.deps);
  var q = await handler({ action: "query", q: "完全不存在的物品" }, t.deps);
  assert.equal(q.ok, true);
  assert.deepEqual(q.items, []);
  assert.equal(q.match_type, "none");
});

// 场景 7:两身份交叉越权
test("越权:A 查询 B 的物品为空,A 对 B 的物品 update/delete 得 NOT_FOUND", async function () {
  var db = createMemoryDb(); // 两个身份共用同一数据库,才能真实验证隔离
  var depsA = makeDeps(db, HOUSEHOLD_A);
  var depsB = makeDeps(db, HOUSEHOLD_B);

  var bItem = await handler(createEvent("op-b-secret", "存折", "书房保险箱"), depsB);
  assert.equal(bItem.ok, true);

  // A 按同样名称查询,查不到 B 的物品
  var qA = await handler({ action: "query", q: "存折" }, depsA);
  assert.equal(qA.ok, true);
  assert.deepEqual(qA.items, []);
  var listA = await handler({ action: "list" }, depsA);
  assert.deepEqual(listA.items, []);

  // A 对 B 的物品 update / delete 均为 NOT_FOUND,绝不落到 B 的文档上
  var updA = await handler(
    { action: "update", item_id: bItem.item._id, expected_version: 1, location_text: "被我改了" },
    depsA
  );
  assert.equal(updA.ok, false);
  assert.equal(updA.error, "NOT_FOUND");

  var delA = await handler({ action: "delete", item_id: bItem.item._id }, depsA);
  assert.equal(delA.ok, false);
  assert.equal(delA.error, "NOT_FOUND");

  // B 的物品原样无损
  var qB = await handler({ action: "query", q: "存折" }, depsB);
  assert.equal(qB.items.length, 1);
  assert.equal(qB.items[0].location_text, "书房保险箱");
  assert.equal(qB.items[0].version, 1);
});

// 场景 8:重试并发
test("重试并发:同 operation_id 两次 create 只建一件,第二次 duplicated", async function () {
  var t = fresh();
  var first = await handler(createEvent("op-retry", "备用钥匙", "鞋柜第二层"), t.deps);
  var second = await handler(createEvent("op-retry", "备用钥匙", "鞋柜第二层"), t.deps);
  assert.equal(first.ok, true);
  assert.equal(first.duplicated, false);
  assert.equal(second.ok, true);
  assert.equal(second.duplicated, true);
  assert.equal(second.item._id, first.item._id);
  assert.equal(second.item.version, 1);

  var raw = await rawItems(t.db);
  assert.equal(raw.data.length, 1, "重复 create 不得产生第二件");
});

test("重试并发:同 expected_version 的两次 update 恰好一笔成功一笔 VERSION_CONFLICT", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-conflict", "电费卡", "餐边抽屉"), t.deps);

  var txA = await handler(
    { action: "update", item_id: created.item._id, expected_version: 1, location_text: "书房抽屉" },
    t.deps
  );
  var txB = await handler(
    { action: "update", item_id: created.item._id, expected_version: 1, location_text: "卧室抽屉" },
    t.deps
  );

  var successes = [txA, txB].filter(function (r) { return r.ok; });
  var conflicts = [txA, txB].filter(function (r) { return r.ok === false; });
  assert.equal(successes.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].error, "VERSION_CONFLICT");
  assert.equal(conflicts[0].message, "内容已被修改,已为你刷新,请重试");

  // 落库的最终状态:version 只加了一次,且是成功那笔的值
  var raw = await rawItems(t.db);
  assert.equal(raw.data.length, 1);
  assert.equal(raw.data[0].version, 2);
  assert.equal(raw.data[0].location_text, successes[0].item.location_text);

  // 过期版本再试仍是 VERSION_CONFLICT;错误 ID 则是 NOT_FOUND
  var stale = await handler(
    { action: "update", item_id: created.item._id, expected_version: 1, location_text: "再试一次" },
    t.deps
  );
  assert.equal(stale.error, "VERSION_CONFLICT");
  var ghost = await handler(
    { action: "update", item_id: "it_ghost", expected_version: 1, location_text: "无此件" },
    t.deps
  );
  assert.equal(ghost.error, "NOT_FOUND");
});

// 场景 9:删除
test("删除:软删除后 query/list 不可见且内容字段已抹空", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-del", "旧合同", "阳台纸箱", "可销毁"), t.deps);
  await handler(createEvent("op-keep", "新合同", "书房柜子"), t.deps);

  var del = await handler({ action: "delete", item_id: created.item._id }, t.deps);
  assert.equal(del.ok, true);

  var q = await handler({ action: "query", q: "旧合同" }, t.deps);
  assert.equal(q.ok, true);
  assert.equal(q.items.length, 0);
  var list = await handler({ action: "list" }, t.deps);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].name, "新合同");

  // 底层文档仍在(deleted 标记),但内容字段全部抹成空字符串
  var raw = await t.db.collection("items").where({ _id: created.item._id }).get();
  assert.equal(raw.data.length, 1);
  var doc = raw.data[0];
  assert.equal(doc.deleted, true);
  assert.equal(doc.name, "");
  assert.equal(doc.name_norm, "");
  assert.equal(doc.location_text, "");
  assert.equal(doc.note, "");

  // 已删除的物品再删 → NOT_FOUND;对它 update → NOT_FOUND
  var delAgain = await handler({ action: "delete", item_id: created.item._id }, t.deps);
  assert.equal(delAgain.error, "NOT_FOUND");
  var updDeleted = await handler(
    { action: "update", item_id: created.item._id, expected_version: 1, location_text: "复活" },
    t.deps
  );
  assert.equal(updDeleted.error, "NOT_FOUND");
});

// 字段校验边界
test("校验边界:空名/超长/缺 operation_id/未知 action/缺 householdId,且校验失败绝不写入", async function () {
  var t = fresh();

  var blankName = await handler(createEvent("op-v1", "   ", "某处"), t.deps);
  assert.equal(blankName.ok, false);
  assert.equal(blankName.error, "INVALID_INPUT");
  assert.equal(typeof blankName.message, "string");
  assert.notEqual(blankName.message, "");

  var longName = await handler(createEvent("op-v2", "名".repeat(51), "某处"), t.deps);
  assert.equal(longName.error, "INVALID_INPUT");

  var longLocation = await handler(createEvent("op-v3", "剪刀", "位".repeat(201)), t.deps);
  assert.equal(longLocation.error, "INVALID_INPUT");

  var longNote = await handler(createEvent("op-v4", "剪刀", "抽屉", "注".repeat(201)), t.deps);
  assert.equal(longNote.error, "INVALID_INPUT");

  var longOpId = await handler(createEvent("x".repeat(65), "剪刀", "抽屉"), t.deps);
  assert.equal(longOpId.error, "INVALID_INPUT");

  var missingOp = await handler({ action: "create", name: "剪刀", location_text: "抽屉" }, t.deps);
  assert.equal(missingOp.error, "INVALID_INPUT");

  var blankLocation = await handler(createEvent("op-v5", "剪刀", "  "), t.deps);
  assert.equal(blankLocation.error, "INVALID_INPUT");

  var unknownAction = await handler({ action: "dropTable", item_id: "it_1" }, t.deps);
  assert.equal(unknownAction.error, "INVALID_INPUT");

  var noAction = await handler({}, t.deps);
  assert.equal(noAction.error, "INVALID_INPUT");

  var emptyQ = await handler({ action: "query", q: "   " }, t.deps);
  assert.equal(emptyQ.error, "INVALID_INPUT");

  var updateNothing = await handler(
    { action: "update", item_id: "it_1", expected_version: 1 },
    t.deps
  );
  assert.equal(updateNothing.error, "INVALID_INPUT");

  var updateBadVersion = await handler(
    { action: "update", item_id: "it_1", expected_version: "1", location_text: "x" },
    t.deps
  );
  assert.equal(updateBadVersion.error, "INVALID_INPUT");

  var badLimit = await handler({ action: "list", limit: 0 }, t.deps);
  assert.equal(badLimit.error, "INVALID_INPUT");

  // 以上全部失败请求之后,库里一条都不能有
  var raw = await rawItems(t.db);
  assert.equal(raw.data.length, 0, "校验失败绝不写入");
});

test("校验边界:缺 householdId 一律 UNAUTHORIZED", async function () {
  var db = createMemoryDb();
  var noIdentity = makeDeps(db, "");
  var r1 = await handler(createEvent("op-u1", "物品", "某处"), noIdentity);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "UNAUTHORIZED");
  var r2 = await handler({ action: "query", q: "物品" }, makeDeps(db, undefined));
  assert.equal(r2.error, "UNAUTHORIZED");
  var r3 = await handler({ action: "list" }, { db: db, now: function () { return ""; }, genId: function () { return "1"; }, logger: null });
  assert.equal(r3.error, "UNAUTHORIZED");
  var raw = await rawItems(db);
  assert.equal(raw.data.length, 0, "无身份绝不写入");
});

test("list:limit 上限与降序;event 里的身份字段一律忽略", async function () {
  var t = fresh();
  await handler(createEvent("op-l1", "雨伞", "门口伞架"), t.deps);
  await handler(createEvent("op-l2", "手电筒", "走廊柜子"), t.deps);
  await handler(createEvent("op-l3", "胶带", "工具箱"), t.deps);

  var list = await handler(
    { action: "list", household_id: "hh_forged", openid: "o_forged", limit: 2 },
    t.deps
  );
  assert.equal(list.ok, true);
  assert.equal(list.items.length, 2);
  // updated_at 降序:后录入的在前
  assert.equal(list.items[0].name, "胶带");
  assert.equal(list.items[1].name, "手电筒");

  var all = await handler({ action: "list" }, t.deps);
  assert.equal(all.items.length, 3);
  var raw = await rawItems(t.db);
  assert.equal(raw.data[0].household_id, HOUSEHOLD_A, "落库 household_id 只来自 deps");
});

// 回归:CloudBase 云函数端 get() 单次最多返回 100 条,query/list 必须分页拉全量
test("分页:文档超过 100 条后 query/list 仍基于全量,不被单次 get 上限截断", async function () {
  var t = fresh();
  var TOTAL = 120;
  for (var i = 1; i < TOTAL; i++) {
    var filler = await handler(
      createEvent("op-bulk-" + i, "杂物" + String(i).padStart(3, "0"), "储物间"),
      t.deps
    );
    assert.equal(filler.ok, true);
  }
  // 目标物品最后创建:落在第 120 条(第二页),且 updated_at 最新
  var target = await handler(createEvent("op-bulk-target", "印泥", "书房抽屉"), t.deps);
  assert.equal(target.ok, true);

  // 未显式 limit 的裸 get 只能看到前 100 条(与云函数端行为一致),证明数据量确实越界
  var raw = await t.db.collection("items").where({}).get();
  assert.equal(raw.data.length, 100, "memoryDb 裸 get 模拟云函数端默认 100 条上限");

  var q = await handler({ action: "query", q: "印泥" }, t.deps);
  assert.equal(q.ok, true);
  assert.equal(q.match_type, "exact");
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].item_id, target.item._id, "第二页的物品也必须能查到");

  var list = await handler({ action: "list" }, t.deps);
  assert.equal(list.ok, true);
  assert.equal(list.items.length, 50, "默认 limit 50");
  assert.equal(list.items[0].item_id, target.item._id, "最新一条在首位,来自第二页数据");
});

test("memoryDb:CloudBase 语义(add/where().get()/where().update()/doc().get()/doc().update())", async function () {
  var db = createMemoryDb();
  var added = await db.collection("items").add({ data: { _id: "it_1", household_id: "hh_x", n: 1, flag: false } });
  assert.equal(added._id, "it_1");
  await db.collection("items").add({ data: { _id: "it_2", household_id: "hh_y", n: 2, flag: false } });
  // 与真实 SDK 一致:裸传 doc(不带 data 包装)不会写入任何字段,只得到一个空文档(_id 由服务端生成)
  var orphanAdd = await db.collection("items").add({ _id: "it_3", household_id: "hh_x", n: 3, flag: false });
  assert.notEqual(orphanAdd._id, "it_3", "裸传时 options 里的 _id 被忽略");
  var orphan = await db.collection("items").doc(orphanAdd._id).get();
  assert.equal(orphan.data.household_id, undefined, "裸传 doc 时字段不落库(真实 SDK 同款行为)");

  var got = await db.collection("items").where({ household_id: "hh_x", flag: false }).get();
  assert.deepEqual(got.data.map(function (d) { return d._id; }), ["it_1"]);

  var upd = await db.collection("items").where({ household_id: "hh_y" }).update({ data: { n: 9 } });
  assert.deepEqual(upd.stats, { updated: 1 });
  var miss = await db.collection("items").where({ household_id: "hh_none" }).update({ data: { n: 0 } });
  assert.deepEqual(miss.stats, { updated: 0 });
  // 与真实 SDK 一致:裸传 update(不带 data 包装)直接拒绝
  await assert.rejects(
    function () { return db.collection("items").where({ household_id: "hh_y" }).update({ n: 1 }); },
    /parameter should be object/,
    "裸传 update 应被拒绝(真实 SDK 同款行为)",
  );

  var byDoc = await db.collection("items").doc("it_1").get();
  assert.equal(byDoc.data.n, 1);
  var none = await db.collection("items").doc("it_404").get();
  assert.equal(none.data, null);

  var docUpd = await db.collection("items").doc("it_1").update({ data: { flag: true } });
  assert.deepEqual(docUpd.stats, { updated: 1 });
  var after = await db.collection("items").doc("it_1").get();
  assert.equal(after.data.flag, true);
});

test("memoryDb:get() 默认 100 条上限与 .skip()/.limit() 分页语义", async function () {
  var db = createMemoryDb();
  for (var i = 1; i <= 120; i++) {
    await db.collection("items").add({ data: { _id: "it_" + i, n: i } });
  }
  var bare = await db.collection("items").where({}).get();
  assert.equal(bare.data.length, 100, "未显式 limit 时模拟云函数端默认 100 条上限");
  assert.equal(bare.data[0]._id, "it_1", "截断保留插入序的前 100 条");

  var page1 = await db.collection("items").where({}).limit(100).get();
  assert.equal(page1.data.length, 100);
  var page2 = await db.collection("items").where({}).skip(100).limit(100).get();
  assert.equal(page2.data.length, 20);
  assert.equal(page2.data[0]._id, "it_101");

  var tail = await db.collection("items").where({}).skip(115).get();
  assert.equal(tail.data.length, 5, "只有 skip 无 limit 时默认上限作用于 skip 之后");
  assert.equal(tail.data[0]._id, "it_116");

  var updateAll = await db.collection("items").where({ n: 1 }).limit(0).update({ data: { n: -1 } });
  assert.deepEqual(updateAll.stats, { updated: 1 }, "limit/skip 不影响 update 语义");
});

test("日志脱敏:只输出 action、错误码、耗时、计数", async function () {
  var db = createMemoryDb();
  var entries = [];
  var deps = {
    db: db,
    householdId: HOUSEHOLD_A,
    now: function () { return new Date(1760000000000).toISOString(); },
    genId: function () { return "1"; },
    logger: { log: function (e) { entries.push(e); } }
  };
  await handler(createEvent("op-log", "隐私物品名", "隐私位置"), deps);
  await handler({ action: "query", q: "隐私物品名" }, deps);
  await handler({ action: "create", operation_id: "op-log2", name: "x", location_text: "y" }, makeDeps(db, HOUSEHOLD_B));
  var seenBad = await handler({ action: "nope" }, deps);

  assert.equal(seenBad.error, "INVALID_INPUT");
  var dump = JSON.stringify(entries);
  assert.equal(dump.indexOf("隐私物品名"), -1, "日志不得出现物品名");
  assert.equal(dump.indexOf("隐私位置"), -1, "日志不得出现位置");
  assert.equal(dump.indexOf(HOUSEHOLD_A), -1, "日志不得出现身份");
  assert.equal(dump.indexOf("op-log"), -1, "日志不得出现 operation_id 原文");
  for (var i = 0; i < entries.length; i++) {
    var keys = Object.keys(entries[i]).sort();
    assert.deepEqual(keys, ["action", "count", "error", "ms"], "日志字段只能是 action/error/ms/count");
  }
});
