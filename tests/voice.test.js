"use strict";

/**
 * 语音录入封装的离线测试(纯逻辑 + 注入依赖的控制器会话生命周期)。
 * 被测对象是 `npm run build:mp` 产出的 miniprogram/utils/voice.js
 * (package.json 的 pretest 已保证先编译)。零外部依赖。
 * 重点回归(架构评审二轮点名):
 * ① 迟到启动:touchend 已发生(stop 先于 recorder.onStart),必须停止且不上传;
 * ② 旧结果复活:A 的 ASR 未返回即被替代/取消,随后 A 返回,必须丢弃 A 且 B 正常完成。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var voice = require("../miniprogram/utils/voice");

function mockRecorder() {
  var handlers = {};
  return {
    start: function (opts) { handlers.opts = opts; },
    stop: function () { handlers.stopped = (handlers.stopped || 0) + 1; },
    onStart: function (cb) { handlers.start = cb; },
    onStop: function (cb) { handlers.stop = cb; },
    onError: function (cb) { handlers.error = cb; },
    __fireStart: function () { handlers.start(); },
    __fireStop: function (r) { handlers.stop(r); },
    __fireError: function (e) { handlers.error(e); },
    __getOpts: function () { return handlers.opts; },
    __stopCount: function () { return handlers.stopped || 0; }
  };
}

/** 可控转写:resolveWhen 手动放行,用于模拟「ASR 在途」 */
function makeDeps(opts) {
  opts = opts || {};
  var recorder = mockRecorder();
  var uploaded = [];
  var pendingTranscribes = [];
  return {
    recorder: recorder,
    uploaded: uploaded,
    readFileBase64: function () {
      if (opts.readFail) {
        return Promise.reject(new Error("readFile fail: permission"));
      }
      return Promise.resolve("QVVESU8=");
    },
    transcribe: function (b64, fmt) {
      if (opts.deferTranscribe) {
        return new Promise(function (resolve) {
          pendingTranscribes.push({ resolve: resolve, b64: b64, fmt: fmt });
        });
      }
      uploaded.push(fmt);
      return Promise.resolve(opts.transcribeResult || { ok: true, text: "降压药在厨房第二个抽屉。" });
    },
    __flush: function (result) {
      var p = pendingTranscribes.shift();
      if (!p) { throw new Error("没有在途转写"); }
      p.resolve(result || { ok: true, text: "降压药在厨房第二个抽屉。" });
    },
    __pendingCount: function () { return pendingTranscribes.length; }
  };
}

function collect() {
  var events = [];
  return {
    events: events,
    cbs: {
      onStart: function () { events.push("start"); },
      onTranscribing: function () { events.push("transcribing"); },
      onStop: function (t) { events.push("stop:" + t); },
      onError: function (code, msg) { events.push("error:" + code + ":" + msg); },
    }
  };
}

function settle() {
  return new Promise(function (r) { setTimeout(r, 20); });
}

test("voiceErrorMessage / cleanTranscript / isMeaningfulTranscript / isSlideUpCancel / summarizeTimings:纯函数行为", function () {
  assert.ok(voice.voiceErrorMessage("RECORD_TOO_SHORT").indexOf("太短") !== -1);
  assert.equal(voice.cleanTranscript("。降压药,在,厨房。"), "降压药,在,厨房");
  assert.equal(voice.isMeaningfulTranscript("嗯。"), false);
  assert.equal(voice.isMeaningfulTranscript("钥匙在抽屉"), true);
  assert.equal(voice.isSlideUpCancel(500, 400), true);
  assert.equal(voice.isSlideUpCancel(500, 460), false);
  var s = voice.summarizeTimings([
    { recordMs: 2000, asrMs: 300, chars: 10, at: "t1" },
    { recordMs: 4000, asrMs: 500, chars: 20, at: "t2" },
    { recordMs: 6000, asrMs: 700, chars: 30, at: "t3" },
    { recordMs: 8000, asrMs: 900, chars: 40, at: "t4" },
  ]);
  assert.equal(s.recordP50, 6000);
  assert.deepEqual(voice.summarizeTimings([]), { count: 0, recordP50: 0, asrP50: 0, charsAvg: 0 });
});

test("会话守卫(授权窗口):松手/切换/离开后,迟到的授权回调不得发起录音", function () {
  var guard = voice.createSessionGuard();
  var s1 = guard.begin();
  assert.equal(guard.isCurrent(s1), true);
  guard.invalidate();
  assert.equal(guard.isCurrent(s1), false, "松手后原会话作废");
  var s2 = guard.begin();
  assert.equal(guard.isCurrent(s2), true);
  assert.equal(guard.isCurrent(s1), false);
});

test("控制器:完整流程 begin→onStart→stop→transcribing→转写→onStop(清洗后文本)", async function () {
  var rec = collect();
  var deps = makeDeps();
  var ctrl = voice.createVoiceController(rec.cbs, deps);
  var session = ctrl.begin();
  assert.deepEqual(deps.recorder.__getOpts(), {
    format: "mp3", duration: 60000, sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 24000, frameSize: 4
  }, "录音参数:mp3/16k/单声道/24kbps");
  deps.recorder.__fireStart();
  ctrl.stop(session);
  deps.recorder.__fireStop({ tempFilePath: "/tmp/a.mp3" });
  await settle();
  assert.deepEqual(rec.events, ["start", "transcribing", "stop:降压药在厨房第二个抽屉"]);
});

test("回归①迟到启动:stop 先于 recorder.onStart —— 必须停止录音且不上传", async function () {
  var rec = collect();
  var deps = makeDeps();
  var ctrl = voice.createVoiceController(rec.cbs, deps);
  var session = ctrl.begin();
  // recorder.onStart 尚未回调,用户已松手
  ctrl.stop(session);
  assert.equal(deps.recorder.__stopCount(), 1, "应立即停止录音");
  // 此后 onStart 才回调:不得进入录音态、不得上传
  deps.recorder.__fireStart();
  deps.recorder.__fireStop({ tempFilePath: "/tmp/empty.mp3" });
  await settle();
  assert.deepEqual(rec.events, [], "迟到启动的会话不得产生任何页面回调");
  assert.equal(deps.uploaded.length, 0, "不得上传音频");
});

test("回归①-变体:cancel 后迟到的 recorder.onStart —— 同样停止且不上传", async function () {
  var rec = collect();
  var deps = makeDeps();
  var ctrl = voice.createVoiceController(rec.cbs, deps);
  var session = ctrl.begin();
  ctrl.cancel(session);
  deps.recorder.__fireStart();
  await settle();
  assert.deepEqual(rec.events, [], "作废会话的迟到启动不得回调页面");
  assert.equal(deps.recorder.__stopCount() >= 1, true, "应停止录音");
});

test("回归②旧结果复活:A 的 ASR 在途被替代,A 返回必须丢弃,B 正常完成", async function () {
  var rec = collect();
  var deps = makeDeps({ deferTranscribe: true });
  var ctrl = voice.createVoiceController(rec.cbs, deps);

  // A:录音完成,转写在途
  var a = ctrl.begin();
  deps.recorder.__fireStart();
  ctrl.stop(a);
  deps.recorder.__fireStop({ tempFilePath: "/tmp/a.mp3" });
  await settle();
  assert.equal(deps.__pendingCount(), 1, "A 的转写在途");

  // 用户开始新会话 B(替代 A)
  var b = ctrl.begin();
  deps.recorder.__fireStart();
  ctrl.stop(b);
  deps.recorder.__fireStop({ tempFilePath: "/tmp/b.mp3" });
  await settle();
  assert.equal(deps.__pendingCount(), 2, "A、B 转写均在途");

  // A 的结果先返回:必须丢弃(不得触发 onStop)
  deps.__flush({ ok: true, text: "旧会话A的结果。" });
  await settle();
  assert.equal(rec.events.indexOf("stop:旧会话A的结果。"), -1, "A 的旧结果必须丢弃");
  assert.equal(rec.events.indexOf("stop:降压药在厨房第二个抽屉"), -1, "B 尚未返回");

  // B 的结果返回:正常回调
  deps.__flush({ ok: true, text: "B的新结果。" });
  await settle();
  assert.ok(rec.events.indexOf("stop:B的新结果") !== -1, "B 正常完成(标点已清洗)");
});

test("回归②-变体:取消后 ASR 返回,同样丢弃", async function () {
  var rec = collect();
  var deps = makeDeps({ deferTranscribe: true });
  var ctrl = voice.createVoiceController(rec.cbs, deps);
  var a = ctrl.begin();
  deps.recorder.__fireStart();
  ctrl.stop(a);
  deps.recorder.__fireStop({ tempFilePath: "/tmp/a.mp3" });
  await settle();
  ctrl.cancel(a); // 切换模式/离开页面:作废在途识别
  deps.__flush({ ok: true, text: "不该出现。" });
  await settle();
  assert.equal(rec.events.indexOf("stop:不该出现。"), -1, "取消后返回的结果必须丢弃");
});

test("控制器:错误归因(ASR 失败/太短/读文件失败/录音器报错)", async function () {
  var rec = collect();
  var deps = makeDeps({ transcribeResult: { ok: false, error: "ASR_UNAVAILABLE", message: "语音识别失败" } });
  var ctrl = voice.createVoiceController(rec.cbs, deps);
  var s = ctrl.begin();
  deps.recorder.__fireStart();
  ctrl.stop(s);
  deps.recorder.__fireStop({ tempFilePath: "/tmp/a.mp3" });
  await settle();
  assert.ok(rec.events[2].indexOf("error:ASR_UNAVAILABLE") === 0);

  var rec2 = collect();
  var deps2 = makeDeps({ transcribeResult: { ok: false, error: "INVALID_INPUT" } });
  var ctrl2 = voice.createVoiceController(rec2.cbs, deps2);
  var s2 = ctrl2.begin();
  deps2.recorder.__fireStart();
  ctrl2.stop(s2);
  deps2.recorder.__fireStop({ tempFilePath: "/tmp/a.mp3" });
  await settle();
  assert.ok(rec2.events[2].indexOf("RECORD_TOO_SHORT") !== -1);

  var rec3 = collect();
  var deps3 = makeDeps({ readFail: true });
  var ctrl3 = voice.createVoiceController(rec3.cbs, deps3);
  var s3 = ctrl3.begin();
  deps3.recorder.__fireStart();
  ctrl3.stop(s3);
  deps3.recorder.__fireStop({ tempFilePath: "/tmp/a.mp3" });
  await settle();
  assert.ok(rec3.events[2].indexOf("error:READ_FAIL") === 0);

  var rec4 = collect();
  var deps4 = makeDeps();
  var ctrl4 = voice.createVoiceController(rec4.cbs, deps4);
  var s4 = ctrl4.begin();
  deps4.recorder.__fireStart();
  deps4.recorder.__fireError({ errMsg: "fail" });
  assert.ok(rec4.events[1].indexOf("error:RECORD_FAIL") === 0, "有效会话内的录音器错误如实上抛");
});
