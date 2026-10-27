"use strict";
/**
 * issue #121 批次乙 ⑥:语义图标接线(消费批次甲 #123 的 location-icons 纯工具)。
 * 五处统一走同一映射:位置页树行 / 位置页头部 / B 页「归到」逐层选择器 /
 * D1 逐件子位置选择器 / 确认页「归到」行。
 * graceful degradation 硬门:hasLocationIconAsset 本期恒 false → 各处一律
 * 回退现状(树行首字徽章逐字不变;其余四处现状无徽章 → 零视觉漂移);
 * 主题切换由双路 image + .theme-light/.theme-dark(appearance CSS 变量)自动跟随。
 */
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");
var locationIcons = require(path.join(ROOT, "miniprogram/utils/location-icons.js"));
var locationIconView = require(path.join(ROOT, "miniprogram/utils/location-icon-view.js"));
var locationScanUtil = require(path.join(ROOT, "miniprogram/utils/location-scan.js"));

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

var locationsPage = null;
globalThis.Page = function (options) {
  locationsPage = options;
};
globalThis.wx = {
  getStorageSync: function () { return ""; },
  setStorageSync: function () {},
  showToast: function () {},
  showModal: function (o) { if (o && typeof o.success === "function") o.success({ confirm: true }); },
  showActionSheet: function () {},
  navigateTo: function () {},
  navigateBack: function () {},
  setNavigationBarTitle: function () {},
  stopPullDownRefresh: function () {},
};
require(path.join(ROOT, "miniprogram/pages/locations/locations.js"));

function makePage(options) {
  var page = {
    data: JSON.parse(JSON.stringify(options.data)),
    setData: function (patch) {
      Object.keys(patch).forEach(function (k) { page.data[k] = patch[k]; });
    },
  };
  Object.keys(options)
    .filter(function (k) { return typeof options[k] === "function"; })
    .forEach(function (k) { page[k] = options[k]; });
  return page;
}

/* ---------------- 视图适配纯函数(资产未产出 → 双空串) ---------------- */

test("W2B-ICON-ART-1:locationIconArtwork 资产未产出(hasLocationIconAsset 恒 false)→ 一律双空串 = 调用方回退现状", () => {
  for (var name of ["书房", "卧室", "厨房", "冰箱", "抽屉", "柜子", "神秘空间", "", "客厅电视柜"]) {
    assert.deepEqual(
      locationIconView.locationIconArtwork(name),
      { icon: "", iconDark: "" },
      name + " 未产出资产必须回退(硬门)",
    );
  }
  assert.equal(locationIcons.hasLocationIconAsset("fridge"), false, "前置:批次甲占位判定仍恒 false");
});

test("W2B-ICON-ART-2:视图适配走同一映射(locationIconName)+ dark/light 双路径约定(资产落地后自动点亮)", () => {
  var ts = read("miniprogram/utils/location-icon-view.ts");
  assert.ok(ts.indexOf("locationIconName") !== -1, "消费批次甲映射");
  assert.ok(ts.indexOf("locationIconSrc") !== -1, "路径走批次甲约定");
  assert.ok(ts.indexOf("hasLocationIconAsset") !== -1, "存在性判定为开关");
  // 纯函数性质:同输入同输出
  assert.deepEqual(locationIconView.locationIconArtwork("冰箱"), locationIconView.locationIconArtwork("冰箱"));
});

/* ---------------- ① 位置页树行(回退 = 首字徽章与现状逐字一致) ---------------- */

test("W2B-ICON-TREE:树行渲染 icon 存在才显示 image 对(theme-light/theme-dark),否则回退首字徽章 {{ item.name[0] }}(与现状一致)", () => {
  var wxml = read("miniprogram/pages/locations/locations.wxml");
  var childRows = wxml.slice(wxml.indexOf('wx:for="{{ children }}"'), wxml.indexOf('wx:for="{{ items }}"'));
  assert.ok(childRows.indexOf('wx:if="{{ item.icon }}"') !== -1, "树行 image 分支");
  assert.ok(childRows.indexOf('src="{{ item.icon }}"') !== -1 && childRows.indexOf('src="{{ item.iconDark }}"') !== -1, "双主题路径");
  assert.ok(childRows.indexOf("theme-light") !== -1 && childRows.indexOf("theme-dark") !== -1, "CSS 变量自动跟随明暗");
  assert.ok(childRows.indexOf("{{ item.name[0] }}") !== -1, "回退分支 = 现状首字徽章(逐字)");
});

test("W2B-ICON-TREE-DECO:decorate() 给每个子节点补 icon/iconDark;资产未产出时双空串(现状渲染不变)", () => {
  var page = makePage(locationsPage);
  page.setData({ mode: "browse" });
  var decorated = page.decorate([
    { location_id: "lc_study", name: "书房", type: "room", path: ["书房"], item_count: 0, child_count: 0 },
    { location_id: "lc_fridge", name: "冰箱", type: "furniture", path: ["厨房", "冰箱"], item_count: 0, child_count: 0 },
  ]);
  for (var row of decorated) {
    assert.equal(row.icon, "", row.name + " icon 回退空串");
    assert.equal(row.iconDark, "", row.name + " iconDark 回退空串");
  }
  assert.equal(decorated[0].name, "书房", "既有字段不受影响");
});

/* ---------------- ② 位置页头部(现状无徽章 → 资产落地前零视觉漂移) ---------------- */

test("W2B-ICON-HEAD:位置页头部接线当前节点图标;资产未产出 = 不渲染(headIcon 空串)", () => {
  var wxml = read("miniprogram/pages/locations/locations.wxml");
  var crumb = wxml.slice(wxml.indexOf("crumb-row"), wxml.indexOf("crumb-row") + 700);
  assert.ok(crumb.indexOf('wx:if="{{ headIcon }}"') !== -1, "头部 image 块以资产在场为前提");
  assert.ok(crumb.indexOf('src="{{ headIcon }}"') !== -1 && crumb.indexOf('src="{{ headIconDark }}"') !== -1, "双主题路径");
  var page = makePage(locationsPage);
  page.setData({ mode: "browse" });
  page.renderList({
    ok: true,
    node: { location_id: "lc_study", name: "书房", type: "room", path: ["书房"] },
    children: [],
    items: [],
    unmounted_count: 0,
    dangling_mounts: 0,
  });
  assert.equal(page.data.headIcon, "", "资产未产出:头部零渲染");
  assert.equal(page.data.headIconDark, "");
});

/* ---------------- ③ B 页「归到」逐层选择器 ---------------- */

test("W2B-ICON-B:video-scan 选择器选项行渲染 icon;映射消费 locationIconArtwork", () => {
  var ts = read("miniprogram/pages/video-scan/video-scan.ts");
  var wxml = read("miniprogram/pages/video-scan/video-scan.wxml");
  assert.ok(ts.indexOf("locationIconArtwork") !== -1, "B 页消费同一映射");
  var sel = wxml.slice(wxml.indexOf("nodeSelectorOptions"), wxml.indexOf("nodeSelectorOptions") + 900);
  // B 页 wxml 沿用本页无空差值风格({{item.icon}}),D1/位置页为 {{ item.icon }}
  assert.ok(sel.indexOf('wx:if="{{item.icon}}"') !== -1, "选项行 image 分支");
  assert.ok(sel.indexOf('src="{{item.icon}}"') !== -1 && sel.indexOf('src="{{item.iconDark}}"') !== -1);
  assert.ok(sel.indexOf("theme-light") !== -1 && sel.indexOf("theme-dark") !== -1);
});

/* ---------------- ④ D1 逐件子位置选择器 ---------------- */

test("W2B-ICON-D1:subtreeOptionViews 携带 icon/iconDark(资产未产出双空串);选择器行渲染 image 分支", () => {
  var views = locationScanUtil.subtreeOptionViews(
    [
      { location_id: "lc_study", name: "书房", path: ["书房"] },
      { location_id: "lc_desk", name: "桌子", path: ["书房", "桌子"] },
    ],
    "lc_study",
  );
  assert.equal(views.length, 2);
  for (var row of views) {
    assert.equal(row.icon, "", row.name + " icon 回退空串");
    assert.equal(row.iconDark, "", row.name + " iconDark 回退空串");
  }
  assert.equal(views[1].name, "桌子");
  var wxml = read("miniprogram/pages/location-video-scan/location-video-scan.wxml");
  var sel = wxml.slice(wxml.indexOf("subtreeOptions"), wxml.indexOf("subtreeOptions") + 900);
  assert.ok(sel.indexOf('wx:if="{{ item.icon }}"') !== -1, "子树选择器 image 分支");
  assert.ok(sel.indexOf('src="{{ item.icon }}"') !== -1 && sel.indexOf('src="{{ item.iconDark }}"') !== -1);
  assert.ok(sel.indexOf("theme-light") !== -1 && sel.indexOf("theme-dark") !== -1);
});

/* ---------------- ⑤ 确认页「归到」行 ---------------- */

test("W2B-ICON-CONFIRM:确认页「归到」行(单件 + 多件)渲染挂靠目标末段图标,映射消费 locationIconArtwork", () => {
  var ts = read("miniprogram/pages/confirm/confirm.ts");
  var wxml = read("miniprogram/pages/confirm/confirm.wxml");
  assert.ok(ts.indexOf("locationIconArtwork") !== -1, "确认页消费同一映射(挂靠目标末段)");
  var single = wxml.slice(wxml.indexOf('wx:if="{{ rows[0].mountPathText }}"'), wxml.indexOf('wx:if="{{ rows[0].mountPathText }}"') + 800);
  assert.ok(single.indexOf('wx:if="{{ rows[0].mountIcon }}"') !== -1, "单件归到行 image 分支");
  assert.ok(single.indexOf('src="{{ rows[0].mountIcon }}"') !== -1 && single.indexOf('src="{{ rows[0].mountIconDark }}"') !== -1);
  assert.ok(single.indexOf("归到「{{ rows[0].mountPathText }}」") !== -1, "既有文案不动");
  var batch = wxml.slice(wxml.indexOf('wx:if="{{ item.mountPathText }}"'), wxml.indexOf('wx:if="{{ item.mountPathText }}"') + 800);
  assert.ok(batch.indexOf('wx:if="{{ item.mountIcon }}"') !== -1, "多件归到行 image 分支");
  assert.ok(batch.indexOf('src="{{ item.mountIcon }}"') !== -1 && batch.indexOf('src="{{ item.mountIconDark }}"') !== -1);
  assert.ok(batch.indexOf("归到「{{ item.mountPathText }}」") !== -1);
});

/* ---------------- 明暗自动跟随(全局机制复用,非新增主题分支) ---------------- */

test("W2B-ICON-THEME:五处 image 均为双路 theme-light/theme-dark 对,由 appearance 的 --theme-*-display 变量自动跟随", () => {
  var appWxss = read("miniprogram/app.wxss");
  assert.ok(appWxss.indexOf(".appearance-root .theme-light") !== -1, "全局明暗显隐机制在场(复用,不新造)");
  assert.ok(appWxss.indexOf(".appearance-root .theme-dark") !== -1);
  var pages = [
    "miniprogram/pages/locations/locations.wxml",
    "miniprogram/pages/video-scan/video-scan.wxml",
    "miniprogram/pages/location-video-scan/location-video-scan.wxml",
    "miniprogram/pages/confirm/confirm.wxml",
  ];
  for (var p of pages) {
    var wxml = read(p);
    assert.ok(wxml.indexOf("appearance-root") !== -1, p + " 挂 appearance-root(变量作用域)");
  }
});
