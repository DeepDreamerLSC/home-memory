"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const voice_1 = require("../../utils/voice");
function toDisplayItems(items) {
    return items.map((item) => ({
        ...item,
        updated_at_text: (0, api_1.formatDateTime)(item.updated_at),
    }));
}
Page({
    data: {
        memoText: "",
        extracting: false,
        queryText: "",
        querying: false,
        queried: false,
        queryKeyword: "",
        queryResults: [],
        queryError: "",
        recentItems: [],
        recentLoading: false,
        recentError: "",
        inputMode: "text",
        voiceState: "idle",
        partialText: "",
    },
    voiceCtrl: null,
    touchStartY: 0,
    onShow() {
        this.loadRecent();
    },
    onMemoInput(e) {
        this.setData({ memoText: e.detail && e.detail.value ? e.detail.value : "" });
    },
    onModeText() {
        markVoiceCancelledIfRecording(this);
        this.setData({ inputMode: "text", voiceState: "idle", partialText: "" });
    },
    onModeVoice() {
        this.setData({ inputMode: "voice", voiceState: "idle", partialText: "" });
        if (this.voiceCtrl === null) {
            this.voiceCtrl = (0, voice_1.initVoiceController)({
                onStart: () => {
                    this.setData({ voiceState: "recording", partialText: "" });
                },
                onRecognize: (partial) => {
                    this.setData({ partialText: partial });
                },
                onStop: (text) => {
                    this.setData({ voiceState: "idle", partialText: text });
                    if (!text) {
                        wx.showToast({ title: "没听清,请重试或改用文字", icon: "none", duration: 2500 });
                        return;
                    }
                    // 转写完成 → 自动进入既有提取链路(录音→转写→AI提取→确认)
                    this.setData({ memoText: text, inputMode: "text" });
                    this.onExtractTap();
                },
                onError: (code, message) => {
                    this.setData({ voiceState: "idle" });
                    if (code === "PERMISSION") {
                        wx.showModal({
                            title: "需要录音权限",
                            content: "语音记一件需要使用麦克风。可以到设置中开启,或改用文字输入。",
                            confirmText: "去设置",
                            cancelText: "用文字",
                            success: (r) => {
                                if (r.confirm) {
                                    wx.openSetting({});
                                }
                                else {
                                    this.voiceFallbackToText();
                                }
                            },
                        });
                    }
                    else {
                        wx.showToast({ title: message, icon: "none", duration: 2500 });
                    }
                },
            });
        }
    },
    onTalkTouchStart(e) {
        if (this.data.voiceState !== "idle") {
            return;
        }
        const touch = e.touches && e.touches[0];
        this.touchStartY = touch ? touch.clientY : 0;
        (0, voice_1.resetVoiceCancelled)();
        // 授权异步,授权通过后手指可能仍按着;直接尝试启动
        void this.startRecording();
    },
    onTalkTouchMove(e) {
        if (this.data.voiceState === "idle") {
            return;
        }
        const touch = e.touches && e.touches[0];
        if (!touch) {
            return;
        }
        if ((0, voice_1.isSlideUpCancel)(this.touchStartY, touch.clientY)) {
            if (this.data.voiceState !== "cancelPending") {
                (0, voice_1.markVoiceCancelled)();
                this.setData({ voiceState: "cancelPending" });
            }
        }
        else if (this.data.voiceState === "cancelPending") {
            // 滑回按钮范围,恢复录音
            (0, voice_1.resetVoiceCancelled)();
            this.setData({ voiceState: "recording" });
        }
    },
    onTalkTouchEnd() {
        this.finishRecording();
    },
    onTalkTouchCancel() {
        (0, voice_1.markVoiceCancelled)();
        this.finishRecording();
    },
    async startRecording() {
        const auth = await (0, voice_1.ensureRecordAuth)();
        if (auth === "denied") {
            wx.showModal({
                title: "需要录音权限",
                content: "语音记一件需要使用麦克风。可以到设置中开启,或改用文字输入。",
                confirmText: "去设置",
                cancelText: "用文字",
                success: (r) => {
                    if (r.confirm) {
                        wx.openSetting({});
                    }
                    else {
                        this.voiceFallbackToText();
                    }
                },
            });
            return;
        }
        if (this.voiceCtrl === null) {
            // 授权通过后控制器缺失(不应发生):回退文字
            this.voiceFallbackToText();
            return;
        }
        this.voiceCtrl.start();
    },
    finishRecording() {
        if (this.data.voiceState === "idle") {
            return;
        }
        if (this.voiceCtrl !== null) {
            this.voiceCtrl.stop();
        }
        // 状态在 onStop/onError 回调里复位;取消场景这里立即复位视觉
        if (this.data.voiceState === "cancelPending") {
            this.setData({ voiceState: "idle", partialText: "" });
        }
    },
    voiceFallbackToText() {
        markVoiceCancelledIfRecording(this);
        this.setData({ inputMode: "text", voiceState: "idle", partialText: "" });
    },
    /** 记一件:textarea → extractDraft,按契约分流 */
    async onExtractTap() {
        const text = this.data.memoText.trim();
        if (!text) {
            wx.showToast({ title: "请先输入一句话", icon: "none" });
            return;
        }
        if (this.data.extracting) {
            return;
        }
        this.setData({ extracting: true });
        try {
            const res = await (0, api_1.callExtractDraft)(text);
            if ("needs_split" in res) {
                wx.showToast({
                    title: res.message || "一次只记一件物品,请分开说",
                    icon: "none",
                    duration: 2500,
                });
                return;
            }
            const draft = res.draft;
            this.goToConfirm("/pages/confirm/confirm?draft=" + encodeURIComponent(JSON.stringify(draft)));
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "AI_UNAVAILABLE") {
                // 契约流程:AI 不可用时征得确认后进入手动录入
                wx.showModal({
                    title: "AI 暂时不可用",
                    content: e.message,
                    confirmText: "手动录入",
                    cancelText: "取消",
                    success: (r) => {
                        if (r.confirm) {
                            this.goToConfirm("/pages/confirm/confirm?manual=true");
                        }
                    },
                });
            }
            else {
                wx.showModal({
                    title: "提取失败",
                    content: (0, api_1.errorMessage)(e),
                    showCancel: false,
                });
            }
        }
        finally {
            this.setData({ extracting: false });
        }
    },
    /** 找东西:输入名称 → itemsApi query */
    onQueryInput(e) {
        this.setData({ queryText: e.detail && e.detail.value ? e.detail.value : "" });
    },
    async onQueryTap() {
        const q = this.data.queryText.trim();
        if (!q) {
            wx.showToast({ title: "请输入物品名称", icon: "none" });
            return;
        }
        if (this.data.querying) {
            return;
        }
        this.setData({ querying: true, queryError: "" });
        try {
            const res = await (0, api_1.callItemsApi)({ action: "query", q });
            this.setData({
                queried: true,
                queryKeyword: q,
                queryResults: toDisplayItems(res.items),
            });
        }
        catch (e) {
            this.setData({
                queried: true,
                queryKeyword: q,
                queryResults: [],
                queryError: (0, api_1.errorMessage)(e),
            });
        }
        finally {
            this.setData({ querying: false });
        }
    },
    onResultTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        const item = this.data.queryResults[index];
        if (item) {
            this.openItem(item);
        }
    },
    onRecentTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        const item = this.data.recentItems[index];
        if (item) {
            this.openItem(item);
        }
    },
    /** 最近记录:itemsApi list */
    async loadRecent() {
        this.setData({ recentLoading: true, recentError: "" });
        try {
            const res = await (0, api_1.callItemsApi)({ action: "list" });
            this.setData({ recentItems: toDisplayItems(res.items) });
        }
        catch (e) {
            this.setData({ recentError: (0, api_1.errorMessage)(e) });
        }
        finally {
            this.setData({ recentLoading: false });
        }
    },
    openItem(item) {
        wx.navigateTo({
            url: "/pages/item/item?data=" + encodeURIComponent(JSON.stringify(item)),
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    goToConfirm(url) {
        wx.navigateTo({
            url,
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
});
/** 切换/离开时若仍在录音,标记取消并停止(不产生识别结果) */
function markVoiceCancelledIfRecording(page) {
    if (page.data.voiceState !== "idle") {
        (0, voice_1.markVoiceCancelled)();
        if (page.voiceCtrl !== null) {
            page.voiceCtrl.stop();
        }
    }
}
