"use strict";

/**
 * #36 0.6.0 真机反馈四连修的客户端静态断言(button 层级 / 尚未归类视图 / vague 展示)。
 * 被测对象是源码与 `npm run build:mp` 产物(pretest 已保证先编译):
 * - BTN-FLAT:按钮文字垂直居中根因修法 + 视觉/热区分层(视觉 ×0.75,热区 ≥88rpx);
 * - UM-VIEW:首页「尚未归类」通栏格可点入 + 明细视图渲染接线;
 * - VAGUE-UI:确认页 C1/C2 与详情页「时间没换算」展示接线 + 纯函数映射。
 * 断言全部为字符串/结构存在性检查,零外部依赖。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, "miniprogram", rel), "utf8");
}

/* ---------------- BTN-FLAT:垂直居中根因 + 视觉/热区分层 ---------------- */

test("BTN-FLAT 根因修法:按钮一律 flex 居中 + line-height:1(根因注释在册)", function () {
  var css = read("app.wxss");
  assert.ok(css.indexOf("CJK 字形贴着") !== -1, "根因结论(字体偏上)应写在注释里");
  assert.ok(css.indexOf("line-height: 1") !== -1, "按钮文本 line-height:1");
  // button.btn 本体=透明热区层,min-height 88(44px 热区下限)
  assert.ok(/button\.btn\s*\{[^}]*min-height:\s*88rpx/.test(css), "button.btn 热区 ≥88rpx");
  assert.ok(/button\.btn\s*\{[^}]*background:\s*transparent/.test(css), "button.btn 本体透明(热区层)");
  // 视觉面 76(原 100 × 0.75)
  assert.ok(/button\.btn \.btn-face\s*\{[^}]*min-height:\s*76rpx/.test(css), "btn-face 视觉 76rpx");
  // .btn.ink:热区 88 = 面 66(原 88 × 0.75)
  assert.ok(/\.btn\.ink\s*\{[^}]*min-height:\s*88rpx/.test(css), ".btn.ink 热区 88rpx");
  assert.ok(/\.btn\.ink \.btn-face\s*\{[^}]*min-height:\s*66rpx/.test(css), ".btn.ink 面 66rpx");
  // r-done / more-inline 共用同一分层模式
  assert.ok(/\.r-done\s*\{[^}]*min-height:\s*88rpx/.test(css), ".r-done 热区 88rpx");
  assert.ok(/\.r-done \.r-done-face\s*\{[^}]*min-height:\s*66rpx/.test(css), ".r-done 面 66rpx");
  assert.ok(/\.more-inline\s*\{[^}]*min-height:\s*88rpx/.test(css), ".more-inline 热区 88rpx");
  assert.ok(/\.more-inline \.more-inline-face\s*\{[^}]*min-height:\s*66rpx/.test(css), ".more-inline 面 66rpx");
});

test("BTN-FLAT 确认页:固定主操作保持居中及不低于44px热区", function () {
  var css = read("pages/confirm/confirm.wxss");
  assert.ok(css.indexOf("line-height: 108rpx") === -1);
  assert.match(css, /\.confirm-dock \.btn-face\s*\{[^}]*min-height:\s*98rpx/);
  assert.match(css, /\.confirm-dock\s*\{[^}]*position:\s*fixed/);
});

test("BTN-FLAT 语音条:102rpx主操作与固定加号,录音浮层避让安全区", function () {
  var css = read("components/voice-bar/voice-bar.wxss");
  assert.match(css, /\.hold\s*\{[^}]*min-height:\s*102rpx/);
  assert.match(css, /\.hold-face\s*\{[^}]*min-height:\s*102rpx/);
  assert.match(css, /\.add-btn\s*\{[^}]*max-width:\s*102rpx/);
  assert.ok(css.includes("calc(150rpx + env(safe-area-inset-bottom))"));
  assert.ok(css.includes(".hold.pressed .hold-face"));
  var wxml = read("components/voice-bar/voice-bar.wxml");
  var hold = wxml.slice(wxml.indexOf('class="hold '), wxml.indexOf('class="hold ') + 600);
  assert.ok(hold.includes("catchtouchstart") && hold.includes("catchtouchend"));
  assert.ok(wxml.includes('bindtap="onAddTap"'));
});

test("BTN-FLAT 首页:搜索与首用语音的透明热区继续可用", function () {
  var css = read("pages/index/index.wxss");
  assert.match(css, /\.search-go\s*\{[^}]*width:\s*74rpx/);
  assert.ok(css.includes(".search-go-hit"));
  assert.match(css, /\.fam-chip\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(css, /\.text-action\s*\{[^}]*min-height:\s*88rpx/);
});

test("BTN-FLAT wxml:主操作按钮均带视觉面内层(热区层保持 bindtap/loading/disabled)", function () {
  ["pages/confirm/confirm.wxml", "pages/item/item.wxml", "pages/family/family.wxml",
    "pages/join-family/join-family.wxml", "pages/locationScan/locationScan.wxml",
    "pages/locations/locations.wxml"].forEach(function (rel) {
    var wxml = read(rel);
    assert.ok(wxml.indexOf("btn-face") !== -1, rel + " 按钮应有视觉面内层");
  });
  var confirmWxml = read("pages/confirm/confirm.wxml");
  assert.ok(confirmWxml.indexOf('loading="{{ batchSaving }}"') !== -1, "loading 语义保留在热区层");
});

/* ---------------- UM-VIEW:「尚未归类」可点入 + 明细视图 ---------------- */

test("UM-VIEW:通栏格可点入明细视图(抬头/行结构/灰标/行点详情/返回家里)", function () {
  var wxml = read("pages/index/index.wxml");
  assert.ok(/unmounted-entry[^>]*bindtap="onUnmountedTap"/.test(wxml.replace(/\n/g, " ")), "通栏格绑定 onUnmountedTap");
  assert.ok(wxml.indexOf("unmountedView") !== -1, "明细视图分支存在");
  assert.ok(wxml.indexOf("onUnmountedRowTap") !== -1, "行点击处理器接线");
  assert.ok(wxml.indexOf("位置待核实") !== -1, "行灰标「位置待核实」");
  assert.ok(wxml.indexOf("件待核实") !== -1, "抬头「N 件待核实」口径");
  // 通栏格仍只在 unmountedCount>0 时渲染(现状不变)
  assert.ok(wxml.indexOf("isRootView && unmountedCount > 0") !== -1, "计数 >0 才显示通栏格");

  var ts = read("pages/index/index.ts");
  ["onUnmountedTap", "onUnmountedRowTap"].forEach(function (name) {
    assert.ok(ts.indexOf(name + "(") !== -1, "index.ts 实现 " + name);
  });
  assert.ok(ts.indexOf("unmounted_items") !== -1, "消费根层 list 的 unmounted_items 投影");

  var css = read("pages/index/index.wxss");
  assert.ok(css.indexOf(".unverified-tag") !== -1, "灰标样式在册");
});

/* ---------------- VAGUE-UI:时间没换算的展示接线与纯函数映射 ---------------- */

var batchSave = require("../miniprogram/utils/batch-save.js");

test("VAGUE-UI 纯函数:rowVagueQuoteInput——无日期且带标记才随行提交(与 reminder 互斥)", function () {
  assert.equal(batchSave.rowVagueQuoteInput({ remindAt: "", remindVagueQuote: "半年后" }), "半年后");
  assert.equal(batchSave.rowVagueQuoteInput({ remindAt: "", remindVagueQuote: "" }), undefined, "无标记不携带");
  assert.equal(batchSave.rowVagueQuoteInput({ remindAt: "2026-11-20", remindVagueQuote: "半年后" }), undefined, "有明确日期不带 vague");
});

test("VAGUE-UI 确认页:C1 灰行 + C2 小灰标;选了日期即收起提示", function () {
  var wxml = read("pages/confirm/confirm.wxml");
  assert.ok(wxml.indexOf("未换算") !== -1, "C1 灰行文案");
  assert.ok(wxml.indexOf("请补充日期或稍后设置") !== -1, "C1 灰行引导");
  assert.ok(wxml.indexOf("vague-badge") !== -1, "C2 行内小灰标");
  var ts = read("pages/confirm/confirm.ts");
  assert.ok(ts.indexOf("remindVagueQuote") !== -1, "行状态携带 vague 标记");
  assert.ok(ts.indexOf('"rows[0].remindVagueQuote": ""') !== -1, "选了明确日期即清空提示(互斥)");
  assert.ok(ts.indexOf("remind_vague_quote") !== -1, "create 随行提交 vague");
});

test("VAGUE-UI 详情页:原话区下方一行灰提示;有到期行在屏时不重复提示", function () {
  var wxml = read("pages/item/item.wxml");
  assert.ok(wxml.indexOf("当时提到时间:") !== -1, "详情页灰提示文案");
  assert.ok(wxml.indexOf("没换算成日期") !== -1, "如实说明没换算");
  assert.ok(/vagueQuote && !expire/.test(wxml.replace(/\n/g, " ")), "有 active 提醒时不再显示");
  var ts = read("pages/item/item.ts");
  assert.ok(ts.indexOf("vagueQuote") !== -1, "详情页状态携带 vague");
});
