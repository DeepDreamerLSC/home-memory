"use strict";
/*
 * 临时草稿会话(确认页不得 URL 传整段草稿;Issue #14 三轮评审:退出后保幂等恢复能力):
 * - 内存 Map 供同进程快速取用;持久层(小程序 wx storage,node/测试用注入/后备)
 *   只保留最新一个会话,供进程被回收后恢复;
 * - 确认页逐行保存时把行状态(含固定 operation_id 与已保存状态)回写会话,
 *   中途退出(部分写入结果未知)不清持久层,首页检测到未完成会话给「继续核对」入口,
 *   恢复后沿用原幂等键——已保存行不再提交,不会重复建档;
 * - 全部保存完成或用户放弃(无勾选)离开时,确认页清除会话;
 * - 过期(24 小时)如实视为不存在:提示重新提取,绝不编造空草稿;
 * - 家庭作用域(issue #34 P0,F3):持久层存储键与内存会话键统一拼接
 *   householdScopeSuffix()(捕获到服务端 household_id 后为 ":hh-<id>")。
 *   草稿归属产生它的家庭:切换家庭后旧草稿原地保留(键不同=互不可达),
 *   回切即恢复;新家庭从干净状态开始,绝不自动迁移(F3/产品决策 3)。
 *   P0 无切换入口,单人阶段后缀为空串,键与现状逐字节一致。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDraftSession = createDraftSession;
exports.getDraftSession = getDraftSession;
exports.updateDraftSessionRows = updateDraftSessionRows;
exports.clearDraftSession = clearDraftSession;
exports.getUnfinishedDraftSession = getUnfinishedDraftSession;
exports.pruneDraftSessions = pruneDraftSessions;
exports.simulateProcessRestartForTest = simulateProcessRestartForTest;
exports.__setDraftSessionStorageForTest = __setDraftSessionStorageForTest;
exports.__resetDraftSessionForTest = __resetDraftSessionForTest;
const api_1 = require("./api");
const household_scope_1 = require("./household-scope");
const TTL_MS = 24 * 60 * 60 * 1000;
/** 存储键基础段;实际键 = 基础段 + 家庭作用域后缀(issue #34 P0,逐读写动态解析) */
const STORAGE_KEY_BASE = "home-memory:draft-session";
/** 测试注入的存储(undefined = 未注入);优先级最高 */
let testStorage;
/** 无 wx / 无注入时的模块内后备(仅同进程) */
let memoryFallback = null;
/**
 * 解析当前可用存储(逐调用解析而非模块加载时绑定:测试里 globalThis.wx 可能是
 * 只含 cloud 的部分 stub,加载时机不同会拿到假 wx;口径与 locations-cache 一致)。
 */
function activeStorage() {
    if (testStorage !== undefined) {
        return testStorage;
    }
    if (typeof wx !== "undefined" &&
        typeof wx.getStorageSync === "function" &&
        typeof wx.setStorageSync === "function" &&
        typeof wx.removeStorageSync === "function") {
        return wx;
    }
    return null;
}
/** 当前作用域的实际存储键:切换家庭后键天然不同,旧家庭草稿不可达(F3) */
function storageKey() {
    return STORAGE_KEY_BASE + (0, household_scope_1.householdScopeSuffix)();
}
/** 内存会话键:sid + 作用域后缀(作用域不同则同一 sid 互不可见) */
function scopedSid(sid) {
    return sid + (0, household_scope_1.householdScopeSuffix)();
}
const sessions = new Map();
function readPersisted() {
    const storage = activeStorage();
    if (storage !== null) {
        const raw = storage.getStorageSync(storageKey());
        return raw && typeof raw === "object" && typeof raw.sid === "string" && raw.payload
            ? raw
            : null;
    }
    return memoryFallback;
}
function writePersisted(entry) {
    const storage = activeStorage();
    if (storage !== null) {
        storage.setStorageSync(storageKey(), entry);
        return;
    }
    memoryFallback = entry;
}
function clearPersisted() {
    const storage = activeStorage();
    if (storage !== null) {
        storage.removeStorageSync(storageKey());
        return;
    }
    memoryFallback = null;
}
function isExpired(payload, now) {
    return now - payload.createdAt > TTL_MS;
}
/** 存入一批草稿(成为当前会话),返回会话 id(由确认页 URL 携带) */
function createDraftSession(originalText, drafts, truncated) {
    const sid = (0, api_1.uuid)();
    const payload = { originalText, drafts, truncated, createdAt: Date.now() };
    sessions.set(scopedSid(sid), payload);
    writePersisted({ sid, payload });
    return sid;
}
/** 按 sid 取会话;内存未命中时从持久层恢复(进程回收场景);过期返回 null(如实提示,不编造) */
function getDraftSession(sid, now = Date.now()) {
    let payload = sessions.get(scopedSid(sid)) ?? undefined;
    if (payload === undefined) {
        const persisted = readPersisted();
        if (persisted !== null && persisted.sid === sid) {
            payload = persisted.payload;
            sessions.set(scopedSid(sid), payload);
        }
    }
    if (payload === undefined) {
        return null;
    }
    if (isExpired(payload, now)) {
        sessions.delete(scopedSid(sid));
        const persisted = readPersisted();
        if (persisted !== null && persisted.sid === sid) {
            clearPersisted();
        }
        return null;
    }
    return payload;
}
/**
 * 确认页回写行状态(保存中逐行调用;会话不存在则忽略)。
 * 持久层归属检查(五轮评审 CAS 守卫):只有 sid 仍是当前持久化会话才落盘——
 * 旧确认页被放弃/替换后的迟到回调,不得把已退役的 sid 反向写回 storage,
 * 否则会顶掉新批次的恢复入口与其幂等键。内存行状态照常更新(不影响新批次)。
 */
function updateDraftSessionRows(sid, rows) {
    const payload = sessions.get(scopedSid(sid));
    if (payload === undefined) {
        return;
    }
    payload.rows = rows;
    const persisted = readPersisted();
    if (persisted === null || persisted.sid !== sid) {
        return;
    }
    writePersisted({ sid, payload });
}
/** 清除会话(保存完成/放弃离开;幂等) */
function clearDraftSession(sid) {
    sessions.delete(scopedSid(sid));
    const persisted = readPersisted();
    if (persisted !== null && persisted.sid === sid) {
        clearPersisted();
    }
}
/** 首页检测未完成会话(进程回收/中途退出后):返回 {sid,payload} 供「继续核对」入口 */
function getUnfinishedDraftSession(now = Date.now()) {
    const persisted = readPersisted();
    if (persisted === null || isExpired(persisted.payload, now)) {
        return null;
    }
    return persisted;
}
/** 清掉全部过期会话;返回剩余数量(now 可注入,测试用) */
function pruneDraftSessions(now = Date.now()) {
    const persisted = readPersisted();
    if (persisted !== null && isExpired(persisted.payload, now)) {
        clearPersisted();
    }
    for (const [sid, payload] of sessions) {
        if (isExpired(payload, now)) {
            sessions.delete(sid);
        }
    }
    return sessions.size;
}
/** 测试钩子:模拟进程回收(清内存会话,保留持久层),验证恢复路径 */
function simulateProcessRestartForTest() {
    sessions.clear();
}
/** 测试钩子:注入存储(null = 强制用模块内后备);只在测试里用 */
function __setDraftSessionStorageForTest(storage) {
    testStorage = storage;
}
/** 还原测试注入与内存后备 */
function __resetDraftSessionForTest() {
    testStorage = undefined;
    memoryFallback = null;
}
