"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const view = require("../miniprogram/utils/video-evidence.js");

function row(extra) {
  return Object.assign({
    evidence_id: "ve_1",
    item_id: "it_1",
    file_id: "cloud://bucket/video-evidence/hh_a/vt_1.mp4",
    video_url: "https://tmp/v.mp4",
    duration_ms: 12000,
    video_w: 1280,
    video_h: 720,
    captured_location_text: "书房 · 抽屉",
    consent_version: "v1",
    created_at: "2026-10-19T08:00:00.000Z",
  }, extra || {});
}

test("VIEW:视频默认视图、比例、位置变更与授权版本门", () => {
  const mapped = view.mapVideoEvidenceView([row()], "书房 · 抽屉");
  assert.ok(mapped);
  assert.equal(mapped.latest.aspect, "1280 / 720");
  assert.equal(mapped.latest.changed, false);
  assert.equal(mapped.latest.urlFail, false);
  assert.equal(view.mapVideoEvidenceView([row({ consent_version: "" })], "书房 · 抽屉"), null);
  const changed = view.mapVideoEvidenceView([row()], "客厅");
  assert.equal(changed.latest.changed, true);
});

test("VIEW:搜索角标只取授权有效且换链成功的最新视频", () => {
  const rows = [
    row({ file_id: "f1", video_url: "u1", created_at: "2026-10-19T08:00:00.000Z" }),
    row({ file_id: "f2", video_url: "u2", created_at: "2026-10-19T09:00:00.000Z" }),
    row({ item_id: "it_2", file_id: "f3", video_url: "u3" }),
    row({ item_id: "it_2", file_id: "f4", video_url: "", consent_version: "v1" }),
  ];
  const picked = view.pickVideoEvidence(rows, ["it_1", "it_2"]);
  assert.deepEqual(picked.it_1, { file_id: "f2", video_url: "u2" });
  assert.deepEqual(picked.it_2, { file_id: "f3", video_url: "u3" });
});
