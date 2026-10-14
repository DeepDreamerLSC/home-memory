"use strict";

/*
 * PR #48 复审 B2 回归:updated_at 只说明「记录更新于」,不得冒充「上次确认」。
 * 服务端在名称/备注/位置任意更新时都会刷新 updated_at——旧文案「上次确认 …」
 * 会让用户误以为刚确认过位置(只改备注也说刚确认),信息失真。
 * 锁定:item 详情页头部与首页搜索结果行两处用户可见映射 + 源码/编译产物
 * 不再出现「上次确认」。D1 只读大卡的「这是上次记录的位置,东西可能已经移动。」
 * 保留不动(单独断言)。被测对象含 `npm run build:mp` 产出的
 * miniprogram/pages/item/item.js(Page 构造器用桩捕获后直调方法)。零外部依赖。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");

/* ---------------- wx 桩 + Page 桩(捕获 item 页配置后直调方法) ---------------- */

globalThis.wx = {
  showToast: function () {},
  showModal: function () {},
  showActionSheet: function () {},
  navigateTo: function () {},
  navigateBack: function () {},
  getStorageSync: function () { return ""; },
  setStorageSync: function () {},
  removeStorageSync: function () {},
  cloud: { callFunction: function (o) { o.success && o.success({ result: { ok: true } }); } },
};

var pageConfig = null;
globalThis.Page = function (config) { pageConfig = config; };

require(path.join(ROOT, "miniprogram", "pages", "item", "item.js"));

/** item 页实例桩:真实 setData 语义(合并进 data) */
function makePageThis() {
  var self = {
    data: {
      itemId: "",
      name: "",
      locationText: "",
      note: "",
      version: 0,
      updatedAtText: "",
      lastConfirmedText: "",
      spacePath: [],
      editPanelOpen: false,
      moreOpen: false,
    },
    setData: function (patch) { Object.assign(self.data, patch); },
  };
  return self;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, "miniprogram", rel), "utf8");
}

test("B2-item:详情页头部 updated_at 映射为「记录更新于 MM-DD」,不再出现「上次确认」", function () {
  assert.ok(pageConfig !== null, "item.js 应调用 Page 构造器");
  assert.equal(typeof pageConfig.applySummary, "function", "applySummary 方法应存在");
  // 本地 2026-10-08 10:30(toISOString 落在同一自然日,免时区漂移)
  var local = new Date(2026, 9, 8, 10, 30, 0);
  var self = makePageThis();
  pageConfig.applySummary.call(self, {
    item_id: "it_wording_1",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    note: "",
    version: 3,
    updated_at: local.toISOString(),
  });
  assert.equal(self.data.lastConfirmedText, "记录更新于 10-08", "头部文案如实说明记录更新时间");
  assert.equal(self.data.lastConfirmedText.indexOf("上次确认"), -1, "头部不得再出现「上次确认」");
});

test("B2-index:首页搜索结果行显示「记录更新于 …」,不再出现「上次确认」", function () {
  var wxml = read("pages/index/index.wxml");
  assert.ok(
    wxml.indexOf("记录更新于 {{ item.updated_at_short }}") !== -1,
    "搜索结果行应为「记录更新于 {{ item.updated_at_short }}」"
  );
  assert.equal(wxml.indexOf("上次确认"), -1, "首页 wxml 不得再出现「上次确认」");
});

test("B2-产物与源:源码与编译产物均无「上次确认」;D1「可能已移动」提示保留不动", function () {
  var js = read("pages/item/item.js");
  assert.equal(js.indexOf("上次确认"), -1, "编译产物 item.js 不得残留「上次确认」");
  assert.ok(js.indexOf("记录更新于 ") !== -1, "编译产物 item.js 应包含「记录更新于」");
  ["pages/item/item.ts", "pages/item/item.wxml", "pages/index/index.wxml"].forEach(function (rel) {
    assert.equal(read(rel).indexOf("上次确认"), -1, rel + " 不得残留「上次确认」");
  });
  // D1 只读大卡静态提示句保留(本批只改「上次确认」文案,不动 D1)
  var wxml = read("pages/item/item.wxml");
  assert.ok(
    wxml.indexOf("这是上次记录的位置,东西可能已经移动。") !== -1,
    "D1 大卡提示句应保留不动"
  );
});
