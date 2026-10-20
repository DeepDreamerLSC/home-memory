"use strict";
// 单件视频 AI 查找 PR A:用户确认高亮保存/读取/删除互斥的离线合同测试。
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH_A = "hh_11111111111111111111111111111111";
const HH_B = "hh_22222222222222222222222222222222";

function makeDeps(db, opts) {
  opts = opts || {};
  let seq = 0;
  let clock = 1760000000000;
  return {
    db: db,
    householdId: opts.householdId || HH_A,
    householdShared: false,
    scopeRevision: null,
    now: () => new Date(clock).toISOString(),
    advance: (ms) => { clock += ms; },
    genId: () => { seq += 1; return "n" + String(seq).padStart(12, "0"); },
    getTempFileUrls: async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID: fileID, tempFileURL: "https://tmp.example/" + encodeURIComponent(fileID) })),
    }),
    deleteCloudFiles: opts.deleteCloudFiles || (async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID: fileID, status: 0, errMsg: "ok" })),
    })),
    logger: { log: () => {} },
  };
}

function freshDb() {
  return createMemoryDb({
    uniqueIndexes: {
      video_evidence: [["household_id", "item_id", "file_id"]],
    },
  });
}

async function rawDocs(db, name) {
  const res = await db.collection(name).where({}).get();
  return res.data || [];
}

async function createItem(deps, op) {
  const res = await handler({
    action: "create",
    operation_id: op,
    name: "黑色耳机",
    location_text: "书房 · 右侧抽屉",
  }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.item.item_id;
}

async function setupEvidence(deps, op) {
  const itemId = await createItem(deps, op || "op-video-highlight");
  const begin = await handler({ action: "videoUploadBegin", item_id: itemId, ext: "mp4" }, deps);
  assert.equal(begin.ok, true, JSON.stringify(begin));
  const fileId = "cloud://bucket/" + begin.upload_path;
  const receipt = await handler({
    action: "videoUploadReceipt",
    upload_ticket: begin.upload_ticket,
    file_id: fileId,
  }, deps);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  const attached = await handler({
    action: "videoEvidenceAttach",
    upload_ticket: begin.upload_ticket,
    file_id: fileId,
    duration_ms: 12000,
    video_w: 1280,
    video_h: 720,
    consent_version: "v1",
  }, deps);
  assert.equal(attached.ok, true, JSON.stringify(attached));
  return { itemId: itemId, evidenceId: attached.evidence.evidence_id, fileId: fileId, attached: attached };
}

function box(x1, y1, x2, y2) {
  return { x1: x1, y1: y1, x2: x2, y2: y2 };
}

function hl(start, end, candidateBox, frameMs) {
  const out = { start_ms: start, end_ms: end, box: candidateBox === undefined ? null : candidateBox };
  if (frameMs !== undefined) out.frame_ms = frameMs;
  return out;
}

function saveEvent(itemId, evidenceId, extra) {
  return Object.assign({
    action: "videoEvidenceHighlightSave",
    item_id: itemId,
    evidence_id: evidenceId,
    expected_highlight_version: 0,
    highlight_update_id: "upd_00000001",
    highlights: [hl(1000, 2500, box(0.1, 0.2, 0.4, 0.8), 1500)],
  }, extra || {});
}

test("HIGHLIGHT-SAVE:合法保存规范化排序、固定 source、版本递增且读侧返回 duration/highlights/version", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ctx = await setupEvidence(deps, "op-save-ok");
  assert.deepEqual(ctx.attached.evidence.highlights, []);
  assert.equal(ctx.attached.evidence.highlight_version, 0);

  const res = await handler(saveEvent(ctx.itemId, ctx.evidenceId, {
    highlights: [
      hl(5000, 6800, null),
      hl(1000, 2500, box(0.1, 0.2, 0.4, 0.8), 1500),
    ],
  }), deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.duplicated, false);
  assert.equal(res.highlight_version, 1);
  assert.equal(res.highlights.length, 2);
  assert.equal(res.highlights[0].start_ms, 1000, "服务端按 start_ms 升序规范化");
  assert.equal(res.highlights[0].frame_ms, 1500);
  assert.equal(res.highlights[0].source, "user_confirmed");
  assert.deepEqual(res.highlights[0].box, box(0.1, 0.2, 0.4, 0.8));
  assert.equal(res.highlights[1].box, null);
  assert.equal(res.highlights[1].source, "user_confirmed");

  const got = await handler({ action: "videoEvidenceGet", item_ids: [ctx.itemId] }, deps);
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.evidence[0].duration_ms, 12000);
  assert.equal(got.evidence[0].highlight_version, 1);
  assert.deepEqual(got.evidence[0].highlights, res.highlights);
  assert.equal(JSON.stringify(got.evidence[0]).indexOf("target_name"), -1, "读侧绝不透出 AI 原文/目标名");
  assert.equal((await rawDocs(db, "video_item_locks")).length, 0, "保存成功后释放 item 锁");
});

test("HIGHLIGHT-VALIDATION:输入形状、时间窗、归属、缺失证据、item 已删均零写", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ctx = await setupEvidence(deps, "op-save-invalid");
  const nine = [];
  for (let i = 0; i < 9; i++) nine.push(hl(i * 100, i * 100 + 50, null));

  const bad = [
    saveEvent(ctx.itemId, ctx.evidenceId, { highlights: [] }),
    saveEvent(ctx.itemId, ctx.evidenceId, { highlights: nine }),
    saveEvent(ctx.itemId, ctx.evidenceId, { highlights: [hl(100, 100, null)] }),
    saveEvent(ctx.itemId, ctx.evidenceId, { highlights: [hl(0, 12001, null)] }),
    saveEvent(ctx.itemId, ctx.evidenceId, { highlights: [hl(-1, 100, null)] }),
    saveEvent(ctx.itemId, ctx.evidenceId, { highlights: [hl(0, 100, box(0.2, 0.2, 0.2, 0.9))] }),
    saveEvent(ctx.itemId, ctx.evidenceId, { highlights: [hl(0, 100, box(-0.1, 0.2, 0.4, 0.9))] }),
    saveEvent(ctx.itemId, ctx.evidenceId, { highlights: [{ start_ms: 0, end_ms: 100 }] }),
    saveEvent(ctx.itemId, ctx.evidenceId, { highlights: [hl(1000, 2000, null, 999)] }),
    saveEvent(ctx.itemId, ctx.evidenceId, { highlights: [hl(1000, 2000, null, 2000)] }),
    saveEvent(ctx.itemId, ctx.evidenceId, { expected_highlight_version: -1 }),
    saveEvent(ctx.itemId, ctx.evidenceId, { expected_highlight_version: 1.5 }),
    saveEvent(ctx.itemId, ctx.evidenceId, { highlight_update_id: "short" }),
    saveEvent(ctx.itemId, ctx.evidenceId, { highlight_update_id: "x".repeat(65) }),
  ];
  for (let i = 0; i < bad.length; i++) {
    const res = await handler(bad[i], deps);
    assert.equal(res.ok, false, "非法输入应拒绝: " + JSON.stringify(bad[i]));
    assert.equal(res.error, "INVALID_INPUT", "第 " + i + " 个非法输入错误码");
  }

  const crossHome = await handler(saveEvent(ctx.itemId, ctx.evidenceId, {}), makeDeps(db, { householdId: HH_B }));
  assert.equal(crossHome.ok, false);
  assert.equal(crossHome.error, "NOT_FOUND", "跨家庭不得识别/写入他家证据");

  const noEvidence = await handler(saveEvent(ctx.itemId, "ve_missing", {}), deps);
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.error, "NOT_FOUND");

  let evidence = (await rawDocs(db, "video_evidence"))[0];
  assert.deepEqual(evidence.highlights, [], "任何非法/越权请求均零写");
  assert.equal(evidence.highlight_version, 0);

  const removed = await handler({ action: "delete", item_id: ctx.itemId }, deps);
  assert.equal(removed.ok, true, JSON.stringify(removed));
  const afterDelete = await handler(saveEvent(ctx.itemId, ctx.evidenceId, {}), deps);
  assert.equal(afterDelete.ok, false);
  assert.equal(afterDelete.error, "NOT_FOUND", "软删 item 后不能写高亮");
  evidence = (await rawDocs(db, "video_evidence"))[0];
  assert.equal(evidence, undefined, "删除 item 时证据随 cleanup 删除");
});

test("HIGHLIGHT-CAS-IDEMPOTENT:同 update_id 重放幂等、异内容冲突、版本 CAS 生效", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ctx = await setupEvidence(deps, "op-save-cas");
  const first = [
    hl(5000, 6800, null),
    hl(1000, 2500, box(0.1, 0.2, 0.4, 0.8), 1500),
  ];
  const firstRes = await handler(saveEvent(ctx.itemId, ctx.evidenceId, {
    highlight_update_id: "upd_cas_0001",
    highlights: first,
  }), deps);
  assert.equal(firstRes.ok, true, JSON.stringify(firstRes));
  assert.equal(firstRes.highlight_version, 1);

  const replay = await handler(saveEvent(ctx.itemId, ctx.evidenceId, {
    highlight_update_id: "upd_cas_0001",
    highlights: [first[1], first[0]],
    expected_highlight_version: 0,
  }), deps);
  assert.equal(replay.ok, true, "原 update_id 重放即使 expected 旧也应幂等成功");
  assert.equal(replay.duplicated, true);
  assert.equal(replay.highlight_version, 1);
  assert.deepEqual(replay.highlights, firstRes.highlights);

  const sameIdDiff = await handler(saveEvent(ctx.itemId, ctx.evidenceId, {
    highlight_update_id: "upd_cas_0001",
    highlights: [hl(100, 200, null)],
  }), deps);
  assert.equal(sameIdDiff.ok, false);
  assert.equal(sameIdDiff.error, "OPERATION_CONFLICT");

  const stale = await handler(saveEvent(ctx.itemId, ctx.evidenceId, {
    highlight_update_id: "upd_cas_0002",
    expected_highlight_version: 0,
    highlights: [hl(100, 200, null)],
  }), deps);
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "VERSION_CONFLICT");
  let raw = (await rawDocs(db, "video_evidence"))[0];
  assert.equal(raw.highlight_version, 1, "冲突/重放均不递增版本");

  const second = await handler(saveEvent(ctx.itemId, ctx.evidenceId, {
    highlight_update_id: "upd_cas_0002",
    expected_highlight_version: 1,
    highlights: [hl(100, 200, null)],
  }), deps);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.duplicated, false);
  assert.equal(second.highlight_version, 2);
  raw = (await rawDocs(db, "video_evidence"))[0];
  assert.equal(raw.highlight_version, 2);
  assert.equal(raw.highlight_update_id, "upd_cas_0002");
  assert.equal(typeof raw.highlight_updated_at, "string");
  assert.equal((await rawDocs(db, "video_item_locks")).length, 0);
});

test("HIGHLIGHT-LOCK:save 与 videoEvidenceDelete 共用物品锁,锁忙双方零写", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ctx = await setupEvidence(deps, "op-save-lock");
  await db.collection("video_item_locks").add({
    data: {
      _id: "vil_" + ctx.itemId,
      household_id: HH_A,
      item_id: ctx.itemId,
      owner_token: "other-owner",
      purpose: "delete",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  });

  const save = await handler(saveEvent(ctx.itemId, ctx.evidenceId, {}), deps);
  assert.equal(save.ok, false);
  assert.equal(save.error, "VIDEO_ITEM_BUSY");
  const del = await handler({ action: "videoEvidenceDelete", item_id: ctx.itemId, evidence_id: ctx.evidenceId }, deps);
  assert.equal(del.ok, false);
  assert.equal(del.error, "VIDEO_ITEM_BUSY");
  assert.equal((await rawDocs(db, "video_evidence")).length, 1, "锁忙时证据绝不被删");
  assert.equal((await rawDocs(db, "video_item_locks")).length, 1, "他人的未过期锁不得被覆盖");

  await db.collection("video_item_locks").doc("vil_" + ctx.itemId).remove();
  const retry = await handler(saveEvent(ctx.itemId, ctx.evidenceId, {}), deps);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal((await rawDocs(db, "video_item_locks")).length, 0);
});

test("HIGHLIGHT-DELETE-MUTEX:删证据持锁期间 save 被拒,删完不复活;失败也释放锁", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ctx = await setupEvidence(deps, "op-delete-mutex");
  const initial = await handler(saveEvent(ctx.itemId, ctx.evidenceId, {}), deps);
  assert.equal(initial.ok, true, JSON.stringify(initial));

  let interleaved = null;
  deps.deleteCloudFiles = async (ids) => {
    interleaved = await handler(saveEvent(ctx.itemId, ctx.evidenceId, {
      highlight_update_id: "upd_delete_interleave",
      expected_highlight_version: 1,
      highlights: [hl(3000, 4000, null)],
    }), deps);
    return { fileList: ids.map((fileID) => ({ fileID: fileID, status: 0 })) };
  };
  const deleted = await handler({ action: "videoEvidenceDelete", item_id: ctx.itemId, evidence_id: ctx.evidenceId }, deps);
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(interleaved.ok, false);
  assert.equal(interleaved.error, "VIDEO_ITEM_BUSY");
  assert.equal((await rawDocs(db, "video_evidence")).length, 0, "删除完成后证据不得被交错保存复活");
  assert.equal((await rawDocs(db, "video_item_locks")).length, 0, "删除成功 finally 释放锁");

  const ctx2 = await setupEvidence(deps, "op-delete-mutex-fail");
  deps.deleteCloudFiles = async (ids) => ({
    fileList: ids.map((fileID) => ({ fileID: fileID, status: -1 })),
  });
  const failed = await handler({ action: "videoEvidenceDelete", item_id: ctx2.itemId, evidence_id: ctx2.evidenceId }, deps);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "VIDEO_DELETE_FAILED");
  assert.equal((await rawDocs(db, "video_evidence")).length, 1, "云删失败保留证据行供重试");
  assert.equal((await rawDocs(db, "video_item_locks")).length, 0, "失败路径也必须释放锁");
});

test("HIGHLIGHT-READ-COMPAT:旧行/非法高亮返回 []/0,旧行无版本字段仍可 CAS 保存", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const itemId = await createItem(deps, "op-read-compat");
  await db.collection("video_evidence").add({
    data: {
      _id: "ve_legacy_row",
      household_id: HH_A,
      item_id: itemId,
      file_id: "cloud://bucket/video-evidence/" + HH_A + "/legacy.mp4",
      duration_ms: 12000,
      video_w: 1280,
      video_h: 720,
      captured_location_text: "书房",
      consent_version: "v1",
      source: "manual",
      created_at: "2026-10-19T00:00:00.000Z",
    },
  });

  const old = await handler({ action: "videoEvidenceGet", item_ids: [itemId] }, deps);
  assert.equal(old.ok, true, JSON.stringify(old));
  assert.equal(old.evidence[0].duration_ms, 12000);
  assert.deepEqual(old.evidence[0].highlights, []);
  assert.equal(old.evidence[0].highlight_version, 0);

  await db.collection("video_evidence").doc("ve_legacy_row").update({
    data: {
      highlights: [{ start_ms: 0, box: null, source: "user_confirmed" }],
      highlight_version: 3,
    },
  });
  const invalid = await handler({ action: "videoEvidenceGet", item_ids: [itemId] }, deps);
  assert.deepEqual(invalid.evidence[0].highlights, [], "缺字段的非法高亮不得展示");
  assert.equal(invalid.evidence[0].highlight_version, 0, "非法行版本按 0");

  await db.collection("video_evidence").doc("ve_legacy_row").update({
    data: {
      highlights: [{ start_ms: 0, end_ms: 1000, box: null, source: "ai_candidate" }],
      highlight_version: 3,
    },
  });
  const aiSource = await handler({ action: "videoEvidenceGet", item_ids: [itemId] }, deps);
  assert.deepEqual(aiSource.evidence[0].highlights, [], "非 user_confirmed 来源绝不透出");
  assert.equal(aiSource.evidence[0].highlight_version, 0);

  await db.collection("video_evidence").doc("ve_legacy_row").update({
    data: {
      highlights: [{ start_ms: 0, end_ms: 1000, box: null, source: "user_confirmed" }],
      highlight_version: 2,
    },
  });
  const good = await handler({ action: "videoEvidenceGet", item_ids: [itemId] }, deps);
  assert.equal(good.evidence[0].highlights.length, 1);
  assert.equal(good.evidence[0].highlight_version, 2);

  await db.collection("video_evidence").doc("ve_legacy_row").remove();
  await db.collection("video_evidence").add({
    data: {
      _id: "ve_legacy_plain",
      household_id: HH_A,
      item_id: itemId,
      file_id: "cloud://bucket/video-evidence/" + HH_A + "/legacy-plain.mp4",
      duration_ms: 12000,
      video_w: 1280,
      video_h: 720,
      captured_location_text: "书房",
      consent_version: "v1",
      source: "manual",
      created_at: "2026-10-20T00:00:00.000Z",
    },
  });
  const saved = await handler(saveEvent(itemId, "ve_legacy_plain", {
    expected_highlight_version: 0,
    highlight_update_id: "upd_legacy_01",
    highlights: [hl(100, 500, box(0.1, 0.1, 0.2, 0.2))],
  }), deps);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.highlight_version, 1, "旧行缺 highlight_version 时按 0 起始并写回");
  const after = (await rawDocs(db, "video_evidence"))[0];
  assert.equal(after._id, "ve_legacy_plain");
  assert.equal(after.highlight_version, 1);
  assert.equal(after.highlight_update_id, "upd_legacy_01");
});

test("HIGHLIGHT-CONCURRENT-LOCK:两个同版本保存并发时只有一个能持锁写入", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const ctx = await setupEvidence(deps, "op-save-concurrent");
  const results = await Promise.all([
    handler(saveEvent(ctx.itemId, ctx.evidenceId, {
      highlight_update_id: "upd_concurrent_a",
      highlights: [hl(1000, 2000, null)],
    }), deps),
    handler(saveEvent(ctx.itemId, ctx.evidenceId, {
      highlight_update_id: "upd_concurrent_b",
      highlights: [hl(3000, 4000, null)],
    }), deps),
  ]);
  const winners = results.filter((r) => r && r.ok === true);
  assert.equal(winners.length, 1, "同一 item 的并发高亮保存只能有一个成功: " + JSON.stringify(results));
  const losers = results.filter((r) => r && r.ok === false);
  assert.equal(losers.length, 1);
  assert.equal(
    losers[0].error === "VIDEO_ITEM_BUSY" || losers[0].error === "VERSION_CONFLICT",
    true,
    "竞争失败必须是锁忙或版本冲突,不能悄悄覆盖"
  );
  const raw = (await rawDocs(db, "video_evidence"))[0];
  assert.equal(raw.highlight_version, 1, "并发下版本只能递增一次");
  assert.equal((await rawDocs(db, "video_item_locks")).length, 0, "并发请求结束后不遗留锁");
});
