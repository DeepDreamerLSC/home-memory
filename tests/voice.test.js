"use strict";

/**
 * 语音录入封装的离线测试(纯逻辑 + 注入依赖的控制器流程)。
 * 被测对象是 `npm run build:mp` 产出的 miniprogram/utils/voice.js
 * (package.json 的 pretest 已保证先编译)。零外部依赖;
 * wx.* 调用路径在源码中均有 try/catch 兜底,离线安全。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var voice = require("../miniprogram/utils/voice");

function mockRecorder() {
  var handlers = {};
  return {
    start: function (opts) { handlers.opts = opts; },
    stop: function () { handlers.stopped = true; },
    onStart: function (cb) { handlers.start = cb; },
    onStop: function (cb) { handlers.stop = cb; },
    onError: function (cb) { handlers.error = cb; },
    __fireStart: function () { handlers.start(); },
    __fireStop: function (r) { handlers.stop(r); },
    __fireError: function (e) { handlers.error(e); },
    __getOpts: function () { return handlers.opts; }
  };
}

function makeDeps(opts) {
  var recorder = mockRecorder();
  return {
    recorder: recorder,
    readFileBase64: function () {
      if (opts && opts.readFail) {
        return Promise.reject(new Error("readFile fail: permission"));
      }
      return Promise.resolve("QVVESU8=");
    },
    transcribe: function () {
      if (opts && opts.transcribeResult) {
        return Promise.resolve(opts.transcribeResult);
      }
      return Promise.resolve({ ok: true, text: "降压药在厨房第二个抽屉。" });
    },
    __recorder: recorder
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

test("voiceErrorMessage:已知码中文文案,未知码如实回退提示", function () {
  assert.ok(voice.voiceErrorMessage("RECORD_TOO_SHORT").indexOf("太短") !== -1);
  assert.ok(voice.voiceErrorMessage("ASR_UNAVAILABLE").indexOf("文字") !== -1);
  assert.ok(voice.voiceErrorMessage("SOME_NEW_CODE").indexOf("文字") !== -1);
});

test("cleanTranscript:去首尾空白与标点,保留中间内容", function () {
  assert.equal(voice.cleanTranscript("  降压药在厨房抽屉 "), "降压药在厨房抽屉");
  assert.equal(voice.cleanTranscript("。降压药,在,厨房。"), "降压药,在,厨房");
  assert.equal(voice.cleanTranscript(""), "");
});

test("isSlideUpCancel:上滑超过阈值判取消,滑回恢复", function () {
  assert.equal(voice.isSlideUpCancel(500, 400), true);
  assert.equal(voice.isSlideUpCancel(500, 460), false);
  assert.equal(voice.isSlideUpCancel(500, 550), false);
});

test("summarizeTimings:空数据零值;多样本给 p50 与平均字数", function () {
  assert.deepEqual(voice.summarizeTimings([]), { count: 0, recordP50: 0, asrP50: 0, charsAvg: 0 });
  var s = voice.summarizeTimings([
    { recordMs: 2000, asrMs: 300, chars: 10, at: "t1" },
    { recordMs: 4000, asrMs: 500, chars: 20, at: "t2" },
    { recordMs: 6000, asrMs: 700, chars: 30, at: "t3" },
    { recordMs: 8000, asrMs: 900, chars: 40, at: "t4" },
  ]);
  assert.equal(s.count, 4);
  assert.equal(s.recordP50, 6000);
  assert.equal(s.asrP50, 700);
  assert.equal(s.charsAvg, 25);
});

test("控制器:完整流程 start→录音→停止→读文件→云函数转写→清洗后文本", async function () {
  var rec = collect();
  var deps = makeDeps();
  var ctrl = voice.createVoiceController(rec.cbs, deps);

  assert.equal(ctrl.start(), true);
  assert.deepEqual(deps.__recorder.__getOpts(), {
    format: "mp3", duration: 60000, sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 24000, frameSize: 4
  }, "录音参数:mp3/16k/单声道/24kbps");
  deps.__recorder.__fireStart();
  ctrl.stop();
  deps.__recorder.__fireStop({ tempFilePath: "/tmp/a.wav" });
  await new Promise(function (r) { setTimeout(r, 20); });
  assert.deepEqual(rec.events, ["start", "transcribing", "stop:降压药在厨房第二个抽屉"]);
});

test("控制器:上滑取消后结果丢弃,不进入识别也不回调", async function () {
  var rec = collect();
  var deps = makeDeps();
  var ctrl = voice.createVoiceController(rec.cbs, deps);
  ctrl.start();
  deps.__recorder.__fireStart();
  voice.markVoiceCancelled();
  ctrl.stop();
  deps.__recorder.__fireStop({ tempFilePath: "/tmp/a.wav" });
  await new Promise(function (r) { setTimeout(r, 20); });
  assert.deepEqual(rec.events, ["start"], "取消后不应出现 transcribing/stop");
});

test("控制器:云函数转写失败 → ASR_UNAVAILABLE;INVALID_INPUT → 太短提示", async function () {
  var rec = collect();
  var deps = makeDeps({ transcribeResult: { ok: false, error: "ASR_UNAVAILABLE", message: "语音识别失败" } });
  var ctrl = voice.createVoiceController(rec.cbs, deps);
  ctrl.start();
  deps.__recorder.__fireStart();
  ctrl.stop();
  deps.__recorder.__fireStop({ tempFilePath: "/tmp/a.wav" });
  await new Promise(function (r) { setTimeout(r, 20); });
  assert.equal(rec.events[2].indexOf("error:ASR_UNAVAILABLE"), 0);

  var rec2 = collect();
  var deps2 = makeDeps({ transcribeResult: { ok: false, error: "INVALID_INPUT" } });
  var ctrl2 = voice.createVoiceController(rec2.cbs, deps2);
  ctrl2.start();
  deps2.__recorder.__fireStart();
  ctrl2.stop();
  deps2.__recorder.__fireStop({ tempFilePath: "/tmp/a.wav" });
  await new Promise(function (r) { setTimeout(r, 20); });
  assert.ok(rec2.events[2].indexOf("RECORD_TOO_SHORT") !== -1);
});

test("控制器:读录音文件失败 → READ_FAIL;录音器报错 → RECORD_FAIL", async function () {
  var rec = collect();
  var deps = makeDeps({ readFail: true });
  var ctrl = voice.createVoiceController(rec.cbs, deps);
  ctrl.start();
  deps.__recorder.__fireStart();
  ctrl.stop();
  deps.__recorder.__fireStop({ tempFilePath: "/tmp/a.wav" });
  await new Promise(function (r) { setTimeout(r, 20); });
  assert.ok(rec.events[2].indexOf("error:READ_FAIL") === 0);

  var rec2 = collect();
  var deps2 = makeDeps();
  voice.createVoiceController(rec2.cbs, deps2);
  deps2.__recorder.__fireError({ errMsg: "fail" });
  assert.ok(rec2.events[0].indexOf("error:RECORD_FAIL") === 0);
});

test("isMeaningfulTranscript:语气词噪音不算有效输入,正常语音有效", function () {
  assert.equal(voice.isMeaningfulTranscript("嗯。"), false, "典型环境噪音转写");
  assert.equal(voice.isMeaningfulTranscript("啊"), false);
  assert.equal(voice.isMeaningfulTranscript("嗯嗯嗯"), false);
  assert.equal(voice.isMeaningfulTranscript(""), false);
  assert.equal(voice.isMeaningfulTranscript("  哦。 "), false);
  assert.equal(voice.isMeaningfulTranscript("钥匙在抽屉"), true);
  assert.equal(voice.isMeaningfulTranscript("啊,充电宝在书房"), true, "开头语气词剥除后仍有效");
  assert.equal(voice.isMeaningfulTranscript("哈密瓜放在茶几"), true, "含'哈'的真实词不受误伤");
});

test("会话守卫:松手/切换/离开后,迟到的授权回调不得启动录音", function () {
  var guard = voice.createSessionGuard();
  var s1 = guard.begin();
  assert.equal(guard.isCurrent(s1), true, "刚按下的会话有效");
  guard.invalidate(); // 模拟松手早于授权返回
  assert.equal(guard.isCurrent(s1), false, "松手后原会话作废,授权回调不得启动录音");
  var s2 = guard.begin();
  assert.equal(guard.isCurrent(s2), true, "新按压新会话");
  assert.equal(guard.isCurrent(s1), false, "旧会话不再复活");
  guard.invalidate();
  guard.invalidate();
  assert.equal(guard.isCurrent(s2), false, "多次作废(切换模式/离开页面)同样生效");
});

test("录音参数:mp3/16k/单声道/24kbps(压缩编码,60 秒约 180KB,远小于 3MB 限额)", async function () {
  var rec = collect();
  var deps = makeDeps();
  var ctrl = voice.createVoiceController(rec.cbs, deps);
  ctrl.start();
  assert.deepEqual(deps.__recorder.__getOpts(), {
    format: "mp3", duration: 60000, sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 24000, frameSize: 4
  });
});
