"use strict";
// D2 历史列表合同(issue #96,docs/design/video-ai/D2-IMPLEMENTATION.md §2/§7 矩阵 A+E):
// itemsApi.locationScanHistory(新只读 action,不进 WRITE_ACTIONS):只列本位置
// active、精确 location_id 不含子树、函数内 created_at 倒序、HISTORY_LIMIT=20
// 截断 + has_more、投影白名单(无 file_id/asset_id/upload_ticket/confirmed_item_ids)、
// 已回收行 video_reclaimed:true + video_url:"" 且不参与换链、换链失败逐行降级
// 不废列表、他家 location_id 空列表、入参形状门(1-128,同 Latest)。
// locationScanLatest 同步增补:video_reclaimed 投影(置位时不调换链、video_url:"")。
// 可控时钟:直接构造 created_at 驱动排序/截断,无真时钟依赖。
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const HH_A = "hh_11111111111111111111111111111141";
const HH_B = "hh_22222222222222222222222222222242";
const DURATION = 12000;
const HISTORY_LIMIT = 20; // §2 冻结常量

// 投影白名单:除这 7 个字段外不得携带任何内部字段(§2「投影不含」)
const ROW_KEYS = ["candidate_count", "confirmed_count", "created_at", "duration_ms", "scan_id", "video_reclaimed", "video_url"];

let GLOBAL_SEQ = 5000;

function makeDeps(db, opts) {
  opts = opts || {};
  let clock = 1760000000000;
  const state = {
    failTempUrl: opts.failTempUrl === true,
    missingFiles: opts.missingFiles || [], // 这些 file_id 的换链结果缺失(单链接失败)
  };
  const tempCalls = [];
  return {
    db,
    state,
    tempCalls,
    householdId: opts.householdId || HH_A,
    householdShared: false,
    scopeRevision: null,
    now: () => new Date(clock).toISOString(),
    advance: (ms) => { clock += ms; },
    genId: () => { GLOBAL_SEQ += 1; return "n" + String(GLOBAL_SEQ).padStart(12, "0"); },
    getTempFileUrls: async (ids) => {
      tempCalls.push(ids.slice());
      if (state.failTempUrl === true) throw new Error("temp url down");
      return {
        fileList: ids
          .filter((fileID) => state.missingFiles.indexOf(fileID) === -1)
          .map((fileID) => ({ fileID, tempFileURL: "https://tmp.example/" + encodeURIComponent(fileID) })),
      };
    },
    deleteCloudFiles: async (ids) => ({
      fileList: ids.map((fileID) => ({ fileID, status: 0, errMsg: "ok" })),
    }),
    logger: { log: () => {} },
  };
}

function freshDb() {
  return createMemoryDb({
    uniqueIndexes: {
      video_evidence: [["household_id", "item_id", "file_id"]],
      location_scans: [["household_id", "scan_id"]],
      locations: [["household_id", "parent_id", "name_norm"]],
    },
  });
}

/** 直接注入 location_scans 行(D1 18 字段全集,D2 只增不改);file_id 逐行独立便于换链断言 */
async function seedScan(db, householdId, scanId, locationId, extra) {
  const doc = Object.assign({
    _id: "ls_" + scanId,
    household_id: householdId,
    scan_id: scanId,
    location_id: locationId,
    location_path_snapshot: ["书房", "书柜"],
    location_text_snapshot: "书房 / 书柜",
    file_id: "cloud://bucket/video-evidence/" + householdId + "/" + scanId + ".mp4",
    asset_id: "va_" + scanId,
    upload_ticket: "vt_" + scanId,
    duration_ms: DURATION,
    video_w: 1280,
    video_h: 720,
    candidate_count: 6,
    confirmed_count: 4,
    confirmed_item_ids: [],
    created_at: "2026-10-18T09:30:00.000Z",
    updated_at: "2026-10-18T09:31:00.000Z",
    status: "active",
  }, extra || {});
  await db.collection("location_scans").add({ data: doc });
  return doc;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

test("HIST-BASIC:多行 created_at 倒序;投影字段白名单(无内部字段)", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const base = Date.parse("2026-10-01T00:00:00.000Z");
  await seedScan(db, HH_A, "scan-hist-old", "lc_shelf", { created_at: iso(base) });
  await seedScan(db, HH_A, "scan-hist-mid", "lc_shelf", { created_at: iso(base + 3600 * 1000) });
  await seedScan(db, HH_A, "scan-hist-new", "lc_shelf", {
    created_at: iso(base + 7200 * 1000),
    candidate_count: 9,
    confirmed_count: 2,
    confirmed_item_ids: ["it_hist_a", "it_hist_b"], // 与 confirmed_count 一致(D1 落库同款),投影口径无关
    duration_ms: 8000,
  });
  const res = await handler({ action: "locationScanHistory", location_id: "lc_shelf" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.has_more, false);
  assert.equal(res.scans.length, 3);
  assert.deepEqual(res.scans.map((r) => r.scan_id), ["scan-hist-new", "scan-hist-mid", "scan-hist-old"], "函数内倒序,最新在前");
  for (const row of res.scans) {
    assert.deepEqual(Object.keys(row).sort(), ROW_KEYS, "投影只含冻结白名单字段");
    assert.equal(typeof row.video_url, "string");
  }
  const newest = res.scans[0];
  assert.equal(newest.created_at, iso(base + 7200 * 1000));
  assert.equal(newest.candidate_count, 9);
  assert.equal(newest.confirmed_count, 2, "confirmed_count 投影取行内原始计数(§2)");
  assert.equal(newest.duration_ms, 8000, "duration_ms 原样投影");
  assert.equal(newest.video_reclaimed, false, "未回收行缺省 false");
  assert.equal(newest.video_url.indexOf("https://tmp.example/") === 0, true, "未回收行换链");
  // 白名单外字段一律不透出
  assert.equal(newest.file_id, undefined);
  assert.equal(newest.asset_id, undefined);
  assert.equal(newest.upload_ticket, undefined);
  assert.equal(newest.confirmed_item_ids, undefined);
});

test("HIST-SCOPE:只列本 location_id,子位置与其他位置的 scan 不出现", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  await seedScan(db, HH_A, "scan-scope-shelf1", "lc_shelf", { created_at: "2026-10-15T08:00:00.000Z" });
  await seedScan(db, HH_A, "scan-scope-shelf2", "lc_shelf", { created_at: "2026-10-16T08:00:00.000Z" });
  await seedScan(db, HH_A, "scan-scope-layer", "lc_layer", { created_at: "2026-10-17T08:00:00.000Z" }); // 子位置
  await seedScan(db, HH_A, "scan-scope-kitchen", "lc_kitchen", { created_at: "2026-10-18T08:00:00.000Z" });
  const res = await handler({ action: "locationScanHistory", location_id: "lc_shelf" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.scans.map((r) => r.scan_id), ["scan-scope-shelf2", "scan-scope-shelf1"], "精确匹配,不含子树/其他位置");
});

test("HIST-STATUS:只列 active;location_deleted/deleted 行不出现", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  await seedScan(db, HH_A, "scan-st-active", "lc_shelf", { created_at: "2026-10-15T08:00:00.000Z" });
  await seedScan(db, HH_A, "scan-st-locdel", "lc_shelf", {
    created_at: "2026-10-16T08:00:00.000Z",
    status: "location_deleted",
    location_deleted_at: "2026-10-19T00:00:00.000Z",
  });
  await seedScan(db, HH_A, "scan-st-purged", "lc_shelf", {
    created_at: "2026-10-17T08:00:00.000Z",
    status: "deleted",
    deleted_at: "2026-10-19T00:00:00.000Z",
  });
  const res = await handler({ action: "locationScanHistory", location_id: "lc_shelf" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.scans.map((r) => r.scan_id), ["scan-st-active"], "只有 active 行进列表");
});

test("HIST-LIMIT:第 21 行起截断 scans=20 + has_more:true;恰好 20 行 → has_more:false", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const base = Date.parse("2026-09-01T00:00:00.000Z");
  for (let i = 0; i < 21; i++) {
    await seedScan(db, HH_A, "scan-limit-a" + String(i).padStart(2, "0"), "lc_shelf", {
      created_at: iso(base + i * 60000),
    });
  }
  const res = await handler({ action: "locationScanHistory", location_id: "lc_shelf" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.scans.length, HISTORY_LIMIT, "HISTORY_LIMIT=20 冻结常量");
  assert.equal(res.has_more, true, "21 行 → 第 21 行起截断标注");
  assert.equal(res.scans[0].scan_id, "scan-limit-a20", "倒序:最新在前");
  assert.equal(res.scans[19].scan_id, "scan-limit-a01", "截断掉的是最旧一行");
  assert.equal(res.scans.some((r) => r.scan_id === "scan-limit-a00"), false);

  // 恰好 20 行:截断标注不亮
  const db2 = freshDb();
  const deps2 = makeDeps(db2);
  for (let i = 0; i < 20; i++) {
    await seedScan(db2, HH_A, "scan-limit-b" + String(i).padStart(2, "0"), "lc_shelf", {
      created_at: iso(base + i * 60000),
    });
  }
  const res2 = await handler({ action: "locationScanHistory", location_id: "lc_shelf" }, deps2);
  assert.equal(res2.ok, true, JSON.stringify(res2));
  assert.equal(res2.scans.length, 20);
  assert.equal(res2.has_more, false, "恰好 20 行不标 has_more");
});

test("HIST-RECLAIMED:已回收行 video_reclaimed:true + video_url:\"\" 且不参与换链调用", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  const reclaimed = await seedScan(db, HH_A, "scan-rc-yes", "lc_shelf", {
    created_at: "2026-10-15T08:00:00.000Z",
    video_reclaimed_at: "2026-11-14T08:00:00.000Z",
    video_reclaim_reason: "zero_confirm_expired",
  });
  const alive = await seedScan(db, HH_A, "scan-rc-no", "lc_shelf", { created_at: "2026-10-16T08:00:00.000Z" });
  const res = await handler({ action: "locationScanHistory", location_id: "lc_shelf" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.scans.map((r) => r.scan_id), ["scan-rc-no", "scan-rc-yes"]);
  const rcRow = res.scans.find((r) => r.scan_id === "scan-rc-yes");
  assert.equal(rcRow.video_reclaimed, true);
  assert.equal(rcRow.video_url, "", "已回收行不给回看入口");
  const aliveRow = res.scans.find((r) => r.scan_id === "scan-rc-no");
  assert.equal(aliveRow.video_reclaimed, false);
  assert.equal(aliveRow.video_url.indexOf("https://tmp.example/") === 0, true);
  // 一次批量换链,且批量里只有未回收行的 file_id
  assert.equal(deps.tempCalls.length, 1, "未回收行一次批量 getTempFileUrls(§2)");
  const flat = deps.tempCalls.reduce((acc, cur) => acc.concat(cur), []);
  assert.equal(flat.indexOf(reclaimed.file_id), -1, "已回收行不参与换链");
  assert.deepEqual(flat, [alive.file_id]);
});

test("HIST-URL-DEGRADE:getTempFileUrls 异常/单链接缺失 → 仅该行 video_url:\"\",列表照常", async () => {
  // a) 整次换链抛异常:全部行 video_url:"",ok 不废
  const db1 = freshDb();
  const deps1 = makeDeps(db1, { failTempUrl: true });
  await seedScan(db1, HH_A, "scan-deg-a1", "lc_shelf", { created_at: "2026-10-15T08:00:00.000Z" });
  await seedScan(db1, HH_A, "scan-deg-a2", "lc_shelf", { created_at: "2026-10-16T08:00:00.000Z" });
  const res1 = await handler({ action: "locationScanHistory", location_id: "lc_shelf" }, deps1);
  assert.equal(res1.ok, true, JSON.stringify(res1));
  assert.equal(res1.scans.length, 2, "换链失败不废列表");
  for (const row of res1.scans) {
    assert.equal(row.video_url, "");
    assert.equal(row.video_reclaimed, false, "dangling 降级 ≠ 已回收,两态可区分");
  }

  // b) 批量里单链接缺失:仅该行降级,其余行照常换链
  const db2 = freshDb();
  const missing = await seedScan(db2, HH_A, "scan-deg-b1", "lc_shelf", { created_at: "2026-10-15T08:00:00.000Z" });
  await seedScan(db2, HH_A, "scan-deg-b2", "lc_shelf", { created_at: "2026-10-16T08:00:00.000Z" });
  const deps2 = makeDeps(db2, { missingFiles: [missing.file_id] });
  const res2 = await handler({ action: "locationScanHistory", location_id: "lc_shelf" }, deps2);
  assert.equal(res2.ok, true, JSON.stringify(res2));
  const degraded = res2.scans.find((r) => r.scan_id === "scan-deg-b1");
  const healthy = res2.scans.find((r) => r.scan_id === "scan-deg-b2");
  assert.equal(degraded.video_url, "", "单链接失败的行降级");
  assert.equal(degraded.video_reclaimed, false);
  assert.equal(healthy.video_url.indexOf("https://tmp.example/") === 0, true, "其余行照常");
});

test("HIST-EMPTY:无记录 → scans:[] + has_more:false;他家 location_id → 空列表(隔离)", async () => {
  const db = freshDb();
  const depsA = makeDeps(db);
  const depsB = makeDeps(db, { householdId: HH_B });
  const empty = await handler({ action: "locationScanHistory", location_id: "lc_shelf" }, depsA);
  assert.equal(empty.ok, true, JSON.stringify(empty));
  assert.deepEqual(empty.scans, []);
  assert.equal(empty.has_more, false);

  await seedScan(db, HH_A, "scan-empty-a", "lc_shelf");
  const cross = await handler({ action: "locationScanHistory", location_id: "lc_shelf" }, depsB);
  assert.equal(cross.ok, true, JSON.stringify(cross));
  assert.deepEqual(cross.scans, [], "他家 location_id → 空列表,同 Latest 语义不报 NOT_FOUND");
  assert.equal(cross.has_more, false);
});

test("HIST-SHAPE:location_id 缺失/超长 → INVALID_INPUT(阳性对照先行,防未知 action 空过)", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  // 阳性对照:合法入参必须是 ok(未知 action 会在这里暴露为 INVALID_INPUT)
  const okRes = await handler({ action: "locationScanHistory", location_id: "lc_shelf" }, deps);
  assert.equal(okRes.ok, true, JSON.stringify(okRes));
  assert.equal((await handler({ action: "locationScanHistory" }, deps)).error, "INVALID_INPUT");
  assert.equal((await handler({ action: "locationScanHistory", location_id: "" }, deps)).error, "INVALID_INPUT");
  assert.equal(
    (await handler({ action: "locationScanHistory", location_id: "x".repeat(129) }, deps)).error,
    "INVALID_INPUT",
  );
});

// ---------- §2 增补:locationScanLatest 的 video_reclaimed 投影(矩阵 E) ----------

test("LATEST-RECLAIMED:Latest 对已回收最新行 video_reclaimed:true + video_url:\"\"(不调换链)", async () => {
  const db = freshDb();
  const deps = makeDeps(db);
  await seedScan(db, HH_A, "scan-latest-rc", "lc_shelf", {
    video_reclaimed_at: "2026-11-14T08:00:00.000Z",
    video_reclaim_reason: "zero_confirm_expired",
  });
  const res = await handler({ action: "locationScanLatest", location_id: "lc_shelf" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.scan.scan_id, "scan-latest-rc");
  assert.equal(res.scan.video_reclaimed, true, "Latest 投影增 video_reclaimed(§2 增补)");
  assert.equal(res.video_url, "");
  assert.equal(deps.tempCalls.length, 0, "已回收行不调 getTempFileUrls");

  // 对照:未回收行缺省 false 且正常换链(「上次清点」与历史对最新一条显示一致)
  const db2 = freshDb();
  const deps2 = makeDeps(db2);
  await seedScan(db2, HH_A, "scan-latest-live", "lc_shelf");
  const res2 = await handler({ action: "locationScanLatest", location_id: "lc_shelf" }, deps2);
  assert.equal(res2.ok, true, JSON.stringify(res2));
  assert.equal(res2.scan.video_reclaimed, false);
  assert.equal(res2.video_url.indexOf("https://tmp.example/") === 0, true);
});

test("LATEST-DANGLING:换链失败 video_url:\"\" 不废查询,且与已回收两态可区分(钉住)", async () => {
  const db = freshDb();
  const deps = makeDeps(db, { missingFiles: ["cloud://bucket/video-evidence/" + HH_A + "/scan-dangling.mp4"] });
  await seedScan(db, HH_A, "scan-dangling", "lc_shelf", { confirmed_item_ids: ["it_gone"] });
  const latest = await handler({ action: "locationScanLatest", location_id: "lc_shelf" }, deps);
  assert.equal(latest.ok, true, JSON.stringify(latest));
  assert.equal(latest.scan.scan_id, "scan-dangling");
  assert.equal(latest.video_url, "", "dangling 换链失败降级");
  assert.equal(latest.scan.video_reclaimed, false, "未回收:dangling ≠ 已回收");

  const hist = await handler({ action: "locationScanHistory", location_id: "lc_shelf" }, deps);
  assert.equal(hist.ok, true, JSON.stringify(hist));
  assert.equal(hist.scans.length, 1);
  assert.equal(hist.scans[0].video_url, "");
  assert.equal(hist.scans[0].video_reclaimed, false);
});
