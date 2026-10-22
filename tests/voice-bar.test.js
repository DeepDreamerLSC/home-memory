"use strict";

/**
 * 常驻语音条组件(components/voice-bar,issue #45 全局语音条)最小断言测试。
 * 被测对象是 `npm run build:mp` 产出的 miniprogram/components/voice-bar/voice-bar.js
 * (package.json 的 pretest 已保证先编译);Component 构造器用桩捕获后直调方法。
 * 零外部依赖;另对冻结的设计基线(--vb-* 取值、挂载页范围)做静态断言。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");
var COMP_DIR = path.join(ROOT, "miniprogram", "components", "voice-bar");

/* ---------------- wx 桩 + Component 桩 ---------------- */

var navs = [];
var kbListeners = [];
var kbRemoved = [];
globalThis.wx = {
  navigateTo: function (o) { navs.push(o.url); },
  showToast: function () {},
  showModal: function (o) { if (o && typeof o.success === "function") o.success({ confirm: false, cancel: true }); },
  showActionSheet: function () {},
  getStorageSync: function () { return ""; },
  setStorageSync: function () {},
  removeStorageSync: function () {},
  onKeyboardHeightChange: function (cb) { kbListeners.push(cb); },
  offKeyboardHeightChange: function (cb) { kbRemoved.push(cb); },
};

var captured = null;
globalThis.Component = function (options) { captured = options; };

require(path.join(COMP_DIR, "voice-bar.js"));

function read(rel) {
  return fs.readFileSync(path.join(COMP_DIR, rel), "utf8");
}

function readPage(page, rel) {
  return fs.readFileSync(path.join(ROOT, "miniprogram", "pages", page, rel), "utf8");
}

/** 组件实例桩:真实 setData 语义(合并进 data) */
function makeCompThis() {
  var self = {
    data: {
      voiceState: "idle",
      transcribing: false,
      extracting: false,
      recordSeconds: 0,
      partialText: "",
      pressed: false,
      kbOpen: false,
    },
    entry: null,
    kbListener: null,
    setData: function (patch) { Object.assign(self.data, patch); },
  };
  return self;
}

test("组件定义:Component 构造参数完整(生命周期/页面级 hide/触摸与文字方法)", function () {
  assert.ok(captured !== null, "voice-bar.js 应调用 Component 构造器");
  assert.equal(typeof captured.lifetimes.attached, "function", "attached 建立 entry 与键盘监听");
  assert.equal(typeof captured.lifetimes.detached, "function", "detached 解除 entry 与键盘监听");
  assert.equal(typeof captured.pageLifetimes.hide, "function", "宿主页 hide 时作废在途按压");
  assert.equal(typeof captured.methods.onHoldTouchStart, "function", "胶囊触摸起点接线");
  assert.equal(typeof captured.methods.onTextTap, "function", "文字按钮接线");
});

test("整颗胶囊=按住热区:触摸起点转共享入口 pressStart(clientY),并进入按压反馈态", function () {
  var self = makeCompThis();
  var calls = [];
  self.entry = {
    pressStart: function (y) { calls.push(["pressStart", y]); },
    pressMove: function (y) { calls.push(["pressMove", y]); },
    pressEnd: function () { calls.push(["pressEnd"]); },
    pressCancel: function () { calls.push(["pressCancel"]); },
    invalidate: function () {},
    isBusy: function () { return false; },
    getState: function () { return null; },
    extract: function () { return Promise.resolve(); },
    detach: function () {},
  };
  captured.methods.onHoldTouchStart.call(self, { touches: [{ clientY: 123 }] });
  assert.deepEqual(calls, [["pressStart", 123]], "起点 clientY 原样传给共享入口");
  assert.equal(self.data.pressed, true, "按压反馈态开启");

  captured.methods.onHoldTouchMove.call(self, { touches: [{ clientY: 60 }] });
  assert.deepEqual(calls[1], ["pressMove", 60], "移动事件转上滑判定");

  captured.methods.onHoldTouchEnd.call(self);
  assert.equal(self.data.pressed, false, "松手退出按压反馈态");
  assert.deepEqual(calls[2], ["pressEnd"], "松手转共享入口收尾");

  captured.methods.onHoldTouchCancel.call(self);
  assert.deepEqual(calls[3], ["pressCancel"], "系统打断转共享入口作废");
});

test("「文字」按钮走文字确认入口;在途(录音/识别/提取)置灰不放行", function () {
  var self = makeCompThis();
  var busy = false;
  self.entry = { isBusy: function () { return busy; } };

  busy = true;
  captured.methods.onTextTap.call(self);
  assert.equal(navs.length, 0, "在途时不得跳文字确认页");

  busy = false;
  captured.methods.onTextTap.call(self);
  assert.deepEqual(navs, ["/pages/confirm/confirm?manual=true"], "空闲时进文字确认(手动录入)页");
});

test("键盘弹起自动避让:attached 注册监听,高度>0 隐藏、归零恢复,detached 移除监听", function () {
  var self = makeCompThis();
  var detachedCalls = [];
  kbListeners.length = 0;
  kbRemoved.length = 0;

  captured.lifetimes.attached.call(self);
  assert.equal(kbListeners.length, 1, "attached 应注册键盘高度监听");
  assert.ok(self.entry !== null, "attached 应挂上共享语音入口");

  kbListeners[0]({ height: 300 });
  assert.equal(self.data.kbOpen, true, "键盘弹起进入避让态");
  kbListeners[0]({ height: 0 });
  assert.equal(self.data.kbOpen, false, "键盘收起恢复常驻");

  self.entry = {
    invalidate: function () { detachedCalls.push("invalidate"); },
    detach: function () { detachedCalls.push("detach"); },
  };
  captured.lifetimes.detached.call(self);
  assert.deepEqual(kbRemoved, [kbListeners[0]], "detached 应移除键盘监听");
  assert.deepEqual(detachedCalls, ["invalidate", "detach"], "卸载时作废在途并解除绑定");
});

test("冻结设计基线:wxml 文案与 wxss 取值(--vb-*/安全区/按压反馈/单色麦克风)", function () {
  var wxml = read("voice-bar.wxml");
  assert.ok(wxml.indexOf("按住说话") !== -1, "胶囊默认文案采用批准稿的按住说话");
  assert.ok(wxml.indexOf("说吧,我记着呢。") !== -1, "录音中文案沿用首页语义");
  assert.ok(wxml.indexOf("好,当我没听见。") !== -1, "上滑取消文案沿用首页语义");
  assert.ok(wxml.indexOf("文字") !== -1, "「文字」按钮存在");
  assert.ok(wxml.indexOf("catchtouchstart") !== -1 && wxml.indexOf("catchtouchend") !== -1, "按住手势绑在胶囊上");

  var wxss = read("voice-bar.wxss");
  [
    "var(--vb-bg)", "var(--vb-hold-bg)", "var(--vb-mic-bg)", "var(--vb-mic-fg)",
    "var(--vb-btn-line)", "env(safe-area-inset-bottom)", "brightness(0.94)", "scale(0.985)",
  ].forEach(function (token) {
    assert.ok(wxss.indexOf(token) !== -1, "wxss 应使用冻结 token:" + token);
  });
  assert.ok(wxss.indexOf("🎙") === -1 && wxml.indexOf("🎙") === -1, "麦克风不用彩色 emoji,单色 CSS 绘制");
  assert.ok(wxml.includes("/assets/icons/mic.png"), "麦克风使用原型的单色图形资产");

  var css = fs.readFileSync(path.join(ROOT, "miniprogram", "app.wxss"), "utf8");
  // 九轮浅色冻结值 + 十轮深色黑灰冻结值(handoff 修订记录)
  ["#f8f7f2", "#30372c", "#efd36e", "#20241f", "#2b3028", "#e8ce78"].forEach(function (hex) {
    assert.ok(css.indexOf(hex) !== -1, "app.wxss 应含冻结取值 " + hex);
  });
  assert.ok(css.indexOf("--vb-hold-bg") !== -1 && css.indexOf("--vb-btn-line") !== -1, "--vb-* 变量组已入 app.wxss");
});

test("挂载范围:locations/family/item 三页挂载;confirm/join-family 不挂;locations 选择模式(picker)不挂", function () {
  ["locations", "family"].forEach(function (p) {
    var cfg = JSON.parse(readPage(p, p + ".json"));
    assert.equal(cfg.usingComponents && cfg.usingComponents["voice-bar"], "/components/voice-bar/voice-bar", p + " 页应挂载语音条");
    assert.ok(readPage(p, p + ".wxml").indexOf("<voice-bar") !== -1, p + " 页 wxml 应包含 voice-bar 标签");
    assert.ok(readPage(p, p + ".wxml").indexOf("page-with-voice-bar") !== -1, p + " 页根节点应让出底部空间");
  });
  var locWxml = readPage("locations", "locations.wxml");
  assert.ok(locWxml.indexOf("mode !== 'pick'") !== -1, "locations 选择位置(picker)为过渡任务流,语音条应排除");
  ["confirm", "join-family", "item"].forEach(function (p) {
    var cfg = JSON.parse(readPage(p, p + ".json"));
    assert.ok(!cfg.usingComponents || !cfg.usingComponents["voice-bar"], p + " 页不得挂载语音条(确认流程/引导流程)");
  });
});

test("添加面板:空闲可展开,录音或提取中不能打开其他录入方式", function () {
  var self = makeCompThis();
  self.entry = { isBusy: function () { return false; } };
  self.data.voiceState = "recording";
  captured.methods.onAddTap.call(self);
  assert.ok(!self.data.showActions);
  self.data.voiceState = "idle";
  captured.methods.onAddTap.call(self);
  assert.equal(self.data.showActions, true);
  captured.methods.onActionsClose.call(self);
  assert.equal(self.data.showActions, false);
  self.data.extracting = true;
  captured.methods.onAddTap.call(self);
  assert.equal(self.data.showActions, false);
});

test("面板三种录入方式走真实页面,在途不导航且成功跳转后关闭面板", function () {
  var targets = [
    ["onTextTap", "/pages/confirm/confirm?manual=true"],
    ["onPhotoTap", "/pages/photo/photo"],
    ["onVideoTap", "/pages/video-scan/video-scan"],
  ];
  targets.forEach(function (target) {
    var self = makeCompThis();
    self.entry = { isBusy: function () { return false; } };
    navs.length = 0;
    self.data.showActions = true;
    self.data.transcribing = true;
    captured.methods[target[0]].call(self);
    assert.equal(navs.length, 0);
    self.data.transcribing = false;
    captured.methods[target[0]].call(self);
    assert.deepEqual(navs, [target[1]]);
    assert.equal(self.data.showActions, false);
  });
});
