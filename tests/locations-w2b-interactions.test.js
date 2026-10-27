"use strict";
/**
 * issue #121 批次乙 ①②③(locations 页交互,消费 v2 横幅 6418877302):
 * - ① 长按/⋯ 入口一致化:根层与各级的子节点行/物品行长按 = 弹与 ⋯ 同款
 *   ActionSheet,且长按路径绝不触发行点击跳转;
 * - ② 根层「+」面板:与 ⋯ 同视觉等级的加号按钮 → 半屏面板(常用房间预设
 *   chips 一键创建 + 自定义输入);子层面板给家具级预设;重名走既有
 *   NODE_CONFLICT 语义(添加失败如实提示);
 * - ③ 位置内直接添加物品(非根层):名称 + 数量步进器 + 单位选择器 →
 *   itemsApi.create(纯文本 location=当前节点路径)→ locations.linkItem
 *   挂到本节点(方案 Z);挂载失败不回滚已建档物品,如实提示从首页
 *   「尚未归类」找回。
 * 被测对象是 `npm run build:mp` 产出的 locations.js 与 locations.wxml。
 */
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");
var api = require(path.join(ROOT, "miniprogram/utils/api.js"));
var locationsApi = require(path.join(ROOT, "miniprogram/utils/locations-api.js"));

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
      if (typeof o.success === "function") o.success({ confirm: true });
    },
    showActionSheet: function (o) { sheetQueue.push(o); },
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
  modalQueue = [];
  sheetQueue = [];
  toasts = [];
  navigations = [];
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

/** 根层 list 响应(书房/客厅两个孩子,便于长按与面板共用) */
function rootListResponse() {
  return {
    ok: true,
    node: { location_id: "lc_root", name: "我的家", type: "home", path: [] },
    children: [
      { location_id: "lc_study", name: "书房", type: "room", path: ["书房"], item_count: 1, child_count: 1 },
      { location_id: "lc_living", name: "客厅", type: "room", path: ["客厅"], item_count: 0, child_count: 0 },
    ],
    items: [
      { item_id: "it_passport", name: "护照", location_text: "客厅电视柜", note: "", version: 3, updated_at: 1760000000000 },
    ],
    unmounted_count: 0,
    dangling_mounts: 0,
  };
}

/** 书房层 list 响应(非根层,③ 的挂载目标) */
function studyListResponse() {
  return {
    ok: true,
    node: { location_id: "lc_study", name: "书房", type: "room", path: ["书房"] },
    children: [
      { location_id: "lc_desk", name: "桌子", type: "furniture", path: ["书房", "桌子"], item_count: 0, child_count: 0 },
    ],
    items: [],
    unmounted_count: 0,
    dangling_mounts: 0,
  };
}

function pageAtRoot() {
  var page = makePage(locationsPage);
  page.requestSeq = { next: function () { return 1; }, isCurrent: function () { return true; } };
  return page;
}

function pageAtStudy() {
  var page = makePage(locationsPage);
  page.requestSeq = { next: function () { return 1; }, isCurrent: function () { return true; } };
  page.nodeId = "lc_study";
  return page;
}

/** 已渲染出根层数据(子节点 + 物品)的页面:长按/表单处理直接可用 */
function pageRenderedAtRoot() {
  var page = pageAtRoot();
  page.setData({ mode: "browse", children: page.decorate(rootListResponse().children), items: rootListResponse().items });
  return page;
}

/** 已渲染出书房层(非根层数据)的页面 */
function pageRenderedAtStudy() {
  var page = pageAtStudy();
  page.nodePath = ["书房"];
  page.setData({
    mode: "browse",
    isRoot: false,
    currentNodeId: "lc_study",
    currentNodeName: "书房",
    children: page.decorate(studyListResponse().children),
    items: [],
  });
  return page;
}

/* ------------------------------------------------------------------ */
/* ① 长按/⋯ 入口一致化                                               */
/* ------------------------------------------------------------------ */

test("W2B-LP-WXML:子节点行与物品行均接长按(bindlongpress),行点击跳转保留(长按不触发跳转由原生互斥+处理不导航保证)", () => {
  var wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.wxml"), "utf8");
  var childStart = wxml.indexOf('bindtap="onChildTap"');
  assert.ok(childStart !== -1, "子节点行点击跳转保留");
  assert.ok(wxml.indexOf('bindlongpress="onChildLongPress"') !== -1, "子节点行长按接线");
  assert.ok(wxml.indexOf('bindlongpress="onItemLongPress"') !== -1, "物品行长按接线");
  assert.ok(wxml.indexOf('bindtap="onItemTap"') !== -1, "物品行点击跳转保留");
});

test("W2B-LP-NODE:浏览模式长按子节点 = 与 ⋯ 同款 ActionSheet(改名/移动/合并/删除),且不发生任何导航", () => {
  resetStubs();
  var page = pageRenderedAtRoot();
  page.onChildLongPress({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(sheetQueue.length, 1, "长按弹 ActionSheet");
  assert.deepEqual(sheetQueue[0].itemList, ["改名", "移动到…", "合并到…", "删除"], "与 ⋯ 同菜单");
  assert.equal(navigations.length, 0, "长按绝不触发行点击跳转(不下钻、不开弹层页)");
});

test("W2B-LP-GUARD:acting 进行中与选择模式(pick)不长按弹菜单(与 ⋯ 同门)", () => {
  resetStubs();
  var page = pageRenderedAtRoot();
  page.setData({ acting: true });
  page.onChildLongPress({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(sheetQueue.length, 0, "acting 中不弹");
  page.setData({ acting: false, mode: "pick" });
  page.onChildLongPress({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(sheetQueue.length, 0, "pick 模式不弹");
});

test("W2B-LP-ITEM:浏览模式长按物品行 = 与 ⋯ 同款 ActionSheet(移动到…/从这里摘除),且不发生任何导航", () => {
  resetStubs();
  var page = pageRenderedAtRoot();
  page.onItemLongPress({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(sheetQueue.length, 1);
  assert.deepEqual(sheetQueue[0].itemList, ["移动到…", "从这里摘除"], "物品行与 ⋯ 同菜单");
  assert.equal(navigations.length, 0, "长按物品行不触发打开详情");
});

test("W2B-LP-EQUIV:长按与 ⋯ 走同一处理(showNodeActions/物品 sheet),根层与各级统一(同一 handler 不分层级)", () => {
  resetStubs();
  var page = pageRenderedAtStudy();
  page.onChildLongPress({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(sheetQueue.length, 1, "子层(书房)长按同样弹菜单");
  var ts = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.ts"), "utf8");
  var at = ts.indexOf("onChildLongPress(e");
  assert.ok(at !== -1, "onChildLongPress 实现在场");
  assert.ok(ts.slice(at, at + 500).indexOf("showNodeActions") !== -1, "长按复用 ⋯ 的 showNodeActions(同菜单同处理)");
});

test("W2B-LP-SUPPRESS:长按后 350ms 内紧跟的行点击被吞(不下钻/不开详情);窗口外恢复", () => {
  resetStubs();
  var page = pageRenderedAtRoot();
  page.onChildLongPress({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(sheetQueue.length, 1);
  page.onChildTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(navigations.length, 0, "长按后紧跟的 tap 不下钻(不依赖基础库互斥的防御位)");
  page.onItemLongPress({ currentTarget: { dataset: { index: 0 } } });
  page.onItemTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(navigations.length, 0, "长按物品行后紧跟的 tap 不打开详情");
  // 窗口外(suppressTapUntil 复位模拟时间流逝):行点击恢复既有跳转
  page.suppressTapUntil = 0;
  page.onChildTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(navigations.length, 1, "窗口外行点击恢复下钻");
  assert.equal(navigations[0].kind, "navigateTo");
});

/* ------------------------------------------------------------------ */
/* ② 根层「+」面板 + 常用房间预设                                     */
/* ------------------------------------------------------------------ */

test("W2B-ADD-ENTRY:wxml「+」按钮复用 row-more 样式语言(catchtap 开面板);面板含 chips 与自定义输入", () => {
  var wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.wxml"), "utf8");
  assert.ok(/class="[^"]*add-plus[^"]*"/.test(wxml), "加号按钮类名(add-plus)");
  assert.ok(wxml.indexOf('catchtap="onAddTap"') !== -1, "+ 用 catchtap(阻断冒泡到行)");
  var wxss = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.wxss"), "utf8");
  assert.ok(wxss.indexOf(".add-plus") !== -1, "add-plus 有样式定义(与 row-more 同语言)");
  assert.ok(wxml.indexOf("onAddPresetTap") !== -1, "预设 chips 接线");
  assert.ok(wxml.indexOf("onAddCustomTap") !== -1, "自定义输入接线");
});

test("W2B-ADD-ROOT-PRESETS:根层开面板 → 九个常用房间预设(书房/卧室/厨房/客厅/卫生间/玄关/阳台/餐厅/储物间)", () => {
  resetStubs();
  var page = pageAtRoot();
  page.setData({ mode: "browse", isRoot: true });
  page.onAddTap();
  assert.equal(page.data.addPanel.visible, true, "面板打开");
  assert.deepEqual(
    page.data.addPanel.presets,
    ["书房", "卧室", "厨房", "客厅", "卫生间", "玄关", "阳台", "餐厅", "储物间"],
    "根层 = 常用房间预设",
  );
});

test("W2B-ADD-SUB-PRESETS:子层开面板 → 家具级预设(抽屉/柜子/架子/桌子/床/冰箱)", () => {
  resetStubs();
  var page = pageAtStudy();
  page.setData({ mode: "browse", isRoot: false, currentNodeName: "书房" });
  page.onAddTap();
  assert.equal(page.data.addPanel.visible, true);
  assert.deepEqual(
    page.data.addPanel.presets,
    ["抽屉", "柜子", "架子", "桌子", "床", "冰箱"],
    "子层 = 家具级预设",
  );
});

test("W2B-ADD-PRESET-CREATE:点预设 chip = 一键创建(ensurePath 前缀=当前 nodePath,created_from=manual),成功后收面板并刷新", async () => {
  resetStubs();
  var calls = [];
  locationsRouter(function (event) {
    calls.push(event);
    if (event.action === "list") return rootListResponse();
    return { ok: true, nodes: [] };
  });
  var page = pageRenderedAtStudy();
  page.onAddTap();
  page.onAddPresetTap({ currentTarget: { dataset: { name: "抽屉" } } });
  await new Promise(function (r) { setImmediate(r); });
  var ensure = calls.filter(function (c) { return c.action === "ensurePath"; });
  assert.equal(ensure.length, 1, "走既有 ensurePath 建节点");
  assert.deepEqual(ensure[0].path, ["书房", "抽屉"], "前缀 = 当前层路径");
  assert.equal(ensure[0].created_from, "manual");
  assert.equal(page.data.addPanel.visible, false, "成功后收面板");
  assert.ok(toasts.some(function (t) { return t.title === "已添加"; }), "成功提示");
});

test("W2B-ADD-PRESET-CONFLICT:重名(NODE_CONFLICT)→ 既有「添加失败」如实提示,面板保留可再选", async () => {
  resetStubs();
  locationsRouter(function (event) {
    if (event.action === "list") return studyListResponse();
    return Promise.reject(new locationsApi.LocationsApiError(
      "NODE_CONFLICT", "这一层已经有叫「抽屉」的位置了", {},
    ));
  });
  var page = pageRenderedAtStudy();
  page.onAddTap();
  page.onAddPresetTap({ currentTarget: { dataset: { name: "抽屉" } } });
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(modalQueue.length, 1, "冲突如实弹「添加失败」");
  assert.equal(modalQueue[0].title, "添加失败");
  assert.ok(String(modalQueue[0].content).indexOf("抽屉") !== -1, "提示含冲突详情");
  assert.equal(page.data.addPanel.visible, true, "面板保留(可改选或自定义)");
  assert.equal(navigations.length, 0);
});

test("W2B-ADD-CUSTOM:自定义输入走同一 doAdd;空名 toast 名称不能为空", async () => {
  resetStubs();
  var calls = [];
  locationsRouter(function (event) {
    calls.push(event);
    if (event.action === "list") return studyListResponse();
    return { ok: true, nodes: [] };
  });
  var page = pageRenderedAtStudy();
  page.onAddTap();
  page.onAddPanelInput({ detail: { value: "  茶水角  " } });
  assert.equal(page.data.addPanel.customName, "  茶水角  ");
  page.onAddCustomTap();
  await new Promise(function (r) { setImmediate(r); });
  var ensure = calls.filter(function (c) { return c.action === "ensurePath"; });
  assert.equal(ensure.length, 1);
  assert.deepEqual(ensure[0].path, ["书房", "茶水角"], "自定义输入 trim 后入 path");
  // 空名:toast,不调接口
  resetStubs();
  calls.length = 0;
  page.onAddTap();
  page.onAddPanelInput({ detail: { value: "   " } });
  page.onAddCustomTap();
  await new Promise(function (r) { setImmediate(r); });
  assert.ok(toasts.some(function (t) { return t.title === "名称不能为空"; }), "空名提示");
  assert.equal(calls.filter(function (c) { return c.action === "ensurePath"; }).length, 0, "空名不建节点");
});

/* ------------------------------------------------------------------ */
/* ③ 位置内直接添加物品(非根层)                                      */
/* ------------------------------------------------------------------ */

test("W2B-ITEM-ENTRY:根层不提供「添加物品」(onAddItemTap 根层 no-op);非根层面板提供入口并展开简单表单", () => {
  resetStubs();
  var page = pageAtRoot();
  page.setData({ mode: "browse", isRoot: true, addPanel: { visible: true, presets: [], customName: "" } });
  page.onAddItemTap();
  assert.equal(page.data.itemPanel.visible, false, "根层无添加物品(物品不允许挂 home 根)");
  assert.equal(page.data.addPanel.visible, true, "根层面板保持");
  var wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.wxml"), "utf8");
  assert.ok(wxml.indexOf('wx:if="{{ !isRoot }}"') !== -1, "添加物品入口仅非根层渲染");

  resetStubs();
  var page2 = pageAtStudy();
  page2.setData({ mode: "browse", isRoot: false, currentNodeName: "书房", addPanel: { visible: true, presets: [], customName: "" } });
  page2.onAddItemTap();
  assert.equal(page2.data.itemPanel.visible, true, "非根层展开表单");
  assert.equal(page2.data.addPanel.visible, false, "加层面板收起(同一操作面切换)");
  assert.equal(page2.data.itemPanel.quantity, 1, "数量默认 1");
  assert.equal(page2.data.unitOptions[page2.data.itemPanel.unitIndex], "件", "单位默认 件");
});

test("W2B-ITEM-FORM:数量步进器夹在 [1,9999];单位选择器随 UNIT_SET", () => {
  resetStubs();
  var page = pageAtStudy();
  page.setData({ mode: "browse", isRoot: false, itemPanel: { visible: true, name: "x", quantity: 1, unitIndex: 0, busy: false } });
  page.onItemQtyStep({ currentTarget: { dataset: { d: -1 } } });
  assert.equal(page.data.itemPanel.quantity, 1, "下限 1");
  page.onItemQtyStep({ currentTarget: { dataset: { d: 1 } } });
  page.onItemQtyStep({ currentTarget: { dataset: { d: 1 } } });
  assert.equal(page.data.itemPanel.quantity, 3, "+1 步进");
  page.onItemUnitChange({ detail: { value: 2 } });
  assert.equal(page.data.itemPanel.unitIndex, 2);
  assert.equal(page.data.unitOptions[2], "包", "单位选项 = UNIT_SET 冻结闭集");
});

test("W2B-ITEM-SAVE:两步落库——create(纯文本 location=当前节点路径,quantity/unit)→ linkItem(expected_version=create 版本,挂本节点);成功后高亮新物品", async () => {
  resetStubs();
  var locCalls = [];
  var itemCalls = [];
  itemsRouter(function (event) {
    itemCalls.push(event);
    if (event.action === "locationScanLatest") return { scan: null };
    return { ok: true, item: { item_id: "it_new_1", version: 1, updated_at: 1760000000000 } };
  });
  locationsRouter(function (event) {
    locCalls.push(event);
    if (event.action === "list") {
      // 刷新后的本层清单:新物品已挂在本层(高亮命中其行)
      var res = studyListResponse();
      res.items.push({ item_id: "it_new_1", name: "备用钥匙", location_text: "书房", note: "", version: 2, updated_at: 1760000000000 });
      return res;
    }
    return { ok: true, item: { item_id: "it_new_1", version: 2, updated_at: 1760000000000 } };
  });
  var page = pageRenderedAtStudy();
  page.onAddItemTap();
  page.onItemNameInput({ detail: { value: "备用钥匙" } });
  page.onItemQtyStep({ currentTarget: { dataset: { d: 1 } } });
  page.onItemUnitChange({ detail: { value: 3 } });
  await page.onItemSaveTap();
  await new Promise(function (r) { setImmediate(r); });

  var create = itemCalls.filter(function (c) { return c.action === "create"; });
  assert.equal(create.length, 1, "建档一次");
  assert.equal(create[0].name, "备用钥匙");
  assert.equal(create[0].location_text, "书房", "纯文本 location = 当前节点路径(join ' / ')");
  assert.equal(create[0].quantity, 2, "步进器数量随 create 携带");
  assert.equal(create[0].unit, "盒", "单位选择器随 create 携带");
  assert.ok(create[0].operation_id, "幂等键随行");

  var link = locCalls.filter(function (c) { return c.action === "linkItem"; });
  assert.equal(link.length, 1, "挂载一次");
  assert.equal(link[0].item_id, "it_new_1");
  assert.equal(link[0].node_id, "lc_study", "挂到本节点(方案 Z:不引入 createItem 节点字段)");
  assert.equal(link[0].expected_version, 1, "expected_version = create 返回版本");
  assert.ok(link[0].update_id, "update_id 幂等键");

  assert.equal(page.data.itemPanel.visible, false, "成功后收表单");
  assert.ok(toasts.some(function (t) { return t.title === "已添加"; }), "成功提示");
  // ④ 联动:成功后原地高亮新物品(见 locations-nav-highlight 测试的 800ms 消除)
  assert.equal(page.data.highlightId, "it_new_1", "新物品行进入短高亮");
});

test("W2B-ITEM-LINK-FAIL:挂载失败不回滚建档(绝不调 itemsApi.delete),如实提示稍后从首页「尚未归类」找回", async () => {
  resetStubs();
  var itemCalls = [];
  itemsRouter(function (event) {
    itemCalls.push(event);
    if (event.action === "locationScanLatest") return { scan: null };
    return { ok: true, item: { item_id: "it_new_2", version: 1, updated_at: 1760000000000 } };
  });
  locationsRouter(function (event) {
    if (event.action === "list") return studyListResponse();
    return Promise.reject(new Error("err: 挂载失败(弱网中断)"));
  });
  var page = pageRenderedAtStudy();
  page.onAddItemTap();
  page.onItemNameInput({ detail: { value: "指甲刀" } });
  await page.onItemSaveTap();
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });

  assert.equal(itemCalls.filter(function (c) { return c.action === "create"; }).length, 1, "建档已完成");
  assert.equal(itemCalls.filter(function (c) { return c.action === "delete"; }).length, 0, "绝不回滚已建档物品");
  assert.equal(modalQueue.length, 1, "挂载失败如实弹层");
  var content = String(modalQueue[0].content);
  assert.ok(content.indexOf("尚未归类") !== -1, "提示稍后从首页「尚未归类」找回:" + content);
  assert.equal(page.data.itemPanel.visible, false, "表单收起(物品已建档,不重复提交)");
});

test("W2B-ITEM-CREATE-FAIL:建档失败 → 如实提示,不发起挂载,表单保留可重试", async () => {
  resetStubs();
  var locCalls = [];
  itemsRouter(function (event) {
    if (event.action === "locationScanLatest") return { scan: null };
    return Promise.reject(new Error("err: 建档失败"));
  });
  locationsRouter(function (event) {
    locCalls.push(event);
    if (event.action === "list") return studyListResponse();
    return { ok: true };
  });
  var page = pageRenderedAtStudy();
  page.onAddItemTap();
  page.onItemNameInput({ detail: { value: "胶带" } });
  await page.onItemSaveTap();
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(locCalls.filter(function (c) { return c.action === "linkItem"; }).length, 0, "建档失败不挂载");
  assert.equal(modalQueue.length, 1, "建档失败如实弹层");
  assert.equal(page.data.itemPanel.visible, true, "表单保留可重试");
  assert.equal(page.data.itemPanel.busy, false, "busy 复位");
});

test("W2B-ITEM-EMPTY-NAME:空名不建档,toast 名称不能为空", async () => {
  resetStubs();
  var itemCalls = [];
  itemsRouter(function (event) {
    itemCalls.push(event);
    return { ok: true, item: { item_id: "it_x", version: 1 } };
  });
  var page = pageAtStudy();
  page.setData({ mode: "browse", isRoot: false, itemPanel: { visible: true, name: "  ", quantity: 1, unitIndex: 0, busy: false } });
  await page.onItemSaveTap();
  assert.equal(itemCalls.length, 0, "空名零请求");
  assert.ok(toasts.some(function (t) { return t.title === "名称不能为空"; }));
  assert.equal(page.data.itemPanel.busy, false);
});
