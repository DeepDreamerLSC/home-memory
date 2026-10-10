"use strict";

const test = require("node:test");
const assert = require("node:assert");

const bs = require("../miniprogram/utils/batch-save.js");

function row(overrides) {
  return Object.assign(
    {
      key: "r0",
      name: "钥匙",
      locationText: "玄关抽屉",
      checked: true,
      status: "pending",
      failMsg: "",
      operationId: "op-1",
    },
    overrides,
  );
}

test("rowsToSave:只含勾选且未 saved 的行(pending 首次与 failed 重试都算)", function () {
  const rows = [
    row({ key: "a", status: "pending" }),
    row({ key: "b", status: "saved" }), // 已保存,不再提交
    row({ key: "c", status: "failed", failMsg: "超时" }), // 失败重试
    row({ key: "d", checked: false }), // 未勾选
    row({ key: "e", status: "saving" }), // 保存中(异常残留),同样属于待保存
  ];
  assert.deepEqual(
    bs.rowsToSave(rows).map((r) => r.key),
    ["a", "c", "e"],
  );
});

test("rowsToSave:全部 saved 后为空(重试不再重复提交)", function () {
  const rows = [row({ status: "saved" }), row({ key: "b", status: "saved", operationId: "op-2" })];
  assert.equal(bs.rowsToSave(rows).length, 0);
});

test("firstInvalidMsg:勾选行缺名称/缺位置给出第几件的可读提示", function () {
  assert.equal(
    bs.firstInvalidMsg([row(), row({ key: "b", name: "  " })]),
    "第 2 件还没写名称",
  );
  assert.equal(
    bs.firstInvalidMsg([row({ locationText: "" })]),
    "第 1 件还没写位置",
  );
  assert.equal(bs.firstInvalidMsg([row(), row({ key: "b", checked: false, name: "" })]), "", "未勾选行不校验");
});

test("allCheckedSaved:按勾选行判定,未勾选与失败行语义正确", function () {
  assert.equal(bs.allCheckedSaved([row({ status: "saved" })]), true);
  assert.equal(bs.allCheckedSaved([row({ status: "pending" })]), false);
  assert.equal(bs.allCheckedSaved([row({ status: "failed" })]), false);
  assert.equal(bs.allCheckedSaved([row({ checked: false, status: "pending" })]), true, "未勾选不影响完成判定");
});

test("batchSummary:勾选/已保存/失败计数正确", function () {
  const rows = [
    row({ key: "a", status: "saved" }),
    row({ key: "b", status: "failed", failMsg: "x" }),
    row({ key: "c", status: "pending" }),
    row({ key: "d", checked: false }),
  ];
  assert.deepEqual(bs.batchSummary(rows), { total: 4, checked: 3, saved: 1, failed: 1 });
});
