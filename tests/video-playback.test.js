"use strict";

// PR C 纯函数合同：高亮规范化、最佳目标、换链/多证据降级、同 file_id 多 item 隔离。
const test = require("node:test");
const assert = require("node:assert/strict");
const view = require("../miniprogram/utils/video-evidence.js");

function box(extra) {
  return Object.assign({ x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.8 }, extra || {});
}

function hl(start, end, b, source) {
  return { start_ms: start, end_ms: end, box: b === undefined ? null : b, source: source || "user_confirmed" };
}

function row(extra) {
  return Object.assign({
    evidence_id: "ve_1",
    item_id: "it_1",
    file_id: "cloud://bucket/video-evidence/hh_a/vt_1.mp4",
    video_url: "https://tmp.example/v1.mp4",
    duration_ms: 12000,
    video_w: 1280,
    video_h: 720,
    captured_location_text: "书房 · 抽屉",
    consent_version: "v1",
    highlights: [],
    highlight_version: 0,
    created_at: "2026-10-19T08:00:00.000Z",
  }, extra || {});
}

test("VIEW:只映射 user_confirmed 的合法时间窗与框;非法条目逐条丢弃", function () {
  const mapped = view.mapVideoEvidenceView([row({
    duration_ms: 12000,
    highlight_version: 2,
    highlights: [
      hl(1000, 3250, box({ x1: 0.1, y1: 0.2, x2: 0.6, y2: 0.8 })),
      hl(2000, 2000, null),
      hl(3000, 4000, box({ x1: 0.6, y1: 0.2, x2: 0.1, y2: 0.8 })),
      hl(4000, 5000, null, "ai_candidate"),
      hl(5000, 6000, null),
      hl(9000, 10000, undefined),
    ],
  })], "书房 · 抽屉");
  assert.ok(mapped);
  const latest = mapped.latest;
  assert.equal(latest.playable, true);
  assert.equal(latest.highlightVersion, 2);
  assert.equal(latest.highlightCount, 3, "1s 有框、5s 与 9s 无框共三条合法");
  assert.deepEqual(latest.highlights.map(function (h) { return h.timeText; }), ["0:01 - 0:03", "0:05 - 0:06", "0:09 - 0:10"]);
  assert.deepEqual(latest.highlights[0].box, { left: 10, top: 20, width: 50, height: 60 });
  assert.equal(latest.highlights[1].box, null);
  assert.equal(latest.primaryHighlight.startMs, 1000, "有框项优先作为默认点");
});

test("SELECT:最新行无高亮时选更早含确认高亮的可播行", function () {
  const rows = [
    row({ evidence_id: "ve_new", file_id: "f-new", video_url: "u-new", created_at: "2026-10-19T10:00:00.000Z", highlights: [] }),
    row({ evidence_id: "ve_old", file_id: "f-old", video_url: "u-old", created_at: "2026-10-18T10:00:00.000Z", highlights: [hl(1000, 2000, null)] }),
  ];
  const mapped = view.mapVideoEvidenceView(rows, "书房 · 抽屉");
  assert.ok(mapped);
  const target = view.selectVideoPlaybackTarget(mapped.all, "it_1");
  assert.equal(target.mode, "highlight");
  assert.equal(target.evidenceId, "ve_old");
  assert.equal(target.startMs, 1000);
  assert.equal(target.fallbackReason, "none");
});

test("SELECT:显式 hint 精确命中;时间窗变更时安全回退且保留原目标", function () {
  const rows = [row({
    evidence_id: "ve_hint",
    highlights: [hl(1200, 2500, null), hl(4000, 5000, box())],
  })];
  const mapped = view.mapVideoEvidenceView(rows, "书房 · 抽屉");
  assert.ok(mapped);
  const hit = view.selectVideoPlaybackTarget(mapped.all, "it_1", {
    evidenceId: "ve_hint",
    startMs: 1200,
    endMs: 2500,
  });
  assert.equal(hit.mode, "highlight");
  assert.equal(hit.startMs, 1200);

  const stale = view.selectVideoPlaybackTarget(mapped.all, "it_1", {
    evidenceId: "ve_hint",
    startMs: 1300,
    endMs: 2400,
  });
  assert.equal(stale.mode, "highlight");
  assert.equal(stale.requestedEvidenceId, "ve_hint");
  assert.equal(stale.fallbackReason, "explicit_highlight_missing");
  assert.equal(stale.startMs, 4000, "回退到默认有框点，不用 query 时间 seek");
});

test("SELECT:显式目标换链失败回退旧可播行;全部失败为 unavailable", function () {
  const rows = [
    row({ evidence_id: "ve_bad", file_id: "f-bad", video_url: "", created_at: "2026-10-19T10:00:00.000Z", highlights: [hl(1000, 2000, null)] }),
    row({ evidence_id: "ve_good", file_id: "f-good", video_url: "u-good", created_at: "2026-10-18T10:00:00.000Z", highlights: [hl(3000, 4000, null)] }),
  ];
  const mapped = view.mapVideoEvidenceView(rows, "书房 · 抽屉");
  assert.ok(mapped);
  const target = view.selectVideoPlaybackTarget(mapped.all, "it_1", {
    evidenceId: "ve_bad",
    startMs: 1000,
    endMs: 2000,
  });
  assert.equal(target.mode, "highlight");
  assert.equal(target.evidenceId, "ve_good");
  assert.equal(target.requestedEvidenceId, "ve_bad");
  assert.equal(target.fallbackReason, "explicit_url_failed");

  const allBad = view.mapVideoEvidenceView([
    row({ evidence_id: "ve_bad", video_url: "", highlights: [hl(1000, 2000, null)] }),
  ], "书房 · 抽屉");
  assert.ok(allBad);
  const unavailable = view.selectVideoPlaybackTarget(allBad.all, "it_1");
  assert.equal(unavailable.mode, "unavailable");
  assert.equal(unavailable.evidenceId, "ve_bad");
  assert.equal(unavailable.startMs, 0);
});

test("ITEM-ISOLATION:同 file_id 多 item 各自 highlights/badge 不串台", function () {
  const rows = [
    row({ evidence_id: "ve_a", item_id: "it_a", file_id: "same-file", highlights: [hl(1000, 2000, null)] }),
    row({ evidence_id: "ve_b", item_id: "it_b", file_id: "same-file", highlights: [hl(7000, 8000, null)] }),
  ];
  const hints = view.pickVideoPlaybackHints(rows, ["it_a", "it_b"]);
  assert.equal(hints.it_a.evidenceId, "ve_a");
  assert.equal(hints.it_a.startMs, 1000);
  assert.equal(hints.it_a.badgeText, "▶ 0:01");
  assert.equal(hints.it_b.evidenceId, "ve_b");
  assert.equal(hints.it_b.startMs, 7000);
  assert.notEqual(hints.it_a.evidenceId, hints.it_b.evidenceId);

  const aView = view.mapVideoEvidenceView(rows.filter(function (r) { return r.item_id === "it_a"; }), "");
  assert.ok(aView);
  const aTarget = view.selectVideoPlaybackTarget(aView.all, "it_a");
  assert.equal(aTarget.evidenceId, "ve_a");
  assert.equal(aTarget.startMs, 1000);
});

test("SEARCH-BADGE:有视频无高亮=▶ 视频;全部换链失败=▶ 暂不可播;无行不出角标", function () {
  const one = view.pickVideoPlaybackHints([
    row({ evidence_id: "ve_plain", highlights: [] }),
  ], ["it_1"]);
  assert.equal(one.it_1.badgeText, "▶ 视频");
  assert.equal(one.it_1.playable, true);
  assert.equal(one.it_1.startMs, null);

  const bad = view.pickVideoPlaybackHints([
    row({ evidence_id: "ve_bad", video_url: "", highlights: [hl(1000, 2000, null)] }),
  ], ["it_1"]);
  assert.equal(bad.it_1.badgeText, "▶ 暂不可播");
  assert.equal(bad.it_1.playable, false);
  assert.equal(bad.it_1.startMs, null);

  const none = view.pickVideoPlaybackHints([], ["it_1"]);
  assert.deepEqual(none, {});
});

test("COMPAT:旧行缺 highlights/版本仍可普通回放;搜索 hint 不携带 URL/box", function () {
  const mapped = view.mapVideoEvidenceView([row({ highlights: undefined, highlight_version: undefined })], "书房 · 抽屉");
  assert.ok(mapped);
  assert.deepEqual(mapped.latest.highlights, []);
  assert.equal(mapped.latest.highlightVersion, 0);
  assert.equal(mapped.latest.playable, true);
  assert.equal(Object.prototype.hasOwnProperty.call(mapped.latest, "videoUrl"), true);
  const hint = view.pickVideoPlaybackHints([row({ highlights: [hl(1000, 2000, box())] })], ["it_1"]).it_1;
  assert.equal(Object.prototype.hasOwnProperty.call(hint, "videoUrl"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(hint, "box"), false);
});

test("SELECT:显式目标全不可播时仍以原目标行作为重试目标", function () {
  const mapped = view.mapVideoEvidenceView([
    row({ evidence_id: "ve_req", video_url: "", highlights: [hl(1000, 2000, null)] }),
    row({ evidence_id: "ve_latest", video_url: "", created_at: "2026-10-19T11:00:00.000Z", highlights: [] }),
  ], "书房 · 抽屉");
  assert.ok(mapped);
  const target = view.selectVideoPlaybackTarget(mapped.all, "it_1", {
    evidenceId: "ve_req",
    startMs: 1000,
    endMs: 2000,
  });
  assert.equal(target.mode, "unavailable");
  assert.equal(target.evidenceId, "ve_req");
  assert.equal(target.requestedEvidenceId, "ve_req");
  assert.equal(target.fallbackReason, "explicit_url_failed");
});

test("SELECT:显式旧目标换链失败时不跳到更新的行;无更早可播则停留原行重试", function () {
  const mapped = view.mapVideoEvidenceView([
    row({ evidence_id: "ve_newer", http: "ok", created_at: "2026-10-19T11:00:00.000Z", highlights: [hl(7000, 8000, null)] }),
    row({ evidence_id: "ve_requested_old", video_url: "", created_at: "2026-10-19T10:00:00.000Z", highlights: [hl(1000, 2000, null)] }),
  ], "书房 · 抽屉");
  assert.ok(mapped);
  const target = view.selectVideoPlaybackTarget(mapped.all, "it_1", {
    evidenceId: "ve_requested_old",
    startMs: 1000,
    endMs: 2000,
  });
  assert.equal(target.mode, "unavailable");
  assert.equal(target.evidenceId, "ve_requested_old");
  assert.equal(target.requestedEvidenceId, "ve_requested_old");
  assert.equal(target.fallbackReason, "explicit_url_failed");
});
