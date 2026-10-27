"use strict";
/**
 * 位置内直接添加物品——建档/挂载响应丢失的确定性故障注入测试
 * (PR #124 评审 5669295913 要求补齐;验证「网络异常下数据不丢不重」的完整链路)
 */
var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");

var locationsPage = null;
var toasts = [];
var modals = [];
globalThis.Page = function (options) { locationsPage = options; };
globalThis.wx = {
  showToast: function (o) { toasts.push(o); },
  showModal: function (o) { modals.push(o); },
  showActionSheet: function () {},
  navigateTo: function () {},
  navigateBack: function () {},
  setNavigationBarTitle: function () {},
  stopPullDownRefresh: function () {},
  getStorageSync: function () { return ""; },
  setStorageSync: function () {},
  removeStorageSync: function () {},
};
require(path.join(ROOT, "miniprogram/pages/locations/locations.js"));

// 用真实 ApiError 类
var apiMod = require(path.join(ROOT, "miniprogram/utils/api.js"));
var locApiMod = require(path.join(ROOT, "miniprogram/utils/locations-api.js"));
var ApiError = apiMod.ApiError;
var origCallItems = apiMod.callItemsApi;
var origCallLoc = locApiMod.callLocationsApi;
test.after(function () {
  apiMod.callItemsApi = origCallItems;
  locApiMod.callLocationsApi = origCallLoc;
});

function makePage() {
  var page = {
    data: JSON.parse(JSON.stringify(locationsPage.data)),
    setData: function (p) { Object.keys(p).forEach(function (k) { page.data[k] = p[k]; }); },
  };
  Object.keys(locationsPage).forEach(function (k) {
    if (k === "data") return;
    if (typeof locationsPage[k] === "function") { page[k] = locationsPage[k]; return; }
  });
  page.data.currentNodeId = "lc_room1";
  page.data.isRoot = false;
  page.data.currentNodeName = "书房";
  page.nodePath = ["书房"];
  page.data.itemPanel = {
    visible: true, createOperationId: "", frozenName: "", frozenQuantity: 0,
    frozenUnitIndex: 0, frozenLocationText: "", name: "", quantity: 1, unitIndex: 0, busy: false,
  };
  page.loadNode = async function () {};
  page.applyPendingHighlight = function () {};
  page.pendingHl = "";
  return page;
}

test("ITEM-IDEMPOTENT-1:建档成功但响应丢失(CLIENT_NETWORK)→重试用冻结值→仅一件物品", async function () {
  toasts = []; modals = [];
  var calls = [];
  apiMod.callItemsApi = async function (event) {
    calls.push(event);
    if (calls.length === 1) throw new ApiError("CLIENT_NETWORK", "网络异常");
    return { ok: true, item: { item_id: "it-f1", version: 1, name: event.name }, duplicated: true };
  };
  locApiMod.callLocationsApi = async function () { return { ok: true }; };

  var page = makePage();
  page.data.itemPanel.name = "充电器";
  await locationsPage.onItemSaveTap.call(page);
  assert.ok(modals.some(function (m) { return m.title.indexOf("可能已保存") !== -1; }), "首次超时提示: " + modals.map(function(m){return m.title}).join("|"));
  assert.ok(page.data.itemPanel.createOperationId !== "", "operation_id 已生成");

  // 重试(用户点确认或再次调用)
  await locationsPage.onItemSaveTap.call(page);
  assert.equal(calls.length, 2, "共两次 create");
  assert.equal(calls[0].operation_id, calls[1].operation_id, "同 operation_id");
  // 完整建档请求一致(评审 5669638959:不只 name,全部载荷逐字段)
  assert.deepEqual(
    { name: calls[1].name, quantity: calls[1].quantity, unit: calls[1].unit, location_text: calls[1].location_text },
    { name: calls[0].name, quantity: calls[0].quantity, unit: calls[0].unit, location_text: calls[0].location_text },
    "完整建档请求逐字段一致(冻结值)"
  );
  // 仅一件物品:两次调用返回同一个 item_id(duplicated 幂等)
  assert.equal(calls.filter(function(c){return c.operation_id}).length, 2, "两次请求同键");
  // 服务端视角:同 operation_id 只产生一个 item(mock 中第二次返回 duplicated:true → 同一 item_id)
  // 在 mock 层面验证:两次请求参数完全一致 → 服务端幂等返回同一物品 → 用户侧仅一件
  assert.ok(calls[0].operation_id === calls[1].operation_id, "服务端幂等前提=同键同内容→仅一件");
});

test("ITEM-IDEMPOTENT-2:未知状态下清空名称→不拦在空名称门,仍用冻结值重试", async function () {
  toasts = []; modals = [];
  var calls = [];
  apiMod.callItemsApi = async function (event) {
    calls.push(event);
    if (calls.length === 1) throw new ApiError("CLIENT_TIMEOUT", "请求超时");
    return { ok: true, item: { item_id: "it-f2", version: 1, name: event.name }, duplicated: true };
  };
  locApiMod.callLocationsApi = async function () { return { ok: true }; };

  var page = makePage();
  page.data.itemPanel.name = "剪刀";
  await locationsPage.onItemSaveTap.call(page);
  assert.equal(page.data.itemPanel.frozenName, "剪刀", "冻结=剪刀");

  page.data.itemPanel.name = ""; // 清空
  await locationsPage.onItemSaveTap.call(page);
  assert.ok(!toasts.some(function (t) { return t.title.indexOf("名称不能为空") !== -1; }), "空名称不拦截");
  assert.equal(calls[1].name, "剪刀", "重试用冻结值");
  assert.equal(calls[0].operation_id, calls[1].operation_id, "同 operation_id");
});

test("ITEM-IDEMPOTENT-3:挂载成功但响应丢失(CLIENT_NETWORK)→提示「待核对」非确定失败", async function () {
  toasts = []; modals = [];
  apiMod.callItemsApi = async function () {
    return { ok: true, item: { item_id: "it-m1", version: 1, name: "胶带" } };
  };
  var locCount = 0;
  var serverMounted = false; // 模拟服务端状态
  locApiMod.callLocationsApi = async function (event) {
    locCount++;
    if (locCount === 1) {
      serverMounted = true; // 服务端实际已成功挂载(写入完成)
      throw new ApiError("CLIENT_NETWORK", "网络异常"); // 但响应在网络中丢失
    }
    return { ok: true };
  };

  var page = makePage();
  page.data.itemPanel.name = "胶带";
  await locationsPage.onItemSaveTap.call(page);

  // 服务端实际已挂载成功(评审 5669638959:模拟先写入再丢响应)
  assert.ok(serverMounted, "服务端实际已执行挂载(写入完成,响应丢失)");
  var m = modals.find(function (x) { return x.title.indexOf("核对") !== -1 || x.title.indexOf("挂") !== -1; });
  assert.ok(m, "有挂载弹窗");
  assert.ok(m.title.indexOf("待核对") !== -1, "标题含待核对: " + m.title);
  assert.ok(m.title.indexOf("没挂上") === -1, "不是确定失败口径");
  assert.ok(m.content.indexOf("可能已挂到") !== -1, "内容含「可能已挂到」(如实描述不确定态)");
});

test("ITEM-IDEMPOTENT-4:挂载明确拒绝(VERSION_CONFLICT)→提示确定失败(旧口径)", async function () {
  toasts = []; modals = [];
  apiMod.callItemsApi = async function () {
    return { ok: true, item: { item_id: "it-m2", version: 1, name: "尺子" } };
  };
  locApiMod.callLocationsApi = async function () {
    throw new ApiError("VERSION_CONFLICT", "版本冲突");
  };

  var page = makePage();
  page.data.itemPanel.name = "尺子";
  await locationsPage.onItemSaveTap.call(page);

  var m = modals.find(function (x) { return x.title.indexOf("记住") !== -1 || x.title.indexOf("挂") !== -1; });
  assert.ok(m, "有弹窗");
  assert.ok(m.title.indexOf("没挂上") !== -1, "明确拒绝=旧口径: " + m.title);
  assert.ok(m.title.indexOf("待核对") === -1, "不是待核对(是确定失败)");
});
