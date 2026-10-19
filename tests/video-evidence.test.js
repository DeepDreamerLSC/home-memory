"use strict";
// 视频证据(video_evidence)离线合同测试:建档、回放换链、幂等重试、归属验证。
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH_A = "hh_11111111111111111111111111111111";
const HH_B = "hh_22222222222222222222222222222222";
const FILE_A = "cloud://bucket/video-evidence/" + HH_A + "/scan-1.mp4";

function makeDeps(db, opts) {
  opts = opts || {};
  let seq = 0;
  let clock = 1760000000000;
  return {
    db,
    householdId: opts.householdId || HH_A,
    householdShared: false,
    scopeRevision: null,
    now: () => {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    genId: () => {
      seq += 1;
      return "v" + seq;
    },
    getTempFileUrls: opts.getTempFileUrls,
    logger: { log: () => {} },
  };
}

function freshDb() {
  return createMemoryDb({
    uniqueIndexes: { video_evidence: [["household_id", "item_id", "file_id"]] },
  });
}

function video(fileId) {
  return {
    file_id: fileId || FILE_A,
    duration_ms: 12000,
    video_w: 1280,
    video_h: 720,
  };
}

function commitEvent(items, extra) {
  return Object.assign(
    { action: "videoCommit", batch_id: "batch-video-1", video: video(), items },
    extra || {},
  );
}

function item(op, extra) {
  return Object.assign(
    {
      operation_id: op,
      name: "黑色耳机",
      location_text: "书房 · 右侧抽屉",
      highlights: [
        { start_ms: 1000, end_ms: 2600, box: { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.6 }, source: "vl" },
      ],
    },
    extra || {},
  );
}

async function rawDocs(db, name) {
  const res = await db.collection(name).where({}).get();
  return res.data || [];
}

test("VIDEO-COMMIT:批量建档并落视频证据/时间窗/0-1 框", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const res = await handler(
    commitEvent([
      item("op-a"),
      item("op-b", {
        name: "五号电池",
        highlights: [{ start_ms: 4000, end_ms: 5000, box: null, source: "manual" }],
      }),
    ]),
    deps,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results.length, 2);
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[0].evidence_saved, true);
  assert.equal(res.evidence_failed, undefined);

  const items = await rawDocs(db, "items");
  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(items.length, 2);
  assert.equal(evidence.length, 2);
  assert.ok(evidence[0]._id.indexOf("ve_") === 0);
  assert.equal(evidence[0].file_id, FILE_A);
  assert.equal(evidence[0].duration_ms, 12000);
  assert.equal(evidence[0].video_w, 1280);
  assert.deepEqual(evidence[0].highlights[0].box, { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.6 });
  assert.equal(evidence[0].captured_location_text, "书房 · 右侧抽屉");
  assert.equal(evidence[1].highlights[0].source, "manual");
});

test("VIDEO-EVIDENCE-GET:换链、最新排序、已删物品过滤", async () => {
  const db = freshDb();
  const seen = [];
  const deps = makeDeps(db, {
    getTempFileUrls: async (ids) => {
      seen.push(ids.slice());
      return { fileList: ids.map((id) => ({ fileID: id, tempFileURL: "https://tmp.example/video.mp4" })) };
    },
  });
  const first = await handler(commitEvent([item("op-a")]), deps);
  const itemId = first.results[0].item_id;
  // 同一 item 的第二段视频(不同 file_id)应排在最前
  const secondFile = "cloud://bucket/video-evidence/" + HH_A + "/scan-2.mp4";
  await handler(commitEvent([item("op-a", { highlights: [] })], { video: video(secondFile) }), deps);

  const got = await handler({ action: "videoEvidenceGet", item_ids: [itemId] }, deps);
  assert.equal(got.ok, true);
  assert.equal(got.evidence.length, 2);
  assert.equal(got.evidence[0].file_id, secondFile);
  assert.equal(got.evidence[0].video_url, "https://tmp.example/video.mp4");
  assert.deepEqual(got.evidence[0].highlights, []);
  assert.ok(seen.length >= 1);

  await db.collection("items").where({ _id: itemId }).update({ data: { deleted: true } });
  const gone = await handler({ action: "videoEvidenceGet", item_ids: [itemId] }, deps);
  assert.deepEqual(gone.evidence, []);
});

test("VIDEO-RETRY:证据幂等补关联,原键重放不重复", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const first = await handler(commitEvent([item("op-a")]), deps);
  const itemId = first.results[0].item_id;
  const retry = await handler(
    {
      action: "videoEvidenceRetry",
      video: video(),
      items: [{ item_id: itemId, highlights: item("op-a").highlights }],
    },
    deps,
  );
  assert.equal(retry.ok, true);
  assert.equal(retry.results[0].ok, true);
  assert.equal(retry.results[0].evidence_saved, false);
  const evidence = await rawDocs(db, "video_evidence");
  assert.equal(evidence.length, 1);
});

test("VIDEO-VALIDATE:跨家庭 file_id 与非法时间窗零写入,非法行整批拒绝", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const denied = await handler(
    commitEvent([item("op-a")], {
      video: video("cloud://bucket/video-evidence/" + HH_B + "/other.mp4"),
    }),
    deps,
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "FILE_NOT_OWNED");
  assert.equal((await rawDocs(db, "items")).length, 0);

  const bad = await handler(
    commitEvent([
      item("op-a"),
      item("op-b", { highlights: [{ start_ms: 5000, end_ms: 1000, box: null }] }),
    ]),
    deps,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "INVALID_INPUT");
  assert.equal((await rawDocs(db, "items")).length, 0);
  assert.equal((await rawDocs(db, "video_evidence")).length, 0);
});
