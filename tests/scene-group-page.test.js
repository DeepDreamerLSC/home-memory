"use strict";
/**
 * issue #101 R0 候选组收拢——两视频入口页面接线反例测试(先于实现;
 * 契约 docs/design/video-ai/R0-OBSERVATION-GROUPS.md §8 矩阵 C,页面测试模式照
 * tests/video-scene-page.test.js:fs/path 加载编译产物 .js、全局 Page 桩驱动页面逻辑)。
 * 被测对象:npm run build:mp 产出的 video-scan.js 与 location-video-scan.js。
 *
 * 契约 §5.2/§7 冻结的页面接线,由本文件冻结为实现验收面:
 * - data.observationGroups = buildSceneGroupViews(observations, drafts) 的组视图
 *   (形状=tests/scene-groups.test.js 冻结的 GroupView);data.sceneStats =
 *   groupStats(observations, drafts)({ observationCount, pendingGroupCount,
 *   draftCount, checkedDraftCount, topLineText });renderObservations 同时刷新两者。
 * - 组卡挂载:两页 json usingComponents["scene-group-card"] =
 *   "/components/scene-group-card/scene-group-card";wxml 以
 *   bind:obsToggle="onObservationToggle" / bind:obsPreview="onObsImageTap" /
 *   bind:confirmSingle="onGroupConfirmSingle" / bind:confirmMulti="onGroupConfirmMulti" /
 *   bind:defer="onGroupDefer" / bind:generatePerObs="onGenerateDraftsTap" 接线。
 * - 事件 detail:组级 { nameKey, obsIds? };行级 { obsId }。
 * - onGroupConfirmSingle:无风险组直接生成聚合草稿(newSceneDraft:name=组 label、
 *   locationText=video-scan 的 batchLocation / D1 的 locationPathText+nodeId、
 *   checked=true);风险组先弹 §2.1 冻结 modal,取消零变更;busy/非 review 禁用。
 *   modal 四要素经 scene-groups.sameFrameRiskModalCopy 单一来源,两页漂移即红;
 *   modal 时间=重复所在帧时间(scene-groups.duplicateFrameTimeText 单一来源,
 *   §2.1 修订 PR #105 review 5626920410),代表帧与重复帧不同帧时不得指错帧。
 * - D1「选去合并」nodeId 一致门(架构终裁,PR #105 review 5626920410):仅当
 *   被合并草稿目标位置一致(nodeId 全部相等;空=默认进入位置)才合并并保留
 *   nodeId;不一致(含「一件默认位置+一件子位置」)拒绝合并、草稿不变、toast
 *   提示先统一子位置。B 页 mergeSceneDrafts(无位置上下文)语义不变。
 * - 草稿卡警示(§2.1):draftViews[].highlightWarning=sceneHighlightWarningText
 *   (草稿线索数 >8 时为冻结警示串);组卡警示随剩余数,整组确认后由草稿卡接续。
 * - onDraftNameInput:改草稿名后组卡「已用于:{草稿名}」claimText 实时刷新(两页一致)。
 * - onGenerateDraftsTap(e):收敛为组内作用域,e.detail.obsIds 载荷;先过 §2.4
 *   claimGuard(toast「第 {序号} 条线索已用于「{草稿名}」…」阻塞),再按
 *   mergeSameName:false 一条一草稿生成。
 * - 旧开关 onMergeSameNameChange 移除;全局跨组勾选列表与全局生成按钮移除;
 *   既有合并/拆分/补件/关联入口零语义变化。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const api = require(path.join(ROOT, "miniprogram/utils/api.js"));
const locationScanUtil = require(path.join(ROOT, "miniprogram/utils/location-scan.js"));
const videoTarget = require(path.join(ROOT, "miniprogram/utils/video-target.js"));

/* ---------------- wx 桩(modal 不自动 success,由用例显式驱动确认/取消) ---------------- */

let storage = {};
let modalQueue = [];
let toasts = [];
let previews = [];

globalThis.wx = {
  getStorageSync: function (k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : ""; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  showToast: function (o) { toasts.push(o); },
  showModal: function (o) { modalQueue.push(o); },
  showActionSheet: function (o) { if (o && typeof o.success === "function") o.success({ tapIndex: 0 }); },
  previewImage: function (o) { previews.push(o); },
  navigateTo: function () {},
  navigateBack: function (o) { if (o && o.fail) o.fail(); },
  setNavigationBarTitle: function () {},
  stopPullDownRefresh: function () {},
};

function resetStubs() {
  storage = {};
  modalQueue = [];
  toasts = [];
  previews = [];
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

/** makePage:真实 setData 语义(合并进 data + 支持回调),类字段按既有测试先例复制 */
function makePage(options) {
  const page = {
    data: JSON.parse(JSON.stringify(options.data)),
    setData: function (patch, cb) {
      Object.keys(patch).forEach(function (k) { page.data[k] = patch[k]; });
      if (typeof cb === "function") cb();
    },
  };
  Object.keys(options).forEach(function (k) {
    if (k === "data" || typeof options[k] === "function") return;
    const v = options[k];
    page[k] = Array.isArray(v) ? [] : (v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v)));
  });
  Object.keys(options)
    .filter(function (k) { return typeof options[k] === "function"; })
    .forEach(function (k) { page[k] = options[k]; });
  return page;
}

function videoScanPage() {
  return makePage(pages.videoScan);
}

function locScanPage() {
  return makePage(pages.locScan);
}

/** 新增接线方法未实现时,以断言失败呈现(绝不以 TypeError 呈现) */
function mustPageMethod(page, name) {
  assert.equal(typeof page[name], "function", "页面应注册 " + name + "(契约 §5.2 接线;未实现)");
  return page[name];
}

/* ---------------- 观察工厂(与 utils/video-scene.ts 的 SceneObservation 同形) ---------------- */

let obsSeq = 0;
function obs(name, o) {
  o = o || {};
  const frameIndex = o.frameIndex === undefined ? 0 : o.frameIndex;
  const timeMs = o.timeMs === undefined ? frameIndex * 1500 : o.timeMs;
  obsSeq += 1;
  return {
    obsId: o.obsId || "obs-" + obsSeq,
    frameIndex,
    timeMs,
    windowStartMs: Math.max(0, timeMs - 750),
    windowEndMs: timeMs + 750,
    framePath: o.framePath || "/tmp/frame-" + frameIndex + ".jpg",
    frameWidth: 640,
    frameHeight: 480,
    name,
    qtyNote: "",
    confidence: "mid",
    box: "box" in o ? o.box : null,
  };
}

function crossFrameObs(name, n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(obs(name, { obsId: "obs-" + prefix + "-" + i, frameIndex: i, timeMs: i * 1500 }));
  }
  return out;
}

function read(pageDir, rel) {
  return fs.readFileSync(path.join(ROOT, "miniprogram/pages", pageDir, rel), "utf8");
}

/** video-scan 会话 storage 键(与页面 scopeKey 同式;householdScopeId 回退 default) */
const VIDEO_SESSION_KEY = "home-memory:video-scene-session:default";
const VIDEO_SESSION_FIELDS = [
  "batchLocation", "createdAt", "drafts", "durationMs", "frozenItems", "height",
  "observations", "pendingUpload", "phase", "sceneId", "scopeId", "version", "videoPath", "width",
];
const LOC_SESSION_FIELDS = [
  "createdAt", "drafts", "durationMs", "frozenItems", "height", "nodeId",
  "observations", "pendingUpload", "phase", "scanId", "scopeId", "version", "videoPath", "width",
];

/* ---------------- C-1 共享挂载与组视图产出 ---------------- */

test("SGP-SHARE:两页挂 scene-group-card、无内联组列表;renderObservations 产出组视图与统计(§5.2/§5.3)", () => {
  for (const dir of ["video-scan", "location-video-scan"]) {
    const cfgPath = path.join(ROOT, "miniprogram/pages", dir, dir + ".json");
    assert.equal(fs.existsSync(cfgPath), true, dir + ".json 应存在");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(
      cfg.usingComponents && cfg.usingComponents["scene-group-card"],
      "/components/scene-group-card/scene-group-card",
      dir + " 页应挂载共享组卡(契约 §5.2)",
    );
    const wxml = read(dir, dir + ".wxml");
    assert.ok(wxml.indexOf("<scene-group-card") !== -1, dir + " 页 wxml 应渲染组卡");
    // 接线冻结
    assert.ok(wxml.indexOf('bind:confirmSingle="onGroupConfirmSingle"') !== -1, dir + " 就 1 件接线");
    assert.ok(wxml.indexOf('bind:confirmMulti="onGroupConfirmMulti"') !== -1, dir + " 有多件接线");
    assert.ok(wxml.indexOf('bind:defer="onGroupDefer"') !== -1, dir + " 暂不确定接线");
    assert.ok(wxml.indexOf('bind:generatePerObs="onGenerateDraftsTap"') !== -1, dir + " 逐条生成接线");
    assert.ok(wxml.indexOf('bind:obsToggle="onObservationToggle"') !== -1, dir + " 行勾选接线(方法名保留)");
    assert.ok(wxml.indexOf('bind:obsPreview="onObsImageTap"') !== -1, dir + " 行预览接线");
    // 内联组列表移除:行级渲染进组件
    assert.equal(wxml.indexOf('wx:for="{{ group.observations }}"'), -1, dir + " 页不得内联展开观察行");
    assert.equal(wxml.indexOf('wx:for="{{group.observations}}"'), -1, dir + " 页不得内联展开观察行");
    assert.equal(wxml.indexOf('bindtap="onObservationToggle"'), -1, dir + " 行级勾选不得留在页面 wxml");
  }
  // D1P-REG 持续:B 页不引用 D1 页
  assert.equal(read("video-scan", "video-scan.wxml").indexOf("location-video-scan"), -1);

  // 两页 renderObservations 均产出 scene-groups 视图:6 条跨帧同名 → 1 组待确认、零草稿、统计分立
  const observations = crossFrameObs("电池", 6, "share");
  const vs = videoScanPage();
  vs.setData({ phase: "review", observations, drafts: [], batchLocation: "书房 · 右侧抽屉" });
  vs.renderObservations();
  assert.ok(Array.isArray(vs.data.observationGroups) && vs.data.observationGroups.length === 1, "6 条同名线索收拢为 1 组");
  assert.equal(vs.data.observationGroups[0].state, "pending", "零用户动作:组待确认,不被暗示为已确认一件");
  assert.equal(vs.data.observationGroups[0].sameFrameRisk, false, "跨帧同名不预判件数");
  assert.equal(vs.data.observationGroups[0].remainingCount, 6);
  assert.equal(vs.data.drafts.length, 0, "默认零草稿(不默认生 6 个草稿)");
  assert.ok(vs.data.sceneStats, "页面应持有 sceneStats(groupStats 推导)");
  assert.equal(vs.data.sceneStats.topLineText, "AI 线索 6 条 → 1 组待确认,已确认 0 件");

  const ls = locScanPage();
  ls.setData({ phase: "review", mode: "scan", nodeId: "lc_shelf", locationPathText: "书房 / 书柜", observations, drafts: [] });
  ls.renderObservations();
  assert.equal(ls.data.observationGroups.length, 1);
  assert.equal(ls.data.observationGroups[0].state, "pending");
  assert.ok(ls.data.sceneStats, "D1 页同样持有 sceneStats");
  assert.equal(ls.data.sceneStats.topLineText, "AI 线索 6 条 → 1 组待确认,已确认 0 件");

  // 行预览接线:obsPreview {obsId} → previewImage(current=该观察帧,urls=组内全部 framePath)
  vs.onObsImageTap({ detail: { obsId: "obs-share-1" } });
  assert.equal(previews.length, 1, "onObsImageTap 应读组件事件 e.detail.obsId");
  assert.equal(previews[0].current, "/tmp/frame-1.jpg");
  assert.deepEqual(
    previews[0].urls,
    observations.map(function (o) { return o.framePath; }),
    "预览 urls=组内全部 framePath(§3.2 同款语义)",
  );
});

/* ---------------- C-2 就 1 件:直生成 / 风险二次确认 ---------------- */

test("SGP-SINGLE-FLOW:无风险组直生成 1 草稿;busy/非 review 禁用;组态切「就 1 件」(§2.1)", async () => {
  resetStubs();
  const observations = crossFrameObs("充电器", 3, "single");
  const page = videoScanPage();
  page.setData({ phase: "review", observations, drafts: [], batchLocation: "书房 · 右侧抽屉" });
  page.renderObservations();

  const confirmSingle = mustPageMethod(page, "onGroupConfirmSingle");
  // busy 与非 review 阶段禁用(§2 前置)
  page.setData({ busy: true });
  await Promise.resolve(confirmSingle.call(page, { detail: { nameKey: "充电器", obsIds: [] } }));
  assert.equal(page.data.drafts.length, 0, "busy 时禁用");
  assert.equal(modalQueue.length, 0);
  page.setData({ busy: false, phase: "uploading" });
  await Promise.resolve(confirmSingle.call(page, { detail: { nameKey: "充电器", obsIds: [] } }));
  assert.equal(page.data.drafts.length, 0, "非 review 阶段禁用");

  // 无风险组:无弹窗直接生成聚合草稿
  page.setData({ phase: "review" });
  await Promise.resolve(confirmSingle.call(page, { detail: { nameKey: "充电器", obsIds: [] } }));
  assert.equal(modalQueue.length, 0, "风险为假时无弹窗");
  assert.equal(page.data.drafts.length, 1);
  const d = page.data.drafts[0];
  assert.deepEqual(d.observationIds, ["obs-single-0", "obs-single-1", "obs-single-2"], "整组未归属观察,扫描序无重复");
  assert.equal(d.name, "充电器", "name=组 label");
  assert.equal(d.locationText, "书房 · 右侧抽屉", "locationText=batchLocation");
  assert.equal(d.checked, true);
  assert.ok(d.draftKey.length > 0 && d.operationId.length > 0);
  // 组态推导切换 + 统计刷新
  assert.equal(page.data.observationGroups[0].state, "single");
  assert.equal(page.data.observationGroups[0].stateText, "已按 1 件确认 → 充电器");
  assert.equal(page.data.sceneStats.topLineText, "AI 线索 3 条,已全部确认 1 件");
});

test("SGP-SINGLE-RISK:同帧同名两条 → 组标「可能有多件」;先弹冻结 modal,取消零变更,确认才生成(§2.1/§3.1)", async () => {
  resetStubs();
  const observations = [
    obs("充电器", { obsId: "obs-risk-a", frameIndex: 2, timeMs: 3000, box: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } }),
    obs("充电器", { obsId: "obs-risk-b", frameIndex: 2, timeMs: 3000, box: { x1: 0.5, y1: 0.5, x2: 0.6, y2: 0.6 } }),
  ];
  const page = videoScanPage();
  page.setData({ phase: "review", observations, drafts: [], batchLocation: "书房" });
  page.renderObservations();
  // 不被静默合成 1 件:组标风险、态为待确认、零草稿
  assert.equal(page.data.observationGroups[0].sameFrameRisk, true, "同帧同名两条 → 组标「可能有多件」");
  assert.equal(page.data.observationGroups[0].state, "pending", "绝不自动合并");
  assert.equal(page.data.drafts.length, 0);

  const confirmSingle = mustPageMethod(page, "onGroupConfirmSingle");
  // 首次点击:弹二次确认;取消 → 无任何变更
  let p = Promise.resolve(confirmSingle.call(page, { detail: { nameKey: "充电器", obsIds: [] } }));
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(modalQueue.length, 1, "风险组「就 1 件」必须先过二次确认");
  assert.equal(modalQueue[0].title, "可能有多件");
  assert.equal(
    modalQueue[0].content,
    "这一组在第 0:03 的同一帧里出现了两条同名线索,可能是两件同名物品。确定只有 1 件吗?",
    "modal 内容=§2.1 冻结串(代表帧时间 " + videoTarget.videoTimeText(3000) + ")",
  );
  modalQueue[0].success({ confirm: false });
  await p;
  assert.equal(page.data.drafts.length, 0, "取消 → 无任何变更");
  assert.equal(page.data.observationGroups[0].state, "pending");

  // 再次点击并确认 → 生成聚合草稿
  p = Promise.resolve(confirmSingle.call(page, { detail: { nameKey: "充电器", obsIds: [] } }));
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(modalQueue.length, 2);
  modalQueue[1].success({ confirm: true });
  await p;
  assert.equal(page.data.drafts.length, 1, "二次确认后才可「就 1 件」");
  assert.deepEqual(page.data.drafts[0].observationIds, ["obs-risk-a", "obs-risk-b"]);
  assert.equal(page.data.observationGroups[0].state, "single");
});

test("SGP-SINGLE-D1:D1 页同语义;位置=进入位置路径文本并补 nodeId(§2.1/§9.5)", async () => {
  resetStubs();
  const observations = crossFrameObs("充电器", 3, "d1single");
  const page = locScanPage();
  page.setData({ phase: "review", mode: "scan", nodeId: "lc_shelf", locationPathText: "书房 / 书柜", observations, drafts: [] });
  page.renderObservations();
  const confirmSingle = mustPageMethod(page, "onGroupConfirmSingle");
  await Promise.resolve(confirmSingle.call(page, { detail: { nameKey: "充电器", obsIds: [] } }));
  assert.equal(modalQueue.length, 0, "跨帧无风险,无弹窗");
  assert.equal(page.data.drafts.length, 1);
  const d = page.data.drafts[0];
  assert.deepEqual(d.observationIds, ["obs-d1single-0", "obs-d1single-1", "obs-d1single-2"]);
  assert.equal(d.locationText, "书房 / 书柜", "locationText=进入位置路径文本");
  assert.equal(d.nodeId, "lc_shelf", "按 onGenerateDraftsTap 同款补 nodeId");
  assert.equal(d.checked, true);
  assert.equal(page.data.observationGroups[0].state, "single");
  assert.equal(page.data.sceneStats.topLineText, "AI 线索 3 条,已全部确认 1 件");
});

test("SGP-SINGLE-RISK-D1:D1 页风险组弹同一冻结 modal(与 B 页单一来源,单边漂移即红)(§2.1)", async () => {
  resetStubs();
  // 修订反例(PR #105 review 5626920410):重复发生在旧帧(frameIndex 2/0:03),
  // 另有一条更新观察使代表帧=0:07——弹窗必须指向重复帧(0:03)而非代表帧
  const observations = [
    obs("充电器", { obsId: "obs-d1risk-a", frameIndex: 2, timeMs: 3000, box: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } }),
    obs("充电器", { obsId: "obs-d1risk-b", frameIndex: 2, timeMs: 3000, box: { x1: 0.5, y1: 0.5, x2: 0.6, y2: 0.6 } }),
    obs("充电器", { obsId: "obs-d1risk-c", frameIndex: 5, timeMs: 7500 }),
  ];
  const page = locScanPage();
  page.setData({ phase: "review", mode: "scan", nodeId: "lc_shelf", locationPathText: "书房 / 书柜", observations, drafts: [] });
  page.renderObservations();
  assert.equal(page.data.observationGroups[0].sameFrameRisk, true);
  assert.equal(page.data.observationGroups[0].repFrame.timeText, videoTarget.videoTimeText(7500), "代表帧=新帧(与重复帧不同帧)");

  const confirmSingle = mustPageMethod(page, "onGroupConfirmSingle");
  const p = Promise.resolve(confirmSingle.call(page, { detail: { nameKey: "充电器", obsIds: [] } }));
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(modalQueue.length, 1, "D1 风险组「就 1 件」同样先过二次确认");
  // 四要素与 §2.1 冻结串逐字相等(时间=重复所在帧 0:03,不是代表帧 0:07)
  assert.deepEqual(
    { title: modalQueue[0].title, content: modalQueue[0].content, confirmText: modalQueue[0].confirmText, cancelText: modalQueue[0].cancelText },
    {
      title: "可能有多件",
      content: "这一组在第 0:03 的同一帧里出现了两条同名线索,可能是两件同名物品。确定只有 1 件吗?",
      confirmText: "就1件",
      cancelText: "再看看",
    },
    "D1 页 modal 文案=§2.1 冻结串(经 scene-groups.sameFrameRiskModalCopy 单一来源;时间=重复帧,§2.1 修订)",
  );
  assert.equal(modalQueue[0].content.indexOf(videoTarget.videoTimeText(7500)), -1, "弹窗绝不指向代表帧(新帧)时间");
  modalQueue[0].success({ confirm: false });
  await p;
  assert.equal(page.data.drafts.length, 0, "取消 → 无任何变更");
});

test("SGP-DRAFT-HIGHLIGHT-WARN:9 条确认后组卡警示消失、草稿卡接续同一冻结警示;两页 wxml 均渲染(§2.1)", async () => {
  resetStubs();
  // 两页 wxml 均挂草稿卡警示行(复审发现 1:此前仅组卡警示,确认后预警中断,保存才被门拦截)
  assert.ok(
    read("video-scan", "video-scan.wxml").indexOf("d.highlightWarning") !== -1,
    "video-scan 草稿卡应渲染 highlightWarning 警示行",
  );
  assert.ok(
    read("location-video-scan", "location-video-scan.wxml").indexOf("item.highlightWarning") !== -1,
    "location-video-scan 草稿卡应渲染 highlightWarning 警示行",
  );

  const WARN = "线索 9 条,单件最多 8 条高亮,保存前需减到 ≤8";
  const mk9 = function (prefix) {
    const out = [];
    for (let i = 0; i < 9; i++) out.push(obs("胶带", { obsId: "obs-" + prefix + "-" + i, frameIndex: i, timeMs: i * 1500 }));
    return out;
  };

  // B 页:确认前组卡警示 → 「就 1 件」→ 组卡警示随剩余数清零,草稿卡接续警示
  const vs = videoScanPage();
  vs.setData({ phase: "review", observations: mk9("bwarn"), drafts: [], batchLocation: "书房" });
  vs.renderObservations();
  assert.equal(vs.data.observationGroups[0].highlightWarning, WARN, "确认前组卡警示");
  await Promise.resolve(mustPageMethod(vs, "onGroupConfirmSingle").call(vs, { detail: { nameKey: "胶带", obsIds: [] } }));
  assert.equal(vs.data.drafts.length, 1);
  assert.equal(vs.data.observationGroups[0].highlightWarning, "", "整组归属后组卡警示消失(剩余 0)");
  assert.equal(vs.data.drafts[0].observationIds.length, 9, "绝不静默截断,9 条线索全量进草稿");
  assert.equal(vs.data.draftViews[0].highlightWarning, WARN, "草稿卡警示接续,保存前预警不中断");
  assert.equal(vs.data.draftViews[0].observationCount, 9);

  // D1 页同款
  const ls = locScanPage();
  ls.setData({ phase: "review", mode: "scan", nodeId: "lc_shelf", locationPathText: "书房 / 书柜", observations: mk9("d1warn"), drafts: [] });
  ls.renderObservations();
  await Promise.resolve(mustPageMethod(ls, "onGroupConfirmSingle").call(ls, { detail: { nameKey: "胶带", obsIds: [] } }));
  assert.equal(ls.data.drafts.length, 1);
  assert.equal(ls.data.observationGroups[0].highlightWarning, "");
  assert.equal(ls.data.draftViews[0].highlightWarning, WARN, "D1 草稿卡同一冻结警示(两入口一致)");

  // ≤8 的草稿与手动补件(零线索)不得警示
  const page = videoScanPage();
  page.setData({
    phase: "review",
    observations: crossFrameObs("电池", 2, "bwarn8"),
    drafts: [
      { draftKey: "k8", observationIds: ["obs-bwarn8-0"], manualHighlights: [], name: "电池", target: "new", operationId: "op8", itemId: "", locationText: "书房", note: "", checked: true },
      { draftKey: "km", observationIds: [], manualHighlights: [{ start_ms: 0, end_ms: 900, box: null, frame_ms: 0 }], name: "手补", target: "new", operationId: "opm", itemId: "", locationText: "书房", note: "", checked: true },
    ],
    batchLocation: "书房",
  });
  page.renderDrafts();
  assert.equal(page.data.draftViews[0].highlightWarning, "", "≤8 条线索的草稿不警示");
  assert.equal(page.data.draftViews[1].highlightWarning, "", "手动补件(零线索)不警示");
});

test("SGP-DRAFT-RENAME-REFRESH:改草稿名后组卡「已用于:{草稿名}」实时刷新,两页一致(复审发现 2)", () => {
  resetStubs();
  const mkDraft = function (key, obsId, name) {
    return { draftKey: key, observationIds: [obsId], manualHighlights: [], name, target: "new", operationId: "op-" + key, itemId: "", locationText: "书房", note: "", checked: true };
  };

  const vs = videoScanPage();
  vs.setData({ phase: "review", observations: crossFrameObs("电池", 2, "rn-b"), drafts: [mkDraft("kb", "obs-rn-b-0", "旧名")], batchLocation: "书房" });
  vs.renderObservations();
  assert.equal(vs.data.observationGroups[0].observations[0].claimText, "已用于:旧名");
  vs.onDraftNameInput({ currentTarget: { dataset: { index: 0 } }, detail: { value: "新名" } });
  assert.equal(vs.data.drafts[0].name, "新名");
  assert.equal(vs.data.observationGroups[0].observations[0].claimText, "已用于:新名", "B 页改名后组卡归属标签同步(此前陈旧到下一次重渲)");

  const ls = locScanPage();
  ls.setData({ phase: "review", mode: "scan", nodeId: "lc_shelf", locationPathText: "书房 / 书柜", observations: crossFrameObs("电池", 2, "rn-d"), drafts: [Object.assign(mkDraft("kd", "obs-rn-d-0", "旧名"), { nodeId: "lc_shelf" })] });
  ls.renderObservations();
  ls.onDraftNameInput({ currentTarget: { dataset: { index: 0 } }, detail: { value: "新名" } });
  assert.equal(ls.data.observationGroups[0].observations[0].claimText, "已用于:新名", "D1 页同语义(既有行为,钉住防回归)");
});

/* ---------------- C-3 有多件 / 逐条生成 / 暂不确定 ---------------- */

test("SGP-MULTI-FLOW:有多件不产生草稿;组内勾选 2 条 generatePerObs → 2 独立草稿(§2.2/§7)", () => {
  resetStubs();
  const observations = crossFrameObs("充电器", 3, "multi");
  const page = videoScanPage();
  page.setData({ phase: "review", observations, drafts: [], batchLocation: "书房" });
  page.renderObservations();

  mustPageMethod(page, "onGroupConfirmMulti").call(page, { detail: { nameKey: "充电器" } });
  assert.equal(page.data.drafts.length, 0, "「有多件或需拆开」是交互态,不产生任何草稿");
  assert.equal(page.data.observations.length, 3, "观察不动");
  assert.deepEqual(page.data.observationGroups[0].observations.map(function (r) { return r.obsId; })[0], "obs-multi-0");

  // 组内勾选 2 条(同名)→ 各成一件:mergeSameName:false 语义
  page.onGenerateDraftsTap({ detail: { nameKey: "充电器", obsIds: ["obs-multi-0", "obs-multi-2"] } });
  assert.equal(page.data.drafts.length, 2, "两条线索各成一件,同名不合并");
  assert.deepEqual(page.data.drafts[0].observationIds, ["obs-multi-0"]);
  assert.deepEqual(page.data.drafts[1].observationIds, ["obs-multi-2"]);
  assert.notEqual(page.data.drafts[0].draftKey, page.data.drafts[1].draftKey);
  assert.equal(page.data.drafts[0].name, "充电器");
  assert.equal(page.data.drafts[1].name, "充电器");
  assert.equal(page.data.drafts[0].locationText, "书房");
  // 归属推导:组转部分归属待确认,剩 1 条
  assert.equal(page.data.observationGroups[0].state, "pending");
  assert.equal(page.data.observationGroups[0].remainingCount, 1);
  assert.equal(page.data.sceneStats.topLineText, "AI 线索 3 条 → 1 组待确认,已确认 2 件");
});

test("SGP-DEFER:暂不确定 → 零数据变更(§2.3)", () => {
  resetStubs();
  const observations = crossFrameObs("电池", 4, "defer");
  const page = videoScanPage();
  page.setData({ phase: "review", observations, drafts: [], batchLocation: "书房" });
  page.renderObservations();
  const before = JSON.stringify(page.data);
  mustPageMethod(page, "onGroupDefer").call(page, { detail: { nameKey: "电池" } });
  assert.equal(JSON.stringify(page.data), before, "「暂不确定」无任何状态写入");
  assert.equal(page.data.observationGroups[0].state, "pending", "组保留在待确认列表与统计里");
  assert.equal(page.data.sceneStats.pendingGroupCount, 1);
});

/* ---------------- C-4 归属唯一阻塞门 ---------------- */

test("SGP-CLAIM-BLOCK:勾选已归属观察 → toast 阻塞、不生成;无冲突才生成(§2.4)", () => {
  resetStubs();
  const observations = crossFrameObs("充电器", 3, "claim");
  const page = videoScanPage();
  page.setData({
    phase: "review",
    observations,
    drafts: [{
      draftKey: "k-old", observationIds: ["obs-claim-1"], manualHighlights: [],
      name: "第一件充电器", target: "new", operationId: "op-old", itemId: "",
      locationText: "书房", note: "", checked: true,
    }],
    batchLocation: "书房",
  });
  page.renderObservations();

  // 勾选含已归属观察(obs-claim-1 是会话第 2 条线索):toast 阻塞,不生成
  page.onGenerateDraftsTap({ detail: { nameKey: "充电器", obsIds: ["obs-claim-1", "obs-claim-2"] } });
  assert.equal(page.data.drafts.length, 1, "阻塞时不生成新草稿");
  assert.equal(toasts.length, 1);
  assert.equal(
    toasts[0].title,
    "第 2 条线索已用于「第一件充电器」,先移除该草稿或拆分后再操作",
    "toast=§2.4 冻结串(序号按观察数组 1 起)",
  );

  // 无冲突:生成且旧草稿不动,归属不变式保持
  page.onGenerateDraftsTap({ detail: { nameKey: "充电器", obsIds: ["obs-claim-0", "obs-claim-2"] } });
  assert.equal(page.data.drafts.length, 3, "2 条新草稿 + 1 条既有");
  const claimed = {};
  page.data.drafts.forEach(function (d) {
    d.observationIds.forEach(function (id) {
      assert.equal(claimed[id], undefined, "obsId " + id + " 至多归属一个草稿");
      claimed[id] = d.draftKey;
    });
  });
  assert.deepEqual(Object.keys(claimed).sort(), ["obs-claim-0", "obs-claim-1", "obs-claim-2"], "无丢失无重复");
});

/* ---------------- C-5 撤销 / 拆分 / 再确认(观察可找回) ---------------- */

test("SGP-UNDO-SPLIT:整组确认排除已归属;移除回 pending;拆分转 multi 且 obsId 守恒(§2.1/§2.4)", async () => {
  resetStubs();
  const observations = crossFrameObs("充电器", 4, "undo");
  const ids = observations.map(function (o) { return o.obsId; });
  const page = videoScanPage();
  page.setData({
    phase: "review",
    observations,
    drafts: [{
      draftKey: "k-part", observationIds: [ids[0], ids[1]], manualHighlights: [],
      name: "已确认的一件", target: "new", operationId: "op-part", itemId: "",
      locationText: "书房", note: "", checked: true,
    }],
    batchLocation: "书房",
  });
  page.renderObservations();

  // 整组确认:确认集=剩余未归属(已归属两条被排除)
  const confirmSingle = mustPageMethod(page, "onGroupConfirmSingle");
  await Promise.resolve(confirmSingle.call(page, { detail: { nameKey: "充电器", obsIds: [] } }));
  assert.equal(page.data.drafts.length, 2);
  assert.deepEqual(page.data.drafts[1].observationIds, [ids[2], ids[3]], "组卡勾选集天然排除已归属观察");

  // 撤销路径=既有「移除」:观察回到未归属,组回到待确认
  page.onDraftRemoveTap({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.data.drafts.length, 1);
  assert.equal(page.data.observationGroups[0].state, "pending");
  assert.equal(page.data.observationGroups[0].remainingCount, 2);
  page.onDraftRemoveTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.drafts.length, 0);
  assert.equal(page.data.observationGroups[0].remainingCount, 4, "原始观察可找回,无丢失");

  // 再确认 1 件后拆分:obsId 集合与拆前相等,归属唯一保持
  await Promise.resolve(confirmSingle.call(page, { detail: { nameKey: "充电器", obsIds: [] } }));
  assert.equal(page.data.drafts.length, 1);
  assert.deepEqual(page.data.drafts[0].observationIds, ids);
  page.onDraftSplitTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.drafts.length, 4, "一件拆四件");
  const seen = {};
  page.data.drafts.forEach(function (d) {
    assert.equal(d.observationIds.length, 1);
    assert.equal(seen[d.observationIds[0]], undefined, "拆分后无重复归属");
    seen[d.observationIds[0]] = d.draftKey;
  });
  assert.deepEqual(Object.keys(seen).sort(), ids.slice().sort(), "拆分后 observationIds 集合与拆前相等");
  assert.equal(page.data.observationGroups[0].state, "multi");
  assert.equal(page.data.observationGroups[0].stateText, "已按 4 件确认");
});

/* ---------------- C-6 旧开关移除与既有入口零回归 ---------------- */

test("SGP-LEGACY-REMOVED:mergeSameName 开关与全局生成按钮移除;注册表不破;合并/补件零回归(§7)", () => {
  resetStubs();
  for (const dir of ["video-scan", "location-video-scan"]) {
    const wxml = read(dir, dir + ".wxml");
    assert.equal(wxml.indexOf("mergeSameName"), -1, dir + " 旧同名开关移除");
    assert.equal(wxml.indexOf("onMergeSameNameChange"), -1, dir + " 旧处理器移除");
    assert.equal(wxml.indexOf("<switch"), -1, dir + " 不再有 switch");
    assert.equal(wxml.indexOf('bindtap="onGenerateDraftsTap"'), -1, dir + " 全局生成按钮移除(收敛进组卡)");
    assert.equal(wxml.indexOf('bindtap="onObservationToggle"'), -1, dir + " 全局跨组勾选行移除");
  }
  assert.equal(read("video-scan", "video-scan.wxml").indexOf("把勾选线索生成待确认物品"), -1, "B 页全局生成按钮文案移除");
  assert.equal(read("location-video-scan", "location-video-scan.wxml").indexOf("生成草稿"), -1, "D1 页全局生成按钮移除");

  // 注册表:onMergeSameNameChange 移除;既有入口与新增接线齐备
  assert.equal(typeof pages.videoScan.onMergeSameNameChange, "undefined");
  assert.equal(typeof pages.locScan.onMergeSameNameChange, "undefined");
  for (const name of [
    "renderObservations", "renderDrafts", "onObservationToggle", "onGenerateDraftsTap",
    "onGroupConfirmSingle", "onGroupConfirmMulti", "onGroupDefer",
    "onAddManualDraftTap", "onDraftSplitTap", "onMergeDraftsTap", "onDraftRemoveTap",
  ]) {
    assert.equal(typeof pages.videoScan[name], "function", "video-scan." + name);
    assert.equal(typeof pages.locScan[name], "function", "location-video-scan." + name);
  }
  for (const name of ["onDraftTargetTap", "onObsImageTap", "onDraftMergeSelectTap"]) {
    assert.equal(typeof pages.videoScan[name], "function", "video-scan." + name);
  }
  for (const name of ["onDraftMatchTap", "onSuggestionTap", "onDraftNodeTap", "onDraftTargetResetTap"]) {
    assert.equal(typeof pages.locScan[name], "function", "location-video-scan." + name);
  }

  // 既有行为零回归:手动补一件;选择合并两件(同名)为一件
  const page = videoScanPage();
  page.setData({ phase: "review", videoDurationMs: 9000, observations: crossFrameObs("电池", 2, "legacy"), drafts: [], batchLocation: "书房" });
  page.renderObservations();
  page.onAddManualDraftTap();
  assert.equal(page.data.drafts.length, 1, "＋ 补一件仍可用");
  assert.equal(page.data.drafts[0].manualHighlights.length, 1);

  page.setData({
    drafts: [
      { draftKey: "k1", observationIds: ["obs-legacy-0"], manualHighlights: [], name: "电池", target: "new", operationId: "op1", itemId: "", locationText: "书房", note: "", checked: true },
      { draftKey: "k2", observationIds: ["obs-legacy-1"], manualHighlights: [], name: "电池", target: "new", operationId: "op2", itemId: "", locationText: "书房", note: "", checked: true },
    ],
    mergeSelectedKeys: [],
  });
  page.renderDrafts();
  page.onDraftMergeSelectTap({ currentTarget: { dataset: { key: "k1" } } });
  page.onDraftMergeSelectTap({ currentTarget: { dataset: { key: "k2" } } });
  assert.deepEqual(page.data.mergeSelectedKeys, ["k1", "k2"]);
  page.onMergeDraftsTap();
  assert.equal(page.data.drafts.length, 1, "合并选中的新建物品草稿仍可用");
  assert.deepEqual(page.data.drafts[0].observationIds, ["obs-legacy-0", "obs-legacy-1"]);
});

/* ---------------- C-7 D1 合并选择死按钮修复(§5.4) ---------------- */

test("SGP-MERGE-FIX:D1「选去合并」行带 data-key,点选后 mergeSelectedKeys 更新(§5.4)", () => {
  const wxml = read("location-video-scan", "location-video-scan.wxml");
  const line = wxml.split("\n").filter(function (l) { return l.indexOf("onDraftMergeSelectTap") !== -1; })[0];
  assert.ok(line !== undefined, "D1 应保留「选去合并」入口");
  assert.ok(
    line.indexOf('data-key="{{ item.draftKey }}"') !== -1,
    "「选去合并」必须以 data-key 绑 draftKey(处理器读 dataset.key;data-index 是死按钮,§5.4):" + line,
  );

  // 行为半边(当前已正确):处理器按 dataset.key 更新选择集
  resetStubs();
  const page = locScanPage();
  page.setData({
    phase: "review", mode: "scan", nodeId: "lc_shelf",
    drafts: [
      { draftKey: "k1", observationIds: [], manualHighlights: [{ start_ms: 0, end_ms: 900, box: null, frame_ms: 0 }], name: "甲", target: "new", operationId: "op1", itemId: "", locationText: "书房 / 书柜", note: "", checked: true },
      { draftKey: "k2", observationIds: [], manualHighlights: [{ start_ms: 1000, end_ms: 1900, box: null, frame_ms: 1000 }], name: "乙", target: "new", operationId: "op2", itemId: "", locationText: "书房 / 书柜", note: "", checked: true },
    ],
    mergeSelectedKeys: [],
  });
  page.renderDrafts();
  page.onDraftMergeSelectTap({ currentTarget: { dataset: { key: "k1" } } });
  assert.deepEqual(page.data.mergeSelectedKeys, ["k1"]);
  page.onDraftMergeSelectTap({ currentTarget: { dataset: { key: "k1" } } });
  assert.deepEqual(page.data.mergeSelectedKeys, [], "再点取消选择");
});

/* ---------------- C-7b D1 合并 nodeId 一致门(架构终裁,PR #105 review 5626920410) ---------------- */

function locMergeDraft(key, obsId, nodeId, pathText) {
  const d = {
    draftKey: key, observationIds: obsId ? [obsId] : [], manualHighlights: [], name: "电池",
    target: "new", operationId: "op-" + key, itemId: "", locationText: pathText, note: "", checked: true,
  };
  if (nodeId !== undefined) d.nodeId = nodeId;
  return d;
}

test("SGP-MERGE-NODE-ID:同 nodeId 合并保留 nodeId 且可构建合法提交载荷;不一致(含默认+子位置混合)拒绝且草稿不变(架构终裁,PR #105 review 5626920410)", () => {
  resetStubs();
  const paths = {
    lc_shelf: ["书房", "书柜"],
    lc_layer: ["书房", "书柜", "第一层"],
  };
  const observations = crossFrameObs("电池", 2, "mnode");

  // ① 两件草稿同 nodeId(子位置)→ 合并保留 nodeId,提交载荷构建通过
  let page = locScanPage();
  page.setData({
    phase: "review", mode: "scan", nodeId: "lc_shelf", observations,
    drafts: [
      locMergeDraft("k1", "obs-mnode-0", "lc_layer", "书房 / 书柜 / 第一层"),
      locMergeDraft("k2", "obs-mnode-1", "lc_layer", "书房 / 书柜 / 第一层"),
    ],
    mergeSelectedKeys: ["k1", "k2"],
  });
  page.pathsByNodeId = paths;
  page.renderDrafts();
  mustPageMethod(page, "onMergeDraftsTap").call(page);
  assert.equal(toasts.length, 0, "目标位置一致 → 合并不被拒");
  assert.equal(page.data.drafts.length, 1, "两件并一件");
  assert.equal(page.data.drafts[0].nodeId, "lc_layer", "合并结果保留一致的 nodeId(此前 mergeSceneDrafts 返回普通草稿丢 nodeId,保存被位置路径校验拦截)");
  assert.deepEqual(page.data.drafts[0].observationIds, ["obs-mnode-0", "obs-mnode-1"]);
  assert.deepEqual(page.data.mergeSelectedKeys, [], "合并后清空选择集");
  let built = locationScanUtil.buildLocationScanCommitItems(
    page.data.drafts, observations, 9000,
    { locationId: "lc_shelf", pathsByNodeId: paths },
    "scan-mnode-1",
  );
  assert.equal(built.ok, true, built.ok === false ? built.message : "");
  assert.equal(built.items[0].node_id, "lc_layer", "提交载荷携带子位置 nodeId");
  assert.equal(built.items[0].location_text, "书房 / 书柜 / 第一层", "location_text 与目标节点路径文本逐字一致");

  // ② nodeId 不一致:一件子位置 + 一件显式默认位置(进入位置)→ 拒绝且草稿不变
  page = locScanPage();
  page.setData({
    phase: "review", mode: "scan", nodeId: "lc_shelf", observations,
    drafts: [
      locMergeDraft("k1", "obs-mnode-0", "lc_layer", "书房 / 书柜 / 第一层"),
      locMergeDraft("k2", "obs-mnode-1", "lc_shelf", "书房 / 书柜"),
    ],
    mergeSelectedKeys: ["k1", "k2"],
  });
  page.renderDrafts();
  page.onMergeDraftsTap();
  assert.equal(page.data.drafts.length, 2, "目标位置不一致 → 拒绝合并,草稿不变");
  assert.equal(page.data.drafts[0].draftKey, "k1");
  assert.equal(page.data.drafts[1].draftKey, "k2");
  assert.deepEqual(page.data.mergeSelectedKeys, ["k1", "k2"], "选择集保持,便于统一位置后直接重试");
  assert.equal(toasts.length, 1, "toast 提示先统一目标子位置");
  assert.equal(toasts[0].title, "所选草稿的目标位置不一致,请先统一子位置再合并");
  assert.equal(toasts[0].title.indexOf("找到"), -1, "不得使用「找到 N 件」类统计措辞(§4)");

  // ②b 混合情形:一件默认位置(nodeId 缺省)+ 一件子位置 → 同样拒绝
  page = locScanPage();
  page.setData({
    phase: "review", mode: "scan", nodeId: "lc_shelf", observations,
    drafts: [
      locMergeDraft("k1", "obs-mnode-0", "lc_layer", "书房 / 书柜 / 第一层"),
      locMergeDraft("k2", "obs-mnode-1", undefined, "书房 / 书柜"),
    ],
    mergeSelectedKeys: ["k1", "k2"],
  });
  page.renderDrafts();
  page.onMergeDraftsTap();
  assert.equal(page.data.drafts.length, 2, "一件默认位置+一件子位置 → 拒绝合并");
  assert.equal(toasts.length, 2, "同样以统一子位置 toast 阻塞");

  // ③ 两件均为默认位置(nodeId 全部缺省=进入位置)→ 允许合并,结果 nodeId 取该一致目标
  page = locScanPage();
  page.setData({
    phase: "review", mode: "scan", nodeId: "lc_shelf", observations,
    drafts: [
      locMergeDraft("k1", "obs-mnode-0", undefined, "书房 / 书柜"),
      locMergeDraft("k2", "obs-mnode-1", undefined, "书房 / 书柜"),
    ],
    mergeSelectedKeys: ["k1", "k2"],
  });
  page.renderDrafts();
  page.onMergeDraftsTap();
  assert.equal(page.data.drafts.length, 1, "全部默认位置=目标一致,允许合并");
  assert.equal(page.data.drafts[0].nodeId, "lc_shelf", "结果 nodeId 取一致目标(缺省=默认进入位置)");
  built = locationScanUtil.buildLocationScanCommitItems(
    page.data.drafts, observations, 9000,
    { locationId: "lc_shelf", pathsByNodeId: paths },
    "scan-mnode-2",
  );
  assert.equal(built.ok, true, built.ok === false ? built.message : "");
});

/* ---------------- C-8 会话恢复(零新增 storage 字段) ---------------- */

function sceneSessionFixture() {
  const aGroup = [
    obs("充电器", { obsId: "obs-r-a1", frameIndex: 0, timeMs: 0 }),
    obs("充电器", { obsId: "obs-r-a2", frameIndex: 1, timeMs: 1500 }),
    obs("充电器", { obsId: "obs-r-a3", frameIndex: 1, timeMs: 1500, box: { x1: 0.5, y1: 0.5, x2: 0.6, y2: 0.6 } }),
    obs("充电器", { obsId: "obs-r-a4", frameIndex: 3, timeMs: 4500 }),
  ];
  const bGroup = crossFrameObs("电池", 2, "r-b");
  return {
    observations: aGroup.concat(bGroup),
    drafts: [{
      draftKey: "old-d1", observationIds: ["obs-r-a1", "obs-r-a4"], manualHighlights: [],
      name: "旧会话确认的一件", target: "new", operationId: "op-old-1", itemId: "",
      locationText: "书房", note: "", checked: true,
    }],
  };
}

test("SGP-SESSION-RESTORE:B 页恢复 R0 前格式会话;组/观察/归属找回;会话字段集与旧版完全一致(§6)", () => {
  resetStubs();
  const fixture = sceneSessionFixture();
  // R0 之前就有的 version:1 格式(StoredSceneSession,video-scan.ts:96-111),零新键
  storage[VIDEO_SESSION_KEY] = {
    version: 1,
    createdAt: Date.now(),
    scopeId: "default",
    phase: "review",
    sceneId: "scene-restore-1",
    videoPath: "/tmp/restore.mp4",
    durationMs: 9000,
    width: 640,
    height: 480,
    batchLocation: "书房",
    observations: fixture.observations,
    drafts: fixture.drafts,
    pendingUpload: null,
    frozenItems: [],
  };
  const page = videoScanPage();
  page.onLoad();
  assert.equal(page.data.phase, "review");
  assert.deepEqual(page.data.observations, fixture.observations, "原始观察全量找回");
  assert.deepEqual(page.data.drafts, fixture.drafts, "旧草稿归属同样参与组态推导");
  // 组态按 observations+drafts 推导:A 组部分归属(剩 2)+同帧风险;B 组待确认
  assert.equal(page.data.observationGroups.length, 2);
  assert.equal(page.data.observationGroups[0].state, "pending");
  assert.equal(page.data.observationGroups[0].remainingCount, 2);
  assert.equal(page.data.observationGroups[0].sameFrameRisk, true, "同帧风险由观察推导,不依赖持久化");
  assert.equal(page.data.observationGroups[1].state, "pending");
  assert.equal(page.data.observationGroups[1].remainingCount, 2);
  assert.ok(page.data.sceneStats, "统计由推导得出");
  assert.equal(page.data.sceneStats.topLineText, "AI 线索 6 条 → 2 组待确认,已确认 1 件");

  // 保存会话:字段集与旧版完全一致(零新增 storage 字段),version 维持 1
  page.saveSession();
  const stored = storage[VIDEO_SESSION_KEY];
  assert.ok(stored, "saveSession 应写回会话");
  assert.equal(stored.version, 1);
  assert.deepEqual(Object.keys(stored).sort(), VIDEO_SESSION_FIELDS, "会话对象字段集与旧版完全一致,无新键");
});

test("SGP-SESSION-RESTORE-D1:D1 页恢复同格式会话;字段集不变(§6)", async () => {
  resetStubs();
  itemsRouter(function (event) {
    assert.equal(event.action, "locationScanContext");
    return {
      ok: true,
      subtree: [
        { location_id: "lc_shelf", name: "书柜", path: ["书房", "书柜"], parent_id: "lc_study" },
        { location_id: "lc_layer", name: "第一层", path: ["书房", "书柜", "第一层"], parent_id: "lc_shelf" },
      ],
      subtree_items: [],
      household_items: [],
      household_truncated: false,
    };
  });
  const fixture = sceneSessionFixture();
  const sessionKey = locationScanUtil.locationScanSessionKey("default", "lc_shelf");
  storage[sessionKey] = {
    version: 1,
    createdAt: Date.now(),
    scopeId: "default",
    nodeId: "lc_shelf",
    phase: "review",
    scanId: "scan-restore-1",
    videoPath: "/tmp/restore-d1.mp4",
    durationMs: 9000,
    width: 640,
    height: 480,
    observations: fixture.observations,
    drafts: fixture.drafts.map(function (d) { return Object.assign({}, d, { nodeId: "lc_shelf" }); }),
    pendingUpload: null,
    frozenItems: [],
  };
  const page = locScanPage();
  page.onLoad({ node_id: "lc_shelf" });
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(page.data.phase, "review");
  assert.equal(page.data.observations.length, 6, "观察找回");
  assert.equal(page.data.observationGroups.length, 2, "组由推导找回");
  assert.equal(page.data.observationGroups[0].remainingCount, 2, "旧草稿归属参与推导");
  assert.equal(page.data.sceneStats.topLineText, "AI 线索 6 条 → 2 组待确认,已确认 1 件");

  page.saveSession();
  const stored = storage[sessionKey];
  assert.ok(stored);
  assert.equal(stored.version, 1);
  assert.deepEqual(Object.keys(stored).sort(), LOC_SESSION_FIELDS, "D1 会话字段集与旧版完全一致,无新键");
});

/* ---------------- C-9 文案口径(三数分立/保存计数/禁混称) ---------------- */

test("SGP-COPY:两页无「找到」混称;保存计数=checked 数;顶部统计行与固定注为冻结串(§4)", () => {
  for (const dir of ["video-scan", "location-video-scan"]) {
    const wxml = read(dir, dir + ".wxml");
    assert.equal(wxml.indexOf("找到"), -1, dir + " 不得出现「找到 N 件」类混称");
    assert.ok(wxml.indexOf("组数不是物品件数;同名线索不会被自动合并") !== -1, dir + " 固定注(§4 冻结串)");
    assert.ok(wxml.indexOf("sceneStats.topLineText") !== -1, dir + " 顶部统计行绑定");
    assert.ok(wxml.indexOf("待确认物品(") !== -1, dir + " 草稿区标题现状保留");
  }
  const bWxml = read("video-scan", "video-scan.wxml");
  assert.equal(bWxml.indexOf("确认并保存 {{draftViews.length}} 件"), -1, "保存按钮不得再计入未勾选草稿");
  assert.ok(bWxml.indexOf("确认并保存") !== -1, "保存按钮文案保留");
  assert.ok(bWxml.indexOf("sceneStats.checkedDraftCount") !== -1, "保存按钮计数=checked 草稿数(X)");
  assert.ok(read("location-video-scan", "location-video-scan.wxml").indexOf("保存本次清点") !== -1, "D1 维持无计数文案");

  // 行为半边:X=checked 草稿数(1 勾选 + 1 未勾选 → 1)
  resetStubs();
  const observations = crossFrameObs("电池", 4, "copy");
  const page = videoScanPage();
  page.setData({
    phase: "review",
    observations,
    drafts: [
      { draftKey: "k1", observationIds: ["obs-copy-0"], manualHighlights: [], name: "电池", target: "new", operationId: "op1", itemId: "", locationText: "书房", note: "", checked: true },
      { draftKey: "k2", observationIds: ["obs-copy-1"], manualHighlights: [], name: "电池", target: "new", operationId: "op2", itemId: "", locationText: "书房", note: "", checked: false },
    ],
    batchLocation: "书房",
  });
  page.renderObservations();
  assert.ok(page.data.sceneStats, "统计随草稿实时推导");
  assert.equal(page.data.sceneStats.observationCount, 4, "N=线索数");
  assert.equal(page.data.sceneStats.pendingGroupCount, 1, "M=待确认组数(部分归属组仍待确认)");
  assert.equal(page.data.sceneStats.draftCount, 2, "N_d=草稿总数(未勾选也计入)");
  assert.equal(page.data.sceneStats.checkedDraftCount, 1, "X=checked 草稿数");
  assert.equal(page.data.sceneStats.topLineText, "AI 线索 4 条 → 1 组待确认,已确认 2 件");
});

/* ---------------- C-10 首页/D2/注册面零改动 ---------------- */

test("SGP-NONCHANGE:首页不接组卡;保留页面及个性化入口;location-scan 原语面不变(§7/§10)", () => {
  const indexWxml = read("index", "index.wxml");
  const indexTs = fs.readFileSync(path.join(ROOT, "miniprogram/pages/index/index.ts"), "utf8");
  for (const src of [indexWxml, indexTs]) {
    assert.equal(src.indexOf("scene-group-card"), -1, "首页不接组卡");
    assert.equal(src.indexOf("observationGroups"), -1, "首页不接触点组视图");
    assert.equal(src.indexOf("location-video-scan"), -1, "首页不得引用 D1 清点页");
    assert.equal(src.indexOf("拍视频清点"), -1, "首页不展示清点入口");
    assert.equal(src.indexOf("上次清点"), -1, "首页不展示清点摘要");
  }
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, "miniprogram/app.json"), "utf8"));
  // R0 基线页面必须全部仍在注册(超集断言,允许其它线如 #102 Q2 的 quantity-voice、
  // #107 个人资料页合法新增);R0 自身不新增页面 → 不得出现任何 R0 语义命名的页面。
  const r0Baseline = [
    "pages/index/index",
    "pages/confirm/confirm",
    "pages/photo/photo",
    "pages/item/item",
    "pages/video-scan/video-scan",
    "pages/locations/locations",
    "pages/location-video-scan/location-video-scan",
    "pages/locationScan/locationScan",
    "pages/family/family",
    "pages/join-family/join-family",
    "pages/reminders/reminders",
    "pages/diag-subscribe/diag-subscribe",
  ];
  for (const pg of r0Baseline) assert.ok(app.pages.includes(pg), "R0 基线页面仍注册:" + pg);
  for (const pg of app.pages) {
    assert.ok(!/scene-group|observation|group-card/i.test(pg), "R0 不新增页面:" + pg);
  }
  // D2 清点历史客户端原语面不变(零语义变化)
  assert.equal(typeof locationScanUtil.buildLocationScanCommitItems, "function");
  assert.equal(typeof locationScanUtil.locationScanSessionKey, "function");
  assert.equal(typeof locationScanUtil.subtreeOptionViews, "function");
  assert.equal(typeof locationScanUtil.lastScanSummaryText, "function");
  assert.equal(locationScanUtil.LOCATION_SCAN_SESSION_TTL_MS, 24 * 60 * 60 * 1000);
});
