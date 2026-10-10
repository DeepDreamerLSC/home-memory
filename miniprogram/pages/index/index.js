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
        inputMode: "voice",
        voiceState: "idle",
        transcribing: false,
        recordSeconds: 0,
        partialText: "",
    },
    voiceCtrl: null,
    touchStartY: 0,
    recordTimer: 0,
    /** 按压会话守卫:授权异步回调、录音、取消、识别结果都必须属于同一次有效按压 */
    sessionGuard: null,
    activeVoiceSession: null,
    onLoad() {
        this.sessionGuard = (0, voice_1.createSessionGuard)();
        this.ensureVoiceCtrl();
    },
    onShow() {
        this.loadRecent();
    },
    onHide() {
        this.clearRecordTimer();
        this.invalidateVoiceSession();
    },
    onUnload() {
        this.clearRecordTimer();
        this.invalidateVoiceSession();
    },
    /**
     * 作废当前按压会话并终止在途录音/识别:
     * 松手早于授权返回、切换模式、离开页面时调用,防止"幽灵录音"与迟到的识别结果触发提取。
     */
    invalidateVoiceSession() {
        if (this.sessionGuard !== null) {
            this.sessionGuard.invalidate();
        }
        // 永久作废在途录音会话:迟到的启动回调与转写结果均按会话丢弃
        const session = this.activeVoiceSession;
        this.activeVoiceSession = null;
        if (session !== null && this.voiceCtrl !== null) {
            this.voiceCtrl.cancel(session);
        }
        this.clearRecordTimer();
        if (this.data.voiceState !== "idle" || this.data.transcribing) {
            this.setData({ voiceState: "idle", transcribing: false, partialText: "" });
        }
    },
    clearRecordTimer() {
        if (this.recordTimer) {
            clearInterval(this.recordTimer);
            this.recordTimer = 0;
        }
    },
    onMemoInput(e) {
        this.setData({ memoText: e.detail && e.detail.value ? e.detail.value : "" });
    },
    onModeText() {
        this.invalidateVoiceSession();
        this.setData({ inputMode: "text", voiceState: "idle", transcribing: false, partialText: "" });
    },
    onModeVoice() {
        this.setData({ inputMode: "voice", voiceState: "idle", transcribing: false, partialText: "", recordSeconds: 0 });
        this.ensureVoiceCtrl();
    },
    /** 惰性创建语音控制器(默认语音模式,页面加载即建) */
    ensureVoiceCtrl() {
        if (this.voiceCtrl !== null) {
            return;
        }
        this.voiceCtrl = (0, voice_1.createVoiceController)({
            onStart: () => {
                this.clearRecordTimer();
                this.setData({ voiceState: "recording", partialText: "", recordSeconds: 0 });
                this.recordTimer = setInterval(() => {
                    this.setData({ recordSeconds: this.data.recordSeconds + 1 });
                }, 1000);
            },
            onTranscribing: () => {
                this.clearRecordTimer();
                this.setData({ transcribing: true, partialText: "识别中…" });
            },
            onStop: (text) => {
                this.clearRecordTimer();
                this.activeVoiceSession = null; // 语音处理结束,释放会话引用
                this.setData({ voiceState: "idle", transcribing: false, partialText: text });
                // 空结果或纯语气词(环境噪音)不算有效输入:如实提示,不进提取,
                // 避免噪音文本被误报成"AI 不可用"
                if (!text || !(0, voice_1.isMeaningfulTranscript)(text)) {
                    wx.showToast({ title: "没听清,请重试或改用文字", icon: "none", duration: 2500 });
                    return;
                }
                // 转写完成 → 自动进入既有提取链路(录音→转写→AI提取→确认)。
                // 保留语音视图显示「AI 整理草稿中…」;memoText 同步保存,
                // 用户切「改用文字」时输入仍在(不丢用户文本)。
                this.setData({ memoText: text });
                this.onExtractTap();
            },
            onError: (code, message) => {
                this.clearRecordTimer();
                this.activeVoiceSession = null; // 语音处理结束(失败),释放会话引用
                this.setData({ voiceState: "idle", transcribing: false });
                wx.showToast({ title: message, icon: "none", duration: 2500 });
            },
        }, (0, voice_1.createDefaultVoiceDeps)());
    },
    onTalkTouchStart(e) {
        if ((0, voice_1.isVoiceEntryBusy)(this.data.voiceState, this.data.transcribing, this.data.extracting)) {
            return;
        }
        const touch = e.touches && e.touches[0];
        this.touchStartY = touch ? touch.clientY : 0;
        this.activeVoiceSession = null;
        // 页面级会话号只管「授权异步返回」窗口:松手/切换/离开后授权才返回则不发起录音
        const session = this.sessionGuard !== null ? this.sessionGuard.begin() : 0;
        void this.startRecording(session);
    },
    onTalkTouchMove(e) {
        if (this.data.voiceState === "idle") {
            return;
        }
        const touch = e.touches && e.touches[0];
        if (!touch) {
            return;
        }
        // 上滑/滑回仅切换视觉状态;真正作废在松手时按状态决定 stop 或 cancel
        if ((0, voice_1.isSlideUpCancel)(this.touchStartY, touch.clientY)) {
            if (this.data.voiceState !== "cancelPending") {
                this.setData({ voiceState: "cancelPending" });
            }
        }
        else if (this.data.voiceState === "cancelPending") {
            this.setData({ voiceState: "recording" });
        }
    },
    onTalkTouchEnd() {
        // 作废授权窗口(松手早于授权返回时不得再发起录音)
        if (this.sessionGuard !== null) {
            this.sessionGuard.invalidate();
        }
        const session = this.activeVoiceSession;
        if (session === null) {
            return; // 录音会话尚未建立(授权未返回):无事可收尾
        }
        if (this.voiceCtrl === null) {
            return;
        }
        if (this.data.voiceState === "cancelPending") {
            this.voiceCtrl.cancel(session); // 上滑取消:永久作废,立即释放引用
            this.activeVoiceSession = null;
            this.setData({ voiceState: "idle", partialText: "" });
        }
        else {
            // 正常松手:停止并进入转写。保留会话引用——"手指松开"不等于
            // "语音处理结束":识别中阶段仍可经 invalidateVoiceSession 取消;
            // 引用在 onStop/onError 回调(处理完成)时释放。
            this.voiceCtrl.stop(session);
        }
    },
    onTalkTouchCancel() {
        if (this.sessionGuard !== null) {
            this.sessionGuard.invalidate();
        }
        const session = this.activeVoiceSession;
        this.activeVoiceSession = null;
        if (session !== null && this.voiceCtrl !== null) {
            this.voiceCtrl.cancel(session);
        }
        this.setData({ voiceState: "idle", partialText: "" });
    },
    async startRecording(session) {
        const auth = await (0, voice_1.ensureRecordAuth)();
        if (this.sessionGuard !== null && !this.sessionGuard.isCurrent(session)) {
            return; // 松手/切换模式/离开页面后授权才返回:本次按压已作废,不发起录音
        }
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
        // 发起录音会话(建立会话后,启动/取消/转写回调全部按会话校验)
        this.activeVoiceSession = this.voiceCtrl.begin();
    },
    voiceFallbackToText() {
        this.invalidateVoiceSession();
        this.setData({ inputMode: "text", voiceState: "idle", transcribing: false, partialText: "" });
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
