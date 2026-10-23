"use strict";

/**
 * Q3 视频草稿数量(issue #102 §2/§5-4;Q0-CONTRACT §9/§12-D):
 * - D1:一件东西 6 帧同名 → 草稿 observationIds=6,数量控件未动 → 提交载荷
 *   **不带 quantity 键**(服务端缺省 1/件);线索数/高亮数永不赋值数量;
 * - D2:同帧两条同名 observation → 默认两条独立草稿 → 2 条 ×1,绝不自动推断 1;
 * - D3:用户在合并草稿行上确认数量 2 → 提交 1 条 quantity=2(用户输入,
 *   绝不由 observation 数自动给 2,也绝不自动压成 1);
 * - 拆分:草稿数量不向拆分行传播(每行重新确认),observationIds/高亮/时间窗
 *   各自保留(原始帧/时间戳可找回),高亮上限 8 不变;
 * - 合并:mergeSceneDrafts 重置数量(不求和、不取线索数),用户重填;
 * - buildSceneCommitItems/buildLocationScanCommitItems 透传+形状门:
 *   非法数量/闭集外单位整批拒绝;target:existing 绝不携带数量字段。
 * 矩阵锚点:Q0-CONTRACT §12-C/D 的 Q3(客户端)行;服务端形状门由
 * tests/video-quantity.test.js(Q1)钉住。
 * 红绿纪律:本文件在未实现草稿数量的代码上必须失败,实现后全绿。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var videoScene = require(path.join(ROOT, "miniprogram/utils/video-scene.js"));
var locationScan = require(path.join(ROOT, "miniprogram/utils/location-scan.js"));

var DURATION = 12000;

function obs(name, frameIndex, timeMs, box) {
  return {
    obsId: "obs-" + name + "-" + frameIndex + "-" + Math.floor(timeMs),
    frameIndex: frameIndex,
    timeMs: timeMs,
    windowStartMs: Math.max(0, timeMs - 750),
    windowEndMs: Math.min(DURATION, timeMs + 750),
    framePath: "tmp://frame-" + frameIndex + ".jpg",
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

/* ---------------- D1:同一件 6 帧 ≠ 数量 6 ---------------- */

test("VQ-D1 6 帧同名合成 1 草稿,数量未动 → 提交不带 quantity 键(缺省 1,绝不 6)", function () {
  var observations = [];
  for (var i = 0; i < 6; i++) observations.push(obs("螺丝刀", i, i * 1600));
  var drafts = videoScene.createDraftsFromObservations(observations, ids(observations), {
    mergeSameName: true,
    batchLocation: "书房 / 工具抽屉",
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].observationIds.length, 6);
  assert.equal(drafts[0].quantity, undefined, "数量控件未动 → 草稿无数量");
  var built = videoScene.buildSceneCommitItems(drafts, observations, DURATION);
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.items.length, 1);
  assert.ok(!("quantity" in built.items[0]), "提交载荷不带 quantity 键,由服务端缺省 1/件");
  assert.ok(!("unit" in built.items[0]));
  assert.equal(built.items[0].highlights.length, 6, "证据按线索逐条保留(不是数量)");
});

/* ---------------- D2:同帧两件默认不合并 ---------------- */

test("VQ-D2 同帧两条同名 observation → 默认 2 条独立草稿 → 2 条 ×1,绝不自动推断 1", function () {
  var sameFrame = [obs("充电器", 3, 4800), obs("充电器", 3, 4800, { x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.9 })];
  var drafts = videoScene.createDraftsFromObservations(sameFrame, ids(sameFrame), {
    batchLocation: "书房 / 书柜",
  });
  assert.equal(drafts.length, 2, "默认一条一草稿(mergeSameName=false),绝不静默合并");
  var built = videoScene.buildSceneCommitItems(drafts, sameFrame, DURATION);
  assert.equal(built.ok, true);
  assert.equal(built.items.length, 2);
  built.items.forEach(function (it) {
    assert.ok(!("quantity" in it), "两行各自不带数量键(各自缺省 1)");
  });
});

/* ---------------- D3:同帧两件用户确认 2 ---------------- */

test("VQ-D3 用户在合并行上确认数量 2 → 1 条 quantity=2;未触碰绝不自动 2 也绝不自动 1", function () {
  var sameFrame = [obs("充电器", 3, 4800), obs("充电器", 3, 4800, { x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.9 })];
  var drafts = videoScene.createDraftsFromObservations(sameFrame, ids(sameFrame), {
    mergeSameName: true,
    batchLocation: "书房 / 书柜",
  });
  assert.equal(drafts.length, 1);
  // 未触碰:2 条线索也不自动给 2
  var untouched = videoScene.buildSceneCommitItems(drafts, sameFrame, DURATION);
  assert.equal(untouched.ok, true);
  assert.ok(!("quantity" in untouched.items[0]), "线索数 2 绝不自动赋值数量");
  // 用户确认 2(步进 1→2)
  var stepped = videoScene.stepDraftQty(drafts[0], 1);
  assert.equal(stepped.quantity, 2);
  assert.equal(stepped.unit, "件");
  var built = videoScene.buildSceneCommitItems([stepped], sameFrame, DURATION);
  assert.equal(built.ok, true);
  assert.equal(built.items.length, 1);
  assert.equal(built.items[0].quantity, 2, "用户输入 2(绝不自动推断 1)");
  assert.equal(built.items[0].unit, "件");
});

/* ---------------- 数量步进/单位选择纯函数 ---------------- */

test("VQ-STEP stepDraftQty:钳 1..9999,首触补默认单位;setDraftUnit:闭集外拒绝", function () {
  var d = videoScene.newSceneDraft({ name: "A", locationText: "L", observationIds: ["o1"], checked: true });
  assert.equal(d.quantity, undefined);
  var up = videoScene.stepDraftQty(d, 1);
  assert.equal(up.quantity, 2, "无数量按 1 起,步进 +1 = 2");
  assert.equal(up.unit, "件", "首触数量补默认单位(成组提交,服务端永不收半对)");
  var down = videoScene.stepDraftQty(up, -10);
  assert.equal(down.quantity, 1, "下限 1");
  var top = videoScene.stepDraftQty(videoScene.stepDraftQty(up, 9998), 5);
  assert.equal(top.quantity, 9999, "上限 9999");
  var bad = videoScene.stepDraftQty(up, 0.5);
  assert.equal(bad.quantity, up.quantity, "非整数步进无效,原值返回");
  // 单位选择:闭集外拒绝;合法单位同时确保数量成组
  var pick = videoScene.setDraftUnit(d, "包");
  assert.equal(pick.unit, "包");
  assert.equal(pick.quantity, 1, "只选单位也把数量落成 1(成组,不产生 unit 单独在场)");
  var same = videoScene.setDraftUnit(d, "箱");
  assert.equal(same.quantity, undefined, "闭集外单位拒绝,草稿原样");
});

/* ---------------- 提交形状门与透传 ---------------- */

test("VQ-BUILD 非法数量/闭集外单位 → 整批拒绝;合法值逐字段透传", function () {
  var observations = [obs("A", 0, 0)];
  function draftWith(over) {
    return Object.assign(
      videoScene.newSceneDraft({ name: "A", locationText: "书房", observationIds: [observations[0].obsId], checked: true }),
      over || {}
    );
  }
  assert.equal(videoScene.buildSceneCommitItems([draftWith({ quantity: 0, unit: "件" })], observations, DURATION).ok, false);
  assert.equal(videoScene.buildSceneCommitItems([draftWith({ quantity: 3.5, unit: "件" })], observations, DURATION).ok, false);
  assert.equal(videoScene.buildSceneCommitItems([draftWith({ quantity: 10000, unit: "件" })], observations, DURATION).ok, false);
  assert.equal(videoScene.buildSceneCommitItems([draftWith({ quantity: 2, unit: "箱" })], observations, DURATION).ok, false);
  var ok = videoScene.buildSceneCommitItems([draftWith({ quantity: 7, unit: "包" })], observations, DURATION);
  assert.equal(ok.ok, true);
  assert.equal(ok.items[0].quantity, 7);
  assert.equal(ok.items[0].unit, "包");
});

test("VQ-BUILD-PAIR unit 单独在场(无 quantity)→ fail-closed,绝不发出半对载荷", function () {
  var observations = [obs("A", 0, 0)];
  var d = videoScene.newSceneDraft({ name: "A", locationText: "书房", observationIds: [observations[0].obsId], checked: true });
  d.unit = "包"; // 直接注入的半态(辅助函数不会产出);客户端先拦
  var out = videoScene.buildSceneCommitItems([d], observations, DURATION);
  assert.equal(out.ok, false, "半对是客户端 bug,fail-closed 绝不发服务端必拒的载荷");
});

test("VQ-EXISTING target:existing 的草稿即便带数量也不进载荷(关联不碰数量,E7)", function () {
  var observations = [obs("A", 0, 0)];
  var d = videoScene.newSceneDraft({
    name: "A", locationText: "书房", target: "existing", itemId: "it-1",
    observationIds: [observations[0].obsId], checked: true, quantity: 3, unit: "包",
  });
  var out = videoScene.buildSceneCommitItems([d], observations, DURATION);
  assert.equal(out.ok, true);
  assert.ok(!("quantity" in out.items[0]), "证据关联绝不携带数量字段");
  assert.ok(!("unit" in out.items[0]));
});

/* ---------------- 合并/拆分的数量纪律 ---------------- */

test("VQ-MERGE mergeSceneDrafts 重置数量:不求和、不取线索数,由用户重新确认", function () {
  var o1 = obs("A", 0, 0);
  var o2 = obs("A", 1, 1600);
  var d1 = videoScene.stepDraftQty(videoScene.newSceneDraft({ name: "A", locationText: "L", observationIds: [o1.obsId], checked: true }), 2);
  var d2 = videoScene.stepDraftQty(videoScene.newSceneDraft({ name: "A", locationText: "L", observationIds: [o2.obsId], checked: true }), 4);
  assert.equal(d1.quantity, 3);
  assert.equal(d2.quantity, 5);
  var merged = videoScene.mergeSceneDrafts([d1, d2], [d1.draftKey, d2.draftKey]);
  assert.ok(merged !== null);
  assert.equal(merged.quantity, undefined, "合并=新身份,总数重新确认(不是 3+5 也不是 2 条线索)");
  assert.equal(merged.unit, undefined);
  var built = videoScene.buildSceneCommitItems([merged], [o1, o2], DURATION);
  assert.ok(!("quantity" in built.items[0]), "合并后未确认 → 不带数量键");
});

test("VQ-SPLIT 拆分:数量不传播(逐行重确认),observationIds/高亮/时间窗各自保留", function () {
  var o1 = obs("棉柔巾", 0, 500);
  var o2 = obs("棉柔巾", 2, 3600);
  var o3 = obs("棉柔巾", 4, 6600);
  var d = videoScene.stepDraftQty(
    videoScene.newSceneDraft({ name: "棉柔巾", locationText: "L", observationIds: ids([o1, o2, o3]), checked: true }),
    4
  );
  assert.equal(d.quantity, 5);
  var parts = videoScene.splitSceneDraft(d);
  assert.equal(parts.length, 3);
  parts.forEach(function (p, i) {
    assert.equal(p.observationIds.length, 1);
    assert.equal(p.observationIds[0], [o1, o2, o3][i].obsId, "原始帧线索按序可找回");
    assert.equal(p.quantity, undefined, "拆分行不带原数量(数量是对组的断言,拆开必须逐行重确认)");
    assert.equal(p.unit, undefined);
  });
  var built = videoScene.buildSceneCommitItems(parts, [o1, o2, o3], DURATION);
  assert.equal(built.ok, true);
  assert.equal(built.items.length, 3);
  // 时间窗/高亮各自来自自己的 observation(时间戳可找回)
  assert.equal(built.items[0].highlights[0].start_ms, 500);
  assert.equal(built.items[1].highlights[0].start_ms, 3600);
  assert.equal(built.items[2].highlights[0].start_ms, 6600);
});

/* ---------------- D1 位置清点入口(location-video-scan)同一口径 ---------------- */

function d1Ctx() {
  return {
    locationId: "node-1",
    pathsByNodeId: { "node-1": ["书房", "书柜"], "node-2": ["书房", "书柜", "第二层"] },
  };
}

test("VQ-LOC-D1/D3 位置清点:数量=用户输入;未动不带键;existing 不携带", function () {
  var observations = [];
  for (var i = 0; i < 6; i++) observations.push(obs("螺丝刀", i, i * 1600));
  var draft = videoScene.createDraftsFromObservations(observations, ids(observations), {
    mergeSameName: true,
    batchLocation: "书房 / 书柜",
  })[0];
  var untouched = locationScan.buildLocationScanCommitItems([draft], observations, DURATION, d1Ctx(), "scan-1");
  assert.equal(untouched.ok, true, JSON.stringify(untouched));
  assert.ok(!("quantity" in untouched.items[0]), "6 帧线索绝不给 6");
  assert.equal(untouched.candidateCount, 6, "candidate_count 仍是线索数口径,与数量无关");

  var stepped = videoScene.stepDraftQty(draft, 1);
  var touched = locationScan.buildLocationScanCommitItems([stepped], observations, DURATION, d1Ctx(), "scan-1");
  assert.equal(touched.ok, true);
  assert.equal(touched.items[0].quantity, 2, "用户输入 2 才是 2");
  assert.equal(touched.items[0].unit, "件");

  var existing = videoScene.newSceneDraft({
    name: "螺丝刀", locationText: "书房 / 书柜", target: "existing", itemId: "it-9",
    observationIds: ids(observations.slice(0, 1)), checked: true, quantity: 3, unit: "包",
  });
  var exOut = locationScan.buildLocationScanCommitItems([existing], observations, DURATION, d1Ctx(), "scan-1");
  assert.equal(exOut.ok, true);
  assert.ok(!("quantity" in exOut.items[0]), "位置清点 existing 关联同样不携带数量");
});

test("VQ-LOC-MERGE mergeLocationScanDrafts 合并后数量重置(nodeId 一致门照旧)", function () {
  var o1 = obs("A", 0, 0);
  var o2 = obs("A", 1, 1600);
  function nodeDraft(o, step) {
    // LocationScanDraft = B 草稿 + nodeId(newSceneDraft 不透传扩展键,测试侧补上)
    return Object.assign(
      videoScene.stepDraftQty(
        videoScene.newSceneDraft({ name: "A", locationText: "书房 / 书柜", observationIds: [o.obsId], checked: true }),
        step
      ),
      { nodeId: "node-2" }
    );
  }
  var d1 = nodeDraft(o1, 1);
  var d2 = nodeDraft(o2, 2);
  var out = locationScan.mergeLocationScanDrafts([d1, d2], [d1.draftKey, d2.draftKey], "node-1");
  assert.equal(out.ok, true);
  assert.equal(out.draft.quantity, undefined, "合并重置数量");
  assert.equal(out.draft.nodeId, "node-2", "位置一致门照旧");
});
