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
 *
 * B1 回归(PR #48 复审,deferred promise 控制提取时序):
 * ⑦ 提取在途切到别的家庭(A→B):迟到结果丢弃——不建草稿、不跳页、如实提示;
 * ⑧ A→B→A 回切同样丢弃(以发起时的作用域代数为准,不以家庭 id 相等放行);
 * ⑨ 发起页面失效(invalidate)后提取返回:同样丢弃;
 * ⑩ 正常路径(未切换)仍建草稿跳确认页,提示链路不误伤。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var voiceEntry = require("../miniprogram/utils/voice-entry");
var draftSession = require("../miniprogram/utils/draft-session");
var householdScope = require("../miniprogram/utils/household-scope");

/* ---------------- wx 桩 ---------------- */

function makeWxStub(opts) {
  opts = opts || {};
  var storage = new Map();
  var toasts = [];
  var modals = [];
  var sheets = [];
  var navs = [];
  var cloudCalls = [];
  var pendingCloud = [];
  var stub = {
    toasts: toasts,
    modals: modals,
    sheets: sheets,
    navs: navs,
    cloudCalls: cloudCalls,
    /** 手动放行一笔挂起的提取调用(deferExtract 时序控制用) */
    resolveExtract: function (result) {
      var o = pendingCloud.shift();
      if (o) {
        o.success({ result: result || defaultExtractResult() });
      }
    },
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
          if (opts.deferExtract) {
            pendingCloud.push(o); // 挂起等测试手动放行(控制提取在途的时序)
            return;
          }
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

test("④b 真机时序:ActionSheet 关闭动画期 showModal 首次 fail → 退避重试一次仍能走通;两次 fail 绝不静默(2026-10-23 真机反馈复现)", async function () {
  // 复现:真机上 ActionSheet success 回调里立刻 wx.showModal 可能因弹层动画未结束而 fail,
  // 旧实现 fail → resolve(false) 静默返回——用户点了「放弃上一批,记新的」后毫无反应。
  // (a) 首次 fail + 重试成功:链路必须继续(二次确认→提取→跳新确认页)
  var seen = 0;
  var ctxA = setup({
    onSheet: function (o) { o.success({ tapIndex: 1 }); },
    onModal: function (o) {
      seen += 1;
      if (seen === 1) { o.fail({ errMsg: "showModal:fail" }); return; } // 动画窗内首次 fail
      o.success({ confirm: true });
    },
  });
  draftSession.createDraftSession(
    "旧原话",
    [{ name: "旧物品", location_text: "旧位置", certain: true, qualifiers: [], source_quote: "旧原话" }],
    false
  );
  var handleA = voiceEntry.attachVoiceEntry(makeHost("首页"));
  await handleA.extract("新的物品一句话");
  assert.ok(ctxA.stub.modals.length >= 2, "首次 fail 必须退避重试(而非静默按取消处理),modal 至少两次");
  assert.equal(ctxA.stub.cloudCalls.length, 1, "重试确认后本次提取照常进行");
  assert.equal(ctxA.stub.navs.length, 1, "提取后跳新确认页");
  handleA.detach();

  // (b) 连续两次 fail:绝不允许无声无息——必须有可见提示(toast),且零提取零跳页
  var seenB = 0;
  var ctxB = setup({
    onSheet: function (o) { o.success({ tapIndex: 1 }); },
    onModal: function (o) { seenB += 1; o.fail({ errMsg: "showModal:fail" }); },
  });
  draftSession.createDraftSession(
    "旧原话2",
    [{ name: "旧物品2", location_text: "旧位置", certain: true, qualifiers: [], source_quote: "旧原话2" }],
    false
  );
  var oldSid = draftSession.getUnfinishedDraftSession().sid;
  var handleB = voiceEntry.attachVoiceEntry(makeHost("首页"));
  await handleB.extract("又一句话");
  assert.equal(ctxB.stub.cloudCalls.length, 0, "两次 fail:不提取");
  assert.equal(ctxB.stub.navs.length, 0, "两次 fail:不跳页");
  assert.equal(draftSession.getUnfinishedDraftSession().sid, oldSid, "旧批次保留(用户选择未被静默执行)");
  assert.ok(ctxB.stub.toasts.some(function (t) { return t.title.indexOf("重试") !== -1 || t.title.indexOf("放弃") !== -1; }), "两次 fail 必须有可见提示,不得静默");
  handleB.detach();
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

/* ---------------- B1 回归:提取在途的家庭切换 / 页面失效 ---------------- */

/** toast 文案汇总(断言用) */
function toastTitles(stub) {
  return stub.toasts.map(function (t) { return t.title; }).join("|");
}

/** 语音链路推进到「提取在途」:按住→录音→松手→转写返回(deferred,提取已发出未返回) */
async function pressUntilExtractPending(ctx, handle) {
  await pressAndWait(handle, 500);
  ctx.deps.recorder.__fireStart();
  handle.pressEnd();
  ctx.deps.recorder.__fireStop({ tempFilePath: "/tmp/a.mp3" });
  await settle();
  assert.equal(ctx.stub.cloudCalls.length, 1, "有效转写应已发出提取请求");
}

test("⑦ B1:语音提取在途切到别的家庭(A→B),迟到结果丢弃:不建草稿、不跳页、如实提示", async function () {
  householdScope.__resetHouseholdScopeForTest();
  try {
    var ctx = setup({ deferExtract: true });
    householdScope.captureHouseholdId("hh_family_a"); // 语音在家庭 A 发起
    var handle = voiceEntry.attachVoiceEntry(makeHost("家庭页"));
    await pressUntilExtractPending(ctx, handle);

    householdScope.captureHouseholdId("hh_family_b"); // AI 提取在途,家里切到 B
    ctx.stub.resolveExtract();
    await settle();

    assert.equal(ctx.stub.navs.length, 0, "迟到结果不得跳确认页");
    assert.equal(
      draftSession.getUnfinishedDraftSession(), null,
      "不得在切换后的家庭 B 出现新草稿/恢复入口"
    );
    householdScope.captureHouseholdId("hh_family_a");
    assert.equal(
      draftSession.getUnfinishedDraftSession(), null,
      "发起家庭 A 的命名空间同样不得出现迟到草稿"
    );
    var toasts = toastTitles(ctx.stub);
    assert.ok(toasts.indexOf("家里刚切换过") !== -1, "应如实提示家里刚切换过:" + toasts);
    assert.ok(toasts.indexOf("没记住") !== -1, "提示应说明这次没记住:" + toasts);
    handle.detach();
  } finally {
    householdScope.__resetHouseholdScopeForTest();
  }
});

test("⑧ B1:A→B→A 回切同样丢弃(以发起时的作用域代数为准,不以家庭 id 相等放行)", async function () {
  householdScope.__resetHouseholdScopeForTest();
  try {
    var ctx = setup({ deferExtract: true });
    householdScope.captureHouseholdId("hh_family_a");
    var handle = voiceEntry.attachVoiceEntry(makeHost("家庭页"));
    await pressUntilExtractPending(ctx, handle);

    householdScope.captureHouseholdId("hh_family_b");
    householdScope.captureHouseholdId("hh_family_a"); // 又切回 A:家庭 id 与发起时相同
    ctx.stub.resolveExtract();
    await settle();

    assert.equal(ctx.stub.navs.length, 0, "家庭 id 虽回到发起时的 A,但期间切换过,不得跳页");
    assert.equal(
      draftSession.getUnfinishedDraftSession(), null,
      "回切后不得以「家庭 id 相等」放行建草稿"
    );
    var toasts = toastTitles(ctx.stub);
    assert.ok(toasts.indexOf("家里刚切换过") !== -1, "应如实提示家里刚切换过:" + toasts);
    handle.detach();
  } finally {
    householdScope.__resetHouseholdScopeForTest();
  }
});

test("⑨ B1:发起页面失效(invalidate)后提取返回,同样丢弃", async function () {
  householdScope.__resetHouseholdScopeForTest();
  try {
    var ctx = setup({ deferExtract: true });
    householdScope.captureHouseholdId("hh_family_a");
    var handle = voiceEntry.attachVoiceEntry(makeHost("家庭页"));
    await pressUntilExtractPending(ctx, handle);

    handle.invalidate(); // 发起页面 hide/unload:在途提取的落盘/跳页副作用一并作废
    ctx.stub.resolveExtract();
    await settle();

    assert.equal(ctx.stub.navs.length, 0, "页面失效后不得跳确认页");
    assert.equal(draftSession.getUnfinishedDraftSession(), null, "页面失效后不得建草稿");
    var toasts = toastTitles(ctx.stub);
    assert.ok(toasts.indexOf("没记住") !== -1, "应给一句如实提示(这次没记住):" + toasts);
    handle.detach();
  } finally {
    householdScope.__resetHouseholdScopeForTest();
  }
});

test("⑩ B1:正常路径(家庭未切换)提取返回仍建草稿跳确认页,不误伤", async function () {
  householdScope.__resetHouseholdScopeForTest();
  try {
    var ctx = setup({ deferExtract: true });
    householdScope.captureHouseholdId("hh_family_a");
    var handle = voiceEntry.attachVoiceEntry(makeHost("家庭页"));
    await pressUntilExtractPending(ctx, handle);

    ctx.stub.resolveExtract(); // 提取期间家庭未切换
    await settle();

    assert.equal(ctx.stub.navs.length, 1, "正常路径应照常跳确认页");
    assert.ok(
      ctx.stub.navs[0].indexOf("/pages/confirm/confirm?sid=") === 0,
      "跳转确认页且携带会话 id:" + ctx.stub.navs[0]
    );
    var unfinished = draftSession.getUnfinishedDraftSession();
    assert.ok(unfinished !== null, "草稿建在发起家庭 A 的命名空间,恢复入口照常");
    assert.equal(unfinished.payload.drafts.length, 1, "默认提取结果为单件");
    assert.equal(toastTitles(ctx.stub).indexOf("没记住"), -1, "正常路径不得出现丢弃提示");
    handle.detach();
  } finally {
    householdScope.__resetHouseholdScopeForTest();
  }
});

/* ---------------- #3 拍照识物:routeExtract 可选旁路(现状锁的双向验证) ---------------- */

test("⑪ routeExtract:声明了旁路的宿主走自己的管线——不建草稿、不跳页,onTranscript 收到原话路径", async function () {
  householdScope.__resetHouseholdScopeForTest();
  try {
    var ctx = setup();
    var routed = [];
    var host = makeHost("photo 页");
    host.routeExtract = function (text, binding) {
      routed.push({ text: text, binding: binding });
      return Promise.resolve();
    };
    host.transcriptsRaw = [];
    host.onTranscript = function (t, audioPath) {
      host.transcriptsRaw.push([t, audioPath]);
    };
    var handle = voiceEntry.attachVoiceEntry(host);

    await pressAndWait(handle, 500);
    ctx.deps.recorder.__fireStart();
    handle.pressEnd();
    ctx.deps.recorder.__fireStop({ tempFilePath: "/tmp/photo-edit.mp3" });
    await settle();

    assert.equal(routed.length, 1, "有效转写移交宿主自带管线(photo 页接 draftEditParse)");
    assert.equal(routed[0].text, "降压药在厨房第二个抽屉", "原话逐字移交");
    assert.equal(typeof routed[0].binding.scopeGen, "number", "发起绑定随移(宿主自做迟到复核)");
    assert.equal(typeof routed[0].binding.abortEpoch, "number");
    assert.equal(ctx.stub.cloudCalls.length, 0, "旁路不走 extractText:零提取调用");
    assert.equal(ctx.stub.navs.length, 0, "旁路不建 confirm 会话、不跳页");
    assert.equal(draftSession.getUnfinishedDraftSession(), null, "旁路绝不建草稿");
    assert.deepEqual(
      host.transcriptsRaw,
      [["降压药在厨房第二个抽屉", "/tmp/photo-edit.mp3"]],
      "onTranscript 第二参透传本次录音临时文件路径(diff sheet 回听用)",
    );
    handle.detach();
  } finally {
    householdScope.__resetHouseholdScopeForTest();
  }
});

test("⑫ routeExtract:未声明旁路的宿主走既有 extractText(现状锁,行为逐字节一致)", async function () {
  householdScope.__resetHouseholdScopeForTest();
  try {
    var ctx = setup();
    var handle = voiceEntry.attachVoiceEntry(makeHost("普通宿主")); // 无 routeExtract
    await pressAndWait(handle, 500);
    ctx.deps.recorder.__fireStart();
    handle.pressEnd();
    ctx.deps.recorder.__fireStop({ tempFilePath: "/tmp/a.mp3" });
    await settle();

    assert.equal(ctx.stub.cloudCalls.length, 1, "未声明旁路照常进 AI 提取");
    assert.equal(ctx.stub.navs.length, 1, "照常跳确认页");
    assert.ok(draftSession.getUnfinishedDraftSession() !== null, "照常建草稿会话");
    handle.detach();
  } finally {
    householdScope.__resetHouseholdScopeForTest();
  }
});

test("⑬ routeExtract:家庭切换在途 → 绑定复核先拦,旁路不收迟到语音", async function () {
  householdScope.__resetHouseholdScopeForTest();
  try {
    var ctx = setup();
    var routed = [];
    var host = makeHost("photo 页");
    host.routeExtract = function (text) {
      routed.push(text);
      return Promise.resolve();
    };
    var handle = voiceEntry.attachVoiceEntry(host);

    await pressAndWait(handle, 500);
    ctx.deps.recorder.__fireStart();
    handle.pressEnd();
    householdScope.captureHouseholdId("hh_switched_mid_voice"); // 转写在途切家庭
    ctx.deps.recorder.__fireStop({ tempFilePath: "/tmp/b.mp3" });
    await settle();

    assert.equal(routed.length, 0, "迟到的语音绝不进旁路管线(不属于现在的家庭)");
    var toasts = toastTitles(ctx.stub);
    assert.ok(toasts.indexOf("家里刚切换过") !== -1, "如实提示:" + toasts);
    handle.detach();
  } finally {
    householdScope.__resetHouseholdScopeForTest();
  }
});
