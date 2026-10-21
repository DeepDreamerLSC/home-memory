"use strict";
// PR B 客户端纯函数：帧计划、逐帧部分失败/取消、同名不自动合并、显式拆分/合并、确认载荷。
const test = require("node:test");
const assert = require("node:assert/strict");
const scene = require("../miniprogram/utils/video-scene");
const target = require("../miniprogram/utils/video-target");

function fakeSession(durationMs, onCapture) {
  return {
    cancelled: false,
    durationMs,
    async captureAt(timeMs, frameIndex) {
      if (onCapture) onCapture({ timeMs, frameIndex, session: this });
      return {
        path: "/tmp/frame-" + frameIndex + ".jpg",
        width: 640,
        height: 480,
        timeMs,
        frameIndex,
        base64: "ZmFrZQ==",
      };
    },
    async cancel() { this.cancelled = true; },
  };
}

function observation(name, timeMs, box) {
  return {
    obsId: "obs-" + name + "-" + timeMs,
    frameIndex: 0,
    timeMs,
    windowStartMs: Math.max(0, timeMs - 750),
    windowEndMs: timeMs + 750,
    framePath: "/tmp/a.jpg",
    frameWidth: 640,
    frameHeight: 480,
    name,
    qtyNote: "",
    confidence: "mid",
    box: box === undefined ? null : box,
  };
}

test("SCENE-PLAN:复用 PR A 4+4 帧计划，短视屏去重且不超 8", () => {
  const plan = scene.planSceneFrames(10000);
  assert.equal(plan.length, 8);
  assert.equal(plan.filter((p) => p.phase === "initial").length, 4);
  assert.equal(plan.filter((p) => p.phase === "supplemental").length, 4);
  const times = plan.map((p) => p.timeMs);
  assert.equal(new Set(times).size, times.length);
  const short = scene.planSceneFrames(300);
  assert.ok(short.length >= 1 && short.length <= 8);
  assert.equal(new Set(short.map((p) => p.timeMs)).size, short.length);
  assert.deepEqual(target.buildFramePlan(10000, { supplemental: true }).map((p) => p.timeMs), times);
});

test("SCENE-SCAN:逐帧候选独立保留；单帧 VL 失败不阻断其他帧", async () => {
  const session = fakeSession(12000);
  let calls = 0;
  const progress = [];
  const outcome = await scene.scanSceneVideo({
    source: { path: "/tmp/video.mp4", durationMs: 12000 },
    durationMs: 12000,
    session,
    callRecognize: async () => {
      calls += 1;
      if (calls === 2) throw new Error("network down");
      return {
        ok: true,
        items: [{ name: "黑色耳机", qty_note: "", confidence: "mid", box: { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5 } }],
      };
    },
    onProgress: (done, total, failures) => progress.push({ done, total, failures }),
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.framesTotal, 8);
  assert.equal(outcome.observations.length, 7);
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.manualFallback, false);
  assert.equal(outcome.observations[0].frameIndex, outcome.observations[0].frameIndex);
  assert.ok(outcome.observations[0].timeMs >= 0);
  assert.equal(outcome.observations[0].box.x2, 0.4);
  assert.equal(progress.length, 8);
});

test("SCENE-SCAN-CANCEL:取消后不再继续后续帧，不产出迟到结果", async () => {
  const session = fakeSession(12000);
  let calls = 0;
  const outcome = await scene.scanSceneVideo({
    source: { path: "/tmp/video.mp4", durationMs: 12000 },
    durationMs: 12000,
    session,
    callRecognize: async () => {
      calls += 1;
      session.cancelled = true;
      return { ok: true, items: [] };
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "cancelled");
  assert.equal(calls, 1);
});

test("SCENE-NO-AUTO-MERGE:同名 observation 默认各成一件，显式开关才归组", () => {
  const observations = [observation("黑色耳机", 1000), observation("黑色耳机", 3000)];
  const ids = observations.map((o) => o.obsId);
  const separate = scene.createDraftsFromObservations(observations, ids, { mergeSameName: false, batchLocation: "抽屉" });
  assert.equal(separate.length, 2);
  assert.notEqual(separate[0].draftKey, separate[1].draftKey);
  assert.notEqual(separate[0].operationId, separate[1].operationId);
  assert.equal(separate[0].observationIds.length, 1);
  assert.equal(separate[1].observationIds.length, 1);

  const merged = scene.createDraftsFromObservations(observations, ids, { mergeSameName: true, batchLocation: "抽屉" });
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].observationIds, ids);
});

test("SCENE-EXPLICIT-SPLIT-MERGE:用户显式拆/合，key/operation_id 仍彼此独立", () => {
  const observations = [observation("杯子", 1000), observation("杯子", 3000), observation("杯子", 5000)];
  const one = scene.createDraftsFromObservations(observations, observations.map((o) => o.obsId), { mergeSameName: true, batchLocation: "柜子" })[0];
  const split = scene.splitSceneDraft(one);
  assert.equal(split.length, 3);
  assert.equal(new Set(split.map((d) => d.draftKey)).size, 3);
  assert.equal(new Set(split.map((d) => d.operationId)).size, 3);
  const merged = scene.mergeSceneDrafts(split, [split[0].draftKey, split[1].draftKey]);
  assert.ok(merged);
  assert.equal(merged.observationIds.length, 2);
  const built = scene.buildSceneCommitItems([merged, split[2]], observations, 12000);
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.items.length, 2);
  assert.equal(new Set(built.items.map((i) => i.draft_key)).size, 2);
  assert.equal(new Set(built.items.map((i) => i.operation_id)).size, 2);
});

test("SCENE-HIGHLIGHTS:observation 源帧成为 start/frame_ms；box null 原样保留且限 8 条", () => {
  const observations = [observation("无框物品", 3200, null)];
  const draft = scene.createDraftsFromObservations(observations, [observations[0].obsId], { batchLocation: "抽屉" })[0];
  const highlights = scene.buildDraftHighlights(draft, observations, 12000);
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0].start_ms, 3200);
  assert.equal(highlights[0].frame_ms, 3200);
  assert.equal(highlights[0].end_ms, 4700);
  assert.equal(highlights[0].box, null);
  const built = scene.buildSceneCommitItems([draft], observations, 12000);
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.items[0].highlights[0].box, null);

  const tooMany = scene.newSceneDraft({
    name: "高亮过多",
    locationText: "抽屉",
    manualHighlights: Array.from({ length: 9 }, (_, i) => ({ start_ms: i * 100, end_ms: i * 100 + 50, box: null, frame_ms: i * 100 })),
  });
  const rejected = scene.buildSceneCommitItems([tooMany], [], 12000);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.message.indexOf("8") !== -1);
});

test("SCENE-BUILD-VALIDATION:空名称/空位置/无高亮/超 12 件均本地拦截", () => {
  const obs = observation("物品", 1000, null);
  const emptyName = scene.createDraftsFromObservations([obs], [obs.obsId], { batchLocation: "抽屉" })[0];
  emptyName.name = "";
  assert.equal(scene.buildSceneCommitItems([emptyName], [obs], 12000).ok, false);
  const emptyLocation = scene.createDraftsFromObservations([obs], [obs.obsId], { batchLocation: "" })[0];
  assert.equal(scene.buildSceneCommitItems([emptyLocation], [obs], 12000).ok, false);
  const noHighlight = scene.newSceneDraft({ name: "物品", locationText: "抽屉", observationIds: [] });
  assert.equal(scene.buildSceneCommitItems([noHighlight], [obs], 12000).ok, false);
  const many = [];
  for (let i = 0; i < 13; i++) {
    many.push(scene.newSceneDraft({ name: "物品" + i, locationText: "抽屉", manualHighlights: [{ start_ms: 0, end_ms: 100, box: null, frame_ms: 0 }] }));
  }
  const res = scene.buildSceneCommitItems(many, [], 12000);
  assert.equal(res.ok, false);
  assert.ok(res.message.indexOf("12") !== -1);
});
