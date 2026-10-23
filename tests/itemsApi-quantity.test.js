"use strict";

/**
 * Q1 基础数量(itemsApi,issue #102 / docs/design/quantity/Q0-CONTRACT.md):
 * 覆盖反例矩阵 §12-A(新建缺省/明确数量/非法值/单位)、§12-B(legacy 不生成
 * 库存事实;新旧客户端并存)、§12-H(数量 0 保留一切;删除≠归零)、§12-J
 * (quantity_confirmed_at 元数据纪律 + VERSION_CONFLICT current)、§12-G4
 * (create 同名不合并)、§12-F5(update 并发族)、photoCommit 数量形状门(§4.3)。
 * 红绿纪律:本文件在未实现数量的代码上必须失败,实现后全绿。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

var HOUSEHOLD_A = "hh_11111111111111111111111111111111";

function makeDeps(db, householdId) {
  var seq = 0;
  var clock = 1760000000000;
  return {
    db: db,
    householdId: householdId || HOUSEHOLD_A,
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

function fresh() {
  var db = createMemoryDb();
  return { db: db, deps: makeDeps(db) };
}

function createEvent(opId, over) {
  return Object.assign(
    {
      action: "create",
      operation_id: opId,
      name: "棉柔巾",
      location_text: "卫生间镜柜"
    },
    over || {}
  );
}

async function rawItems(db) {
  var res = await db.collection("items").where({}).get();
  return res.data || [];
}

/** 直插 pre-Q1 存量文档(无 quantity/unit,模拟 Q1 上线前的既有数据) */
async function seedLegacyItem(db, id, over) {
  var doc = Object.assign(
    {
      _id: id,
      household_id: HOUSEHOLD_A,
      name: "旧抽纸",
      name_norm: "旧抽纸",
      location_text: "客厅电视柜",
      note: "×3 备忘",
      version: 1,
      deleted: false,
      operation_id: "op-seed-" + id,
      remind_vague_quote: "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    },
    over || {}
  );
  await db.collection("items").add({ data: doc });
  return doc;
}

// ---------- §12-A:create 数量入参与校验 ----------

test("A1 create 不带 quantity(旧客户端)→ 落 1/件,confirmed_at 与 created_at 同刻;投影回读;原键重试 duplicated", async function () {
  var t = fresh();
  var res = await handler(createEvent("op-a1"), t.deps);
  assert.equal(res.ok, true);
  assert.equal(res.duplicated, false);
  assert.equal(res.item.quantity, 1);
  assert.equal(res.item.unit, "件");
  assert.equal(res.item.quantity_confirmed_at, res.item.updated_at, "新建即一次数量确认(缺省 1/件)");
  var docs = await rawItems(t.db);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].quantity, 1);
  assert.equal(docs[0].unit, "件");
  assert.equal(docs[0].quantity_confirmed_at, docs[0].created_at, "J1:确认时间与创建同刻");
  // 原键原内容(仍不带数量)重试 → duplicated 稳定返回
  var retry = await handler(createEvent("op-a1"), t.deps);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicated, true);
  assert.equal(retry.item.quantity, 1);
  assert.equal(retry.item.unit, "件");
});

test("A2 create {quantity:3, unit:'包'} → 落 3/包;重试同键同数量 duplicated", async function () {
  var t = fresh();
  var res = await handler(createEvent("op-a2", { quantity: 3, unit: "包" }), t.deps);
  assert.equal(res.ok, true);
  assert.equal(res.item.quantity, 3);
  assert.equal(res.item.unit, "包");
  var retry = await handler(createEvent("op-a2", { quantity: 3, unit: "包" }), t.deps);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicated, true);
  assert.equal(retry.item.quantity, 3);
});

test("A2b create 同键重试改数量 → OPERATION_CONFLICT(数量进幂等内容判断)", async function () {
  var t = fresh();
  await handler(createEvent("op-a2b", { quantity: 3, unit: "包" }), t.deps);
  var res = await handler(createEvent("op-a2b", { quantity: 4, unit: "包" }), t.deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "OPERATION_CONFLICT");
});

test("A3 create {quantity:0} → INVALID_INPUT,reason=QUANTITY_OUT_OF_RANGE,零写", async function () {
  var t = fresh();
  var res = await handler(createEvent("op-a3", { quantity: 0 }), t.deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "INVALID_INPUT");
  assert.equal(res.detail && res.detail.reason, "QUANTITY_OUT_OF_RANGE");
  assert.equal((await rawItems(t.db)).length, 0, "校验失败零写入");
});

test("A4 create quantity 非 number/非整数/显式 null → QUANTITY_NOT_INTEGER,零写", async function () {
  var t = fresh();
  var cases = [3.5, "3", null, NaN, true];
  for (var i = 0; i < cases.length; i++) {
    var res = await handler(createEvent("op-a4-" + i, { quantity: cases[i] }), t.deps);
    assert.equal(res.ok, false, "quantity=" + String(cases[i]) + " 必须拒绝");
    assert.equal(res.error, "INVALID_INPUT");
    assert.equal(res.detail && res.detail.reason, "QUANTITY_NOT_INTEGER");
  }
  assert.equal((await rawItems(t.db)).length, 0);
});

test("A5 create 越界(10000/-2)→ QUANTITY_OUT_OF_RANGE", async function () {
  var t = fresh();
  var over = await handler(createEvent("op-a5a", { quantity: 10000 }), t.deps);
  assert.equal(over.ok, false);
  assert.equal(over.detail && over.detail.reason, "QUANTITY_OUT_OF_RANGE");
  var under = await handler(createEvent("op-a5b", { quantity: -2 }), t.deps);
  assert.equal(under.ok, false);
  assert.equal(under.detail && under.detail.reason, "QUANTITY_OUT_OF_RANGE");
  assert.equal((await rawItems(t.db)).length, 0);
});

test("A6 create unit 闭集外('箱')/非字符串 → UNIT_UNSUPPORTED", async function () {
  var t = fresh();
  var res = await handler(createEvent("op-a6", { quantity: 3, unit: "箱" }), t.deps);
  assert.equal(res.ok, false);
  assert.equal(res.detail && res.detail.reason, "UNIT_UNSUPPORTED");
  var res2 = await handler(createEvent("op-a6b", { quantity: 3, unit: null }), t.deps);
  assert.equal(res2.ok, false);
  assert.equal(res2.detail && res2.detail.reason, "UNIT_UNSUPPORTED");
  assert.equal((await rawItems(t.db)).length, 0);
});

test("A7 create unit 在场而 quantity 缺席 → QUANTITY_UNIT_PAIR", async function () {
  var t = fresh();
  var res = await handler(createEvent("op-a7", { unit: "包" }), t.deps);
  assert.equal(res.ok, false);
  assert.equal(res.detail && res.detail.reason, "QUANTITY_UNIT_PAIR");
  assert.equal((await rawItems(t.db)).length, 0);
});

test("A2c create 显式 quantity:1/unit:'件' 与缺省同形;quantity 在场 unit 缺席 → 落 '件'", async function () {
  var t = fresh();
  var explicit = await handler(createEvent("op-a2c", { quantity: 1, unit: "件" }), t.deps);
  assert.equal(explicit.item.quantity, 1);
  assert.equal(explicit.item.unit, "件");
  var noUnit = await handler(createEvent("op-a2c2", { quantity: 3 }), t.deps);
  assert.equal(noUnit.item.quantity, 3);
  assert.equal(noUnit.item.unit, "件");
});

// ---------- §12-J:update 数量(设为当前总数) ----------

test("A8/J3 update {quantity:5, unit:'包'} 于 (3,件) 行 → 成功 5/包,version+1,confirmed_at 刷新", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-a8", { quantity: 3, unit: "件" }), t.deps);
  assert.equal(created.item.version, 1);
  var firstConfirmedAt = created.item.quantity_confirmed_at;
  await new Promise(function (r) {
    setTimeout(r, 5);
  });
  var res = await handler(
    {
      action: "update",
      item_id: created.item.item_id,
      expected_version: 1,
      update_id: "u-a8",
      quantity: 5,
      unit: "包"
    },
    t.deps
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.item.quantity, 5);
  assert.equal(res.item.unit, "包");
  assert.equal(res.item.version, 2);
  assert.ok(res.item.quantity_confirmed_at > firstConfirmedAt, "改单位=一次数量确认,刷新确认时间");
});

test("A9 update quantity/unit 只携其一 → QUANTITY_UNIT_PAIR,数量零写", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-a9", { quantity: 3, unit: "包" }), t.deps);
  var onlyQ = await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, quantity: 5 },
    t.deps
  );
  assert.equal(onlyQ.ok, false);
  assert.equal(onlyQ.detail && onlyQ.detail.reason, "QUANTITY_UNIT_PAIR");
  var onlyU = await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, unit: "盒" },
    t.deps
  );
  assert.equal(onlyU.ok, false);
  assert.equal(onlyU.detail && onlyU.detail.reason, "QUANTITY_UNIT_PAIR");
  var docs = await rawItems(t.db);
  assert.equal(docs[0].quantity, 3);
  assert.equal(docs[0].unit, "包");
  assert.equal(docs[0].version, 1, "零写:版本未推进");
});

test("update 数量非法值 → reason 枚举(-1/10000 → OUT_OF_RANGE;1.5/'5' → NOT_INTEGER;unit '箱' → UNIT_UNSUPPORTED)", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-av", { quantity: 3, unit: "包" }), t.deps);
  var bad = [
    [{ quantity: -1, unit: "包" }, "QUANTITY_OUT_OF_RANGE"],
    [{ quantity: 10000, unit: "包" }, "QUANTITY_OUT_OF_RANGE"],
    [{ quantity: 1.5, unit: "包" }, "QUANTITY_NOT_INTEGER"],
    [{ quantity: "5", unit: "包" }, "QUANTITY_NOT_INTEGER"],
    [{ quantity: 5, unit: "箱" }, "UNIT_UNSUPPORTED"]
  ];
  for (var i = 0; i < bad.length; i++) {
    var res = await handler(
      Object.assign({ action: "update", item_id: created.item.item_id, expected_version: 1 }, bad[i][0]),
      t.deps
    );
    assert.equal(res.ok, false, JSON.stringify(bad[i]));
    assert.equal(res.detail && res.detail.reason, bad[i][1]);
  }
});

test("J3b 名称/位置/备注 update 不触碰数量字段、不刷新确认时间", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-j3b", { quantity: 3, unit: "包" }), t.deps);
  var before = created.item.quantity_confirmed_at;
  var res = await handler(
    {
      action: "update",
      item_id: created.item.item_id,
      expected_version: 1,
      update_id: "u-j3b",
      name: "棉柔巾(加大)"
    },
    t.deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.item.quantity, 3);
  assert.equal(res.item.unit, "包");
  assert.equal(res.item.quantity_confirmed_at, before, "名称编辑不是数量确认");
});

test("J2 update 数量响应丢失 → 同 update_id 同 payload 重试 replayed:true;confirmed_at 仍是首次时刻", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-j2", { quantity: 3, unit: "包" }), t.deps);
  var first = await handler(
    {
      action: "update",
      item_id: created.item.item_id,
      expected_version: 1,
      update_id: "u-j2",
      quantity: 7,
      unit: "包"
    },
    t.deps
  );
  assert.equal(first.ok, true);
  assert.equal(first.item.version, 2);
  var firstConfirmedAt = first.item.quantity_confirmed_at;
  // 响应丢失:客户端以原 expected_version + 原 payload 重试
  var replay = await handler(
    {
      action: "update",
      item_id: created.item.item_id,
      expected_version: 1,
      update_id: "u-j2",
      quantity: 7,
      unit: "包"
    },
    t.deps
  );
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.replayed, true);
  assert.equal(replay.item.quantity, 7);
  assert.equal(replay.item.quantity_confirmed_at, firstConfirmedAt, "重放不刷新确认时间");
});

test("J2b 同 update_id 重试改数量 → VERSION_CONFLICT(指纹含 quantity/unit,绝不吞新内容)", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-j2b", { quantity: 3, unit: "包" }), t.deps);
  await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, update_id: "u-j2b", quantity: 7, unit: "包" },
    t.deps
  );
  var res = await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, update_id: "u-j2b", quantity: 8, unit: "包" },
    t.deps
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "VERSION_CONFLICT");
});

test("J5 update VERSION_CONFLICT 响应携带 current(最新完整投影含 quantity/unit/confirmed_at)", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-j5", { quantity: 3, unit: "包" }), t.deps);
  // 家人 A 先把数量改为 6(v2)
  await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, update_id: "u-j5-a", quantity: 6, unit: "包" },
    t.deps
  );
  // 用户 B 携过期 expected_version=1 → 冲突,响应带最新值
  var res = await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, update_id: "u-j5-b", quantity: 5, unit: "包" },
    t.deps
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "VERSION_CONFLICT");
  assert.ok(res.current, "冲突响应必须携带 current");
  assert.equal(res.current.item_id, created.item.item_id);
  assert.equal(res.current.version, 2);
  assert.equal(res.current.quantity, 6);
  assert.equal(res.current.unit, "包");
  assert.equal(typeof res.current.quantity_confirmed_at, "string");
});

test("F5 update 并发族回归:A 改数量成功后,B 携旧版本改名称 → VERSION_CONFLICT(数量并入指纹不破坏既有语义)", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-f5", { quantity: 5, unit: "包" }), t.deps);
  var a = await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, update_id: "u-f5-a", quantity: 7, unit: "包" },
    t.deps
  );
  assert.equal(a.ok, true);
  var b = await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, update_id: "u-f5-b", name: "新名字" },
    t.deps
  );
  assert.equal(b.ok, false);
  assert.equal(b.error, "VERSION_CONFLICT");
  // B 以刷新后的版本重试成功
  var b2 = await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 2, update_id: "u-f5-b", name: "新名字" },
    t.deps
  );
  assert.equal(b2.ok, true);
  assert.equal(b2.item.quantity, 7, "名称编辑不动数量");
});

// ---------- §12-B:legacy 不生成库存事实;新旧并存 ----------

test("B1 直插无 quantity/unit 存量文档 → get/query/list 投影三 null(可区分未确认,不显示误导值)", async function () {
  var t = fresh();
  await seedLegacyItem(t.db, "it-legacy-1");
  var got = await handler({ action: "get", item_id: "it-legacy-1" }, t.deps);
  assert.equal(got.ok, true);
  assert.equal(got.item.quantity, null);
  assert.equal(got.item.unit, null);
  assert.equal(got.item.quantity_confirmed_at, null);
  var queried = await handler({ action: "query", q: "旧抽纸" }, t.deps);
  assert.equal(queried.ok, true);
  assert.equal(queried.items.length, 1);
  assert.equal(queried.items[0].quantity, null);
  assert.equal(queried.items[0].unit, null);
  var listed = await handler({ action: "list" }, t.deps);
  assert.equal(listed.ok, true);
  assert.equal(listed.items[0].quantity, null);
  assert.equal(listed.items[0].unit, null);
  assert.equal(listed.items[0].quantity_confirmed_at, null);
});

test("B1b 存量行 note='×3 备忘' 不升格:投影仍 null,服务端绝不解析 note", async function () {
  var t = fresh();
  var doc = await seedLegacyItem(t.db, "it-legacy-2", { note: "×3 备忘" });
  assert.equal(doc.note, "×3 备忘");
  var got = await handler({ action: "get", item_id: "it-legacy-2" }, t.deps);
  assert.equal(got.item.quantity, null);
  assert.equal(got.item.note, "×3 备忘", "note 原样保留,一字不改");
});

test("J4 legacy 行的名称 update 后 quantity/unit/confirmed_at 三者仍缺(不回填)", async function () {
  var t = fresh();
  await seedLegacyItem(t.db, "it-legacy-4");
  var res = await handler(
    { action: "update", item_id: "it-legacy-4", expected_version: 1, update_id: "u-j4", name: "旧抽纸(改)" },
    t.deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.item.quantity, null);
  assert.equal(res.item.unit, null);
  assert.equal(res.item.quantity_confirmed_at, null);
  var docs = await rawItems(t.db);
  assert.equal(docs[0].quantity, undefined, "存储层三字段保持缺席");
  assert.equal(docs[0].unit, undefined);
  assert.equal(docs[0].quantity_confirmed_at, undefined);
});

test("J4b legacy 行首次核对:update {quantity:2, unit:'包'} 写入三字段(成组不变量)", async function () {
  var t = fresh();
  await seedLegacyItem(t.db, "it-legacy-5");
  var res = await handler(
    { action: "update", item_id: "it-legacy-5", expected_version: 1, update_id: "u-j4b", quantity: 2, unit: "包" },
    t.deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.item.quantity, 2);
  assert.equal(res.item.unit, "包");
  assert.equal(typeof res.item.quantity_confirmed_at, "string");
  var docs = await rawItems(t.db);
  assert.equal(docs[0].quantity, 2);
  assert.equal(docs[0].unit, "包");
});

test("B5 post-Q1 文档(缺省 1/件)+ 旧客户端原键重试(不带数量)→ duplicated", async function () {
  var t = fresh();
  await handler(createEvent("op-b5"), t.deps);
  var retry = await handler(createEvent("op-b5"), t.deps);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicated, true, "请求缺席数量命中 post-Q1 (1,件) 文档 → 同内容");
});

test("B5b post-Q1 文档(3/包)+ 旧客户端原键重试(不带数量)→ OPERATION_CONFLICT(不静默吞)", async function () {
  var t = fresh();
  await handler(createEvent("op-b5b", { quantity: 3, unit: "包" }), t.deps);
  var retry = await handler(createEvent("op-b5b"), t.deps);
  assert.equal(retry.ok, false);
  assert.equal(retry.error, "OPERATION_CONFLICT");
});

test("B6 pre-Q1 存量行 + 旧客户端原键重试(载荷无数量)→ duplicated(跨部署重放窗口)", async function () {
  var t = fresh();
  // pre-Q1 存量行:名字/位置/备注与旧客户端载荷一致,同 operation_id
  await seedLegacyItem(t.db, "it-preq1", {
    name: "棉柔巾",
    name_norm: "棉柔巾",
    location_text: "卫生间镜柜",
    note: "",
    operation_id: "op-b6"
  });
  var res = await handler(createEvent("op-b6"), t.deps);
  assert.equal(res.ok, true);
  assert.equal(res.duplicated, true, "请求缺席 + 文档未确认 → 同内容(跨部署窗口)");
  assert.equal(res.item.quantity, null);
});

test("B7 pre-Q1 存量行 + 新客户端原键重试携 quantity=2 → OPERATION_CONFLICT(内容不同绝不静默改)", async function () {
  var t = fresh();
  await seedLegacyItem(t.db, "it-preq1-7", {
    name: "棉柔巾",
    name_norm: "棉柔巾",
    location_text: "卫生间镜柜",
    note: "",
    operation_id: "op-b7"
  });
  var res = await handler(createEvent("op-b7", { quantity: 2, unit: "包" }), t.deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "OPERATION_CONFLICT");
});

test("J8 readQuantity 放宽分支:doc 有 quantity/unit 而无 confirmed_at → 已确认读 + confirmed_at:null(不丢数量)", async function () {
  var t = fresh();
  await seedLegacyItem(t.db, "it-j8", { quantity: 4, unit: "盒" });
  var got = await handler({ action: "get", item_id: "it-j8" }, t.deps);
  assert.equal(got.ok, true);
  assert.equal(got.item.quantity, 4);
  assert.equal(got.item.unit, "盒");
  assert.equal(got.item.quantity_confirmed_at, null);
});

test("B1c 存储异常防御:半态(quantity 无 unit)/越界/闭集外单位一律按未确认读(null),绝不伪造", async function () {
  var t = fresh();
  await seedLegacyItem(t.db, "it-b1c-a", { quantity: 4 });
  await seedLegacyItem(t.db, "it-b1c-b", { quantity: 10000, unit: "件" });
  await seedLegacyItem(t.db, "it-b1c-c", { quantity: 2, unit: "箱" });
  var a = await handler({ action: "get", item_id: "it-b1c-a" }, t.deps);
  var b = await handler({ action: "get", item_id: "it-b1c-b" }, t.deps);
  var c = await handler({ action: "get", item_id: "it-b1c-c" }, t.deps);
  assert.equal(a.item.quantity, null);
  assert.equal(b.item.quantity, null);
  assert.equal(c.item.quantity, null);
  assert.equal(c.item.unit, null);
});

// ---------- §12-H:数量 0 保留一切;删除≠归零 ----------

test("H1 update {quantity:0, unit:'包'} → 成功;item 未删、位置保留、提醒行保留、投影 quantity=0", async function () {
  var t = fresh();
  var created = await handler(
    createEvent("op-h1", {
      quantity: 3,
      unit: "包",
      reminder: { due_date: "2026-12-01", kind: "有效期" }
    }),
    t.deps
  );
  var res = await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, update_id: "u-h1", quantity: 0, unit: "包" },
    t.deps
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.item.quantity, 0);
  assert.equal(res.item.unit, "包");
  assert.equal(res.item.location_text, "卫生间镜柜");
  var reminders = await handler({ action: "remindList" }, t.deps);
  assert.equal(reminders.ok, true);
  var rows = reminders.reminders.filter(function (r) {
    return r.item_id === created.item.item_id;
  });
  assert.equal(rows.length, 1, "数量归零不删除提醒");
});

test("H2 quantity=0 行照常 query/list/get(未删,正常出现)", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-h2", { quantity: 2, unit: "包" }), t.deps);
  await handler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, quantity: 0, unit: "包" },
    t.deps
  );
  var queried = await handler({ action: "query", q: "棉柔巾" }, t.deps);
  assert.equal(queried.items.length, 1);
  assert.equal(queried.items[0].quantity, 0);
  var listed = await handler({ action: "list" }, t.deps);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].quantity, 0);
});

test("H6 quantity=0 行的 remindList/remindComplete 照常(数量与提醒零耦合;Q1 复审补锁)", async function () {
  var t = fresh();
  var created = await handler(
    createEvent("op-h6", {
      quantity: 3,
      unit: "包",
      reminder: { due_date: "2026-12-01", kind: "下次维护" }
    }),
    t.deps
  );
  var itemId = created.item.item_id;
  var zeroed = await handler(
    { action: "update", item_id: itemId, expected_version: 1, update_id: "u-h6", quantity: 0, unit: "包" },
    t.deps
  );
  assert.equal(zeroed.ok, true, JSON.stringify(zeroed));

  // 数量 0 的行:提醒照常列出、照常完成,绝不因归零被隐藏或拦截
  var listed = await handler({ action: "remindList" }, t.deps);
  assert.equal(listed.ok, true);
  var rows = listed.reminders.filter(function (r) {
    return r.item_id === itemId;
  });
  assert.equal(rows.length, 1, "quantity=0 行的 active 提醒照常出现在 remindList");

  var done = await handler({ action: "remindComplete", item_id: itemId }, t.deps);
  assert.equal(done.ok, true, "quantity=0 行的提醒照常可完成");

  var after = await handler({ action: "remindList" }, t.deps);
  assert.equal(after.reminders.length, 0, "完成后列表收敛(与数量无关的既有语义)");
  var doc = (await rawItems(t.db))[0];
  assert.equal(doc.quantity, 0, "完成提醒不触碰数量");
  assert.equal(doc.unit, "包");
  assert.equal(doc.deleted, false, "完成提醒绝不删物品");
});

test("H3/H4 delete 独立于数量:quantity=0 可删;delete 不触碰 quantity/unit 字段;数量非零不阻删", async function () {
  var t = fresh();
  var zero = await handler(createEvent("op-h3a", { quantity: 2, unit: "包" }), t.deps);
  await handler({ action: "update", item_id: zero.item.item_id, expected_version: 1, quantity: 0, unit: "包" }, t.deps);
  var delZero = await handler({ action: "delete", item_id: zero.item.item_id }, t.deps);
  assert.equal(delZero.ok, true);
  var many = await handler(createEvent("op-h3b", { quantity: 5, unit: "包" }), t.deps);
  var delMany = await handler({ action: "delete", item_id: many.item.item_id }, t.deps);
  assert.equal(delMany.ok, true, "删除不因数量非零受阻");
  var docs = await rawItems(t.db);
  var zeroDoc = docs.find(function (d) {
    return d._id === zero.item.item_id;
  });
  var manyDoc = docs.find(function (d) {
    return d._id === many.item.item_id;
  });
  assert.equal(zeroDoc.quantity, 0, "I3:delete 不触碰数量字段");
  assert.equal(zeroDoc.unit, "包");
  assert.equal(manyDoc.quantity, 5);
  assert.equal(manyDoc.unit, "包");
});

// ---------- §12-G4:create 同名不合并 ----------

test("G4 create 同名不同 operation_id 两笔 → 2 条独立 item(绝不按 name 查重合并)", async function () {
  var t = fresh();
  await handler(createEvent("op-g4a"), t.deps);
  await handler(createEvent("op-g4b"), t.deps);
  var docs = await rawItems(t.db);
  assert.equal(docs.length, 2);
});

// ---------- photoCommit(§4.3) ----------

function photo(fileId, box) {
  return {
    file_id: fileId,
    img_w: 100,
    img_h: 100,
    box: box === undefined ? null : box,
    source: "vl"
  };
}

test("PHOTO-Q1 photoCommit items[i] 携 quantity/unit → 逐件落库;单来源行 quantity=2 + box 保留合法(C4/C5)", async function () {
  var t = fresh();
  var res = await handler(
    {
      action: "photoCommit",
      batch_id: "batch-q1-a",
      items: [
        {
          operation_id: "op-pq-1",
          name: "洗衣液",
          location_text: "阳台储物柜",
          quantity: 2,
          unit: "瓶",
          photo: photo("cloud://env.bkt/photo-evidence/" + HOUSEHOLD_A + "/1-1.jpg", { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.5 })
        },
        { operation_id: "op-pq-2", name: "抹布", location_text: "阳台储物柜" }
      ]
    },
    t.deps
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results.length, 2);
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[1].ok, true);
  var docs = await rawItems(t.db);
  var wash = docs.find(function (d) {
    return d.operation_id === "op-pq-1";
  });
  var cloth = docs.find(function (d) {
    return d.operation_id === "op-pq-2";
  });
  assert.equal(wash.quantity, 2);
  assert.equal(wash.unit, "瓶");
  // 未携带数量的件走缺省 1/件
  assert.equal(cloth.quantity, 1);
  assert.equal(cloth.unit, "件");
});

test("PHOTO-Q1b photoCommit 任一件数量非法 → 整批 INVALID_INPUT 零写,detail.index 定位", async function () {
  var t = fresh();
  var cases = [
    { quantity: 0, reason: "QUANTITY_OUT_OF_RANGE", index: 0 },
    { quantity: 3.5, reason: "QUANTITY_NOT_INTEGER", index: 1 },
    { quantity: 2, unit: "箱", reason: "UNIT_UNSUPPORTED", index: 1 }
  ];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    var item = { operation_id: "op-pqb-" + i + "-a", name: "A", location_text: "厨房" };
    var item2 = { operation_id: "op-pqb-" + i + "-b", name: "B", location_text: "厨房" };
    if (c.index === 0) {
      item.quantity = c.quantity;
      if (c.unit) item.unit = c.unit;
    } else {
      item2.quantity = c.quantity;
      if (c.unit) item2.unit = c.unit;
    }
    var res = await handler(
      { action: "photoCommit", batch_id: "batch-pqb-" + i, items: [item, item2] },
      t.deps
    );
    assert.equal(res.ok, false, JSON.stringify(c));
    assert.equal(res.error, "INVALID_INPUT");
    assert.equal(res.detail && res.detail.reason, c.reason);
    assert.equal(res.detail && res.detail.index, c.index);
  }
  assert.equal((await rawItems(t.db)).length, 0, "整批零写入");
});

test("PHOTO-Q1c photoCommit unit 单独在场 → QUANTITY_UNIT_PAIR", async function () {
  var t = fresh();
  var res = await handler(
    {
      action: "photoCommit",
      batch_id: "batch-pqc",
      items: [{ operation_id: "op-pqc-1", name: "A", location_text: "厨房", unit: "包" }]
    },
    t.deps
  );
  assert.equal(res.ok, false);
  assert.equal(res.detail && res.detail.reason, "QUANTITY_UNIT_PAIR");
});

test("PHOTO-B9 pre-Q1 冻结载荷(note=×N 拼法,无 quantity)由新客户端重放 → 不注入数量,撞 duplicated 收敛", async function () {
  var t = fresh();
  // 旧客户端曾提交:note 由数量拼出,载荷无 quantity
  var legacyPayload = {
    operation_id: "op-b9",
    name: "垃圾袋",
    location_text: "厨房",
    note: "×2 卷",
    photo: photo("cloud://env.bkt/photo-evidence/" + HOUSEHOLD_A + "/9-1.jpg", null)
  };
  var first = await handler({ action: "photoCommit", batch_id: "batch-b9", items: [legacyPayload] }, t.deps);
  assert.equal(first.ok, true);
  // 响应丢失 → 新客户端以冻结载荷逐字节重试(仍无 quantity)
  var retry = await handler({ action: "photoCommit", batch_id: "batch-b9", items: [legacyPayload] }, t.deps);
  assert.equal(retry.ok, true);
  assert.equal(retry.results[0].ok, true);
  assert.equal(retry.results[0].duplicated, true, "原键原内容(含 note 形态)重放收敛");
  var docs = await rawItems(t.db);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].quantity, 1, "重试不注入数量;文档为缺省 1/件");
  assert.equal(docs[0].note, "×2 卷", "旧 note 原样保留");
});

test("PHOTO-Q1d photoCommit 原键重试改数量 → OPERATION_CONFLICT(数量进幂等内容)", async function () {
  var t = fresh();
  await handler(
    {
      action: "photoCommit",
      batch_id: "batch-q1d",
      items: [{ operation_id: "op-pq-d", name: "纸巾", location_text: "客厅", quantity: 2, unit: "盒" }]
    },
    t.deps
  );
  var res = await handler(
    {
      action: "photoCommit",
      batch_id: "batch-q1d",
      items: [{ operation_id: "op-pq-d", name: "纸巾", location_text: "客厅", quantity: 3, unit: "盒" }]
    },
    t.deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.results[0].ok, false);
  assert.equal(res.results[0].error, "OPERATION_CONFLICT");
});
