"use strict";

/**
 * 拍照识物候选草稿状态机的离线测试(纯函数,零 wx、零外部依赖)。
 * 被测对象是 `npm run build:mp` 产出的 miniprogram/utils/intake-draft.js。
 * 规格:docs/design/issue3-photo-intake/IMPLEMENTATION.md §4.1③/§5/§8;
 * 行为基准:docs/design/issue3-photo-intake/prototype.html script
 * (三态流转、语音逐字段应用、例外只含已勾选、计数单一来源、圈选入列默认未勾选)。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var id = require("../miniprogram/utils/intake-draft");

/** 确定性 id 生成器(工厂入参注入;draftId/operationId 逐次不同) */
function seqGen() {
  var n = 0;
  return function () {
    n += 1;
    return "id-" + n;
  };
}

function aiItem(over) {
  return Object.assign(
    { name: "黄色薯片罐", qty_note: "", confidence: "mid", box: { x1: 0.273, y1: 0.389, x2: 0.593, y2: 0.507 } },
    over || {},
  );
}

// ---------- 数量备注:parseIntakeQtyNote / composeNote ----------

test("parseIntakeQtyNote:抽数字为 qty(1-99),剩余文本为 suffix,空则「备注」", function () {
  assert.deepEqual(id.parseIntakeQtyNote(""), { qty: 1, suffix: "备注" });
  assert.deepEqual(id.parseIntakeQtyNote("(空罐)"), { qty: 1, suffix: "(空罐)" });
  assert.deepEqual(id.parseIntakeQtyNote("约2根"), { qty: 2, suffix: "约根" });
  assert.deepEqual(id.parseIntakeQtyNote("24节"), { qty: 24, suffix: "节" });
  // 0 夹回 1(数量域 1-99,0 个不存在);超出 99 夹到 99
  assert.equal(id.parseIntakeQtyNote("0个").qty, 1);
  assert.equal(id.parseIntakeQtyNote("999").qty, 99);
  assert.equal(id.parseIntakeQtyNote("999").suffix, "备注");
  assert.deepEqual(id.parseIntakeQtyNote("还有几节"), { qty: 1, suffix: "还有几节" });
});

test("composeNote:×N + 后缀单一来源,空后缀按「备注」,折叠多余空白", function () {
  assert.equal(id.composeNote(2, "节"), "×2 节");
  assert.equal(id.composeNote(1, ""), "×1 备注");
  assert.equal(id.composeNote(3, " 空 罐 "), "×3 空 罐");
  assert.equal(id.composeNote(2, "  数量不确定  "), "×2 数量不确定");
});

// ---------- 入列工厂:AI 预选 / 圈选默认未勾选 / 语音补录 ----------

test("makeAiRow:confidence=high 默认勾选(保留),mid/low 默认不勾(候选);box 透传", function () {
  var high = id.makeAiRow(aiItem({ confidence: "high" }), seqGen());
  assert.equal(high.checked, true, "AI 高置信预选为保留");
  assert.equal(high.done, false);
  assert.equal(high.src, "ai");
  assert.deepEqual(high.box, { x1: 0.273, y1: 0.389, x2: 0.593, y2: 0.507 });
  var mid = id.makeAiRow(aiItem({ confidence: "mid", qty_note: "约2根" }), seqGen());
  assert.equal(mid.checked, false);
  assert.equal(mid.qty, 2);
  assert.equal(mid.suffix, "约根");
  var low = id.makeAiRow(aiItem({ confidence: "low", box: null }), seqGen());
  assert.equal(low.checked, false);
  assert.equal(low.box, null, "无框候选合法(整照关联)");
});

test("makeAiRow:draftId 与 operationId 入列即生成且互不相同", function () {
  var row = id.makeAiRow(aiItem(), seqGen());
  assert.match(row.draftId, /^id-\d+$/);
  assert.match(row.operationId, /^id-\d+$/);
  assert.notEqual(row.draftId, row.operationId);
});

test("makeCircleRow:圈选入列 = 未勾选候选,src=circle,沿用用户圈选框", function () {
  var circled = { x1: 0.06, y1: 0.69, x2: 0.29, y2: 0.93 };
  var row = id.makeCircleRow(
    aiItem({ name: "PlayStation 游戏盒", confidence: "mid", box: null, qty_note: "" }),
    circled,
    seqGen(),
  );
  assert.equal(row.checked, false, "圈选入列默认未勾选(勾选才保留)");
  assert.equal(row.src, "circle");
  assert.deepEqual(row.box, circled, "行框 = 用户圈的框(红虚线语义),不是模型框");
  assert.equal(row.done, false);
  assert.deepEqual(id.intakeCounts([row]), { total: 1, keep: 0, done: 0, unchecked: 1 });
});

test("makeVoiceAddedRow:语音补遗漏 = 未勾选、无框、src=voice", function () {
  var row = id.makeVoiceAddedRow("五号电池", "还有几节", seqGen());
  assert.equal(row.checked, false);
  assert.equal(row.src, "voice");
  assert.equal(row.box, null);
  assert.equal(row.qty, 1);
  assert.equal(row.suffix, "还有几节");
  assert.equal(row.confidence, "low", "无 VL 依据,恒 low 且无框不参与框样式");
});

// ---------- 三态流转 ----------

test("三态流转:候选 ↔ 保留 可反复切换;已确认记住(done)是终态不可再勾选", function () {
  var row = id.makeAiRow(aiItem({ confidence: "mid" }), seqGen());
  assert.equal(id.rowStateLabel(row), "候选");
  var kept = id.toggleRowChecked(row);
  assert.equal(id.rowStateLabel(kept), "保留");
  assert.equal(kept.checked, true);
  assert.equal(id.rowStateLabel(id.toggleRowChecked(kept)), "候选");
  var done = id.markRowSaved(kept);
  assert.equal(id.rowStateLabel(done), "已记住");
  var toggled = id.toggleRowChecked(done);
  assert.equal(toggled, done, "done 行勾选切换为 no-op(同一引用)");
  assert.equal(toggled.checked, true, "done 行勾选态不被变更");
});

test("框标签前缀与行状态单一来源同步(候选·/保留·/已记住·)", function () {
  var row = id.makeAiRow(aiItem({ confidence: "mid" }), seqGen());
  assert.equal(id.boxTagPrefix(row), "候选·");
  assert.equal(id.boxTagPrefix(id.toggleRowChecked(row)), "保留·");
  assert.equal(id.boxTagPrefix(id.markRowSaved(row)), "已记住·");
});

test("全选/清空只动未 done 行,已确认记住的行不受影响", function () {
  var rows = [
    id.makeAiRow(aiItem({ confidence: "mid", name: "A" }), seqGen()),
    id.makeAiRow(aiItem({ confidence: "high", name: "B" }), seqGen()),
  ];
  var doneRow = id.markRowSaved(rows[1]);
  var list = [rows[0], doneRow];
  var all = id.setRowsChecked(list, true);
  assert.equal(all[0].checked, true);
  assert.equal(all[1], doneRow, "done 行原样返回");
  assert.equal(all[1].checked, true);
  var none = id.setRowsChecked(all, false);
  assert.equal(none[0].checked, false);
  assert.equal(none[1].checked, true, "清空不动 done 行");
});

test("步进器:下限 1、上限 99;不改勾选态与 draftId/operationId", function () {
  var row = id.makeAiRow(aiItem({ confidence: "high", qty_note: "3" }), seqGen());
  assert.equal(row.qty, 3);
  assert.equal(row.unit, "件", "Q1 行入列即带默认单位(issue #102)");
  var up = id.stepRowQty(row, 1);
  assert.equal(up.qty, 4);
  assert.equal(up.checked, true, "步进不改勾选态");
  assert.equal(up.draftId, row.draftId);
  assert.equal(up.operationId, row.operationId);
  assert.equal(up.qtyTouched, true, "触碰步进器=数量确认(待核对标记随之消失)");
  var one = { ...row, qty: 1 };
  var floor = id.stepRowQty(one, -1);
  assert.equal(floor.qty, 1, "下限 1");
  assert.equal(floor.qtyTouched, true, "首次触碰即使 qty 不变也翻触碰标记");
  assert.equal(id.stepRowQty(floor, -1), floor, "已触碰且 qty 无变化时返回原引用");
  var capped = id.stepRowQty({ ...row, qty: 99 }, 1);
  assert.equal(capped.qty, 99, "上限 99");
});

// ---------- 语音逐字段应用(屏③ diff) ----------

function chipRow() {
  return id.makeAiRow(aiItem({ confidence: "mid", name: "黄色薯片罐", qty_note: "(数量不确定)" }), seqGen());
}

var CHIP_EDITS = [
  { field: "name", old: "黄色薯片罐", new: "品客薯片罐" },
  { field: "qty_note", old: "(数量不确定)", new: "(空罐)" },
  { field: "location", old: "玄关柜·第二层", new: "厨房" },
];

test("语音应用:三字段全勾 → 逐字段改,name/qty+suffix/exc 各自落位,src=voice", function () {
  var row = chipRow();
  var out = id.applyDraftEdits(row, CHIP_EDITS, ["name", "qty_note", "location"]);
  assert.equal(out.applied, 3);
  assert.equal(out.row.name, "品客薯片罐");
  assert.equal(out.row.qty, 1, "(空罐) 无数字 → qty 1");
  assert.equal(out.row.suffix, "(空罐)");
  assert.equal(out.row.exc, "厨房", "位置只写该件例外");
  assert.equal(out.row.src, "voice");
});

test("语音应用:只勾部分字段 → 未勾字段保持原值(逐项裁决)", function () {
  var row = chipRow();
  var out = id.applyDraftEdits(row, CHIP_EDITS, ["qty_note"]);
  assert.equal(out.applied, 1);
  assert.equal(out.row.name, "黄色薯片罐", "未勾选的名称不改");
  assert.equal(out.row.suffix, "(空罐)");
  assert.equal(out.row.exc, null, "未勾选的位置不改(仍继承批次)");
  assert.equal(out.row.src, "voice", "应用过至少一处即标 voice");
});

test("语音应用:0 勾选不执行(返回原行引用),勾选态绝不被动变更(V0.4.1 修复项)", function () {
  var row = chipRow();
  var out = id.applyDraftEdits(row, CHIP_EDITS, []);
  assert.equal(out.applied, 0);
  assert.equal(out.row, row, "0 勾选 = 不执行,引用不变");
  var out2 = id.applyDraftEdits(chipRow(), CHIP_EDITS, ["name", "qty_note", "location"]);
  assert.equal(out2.row.checked, false, "应用编辑不改勾选(保留)状态");
  var kept = id.toggleRowChecked(chipRow());
  var out3 = id.applyDraftEdits(kept, CHIP_EDITS, ["name"]);
  assert.equal(out3.row.checked, true, "已勾选行应用编辑后仍是保留");
  assert.equal(out3.row.done, false);
});

test("语音应用:qty_note 含数字时拆 qty+suffix;白名单外字段跳过;空 new 跳过", function () {
  var row = chipRow();
  var out = id.applyDraftEdits(row, [
    { field: "qty_note", new: "约2根" },
    { field: "note", new: "越权字段" },
    { field: "name", new: "   " },
  ], ["qty_note", "note", "name"]);
  assert.equal(out.applied, 1, "只有 qty_note 一处生效");
  assert.equal(out.row.qty, 2);
  assert.equal(out.row.suffix, "约根");
  assert.equal(out.row.name, "黄色薯片罐", "空白 new 不落值");
});

test("语音应用:draftId/operationId/box/checked 全程稳定(按内容锁定,不按行号)", function () {
  var row = chipRow();
  var out = id.applyDraftEdits(row, CHIP_EDITS, ["name", "qty_note", "location"]);
  assert.equal(out.row.draftId, row.draftId);
  assert.equal(out.row.operationId, row.operationId, "幂等键沿用,内容改后仍同键");
  assert.deepEqual(out.row.box, row.box);
  assert.equal(out.row.checked, row.checked);
});

// ---------- 保存结果落行 ----------

test("markRowSaved / markRowFailed:成功进终态;失败保留原幂等键可重试", function () {
  var row = chipRow();
  var failed = id.markRowFailed(row, "网络超时");
  assert.equal(failed.done, false);
  assert.equal(failed.failMsg, "网络超时");
  assert.equal(failed.operationId, row.operationId, "失败行沿用原键(同键同内容幂等收敛)");
  var retried = id.markRowSaved(failed);
  assert.equal(retried.done, true);
  assert.equal(retried.failMsg, "");
  assert.equal(retried.operationId, row.operationId);
  assert.equal(id.markRowFailed(row, "").failMsg, "保存失败,可重试", "空文案兜底");
});

// ---------- 计数单一来源 ----------

test("计数单一来源:保留 n / N(待核对);有 done 行改「已确认记住 n 件 · 本批完成」", function () {
  var rows = [
    id.makeAiRow(aiItem({ confidence: "high", name: "A" }), seqGen()),
    id.makeAiRow(aiItem({ confidence: "mid", name: "B" }), seqGen()),
    id.makeAiRow(aiItem({ confidence: "low", name: "C" }), seqGen()),
  ];
  var view = id.intakeCountView(rows);
  assert.equal(view.headText, "保留 1 / 3(待核对)");
  assert.equal(view.saveText, "存 1 件");
  assert.equal(view.saveDisabled, false);
  var afterToggle = rows.map(function (r, i) {
    return i === 1 ? id.toggleRowChecked(r) : r;
  });
  assert.equal(id.intakeCountView(afterToggle).saveText, "存 2 件");
  var withDone = [id.markRowSaved(afterToggle[0]), afterToggle[1], afterToggle[2]];
  var doneView = id.intakeCountView(withDone);
  assert.equal(doneView.headText, "已确认记住 1 件 · 本批完成");
  assert.equal(doneView.saveText, "✓ 已入库");
  assert.equal(doneView.saveDisabled, true);
  assert.deepEqual(id.intakeCounts(withDone), { total: 3, keep: 1, done: 1, unchecked: 1 });
});

test("0 勾选禁用保存;圈选入列后再勾选,计数实时联动(单一数值来源)", function () {
  var base = id.makeAiRow(aiItem({ confidence: "high", name: "A" }), seqGen());
  assert.equal(id.intakeCountView([base]).saveDisabled, false);
  var cleared = id.setRowsChecked([base], false);
  assert.equal(id.intakeCountView(cleared).saveDisabled, true, "0 勾选禁用");
  var circled = id.makeCircleRow(aiItem({ name: "D", confidence: "mid", box: null }), { x1: 0, y1: 0, x2: 0.5, y2: 0.5 }, seqGen());
  var withCircle = cleared.concat([circled]);
  assert.equal(id.intakeCounts(withCircle).keep, 0, "圈选入列默认未勾选,计数不动");
  var checked2 = withCircle.map(function (r) {
    return r === circled ? id.toggleRowChecked(r) : r;
  });
  assert.equal(id.intakeCounts(checked2).keep, 1, "勾选后保存计数联动");
  assert.equal(id.intakeCountView(checked2).saveText, "存 1 件");
});

// ---------- 保存最终确认数据派生(例外只含已勾选) ----------

function confirmFixture() {
  var gen = seqGen();
  var keptWithExc = id.applyDraftEdits(
    id.makeAiRow(aiItem({ confidence: "high", name: "黄色薯片罐" }), gen),
    [{ field: "location", new: "厨房" }],
    ["location"],
  ).row;
  var keptNoExc = id.makeAiRow(aiItem({ confidence: "high", name: "白色数据线", qty_note: "2" }), gen);
  var uncheckedWithExc = id.applyDraftEdits(
    id.makeAiRow(aiItem({ confidence: "low", name: "黑色小盒子" }), gen),
    [{ field: "location", new: "书房" }],
    ["location"],
  ).row;
  var doneWithExc = id.markRowSaved(id.applyDraftEdits(
    id.makeAiRow(aiItem({ confidence: "high", name: "黑色耳机" }), gen),
    [{ field: "location", new: "卧室" }],
    ["location"],
  ).row);
  return [keptWithExc, keptNoExc, uncheckedWithExc, doneWithExc];
}

test("保存确认派生:例外只含已勾选件(未保留候选不进,done 行不再进);#d 序号为清单内位置", function () {
  var s = id.deriveSaveConfirm(confirmFixture(), "玄关柜 · 第二层");
  assert.equal(s.keepCount, 2);
  assert.equal(s.skipCount, 1, "未勾选候选 = 不保存件数");
  assert.equal(s.doneCount, 1);
  assert.equal(s.exceptions.length, 1, "只有已勾选且有例外的件进清单");
  assert.equal(s.exceptions[0].name, "黄色薯片罐");
  assert.equal(s.exceptions[0].exc, "厨房");
  assert.equal(s.exceptions[0].index, 1, "#d 序号 = 清单内 1-based 位置");
  assert.deepEqual(s.exceptionLines, ["📍 #d1 黄色薯片罐 → 厨房"]);
  assert.equal(s.exceptionText, "📍 #d1 黄色薯片罐 → 厨房");
  assert.equal(s.summaryText, "保留 2 件写入 · 未勾选 1 件不保存");
  assert.equal(s.saveDisabled, true, "清单里已有 done 行 = 本批已完成,保存入口禁用(原型 confirmSave 早退)");
  assert.equal(s.batchLocation, "玄关柜 · 第二层");
  // 去掉 done 行后同一派生规则:例外清单不变,保存可用
  var s2 = id.deriveSaveConfirm(confirmFixture().slice(0, 3), "玄关柜 · 第二层");
  assert.equal(s2.saveDisabled, false);
  assert.equal(s2.doneCount, 0);
  assert.deepEqual(s2.exceptionLines, ["📍 #d1 黄色薯片罐 → 厨房"]);
});

test("保存确认派生:无例外时的整段文案;0 勾选或已有 done 行时禁用", function () {
  var rows = [
    id.makeAiRow(aiItem({ confidence: "high", name: "A" }), seqGen()),
    id.makeAiRow(aiItem({ confidence: "mid", name: "B" }), seqGen()),
  ];
  var s = id.deriveSaveConfirm(rows, "客厅电视柜");
  assert.equal(s.hasExceptions, false);
  assert.equal(s.exceptionText, "无例外,全部继承本批位置");
  assert.deepEqual(s.exceptions, []);
  assert.equal(id.deriveSaveConfirm(id.setRowsChecked(rows, false), "客厅电视柜").saveDisabled, true);
  var withDone = [id.markRowSaved(rows[0]), rows[1]];
  assert.equal(id.deriveSaveConfirm(withDone, "客厅电视柜").saveDisabled, true, "本批已完成不再保存");
});

test("纯函数:所有变更返回新对象,入参数组/对象不被改动;draftId 全程稳定", function () {
  var rows = confirmFixture();
  var snapshot = JSON.parse(JSON.stringify(rows));
  id.setRowsChecked(rows, true);
  rows.forEach(function (r) {
    id.stepRowQty(r, 5);
    id.toggleRowChecked(r);
    id.applyDraftEdits(r, CHIP_EDITS, ["name", "qty_note", "location"]);
    id.markRowSaved(r);
    id.markRowFailed(r, "x");
  });
  id.intakeCounts(rows);
  id.intakeCountView(rows);
  id.deriveSaveConfirm(rows, "批次位置");
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), snapshot, "入参逐字节未被改动");
});

test("全链路 draftId 稳定:入列→勾选→步进→语音应用→保存,draftId/operationId 不变", function () {
  var row = chipRow();
  var draftId0 = row.draftId;
  var opId0 = row.operationId;
  var final = id.markRowSaved(
    id.applyDraftEdits(
      id.stepRowQty(id.toggleRowChecked(row), 2),
      CHIP_EDITS,
      ["name", "qty_note", "location"],
    ).row,
  );
  assert.equal(final.draftId, draftId0);
  assert.equal(final.operationId, opId0);
  assert.equal(id.qtyNoteText(final), "×1 (空罐)", "备注文案与草稿单一来源");
});
