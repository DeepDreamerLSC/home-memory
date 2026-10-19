"use strict";

/**
 * #36 真机反馈三件 B:已处理后问「保留还是删除物品记录」(用户功能请求)。
 * - KD-ASK:askKeepAfterDone 三分支——确认=保留、取消=删除物品、
 *   fail(点遮罩/系统返回)=dismiss(调用方按保留处理,安全默认防误触);
 * - KD-R1:提醒页 onDoneTap——完成成功后追问;删除走 itemsApi delete
 *   (与详情页删除先例同款,api 层自动拼装作用域双 marker);删除成功列表
 *   刷新(行消失);删除失败如实 toast、不回滚已处理;保留分支现状零变化;
 * - KD-D1:详情页 onExpireDoneTap——同款追问;删除成功 navigateBack;
 *   删除失败 toast 后留在本页(已处理不回滚)。
 * 被测对象为 build:mp 产物(Page 构造器用桩捕获后按真实 setData 语义直调)。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");
var ui = require("../miniprogram/utils/remind-ui.js");

/* ---------------- KD-ASK:askKeepAfterDone 三分支 ---------------- */

test("KD-ASK-1:确认=保留 / 取消=删除物品 / fail=dismiss;文案与按钮字样", async function () {
  var modals = [];
  var mode = "confirm";
  globalThis.wx = {
    showModal: function (o) {
      modals.push(o);
      if (mode === "fail") {
        if (o.fail) {
          o.fail({ errMsg: "showModal:fail" });
        }
        return;
      }
      o.success({ confirm: mode === "confirm" });
    },
  };
  assert.equal(await ui.askKeepAfterDone("感冒药"), "keep", "确认(保留)");
  mode = "cancel";
  assert.equal(await ui.askKeepAfterDone("感冒药"), "delete", "取消(删除物品)");
  mode = "fail";
  assert.equal(await ui.askKeepAfterDone("感冒药"), "dismiss", "点遮罩/系统返回:dismiss,调用方按保留");
  delete globalThis.wx;

  assert.equal(modals.length, 3);
  assert.equal(modals[0].title, "已处理", "标题「已处理」");
  assert.equal(modals[0].content, "「感冒药」的记录还保留吗?", "content 点名物品");
  assert.equal(modals[0].confirmText, "保留");
  assert.equal(modals[0].cancelText, "删除物品");

  globalThis.wx = {
    showModal: function (o) {
      modals.push(o);
      o.success({ confirm: true });
    },
  };
  assert.equal(await ui.askKeepAfterDone(""), "keep", "空名兜底");
  assert.ok(modals[3].content.indexOf("这件东西") !== -1, "空名兜底「这件东西」");
  delete globalThis.wx;
});

/* ---------------- 公共页面桩 ---------------- */

function setPath(obj, key, value) {
  var parts = key.replace(/\]/g, "").split(/[.[]/);
  var cur = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function makePageFrom(config) {
  var page = {
    data: JSON.parse(JSON.stringify(config.data)),
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
  Object.keys(config).forEach(function (k) {
    if (k !== "data") {
      page[k] = config[k];
    }
  });
  return page;
}

var toasts = [];
var backCalls = 0;
var cloudCalls = [];
/** showModal 应答编排:按顺序消费 [「处理好了吗」应答, 「已处理-保留/删除」应答] */
var modalScript = [];
/** 服务端开关 */
var deleteResult = "ok";
var remindListRows = [];

function installWx() {
  toasts = [];
  backCalls = 0;
  cloudCalls = [];
  modalScript = [];
  deleteResult = "ok";
  remindListRows = [];
  globalThis.wx = {
    showToast: function (o) {
      toasts.push(o.title);
    },
    showModal: function (o) {
      var step = modalScript.shift() || { confirm: true };
      if (step.fail) {
        if (o.fail) {
          o.fail({ errMsg: "showModal:fail" });
        }
        return;
      }
      o.success({ confirm: step.confirm === true });
    },
    navigateTo: function () {},
    navigateBack: function () {
      backCalls += 1;
    },
    reLaunch: function () {},
    getStorageSync: function () {
      return "";
    },
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
              if (o.success) {
                o.success({ result: result });
              }
            },
            function (err) {
              if (o.fail) {
                o.fail({ errMsg: String((err && err.message) || err) });
              }
            },
          );
      },
    },
  };
}

function router(name, data) {
  if (name === "households" && data.action === "status") {
    return { ok: true, household_id: "default", shared: false };
  }
  if (name === "itemsApi") {
    if (data.action === "remindList") {
      return { ok: true, reminders: remindListRows, household_id: "default" };
    }
    if (data.action === "remindComplete") {
      return { ok: true };
    }
    if (data.action === "delete") {
      if (deleteResult === "fail") {
        return { ok: false, error: "NOT_FOUND", message: "没有找到这条记录" };
      }
      return { ok: true };
    }
  }
  return Promise.reject(new Error("意外调用 " + name + ":" + (data && data.action)));
}

function settle(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms || 20);
  });
}

/* ---------------- KD-R1:提醒页 onDoneTap ---------------- */

var remindersConfig = null;
var itemConfig = null;
(function loadPages() {
  globalThis.getCurrentPages = function () {
    return [];
  };
  installWx();
  globalThis.Page = function (config) {
    remindersConfig = config;
  };
  require(path.join(ROOT, "miniprogram", "pages", "reminders", "reminders.js"));
  globalThis.Page = function (config) {
    itemConfig = config;
  };
  require(path.join(ROOT, "miniprogram", "pages", "item", "item.js"));
})();

function ymdDaysFromNow(days) {
  var d = new Date();
  d.setDate(d.getDate() + days);
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + m + "-" + day;
}

function remindRow(overrides) {
  return Object.assign(
    {
      item_id: "it-r1",
      name: "感冒药",
      location_text: "药箱第一格",
      due_date: ymdDaysFromNow(3),
      kind: "有效期",
      generation: 2,
    },
    overrides,
  );
}

/** 直接把行放进某分组 data(onDoneTap 的 rowOf 从 data 三分组取行) */
function withSoonRow(page, row, group) {
  var display = Object.assign({ initial: "感", pillText: "3 天后" }, row);
  page.setData({ loading: false, errorText: "", soon: group === "soon" ? [display] : [], later: group === "later" ? [display] : [] });
}

test("KD-R1-1:保留(确认)——不调 delete,「已处理」toast 照旧,列表刷新", async function () {
  installWx();
  modalScript = [{ confirm: true }, { confirm: true }]; // 「处理好了吗」确认 → 「已处理」选保留
  var page = makePageFrom(remindersConfig);
  withSoonRow(page, remindRow(), "soon");
  await remindersConfig.onDoneTap.call(page, {
    currentTarget: { dataset: { group: "soon", index: 0 } },
  });
  await settle();
  var completes = cloudCalls.filter(function (c) {
    return c.data.action === "remindComplete";
  });
  var deletes = cloudCalls.filter(function (c) {
    return c.data.action === "delete";
  });
  assert.equal(completes.length, 1, "remindComplete 照常一次");
  assert.equal(deletes.length, 0, "保留:绝不调 delete");
  assert.ok(toasts.indexOf("已处理。要下次提醒,到详情里选日子") !== -1, "保留分支 toast 现状零变化");
  assert.ok(
    cloudCalls.filter(function (c) {
      return c.data.action === "remindList";
    }).length >= 1,
    "完成后刷新列表(既有机制)",
  );
});

test("KD-R1-2:删除物品(取消)——delete 携带 item_id,成功后行随刷新消失", async function () {
  installWx();
  remindListRows = [remindRow()];
  modalScript = [{ confirm: true }, { confirm: false }]; // 「处理好了吗」确认 → 「已处理」选删除
  var page = makePageFrom(remindersConfig);
  await remindersConfig.onShow.call(page);
  await settle();
  assert.equal(page.data.soon.length, 1, "前置:行在列表");

  remindListRows = []; // 删除后服务端列表为空
  await remindersConfig.onDoneTap.call(page, {
    currentTarget: { dataset: { group: "soon", index: 0 } },
  });
  await settle();
  var deletes = cloudCalls.filter(function (c) {
    return c.data.action === "delete";
  });
  assert.equal(deletes.length, 1, "删除物品分支调 itemsApi delete");
  assert.equal(deletes[0].data.item_id, "it-r1", "删除参数与详情页先例同款(item_id;双 marker 由 api 层拼装)");
  assert.equal(page.data.soon.length, 0, "删除成功后刷新:该行从列表消失");
  assert.ok(toasts.indexOf("已删除") !== -1, "删除成功 toast");
});

test("KD-R1-3:删除失败——toast 错误文本,物品保留、已处理不回滚,仍刷新列表", async function () {
  installWx();
  deleteResult = "fail";
  modalScript = [{ confirm: true }, { confirm: false }];
  var page = makePageFrom(remindersConfig);
  withSoonRow(page, remindRow({ due_date: "2026-10-10" }), "soon");
  await remindersConfig.onDoneTap.call(page, {
    currentTarget: { dataset: { group: "soon", index: 0 } },
  });
  await settle();
  var completes = cloudCalls.filter(function (c) {
    return c.data.action === "remindComplete";
  });
  assert.equal(completes.length, 1, "完成已发生:不因删除失败回滚");
  assert.ok(
    toasts.some(function (t) {
      return t.indexOf("没删成:") === 0;
    }),
    "删除失败如实 toast:" + JSON.stringify(toasts),
  );
  assert.ok(
    cloudCalls.filter(function (c) {
      return c.data.action === "remindList";
    }).length >= 1,
    "失败后仍刷新列表(收掉的提醒行消失,物品行不在此页)",
  );
});

test("KD-R1-4:dismiss(fail 回调)——按保留处理,不调 delete", async function () {
  installWx();
  modalScript = [{ confirm: true }, { fail: true }]; // 「处理好了吗」确认 → 追问框被遮罩/系统返回打断
  var page = makePageFrom(remindersConfig);
  withSoonRow(page, remindRow({ due_date: "2026-12-01" }), "later");
  await remindersConfig.onDoneTap.call(page, {
    currentTarget: { dataset: { group: "later", index: 0 } },
  });
  await settle();
  assert.equal(
    cloudCalls.filter(function (c) {
      return c.data.action === "delete";
    }).length,
    0,
    "dismiss=保留(安全默认,防误触删除)",
  );
  assert.ok(toasts.indexOf("已处理。要下次提醒,到详情里选日子") !== -1, "按保留分支收尾");
});

/* ---------------- KD-D1:详情页 onExpireDoneTap ---------------- */

function summaryItem() {
  return {
    item_id: "it-d1",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    note: "",
    version: 4,
    updated_at: "2026-10-14T02:00:00.000Z",
  };
}

function loadedItemPage() {
  var page = makePageFrom(itemConfig);
  itemConfig.applySummary.call(page, summaryItem());
  itemConfig.applyReminderRow.call(page, {
    item_id: "it-d1",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-10-20",
    kind: "有效期",
    generation: 1,
  });
  return page;
}

test("KD-D1-1:删除物品(取消)——delete 成功后 toast「已删除」并 navigateBack", async function () {
  installWx();
  modalScript = [{ confirm: true }, { confirm: false }];
  var page = loadedItemPage();
  await itemConfig.onExpireDoneTap.call(page);
  await settle(900); // 「已删除」后的返回上一页在 800ms setTimeout 内
  var deletes = cloudCalls.filter(function (c) {
    return c.data.action === "delete";
  });
  assert.equal(deletes.length, 1, "删除物品分支调 itemsApi delete");
  assert.equal(deletes[0].data.item_id, "it-d1", "与 ⋯ 菜单删除先例同款调用");
  assert.equal(page.data.expire, null, "完成后到期行已收起(既有)");
  assert.ok(toasts.indexOf("已删除") !== -1, "删除成功 toast");
  assert.equal(backCalls, 1, "删除成功返回上一页");
});

test("KD-D1-2:删除失败——toast 错误,留在本页,已处理不回滚(到期行不复活)", async function () {
  installWx();
  deleteResult = "fail";
  modalScript = [{ confirm: true }, { confirm: false }];
  var page = loadedItemPage();
  await itemConfig.onExpireDoneTap.call(page);
  await settle();
  assert.ok(
    toasts.some(function (t) {
      return t.indexOf("没删成:") === 0;
    }),
    "删除失败如实 toast:" + JSON.stringify(toasts),
  );
  assert.equal(backCalls, 0, "留在本页(物品保留,可稍后再删)");
  assert.equal(page.data.expire, null, "已处理不回滚:到期行不复活");
  assert.equal(page.data.remindGeneration, 0, "完成状态保持");
});

test("KD-D1-3:保留(确认)与 dismiss——不调 delete,「已处理」toast 照旧", async function () {
  installWx();
  modalScript = [{ confirm: true }, { confirm: true }];
  var page = loadedItemPage();
  await itemConfig.onExpireDoneTap.call(page);
  await settle();
  assert.equal(
    cloudCalls.filter(function (c) {
      return c.data.action === "delete";
    }).length,
    0,
    "保留:不调 delete",
  );
  assert.ok(toasts.indexOf("已处理。要下次提醒,到详情里选日子") !== -1);
  assert.equal(backCalls, 0, "保留:留在本页(现状)");

  installWx();
  modalScript = [{ confirm: true }, { fail: true }];
  var page2 = loadedItemPage();
  await itemConfig.onExpireDoneTap.call(page2);
  await settle();
  assert.equal(
    cloudCalls.filter(function (c) {
      return c.data.action === "delete";
    }).length,
    0,
    "dismiss=保留:不调 delete",
  );
  assert.ok(toasts.indexOf("已处理。要下次提醒,到详情里选日子") !== -1, "按保留分支收尾");
});
