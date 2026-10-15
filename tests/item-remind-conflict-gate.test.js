"use strict";

/**
 * PR #56 架构复审 F4-B1 回归:提醒冲突待选 / 待补写状态下,提醒的真实写入
 * (用完了 remindComplete / 改期 remindSet / 清除 remindClear)必须失败关闭。
 *
 * 复审情景(双机复现):初始 10-20,A 改 11-01,B 试图改 10-25 → B 弹冲突、
 * 尚未选边 → B 点详情「用完了」→ 旧代码直接以远端新轮次调 remindComplete,
 * 绕开选边硬门,可能完成 A 的 11-01 轮次。要求:冲突或待补写状态下禁用 +
 * 提示先处理冲突;预览态(到期行显示的「你正要存的候选」)不得冒充已确认
 * 的当前提醒。
 *
 * 被测对象是 `npm run build:mp` 产物 miniprogram/pages/item/item.js
 * (Page 构造器用桩捕获后按真实 setData 语义直调方法),零外部依赖。
 * 红绿纪律:本文件在未修复代码上必须失败(remindComplete 被调用),
 * 修复后转绿。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");

/* ---------------- wx 桩 + Page 桩(先装好再 require 详情页产物) ---------------- */

var toasts = [];
var modals = [];
var cloudCalls = [];

/** 服务端状态由用例内改写:提醒行 / remindSet 结果 / itemsApi.get 投影 */
var serverRow = null;
var remindSetResult = "ok"; // ok | conflict
var serverItem = null;

function resetEnv() {
  toasts = [];
  modals = [];
  cloudCalls = [];
  serverRow = null;
  remindSetResult = "ok";
  serverItem = null;
}

function router(name, data) {
  if (name === "households" && data.action === "status") {
    // 个人态作用域:资格复核(硬门 C)可通过,提醒行按 itemsApi 真实路径拉取
    return { ok: true, household_id: "default", shared: false };
  }
  if (name === "itemsApi") {
    if (data.action === "remindList") {
      if (serverRow === null) {
        return Promise.reject(new Error("remindList 不可用"));
      }
      return { ok: true, reminders: [serverRow], household_id: "default" };
    }
    if (data.action === "get") {
      if (serverItem === null) {
        return Promise.reject(new Error("get 不可用"));
      }
      return { ok: true, item: serverItem };
    }
    if (data.action === "remindSet") {
      if (remindSetResult === "conflict") {
        return {
          ok: false,
          error: "VERSION_CONFLICT",
          message: "内容已被修改,已为你刷新,请重试",
        };
      }
      return {
        ok: true,
        reminder: {
          item_id: data.item_id,
          due_date: data.due_date,
          kind: "下次维护",
          generation: (serverRow && serverRow.generation ? serverRow.generation : 0) + 1,
        },
      };
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
      // 二次确认一律点「确认」:驱动「用完了吗」弹窗放行,验证其后的真实写入被门禁拦下
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
  // 页面自定义实例字段(original / remindOriginal / pendingRetry 等)原样挂上
  Object.keys(pageConfig).forEach(function (k) {
    if (k !== "data" && typeof pageConfig[k] !== "function") {
      page[k] = pageConfig[k];
    }
  });
  Object.keys(pageConfig).forEach(function (k) {
    if (typeof pageConfig[k] === "function") {
      page[k] = pageConfig[k];
    }
  });
  return page;
}

function summaryItem(overrides) {
  return Object.assign(
    {
      item_id: "it-b1",
      name: "降压药",
      location_text: "厨房第二个抽屉",
      note: "",
      version: 4,
      updated_at: "2026-10-14T02:00:00.000Z",
    },
    overrides,
  );
}

/** 已加载到 gen1 @ 10-20 的常态页面(applySummary + applyReminderRow 真实驱动) */
function loadedPage() {
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  pageConfig.applyReminderRow.call(page, {
    item_id: "it-b1",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-10-20",
    kind: "有效期",
    generation: 1,
  });
  return page;
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

/* ---------------- F4-B1 主线:冲突待选时「用完了」绝不完成任何轮次 ---------------- */

test("F4-B1-主:提醒冲突待选时点「用完了」,remindComplete 未被调用,候选与面板保留", async function () {
  resetEnv();
  var page = loadedPage();
  // 家人(A)已把提醒改到 12-01 第 2 轮:下一次 remindList / get 都会看到新事实
  serverRow = {
    item_id: "it-b1",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-12-01",
    kind: "有效期",
    generation: 2,
  };
  serverItem = summaryItem({ version: 5 });
  remindSetResult = "conflict";

  // 本机(B)试图改到 11-25 → remindSet 撞 VERSION_CONFLICT → 冲突刷新 → 面板弹出
  await pageConfig.onRemindDateChange.call(page, { detail: { value: "2026-11-25" } });
  await settlePromises();
  assert.equal(page.data.conflicts.length, 1, "提醒字段进入冲突面板");
  assert.equal(page.data.conflicts[0].key, "remind");
  assert.equal(page.data.conflicts[0].choice, null, "尚未选边");
  assert.equal(page.data.conflictPending, true, "门禁在(保存禁用)");
  assert.equal(page.data.remindGeneration, 2, "轮次已对齐远端新轮次(复审指出的危险组合)");
  assert.equal(page.data.remindAt, "2026-11-25", "表单是本地候选,不是已确认的当前提醒");
  assert.equal(page.data.expire && page.data.expire.dueDate, "2026-11-25", "到期行显示的是候选预览");

  // 复审动作:未选边直接点「用完了」
  cloudCalls.length = 0;
  toasts = [];
  modals = [];
  await pageConfig.onExpireDoneTap.call(page);
  await settlePromises();

  assert.equal(
    remindWriteCalls().filter(function (c) {
      return c.data.action === "remindComplete";
    }).length,
    0,
    "remindComplete 未被调用:预览态不得冒充已确认的当前提醒去完成远端新轮次",
  );
  assert.equal(modals.length, 0, "失败关闭应发生在「用完了吗」确认之前,不先骗用户确认");
  assert.ok(
    toasts.some(function (t) {
      return t.title.indexOf("冲突") !== -1 && t.icon === "none";
    }),
    "提示先处理冲突:" + JSON.stringify(toasts.map(function (t) { return t.title; })),
  );
  // 候选与面板原样保留:用户仍需选边,没有被静默清掉
  assert.equal(page.data.remindAt, "2026-11-25", "候选保留");
  assert.equal(page.data.conflicts.length, 1, "冲突面板保留");
  assert.equal(page.data.conflictPending, true, "门禁保持");
  assert.equal(page.data.remindGeneration, 2, "轮次保持");
});

test("F4-B1-待补写:提醒远端不可得遗留待写选择时,「用完了」同样失败关闭", async function () {
  resetEnv();
  var page = loadedPage();
  // remindSet 撞冲突,且冲突刷新那轮 remindList 拉取失败(弱网):
  // 选择留在表单待补写(remindRemoteUnknown),轮次停在旧所见 1
  remindSetResult = "conflict";
  serverItem = summaryItem({ version: 5 });
  serverRow = null; // remindList 不可用

  await pageConfig.onRemindDateChange.call(page, { detail: { value: "2026-11-25" } });
  await settlePromises();
  assert.equal(page.data.conflicts.length, 0, "提醒远端不可得:不猜远端,不进面板");
  assert.equal(page.remindRemoteUnknown, true, "标记远端不可得");
  assert.equal(page.data.remindAt, "2026-11-25", "候选留在表单等保存补写");
  assert.equal(
    pageConfig.pendingRemindWrite.call(page) !== null,
    true,
    "待补写状态在册",
  );

  cloudCalls.length = 0;
  toasts = [];
  modals = [];
  await pageConfig.onExpireDoneTap.call(page);
  await settlePromises();

  assert.equal(remindWriteCalls().length, 0, "待补写状态下 remindComplete 未被调用");
  assert.equal(page.data.remindAt, "2026-11-25", "候选保留,没有被完成动作顺手清掉");
});

test("F4-B1-改期与清除:待补写状态下改日子/清除只更新候选,不发真实写入", async function () {
  resetEnv();
  var page = loadedPage();
  remindSetResult = "conflict";
  serverItem = summaryItem({ version: 5 });
  serverRow = null;

  await pageConfig.onRemindDateChange.call(page, { detail: { value: "2026-11-25" } });
  await settlePromises();
  assert.equal(pageConfig.pendingRemindWrite.call(page) !== null, true, "处于待补写状态");

  // 用户再改日子:只更新候选,不直接 remindSet
  cloudCalls.length = 0;
  toasts = [];
  await pageConfig.onRemindDateChange.call(page, { detail: { value: "2026-11-30" } });
  await settlePromises();
  assert.equal(
    remindWriteCalls().filter(function (c) {
      return c.data.action === "remindSet";
    }).length,
    0,
    "待补写状态下改期不发 remindSet",
  );
  assert.equal(page.data.remindAt, "2026-11-30", "候选更新为新选的日子");
  assert.ok(
    toasts.some(function (t) {
      return t.title.indexOf("保存修改") !== -1;
    }),
    "如实引导走保存修改补写:" + JSON.stringify(toasts.map(function (t) { return t.title; })),
  );

  // 用户点 ✕ 清除:同样只更新候选,不直接 remindClear
  cloudCalls.length = 0;
  toasts = [];
  await pageConfig.onRemindFieldClear.call(page);
  await settlePromises();
  assert.equal(
    remindWriteCalls().filter(function (c) {
      return c.data.action === "remindClear";
    }).length,
    0,
    "待补写状态下清除不发 remindClear",
  );
  assert.equal(page.data.remindAt, "", "候选更新为「不带提醒」");
});

test("F4-B1-对照:无冲突无待补写时「用完了」照常完成(不误伤既有路径)", async function () {
  resetEnv();
  var page = loadedPage();
  serverRow = {
    item_id: "it-b1",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-10-20",
    kind: "有效期",
    generation: 1,
  };
  await pageConfig.onExpireDoneTap.call(page);
  await settlePromises();
  var completes = remindWriteCalls().filter(function (c) {
    return c.data.action === "remindComplete";
  });
  assert.equal(completes.length, 1, "常态下一次完成");
  assert.equal(completes[0].data.expected_generation, 1, "带所见轮次号(既有 CAS 口径)");
  assert.equal(page.data.expire, null, "完成后到期行收起(既有行为)");
});
