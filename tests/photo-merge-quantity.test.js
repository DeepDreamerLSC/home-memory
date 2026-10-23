"use strict";

/**
 * Q3 照片同帧多框合成(issue #102 §2/§5-3;Q0-CONTRACT §8/§12-C):
 * - C1:同照片两候选框,用户显式合并 → photoCommit 1 条 quantity=2,
 *   photo.box=null(整照关联,绝不把 B1/B2 冒充两件的位置);
 * - C2:不合并 → 2 条 ×1,框各自保留;
 * - C3:默认(用户不操作)→ 两行独立提交,不存在任何自动合并路径;
 * - §8 规则 2:单来源行步进器调 N(box=B1)→ 合法 quantity=N + box=B1;
 * - §8 规则 4:合并行 source 归并(全 vl→vl,含 circle→circle);
 * - 来源候选可展开查验(mergedFrom:候选 id/框/名称,只进会话内存,绝不进提交载荷);
 * - 单位不同/pre-Q1 旧会话行/done 行/单选 拒绝合并,行集原样;
 * - 合成行数量=来源行步进值之和的预填提示(待核对),用户触碰步进器=确认
 *   (quantity 永不由候选框数/VL 置信推断——L1/Q3 铁律)。
 * 红绿纪律:本文件在未实现合并的代码上必须失败,实现后全绿。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var intakeDraft = require(path.join(ROOT, "miniprogram/utils/intake-draft.js"));
var photoIntake = require(path.join(ROOT, "miniprogram/utils/photo-intake.js"));

var B1 = { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.5 };
var B2 = { x1: 0.5, y1: 0.4, x2: 0.9, y2: 0.8 };
var PHOTO = { file_id: "cloud://bucket/p1.jpg", img_w: 1024, img_h: 768 };

var seq = 0;
function genId() {
  seq += 1;
  return "q3id-" + seq;
}

/** Q1 候选行(unit 在场;形状 = makeAiRow 产物) */
function aiRow(name, box, over) {
  return Object.assign(
    {
      draftId: genId(),
      name: name,
      qty: 1,
      suffix: "备注",
      unit: "件",
      qtyTouched: false,
      exc: null,
      src: "ai",
      confidence: "high",
      box: box,
      checked: true,
      done: false,
      failMsg: "",
      operationId: genId(),
    },
    over || {}
  );
}

/* ---------------- 纯函数:mergeRowsIntoOne ---------------- */

test("PM-C1 同照片两候选框(同帧两盒)显式合并 → 1 条 ×2,box=null 绝不冒充 B1/B2", function () {
  var r1 = aiRow("棉柔巾", B1);
  var r2 = aiRow("棉柔巾", B2);
  var out = intakeDraft.mergeRowsIntoOne([r1, r2], [r1.draftId, r2.draftId]);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.rows.length, 1, "两行合成一行");
  var merged = out.rows[0];
  assert.equal(merged.quantity === undefined ? merged.qty : merged.qty, 2, "行 qty=2");
  assert.equal(merged.unit, "件");
  assert.equal(merged.box, null, "合并行整照关联:box=null(Q0-CONTRACT §8 规则 1)");
  assert.notDeepEqual(merged.box, B1);
  assert.notDeepEqual(merged.box, B2);
  assert.equal(merged.checked, true);
  assert.equal(merged.done, false);
  assert.equal(merged.draftId, r1.draftId, "draftId 取首行(锁定/编辑沿用)");
  assert.equal(merged.operationId, r1.operationId, "幂等键沿用首行(同键异内容=服务端如实冲突)");

  // 提交载荷:1 条 quantity=2 + photo.box=null(source 全 vl → vl,§8 规则 4)
  var items = photoIntake.buildPhotoCommitItems(out.rows, "卫生间 / 镜柜", PHOTO);
  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, 2);
  assert.equal(items[0].unit, "件");
  assert.equal(items[0].photo.box, null, "证据行 box=null(整照),不落 B1 或 B2 冒充");
  assert.equal(items[0].photo.source, "vl");
  assert.equal("note" in items[0], false, "Q1 合并行 note 不再由数量拼出");
});

test("PM-C1-source 含圈选来源的合并 → source=circle(§8 规则 4:凡含用户圈选即用户确认痕迹)", function () {
  var r1 = aiRow("棉柔巾", B1);
  var r2 = aiRow("棉柔巾", B2, { src: "circle" });
  var out = intakeDraft.mergeRowsIntoOne([r1, r2], [r1.draftId, r2.draftId]);
  assert.equal(out.ok, true);
  var items = photoIntake.buildPhotoCommitItems(out.rows, "卫生间", PHOTO);
  assert.equal(items[0].photo.source, "circle");
  assert.equal(items[0].photo.box, null);
});

test("PM-C2 不合并 → 2 条 ×1,框各自保留(用户选择 B:N 条独立 item)", function () {
  var r1 = aiRow("棉柔巾", B1);
  var r2 = aiRow("棉柔巾", B2);
  var items = photoIntake.buildPhotoCommitItems([r1, r2], "卫生间", PHOTO);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].photo.box, B1);
  assert.deepEqual(items[1].photo.box, B2);
  assert.equal(items[0].quantity, 1);
  assert.equal(items[1].quantity, 1);
});

test("PM-C3 默认零操作 → 行集原样,行数=提交件数,不存在自动合并路径", function () {
  var r1 = aiRow("棉柔巾", B1);
  var r2 = aiRow("棉柔巾", B2);
  var rows = intakeDraft.setRowsChecked([r1, r2], true);
  var items = photoIntake.buildPhotoCommitItems(rows, "卫生间", PHOTO);
  assert.equal(items.length, rows.length, "一行一件,绝不按同名/框数静默归并");
});

test("PM-C4 单来源行步进器调到 2(box=B1)→ 合法 quantity=2 + box=B1(§8 规则 2)", function () {
  var r1 = intakeDraft.stepRowQty(aiRow("棉柔巾", B1), 1);
  var items = photoIntake.buildPhotoCommitItems([r1], "卫生间", PHOTO);
  assert.equal(items[0].quantity, 2);
  assert.deepEqual(items[0].photo.box, B1, "单来源行保留原框,不是一框冒充两件");
});

test("PM-UNIT-MISMATCH 单位不同的行禁止合并(L3:不同单位绝不默默叠加)", function () {
  var r1 = aiRow("棉柔巾", B1, { unit: "包" });
  var r2 = aiRow("棉柔巾", B2, { unit: "盒" });
  var out = intakeDraft.mergeRowsIntoOne([r1, r2], [r1.draftId, r2.draftId]);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "unit-mismatch");
  assert.ok(out.message.length > 0);
});

test("PM-LEGACY pre-Q1 会话恢复行(unit 缺席)不参与合并(E13 冻结载荷纪律)", function () {
  var legacy = aiRow("棉柔巾", null);
  delete legacy.unit;
  var r2 = aiRow("棉柔巾", B2);
  var out = intakeDraft.mergeRowsIntoOne([legacy, r2], [legacy.draftId, r2.draftId]);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "legacy-row");
});

test("PM-DONE 已入库(done)行是终态,不参与合并", function () {
  var r1 = aiRow("棉柔巾", B1, { done: true });
  var r2 = aiRow("棉柔巾", B2);
  var out = intakeDraft.mergeRowsIntoOne([r1, r2], [r1.draftId, r2.draftId]);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "done");
});

test("PM-SINGLE 只选一行 / 选不存在的行 → 拒绝,行集原样", function () {
  var r1 = aiRow("棉柔巾", B1);
  var r2 = aiRow("棉柔巾", B2);
  var single = intakeDraft.mergeRowsIntoOne([r1, r2], [r1.draftId]);
  assert.equal(single.ok, false);
  assert.equal(single.reason, "single");
  var ghost = intakeDraft.mergeRowsIntoOne([r1, r2], [r1.draftId, "ghost-id", r2.draftId]);
  assert.equal(ghost.ok, false);
  assert.equal(ghost.reason, "not-found");
});

test("PM-SUM 合成行数量=来源步进值之和的预填,标待核对;用户步进=确认(L1)", function () {
  var r1 = aiRow("棉柔巾", B1, { qty: 3, qtyTouched: true });
  var r2 = aiRow("棉柔巾", B2, { qty: 2, qtyTouched: true });
  var out = intakeDraft.mergeRowsIntoOne([r1, r2], [r1.draftId, r2.draftId]);
  assert.equal(out.ok, true);
  var merged = out.rows[0];
  assert.equal(merged.qty, 5, "预填=3+2(来源行步进值之和)");
  assert.equal(merged.qtyTouched, false, "合成行重新标待核对,总和需用户过目确认");
  assert.equal(out.qtySum, 5, "钳前合计随结果返回,未截断时等于预填");
  // 用户步进改总数 = 确认
  var stepped = intakeDraft.stepRowQty(merged, -1);
  assert.equal(stepped.qty, 4);
  assert.equal(stepped.qtyTouched, true);
});

test("PM-SUM-CLAMP 预填之和超 99 → 钳回 99,且钳前合计随结果返回供显式提示截断(复审发现5)", function () {
  var r1 = aiRow("A", B1, { qty: 60, qtyTouched: true });
  var r2 = aiRow("A", B2, { qty: 60, qtyTouched: true });
  var out = intakeDraft.mergeRowsIntoOne([r1, r2], [r1.draftId, r2.draftId]);
  assert.equal(out.ok, true);
  assert.equal(out.rows[0].qty, 99);
  assert.equal(out.qtySum, 120, "qtySum=钳前合计(60+60),调用方据此显式提示截断,绝不静默");
  assert.ok(out.qtySum > out.rows[0].qty, "qtySum>合成行 qty 即截断发生的判据");
});

test("PM-SOURCES 来源候选可展开查验:mergedFrom 保留 id/框/名称,绝不进提交载荷", function () {
  var r1 = aiRow("棉柔巾", B1);
  var r2 = aiRow("棉柔巾", B2);
  var out = intakeDraft.mergeRowsIntoOne([r1, r2], [r1.draftId, r2.draftId]);
  assert.equal(out.ok, true);
  var merged = out.rows[0];
  assert.ok(Array.isArray(merged.mergedFrom) && merged.mergedFrom.length === 2);
  assert.equal(merged.mergedFrom[0].draftId, r1.draftId);
  assert.deepEqual(merged.mergedFrom[0].box, B1);
  assert.equal(merged.mergedFrom[1].box, B2);
  assert.equal(merged.mergedFrom[0].name, "棉柔巾");
  // 提交载荷绝不携带来源候选(会话内存,不落库)
  var items = photoIntake.buildPhotoCommitItems(out.rows, "卫生间", PHOTO);
  assert.equal(JSON.stringify(items).indexOf("mergedFrom"), -1);
});

test("PM-REMERGE 合并行可再合并:来源清单累积,框仍全部可找回", function () {
  var r1 = aiRow("棉柔巾", B1);
  var r2 = aiRow("棉柔巾", B2);
  var first = intakeDraft.mergeRowsIntoOne([r1, r2], [r1.draftId, r2.draftId]);
  assert.equal(first.ok, true);
  var r3 = aiRow("棉柔巾", { x1: 0.0, y1: 0.0, x2: 0.2, y2: 0.2 });
  var second = intakeDraft.mergeRowsIntoOne(first.rows.concat([r3]), [
    first.rows[0].draftId,
    r3.draftId,
  ]);
  assert.equal(second.ok, true);
  assert.equal(second.rows.length, 1);
  assert.equal(second.rows[0].mergedFrom.length, 3, "B1/B2/B3 三个来源框全部可找回");
  var boxes = second.rows[0].mergedFrom.map(function (s) { return s.box; });
  assert.deepEqual(boxes, [B1, B2, r3.box]);
});

test("PM-ORDER 未选中的行原样保留,合成行落在首选中行位置", function () {
  var r0 = aiRow("抽纸", null);
  var r1 = aiRow("棉柔巾", B1);
  var r2 = aiRow("棉柔巾", B2);
  var out = intakeDraft.mergeRowsIntoOne([r0, r1, r2], [r1.draftId, r2.draftId]);
  assert.equal(out.ok, true);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].draftId, r0.draftId, "未选中原样");
  assert.equal(out.rows[1].draftId, r1.draftId, "合成行=首选中位置");
});
