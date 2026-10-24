"use strict";
/**
 * 视频确认流零隐私使用埋点——两页接线测试(先于实现;模式照
 * tests/scene-group-page.test.js:fs/path 加载编译产物 .js、全局 Page 桩驱动页面逻辑)。
 * 被测对象:npm run build:mp 产出的 video-scan.js 与 location-video-scan.js。
 *
 * 最小验收面(#85/#76 降本阶梯第 2 级):
 * - 保存成功(commitFrozenUpload done 分支)恰好发一次 kind="video_confirm_save" 的
 *   usageMetrics ping:counts 含 observations(线索总数)/groups(组数)/drafts(保存件数)
 *   + 会话四计数(merges/splits/removes/manualAdds),ms 为会话起点到保存成功的毫秒;
 * - abandon:onHide/onUnload 时会话有扫描结果(review/partial/failed)且未保存 → 一次
 *   kind="video_confirm_abandon";重复 onHide 不重复报;保存成功后不再 abandon;
 *   无扫描结果(observations=0)不报;uploading/committing 不报(提交仍在后台收敛);
 * - 计数器:合并/拆分/移除/手动补件四个既有 handler 处 +1,计数器逻辑在 utils
 *   (页面只调用,不复制);
 * - fire-and-forget:埋点失败绝不影响主流程(不 toast、不阻塞保存)。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const api = require(path.join(ROOT, "miniprogram/utils/api.js"));

/* ---------------- wx 桩(cloud.callFunction 捕获埋点) ---------------- */

let storage = {};
let modalQueue = [];
let toasts = [];
let cloudCalls = [];

globalThis.wx = {
  getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : ""),
  setStorageSync: (k, v) => { storage[k] = v; },
  removeStorageSync: (k) => { delete storage[k]; },
  showToast: (o) => { toasts.push(o); },
  showModal: (o) => { modalQueue.push(o); },
  showActionSheet: (o) => { if (o && typeof o.success === "function") o.success({ tapIndex: 0 }); },
  previewImage: () => {},
  navigateTo: () => {},
  navigateBack: (o) => { if (o && o.fail) o.fail(); },
  setNavigationBarTitle: () => {},
  getSystemInfoSync: () => ({ platform: "devtools" }),
  cloud: {
    callFunction: (o) => { cloudCalls.push(o); if (o && typeof o.fail === "function") return undefined; },
    uploadFile: (o) => { if (o && typeof o.success === "function") o.success({ fileID: "cloud://bucket/x.mp4" }); },
  },
};

function resetStubs() {
  storage = {};
  modalQueue = [];
  toasts = [];
  cloudCalls = [];
}

/* ---------------- 页面装载 ---------------- */

const pages = {};
globalThis.Page = function (options) { pages.__last = options; };
require(path.join(ROOT, "miniprogram/pages/video-scan/video-scan.js"));
pages.videoScan = pages.__last;
require(path.join(ROOT, "miniprogram/pages/location-video-scan/location-video-scan.js"));
pages.locScan = pages.__last;

const originalCallItems = api.callItemsApi;
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
    if (k === "data" || typeof options[k] === "function") return;
    const v = options[k];
    page[k] = Array.isArray(v) ? [] : (v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v)));
  });
  Object.keys(options)
    .filter(function (k) { return typeof options[k] === "function"; })
    .forEach(function (k) { page[k] = options[k]; });
  return page;
}

function videoScanPage() { return makePage(pages.videoScan); }
function locScanPage() { return makePage(pages.locScan); }

/** 观察工厂(与 utils/video-scene.ts 的 SceneObservation 同形) */
let obsSeq = 0;
function obs(nameText, o) {
  o = o || {};
  const frameIndex = o.frameIndex === undefined ? 0 : o.frameIndex;
  const timeMs = o.timeMs === undefined ? frameIndex * 1500 : o.timeMs;
  obsSeq += 1;
  return {
    obsId: o.obsId || "obs-ump-" + obsSeq,
    frameIndex,
    timeMs,
    windowStartMs: Math.max(0, timeMs - 750),
    windowEndMs: timeMs + 750,
    framePath: o.framePath || "/tmp/frame-" + frameIndex + ".jpg",
    frameWidth: 640,
    frameHeight: 480,
    name: nameText,
    qtyNote: "",
    confidence: "mid",
    box: "box" in o ? o.box : null,
  };
}

function draft(key, nameText, obsIds, extra) {
  return Object.assign({
    draftKey: key,
    observationIds: obsIds,
    manualHighlights: [],
    name: nameText,
    target: "new",
    operationId: "op-" + key,
    itemId: "",
    locationText: "书房",
    note: "",
    checked: true,
  }, extra || {});
}

function pendingFixture(frozenItems) {
  return {
    sceneId: "scene-ump-1",
    uploadTicket: "vt_ump_1",
    uploadPath: "video-evidence/hh/x.mp4",
    assetId: "va_ump_1",
    fileId: "cloud://bucket/x.mp4",
    receiptDone: true,
    expiresAt: "2026-10-25T00:00:00.000Z",
    durationMs: 9000,
    width: 640,
    height: 480,
    frozenItems: frozenItems || [],
    location: { location_id: "lc_shelf", scan_id: "scene-ump-1", path_snapshot: ["书房", "书柜"], text_snapshot: "书房 / 书柜" },
    candidateCount: 4,
  };
}

function commitRouter(items) {
  api.callItemsApi = function (event) {
    assert.equal(event.action, "videoSceneCommit");
    return Promise.resolve({
      ok: true,
      scene_id: "scene-ump-1",
      asset_id: "va_ump_1",
      ticket_state: "bound",
      results: items.map(function (it, i) { return { draft_key: it.draftKey || "k" + i, ok: true, item_id: "it_" + i }; }),
    });
  };
}

function lastPing() {
  assert.ok(cloudCalls.length > 0, "应发出 usageMetrics 埋点");
  const call = cloudCalls[cloudCalls.length - 1];
  assert.equal(call.name, "usageMetrics");
  return call.data;
}

/* ---------------- 计数器:四个既有 handler 处 +1(B 页) ---------------- */

test("UMP-COUNTERS-B:合并/拆分/移除/手动补件各 +1,保存在 ping 里全量携带(计数器在 utils,页面只调用)", async () => {
  resetStubs();
  const observations = [
    obs("电池", { obsId: "ump-b-1", frameIndex: 0 }),
    obs("电池", { obsId: "ump-b-2", frameIndex: 2 }),
    obs("充电器", { obsId: "ump-b-3", frameIndex: 4 }),
  ];
  const page = videoScanPage();
  page.setData({
    phase: "review",
    videoDurationMs: 9000,
    observations,
    drafts: [
      draft("kb1", "电池", ["ump-b-1", "ump-b-2"]),
      draft("kb2", "充电器", ["ump-b-3"]),
    ],
    mergeSelectedKeys: [],
    batchLocation: "书房",
  });
  page.renderObservations();
  assert.equal(page.data.observationGroups.length, 2, "两组:电池 + 充电器");

  // 手动补件 +1
  page.onAddManualDraftTap();
  assert.equal(page.data.drafts.length, 3);
  // 拆分(两线索草稿)+1
  page.onDraftSplitTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.drafts[0].observationIds.length, 1, "拆分生效(一件拆两件)");
  assert.equal(page.data.drafts[1].observationIds.length, 1);
  // 合并两件 +1
  const toastsBeforeMerge = toasts.length;
  page.onDraftMergeSelectTap({ currentTarget: { dataset: { key: page.data.drafts[0].draftKey } } });
  page.onDraftMergeSelectTap({ currentTarget: { dataset: { key: page.data.drafts[1].draftKey } } });
  const draftsBeforeMerge = page.data.drafts.length;
  page.onMergeDraftsTap();
  assert.equal(toasts.length, toastsBeforeMerge, "两件新建可合并,合并本身无阻塞 toast");
  assert.equal(page.data.drafts.length, draftsBeforeMerge - 1, "两件并一件");
  // 移除一件 +1
  page.onDraftRemoveTap({ currentTarget: { dataset: { index: page.data.drafts.length - 1 } } });

  // 保存成功:drive commitFrozenUpload 到 done
  const frozen = page.data.drafts;
  commitRouter(frozen);
  await page.commitFrozenUpload(pendingFixture(frozen));
  assert.equal(page.data.phase, "done");
  assert.equal(cloudCalls.length, 1, "保存成功恰好发一次 save ping");
  const ping = lastPing();
  assert.equal(ping.kind, "video_confirm_save");
  assert.equal(ping.platform, "devtools");
  assert.equal(ping.counts.observations, 3, "observations=线索总数");
  assert.equal(ping.counts.groups, 2, "groups=组数");
  assert.equal(ping.counts.drafts, frozen.length, "drafts=保存件数");
  assert.equal(ping.counts.merges, 1);
  assert.equal(ping.counts.splits, 1);
  assert.equal(ping.counts.removes, 1);
  assert.equal(ping.counts.manualAdds, 1);
  assert.ok(Number.isInteger(ping.ms) && ping.ms >= 0 && ping.ms <= 3600000, "ms=会话毫秒(门内)");

  // 保存成功后离开:onHide 不再报 abandon
  page.onHide();
  assert.equal(cloudCalls.length, 1, "已保存 → 无 abandon ping");
});

/* ---------------- abandon 路径(B 页) ---------------- */

test("UMP-ABANDON-B:review 有扫描结果离开报一次 abandon;重复 hide 不重复;无结果/上传中不报", async () => {
  resetStubs();
  const page = videoScanPage();
  page.setData({ phase: "review", observations: [obs("电池")], drafts: [], batchLocation: "书房" });
  page.renderObservations();
  page.onHide();
  assert.equal(cloudCalls.length, 1);
  const ping = lastPing();
  assert.equal(ping.kind, "video_confirm_abandon");
  assert.equal(ping.counts.observations, 1);
  assert.equal(ping.platform, "devtools");
  // 重复 onHide / onUnload(复用 onHide)不重复报
  page.onHide();
  page.onUnload();
  assert.equal(cloudCalls.length, 1, "abandon 至多一次");

  // 无扫描结果:静默
  resetStubs();
  const empty = videoScanPage();
  empty.setData({ phase: "review", observations: [], drafts: [] });
  empty.onHide();
  assert.equal(cloudCalls.length, 0, "无扫描结果不报 abandon");

  // uploading/committing:提交仍在后台收敛,不报 abandon
  resetStubs();
  const uploading = videoScanPage();
  uploading.setData({ phase: "uploading", observations: [obs("电池")] });
  uploading.onHide();
  assert.equal(cloudCalls.length, 0, "uploading 不报 abandon");
});

test("UMP-ABANDON-B-PARTIAL:partial(视频已传、关联未完)离开同样报 abandon(best-effort)", () => {
  resetStubs();
  const page = videoScanPage();
  page.setData({ phase: "partial", observations: [obs("电池")], drafts: [draft("kp", "电池", [])] });
  page.onHide();
  assert.equal(cloudCalls.length, 1);
  assert.equal(lastPing().kind, "video_confirm_abandon");
  assert.equal(lastPing().counts.drafts, 1, "drafts=未保存草稿数");
});

/* ---------------- D1 页同款最小断言 ---------------- */

test("UMP-D1-SAVE:保存成功发一次 save ping(计数经 utils 同一实现);abandon 同语义", async () => {
  resetStubs();
  const observations = [
    obs("电池", { obsId: "ump-d1-1", frameIndex: 0 }),
    obs("电池", { obsId: "ump-d1-2", frameIndex: 3 }),
    obs("充电器", { obsId: "ump-d1-3", frameIndex: 5 }),
  ];
  const page = locScanPage();
  page.setData({
    phase: "review",
    mode: "scan",
    nodeId: "lc_shelf",
    locationPathText: "书房 / 书柜",
    videoDurationMs: 9000,
    observations,
    drafts: [
      Object.assign(draft("kd1", "电池", ["ump-d1-1"]), { nodeId: "lc_shelf" }),
    ],
    mergeSelectedKeys: [],
  });
  page.renderObservations();
  assert.equal(page.data.observationGroups.length, 2);
  // D1 交互计数:手动补件 + 移除
  page.onAddManualDraftTap();
  page.onDraftRemoveTap({ currentTarget: { dataset: { index: page.data.drafts.length - 1 } } });

  const frozen = page.data.drafts;
  commitRouter(frozen);
  await page.commitFrozenUpload(pendingFixture(frozen));
  assert.equal(page.data.phase, "done");
  assert.equal(cloudCalls.length, 1);
  const ping = lastPing();
  assert.equal(ping.kind, "video_confirm_save");
  assert.equal(ping.counts.observations, 3);
  assert.equal(ping.counts.groups, 2);
  assert.equal(ping.counts.drafts, frozen.length);
  assert.equal(ping.counts.manualAdds, 1);
  assert.equal(ping.counts.removes, 1);
  assert.equal(ping.counts.merges, 0);
  assert.equal(ping.counts.splits, 0);

  // D1 abandon:未保存离开
  resetStubs();
  const abandonPage = locScanPage();
  abandonPage.setData({ phase: "review", mode: "scan", observations: [obs("电池")], drafts: [] });
  abandonPage.renderObservations();
  abandonPage.onHide();
  assert.equal(cloudCalls.length, 1);
  assert.equal(lastPing().kind, "video_confirm_abandon");
});

/* ---------------- fire-and-forget:埋点失败不影响主流程 ---------------- */

test("UMP-SILENT-FAIL:云调用抛异常/拒绝时保存流程照常完成,零 toast", async () => {
  resetStubs();
  const prevCall = globalThis.wx.cloud.callFunction;
  globalThis.wx.cloud.callFunction = () => { throw new Error("cloud exploded"); };
  const page = videoScanPage();
  page.setData({ phase: "committing", observations: [obs("电池")], drafts: [draft("kf", "电池", [])] });
  const frozen = page.data.drafts;
  commitRouter(frozen);
  await page.commitFrozenUpload(pendingFixture(frozen));
  assert.equal(page.data.phase, "done", "埋点抛异常不阻断保存");
  assert.equal(toasts.length, 0, "埋点失败不 toast");
  globalThis.wx.cloud.callFunction = prevCall;
});

/* ---------------- 接线静态面:共享逻辑在 utils,两页不复制计数器 ---------------- */

test("UMP-WIRING:两页只调用 utils/usage-metrics,不内联计数器;扫描开始重置会话", () => {
  for (const dir of ["video-scan", "location-video-scan"]) {
    const ts = require("fs").readFileSync(path.join(ROOT, "miniprogram/pages", dir, dir + ".ts"), "utf8");
    assert.ok(ts.indexOf("usage-metrics") !== -1, dir + " 应引入 utils/usage-metrics");
    assert.ok(ts.indexOf("buildVideoConfirmUsagePing") !== -1, dir + " 经 utils 构建 ping");
    assert.ok(ts.indexOf("shouldReportUsageAbandon") !== -1, dir + " 经 utils 判 abandon 门");
    assert.ok(ts.indexOf("bumpUsageCount") !== -1, dir + " 经 utils 递增计数");
    // 计数器不复制:页面源码不得自持 merges/splits 数值运算
    assert.equal(/\bthis\.usage\.(merges|splits|removes|manualAdds)\s*\+=/.test(ts), false, dir + " 不得内联计数器运算");
  }
});
