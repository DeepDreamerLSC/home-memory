"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * PR B 场景扫描确认页：
 * - 用户主动录/选一段抽屉柜子视频；
 * - 本地抽帧 → 逐帧 vlRecognize → 多物品 observation；
 * - 用户显式生成/合并/拆分/补件后才产生待存草稿；
 * - 原视频只在最终确认后上传；同一 file_id/asset_id 为多件建 evidence；
 * - 不自动合并同名、不自动入库、不自动播放。
 */
const api_1 = require("../../utils/api");
const video_attach_1 = require("../../utils/video-attach");
const video_scene_1 = require("../../utils/video-scene");
const video_target_1 = require("../../utils/video-target");
const photo_vl_1 = require("../../utils/photo-vl");
const households_api_1 = require("../../utils/households-api");
const household_scope_1 = require("../../utils/household-scope");
const SESSION_PREFIX = "home-memory:video-scene-session:";
const PENDING_PREFIX = "home-memory:video-scene-pending:";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
function scopeKey(prefix) {
    return prefix + ((0, household_scope_1.householdScopeId)() || "default");
}
function storageGet(key) {
    try {
        return wx.getStorageSync(key);
    }
    catch (e) {
        return null;
    }
}
function storageSet(key, value) {
    try {
        wx.setStorageSync(key, value);
    }
    catch (e) {
        // 本地恢复失败不影响当前页面；base64 从不进 storage。
    }
}
function storageRemove(key) {
    try {
        wx.removeStorageSync(key);
    }
    catch (e) { }
}
function isRecord(v) {
    return typeof v === "object" && v !== null && Array.isArray(v) === false;
}
function normalizeHighlightInput(raw) {
    const box = raw.box === null ? null : {
        x1: raw.box.x1,
        y1: raw.box.y1,
        x2: raw.box.x2,
        y2: raw.box.y2,
    };
    const out = { start_ms: raw.start_ms, end_ms: raw.end_ms, box };
    if (raw.frame_ms !== undefined)
        out.frame_ms = raw.frame_ms;
    return out;
}
function makeSession(data, pendingUpload) {
    return {
        version: 1,
        createdAt: Date.now(),
        scopeId: (0, household_scope_1.householdScopeId)(),
        phase: data.phase,
        sceneId: data.sceneId,
        videoPath: data.videoPath,
        durationMs: data.videoDurationMs,
        width: data.videoWidth,
        height: data.videoHeight,
        batchLocation: data.batchLocation,
        observations: data.observations,
        drafts: data.drafts,
        pendingUpload,
        frozenItems: data.frozenItems,
    };
}
function parseStoredSession(raw) {
    if (isRecord(raw) === false || raw.version !== 1)
        return null;
    if (typeof raw.createdAt !== "number" || Date.now() - raw.createdAt > SESSION_TTL_MS)
        return null;
    if (typeof raw.scopeId !== "string" || raw.scopeId !== (0, household_scope_1.householdScopeId)())
        return null;
    if (typeof raw.videoPath !== "string" || typeof raw.durationMs !== "number")
        return null;
    if (Array.isArray(raw.observations) === false || Array.isArray(raw.drafts) === false)
        return null;
    const pending = isRecord(raw.pendingUpload) && typeof raw.pendingUpload.fileId === "string"
        ? raw.pendingUpload
        : null;
    const frozen = Array.isArray(raw.frozenItems) ? raw.frozenItems : [];
    return {
        version: 1,
        createdAt: raw.createdAt,
        scopeId: raw.scopeId,
        phase: typeof raw.phase === "string" ? raw.phase : "review",
        sceneId: typeof raw.sceneId === "string" ? raw.sceneId : "",
        videoPath: raw.videoPath,
        durationMs: raw.durationMs,
        width: typeof raw.width === "number" ? raw.width : 0,
        height: typeof raw.height === "number" ? raw.height : 0,
        batchLocation: typeof raw.batchLocation === "string" ? raw.batchLocation : "",
        observations: raw.observations,
        drafts: raw.drafts,
        pendingUpload: pending,
        frozenItems: frozen,
    };
}
Page({
    data: {
        phase: "idle",
        sceneId: "",
        videoPath: "",
        videoDurationMs: 0,
        videoWidth: 0,
        videoHeight: 0,
        videoAspect: "16 / 9",
        batchLocation: "",
        progressText: "",
        failureText: "",
        errorText: "",
        resultText: "",
        mergeSameName: false,
        observations: [],
        drafts: [],
        selectedObsIds: [],
        mergeSelectedKeys: [],
        observationGroups: [],
        draftViews: [],
        frozenItems: [],
        pendingUpload: null,
        busy: false,
    },
    onLoad() {
        const stored = parseStoredSession(storageGet(scopeKey(SESSION_PREFIX)));
        if (stored === null)
            return;
        const phase = stored.pendingUpload !== null ? "partial" : "review";
        this.setData({
            phase,
            sceneId: stored.sceneId,
            videoPath: stored.videoPath,
            videoDurationMs: stored.durationMs,
            videoWidth: stored.width,
            videoHeight: stored.height,
            videoAspect: stored.width > 0 && stored.height > 0 ? stored.width + " / " + stored.height : "16 / 9",
            batchLocation: stored.batchLocation,
            observations: stored.observations,
            drafts: stored.drafts,
            frozenItems: stored.frozenItems,
            pendingUpload: stored.pendingUpload,
            progressText: phase === "partial" ? "上次视频处理尚未完成" : "",
            resultText: phase === "partial"
                ? (stored.pendingUpload !== null && stored.pendingUpload.fileId !== ""
                    ? "上次视频已上传，可重试完成剩余关联"
                    : "上次视频上传未完成，请放弃待关联票据后重新确认")
                : "",
        }, () => {
            this.renderObservations();
            this.renderDrafts();
        });
    },
    onHide() {
        const session = this.scanSession;
        if (session !== undefined) {
            void session.cancel();
            this.scanSession = undefined;
        }
        if (this.data.phase === "scanning") {
            this.setData({ phase: "review" });
        }
        if (this.data.observations.length > 0 || this.data.drafts.length > 0 || this.data.pendingUpload !== null) {
            this.saveSession();
        }
    },
    onUnload() {
        this.onHide();
    },
    saveSession() {
        if (this.data.observations.length === 0 && this.data.drafts.length === 0 && this.data.pendingUpload === null)
            return;
        storageSet(scopeKey(SESSION_PREFIX), makeSession(this.data, this.data.pendingUpload));
    },
    clearSession() {
        storageRemove(scopeKey(SESSION_PREFIX));
        storageRemove(scopeKey(PENDING_PREFIX));
    },
    renderObservations() {
        const selected = new Set(this.data.selectedObsIds);
        const groups = (0, video_scene_1.groupSceneObservations)(this.data.observations).map((g) => ({
            nameKey: g.nameKey,
            label: g.label,
            countText: g.observations.length + " 条同名线索（不代表同一件）",
            observations: g.observations.map((obs) => ({
                obsId: obs.obsId,
                name: obs.name,
                timeText: (0, video_target_1.videoTimeText)(obs.timeMs),
                confidenceText: (0, video_scene_1.sceneConfidenceText)(obs.confidence),
                framePath: obs.framePath,
                boxStyle: (0, video_target_1.boxPercentStyle)(obs.box),
                checked: selected.has(obs.obsId),
            })),
        }));
        this.setData({ observationGroups: groups });
    },
    renderDrafts() {
        const views = this.data.drafts.map((d) => {
            const highlights = d.observationIds.length + d.manualHighlights.length;
            const first = d.manualHighlights.length > 0 ? d.manualHighlights[0] : null;
            return {
                draftKey: d.draftKey,
                name: d.name,
                locationText: d.locationText,
                note: d.note,
                target: d.target,
                targetText: d.target === "existing" ? "关联已有物品：" + (d.itemId || "未选择") : "新建物品",
                itemId: d.itemId,
                checked: d.checked,
                mergeSelected: this.data.mergeSelectedKeys.indexOf(d.draftKey) !== -1,
                observationCount: d.observationIds.length,
                highlightCount: highlights,
                isManual: d.observationIds.length === 0 && d.manualHighlights.length > 0,
                startSecText: first === null ? "" : (first.start_ms / 1000).toFixed(1),
                endSecText: first === null ? "" : (first.end_ms / 1000).toFixed(1),
            };
        });
        this.setData({ draftViews: views });
    },
    async onChooseVideoTap() {
        if (this.data.busy)
            return;
        const consent = await new Promise((resolve) => {
            wx.showModal({
                title: "拍一段抽屉/柜子视频",
                content: "原视频在你最终确认前不会上传云存储；识别时会把少量静帧临时发到云端 AI，不保存识别结果。确认后才会保存原视频和每件物品的高亮。视频只作历史证据，不冒充当前位置，也不会自动播放。",
                confirmText: "继续",
                cancelText: "取消",
                success: (r) => resolve(r.confirm === true),
                fail: () => resolve(false),
            });
        });
        if (consent === false)
            return;
        const file = await new Promise((resolve) => {
            wx.chooseMedia({
                count: 1,
                mediaType: ["video"],
                sourceType: ["camera", "album"],
                maxDuration: 30,
                camera: "back",
                success: (res) => {
                    const f = res.tempFiles && res.tempFiles[0];
                    if (f === undefined || typeof f.tempFilePath !== "string" || f.tempFilePath === "") {
                        resolve(null);
                        return;
                    }
                    resolve({
                        path: f.tempFilePath,
                        durationMs: Math.max(1, Math.round((f.duration || 0) * 1000)),
                        width: Math.max(1, Math.round(f.width || 0)),
                        height: Math.max(1, Math.round(f.height || 0)),
                        size: f.size || 0,
                    });
                },
                fail: () => resolve(null),
            });
        });
        if (file === null)
            return;
        await this.startSceneScan(file);
    },
    async startSceneScan(file) {
        const sceneId = (0, api_1.uuid)();
        const epoch = (this.scanEpoch || 0) + 1;
        this.scanEpoch = epoch;
        let session;
        try {
            session = (0, video_target_1.createVideoFrameSession)({ path: file.path, durationMs: file.durationMs }, { durationMs: file.durationMs });
        }
        catch (e) {
            this.setData({ phase: "failed", busy: false, errorText: "当前设备暂不支持视频抽帧，可改用拍照识物或手动添加。" });
            return;
        }
        this.scanSession = session;
        this.setData({
            phase: "scanning",
            sceneId,
            videoPath: file.path,
            videoDurationMs: file.durationMs,
            videoWidth: file.width,
            videoHeight: file.height,
            videoAspect: file.width > 0 && file.height > 0 ? file.width + " / " + file.height : "16 / 9",
            observations: [],
            drafts: [],
            selectedObsIds: [],
            mergeSelectedKeys: [],
            frozenItems: [],
            pendingUpload: null,
            errorText: "",
            failureText: "",
            resultText: "",
            progressText: "正在抽取第 1/8 帧…",
            busy: true,
        });
        this.renderObservations();
        this.renderDrafts();
        const outcome = await (0, video_scene_1.scanSceneVideo)({
            source: { path: file.path, durationMs: file.durationMs },
            durationMs: file.durationMs,
            session,
            callRecognize: async (input) => {
                const prepared = {
                    ok: true,
                    path: "",
                    imgW: input.img_w,
                    imgH: input.img_h,
                    base64: input.image_base64,
                    compressed: true,
                };
                const result = await (0, photo_vl_1.recognizeWithVl)(prepared);
                if (result.ok === true) {
                    return { ok: true, items: result.items, truncated: result.truncated };
                }
                return { ok: false, error: result.kind, message: result.message };
            },
            onProgress: (done, total, failures) => {
                if ((this.scanEpoch || 0) !== epoch)
                    return;
                this.setData({
                    progressText: "已分析 " + done + "/" + total + " 帧" + (failures > 0 ? "，" + failures + " 帧失败" : ""),
                });
            },
        });
        if ((this.scanEpoch || 0) !== epoch)
            return;
        if (outcome.ok === false) {
            if (outcome.kind === "cancelled") {
                this.setData({ phase: "idle", busy: false, progressText: "" });
                return;
            }
            this.setData({
                phase: outcome.observations.length > 0 ? "review" : "failed",
                busy: false,
                observations: outcome.observations,
                errorText: outcome.message,
            });
            this.renderObservations();
            this.saveSession();
            return;
        }
        const failureText = outcome.failures.length > 0
            ? "已分析 " + outcome.framesScanned + "/" + outcome.framesTotal + " 帧，" + outcome.failures.length + " 帧失败；结果可能漏件，可手动补件。"
            : "";
        const truncatedText = outcome.truncatedFrames.length > 0
            ? "有 " + outcome.truncatedFrames.length + " 帧只保留了前 10 件，可能漏件。"
            : "";
        this.setData({
            phase: "review",
            busy: false,
            observations: outcome.observations,
            failureText: [failureText, truncatedText].filter((s) => s !== "").join(" "),
            resultText: outcome.observations.length === 0
                ? "AI 暂未给出物品线索，可手动补一件；原视频仍只在最终确认后上传。"
                : "已发现 " + outcome.observations.length + " 条线索；同名线索只是提示，不会被自动合并。",
            progressText: "",
        });
        this.renderObservations();
        this.renderDrafts();
        this.saveSession();
        if (outcome.manualFallback) {
            wx.showToast({ title: "未识别到线索，可手动补件", icon: "none" });
        }
    },
    async cancelScan() {
        this.scanEpoch = (this.scanEpoch || 0) + 1;
        const session = this.scanSession;
        if (session !== undefined)
            await session.cancel();
        this.scanSession = undefined;
    },
    async onCancelScanTap() {
        await this.cancelScan();
        this.setData({ phase: "idle", busy: false, observations: [], drafts: [], progressText: "", errorText: "" });
        this.clearSession();
    },
    /** 点缩略图放大预览(真机反馈 2026-10-20:横图看不清、无法展开)——catchtap 不触发勾选 */
    onObsImageTap(e) {
        const obsId = String(e.currentTarget.dataset.obsId || "");
        const group = this.data.observationGroups.find((g) => g.observations.some((o) => o.obsId === obsId));
        const urls = (group ? group.observations : this.data.observations)
            .map((o) => o.framePath)
            .filter((p) => typeof p === "string" && p !== "");
        const current = this.data.observations.find((o) => o.obsId === obsId);
        if (current && current.framePath) {
            wx.previewImage({ current: current.framePath, urls: urls.length > 0 ? urls : [current.framePath] });
        }
    },
    onObservationToggle(e) {
        const obsId = String(e.currentTarget.dataset.obsId || "");
        if (obsId === "")
            return;
        const current = this.data.selectedObsIds;
        const selected = current.indexOf(obsId) === -1
            ? current.concat([obsId])
            : current.filter((id) => id !== obsId);
        this.setData({ selectedObsIds: selected });
        this.renderObservations();
    },
    onMergeSameNameChange(e) {
        const value = isRecord(e.detail) && e.detail.value === true;
        this.setData({ mergeSameName: value });
    },
    onGenerateDraftsTap() {
        if (this.data.selectedObsIds.length === 0) {
            wx.showToast({ title: "先勾选至少一条线索", icon: "none" });
            return;
        }
        const drafts = (0, video_scene_1.createDraftsFromObservations)(this.data.observations, this.data.selectedObsIds, {
            mergeSameName: this.data.mergeSameName,
            batchLocation: this.data.batchLocation,
        });
        this.setData({
            drafts: this.data.drafts.concat(drafts),
            selectedObsIds: [],
        }, () => {
            this.renderObservations();
            this.renderDrafts();
            this.saveSession();
        });
    },
    onBatchLocationInput(e) {
        const value = isRecord(e.detail) && typeof e.detail.value === "string" ? e.detail.value : "";
        const drafts = this.data.drafts.map((d) => d.target === "new" && d.locationText.trim() === "" ? { ...d, locationText: value } : d);
        this.setData({ batchLocation: value, drafts }, () => this.renderDrafts());
    },
    onDraftCheckedTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length)
            return;
        const drafts = this.data.drafts.slice();
        drafts[index] = { ...drafts[index], checked: drafts[index].checked === false };
        this.setData({ drafts }, () => this.renderDrafts());
    },
    onDraftMergeSelectTap(e) {
        const key = String(e.currentTarget.dataset.key || "");
        if (key === "")
            return;
        const keys = this.data.mergeSelectedKeys.slice();
        const index = keys.indexOf(key);
        if (index === -1)
            keys.push(key);
        else
            keys.splice(index, 1);
        this.setData({ mergeSelectedKeys: keys }, () => this.renderDrafts());
    },
    onDraftNameInput(e) {
        const index = Number(e.currentTarget.dataset.index);
        const value = isRecord(e.detail) && typeof e.detail.value === "string" ? e.detail.value : "";
        if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length)
            return;
        const drafts = this.data.drafts.slice();
        drafts[index] = { ...drafts[index], name: value };
        this.setData({ drafts }, () => this.renderDrafts());
    },
    onDraftLocationInput(e) {
        const index = Number(e.currentTarget.dataset.index);
        const value = isRecord(e.detail) && typeof e.detail.value === "string" ? e.detail.value : "";
        if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length)
            return;
        const drafts = this.data.drafts.slice();
        drafts[index] = { ...drafts[index], locationText: value };
        this.setData({ drafts }, () => this.renderDrafts());
    },
    onDraftNoteInput(e) {
        const index = Number(e.currentTarget.dataset.index);
        const value = isRecord(e.detail) && typeof e.detail.value === "string" ? e.detail.value : "";
        if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length)
            return;
        const drafts = this.data.drafts.slice();
        drafts[index] = { ...drafts[index], note: value };
        this.setData({ drafts }, () => this.renderDrafts());
    },
    onDraftManualTimeInput(e) {
        const index = Number(e.currentTarget.dataset.index);
        const field = String(e.currentTarget.dataset.field || "");
        const raw = isRecord(e.detail) && typeof e.detail.value === "string" ? Number(e.detail.value) : NaN;
        if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length)
            return;
        if (Number.isFinite(raw) === false || raw < 0)
            return;
        const draft = this.data.drafts[index];
        if (draft.manualHighlights.length === 0)
            return;
        const current = normalizeHighlightInput(draft.manualHighlights[0]);
        let start = current.start_ms;
        let end = current.end_ms;
        if (field === "start")
            start = Math.round(raw * 1000);
        else if (field === "end")
            end = Math.round(raw * 1000);
        else
            return;
        const duration = Math.max(1, this.data.videoDurationMs);
        start = Math.max(0, Math.min(duration - 1, start));
        end = Math.max(start + 1, Math.min(duration, end));
        const highlight = {
            start_ms: start,
            end_ms: end,
            box: current.box,
            frame_ms: start,
        };
        const drafts = this.data.drafts.slice();
        drafts[index] = { ...draft, manualHighlights: [highlight] };
        this.setData({ drafts }, () => this.renderDrafts());
    },
    onDraftRemoveTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length)
            return;
        const removed = this.data.drafts[index];
        const drafts = this.data.drafts.filter((_, i) => i !== index);
        const keys = this.data.mergeSelectedKeys.filter((k) => k !== removed.draftKey);
        this.setData({ drafts, mergeSelectedKeys: keys }, () => {
            this.renderDrafts();
            this.saveSession();
        });
    },
    onDraftSplitTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length)
            return;
        const draft = this.data.drafts[index];
        const split = (0, video_scene_1.splitSceneDraft)(draft);
        if (split.length <= 1 && split[0] === draft) {
            wx.showToast({ title: "这件只有一条高亮，无需拆分", icon: "none" });
            return;
        }
        const drafts = this.data.drafts.slice();
        drafts.splice(index, 1, ...split);
        this.setData({ drafts }, () => {
            this.renderDrafts();
            this.saveSession();
            wx.showToast({ title: "已拆成 " + split.length + " 件", icon: "none" });
        });
    },
    onMergeDraftsTap() {
        const merged = (0, video_scene_1.mergeSceneDrafts)(this.data.drafts, this.data.mergeSelectedKeys);
        if (merged === null) {
            wx.showToast({ title: "请选择至少两件新建物品草稿", icon: "none" });
            return;
        }
        const keys = new Set(this.data.mergeSelectedKeys);
        const firstIndex = this.data.drafts.findIndex((d) => keys.has(d.draftKey));
        const drafts = this.data.drafts.filter((d) => keys.has(d.draftKey) === false);
        drafts.splice(Math.max(0, firstIndex), 0, merged);
        this.setData({ drafts, mergeSelectedKeys: [] }, () => {
            this.renderDrafts();
            this.saveSession();
        });
    },
    onAddManualDraftTap() {
        const duration = Math.max(1, this.data.videoDurationMs);
        const end = Math.min(duration, 1500);
        const draft = (0, video_scene_1.newSceneDraft)({
            locationText: this.data.batchLocation,
            manualHighlights: [{
                    start_ms: 0,
                    end_ms: end > 0 ? end : duration,
                    box: null,
                    frame_ms: 0,
                }],
            checked: true,
        });
        this.setData({ drafts: this.data.drafts.concat([draft]) }, () => {
            this.renderDrafts();
            this.saveSession();
        });
    },
    async onDraftTargetTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length)
            return;
        const choice = await new Promise((resolve) => {
            wx.showActionSheet({
                itemList: ["新建物品", "关联已有物品"],
                success: (r) => resolve(r.tapIndex),
                fail: () => resolve(null),
            });
        });
        if (choice === null)
            return;
        if (choice === 0) {
            const d = this.data.drafts[index];
            if (d.target === "new") {
                wx.showToast({ title: "这件已是「新建物品」", icon: "none" });
                return;
            }
            const drafts = this.data.drafts.slice();
            drafts[index] = { ...drafts[index], target: "new", itemId: "" };
            this.setData({ drafts }, () => this.renderDrafts());
            return;
        }
        try {
            await (0, households_api_1.ensureScopeVerified)();
            const res = await (0, api_1.callItemsApi)({ action: "list", limit: 50 });
            if (res.items.length === 0) {
                wx.showToast({ title: "还没有可关联的物品", icon: "none" });
                return;
            }
            const options = res.items.slice(0, 6);
            const picked = await new Promise((resolve) => {
                wx.showActionSheet({
                    itemList: options.map((it) => it.name + " · " + it.location_text),
                    success: (r) => resolve(r.tapIndex),
                    fail: () => resolve(null),
                });
            });
            if (picked === null || options[picked] === undefined)
                return;
            const drafts = this.data.drafts.slice();
            drafts[index] = { ...drafts[index], target: "existing", itemId: options[picked].item_id };
            this.setData({ drafts }, () => this.renderDrafts());
        }
        catch (err) {
            wx.showModal({ title: "读取物品失败", content: (0, api_1.errorMessage)(err), showCancel: false });
        }
    },
    onRestartTap() {
        wx.showModal({
            title: "重新拍摄",
            content: "当前候选和草稿会清空；原视频在确认前未上传。确定重来吗？",
            confirmText: "重来",
            success: (r) => {
                if (r.confirm !== true)
                    return;
                void this.cancelScan();
                this.clearSession();
                this.setData({
                    phase: "idle",
                    sceneId: "",
                    videoPath: "",
                    videoDurationMs: 0,
                    videoWidth: 0,
                    videoHeight: 0,
                    batchLocation: "",
                    progressText: "",
                    failureText: "",
                    errorText: "",
                    resultText: "",
                    observations: [],
                    drafts: [],
                    selectedObsIds: [],
                    mergeSelectedKeys: [],
                    frozenItems: [],
                    pendingUpload: null,
                    busy: false,
                }, () => {
                    this.renderObservations();
                    this.renderDrafts();
                });
            },
        });
    },
    async onSaveTap() {
        if (this.data.busy)
            return;
        const built = (0, video_scene_1.buildSceneCommitItems)(this.data.drafts, this.data.observations, this.data.videoDurationMs);
        if (built.ok === false) {
            wx.showModal({ title: "还不能保存", content: built.message, showCancel: false });
            return;
        }
        try {
            await (0, households_api_1.ensureScopeVerified)();
        }
        catch (e) {
            wx.showToast({ title: "暂时无法确认当前家庭，请稍后重试", icon: "none" });
            return;
        }
        this.setData({ phase: "uploading", busy: true, errorText: "", resultText: "", frozenItems: built.items }, () => {
            void this.startSceneUpload(built.items);
        });
    },
    async localVideoAvailable() {
        const path = this.data.videoPath;
        if (path === "")
            return false;
        if (typeof wx.getFileSystemManager !== "function")
            return true;
        const fs = wx.getFileSystemManager();
        if (typeof fs.access !== "function")
            return true;
        return new Promise((resolve) => {
            fs.access({
                path,
                success: () => resolve(true),
                fail: () => resolve(false),
            });
        });
    },
    async startSceneUpload(frozenItems) {
        if (this.data.videoPath === "" || this.data.sceneId === "") {
            this.setData({ phase: "review", busy: false, errorText: "本地视频已失效，请重拍" });
            return;
        }
        const available = await this.localVideoAvailable();
        if (available === false) {
            this.setData({ phase: "review", busy: false, errorText: "本地视频临时文件已失效，请重拍；本次没有上传任何文件。" });
            return;
        }
        let begin = null;
        try {
            begin = await (0, api_1.callItemsApi)({
                action: "videoUploadBegin",
                purpose: "scene",
                scene_id: this.data.sceneId,
                ext: (0, video_attach_1.videoExtOf)(this.data.videoPath),
                duration_ms: this.data.videoDurationMs,
                video_w: this.data.videoWidth,
                video_h: this.data.videoHeight,
            });
        }
        catch (e) {
            this.setData({ phase: "review", busy: false, errorText: (0, api_1.errorMessage)(e) });
            return;
        }
        if (begin === null || begin.upload_ticket === undefined || typeof begin.upload_path !== "string" || typeof begin.asset_id !== "string") {
            this.setData({ phase: "review", busy: false, errorText: "服务返回异常，请稍后重试" });
            return;
        }
        const basePending = {
            sceneId: this.data.sceneId,
            uploadTicket: begin.upload_ticket,
            uploadPath: begin.upload_path,
            assetId: begin.asset_id,
            fileId: "",
            receiptDone: false,
            expiresAt: begin.expires_at,
            durationMs: this.data.videoDurationMs,
            width: this.data.videoWidth,
            height: this.data.videoHeight,
            frozenItems,
        };
        this.setData({ pendingUpload: basePending }, () => this.saveSession());
        let fileId = "";
        try {
            const uploaded = await new Promise((resolve, reject) => {
                wx.cloud.uploadFile({
                    cloudPath: begin.upload_path,
                    filePath: this.data.videoPath,
                    success: (res) => resolve({ fileID: res.fileID }),
                    fail: (err) => reject(new Error((err && err.errMsg) || "uploadFile:fail")),
                });
            });
            fileId = uploaded.fileID;
        }
        catch (e) {
            try {
                await (0, api_1.callItemsApi)({ action: "videoUploadCancel", upload_ticket: begin.upload_ticket });
            }
            catch (e2) { }
            this.setData({ phase: "review", busy: false, pendingUpload: null, errorText: "视频上传失败，请检查网络后重试" }, () => this.saveSession());
            wx.showModal({ title: "上传失败", content: "原视频没有上传成功，本次未写入任何物品证据。", showCancel: false });
            return;
        }
        const pending = { ...basePending, fileId };
        this.setData({ pendingUpload: pending, phase: "committing", busy: true }, () => this.saveSession());
        try {
            await (0, api_1.callItemsApi)({ action: "videoUploadReceipt", upload_ticket: pending.uploadTicket, file_id: fileId });
            const withReceipt = { ...pending, receiptDone: true };
            this.setData({ pendingUpload: withReceipt }, () => this.saveSession());
            await this.commitFrozenUpload(withReceipt);
        }
        catch (e) {
            const still = this.data.pendingUpload || pending;
            this.setData({
                phase: "partial",
                busy: false,
                errorText: (0, api_1.errorMessage)(e),
                resultText: "视频已上传，但还没有完成证据关联。可重试；不会自动重复创建物品。",
                pendingUpload: still,
            }, () => this.saveSession());
        }
    },
    async commitFrozenUpload(pending) {
        this.setData({ phase: "committing", busy: true, errorText: "" });
        try {
            const res = await (0, api_1.callItemsApi)({
                action: "videoSceneCommit",
                scene_id: pending.sceneId,
                upload_ticket: pending.uploadTicket,
                asset_id: pending.assetId,
                file_id: pending.fileId,
                duration_ms: pending.durationMs,
                video_w: pending.width,
                video_h: pending.height,
                consent_version: "v1",
                items: pending.frozenItems,
            });
            const failed = res.evidence_failed ? res.evidence_failed.length : 0;
            const successCount = res.results.filter((r) => r.ok === true).length;
            if (res.ticket_state === "partial" || failed > 0) {
                this.setData({
                    phase: "partial",
                    busy: false,
                    errorText: "已保存 " + successCount + " 件，仍有 " + failed + " 件未完成。",
                    resultText: "可用同一份确认内容重试剩余件；已成功件不会重复创建。",
                    pendingUpload: pending,
                }, () => this.saveSession());
                return;
            }
            this.setData({
                phase: "done",
                busy: false,
                errorText: "",
                resultText: "已为 " + successCount + " 件物品保存同一段视频证据，每件高亮彼此独立。",
                pendingUpload: null,
                frozenItems: pending.frozenItems,
            }, () => {
                this.clearSession();
                this.renderDrafts();
            });
            const session = this.scanSession;
            if (session !== undefined) {
                await session.cancel();
                this.scanSession = undefined;
            }
        }
        catch (e) {
            this.setData({
                phase: "partial",
                busy: false,
                errorText: (0, api_1.errorMessage)(e),
                resultText: "网络或服务异常；用同一份确认内容重试即可幂等收敛。",
                pendingUpload: pending,
            }, () => this.saveSession());
        }
    },
    async onRetryCommitTap() {
        const pending = this.data.pendingUpload;
        if (pending === null || this.data.busy)
            return;
        if (pending.fileId === "") {
            wx.showModal({
                title: "不能继续上次上传",
                content: "上次在视频上传完成前中断；请放弃待关联票据后重新确认，避免产生无主文件。",
                showCancel: false,
            });
            return;
        }
        this.setData({ busy: true, errorText: "" });
        try {
            if (pending.receiptDone === false) {
                await (0, api_1.callItemsApi)({ action: "videoUploadReceipt", upload_ticket: pending.uploadTicket, file_id: pending.fileId });
                const withReceipt = { ...pending, receiptDone: true };
                this.setData({ pendingUpload: withReceipt }, () => this.saveSession());
                await this.commitFrozenUpload(withReceipt);
            }
            else {
                await this.commitFrozenUpload(pending);
            }
        }
        catch (e) {
            this.setData({ phase: "partial", busy: false, errorText: (0, api_1.errorMessage)(e) }, () => this.saveSession());
        }
    },
    async onDiscardPendingTap() {
        const pending = this.data.pendingUpload;
        if (pending === null || this.data.busy)
            return;
        const confirmed = await new Promise((resolve) => {
            wx.showModal({
                title: "放弃待关联视频",
                content: "服务端会先判断是否已有物品证据：已有证据时不会删除原视频，只显示已保存部分。",
                confirmText: "放弃",
                confirmColor: "#d93025",
                success: (r) => resolve(r.confirm === true),
                fail: () => resolve(false),
            });
        });
        if (confirmed === false)
            return;
        this.setData({ busy: true });
        try {
            const res = await (0, api_1.callItemsApi)({ action: "videoUploadCancel", upload_ticket: pending.uploadTicket });
            if (res.state === "bound") {
                this.setData({
                    phase: "done",
                    busy: false,
                    pendingUpload: null,
                    resultText: "这段视频已经为部分物品保存为证据，不能整段删除；已关联物品保持不变。",
                }, () => this.clearSession());
            }
            else {
                this.setData({
                    phase: "review",
                    busy: false,
                    pendingUpload: null,
                    frozenItems: [],
                    errorText: "",
                    resultText: "已删除未关联的视频；仍可修改草稿后重新确认。",
                }, () => {
                    this.saveSession();
                });
            }
        }
        catch (e) {
            this.setData({ busy: false, errorText: (0, api_1.errorMessage)(e) });
            wx.showModal({ title: "删除失败", content: (0, api_1.errorMessage)(e), showCancel: false });
        }
    },
    onDoneBackTap() {
        wx.navigateBack({
            fail: () => {
                wx.showToast({ title: "返回失败，请手动返回", icon: "none" });
            },
        });
    },
});
