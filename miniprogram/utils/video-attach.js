"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VIDEO_CONSENT_VERSION = void 0;
exports.videoExtOf = videoExtOf;
exports.chooseVideoFile = chooseVideoFile;
exports.loadPendingVideo = loadPendingVideo;
exports.savePendingVideo = savePendingVideo;
exports.clearPendingVideo = clearPendingVideo;
exports.attachVideoToItem = attachVideoToItem;
exports.retryPendingVideo = retryPendingVideo;
exports.discardPendingVideo = discardPendingVideo;
/**
 * 单件物品视频留证编排。
 *
 * 关键边界:
 * - 一个视频只绑定用户当前明确打开的一件物品;
 * - 上传前先向服务端申请上传票据,云存储路径由服务端给定;
 * - 上传成功但绑定失败时,把 pending 记录写本地 storage,页面可重试或删除;
 * - 原视频只在用户确认留证后上传;删除物品或手动删视频时由服务端删云文件。
 */
const api_1 = require("./api");
exports.VIDEO_CONSENT_VERSION = "v1";
const PENDING_PREFIX = "home-memory:video-pending:";
function wxAvailable() {
    return typeof wx !== "undefined" && wx !== null;
}
const defaultDeps = {
    chooseMedia: (opt) => new Promise((resolve, reject) => {
        wx.chooseMedia({
            ...opt,
            success: (res) => resolve({ tempFiles: res.tempFiles }),
            fail: (err) => reject(new Error((err && err.errMsg) || "chooseMedia:fail")),
        });
    }),
    uploadFile: (opt) => new Promise((resolve, reject) => {
        wx.cloud.uploadFile({
            cloudPath: opt.cloudPath,
            filePath: opt.filePath,
            success: (res) => resolve({ fileID: res.fileID }),
            fail: (err) => reject(new Error((err && err.errMsg) || "uploadFile:fail")),
        });
    }),
    begin: (itemId, ext) => (0, api_1.callItemsApi)({ action: "videoUploadBegin", item_id: itemId, ext }),
    receipt: (event) => (0, api_1.callItemsApi)({ action: "videoUploadReceipt", ...event }),
    attach: (event) => (0, api_1.callItemsApi)({ action: "videoEvidenceAttach", ...event }),
    cancel: (uploadTicket) => (0, api_1.callItemsApi)({ action: "videoUploadCancel", upload_ticket: uploadTicket }),
    now: () => Date.now(),
};
function depsOf(partial) {
    return Object.assign({}, defaultDeps, partial || {});
}
/** 从本地路径推断上传扩展名;服务端只接受 mp4/mov/m4v,其余按 mp4。 */
function videoExtOf(path) {
    const m = /\.([a-zA-Z0-9]+)$/.exec(path.trim());
    const ext = m ? m[1].toLowerCase() : "mp4";
    return ext === "mov" ? "mov" : ext === "m4v" ? "m4v" : "mp4";
}
async function chooseVideoFile(partial) {
    const d = depsOf(partial);
    try {
        const res = await d.chooseMedia({
            count: 1,
            mediaType: ["video"],
            sourceType: ["camera", "album"],
            maxDuration: 60,
            camera: "back",
        });
        const f = res.tempFiles && res.tempFiles[0];
        if (f === undefined || typeof f.tempFilePath !== "string" || f.tempFilePath === "")
            return null;
        return {
            path: f.tempFilePath,
            durationMs: Math.max(1, Math.round((f.duration || 0) * 1000)),
            width: Math.max(1, Math.round(f.width || 0)),
            height: Math.max(1, Math.round(f.height || 0)),
            size: f.size || 0,
        };
    }
    catch (e) {
        return null;
    }
}
function storage() {
    if (wxAvailable() === false)
        return null;
    if (typeof wx.getStorageSync !== "function" || typeof wx.setStorageSync !== "function")
        return null;
    return wx;
}
function pendingKey(scopeId, itemId) {
    return PENDING_PREFIX + (scopeId || "default") + ":" + itemId;
}
function validPending(v) {
    if (typeof v !== "object" || v === null || Array.isArray(v))
        return false;
    const p = v;
    return (typeof p.itemId === "string" &&
        typeof p.uploadTicket === "string" &&
        typeof p.uploadPath === "string" &&
        typeof p.fileId === "string" &&
        typeof p.durationMs === "number" &&
        typeof p.width === "number" &&
        typeof p.height === "number" &&
        typeof p.scopeId === "string" &&
        typeof p.createdAt === "number" &&
        typeof p.expiresAt === "string");
}
function loadPendingVideo(scopeId, itemId) {
    const s = storage();
    if (s === null)
        return null;
    try {
        const raw = s.getStorageSync(pendingKey(scopeId, itemId));
        return validPending(raw) ? raw : null;
    }
    catch (e) {
        return null;
    }
}
function savePendingVideo(p) {
    const s = storage();
    if (s === null)
        return;
    try {
        s.setStorageSync(pendingKey(p.scopeId, p.itemId), p);
    }
    catch (e) { }
}
function clearPendingVideo(scopeId, itemId) {
    const s = storage();
    if (s === null)
        return;
    try {
        if (typeof s.removeStorageSync === "function")
            s.removeStorageSync(pendingKey(scopeId, itemId));
        else
            s.setStorageSync(pendingKey(scopeId, itemId), null);
    }
    catch (e) { }
}
function isTicketExpiredError(e) {
    return (0, api_1.isApiError)(e) && e.code === "VIDEO_TICKET_EXPIRED";
}
/**
 * 上传后先回执 file_id 给服务端,再绑定证据。
 * 回执失败也保留 pending;票据过期时返回 expired,页面要求删除后重拍,不无限重试。
 */
async function receiptAndAttach(pending, d, failureMessage) {
    try {
        await d.receipt({ upload_ticket: pending.uploadTicket, file_id: pending.fileId });
    }
    catch (e) {
        if (isTicketExpiredError(e)) {
            return { ok: false, message: "视频上传凭据已过期,请删除待关联视频后重新拍摄", pending, expired: true };
        }
        return { ok: false, message: "视频已上传但回执未确认,可点重试;不会当作已保存", pending };
    }
    try {
        const attached = await d.attach({
            upload_ticket: pending.uploadTicket,
            file_id: pending.fileId,
            duration_ms: pending.durationMs,
            video_w: pending.width,
            video_h: pending.height,
            consent_version: exports.VIDEO_CONSENT_VERSION,
        });
        clearPendingVideo(pending.scopeId, pending.itemId);
        return { ok: true, evidence: attached.evidence, duplicated: attached.duplicated };
    }
    catch (e) {
        if (isTicketExpiredError(e)) {
            return { ok: false, message: "视频上传凭据已过期,请删除待关联视频后重新拍摄", pending, expired: true };
        }
        return { ok: false, message: failureMessage, pending };
    }
}
/**
 * 申请票据 -> 上传 -> 回执 file_id -> 绑定。上传/回执/绑定任一步失败都保留
 * pending(上传本身失败除外),不假装成功。
 */
async function attachVideoToItem(input, partial) {
    const d = depsOf(partial);
    let begin;
    try {
        begin = await d.begin(input.itemId, videoExtOf(input.file.path));
    }
    catch (e) {
        return { ok: false, message: "暂时无法准备视频上传,请稍后重试", pending: null };
    }
    let fileId = "";
    try {
        const uploaded = await d.uploadFile({ cloudPath: begin.upload_path, filePath: input.file.path });
        fileId = uploaded.fileID;
    }
    catch (e) {
        try {
            await d.cancel(begin.upload_ticket);
        }
        catch (e2) { }
        return { ok: false, message: "视频上传失败,请检查网络后重试", pending: null };
    }
    const pending = {
        itemId: input.itemId,
        uploadTicket: begin.upload_ticket,
        uploadPath: begin.upload_path,
        fileId,
        durationMs: input.file.durationMs,
        width: input.file.width,
        height: input.file.height,
        scopeId: input.scopeId,
        createdAt: d.now(),
        expiresAt: begin.expires_at,
    };
    savePendingVideo(pending);
    return receiptAndAttach(pending, d, "视频已上传但暂未关联成功,可点重试;不会当作已保存");
}
async function retryPendingVideo(pending, partial) {
    return receiptAndAttach(pending, depsOf(partial), "视频仍未关联成功,请稍后重试");
}
/**
 * 用户放弃待关联视频:不再由客户端直接删云文件,统一请求服务端判断。
 * - 服务端发现证据已绑定 -> state=bound,不删文件,客户端恢复为正式视频;
 * - 未绑定 -> 服务端确认逐文件删除成功后才会置 cancelled;
 * - 删除失败 -> 返回错误,本地 pending 保留。
 */
async function discardPendingVideo(pending, partial) {
    const d = depsOf(partial);
    let res;
    try {
        res = await d.cancel(pending.uploadTicket);
    }
    catch (e) {
        const message = (0, api_1.isApiError)(e) ? e.message : "视频删除失败,请稍后重试";
        return { ok: false, message };
    }
    clearPendingVideo(pending.scopeId, pending.itemId);
    if (res.state === "bound")
        return { ok: true, state: "bound", evidence: res.evidence, message: "" };
    return { ok: true, state: "cancelled", message: "" };
}
