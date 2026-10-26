"use strict";
// 评审 5649433998 修补 1:B 页「归到」逐层选择器异步响应乱序守卫(请求代次 epoch)。
// 反例:进书房(请求A,挂起)→返回上一层→进厨房(请求B,先回)→A 后到——
// 较慢的旧层级响应不得覆盖当前层列表/面包屑(打开层级/返回/关闭/清除/选中
// 一律推进代次,迟到响应整个丢弃,不 setData)。被测对象是 build:mp 产出的
// video-scan.js;守卫复用 D1 locations 页同款 createRequestSeq(utils/locations-cache,
// 页内纯函数可直接驱动)。零网络零外部依赖;wx 全 stub。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const locationsApi = require(path.join(ROOT, "miniprogram/utils/locations-api.js"));
const locationsCache = require(path.join(ROOT, "miniprogram/utils/locations-cache.js"));

let pageOptions = null;
globalThis.Page = (options) => { pageOptions = options; };
globalThis.wx = {
  getStorageSync: () => "",
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: () => {},
  showModal: (o) => { if (o && o.success) o.success({ confirm: false }); },
  showActionSheet: (o) => { if (o && o.fail) o.fail({ errMsg: "cancel" }); },
};
require(path.join(ROOT, "miniprogram/pages/video-scan/video-scan.js"));

const originalCallLocations = locationsApi.callLocationsApi;

/** 逐次挂起的 locations 路由:每个请求捕获 resolve/reject,由测试手工放行 */
function hangLocations() {
  const calls = [];
  locationsApi.callLocationsApi = (event) => new Promise((resolve, reject) => {
    calls.push({ event, resolve, reject });
  });
  return calls;
}

function tick(n) {
  let left = n || 2;
  return new Promise((done) => {
    (function step() {
      if (left <= 0) return done();
      left -= 1;
      setImmediate(step);
    })();
  });
}

function makePage() {
  const page = {
    data: JSON.parse(JSON.stringify(pageOptions.data)),
    // 真实 setData 的 callback 是异步派生渲染:用 setImmediate 模拟,
    // 页面里挂在 setData 回调上的 renderNodeSelector 因此可被驱动
    setData(patch, callback) {
      Object.keys(patch).forEach((k) => { page.data[k] = patch[k]; });
      if (typeof callback === "function") setImmediate(callback);
    },
  };
  Object.keys(pageOptions).forEach((k) => {
    if (k === "data") return;
    const v = pageOptions[k];
    page[k] = typeof v === "function" || typeof v !== "object" || v === null ? v : {};
  });
  // 页面对象成员经 JSON 克隆只剩空壳:注入可驱动的真实现
  // (与 location-scan-page.test.js 对 requestSeq 的注入同款)
  page.nodePaths = {};
  page.nodeSelectorSeq = locationsCache.createRequestSeq();
  return page;
}

function newDraft() {
  return {
    draftKey: "k1", observationIds: [], manualHighlights: [],
    name: "螺丝刀", target: "new", operationId: "op1", itemId: "",
    locationText: "书房", note: "", checked: true,
  };
}

function child(id, name, pathSegs, childCount) {
  return { location_id: id, name, path: pathSegs, item_count: 0, child_count: childCount || 0 };
}
const TOP_CHILDREN = [child("lc_study", "书房", ["书房"], 1), child("lc_kitchen", "厨房", ["厨房"], 1)];
const STUDY_CHILDREN = [child("lc_shelf", "书柜", ["书房", "书柜"], 1)];
const KITCHEN_CHILDREN = [child("lc_cabinet", "橱柜", ["厨房", "橱柜"], 0)];

test.after(() => { locationsApi.callLocationsApi = originalCallLocations; });

function optionIds(page) {
  return page.data.nodeSelectorOptions.map((o) => o.locationId);
}

// ---------------------------------------------------------------------------
// 反例主路径:旧层级响应后到,不得覆盖当前层
// ---------------------------------------------------------------------------

test("B-NODE-SEQ-REORDER:进书房(A挂起)→返回→进厨房(B先回)→A后到 → 列表/面包屑保持厨房,不回跳书房", async () => {
  const calls = hangLocations();
  const page = makePage();
  page.setData({ drafts: [newDraft()] });

  // 打开选择器:顶层请求(立即回)。导航方法一律不 await——挂起请求会卡住
  // await 链,fire-and-forget + tick 驱动到断言点即可
  page.onDraftNodeTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(calls.length, 1);
  calls[0].resolve({ ok: true, children: TOP_CHILDREN });
  await tick();
  assert.deepEqual(optionIds(page), ["lc_study", "lc_kitchen"], "顶层就绪");
  assert.equal(page.data.nodeSelectorPathText, "家");
  assert.equal(page.data.nodeSelectorLoading, false);

  // 下钻书房:请求 A(挂起,模拟慢网络)
  page.onNodeDrillTap({ currentTarget: { dataset: { nodeId: "lc_study" } } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].event.parent_id, "lc_study");
  await tick(1); // 面包屑在 setData 回调里派生渲染
  assert.equal(page.data.nodeSelectorPathText, "书房");

  // 返回上一层:顶层再拉(先回)
  page.onNodeSelectorBackTap();
  assert.equal(calls.length, 3);
  calls[2].resolve({ ok: true, children: TOP_CHILDREN });
  await tick();
  assert.deepEqual(optionIds(page), ["lc_study", "lc_kitchen"]);

  // 下钻厨房:请求 B(先回)
  page.onNodeDrillTap({ currentTarget: { dataset: { nodeId: "lc_kitchen" } } });
  assert.equal(calls.length, 4);
  assert.equal(calls[3].event.parent_id, "lc_kitchen");
  calls[3].resolve({ ok: true, children: KITCHEN_CHILDREN });
  await tick();
  assert.deepEqual(optionIds(page), ["lc_cabinet"], "厨房层就绪");
  assert.equal(page.data.nodeSelectorPathText, "厨房");
  assert.equal(page.data.nodeSelectorLoading, false);

  // 旧层级请求 A(书房子列表)后到 → 整个丢弃:不 setData,列表/面包屑不回跳
  calls[1].resolve({ ok: true, children: STUDY_CHILDREN });
  await tick(3);
  assert.deepEqual(optionIds(page), ["lc_cabinet"], "列表保持厨房,不回跳书房");
  assert.equal(page.data.nodeSelectorPathText, "厨房", "面包屑保持厨房");
  assert.deepEqual(
    page.data.nodeSelectorStack.map((f) => f.locationId),
    ["", "lc_kitchen"],
    "导航栈仍是 厨房",
  );
  assert.equal(page.data.nodeSelectorLoading, false);
  assert.equal(page.data.nodeSelectorError, "", "迟到成功响应不写错误");
});

// ---------------------------------------------------------------------------
// 关闭/清除/选中同样推进代次:迟到响应不复活弹层、不写选项、不写错误
// ---------------------------------------------------------------------------

test("B-NODE-SEQ-CLOSE:挂起请求期间关闭弹层 → 迟到响应(成功与失败)整个丢弃", async () => {
  const calls = hangLocations();
  const page = makePage();
  page.setData({ drafts: [newDraft()] });
  page.onDraftNodeTap({ currentTarget: { dataset: { index: 0 } } });
  calls[0].resolve({ ok: true, children: TOP_CHILDREN });
  await tick();
  // 下钻书房:请求 A 挂起,随后用户直接关闭弹层
  page.onNodeDrillTap({ currentTarget: { dataset: { nodeId: "lc_study" } } });
  page.onNodeSelectorCloseTap();
  assert.equal(page.data.nodeSelectorVisible, false);
  calls[1].resolve({ ok: true, children: STUDY_CHILDREN });
  await tick(3);
  assert.equal(page.data.nodeSelectorVisible, false, "迟到响应不得复活弹层");
  assert.deepEqual(page.data.nodeSelectorOptions, [], "迟到响应不写选项");
  assert.equal(page.data.nodeSelectorError, "");
});

test("B-NODE-SEQ-CLEAR:挂起请求期间「不挂,只记文字」清除 → 迟到失败响应不写错误,草稿清选", async () => {
  const calls = hangLocations();
  const page = makePage();
  page.setData({ drafts: [Object.assign(newDraft(), { nodeId: "lc_shelf" })] });
  page.onDraftNodeTap({ currentTarget: { dataset: { index: 0 } } });
  calls[0].resolve({ ok: true, children: TOP_CHILDREN });
  await tick();
  page.onNodeDrillTap({ currentTarget: { dataset: { nodeId: "lc_study" } } });
  page.onNodeSelectorClearTap();
  assert.equal(page.data.nodeSelectorVisible, false);
  assert.equal(page.data.drafts[0].nodeId, undefined, "清除:草稿回到纯文本");
  calls[1].reject(new Error("network reset"));
  await tick(3);
  assert.equal(page.data.nodeSelectorVisible, false);
  assert.equal(page.data.nodeSelectorError, "", "迟到失败响应同样丢弃,不写错误");
});

test("B-NODE-SEQ-PICK:选中节点关闭选择器后,同批挂起响应迟到 → 草稿选定不被扰动", async () => {
  const calls = hangLocations();
  const page = makePage();
  page.setData({ drafts: [newDraft()] });
  page.onDraftNodeTap({ currentTarget: { dataset: { index: 0 } } });
  calls[0].resolve({ ok: true, children: TOP_CHILDREN });
  await tick();
  // 下钻书房(A 挂起)→ 返回(顶层再拉,B' 先回)→ 直接选中厨房关闭
  page.onNodeDrillTap({ currentTarget: { dataset: { nodeId: "lc_study" } } });
  page.onNodeSelectorBackTap();
  assert.equal(calls.length, 3);
  calls[2].resolve({ ok: true, children: TOP_CHILDREN });
  await tick();
  page.onNodeOptionTap({ currentTarget: { dataset: { nodeId: "lc_kitchen" } } });
  assert.equal(page.data.drafts[0].nodeId, "lc_kitchen");
  assert.equal(page.data.drafts[0].locationText, "厨房");
  assert.equal(page.data.nodeSelectorVisible, false);
  // 关闭后旧层级请求 A 迟到:任何 setData 都不得再发生
  calls[1].resolve({ ok: true, children: STUDY_CHILDREN });
  await tick(3);
  assert.equal(page.data.drafts[0].nodeId, "lc_kitchen", "选定结果不被迟到响应扰动");
  assert.equal(page.data.nodeSelectorVisible, false, "迟到响应不得复活弹层");
});
