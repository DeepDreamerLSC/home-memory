"use strict";

/**
 * 语音录入入口共享模块(utils/voice-entry,issue #45 全局语音条)离线测试。
 * 被测对象是 `npm run build:mp` 产出的 miniprogram/utils/voice-entry.js
 * (package.json 的 pretest 已保证先编译)。零外部依赖。
 *
 * 覆盖(均为 issue #45 阶段验收的最小断言,中文文案即契约):
 * ① 完整链路:按住 → 录音 → 上滑取消(不上传)→ 再按住 → 松手 → 转写 → 提取 → 跳确认页;
 * ② 忙碌门禁:录音中再次按压不得启动新录音;
 * ③ 噪音转写(纯语气词)不进提取,如实提示「没听清」;
 * ④ 未完成批次三选门:继续核对上一批 / 放弃上一批(二次确认)/ 中止;
 * ⑤ 授权被拒选「用文字」:回退只路由给发起按压的宿主;
 * ⑥ 单例广播:多宿主同报状态,detach 后不再收。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var voiceEntry = require("../miniprogram/utils/voice-entry");
var draftSession = require("../miniprogram/utils/draft-session");

/* ---------------- wx 桩 ---------------- */

function makeWxStub(opts) {
  opts = opts || {};
  var storage = new Map();
  var toasts = [];
  var modals = [];
  var sheets = [];
  var navs = [];
  var cloudCalls = [];
  var stub = {
    toasts: toasts,
    modals: modals,
    sheets: sheets,
    navs: navs,
    cloudCalls: cloudCalls,
    wx: {
      getStorageSync: function (k) { return storage.has(k) ? storage.get(k) : ""; },
      setStorageSync: function (k, v) { storage.set(k, v); },
      removeStorageSync: function (k) { storage.delete(k); },
      getSetting: function (o) {
        o.success({ authSetting: { "scope.record": opts.recordAuth !== false } });
      },
      authorize: function (o) { o.success && o.success(); },
      openSetting: function () {},
      showToast: function (o) { toasts.push(o); },
      showModal: function (o) {
        modals.push(o);
        if (opts.onModal) { opts.onModal(o); }
      },
      showActionSheet: function (o) {
        sheets.push(o);
        if (opts.onSheet) { opts.onSheet(o); }
      },
      navigateTo: function (o) { navs.push(o.url); },
      cloud: {
        callFunction: function (o) {
          cloudCalls.push(o);
          o.success({ result: opts.extractResult || defaultExtractResult() });
        },
      },
    },
  };
  return stub;
}

function defaultExtractResult() {
  return {
    ok: true,
    original_text: "降压药在厨房第二个抽屉",
    drafts: [
      {
        name: "降压药",
        location_text: "厨房第二个抽屉",
        certain: true,
        qualifiers: [],
        source_quote: "降压药在厨房第二个抽屉",
      },
    ],
    truncated: false,
  };
}

/** 语音控制器依赖桩(与 voice.test.js 同构:可控 recorder + 转写) */
function makeDeps(opts) {
  opts = opts || {};
  var handlers = {};
  var uploaded = [];
  var startCount = 0;
  return {
    uploaded: uploaded,
    recorder: {
      start: function () { startCount += 1; },
      stop: function () { handlers.stopped = (handlers.stopped || 0) + 1; },
      onStart: function (cb) { handlers.start = cb; },
      onStop: function (cb) { handlers.stop = cb; },
      onError: function (cb) { handlers.error = cb; },
      __fireStart: function () { handlers.start(); },
      __fireStop: function (r) { handlers.stop(r); },
      __startCount: function () { return startCount; },
    },
    readFileBase64: function () { return Promise.resolve("QVVESU8="); },
    transcribe: function (b64, fmt) {
      uploaded.push(fmt);
      return Promise.resolve(opts.transcribeResult || { ok: true, text: "降压药在厨房第二个抽屉。" });
    },
  };
}

function settle() {
  return new Promise(function (r) { setTimeout(r, 25); });
}

/** 每个用例干净开始:wx 桩 + 模块单例复位 + 草稿会话复位 */
function setup(opts) {
  var stub = makeWxStub(opts);
  globalThis.wx = stub.wx;
  var deps = makeDeps(opts || {});
  voiceEntry.__setVoiceEntryDepsForTest(function () { return deps; });
  draftSession.__resetDraftSessionForTest();
  return { stub: stub, deps: deps };
}

function makeHost(name) {
  var host = {
    name: name,
    states: [],
    transcripts: [],
    fallbacks: 0,
    onStateChange: function (s) { host.states.push(s); },
    onTranscript: function (t) { host.transcripts.push(t); },
    fallbackToText: function () { host.fallbacks += 1; },
  };
  return host;
}

/** 按住并等授权返回(录音会话建立) */
async function pressAndWait(handle, clientY) {
  handle.pressStart(clientY);
  await settle();
}

test("① 完整链路:按住→录音→上滑取消不上传;再按住→松手→转写→提取→跳确认页", async function () {
  var ctx = setup();
  var host = makeHost("首页");
  var handle = voiceEntry.attachVoiceEntry(host);

  // 第一次按压:上滑取消,不得上传音频
  await pressAndWait(handle, 500);
  ctx.deps.recorder.__fireStart();
  handle.pressMove(400); // 上滑 100px > 阈值 60:进入待取消
  assert.equal(handle.getState().voiceState, "cancelPending", "上滑后进入待取消态");
  handle.pressEnd();
  assert.equal(handle.getState().voiceState, "idle", "松手后回到空闲");
  assert.equal(ctx.deps.uploaded.length, 0, "上滑取消的录音不得上传");
  assert.equal(ctx.stub.navs.length, 0, "取消不得触发任何跳转");

  // 第二次按压:正常松手 → 转写 → 提取 → 跳确认页
  await pressAndWait(handle, 500);
  ctx.deps.recorder.__fireStart();
  assert.equal(handle.getState().voiceState, "recording", "录音已启动");
  handle.pressEnd();
  ctx.deps.recorder.__fireStop({ tempFilePath: "/tmp/a.mp3" });
  var transcribingState = handle.getState();
  assert.equal(transcribingState.transcribing, true, "松手后进入识别中");
  assert.equal(transcribingState.partialText, "识别中…", "识别中提示文案沿用首页语义");
  await settle();

  assert.equal(ctx.stub.cloudCalls.length, 1, "有效转写应进入 AI 提取");
  assert.equal(ctx.stub.cloudCalls[0].data.text, "降压药在厨房第二个抽屉", "提取文本为清洗后的转写");
  assert.equal(ctx.stub.navs.length, 1, "提取成功应跳确认页");
  assert.ok(
    ctx.stub.navs[0].indexOf("/pages/confirm/confirm?sid=") === 0,
    "跳转确认页且携带会话 id:" + ctx.stub.navs[0]
  );
  assert.deepEqual(host.transcripts, ["降压药在厨房第二个抽屉"], "有效转写文本回传发起按压的宿主");
  handle.detach();
});

test("② 忙碌门禁:录音中再次按压不得启动新录音", async function () {
  var ctx = setup();
  var handle = voiceEntry.attachVoiceEntry(makeHost("首页"));
  await pressAndWait(handle, 500);
  ctx.deps.recorder.__fireStart();
  assert.equal(ctx.deps.recorder.__startCount(), 1, "第一次按压启动录音");

  handle.pressStart(500); // 录音中再按:必须被门禁拦下
  await settle();
  assert.equal(ctx.deps.recorder.__startCount(), 1, "忙碌门禁生效,不得再次启动录音");
  assert.equal(handle.isBusy(), true, "录音中入口为忙碌态");
  handle.pressEnd();
  ctx.deps.recorder.__fireStop({ tempFilePath: "/tmp/a.mp3" });
  await settle();
  handle.detach();
});

test("③ 噪音转写不进提取:如实提示「没听清」,不调云函数不跳页", async function () {
  var ctx = setup({ transcribeResult: { ok: true, text: "嗯。" } });
  var handle = voiceEntry.attachVoiceEntry(makeHost("首页"));
  await pressAndWait(handle, 500);
  ctx.deps.recorder.__fireStart();
  handle.pressEnd();
  ctx.deps.recorder.__fireStop({ tempFilePath: "/tmp/a.mp3" });
  await settle();

  assert.equal(ctx.stub.toasts.length, 1, "应给出一次如实提示");
  assert.equal(ctx.stub.toasts[0].title, "没听清,请重试或改用文字", "噪音提示文案沿用首页语义");
  assert.equal(ctx.stub.cloudCalls.length, 0, "噪音文本不得进入 AI 提取");
  assert.equal(ctx.stub.navs.length, 0, "不得跳确认页");
  handle.detach();
});

test("④ 未完成批次三选门:继续核对 / 放弃(二次确认)/ 中止", async function () {
  // (a) 继续:跳回原会话,本次不提取(旧批次须在 setup 之后建立,避免被复位清掉)
  var ctxA = setup({
    onSheet: function (o) { o.success({ tapIndex: 0 }); },
  });
  var oldSid = draftSession.createDraftSession(
    "昨天的原话",
    [{ name: "旧物品", location_text: "旧位置", certain: true, qualifiers: [], source_quote: "昨天的原话" }],
    false
  );
  var handleA = voiceEntry.attachVoiceEntry(makeHost("首页"));
  await handleA.extract("新的一句话");
  assert.equal(ctxA.stub.sheets.length, 1, "存在未完成批次时必须先三选");
  assert.ok(
    ctxA.stub.sheets[0].itemList[0].indexOf("继续核对上一批(共 1 件)") !== -1,
    "三选首项文案讲清件数"
  );
  assert.deepEqual(ctxA.stub.navs, ["/pages/confirm/confirm?sid=" + oldSid], "继续核对=跳回原批次");
  assert.equal(ctxA.stub.cloudCalls.length, 0, "继续核对不得触发新提取");
  handleA.detach();

  // (b) 放弃:二次确认讲清「不撤销」,确认后清旧建新
  var ctxB = setup({
    onSheet: function (o) { o.success({ tapIndex: 1 }); },
    onModal: function (o) { o.success({ confirm: true }); },
  });
  draftSession.createDraftSession(
    "昨天的原话",
    [{ name: "旧物品", location_text: "旧位置", certain: true, qualifiers: [], source_quote: "昨天的原话" }],
    false
  );
  var oldSidB = draftSession.getUnfinishedDraftSession().sid;
  var handleB = voiceEntry.attachVoiceEntry(makeHost("首页"));
  await handleB.extract("新的一句话");
  assert.equal(ctxB.stub.modals.length, 1, "放弃必须二次确认");
  assert.equal(ctxB.stub.modals[0].title, "放弃上一批?", "二次确认标题如实");
  assert.equal(ctxB.stub.cloudCalls.length, 1, "确认放弃后才进行本次提取");
  assert.equal(ctxB.stub.navs.length, 1, "提取后跳新确认页");
  assert.notEqual(ctxB.stub.navs[0], "/pages/confirm/confirm?sid=" + oldSidB, "新会话不复用旧 sid");
  var unfinished = draftSession.getUnfinishedDraftSession();
  assert.ok(unfinished !== null && unfinished.sid !== oldSidB, "持久层已被新批次接管");
  handleB.detach();

  // (c) 中止(点遮罩):什么都不动
  var ctxC = setup({
    onSheet: function (o) { o.fail({}); },
  });
  draftSession.createDraftSession(
    "昨天的原话",
    [{ name: "旧物品", location_text: "旧位置", certain: true, qualifiers: [], source_quote: "昨天的原话" }],
    false
  );
  var handleC = voiceEntry.attachVoiceEntry(makeHost("首页"));
  await handleC.extract("新的一句话");
  assert.equal(ctxC.stub.navs.length, 0, "中止不跳页");
  assert.equal(ctxC.stub.cloudCalls.length, 0, "中止不提取");
  handleC.detach();
});

test("⑤ 授权被拒选「用文字」:回退只路由给发起按压的宿主", async function () {
  var ctx = setup({
    recordAuth: false,
    onModal: function (o) { o.success({ confirm: false }); }, // 用户选「用文字」
  });
  var homeHost = makeHost("首页");
  var otherHost = makeHost("其他页");
  var homeHandle = voiceEntry.attachVoiceEntry(homeHost);
  voiceEntry.attachVoiceEntry(otherHost);

  await pressAndWait(homeHandle, 500); // 在首页宿主上按压
  assert.equal(ctx.stub.modals.length, 1, "授权被拒应弹权限说明");
  assert.equal(ctx.stub.modals[0].title, "需要录音权限", "权限弹窗标题沿用首页语义");
  assert.equal(homeHost.fallbacks, 1, "发起按压的宿主收到文字回退");
  assert.equal(otherHost.fallbacks, 0, "其他宿主不得被回退");
  homeHandle.detach();
});

test("⑥ 单例广播:多宿主同报状态;detach 后不再收", async function () {
  var ctx = setup();
  var hostA = makeHost("A页");
  var hostB = makeHost("B页");
  var handleA = voiceEntry.attachVoiceEntry(hostA);
  var handleB = voiceEntry.attachVoiceEntry(hostB);

  await pressAndWait(handleA, 500);
  ctx.deps.recorder.__fireStart();
  var aRecording = hostA.states.filter(function (s) { return s.voiceState === "recording"; }).length;
  var bRecording = hostB.states.filter(function (s) { return s.voiceState === "recording"; }).length;
  assert.equal(aRecording > 0 && bRecording > 0, true, "状态变化应广播给所有在挂宿主");

  handleB.detach();
  handleA.pressEnd();
  ctx.deps.recorder.__fireStop({ tempFilePath: "/tmp/a.mp3" });
  await settle();
  var bAfterDetach = hostB.states.filter(function (s) { return s.partialText === "降压药在厨房第二个抽屉"; }).length;
  assert.equal(bAfterDetach, 0, "解除绑定后不得再收状态");
  var aAfterDetach = hostA.states.filter(function (s) { return s.partialText === "降压药在厨房第二个抽屉"; }).length;
  assert.equal(aAfterDetach > 0, true, "仍在挂的宿主照常收到转写结果");
  handleA.detach();
});
