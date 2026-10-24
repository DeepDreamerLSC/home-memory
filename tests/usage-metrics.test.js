"use strict";
/**
 * 视频确认流零隐私使用埋点(#85/#76 降本阶梯第 2 级)——纯函数与云函数半边测试(先于实现)。
 *
 * 覆盖:
 * - 服务端 cloudfunctions/usageMetrics/lib/handler.js:形状门(kind/platform/counts/ms
 *   全部先于写入,违规 {ok:false,error:"INVALID_INPUT"} 零写)、合法纯 append
 *   (usage_metrics 插行,created_at=服务端时间)、DB 写失败不抛、日志白名单
 *   (只记 action/error/ms/count 四键);
 * - 客户端 miniprogram/utils/usage-metrics.js(build:mp 产物):buildUsagePing
 *   同款形状门、detectUsagePlatform 归一、会话计数器原语、buildVideoConfirmUsagePing
 *   (ms 钳制)、shouldReportUsageAbandon 阶段门;
 * - 两端冻结常量同源(USAGE_KINDS/USAGE_PLATFORMS/USAGE_COUNT_KEYS/边界值,
 *   两个部署包不能互 require,由本文件锁定一致);
 * - 静态无 PII 扫描:usage 相关源码绝不含 openid/getWXContext/name 字段引用。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const handler = require("../cloudfunctions/usageMetrics/lib/handler");
const usage = require("../miniprogram/utils/usage-metrics.js");
const createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

const NOW = "2026-10-24T08:00:00.000Z";
const COLLECTION = "usage_metrics";

function validEvent(extra) {
  return Object.assign({
    kind: "video_confirm_save",
    platform: "ios",
    counts: { observations: 6, groups: 2, drafts: 3, merges: 1, splits: 0, removes: 0, manualAdds: 0 },
    ms: 42000,
  }, extra || {});
}

async function run(event, deps) {
  const logs = [];
  const db = (deps && deps.db) || createMemoryDb({});
  const res = await handler.handler({
    event,
    db,
    now: () => NOW,
    logger: { log: (entry) => logs.push(entry) },
  });
  const rows = (await db.collection(COLLECTION).where({}).get()).data;
  return { res, rows, logs };
}

/* ---------------- 服务端:形状门全部先于写入 ---------------- */

test("METRICS-SRV-OK:合法载荷纯 append 一行(created_at=服务端时间),返回 ok:true", async () => {
  const { res, rows, logs } = await run(validEvent());
  assert.deepEqual(res, { ok: true });
  assert.equal(rows.length, 1, "恰好插一行");
  assert.deepEqual(rows[0].kind, "video_confirm_save");
  assert.deepEqual(rows[0].platform, "ios");
  assert.deepEqual(rows[0].counts, validEvent().counts);
  assert.equal(rows[0].ms, 42000);
  assert.equal(rows[0].created_at, NOW, "created_at 取服务端时间,不信任客户端");
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]).sort(), ["action", "count", "error", "ms"], "日志白名单四键");
  assert.deepEqual(
    { action: logs[0].action, error: logs[0].error, count: logs[0].count },
    { action: "record", error: null, count: 1 },
  );
  assert.ok(Number.isInteger(logs[0].ms) && logs[0].ms >= 0, "日志 ms 为非负整数");
});

test("METRICS-SRV-BOUNDARY:counts 空对象/全键 0 与 100000、ms 0 与 3600000 均合法", async () => {
  for (const ev of [
    validEvent({ counts: {} }),
    validEvent({ counts: { observations: 0, groups: 0, drafts: 0, merges: 0, splits: 0, removes: 0, manualAdds: 0 } }),
    validEvent({ counts: { observations: 100000 } }),
    validEvent({ ms: 0 }),
    validEvent({ ms: 3600000 }),
  ]) {
    const { res, rows } = await run(ev);
    assert.equal(res.ok, true, JSON.stringify(ev));
    assert.equal(rows.length, 1);
  }
});

test("METRICS-SRV-GATE:任何违规返回 INVALID_INPUT 且零写(先于写入,不产生半行)", async () => {
  const bad = [
    ["kind 闭集外", validEvent({ kind: "video_confirm_other" })],
    ["kind 缺省", validEvent({ kind: undefined })],
    ["kind 非串", validEvent({ kind: 1 })],
    ["platform 闭集外", validEvent({ platform: "mac" })],
    ["platform 缺省", validEvent({ platform: undefined })],
    ["counts 含闭集外键", validEvent({ counts: { observations: 1, openid: 2 } })],
    ["counts 数组", validEvent({ counts: [] })],
    ["counts null", validEvent({ counts: null })],
    ["counts 缺省", validEvent({ counts: undefined })],
    ["counts 值非整数", validEvent({ counts: { observations: 1.5 } })],
    ["counts 值负数", validEvent({ counts: { observations: -1 } })],
    ["counts 值超上界", validEvent({ counts: { observations: 100001 } })],
    ["counts 值字符串", validEvent({ counts: { observations: "6" } })],
    ["ms 负数", validEvent({ ms: -1 })],
    ["ms 超上界", validEvent({ ms: 3600001 })],
    ["ms 非整数", validEvent({ ms: 42.5 })],
    ["ms 字符串", validEvent({ ms: "42000" })],
    ["ms 缺省", validEvent({ ms: undefined })],
    ["载荷非对象", "not-an-object"],
    ["载荷 null", null],
  ];
  for (const [label, ev] of bad) {
    const { res, rows, logs } = await run(ev);
    assert.deepEqual(res, { ok: false, error: "INVALID_INPUT" }, label);
    assert.equal(rows.length, 0, label + ":零写");
    assert.equal(logs.length, 1, label + ":违规也记一条白名单日志");
    assert.deepEqual(Object.keys(logs[0]).sort(), ["action", "count", "error", "ms"], label + ":日志白名单四键");
    assert.equal(logs[0].error, "INVALID_INPUT");
    assert.equal(logs[0].count, 0);
  }
});

test("METRICS-SRV-DBFAIL:集合写入失败不抛,返回 DB_WRITE_FAILED 并记白名单日志", async () => {
  const logs = [];
  const failingDb = {
    collection: () => ({ add: () => Promise.reject(new Error("collection.add:fail -502001")) }),
  };
  const res = await handler.handler({
    event: validEvent(),
    db: failingDb,
    now: () => NOW,
    logger: { log: (entry) => logs.push(entry) },
  });
  assert.deepEqual(res, { ok: false, error: "DB_WRITE_FAILED" });
  assert.equal(logs.length, 1);
  assert.deepEqual(
    { action: logs[0].action, error: logs[0].error, count: logs[0].count },
    { action: "record", error: "DB_WRITE_FAILED", count: 0 },
  );
  assert.deepEqual(Object.keys(logs[0]).sort(), ["action", "count", "error", "ms"]);
});

test("METRICS-SRV-NOQUERY:服务端只 append——handler 绝不触发 update/remove(纯插行)", async () => {
  const db = createMemoryDb({});
  const touched = [];
  const wrap = {
    collection: (n) => {
      const c = db.collection(n);
      return {
        add: (o) => { touched.push("add"); return c.add(o); },
        where: () => { touched.push("where"); return c.where({}); },
        doc: (id) => { touched.push("doc"); return c.doc(id); },
      };
    },
  };
  await handler.handler({ event: validEvent(), db: wrap, now: () => NOW });
  await handler.handler({ event: validEvent({ kind: "video_confirm_abandon" }), db: wrap, now: () => NOW });
  assert.deepEqual(touched, ["add", "add"], "两次上报只有两次 add,无 where/doc");
});

/* ---------------- 两端冻结常量同源(部署包隔离,测试锁定) ---------------- */

test("METRICS-CONSTS:客户端与服务端冻结闭集逐项一致(两端互指债务由本测试钉死)", () => {
  assert.deepEqual(usage.USAGE_KINDS, handler.USAGE_KINDS);
  assert.deepEqual(usage.USAGE_PLATFORMS, handler.USAGE_PLATFORMS);
  assert.deepEqual(usage.USAGE_COUNT_KEYS, handler.USAGE_COUNT_KEYS);
  assert.deepEqual(usage.USAGE_KINDS, ["video_confirm_save", "video_confirm_abandon"]);
  assert.deepEqual(usage.USAGE_PLATFORMS, ["ios", "android", "devtools", "unknown"]);
  assert.deepEqual(
    usage.USAGE_COUNT_KEYS,
    ["observations", "groups", "drafts", "merges", "splits", "removes", "manualAdds"],
  );
  assert.equal(usage.USAGE_COUNT_MAX, handler.USAGE_COUNT_MAX);
  assert.equal(usage.USAGE_MS_MAX, handler.USAGE_MS_MAX);
  assert.equal(handler.USAGE_COUNT_MAX, 100000);
  assert.equal(handler.USAGE_MS_MAX, 3600000);
});

/* ---------------- 客户端:buildUsagePing 同款形状门(纯函数,node 直测) ---------------- */

test("METRICS-CLIENT-BUILD:合法载荷原样成 ping;违规一律 null(与服务端同门)", () => {
  const counts = { observations: 6, groups: 2, drafts: 3, merges: 1, splits: 0, removes: 0, manualAdds: 0 };
  assert.deepEqual(
    usage.buildUsagePing("video_confirm_save", "devtools", counts, 1500),
    { kind: "video_confirm_save", platform: "devtools", counts, ms: 1500 },
  );
  const bad = [
    ["kind 闭集外", ["video_confirm_other", "ios", counts, 100]],
    ["platform 闭集外", ["video_confirm_save", "windows", counts, 100]],
    ["counts 闭集外键", ["video_confirm_save", "ios", { foo: 1 }, 100]],
    ["counts 值越界", ["video_confirm_save", "ios", { observations: 100001 }, 100]],
    ["counts 非对象", ["video_confirm_save", "ios", [], 100]],
    ["ms 越界", ["video_confirm_save", "ios", counts, 3600001]],
    ["ms 非整数", ["video_confirm_save", "ios", counts, 1.5]],
    ["kind 缺省", [undefined, "ios", counts, 100]],
  ];
  for (const [label, args] of bad) {
    assert.equal(usage.buildUsagePing.apply(null, args), null, label);
  }
});

test("METRICS-CLIENT-PLATFORM:wx.getSystemInfoSync().platform 归一到闭集,异常/缺失归 unknown", () => {
  const cases = [
    ["ios", "ios"],
    ["android", "android"],
    ["devtools", "devtools"],
    ["mac", "unknown"],
    ["", "unknown"],
  ];
  const prevWx = globalThis.wx;
  for (const [raw, want] of cases) {
    globalThis.wx = { getSystemInfoSync: () => ({ platform: raw }) };
    assert.equal(usage.detectUsagePlatform(), want, "platform=" + JSON.stringify(raw));
  }
  globalThis.wx = { getSystemInfoSync: () => { throw new Error("boom"); } };
  assert.equal(usage.detectUsagePlatform(), "unknown", "抛异常归 unknown");
  globalThis.wx = {};
  assert.equal(usage.detectUsagePlatform(), "unknown", "缺 getSystemInfoSync 归 unknown");
  delete globalThis.wx;
  assert.equal(usage.detectUsagePlatform(), "unknown", "缺 wx 全局归 unknown");
  globalThis.wx = prevWx;
});

/* ---------------- 客户端:会话计数器与确认流 ping 构建 ---------------- */

test("METRICS-CLIENT-SESSION:reset/bump/elapsed 原语;恢复会话只补起点不重置计数", () => {
  const s = usage.createUsageSession();
  assert.equal(s.startedAtMs, null);
  assert.equal(s.merges, 0);
  usage.resetUsageSession(s, 1000);
  assert.equal(s.startedAtMs, 1000);
  usage.bumpUsageCount(s, "merges");
  usage.bumpUsageCount(s, "merges");
  usage.bumpUsageCount(s, "splits");
  assert.equal(s.merges, 2);
  assert.equal(s.splits, 1);
  assert.equal(s.removes, 0);
  // 恢复会话(起点为 null)只补起点;已有起点不动
  const restored = usage.createUsageSession();
  usage.bumpUsageCount(restored, "manualAdds");
  usage.markUsageSessionStart(restored, 5000);
  usage.markUsageSessionStart(restored, 9000);
  assert.equal(restored.startedAtMs, 5000, "起点只补一次");
  assert.equal(restored.manualAdds, 1, "补起点不清计数");
});

test("METRICS-CLIENT-CONFIRM-PING:save/abandon ping 七键计数 + 钳制 ms;超 1h 钳到上界", () => {
  const s = usage.createUsageSession();
  usage.resetUsageSession(s, 1_000);
  usage.bumpUsageCount(s, "merges");
  usage.bumpUsageCount(s, "removes");
  const ping = usage.buildVideoConfirmUsagePing(
    s, "video_confirm_save", "devtools",
    { observations: 6, groups: 2, drafts: 3 }, 61_000,
  );
  assert.deepEqual(ping, {
    kind: "video_confirm_save",
    platform: "devtools",
    counts: { observations: 6, groups: 2, drafts: 3, merges: 1, splits: 0, removes: 1, manualAdds: 0 },
    ms: 60_000,
  }, "counts=快照三键+会话四键全量携带,ms=elapsed 钳制");
  // 起点 null(极端恢复窗口)→ ms 0,不废 ping
  const noStart = usage.createUsageSession();
  assert.equal(usage.buildVideoConfirmUsagePing(noStart, "video_confirm_abandon", "ios", { observations: 1, groups: 1, drafts: 0 }, 9_999).ms, 0);
  // 超 1h(24h 恢复会话再保存)钳到 3600000,绝不出门被服务端拒
  const long = usage.createUsageSession();
  usage.resetUsageSession(long, 0);
  assert.equal(usage.buildVideoConfirmUsagePing(long, "video_confirm_save", "ios", { observations: 1, groups: 1, drafts: 1 }, 3_600_000 + 5_000).ms, 3_600_000);
});

test("METRICS-CLIENT-ABANDON-GATE:仅 review/partial/failed 且有扫描结果且未报过才放行", () => {
  const mk = () => { const s = usage.createUsageSession(); usage.resetUsageSession(s, 1); return s; };
  assert.equal(usage.shouldReportUsageAbandon(mk(), "review", 3), true);
  assert.equal(usage.shouldReportUsageAbandon(mk(), "partial", 3), true);
  assert.equal(usage.shouldReportUsageAbandon(mk(), "failed", 3), true);
  for (const phase of ["idle", "scanning", "uploading", "committing", "done"]) {
    assert.equal(usage.shouldReportUsageAbandon(mk(), phase, 3), false, "phase=" + phase + " 不报 abandon");
  }
  assert.equal(usage.shouldReportUsageAbandon(mk(), "review", 0), false, "无扫描结果不报");
  const saved = mk();
  usage.markUsageSaved(saved);
  assert.equal(usage.shouldReportUsageAbandon(saved, "review", 3), false, "已 save 不再 abandon");
  const abandoned = mk();
  usage.markUsageAbandoned(abandoned);
  assert.equal(usage.shouldReportUsageAbandon(abandoned, "review", 3), false, "已 abandon 不重复");
});

test("METRICS-CLIENT-SEND:sendUsagePing fire-and-forget——null 静默、无 wx.cloud 静默、fail 全吞不抛", async () => {
  const calls = [];
  const prevWx = globalThis.wx;
  // null 载荷:零调用零异常
  globalThis.wx = { cloud: { callFunction: (o) => { calls.push(o); } } };
  usage.sendUsagePing(null);
  assert.equal(calls.length, 0);
  // 正常路径:一次 usageMetrics 调用,不 await、不重试
  usage.sendUsagePing(usage.buildUsagePing("video_confirm_save", "ios", { observations: 1 }, 10));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "usageMetrics");
  assert.equal(calls[0].data.kind, "video_confirm_save");
  // 回调式 fail:全吞
  globalThis.wx = { cloud: { callFunction: (o) => { if (o && o.fail) o.fail({ errMsg: "fail" }); } } };
  usage.sendUsagePing(usage.buildUsagePing("video_confirm_save", "ios", {}, 10));
  // Promise 式 reject:全吞(node:test 会在未处理拒绝时报警,此调用本身即验证不抛)
  globalThis.wx = {
    cloud: {
      callFunction: () => Promise.reject(new Error("cloud down")),
    },
  };
  usage.sendUsagePing(usage.buildUsagePing("video_confirm_save", "ios", {}, 10));
  await new Promise((r) => setImmediate(r));
  // 无 wx.cloud:静默
  globalThis.wx = {};
  usage.sendUsagePing(usage.buildUsagePing("video_confirm_save", "ios", {}, 10));
  delete globalThis.wx;
  usage.sendUsagePing(usage.buildUsagePing("video_confirm_save", "ios", {}, 10));
  globalThis.wx = prevWx;
});

/* ---------------- 静态无 PII 扫描(隐私红线) ---------------- */

test("METRICS-NO-PII:usage 相关源码绝不含 openid/getWXContext/name 字段引用", () => {
  const files = [
    "cloudfunctions/usageMetrics/index.js",
    "cloudfunctions/usageMetrics/lib/handler.js",
    "miniprogram/utils/usage-metrics.ts",
    "miniprogram/utils/usage-metrics.js",
  ];
  for (const rel of files) {
    const p = path.join(ROOT, rel);
    assert.equal(fs.existsSync(p), true, rel + " 应存在");
    // 豁免唯一合法 name 字面量:wx.cloud.callFunction 的 API 形参
    // (name: USAGE_METRICS_FUNCTION / name: exports.USAGE_METRICS_FUNCTION),
    // 它是云函数标识常量、不是数据字段;此外任何 name 引用都是违规。
    const src = fs.readFileSync(p, "utf8").replace(/^\s*name:\s+(exports\.)?USAGE_METRICS_FUNCTION\s*,?\s*$/gm, "");
    assert.equal(/openid/i.test(src), false, rel + " 不得引用 openid(完全匿名,不取身份)");
    assert.equal(src.indexOf("getWXContext"), -1, rel + " 不得调用 getWXContext(完全匿名)");
    assert.equal(/\bname\b/i.test(src), false, rel + " 不得引用 name 字段(物品名/昵称绝不进埋点)");
  }
});

test("METRICS-NO-PII-INDEX:usageMetrics 入口不读 event 之外的任何来源(纯匿名适配)", () => {
  const src = fs.readFileSync(path.join(ROOT, "cloudfunctions/usageMetrics/index.js"), "utf8");
  assert.ok(src.indexOf("wx-server-sdk") !== -1, "依赖仅 wx-server-sdk");
  assert.equal(src.indexOf("cloud.getWXContext"), -1);
  for (const forbidden of ["OPENID", "APPID", "UNIONID"]) {
    assert.equal(src.indexOf(forbidden), -1, "入口不得出现 " + forbidden);
  }
});
