"use strict";
/**
 * PR-B(issue #116,D0-CONTRACT.md v4 §3/§3.1)页面侧:locations 页四选弹层
 * (取消/迁移到上一级/转为未归类/全部删除)、unmount 确认/冲突/未完成态文案、
 * deleting 节点置灰续跑入口;首页「尚未归类」50 上限标注与找回路径文案。
 * 被测对象是 `npm run build:mp` 产出的 locations.js / index.js 与 wxml 文案。
 */
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");
var api = require(path.join(ROOT, "miniprogram/utils/api.js"));
var locationsApi = require(path.join(ROOT, "miniprogram/utils/locations-api.js"));

var modalQueue = [];
var toasts = [];

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
    showActionSheet: function (o) {
      if (typeof o.success === "function") o.success({ tapIndex: 0 });
    },
    showLoading: function () {},
    hideLoading: function () {},
    navigateTo: function () {},
    navigateBack: function (o) { if (o && o.fail) o.fail(); },
    setNavigationBarTitle: function () {},
    stopPullDownRefresh: function () {},
  };
}

function resetStubs() {
  modalQueue = [];
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

function locationsRouter(handler) {
  locationsApi.callLocationsApi = function (event) { return Promise.resolve(handler(event)); };
}

test.after(function () {
  api.callItemsApi = originalCallItems;
  locationsApi.callLocationsApi = originalCallLocations;
});

function layer() {
  return {
    visible: true,
    nodeId: "lc_study",
    name: "书房",
    countsText: "当前及子位置共 3 个,物品 2 件,关联视频 2 条",
    scanCount: 1,
    migrateAvailable: false,
    busy: false,
  };
}

test("UNMOUNT-P4-WXML:删除弹层为四选(取消/迁移/转为未归类/全部删除);全部删除独立二次确认保留", async () => {
  var wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.wxml"), "utf8");
  assert.ok(wxml.indexOf("删位置并迁移物品") !== -1, "迁移到上一级仍在");
  assert.ok(wxml.indexOf("转为未归类") !== -1, "四选新增「转为未归类」");
  assert.ok(wxml.indexOf("全部删除") !== -1);
  assert.ok(wxml.indexOf("取消") !== -1);
  // 按钮顺序(bindtap 位置):取消 < 迁移(onMigrateTap) < 转为未归类(onUnmountTap) < 全部删除(onPurgeTap)
  var cancelAt = wxml.indexOf("onDeleteLayerCancel");
  var migrateAt = wxml.indexOf("onMigrateTap");
  var unmountAt = wxml.indexOf("onUnmountTap");
  var purgeAt = wxml.indexOf("onPurgeTap");
  assert.ok(cancelAt !== -1 && migrateAt !== -1 && unmountAt !== -1 && purgeAt !== -1, "四个按钮 handler 齐备");
  assert.ok(cancelAt < migrateAt, "取消在前");
  assert.ok(migrateAt < unmountAt, "转为未归类在迁移之后");
  assert.ok(unmountAt < purgeAt, "转为未归类在全部删除之前");
  // pending 提示与续跑入口(D0 §3.1 发现点一文案)
  assert.ok(wxml.indexOf("未完成") !== -1, "pending_unmount 续跑提示在弹层");
  // deleting 子节点置灰标注(发现点二)
  assert.ok(wxml.indexOf("清理中") !== -1, "deleting 节点置灰标注");
  // 全部删除的独立二次确认保留在 doPurgeDelete(wx.showModal「全部删除(不可恢复)」)
  var ts = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.ts"), "utf8");
  assert.ok(ts.indexOf("全部删除(不可恢复)") !== -1, "全部删除独立二次确认不变");
});

test("UNMOUNT-PENDING-PREVIEW:deletePreview 附 pending_unmount → 弹层提示续跑,不自动发起", async () => {
  resetStubs();
  var calls = [];
  locationsRouter(function (event) {
    calls.push(event);
    if (event.action === "deletePreview") {
      return {
        ok: true, node_count: 3, item_count: 0, video_count: 2, scan_count: 1,
        migrate_available: false, deleting: true,
        pending_unmount: {
          op_id: "unmount:abc123", phase: "nodes", status: "pending",
          created_at: "2026-10-26T00:00:00.000Z",
          counts: { unmounted: 2, compensated: 0, conflicts: 0 },
        },
      };
    }
    return { ok: true };
  });
  var page = makePage(locationsPage);
  await page.deleteNodeWithPreview({ location_id: "lc_study", name: "书房", path: ["书房"] });
  assert.equal(page.data.deleteLayer.visible, true);
  assert.ok(page.data.deleteLayer.pendingUnmount, "pending 摘要进弹层数据");
  assert.equal(page.data.deleteLayer.pendingUnmount.phase, "nodes");
  var writeCalls = calls.filter(function (c) { return c.action === "deleteLocation"; });
  assert.equal(writeCalls.length, 0, "预览绝不自动发起续跑(用户显式触发)");
});

test("UNMOUNT-SUCCESS:转为未归类 → deleteLocation(mode:unmount),完成提示展示转未归类总数(unmounted+compensated)", async () => {
  resetStubs();
  var calls = [];
  locationsRouter(function (event) {
    calls.push(event);
    if (event.action === "list") {
      return {
        ok: true,
        node: { location_id: "lc_root", name: "我的家", type: "home", path: [] },
        children: [], items: [], unmounted_count: 2, dangling_mounts: 0,
      };
    }
    // 阶段一 2 件 + 阶段二补偿 1 件(窗口期悬挂件)——总数 3 件进「尚未归类」
    return { ok: true, deleted_nodes: 3, remounted: 0, unmounted: 2, compensated: 1, scans_marked: 1 };
  });
  var page = makePage(locationsPage);
  page.requestSeq = { next: function () { return 1; }, isCurrent: function () { return true; } };
  page.setData({ deleteLayer: layer() });
  await page.doUnmountDelete();
  var del = calls.filter(function (c) { return c.action === "deleteLocation"; });
  assert.equal(del.length, 1);
  assert.equal(del[0].mode, "unmount");
  assert.equal(page.data.deleteLayer.visible, false, "成功后关弹层");
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, "已删除;3 件物品已转未归类", "完成提示展示总数(阶段一+阶段二补偿,合同 §3)");
});

test("UNMOUNT-CONFLICT-COPY:阶段一熔断 → 「已解挂 N 件、M 件需先核对」,弹层随冲突关闭(旧预览计数作废,核对后重新预览→重新确认)", async () => {
  resetStubs();
  locationsRouter(function (event) {
    if (event.action === "deleteLocation") {
      return Promise.reject(new locationsApi.LocationsApiError(
        "UNMOUNT_CONFLICT",
        "有物品刚被修改",
        {
          unmounted: 3,
          conflicts: [
            { item_id: "it_1", current_version: 4, location_text: "书房的书柜" },
            { item_id: "it_2", current_version: 5, location_text: "书柜第一层" },
          ],
          nodes_deleted: 0,
        },
      ));
    }
    return { ok: true };
  });
  var page = makePage(locationsPage);
  page.setData({ deleteLayer: layer() });
  await page.doUnmountDelete();
  assert.equal(modalQueue.length, 1);
  assert.ok(
    modalQueue[0].content.indexOf("已解挂 3 件") !== -1,
    "冲突文案含已解挂数:" + JSON.stringify(modalQueue[0].content),
  );
  assert.ok(
    modalQueue[0].content.indexOf("2 件") !== -1,
    "冲突文案含需核对数:" + JSON.stringify(modalQueue[0].content),
  );
  assert.ok(
    modalQueue[0].content.indexOf("重新") !== -1 && modalQueue[0].content.indexOf("预览") !== -1,
    "文案引导重新预览→重新确认(P0-A):" + JSON.stringify(modalQueue[0].content),
  );
  assert.equal(page.data.deleteLayer.busy, false);
  assert.equal(page.data.deleteLayer.visible, false, "弹层随冲突关闭:不得带着旧预览计数直接再点(复审 F9)");
  assert.equal(page.data.deleteLayer.pendingUnmount, null, "旧预览态一并作废");
});

test("UNMOUNT-INCOMPLETE-COPY:未完成态如实提示可续跑,绝不假报成功", async () => {
  resetStubs();
  var calls = [];
  locationsRouter(function (event) {
    calls.push(event);
    if (event.action === "deleteLocation") {
      return Promise.reject(new locationsApi.LocationsApiError(
        "UNMOUNT_INCOMPLETE",
        "上次的清理还没完成,可以继续",
        { pending: { op_id: "unmount:x", phase: "scans", status: "pending", created_at: "t", counts: { unmounted: 2, compensated: 0, conflicts: 0 } } },
      ));
    }
    return { ok: true };
  });
  var page = makePage(locationsPage);
  page.setData({ deleteLayer: layer() });
  await page.doUnmountDelete();
  assert.equal(toasts.length, 0, "绝不假报成功");
  assert.equal(modalQueue.length, 1);
  assert.ok(modalQueue[0].content.indexOf("继续") !== -1, "提示可续跑");
  assert.equal(page.data.deleteLayer.busy, false);
});

test("UNMOUNT-RESUME-ENTRY:deleting 子节点在列表置灰并标注,入口走 ⋯→删除 的 pending 提示;选择模式下并入 disabled(「选这个」不渲染)", async () => {
  var page = makePage(locationsPage);
  page.setData({ mode: "browse" });
  var decorated = page.decorate([
    { location_id: "lc_study", name: "书房", type: "room", path: ["书房"], item_count: 0, child_count: 1, deleting: true },
    { location_id: "lc_kitchen", name: "厨房", type: "room", path: ["厨房"], item_count: 0, child_count: 0 },
  ]);
  assert.equal(decorated[0].deleting, true, "deleting 布尔进 DisplayNode");
  assert.ok(decorated[0].countText.indexOf("清理中") !== -1, "置灰标注文案");
  assert.notEqual(decorated[1].deleting, true, "非 deleting 节点不受影响");
  // 复审 F7:pick 模式下 deleting 并入 disabled——wxml 的「选这个」以 !disabled 渲染,
  // disabled 后按钮不渲染、点行走 disabledReason 提示(服务端冻结门兜底不变)
  page.setData({ mode: "pick" });
  var pickDecorated = page.decorate([
    { location_id: "lc_study", name: "书房", type: "room", path: ["书房"], item_count: 0, child_count: 0, deleting: true },
    { location_id: "lc_kitchen", name: "厨房", type: "room", path: ["厨房"], item_count: 0, child_count: 0 },
  ]);
  assert.equal(pickDecorated[0].disabled, true, "pick 模式 deleting 节点 disabled");
  assert.ok(pickDecorated[0].disabledReason.indexOf("清理中") !== -1, "disabledReason 指明清理中");
  assert.notEqual(pickDecorated[1].disabled, true, "非 deleting 节点可选");
  var wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.wxml"), "utf8");
  assert.ok(wxml.indexOf("mode === 'pick' && !item.disabled") !== -1, "「选这个」以 !disabled 为渲染条件");
});

test("UNMOUNTED-CAP-ANNOTATION:首页「尚未归类」50 上限固定标注「仅显示最近 50 件,共 M 件」+ 找回路径文案", () => {
  var wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/index/index.wxml"), "utf8");
  assert.ok(wxml.indexOf("仅显示最近") !== -1, "固定标注开头");
  assert.ok(wxml.indexOf("共 {{ unmountedCount }} 件") !== -1, "共 M 件(M=unmounted_count)");
  assert.ok(wxml.indexOf("搜索") !== -1, "找回路径:首页搜索");
  assert.ok(wxml.indexOf("生成向导") !== -1 || wxml.indexOf("向导") !== -1, "找回路径:生成向导");
});

test("DELETING-FROZEN-COPY:冻结门拒绝(INVALID_INPUT+detail.reason=deleting)的统一可读文案;其余错误返回 null 走 errorMessage 兜底(复审 F10)", () => {
  var frozen = new locationsApi.LocationsApiError(
    "INVALID_INPUT", "输入不合法,请检查后重试", { reason: "deleting" }
  );
  assert.equal(typeof locationsApi.deletingFrozenMessage, "function");
  assert.equal(locationsApi.deletingFrozenMessage(frozen), "该位置正在清理中,请等清理完成后再操作");
  // 非 deleting 的 INVALID_INPUT(如根禁挂)、其他错误码、detail 缺失:一律 null
  assert.equal(
    locationsApi.deletingFrozenMessage(new locationsApi.LocationsApiError("INVALID_INPUT", "输入不合法,请检查后重试")),
    null
  );
  assert.equal(
    locationsApi.deletingFrozenMessage(new locationsApi.LocationsApiError("INVALID_INPUT", "输入不合法", { reason: "quantity" })),
    null
  );
  assert.equal(locationsApi.deletingFrozenMessage(new Error("x")), null);
  // 接线核对:确认页 ensureAndLink 失败行、详情页整理位置、生成向导 applyScan、
  // 位置页删除四入口的 .js 均引用 deletingFrozenMessage(build:mp 成对产出)
  var confirmJs = fs.readFileSync(path.join(ROOT, "miniprogram/pages/confirm/confirm.js"), "utf8");
  var itemJs = fs.readFileSync(path.join(ROOT, "miniprogram/pages/item/item.js"), "utf8");
  var scanJs = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locationScan/locationScan.js"), "utf8");
  var locationsJs = fs.readFileSync(path.join(ROOT, "miniprogram/pages/locations/locations.js"), "utf8");
  assert.ok(confirmJs.indexOf("deletingFrozenMessage") !== -1, "确认页 ensureAndLink 接线");
  assert.ok(itemJs.indexOf("deletingFrozenMessage") !== -1, "详情页整理位置 linkItem 接线");
  assert.ok(scanJs.indexOf("deletingFrozenMessage") !== -1, "生成向导 applyScan 接线");
  assert.ok(locationsJs.indexOf("deletingFrozenMessage") !== -1, "位置页删除入口接线");
});
