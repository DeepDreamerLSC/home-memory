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

// ---------- runBatchSave 故障注入(评审二轮:部分成功、原键重试、快照隔离) ----------

const bs2 = require("../miniprogram/utils/batch-save.js");

function batchRow(overrides) {
  return Object.assign(
    { key: "r", name: "钥匙", locationText: "玄关", checked: true, status: "pending", failMsg: "", operationId: "op-r" },
    overrides,
  );
}

test("runBatchSave:首行成功、次行超时、末行成功 —— 状态逐行如实推进,失败行保留原键", async function () {
  const rows = [batchRow({ key: "a", operationId: "op-a" }), batchRow({ key: "b", operationId: "op-b" }), batchRow({ key: "c", operationId: "op-c" })];
  const calls = [];
  const finalRows = await bs2.runBatchSave(
    rows,
    (row) => {
      calls.push(row.operationId);
      if (row.key === "b") return Promise.reject(new Error("timeout"));
      return Promise.resolve();
    },
    () => {},
  );
  assert.deepEqual(calls, ["op-a", "op-b", "op-c"], "三行都应尝试提交");
  assert.equal(finalRows[0].status, "saved");
  assert.equal(finalRows[1].status, "failed");
  assert.equal(finalRows[1].failMsg, "timeout");
  assert.equal(finalRows[1].operationId, "op-b", "失败行保留原幂等键");
  assert.equal(finalRows[2].status, "saved", "失败不阻断后续行");
  assert.equal(bs2.rowsToSave(finalRows).map((r) => r.key).join(","), "b", "重试只含失败行");
});

test("runBatchSave:原键重试且内容已改 —— 键不变内容变(服务端同键幂等/异内容冲突兜底)", async function () {
  let rows = [batchRow({ key: "a", operationId: "op-a", locationText: "玄关" })];
  rows = await bs2.runBatchSave(rows, () => Promise.reject(new Error("timeout")), () => {});
  assert.equal(rows[0].status, "failed");
  // 用户在失败行上改了位置后重试:快照内容变,幂等键不变
  const retried = Object.assign({}, rows[0], { locationText: "客厅" });
  const seen = [];
  const out = await bs2.runBatchSave([retried], (row) => {
    seen.push({ id: row.operationId, loc: row.locationText });
    return Promise.resolve();
  }, () => {});
  assert.deepEqual(seen, [{ id: "op-a", loc: "客厅" }], "重试沿用原键提交新内容");
  assert.equal(out[0].status, "saved");
});

test("runBatchSave:在快照拷贝上推进,绝不改动调用方数组;已保存行不重复提交", async function () {
  const rows = [batchRow({ key: "a", status: "saved", operationId: "op-a" }), batchRow({ key: "b", operationId: "op-b" })];
  const calls = [];
  const out = await bs2.runBatchSave(rows, (row) => {
    calls.push(row.key);
    return Promise.resolve();
  }, () => {});
  assert.deepEqual(calls, ["b"], "已保存行不再提交");
  assert.equal(rows[0].status, "saved");
  assert.equal(rows[1].status, "pending", "原数组不被触碰(快照隔离)");
  assert.equal(out[1].status, "saved");
});

test("runBatchSave:onRowUpdate 携带行状态与原始错误(调用方分类 OPERATION_CONFLICT)", async function () {
  const events = [];
  const fakeConflict = Object.assign(new Error("conflict"), { code: "OPERATION_CONFLICT" });
  await bs2.runBatchSave(
    [batchRow({ key: "a" })],
    () => Promise.reject(fakeConflict),
    (row, error) => events.push({ key: row.key, status: row.status, error }),
  );
  assert.equal(events.length, 2, "saving + failed 两次回调");
  assert.equal(events[1].status, "failed");
  assert.strictEqual(events[1].error, fakeConflict, "原始错误透传给调用方分类");
});
