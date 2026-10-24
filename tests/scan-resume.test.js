"use strict";
/**
 * 视频识别防熄屏(L1)+断点续扫(L2)反例测试(真机反馈 2026-10-24;
 * 页面测试模式照 tests/scene-group-page.test.js:fs/path 加载编译产物 .js、
 * 全局 Page/wx 桩驱动页面逻辑)。
 *
 * 被测对象:utils/video-scene.js(scanSceneVideo 的 skipFrameIndexes/onFrameDone)、
 * utils/keep-screen.js(setScanKeepScreenOn)、两页编译产物(旧会话兼容/进度恢复/
 * 取消保进度/续扫入口)。
 *
 * L2 核心契约:
 * - 帧完成标记(scannedFrameIndexes)与观察存在性解耦:零候选帧也算完成,
 *   续扫不重复识别;失败帧不算完成,续扫自动重试;
 * - 已完成帧续扫时不再抽帧(captureAt)也不再调 VL(callRecognize),只计进度;
 * - 存量会话无 scannedFrameIndexes 字段 = 无进度,行为与旧版一致(全量重扫);
 * - 取消时已有落盘进度 → 保留进度留在 review;零进度 → 清会话回 idle。
 * L1 契约:识别开始 setKeepScreenOn(true);结束/取消/onHide 全路径恢复 false。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const videoScene = require(path.join(ROOT, "miniprogram/utils/video-scene.js"));
const keepScreen = require(path.join(ROOT, "miniprogram/utils/keep-screen.js"));
const api = require(path.join(ROOT, "miniprogram/utils/api.js"));

/* ---------------- wx 桩 ---------------- */

let storage = {};
let toasts = [];
let keepCalls = [];

globalThis.wx = {
  getStorageSync: function (k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : ""; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  showToast: function (o) { toasts.push(o); },
  showModal: function () {},
  showActionSheet: function (o) { if (o && o.success) o.success({ tapIndex: 0 }); },
  navigateTo: function () {},
  navigateBack: function (o) { if (o && o.fail) o.fail(); },
  setNavigationBarTitle: function () {},
  stopPullDownRefresh: function () {},
  setKeepScreenOn: function (o) { if (o && o.keepScreenOn !== undefined) keepCalls.push(o.keepScreenOn); },
};

function resetStubs() {
  storage = {};
  toasts = [];
  keepCalls = [];
}

/* ---------------- 页面装载(先装桩再 require 编译产物) ---------------- */

const pages = {};
globalThis.Page = function (options) { pages.__last = options; };
require(path.join(ROOT, "miniprogram/pages/video-scan/video-scan.js"));
pages.videoScan = pages.__last;
require(path.join(ROOT, "miniprogram/pages/location-video-scan/location-video-scan.js"));
pages.locScan = pages.__last;

const originalCallItems = api.callItemsApi;
function itemsRouter(handler) {
  api.callItemsApi = function (event) { return Promise.resolve(handler(event)); };
}
test.after(function () { api.callItemsApi = originalCallItems; });

function makePage(options) {
  const page = {
    data: JSON.parse(JSON.stringify(options.data)),
    setData: function (patch, cb) {
      Object.keys(patch).forEach(function (k) { page.data[k] = patch[k]; });
      if (typeof cb === "function") cb();
    },
  };
  Object.keys(options).forEach(function (k) {
    if (k === "data") return;
    if (typeof options[k] === "function") { page[k] = options[k]; return; } // 内部 this.X() 互调需要
    const v = options[k];
    page[k] = Array.isArray(v) ? [] : (v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v)));
  });
  return page;
}

/* ---------------- utils:scanSceneVideo 断点续扫语义 ---------------- */

function fakeSession() {
  return {
    cancelled: false,
    captures: [],
    async captureAt(timeMs, frameIndex) { this.captures.push(frameIndex); return { base64: "Zg==", width: 8, height: 6 }; },
    async cancel() { this.cancelled = true; },
  };
}

function queueRecognizer(queue) {
  const calls = [];
  return {
    calls,
    callRecognize: async function () {
      calls.push(1);
      const next = queue.shift();
      if (next === undefined) throw new Error("识别调用次数超出队列——测试装配与帧计划不符");
      return next;
    },
  };
}

const DUR = 15000;

test("SR-PLAN:帧计划确定性;sceneFrameTotal 与 planSceneFrames 同源", function () {
  const a = videoScene.sceneFrameTotal(DUR);
  const b = videoScene.planSceneFrames(DUR).length;
  assert.equal(a, b, "总帧数单一来源");
  assert.equal(videoScene.sceneFrameTotal(DUR), a, "同时长两次调用一致");
  assert.ok(a >= 3, "测试时长应产生至少 3 帧(实际 " + a + ",调整 DUR)");
});

test("SR-UTIL-SKIP:续扫跳过已完成帧——不重抽帧、不重调 VL,只计进度", async function () {
  resetStubs();
  const plans = videoScene.planSceneFrames(DUR);
  const skip = [plans[0].frameIndex, plans[1].frameIndex];
  const remaining = plans.filter(function (p) { return skip.indexOf(p.frameIndex) === -1; });
  const rec = queueRecognizer(remaining.map(function () {
    return { ok: true, items: [{ name: "电池", box: null }] };
  }));
  const session = fakeSession();
  const frameDone = [];
  const progress = [];
  const outcome = await videoScene.scanSceneVideo({
    source: {},
    durationMs: DUR,
    session: session,
    skipFrameIndexes: skip,
    callRecognize: rec.callRecognize,
    onFrameDone: function (f) { frameDone.push(f); },
    onProgress: function (done, total) { progress.push([done, total]); },
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(session.captures.slice().sort(function (a, b) { return a - b; }),
    remaining.map(function (p) { return p.frameIndex; }).sort(function (a, b) { return a - b; }),
    "跳过帧不得重新抽帧");
  assert.equal(rec.calls.length, remaining.length, "跳过帧不得重调 VL");
  assert.ok(frameDone.every(function (f) { return skip.indexOf(f.frameIndex) === -1; }),
    "跳过帧不发 onFrameDone(页面已有其持久化结果)");
  const obsFrames = Array.from(new Set(outcome.observations.map(function (o) { return o.frameIndex; })));
  assert.ok(obsFrames.every(function (fi) { return skip.indexOf(fi) === -1; }), "本轮观察只来自未跳过帧");
  const last = progress[progress.length - 1];
  assert.equal(last[0], plans.length, "进度计入跳过帧(最终 done=总帧数)");
  assert.equal(last[1], plans.length);
});

test("SR-UTIL-ZERO-CANDIDATE:零候选帧也算完成(ok=true,观察为空)——不得靠观察存在性判完成", async function () {
  resetStubs();
  const plans = videoScene.planSceneFrames(DUR);
  const rec = queueRecognizer(plans.map(function () { return { ok: true, items: [] }; }));
  const frameDone = [];
  const outcome = await videoScene.scanSceneVideo({
    source: {}, durationMs: DUR, session: fakeSession(),
    callRecognize: rec.callRecognize,
    onFrameDone: function (f) { frameDone.push(f); },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.observations.length, 0, "全部零候选");
  assert.equal(frameDone.length, plans.length, "每帧都发完成事件");
  assert.ok(frameDone.every(function (f) { return f.ok === true && f.observations.length === 0; }),
    "零候选帧 ok=true 且观察为空");
});

test("SR-UTIL-FAIL-FRAME:失败帧 ok=false 不算完成(续扫自动重试),其余帧照常", async function () {
  resetStubs();
  const plans = videoScene.planSceneFrames(DUR);
  const responses = plans.map(function (p, i) {
    return i === 1 ? { ok: false, error: "AI_DOWN" } : { ok: true, items: [{ name: "胶带", box: null }] };
  });
  const rec = queueRecognizer(responses);
  const frameDone = [];
  const outcome = await videoScene.scanSceneVideo({
    source: {}, durationMs: DUR, session: fakeSession(),
    callRecognize: rec.callRecognize,
    onFrameDone: function (f) { frameDone.push(f); },
  });
  assert.equal(outcome.ok, true, "个别帧失败不废整轮");
  assert.equal(outcome.failures.length, 1, "失败帧计入 failures");
  const failed = frameDone.filter(function (f) { return f.ok === false; });
  assert.equal(failed.length, 1, "失败帧发 ok=false 完成事件(页面不落完成标记)");
  assert.equal(frameDone.length, plans.length);
});

/* ---------------- utils:keep-screen ---------------- */

test("SR-KEEP:开/关直通 wx.setKeepScreenOn;API 缺失时吞掉不抛", function () {
  resetStubs();
  keepScreen.setScanKeepScreenOn(true);
  keepScreen.setScanKeepScreenOn(false);
  assert.deepEqual(keepCalls, [true, false], "标志位直通");
  const original = globalThis.wx.setKeepScreenOn;
  delete globalThis.wx.setKeepScreenOn;
  let threw = false;
  try { keepScreen.setScanKeepScreenOn(true); } catch (e) { threw = true; }
  globalThis.wx.setKeepScreenOn = original;
  assert.equal(threw, false, "低版本无此 API 必须静默降级");
});

/* ---------------- 两页:会话兼容/恢复/取消保进度 ---------------- */

function seedBSession(scanned) {
  // 用页面自身 saveSession 生成合法存储形态(saveSession 有零内容守卫,给一条观察)
  const p0 = makePage(pages.videoScan);
  p0.setData({
    sceneId: "sr-s1", videoPath: "wxfile://sr", videoDurationMs: DUR,
    videoWidth: 8, videoHeight: 6, batchLocation: "书房",
    observations: [{ obsId: "o1", frameIndex: 0, timeMs: 0, windowStartMs: 0, windowEndMs: 1500, name: "电池", box: null }],
    scannedFrameIndexes: scanned, drafts: [], pendingUpload: null, frozenItems: [],
  });
  pages.videoScan.saveSession.call(p0);
  const key = Object.keys(storage).filter(function (k) { return k.indexOf("video-scene-session") !== -1; })[0];
  assert.ok(key, "会话已落盘");
  return key;
}

test("SR-PAGE-COMPAT:存量会话无 scannedFrameIndexes → 空进度,行为与旧版一致", function () {
  resetStubs();
  const key = seedBSession([0]);
  delete storage[key].scannedFrameIndexes; // 老版本会话形态
  const p = makePage(pages.videoScan);
  pages.videoScan.onLoad.call(p);
  assert.deepEqual(p.data.scannedFrameIndexes, [], "旧会话=无进度");
  assert.equal(p.data.framesTotal, videoScene.sceneFrameTotal(DUR), "总帧数恢复计算");
  assert.equal(p.data.phase, "review", "观察仍在,进确认态(与旧版一致)");
});

test("SR-PAGE-RESTORE:新会话恢复 scannedFrameIndexes 与 framesTotal", function () {
  resetStubs();
  seedBSession([0, 1]);
  const p = makePage(pages.videoScan);
  pages.videoScan.onLoad.call(p);
  assert.deepEqual(p.data.scannedFrameIndexes, [0, 1]);
  assert.equal(p.data.framesTotal, videoScene.sceneFrameTotal(DUR));
});

test("SR-PAGE-CANCEL:取消时已有落盘进度 → 保留进度留 review;零进度 → 清会话回 idle", async function () {
  resetStubs();
  // (a) 有进度:取消不清
  const pa = makePage(pages.videoScan);
  pa.setData({
    phase: "scanning", busy: true, sceneId: "sr-s2",
    videoPath: "wxfile://sr", videoDurationMs: DUR, videoWidth: 8, videoHeight: 6, batchLocation: "书房",
    observations: [], scannedFrameIndexes: [0], drafts: [], pendingUpload: null, frozenItems: [],
  });
  pa.scanSession = undefined;
  await pages.videoScan.onCancelScanTap.call(pa);
  assert.equal(pa.data.phase, "review", "有进度取消=留在确认态(横幅可续扫)");
  assert.deepEqual(pa.data.scannedFrameIndexes, [0], "进度保留");
  assert.ok(Object.keys(storage).some(function (k) { return k.indexOf("video-scene-session") !== -1; }), "会话已保存");

  // (b) 零进度:取消即清
  resetStubs();
  const pb = makePage(pages.videoScan);
  pb.setData({
    phase: "scanning", busy: true, sceneId: "sr-s3",
    videoPath: "wxfile://sr", videoDurationMs: DUR, videoWidth: 8, videoHeight: 6, batchLocation: "",
    observations: [], scannedFrameIndexes: [], drafts: [], pendingUpload: null, frozenItems: [],
  });
  pb.scanSession = undefined;
  await pages.videoScan.onCancelScanTap.call(pb);
  assert.equal(pb.data.phase, "idle", "零进度取消=回初始态");
  assert.ok(!Object.keys(storage).some(function (k) { return k.indexOf("video-scene-session") !== -1; }), "会话被清");
});

test("SR-PAGE-RESUME-GUARD:busy 或无视频信息时续扫入口静默不动作", async function () {
  resetStubs();
  const pa = makePage(pages.videoScan);
  pa.setData({ busy: true, videoPath: "wxfile://x", videoDurationMs: DUR, videoWidth: 8, videoHeight: 6, scannedFrameIndexes: [0] });
  await pages.videoScan.onResumeScanTap.call(pa);
  assert.equal(toasts.length, 0, "busy 时静默返回");
  const pb = makePage(pages.videoScan);
  pb.setData({ busy: false, videoPath: "", videoDurationMs: 0, videoWidth: 0, videoHeight: 0, scannedFrameIndexes: [0] });
  await pages.videoScan.onResumeScanTap.call(pb);
  assert.equal(toasts.length, 0, "无视频信息时静默返回(不弹错)");
});

/* ---------------- 两页:wxml 续扫卡与 L1 静态面 ---------------- */

function normalized(p) {
  return fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\s+/g, "");
}

test("SR-WXML-RESUME-CARD:两页续扫卡条件与处理器接线一致", function () {
  for (const p of [
    "miniprogram/pages/video-scan/video-scan.wxml",
    "miniprogram/pages/location-video-scan/location-video-scan.wxml",
  ]) {
    const s = normalized(p);
    assert.ok(s.indexOf("scannedFrameIndexes.length>0") !== -1, p + ": 有进度才显示");
    assert.ok(s.indexOf("scannedFrameIndexes.length<framesTotal") !== -1, p + ": 未完成才显示");
    assert.ok(s.indexOf('bindtap="onResumeScanTap"') !== -1, p + ": 续扫入口");
    assert.ok(s.indexOf('bindtap="onRescanTap"') !== -1, p + ": 重扫次选");
  }
});

test("SR-L1-STATIC:两页识别开始常亮、结束/取消/隐藏全路径恢复", function () {
  for (const p of [
    "miniprogram/pages/video-scan/video-scan.js",
    "miniprogram/pages/location-video-scan/location-video-scan.js",
  ]) {
    const s = fs.readFileSync(path.join(ROOT, p), "utf8");
    const onCount = s.split("setScanKeepScreenOn)(true)").length - 1;
    const offCount = s.split("setScanKeepScreenOn)(false)").length - 1;
    assert.ok(onCount >= 1, p + ": 识别开始常亮");
    assert.ok(offCount >= 3, p + ": 至少 结束/取消/onHide 三处恢复(实际 " + offCount + ")");
  }
});
