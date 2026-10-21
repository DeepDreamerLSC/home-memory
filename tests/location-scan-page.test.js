"use strict";
/**
 * D1 位置级视频清点页面测试(issue #94,D1-IMPLEMENTATION.md §6/§7):
 * 被测对象是 `npm run build:mp` 产出的 locations.js 与 location-video-scan.js。
 * 零网络、零外部依赖;wx/cloud 全 stub,modal/sheet stub 防御性回调 success。
 *
 * 覆盖(#94 验收清单页面侧):
 * - D1P-REG:app.json 注册新页;首页零改动(不展示清点入口/摘要,#94 红线);
 * - D1P-ENTRY:位置页底部入口卡仅 browse 且非根层;根层不渲染(#94 验收 1);
 * - D1P-LAST:locationScanLatest 摘要渲染(确认 N 件/M 件已删)、无记录与失败静默(#94 验收 10);
 * - D1P-DELETE:三按钮弹窗影响面文案(#94 验收 11)、取消不调接口、migrate/purge 语义、
 *   purge NODE_NOT_EMPTY 收敛(逐件 itemsApi.delete 后重试)、根层无删除入口(#94 验收 12);
 * - D1P-SUBTREE:逐件子位置选择器仅含子树节点、子树外 nodeId 被拒(#94 验收 2);
 * - D1P-MOVE:三选移动语义——子树内只关联;子树外三选(只关联/移动+关联/取消不切)(#94 验收 4/5);
 * - D1P-BUILD:提交载荷(location 块、candidate_count、new 的 node_id+路径文本、
 *   existing 的 move_to_node_id+expected_version 配对)(#94 验收 7/9 客户端半边);
 * - D1P-REDLINE:回看不自动播放;B 的 pages/video-scan 零改动。
 */
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");
var api = require(path.join(ROOT, "miniprogram/utils/api.js"));
var locationsApi = require(path.join(ROOT, "miniprogram/utils/locations-api.js"));
var locationScanUtil = require(path.join(ROOT, "miniprogram/utils/location-scan.js"));

/* ---------------- wx 桩(modal/sheet 防御性回调 success) ---------------- */

var modalQueue = [];
var sheetQueue = [];
var toasts = [];
var navigations = [];

function baseWx() {
  var store = {};
  return {
    getStorageSync: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : ""; },
    setStorageSync: function (k, v) { store[k] = v; },
    removeStorageSync: function (k) { delete store[k]; },
    showToast: function (o) { toasts.push(o); },
    showModal: function (o) {
      modalQueue.push(o);
      if (typeof o.success === "function") o.success({ confirm: true, content: o.editable ? "stub" : undefined });
    },
    showActionSheet: function (o) {
      sheetQueue.push(o);
      if (typeof o.success === "function") o.success({ tapIndex: 0 });
    },
    showLoading: function () {},
    hideLoading: function () {},
    navigateTo: function (o) { navigations.push(o); if (o && o.fail) {} },
    navigateBack: function (o) { if (o && o.fail) o.fail(); },
    setNavigationBarTitle: function () {},
    stopPullDownRefresh: function () {},
  };
}

function resetStubs() {
  modalQueue = [];
  sheetQueue = [];
  toasts = [];
  navigations = [];
}

/* ---------------- 页面装载(先装 stub 再 require 产物) ---------------- */

var locationsPage = null;
var scanPage = null;
globalThis.Page = function (options) {
  // 两个页面按 require 顺序分别捕获:locations 先、location-video-scan 后
  if (scanPage === null && locationsPage !== null) scanPage = options;
  else locationsPage = options;
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
require(path.join(ROOT, "miniprogram/pages/location-video-scan/location-video-scan.js"));

var originalCallItems = api.callItemsApi;
var originalCallLocations = locationsApi.callLocationsApi;

function itemsRouter(handler) {
  api.callItemsApi = function (event) { return Promise.resolve(handler(event)); };
}

function locationsRouter(handler) {
  locationsApi.callLocationsApi = function (event) { return Promise.resolve(handler(event)); };
}

function restoreRouters() {
  api.callItemsApi = originalCallItems;
  locationsApi.callLocationsApi = originalCallLocations;
}

test.after(restoreRouters);

function rootNodeResponse() {
  return {
    ok: true,
    node: { location_id: "lc_root", name: "我的家", type: "home", path: [] },
    children: [
      { location_id: "lc_study", name: "书房", type: "room", path: ["书房"], item_count: 0, child_count: 1 },
      { location_id: "lc_kitchen", name: "厨房", type: "room", path: ["厨房"], item_count: 0, child_count: 0 },
    ],
    items: [],
    unmounted_count: 0,
    dangling_mounts: 0,
  };
}

function shelfNodeResponse() {
  return {
    ok: true,
    node: { location_id: "lc_shelf", name: "书柜", type: "container", path: ["书房", "书柜"] },
    children: [
      { location_id: "lc_layer", name: "第一层", type: "container", path: ["书房", "书柜", "第一层"], item_count: 0, child_count: 0 },
    ],
    items: [],
    unmounted_count: 0,
    dangling_mounts: 0,
  };
}

/* ---------------- 注册与首页零改动 ---------------- */

test("D1P-REG:app.json 注册 location-video-scan;首页零改动(#94 红线)", () => {
  var app = JSON.parse(fs.readFileSync(path.join(ROOT, "miniprogram/app.json"), "utf8"));
  assert.ok(app.pages.indexOf("pages/location-video-scan/location-video-scan") !== -1);
  // 首页不展示清点:入口/摘要/新页引用一律不得出现(#94「首页不做任何改动」)
  var indexWxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/index/index.wxml"), "utf8");
  var indexTs = fs.readFileSync(path.join(ROOT, "miniprogram/pages/index/index.ts"), "utf8");
  for (var i = 0; i < 2; i++) {
    var src = i === 0 ? indexWxml : indexTs;
    assert.equal(src.indexOf("location-video-scan"), -1, "首页不得引用 D1 清点页");
    assert.equal(src.indexOf("拍视频清点"), -1, "首页不展示清点入口");
    assert.equal(src.indexOf("上次清点"), -1, "首页不展示清点摘要");
  }
  // B 的 video-scan 页零改动:不出现位置上下文
  var bWxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/video-scan/video-scan.wxml"), "utf8");
  assert.equal(bWxml.indexOf("location-video-scan"), -1);
});

/* ---------------- 位置页入口卡:非根层渲染、根层不渲染 ---------------- */

test("D1P-ENTRY:非根层显示入口卡并发起 locationScanLatest;根层不显示(#94 验收 1/10)", async () => {
  resetStubs();
  var latestCalls = [];
  itemsRouter(function (event) {
    if (event.action === "locationScanLatest") {
      latestCalls.push(event);
      return {
        ok: true,
        scan: {
          scan_id: "scan-entry",
          location_id: "lc_shelf",
          created_at: "2026-10-18T09:30:00.000Z",
          candidate_count: 6,
          confirmed_count: 4,
          confirmed_item_ids: ["a", "b", "c", "d"],
          duration_ms: 9000,
        },
        video_url: "https://tmp/v.mp4",
        items: [{ item_id: "a", name: "甲", location_text: "书房 / 书柜" }, { item_id: "b", name: "乙", location_text: "书房 / 书柜" }],
      };
    }
    return { ok: true, items: [] };
  });
  var page = makePage(locationsPage);
  page.requestSeq = { next: function () { return 1; }, isCurrent: function () { return true; } };

  // 根层:入口不显示,摘要清空,不发起查询
  page.renderList(rootNodeResponse());
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(page.data.hasScanEntry, false, "根层不显示清点入口");
  assert.equal(page.data.scanSummaryText, "");
  assert.equal(latestCalls.length, 0);

  // 非根层(browse):入口显示 + fire-and-forget 摘要查询
  page.renderList(shelfNodeResponse());
  await new Promise(function (r) { setImmediate(r); });
  await page.loadScanSummary ? null : null;
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(page.data.hasScanEntry, true, "非根层显示清点入口");
  assert.equal(latestCalls.length, 1);
  assert.equal(latestCalls[0].location_id, "lc_shelf");
  assert.equal(page.data.scanSummaryText, "上次清点:10-18 · 确认 4 件(2 件已删)");

  // wxml:入口卡条件渲染 + 点整卡拍摄、点「回看」进回放
  var wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.wxml"), "utf8");
  assert.ok(wxml.indexOf("hasScanEntry") !== -1);
  assert.ok(wxml.indexOf("📹 拍视频清点这里") !== -1);
  assert.ok(wxml.indexOf("onScanEntryTap") !== -1);
  assert.ok(wxml.indexOf("onScanReviewTap") !== -1);
  assert.ok(wxml.indexOf("回看") !== -1);

  // 点整卡拍摄:带 node_id 进入清点页
  page.onScanEntryTap();
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].url, "/pages/location-video-scan/location-video-scan?node_id=lc_shelf");
  // 回看:mode=last
  page.onScanReviewTap();
  assert.equal(navigations[1].url, "/pages/location-video-scan/location-video-scan?mode=last&node_id=lc_shelf");
});

test("D1P-LAST:无记录/失败 → 摘要静默隐藏,不影响主列表", async () => {
  resetStubs();
  var page = makePage(locationsPage);
  page.data.currentNodeId = "lc_shelf";
  itemsRouter(function () { return { ok: true, scan: null, video_url: "", items: [] }; });
  await page.loadScanSummary("lc_shelf");
  assert.equal(page.data.scanSummaryText, "");

  itemsRouter(function () { return Promise.reject(new Error("boom")); });
  page.scanLoadSeq = 5;
  await page.loadScanSummary("lc_shelf").catch(function () {});
  assert.equal(page.data.scanSummaryText, "", "失败静默隐藏第二行");
});

/* ---------------- 删除位置三按钮 ---------------- */

test("D1P-DELETE-PREVIEW:影响面文案与迁移可用性;取消不调任何接口(#94 验收 11)", async () => {
  resetStubs();
  var previewCalls = [];
  var writeCalls = [];
  locationsRouter(function (event) {
    if (event.action === "deletePreview") {
      previewCalls.push(event);
      return { ok: true, node_count: 3, item_count: 5, video_count: 7, scan_count: 2, migrate_available: true };
    }
    writeCalls.push(event);
    return { ok: true, deleted_nodes: 3, remounted: 0, compensated: 0, compensated_skipped: 0, scans_marked: 2 };
  });
  var page = makePage(locationsPage);
  var node = { location_id: "lc_shelf", name: "书柜", path: ["书房", "书柜"] };
  await page.deleteNodeWithPreview(node);
  assert.equal(previewCalls.length, 1);
  assert.equal(previewCalls[0].node_id, "lc_shelf");
  assert.equal(page.data.deleteLayer.visible, true);
  assert.equal(
    page.data.deleteLayer.countsText,
    "当前及子位置共 3 个,物品 5 件,关联视频 7 条",
    "#94 原文格式的影响面文案",
  );
  assert.equal(page.data.deleteLayer.migrateAvailable, true);
  // wxml 三按钮
  var wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.wxml"), "utf8");
  assert.ok(wxml.indexOf("删位置并迁移物品") !== -1);
  assert.ok(wxml.indexOf("全部删除") !== -1);
  assert.ok(wxml.indexOf("取消") !== -1);
  assert.ok(wxml.indexOf("deleteLayer.countsText") !== -1);
  // 取消:关弹层,零写调用
  page.onDeleteLayerCancel();
  assert.equal(page.data.deleteLayer.visible, false);
  assert.equal(writeCalls.length, 0, "取消不调任何接口(#94 三按钮语义)");
});

test("D1P-DELETE-MIGRATE:删位置并迁移物品 → deleteLocation(mode:migrate)", async () => {
  resetStubs();
  var calls = [];
  locationsRouter(function (event) {
    calls.push(event);
    if (event.action === "list") return shelfNodeResponse();
    return { ok: true, deleted_nodes: 3, remounted: 5, compensated: 0, compensated_skipped: 0, scans_marked: 2 };
  });
  var page = makePage(locationsPage);
  page.requestSeq = { next: function () { return 1; }, isCurrent: function () { return true; } };
  page.setData({
    deleteLayer: { visible: true, nodeId: "lc_layer", name: "第一层", countsText: "…", scanCount: 1, migrateAvailable: true, busy: false },
  });
  await page.doMigrateDelete();
  var delCalls = calls.filter(function (c) { return c.action === "deleteLocation"; });
  assert.equal(delCalls.length, 1);
  assert.equal(delCalls[0].mode, "migrate");
  assert.equal(delCalls[0].node_id, "lc_layer");
  assert.equal(page.data.deleteLayer.visible, false, "成功后关闭弹层");
});

test("D1P-DELETE-PURGE:全部删除二次确认 → NODE_NOT_EMPTY 收敛(逐件 itemsApi.delete 后重试)(#94 验收 14)", async () => {
  resetStubs();
  var purgeRounds = 0;
  var deletedItems = [];
  var latestSeq = 0;
  locationsRouter(function (event) {
    if (event.action === "deleteLocation" && event.mode === "purge") {
      purgeRounds += 1;
      if (purgeRounds === 1) {
        // 真 LocationsApiError 实例:页面的 isLocationsApiErrorWithCode 按类判别
        return Promise.reject(new locationsApi.LocationsApiError(
          "NODE_NOT_EMPTY",
          "这里还有东西",
          { remaining_items: [{ item_id: "it_1", current_version: 2 }, { item_id: "it_2", current_version: 3 }] },
        ));
      }
      return { ok: true, deleted_nodes: 2, remounted: 0, compensated: 0, compensated_skipped: 0, scans_marked: 1 };
    }
    if (event.action === "list") return shelfNodeResponse();
    return { ok: true, node_count: 0, item_count: 0, video_count: 0, scan_count: 0, migrate_available: false };
  });
  itemsRouter(function (event) {
    if (event.action === "delete") {
      deletedItems.push(event);
      return { ok: true };
    }
    return { ok: true, scan: null, video_url: "", items: [] };
  });
  var page = makePage(locationsPage);
  page.requestSeq = { next: function () { latestSeq += 1; return latestSeq; }, isCurrent: function () { return true; } };
  page.setData({
    deleteLayer: { visible: true, nodeId: "lc_layer", name: "第一层", countsText: "当前及子位置共 2 个,物品 2 件,关联视频 2 条", scanCount: 1, migrateAvailable: false, busy: false },
  });
  await page.doPurgeDelete();
  // 二次确认弹窗(#94「必须二次确认」)
  assert.equal(modalQueue.length, 1);
  assert.equal(modalQueue[0].confirmText, "全部删除");
  // 首轮 NODE_NOT_EMPTY → 逐件软删 → 二轮收敛
  assert.equal(deletedItems.length, 2);
  assert.deepEqual(deletedItems.map(function (e) { return e.item_id; }), ["it_1", "it_2"]);
  assert.equal(purgeRounds, 2);
  assert.equal(page.data.deleteLayer.visible, false);
});

test("D1P-DELETE-PURGE-CANCEL:二次确认点取消 → 零调用", async () => {
  resetStubs();
  var calls = [];
  locationsRouter(function (event) { calls.push(event); return { ok: true }; });
  // 重写 modal 桩:用户取消
  var origModal = globalThis.wx.showModal;
  globalThis.wx.showModal = function (o) { if (o.success) o.success({ confirm: false }); };
  var page = makePage(locationsPage);
  page.setData({
    deleteLayer: { visible: true, nodeId: "lc_layer", name: "第一层", countsText: "…", scanCount: 0, migrateAvailable: false, busy: false },
  });
  await page.doPurgeDelete();
  globalThis.wx.showModal = origModal;
  assert.equal(calls.length, 0, "取消 = 不调任何接口");
  assert.equal(page.data.deleteLayer.visible, true, "弹层保留,由用户再选");
});

test("D1P-ROOT-GUARD:根位置无删除入口(wxml 无根行删除;服务端双重防删由服务端测试覆盖)", () => {
  var wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.wxml"), "utf8");
  // 根不在 children 列表(既有行为):「⋯」只渲染在子节点行;入口卡根层由 hasScanEntry 控制
  assert.ok(wxml.indexOf("onChildMore") !== -1);
  assert.ok(wxml.indexOf("hasScanEntry") !== -1);
  // deletePreview/deleteLocation 的根 INVALID_INPUT 由 tests/locations-delete-cascade.test.js ROOT-GUARD 覆盖
});

/* ---------------- 清点页:装载、上下文、子树约束 ---------------- */

test("D1P-SCAN-CTX:loadContext 固定位置上下文;选择器仅含子树节点(#94 验收 1/2)", async () => {
  resetStubs();
  itemsRouter(function (event) {
    assert.equal(event.action, "locationScanContext");
    return {
      ok: true,
      subtree: [
        { location_id: "lc_shelf", name: "书柜", path: ["书房", "书柜"], parent_id: "lc_study" },
        { location_id: "lc_layer", name: "第一层", path: ["书房", "书柜", "第一层"], parent_id: "lc_shelf" },
      ],
      subtree_items: [{ item_id: "it_wrench", name: "扳手", location_node_id: "lc_shelf", location_text: "书房 / 书柜", version: 2 }],
      household_items: [{ item_id: "it_kitchen_knife", name: "厨房刀", location_node_id: "lc_kitchen", location_text: "厨房", version: 4 }],
      household_truncated: false,
    };
  });
  var page = makePage(scanPage);
  page.setData({ nodeId: "lc_shelf", mode: "scan" });
  await page.loadContext();
  assert.equal(page.data.contextReady, true);
  assert.equal(page.data.locationPathText, "书房 / 书柜");
  assert.equal(page.data.subtreeHasChildren, true);
  // 选择器数据面:只有子树节点(含自身),深度以进入位置为 0
  assert.deepEqual(
    page.data.subtreeOptions.map(function (o) { return o.location_id; }),
    ["lc_shelf", "lc_layer"],
  );
  assert.equal(page.data.subtreeOptions[0].depth, 0);
  assert.equal(page.data.subtreeOptions[1].depth, 1);

  // 子树外 nodeId(防御兜底):绝不写入草稿
  page.setData({
    drafts: [{ draftKey: "k1", observationIds: [], manualHighlights: [], name: "螺丝刀", target: "new", operationId: "op1", itemId: "", locationText: "书房 / 书柜", note: "", checked: true, nodeId: "lc_shelf" }],
    selectorVisible: true,
    nodeSelectorFor: 0,
  });
  page.onNodeOptionTap({ currentTarget: { dataset: { nodeId: "lc_kitchen" } } });
  assert.equal(page.data.drafts[0].nodeId, "lc_shelf", "子树外节点被拒,草稿不变");
  assert.equal(page.data.selectorVisible, true, "弹层不关,等用户重选");

  // 子树内选择:nodeId 与 locationText(路径文本)一起写
  page.onNodeOptionTap({ currentTarget: { dataset: { nodeId: "lc_layer" } } });
  assert.equal(page.data.drafts[0].nodeId, "lc_layer");
  assert.equal(page.data.drafts[0].locationText, "书房 / 书柜 / 第一层", "location_text 与所选节点路径文本逐字一致");
  assert.equal(page.data.selectorVisible, false);
});

/* ---------------- 清点页:三选移动语义 ---------------- */

function scanPageWithPools() {
  var page = makePage(scanPage);
  page.setData({ nodeId: "lc_shelf", mode: "scan", locationPathText: "书房 / 书柜" });
  page.poolSubtree = [
    { location_id: "lc_shelf", name: "书柜", path: ["书房", "书柜"], parent_id: "lc_study" },
    { location_id: "lc_layer", name: "第一层", path: ["书房", "书柜", "第一层"], parent_id: "lc_shelf" },
  ];
  page.poolSubtreeItems = [
    { item_id: "it_wrench", name: "扳手", location_node_id: "lc_shelf", location_text: "书房 / 书柜", version: 2 },
  ];
  page.poolHouseholdItems = [
    { item_id: "it_wrench", name: "扳手", location_node_id: "lc_shelf", location_text: "书房 / 书柜", version: 2 },
    { item_id: "it_knife", name: "厨房刀", location_node_id: "lc_kitchen", location_text: "厨房", version: 9 },
  ];
  page.pathsByNodeId = { lc_shelf: ["书房", "书柜"], lc_layer: ["书房", "书柜", "第一层"] };
  page.setData({
    drafts: [{ draftKey: "k1", observationIds: [], manualHighlights: [], name: "扳手", target: "new", operationId: "op1", itemId: "", locationText: "书房 / 书柜", note: "", checked: true }],
    matchPanelVisible: true,
    matchPanelFor: 0,
    matchViews: [],
  });
  return page;
}

test("D1P-MOVE-INSIDE:挂载已在子树内 → 只关联,绝不动位置(#94 验收 4)", async () => {
  resetStubs();
  var page = scanPageWithPools();
  page.setData({
    matchViews: [{ item_id: "it_wrench", name: "扳手", location_display: "书房 / 书柜", location_fallback: false, mounted_in_subtree: true, level: 1, version: 2, levelText: "同位置同名", whereText: "书房 / 书柜" }],
  });
  await page.onSuggestionTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.drafts[0].target, "existing");
  assert.equal(page.data.drafts[0].itemId, "it_wrench");
  assert.equal(page.data.drafts[0].moveToNodeId, undefined, "已在范围内:绝不移动");
  assert.equal(page.data.drafts[0].expectedVersion, undefined);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, "已在当前位置范围内,只补视频证据");
  assert.equal(sheetQueue.length, 0, "子树内不弹三选");
});

test("D1P-MOVE-CHOICES:子树外三选——只关联 / 移动到当前位置并关联 / 取消(#94 验收 5)", async () => {
  // 选「只关联,保留原位置」
  resetStubs();
  sheetQueue.splice(0);
  globalThis.wx.showActionSheet = function (o) { sheetQueue.push(o); if (o.success) o.success({ tapIndex: 0 }); };
  var page = scanPageWithPools();
  page.setData({
    matchViews: [{ item_id: "it_knife", name: "厨房刀", location_display: "厨房", location_fallback: true, mounted_in_subtree: false, level: 3, version: 9, levelText: "家里同名", whereText: "厨房(不在当前范围内)" }],
  });
  await page.onSuggestionTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(sheetQueue.length, 1);
  assert.deepEqual(sheetQueue[0].itemList, ["只关联,保留原位置", "移动到当前位置并关联"]);
  assert.equal(page.data.drafts[0].target, "existing");
  assert.equal(page.data.drafts[0].moveToNodeId, undefined, "只关联:保留原位置");
  assert.equal(page.data.drafts[0].expectedVersion, undefined);

  // 选「移动到当前位置并关联」:move_to_node_id = 进入位置 + 匹配池 version
  resetStubs();
  sheetQueue.splice(0);
  globalThis.wx.showActionSheet = function (o) { sheetQueue.push(o); if (o.success) o.success({ tapIndex: 1 }); };
  page = scanPageWithPools();
  page.setData({
    matchViews: [{ item_id: "it_knife", name: "厨房刀", location_display: "厨房", location_fallback: true, mounted_in_subtree: false, level: 3, version: 9, levelText: "家里同名", whereText: "厨房(不在当前范围内)" }],
  });
  await page.onSuggestionTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.drafts[0].target, "existing");
  assert.equal(page.data.drafts[0].moveToNodeId, "lc_shelf", "移动目标固定为进入的位置");
  assert.equal(page.data.drafts[0].expectedVersion, 9, "expected_version 来自匹配池,绝不页面自造");

  // 取消:不切 target,草稿保持新建
  resetStubs();
  sheetQueue.splice(0);
  globalThis.wx.showActionSheet = function (o) { sheetQueue.push(o); if (o.fail) o.fail({ errMsg: "cancel" }); };
  page = scanPageWithPools();
  page.setData({
    matchViews: [{ item_id: "it_knife", name: "厨房刀", location_display: "厨房", location_fallback: true, mounted_in_subtree: false, level: 3, version: 9, levelText: "家里同名", whereText: "厨房" }],
  });
  await page.onSuggestionTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.drafts[0].target, "new", "取消 = 不切 target,保持新建");
  assert.equal(page.data.matchPanelVisible, true, "面板保留,由用户再选或关闭");
});

/* ---------------- 提交载荷构建(三选移动/位置继承的落库形状) ---------------- */

test("D1P-BUILD:location 块 + candidate_count;new 带节点路径文本;existing 移动配对 expected_version(#94 验收 3/7/9)", () => {
  var drafts = [
    {
      draftKey: "k_new_default", observationIds: [], manualHighlights: [{ start_ms: 0, end_ms: 900, box: null, frame_ms: 0 }],
      name: "螺丝刀", target: "new", operationId: "op_a", itemId: "",
      locationText: "书房 / 书柜", note: "", checked: true,
    },
    {
      draftKey: "k_new_layer", observationIds: [], manualHighlights: [{ start_ms: 1000, end_ms: 1900, box: null, frame_ms: 1000 }],
      name: "胶带", target: "new", operationId: "op_b", itemId: "",
      locationText: "书房 / 书柜 / 第一层", note: "", checked: true, nodeId: "lc_layer",
    },
    {
      draftKey: "k_exist_link", observationIds: [], manualHighlights: [{ start_ms: 2000, end_ms: 2900, box: null, frame_ms: 2000 }],
      name: "扳手", target: "existing", itemId: "it_wrench",
      locationText: "", note: "", checked: true,
    },
    {
      draftKey: "k_exist_move", observationIds: [], manualHighlights: [{ start_ms: 3000, end_ms: 3900, box: null, frame_ms: 3000 }],
      name: "厨房刀", target: "existing", itemId: "it_knife",
      locationText: "", note: "", checked: true, moveToNodeId: "lc_shelf", expectedVersion: 9,
    },
  ];
  var observations = [
    { obsId: "o1", frameIndex: 0, timeMs: 0, windowStartMs: 0, windowEndMs: 750, framePath: "/tmp/f0.jpg", frameWidth: 100, frameHeight: 100, name: "螺丝刀", qtyNote: "", confidence: "high", box: null },
    { obsId: "o2", frameIndex: 1, timeMs: 2000, windowStartMs: 2000, windowEndMs: 2750, framePath: "/tmp/f1.jpg", frameWidth: 100, frameHeight: 100, name: "扳手", qtyNote: "", confidence: "mid", box: null },
  ];
  var built = locationScanUtil.buildLocationScanCommitItems(
    drafts,
    observations,
    9000,
    { locationId: "lc_shelf", pathsByNodeId: { lc_shelf: ["书房", "书柜"], lc_layer: ["书房", "书柜", "第一层"] } },
    "scan-build-0001",
  );
  assert.equal(built.ok, true, built.ok === false ? built.message : "");
  // 位置继承:缺省 node_id = 进入位置
  assert.equal(built.items[0].node_id, "lc_shelf");
  assert.equal(built.items[0].location_text, "书房 / 书柜");
  // 显式子位置
  assert.equal(built.items[1].node_id, "lc_layer");
  assert.equal(built.items[1].location_text, "书房 / 书柜 / 第一层");
  // 只关联:不带 move 字段
  assert.equal(built.items[2].move_to_node_id, undefined);
  assert.equal(built.items[2].expected_version, undefined);
  // 显式移动:配对携带
  assert.equal(built.items[3].move_to_node_id, "lc_shelf");
  assert.equal(built.items[3].expected_version, 9);
  // location 块三方一致 + candidate_count = 线索数
  assert.deepEqual(built.location, {
    location_id: "lc_shelf",
    scan_id: "scan-build-0001",
    path_snapshot: ["书房", "书柜"],
    text_snapshot: "书房 / 书柜",
  });
  assert.equal(built.candidateCount, 2);

  // 位置记录与所选节点不一致 → 拒绝提交(客户端先拦,服务端同款门第二道)
  var bad = JSON.parse(JSON.stringify(drafts));
  bad[1].locationText = "书房 / 书柜 / 第二层";
  var builtBad = locationScanUtil.buildLocationScanCommitItems(
    bad, observations, 9000,
    { locationId: "lc_shelf", pathsByNodeId: { lc_shelf: ["书房", "书柜"], lc_layer: ["书房", "书柜", "第一层"] } },
    "scan-build-0001",
  );
  assert.equal(builtBad.ok, false);

  // moveToNodeId 无版本 → 拒绝
  var bad2 = JSON.parse(JSON.stringify(drafts)).slice(0, 4);
  bad2[3].expectedVersion = undefined;
  var builtBad2 = locationScanUtil.buildLocationScanCommitItems(
    bad2, observations, 9000,
    { locationId: "lc_shelf", pathsByNodeId: { lc_shelf: ["书房", "书柜"], lc_layer: ["书房", "书柜", "第一层"] } },
    "scan-build-0001",
  );
  assert.equal(builtBad2.ok, false, "移动缺 expected_version 客户端先拦");
});

/* ---------------- 清点页红线与方法面 ---------------- */

test("D1P-SCAN-PAGE:阶段机方法齐备;回看不自动播放;建议只是提示", () => {
  assert.ok(scanPage, "location-video-scan 页面装载成功");
  assert.equal(scanPage.data.phase, "idle");
  assert.equal(scanPage.data.mode, "scan");
  for (var i = 0; i < METHODS.length; i++) {
    assert.equal(typeof scanPage[METHODS[i]], "function", METHODS[i]);
  }
  var wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/location-video-scan/location-video-scan.wxml"), "utf8");
  assert.equal(wxml.indexOf("autoplay"), -1, "回看绝不自动播放(#94 红线)");
  assert.ok(wxml.indexOf("<video") !== -1, "回看模式渲染视频播放器(用户点播放才播)");
  assert.ok(wxml.indexOf("lastVideoUrl") !== -1, "video 由换链结果控制渲染");
  assert.ok(wxml.indexOf("绝不自动合并") !== -1 || wxml.indexOf("不会被自动合并") !== -1, "同名线索不自动合并提示");
  assert.ok(wxml.indexOf("绝不自动移动") !== -1 || wxml.indexOf("点选才关联") !== -1, "建议面板红线文案");
  assert.ok(wxml.indexOf("只能选") !== -1, "子位置选择器边界文案");
});

var METHODS = [
  "onLoad", "loadContext", "loadLastScan", "onChooseVideoTap", "startScan",
  "onGenerateDraftsTap", "onAddManualDraftTap", "onDraftNodeTap", "onNodeOptionTap",
  "onDraftMatchTap", "onSuggestionTap", "onDraftTargetResetTap",
  "onSaveTap", "startUpload", "commitFrozenUpload", "onRetryCommitTap", "onDiscardPendingTap",
  "onLastItemTap", "onDoneBackTap",
];

test("D1P-SCAN-LAST:回看模式读 locationScanLatest,清单跳详情用 item_id 直查", async () => {
  resetStubs();
  var latest = [];
  itemsRouter(function (event) {
    if (event.action === "locationScanLatest") {
      latest.push(event);
      return {
        ok: true,
        scan: {
          scan_id: "scan-last", location_id: "lc_shelf", created_at: "2026-10-18T09:30:00.000Z",
          candidate_count: 5, confirmed_count: 3, confirmed_item_ids: ["a", "b", "c"], duration_ms: 9000,
        },
        video_url: "https://tmp/last.mp4",
        items: [{ item_id: "it_a", name: "甲", location_text: "书房 / 书柜" }],
      };
    }
    return { ok: true };
  });
  var page = makePage(scanPage);
  page.onLoad({ mode: "last", node_id: "lc_shelf" });
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(latest.length, 1);
  assert.equal(latest[0].location_id, "lc_shelf");
  assert.equal(page.data.mode, "last");
  assert.equal(page.data.lastVideoUrl, "https://tmp/last.mp4");
  assert.equal(page.data.lastSummaryText.indexOf("确认 3 件") !== -1, true);
  assert.equal(page.data.lastItems.length, 1);
  page.onLastItemTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].url, "/pages/item/item?item_id=it_a");
});
