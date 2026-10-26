"use strict";
// issue #121 第二波批次甲 ④:跳转高亮纯函数(离线合同测试)。
// 零 wx 依赖:输入只有页面栈描述(层数 + 各层是否已是目标 locations 页),
// 输出导航方案。v2 横幅(架构预审 6418877302)裁定:不统一强制 redirectTo,
// 仅栈近满(≥9 层,防 10 层上限)时兜底 redirect;页面接线归批次乙(PR-B #122)。
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  HIGHLIGHT_QUERY_KEY,
  STACK_FULL_REDIRECT_THRESHOLD,
  buildLocationNavPlan,
} = require("../miniprogram/utils/nav-highlight.js");

test("协议常量:hl 查询键与栈满 redirect 阈值(微信页面栈上限 10 层,预留 1 层)", () => {
  assert.equal(HIGHLIGHT_QUERY_KEY, "hl");
  assert.equal(STACK_FULL_REDIRECT_THRESHOLD, 9);
});

test("栈 2 层、当前页即目标(树内小移)→ method=none,原地刷新由调用方处理", () => {
  const plan = buildLocationNavPlan(2, {
    targetNodeId: "lc_kitchen",
    stackNodeIds: [null, "lc_kitchen"],
  });
  assert.equal(plan.method, "none");
  assert.equal(plan.stepsBack, 0);
  assert.equal(plan.url, "/pages/locations/locations?node_id=lc_kitchen");
});

test("栈 4 层、目标在栈内 2 层前 → navigateBackToTarget stepsBack=2", () => {
  const plan = buildLocationNavPlan(4, {
    targetNodeId: "lc_shelf",
    stackNodeIds: [null, "lc_shelf", null, "lc_layer"],
  });
  assert.equal(plan.method, "navigateBackToTarget");
  assert.equal(plan.stepsBack, 2);
  assert.equal(plan.url, "/pages/locations/locations?node_id=lc_shelf");
});

test("栈中无目标 → navigateTo(新压一层)", () => {
  const plan = buildLocationNavPlan(3, {
    targetNodeId: "lc_balcony",
    stackNodeIds: [null, "lc_index", null],
  });
  assert.equal(plan.method, "navigateTo");
  assert.equal(plan.stepsBack, 0);
  assert.equal(plan.url, "/pages/locations/locations?node_id=lc_balcony");
});

test("栈中无目标且栈近满(9 层)→ redirectTo(仅栈满兜底,不统一强制)", () => {
  const plan = buildLocationNavPlan(9, {
    targetNodeId: "lc_balcony",
    stackNodeIds: [null, null, null, null, null, null, null, null, null],
  });
  assert.equal(plan.method, "redirectTo");
  assert.equal(plan.stepsBack, 0);
  assert.equal(plan.url, "/pages/locations/locations?node_id=lc_balcony");
});

test("栈满 9 层但目标已在栈内 → 回退优先(navigateBack 不加层,不触发 redirect)", () => {
  const back = buildLocationNavPlan(9, {
    targetNodeId: "lc_shelf",
    stackNodeIds: [null, "lc_shelf", null, null, null, null, null, null, null],
  });
  assert.equal(back.method, "navigateBackToTarget");
  assert.equal(back.stepsBack, 7);

  const none = buildLocationNavPlan(9, {
    targetNodeId: "lc_top",
    stackNodeIds: [null, null, null, null, null, null, null, null, "lc_top"],
  });
  assert.equal(none.method, "none");
  assert.equal(none.stepsBack, 0);
});

test("未提供栈描述(stackNodeIds 缺省)→ 视为栈中无目标:navigateTo / 满栈 redirect", () => {
  assert.equal(
    buildLocationNavPlan(2, { targetNodeId: "lc_a" }).method,
    "navigateTo"
  );
  assert.equal(
    buildLocationNavPlan(9, { targetNodeId: "lc_a" }).method,
    "redirectTo"
  );
});

test("highlight 参数透传:有值时追加 &hl=…,无值时绝不出现 hl 键", () => {
  const withHl = buildLocationNavPlan(3, {
    targetNodeId: "lc_1",
    highlight: "it_9",
  });
  assert.equal(
    withHl.url,
    "/pages/locations/locations?node_id=lc_1&hl=it_9"
  );

  const backWithHl = buildLocationNavPlan(4, {
    targetNodeId: "lc_shelf",
    highlight: "it_9",
    stackNodeIds: [null, "lc_shelf", null, "lc_layer"],
  });
  assert.equal(backWithHl.method, "navigateBackToTarget");
  assert.equal(
    backWithHl.url,
    "/pages/locations/locations?node_id=lc_shelf&hl=it_9"
  );

  const noHl = buildLocationNavPlan(3, { targetNodeId: "lc_1" });
  assert.equal(noHl.url.indexOf("hl="), -1);

  // 空串 highlight 与缺省等价,不出 &hl=
  const emptyHl = buildLocationNavPlan(3, {
    targetNodeId: "lc_1",
    highlight: "",
  });
  assert.equal(emptyHl.url.indexOf("hl="), -1);
});

test("url 编码与根层约定:特殊字符 encodeURIComponent;空 node_id=根层(不带参)", () => {
  const plan = buildLocationNavPlan(2, {
    targetNodeId: "lc a/1",
    highlight: "it 9",
  });
  assert.equal(
    plan.url,
    "/pages/locations/locations?node_id=lc%20a%2F1&hl=it%209"
  );

  const root = buildLocationNavPlan(2, { targetNodeId: "" });
  assert.equal(root.method, "navigateTo");
  assert.equal(root.url, "/pages/locations/locations");
});

test("根层目标与栈内根层 locations 页匹配:stackNodeIds 中的空串=根层", () => {
  const plan = buildLocationNavPlan(2, {
    targetNodeId: "",
    stackNodeIds: [null, ""],
  });
  assert.equal(plan.method, "none");
  assert.equal(plan.stepsBack, 0);
});
