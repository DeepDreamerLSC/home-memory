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

test("shouldDefaultChecked:位置确定且有专属证据、锚定不共享才默认勾;位置没听清一律不默认勾(B3)", function () {
  assert.equal(bs.shouldDefaultChecked("钥匙放在玄关抽屉", false, true), true, "位置确定+专属证据默认勾");
  assert.equal(bs.shouldDefaultChecked("钥匙和充电宝都在玄关抽屉", true, true), false, "共享锚定不默认勾");
  assert.equal(bs.shouldDefaultChecked("", false, true), false, "无证据不默认勾");
  // B3:certain=false(位置没听清)即使原话证据充分也不默认勾——
  // 否则出现「⚠ 位置待核实 + 已勾选」,整批提交卡在「还没写位置」上
  assert.equal(bs.shouldDefaultChecked("降压药好像在厨房抽屉", false, false), false, "位置没听清不默认勾(有原话也不勾)");
});

/** 确认页初始行的最小同构(与 pages/confirm onLoad 的行构造一致,含 B3 的 certain 维度) */
function confirmLikeRow(d, i) {
  return Object.assign(
    {
      key: "row-" + i,
      name: d.name,
      locationText: d.location_text,
      checked: bs.shouldDefaultChecked(d.source_quote, d.anchor_shared === true, d.certain === true),
      status: "pending",
      failMsg: "",
      operationId: "op-" + i,
    },
  );
}

test("B3-C2:两件确定 + 一件没听清(原话非空)——默认勾选 2 件,可保存两件,第三件不进入写请求", async function () {
  const drafts = [
    { name: "钥匙", location_text: "玄关抽屉", certain: true, source_quote: "钥匙放在玄关抽屉" },
    { name: "充电宝", location_text: "客厅茶几", certain: true, source_quote: "充电宝在客厅茶几" },
    // 位置没听清(certain=false)但原话证据非空:旧行为会默认勾选,B3 起必须不勾
    { name: "护照", location_text: "", certain: false, source_quote: "护照好像在书房某个抽屉" },
  ];
  const rows = drafts.map(confirmLikeRow);
  assert.equal(rows.filter((r) => r.checked).length, 2, "默认勾选数应为 2(uncertain 不勾)");
  assert.equal(rows[2].checked, false, "没听清位置的第三件默认不勾选");
  assert.equal(bs.firstInvalidMsg(rows), "", "未勾选行不进必填校验,两件确定的可整批保存");

  const writes = [];
  const finalRows = await bs.runBatchSave(
    rows,
    (r) => {
      writes.push(r.name);
      return Promise.resolve();
    },
    () => {},
  );
  assert.deepEqual(writes, ["钥匙", "充电宝"], "写请求只含勾选的两件,第三件不进入写请求");
  assert.equal(bs.allCheckedSaved(finalRows), true, "两件全部保存完成");
  assert.equal(finalRows[2].status, "pending", "未勾选行保持待核对(补位置后由用户明确勾选)");
});

// ---------- PR #52 复审 B3:C2 行 → create reminder 参数映射(纯函数) ----------

function remindRow(overrides) {
  return Object.assign(
    {
      key: "r0",
      name: "钥匙",
      locationText: "玄关",
      checked: true,
      status: "pending",
      failMsg: "",
      operationId: "op-r1",
      remindAt: "",
      remindKind: "",
      remindOrigin: "",
      remindQuote: "",
      remindTouched: false,
    },
    overrides,
  );
}

test("rowReminderInput:行内无日期(服务端因归属不明置空)→ undefined,一键确认绝不写入错误提醒", function () {
  // B3 反例链路:模型把滤芯的日期赋给钥匙,服务端归属门把钥匙三项置 null →
  // 确认页 remindAt 为 "" → 随行提交不带 reminder
  assert.equal(bs.rowReminderInput(remindRow()), undefined);
  assert.equal(
    bs.rowReminderInput(remindRow({ remindAt: "", remindKind: "有效期" })),
    undefined,
    "类别残留而日期为空:同样不带(半态禁止)",
  );
});

test("rowReminderInput:日期仍是原话提取值才带 quote;选择器改过的只带 due/kind", function () {
  const extracted = bs.rowReminderInput(
    remindRow({
      remindAt: "2027-11-20",
      remindKind: "下次维护",
      remindOrigin: "2027-11-20",
      remindQuote: "2027年11月20号",
    }),
  );
  assert.deepStrictEqual(extracted, {
    due_date: "2027-11-20",
    kind: "下次维护",
    quote: "2027年11月20号",
  });
  const picked = bs.rowReminderInput(
    remindRow({
      remindAt: "2027-12-01",
      remindKind: "下次维护",
      remindOrigin: "2027-11-20",
      remindQuote: "2027年11月20号",
    }),
  );
  assert.deepStrictEqual(picked, { due_date: "2027-12-01", kind: "下次维护" });
});

test("rowReminderInput 接线:归属置空的行经 runBatchSave 提交,create 收到的 event 不含 reminder 键", async function () {
  // C2 一键确认的等价断言:B3 置空行 + 正常行混排,只有正常行带 reminder
  const events = [];
  const rows = [
    remindRow({ key: "b3-null", name: "钥匙", operationId: "op-b3-1" }), // 归属不明置空
    remindRow({
      key: "b3-keep",
      name: "滤芯",
      locationText: "厨房",
      remindAt: "2027-11-20",
      remindKind: "下次维护",
      remindOrigin: "2027-11-20",
      remindQuote: "2027年11月20号",
      operationId: "op-b3-2",
    }),
  ];
  const finalRows = await bs.runBatchSave(
    rows,
    (row) => {
      const reminder = bs.rowReminderInput(row);
      events.push({ operationId: row.operationId, reminder });
      return Promise.resolve();
    },
    () => {},
  );
  assert.equal(bs.allCheckedSaved(finalRows), true);
  assert.equal(events.length, 2);
  assert.equal(
    events[0].reminder,
    undefined,
    "归属置空行:随行提交不带 reminder(不写入错误提醒)",
  );
  assert.deepStrictEqual(events[1].reminder, {
    due_date: "2027-11-20",
    kind: "下次维护",
    quote: "2027年11月20号",
  });
});
