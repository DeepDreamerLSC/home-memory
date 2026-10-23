"use strict";

/**
 * Q3 视觉数量页面接线(issue #102 §2/§5;Q0-CONTRACT §8/§9/§12-C/D 的 Q3 行):
 * - 两视频入口(video-scan / location-video-scan)草稿卡同款数量输入:
 *   onDraftQtyStep / onDraftUnitChange,draftViews 携 qty/unit/unitIndex/quantitySet;
 *   未触碰的草稿绝不因线索数预填数量;保存冻结载荷带用户确认值;
 * - 组卡「就 1 件」生成的聚合草稿不带数量(数量与线索数解耦);
 * - photo 页合并流:onRowMergeSelectTap / onMergeSelectedTap / onMergedSourcesTap,
 *   合成行整照关联(box=null)、来源候选可展开查验、提交载荷带 quantity=N
 *   且绝不携带 mergedFrom;默认无任何自动合并。
 * 被测对象:npm run build:mp 产物页面 .js(模式照 tests/scene-group-page.test.js)。
 * 红绿纪律:本文件在未实现接线/合并的代码上必须失败,实现后全绿。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var api = require(path.join(ROOT, "miniprogram/utils/api.js"));
var videoScene = require(path.join(ROOT, "miniprogram/utils/video-scene.js"));
var intakeDraft = require(path.join(ROOT, "miniprogram/utils/intake-draft.js"));

/* ---------------- wx 桩 ---------------- */

var toasts = [];
var modals = [];
var uploads = [];
var commitEvents = [];
var storage = {};

globalThis.wx = {
  getStorageSync: function (k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : ""; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  showToast: function (o) { toasts.push(o.title); },
  showModal: function (o) {
    modals.push(o);
    if (o.success) o.success({ confirm: true, cancel: false });
  },
  showActionSheet: function (o) { if (o && o.success) o.success({ tapIndex: 0 }); },
  previewImage: function () {},
  navigateTo: function () {},
  navigateBack: function (o) { if (o && o.fail) o.fail(); },
  setNavigationBarTitle: function () {},
  stopPullDownRefresh: function () {},
  cloud: {
    callFunction: function (o) {
      Promise.resolve()
        .then(function () { return api.__routerForTest ? api.__routerForTest(o.name, o.data) : { ok: true }; })
        .then(
          function (result) { o.success({ result: result }); },
          function (err) { o.fail({ errMsg: String((err && err.message) || err) }); }
        );
    },
    uploadFile: function (o) {
      uploads.push(o);
      o.success({ fileID: "cloud://bucket/video.mp4" });
    },
  },
};

function resetStubs() {
  toasts = [];
  modals = [];
  uploads = [];
  commitEvents = [];
  storage = {};
}

/* ---------------- 页面装载 ---------------- */

var pages = {};
globalThis.Page = function (options) { pages.__last = options; };
require(path.join(ROOT, "miniprogram/pages/video-scan/video-scan.js"));
pages.videoScan = pages.__last;
require(path.join(ROOT, "miniprogram/pages/location-video-scan/location-video-scan.js"));
pages.locScan = pages.__last;
require(path.join(ROOT, "miniprogram/pages/photo/photo.js"));
pages.photo = pages.__last;

var originalCallItems = api.callItemsApi;
test.after(function () { api.callItemsApi = originalCallItems; });

function makePage(options) {
  var page = {
    data: JSON.parse(JSON.stringify(options.data)),
    setData: function (patch, cb) {
      Object.keys(patch).forEach(function (k) { page.data[k] = patch[k]; });
      if (typeof cb === "function") cb();
    },
  };
  Object.keys(options).forEach(function (k) {
    if (k === "data") return;
    page[k] = options[k];
  });
  return page;
}

function mustMethod(page, name) {
  assert.equal(typeof page[name], "function", "缺少方法 " + name);
}

function obs(name, frameIndex, timeMs, box) {
  return {
    obsId: "obs-" + name + "-" + frameIndex + "-" + Math.floor(timeMs),
    frameIndex: frameIndex,
    timeMs: timeMs,
    windowStartMs: Math.max(0, timeMs - 750),
    windowEndMs: Math.min(12000, timeMs + 750),
    framePath: "tmp://f" + frameIndex + ".jpg",
    frameWidth: 1280,
    frameHeight: 720,
    name: name,
    qtyNote: "",
    confidence: "mid",
    box: box === undefined ? { x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 } : box,
  };
}

function ids(list) {
  return list.map(function (o) { return o.obsId; });
}

function tick() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

/* ---------------- 两视频入口:数量输入接线 ---------------- */

test("VQP-CONSISTENCY 两页方法与 wxml 接线一致(两视频入口一致,issue §2 边界)", function () {
  var vs = path.join(ROOT, "miniprogram/pages/video-scan/video-scan.wxml");
  var ls = path.join(ROOT, "miniprogram/pages/location-video-scan/location-video-scan.wxml");
  [vs, ls].forEach(function (wxml) {
    var text = fs.readFileSync(wxml, "utf8");
    assert.ok(text.indexOf("onDraftQtyStep") !== -1, "wxml 必须接 onDraftQtyStep: " + wxml);
    assert.ok(text.indexOf("onDraftUnitChange") !== -1, "wxml 必须接 onDraftUnitChange: " + wxml);
    assert.ok(text.indexOf("线索数不代表件数") !== -1, "数量行必须声明线索数≠件数: " + wxml);
  });
  var vsPage = makePage(pages.videoScan);
  var lsPage = makePage(pages.locScan);
  mustMethod(vsPage, "onDraftQtyStep");
  mustMethod(vsPage, "onDraftUnitChange");
  mustMethod(lsPage, "onDraftQtyStep");
  mustMethod(lsPage, "onDraftUnitChange");
});

test("VQP-VIEW draftViews 携带数量视图字段:未触碰 qty=1/无数量,已确认显示 ×N单位", function () {
  var page = makePage(pages.videoScan);
  var observations = [obs("棉柔巾", 0, 500)];
  var untouched = videoScene.newSceneDraft({
    name: "棉柔巾", locationText: "书房", observationIds: ids(observations), checked: true,
  });
  var touched = videoScene.stepDraftQty(
    videoScene.newSceneDraft({ name: "抽纸", locationText: "书房", observationIds: ids(observations), checked: true }),
    2
  );
  page.setData({ drafts: [untouched, touched] });
  page.renderDrafts();
  assert.equal(page.data.draftViews[0].qty, 1, "未触碰显示 1(缺省口径),线索数不预填数量");
  assert.equal(page.data.draftViews[0].quantitySet, false);
  assert.equal(page.data.draftViews[0].unit, "件");
  assert.equal(page.data.draftViews[1].qty, 3);
  assert.equal(page.data.draftViews[1].quantitySet, true);
  assert.equal(page.data.draftViews[1].unit, "件");
});

test("VQP-STEP-B 步进/单位选择更新草稿并重渲染(video-scan)", function () {
  var page = makePage(pages.videoScan);
  var observations = [obs("棉柔巾", 0, 500)];
  var draft = videoScene.newSceneDraft({ name: "棉柔巾", locationText: "书房", observationIds: ids(observations), checked: true });
  page.setData({ drafts: [draft] });
  page.onDraftQtyStep({ currentTarget: { dataset: { index: 0, d: 1 } } });
  assert.equal(page.data.drafts[0].quantity, 2);
  assert.equal(page.data.drafts[0].unit, "件");
  page.onDraftUnitChange({ currentTarget: { dataset: { index: 0 } }, detail: { value: 2 } }); // UNIT_SET[2]="包"
  assert.equal(page.data.drafts[0].unit, "包");
  assert.equal(page.data.draftViews[0].qty, 2);
  assert.equal(page.data.draftViews[0].unit, "包");
  assert.equal(page.data.draftViews[0].unitIndex, 2);
});

test("VQP-STEP-D1 位置清点入口同一交互(location-video-scan)", function () {
  var page = makePage(pages.locScan);
  var observations = [obs("棉柔巾", 0, 500)];
  var draft = videoScene.newSceneDraft({ name: "棉柔巾", locationText: "书房 / 书柜", observationIds: ids(observations), checked: true });
  page.setData({ drafts: [draft] });
  page.onDraftQtyStep({ currentTarget: { dataset: { index: 0, d: 3 } } });
  assert.equal(page.data.drafts[0].quantity, 4, "1+3=4(用户输入,与线索数无关)");
  page.renderDrafts();
  assert.equal(page.data.draftViews[0].qty, 4);
});

test("VQP-GROUP-NO-QTY 组卡「就 1 件」聚合草稿不带数量(线索数永不赋值数量)", async function () {
  resetStubs();
  var page = makePage(pages.videoScan);
  var observations = [];
  for (var i = 0; i < 6; i++) observations.push(obs("螺丝刀", i, i * 1600));
  page.setData({ phase: "review", batchLocation: "书房 / 工具抽屉", observations: observations, drafts: [] });
  page.renderObservations();
  var group = page.data.observationGroups[0];
  assert.equal(group.nameKey, videoScene.groupSceneObservations(observations)[0].nameKey);
  await page.onGroupConfirmSingle({ detail: { nameKey: group.nameKey, obsIds: [] } });
  assert.equal(page.data.drafts.length, 1);
  assert.equal(page.data.drafts[0].observationIds.length, 6);
  assert.equal(page.data.drafts[0].quantity, undefined, "6 帧合成 1 件,数量控件未动 → 无数量(缺省 1,绝不 6)");
});

test("VQP-SAVE-FROZEN-B 保存冻结载荷带用户数量;未触碰行不带数量键(video-scan 全链)", async function () {
  resetStubs();
  api.callItemsApi = function (event) {
    commitEvents.push(event);
    if (event.action === "videoUploadBegin") {
      return Promise.resolve({
        upload_ticket: "tkt-1", upload_path: "video/x.mp4", asset_id: "as-1",
        expires_at: "2026-10-24T00:00:00.000Z",
      });
    }
    if (event.action === "videoUploadReceipt") return Promise.resolve({ ok: true });
    if (event.action === "videoSceneCommit") {
      return Promise.resolve({
        ok: true, ticket_state: "committed", evidence_failed: [],
        results: event.items.map(function (it, i) {
          return { index: i, ok: true, item_id: "it-" + i, created: true, evidence_saved: true };
        }),
      });
    }
    return Promise.reject(new Error("意外调用 " + event.action));
  };
  var page = makePage(pages.videoScan);
  var observations = [obs("棉柔巾", 0, 500), obs("抽纸", 1, 1600)];
  var d1 = videoScene.stepDraftQty(
    videoScene.newSceneDraft({ name: "棉柔巾", locationText: "书房", observationIds: [observations[0].obsId], checked: true }),
    1
  );
  var d2 = videoScene.newSceneDraft({ name: "抽纸", locationText: "书房", observationIds: [observations[1].obsId], checked: true });
  page.setData({
    phase: "review", sceneId: "scene-q3", videoPath: "tmp://v.mp4", videoDurationMs: 12000,
    videoWidth: 1280, videoHeight: 720, observations: observations, drafts: [d1, d2],
  });
  await page.onSaveTap();
  await tick(); await tick(); await tick();
  var commit = commitEvents.filter(function (e) { return e.action === "videoSceneCommit"; })[0];
  assert.ok(commit, "必须走到 videoSceneCommit");
  assert.equal(commit.items.length, 2);
  assert.equal(commit.items[0].quantity, 2, "用户确认 2 随冻结载荷提交");
  assert.equal(commit.items[0].unit, "件");
  assert.ok(!("quantity" in commit.items[1]), "未触碰行不带数量键(缺省 1/件)");
});

/* ---------------- photo 页:同帧多框合并接线 ---------------- */

function aiRow(draftId, name, box, over) {
  return Object.assign(
    {
      draftId: draftId,
      name: name,
      qty: 1,
      suffix: "备注",
      unit: "件",
      qtyTouched: false,
      exc: null,
      src: "ai",
      confidence: "high",
      box: box,
      checked: true,
      done: false,
      failMsg: "",
      operationId: "op-" + draftId,
    },
    over || {}
  );
}

var photoPage;

function freshPhotoPage(rows) {
  photoPage = makePage(pages.photo);
  photoPage.rowsRaw = rows;
  photoPage.setData({ entryReady: true, batchLocation: "卫生间 / 镜柜", photoPath: "tmp://p.jpg" });
  photoPage.rebuildRows();
  return photoPage;
}

test("PHP-MERGE 页面合并流:选两行 → 合成 1 条 ×2 整照关联,来源可展开", function () {
  resetStubs();
  var r1 = aiRow("d1", "棉柔巾", { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.5 });
  var r2 = aiRow("d2", "棉柔巾", { x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.9 });
  var page = freshPhotoPage([r1, r2]);
  mustMethod(page, "onRowMergeSelectTap");
  mustMethod(page, "onMergeSelectedTap");
  mustMethod(page, "onMergedSourcesTap");
  page.onRowMergeSelectTap({ currentTarget: { dataset: { index: 0 } } });
  page.onRowMergeSelectTap({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.data.mergeIds.length, 2);
  page.onMergeSelectedTap();
  assert.equal(page.rowsRaw.length, 1, "合成一行");
  assert.equal(page.rowsRaw[0].qty, 2);
  assert.equal(page.rowsRaw[0].box, null, "整照关联");
  assert.equal(page.rowsRaw[0].mergedFrom.length, 2, "来源候选保留(候选 id/框/名称)");
  assert.equal(page.data.mergeIds.length, 0, "合并后清空选择");
  // 视图:合成行标来源数,可展开查验
  var view = page.data.rows[0];
  assert.equal(view.mergedCount, 2);
  page.onMergedSourcesTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.rows[0].sourceViews.length, 2);
  // 最终确认弹层列出合成数量(用户点确认 = L1)
  page.onSaveTap();
  assert.ok(page.data.saveSheet, "必须弹出保存确认层");
  assert.equal(page.data.saveSheet.qtyLines[0], "#d1 棉柔巾 ×2件");
});

test("PHP-MERGE-PAYLOAD 页面保存链:合成行提交 quantity=2 + box=null,绝不带 mergedFrom", async function () {
  resetStubs();
  var commitPayload = null;
  api.callItemsApi = function (event) {
    if (event.action === "photoCommit") {
      commitPayload = event;
      return Promise.resolve({
        ok: true,
        results: event.items.map(function (it, i) {
          return { index: i, ok: true, item_id: "it-" + i, duplicated: false, evidence_saved: true, version: 1 };
        }),
        evidence_failed: [],
      });
    }
    return Promise.reject(new Error("意外调用 " + event.action));
  };
  var r1 = aiRow("d1", "棉柔巾", { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.5 });
  var r2 = aiRow("d2", "棉柔巾", { x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.9 });
  var page = freshPhotoPage([r1, r2]);
  page.sessionScope = null;
  page.saveBackDelayMs = 0;
  page.onRowMergeSelectTap({ currentTarget: { dataset: { index: 0 } } });
  page.onRowMergeSelectTap({ currentTarget: { dataset: { index: 1 } } });
  page.onMergeSelectedTap();
  page.onSaveTap();
  assert.ok(page.data.saveSheet);
  await page.onSaveGoTap();
  await tick(); await tick();
  assert.ok(commitPayload, "必须发出 photoCommit");
  assert.equal(commitPayload.items.length, 1);
  assert.equal(commitPayload.items[0].quantity, 2);
  assert.equal(commitPayload.items[0].unit, "件");
  assert.equal(commitPayload.items[0].photo.box, null, "C1:box=null 整照,绝不落 B1/B2 冒充");
  assert.equal(JSON.stringify(commitPayload).indexOf("mergedFrom"), -1, "来源候选绝不进提交载荷");
});

test("PHP-MERGE-BLOCK 单位不同 → toast 阻塞,行集原样;默认零操作绝不合并", async function () {
  resetStubs();
  var r1 = aiRow("d1", "棉柔巾", { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.5 }, { unit: "包" });
  var r2 = aiRow("d2", "棉柔巾", { x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.9 }, { unit: "盒" });
  var page = freshPhotoPage([r1, r2]);
  page.onRowMergeSelectTap({ currentTarget: { dataset: { index: 0 } } });
  page.onRowMergeSelectTap({ currentTarget: { dataset: { index: 1 } } });
  page.onMergeSelectedTap();
  assert.equal(page.rowsRaw.length, 2, "单位不同绝不默默叠加");
  assert.ok(toasts.length > 0);
  // 默认(零操作):两行独立,保存各 ×1
  var keep = page.rowsRaw.filter(function (r) { return r.checked && !r.done; });
  assert.equal(keep.length, 2);
});

test("PHP-MERGE-PENDING 合成行数量预填标待核对;用户步进后消失", function () {
  resetStubs();
  var r1 = aiRow("d1", "棉柔巾", { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.5 });
  var r2 = aiRow("d2", "棉柔巾", { x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.9 });
  var page = freshPhotoPage([r1, r2]);
  page.onRowMergeSelectTap({ currentTarget: { dataset: { index: 0 } } });
  page.onRowMergeSelectTap({ currentTarget: { dataset: { index: 1 } } });
  page.onMergeSelectedTap();
  assert.equal(page.data.rows[0].qtyPending, true, "合成数量是预填,标待核对");
  page.onStepTap({ currentTarget: { dataset: { index: 0, d: 1 } } });
  assert.equal(page.data.rows[0].qtyPending, false, "用户触碰步进器 = 确认");
  assert.equal(page.data.rows[0].qty, 3);
});

test("PHP-MERGE-WXML photo.wxml 接合并入口与来源查验区", function () {
  var text = fs.readFileSync(path.join(ROOT, "miniprogram/pages/photo/photo.wxml"), "utf8");
  assert.ok(text.indexOf("onRowMergeSelectTap") !== -1);
  assert.ok(text.indexOf("onMergeSelectedTap") !== -1);
  assert.ok(text.indexOf("onMergedSourcesTap") !== -1);
});
