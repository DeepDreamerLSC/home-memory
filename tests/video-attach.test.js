"use strict";
// 单件视频留证客户端编排:上传票据、pending 恢复、失败不假装成功、删除。
const test = require("node:test");
const assert = require("node:assert/strict");
const attach = require("../miniprogram/utils/video-attach.js");
const { ApiError } = require("../miniprogram/utils/api.js");

function installStorage() {
  const store = new Map();
  global.wx = {
    getStorageSync: (k) => store.has(k) ? store.get(k) : "",
    setStorageSync: (k, v) => { store.set(k, v); },
    removeStorageSync: (k) => { store.delete(k); },
  };
  return () => { delete global.wx; };
}

function baseDeps(overrides) {
  return Object.assign({
    uploadFile: async () => ({ fileID: "cloud://bucket/video-evidence/hh_a/vt_12345678.mp4" }),
    begin: async () => ({
      upload_ticket: "vt_12345678",
      upload_path: "video-evidence/hh_a/vt_12345678.mp4",
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
    receipt: async () => ({ ok: true }),
    attach: async () => ({
      duplicated: false,
      evidence: {
        evidence_id: "ve_1",
        item_id: "it_1",
        file_id: "cloud://bucket/video-evidence/hh_a/vt_12345678.mp4",
        video_url: "https://tmp/v.mp4",
        duration_ms: 12000,
        video_w: 1280,
        video_h: 720,
        captured_location_text: "书房",
        consent_version: "v1",
        created_at: "2026-10-19T00:00:00.000Z",
      },
    }),
    cancel: async () => ({ state: "cancelled" }),
    now: () => 1760000000000,
  }, overrides || {});
}

function file() {
  return { path: "/tmp/a.mov", durationMs: 12000, width: 1280, height: 720, size: 100 };
}

test("VA-EXT:扩展名只接受 mp4/mov/m4v,其它按 mp4", () => {
  assert.equal(attach.videoExtOf("/tmp/a.MOV"), "mov");
  assert.equal(attach.videoExtOf("/tmp/a.m4v"), "m4v");
  assert.equal(attach.videoExtOf("/tmp/a.avi"), "mp4");
});

test("VA-OK:上传成功后绑定成功,pending 被清理", async () => {
  const restore = installStorage();
  try {
    const out = await attach.attachVideoToItem(
      { itemId: "it_1", scopeId: "hh_a", file: file() },
      baseDeps(),
    );
    assert.equal(out.ok, true);
    assert.equal(attach.loadPendingVideo("hh_a", "it_1"), null);
  } finally {
    restore();
  }
});

test("VA-PENDING:上传成功但绑定失败时保留 pending,重试成功后才清理", async () => {
  const restore = installStorage();
  try {
    let fail = true;
    const deps = baseDeps({
      attach: async () => {
        if (fail) throw new Error("network");
        return {
          duplicated: true,
          evidence: {
            evidence_id: "ve_1", item_id: "it_1",
            file_id: "cloud://bucket/video-evidence/hh_a/vt_12345678.mp4",
            video_url: "https://tmp/v.mp4", duration_ms: 12000,
            video_w: 1280, video_h: 720, captured_location_text: "书房",
            consent_version: "v1", created_at: "2026-10-19T00:00:00.000Z",
          },
        };
      },
    });
    const out = await attach.attachVideoToItem({ itemId: "it_1", scopeId: "hh_a", file: file() }, deps);
    assert.equal(out.ok, false);
    const pending = attach.loadPendingVideo("hh_a", "it_1");
    assert.ok(pending);
    assert.equal(pending.uploadTicket, "vt_12345678");
    assert.equal(pending.expiresAt, "2099-01-01T00:00:00.000Z");
    fail = false;
    const retry = await attach.retryPendingVideo(pending, deps);
    assert.equal(retry.ok, true);
    assert.equal(attach.loadPendingVideo("hh_a", "it_1"), null);
  } finally {
    restore();
  }
});

test("VA-DISCARD:由服务端判断删除;失败保留 pending,成功后清理", async () => {
  const restore = installStorage();
  try {
    let fail = true;
    const deps = baseDeps({
      cancel: async () => {
        if (fail) throw new ApiError("VIDEO_DELETE_FAILED", "删除失败");
        return { state: "cancelled" };
      },
      attach: async () => { throw new Error("network"); },
    });
    const out = await attach.attachVideoToItem({ itemId: "it_1", scopeId: "hh_a", file: file() }, deps);
    assert.equal(out.ok, false);
    const pending = attach.loadPendingVideo("hh_a", "it_1");
    assert.ok(pending);
    const bad = await attach.discardPendingVideo(pending, deps);
    assert.equal(bad.ok, false);
    assert.ok(attach.loadPendingVideo("hh_a", "it_1"));
    fail = false;
    const ok = await attach.discardPendingVideo(pending, deps);
    assert.equal(ok.ok, true);
    assert.equal(ok.state, "cancelled");
    assert.equal(attach.loadPendingVideo("hh_a", "it_1"), null);
  } finally {
    restore();
  }
});

test("VA-EXPIRED:票据过期时返回明确 expired,保留 pending 供删除", async () => {
  const restore = installStorage();
  try {
    const deps = baseDeps({
      receipt: async () => { throw new ApiError("VIDEO_TICKET_EXPIRED", "过期"); },
    });
    const out = await attach.attachVideoToItem({ itemId: "it_1", scopeId: "hh_a", file: file() }, deps);
    assert.equal(out.ok, false);
    assert.equal(out.expired, true);
    assert.ok(attach.loadPendingVideo("hh_a", "it_1"));
  } finally {
    restore();
  }
});

test("VA-CANCEL-BOUND:服务端发现已绑定时不删文件,客户端恢复正式证据", async () => {
  const restore = installStorage();
  try {
    const deps = baseDeps({
      cancel: async () => ({
        state: "bound",
        evidence: {
          evidence_id: "ve_1", item_id: "it_1",
          file_id: "cloud://bucket/video-evidence/hh_a/vt_12345678.mp4",
          video_url: "https://tmp/v.mp4", duration_ms: 12000,
          video_w: 1280, video_h: 720, captured_location_text: "书房",
          consent_version: "v1", created_at: "2026-10-19T00:00:00.000Z",
        },
      }),
      attach: async () => { throw new Error("network"); },
    });
    const out = await attach.attachVideoToItem({ itemId: "it_1", scopeId: "hh_a", file: file() }, deps);
    assert.equal(out.ok, false);
    const pending = attach.loadPendingVideo("hh_a", "it_1");
    assert.ok(pending);
    const discarded = await attach.discardPendingVideo(pending, deps);
    assert.equal(discarded.ok, true);
    assert.equal(discarded.state, "bound");
    assert.equal(discarded.evidence.evidence_id, "ve_1");
    assert.equal(attach.loadPendingVideo("hh_a", "it_1"), null);
  } finally {
    restore();
  }
});
