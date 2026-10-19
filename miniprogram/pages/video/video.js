"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 视频识别确认页:
 * 选视频 -> 客户端抽帧 -> 逐帧 vlRecognize -> 同名聚合 -> 用户确认
 * -> 上传原视频一次 -> videoCommit 批量建档 + 视频证据(时间窗/高亮框)。
 * 识别只是候选;用户勾选并保存后才有事实写入。
 */
const api_1 = require("../../utils/api");
const households_api_1 = require("../../utils/households-api");
const household_scope_1 = require("../../utils/household-scope");
const photo_vl_1 = require("../../utils/photo-vl");
const video_frames_1 = require("../../utils/video-frames");
const video_intake_1 = require("../../utils/video-intake");
Page({
    data: {
        stage: "pick",
        analyzeText: "",
        analyzeDetail: "",
        noticeText: "",
        errorText: "",
        rows: [],
        batchLocation: "",
        videoText: "",
        pickDisabled: false,
        saveText: "确认记住",
    },
    video: null,
    rowsRaw: [],
    batchId: "",
    fileId: null,
    scopeId: "",
    saving: false,
    onLoad() {
        this.batchId = (0, api_1.uuid)();
    },
    renderRows() {
        const confMap = { high: "高", mid: "中", low: "低" };
        this.setData({
            rows: this.rowsRaw.map((r, i) => ({
                draftId: r.draftId,
                index: i,
                name: r.name,
                qty: r.qty,
                qtyNote: r.qtyNote,
                checked: r.checked,
                confText: r.seenCount > 0 ? confMap[r.confidence] + " · 出现 " + r.seenCount + " 帧" : "手动添加",
                seenText: r.seenCount > 0 ? "视频里有 " + r.seenCount + " 个采样帧识别到" : "仅保存视频证据,无自动高亮",
                isManual: r.seenCount === 0,
            })),
        });
    },
    async onChooseVideo() {
        if (this.data.pickDisabled)
            return;
        this.setData({ pickDisabled: true, errorText: "", noticeText: "" });
        const consent = await new Promise((resolve) => {
            wx.showModal({
                title: "视频识别说明",
                content: "识别需要把从视频里抽出的少量画面临时发送到云端处理,不会保存这些帧;原视频只在你确认保存后才会上传保存。",
                confirmText: "开始识别",
                cancelText: "取消",
                success: (r) => resolve(r.confirm === true),
                fail: () => resolve(false),
            });
        });
        if (consent === false) {
            this.setData({ pickDisabled: false });
            return;
        }
        const video = await (0, video_intake_1.pickVideo)();
        if (video === null) {
            this.setData({ pickDisabled: false });
            return;
        }
        this.video = video;
        this.fileId = null;
        this.setData({
            stage: "analyzing",
            videoText: Math.round(video.duration_ms / 1000) + " 秒 · " + video.width + "×" + video.height,
            analyzeText: "正在抽取关键帧",
            analyzeDetail: "识别在手机本地抽帧后逐帧进行,原视频要等你确认保存后才会上传",
        });
        try {
            await (0, households_api_1.ensureScopeVerified)();
            this.scopeId = (0, household_scope_1.householdScopeId)();
        }
        catch (e) {
            this.scopeId = "";
        }
        let frames;
        try {
            frames = await (0, video_frames_1.extractVideoFrames)(video.path, video.duration_ms, 8);
        }
        catch (e) {
            this.rowsRaw = [];
            this.setData({
                stage: "review",
                pickDisabled: false,
                analyzeText: "",
                analyzeDetail: "",
                noticeText: "自动抽帧暂不可用。视频仍可保存为证据;你可以手动添加物品名称。",
            });
            this.renderRows();
            return;
        }
        const recognitions = [];
        let failedFrames = 0;
        for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            this.setData({
                analyzeText: "正在识别第 " + (i + 1) + "/" + frames.length + " 帧",
                analyzeDetail: "只把抽出的帧临时发给云端识别,原视频尚未上传",
            });
            const out = await (0, photo_vl_1.recognizeWithVl)({
                ok: true,
                path: video.path,
                imgW: frame.width,
                imgH: frame.height,
                base64: frame.base64,
                compressed: false,
            });
            if (out.ok) {
                recognitions.push({ time_ms: frame.time_ms, items: out.items });
            }
            else {
                failedFrames += 1;
            }
        }
        const candidates = (0, video_frames_1.aggregateVideoRecognitions)(recognitions, video.duration_ms, 10);
        this.rowsRaw = candidates.map((c) => ({
            draftId: (0, api_1.uuid)(),
            name: c.name,
            qty: 1,
            qtyNote: c.qty_note,
            checked: true,
            confidence: c.confidence,
            seenCount: c.seen_count,
            highlights: c.highlights,
        }));
        const notice = candidates.length === 0
            ? "没有自动识别出物品。你可以手动添加,视频仍会作为证据保存。"
            : failedFrames > 0
                ? "有 " + failedFrames + "/" + frames.length + " 个采样帧识别失败;下面是成功帧的候选,请逐件核对。"
                : "";
        this.setData({ stage: "review", pickDisabled: false, analyzeText: "", analyzeDetail: "", noticeText: notice });
        this.renderRows();
    },
    onAddManual() {
        this.rowsRaw.push({
            draftId: (0, api_1.uuid)(),
            name: "",
            qty: 1,
            qtyNote: "",
            checked: true,
            confidence: "low",
            seenCount: 0,
            highlights: [],
        });
        this.renderRows();
    },
    onToggle(e) {
        const i = Number(e.currentTarget.dataset.index);
        if (this.rowsRaw[i] === undefined)
            return;
        this.rowsRaw[i] = { ...this.rowsRaw[i], checked: this.rowsRaw[i].checked === false };
        this.renderRows();
    },
    onNameInput(e) {
        const i = Number(e.currentTarget.dataset.index);
        if (this.rowsRaw[i] === undefined)
            return;
        this.rowsRaw[i] = { ...this.rowsRaw[i], name: e.detail.value || "" };
        this.renderRows();
    },
    onQtyStep(e) {
        const i = Number(e.currentTarget.dataset.index);
        const dir = Number(e.currentTarget.dataset.dir);
        if (this.rowsRaw[i] === undefined)
            return;
        const next = Math.max(1, Math.min(99, this.rowsRaw[i].qty + (dir === -1 ? -1 : 1)));
        this.rowsRaw[i] = { ...this.rowsRaw[i], qty: next };
        this.renderRows();
    },
    onBatchLocationInput(e) {
        this.setData({ batchLocation: e.detail.value || "" });
    },
    async onSave() {
        if (this.saving || this.video === null)
            return;
        const filled = this.rowsRaw.filter((r) => r.checked && r.name.trim() !== "");
        if (filled.length === 0) {
            this.setData({ errorText: "请至少保留一件物品并填写名称" });
            return;
        }
        if (this.data.batchLocation.trim() === "") {
            this.setData({ errorText: "请填写这批物品的位置" });
            return;
        }
        if (this.scopeId === "") {
            this.setData({ errorText: "暂时无法确认当前家庭,请稍后重试" });
            return;
        }
        this.saving = true;
        this.setData({ stage: "saving", saveText: "正在保存…", errorText: "" });
        const outcome = await (0, video_intake_1.commitVideoBatch)({
            batchId: this.batchId,
            rows: this.rowsRaw,
            batchLocation: this.data.batchLocation,
            video: this.video,
            scopeId: this.scopeId,
            fileId: this.fileId,
        });
        this.fileId = outcome.fileId || null;
        if (outcome.ok === false) {
            this.saving = false;
            this.setData({ stage: "review", saveText: "确认记住", errorText: outcome.message });
            return;
        }
        const failedRows = outcome.results.filter((r) => r.ok === false).length;
        let evidenceFailed = outcome.evidenceFailed.length;
        if (evidenceFailed > 0) {
            const itemIdByIndex = {};
            outcome.results.forEach((r) => {
                if (r.ok && r.item_id)
                    itemIdByIndex[r.index] = r.item_id;
            });
            try {
                const still = await (0, video_intake_1.retryVideoEvidence)(outcome.video, this.rowsRaw, itemIdByIndex);
                evidenceFailed = still.length;
            }
            catch (e) {
                evidenceFailed = outcome.evidenceFailed.length;
            }
        }
        this.saving = false;
        this.setData({ stage: "done", saveText: "已保存" });
        const pieces = [];
        outcome.results.forEach((r) => {
            if (r.ok === false && r.message)
                pieces.push(r.message);
        });
        let msg = "已记住 " + (outcome.results.length - failedRows) + " 件";
        if (failedRows > 0)
            msg += ";有 " + failedRows + " 件没存上";
        if (evidenceFailed > 0)
            msg += ";" + evidenceFailed + " 件视频待关联";
        wx.showToast({ title: msg, icon: "none", duration: 2600 });
        setTimeout(() => this.goBack(), 900);
    },
    goBack() {
        wx.navigateBack({
            fail: () => wx.reLaunch({ url: "/pages/index/index" }),
        });
    },
});
