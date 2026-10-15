"use strict";

/**
 * itemsApi 离线合同测试(docs/API_CONTRACT.md「离线测试规范」)。
 * 覆盖验收十场景中与数据层相关的九个(「AI 失败」属 extractDraft 测试):
 * 首次录入、同名不同件、移动、纠正、模糊别名、查无此物、两身份交叉越权、
 * 重试并发、删除;外加字段校验边界、日志脱敏与分页回归检查。
 * issue #36 二阶段:提醒实体段——独立 reminders 集合、create 可选 reminder、
 * remindList/remindComplete/remindClear/remindSet、物品删除级联、共享家庭双 marker
 * 硬门、日期格式严格拒绝、周期再生、remindSet 补录与替换不堆积、duplicated
 * 收敛与提醒日志脱敏(含日期明细)。
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
  // 响应为投影形态(不含内部字段);内部字段经 rawItems 直查存储层断言
  assert.ok(res.item.item_id.indexOf("it_") === 0, "item_id 应以 it_ 开头");
  var raw = await rawItems(t.db);
  assert.equal(raw.data.length, 1);
  assert.equal(raw.data[0].deleted, false);
  assert.equal(raw.data[0].household_id, HOUSEHOLD_A);
  assert.equal(raw.data[0].name_norm, "降压药");

  var q = await handler({ action: "query", q: "降压药" }, t.deps);
  assert.equal(q.ok, true);
  assert.equal(q.match_type, "exact");
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].item_id, res.item.item_id);
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
  assert.notEqual(r1.item.item_id, r2.item.item_id);

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
      item_id: created.item.item_id,
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
      item_id: created.item.item_id,
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
      item_id: created.item.item_id,
      expected_version: 2,
      name: "港澳通行证"
    },
    t.deps
  );
  assert.equal(rename.ok, true);
  var rawRenamed = await rawItems(t.db);
  assert.equal(rawRenamed.data[0].name_norm, "港澳通行证");
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
    { action: "update", item_id: bItem.item.item_id, expected_version: 1, location_text: "被我改了" },
    depsA
  );
  assert.equal(updA.ok, false);
  assert.equal(updA.error, "NOT_FOUND");

  var delA = await handler({ action: "delete", item_id: bItem.item.item_id }, depsA);
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
  assert.equal(second.item.item_id, first.item.item_id);
  assert.equal(second.item.version, 1);

  var raw = await rawItems(t.db);
  assert.equal(raw.data.length, 1, "重复 create 不得产生第二件");
});

test("重试并发:同 expected_version 的两次 update 恰好一笔成功一笔 VERSION_CONFLICT", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-conflict", "电费卡", "餐边抽屉"), t.deps);

  var txA = await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, location_text: "书房抽屉" },
    t.deps
  );
  var txB = await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, location_text: "卧室抽屉" },
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
    { action: "update", item_id: created.item.item_id, expected_version: 1, location_text: "再试一次" },
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

  var del = await handler({ action: "delete", item_id: created.item.item_id }, t.deps);
  assert.equal(del.ok, true);

  var q = await handler({ action: "query", q: "旧合同" }, t.deps);
  assert.equal(q.ok, true);
  assert.equal(q.items.length, 0);
  var list = await handler({ action: "list" }, t.deps);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].name, "新合同");

  // 底层文档仍在(deleted 标记),但内容字段全部抹成空字符串
  var raw = await t.db.collection("items").where({ _id: created.item.item_id }).get();
  assert.equal(raw.data.length, 1);
  var doc = raw.data[0];
  assert.equal(doc.deleted, true);
  assert.equal(doc.name, "");
  assert.equal(doc.name_norm, "");
  assert.equal(doc.location_text, "");
  assert.equal(doc.note, "");

  // 已删除的物品再删 → NOT_FOUND;对它 update → NOT_FOUND
  var delAgain = await handler({ action: "delete", item_id: created.item.item_id }, t.deps);
  assert.equal(delAgain.error, "NOT_FOUND");
  var updDeleted = await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, location_text: "复活" },
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
  assert.equal(q.items[0].item_id, target.item.item_id, "第二页的物品也必须能查到");

  var list = await handler({ action: "list" }, t.deps);
  assert.equal(list.ok, true);
  assert.equal(list.items.length, 50, "默认 limit 50");
  assert.equal(list.items[0].item_id, target.item.item_id, "最新一条在首位,来自第二页数据");
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

// ---------- 评审修复回归(OPERATION_CONFLICT / update 重放 / get) ----------

test("同键异内容重放:OPERATION_CONFLICT,附已有记录,绝不静默返回旧数据", async function () {
  var t = fresh();
  var first = await handler(createEvent("op-x", "钥匙", "玄关抽屉"), t.deps);
  assert.equal(first.ok, true);
  // 场景:第一次保存成功但响应丢失,用户改了位置后用同一 operation_id 重试
  var second = await handler(createEvent("op-x", "钥匙", "书房抽屉"), t.deps);
  assert.equal(second.ok, false);
  assert.equal(second.error, "OPERATION_CONFLICT");
  assert.ok(second.message.indexOf("内容") !== -1, "提示应说明内容不同");
  assert.equal(second.existing.item_id, first.item.item_id, "应附已有记录供可操作引导");
  assert.equal(second.existing.location_text, "玄关抽屉");
  var raw = await rawItems(t.db);
  assert.equal(raw.data.length, 1, "数据库仍只有一件,未被覆盖");
});

test("同键删除后重放:OPERATION_CONFLICT(已删除变体),不复活也不新建", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-d", "旧充电宝", "鞋柜"), t.deps);
  assert.equal(created.ok, true);
  var del = await handler({ action: "delete", item_id: created.item.item_id }, t.deps);
  assert.equal(del.ok, true);
  // 软删文档仍占用唯一索引;同键重放必须明确冲突而不是返回已删数据或新建
  var replay = await handler(createEvent("op-d", "旧充电宝", "鞋柜"), t.deps);
  assert.equal(replay.ok, false);
  assert.equal(replay.error, "OPERATION_CONFLICT");
  assert.ok(replay.message.indexOf("删除") !== -1, "提示应说明已删除");
  assert.equal(replay.existing, undefined, "已删记录不应作为 existing 下发");
  var raw = await rawItems(t.db);
  assert.equal(raw.data.length, 1, "未新建文档");
  assert.equal(raw.data[0].deleted, true, "原文档保持已删");
});

test("真并发创建(同键同内容):Promise.all 双请求,恰好一笔新建一笔 duplicated", async function () {
  var t = fresh();
  var results = await Promise.all([
    handler(createEvent("op-race", "体温计", "药箱"), t.deps),
    handler(createEvent("op-race", "体温计", "药箱"), t.deps),
  ]);
  // 两笔都先查后插:唯一索引拒绝第二笔,catch 回查后返回稳定结果
  var dupCount = results.filter(function (r) { return r.ok === true && r.duplicated === true; }).length;
  var newCount = results.filter(function (r) { return r.ok === true && r.duplicated === false; }).length;
  assert.equal(dupCount, 1, "应恰好一笔 duplicated");
  assert.equal(newCount, 1, "应恰好一笔新建");
  var raw = await rawItems(t.db);
  assert.equal(raw.data.length, 1, "库中只有一件");
});

test("真并发创建(同键异内容):Promise.all 双请求,一笔成功另一笔 OPERATION_CONFLICT", async function () {
  var t = fresh();
  var results = await Promise.all([
    handler(createEvent("op-race2", "体温计", "药箱"), t.deps),
    handler(createEvent("op-race2", "体温计", "客厅抽屉"), t.deps),
  ]);
  var okCount = results.filter(function (r) { return r.ok === true; }).length;
  var conflictCount = results.filter(function (r) { return r.ok === false && r.error === "OPERATION_CONFLICT"; }).length;
  assert.equal(okCount, 1);
  assert.equal(conflictCount, 1);
});

test("update 重放:同 update_id 的丢失响应重试返回 replayed,不误报版本冲突", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-u", "护照", "书房保险柜"), t.deps);
  var itemId = created.item.item_id;
  // 第一笔写入成功但响应丢失(客户端不知道)
  var lost = await handler(
    { action: "update", item_id: itemId, expected_version: 1, update_id: "upd-1", location_text: "卧室保险柜" },
    t.deps
  );
  assert.equal(lost.ok, true);
  assert.equal(lost.item.version, 2);
  // 同 update_id、同 expected_version 的重试:应识别为自己的重放
  var replay = await handler(
    { action: "update", item_id: itemId, expected_version: 1, update_id: "upd-1", location_text: "卧室保险柜" },
    t.deps
  );
  assert.equal(replay.ok, true, "重放应成功");
  assert.equal(replay.replayed, true, "应标记 replayed");
  assert.equal(replay.item.version, 2);
  assert.equal(replay.item.location_text, "卧室保险柜");
  // 不同 update_id 撞旧版本:才是真正的 VERSION_CONFLICT
  var other = await handler(
    { action: "update", item_id: itemId, expected_version: 1, update_id: "upd-2", location_text: "书房抽屉" },
    t.deps
  );
  assert.equal(other.ok, false);
  assert.equal(other.error, "VERSION_CONFLICT");
});

test("真并发修改:Promise.all 两笔不同 update_id 同 expected_version,恰好一笔成功", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-cu", "扳手", "工具箱"), t.deps);
  var itemId = created.item.item_id;
  var results = await Promise.all([
    handler({ action: "update", item_id: itemId, expected_version: 1, update_id: "cu-1", location_text: "阳台柜" }, t.deps),
    handler({ action: "update", item_id: itemId, expected_version: 1, update_id: "cu-2", location_text: "车库" }, t.deps),
  ]);
  var okCount = results.filter(function (r) { return r.ok === true; }).length;
  var conflictCount = results.filter(function (r) { return r.ok === false && r.error === "VERSION_CONFLICT"; }).length;
  assert.equal(okCount, 1, "恰好一笔成功");
  assert.equal(conflictCount, 1, "另一笔版本冲突");
  var raw = await rawItems(t.db);
  assert.equal(raw.data[0].version, 2, "落库 version 只加一次");
});

test("get:按 id 单查命中;越权与已删均 NOT_FOUND;不受 list 截断影响", async function () {
  var t = fresh();
  var oldest = null;
  for (var i = 1; i <= 55; i++) {
    var r = await handler(createEvent("op-g" + i, "备件" + String(i).padStart(2, "0"), "仓库第" + i + "格"), t.deps);
    if (i === 1) {
      oldest = r.item;
    }
  }
  // list 默认 50 条:最早的一条会被截断
  var list = await handler({ action: "list" }, t.deps);
  assert.equal(list.items.length, 50);
  assert.equal(list.items.some(function (s) { return s.item_id === oldest.item_id; }), false, "最早一条不在 list 里");
  // get 不受截断影响
  var got = await handler({ action: "get", item_id: oldest.item_id }, t.deps);
  assert.equal(got.ok, true);
  assert.equal(got.item.item_id, oldest.item_id);
  assert.equal(got.item.name, "备件01");
  // 越权:另一身份 get 得 NOT_FOUND
  var foreign = await handler({ action: "get", item_id: oldest.item_id }, makeDeps(t.db, HOUSEHOLD_B));
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, "NOT_FOUND");
  // 已删:get 不可见
  await handler({ action: "delete", item_id: oldest.item_id }, t.deps);
  var gotDeleted = await handler({ action: "get", item_id: oldest.item_id }, t.deps);
  assert.equal(gotDeleted.ok, false);
  assert.equal(gotDeleted.error, "NOT_FOUND");
});

test("重放内容校验:同 update_id 但内容不同,一律 VERSION_CONFLICT 绝不吞掉新内容", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-fp", "灭火器", "厨房角落"), t.deps);
  var itemId = created.item.item_id;
  // 第一笔写入成功(响应丢失)
  var lost = await handler(
    { action: "update", item_id: itemId, expected_version: 1, update_id: "fp-1", location_text: "阳台" },
    t.deps
  );
  assert.equal(lost.ok, true);
  // 同 update_id 但内容变了:不能当重放返回成功,必须报版本冲突
  var tampered = await handler(
    { action: "update", item_id: itemId, expected_version: 1, update_id: "fp-1", location_text: "车库" },
    t.deps
  );
  assert.equal(tampered.ok, false, "同 update_id 异内容必须失败");
  assert.equal(tampered.error, "VERSION_CONFLICT");
  var raw = await rawItems(t.db);
  assert.equal(raw.data[0].location_text, "阳台", "原写入内容无损");
  // 同 update_id 同内容:仍是合法重放
  var replay = await handler(
    { action: "update", item_id: itemId, expected_version: 1, update_id: "fp-1", location_text: "阳台" },
    t.deps
  );
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
});

// ---------- PR #17 三轮:真实响应丢失下的幂等恢复 ----------

test("响应丢失恢复:服务端已写入但客户端收到超时 → 原键原内容重试只产生一条记录", async function () {
  var t = fresh();
  // 第一次写入成功,但客户端没收到响应(超时)——服务端事实:已有一条
  var lost = await handler(createEvent("op-lost", "护照", "书房保险盒"), t.deps);
  assert.equal(lost.ok, true);
  // 客户端不知情,以原键原内容重试(批量保存失败行重试的真实形态)
  var retry = await handler(createEvent("op-lost", "护照", "书房保险盒"), t.deps);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicated, true, "原键原内容重试必须幂等返回 duplicated");
  var raw = await rawItems(t.db);
  assert.equal(raw.data.length, 1, "响应丢失 + 原键重试不得重复建档");
});

test("响应丢失恢复:重试时内容已改(同键异内容)→ OPERATION_CONFLICT 附已有记录,绝不静默建第二件", async function () {
  var t = fresh();
  await handler(createEvent("op-lost2", "护照", "书房保险盒"), t.deps);
  var res = await handler(createEvent("op-lost2", "护照", "玄关抽屉"), t.deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "OPERATION_CONFLICT");
  assert.ok(res.existing && res.existing.item_id, "冲突必须附已有记录供引导");
  var raw = await rawItems(t.db);
  assert.equal(raw.data.length, 1);
});

// ---------- issue #36 二阶段:提醒实体(独立 reminders 集合) ----------

var SHARED_HH = "hh_shared_reminders_1";

/** 共享家庭形态的 deps(index.js 解析为 shared 时注入的字段,双 marker 硬门依据) */
function makeSharedDeps(db) {
  var deps = makeDeps(db, SHARED_HH);
  deps.householdShared = true;
  deps.scopeRevision = 7;
  return deps;
}

/** 固定时钟 deps:remindComplete 的周期再生断言需要确定的「完成日」 */
function fixedDeps(db, isoNow) {
  var seq = 0;
  return {
    db: db,
    householdId: HOUSEHOLD_A,
    now: function () {
      return isoNow;
    },
    genId: function () {
      seq += 1;
      return "f" + seq;
    },
    logger: { log: function () {} }
  };
}

function rawReminders(db) {
  return db.collection("reminders").where({}).get();
}

function activeReminderRows(data) {
  return data.filter(function (r) {
    return r.status === "active";
  });
}

function remindEvent(opId, name, locationText, reminder) {
  return {
    action: "create",
    operation_id: opId,
    name: name,
    location_text: locationText,
    reminder: reminder
  };
}

test("提醒:create 带合法 reminder → item 与独立 reminders 文档同时建立,items 文档零污染", async function () {
  var t = fresh();
  var res = await handler(
    remindEvent("op-r1", "降压药", "厨房第二个抽屉", {
      due_date: "2026-11-20",
      kind: "有效期",
      quote: "11月20号过期"
    }),
    t.deps
  );
  assert.equal(res.ok, true);
  var raw = await rawReminders(t.db);
  assert.equal(raw.data.length, 1, "恰建一条提醒文档");
  var rd = raw.data[0];
  assert.ok(rd._id.indexOf("rd_") === 0, "提醒 _id 应以 rd_ 开头");
  assert.equal(rd.household_id, HOUSEHOLD_A, "提醒文档带服务端派生的家庭归属");
  assert.equal(rd.item_id, res.item.item_id, "提醒内部关联 item_id");
  assert.equal(rd.status, "active");
  assert.equal(rd.due_date, "2026-11-20");
  assert.equal(rd.kind, "有效期");
  assert.equal(rd.quote, "11月20号过期");
  assert.equal(typeof rd.created_at, "string");
  // 独立实体纪律:items 文档不被堆上任何提醒字段
  var items = await rawItems(t.db);
  assert.equal(items.data.length, 1);
  assert.equal(items.data[0].due_date, undefined, "items 文档不得出现提醒日期字段");
  assert.equal(items.data[0].reminder, undefined);
  assert.equal(items.data[0].kind, undefined);
});

test("提醒:不带 reminder 的 create 维持原行为,reminders 集合零写入(零回归)", async function () {
  var t = fresh();
  var res = await handler(createEvent("op-r0", "剪刀", "工具箱"), t.deps);
  assert.equal(res.ok, true);
  var raw = await rawReminders(t.db);
  assert.equal(raw.data.length, 0, "无提醒参数时不建提醒文档");
});

test("remindList:投影只有物品名/位置文本/due/kind/item_id,按 due_date 升序", async function () {
  var t = fresh();
  await handler(
    remindEvent("op-rl1", "滤芯", "厨房柜子", { due_date: "2026-12-01", kind: "下次维护" }),
    t.deps
  );
  await handler(
    remindEvent("op-rl2", "降压药", "药箱", { due_date: "2026-11-20", kind: "有效期", quote: "11月20号过期" }),
    t.deps
  );
  // 无提醒的物品不出现在提醒列表
  await handler(createEvent("op-rl3", "雨伞", "门口伞架"), t.deps);

  var res = await handler({ action: "remindList" }, t.deps);
  assert.equal(res.ok, true);
  assert.equal(res.household_id, HOUSEHOLD_A, "只读 action 响应携带服务端解析的 household_id");
  assert.equal(res.scope_revision, undefined, "个人家庭不带 scope_revision");
  assert.equal(res.reminders.length, 2);
  assert.deepEqual(
    Object.keys(res.reminders[0]).sort(),
    ["due_date", "generation", "item_id", "kind", "location_text", "name"],
    "行投影字段固定,不带 quote 与内部字段(PR #52 B1 增轮次号 generation)"
  );
  // 升序:11-20 在 12-01 之前
  assert.equal(res.reminders[0].name, "降压药");
  assert.equal(res.reminders[0].due_date, "2026-11-20");
  assert.equal(res.reminders[0].kind, "有效期");
  assert.equal(res.reminders[0].location_text, "药箱");
  assert.equal(res.reminders[1].name, "滤芯");
  assert.equal(res.reminders[1].due_date, "2026-12-01");

  // 跨家庭隔离:B 家庭的 remindList 看不到 A 的提醒
  var listB = await handler({ action: "remindList" }, makeDeps(t.db, HOUSEHOLD_B));
  assert.equal(listB.ok, true);
  assert.deepEqual(listB.reminders, [], "跨家庭提醒不可见");
});

test("日期格式拒绝:due_date 必须严格 YYYY-MM-DD 且真实日历日,失败 item 与 reminders 均零写入", async function () {
  var t = fresh();
  var badDates = [
    "2026-2-28", // 无补零
    "2026-11-2", // 日无补零
    "2026-02-30", // 不存在的日历日
    "2026-02-29", // 2026 非闰年
    "2026-13-01", // 月越界
    "2026-00-10", // 月为零
    "2026/11/20", // 斜杠分隔
    "2026-11-20T00:00:00Z", // 带时间
    "下个月", // 模糊表述(#36 纪律:绝不解析)
    "20261120" // 无分隔
  ];
  for (var i = 0; i < badDates.length; i++) {
    var res = await handler(
      remindEvent("op-bad-" + i, "物品", "某处", { due_date: badDates[i], kind: "有效期" }),
      t.deps
    );
    assert.equal(res.ok, false, "非法日期必须拒绝:" + badDates[i]);
    assert.equal(res.error, "INVALID_INPUT", "非法日期错误码:" + badDates[i]);
    assert.equal(typeof res.message, "string");
  }
  // 非字符串类型(数字)同样拒绝
  var numeric = await handler(
    remindEvent("op-bad-num", "物品", "某处", { due_date: 20261120, kind: "有效期" }),
    t.deps
  );
  assert.equal(numeric.error, "INVALID_INPUT");
  // 非法 kind(词表外)拒绝
  var badKind = await handler(
    remindEvent("op-bad-kind", "物品", "某处", { due_date: "2026-11-20", kind: "过期" }),
    t.deps
  );
  assert.equal(badKind.error, "INVALID_INPUT", "kind 必须在冻结词表内");
  var badKindEn = await handler(
    remindEvent("op-bad-kind2", "物品", "某处", { due_date: "2026-11-20", kind: "expiry" }),
    t.deps
  );
  assert.equal(badKindEn.error, "INVALID_INPUT");
  // quote 类型非法 / 超 200 码点拒绝
  var badQuote = await handler(
    remindEvent("op-bad-quote", "物品", "某处", { due_date: "2026-11-20", kind: "有效期", quote: 123 }),
    t.deps
  );
  assert.equal(badQuote.error, "INVALID_INPUT");
  var longQuote = await handler(
    remindEvent("op-bad-quote2", "物品", "某处", { due_date: "2026-11-20", kind: "有效期", quote: "字".repeat(201) }),
    t.deps
  );
  assert.equal(longQuote.error, "INVALID_INPUT");
  // reminder 非对象(直接传日期串)拒绝
  var badShape = await handler(remindEvent("op-bad-shape", "物品", "某处", "2026-11-20"), t.deps);
  assert.equal(badShape.error, "INVALID_INPUT");
  // 以上全部失败请求之后:items 与 reminders 一条都不能有
  assert.equal((await rawItems(t.db)).data.length, 0, "校验失败绝不写入 items");
  assert.equal((await rawReminders(t.db)).data.length, 0, "校验失败绝不写入 reminders");
});

test("日期格式:闰年真实日历日放行;quote 子串锚定在服务端放宽(客户端已核)", async function () {
  var t = fresh();
  // 2028 为闰年,02-29 是真实日历日
  var leap = await handler(
    remindEvent("op-leap", "证件", "书房抽屉", { due_date: "2028-02-29", kind: "下次维护" }),
    t.deps
  );
  assert.equal(leap.ok, true, "闰年 2 月 29 日合法");
  // quote 不必是任何原话的子串:服务端无从比对(锚定在确认页完成),只做类型与长度校验
  var relaxed = await handler(
    remindEvent("op-relax", "药膏", "药箱", { due_date: "2026-11-20", kind: "开封后", quote: "任意非原话文本也接受" }),
    t.deps
  );
  assert.equal(relaxed.ok, true, "quote 子串校验在服务端放宽");
  // 用户日期选择器来源:无 quote,落库为空字符串
  var noQuote = await handler(
    remindEvent("op-picker", "酱油", "厨房调味架", { due_date: "2027-03-01", kind: "开封后" }),
    t.deps
  );
  assert.equal(noQuote.ok, true);
  var raw = await rawReminders(t.db);
  var byOp = {};
  for (var i = 0; i < raw.data.length; i++) {
    byOp[raw.data[i].due_date] = raw.data[i];
  }
  assert.equal(byOp["2026-11-20"].quote, "任意非原话文本也接受");
  assert.equal(byOp["2027-03-01"].quote, "", "无 quote 落库为空字符串");
});

test("duplicated 收敛:同键原内容重试不重复建提醒,恰一条 active", async function () {
  var t = fresh();
  var reminder = { due_date: "2026-11-20", kind: "有效期", quote: "11月20号过期" };
  var first = await handler(remindEvent("op-rem-dup", "降压药", "药箱", reminder), t.deps);
  assert.equal(first.ok, true);
  assert.equal(first.duplicated, false);
  // 响应丢失后原键原内容重试(含同一 reminder)
  var second = await handler(remindEvent("op-rem-dup", "降压药", "药箱", reminder), t.deps);
  assert.equal(second.ok, true);
  assert.equal(second.duplicated, true);
  var raw = await rawReminders(t.db);
  assert.equal(activeReminderRows(raw.data).length, 1, "重试不得重复建提醒");
});

test("remindComplete(无周期):active 置 done 记 completed_at,历史保留;重复完成与无提醒均 NOT_FOUND", async function () {
  var t = fresh();
  var created = await handler(
    remindEvent("op-rc1", "滤芯", "厨房柜子", { due_date: "2026-12-01", kind: "下次维护" }),
    t.deps
  );
  var itemId = created.item.item_id;

  var done = await handler({ action: "remindComplete", item_id: itemId }, t.deps);
  assert.equal(done.ok, true);
  var raw = await rawReminders(t.db);
  assert.equal(raw.data.length, 1, "done 行保留(历史)");
  assert.equal(raw.data[0].status, "done");
  assert.equal(typeof raw.data[0].completed_at, "string", "完成时间落库");
  var listed = await handler({ action: "remindList" }, t.deps);
  assert.deepEqual(listed.reminders, [], "完成后提醒列表为空");

  // 已无 active:重复完成 → NOT_FOUND(列表刷新即收敛,绝不静默复活)
  var again = await handler({ action: "remindComplete", item_id: itemId }, t.deps);
  assert.equal(again.ok, false);
  assert.equal(again.error, "NOT_FOUND");
  // 不存在的物品 → NOT_FOUND
  var ghost = await handler({ action: "remindComplete", item_id: "it_ghost" }, t.deps);
  assert.equal(ghost.error, "NOT_FOUND");
  // 跨家庭:B 对 A 的物品完成 → NOT_FOUND
  var foreign = await handler({ action: "remindComplete", item_id: itemId }, makeDeps(t.db, HOUSEHOLD_B));
  assert.equal(foreign.error, "NOT_FOUND");
  // item_id 非法 → INVALID_INPUT
  var bad = await handler({ action: "remindComplete", item_id: "" }, t.deps);
  assert.equal(bad.error, "INVALID_INPUT");
});

test("remindComplete(带周期):新 active 提醒 due=完成日+周期,kind 为下次维护;跨月跨年进位正确", async function () {
  var db = createMemoryDb();
  var deps = fixedDeps(db, "2026-10-15T08:00:00.000Z"); // 完成日 2026-10-15
  var created = await handler(
    remindEvent("op-rc2", "滤芯", "厨房柜子", { due_date: "2026-10-20", kind: "有效期" }),
    deps
  );
  var itemId = created.item.item_id;

  var res = await handler({ action: "remindComplete", item_id: itemId, period_days: 30 }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.reminder.due_date, "2026-11-14", "2026-10-15 + 30 天 = 2026-11-14");
  assert.equal(res.reminder.kind, "下次维护", "周期再生的提醒为下次维护语义");
  assert.equal(res.reminder.item_id, itemId);
  assert.equal(res.reminder.name, "滤芯");

  var raw = await rawReminders(db);
  var active = activeReminderRows(raw.data);
  assert.equal(active.length, 1, "恰再生一条 active");
  assert.equal(active[0].due_date, "2026-11-14");
  assert.equal(active[0].kind, "下次维护");
  assert.equal(active[0].quote, "", "再生提醒无原话锚点");
  var doneRows = raw.data.filter(function (r) {
    return r.status === "done";
  });
  assert.equal(doneRows.length, 1, "原提醒置 done");
  assert.equal(doneRows[0].due_date, "2026-10-20");
  assert.equal(doneRows[0].kind, "有效期", "done 行保留原类别");

  // 跨月进位:10-31 + 1 天 = 11-01;跨年进位:12-31 + 1 天 = 次年 01-01
  var db2 = createMemoryDb();
  var d2 = fixedDeps(db2, "2026-10-31T23:00:00.000Z");
  var c2 = await handler(remindEvent("op-rc3", "药膏", "药箱", { due_date: "2026-10-31", kind: "开封后" }), d2);
  var r2 = await handler({ action: "remindComplete", item_id: c2.item.item_id, period_days: 1 }, d2);
  assert.equal(r2.reminder.due_date, "2026-11-01", "月末 +1 天自然进位");

  var db3 = createMemoryDb();
  var d3 = fixedDeps(db3, "2026-12-31T10:00:00.000Z");
  var c3 = await handler(remindEvent("op-rc4", "日历", "书桌", { due_date: "2026-12-31", kind: "下次维护" }), d3);
  var r3 = await handler({ action: "remindComplete", item_id: c3.item.item_id, period_days: 1 }, d3);
  assert.equal(r3.reminder.due_date, "2027-01-01", "年末 +1 天跨年进位");

  // period_days 非法:负数 / 非整数 / 超护栏 → INVALID_INPUT 且零写入
  var t = fresh();
  var created4 = await handler(
    remindEvent("op-rc5", "剪刀", "工具箱", { due_date: "2026-11-01", kind: "下次维护" }),
    t.deps
  );
  for (var i = 0; i < ["30x", 30.5, -1, 3660].length; i++) {
    var bad = ["30x", 30.5, -1, 3660][i];
    var res4 = await handler({ action: "remindComplete", item_id: created4.item.item_id, period_days: bad }, t.deps);
    assert.equal(res4.ok, false, "非法 period_days 必须拒绝:" + bad);
    assert.equal(res4.error, "INVALID_INPUT");
  }
  assert.equal((await rawReminders(t.db)).data.length, 1, "非法参数零写入,原 active 无损");
  // period_days=0:显式不带周期,与缺省同义,不再生
  var zero = await handler({ action: "remindComplete", item_id: created4.item.item_id, period_days: 0 }, t.deps);
  assert.equal(zero.ok, true);
  assert.equal(zero.reminder, undefined, "period_days=0 不再生");
  assert.equal(activeReminderRows((await rawReminders(t.db)).data).length, 0);
});

test("remindClear:硬删该 item 的 active 提醒,done 历史保留,天然幂等", async function () {
  var t = fresh();
  var created = await handler(
    remindEvent("op-clr", "备用钥匙", "玄关抽屉", { due_date: "2026-11-20", kind: "下次维护" }),
    t.deps
  );
  // 先完成一次生成 done 历史,再建一条新 active
  await handler({ action: "remindComplete", item_id: created.item.item_id, period_days: 15 }, t.deps);
  assert.equal(activeReminderRows((await rawReminders(t.db)).data).length, 1);

  var cleared = await handler({ action: "remindClear", item_id: created.item.item_id }, t.deps);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.cleared, 1, "恰清掉一条 active");
  var raw = await rawReminders(t.db);
  assert.equal(activeReminderRows(raw.data).length, 0);
  assert.equal(raw.data.length, 1, "done 历史保留");
  assert.equal(raw.data[0].status, "done");

  var again = await handler({ action: "remindClear", item_id: created.item.item_id }, t.deps);
  assert.equal(again.ok, true, "无可清也是成功(幂等)");
  assert.equal(again.cleared, 0);

  var bad = await handler({ action: "remindClear", item_id: "" }, t.deps);
  assert.equal(bad.error, "INVALID_INPUT");
});

test("remindSet:无提醒的已有物品补录提醒(日期选择器来源),kind 缺省下次维护,quote 为空", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-set1", "酱油", "厨房调味架"), t.deps);
  assert.equal((await rawReminders(t.db)).data.length, 0, "先确认无提醒");

  var res = await handler(
    { action: "remindSet", item_id: created.item.item_id, due_date: "2027-03-01" },
    t.deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.reminder.item_id, created.item.item_id);
  assert.equal(res.reminder.name, "酱油");
  assert.equal(res.reminder.due_date, "2027-03-01");
  assert.equal(res.reminder.kind, "下次维护", "未携带 kind 时缺省「下次维护」");

  var raw = await rawReminders(t.db);
  assert.equal(raw.data.length, 1, "恰建一条提醒文档");
  assert.equal(raw.data[0].status, "active");
  assert.equal(raw.data[0].household_id, HOUSEHOLD_A);
  assert.equal(raw.data[0].due_date, "2027-03-01");
  assert.equal(raw.data[0].quote, "", "选择器来源无原话锚点");

  var listed = await handler({ action: "remindList" }, t.deps);
  assert.equal(listed.reminders.length, 1, "补录后提醒列表可见");
  assert.equal(listed.reminders[0].due_date, "2027-03-01");
});

test("remindSet 替换语义:已有 active 先清后建,每 item 至多一条 active,不堆积", async function () {
  var t = fresh();
  var created = await handler(
    remindEvent("op-set2", "滤芯", "厨房柜子", { due_date: "2026-11-01", kind: "有效期", quote: "11月1号到期" }),
    t.deps
  );
  var res = await handler(
    { action: "remindSet", item_id: created.item.item_id, due_date: "2026-12-10", kind: "开封后" },
    t.deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.reminder.due_date, "2026-12-10");
  assert.equal(res.reminder.kind, "开封后");
  var raw = await rawReminders(t.db);
  assert.equal(raw.data.length, 1, "旧 active 被替换删除,不堆积");
  assert.equal(activeReminderRows(raw.data).length, 1, "替换后恰一条 active");
  assert.equal(raw.data[0].due_date, "2026-12-10");
  assert.equal(raw.data[0].kind, "开封后");

  // 同一天重复设同一日子:再替换一次,仍只有一条
  var again = await handler(
    { action: "remindSet", item_id: created.item.item_id, due_date: "2026-12-10" },
    t.deps
  );
  assert.equal(again.ok, true);
  assert.equal(again.reminder.kind, "下次维护", "未携带 kind 缺省,不沿用旧 kind");
  assert.equal((await rawReminders(t.db)).data.length, 1, "重复设置不堆积");
});

test("remindSet 校验与归属:非法入参零写入;物品不存在/已删/跨家庭 NOT_FOUND", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-set3", "护照", "书房保险盒"), t.deps);
  var bad = [
    { due_date: "2026-11-32" },
    { due_date: "2026-02-30" },
    { due_date: "2026/11/20" },
    { due_date: "20261120" },
    { due_date: 20261120 },
    { due_date: undefined },
    { due_date: "2026-11-20", kind: "到期" },
    { due_date: "2026-11-20", quote: 123 },
    { due_date: "2026-11-20", quote: "字".repeat(201) }
  ];
  for (var i = 0; i < bad.length; i++) {
    var res = await handler(
      Object.assign({ action: "remindSet", item_id: created.item.item_id }, bad[i]),
      t.deps
    );
    assert.equal(res.ok, false, JSON.stringify(bad[i]));
    assert.equal(res.error, "INVALID_INPUT");
  }
  assert.equal((await rawReminders(t.db)).data.length, 0, "非法参数零写入");

  var ghost = await handler({ action: "remindSet", item_id: "it_ghost", due_date: "2026-11-20" }, t.deps);
  assert.equal(ghost.error, "NOT_FOUND");
  var foreign = await handler(
    { action: "remindSet", item_id: created.item.item_id, due_date: "2026-11-20" },
    makeDeps(t.db, HOUSEHOLD_B)
  );
  assert.equal(foreign.error, "NOT_FOUND", "跨家庭物品不可设提醒");
  var noId = await handler({ action: "remindSet", item_id: "", due_date: "2026-11-20" }, t.deps);
  assert.equal(noId.error, "INVALID_INPUT");

  await handler({ action: "delete", item_id: created.item.item_id }, t.deps);
  var del = await handler({ action: "remindSet", item_id: created.item.item_id, due_date: "2026-11-20" }, t.deps);
  assert.equal(del.error, "NOT_FOUND", "已删物品不可设提醒");
  assert.equal((await rawReminders(t.db)).data.length, 0, "全程零提醒写入");
});

test("级联:delete 物品时其 active 提醒一并清掉,done 历史保留,他件提醒不受影响", async function () {
  var t = fresh();
  var doomed = await handler(
    remindEvent("op-cas1", "旧合同", "阳台纸箱", { due_date: "2026-11-01", kind: "下次维护" }),
    t.deps
  );
  var keeper = await handler(
    remindEvent("op-cas2", "新合同", "书房柜子", { due_date: "2026-12-01", kind: "下次维护" }),
    t.deps
  );
  // doomed 再周期再生一条 active:级联应把两条 active 全清、done 保留
  await handler({ action: "remindComplete", item_id: doomed.item.item_id, period_days: 20 }, t.deps);

  var del = await handler({ action: "delete", item_id: doomed.item.item_id }, t.deps);
  assert.equal(del.ok, true);

  var raw = await rawReminders(t.db);
  var doomedRows = raw.data.filter(function (r) {
    return r.item_id === doomed.item.item_id;
  });
  assert.equal(activeReminderRows(doomedRows).length, 0, "已删物品不得残留 active 提醒");
  assert.equal(doomedRows.length, 1, "done 历史保留");
  assert.equal(doomedRows[0].status, "done");

  var listed = await handler({ action: "remindList" }, t.deps);
  assert.equal(listed.reminders.length, 1, "提醒列表只剩未删物品的提醒");
  assert.equal(listed.reminders[0].item_id, keeper.item.item_id);
});

test("remindList 读侧容忍:悬挂提醒行(物品已删/不存在)跳过不展示", async function () {
  var t = fresh();
  var created = await handler(
    remindEvent("op-dangle", "滤芯", "厨房柜子", { due_date: "2026-12-01", kind: "下次维护" }),
    t.deps
  );
  // 模拟级联失效的悬挂形态:直接给不存在的物品手插一条 active 提醒
  await t.db.collection("reminders").add({
    data: {
      _id: "rd_dangling",
      household_id: HOUSEHOLD_A,
      item_id: "it_missing",
      status: "active",
      due_date: "2026-01-01",
      kind: "有效期",
      quote: "",
      created_at: "2026-10-01T00:00:00.000Z"
    }
  });
  var listed = await handler({ action: "remindList" }, t.deps);
  assert.equal(listed.ok, true);
  assert.equal(listed.reminders.length, 1, "悬挂行读侧容忍跳过");
  assert.equal(listed.reminders[0].item_id, created.item.item_id);
});

test("双 marker 硬门:共享家庭 remindComplete/remindClear 缺或错 marker 零写入,一致才放行", async function () {
  var db = createMemoryDb();
  var deps = makeSharedDeps(db); // householdShared:true, scopeRevision:7

  // create 带提醒本身也走硬门:缺 marker → FAMILY_SWITCHED,item 与 reminder 均零写入
  var noMarkerCreate = await handler(
    remindEvent("op-gate-0", "滤芯", "厨房柜子", { due_date: "2026-12-01", kind: "下次维护" }),
    deps
  );
  assert.equal(noMarkerCreate.ok, false);
  assert.equal(noMarkerCreate.error, "FAMILY_SWITCHED");
  assert.equal((await rawItems(db)).data.length, 0, "硬门拒绝零写入 items");
  assert.equal((await rawReminders(db)).data.length, 0, "硬门拒绝零写入 reminders");

  // 一致双 marker 建 item + 提醒(marker 在 event 上,checkWriteScopeBinding 只读 event)
  var gatedEvent = remindEvent("op-gate-1", "滤芯", "厨房柜子", { due_date: "2026-12-01", kind: "下次维护" });
  gatedEvent.expected_household_id = SHARED_HH;
  gatedEvent.expected_scope_revision = 7;
  var created = await handler(gatedEvent, deps);
  assert.equal(created.ok, true, JSON.stringify(created));
  var itemId = created.item.item_id;

  // remindComplete 缺 expected_household_id → FAMILY_SWITCHED,零写入
  var noMarker = await handler({ action: "remindComplete", item_id: itemId, period_days: 30 }, deps);
  assert.equal(noMarker.ok, false);
  assert.equal(noMarker.error, "FAMILY_SWITCHED");
  // household 一致但缺 scope_revision → FAMILY_STALE_SCOPE
  var noRev = await handler(
    { action: "remindComplete", item_id: itemId, period_days: 30, expected_household_id: SHARED_HH },
    deps
  );
  assert.equal(noRev.error, "FAMILY_STALE_SCOPE");
  // 旧修订号 → FAMILY_STALE_SCOPE(成员变更后的旧请求)
  var staleRev = await handler(
    { action: "remindComplete", item_id: itemId, period_days: 30, expected_household_id: SHARED_HH, expected_scope_revision: 6 },
    deps
  );
  assert.equal(staleRev.error, "FAMILY_STALE_SCOPE");
  // marker 类型非法 → INVALID_INPUT
  var badType = await handler(
    { action: "remindComplete", item_id: itemId, expected_household_id: 123, expected_scope_revision: 7 },
    deps
  );
  assert.equal(badType.error, "INVALID_INPUT");
  // 以上全部拒绝后:提醒原样无损
  assert.equal(activeReminderRows((await rawReminders(db)).data).length, 1, "硬门拒绝必须零写入");

  // remindClear 同款硬门
  var noMarkerClear = await handler({ action: "remindClear", item_id: itemId }, deps);
  assert.equal(noMarkerClear.error, "FAMILY_SWITCHED");
  var staleClear = await handler(
    { action: "remindClear", item_id: itemId, expected_household_id: SHARED_HH, expected_scope_revision: 3 },
    deps
  );
  assert.equal(staleClear.error, "FAMILY_STALE_SCOPE");
  assert.equal(activeReminderRows((await rawReminders(db)).data).length, 1, "清除同样零写入");

  // remindSet 同款硬门:缺 marker → FAMILY_SWITCHED 零写入;一致双 marker 放行(替换语义)
  var noMarkerSet = await handler({ action: "remindSet", item_id: itemId, due_date: "2026-12-15" }, deps);
  assert.equal(noMarkerSet.error, "FAMILY_SWITCHED");
  assert.equal(activeReminderRows((await rawReminders(db)).data).length, 1, "硬门拒绝必须零写入");
  var okSet = await handler(
    { action: "remindSet", item_id: itemId, due_date: "2026-12-15", expected_household_id: SHARED_HH, expected_scope_revision: 7 },
    deps
  );
  assert.equal(okSet.ok, true, JSON.stringify(okSet));
  assert.equal(activeReminderRows((await rawReminders(db)).data).length, 1, "替换后仍恰一条 active");

  // remindList 只读不参与校验,响应带共享域作用域字段(marker 捕获来源)
  var listed = await handler({ action: "remindList" }, deps);
  assert.equal(listed.ok, true);
  assert.equal(listed.household_id, SHARED_HH);
  assert.equal(listed.scope_revision, 7, "共享家庭 remindList 附带 scope_revision");
  assert.equal(listed.reminders.length, 1);

  // 一致双 marker:完成放行
  var done = await handler(
    { action: "remindComplete", item_id: itemId, expected_household_id: SHARED_HH, expected_scope_revision: 7 },
    deps
  );
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(activeReminderRows((await rawReminders(db)).data).length, 0);

  // 个人家庭宽松口径:不带 marker 的提醒写操作零回归
  var t2 = fresh();
  var personal = await handler(
    remindEvent("op-gate-p", "药膏", "药箱", { due_date: "2026-11-20", kind: "开封后" }),
    t2.deps
  );
  assert.equal(personal.ok, true);
  var personalDone = await handler({ action: "remindComplete", item_id: personal.item.item_id }, t2.deps);
  assert.equal(personalDone.ok, true, "个人家庭提醒写操作维持宽松口径");
});

test("提醒日志脱敏:remindList 只记计数,绝不记物品名与日期明细", async function () {
  var db = createMemoryDb();
  var entries = [];
  var deps = {
    db: db,
    householdId: HOUSEHOLD_A,
    now: function () {
      return new Date(1760000000000).toISOString();
    },
    genId: function () {
      return "1";
    },
    logger: { log: function (e) { entries.push(e); } }
  };
  await handler(
    remindEvent("op-rlog", "隐私物品名", "隐私位置", { due_date: "2026-11-20", kind: "有效期", quote: "11月20号过期" }),
    deps
  );
  await handler({ action: "remindList" }, deps);
  var badComplete = await handler({ action: "remindComplete", item_id: "it_none" }, deps);

  assert.equal(badComplete.error, "NOT_FOUND");
  var dump = JSON.stringify(entries);
  assert.equal(dump.indexOf("隐私物品名"), -1, "日志不得出现物品名");
  assert.equal(dump.indexOf("隐私位置"), -1, "日志不得出现位置");
  assert.equal(dump.indexOf("2026-11-20"), -1, "日志不得出现提醒日期明细");
  assert.equal(dump.indexOf("11月20号"), -1, "日志不得出现提醒原话锚点");
  assert.equal(dump.indexOf(HOUSEHOLD_A), -1, "日志不得出现身份");
  for (var i = 0; i < entries.length; i++) {
    var keys = Object.keys(entries[i]).sort();
    assert.deepEqual(keys, ["action", "count", "error", "ms"], "日志字段只能是 action/error/ms/count");
  }
  var listEntry = entries.filter(function (e) {
    return e.action === "remindList";
  })[0];
  assert.equal(listEntry.count, 1, "remindList 只记行数计数");
});

test("提醒:缺 householdId 一律 UNAUTHORIZED(含提醒专属 action)", async function () {
  var db = createMemoryDb();
  var noIdentity = makeDeps(db, "");
  var r1 = await handler({ action: "remindList" }, noIdentity);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "UNAUTHORIZED");
  var r2 = await handler({ action: "remindComplete", item_id: "it_1" }, makeDeps(db, undefined));
  assert.equal(r2.error, "UNAUTHORIZED");
  var r3 = await handler({ action: "remindClear", item_id: "it_1" }, { db: db, logger: null });
  assert.equal(r3.error, "UNAUTHORIZED");
  assert.equal((await rawReminders(db)).data.length, 0, "无身份绝不写入");
});

test("提醒分页:active 提醒超过 100 条后 remindList 仍基于全量升序,不被单次 get 上限截断", async function () {
  var t = fresh();
  var TOTAL = 120;
  function dueFromIndex(i) {
    var d = new Date(Date.UTC(2027, 0, 1) + i * 86400000);
    var pad = function (n) {
      return n < 10 ? "0" + n : String(n);
    };
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }
  for (var i = 0; i < TOTAL; i++) {
    var res = await handler(
      remindEvent("op-rem-page-" + i, "备件" + String(i).padStart(3, "0"), "仓库", {
        due_date: dueFromIndex(i),
        kind: "下次维护"
      }),
      t.deps
    );
    assert.equal(res.ok, true);
  }
  // 未显式 limit 的裸 get 只能看到前 100 条(与云函数端行为一致),证明数据量确实越界
  var raw = await t.db.collection("reminders").where({}).get();
  assert.equal(raw.data.length, 100, "memoryDb 裸 get 模拟云函数端默认 100 条上限");

  var listed = await handler({ action: "remindList" }, t.deps);
  assert.equal(listed.ok, true);
  assert.equal(listed.reminders.length, TOTAL, "分页拉全量,120 条全部可见");
  assert.equal(listed.reminders[0].due_date, "2027-01-01", "最早到期在首位");
  assert.equal(listed.reminders[TOTAL - 1].due_date, "2027-04-30", "最晚到期在末位");
  for (var j = 1; j < listed.reminders.length; j++) {
    assert.ok(listed.reminders[j - 1].due_date <= listed.reminders[j].due_date, "due_date 全程非降序");
  }
});

// ---------- PR #52 复审 B1:提醒轮次号(generation)条件更新 ----------

/**
 * 包装 db:把第一笔 reminders 再生插入(_id 以 rg_ 开头)停在闸门上,
 * 模拟双身份(同家庭两设备)并发请求在「已置 done、尚未再生」窗口的真实交错;
 * 其余集合与操作全部直通。
 */
function parkFirstRegenAdd(db) {
  var releaseGate;
  var gate = new Promise(function (resolve) {
    releaseGate = resolve;
  });
  var parked = false;
  var wrapped = {
    collection: function (name) {
      var base = db.collection(name);
      if (name !== "reminders") {
        return base;
      }
      return {
        add: function (options) {
          var doc = options && options.data;
          if (!parked && doc && typeof doc._id === "string" && doc._id.indexOf("rg_") === 0) {
            parked = true;
            return gate.then(function () {
              return base.add(options);
            });
          }
          return base.add(options);
        },
        where: function (cond) {
          return base.where(cond);
        },
        doc: function (id) {
          return base.doc(id);
        }
      };
    }
  };
  return { db: wrapped, release: function () { releaseGate(); } };
}

/** 包装 db:reminders 的再生插入失败一次(基础设施故障注入),其余直通 */
function failFirstRegenAdd(db) {
  var failed = false;
  var wrapped = {
    collection: function (name) {
      var base = db.collection(name);
      if (name !== "reminders") {
        return base;
      }
      return {
        add: function (options) {
          var doc = options && options.data;
          if (!failed && doc && typeof doc._id === "string" && doc._id.indexOf("rg_") === 0) {
            failed = true;
            return Promise.reject(new Error("injected regen add failure"));
          }
          return base.add(options);
        },
        where: function (cond) {
          return base.where(cond);
        },
        doc: function (id) {
          return base.doc(id);
        }
      };
    }
  };
  return wrapped;
}

/** 第二台设备的 deps:同家庭、独立 genId 序列(双身份=同家庭两设备) */
function deviceDeps(db, tag) {
  var seq = 0;
  return {
    db: db,
    householdId: HOUSEHOLD_A,
    now: function () {
      return "2026-10-15T08:00:00.000Z";
    },
    genId: function () {
      seq += 1;
      return tag + seq;
    },
    logger: { log: function () {} }
  };
}

test("B1 轮次号:remindList 行携带 generation,完成一轮后再生行轮次递增", async function () {
  var t = fresh();
  var created = await handler(
    remindEvent("op-b1-g0", "滤芯", "厨房柜子", { due_date: "2026-10-20", kind: "下次维护" }),
    t.deps
  );
  var itemId = created.item.item_id;
  var listed = await handler({ action: "remindList" }, t.deps);
  assert.equal(listed.reminders[0].generation, 1, "首轮提醒轮次号为 1");

  var done = await handler(
    { action: "remindComplete", item_id: itemId, expected_generation: 1, period_days: 30 },
    t.deps
  );
  assert.equal(done.ok, true);
  assert.equal(done.reminder.generation, 2, "再生行轮次号递增");

  listed = await handler({ action: "remindList" }, t.deps);
  assert.equal(listed.reminders[0].generation, 2);
  assert.equal(listed.reminders.length, 1, "恰一条 active");
});

test("B1 反例①(旧页顺序重放,不带周期):设备2 停在旧轮页点用完了 → VERSION_CONFLICT,新一轮无损", async function () {
  var t = fresh();
  var created = await handler(
    remindEvent("op-b1-a1", "滤芯", "厨房柜子", { due_date: "2026-10-20", kind: "下次维护" }),
    t.deps
  );
  var itemId = created.item.item_id;
  // 设备1:完成第 1 轮并按周期 30 再生第 2 轮
  var first = await handler(
    { action: "remindComplete", item_id: itemId, expected_generation: 1, period_days: 30 },
    t.deps
  );
  assert.equal(first.ok, true);
  assert.equal(first.reminder.generation, 2);

  // 设备2:还停在第 1 轮的旧页上点「用完了」(不带周期)
  var stale = await handler(
    { action: "remindComplete", item_id: itemId, expected_generation: 1 },
    t.deps
  );
  assert.equal(stale.ok, false, "旧轮请求必须被拦下");
  assert.equal(stale.error, "VERSION_CONFLICT");
  assert.equal(typeof stale.message, "string");

  // 新一轮无损:仍恰一条 active、轮次 2、日期未被旧页动过
  var raw = await rawReminders(t.db);
  var active = activeReminderRows(raw.data);
  assert.equal(active.length, 1, "旧页重放绝不动新一轮");
  assert.equal(active[0].generation, 2);
  assert.equal(active[0].kind, "下次维护");
  assert.equal(active[0].quote, "");
  assert.equal(raw.data.filter(function (r) { return r.status === "done"; }).length, 1, "原轮 done 恰一条");
});

test("B1 重放收敛:响应丢失后同参重试(同轮同周期)→ 幂等成功;换周期 → 显式冲突", async function () {
  var t = fresh();
  var created = await handler(
    remindEvent("op-b1-a2", "滤芯", "厨房柜子", { due_date: "2026-10-20", kind: "下次维护" }),
    t.deps
  );
  var itemId = created.item.item_id;
  await handler({ action: "remindComplete", item_id: itemId, expected_generation: 1, period_days: 30 }, t.deps);

  // 响应丢失后原样重试(同轮次同周期):幂等收敛成功,不重复再生
  var replay = await handler(
    { action: "remindComplete", item_id: itemId, expected_generation: 1, period_days: 30 },
    t.deps
  );
  assert.equal(replay.ok, true, "同参重放收敛成功");
  assert.equal(replay.replayed, true);
  assert.equal(replay.reminder.generation, 2);
  var raw = await rawReminders(t.db);
  assert.equal(activeReminderRows(raw.data).length, 1, "重放不得再生第二条");
  assert.equal(raw.data.filter(function (r) { return r.status === "done"; }).length, 1);

  // 同轮但换周期:与当时完成意图不一致 → 显式冲突,绝不猜
  var changed = await handler(
    { action: "remindComplete", item_id: itemId, expected_generation: 1, period_days: 90 },
    t.deps
  );
  assert.equal(changed.ok, false);
  assert.equal(changed.error, "VERSION_CONFLICT");
  assert.equal(activeReminderRows((await rawReminders(t.db)).data).length, 1, "换周期重试零写入");
});

test("B1 反例②(双身份并发,deferred 交错):同轮两请求并发 → 都成功收敛,恰一条 active、同轮至多再生一次", async function () {
  // reminders 集合声明 _id 唯一索引:确定性再生 _id 的并发双插由集合拒绝(与线上一致)
  var db = createMemoryDb({ uniqueIndexes: { reminders: [["_id"]] } });
  var dev1 = deviceDeps(db, "d1");
  var created = await handler(
    remindEvent("op-b1-c1", "滤芯", "厨房柜子", { due_date: "2026-10-20", kind: "下次维护" }),
    dev1
  );
  var itemId = created.item.item_id;

  var park = parkFirstRegenAdd(db);
  var dev1Parked = deviceDeps(park.db, "p1");
  var dev2 = deviceDeps(park.db, "p2");
  var event = { action: "remindComplete", item_id: itemId, expected_generation: 1, period_days: 30 };

  // 设备1:命中第 1 轮置 done,再生插入被闸门停住(窗口:已 done、未再生)
  var req1 = handler(event, dev1Parked);
  await new Promise(function (r) {
    setTimeout(r, 0);
  }); // 让 req1 走到停点
  // 设备2:同轮并发请求——条件更新命中 0 条,无 active 且该轮 done 行带欠账 → 治愈补建
  var res2 = await handler(event, dev2);
  assert.equal(res2.ok, true, "并发孪生治愈补建成功");
  assert.equal(res2.reminder.generation, 2);

  // 放行设备1 的再生插入:确定性 _id 撞上孪生的同轮再生行 → 收敛成功
  park.release();
  var res1 = await req1;
  assert.equal(res1.ok, true, "设备1 撞重复键后收敛成功,绝不假装失败");
  assert.equal(res1.reminder.generation, 2);
  assert.equal(res1.reminder.due_date, res2.reminder.due_date, "两请求收敛到同一条再生行");

  var raw = await rawReminders(db);
  assert.equal(activeReminderRows(raw.data).length, 1, "并发后仍至多一条 active");
  assert.equal(raw.data.filter(function (r) { return r.status === "done"; }).length, 1, "同一轮至多完成一次");
  assert.equal(activeReminderRows(raw.data)[0]._id.indexOf("rg_") === 0, true, "再生行确定性 _id");
});

test("B1 故障注入:再生插入失败 → 如实上抛不假装完成;欠账标记落库,同参重试治愈恢复(日期不漂移)", async function () {
  var db = createMemoryDb({ uniqueIndexes: { reminders: [["_id"]] } });
  var deps = deviceDeps(failFirstRegenAdd(db), "f1");
  var created = await handler(
    remindEvent("op-b1-f1", "滤芯", "厨房柜子", { due_date: "2026-10-20", kind: "下次维护" }),
    deviceDeps(db, "f0")
  );
  var itemId = created.item.item_id;
  var event = { action: "remindComplete", item_id: itemId, expected_generation: 1, period_days: 30 };

  // 再生插入失败:基础设施错误如实上抛,绝不返回假装的 ok
  await assert.rejects(
    function () {
      return handler(event, deps);
    },
    /injected regen add failure/,
    "再生失败必须可识别(上抛),不得假装完成"
  );

  // 状态如实:该轮已 done 且带欠账标记(due 已按完成时基准算好)
  var raw = await rawReminders(db);
  assert.equal(activeReminderRows(raw.data).length, 0, "再生未落地,无 active");
  var doneRow = raw.data.filter(function (r) { return r.status === "done"; })[0];
  assert.equal(doneRow.next_period_days, 30, "欠账标记记周期");
  assert.equal(doneRow.next_due, "2026-11-14", "欠账标记记完成时算好的下次日期");

  // 同参重试:命中欠账 → 治愈补建,恢复路径闭环;日期用欠账里记的原值,不随治愈时间漂移
  var healed = await handler(event, deviceDeps(db, "f2"));
  assert.equal(healed.ok, true, "同参重试走治愈路径恢复");
  assert.equal(healed.reminder.due_date, "2026-11-14", "治愈恢复的日期与完成时一致");
  assert.equal(healed.reminder.generation, 2);
  raw = await rawReminders(db);
  assert.equal(activeReminderRows(raw.data).length, 1);
});

test("B1 remindSet 旧页:改期带轮次条件,他人已更新 → VERSION_CONFLICT 绝不静默覆盖;补录(0)同理", async function () {
  var t = fresh();
  var created = await handler(
    remindEvent("op-b1-s1", "滤芯", "厨房柜子", { due_date: "2026-11-01", kind: "有效期" }),
    t.deps
  );
  var itemId = created.item.item_id;
  // 家人 A 在第 1 轮上改期 → 第 2 轮
  var setByA = await handler(
    { action: "remindSet", item_id: itemId, due_date: "2026-12-10", expected_generation: 1 },
    t.deps
  );
  assert.equal(setByA.ok, true);
  assert.equal(setByA.reminder.generation, 2, "改期后轮次递增");

  // 设备 B 停在第 1 轮旧页改期:命中不了第 1 轮 → 显式冲突,A 的新提醒无损
  var staleSet = await handler(
    { action: "remindSet", item_id: itemId, due_date: "2027-01-01", expected_generation: 1 },
    t.deps
  );
  assert.equal(staleSet.ok, false);
  assert.equal(staleSet.error, "VERSION_CONFLICT");
  var raw = await rawReminders(t.db);
  var active = activeReminderRows(raw.data);
  assert.equal(active.length, 1, "旧页改期零写入");
  assert.equal(active[0].due_date, "2026-12-10");
  assert.equal(active[0].generation, 2);

  // 旧页持第 1 轮做「补录」(expected_generation 0):已有提醒 → 显式冲突
  var staleAdd = await handler(
    { action: "remindSet", item_id: itemId, due_date: "2027-01-01", expected_generation: 0 },
    t.deps
  );
  assert.equal(staleAdd.error, "VERSION_CONFLICT");
  assert.equal(activeReminderRows((await rawReminders(t.db)).data).length, 1);

  // 持当前轮次(2)改期 → 成功,轮次递增为 3
  var freshSet = await handler(
    { action: "remindSet", item_id: itemId, due_date: "2027-01-05", expected_generation: 2 },
    t.deps
  );
  assert.equal(freshSet.ok, true);
  assert.equal(freshSet.reminder.generation, 3);
  assert.equal(activeReminderRows((await rawReminders(t.db)).data).length, 1);

  // expected_generation 非法(负数/非整数)→ INVALID_INPUT 零写入
  for (var i = 0; i < [-1, 1.5, "3"].length; i++) {
    var bad = await handler(
      { action: "remindSet", item_id: itemId, due_date: "2027-02-01", expected_generation: [-1, 1.5, "3"][i] },
      t.deps
    );
    assert.equal(bad.error, "INVALID_INPUT", "非法轮次号必须拒绝");
  }
  var badComplete = await handler(
    { action: "remindComplete", item_id: itemId, expected_generation: -2 },
    t.deps
  );
  assert.equal(badComplete.error, "INVALID_INPUT");
});

test("B1 remindClear 旧页:清除带轮次条件,他人已更新 → VERSION_CONFLICT 绝不静默删;清除后欠账作废不复活", async function () {
  var t = fresh();
  var created = await handler(
    remindEvent("op-b1-x1", "滤芯", "厨房柜子", { due_date: "2026-10-20", kind: "下次维护" }),
    t.deps
  );
  var itemId = created.item.item_id;
  // 完成第 1 轮并再生第 2 轮
  await handler({ action: "remindComplete", item_id: itemId, expected_generation: 1, period_days: 30 }, t.deps);

  // 旧页持第 1 轮清除:命中不了 → 显式冲突,第 2 轮无损
  var staleClear = await handler(
    { action: "remindClear", item_id: itemId, expected_generation: 1 },
    t.deps
  );
  assert.equal(staleClear.ok, false);
  assert.equal(staleClear.error, "VERSION_CONFLICT");
  var raw = await rawReminders(t.db);
  assert.equal(activeReminderRows(raw.data).length, 1, "旧页清除零写入");
  assert.equal(activeReminderRows(raw.data)[0].generation, 2);

  // 持当前轮次(2)清除 → 成功;done 行欠账一并作废(此后旧欠账不可被治愈复活)
  var cleared = await handler(
    { action: "remindClear", item_id: itemId, expected_generation: 2 },
    t.deps
  );
  assert.equal(cleared.ok, true);
  assert.equal(cleared.cleared, 1);
  raw = await rawReminders(t.db);
  assert.equal(activeReminderRows(raw.data).length, 0);
  var doneRow = raw.data.filter(function (r) { return r.status === "done"; })[0];
  assert.equal(doneRow.next_period_days, 0, "清除后欠账标记作废");
  // 已清除且欠账作废:旧轮完成请求不再治愈出任何提醒
  var zombie = await handler(
    { action: "remindComplete", item_id: itemId, expected_generation: 1, period_days: 30 },
    t.deps
  );
  assert.equal(zombie.ok, false);
  assert.equal(activeReminderRows((await rawReminders(t.db)).data).length, 0, "绝不复活已清除的提醒");
});
