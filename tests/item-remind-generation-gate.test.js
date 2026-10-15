"use strict";

/**
 * PR #56 架构复审 F4-B2 回归:提醒轮次未知(remindGeneration=-1)时,
 * 新详情页不得发起任何 reminder 写(remindSet / remindClear / remindComplete)。
 *
 * 复审证据:item.ts 初始 remindGeneration=-1;onRemindDateChange / onSaveTap /
 * onRemindFieldClear 以条件展开省略 expected_generation,服务端缺省按旧协议
 * 无条件替换(itemsApi handler 721-730 / 1737-1740)。弱网 remindList 失败、
 * 尚未加载完成或冲突刷新远端不可得时,客户端会无 CAS 地覆盖/清除家人更新。
 *
 * 要求:读不到轮次(-1)时保留用户候选并提示刷新重试;成功读到 0/真实轮次后
 * 才发带 expected_generation 的写请求。后端兼容不动(旧客户端仍可用),
 * 新客户端绝不主动退回无条件写。
 *
 * 被测对象是 `npm run build:mp` 产物 miniprogram/pages/item/item.js
 * (Page 构造器用桩捕获后按真实 setData 语义直调方法),零外部依赖。
 * 红绿纪律:未加载 / 加载失败 / 冲突刷新失败三条在未修复代码上必须失败
 * (写请求已发出),修复后转绿;另附正路径对照(读到轮次后必带 expected_generation)。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");

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
      item_id: "it-b2",
      name: "降压药",
      location_text: "厨房第二个抽屉",
      note: "",
      version: 4,
      updated_at: "2026-10-14T02:00:00.000Z",
    },
    overrides,
  );
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
    setTimeout(resolve, 20);
  });
}

/* ---------------- 三条阻断回归:轮次未知(-1)时零提醒写、候选保留 ---------------- */

test("F4-B2-未加载:提醒行还没加载完(轮次-1)就选日子,无写请求发出且候选保留", async function () {
  resetEnv();
  // 页面刚打开:applySummary 完成,refreshReminderRow 尚未返回(onShow 在途),
  // remindGeneration 停在初始 -1;此时弱网下补拉也不可用
  remindListMode = "fail";
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  assert.equal(page.data.remindGeneration, -1, "前置:轮次未知");

  await pageConfig.onRemindDateChange.call(page, { detail: { value: "2026-11-25" } });
  await settlePromises();

  assert.equal(remindWriteCalls().length, 0, "未加载完成:不得发起任何 reminder 写(绝不退回旧协议无条件写)");
  assert.equal(page.data.remindAt, "2026-11-25", "用户候选保留在表单");
  assert.equal(
    page.data.expire && page.data.expire.dueDate,
    "2026-11-25",
    "候选同步到期行(预览,可再改)",
  );
  assert.ok(
    toasts.some(function (t) {
      return t.title.indexOf("已保留") !== -1 || t.title.indexOf("再试") !== -1;
    }),
    "提示刷新/重试,不静默吞掉:" + JSON.stringify(toasts.map(function (t) { return t.title; })),
  );
});

test("F4-B2-加载失败:提醒行拉取失败(轮次-1)后选日子,无写请求发出且候选保留", async function () {
  resetEnv();
  remindListMode = "fail";
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  // onShow 的刷新真实跑过一轮:先清空再拉,拉取失败静默,轮次停在 -1
  await pageConfig.refreshReminderRow.call(page);
  await settlePromises();
  assert.equal(page.data.remindGeneration, -1, "前置:加载失败后轮次未知");
  assert.equal(page.data.expire, null, "加载失败静默不显示保质期行(既有行为)");

  await pageConfig.onRemindDateChange.call(page, { detail: { value: "2026-11-25" } });
  await settlePromises();

  assert.equal(remindWriteCalls().length, 0, "加载失败:不得发起任何 reminder 写");
  assert.equal(page.data.remindAt, "2026-11-25", "用户候选保留");
});

test("F4-B2-冲突刷新失败:刷新那轮提醒远端不可得(轮次仍-1),改期与保存补写都不发写", async function () {
  resetEnv();
  // 前情:用户改备注保存撞 VERSION_CONFLICT,冲突刷新时 remindList 弱网失败——
  // 提醒远端不可得、轮次从未读到,候选只能留在表单
  remindListMode = "fail";
  serverItem = summaryItem({ version: 5, note: "家人改的备注" });
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  pageConfig.onNoteInput.call(page, { detail: { value: "我改的备注" } });
  var result = await pageConfig.refreshForConflict.call(page);
  await settlePromises();
  assert.equal(result, "refreshed", "冲突刷新主体成功");
  assert.equal(page.remindRemoteUnknown, true, "提醒远端不可得在册");
  assert.equal(page.data.remindGeneration, -1, "前置:整轮没读到轮次,仍为 -1");

  // 用户选日子:不得发 remindSet
  cloudCalls.length = 0;
  toasts = [];
  await pageConfig.onRemindDateChange.call(page, { detail: { value: "2026-11-25" } });
  await settlePromises();
  assert.equal(
    remindWriteCalls().filter(function (c) {
      return c.data.action === "remindSet";
    }).length,
    0,
    "冲突刷新失败后:改期不得发起 remindSet",
  );
  assert.equal(page.data.remindAt, "2026-11-25", "候选保留");

  // 保存补写路径同样不得发:冲突面板在(备注未选边),先显式选边再保存
  pageConfig.applyConflictChoice.call(page, "note", "local");
  cloudCalls.length = 0;
  toasts = [];
  await pageConfig.onSaveTap.call(page);
  await settlePromises();
  var writes = remindWriteCalls();
  assert.equal(writes.length, 0, "轮次未知时保存补写不得发起任何 reminder 写");
  assert.equal(page.data.remindAt, "2026-11-25", "候选仍保留在表单等下次重试");
});

test("F4-B2-保存补写:轮次未知直接点保存修改,提醒不写、候选保留、文本照常保存", async function () {
  resetEnv();
  remindListMode = "fail";
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  // 直驱待补写状态:此前改期被拦,候选 11-25 留在表单,轮次从未读到
  pageConfig.setPendingRemind.call(page, "2026-11-25");
  assert.equal(pageConfig.pendingRemindWrite.call(page) !== null, true, "前置:存在待补写");

  await pageConfig.onSaveTap.call(page);
  await settlePromises();
  assert.equal(remindWriteCalls().length, 0, "轮次未知:保存不得发起任何 reminder 写");
  assert.equal(page.data.remindAt, "2026-11-25", "候选保留");
  assert.ok(
    toasts.some(function (t) {
      return t.title.indexOf("提醒没存上") !== -1;
    }),
    "如实说提醒没存上:" + JSON.stringify(toasts.map(function (t) { return t.title; })),
  );
});

/* ---------------- 正路径对照:读到轮次后必带 expected_generation(绝不省略) ---------------- */

test("F4-B2-对照:读到真实轮次/确认无提醒(0)后,改期与清除必带 expected_generation", async function () {
  // 真实轮次 3:改期必带 expected_generation: 3
  resetEnv();
  serverRow = {
    item_id: "it-b2",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-10-20",
    kind: "有效期",
    generation: 3,
  };
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  pageConfig.applyReminderRow.call(page, serverRow);
  await pageConfig.onRemindDateChange.call(page, { detail: { value: "2026-11-25" } });
  await settlePromises();
  var sets = remindWriteCalls().filter(function (c) {
    return c.data.action === "remindSet";
  });
  assert.equal(sets.length, 1, "常态改期一次");
  assert.equal(sets[0].data.expected_generation, 3, "轮次已知:必带 expected_generation");

  // 确认无提醒(0,补录语义):补录必带 expected_generation: 0
  resetEnv();
  var page2 = makePage();
  pageConfig.applySummary.call(page2, summaryItem());
  pageConfig.applyReminderRow.call(page2, null);
  assert.equal(page2.data.remindGeneration, 0, "前置:0=已确认无提醒");
  await pageConfig.onRemindDateChange.call(page2, { detail: { value: "2026-11-25" } });
  await settlePromises();
  var sets2 = remindWriteCalls().filter(function (c) {
    return c.data.action === "remindSet";
  });
  assert.equal(sets2.length, 1, "补录一次");
  assert.equal(sets2[0].data.expected_generation, 0, "补录也必带 expected_generation(0)");

  // 清除路径:轮次 3 清除必带 expected_generation: 3
  resetEnv();
  serverRow = {
    item_id: "it-b2",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-10-20",
    kind: "有效期",
    generation: 3,
  };
  var page3 = makePage();
  pageConfig.applySummary.call(page3, summaryItem());
  pageConfig.applyReminderRow.call(page3, serverRow);
  await pageConfig.onRemindFieldClear.call(page3);
  await settlePromises();
  var clears = remindWriteCalls().filter(function (c) {
    return c.data.action === "remindClear";
  });
  assert.equal(clears.length, 1, "常态清除一次");
  assert.equal(clears[0].data.expected_generation, 3, "清除必带 expected_generation");
});
