"use strict";

/**
 * Q1 数量客户端纯函数(issue #102 / Q0-CONTRACT §2.2/§10/§4.3/§4.6):
 * UNIT_SET 双端逐字一致、displayNoteFor(§10.2 兜底)、数量槽文案(§10.1)、
 * 投影缺键归一(§2.4/B8)、photoCommit 载荷构建(note 不再由数量拼出;pre-Q1
 * 会话行逐字节重放不注入数量,B9)、行工厂单位缺省「件」、批量行 create 携带
 * 条件(rowQuantityInput)。
 * 被测对象是 `npm run build:mp` 产物(.ts → .js 成对提交)。
 * 红绿纪律:本文件在未实现数量的代码上必须失败,实现后全绿。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var quantity = require("../miniprogram/utils/quantity");
var serverHandlerExports = require("../cloudfunctions/itemsApi/lib/handler");
var intake = require("../miniprogram/utils/intake-draft");
var photoIntake = require("../miniprogram/utils/photo-intake");
var batchSave = require("../miniprogram/utils/batch-save");

// ---------- UNIT_SET 冻结闭集(§2.2:双端逐字一致,顺序即冻结顺序) ----------

test("UNIT_SET:客户端与服务端逐字一致(数组含顺序),字面量锁定 14 值", function () {
  var frozen = ["件", "个", "包", "盒", "瓶", "袋", "支", "双", "套", "卷", "张", "本", "罐", "只"];
  assert.deepEqual(quantity.UNIT_SET, frozen);
  assert.deepEqual(serverHandlerExports.UNIT_SET, frozen, "服务端导出必须与客户端镜像逐字一致");
});

// ---------- displayNoteFor(§10.2 兜底:并排表面的 ×N 剥离) ----------

test("displayNoteFor:未确认 → note 原样(旧 ×N 是仅有的信息,不隐藏不升格)", function () {
  assert.equal(quantity.displayNoteFor("×3 备忘", false), "×3 备忘");
  assert.equal(quantity.displayNoteFor("500ml 2号抽屉", false), "500ml 2号抽屉");
  assert.equal(quantity.displayNoteFor("", false), "");
});

test("displayNoteFor:已确认 + 旧形状 ^×N → 剥词元只展示后缀;默认占位/剥后空 → 整条不展示(B4)", function () {
  assert.equal(quantity.displayNoteFor("×3 备忘", true), "备忘");
  assert.equal(quantity.displayNoteFor("×3 备注", true), "");
  assert.equal(quantity.displayNoteFor("×3 2号抽屉", true), "2号抽屉");
  assert.equal(quantity.displayNoteFor("×3", true), "");
  assert.equal(quantity.displayNoteFor("× 3 备忘", true), "备忘", "× 与数字间可含空白");
});

test("displayNoteFor:已确认 + 非旧形状 → 原样(自由备注与数量无关,绝不含数字就隐藏)", function () {
  assert.equal(quantity.displayNoteFor("500ml 2号抽屉", true), "500ml 2号抽屉");
  assert.equal(quantity.displayNoteFor("2号抽屉那盒", true), "2号抽屉那盒");
});

// ---------- 数量槽文案(§10.1 冻结词表:已确认「×N单位」;未确认「待核对」) ----------

test("quantitySlotText:已确认 ×N单位(0 也如实);未确认「待核对」无数字", function () {
  assert.equal(quantity.quantitySlotText(3, "包"), "×3包");
  assert.equal(quantity.quantitySlotText(0, "包"), "×0包");
  assert.equal(quantity.quantitySlotText(1, "件"), "×1件");
  assert.equal(quantity.quantitySlotText(null, null), "待核对");
  assert.equal(quantity.quantitySlotText(undefined, undefined), "待核对", "旧服务端缺键等同未确认");
});

test("quantityConfirmedText:详情口径「上次确认 ×N单位」+ 确认时间后缀;缺失退化无时间", function () {
  assert.equal(quantity.quantityConfirmedText(3, "包", "2026-10-01T00:00:00.000Z"), "上次确认 ×3包 · 10-01");
  assert.equal(quantity.quantityConfirmedText(0, "包", null), "上次确认 ×0包");
  assert.equal(quantity.quantityConfirmedText(2, "盒", "不是日期"), "上次确认 ×2盒", "非法时间戳退化为无时间,不丢数量");
});

// ---------- 投影缺键归一(§2.4/B8:新客户端 × 旧服务端) ----------

test("normalizeQuantityFields:缺键/非法键归一 null;合法键透传", function () {
  assert.deepEqual(
    quantity.normalizeQuantityFields({ item_id: "a", name: "x" }),
    { item_id: "a", name: "x", quantity: null, unit: null, quantity_confirmed_at: null }
  );
  assert.deepEqual(
    quantity.normalizeQuantityFields({ item_id: "a", name: "x", quantity: 3, unit: "包", quantity_confirmed_at: "2026-10-01T00:00:00.000Z" }),
    { item_id: "a", name: "x", quantity: 3, unit: "包", quantity_confirmed_at: "2026-10-01T00:00:00.000Z" }
  );
  var half = quantity.normalizeQuantityFields({ item_id: "a", name: "x", quantity: 3 });
  assert.equal(half.quantity, null, "半态投影归一为未确认");
  assert.equal(half.unit, null);
});

// ---------- photoCommit 载荷构建(§4.3:note 不再由数量拼出;B9 不注入) ----------

function q1Row(over) {
  return Object.assign(
    {
      draftId: "d1",
      name: "薯片罐",
      qty: 2,
      suffix: "约罐",
      unit: "罐",
      qtyTouched: false,
      exc: null,
      src: "ai",
      confidence: "high",
      box: null,
      checked: true,
      done: false,
      failMsg: "",
      operationId: "op-pc-1",
    },
    over || {}
  );
}

/** pre-Q1 会话恢复的行:unit 字段缺席(旧版本会话没有数量组) */
function legacyRow(over) {
  var row = q1Row(over);
  delete row.unit;
  delete row.qtyTouched;
  return row;
}

test("buildPhotoCommitItems:Q1 行 → quantity/unit 进字段,note 不再由数量拼出(空则不携带)", function () {
  var items = photoIntake.buildPhotoCommitItems(
    [q1Row()],
    "客厅电视柜",
    { file_id: "cloud://e.b/p/x.jpg", img_w: 100, img_h: 100 }
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, 2);
  assert.equal(items[0].unit, "罐");
  assert.equal(items[0].note, undefined, "数量进字段后 note 绝不再拼 ×N");
});

test("buildPhotoCommitItems:pre-Q1 会话行(unit 缺席)→ 逐字节重放旧载荷形态(note=×N 拼法,无 quantity/unit)", function () {
  var items = photoIntake.buildPhotoCommitItems(
    [legacyRow()],
    "客厅电视柜",
    { file_id: "cloud://e.b/p/x.jpg", img_w: 100, img_h: 100 }
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].note, "×2 约罐", "旧会话行沿用旧拼法,保证原键原内容重试收敛");
  assert.equal(items[0].quantity, undefined, "绝不给 pre-Q1 会话载荷注入 quantity");
  assert.equal(items[0].unit, undefined);
});

test("buildPhotoCommitItems:Q1 行用户改过数量 → 提交最新值(用户触碰=确认)", function () {
  var items = photoIntake.buildPhotoCommitItems(
    [q1Row({ qty: 5, unit: "盒", qtyTouched: true })],
    "客厅电视柜",
    { file_id: "cloud://e.b/p/x.jpg", img_w: 100, img_h: 100 }
  );
  assert.equal(items[0].quantity, 5);
  assert.equal(items[0].unit, "盒");
});

// ---------- 行工厂与步进器(intake-draft:unit 缺省「件」,触碰标记) ----------

function seqGen() {
  var n = 0;
  return function () {
    n += 1;
    return "id-" + n;
  };
}

test("makeAiRow/makeManualRow:Q1 起入列即带 unit='件'(数量组随会话携带),qtyTouched=false", function () {
  var ai = intake.makeAiRow({ name: "薯片罐", qty_note: "约2罐", confidence: "high", box: null }, seqGen());
  assert.equal(ai.qty, 2);
  assert.equal(ai.unit, "件", "unit 只来自选择器,默认「件」;VL 原文『罐』不映射为 unit");
  assert.equal(ai.qtyTouched, false);
  var manual = intake.makeManualRow("垃圾袋", "", seqGen());
  assert.equal(manual.unit, "件");
  assert.equal(manual.qtyTouched, false);
});

test("stepRowQty:用户步进 → qty 更新且 qtyTouched=true;域内不变返回原引用语义不受影响", function () {
  var row = q1Row({ qty: 2 });
  var stepped = intake.stepRowQty(row, 1);
  assert.equal(stepped.qty, 3);
  assert.equal(stepped.qtyTouched, true, "触碰步进器=用户确认数量,待核对标记随之成立");
});

test("setRowUnit:单位选择器切换 → unit 更新且 qtyTouched=true;闭集外值拒绝(防御)", function () {
  var row = q1Row();
  var changed = intake.setRowUnit(row, "盒");
  assert.equal(changed.unit, "盒");
  assert.equal(changed.qtyTouched, true);
  assert.equal(intake.setRowUnit(row, "箱"), row, "闭集外单位原样返回,绝不写入");
});

// ---------- 批量行 create 携带条件(batch-save.rowQuantityInput) ----------

test("rowQuantityInput:draft 锚定到数量或用户触碰过 → 携带;否则 undefined(不注入)", function () {
  assert.deepEqual(
    batchSave.rowQuantityInput({ quantity: 3, unit: "包", quantityProvided: true }),
    { quantity: 3, unit: "包" }
  );
  assert.equal(
    batchSave.rowQuantityInput({ quantity: 1, unit: "件", quantityProvided: false }),
    undefined,
    "pre-Q1 会话恢复的行(未提取也未触碰)不携带数量"
  );
  assert.equal(batchSave.rowQuantityInput({}), undefined);
});
