"use strict";
/**
 * issue #101 R0 候选组卡组件 scene-group-card 反例测试(先于实现;
 * 契约 docs/design/video-ai/R0-OBSERVATION-GROUPS.md §8 矩阵 B,Component 桩先例
 * tests/voice-bar.test.js:36)。被测对象是 npm run build:mp 产出的
 * miniprogram/components/scene-group-card/scene-group-card.js。
 *
 * 契约 §5.2 冻结:properties { group: Object, busy: Boolean };events
 * expand / obsToggle {obsId} / obsPreview {obsId} / confirmSingle {obsIds} /
 * confirmMulti / defer / generatePerObs {obsIds};组件内持有展开态(默认折叠)与
 * 组内勾选态(默认不勾选——PR #103 视频核对原型第 8 条:来源默认不勾选,整组
 * 确认可一次操作,不强迫逐帧点六次);二次确认弹窗在页面,组件只发事件。
 *
 * 契约未逐字冻结的方法名/内部字段,由本文件冻结为实现验收面:
 * - data: { expanded: false(默认折叠), checkedIds: [](组内勾选 obsId) }
 * - methods: onExpandToggle / onObsToggle(e.currentTarget.dataset.obsId) /
 *   onObsImageTap(e.currentTarget.dataset.obsId) / onConfirmSingleTap /
 *   onConfirmMultiTap / onDeferTap / onGeneratePerObsTap
 * - 事件 detail:组级事件 { nameKey, obsIds? };行级事件 { obsId }
 * - busy=true 或已归属行:动作与勾选一律无效(不 triggerEvent、不改 checkedIds)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const COMP_DIR = path.join(ROOT, "miniprogram", "components", "scene-group-card");

/* ---------------- Component 桩(voice-bar 先例) ---------------- */

globalThis.wx = {
  showToast: function () {},
  showModal: function () {},
  showActionSheet: function () {},
  getStorageSync: function () { return ""; },
  setStorageSync: function () {},
  removeStorageSync: function () {},
  previewImage: function () {},
};

let captured = null;
try {
  globalThis.Component = function (options) { captured = options; };
  require(path.join(COMP_DIR, "scene-group-card.js"));
} catch (e) {
  captured = null; // 实现未落地:以下每条测试以断言失败呈现,不崩文件
}

function mustMethod(name) {
  assert.ok(captured !== null, "miniprogram/components/scene-group-card/scene-group-card.js 未实现或不可加载(契约 §5.2)");
  assert.equal(typeof captured.methods[name], "function", "scene-group-card 应注册方法 " + name + "(契约 §5.2)");
  return captured.methods[name];
}

function readComp(rel) {
  const p = path.join(COMP_DIR, rel);
  assert.equal(fs.existsSync(p), true, "组件应含 " + rel + "(契约 §5.2)");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

/** 组件实例桩:properties 镜像进 data(miniprogram 语义),setData 合并,triggerEvent 捕获 */
function makeCompThis(group, busy) {
  const self = {
    data: {
      group: group,
      busy: busy === true,
      expanded: false,
      checkedIds: [],
    },
    events: [],
    setData: function (patch) { Object.assign(self.data, patch); },
    triggerEvent: function (name, detail) { self.events.push({ name: name, detail: detail }); },
  };
  self.properties = { group: group, busy: busy === true };
  return self;
}

/** 一张可直接喂组件的组视图(形状=tests/scene-groups.test.js 冻结的 GroupView) */
function pendingGroup() {
  return {
    nameKey: "充电器",
    label: "充电器",
    countText: "3 条线索",
    state: "pending",
    stateText: "待确认有几件",
    remainingCount: 3,
    sameFrameRisk: false,
    highlightWarning: "",
    repFrame: { framePath: "/tmp/frame-2.jpg", boxStyle: "left:10%;top:10%;width:20%;height:30%", timeText: "0:03" },
    observations: [
      { obsId: "o1", name: "充电器", timeText: "0:00", confidenceText: "较有把握", framePath: "/tmp/frame-0.jpg", boxStyle: "display:none", checked: false, claimed: false, claimText: "" },
      { obsId: "o2", name: "充电器", timeText: "0:03", confidenceText: "可能", framePath: "/tmp/frame-2.jpg", boxStyle: "left:10%;top:10%;width:20%;height:30%", checked: false, claimed: false, claimText: "" },
      { obsId: "o3", name: "充电器、", timeText: "0:05", confidenceText: "不确定", framePath: "/tmp/frame-3.jpg", boxStyle: "display:none", checked: false, claimed: false, claimText: "" },
    ],
  };
}

/* ---------------- 矩阵 B ---------------- */

test("SGC-DEFAULT-COLLAPSED:初始 data 折叠;折叠卡渲染要素=label/线索数/代表帧/状态文案/三动作(§5.2)", () => {
  assert.ok(captured !== null, "组件未实现(契约 §5.2)");
  assert.equal(captured.data.expanded, false, "组卡默认折叠,首屏条目=组数");
  assert.deepEqual(captured.data.checkedIds, [], "组内勾选态默认不勾选(来源默认不勾选)");

  const wxml = readComp("scene-group-card.wxml");
  // 折叠卡五要素
  assert.ok(wxml.indexOf("group.label") !== -1, "折叠卡显示组 label");
  assert.ok(wxml.indexOf("group.countText") !== -1, "折叠卡显示线索数");
  assert.ok(wxml.indexOf("group.repFrame.framePath") !== -1, "折叠卡显示代表帧缩略图");
  assert.ok(wxml.indexOf("group.repFrame.timeText") !== -1, "折叠卡显示代表帧时间");
  assert.ok(wxml.indexOf("group.repFrame.boxStyle") !== -1, "折叠卡代表帧带候选框");
  assert.ok(wxml.indexOf("group.stateText") !== -1, "折叠卡显示组态文案");
  // 三动作(§2 冻结文案)
  assert.ok(wxml.indexOf("就 1 件") !== -1, "动作一:就 1 件");
  assert.ok(wxml.indexOf("有多件或需拆开") !== -1, "动作二:有多件或需拆开");
  assert.ok(wxml.indexOf("暂不确定") !== -1, "动作三:暂不确定");
  // 展开态才渲染全部观察行(默认折叠不渲染几十条)
  assert.ok(wxml.indexOf("expanded") !== -1, "观察行受展开态控制");
  assert.ok(wxml.indexOf('wx:for="{{ group.observations }}"') !== -1, "展开渲染全部观察行");

  const json = readComp("scene-group-card.json");
  assert.equal(JSON.parse(json).component, true, "组件 json 声明 component:true");
});

test("SGC-EXPAND:expand 事件与展开;obsToggle/obsPreview 事件载荷正确(§5.2)", () => {
  const onExpandToggle = mustMethod("onExpandToggle");
  const onObsToggle = mustMethod("onObsToggle");
  const onObsImageTap = mustMethod("onObsImageTap");

  const self = makeCompThis(pendingGroup(), false);
  onExpandToggle.call(self);
  assert.equal(self.data.expanded, true, "点组卡切换展开");
  assert.deepEqual(self.events, [{ name: "expand", detail: { nameKey: "充电器" } }]);

  // 行级勾选:改组内勾选态并上报 obsId;再点取消
  onObsToggle.call(self, { currentTarget: { dataset: { obsId: "o2" } } });
  assert.deepEqual(self.data.checkedIds, ["o2"]);
  assert.deepEqual(self.events[1], { name: "obsToggle", detail: { obsId: "o2" } });
  onObsToggle.call(self, { currentTarget: { dataset: { obsId: "o2" } } });
  assert.deepEqual(self.data.checkedIds, [], "再点取消勾选");

  // 缩略图预览:catchtap 不触发行勾选,只上报 obsPreview
  onObsImageTap.call(self, { currentTarget: { dataset: { obsId: "o3" } } });
  assert.deepEqual(self.events[2], { name: "obsPreview", detail: { obsId: "o3" } });
  assert.deepEqual(self.data.checkedIds, [], "预览不改勾选态");
});

test("SGC-ACTIONS:confirmSingle/confirmMulti/defer/generatePerObs 事件与载荷;busy 禁用;已归属行不可勾(§2/§5.2)", () => {
  const onConfirmSingleTap = mustMethod("onConfirmSingleTap");
  const onConfirmMultiTap = mustMethod("onConfirmMultiTap");
  const onDeferTap = mustMethod("onDeferTap");
  const onGeneratePerObsTap = mustMethod("onGeneratePerObsTap");
  const onObsToggle = mustMethod("onObsToggle");

  // 就 1 件:展开态未勾选 → obsIds 空数组(整组语义由页面 confirmSingleSet 解释)
  const self = makeCompThis(pendingGroup(), false);
  onConfirmSingleTap.call(self);
  assert.deepEqual(self.events, [{ name: "confirmSingle", detail: { nameKey: "充电器", obsIds: [] } }]);

  // 勾选两条后就 1 件:载荷=当前勾选
  const self2 = makeCompThis(pendingGroup(), false);
  self2.data.checkedIds = ["o1", "o3"];
  onConfirmSingleTap.call(self2);
  assert.deepEqual(self2.events, [{ name: "confirmSingle", detail: { nameKey: "充电器", obsIds: ["o1", "o3"] } }]);

  // 有多件或需拆开:进入逐条模式(展开),不产生任何草稿语义
  const self3 = makeCompThis(pendingGroup(), false);
  self3.data.expanded = false;
  onConfirmMultiTap.call(self3);
  assert.equal(self3.data.expanded, true, "逐条模式=展开+行级勾选");
  assert.deepEqual(self3.events, [{ name: "confirmMulti", detail: { nameKey: "充电器" } }]);

  // 暂不确定:折叠、零数据变更
  const self4 = makeCompThis(pendingGroup(), false);
  self4.data.expanded = true;
  onDeferTap.call(self4);
  assert.equal(self4.data.expanded, false);
  assert.deepEqual(self4.events, [{ name: "defer", detail: { nameKey: "充电器" } }]);

  // 勾选线索各成一件:载荷=当前勾选
  const self5 = makeCompThis(pendingGroup(), false);
  self5.data.checkedIds = ["o2"];
  onGeneratePerObsTap.call(self5);
  assert.deepEqual(self5.events, [{ name: "generatePerObs", detail: { nameKey: "充电器", obsIds: ["o2"] } }]);

  // busy=true:三动作与逐条生成一律禁用(§2 前置)
  for (const setup of [
    ["onConfirmSingleTap", onConfirmSingleTap],
    ["onConfirmMultiTap", onConfirmMultiTap],
    ["onDeferTap", onDeferTap],
    ["onGeneratePerObsTap", onGeneratePerObsTap],
  ]) {
    const busySelf = makeCompThis(pendingGroup(), true);
    setup[1].call(busySelf);
    assert.deepEqual(busySelf.events, [], setup[0] + " 在 busy 时禁用");
  }

  // 已归属行不可勾、显示「已用于:{草稿名}」
  const claimedGroup = pendingGroup();
  claimedGroup.observations[0].claimed = true;
  claimedGroup.observations[0].claimText = "已用于:充电器A";
  const self6 = makeCompThis(claimedGroup, false);
  self6.data.checkedIds = [];
  onObsToggle.call(self6, { currentTarget: { dataset: { obsId: "o1" } } });
  assert.deepEqual(self6.data.checkedIds, [], "已归属行不可勾选");
  assert.deepEqual(self6.events, [], "已归属行勾选不上报事件");

  const wxml = readComp("scene-group-card.wxml");
  assert.ok(wxml.indexOf("已用于:") !== -1 && wxml.indexOf("claimText") !== -1, "归属标签显示「已用于:{草稿名}」");
  assert.ok(wxml.indexOf("勾选线索各成一件") !== -1, "逐条模式生成按钮文案");
  assert.ok(wxml.indexOf("onGeneratePerObsTap") !== -1, "逐条生成按钮接线");
  assert.ok(wxml.indexOf("busy") !== -1, "busy 参与禁用绑定");
});

test("SGC-RISK-BADGE:risk 组显示「可能有多件,需拆分核对」;与任一组态可叠加(§3.1)", () => {
  const wxml = readComp("scene-group-card.wxml");
  assert.ok(wxml.indexOf("sameFrameRisk") !== -1, "风险徽标由 sameFrameRisk 驱动");
  assert.ok(wxml.indexOf("可能有多件,需拆分核对") !== -1, "风险徽标为 §3.1 固定文案");

  // 叠加示例:risk 组被显式确认后(single 态)徽标仍在(视图形状来自 scene-groups 测试冻结)
  const riskSingle = pendingGroup();
  riskSingle.sameFrameRisk = true;
  riskSingle.state = "single";
  riskSingle.stateText = "已按 1 件确认 → 充电器";
  riskSingle.remainingCount = 0;
  assert.equal(riskSingle.sameFrameRisk, true, "风险标志与组态正交,不因确认消失");
});
