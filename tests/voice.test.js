"use strict";

/**
 * 语音录入封装的离线测试(纯逻辑部分)。
 * 注意:被测对象是 `npm run build:mp` 产出的 miniprogram/utils/voice.js
 * (package.json 的 pretest 已保证先编译)。
 * 零外部依赖;wx.* 的调用路径在源码中均有 try/catch 兜底,离线安全。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var voice = require("../miniprogram/utils/voice");

function mockManager() {
  var handlers = {};
  return {
    onStart: function (cb) { handlers.start = cb; },
    onRecognize: function (cb) { handlers.recognize = cb; },
    onStop: function (cb) { handlers.stop = cb; },
    onError: function (cb) { handlers.error = cb; },
    start: function (opts) { handlers.opts = opts; },
    stop: function () { handlers.stopped = true; },
    __fireStart: function () { handlers.start(); },
    __fireRecognize: function (r) { handlers.recognize(r); },
    __fireStop: function (r) { handlers.stop(r); },
    __fireError: function (r) { handlers.error(r); },
    __getOpts: function () { return handlers.opts; },
  };
}

test("voiceErrorMessage:已知错误码给中文文案,未知码如实标注", function () {
  assert.ok(voice.voiceErrorMessage(-6).indexOf("录音权限") !== -1);
  assert.ok(voice.voiceErrorMessage(-10006).indexOf("太短") !== -1);
  var unknown = voice.voiceErrorMessage(-99999);
  assert.ok(unknown.indexOf("-99999") !== -1, "未知码应包含原始错误码");
  assert.ok(unknown.indexOf("文字") !== -1, "应提示可回退文字");
});

test("cleanTranscript:去首尾空白与标点,保留中间内容", function () {
  assert.equal(voice.cleanTranscript("  降压药在厨房抽屉 "), "降压药在厨房抽屉");
  assert.equal(voice.cleanTranscript("。降压药,在,厨房。"), "降压药,在,厨房");
  assert.equal(voice.cleanTranscript(""), "");
});

test("isSlideUpCancel:上滑超过阈值判取消,滑回恢复", function () {
  assert.equal(voice.isSlideUpCancel(500, 400), true, "上滑 100px 应判取消");
  assert.equal(voice.isSlideUpCancel(500, 460), false, "上滑 40px 未达阈值");
  assert.equal(voice.isSlideUpCancel(500, 550), false, "下滑不算取消");
});

test("summarizeTimings:空数据零值;多样本给 p50 与平均字数", function () {
  var empty = voice.summarizeTimings([]);
  assert.deepEqual(empty, { count: 0, recordP50: 0, asrP50: 0, charsAvg: 0 });

  var timings = [
    { recordMs: 2000, asrMs: 300, chars: 10, at: "t1" },
    { recordMs: 4000, asrMs: 500, chars: 20, at: "t2" },
    { recordMs: 6000, asrMs: 700, chars: 30, at: "t3" },
    { recordMs: 8000, asrMs: 900, chars: 40, at: "t4" },
  ];
  var s = voice.summarizeTimings(timings);
  assert.equal(s.count, 4);
  assert.equal(s.recordP50, 6000, "排序后取中位(上取整)");
  assert.equal(s.asrP50, 700);
  assert.equal(s.charsAvg, 25);
});

test("createVoiceController:完整流程 start→识别→stop 给出清洗后文本", function () {
  var m = mockManager();
  var events = [];
  var ctrl = voice.createVoiceController({
    onStart: function () { events.push("start"); },
    onRecognize: function (t) { events.push("recognize:" + t); },
    onStop: function (t) { events.push("stop:" + t); },
    onError: function () { events.push("error"); },
  }, m);

  assert.equal(ctrl.start(), true);
  assert.deepEqual(m.__getOpts(), { duration: 60000, lang: "zh_CN" }, "录音参数:最长 60 秒中文");
  m.__fireStart();
  m.__fireRecognize({ result: " 降压药 " });
  m.__fireStop({ result: "降压药在厨房第二个抽屉。" });
  assert.deepEqual(events, ["start", "recognize:降压药", "stop:降压药在厨房第二个抽屉"]);
});

test("createVoiceController:上滑取消后 onStop 丢弃,不再回调", function () {
  var m = mockManager();
  var stopped = false;
  var ctrl = voice.createVoiceController({
    onStart: function () {},
    onRecognize: function () {},
    onStop: function () { stopped = true; },
    onError: function () {},
  }, m);
  ctrl.start();
  m.__fireStart();
  voice.markVoiceCancelled(); // 模拟上滑取消
  ctrl.stop();
  m.__fireStop({ result: "不该出现" });
  assert.equal(stopped, false, "取消后的识别结果应被丢弃");
});

test("createVoiceController:onError 归因:ret -6 为权限,其余为识别失败", function () {
  voice.resetVoiceCancelled(); // 隔离上一用例遗留的取消标记(真实流程由 onStart 复位)
  var m = mockManager();
  var errors = [];
  voice.createVoiceController({
    onStart: function () {},
    onRecognize: function () {},
    onStop: function () {},
    onError: function (code, msg, ret) { errors.push([code, msg, ret]); },
  }, m);
  m.__fireError({ ret: -6 });
  m.__fireError({ ret: -10013 });
  assert.equal(errors[0][0], "PERMISSION");
  assert.equal(errors[1][0], "ASR");
  assert.ok(errors[1][1].length > 0, "应携带中文文案");
});

test("createVoiceController:插件不可用降级为明确错误并回退文字", function () {
  var errors = [];
  var ctrl = voice.createVoiceController({
    onStart: function () {},
    onRecognize: function () {},
    onStop: function () {},
    onError: function (code, msg) { errors.push([code, msg]); },
  }, null);
  assert.equal(ctrl.start(), false, "插件缺失时 start 应返回 false");
  assert.equal(errors[0][0], "UNKNOWN");
  assert.ok(errors[0][1].indexOf("文字") !== -1, "应提示改用文字输入");
});
