"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pickVideo = pickVideo;
exports.buildVideoCommitItems = buildVideoCommitItems;
exports.commitVideoBatch = commitVideoBatch;
exports.retryVideoEvidence = retryVideoEvidence;
/**
 * 视频建档编排:选视频 -> 客户端抽帧识别 -> 用户勾选 -> 确认后上传原视频
 * -> itemsApi.videoCommit 批量建档 + 证据行。
 *
 * 隐私纪律:识别阶段只把抽出的帧临时传给 vlRecognize;原视频只在用户最终
 * 确认保存后上传,上传路径首段是本家庭 household_id(服务端归属硬门依据)。
 */
const api_1 = require("./api");
const video_evidence_1 = require("./video-evidence");
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
    commit: (event) => (0, api_1.callItemsApi)(event),
    retry: (event) => (0, api_1.callItemsApi)(event),
};
function depsOf(partial) {
    return Object.assign({}, defaultDeps, partial || {});
}
async function pickVideo(partial) {
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
        if (f === undefined || typeof f.tempFilePath !== "string")
            return null;
        return {
            path: f.tempFilePath,
            duration_ms: Math.max(1, Math.round((f.duration || 0) * 1000)),
            width: Math.max(1, Math.round(f.width || 0)),
            height: Math.max(1, Math.round(f.height || 0)),
            thumbPath: f.thumbTempFilePath || "",
            size: f.size || 0,
        };
    }
    catch (e) {
        return null;
    }
}
function composeNote(qty, qtyNote) {
    const n = Math.max(1, Math.round(qty));
    const extra = qtyNote.trim();
    return extra === "" ? "×" + n : "×" + n + " " + extra;
}
function buildVideoCommitItems(rows, batchLocation) {
    return rows
        .filter((r) => r.checked && r.name.trim() !== "")
        .map((r) => ({
        operation_id: r.draftId,
        name: r.name.trim(),
        location_text: batchLocation.trim(),
        note: composeNote(r.qty, r.qtyNote),
        highlights: r.highlights,
    }));
}
/** 用户确认后的唯一上传 + 建档编排;重试沿用 fileId,操作幂等。 */
async function commitVideoBatch(input, partial) {
    const d = depsOf(partial);
    const items = buildVideoCommitItems(input.rows, input.batchLocation);
    if (items.length === 0) {
        return {
            ok: false,
            fileId: input.fileId || "",
            video: { file_id: "", duration_ms: input.video.duration_ms, video_w: input.video.width, video_h: input.video.height },
            results: [],
            evidenceFailed: [],
            message: "请至少保留一件物品",
        };
    }
    let fileId = input.fileId;
    if (fileId === null || fileId === "") {
        try {
            const uploaded = await d.uploadFile({
                cloudPath: (0, video_evidence_1.videoCloudPath)(input.scopeId, new Date(), (0, api_1.uuid)()),
                filePath: input.video.path,
            });
            fileId = uploaded.fileID;
        }
        catch (e) {
            return {
                ok: false,
                fileId: "",
                video: { file_id: "", duration_ms: input.video.duration_ms, video_w: input.video.width, video_h: input.video.height },
                results: [],
                evidenceFailed: [],
                message: "视频上传失败,请稍后重试",
            };
        }
    }
    const video = {
        file_id: fileId,
        duration_ms: input.video.duration_ms,
        video_w: input.video.width,
        video_h: input.video.height,
    };
    try {
        const res = await d.commit({
            action: "videoCommit",
            batch_id: input.batchId,
            video,
            items,
        });
        return {
            ok: true,
            fileId,
            video,
            results: res.results,
            evidenceFailed: Array.isArray(res.evidence_failed) ? res.evidence_failed : [],
            message: "",
        };
    }
    catch (e) {
        return { ok: false, fileId, video, results: [], evidenceFailed: [], message: "视频建档失败,请稍后重试" };
    }
}
/** 证据写入失败后的幂等补关联;返回仍失败的 item_id(空=全部成功)。 */
async function retryVideoEvidence(video, rows, itemIdByIndex, partial) {
    const d = depsOf(partial);
    const picked = rows.filter((r) => r.checked);
    const items = picked.map((r, i) => ({ item_id: itemIdByIndex[i] || "", highlights: r.highlights }));
    if (items.some((x) => x.item_id === ""))
        return items.map((x) => x.item_id).filter((x) => x !== "");
    const res = await d.retry({ action: "videoEvidenceRetry", video, items });
    return res.results.filter((r) => r.ok === false).map((r) => r.item_id);
}
