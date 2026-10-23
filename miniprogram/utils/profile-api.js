"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cachedUserProfile = cachedUserProfile;
exports.getUserProfile = getUserProfile;
exports.saveUserProfile = saveUserProfile;
let remembered = { nickname: "", avatarFileId: "", version: 0 };
let pendingRead = null;
let generation = 0;
function cachedUserProfile() { return { ...remembered }; }
async function call(data) {
    if (typeof wx === "undefined" || !wx.cloud || typeof wx.cloud.callFunction !== "function")
        throw new Error("个人资料暂时不可用");
    return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) {
            done = true;
            reject(new Error("网络较慢，请稍后重试"));
        } }, 20000);
        wx.cloud.callFunction({ name: "userProfile", data, success: res => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                const result = res.result;
                if (!result || result.ok !== true) {
                    reject(new Error(typeof result?.message === "string" ? result.message : "个人资料暂时不可用"));
                    return;
                }
                resolve(result);
            }, fail: () => { if (done)
                return; done = true; clearTimeout(timer); reject(new Error("个人资料暂时不可用，请检查网络后重试")); } });
    });
}
function parse(result) {
    const p = result.profile;
    if (!p || typeof p.nickname !== "string" || typeof p.avatar_file_id !== "string" || !Number.isInteger(p.version) || p.version < 0)
        throw new Error("个人资料返回格式不正确");
    return { nickname: p.nickname, avatarFileId: p.avatar_file_id, version: p.version };
}
function getUserProfile() {
    if (pendingRead)
        return pendingRead;
    const seq = generation;
    const request = call({ action: "get" }).then(result => { const p = parse(result); if (seq === generation)
        remembered = p; return cachedUserProfile(); });
    pendingRead = request;
    void request.finally(() => { if (pendingRead === request)
        pendingRead = null; }).catch(() => { });
    return request;
}
async function compress(path) {
    return new Promise((resolve, reject) => wx.compressImage({ src: path, quality: 75, compressedWidth: 512, success: r => resolve(r.tempFilePath), fail: () => reject(new Error("头像处理失败，请重新选择")) }));
}
async function saveUserProfile(input) {
    const data = { action: "save", nickname: input.nickname, version: input.version };
    if (input.avatarPath) {
        const filePath = await compress(input.avatarPath);
        const ticket = await call({ action: "prepareAvatar" });
        if (typeof ticket.cloud_path !== "string" || typeof ticket.nonce !== "string")
            throw new Error("头像上传凭据不正确");
        const uploaded = await new Promise((resolve, reject) => wx.cloud.uploadFile({ cloudPath: ticket.cloud_path, filePath, success: resolve, fail: () => reject(new Error("头像上传失败，请重试")) }));
        data.avatar_file_id = uploaded.fileID;
        data.nonce = ticket.nonce;
    }
    const profile = parse(await call(data));
    generation++;
    pendingRead = null;
    if (profile.version >= remembered.version)
        remembered = profile;
    return cachedUserProfile();
}
