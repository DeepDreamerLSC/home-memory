"use strict";

// PR C 搜索角标：确认片段时间、独立 badge 导航 hint、换链/旧行降级与多 item 隔离。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
let pageConfig = null;
let queryItems = [];
let videoRows = [];
let videoFails = false;
let navigations = [];
let toasts = [];
let cloudCalls = [];

function reset() {
  queryItems = [];
  videoRows = [];
  videoFails = false;
  navigations = [];
  toasts = [];
  cloudCalls = [];
}

function localIso(y, m, d, h) {
  return new Date(y, m - 1, d, h || 10, 30, 0).toISOString();
}

function item(id, name) {
  return {
    item_id: id,
    name: name,
    location_text: "书房 · 抽屉",
    note: "",
    version: 1,
    updated_at: localIso(2026, 10, 19, 9),
  };
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
    highlights: [{ start_ms: 1000, end_ms: 2000, box: null, source: "user_confirmed" }],
    highlight_version: 1,
    created_at: localIso(2026, 10, 19, 10),
  }, extra || {});
}

function router(name, data) {
  if (name === "households" && data.action === "status") {
    return { ok: true, household_id: "default", shared: false };
  }
  if (name === "itemsApi") {
    if (data.action === "query") return { ok: true, items: queryItems, match_type: "exact" };
    if (data.action === "photoEvidenceGet") return { ok: true, household_id: "default", evidence: [] };
    if (data.action === "videoEvidenceGet") {
      if (videoFails) return Promise.reject(new Error("换链服务不可用"));
      return { ok: true, household_id: "default", evidence: videoRows };
    }
  }
  return Promise.reject(new Error("意外调用 " + name + ":" + (data && data.action)));
}

function installWx() {
  globalThis.wx = {
    showToast: function (o) { toasts.push(o); },
    showModal: function (o) {},
    navigateTo: function (o) { navigations.push(o && o.url); },
    navigateBack: function () {},
    reLaunch: function () {},
    getStorageSync: function () { return ""; },
    setStorageSync: function () {},
    removeStorageSync: function () {},
    cloud: {
      callFunction: function (o) {
        cloudCalls.push({ name: o.name, data: JSON.parse(JSON.stringify(o.data)) });
        Promise.resolve()
          .then(function () { return router(o.name, o.data); })
          .then(function (result) { o.success({ result: result }); }, function (err) { o.fail({ errMsg: String((err && err.message) || err) }); });
      },
    },
  };
}

globalThis.Page = function (config) { pageConfig = config; };
installWx();
require(path.join(ROOT, "miniprogram", "pages", "index", "index.js"));

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
  return new Promise(function (resolve) { setTimeout(resolve, 30); });
}

async function runQuery(page) {
  page.setData({ queryText: "耳机" });
  await pageConfig.onQueryTap.call(page);
  await settle();
}

function videoCalls() {
  return cloudCalls.filter(function (c) { return c.name === "itemsApi" && c.data.action === "videoEvidenceGet"; });
}

test("SEARCH:有确认片段时 badge 显示起点，且异步查询不泄漏 URL/box", async function () {
  reset();
  queryItems = [item("it_1", "黑色耳机")];
  videoRows = [videoRow()];
  const page = makePage();
  await runQuery(page);

  assert.equal(videoCalls().length, 1);
  assert.deepEqual(videoCalls()[0].data.item_ids, ["it_1"]);
  const hint = page.data.queryResults[0].videoHint;
  assert.ok(hint);
  assert.equal(hint.badgeText, "▶ 0:01");
  assert.equal(hint.evidenceId, "ve_1");
  assert.equal(JSON.stringify(hint).indexOf("https://"), -1);
  assert.equal(toasts.length, 0);
});

test("NAV:badge 独立点击只带 evidence_id/start/end 只读 hint；整行点击不带视频 hint", async function () {
  reset();
  queryItems = [item("it_1", "黑色耳机")];
  videoRows = [videoRow()];
  const page = makePage();
  await runQuery(page);

  pageConfig.onResultVideoTap.call(page, { currentTarget: { dataset: { index: 0 } } });
  assert.equal(navigations.length, 1);
  const badgeUrl = navigations[0];
  assert.ok(badgeUrl.indexOf("video_entry=search_badge") !== -1);
  assert.ok(badgeUrl.indexOf("video_evidence_id=ve_1") !== -1);
  assert.ok(badgeUrl.indexOf("video_hint_start_ms=1000") !== -1);
  assert.ok(badgeUrl.indexOf("video_hint_end_ms=2000") !== -1);
  assert.equal(badgeUrl.indexOf("video_url"), -1);
  assert.equal(badgeUrl.indexOf("https"), -1);

  navigations = [];
  pageConfig.onResultTap.call(page, { currentTarget: { dataset: { index: 0 } } });
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].indexOf("video_entry"), -1, "普通行仍是普通详情入口");
});

test("DEGRADE:无高亮=▶ 视频；全换链失败=▶ 暂不可播；查询失败静默无 badge", async function () {
  reset();
  queryItems = [item("it_plain", "牙膏")];
  videoRows = [videoRow({ evidence_id: "ve_plain", item_id: "it_plain", highlights: [] })];
  let page = makePage();
  await runQuery(page);
  assert.equal(page.data.queryResults[0].videoHint.badgeText, "▶ 视频");

  reset();
  queryItems = [item("it_bad", "耳机")];
  videoRows = [videoRow({ evidence_id: "ve_bad", item_id: "it_bad", video_url: "" })];
  page = makePage();
  await runQuery(page);
  assert.equal(page.data.queryResults[0].videoHint.badgeText, "▶ 暂不可播");
  assert.equal(page.data.queryResults[0].videoHint.playable, false);

  reset();
  queryItems = [item("it_fail", "耳机")];
  videoFails = true;
  page = makePage();
  await runQuery(page);
  assert.equal(page.data.queryResults[0].videoHint, undefined);
  assert.equal(toasts.length, 0);
});

test("MULTI-ITEM:同 file_id 两个 item 的 badge 分别来自各自 highlights", async function () {
  reset();
  queryItems = [item("it_a", "耳机"), item("it_b", "电池")];
  videoRows = [
    videoRow({ evidence_id: "ve_a", item_id: "it_a", file_id: "same-file", highlights: [{ start_ms: 1000, end_ms: 2000, box: null, source: "user_confirmed" }] }),
    videoRow({ evidence_id: "ve_b", item_id: "it_b", file_id: "same-file", highlights: [{ start_ms: 7000, end_ms: 8000, box: null, source: "user_confirmed" }] }),
  ];
  const page = makePage();
  await runQuery(page);
  assert.equal(page.data.queryResults[0].videoHint.evidenceId, "ve_a");
  assert.equal(page.data.queryResults[0].videoHint.badgeText, "▶ 0:01");
  assert.equal(page.data.queryResults[1].videoHint.evidenceId, "ve_b");
  assert.equal(page.data.queryResults[1].videoHint.badgeText, "▶ 0:07");
});
