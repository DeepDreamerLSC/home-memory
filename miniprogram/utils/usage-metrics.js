"use strict";
/**
 * 视频确认流零隐私使用埋点(#85/#76 降本阶梯第 2 级,Owner 自用数据自动积累):
 * - buildUsagePing 纯函数:与服务端 cloudfunctions/usageMetrics 同款形状门
 *   (kind/platform/counts/ms,零 wx.* 依赖,node 可直接 require 测试);
 * - 会话计数器原语(merges/splits/removes/manualAdds + 会话起点):计数器逻辑只在
 *   本文件一份,video-scan 与 location-video-scan 两页只调用绝不复制;
 * - sendUsagePing:wx.cloud.callFunction({usageMetrics}) fire-and-forget,
 *   catch 全吞(埋点失败绝不影响主流程,不 toast、不重试、不阻塞);
 * - detectUsagePlatform:wx.getSystemInfoSync().platform 归一到闭集,异常/缺失归
 *   "unknown"(仓库无既有共享 platform 工具,归一在此收口单一来源)。
 *
 * 隐私红线(最优先):载荷只允许 数值计数、毫秒时长、platform 枚举、kind 枚举、
 * 时间戳(服务端加)。绝不包含身份标识/昵称/物品名/位置文本/任何用户输入内容/
 * 任何文件 id——由 tests/usage-metrics.test.js 静态扫描锁定。
 *
 * 同源纪律:与服务端 cloudfunctions/usageMetrics/lib/handler.js 是两个部署包不能
 * 互 require(同 videoCleanup/itemsApi 锁副本先例),冻结常量集合两端同源复制,
 * 一致性由 tests/usage-metrics.test.js 逐项比对锁定——改一边必须同步另一边。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.USAGE_MS_MAX = exports.USAGE_COUNT_MAX = exports.USAGE_COUNT_KEYS = exports.USAGE_PLATFORMS = exports.USAGE_KINDS = exports.USAGE_METRICS_FUNCTION = void 0;
exports.buildUsagePing = buildUsagePing;
exports.detectUsagePlatform = detectUsagePlatform;
exports.createUsageSession = createUsageSession;
exports.resetUsageSession = resetUsageSession;
exports.markUsageSessionStart = markUsageSessionStart;
exports.bumpUsageCount = bumpUsageCount;
exports.markUsageSaved = markUsageSaved;
exports.markUsageAbandoned = markUsageAbandoned;
exports.elapsedUsageMs = elapsedUsageMs;
exports.buildVideoConfirmUsagePing = buildVideoConfirmUsagePing;
exports.shouldReportUsageAbandon = shouldReportUsageAbandon;
exports.sendUsagePing = sendUsagePing;
exports.USAGE_METRICS_FUNCTION = "usageMetrics";
/** 冻结闭集(与服务端 usageMetrics/lib/handler.js 同源复制,改动必须两端同步) */
exports.USAGE_KINDS = ["video_confirm_save", "video_confirm_abandon"];
exports.USAGE_PLATFORMS = ["ios", "android", "devtools", "unknown"];
exports.USAGE_COUNT_KEYS = [
    "observations",
    "groups",
    "drafts",
    "merges",
    "splits",
    "removes",
    "manualAdds",
];
exports.USAGE_COUNT_MAX = 100000;
exports.USAGE_MS_MAX = 3600000;
/** abandon 只在「有扫描结果且未保存完成」的离开路径上报;提交仍在后台收敛的阶段不报 */
const USAGE_ABANDON_PHASES = ["review", "partial", "failed"];
function isPlainObject(v) {
    return typeof v === "object" && v !== null && Array.isArray(v) === false;
}
/**
 * 形状门(与服务端同款):kind ∈ 冻结闭集;platform ∈ 冻结闭集;counts 为对象且
 * 键集合 ⊆ 冻结闭集、值为 0..100000 整数;ms 为 0..3600000 整数。
 * 任何违规返回 null(调用方跳过发送,绝不发会被服务端拒绝的载荷)。
 */
function buildUsagePing(kind, platform, counts, ms) {
    if (typeof kind !== "string" || exports.USAGE_KINDS.indexOf(kind) === -1)
        return null;
    if (typeof platform !== "string" || exports.USAGE_PLATFORMS.indexOf(platform) === -1)
        return null;
    if (isPlainObject(counts) === false)
        return null;
    for (const key of Object.keys(counts)) {
        if (exports.USAGE_COUNT_KEYS.indexOf(key) === -1)
            return null;
        const n = counts[key];
        if (typeof n !== "number" || Number.isInteger(n) === false || n < 0 || n > exports.USAGE_COUNT_MAX)
            return null;
    }
    if (typeof ms !== "number" || Number.isInteger(ms) === false || ms < 0 || ms > exports.USAGE_MS_MAX)
        return null;
    return { kind, platform, counts: counts, ms };
}
/** platform 归一:wx.getSystemInfoSync().platform → 闭集,异常/缺失归 "unknown" */
function detectUsagePlatform() {
    try {
        if (typeof wx === "undefined" || typeof wx.getSystemInfoSync !== "function")
            return "unknown";
        const info = wx.getSystemInfoSync();
        const raw = typeof info.platform === "string" ? info.platform : "";
        if (raw === "ios" || raw === "android" || raw === "devtools")
            return raw;
        return "unknown";
    }
    catch (e) {
        return "unknown";
    }
}
function createUsageSession() {
    return {
        startedAtMs: null,
        merges: 0,
        splits: 0,
        removes: 0,
        manualAdds: 0,
        savedSent: false,
        abandonSent: false,
    };
}
/** 扫描开始:归零计数、重置起点、清已报标记(新一次清点 = 新一次计量) */
function resetUsageSession(state, nowMs) {
    state.startedAtMs = nowMs;
    state.merges = 0;
    state.splits = 0;
    state.removes = 0;
    state.manualAdds = 0;
    state.savedSent = false;
    state.abandonSent = false;
}
/** 恢复会话补起点:仅当起点仍为 null 时补一次(不清计数、不动已报标记) */
function markUsageSessionStart(state, nowMs) {
    if (state.startedAtMs === null)
        state.startedAtMs = nowMs;
}
/** 会话内交互计数 +1(页面在合并/拆分/移除/手动补件四个既有 handler 处调用) */
function bumpUsageCount(state, key) {
    state[key] = state[key] + 1;
}
function markUsageSaved(state) {
    state.savedSent = true;
}
function markUsageAbandoned(state) {
    state.abandonSent = true;
}
/** 会话毫秒:起点为 null 记 0;钳到 [0, USAGE_MS_MAX](24h 恢复会话也绝不出门) */
function elapsedUsageMs(state, nowMs) {
    if (state.startedAtMs === null)
        return 0;
    const raw = nowMs - state.startedAtMs;
    if (Number.isFinite(raw) === false)
        return 0;
    return Math.max(0, Math.min(exports.USAGE_MS_MAX, Math.round(raw)));
}
/**
 * 确认流 ping:counts = 快照三键 + 会话四键全量携带,ms = 会话起点到当前的毫秒
 * (钳制);再过 buildUsagePing 同款门。计数器逻辑只在此一份,两页共用。
 */
function buildVideoConfirmUsagePing(state, kind, platform, snapshot, nowMs) {
    const counts = {
        observations: snapshot.observations,
        groups: snapshot.groups,
        drafts: snapshot.drafts,
        merges: state.merges,
        splits: state.splits,
        removes: state.removes,
        manualAdds: state.manualAdds,
    };
    return buildUsagePing(kind, platform, counts, elapsedUsageMs(state, nowMs));
}
/**
 * abandon 门:会话有扫描结果(observations > 0)、未保存(save ping 未发)、
 * 未报过 abandon,且处于 review/partial/failed(uploading/committing 提交仍在
 * 后台收敛,done 已保存——都不报)。
 */
function shouldReportUsageAbandon(state, phase, observationCount) {
    if (observationCount <= 0)
        return false;
    if (state.savedSent || state.abandonSent)
        return false;
    return USAGE_ABANDON_PHASES.indexOf(phase) !== -1;
}
/**
 * fire-and-forget 上报:失败全吞(不 toast、不重试、不阻塞主流程);
 * wx.cloud 不可用/抛异常同样静默——埋点绝不能成为主流程故障源。
 */
function sendUsagePing(payload) {
    if (payload === null)
        return;
    try {
        if (typeof wx === "undefined" || !wx.cloud || typeof wx.cloud.callFunction !== "function")
            return;
        const res = wx.cloud.callFunction({
            // 云函数标识(冻结常量,非用户数据)
            name: exports.USAGE_METRICS_FUNCTION,
            data: payload,
            success: () => { },
            fail: () => { },
        });
        // 新基础库回调式不返 Promise;Promise 式(未传回调时)吞掉 rejection 防未处理拒绝
        if (res !== undefined && res !== null && typeof res.catch === "function") {
            res.catch(() => { });
        }
    }
    catch (e) {
        // 全吞:埋点失败绝不影响主流程
    }
}
