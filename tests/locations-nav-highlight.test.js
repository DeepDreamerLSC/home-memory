"use strict";
/**
 * issue #121 批次乙 ④:跳转高亮接线(消费批次甲 #123 的 nav-highlight 纯工具)。
 * - 物品移动完成(详情页/D1 三选/B 页)→ buildLocationNavPlan 决定导航方案;
 *   执行器 utils/location-nav.js:navigateBack 回退场景先写模块级 pending 高亮,
 *   目标位置页 onShow 消费(不依赖 onLoad);navigateTo/redirectTo 场景走
 *   url 的 node_id + hl 参数,目标页 onLoad 读取;
 * - 位置页:高亮 800ms 后消除(mock timers 精确到毫秒);
 * - 合并完成同理高亮相关节点(hl = 目标节点 id,落层后高亮本层头部);
 * - 详情页 / D1 / B 页的接线为源断言(.ts 消费 navToLocationLayer)。
 */
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");
var api = require(path.join(ROOT, "miniprogram/utils/api.js"));
var locationsApi = require(path.join(ROOT, "miniprogram/utils/locations-api.js"));
var navHighlight = require(path.join(ROOT, "miniprogram/utils/nav-highlight.js"));
var locationNav = require(path.join(ROOT, "miniprogram/utils/location-nav.js"));

var navigations = [];
var toasts = [];

function baseWx() {
  var store = {};
  return {
    getStorageSync: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : ""; },
    setStorageSync: function (k, v) { store[k] = v; },
    removeStorageSync: function (k) { delete store[k]; },
    showToast: function (o) { toasts.push(o); },
    showModal: function (o) {
      if (typeof o.success === "function") o.success({ confirm: true });
    },
    showActionSheet: function () {},
    showLoading: function () {},
    hideLoading: function () {},
    navigateTo: function (o) { navigations.push({ kind: "navigateTo", url: o.url }); },
    redirectTo: function (o) { navigations.push({ kind: "redirectTo", url: o.url }); },
    navigateBack: function (o) { navigations.push({ kind: "navigateBack", delta: (o && o.delta) || 1 }); },
    setNavigationBarTitle: function () {},
    stopPullDownRefresh: function () {},
  };
}

function resetStubs() {
  navigations = [];
  toasts = [];
}

var locationsPage = null;
globalThis.Page = function (options) {
  locationsPage = options;
};

function makePage(options) {
  var page = {
    data: JSON.parse(JSON.stringify(options.data)),
    setData: function (patch) {
      Object.keys(patch).forEach(function (k) { page.data[k] = patch[k]; });
    },
  };
  Object.keys(options).forEach(function (k) {
    if (k === "data" || typeof options[k] === "function") return;
    var v = options[k];
    page[k] = Array.isArray(v) ? [] : (v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v)));
  });
  Object.keys(options)
    .filter(function (k) { return typeof options[k] === "function"; })
    .forEach(function (k) { page[k] = options[k]; });
  return page;
}

globalThis.wx = baseWx();
require(path.join(ROOT, "miniprogram/pages/locations/locations.js"));

var originalCallItems = api.callItemsApi;
var originalCallLocations = locationsApi.callLocationsApi;

function itemsRouter(handler) {
  api.callItemsApi = function (event) { return Promise.resolve(handler(event)); };
}

function locationsRouter(handler) {
  locationsApi.callLocationsApi = function (event) { return Promise.resolve(handler(event)); };
}

test.after(function () {
  api.callItemsApi = originalCallItems;
  locationsApi.callLocationsApi = originalCallLocations;
});

function studyLayerResponse(withItem) {
  var items = [];
  if (withItem) {
    items.push({ item_id: "it_9", name: "护照", location_text: "书房 / 桌子", note: "", version: 4, updated_at: 1760000000000 });
  }
  return {
    ok: true,
    node: { location_id: "lc_study", name: "书房", type: "room", path: ["书房"] },
    children: [
      { location_id: "lc_desk", name: "桌子", type: "furniture", path: ["书房", "桌子"], item_count: 0, child_count: 0 },
    ],
    items: items,
    unmounted_count: 0,
    dangling_mounts: 0,
  };
}

/** 桩页面栈:index / locations(root) / locations(lc_study) / …(由用例给出顶层) */
function fakeStack(topPages) {
  var base = [
    { route: "pages/index/index" },
    { route: "pages/locations/locations", nodeId: "" },
    { route: "pages/locations/locations", nodeId: "lc_study" },
  ];
  globalThis.getCurrentPages = function () { return base.concat(topPages); };
  return base;
}

/* ------------------------------------------------------------------ */
/* 模块级 pending 高亮(navigateBack 回退场景,不依赖 onLoad)          */
/* ------------------------------------------------------------------ */

test("W2B-PEND-1:同节点 set→consume 返回高亮 id 并清空;重复 consume 为空", () => {
  locationNav.setPendingLocationHighlight("lc_study", "it_9", 1000);
  assert.equal(locationNav.consumePendingLocationHighlight("lc_study", 1500), "it_9");
  assert.equal(locationNav.consumePendingLocationHighlight("lc_study", 1600), "", "consume 后清空");
});

test("W2B-PEND-2:节点不匹配 → 返回空串且保留(TTL 内正确的页仍可消费)", () => {
  locationNav.setPendingLocationHighlight("lc_study", "it_9", 1000);
  assert.equal(locationNav.consumePendingLocationHighlight("lc_other", 1500), "");
  assert.equal(locationNav.consumePendingLocationHighlight("lc_study", 1600), "it_9", "未清空,目标页仍能消费");
});

test("W2B-PEND-3:过期(TTL)后不再投递", () => {
  locationNav.setPendingLocationHighlight("lc_study", "it_9", 1000);
  var late = 1000 + locationNav.PENDING_HIGHLIGHT_TTL_MS + 1;
  assert.equal(locationNav.consumePendingLocationHighlight("lc_study", late), "", "过期即弃");
});

/* ------------------------------------------------------------------ */
/* 执行器 navToLocationLayer:buildLocationNavPlan 决定导航方案         */
/* ------------------------------------------------------------------ */

test("W2B-EXEC-BACK:栈内已有目标层 → navigateBack(stepsBack)且先写 pending(目标页 onShow 消费)", () => {
  resetStubs();
  fakeStack([{ route: "pages/item/item" }]);
  var method = locationNav.navToLocationLayer("lc_study", "it_9");
  assert.equal(method, "navigateBackToTarget");
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].kind, "navigateBack");
  assert.equal(navigations[0].delta, 1, "目标在栈内 1 层之下");
  assert.equal(locationNav.consumePendingLocationHighlight("lc_study"), "it_9", "回退场景 pending 已写入");
});

test("W2B-EXEC-TO:栈中无目标 → navigateTo(url 带 node_id 与 hl,encodeURIComponent)", () => {
  resetStubs();
  fakeStack([{ route: "pages/item/item" }]);
  var method = locationNav.navToLocationLayer("lc new/1", "it 9");
  assert.equal(method, "navigateTo");
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].kind, "navigateTo");
  assert.equal(navigations[0].url, "/pages/locations/locations?node_id=lc%20new%2F1&hl=it%209");
  assert.equal(locationNav.consumePendingLocationHighlight("lc new/1"), "", "前进场景不写 pending(onLoad 读 hl)");
});

test("W2B-EXEC-NONE:目标即栈顶 → method=none,零导航(原地刷新由调用方处理)", () => {
  resetStubs();
  fakeStack([]);
  globalThis.getCurrentPages = function () {
    return [
      { route: "pages/index/index" },
      { route: "pages/locations/locations", nodeId: "lc_study" },
    ];
  };
  assert.equal(locationNav.navToLocationLayer("lc_study", "it_9"), "none");
  assert.equal(navigations.length, 0);
});

test("W2B-EXEC-REDIRECT:栈近满(≥9)且栈中无目标 → redirectTo 兜底", () => {
  resetStubs();
  var pages = [{ route: "pages/index/index" }];
  for (var i = 0; i < 8; i++) pages.push({ route: "pages/other/other" });
  globalThis.getCurrentPages = function () { return pages; };
  assert.equal(locationNav.navToLocationLayer("lc_balcony", "it_9"), "redirectTo");
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].kind, "redirectTo");
  assert.ok(navigations[0].url.indexOf("node_id=lc_balcony") !== -1);
});

test("W2B-EXEC-STACK-DESC:栈描述只认 locations 页(其余层为 null);根层 locations 页 = 空串", () => {
  fakeStack([{ route: "pages/item/item" }]);
  var desc = locationNav.locationsStackNodeIds();
  assert.equal(desc.length, 4);
  assert.equal(desc[0], null, "非 locations 层 = null");
  assert.equal(desc[1], "", "根层 locations 页 = 空串");
  assert.equal(desc[2], "lc_study");
  assert.equal(desc[3], null);
});

/* ------------------------------------------------------------------ */
/* 位置页消费:onLoad 读 hl / onShow 消费 pending / 800ms 消除         */
/* ------------------------------------------------------------------ */

test("W2B-HL-ONLOAD:onLoad 读 url 的 hl 参数 → 物品行短高亮;800ms 后消除(mock timers 毫秒级)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  resetStubs();
  itemsRouter(function (event) {
    if (event.action === "locationScanLatest") return { scan: null };
    return { ok: true };
  });
  locationsRouter(function (event) {
    if (event.action === "list") return studyLayerResponse(true);
    return { ok: true };
  });
  var page = makePage(locationsPage);
  page.requestSeq = { next: function () { return 1; }, isCurrent: function () { return true; } };
  page.onLoad({ node_id: "lc_study", hl: "it_9" });
  await page.loadNode();
  assert.equal(page.data.highlightId, "it_9", "hl 命中物品行 → 高亮");
  t.mock.timers.tick(799);
  assert.equal(page.data.highlightId, "it_9", "799ms 仍在高亮");
  t.mock.timers.tick(1);
  assert.equal(page.data.highlightId, "", "800ms 整点消除");
});

test("W2B-HL-ONLOAD-NODE:hl 命中子节点行同样高亮;未命中任何行则不高亮", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  resetStubs();
  itemsRouter(function (event) {
    if (event.action === "locationScanLatest") return { scan: null };
    return { ok: true };
  });
  locationsRouter(function (event) {
    if (event.action === "list") return studyLayerResponse(false);
    return { ok: true };
  });
  var page = makePage(locationsPage);
  page.requestSeq = { next: function () { return 1; }, isCurrent: function () { return true; } };
  page.onLoad({ node_id: "lc_study", hl: "lc_desk" });
  await page.loadNode();
  assert.equal(page.data.highlightId, "lc_desk", "hl 命中子节点行");
  t.mock.timers.tick(800);
  assert.equal(page.data.highlightId, "");

  var page2 = makePage(locationsPage);
  page2.requestSeq = { next: function () { return 1; }, isCurrent: function () { return true; } };
  page2.onLoad({ node_id: "lc_study", hl: "it_unknown" });
  await page2.loadNode();
  assert.equal(page2.data.highlightId, "", "未命中不高亮(不闪不猜)");
});

test("W2B-HL-ONSHOW:navigateBack 回退场景——onShow 消费模块级 pending 高亮(不依赖 onLoad)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  resetStubs();
  itemsRouter(function (event) {
    if (event.action === "locationScanLatest") return { scan: null };
    return { ok: true };
  });
  locationsRouter(function (event) {
    if (event.action === "list") return studyLayerResponse(true);
    return { ok: true };
  });
  var page = makePage(locationsPage);
  page.requestSeq = { next: function () { return 1; }, isCurrent: function () { return true; } };
  page.onLoad({ node_id: "lc_study" });
  await page.loadNode();
  assert.equal(page.data.highlightId, "", "前置:无 hl 无高亮");
  // 模拟:详情页移动完成 → 回退到本层(executor 已写 pending)
  locationNav.setPendingLocationHighlight("lc_study", "it_9");
  page.onShow();
  await page.loadNode();
  assert.equal(page.data.highlightId, "it_9", "onShow 消费 pending → 高亮");
  t.mock.timers.tick(800);
  assert.equal(page.data.highlightId, "");
});

test("W2B-HL-ONSHOW-MISMATCH:pending 属于别的层 → 本页不消费不投递(留给正确页面)", async () => {
  resetStubs();
  itemsRouter(function (event) {
    if (event.action === "locationScanLatest") return { scan: null };
    return { ok: true };
  });
  locationsRouter(function (event) {
    if (event.action === "list") return studyLayerResponse(true);
    return { ok: true };
  });
  var page = makePage(locationsPage);
  page.requestSeq = { next: function () { return 1; }, isCurrent: function () { return true; } };
  page.onLoad({ node_id: "lc_study" });
  locationNav.setPendingLocationHighlight("lc_other", "it_9");
  page.onShow();
  await page.loadNode();
  assert.equal(page.data.highlightId, "", "别层的 pending 不投递到本页");
});

/* ------------------------------------------------------------------ */
/* 位置页内操作接线:物品移动 / 合并                                    */
/* ------------------------------------------------------------------ */

test("W2B-MOVE-ITEM:位置页移动物品到栈内祖先层 → navigateBack(不加层)+ pending 高亮;目标=本层 → 原地高亮", async () => {
  resetStubs();
  var deskLayer = {
    ok: true,
    node: { location_id: "lc_desk", name: "桌子", type: "furniture", path: ["书房", "桌子"] },
    children: [],
    items: [
      { item_id: "it_9", name: "护照", location_text: "书房 / 桌子", note: "", version: 4, updated_at: 1760000000000 },
    ],
    unmounted_count: 0,
    dangling_mounts: 0,
  };
  itemsRouter(function (event) {
    if (event.action === "locationScanLatest") return { scan: null };
    return { ok: true };
  });
  locationsRouter(function (event) {
    if (event.action === "list") return deskLayer;
    return { ok: true, item: { item_id: "it_9", version: 5, updated_at: 1760000000000 } };
  });
  // 栈:index / 根层 / 书房 / 桌子(当前页在桌子层,把物品挂回书房)
  fakeStack([{ route: "pages/locations/locations", nodeId: "lc_desk" }]);
  var page = makePage(locationsPage);
  page.requestSeq = { next: function () { return 1; }, isCurrent: function () { return true; } };
  page.onLoad({ node_id: "lc_desk" });
  await page.loadNode();
  var item = { item_id: "it_9", name: "护照", location_text: "书房 / 桌子", note: "", version: 4, updated_at: 1760000000000, updated_at_text: "x" };
  resetStubs();
  await page.doMoveItem(item, "lc_study");
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(navigations.length, 1, "移动完成发起一次导航");
  assert.equal(navigations[0].kind, "navigateBack", "目标层在栈内 → 回退不加层");
  assert.equal(navigations[0].delta, 1, "栈顶(桌子)到书房 = 1 层");
  assert.equal(locationNav.consumePendingLocationHighlight("lc_study"), "it_9", "pending 高亮已写入(物品 id)");

  // 目标即本层(method=none):原地刷新 + 本页直接高亮物品行
  resetStubs();
  fakeStack([{ route: "pages/locations/locations", nodeId: "lc_desk" }]);
  var page2 = makePage(locationsPage);
  page2.requestSeq = { next: function () { return 1; }, isCurrent: function () { return true; } };
  page2.onLoad({ node_id: "lc_desk" });
  await page2.loadNode();
  await page2.doMoveItem(item, "lc_desk");
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(navigations.length, 0, "目标=本层不导航");
  assert.equal(page2.data.highlightId, "it_9", "原地短高亮物品行");
});

test("W2B-MERGE:合并完成 → 按方案进入目标层并高亮相关节点(hl=目标节点 id,落层高亮本层头部)", async () => {
  resetStubs();
  itemsRouter(function (event) {
    if (event.action === "locationScanLatest") return { scan: null };
    return { ok: true };
  });
  locationsRouter(function (event) {
    if (event.action === "list") return studyLayerResponse(true);
    return { ok: true, node: { location_id: "lc_other" }, remounted: 2, compensated: 0 };
  });
  fakeStack([]);
  var page = makePage(locationsPage);
  page.requestSeq = { next: function () { return 1; }, isCurrent: function () { return true; } };
  page.onLoad({ node_id: "lc_study" });
  await page.loadNode();
  resetStubs();
  await page.doMerge({ location_id: "lc_merging", name: "书房", path: ["书房"] }, "lc_other");
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(navigations.length, 1);
  var nav = navigations[0];
  assert.ok(nav.kind === "navigateTo" || nav.kind === "redirectTo" || nav.kind === "navigateBack", "按 plan 执行");
  if (nav.url !== undefined) {
    assert.ok(nav.url.indexOf("node_id=lc_other") !== -1, "进入目标层");
    assert.ok(nav.url.indexOf("hl=lc_other") !== -1, "hl 携带目标节点 id(高亮相关节点)");
  } else {
    assert.equal(locationNav.consumePendingLocationHighlight("lc_other"), "lc_other", "回退场景 pending 携带目标节点 id");
  }
});

/* ------------------------------------------------------------------ */
/* 详情页 / D1 三选 / B 页接线(源断言:消费 navToLocationLayer)        */
/* ------------------------------------------------------------------ */

test("W2B-SRC-ITEM:详情页两处挂载成功(手动兜底 linkItem / ensurePath+linkItem)均接线跳转高亮", () => {
  var ts = fs.readFileSync(path.join(ROOT, "miniprogram/pages/item/item.ts"), "utf8");
  assert.ok(ts.indexOf("navToLocationLayer") !== -1, "详情页消费执行器");
  var linkAt = ts.indexOf("async doLinkToNode(nodeId, path)");
  var confirmAt = ts.indexOf("async confirmMount()");
  assert.ok(linkAt !== -1 && confirmAt !== -1);
  var linkBody = ts.slice(linkAt, linkAt + 4000);
  var confirmBody = ts.slice(confirmAt, confirmAt + 5000);
  assert.ok(linkBody.indexOf("navToLocationLayer") !== -1, "手动兜底挂载成功 → 跳转高亮");
  assert.ok(confirmBody.indexOf("navToLocationLayer") !== -1, "整理位置成功 → 跳转高亮");
});

test("W2B-SRC-D1:D1 三选移动在提交完成处记录高亮;「回到位置页」按方案回退并投递 pending", () => {
  var ts = fs.readFileSync(path.join(ROOT, "miniprogram/pages/location-video-scan/location-video-scan.ts"), "utf8");
  assert.ok(ts.indexOf("navToLocationLayer") !== -1, "D1 消费执行器");
  var doneAt = ts.indexOf("onDoneBackTap()");
  assert.ok(doneAt !== -1);
  assert.ok(ts.slice(doneAt, doneAt + 700).indexOf("navToLocationLayer") !== -1, "回到位置页走 plan(回退+pending)");
});

test("W2B-SRC-B:B 页(场景扫描)显式挂载完成记录高亮;「返回」按方案跳转", () => {
  var ts = fs.readFileSync(path.join(ROOT, "miniprogram/pages/video-scan/video-scan.ts"), "utf8");
  assert.ok(ts.indexOf("navToLocationLayer") !== -1, "B 页消费执行器");
  var doneAt = ts.indexOf("onDoneBackTap()");
  assert.ok(doneAt !== -1);
  assert.ok(ts.slice(doneAt, doneAt + 700).indexOf("navToLocationLayer") !== -1, "返回走 plan");
});

test("W2B-SRC-WXML:位置页高亮类接线(树行/物品行/头部);util 纯函数契约保持(buildLocationNavPlan 由执行器消费)", () => {
  var wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.wxml"), "utf8");
  assert.ok(wxml.indexOf("highlightId === item.location_id") !== -1, "树行高亮类");
  assert.ok(wxml.indexOf("highlightId === item.item_id") !== -1, "物品行高亮类");
  assert.ok(wxml.indexOf("highlightId === currentNodeId") !== -1, "本层头部高亮类(合并落层)");
  var wxss = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.wxss"), "utf8");
  assert.ok(wxss.indexOf(".row-hl") !== -1, "高亮样式定义");
  assert.equal(typeof navHighlight.buildLocationNavPlan, "function", "批次甲纯工具保持导出");
});
