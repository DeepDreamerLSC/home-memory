"use strict";

/**
 * Q1 数量页面接线(item 详情「设为当前总数」/ confirm 语音批量行携带):
 * - item 页:上次确认数量展示(§10.1 词表)、未确认不预填、保存走 update
 *   {quantity, unit}(0 合法)、VERSION_CONFLICT 用 current 展示最新值;
 * - confirm 页:draft 数量三项 → 行预填「待确认」→ create 随行携带;
 *   未提取且未触碰 → 不携带(服务端缺省 1/件);手动表单可填可不填。
 * 被测对象是 `npm run build:mp` 产物页面 .js。
 * 红绿纪律:本文件在未实现数量的代码上必须失败,实现后全绿。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");

var ROOT = path.join(__dirname, "..");

var toasts = [];
var modals = [];
var cloudCalls = [];

/** itemsApi router:默认成功;用例内按需改写 */
var itemsApiRouter = function () {
  throw new Error("itemsApi router 未配置");
};

function installWx() {
  globalThis.wx = {
    showToast: function (o) {
      toasts.push(o.title);
    },
    showModal: function (o) {
      modals.push(o);
      if (o.success) o.success({ confirm: true });
    },
    navigateTo: function () {},
    navigateBack: function () {},
    reLaunch: function () {},
    pageScrollTo: function () {},
    getStorageSync: function () {
      return "";
    },
    setStorageSync: function () {},
    removeStorageSync: function () {},
    requestSubscribeMessage: function (o) {
      if (o && o.complete) o.complete({});
    },
    cloud: {
      callFunction: function (o) {
        cloudCalls.push({ name: o.name, data: JSON.parse(JSON.stringify(o.data)) });
        Promise.resolve()
          .then(function () {
            return itemsApiRouter(o.name, o.data);
          })
          .then(
            function (result) {
              o.success({ result: result });
            },
            function (err) {
              o.fail({ errMsg: String((err && err.message) || err) });
            }
          );
      },
    },
  };
}

function setPath(obj, key, value) {
  var parts = key.replace(/\]/g, "").split(/[.[]/);
  var cur = obj;
  for (var i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  cur[parts[parts.length - 1]] = value;
}

function pageOf(pageConfig) {
  var page = {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData: function (patch) {
      var keys = Object.keys(patch);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.indexOf(".") === -1 && k.indexOf("[") === -1) page.data[k] = patch[k];
        else setPath(page.data, k, patch[k]);
      }
    },
  };
  Object.keys(pageConfig).forEach(function (k) {
    if (k !== "data") page[k] = pageConfig[k];
  });
  return page;
}

function resetEnv() {
  toasts = [];
  modals = [];
  cloudCalls = [];
  itemsApiRouter = function () {
    throw new Error("itemsApi router 未配置");
  };
}

function summaryItem(over) {
  return Object.assign(
    {
      item_id: "it-q1",
      name: "棉柔巾",
      location_text: "卫生间镜柜",
      note: "",
      version: 1,
      updated_at: "2026-10-20T08:00:00.000Z",
      quantity: null,
      unit: null,
      quantity_confirmed_at: null,
    },
    over || {}
  );
}

/* ---------------- item 详情页 ---------------- */

installWx();
var itemConfig;
globalThis.Page = function (config) {
  itemConfig = config;
};
require(path.join(ROOT, "miniprogram", "pages", "item", "item.js"));

test("item 详情:已确认行显示「上次确认 ×N单位」+ 确认时间;未确认行显示「待核对」", function () {
  resetEnv();
  var page = pageOf(itemConfig);
  page.applySummary(summaryItem({ quantity: 3, unit: "包", quantity_confirmed_at: "2026-10-18T08:00:00.000Z" }));
  assert.equal(page.data.quantityText, "上次确认 ×3包 · 10-18");
  assert.equal(page.data.quantityConfirmed, true);

  var legacy = pageOf(itemConfig);
  legacy.applySummary(summaryItem({}));
  assert.equal(legacy.data.quantityText, "待核对");
  assert.equal(legacy.data.quantityConfirmed, false);
});

test("item 详情:未确认行数量输入不预填 1(占位待核对);填 0 合法;保存走 update {quantity, unit}", async function () {
  resetEnv();
  var updated = null;
  itemsApiRouter = function (name, data) {
    if (name === "itemsApi" && data.action === "update") {
      updated = data;
      return {
        ok: true,
        item: summaryItem({ quantity: data.quantity, unit: data.unit, version: 2, quantity_confirmed_at: "2026-10-21T00:00:00.000Z" }),
      };
    }
    return Promise.reject(new Error("意外调用 " + name + ":" + data.action));
  };
  var page = pageOf(itemConfig);
  page.applySummary(summaryItem({}));
  assert.equal(page.data.quantityDraft, "", "未确认行绝不预填 1");
  // 用户主动填写 0(确认目前没有)+ 单位选「包」
  page.onQuantityInput({ detail: { value: "0" } });
  page.onQuantityUnitChange({ detail: { value: 1 } }); // UNIT_SET[1] = "个"
  await page.onQuantitySaveTap();
  var updateCall = cloudCalls.filter(function (c) {
    return c.name === "itemsApi" && c.data.action === "update";
  })[0];
  assert.ok(updateCall, "必须发出数量 update");
  assert.equal(updateCall.data.quantity, 0);
  assert.equal(updateCall.data.unit, "个");
  assert.equal(updateCall.data.expected_version, 1);
  assert.ok(updateCall.data.update_id, "数量保存必须带 update_id(响应丢失可重放识别)");
  assert.equal(page.data.quantityText, "上次确认 ×0个");
});

test("item 详情:未填数量点保存 → 不发 update,提示先核对", async function () {
  resetEnv();
  var page = pageOf(itemConfig);
  page.applySummary(summaryItem({}));
  await page.onQuantitySaveTap();
  var updates = cloudCalls.filter(function (c) {
    return c.name === "itemsApi" && c.data.action === "update";
  });
  assert.equal(updates.length, 0);
  assert.ok(toasts.length > 0);
});

test("item 详情:VERSION_CONFLICT 响应 current → 展示最新值引导核对,绝不自动重放", async function () {
  resetEnv();
  itemsApiRouter = function (name, data) {
    if (data.action === "update") {
      return {
        ok: false,
        error: "VERSION_CONFLICT",
        message: "内容已被修改,已为你刷新,请重试",
        current: summaryItem({ quantity: 7, unit: "包", version: 2, quantity_confirmed_at: "2026-10-21T00:00:00.000Z" }),
      };
    }
    return Promise.reject(new Error("意外调用 " + data.action));
  };
  var page = pageOf(itemConfig);
  page.applySummary(summaryItem({ quantity: 3, unit: "包", quantity_confirmed_at: "2026-10-18T08:00:00.000Z" }));
  page.onQuantityInput({ detail: { value: "5" } });
  page.onQuantityUnitChange({ detail: { value: 2 } }); // "包"
  await page.onQuantitySaveTap();
  assert.equal(page.data.quantityText, "上次确认 ×7包", "冲突后以 current 展示家人已更新的最新值");
  assert.equal(page.data.version, 2, "版本对齐最新,重核对以新版本提交");
  var updates = cloudCalls.filter(function (c) {
    return c.name === "itemsApi" && c.data.action === "update";
  });
  assert.equal(updates.length, 1, "绝不自动把旧值再发一次");
});

/* ---------------- confirm 语音批量页 ---------------- */

delete require.cache[path.join(ROOT, "miniprogram", "pages", "confirm", "confirm.js")];
var confirmConfig;
globalThis.Page = function (config) {
  confirmConfig = config;
};
require(path.join(ROOT, "miniprogram", "pages", "confirm", "confirm.js"));

var draftSession = require(path.join(ROOT, "miniprogram", "utils", "draft-session.js"));

function draftWith(over) {
  return Object.assign(
    {
      name: "棉柔巾",
      location_text: "卫生间",
      certain: true,
      qualifiers: [],
      source_quote: "买了三包棉柔巾放卫生间",
      remind_at: null,
      remind_kind: null,
      remind_quote: null,
      remind_vague_quote: null,
      remind_converted: null,
      mount_path: null,
    },
    over || {}
  );
}

function freshConfirmPage(sid) {
  var page = pageOf(confirmConfig);
  page.onLoad({ sid: sid });
  return page;
}

test("confirm:draft 数量三项锚定成功 → 行预填 3/包并标待确认;create 随行携带", async function () {
  resetEnv();
  draftSession.__setDraftSessionStorageForTest(null);
  draftSession.__resetDraftSessionForTest();
  var sid = draftSession.createDraftSession("买了三包棉柔巾放卫生间", [
    draftWith({ quantity: 3, unit: "包", quantity_quote: "三包" }),
  ], false);
  var page = freshConfirmPage(sid);
  assert.equal(page.data.rows[0].quantity, 3);
  assert.equal(page.data.rows[0].unit, "包");
  assert.equal(page.data.rows[0].quantityProvided, true);
  assert.equal(page.data.rows[0].quantityBadge, "待确认");

  itemsApiRouter = function (name, data) {
    if (name === "itemsApi" && data.action === "create") {
      return { ok: true, item: summaryItem({ quantity: data.quantity || null, unit: data.unit || null }) };
    }
    return Promise.reject(new Error("意外调用 " + name + ":" + data.action));
  };
  await page.onSaveBatchTap();
  var createCall = cloudCalls.filter(function (c) {
    return c.name === "itemsApi" && c.data.action === "create";
  })[0];
  assert.ok(createCall, "必须发出 create");
  assert.equal(createCall.data.quantity, 3);
  assert.equal(createCall.data.unit, "包");
});

test("confirm:draft 未说数量 → 行预填 1/件标待确认;create 不携带(服务端缺省 1/件)", async function () {
  resetEnv();
  draftSession.__setDraftSessionStorageForTest(null);
  draftSession.__resetDraftSessionForTest();
  var sid = draftSession.createDraftSession("棉柔巾放卫生间", [
    draftWith({ quantity: null, unit: null, quantity_quote: null, source_quote: "棉柔巾放卫生间" }),
  ], false);
  var page = freshConfirmPage(sid);
  assert.equal(page.data.rows[0].quantity, 1);
  assert.equal(page.data.rows[0].unit, "件");
  assert.equal(page.data.rows[0].quantityProvided, false);

  itemsApiRouter = function (name, data) {
    if (data.action === "create") {
      return { ok: true, item: summaryItem({ quantity: 1, unit: "件" }) };
    }
    return Promise.reject(new Error("意外调用 " + name + ":" + data.action));
  };
  await page.onSaveBatchTap();
  var createCall = cloudCalls.filter(function (c) {
    return c.name === "itemsApi" && c.data.action === "create";
  })[0];
  assert.ok(!("quantity" in createCall.data), "未提取也未触碰的行不注入数量键");
});

test("confirm:用户步进数量 → quantityProvided 翻 true,create 携带新值", async function () {
  resetEnv();
  draftSession.__setDraftSessionStorageForTest(null);
  draftSession.__resetDraftSessionForTest();
  var sid = draftSession.createDraftSession("棉柔巾放卫生间", [
    draftWith({ quantity: null, unit: null, quantity_quote: null, source_quote: "棉柔巾放卫生间" }),
  ], false);
  var page = freshConfirmPage(sid);
  page.onRowQtyStep({ currentTarget: { dataset: { index: 0, d: 2 } } });
  assert.equal(page.data.rows[0].quantity, 3, "1 + 2 = 3");
  assert.equal(page.data.rows[0].quantityProvided, true, "用户触碰=确认数量");

  itemsApiRouter = function (name, data) {
    if (data.action === "create") {
      return { ok: true, item: summaryItem({}) };
    }
    return Promise.reject(new Error("意外调用 " + name + ":" + data.action));
  };
  await page.onSaveBatchTap();
  var createCall = cloudCalls.filter(function (c) {
    return c.name === "itemsApi" && c.data.action === "create";
  })[0];
  assert.equal(createCall.data.quantity, 3);
  assert.equal(createCall.data.unit, "件");
});

test("confirm 手动表单:数量默认不填 → create 不带数量;填 4+盒 → 携带", async function () {
  resetEnv();
  var page = pageOf(confirmConfig);
  page.onLoad({ manual: "true" });
  page.onNameInput({ detail: { value: "洗衣液" } });
  page.onLocationInput({ detail: { value: "阳台" } });

  itemsApiRouter = function (name, data) {
    if (data.action === "create") {
      return { ok: true, item: summaryItem({}) };
    }
    return Promise.reject(new Error("意外调用 " + name + ":" + data.action));
  };
  await page.onSaveTap();
  var first = cloudCalls.filter(function (c) {
    return c.name === "itemsApi" && c.data.action === "create";
  })[0];
  assert.ok(!("quantity" in first.data), "手动表单不填 → 缺省 1/件(不带数量键)");

  var page2 = pageOf(confirmConfig);
  page2.onLoad({ manual: "true" });
  page2.onNameInput({ detail: { value: "洗衣液" } });
  page2.onLocationInput({ detail: { value: "阳台" } });
  page2.onQuantityInput({ detail: { value: "4" } });
  page2.onQuantityUnitChange({ detail: { value: 3 } }); // UNIT_SET[3] = "盒"
  await page2.onSaveTap();
  var second = cloudCalls.filter(function (c) {
    return c.name === "itemsApi" && c.data.action === "create";
  })[1];
  assert.equal(second.data.quantity, 4);
  assert.equal(second.data.unit, "盒");
});
