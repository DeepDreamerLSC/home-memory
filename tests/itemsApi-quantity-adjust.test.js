"use strict";

/**
 * Q2 语音数量操作(itemsApi.quantityAdjust,issue #102 / docs/design/quantity/
 * Q0-CONTRACT.md §7):统一 mode action(add/subtract/set)的版本 CAS、QA 指纹
 * 重放、失败关闭矩阵(§7.7)与家庭隔离(L9)。
 * 覆盖反例矩阵 §12-E9/E10/E13、§12-A10、§12-F1-F4(并发不覆盖/跨家庭/共享
 * 家庭双 marker)、§12-G1-G3(响应丢失重试最多生效一次/重放参数更改拒绝/结果
 * 不明绝不盲重减)、§12-J6(VERSION_CONFLICT 携带 current)、L2(set 0 保留一切)。
 * 红绿纪律:本文件在未实现 quantityAdjust 的代码上必须失败,实现后全绿。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

var HOUSEHOLD_A = "hh_11111111111111111111111111111111";
var HOUSEHOLD_B = "hh_22222222222222222222222222222222";
var SHARED_HH = "hh_shared_quantity_adjust";

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

/** 共享家庭形态 deps(双 marker 硬门) */
function sharedDeps(db) {
  var deps = makeDeps(db, SHARED_HH);
  deps.householdShared = true;
  deps.scopeRevision = 7;
  return deps;
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

function qa(over) {
  return Object.assign(
    {
      action: "quantityAdjust",
      item_id: "it-x",
      expected_version: 1,
      update_id: "qa-1",
      mode: "add",
      amount: 2
    },
    over || {}
  );
}

async function rawItems(db) {
  var res = await db.collection("items").where({}).get();
  return res.data || [];
}

/** 建 (5,包) 行并返回 item 投影 */
async function seeded(t, over) {
  var res = await handler(createEvent("op-seed", { quantity: 5, unit: "包" }, over), t.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.item;
}

/** 直插 pre-Q1 存量文档(无 quantity/unit = 数量未确认) */
async function seedLegacy(db, id) {
  await db.collection("items").add({
    data: {
      _id: id,
      household_id: HOUSEHOLD_A,
      name: "旧抽纸",
      name_norm: "旧抽纸",
      location_text: "客厅电视柜",
      note: "",
      version: 1,
      deleted: false,
      operation_id: "op-legacy-" + id,
      remind_vague_quote: "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    }
  });
}

// ---------- 基本算术与投影 ----------

test("ADD:(5,包) +2 → 7/包,version+1,confirmed_at 刷新,名称/位置不动", async function () {
  var t = fresh();
  var item = await seeded(t);
  var res = await handler(qa({ item_id: item.item_id, mode: "add", amount: 2 }), t.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.item.quantity, 7);
  assert.equal(res.item.unit, "包");
  assert.equal(res.item.version, 2);
  assert.equal(typeof res.item.quantity_confirmed_at, "string");
  assert.equal(res.item.name, "棉柔巾", "add 不改名称");
  assert.equal(res.item.location_text, "卫生间镜柜", "add 不改位置");
  assert.equal(res.replayed, undefined, "首次写入不标 replayed");
});

test("SUBTRACT:(5,包) -3 → 2/包;携带与当前一致 unit 放行", async function () {
  var t = fresh();
  var item = await seeded(t);
  var res = await handler(qa({ item_id: item.item_id, mode: "subtract", amount: 3, unit: "包" }), t.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.item.quantity, 2);
  assert.equal(res.item.unit, "包");
});

test("SET:(5,包) 设为 4 → 4/包,set 永不改 unit;不携 unit 合法(已确认行)", async function () {
  var t = fresh();
  var item = await seeded(t);
  var res = await handler(qa({ item_id: item.item_id, mode: "set", amount: 4 }), t.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.item.quantity, 4);
  assert.equal(res.item.unit, "包");
});

test("L2:set 0 → 成功;item 未删、位置保留、提醒保留、投影 quantity=0", async function () {
  var t = fresh();
  var created = await handler(
    createEvent("op-l2", {
      quantity: 3,
      unit: "包",
      reminder: { due_date: "2026-12-01", kind: "有效期" }
    }),
    t.deps
  );
  var res = await handler(qa({ item_id: created.item.item_id, mode: "set", amount: 0, unit: "包" }), t.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.item.quantity, 0);
  assert.equal(res.item.location_text, "卫生间镜柜", "归零不摘位置");
  var got = await handler({ action: "get", item_id: created.item.item_id }, t.deps);
  assert.equal(got.ok, true, "归零后行照常可读(未删除)");
  var reminders = await handler({ action: "remindList" }, t.deps);
  var rows = reminders.reminders.filter(function (r) {
    return r.item_id === created.item.item_id;
  });
  assert.equal(rows.length, 1, "数量归零不删除提醒");
});

test("9999 上限:9998+1 成功;9998+2 → QUANTITY_OVER_MAX 零写", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-max", { quantity: 9998, unit: "件" }), t.deps);
  var itemId = created.item.item_id;
  var ok = await handler(qa({ item_id: itemId, mode: "add", amount: 1 }), t.deps);
  assert.equal(ok.ok, true);
  assert.equal(ok.item.quantity, 9999);
  var over = await handler(
    qa({ item_id: itemId, expected_version: 2, mode: "add", amount: 2 }),
    t.deps
  );
  assert.equal(over.ok, false);
  assert.equal(over.error, "INVALID_INPUT");
  assert.equal(over.detail && over.detail.reason, "QUANTITY_OVER_MAX");
  var docs = await rawItems(t.db);
  assert.equal(docs[0].quantity, 9999, "越界零写");
  assert.equal(docs[0].version, 2);
});

// ---------- 纯参数形状(reason 映射,§7.2-1 复审冻结) ----------

test("PARAM_SHAPE:item_id/expected_version/update_id/mode 形状错 → detail.reason=PARAM_SHAPE", async function () {
  var t = fresh();
  var item = await seeded(t);
  var bad = [
    { item_id: "" },
    { item_id: 123 },
    { expected_version: 0 },
    { expected_version: "1" },
    { expected_version: 1.5 },
    { update_id: "" },
    { update_id: new Array(66).join("x") },
    { mode: "plus" },
    { mode: "ADD" }
  ];
  for (var i = 0; i < bad.length; i++) {
    var res = await handler(qa(Object.assign({ item_id: item.item_id }, bad[i])), t.deps);
    assert.equal(res.ok, false, JSON.stringify(bad[i]));
    assert.equal(res.error, "INVALID_INPUT");
    assert.equal(res.detail && res.detail.reason, "PARAM_SHAPE", JSON.stringify(bad[i]));
  }
  assert.equal((await rawItems(t.db)).length, 1, "形状错零写(不新增)");
});

test("amount 非整数/非 number/缺席 → QUANTITY_NOT_INTEGER(先类型后值域)", async function () {
  var t = fresh();
  var item = await seeded(t);
  var bad = ["2", 1.5, null, NaN, true];
  for (var i = 0; i < bad.length; i++) {
    var res = await handler(qa({ item_id: item.item_id, amount: bad[i] }), t.deps);
    assert.equal(res.ok, false, String(bad[i]));
    assert.equal(res.detail && res.detail.reason, "QUANTITY_NOT_INTEGER");
  }
  var absent = await handler(
    (function () {
      var e = qa({ item_id: item.item_id });
      delete e.amount;
      return e;
    })(),
    t.deps
  );
  assert.equal(absent.ok, false);
  assert.equal(absent.detail && absent.detail.reason, "QUANTITY_NOT_INTEGER");
});

test("E13 amount 越出 mode 值域(含 >9999)→ QUANTITY_OUT_OF_RANGE,绝不归 PARAM_SHAPE", async function () {
  var t = fresh();
  var item = await seeded(t);
  var cases = [
    { mode: "add", amount: 10000 },
    { mode: "add", amount: 0 },
    { mode: "add", amount: -2 },
    { mode: "subtract", amount: 10000 },
    { mode: "subtract", amount: 0 },
    { mode: "set", amount: 10000 },
    { mode: "set", amount: -1 }
  ];
  for (var i = 0; i < cases.length; i++) {
    var res = await handler(qa(Object.assign({ item_id: item.item_id }, cases[i])), t.deps);
    assert.equal(res.ok, false, JSON.stringify(cases[i]));
    assert.equal(res.error, "INVALID_INPUT");
    assert.equal(res.detail && res.detail.reason, "QUANTITY_OUT_OF_RANGE", JSON.stringify(cases[i]));
  }
  assert.equal((await rawItems(t.db))[0].quantity, 5, "值域错零写");
});

test("unit 参数:闭集外('箱'/null)→ UNIT_UNSUPPORTED;与当前不符 → UNIT_MISMATCH(A10)", async function () {
  var t = fresh();
  var item = await seeded(t);
  var unsupported = await handler(qa({ item_id: item.item_id, unit: "箱" }), t.deps);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.detail && unsupported.detail.reason, "UNIT_UNSUPPORTED");
  var nullUnit = await handler(qa({ item_id: item.item_id, unit: null }), t.deps);
  assert.equal(nullUnit.ok, false);
  assert.equal(nullUnit.detail && nullUnit.detail.reason, "UNIT_UNSUPPORTED");
  // A10:不同单位绝不默默叠加
  var mismatch = await handler(qa({ item_id: item.item_id, mode: "add", amount: 2, unit: "盒" }), t.deps);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.detail && mismatch.detail.reason, "UNIT_MISMATCH");
  assert.equal(mismatch.detail && mismatch.detail.current_unit, "包");
  var docs = await rawItems(t.db);
  assert.equal(docs[0].quantity, 5, "UNIT_MISMATCH 零写");
  assert.equal(docs[0].version, 1);
});

// ---------- 目标读取与未确认行(§7.2-2/3) ----------

test("E10 add/subtract 于未确认行(legacy 无字段)→ QUANTITY_UNCONFIRMED 附 current_quantity:null,零写", async function () {
  var t = fresh();
  await seedLegacy(t.db, "it-legacy-qa");
  var add = await handler(qa({ item_id: "it-legacy-qa", mode: "add", amount: 2 }), t.deps);
  assert.equal(add.ok, false);
  assert.equal(add.error, "INVALID_INPUT");
  assert.equal(add.detail && add.detail.reason, "QUANTITY_UNCONFIRMED");
  assert.equal(add.detail && add.detail.current_quantity, null);
  var sub = await handler(qa({ item_id: "it-legacy-qa", mode: "subtract", amount: 1 }), t.deps);
  assert.equal(sub.detail && sub.detail.reason, "QUANTITY_UNCONFIRMED");
  var docs = await rawItems(t.db);
  assert.equal(docs[0].version, 1, "未确认行零写");
  assert.equal(docs[0].quantity, undefined, "不回填数量");
});

test("set 于未确认行:未携 unit → UNIT_REQUIRED;携 unit → 首次确认成功(不换算)", async function () {
  var t = fresh();
  await seedLegacy(t.db, "it-legacy-set");
  var noUnit = await handler(qa({ item_id: "it-legacy-set", mode: "set", amount: 4 }), t.deps);
  assert.equal(noUnit.ok, false);
  assert.equal(noUnit.detail && noUnit.detail.reason, "UNIT_REQUIRED");
  var withUnit = await handler(
    qa({ item_id: "it-legacy-set", mode: "set", amount: 4, unit: "包" }),
    t.deps
  );
  assert.equal(withUnit.ok, true, JSON.stringify(withUnit));
  assert.equal(withUnit.item.quantity, 4);
  assert.equal(withUnit.item.unit, "包");
  assert.equal(withUnit.item.version, 2);
});

test("E9 subtract 结果 <0 → QUANTITY_BELOW_ZERO 附 current_quantity,零写(库存不足)", async function () {
  var t = fresh();
  var created = await handler(createEvent("op-e9", { quantity: 2, unit: "包" }), t.deps);
  var res = await handler(
    qa({ item_id: created.item.item_id, mode: "subtract", amount: 3, unit: "包" }),
    t.deps
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "INVALID_INPUT");
  assert.equal(res.detail && res.detail.reason, "QUANTITY_BELOW_ZERO");
  assert.equal(res.detail && res.detail.current_quantity, 2);
  var docs = await rawItems(t.db);
  assert.equal(docs[0].quantity, 2, "库存不足零写");
  assert.equal(docs[0].version, 1);
});

// ---------- NOT_FOUND 与家庭隔离(L9/F3) ----------

test("目标不存在 / 已删除 → NOT_FOUND 零写", async function () {
  var t = fresh();
  var missing = await handler(qa({ item_id: "it-nope" }), t.deps);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "NOT_FOUND");
  var created = await seeded(t);
  await handler({ action: "delete", item_id: created.item_id }, t.deps);
  var deleted = await handler(qa({ item_id: created.item_id }), t.deps);
  assert.equal(deleted.ok, false);
  assert.equal(deleted.error, "NOT_FOUND");
});

test("F3 跨家庭:目标是他家 item_id → NOT_FOUND,他家文档原样零写", async function () {
  var db = createMemoryDb();
  var depsA = makeDeps(db, HOUSEHOLD_A);
  var depsB = makeDeps(db, HOUSEHOLD_B);
  var createdB = await handler(createEvent("op-b-side"), depsB);
  assert.equal(createdB.ok, true);
  var res = await handler(qa({ item_id: createdB.item.item_id, mode: "add", amount: 2 }), depsA);
  assert.equal(res.ok, false);
  assert.equal(res.error, "NOT_FOUND", "跨家庭统一 NOT_FOUND,不泄露存在性");
  var docs = await rawItems(db);
  assert.equal(docs[0].quantity, 1, "他家文档零写");
});

test("F4 共享家庭:quantityAdjust 进 WRITE_ACTIONS,缺/错双 marker → FAMILY_SWITCHED/FAMILY_STALE_SCOPE 零写", async function () {
  var db = createMemoryDb();
  var deps = sharedDeps(db);
  var gated = createEvent("op-f4", { quantity: 5, unit: "包" });
  gated.expected_household_id = SHARED_HH;
  gated.expected_scope_revision = 7;
  var created = await handler(gated, deps);
  assert.equal(created.ok, true, JSON.stringify(created));
  var base = { item_id: created.item.item_id, expected_version: 1, update_id: "qa-f4", mode: "add", amount: 2 };
  var noMarker = await handler(Object.assign({ action: "quantityAdjust" }, base), deps);
  assert.equal(noMarker.ok, false);
  assert.equal(noMarker.error, "FAMILY_SWITCHED");
  var stale = await handler(
    Object.assign({ action: "quantityAdjust", expected_household_id: SHARED_HH, expected_scope_revision: 6 }, base),
    deps
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "FAMILY_STALE_SCOPE");
  var docs = await rawItems(db);
  assert.equal(docs[0].quantity, 5, "硬门拒绝零写");
  assert.equal(docs[0].version, 1);
  // 一致双 marker 放行
  var pass = await handler(
    Object.assign(
      { action: "quantityAdjust", expected_household_id: SHARED_HH, expected_scope_revision: 7 },
      base
    ),
    deps
  );
  assert.equal(pass.ok, true, JSON.stringify(pass));
  assert.equal(pass.item.quantity, 7);
});

// ---------- 并发与冲突(F1/F2/J6) ----------

test("F1/J6 双成员并发:A +2 成功;B 携旧 expected_version -1 → VERSION_CONFLICT 携带 current,绝不覆盖", async function () {
  var t = fresh();
  var item = await seeded(t);
  var a = await handler(
    qa({ item_id: item.item_id, update_id: "qa-f1-a", mode: "add", amount: 2 }),
    t.deps
  );
  assert.equal(a.ok, true);
  assert.equal(a.item.quantity, 7);
  // B 仍基于读到的 (5, v1) 请求 -1
  var b = await handler(
    qa({ item_id: item.item_id, update_id: "qa-f1-b", mode: "subtract", amount: 1 }),
    t.deps
  );
  assert.equal(b.ok, false);
  assert.equal(b.error, "VERSION_CONFLICT");
  assert.ok(b.current, "冲突响应必须携带 current 最新投影");
  assert.equal(b.current.item_id, item.item_id);
  assert.equal(b.current.version, 2);
  assert.equal(b.current.quantity, 7);
  assert.equal(b.current.unit, "包");
  assert.equal(typeof b.current.quantity_confirmed_at, "string");
  var docs = await rawItems(t.db);
  assert.equal(docs[0].quantity, 7, "后写不覆盖前写");
});

test("F2 B 冲突后刷新并显式重确认(新 update_id+expected_version=v2)→ 成功 6/v3", async function () {
  var t = fresh();
  var item = await seeded(t);
  await handler(qa({ item_id: item.item_id, update_id: "qa-f2-a", mode: "add", amount: 2 }), t.deps);
  var b = await handler(
    qa({
      item_id: item.item_id,
      update_id: "qa-f2-b",
      expected_version: 2,
      mode: "subtract",
      amount: 1
    }),
    t.deps
  );
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.item.quantity, 6);
  assert.equal(b.item.version, 3);
});

// ---------- 响应丢失重试与重放(G1/G2/G3,§7.5) ----------

test("G1 +2 成功响应丢失 → 同 update_id+expected_version+payload 重试 replayed:true,最多生效一次(7 不变 9)", async function () {
  var t = fresh();
  var item = await seeded(t);
  var first = await handler(
    qa({ item_id: item.item_id, update_id: "qa-g1", mode: "add", amount: 2 }),
    t.deps
  );
  assert.equal(first.ok, true);
  assert.equal(first.item.quantity, 7);
  var replay = await handler(
    qa({ item_id: item.item_id, update_id: "qa-g1", mode: "add", amount: 2 }),
    t.deps
  );
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.replayed, true);
  assert.equal(replay.item.quantity, 7, "重试不叠加");
  assert.equal(replay.item.version, 2);
});

test("G2 同 update_id 但 amount 2→3 重试 → VERSION_CONFLICT(指纹失配,绝不吞新内容)", async function () {
  var t = fresh();
  var item = await seeded(t);
  await handler(qa({ item_id: item.item_id, update_id: "qa-g2", mode: "add", amount: 2 }), t.deps);
  var res = await handler(
    qa({ item_id: item.item_id, update_id: "qa-g2", mode: "add", amount: 3 }),
    t.deps
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "VERSION_CONFLICT");
  var docs = await rawItems(t.db);
  assert.equal(docs[0].quantity, 7, "异内容重试零写");
});

test("G3 重试遇他人写入(结果不明)→ VERSION_CONFLICT + current;绝不盲重放旧 delta", async function () {
  var t = fresh();
  var item = await seeded(t);
  // +2 实际已生效,但响应丢失
  await handler(qa({ item_id: item.item_id, update_id: "qa-g3", mode: "add", amount: 2 }), t.deps);
  // 期间家人推进了版本(名称编辑)
  await handler(
    { action: "update", item_id: item.item_id, expected_version: 2, update_id: "u-g3", name: "棉柔巾(加大)" },
    t.deps
  );
  // 原参重试:结果不可知,必须 VERSION_CONFLICT 而非重放/误报成功
  var res = await handler(
    qa({ item_id: item.item_id, update_id: "qa-g3", mode: "add", amount: 2 }),
    t.deps
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "VERSION_CONFLICT");
  assert.ok(res.current);
  assert.equal(res.current.version, 3);
  assert.equal(res.current.quantity, 7, "没有二次 +2,也没有盲目回滚");
  assert.equal(res.current.name, "棉柔巾(加大)");
  var docs = await rawItems(t.db);
  assert.equal(docs[0].quantity, 7);
  assert.equal(docs[0].version, 3);
});

test("QA 指纹区分 mode:同 update_id 下 add 2 与 set 7 → VERSION_CONFLICT(§7.4)", async function () {
  var t = fresh();
  var item = await seeded(t);
  await handler(qa({ item_id: item.item_id, update_id: "qa-mode", mode: "add", amount: 2 }), t.deps);
  var res = await handler(
    qa({ item_id: item.item_id, update_id: "qa-mode", mode: "set", amount: 7 }),
    t.deps
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "VERSION_CONFLICT");
});

// ---------- 语义边界(§7.3) ----------

test("add 是数量调整不是新建:绝不新增文档;单 item 单操作(名称/备注不动)", async function () {
  var t = fresh();
  var item = await seeded(t);
  var before = (await rawItems(t.db)).length;
  var res = await handler(qa({ item_id: item.item_id, mode: "add", amount: 1 }), t.deps);
  assert.equal(res.ok, true);
  assert.equal((await rawItems(t.db)).length, before, "quantityAdjust 绝不新建 item");
});

test("set 于已确认行携带 unit 必须等于当前值:unit:'盒' 于 (5,包) → UNIT_MISMATCH", async function () {
  var t = fresh();
  var item = await seeded(t);
  var res = await handler(
    qa({ item_id: item.item_id, mode: "set", amount: 5, unit: "盒" }),
    t.deps
  );
  assert.equal(res.ok, false);
  assert.equal(res.detail && res.detail.reason, "UNIT_MISMATCH");
  assert.equal((await rawItems(t.db))[0].quantity, 5, "零写");
});
