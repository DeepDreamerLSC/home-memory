"use strict";

// PR C 详情页回放：默认折叠/ badge 展开暂停/无自动 play/时间点 seek/换链与多证据降级。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
let pageConfig = null;
let videoRows = [];
let videoFails = false;
let videoDeleteFails = false;
let navigations = [];
let toasts = [];
let modals = [];
let pageScrolls = [];
let seekCalls = [];
let playCalls = [];
let pauseCalls = [];

function localIso(y, m, d, h) {
  return new Date(y, m - 1, d, h || 10, 30, 0).toISOString();
}

function summaryItem() {
  return {
    item_id: "it_1",
    name: "黑色耳机",
    location_text: "书房 · 抽屉",
    note: "",
    version: 2,
    updated_at: localIso(2026, 10, 19, 9),
  };
}

function box(extra) {
  return Object.assign({ x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.8 }, extra || {});
}

function hl(start, end, b) {
  return { start_ms: start, end_ms: end, box: b === undefined ? null : b, source: "user_confirmed" };
}

function videoRow(extra) {
  return Object.assign({
    evidence_id: "ve_1",
    item_id: "it_1",
    file_id: "cloud://bucket/video-evidence/hh/ve_1.mp4",
    video_url: "https://tmp.example/v1.mp4",
    duration_ms: 12000,
    video_w: 1280,
    video_h: 720,
    captured_location_text: "书房 · 抽屉",
    consent_version: "v1",
    highlights: [hl(1000, 2000, box())],
    highlight_version: 1,
    created_at: localIso(2026, 10, 19, 10),
  }, extra || {});
}

function reset() {
  videoRows = [];
  videoFails = false;
  videoDeleteFails = false;
  navigations = [];
  toasts = [];
  modals = [];
  pageScrolls = [];
  seekCalls = [];
  playCalls = [];
  pauseCalls = [];
}

function router(name, data) {
  if (name === "households" && data.action === "status") {
    return { ok: true, household_id: "default", shared: false };
  }
  if (name === "itemsApi") {
    if (data.action === "remindList") return { ok: true, reminders: [], household_id: "default" };
    if (data.action === "photoEvidenceGet") return { ok: true, household_id: "default", evidence: [] };
    if (data.action === "videoEvidenceGet") {
      if (videoFails) return Promise.reject(new Error("换链服务不可用"));
      return { ok: true, household_id: "default", evidence: videoRows };
    }
    if (data.action === "videoEvidenceDelete") {
      if (videoDeleteFails) return Promise.reject(new Error("删除失败"));
      return { ok: true, deleted: 1 };
    }
  }
  return Promise.reject(new Error("意外调用 " + name + ":" + (data && data.action)));
}

function installWx() {
  globalThis.wx = {
    showToast: function (o) { toasts.push(o); },
    showModal: function (o) {
      modals.push(o);
      if (o.success) o.success({ confirm: true });
    },
    navigateTo: function (o) { navigations.push(o && o.url); },
    navigateBack: function () {},
    reLaunch: function () {},
    getStorageSync: function () { return ""; },
    setStorageSync: function () {},
    removeStorageSync: function () {},
    getAccountInfoSync: function () { return { miniProgram: { envVersion: "develop" } }; },
    pageScrollTo: function (o) { pageScrolls.push(o); },
    createVideoContext: function () {
      return {
        seek: function (seconds) { seekCalls.push(seconds); },
        play: function () { playCalls.push(true); },
        pause: function () { pauseCalls.push(true); },
      };
    },
    cloud: {
      callFunction: function (o) {
        Promise.resolve()
          .then(function () { return router(o.name, o.data); })
          .then(function (result) { o.success({ result: result }); }, function (err) { o.fail({ errMsg: String((err && err.message) || err) }); });
      },
    },
  };
}

globalThis.Page = function (config) { pageConfig = config; };
installWx();
require(path.join(ROOT, "miniprogram", "pages", "item", "item.js"));

function makePage() {
  const page = {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData: function (patch) {
      Object.keys(patch).forEach(function (key) {
        if (key.indexOf(".") === -1 && key.indexOf("[") === -1) page.data[key] = patch[key];
      });
    },
  };
  Object.keys(pageConfig).forEach(function (key) {
    if (key !== "data") page[key] = pageConfig[key];
  });
  return page;
}

function settle() {
  return new Promise(function (resolve) { setTimeout(resolve, 60); });
}

function itemOptions(hint) {
  const options = { data: encodeURIComponent(JSON.stringify(summaryItem())) };
  if (hint) {
    options.video_entry = "search_badge";
    options.video_evidence_id = hint.evidenceId;
    if (hint.startMs !== null && hint.endMs !== null) {
      options.video_hint_start_ms = String(hint.startMs);
      options.video_hint_end_ms = String(hint.endMs);
    }
  }
  return options;
}

async function openPage(rows, hint) {
  videoRows = rows;
  const page = makePage();
  pageConfig.onLoad.call(page, itemOptions(hint));
  pageConfig.onShow.call(page);
  await settle();
  return page;
}

test("DETAIL:普通入口默认折叠;展开到 start-300ms 暂停且只 seek 不 play", async function () {
  reset();
  const page = await openPage([videoRow()]);
  assert.equal(page.data.videoReady, true);
  assert.equal(page.data.videoOpen, false, "普通入口默认折叠");
  assert.equal(page.data.videoSelected.evidenceId, "ve_1");
  assert.ok(page.data.videoFoldText.indexOf("你确认过的片段 0:01–0:02") !== -1);
  assert.equal(pageScrolls.length, 0);
  assert.equal(playCalls.length, 0);

  pageConfig.onVideoToggle.call(page);
  assert.equal(page.data.videoOpen, true);
  assert.equal(page.data.videoInitialTime, 0.7, "1000ms - 300ms 预卷");
  assert.equal(page.data.videoSeekPending, true);
  assert.equal(playCalls.length, 0, "展开不得自动 play");

  pageConfig.onVideoLoadedMetadata.call(page);
  assert.deepEqual(seekCalls, [0.7], "loadedmetadata 兜底 seek");
  assert.equal(playCalls.length, 0);

  pageConfig.onVideoTimeUpdate.call(page, { detail: { currentTime: 1.2, duration: 12 } });
  assert.deepEqual(page.data.videoActiveBox, { left: 10, top: 20, width: 40, height: 60 });
  pageConfig.onVideoTimeUpdate.call(page, { detail: { currentTime: 2.1, duration: 12 } });
  assert.equal(page.data.videoActiveBox, null);

  const key = page.data.videoSelected.highlights[0].key;
  pageConfig.onVideoHighlightTap.call(page, { currentTarget: { dataset: { highlightKey: key } } });
  assert.equal(seekCalls.length, 2, "时间点点击只 seek");
  assert.equal(seekCalls[1], 0.7);
  assert.equal(playCalls.length, 0, "时间点点击不 play");
});

test("BADGE:进入后滚动并展开暂停态;再次 onShow 不复用展开,始终不 play", async function () {
  reset();
  const page = await openPage([videoRow()], { evidenceId: "ve_1", startMs: 1000, endMs: 2000 });
  assert.equal(pageScrolls.length, 1);
  assert.equal(page.data.videoOpen, true, "badge 入口展开暂停态");
  assert.equal(page.data.videoInitialTime, 0.7);
  assert.equal(playCalls.length, 0);

  pageConfig.onShow.call(page);
  await settle();
  assert.equal(page.data.videoOpen, false, "后续 onShow 恢复折叠");
  assert.equal(pageScrolls.length, 1, "scroll/展开只消费一次");
  assert.equal(playCalls.length, 0);
});

test("NO-HIGHLIGHT:回退 0s 普通回放,文案如实且无时间点", async function () {
  reset();
  const page = await openPage([videoRow({ highlights: [], highlight_version: 0 })]);
  assert.equal(page.data.videoSelected.highlights.length, 0);
  assert.ok(page.data.videoFoldText.indexOf("点开当时视频") !== -1);
  pageConfig.onVideoToggle.call(page);
  assert.equal(page.data.videoInitialTime, 0);
  assert.equal(page.data.videoSelected.highlights.length, 0);
  assert.equal(playCalls.length, 0);
});

test("URL-FAIL:全部换链失败显示重试态,不渲染 seek/play", async function () {
  reset();
  const page = await openPage([videoRow({ video_url: "" })]);
  assert.equal(page.data.videoOpen, false);
  assert.equal(page.data.videoSelected.playable, false);
  assert.ok(page.data.videoFoldText.indexOf("视频暂时无法加载") !== -1);
  pageConfig.onVideoToggle.call(page);
  await settle();
  assert.equal(page.data.videoOpen, false);
  assert.equal(seekCalls.length, 0);
  assert.equal(playCalls.length, 0);
});

test("MULTI:显式目标换链失败回退旧可播行;提示明确且原目标行仍在列表中", async function () {
  reset();
  const rows = [
    videoRow({ evidence_id: "ve_bad", file_id: "f-bad", video_url: "", highlights: [hl(1000, 2000, null)], created_at: localIso(2026, 10, 19, 10) }),
    videoRow({ evidence_id: "ve_good", file_id: "f-good", video_url: "https://tmp.example/good.mp4", highlights: [hl(3000, 4000, null)], created_at: localIso(2026, 10, 18, 10) }),
  ];
  const page = await openPage(rows, { evidenceId: "ve_bad", startMs: 1000, endMs: 2000 });
  assert.equal(page.data.videoEvidence.all.length, 2);
  assert.equal(page.data.videoSelected.evidenceId, "ve_good");
  assert.ok(page.data.videoPlaybackNotice.indexOf("原目标视频暂时无法加载") !== -1);
  assert.ok(page.data.videoPlaybackNotice.indexOf("已回退到更早") !== -1);
  assert.equal(page.data.videoOpen, true, "回退到可播行后仍按 badge 展开暂停");
  assert.equal(page.data.videoInitialTime, 2.7);
  assert.equal(playCalls.length, 0);

  pageConfig.onVideoEvidenceSelect.call(page, { currentTarget: { dataset: { evidenceId: "ve_bad" } } });
  assert.equal(page.data.videoSelected.evidenceId, "ve_bad");
  assert.ok(page.data.videoPlaybackNotice.indexOf("这段视频暂时无法加载") !== -1);
  assert.equal(playCalls.length, 0);
});

test("MULTI-ITEM:详情只投影当前 item 的 rows;同 file_id 不串时间点", async function () {
  reset();
  const rows = [
    videoRow({ evidence_id: "ve_a", item_id: "it_1", file_id: "same-file", highlights: [hl(1000, 2000, null)] }),
    videoRow({ evidence_id: "ve_b", item_id: "it_2", file_id: "same-file", highlights: [hl(7000, 8000, null)] }),
  ];
  const page = await openPage(rows);
  assert.equal(page.data.videoEvidence.all.length, 1, "只保留当前 item 行");
  assert.equal(page.data.videoSelected.evidenceId, "ve_a");
  assert.deepEqual(page.data.videoSelected.highlights.map(function (h) { return h.startMs; }), [1000]);
  assert.equal(playCalls.length, 0);
});

test("STALE-HINT:非法/过期 hint 安全回退默认点,不用 query 时间 seek", async function () {
  reset();
  const page = await openPage([
    videoRow({ evidence_id: "ve_existing", highlights: [hl(4000, 5000, null)] }),
  ], { evidenceId: "ve_missing", startMs: 1000, endMs: 2000 });
  assert.equal(page.data.videoSelected.evidenceId, "ve_existing");
  assert.equal(page.data.videoInitialTime, 3.7);
  assert.ok(page.data.videoPlaybackNotice.indexOf("原来的视频片段不可用了") !== -1);
  assert.equal(seekCalls.indexOf(0.7), -1, "未使用 query 的 1000ms 直接 seek");
  assert.equal(playCalls.length, 0);
});

test("STATIC:详情页 WXML 不自动播放,回放代码不调用 play()", function () {
  const wxml = fs.readFileSync(path.join(ROOT, "miniprogram", "pages", "item", "item.wxml"), "utf8");
  const ts = fs.readFileSync(path.join(ROOT, "miniprogram", "pages", "item", "item.ts"), "utf8");
  assert.equal(wxml.indexOf('autoplay="{{ true }}"'), -1);
  assert.ok(wxml.indexOf('autoplay="{{ false }}"') !== -1);
  assert.equal(ts.indexOf(".play("), -1, "页面胶水不得程序化播放");
});

test("PLAYER-ERROR:运行期加载失败可重试;重试恢复暂停定位且不 play", async function () {
  reset();
  const page = await openPage([videoRow()]);
  pageConfig.onVideoToggle.call(page);
  assert.equal(page.data.videoOpen, true);
  pageConfig.onVideoPlaybackError.call(page);
  assert.ok(page.data.videoPlaybackError.indexOf("加载失败") !== -1);
  assert.equal(playCalls.length, 0);

  pageConfig.onVideoRetry.call(page);
  await settle();
  assert.equal(page.data.videoPlaybackError, "");
  assert.equal(page.data.videoOpen, true, "用户点重试后可恢复暂停态");
  assert.equal(page.data.videoInitialTime, 0.7);
  assert.equal(playCalls.length, 0);
  pageConfig.onVideoLoadedMetadata.call(page);
  assert.equal(seekCalls.length >= 1, true);
});
