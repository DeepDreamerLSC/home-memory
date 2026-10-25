"use strict";

/**
 * PR #56 架构复审 F4-B4 回归:轮次未知(-1)写前补拉撞见「与用户已确认基准
 * 不同的远端提醒」时,不得直接发提醒写(remindSet / remindClear / remindComplete)。
 *
 * 复审情景:补拉拿到远端新内容后恢复本地候选,直接以新轮次 remindSet——
 * CAS 只保证提交瞬间无新变化,不能代替用户对已有他人修改的知情选择,
 * 可能静默覆盖 A 刚设的提醒,用户从未看过远端值。
 *
 * 修复合同(补拉结果三分支,不加新架构):
 * - 远端确认无提醒(轮次 0/无行)→ 正常补录(expected_generation=0);
 * - 远端内容与用户已确认基准(remindOriginal 语义)一致 → 按轮次正常提交;
 * - 远端已有不同内容且用户尚未知悉 → 不得直接写:保留本地候选,进入既有
 *   冲突双值面板(远端值 vs 本地候选)显式选边后才能写;
 * - 「用完了」补拉发现提醒已变化 → 停止原完成动作,先显式确认最新提醒
 *   (带新日期的确认框),确认后才 remindComplete;清除(remindClear)同理。
 *
 * 被测对象是 `npm run build:mp` 产物 miniprogram/pages/item/item.js
 * (Page 构造器用桩捕获后按真实 setData 语义直调方法),零外部依赖。
 * 红绿纪律:标「红」的用例在未修复代码(2959b95)上必须失败(写请求已发出
 * /无带日期确认),修复后转绿;标「对照」的正常路径(无提醒补录/基准一致)
 * 断言不被误拦,修复前后都应通过。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");
var remindUi = require(path.join(ROOT, "miniprogram", "utils", "remind-ui.js"));

/* ---------------- wx 桩 + Page 桩(先装好再 require 详情页产物) ---------------- */

var toasts = [];
var modals = [];
var cloudCalls = [];

/** 服务端行为开关:remindList 可用性 / 返回行 / get 投影 */
var remindListMode = "row"; // row | fail
var serverRow = null;
var serverItem = null;

function resetEnv() {
  toasts = [];
  modals = [];
  cloudCalls = [];
  remindListMode = "row";
  serverRow = null;
  serverItem = null;
}

function router(name, data) {
  if (name === "households" && data.action === "status") {
    return { ok: true, household_id: "default", shared: false };
  }
  if (name === "itemsApi") {
    if (data.action === "remindList") {
      if (remindListMode === "fail") {
        return Promise.reject(new Error("remindList 弱网失败"));
      }
      return {
        ok: true,
        reminders: serverRow ? [serverRow] : [],
        household_id: "default",
      };
    }
    if (data.action === "get") {
      if (serverItem === null) {
        return Promise.reject(new Error("get 不可用"));
      }
      return { ok: true, item: serverItem };
    }
    if (data.action === "remindSet") {
      return {
        ok: true,
        reminder: {
          item_id: data.item_id,
          due_date: data.due_date,
          kind: "下次维护",
          generation: 9,
        },
      };
    }
    if (data.action === "remindClear") {
      return { ok: true };
    }
    if (data.action === "remindComplete") {
      return { ok: true, reminder: null };
    }
  }
  return Promise.reject(new Error("意外调用 " + name + ":" + (data && data.action)));
}

function installWx() {
  globalThis.wx = {
    showToast: function (o) {
      toasts.push(o);
    },
    showModal: function (o) {
      modals.push(o);
      if (o.success) {
        o.success({ confirm: true });
      }
    },
    navigateTo: function () {},
    navigateBack: function () {},
    reLaunch: function () {},
    getStorageSync: function () { return ""; },
    setStorageSync: function () {},
    removeStorageSync: function () {},
    cloud: {
      callFunction: function (o) {
        cloudCalls.push({ name: o.name, data: JSON.parse(JSON.stringify(o.data)) });
        Promise.resolve()
          .then(function () {
            return router(o.name, o.data);
          })
          .then(
            function (result) {
              o.success({ result: result });
            },
            function (err) {
              o.fail({ errMsg: String((err && err.message) || err) });
            },
          );
      },
    },
  };
}

var pageConfig = null;
globalThis.Page = function (config) {
  pageConfig = config;
};

installWx();
require(path.join(ROOT, "miniprogram", "pages", "item", "item.js"));

/** setData 路径语法桩("conflicts[0].choice" 等;与真实 setData 同语义) */
function setPath(obj, key, value) {
  var parts = key.replace(/\]/g, "").split(/[.[]/);
  var cur = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function makePage() {
  var page = {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData: function (patch) {
      Object.keys(patch).forEach(function (k) {
        if (k.indexOf(".") === -1 && k.indexOf("[") === -1) {
          page.data[k] = patch[k];
        } else {
          setPath(page.data, k, patch[k]);
        }
      });
    },
  };
  Object.keys(pageConfig).forEach(function (k) {
    if (k !== "data") {
      page[k] = pageConfig[k];
    }
  });
  return page;
}

function summaryItem(overrides) {
  return Object.assign(
    {
      item_id: "it-b4",
      name: "降压药",
      location_text: "厨房第二个抽屉",
      note: "",
      version: 4,
      updated_at: "2026-10-14T02:00:00.000Z",
    },
    overrides,
  );
}

/** 无 generation 的提醒行(旧服务端投影):上屏但轮次未知(-1) */
function legacyRow(dueDate) {
  return {
    item_id: "it-b4",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: dueDate,
    kind: "有效期",
  };
}

function remindWriteCalls() {
  return cloudCalls.filter(function (c) {
    return (
      c.name === "itemsApi" &&
      (c.data.action === "remindComplete" ||
        c.data.action === "remindSet" ||
        c.data.action === "remindClear")
    );
  });
}

function settlePromises() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 30);
  });
}

/**
 * 本地今天往后 days 天的 picker 可用日期,并避开 avoid(远端值/已确认基准的
 * 固定日):picker 提交校验拒绝过去的日子(remind-ui.pickerDateProblem,
 * "选今天或往后的日子"),写死的「未来日」会随现实时间推进过期——2026-10-25
 * 在 2026-10-26 起即被拒,用例随日期整体失效;撞上 avoid 则候选与远端/基准
 * 同值,基准一致用例还会因 value === remindOriginal 提前返回(零 remindSet)。
 */
function pickFutureDate(days, avoid) {
  function iso(d) {
    return (
      d.getFullYear() +
      "-" +
      (d.getMonth() < 9 ? "0" : "") +
      (d.getMonth() + 1) +
      "-" +
      (d.getDate() < 10 ? "0" : "") +
      d.getDate()
    );
  }
  var d = new Date();
  d.setDate(d.getDate() + days);
  while (avoid.indexOf(iso(d)) !== -1) {
    d.setDate(d.getDate() + 1);
  }
  return iso(d);
}

/** 断言冲突面板里有提醒条目(远端值 vs 本地候选,未选边) */
function assertRemindPanel(page, expectedLocal, expectedRemote) {
  var entry = page.data.conflicts.filter(function (c) {
    return c.key === "remind";
  })[0];
  assert.ok(entry, "提醒字段进入冲突双值面板");
  assert.equal(entry.localValue, expectedLocal, "面板「你的修改」= 本地候选");
  assert.equal(entry.remoteValue, expectedRemote, "面板「最新记录」= 远端值");
  assert.equal(entry.choice, null, "尚未选边(显式选择后才能写)");
  assert.equal(page.data.conflictPending, true, "门禁在(保存禁用)");
  assert.equal(page.data.editPanelOpen, true, "编辑折叠强制展开:看得见两版值再选");
}

/* ---------------- 红:补拉撞见不同远端,不得直接写 ---------------- */

test("F4-B4-红-改期:补拉撞见不同远端,remindSet 不得发出,候选保留并进冲突双值面板", async function () {
  resetEnv();
  // 前情:进页时提醒行弱网加载失败(轮次 -1、基准空),用户不知道 A 已设 11-01;
  // 写前补拉读到远端 2026-11-01/轮次 5——与用户已确认基准(空)不同
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  remindListMode = "fail";
  await pageConfig.refreshReminderRow.call(page);
  await settlePromises();
  assert.equal(page.data.remindGeneration, -1, "前置:轮次未知");
  assert.equal(page.remindOriginal, "", "前置:基准未确认过任何远端值");

  remindListMode = "row";
  serverRow = {
    item_id: "it-b4",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-11-01",
    kind: "有效期",
    generation: 5,
  };
  serverItem = summaryItem({ version: 4 });

  var pick = pickFutureDate(9, ["2026-11-01"]);
  await pageConfig.onRemindDateChange.call(page, { detail: { value: pick } });
  await settlePromises();

  assert.equal(
    remindWriteCalls().filter(function (c) {
      return c.data.action === "remindSet";
    }).length,
    0,
    "补拉撞见不同远端:不得直接 remindSet 覆盖用户从未看过的远端值",
  );
  assert.equal(page.data.remindAt, pick, "本地候选保留在表单");
  assertRemindPanel(page, pick, "2026-11-01");
  assert.equal(page.data.remindGeneration, 5, "轮次已对齐远端最新(选边后按它提交)");
  assert.ok(
    toasts.some(function (t) {
      return t.title.indexOf("选择保留哪一版") !== -1;
    }),
    "提示进入冲突选边:" + JSON.stringify(toasts.map(function (t) { return t.title; })),
  );
});

test("F4-B4-红-保存补写:补拉撞见不同远端,保存不得发任何提醒写,进面板", async function () {
  resetEnv();
  // 前情:改期被 F4-B2 拦下后候选 10-25 留在表单待补写(轮次 -1);
  // 保存补写前补拉读到远端 11-01/轮次 5——与基准(空)不同
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  pageConfig.setPendingRemind.call(page, "2026-10-25");
  assert.equal(pageConfig.pendingRemindWrite.call(page) !== null, true, "前置:存在待补写");
  assert.equal(page.data.remindGeneration, -1, "前置:轮次未知");

  serverRow = {
    item_id: "it-b4",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-11-01",
    kind: "有效期",
    generation: 5,
  };
  serverItem = summaryItem({ version: 4 });

  await pageConfig.onSaveTap.call(page);
  await settlePromises();

  assert.equal(remindWriteCalls().length, 0, "补拉撞见不同远端:保存不得发任何提醒写");
  assert.equal(page.data.remindAt, "2026-10-25", "候选保留");
  assertRemindPanel(page, "2026-10-25", "2026-11-01");
});

test("F4-B4-红-清除:补拉撞见不同远端,remindClear 不得发出,进面板", async function () {
  resetEnv();
  // 前情:旧服务端投影(无 generation)上屏 10-20(轮次 -1、基准 10-20);
  // 点 ✕ 清除前补拉读到远端已被家人改到 11-05/轮次 5
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  pageConfig.applyReminderRow.call(page, legacyRow("2026-10-20"));
  assert.equal(page.data.remindGeneration, -1, "前置:上屏但轮次未知");
  assert.equal(page.remindOriginal, "2026-10-20", "前置:基准 = 用户已确认的 10-20");

  serverRow = {
    item_id: "it-b4",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-11-05",
    kind: "有效期",
    generation: 5,
  };
  serverItem = summaryItem({ version: 4 });

  await pageConfig.onRemindFieldClear.call(page);
  await settlePromises();

  assert.equal(
    remindWriteCalls().filter(function (c) {
      return c.data.action === "remindClear";
    }).length,
    0,
    "补拉撞见不同远端:不得直接 remindClear 删掉用户从未看过的远端提醒",
  );
  assert.equal(page.data.remindAt, "", "候选(不带提醒)保留在表单");
  assertRemindPanel(page, "", "2026-11-05");
});

test("F4-B4-红-用完了:补拉发现提醒已变化,必须先经带新日期的显式确认才能 remindComplete", async function () {
  resetEnv();
  // 前情:旧服务端投影(无 generation)上屏 10-20;用户点「用完了」,
  // 补拉读到远端已被家人改到 11-01/轮次 5——用户从未看过 11-01
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  pageConfig.applyReminderRow.call(page, legacyRow("2026-10-20"));
  assert.equal(page.data.remindGeneration, -1, "前置:轮次未知");

  serverRow = {
    item_id: "it-b4",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-11-01",
    kind: "有效期",
    generation: 5,
  };

  await pageConfig.onExpireDoneTap.call(page);
  await settlePromises();

  var completes = remindWriteCalls().filter(function (c) {
    return c.data.action === "remindComplete";
  });
  var newDateText = remindUi.monthDayText("2026-11-01");
  // 红:未修复代码只有「用完了吗」(不带日期)就直接 remindComplete(generation 5),
  // 完成的是用户从未确认过的 11-01
  assert.ok(
    modals[0] && modals[0].content && modals[0].content.indexOf(newDateText) !== -1,
    "第一个弹窗必须是带新日期(" + newDateText + ")的显式确认,先于任何完成:" +
      JSON.stringify(modals.map(function (m) { return m.title + "|" + m.content; })),
  );
  assert.equal(completes.length, 1, "显式确认后才完成一次");
  assert.equal(completes[0].data.expected_generation, 5, "按补拉读到的最新轮次完成");
  assert.equal(
    page.data.expire,
    null,
    "完成后到期行收起(既有行为;确认动作本身已在带日期的弹窗里完成)",
  );
});

test("F4-B4-红-用完了-取消:显式确认框取消时不写 remindComplete,屏上如实显示最新提醒", async function () {
  resetEnv();
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  pageConfig.applyReminderRow.call(page, legacyRow("2026-10-20"));

  serverRow = {
    item_id: "it-b4",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-11-01",
    kind: "有效期",
    generation: 5,
  };

  // 本用例:确认框一律点「取消」——不确认最新提醒就绝不完成
  var originalShowModal = globalThis.wx.showModal;
  globalThis.wx.showModal = function (o) {
    modals.push(o);
    if (o.success) {
      o.success({ confirm: false });
    }
  };
  try {
    await pageConfig.onExpireDoneTap.call(page);
    await settlePromises();
  } finally {
    globalThis.wx.showModal = originalShowModal;
  }

  assert.equal(
    remindWriteCalls().filter(function (c) {
      return c.data.action === "remindComplete";
    }).length,
    0,
    "用户未确认最新提醒:不得 remindComplete",
  );
  assert.equal(
    page.data.expire && page.data.expire.dueDate,
    "2026-11-01",
    "屏上如实显示最新提醒,用户看清后再决定",
  );
});

test("F4-B4-红-清除-无提醒:补拉确认远端已无提醒时,清除不再发空写,表单对齐远端事实", async function () {
  resetEnv();
  // 前情:旧投影上屏 10-20(轮次 -1);清除前补拉发现远端提醒已被家人清掉
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  pageConfig.applyReminderRow.call(page, legacyRow("2026-10-20"));
  serverRow = null; // remindList 返回空:远端已无提醒

  await pageConfig.onRemindFieldClear.call(page);
  await settlePromises();

  assert.equal(remindWriteCalls().length, 0, "远端已无提醒:没有可清除的,不发空写");
  assert.equal(page.data.remindAt, "", "表单对齐远端事实(不带提醒)");
  assert.equal(page.data.remindGeneration, 0, "轮次对齐为 0(补录语义)");
});

test("F4-B4-选边闭环:冲突面板选「保留我的修改」后保存,才按最新轮次 remindSet", async function () {
  resetEnv();
  // 承接「红-改期」的后续:面板出现 → 用户显式选保留本地 10-25 → 保存补写,
  // 此时才以刷新后的最新轮次(5)提交——显式选择构成知情覆盖
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  remindListMode = "fail";
  await pageConfig.refreshReminderRow.call(page);
  await settlePromises();

  remindListMode = "row";
  serverRow = {
    item_id: "it-b4",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-11-01",
    kind: "有效期",
    generation: 5,
  };
  serverItem = summaryItem({ version: 4 });

  var pick = pickFutureDate(9, ["2026-11-01"]);
  await pageConfig.onRemindDateChange.call(page, { detail: { value: pick } });
  await settlePromises();
  assert.equal(remindWriteCalls().length, 0, "选边前零提醒写");

  pageConfig.applyConflictChoice.call(page, "remind", "local");
  assert.equal(page.data.conflicts[0].choice, "local", "已显式选边");

  await pageConfig.onSaveTap.call(page);
  await settlePromises();
  var sets = remindWriteCalls().filter(function (c) {
    return c.data.action === "remindSet";
  });
  assert.equal(sets.length, 1, "选边保存后一次补写");
  assert.equal(sets[0].data.due_date, pick, "写的是用户显式保留的候选");
  assert.equal(sets[0].data.expected_generation, 5, "以刷新后的最新轮次提交(既有 CAS 口径)");
});

/* ---------------- 对照:正常路径不被误拦(修复前后都应通过) ---------------- */

test("F4-B4-对照-无提醒补录:补拉确认远端无提醒,改期照常补录且必带 expected_generation=0", async function () {
  resetEnv();
  // 前情:进页提醒行加载失败(轮次 -1、基准空);补拉确认远端确实无提醒
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  remindListMode = "fail";
  await pageConfig.refreshReminderRow.call(page);
  await settlePromises();
  assert.equal(page.data.remindGeneration, -1, "前置:轮次未知");

  remindListMode = "row";
  serverRow = null; // 远端确认无提醒
  await pageConfig.onRemindDateChange.call(page, {
    detail: { value: pickFutureDate(9, []) },
  });
  await settlePromises();

  var sets = remindWriteCalls().filter(function (c) {
    return c.data.action === "remindSet";
  });
  assert.equal(sets.length, 1, "无提醒补录不被误拦:照常一次 remindSet");
  assert.equal(sets[0].data.expected_generation, 0, "补录语义必带 expected_generation=0");
  assert.equal(page.data.conflicts.length, 0, "无冲突:不进面板");
});

test("F4-B4-对照-基准一致:补拉远端与用户已确认基准一致,改期照常按轮次提交", async function () {
  resetEnv();
  // 前情:旧投影(无 generation)上屏 11-01,基准已确认 11-01;补拉远端仍是
  // 11-01(这次带上了轮次 5)——远端没变化,不属于「用户尚未知悉的他人修改」
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  pageConfig.applyReminderRow.call(page, legacyRow("2026-11-01"));
  assert.equal(page.data.remindGeneration, -1, "前置:轮次未知");
  assert.equal(page.remindOriginal, "2026-11-01", "前置:基准已确认 11-01");

  serverRow = {
    item_id: "it-b4",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-11-01",
    kind: "有效期",
    generation: 5,
  };
  await pageConfig.onRemindDateChange.call(page, {
    detail: { value: pickFutureDate(30, ["2026-11-01"]) },
  });
  await settlePromises();

  var sets = remindWriteCalls().filter(function (c) {
    return c.data.action === "remindSet";
  });
  assert.equal(sets.length, 1, "基准一致不被误拦:照常一次 remindSet");
  assert.equal(sets[0].data.expected_generation, 5, "按补拉轮次正常提交");
  assert.equal(page.data.conflicts.length, 0, "无冲突:不进面板");
});

test("F4-B4-对照-清除-基准一致:补拉远端与基准一致,清除照常(带轮次)", async function () {
  resetEnv();
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  pageConfig.applyReminderRow.call(page, legacyRow("2026-10-20"));

  serverRow = {
    item_id: "it-b4",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-10-20",
    kind: "有效期",
    generation: 5,
  };
  await pageConfig.onRemindFieldClear.call(page);
  await settlePromises();

  var clears = remindWriteCalls().filter(function (c) {
    return c.data.action === "remindClear";
  });
  assert.equal(clears.length, 1, "基准一致不被误拦:照常一次 remindClear");
  assert.equal(clears[0].data.expected_generation, 5, "按补拉轮次正常清除");
  assert.equal(page.data.conflicts.length, 0, "无冲突:不进面板");
});

test("F4-B4-对照-用完了:补拉基准一致照常完成(带轮次);远端已无提醒则不完成", async function () {
  // 基准一致:屏上 10-20(轮次 -1),补拉远端仍是 10-20(轮次 5)→ 照常完成
  resetEnv();
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  pageConfig.applyReminderRow.call(page, legacyRow("2026-10-20"));
  serverRow = {
    item_id: "it-b4",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-10-20",
    kind: "有效期",
    generation: 5,
  };
  await pageConfig.onExpireDoneTap.call(page);
  await settlePromises();
  var completes = remindWriteCalls().filter(function (c) {
    return c.data.action === "remindComplete";
  });
  assert.equal(completes.length, 1, "基准一致不被误拦:照常一次 remindComplete");
  assert.equal(completes[0].data.expected_generation, 5, "按补拉轮次正常完成");

  // 远端已无提醒:补拉发现无可完成 → 不写
  resetEnv();
  var page2 = makePage();
  pageConfig.applySummary.call(page2, summaryItem());
  pageConfig.applyReminderRow.call(page2, legacyRow("2026-10-20"));
  serverRow = null;
  await pageConfig.onExpireDoneTap.call(page2);
  await settlePromises();
  assert.equal(
    remindWriteCalls().filter(function (c) {
      return c.data.action === "remindComplete";
    }).length,
    0,
    "远端已无提醒:没有可完成的,不写",
  );
  assert.equal(page2.data.expire, null, "到期行如实收起");
});
