"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDraftSession = createDraftSession;
exports.getDraftSession = getDraftSession;
exports.clearDraftSession = clearDraftSession;
exports.pruneDraftSessions = pruneDraftSessions;
const api_1 = require("./api");
const TTL_MS = 10 * 60 * 1000;
const sessions = new Map();
function prune(now) {
    for (const [sid, payload] of sessions) {
        if (now - payload.createdAt > TTL_MS) {
            sessions.delete(sid);
        }
    }
}
/** 存入一批草稿,返回会话 id(由确认页 URL 携带) */
function createDraftSession(originalText, drafts, truncated) {
    const sid = (0, api_1.uuid)();
    sessions.set(sid, { originalText, drafts, truncated, createdAt: Date.now() });
    return sid;
}
/** 按 sid 取会话;过期或不存在返回 null(调用方如实提示,不编造空草稿) */
function getDraftSession(sid, now = Date.now()) {
    const payload = sessions.get(sid);
    if (!payload) {
        return null;
    }
    if (now - payload.createdAt > TTL_MS) {
        sessions.delete(sid);
        return null;
    }
    return payload;
}
/** 清除会话(保存完成/放弃离开;幂等) */
function clearDraftSession(sid) {
    sessions.delete(sid);
}
/** 清掉全部过期会话;返回剩余数量(now 可注入,测试用) */
function pruneDraftSessions(now = Date.now()) {
    prune(now);
    return sessions.size;
}
