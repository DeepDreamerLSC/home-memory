"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const voice_1 = require("../../utils/voice");
const draft_session_1 = require("../../utils/draft-session");
const household_scope_1 = require("../../utils/household-scope");
const households_api_1 = require("../../utils/households-api");
const households_api_2 = require("../../utils/households-api");
const household_scope_2 = require("../../utils/household-scope");
function toDisplayItems(items) {
    return items.map((item) => ({
        ...item,
        updated_at_text: (0, api_1.formatDateTime)(item.updated_at),
    }));
}
Page({
    data: {
        familyShared: false,
        selfNick: "",
        selfAvatar: "",
        nickModalOpen: false,
        nickDraft: "",
        pendingAvatarTemp: "",
        profileSaving: false,
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
        /** 未完成草稿会话恢复入口(非空时显示横幅) */
        resumeSession: null,
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
    onLoad(options) {
        this.sessionGuard = (0, voice_1.createSessionGuard)();
        this.ensureVoiceCtrl();
        // 邀请卡片落地兜底(issue #34 P1-B):分享卡片 path 指向加入确认页,
        // 冷启动直达;若有其他入口把 invite 带到首页,转送加入确认页(一步确认)
        const invite = options && options.invite ? String(options.invite).trim() : "";
        if (invite) {
            wx.navigateTo({
                url: "/pages/join-family/join-family?invite=" + encodeURIComponent(invite),
                fail: () => {
                    wx.showToast({ title: "邀请打开失败,请重试", icon: "none" });
                },
            });
        }
    },
    /** 头像栏状态刷新(来自 household-scope 记忆;app 前台复核后已最新) */
    refreshProfileBar() {
        const prof = (0, household_scope_1.householdSelfProfile)();
        this.setData({
            familyShared: (0, household_scope_1.isHouseholdScopeShared)(),
            selfNick: prof.nickname || "",
            selfAvatar: prof.avatarFileId || "",
        });
        void this.setData({ familyNameTip: (0, household_scope_1.householdScopeName)() || "" });
    },
    /** 选完头像:弹昵称弹窗(一起保存;取消丢弃) */
    onHomeAvatarChosen(e) {
        const url = e.detail && e.detail.avatarUrl;
        if (typeof url !== "string" || url.length === 0) {
            return;
        }
        this.setData({ pendingAvatarTemp: url, nickModalOpen: true, nickDraft: this.data.selfNick });
    },
    /** 个人家庭:如实提示(资料是家庭成员间的展示,非账号体系) */
    onHomeAvatarPersonalTap() {
        wx.showModal({
            title: "头像与昵称",
            content: "头像昵称是给共享家庭的家人看的。创建或加入共享家庭后,在这里点一下即可设置。",
            showCancel: false,
            confirmText: "知道了",
        });
    },
    onNickDraftInput(e) {
        this.setData({ nickDraft: (e.detail.value || "").trim() });
    },
    onNickModalCancel() {
        this.setData({ nickModalOpen: false, pendingAvatarTemp: "", nickDraft: "" });
    },
    /** 保存:头像传云存储 → updateProfile → 本地记忆/头像栏更新 */
    async onNickModalSave() {
        if (this.data.profileSaving) {
            return;
        }
        const patch = {};
        const nick = this.data.nickDraft.trim();
        if (nick !== "") {
            patch.nickname = nick;
        }
        this.setData({ profileSaving: true });
        try {
            if (this.data.pendingAvatarTemp) {
                const up = await wx.cloud.uploadFile({
                    cloudPath: "household-avatars/" +
                        Date.now() +
                        "-" +
                        Math.floor(Math.random() * 1000000) +
                        ".jpg",
                    filePath: this.data.pendingAvatarTemp,
                });
                if (up.fileID) {
                    patch.avatar_file_id = up.fileID;
                }
            }
            if (Object.keys(patch).length === 0) {
                wx.showToast({ title: "填个昵称或选个头像再保存", icon: "none" });
                return;
            }
            await (0, households_api_1.updateHouseholdProfile)(patch);
            wx.showToast({ title: "已保存", icon: "success" });
            this.setData({ nickModalOpen: false, pendingAvatarTemp: "", nickDraft: "" });
            this.refreshProfileBar();
        }
        catch (e) {
            wx.showModal({ title: "保存失败", content: (0, api_1.errorMessage)(e), showCancel: false });
        }
        finally {
            this.setData({ profileSaving: false });
        }
    },
    onShow() {
        this.refreshProfileBar();
        void this.loadRecent();
        // 未完成草稿会话恢复入口(中途退出/进程回收;原幂等键续存,不重复建档)。
        // 展示前资格复核(硬门 C):先等服务端家庭上下文验证,未验证期间不把
        // 旧家庭的未完成批次当作当前可访问内容展示;验证失败时保持无横幅
        // (loadRecent 的 list 响应也会捕获作用域并标记已验证)
        void (0, households_api_2.ensureScopeVerified)().then(() => {
            this.setData({ resumeSession: this.currentResumeSession() });
        });
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
    /**
     * 未完成批次的新建门禁(第四轮评审阻断项):存在未完成会话时直接新建会覆盖
     * 持久化恢复入口,旧批次已保存行的 operation_id 幂等键随之丢失——必须先由
     * 用户明确裁决:继续核对旧的 / 放弃旧的记新的 / 中止(什么都不动)。
     */
    askDraftEntryIntent(count) {
        return new Promise((resolve) => {
            wx.showActionSheet({
                itemList: ["继续核对上一批(共 " + count + " 件)", "放弃上一批,记新的"],
                success: (r) => {
                    resolve(r.tapIndex === 0 ? "resume" : "discard");
                },
                fail: () => {
                    resolve("abort"); // 点遮罩/取消:保留旧批次,本次不提取
                },
            });
        });
    },
    /**
     * 放弃旧批次的二次确认(五轮评审):明确「放弃」只是丢掉恢复入口,
     * 不是数据库撤销——已保存的物品不会回滚,结果未知的物品可能已入库。
     */
    confirmDiscardDraft() {
        return new Promise((resolve) => {
            wx.showModal({
                title: "放弃上一批?",
                content: "已保存的物品不会被撤销;结果未知的物品可能已入库,可稍后在「最近记住的」中查看。",
                confirmText: "放弃,记新的",
                cancelText: "返回",
                success: (r) => {
                    resolve(r.confirm);
                },
                fail: () => {
                    resolve(false);
                },
            });
        });
    },
    /** 记一件:textarea → extractDraft(v2 多件拆分),草稿入临时会话,确认页按 sid 取 */
    async onExtractTap() {
        const text = this.data.memoText.trim();
        if (!text) {
            wx.showToast({ title: "请先输入一句话", icon: "none" });
            return;
        }
        if (this.data.extracting) {
            return;
        }
        const unfinished = (0, draft_session_1.getUnfinishedDraftSession)();
        if (unfinished !== null) {
            const choice = await this.askDraftEntryIntent(unfinished.payload.drafts.length);
            if (choice === "resume") {
                this.goToConfirm("/pages/confirm/confirm?sid=" + unfinished.sid);
                return;
            }
            if (choice === "abort") {
                return;
            }
            // 放弃:二次确认讲清语义(非数据库撤销),显式清除恢复入口后才开始本次提取
            if (!(await this.confirmDiscardDraft())) {
                return;
            }
            (0, draft_session_1.clearDraftSession)(unfinished.sid);
        }
        this.setData({ extracting: true });
        try {
            const res = await (0, api_1.callExtractDraft)(text, { protocol: 2 });
            if ("drafts" in res) {
                // v2:一句话 1-5 件,统一走列表确认页(单件也是 1 行列表)
                const sid = (0, draft_session_1.createDraftSession)(res.original_text, res.drafts, res.truncated);
                this.goToConfirm("/pages/confirm/confirm?sid=" + sid);
                return;
            }
            if ("needs_split" in res) {
                // 防御:服务端未升级窗口内仍可能返回旧形态
                wx.showToast({
                    title: res.message || "一次只记一件物品,请分开说",
                    icon: "none",
                    duration: 2500,
                });
                return;
            }
            // v1 单草稿兜底:同样入会话走列表页
            const sid = (0, draft_session_1.createDraftSession)(text, [{ ...res.draft, source_quote: text }], false);
            this.goToConfirm("/pages/confirm/confirm?sid=" + sid);
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
    onResumeTap() {
        const resume = this.data.resumeSession;
        if (resume === null) {
            return;
        }
        this.setData({ resumeSession: null });
        this.goToConfirm("/pages/confirm/confirm?sid=" + resume.sid);
    },
    /** 未完成批次数据按当前家庭作用域读取(键隔离,P0;验证后才读,硬门 C) */
    currentResumeSession() {
        const unfinished = (0, draft_session_1.getUnfinishedDraftSession)();
        if (unfinished === null) {
            return null;
        }
        return { sid: unfinished.sid, count: unfinished.payload.drafts.length };
    },
    onRecentTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        const item = this.data.recentItems[index];
        if (item) {
            this.openItem(item);
        }
    },
    /** 最近记录:itemsApi list;家庭切换(作用域代数变化)后的迟到响应不上屏 */
    async loadRecent() {
        const scopeGen = (0, household_scope_2.captureScopeGeneration)();
        this.setData({ recentLoading: true, recentError: "" });
        try {
            const res = await (0, api_1.callItemsApi)({ action: "list" });
            if (!(0, household_scope_2.isScopeGenerationCurrent)(scopeGen)) {
                return; // 家庭刚切换(创建/加入/退出/被移除):旧家庭响应不上屏
            }
            this.setData({ recentItems: toDisplayItems(res.items) });
        }
        catch (e) {
            if (!(0, household_scope_2.isScopeGenerationCurrent)(scopeGen)) {
                return;
            }
            this.setData({ recentError: (0, api_1.errorMessage)(e) });
        }
        finally {
            if ((0, household_scope_2.isScopeGenerationCurrent)(scopeGen)) {
                this.setData({ recentLoading: false });
            }
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
    onHomeTreeTap() {
        wx.navigateTo({
            url: "/pages/locations/locations",
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    /** 家庭管理页入口(issue #34 P1-B:创建/邀请/成员/退出/解散) */
    onFamilyTap() {
        wx.navigateTo({
            url: "/pages/family/family",
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
});
