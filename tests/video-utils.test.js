"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const frames = require("../miniprogram/utils/video-frames");
const evidence = require("../miniprogram/utils/video-evidence");

test("VIDEO-PLAN:采样点避开首尾且数量有上限", () => {
  assert.deepEqual(frames.planVideoFrameTimes(0, 8), []);
  assert.equal(frames.planVideoFrameTimes(1000, 8).length, 1);
  const times = frames.planVideoFrameTimes(10000, 8);
  assert.equal(times.length, 8);
  assert.ok(times[0] >= 500 && times[0] <= 1000);
  assert.ok(times[times.length - 1] <= 9500);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1]);
});

test("VIDEO-AGG:同名跨帧聚合为一件,保留逐帧高亮窗,置信度取高", () => {
  const out = frames.aggregateVideoRecognitions(
    [
      {
        time_ms: 1000,
        items: [
          { name: "黑色耳机", qty_note: "", confidence: "mid", box: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } },
          { name: "电池", qty_note: "", confidence: "low", box: null },
        ],
      },
      {
        time_ms: 2000,
        items: [
          { name: " 黑色耳机 ", qty_note: "一副", confidence: "high", box: { x1: 0.2, y1: 0.2, x2: 0.5, y2: 0.6 } },
        ],
      },
    ],
    10000,
    10,
  );
  assert.equal(out.length, 2);
  const earphone = out.find((x) => x.name === "黑色耳机");
  assert.ok(earphone);
  assert.equal(earphone.seen_count, 2);
  assert.equal(earphone.confidence, "high");
  assert.equal(earphone.qty_note, "一副");
  assert.equal(earphone.highlights.length, 2);
  assert.ok(earphone.highlights[1].box.x2 > 0.4);
});

test("VIDEO-VIEW:高亮时间窗映射百分比,currentTime 命中才出框", () => {
  const view = evidence.mapVideoEvidenceView(
    [
      {
        item_id: "it_1",
        file_id: "cloud://bucket/video-evidence/hh_a/v.mp4",
        video_url: "https://tmp/v.mp4",
        duration_ms: 12000,
        video_w: 1280,
        video_h: 720,
        highlights: [
          { start_ms: 1000, end_ms: 2500, box: { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.7 }, source: "vl" },
        ],
        captured_location_text: "书房 · 抽屉",
        source: "vl",
        created_at: "2026-10-19T08:00:00.000Z",
      },
    ],
    "书房 · 抽屉",
  );
  assert.ok(view);
  assert.equal(view.latest.aspect, "1280 / 720");
  assert.equal(view.latest.changed, false);
  assert.equal(view.latest.firstHighlightMs, 700);
  assert.deepEqual(evidence.highlightBoxAt(view.latest, 1200), {
    startMs: 1000,
    endMs: 2500,
    left: 10,
    top: 20,
    width: 40,
    height: 50,
  });
  assert.equal(evidence.highlightBoxAt(view.latest, 3000), null);
});

test("VIDEO-PICK:搜索角标取每件最新换链成功视频", () => {
  const rows = [
    { item_id: "a", file_id: "f1", video_url: "u1", created_at: "2026-10-19T08:00:00.000Z" },
    { item_id: "a", file_id: "f2", video_url: "u2", created_at: "2026-10-19T09:00:00.000Z" },
    { item_id: "b", file_id: "f3", video_url: "", created_at: "2026-10-19T09:00:00.000Z" },
  ];
  const out = evidence.pickVideoEvidence(rows, ["a", "b"]);
  assert.deepEqual(out.a, { file_id: "f2", video_url: "u2" });
  assert.equal(out.b, undefined);
  assert.equal(evidence.videoCloudPath("hh_a", new Date(1000), "x"), "video-evidence/hh_a/1000-x.mp4");
});
