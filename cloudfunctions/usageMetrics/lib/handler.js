"use strict";
// 视频确认流零隐私使用埋点(#85/#76 降本阶梯第 2 级,Owner 自用数据自动积累):
// - 唯一入口:匿名上报 {kind, platform, counts, ms};
// - 形状门全部先于写入(任何违规返回 {ok:false,error:"INVALID_INPUT"} 零写):
//   kind ∈ 冻结闭集 {video_confirm_save, video_confirm_abandon};
//   platform ∈ {ios, android, devtools, unknown};
//   counts 为对象且键集合 ⊆ 冻结闭集、值为 0..100000 整数;ms 为 0..3600000 整数;
// - 合法即向集合 usage_metrics 插一行 {kind, platform, counts, ms,
//   created_at: 服务端时间},返回 {ok:true};不做更新不做查询,纯 append;
// - 隐私红线:不取任何身份上下文(完全匿名),日志只记
//   {action, error, ms, count} 白名单四键(action+ms+count 形式),
//   绝不落任何身份/内容字段(静态扫描由 tests/usage-metrics.test.js 锁定)。
//
// 同源纪律:与客户端 miniprogram/utils/usage-metrics.ts 是两个部署包不能互
// require(同 videoCleanup/itemsApi 锁副本先例),冻结常量集合两端同源复制,
// 一致性由 tests/usage-metrics.test.js 逐项比对锁定——改一边必须同步另一边。

var COLLECTION = "usage_metrics";
// 冻结闭集(与客户端 usage-metrics.ts 同源复制,改动必须两端同步)
var USAGE_KINDS = ["video_confirm_save", "video_confirm_abandon"];
var USAGE_PLATFORMS = ["ios", "android", "devtools", "unknown"];
var USAGE_COUNT_KEYS = ["observations", "groups", "drafts", "merges", "splits", "removes", "manualAdds"];
var USAGE_COUNT_MAX = 100000;
var USAGE_MS_MAX = 3600000;

function isPlainObject(v) {
  return typeof v === "object" && v !== null && Array.isArray(v) === false;
}

function validCounts(counts) {
  var keys = Object.keys(counts);
  for (var i = 0; i < keys.length; i++) {
    if (USAGE_COUNT_KEYS.indexOf(keys[i]) === -1) return false;
    var n = counts[keys[i]];
    if (Number.isInteger(n) === false || n < 0 || n > USAGE_COUNT_MAX) return false;
  }
  return true;
}

/** 形状门:全部字段先于写入校验,违规零写 */
function validUsagePayload(event) {
  if (isPlainObject(event) === false) return false;
  if (typeof event.kind !== "string" || USAGE_KINDS.indexOf(event.kind) === -1) return false;
  if (typeof event.platform !== "string" || USAGE_PLATFORMS.indexOf(event.platform) === -1) return false;
  if (isPlainObject(event.counts) === false) return false;
  if (validCounts(event.counts) === false) return false;
  if (Number.isInteger(event.ms) === false || event.ms < 0 || event.ms > USAGE_MS_MAX) return false;
  return true;
}

async function handler(deps) {
  var startedAt = Date.now();
  var log = function (error, count) {
    if (deps.logger && typeof deps.logger.log === "function") {
      try {
        deps.logger.log({ action: "record", error: error, ms: Date.now() - startedAt, count: count });
      } catch (e) {}
    }
  };
  var event = deps.event;
  if (validUsagePayload(event) === false) {
    log("INVALID_INPUT", 0);
    return { ok: false, error: "INVALID_INPUT" };
  }
  var now = deps.now ? deps.now() : new Date().toISOString();
  try {
    await deps.db.collection(COLLECTION).add({
      data: {
        kind: event.kind,
        platform: event.platform,
        counts: event.counts,
        ms: event.ms,
        created_at: now
      }
    });
  } catch (e) {
    // 写失败如实返回错误码(调用方 fire-and-forget 全吞,不影响主流程)
    log("DB_WRITE_FAILED", 0);
    return { ok: false, error: "DB_WRITE_FAILED" };
  }
  log(null, 1);
  return { ok: true };
}

module.exports = {
  handler: handler,
  USAGE_KINDS: USAGE_KINDS.slice(),
  USAGE_PLATFORMS: USAGE_PLATFORMS.slice(),
  USAGE_COUNT_KEYS: USAGE_COUNT_KEYS.slice(),
  USAGE_COUNT_MAX: USAGE_COUNT_MAX,
  USAGE_MS_MAX: USAGE_MS_MAX
};
