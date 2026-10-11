"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDraftSession = createDraftSession;
exports.getDraftSession = getDraftSession;
exports.updateDraftSessionRows = updateDraftSessionRows;
exports.clearDraftSession = clearDraftSession;
exports.getUnfinishedDraftSession = getUnfinishedDraftSession;
exports.pruneDraftSessions = pruneDraftSessions;
exports.simulateProcessRestartForTest = simulateProcessRestartForTest;
const api_1 = require("./api");
const TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = "home-memory:draft-session";
/** 小程序 storage;node/测试环境无 wx 时用模块后备(仅同进程) */
const storage = typeof wx !== "undefined" ? wx : null;
const sessions = new Map();
let memoryFallback = null;
function readPersisted() {
    if (storage !== null) {
        const raw = storage.getStorageSync(STORAGE_KEY);
        return raw && typeof raw === "object" && typeof raw.sid === "string" && raw.payload
            ? raw
            : null;
    }
    return memoryFallback;
}
function writePersisted(entry) {
    if (storage !== null) {
        storage.setStorageSync(STORAGE_KEY, entry);
        return;
    }
    memoryFallback = entry;
}
function clearPersisted() {
    if (storage !== null) {
        storage.removeStorageSync(STORAGE_KEY);
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
    sessions.set(sid, payload);
    writePersisted({ sid, payload });
    return sid;
}
/** 按 sid 取会话;内存未命中时从持久层恢复(进程回收场景);过期返回 null(如实提示,不编造) */
function getDraftSession(sid, now = Date.now()) {
    let payload = sessions.get(sid) ?? undefined;
    if (payload === undefined) {
        const persisted = readPersisted();
        if (persisted !== null && persisted.sid === sid) {
            payload = persisted.payload;
            sessions.set(sid, payload);
        }
    }
    if (payload === undefined) {
        return null;
    }
    if (isExpired(payload, now)) {
        sessions.delete(sid);
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
    const payload = sessions.get(sid);
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
    sessions.delete(sid);
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
