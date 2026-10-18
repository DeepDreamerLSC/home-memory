"use strict";
/**
 * 拍照识物确认页(#3,屏①-⑤;docs/design/issue3-photo-intake/IMPLEMENTATION.md §4.1/§5/§7/§8)。
 *
 * 两模式:confirm(默认,候选清单)与 circle(圈选补识别)。承载:
 * - 证据条:默认折叠(压暗缩略),点开或点候选行展开全幅并高亮该候选框;
 *   容器等比跟随原图(aspect-ratio = img_w/img_h,零裁切,§3.2 纪律);
 * - 候选清单三态(候选/保留/已确认记住)+ 计数单一来源(utils/intake-draft);
 * - 位置栏:批次位置(手动/常用快选/按住说位置),逐件例外在编辑面板改;保存
 *   成功后批次位置与各件例外像语音确认流程一样挂到位置节点树(issue #65 V0.4
 *   第③条:同一 ensureAndLink 机制,失败不回滚不阻断,只轻提示「主界面可补」);
 *   挂树分段 LLM 逐字锚定优先(extractDraft.locationSplit 预热 locPathCache,
 *   无分隔符中文可拆「书房 › 桌子 › 右边抽屉」,位置栏同步层级预览),缺失/在途
 *   走 splitLocationSegments 分隔符规则兜底,绝不因异步拆分未返回而阻塞保存;
 * - 按住说话:utils/voice-entry 单例的真实手势机(按住/松手/上滑取消/最短按压),
 *   本页只渲染 recsheet 浮层并经 routeExtract 旁路接 draftEditParse → diff 弹层
 *   (逐字段勾选应用,0 勾选禁用;原话保留可回听);
 * - 手动编辑面板 / 保存最终确认弹层 / 圈选画框;
 * - 隐私口径:确认「存 n 件」前照片不持久化、不写云存储(识别的临时传输需首次
 *   授权,B4;utils/photo-intake.commitPhotoBatch 是唯一写云存储动作,只在最终确认后到达)。
 *
 * 生命周期(§7.8):onHide/onUnload → voiceEntry.invalidate()(防幽灵录音与迟到 diff);
 * onUnload 另递增 captureEpoch(PR #67 R2),在途识别/授权/降级弹窗/圈选的迟到
 * 回包按代数核对后静默丢弃,页面销毁后零建会话零上屏。
 */
Object.defineProperty(exports, "__esModule", { value: true });
const intake_draft_1 = require("../../utils/intake-draft");
const photo_box_1 = require("../../utils/photo-box");
const photo_vl_1 = require("../../utils/photo-vl");
const photo_intake_1 = require("../../utils/photo-intake");
const photo_session_1 = require("../../utils/photo-session");
const voice_entry_1 = require("../../utils/voice-entry");
const api_1 = require("../../utils/api");
const household_scope_1 = require("../../utils/household-scope");
const locations_cache_1 = require("../../utils/locations-cache");
/** 置信度展示文案(只作排序/标注,不作确认依据) */
const CONFIDENCE_LABEL = {
    high: "高",
    mid: "中",
    low: "低",
};
/** diff 弹层字段名固定文案(§5.3) */
const EDIT_FIELD_LABEL = {
    name: "名称",
    qty_note: "数量备注",
    location: "位置(例外,不继承批次)",
};
/** 提醒类别冻结词表(与服务端 remind_kind 同源;编辑面板 picker 用) */
const REMIND_KIND_OPTIONS = ["有效期", "开封后", "下次维护"];
/** 圈选框最小显示尺寸(px):小于此视为误触,不发起识别 */
const CIRCLE_MIN_PX = 12;
/**
 * 云端识别授权记忆键(PR #67 B4,命名沿用 home-memory: 前缀风格):
 * 值 "granted" = 用户同意过识别临时传输,此后不再询问;**拒绝不落键**
 * (重新进入拍照页时会再询问——本仓库无设置页,不做「去设置开启」入口)。
 */
const VL_AUTH_STORAGE_KEY = "home-memory:photo-vl-auth";
/** 授权弹窗文案:如实说明识别=临时传输处理,保存是另一回事 */
const VL_AUTH_CONTENT = "识别需要把这张照片临时发送到云端处理(仅传输识别,不会保存);你点确认入库后,照片才会保存。";
/* ---------------- 页面 ---------------- */
/** 展开态尺寸(真机 2026-10-17 二次反馈:aspect-ratio/min/calc/vh 在部分内核未全生效,
 * 照片曾放大至 300%+;改为 JS 直接算像素——横向或纵向先撑满即停,样式只吃 px)。
 * 规则:先按宽撑满;高超过屏高 46% 则按高截断、宽同比例回缩,居中留黑边,零裁剪。 */
function photoExpandStyleOf(imgW, imgH, winW, winH) {
    const r = imgW > 0 && imgH > 0 ? imgW / imgH : 4 / 3;
    let w = winW;
    let h = winW / r;
    const capH = Math.round(winH * 0.46);
    if (h > capH) {
        h = capH;
        w = Math.round(capH * r);
    }
    return "width:" + Math.round(w) + "px;height:" + Math.round(h) + "px;margin:0 auto;";
}
Page({
    data: {
        mode: "confirm",
        entryReady: false,
        recognizing: false,
        entryHint: "",
        photoPath: "",
        imgW: 0,
        imgH: 0,
        photoAspect: "4 / 3",
        photoExpandStyle: "width:375px;height:281px;margin:0 auto;",
        photoCollapsed: true,
        qkHigh: 0,
        /** 窗口逻辑尺寸(onLoad 读取;stub 环境失败用 375×667) */
        winW: 375,
        winH: 667,
        voiceCtaText: "这些物品位置在哪,请告诉我",
        celebrateText: null,
        highlightId: "",
        boxViews: [],
        rows: [],
        headText: "保留 0 / 0(待核对)",
        saveText: "存 0 件",
        saveDisabled: true,
        navSubtitle: "",
        batchLocation: "",
        locPathText: "",
        recentLocations: [],
        voiceState: "idle",
        transcribing: false,
        extracting: false,
        recordSeconds: 0,
        partialText: "",
        holdPressed: false,
        diffLoading: false,
        diff: null,
        edit: null,
        saveSheet: null,
        saveBusy: false,
        circle: {
            drawing: false,
            rect: null,
            recognizing: false,
            errorText: "",
            result: null,
        },
        vlAuthDenied: false,
        evidencePending: null,
        evidenceRetryBusy: false,
    },
    rowsRaw: [],
    prepared: null,
    fileId: null,
    batchId: "",
    sessionCreatedAt: 0,
    sessionScope: null,
    entryScope: null,
    batchFinished: false,
    capturing: false,
    captureEpoch: 0,
    committing: false,
    pendingEvidence: null,
    celebrateTimer: null,
    saveBackTimer: null,
    saveBackDelayMs: 1500,
    evidenceRetryBusy: false,
    lastAudioPath: "",
    audioPlayed: false,
    diffEditsRaw: [],
    diffTargetDraftId: "",
    diffAddQtyNote: "",
    diffText: "",
    circleStart: null,
    circleBox: null,
    circleRectEl: null,
    voiceEntry: null,
    vlAuthGranted: false,
    vlAuthAsked: false,
    locPathCache: {},
    locPathPending: {},
    onLoad(options) {
        try {
            const si = wx.getSystemInfoSync();
            if (si && si.windowWidth > 0) {
                this.setData({ winW: si.windowWidth, winH: si.windowHeight || 667 });
            }
        }
        catch (e) {
            /* stub/异常:保持默认 375×667 */
        }
        // 实例态重建(Page options 被浅拷贝共享,index 页同款防护)
        this.rowsRaw = [];
        this.prepared = null;
        this.fileId = null;
        this.batchId = "";
        this.sessionCreatedAt = 0;
        this.sessionScope = null;
        this.entryScope = null;
        this.batchFinished = false;
        // B4:授权记忆还原(同意过识别临时传输的不再问;拒绝不落键,重进会再问)
        this.vlAuthGranted = this.readVlAuthRemembered();
        this.vlAuthAsked = this.vlAuthGranted;
        // 位置层级拆分缓存/在途表重建(Page options 被浅拷贝共享,同 rowsRaw 防护)
        this.locPathCache = {};
        this.locPathPending = {};
        this.capturing = false;
        this.captureEpoch = 0;
        this.committing = false;
        this.pendingEvidence = null;
        this.evidenceRetryBusy = false;
        this.lastAudioPath = "";
        this.audioPlayed = false;
        this.diffEditsRaw = [];
        this.diffTargetDraftId = "";
        this.diffAddQtyNote = "";
        this.diffText = "";
        this.circleStart = null;
        this.circleBox = null;
        this.circleRectEl = null;
        this.ensureVoiceEntry();
        const resume = options !== undefined && options.resume === "1";
        if (resume) {
            this.restoreSession();
            return;
        }
        void this.beginCapture();
    },
    onShow() {
        this.refreshRecentLocations();
    },
    onHide() {
        if (this.voiceEntry !== null) {
            this.voiceEntry.invalidate();
        }
    },
    onUnload() {
        if (this.voiceEntry !== null) {
            this.voiceEntry.invalidate();
            this.voiceEntry.detach();
            this.voiceEntry = null;
        }
        // R2:页面销毁——在途异步(识别/授权/降级弹窗/圈选)的迟到回包全部失效
        this.captureEpoch += 1;
        if (this.celebrateTimer !== null) {
            clearTimeout(this.celebrateTimer);
            this.celebrateTimer = null;
        }
        if (this.saveBackTimer !== null) {
            clearTimeout(this.saveBackTimer);
            this.saveBackTimer = null;
        }
        // 全部入库(或空批)**且无证据待关联**才清会话;否则中途退出保留恢复入口
        // (§4.1 photo-session)。pendingEvidence 非空(C3:evidence_failed 待重试关联)
        // 时一律 persistSession——用户离开绝不删会话与续联载荷,跨页恢复重试不断链
        // (PR #67 R1)。
        const rows = this.rowsRaw;
        const batchAllDone = this.batchFinished || rows.length === 0 || rows.every((r) => r.done);
        if (batchAllDone && this.pendingEvidence === null) {
            (0, photo_session_1.clearPhotoSession)();
        }
        else {
            this.persistSession();
        }
    },
    /* ---------------- 拍照入口(§7.3/§7.4 降级) ---------------- */
    /** 读授权记忆(best-effort:读失败按未授权处理,绝不静默放行识别) */
    readVlAuthRemembered() {
        if (typeof wx === "undefined" || typeof wx.getStorageSync !== "function") {
            return false;
        }
        try {
            return wx.getStorageSync(VL_AUTH_STORAGE_KEY) === "granted";
        }
        catch (e) {
            return false;
        }
    },
    /**
     * 首次识别授权(B4,一次性):识别需把照片临时发送到云端处理,先征得同意。
     * 同意 → storage 记忆 "granted"(此后不再问);拒绝 → 本次不调识别(不落键,
     * 重新进入本页会再询问——无设置页,不造入口),页面仍可手动/语音建候选。
     * 已问过且未同意(本页访问内)→ 不再问,直接按拒绝返回。
     */
    askVlAuthOnce() {
        if (this.vlAuthGranted) {
            return Promise.resolve(true);
        }
        if (!this.vlAuthAsked) {
            this.vlAuthAsked = true;
            return new Promise((resolve) => {
                wx.showModal({
                    title: "云端识别授权",
                    content: VL_AUTH_CONTENT,
                    confirmText: "同意",
                    cancelText: "本次不用",
                    success: (r) => {
                        if (r.confirm) {
                            this.vlAuthGranted = true;
                            if (typeof wx !== "undefined" && typeof wx.setStorageSync === "function") {
                                try {
                                    wx.setStorageSync(VL_AUTH_STORAGE_KEY, "granted");
                                }
                                catch (e) {
                                    // 记忆失败不影响本次:下次进入再问一次(如实,不静默放行)
                                }
                            }
                            resolve(true);
                            return;
                        }
                        this.setData({ vlAuthDenied: true });
                        resolve(false);
                    },
                    fail: () => {
                        // 弹层失败按拒绝处理:绝不未经同意就发起识别传输
                        this.setData({ vlAuthDenied: true });
                        resolve(false);
                    },
                });
            });
        }
        return Promise.resolve(false);
    },
    async beginCapture() {
        if (this.capturing) {
            return;
        }
        // R2:新一轮拍照流程开始——上一轮在途异步的迟到回包全部失效
        this.captureEpoch += 1;
        const epoch = this.captureEpoch;
        this.capturing = true;
        this.setData({ recognizing: true, entryHint: "" });
        const shot = await (0, photo_intake_1.takePhoto)();
        if (epoch !== this.captureEpoch) {
            return; // R2:页面已走/已被新一轮接管:选片回包静默丢弃
        }
        if (!shot.ok) {
            this.capturing = false;
            if (shot.kind === "cancel") {
                // §7.3:两次都取消 → 返回上一页(navigateBack 失败时留在入口可再拍)
                this.setData({ recognizing: false });
                this.navigateBackSafe();
                return;
            }
            // 用户去系统设置开权限:留在入口态等回来
            this.setData({
                recognizing: false,
                entryHint: "去设置开启相机权限后回来重拍;也可以再点按钮从相册选。",
            });
            return;
        }
        // C1(PR #67):照片在手 = 最早能确定「用户要拍这张照片」的时机——先捕获入口
        // 作用域,此后本批会话一律绑定它(识别/授权等待期间家庭切换,不得把本批改投
        // 切换后的家庭;识别返回后先复核漂移,漂移即不建会话)
        this.entryScope = (0, photo_session_1.capturePhotoSessionScope)();
        // 本地压缩 → 宽高 → base64(不写云存储;prepared 只存页面内存,识别传输见下方授权门)
        const prepared = await (0, photo_vl_1.preparePhotoForVl)(shot.tempFilePath);
        if (epoch !== this.captureEpoch) {
            return; // R2:压缩/读盘等待期页面已走/被新一轮接管:静默丢弃
        }
        if (!prepared.ok) {
            this.capturing = false;
            this.setData({ recognizing: false, entryHint: "" });
            wx.showToast({ title: prepared.message, icon: "none" });
            return;
        }
        this.prepared = prepared;
        this.setData({
            photoPath: prepared.path,
            imgW: prepared.imgW,
            imgH: prepared.imgH,
            photoAspect: prepared.imgW + " / " + prepared.imgH,
            photoExpandStyle: photoExpandStyleOf(prepared.imgW, prepared.imgH, this.data.winW, this.data.winH),
        });
        // B4:识别=把照片临时发送到云端处理——首次需用户授权;拒绝则本次不调识别,
        // 照片仍留在本机作证据,页面照常进手动/语音建候选
        const granted = await this.askVlAuthOnce();
        if (epoch !== this.captureEpoch) {
            return; // R2:授权弹窗等待期页面已走:同意/拒绝都不再续行,不建会话不识别
        }
        if (!granted) {
            this.capturing = false;
            this.startEmptyBatch(prepared, "未授权云端识别;可手动添加或语音建候选,照片仍作证据。", this.entryScope);
            return;
        }
        const outcome = await (0, photo_vl_1.recognizeWithVl)(prepared);
        if (epoch !== this.captureEpoch) {
            return; // R2:识别回包迟到(页面已走/被新一轮接管):不建会话不上屏
        }
        this.capturing = false;
        // C1:识别返回后、候选上屏/开批之前先复核入口作用域——识别等待期间家庭已切换
        // → 不建会话、候选不上屏,终局与 B1 的 SCOPE_MISMATCH 同款语义;同 householdId
        // 仅作用域代数/修订前进(同户内作用域版本变化)不算漂移,照常
        if (this.photoEntryScopeDrifted(this.entryScope)) {
            this.terminateCaptureForScopeDrift();
            return;
        }
        if (outcome.ok) {
            const rows = outcome.items.map((it) => (0, intake_draft_1.makeAiRow)(it));
            this.rowsRaw = rows;
            // C1:会话绑定拍照入口作用域(不是识别返回时刻的当前作用域)
            const session = (0, photo_session_1.startPhotoSession)({ localPath: prepared.path, imgW: prepared.imgW, imgH: prepared.imgH, fileId: null }, rows, "", this.entryScope === null ? undefined : this.entryScope);
            this.batchId = session.batchId;
            this.sessionCreatedAt = session.createdAt;
            this.sessionScope = session.scope;
            this.fileId = null;
            const preselected = rows.filter((r) => r.checked).length;
            const subtitle = "识别到 " +
                rows.length +
                " 个候选,全部待你核对 · AI 预选了 " +
                preselected +
                " 个" +
                (outcome.truncated ? "(超过 10 件,只取前 10)" : "");
            this.setData({ entryReady: true, recognizing: false, navSubtitle: subtitle, photoCollapsed: true });
            this.refreshRecentLocations();
            this.rebuildRows();
            return;
        }
        if (outcome.kind === "unavailable") {
            // §7.1:VL 不可用 → modal 后仍进页面(照片只是本地临时文件,云端零残留)
            this.setData({ recognizing: false });
            wx.showModal({
                title: "拍照识别暂不可用",
                content: "可先手动添加物品;照片会留在本机当证据,保存时才会上传。",
                confirmText: "手动添加",
                cancelText: "不拍了",
                success: (r) => {
                    if (epoch !== this.captureEpoch) {
                        return; // R2:降级弹窗等待期页面已走/被新一轮接管:不建会话不上屏
                    }
                    if (r.confirm) {
                        this.startEmptyBatch(prepared, "拍照识别暂不可用;手动添加的物品照常保存,照片仍作证据。", this.entryScope === null ? undefined : this.entryScope);
                    }
                    else {
                        this.navigateBackSafe();
                    }
                },
            });
            return;
        }
        // invalid_photo(照片太大)/ bad_response:留在入口,如实提示
        this.setData({ recognizing: false, entryHint: "" });
        wx.showToast({ title: outcome.message, icon: "none" });
    },
    /** 空候选开批(VL 不可用降级/未授权:照片仍作证据,候选为空 + 手动添加);
     *  C1:开批前复核入口作用域——授权/降级弹窗等待期间切了家,同样不建会话不上屏 */
    startEmptyBatch(prepared, subtitle, entryScope) {
        if (entryScope !== undefined && this.photoEntryScopeDrifted(entryScope)) {
            this.terminateCaptureForScopeDrift();
            return;
        }
        this.rowsRaw = [];
        // C1:会话绑定拍照入口作用域(不是降级开批时刻的当前作用域)
        const session = (0, photo_session_1.startPhotoSession)({ localPath: prepared.path, imgW: prepared.imgW, imgH: prepared.imgH, fileId: null }, [], "", entryScope);
        this.batchId = session.batchId;
        this.sessionCreatedAt = session.createdAt;
        this.sessionScope = session.scope;
        this.fileId = null;
        this.setData({
            entryReady: true,
            recognizing: false,
            photoCollapsed: true,
            navSubtitle: subtitle,
            photoPath: prepared.path,
            imgW: prepared.imgW,
            imgH: prepared.imgH,
            photoAspect: prepared.imgW + " / " + prepared.imgH,
            photoExpandStyle: photoExpandStyleOf(prepared.imgW, prepared.imgH, this.data.winW, this.data.winH),
        });
        this.refreshRecentLocations();
        this.rebuildRows();
    },
    /** 恢复未完成批(?resume=1):localPath 文件已不存在 → 如实提示重拍,不编造 */
    restoreSession() {
        const session = (0, photo_session_1.getUnfinishedPhotoSession)();
        if (session === null) {
            void this.beginCapture();
            return;
        }
        const finishRestore = () => {
            this.rowsRaw = session.rows;
            this.batchId = session.batchId;
            this.sessionCreatedAt = session.createdAt;
            this.sessionScope = session.scope;
            this.fileId = session.file.fileId;
            this.prepared = null; // base64 绝不入会话;圈选时按 localPath 重新 prepare
            this.pendingEvidence = session.pendingEvidence; // C3:续联载荷随会话恢复
            const counts = (0, intake_draft_1.intakeCounts)(session.rows);
            this.setData({
                entryReady: true,
                recognizing: false,
                photoCollapsed: true,
                photoPath: session.file.localPath,
                imgW: session.file.imgW,
                imgH: session.file.imgH,
                photoAspect: session.file.imgW + " / " + session.file.imgH,
                photoExpandStyle: photoExpandStyleOf(session.file.imgW, session.file.imgH, this.data.winW, this.data.winH),
                batchLocation: session.batchLocation,
                locPathText: this.locPathViewOf(session.batchLocation),
                navSubtitle: "继续核对上次的 " + session.rows.length + " 个候选(已确认记住 " + counts.done + " 件)",
            });
            this.refreshRecentLocations();
            this.rebuildRows();
            this.buildEvidencePendingView();
            // 会话恢复的批次位置同机制预热层级拆分(挂树/预览与手输同源)
            this.ensureLocPath(session.batchLocation);
        };
        // 小程序临时文件可能被系统回收:恢复前复核文件是否还在
        if (typeof wx !== "undefined" &&
            wx.getFileSystemManager &&
            typeof wx.getFileSystemManager === "function" &&
            typeof wx.getFileSystemManager().access === "function") {
            wx.getFileSystemManager().access({
                path: session.file.localPath,
                success: () => finishRestore(),
                fail: () => {
                    wx.showToast({ title: "上次的照片已被系统清理,这批重拍吧", icon: "none", duration: 2500 });
                    (0, photo_session_1.clearPhotoSession)();
                    void this.beginCapture();
                },
            });
            return;
        }
        finishRestore();
    },
    navigateBackSafe() {
        wx.navigateBack({
            fail: () => {
                this.setData({ recognizing: false, entryHint: "没拍成。点上面的按钮再来一张。" });
            },
        });
    },
    /**
     * C1:拍照流程入口作用域漂移判定——入口(照片在手时)捕获的家庭 ≠ 当前作用域家庭。
     * 只比 householdId:同户内作用域代数/修订前进(scope 版本变化)不算漂移,照常;
     * null(理论边路:未走到照片在手)不判漂移,由 B1 保存复核与服务端硬门兜底。
     */
    photoEntryScopeDrifted(entryScope) {
        if (entryScope === null) {
            return false;
        }
        const entryId = entryScope.householdId !== null ? entryScope.householdId : "default";
        return (0, household_scope_1.householdScopeId)() !== entryId;
    },
    /**
     * C1:拍照流程入口漂移的统一终局(与 B1 的 SCOPE_MISMATCH 终局同款语义):
     * 零会话、零候选、零上传,toast + 返回首页(reLaunch 兜底)。
     * 绝不在此清任何 photo 会话存储——漂移前的旧批属于其开批家庭的键,当前作用域
     * 已切走,清当前键既清不到旧键、也不得误伤该家庭既有的未完成批。
     */
    terminateCaptureForScopeDrift() {
        this.capturing = false;
        this.rowsRaw = [];
        this.entryScope = null;
        this.setData({
            recognizing: false,
            entryReady: false,
            entryHint: "",
            highlightId: "",
            rows: [],
            boxViews: [],
        });
        wx.showToast({ title: "家庭已切换,本次拍照未保存", icon: "none", duration: 2500 });
        wx.navigateBack({
            fail: () => {
                wx.reLaunch({ url: "/pages/index/index", fail: () => { } });
            },
        });
    },
    onEntryShotTap() {
        void this.beginCapture();
    },
    /* ---------------- 证据条与识别框 ---------------- */
    /** 折叠态点照片/evChip:展开全幅(框随展开显示) */
    onPhotoTap() {
        // 开关语义(真机反馈 2026-10-17):竖构图展开几乎满屏,用户本能点图想收起——
        // 展开态点照片空白区=收起(框/角标/圈选入口均为 catchtap,不会误触)
        if (!this.data.photoCollapsed) {
            this.setData({ photoCollapsed: true, highlightId: "" });
            this.rebuildRows();
            return;
        }
        this.setData({ photoCollapsed: false });
        this.rebuildRows();
    },
    /** 展开态点角标:收起回证据条 */
    onAskChipTap() {
        this.setData({ photoCollapsed: true, highlightId: "" });
        this.rebuildRows();
    },
    /** 点框:高亮对应行 */
    onBoxTap(e) {
        const draftId = String((e.currentTarget.dataset || {}).id || "");
        if (draftId !== "") {
            this.flashRow(draftId);
        }
    },
    flashRow(draftId) {
        this.setData({ highlightId: draftId, photoCollapsed: false });
        this.rebuildRows();
    },
    /* ---------------- 候选清单(三态) ---------------- */
    /** 点行(非勾选区/步进器):展开照片 + 该框脉冲高亮 + 打开手动编辑面板(屏①+屏④);
     *  done 是终态:只读查看(展开照片+高亮),不打开编辑面板(同 onCheckTap/onStepTap 的 done 门,
     *  改了也永不进保存,不得提供看似生效的修改路径) */
    onRowTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        const row = this.rowsRaw[index];
        if (!row) {
            return;
        }
        this.setData({ photoCollapsed: false, highlightId: row.draftId });
        this.rebuildRows();
        if (row.done) {
            return;
        }
        this.openEditSheet(row.draftId);
    },
    onCheckTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        const row = this.rowsRaw[index];
        if (!row) {
            return;
        }
        this.rowsRaw = this.rowsRaw.map((r) => (r.draftId === row.draftId ? (0, intake_draft_1.toggleRowChecked)(r) : r));
        this.rebuildRows();
        this.persistSession();
    },
    onStepTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        const delta = Number(e.currentTarget.dataset.d);
        const row = this.rowsRaw[index];
        if (!row || row.done || (delta !== 1 && delta !== -1)) {
            return;
        }
        this.rowsRaw = this.rowsRaw.map((r) => (r.draftId === row.draftId ? (0, intake_draft_1.stepRowQty)(r, delta) : r));
        this.rebuildRows();
        this.persistSession();
    },
    /** 「全选 / 清空」:有未勾行 → 全选;否则清空(不动 done 行) */
    onToggleAllTap() {
        const anyUnchecked = this.rowsRaw.some((r) => !r.done && !r.checked);
        this.rowsRaw = (0, intake_draft_1.setRowsChecked)(this.rowsRaw, anyUnchecked);
        this.rebuildRows();
        this.persistSession();
    },
    /** 快速核实(真机反馈:逐件勾选繁琐):一键三档——全保留/只留高可信/清空。
     *  done 行是终态不动;点完立即重建计数,保存键/确认弹层随之更新。 */
    onQuickVerifyTap(e) {
        const mode = String(((e.currentTarget || {}).dataset || {}).mode || "");
        if (mode !== "all" && mode !== "high" && mode !== "none") {
            return;
        }
        this.rowsRaw = (0, intake_draft_1.quickVerifyRows)(this.rowsRaw, mode);
        this.rebuildRows();
        this.persistSession();
    },
    /** 保存成功自动返回首页(真机反馈 2026-10-18):庆祝胶囊(~1.4s)闪完退回;
     * 页面已走/再次保存时重置;失败不退(留在本页可重试)。 */
    scheduleSaveBack() {
        if (this.saveBackTimer !== null) {
            clearTimeout(this.saveBackTimer);
        }
        this.saveBackTimer = setTimeout(() => {
            this.saveBackTimer = null;
            this.navigateBackSafe();
        }, this.saveBackDelayMs);
    },
    /** 保存庆祝胶囊(微交互包 2026-10-17):弹入 1.4s 自动收;连续触发重置计时 */
    showCelebrate(text) {
        if (this.celebrateTimer !== null) {
            clearTimeout(this.celebrateTimer);
        }
        this.setData({ celebrateText: text });
        this.celebrateTimer = setTimeout(() => {
            this.celebrateTimer = null;
            this.setData({ celebrateText: null });
        }, 1400);
    },
    onManualAddTap() {
        this.openNewRowSheet();
    },
    /** 行数据 → 渲染视图(计数/框标签/备注文案单一来源派生) */
    rebuildRows() {
        const hl = this.data.highlightId;
        const expanded = !this.data.photoCollapsed;
        const rows = this.rowsRaw.map((r, i) => {
            const state = (0, intake_draft_1.rowStateOf)(r);
            const note = (0, intake_draft_1.qtyNoteText)(r);
            const excText = r.exc !== null && r.exc.trim() !== "" ? " · 位置例外:" + r.exc.trim() : "";
            const origin = r.src === "ai" || r.src === "circle"
                ? "置信度" + CONFIDENCE_LABEL[r.confidence]
                : r.src === "voice"
                    ? "语音补录"
                    : "手动补录";
            const meta = (r.done ? "已入库 · " : "") + "#d" + (i + 1) + " · " + note + excText + " · " + origin;
            return {
                draftId: r.draftId,
                index: i + 1,
                name: r.name,
                checked: r.checked,
                done: r.done,
                stateLabel: state === "keep" ? "保留" : state === "done" ? "已记住" : "候选",
                stateCls: state,
                srcBadge: r.src === "voice" ? "语音" : r.src === "circle" ? "圈选" : r.src === "manual" ? "手动" : "",
                srcCls: r.src === "voice" ? "voice" : r.src === "circle" ? "boxsel" : r.src === "manual" ? "manual" : "",
                qty: r.qty,
                noteText: note,
                excText,
                originText: origin,
                metaText: meta,
                failMsg: r.failMsg,
                isHl: r.draftId === hl,
            };
        });
        const boxViews = [];
        this.rowsRaw.forEach((r) => {
            if (r.box === null || r.box === undefined) {
                return;
            }
            const b = r.box;
            boxViews.push({
                draftId: r.draftId,
                left: round2(b.x1 * 100),
                top: round2(b.y1 * 100),
                width: round2((b.x2 - b.x1) * 100),
                height: round2((b.y2 - b.y1) * 100),
                cls: r.src === "circle" ? "user" : r.confidence === "low" ? "amber" : "",
                tag: (0, intake_draft_1.boxTagPrefix)(r) + r.name,
                isHl: expanded && r.draftId === hl,
            });
        });
        const counts = (0, intake_draft_1.intakeCounts)(this.rowsRaw);
        const view = (0, intake_draft_1.intakeCountView)(this.rowsRaw);
        const hasFail = this.rowsRaw.some((r) => r.failMsg !== "");
        let saveText = view.saveText;
        let saveDisabled = view.saveDisabled;
        if (hasFail && counts.keep > 0) {
            // 部分失败:失败行标红可重试(§7.6),保存入口保持可用
            saveText = "重试存 " + counts.keep + " 件";
            saveDisabled = false;
        }
        const qkHigh = this.rowsRaw.filter((r) => !r.done && r.confidence === "high").length;
        this.setData({ rows, boxViews, headText: view.headText, saveText, saveDisabled, qkHigh });
    },
    /* ---------------- 位置栏 ---------------- */
    onBatchLocEditTap() {
        this.askBatchLocation("这批候选默认都在哪?");
    },
    onNewLocTap() {
        this.askBatchLocation("新建本批位置");
    },
    /** 点层级预览手动改拆分(真机反馈 2026-10-18:模型拆错时无法编辑)。
     * › 连接编辑;确认后写入 locPathCache 直接生效(1-6 层×1-30 码点;非法提示不改)。 */
    onLocPathEditTap() {
        const text = this.data.batchLocation.trim();
        if (text === "") {
            return;
        }
        const cur = this.locPathCache[text];
        const prefill = cur !== undefined ? cur.join(" › ") : text;
        wx.showModal({
            title: "位置层级(用 › 分层)",
            editable: true,
            placeholderText: prefill,
            content: prefill,
            success: (r) => {
                if (!r.confirm || typeof r.content !== "string") {
                    return;
                }
                const parts = r.content.split("›").map((x) => x.trim()).filter((x) => x !== "");
                const uniq = parts.filter((x, i) => parts.indexOf(x) === i);
                if (uniq.length < 1 || uniq.length > 6 || uniq.some((x) => Array.from(x).length > 30)) {
                    wx.showToast({ title: "层级须 1-6 层,每层 1-30 字", icon: "none" });
                    return;
                }
                this.locPathCache[text] = uniq;
                this.setData({ locPathText: this.locPathViewOf(text) });
                wx.showToast({ title: "层级已改,保存按此挂树", icon: "none" });
            },
        });
    },
    askBatchLocation(title) {
        wx.showModal({
            title,
            editable: true,
            placeholderText: this.data.batchLocation || "如:玄关柜 · 第二层抽屉",
            success: (r) => {
                if (!r.confirm) {
                    return;
                }
                const v = (r.content || "").trim();
                if (v === "") {
                    wx.showToast({ title: "位置不能为空", icon: "none" });
                    return;
                }
                this.setBatchLocationText(v);
            },
        });
    },
    onRecentLocTap(e) {
        const loc = String((e.currentTarget.dataset || {}).loc || "");
        if (loc === "") {
            return;
        }
        this.setBatchLocationText(loc);
    },
    setBatchLocationText(v) {
        this.setData({
            batchLocation: v,
            voiceCtaText: v.trim() === "" ? "这些物品位置在哪,请告诉我" : "有什么物品要改的吗?请告诉我",
            locPathText: this.locPathViewOf(v),
        });
        this.ensureLocPath(v);
        this.persistSession();
        this.rebuildRows();
    },
    /**
     * LLM 位置层级拆分预热(真机 2026-10-17):无分隔符中文(「书房桌子右边
     * 抽屉」)确定性分段只能整串挂平节点,交给 extractDraft.locationSplit 按
     * 「从大到小」拆层级(服务端逐字锚定硬校验)。fire-and-forget:只回填
     * locPathCache 与位置栏预览,绝不 await、绝不阻塞保存——保存时刻缓存缺什么
     * 就走 splitLocationSegments 确定性兜底。fallback:true(模型输出没过硬校验)
     * 不回填缓存:回落规则分段,带分隔符文本仍能按规则拆开。
     */
    ensureLocPath(text) {
        const t = (typeof text === "string" ? text : "").trim();
        if (t === "") {
            return;
        }
        if (Object.prototype.hasOwnProperty.call(this.locPathCache, t)) {
            return;
        }
        if (this.locPathPending[t]) {
            return;
        }
        this.locPathPending[t] = true;
        void (0, api_1.callLocationSplit)(t)
            .then((res) => {
            if (!res.fallback &&
                Array.isArray(res.path) &&
                res.path.length > 0 &&
                res.path.every((seg) => typeof seg === "string" && seg.trim() !== "")) {
                this.locPathCache[t] = res.path;
            }
        })
            .catch(() => {
            // AI_UNAVAILABLE/网络/形状失败:不缓存、不提示(拆分是增强,兜底常在)
        })
            .then(() => {
            delete this.locPathPending[t];
            if (this.data.batchLocation.trim() === t) {
                this.syncLocPathView(this.data.batchLocation);
            }
        });
    },
    /** 位置栏层级预览文案:缓存命中 → 「书房 › 桌子 › 右边抽屉」;否则原文 */
    locPathViewOf(text) {
        const t = (typeof text === "string" ? text : "").trim();
        if (t !== "" &&
            Object.prototype.hasOwnProperty.call(this.locPathCache, t) &&
            Array.isArray(this.locPathCache[t]) &&
            this.locPathCache[t].length > 0) {
            return this.locPathCache[t].join(" › ");
        }
        return t;
    },
    /** 批次位置变化/缓存回填时同步 locPathText 上屏(无缓存时显示原文) */
    syncLocPathView(text) {
        this.setData({ locPathText: this.locPathViewOf(text) });
    },
    /** 常用快选:取 locations-cache 根层最近的 2 个房间(失败/未验证隐藏) */
    refreshRecentLocations() {
        if (!(0, household_scope_1.isScopeVerified)()) {
            if (this.data.recentLocations.length > 0) {
                this.setData({ recentLocations: [] });
            }
            return;
        }
        const entry = (0, locations_cache_1.readLocationsLayer)("");
        if (entry === null) {
            if (this.data.recentLocations.length > 0) {
                this.setData({ recentLocations: [] });
            }
            return;
        }
        const names = (entry.response.children || [])
            .map((c) => c.name)
            .filter((n) => typeof n === "string" && n !== "")
            .slice(0, 2);
        this.setData({ recentLocations: names });
    },
    /* ---------------- 按住说话(voice-entry 宿主 + routeExtract 旁路) ---------------- */
    ensureVoiceEntry() {
        if (this.voiceEntry !== null) {
            return;
        }
        this.voiceEntry = (0, voice_entry_1.attachVoiceEntry)({
            onStateChange: (s) => {
                this.setData({
                    voiceState: s.voiceState,
                    transcribing: s.transcribing,
                    extracting: s.extracting,
                    recordSeconds: s.recordSeconds,
                    partialText: s.partialText,
                });
            },
            fallbackToText: () => {
                this.voiceFallbackToText();
            },
            onTranscript: (text, audioTempPath) => {
                this.diffText = text;
                this.lastAudioPath = typeof audioTempPath === "string" ? audioTempPath : "";
            },
            routeExtract: (text, binding) => this.handleRouteExtract(text, binding),
        });
    },
    onTalkTouchStart(e) {
        if (this.voiceEntry === null) {
            return;
        }
        this.setData({ holdPressed: true });
        const touch = e.touches && e.touches[0];
        this.voiceEntry.pressStart(touch ? touch.clientY : 0);
    },
    onTalkTouchMove(e) {
        if (this.voiceEntry === null) {
            return;
        }
        const touch = e.touches && e.touches[0];
        if (!touch) {
            return;
        }
        this.voiceEntry.pressMove(touch.clientY);
    },
    onTalkTouchEnd() {
        this.setData({ holdPressed: false });
        if (this.voiceEntry !== null) {
            this.voiceEntry.pressEnd();
        }
    },
    onTalkTouchCancel() {
        this.setData({ holdPressed: false });
        if (this.voiceEntry !== null) {
            this.voiceEntry.pressCancel();
        }
    },
    /** 录音授权被拒选「用文字」:拍照页回退 = 手动加一件(编辑面板新行) */
    voiceFallbackToText() {
        if (this.voiceEntry !== null) {
            this.voiceEntry.invalidate();
        }
        this.setData({ voiceState: "idle", transcribing: false, extracting: false, partialText: "" });
        this.openNewRowSheet();
    },
    /** 转写 → draftEditParse → diff 弹层(§5;迟到复核按发起绑定) */
    async handleRouteExtract(text, binding) {
        if (this.committing) {
            return;
        }
        const scopeGen = binding !== null && binding !== undefined ? binding.scopeGen : (0, household_scope_1.captureScopeGeneration)();
        this.setData({ diffLoading: true });
        const candidates = this.rowsRaw
            .filter((r) => !r.done)
            .slice(0, 12)
            .map((r) => ({ draft_id: r.draftId, name: r.name }));
        try {
            const res = await (0, api_1.callDraftEditParse)({
                action: "draftEditParse",
                text,
                batch_location: this.data.batchLocation.trim() !== "" ? this.data.batchLocation.trim() : "(本批位置还没填)",
                candidates,
            });
            if (!(0, household_scope_1.isScopeGenerationCurrent)(scopeGen)) {
                this.setData({ diffLoading: false });
                return; // 在途家庭切换:迟到结果不上屏
            }
            if (res.intent === "none") {
                this.setData({ diffLoading: false });
                wx.showToast({ title: "没听懂这句,换个说法或手动改", icon: "none", duration: 2500 });
                return;
            }
            const view = this.buildDiffView(res);
            this.diffText = text;
            if (view === null) {
                this.setData({ diffLoading: false });
                return;
            }
            this.setData({ diffLoading: false, diff: view });
        }
        catch (err) {
            if (!(0, household_scope_1.isScopeGenerationCurrent)(scopeGen)) {
                this.setData({ diffLoading: false });
                return;
            }
            this.setData({ diffLoading: false });
            wx.showToast({ title: "没听懂,可手动点行编辑", icon: "none", duration: 2500 });
        }
    },
    buildDiffView(res) {
        const rowIndexOf = (draftId) => {
            const i = this.rowsRaw.findIndex((r) => r.draftId === draftId);
            return i === -1 ? 0 : i + 1;
        };
        const audioAvailable = this.lastAudioPath !== "" &&
            typeof wx !== "undefined" &&
            typeof wx.createInnerAudioContext === "function";
        if (res.intent === "add") {
            const qtyNote = typeof res.added.qty_note === "string" ? res.added.qty_note : "";
            this.diffEditsRaw = [];
            this.diffTargetDraftId = "";
            this.diffAddQtyNote = qtyNote;
            const parsed = (0, intake_draft_1.parseIntakeQtyNote)(qtyNote);
            return {
                text: this.diffText,
                audioAvailable,
                intent: "add",
                needsPick: false,
                picks: [],
                lockIndex: 0,
                lockName: "",
                matchedWord: "",
                edits: [],
                pickedCount: 1,
                applyText: "加进清单(候选)",
                applyDisabled: false,
                addName: res.added.name,
                addNoteText: "×" + parsed.qty + " " + parsed.suffix,
                locNew: "",
            };
        }
        if (res.intent === "batch_location") {
            this.diffEditsRaw = [];
            this.diffTargetDraftId = "";
            this.diffAddQtyNote = "";
            return {
                text: this.diffText,
                audioAvailable,
                intent: "batch_location",
                needsPick: false,
                picks: [],
                lockIndex: 0,
                lockName: "",
                matchedWord: "",
                edits: [],
                pickedCount: 1,
                applyText: "就改本批位置",
                applyDisabled: false,
                addName: "",
                addNoteText: "",
                locNew: res.new_location,
            };
        }
        // intent="edit"(none 已在入口拦下;防御性再拦)
        if (res.intent !== "edit") {
            return null;
        }
        const editsRaw = (res.edits || []).map((e) => ({
            field: e.field,
            new: e.new,
            old: typeof e.old === "string" ? e.old : "",
        }));
        this.diffEditsRaw = editsRaw;
        this.diffAddQtyNote = "";
        if (res.needs_pick) {
            this.diffTargetDraftId = "";
            return {
                text: this.diffText,
                audioAvailable,
                intent: "edit",
                needsPick: true,
                picks: (res.picks || []).map((p) => ({
                    draftId: p.draft_id,
                    name: p.name,
                    index: rowIndexOf(p.draft_id),
                })),
                lockIndex: 0,
                lockName: "",
                matchedWord: "",
                edits: [],
                pickedCount: 0,
                applyText: "一项都没勾",
                applyDisabled: true,
                addName: "",
                addNoteText: "",
                locNew: "",
            };
        }
        const targetId = res.target !== null ? res.target.draft_id : "";
        this.diffTargetDraftId = targetId;
        const edits = editsRaw.map((e) => ({
            field: e.field,
            label: EDIT_FIELD_LABEL[e.field] || e.field,
            old: e.old || "",
            new: e.new,
            picked: true,
        }));
        const pickedCount = edits.length;
        return {
            text: this.diffText,
            audioAvailable,
            intent: "edit",
            needsPick: false,
            picks: [],
            lockIndex: targetId !== "" ? rowIndexOf(targetId) : 0,
            lockName: targetId !== "" ? (this.rowsRaw.find((r) => r.draftId === targetId) || { name: "" }).name : "",
            matchedWord: res.target !== null && typeof res.target.matched_word === "string" ? res.target.matched_word : "",
            edits,
            pickedCount,
            applyText: pickedCount > 0 ? "应用勾选的 " + pickedCount + " 处" : "一项都没勾",
            applyDisabled: pickedCount === 0,
            addName: "",
            addNoteText: "",
            locNew: "",
        };
    },
    onDiffFieldToggle(e) {
        const d = this.data.diff;
        if (d === null || d.needsPick) {
            return;
        }
        const index = Number(e.currentTarget.dataset.index);
        const edits = d.edits.map((ed, i) => (i === index ? { ...ed, picked: !ed.picked } : ed));
        const pickedCount = edits.filter((ed) => ed.picked).length;
        this.setData({
            diff: {
                ...d,
                edits,
                pickedCount,
                applyText: pickedCount > 0 ? "应用勾选的 " + pickedCount + " 处" : "一项都没勾",
                applyDisabled: pickedCount === 0,
            },
        });
    },
    /** needs_pick 点选:显式点选 = 新的明确输入,只带所选候选重放一次(§5.7) */
    onDiffPickTap(e) {
        const d = this.data.diff;
        if (d === null || !d.needsPick) {
            return;
        }
        const draftId = String((e.currentTarget.dataset || {}).id || "");
        const row = this.rowsRaw.find((r) => r.draftId === draftId);
        if (!row) {
            return;
        }
        // 期间不执行任何修改:关掉点选层,进入解析中,响应回来换新 diff 弹层
        this.setData({ diff: null, diffLoading: true });
        void this.reparseWithSingleCandidate(this.diffText, row.draftId, row.name);
    },
    async reparseWithSingleCandidate(text, draftId, name) {
        const scopeGen = (0, household_scope_1.captureScopeGeneration)();
        try {
            const res = await (0, api_1.callDraftEditParse)({
                action: "draftEditParse",
                text,
                batch_location: this.data.batchLocation.trim() !== "" ? this.data.batchLocation.trim() : "(本批位置还没填)",
                candidates: [{ draft_id: draftId, name }],
            });
            if (!(0, household_scope_1.isScopeGenerationCurrent)(scopeGen)) {
                this.setData({ diffLoading: false });
                return;
            }
            if (res.intent === "none") {
                this.setData({ diffLoading: false });
                wx.showToast({ title: "没听懂这句,换个说法或手动改", icon: "none", duration: 2500 });
                return;
            }
            const view = this.buildDiffView(res);
            this.setData({ diffLoading: false, diff: view });
        }
        catch (err) {
            if ((0, household_scope_1.isScopeGenerationCurrent)(scopeGen)) {
                this.setData({ diffLoading: false });
                wx.showToast({ title: "没听懂,可手动点行编辑", icon: "none", duration: 2500 });
            }
            else {
                this.setData({ diffLoading: false });
            }
        }
    },
    /** 「念错了,当我没说」:关 sheet 零改动 */
    onDiffCancelTap() {
        this.setData({ diff: null });
        wx.showToast({ title: "好,当我没说。", icon: "none" });
    },
    onDiffApplyTap() {
        const d = this.data.diff;
        if (d === null || d.applyDisabled) {
            return;
        }
        if (d.intent === "edit") {
            const row = this.rowsRaw.find((r) => r.draftId === this.diffTargetDraftId);
            if (!row) {
                this.setData({ diff: null });
                return;
            }
            const pickedFields = d.edits.filter((ed) => ed.picked).map((ed) => ed.field);
            const applied = (0, intake_draft_1.applyDraftEdits)(row, this.diffEditsRaw, pickedFields);
            if (applied.applied > 0) {
                this.rowsRaw = this.rowsRaw.map((r) => (r.draftId === row.draftId ? applied.row : r));
                this.rebuildRows();
                this.persistSession();
            }
            this.setData({ diff: null });
            wx.showToast({ title: "改好了 " + applied.applied + " 处 · 接着按住说", icon: "none" });
            return;
        }
        if (d.intent === "add") {
            this.rowsRaw = this.rowsRaw.concat([(0, intake_draft_1.makeVoiceAddedRow)(d.addName, this.diffAddQtyNote)]);
            this.rebuildRows();
            this.persistSession();
            this.setData({ diff: null });
            wx.showToast({ title: "补了一件,勾选才保留", icon: "none" });
            return;
        }
        // batch_location:改批次默认位置;已设例外的候选不受影响(例外仍是例外)
        this.setData({
            diff: null,
            batchLocation: d.locNew,
            voiceCtaText: d.locNew.trim() === ""
                ? "这些物品位置在哪,请告诉我"
                : "有什么物品要改的吗?请告诉我",
            locPathText: this.locPathViewOf(d.locNew),
        });
        this.ensureLocPath(d.locNew);
        this.persistSession();
        wx.showToast({ title: "本批位置已改:" + d.locNew, icon: "none" });
    },
    /** 原话回听(InnerAudioContext.src = 本次录音临时文件;失败如实提示) */
    onDiffPlayTap() {
        if (this.lastAudioPath === "") {
            wx.showToast({ title: "原话文件不在了", icon: "none" });
            return;
        }
        if (typeof wx === "undefined" || typeof wx.createInnerAudioContext !== "function") {
            wx.showToast({ title: "当前版本不支持回放", icon: "none" });
            return;
        }
        try {
            const ctx = wx.createInnerAudioContext();
            ctx.src = this.lastAudioPath;
            ctx.play();
            wx.showToast({ title: "正在回放原话", icon: "none" });
        }
        catch (e) {
            wx.showToast({ title: "回放失败", icon: "none" });
        }
    },
    /* ---------------- 手动编辑面板(屏④) ---------------- */
    openEditSheet(draftId) {
        const index = this.rowsRaw.findIndex((r) => r.draftId === draftId);
        const row = this.rowsRaw[index];
        if (!row) {
            return;
        }
        if (row.done) {
            // 终态行不开编辑面板(防御门:onRowTap 已拦,此处兜底)
            return;
        }
        const seen = new Set();
        const nameChips = [];
        this.rowsRaw.forEach((r) => {
            if (r.draftId === row.draftId || seen.has(r.name)) {
                return;
            }
            seen.add(r.name);
            nameChips.push({ name: r.name, isKeep: false });
        });
        nameChips.push({ name: "保持:" + row.name, isKeep: true });
        const origin = row.src === "ai" || row.src === "circle"
            ? "来源:照片识别 · 置信度" + CONFIDENCE_LABEL[row.confidence]
            : row.src === "voice"
                ? "来源:语音补录"
                : "来源:手动添加";
        const locSeed = row.exc !== null && row.exc.trim() !== "" ? row.exc : this.data.batchLocation;
        this.setData({
            edit: {
                isNew: false,
                draftId: row.draftId,
                index: index + 1,
                title: "改一下 · #d" + (index + 1),
                sourceText: origin,
                nameChips,
                nameInput: row.name,
                qty: row.qty,
                locValue: locSeed,
                batchLocation: this.data.batchLocation,
                hasRemind: row.remind !== null && row.remind !== undefined,
                dueDate: row.remind ? row.remind.due_date : "",
                remindKindIndex: Math.max(0, REMIND_KIND_OPTIONS.indexOf(row.remind ? row.remind.kind : "下次维护")),
                remindKinds: REMIND_KIND_OPTIONS,
            },
        });
    },
    openNewRowSheet() {
        this.setData({
            edit: {
                isNew: true,
                draftId: "",
                index: this.rowsRaw.length + 1,
                title: "手动加一件",
                sourceText: "手动添加 · 保存时才会上传照片(box=null 整照关联)",
                nameChips: [],
                nameInput: "",
                qty: 1,
                locValue: this.data.batchLocation,
                batchLocation: this.data.batchLocation,
                hasRemind: false,
                dueDate: "",
                remindKindIndex: REMIND_KIND_OPTIONS.indexOf("下次维护"),
                remindKinds: REMIND_KIND_OPTIONS,
            },
        });
    },
    onEditChipTap(e) {
        const ed = this.data.edit;
        if (ed === null) {
            return;
        }
        const name = String((e.currentTarget.dataset || {}).name || "");
        if (name === "") {
            return;
        }
        const value = name.indexOf("保持:") === 0 ? name.slice(3) : name;
        this.setData({ edit: { ...ed, nameInput: value } });
    },
    onEditNameInput(e) {
        const ed = this.data.edit;
        if (ed === null) {
            return;
        }
        this.setData({ edit: { ...ed, nameInput: (e.detail && e.detail.value) || "" } });
    },
    onEditLocInput(e) {
        const ed = this.data.edit;
        if (ed === null) {
            return;
        }
        this.setData({ edit: { ...ed, locValue: (e.detail && e.detail.value) || "" } });
    },
    onEditStepTap(e) {
        const ed = this.data.edit;
        if (ed === null) {
            return;
        }
        const delta = Number(e.currentTarget.dataset.d);
        if (delta !== 1 && delta !== -1) {
            return;
        }
        const qty = Math.min(99, Math.max(1, ed.qty + delta));
        this.setData({ edit: { ...ed, qty } });
    },
    onEditDateChange(e) {
        const ed = this.data.edit;
        if (ed === null) {
            return;
        }
        const value = (e.detail && e.detail.value) || "";
        this.setData({ edit: { ...ed, hasRemind: value !== "", dueDate: value } });
    },
    onEditKindChange(e) {
        const ed = this.data.edit;
        if (ed === null) {
            return;
        }
        this.setData({ edit: { ...ed, remindKindIndex: Number(e.detail && e.detail.value) || 0 } });
    },
    onEditClearRemindTap() {
        const ed = this.data.edit;
        if (ed === null) {
            return;
        }
        this.setData({ edit: { ...ed, hasRemind: false, dueDate: "" } });
    },
    onEditConfirmTap() {
        const ed = this.data.edit;
        if (ed === null) {
            return;
        }
        const name = ed.nameInput.trim();
        if (name === "") {
            wx.showToast({ title: "名称不能为空", icon: "none" });
            return;
        }
        const loc = ed.locValue.trim();
        const batch = this.data.batchLocation.trim();
        // 位置(默认继承批次,不同才改):与批次相同 → 例外清空(继承),不同 → 例外
        const exc = loc !== batch || batch === "" ? (loc !== "" ? loc : null) : null;
        // 例外位置同机制预热 LLM 层级拆分(挂树时经同一 locPathCache 命中)
        if (exc !== null) {
            this.ensureLocPath(exc);
        }
        const remind = ed.hasRemind && ed.dueDate !== ""
            ? { due_date: ed.dueDate, kind: REMIND_KIND_OPTIONS[ed.remindKindIndex] }
            : null;
        if (ed.isNew) {
            const row = (0, intake_draft_1.makeManualRow)(name, "");
            this.rowsRaw = this.rowsRaw.concat([{ ...row, qty: ed.qty, exc, remind }]);
            this.rebuildRows();
            this.persistSession();
            this.setData({ edit: null });
            wx.showToast({ title: "加了一件候选,勾选才保留", icon: "none" });
            return;
        }
        const index = this.rowsRaw.findIndex((r) => r.draftId === ed.draftId);
        if (index === -1) {
            this.setData({ edit: null });
            return;
        }
        const prev = this.rowsRaw[index];
        if (prev.done) {
            // 终态行防御:面板开着时该行已落「已确认记住」(保存完成/会话恢复后)→
            // 关面板零改动、绝不 toast「改好了」假回执(done 行永不进保存)
            this.setData({ edit: null });
            return;
        }
        // 手动编辑绝不改勾选(保留)状态;draftId/operationId/box/src 原样(§8 屏④)
        this.rowsRaw = this.rowsRaw.map((r, i) => i === index ? { ...prev, name, qty: ed.qty, exc, remind } : r);
        this.rebuildRows();
        this.persistSession();
        this.setData({ edit: null });
        wx.showToast({ title: "改好了", icon: "none" });
    },
    onEditCloseTap() {
        this.setData({ edit: null });
    },
    /* ---------------- 保存最终确认(屏①保存 sheet) ---------------- */
    /**
     * 会话期内家庭漂移检测(B1):会话归属家庭(开批时捕获)≠ 当前作用域 → 保存被拦。
     * 服务端同款判定为 SCOPE_MISMATCH 硬拒,这里是客户端前置(少一次注定失败的上传)。
     */
    sessionScopeDrifted() {
        if (this.sessionScope === null) {
            return false; // 无会话作用域记忆(理论边路):服务端硬门兜底
        }
        const scopeId = this.sessionScope.householdId !== null ? this.sessionScope.householdId : "default";
        return (0, household_scope_1.householdScopeId)() !== scopeId;
    },
    /** 漂移/SCOPE_MISMATCH 的统一终局:终止会话 + 提示 + 返回首页,绝不重试写另一家 */
    terminateSessionForScopeDrift() {
        const scope = this.sessionScope;
        this.batchFinished = true; // onUnload 不再回写复活旧批
        this.sessionScope = null;
        // 会话被刻意终止,续联载荷一并废弃(onUnload 的 R1 保留门只认 pendingEvidence,
        // 不清空会借它回写复活已终止的会话)
        this.pendingEvidence = null;
        // 会话存在开批家庭的存储键下(作用域隔离):按会话自己的键清除,
        // 再按当前键清一次兜底(default 键/未捕获开批两种路径)
        (0, photo_session_1.clearPhotoSessionForScope)(scope);
        (0, photo_session_1.clearPhotoSession)();
        this.setData({ saveBusy: false, saveSheet: null, recognizing: false });
        wx.showToast({ title: "家庭已切换,本批未保存", icon: "none", duration: 2500 });
        wx.navigateBack({
            fail: () => {
                wx.reLaunch({ url: "/pages/index/index", fail: () => { } });
            },
        });
    },
    onSaveTap() {
        if (this.data.saveBusy) {
            return;
        }
        if (this.batchFinished) {
            return; // 本批已终局(全部入库/漂移终止):不再打开确认层
        }
        if (this.sessionScopeDrifted()) {
            this.terminateSessionForScopeDrift();
            return;
        }
        if (this.data.saveDisabled) {
            wx.showToast({ title: "先勾选要保留的候选", icon: "none" });
            return;
        }
        if (this.data.batchLocation.trim() === "") {
            wx.showToast({ title: "先填这批默认放哪儿", icon: "none" });
            this.askBatchLocation("这批候选默认都在哪?");
            return;
        }
        const s = (0, intake_draft_1.deriveSaveConfirm)(this.rowsRaw, this.data.batchLocation);
        this.setData({
            saveSheet: {
                batchLocation: s.batchLocation,
                exceptionLines: s.exceptionLines,
                exceptionText: s.exceptionText,
                summaryText: s.summaryText,
                keepCount: s.keepCount,
                skipCount: s.skipCount,
            },
        });
    },
    onSaveBackTap() {
        this.setData({ saveSheet: null });
    },
    async onSaveGoTap() {
        if (this.committing) {
            return;
        }
        if (this.batchFinished) {
            // 本批已终局(全部入库/漂移终止):迟到的确认手势直接吞掉,绝不再写
            this.setData({ saveSheet: null });
            return;
        }
        if (this.sessionScopeDrifted()) {
            // B1:会话期内已切到另一家(确认层开着时漂移也要拦):终止会话返回首页
            this.terminateSessionForScopeDrift();
            return;
        }
        const pending = this.rowsRaw.filter((r) => r.checked && !r.done);
        if (pending.length === 0) {
            this.setData({ saveSheet: null });
            return;
        }
        this.committing = true;
        const scopeGen = (0, household_scope_1.captureScopeGeneration)();
        this.setData({ saveBusy: true });
        const outcome = await (0, photo_intake_1.commitPhotoBatch)({
            batchId: this.batchId,
            rows: pending,
            batchLocation: this.data.batchLocation,
            localPath: this.data.photoPath,
            imgW: this.data.imgW,
            imgH: this.data.imgH,
            fileId: this.fileId,
            scopeHouseholdId: this.sessionScope !== null ? this.sessionScope.householdId : null,
        });
        this.committing = false;
        if (!(0, household_scope_1.isScopeGenerationCurrent)(scopeGen)) {
            // 在途家庭切换:本次不落行(服务端双 marker 已拦,客户端不上屏)
            this.setData({ saveBusy: false, saveSheet: null });
            wx.showToast({ title: "家里刚切换过,本次没保存,请确认当前家庭后重试", icon: "none", duration: 2500 });
            return;
        }
        if (!outcome.ok) {
            // B1:服务端判定会话家庭 ≠ 当前派生家庭 → 终止会话返回首页,绝不重试写另一家
            if (outcome.stage === "commit" && outcome.error === "SCOPE_MISMATCH") {
                this.terminateSessionForScopeDrift();
                return;
            }
            // 上传失败:整批不提交(云端零残留);commit 失败:fileId 已回带供重试收敛
            if (outcome.stage === "upload") {
                this.fileId = null;
            }
            else {
                this.fileId = outcome.fileId !== "" ? outcome.fileId : this.fileId;
            }
            this.persistSession();
            this.setData({ saveBusy: false, saveSheet: null });
            wx.showToast({ title: outcome.message, icon: "none", duration: 2500 });
            return;
        }
        // 逐件落行:成功 → done(终态);失败 → 标红可重试(其余件不拦)
        this.fileId = outcome.fileId;
        const byIndex = new Map();
        outcome.results.forEach((rr) => byIndex.set(rr.index, { ok: rr.ok, item_id: rr.item_id, message: rr.message }));
        pending.forEach((row, i) => {
            const rr = byIndex.get(i) || { ok: false, message: "结果未知" };
            this.rowsRaw = this.rowsRaw.map((r) => r.draftId === row.draftId
                ? rr.ok
                    ? (0, intake_draft_1.markRowSaved)(r)
                    : (0, intake_draft_1.markRowFailed)(r, rr.message || "保存失败,可重试")
                : r);
        });
        // C3:物品已建但证据写入失败的件 → 续联载荷(行框/来源随行),终态提示 + 重试入口
        const evidenceFailedIds = new Set(outcome.evidenceFailed);
        if (evidenceFailedIds.size > 0) {
            const retryItems = [];
            pending.forEach((row, i) => {
                const rr = byIndex.get(i);
                if (rr && rr.ok && rr.item_id !== undefined && evidenceFailedIds.has(rr.item_id)) {
                    retryItems.push({
                        item_id: rr.item_id,
                        box: row.box === undefined ? null : row.box,
                        source: row.src === "circle" ? "circle" : "vl",
                    });
                }
            });
            if (retryItems.length > 0) {
                this.pendingEvidence = {
                    fileId: outcome.fileId,
                    imgW: this.data.imgW,
                    imgH: this.data.imgH,
                    items: retryItems,
                };
            }
        }
        this.rebuildRows();
        this.setData({ saveBusy: false, saveSheet: null });
        this.buildEvidencePendingView(pending.length);
        const fails = outcome.results.filter((rr) => !rr.ok).length;
        if (fails === 0) {
            this.batchFinished = true;
            if (this.pendingEvidence === null) {
                (0, photo_session_1.clearPhotoSession)();
                this.showCelebrate("✓ 都记住了 · " + pending.length + " 件已入库");
                // 真机反馈 2026-10-18:确认保存后自动回首页(庆祝闪完再退;首页横幅可再进)
                this.scheduleSaveBack();
            }
            else {
                // C3:建档全部成功但部分证据待关联——会话保留续联载荷,终态提示 + 重试入口
                this.persistSession();
                wx.showToast({
                    title: "已入库 " + pending.length + " 件,其中 " + this.pendingEvidence.items.length + " 件照片待关联",
                    icon: "none",
                    duration: 2500,
                });
            }
        }
        else {
            this.persistSession();
            wx.showToast({ title: fails + " 件没存上,失败行可重试", icon: "none", duration: 2500 });
        }
        // 位置挂树(issue #65 V0.4 第③条):本批唯一位置清单(批次位置+各已保存件
        // 例外,去重)→ 逐件挂上位置树。终态与提示先落,挂树在后(fire-and-forget);
        // 挂树失败不回滚不阻断,由 runPhotoMounts 轻提示。会话恢复/失败重试只带
        // 未 done 行,已 done 件不会重挂(update_id 又按行幂等键收敛)。
        // 分段 LLM 逐字锚定优先(locPathCache 预热命中的文本用之),缺失/在途走
        // splitLocationSegments 规则兜底——绝不因异步拆分未返回而阻塞保存。
        void this.runPhotoMounts((0, photo_intake_1.planPhotoMounts)(pending, outcome.results, this.data.batchLocation, this.locPathCache));
    },
    /**
     * 保存成功后的位置挂树(issue #65 V0.4 第③条):拍照批次位置与逐件例外像
     * 语音录入确认流程一样挂到位置节点树(同一个 locations.ensureAndLink API
     * 与幂等语义),用户不必再去主界面二次确认归属。挂树失败**不回滚不阻断**:
     * location_text 已随 photoCommit 落库,件照常在「尚未归类」,只轻提示
     * 「N 件的位置树没挂上,主界面可补」;全部挂上则零打扰。
     */
    async runPhotoMounts(plan) {
        const outcome = await (0, photo_intake_1.mountPhotoItems)(plan);
        const notMounted = outcome.failed + plan.skipped;
        if (notMounted > 0) {
            wx.showToast({
                title: notMounted + " 件的位置树没挂上,主界面可补",
                icon: "none",
                duration: 2500,
            });
        }
    },
    /* ---------------- 证据待关联重试(C3:photoEvidenceRetry 幂等收敛) ---------------- */
    /** 终态「照片待关联」提示视图:有续联载荷才显示(计数单一来源=载荷件数) */
    buildEvidencePendingView(savedCount) {
        const count = this.pendingEvidence !== null ? this.pendingEvidence.items.length : 0;
        if (count === 0) {
            if (this.data.evidencePending !== null) {
                this.setData({ evidencePending: null });
            }
            return;
        }
        const saved = savedCount !== undefined ? savedCount : this.rowsRaw.filter((r) => r.done).length;
        this.setData({ evidencePending: { count, savedCount: saved } });
    },
    /**
     * 重试关联(C3):photoEvidenceRetry 幂等(唯一索引冲突=已存在=成功),点击可
     * 重复直至成功。全部关联成功 → 清提示清载荷(批已终局则顺带清会话);部分失败
     * → 只保留仍待关联的件(NOT_FOUND 的件=item 已删,证据读取侧本就过滤,不再
     * 无意义重试),提示后可再点;调用失败 → 载荷原样保留可再点。
     */
    async onEvidenceRetryTap() {
        if (this.committing || this.evidenceRetryBusy || this.pendingEvidence === null) {
            return;
        }
        this.evidenceRetryBusy = true;
        this.setData({ evidenceRetryBusy: true });
        const payload = this.pendingEvidence;
        const outcome = await (0, photo_intake_1.retryPhotoEvidence)({
            fileId: payload.fileId,
            imgW: payload.imgW,
            imgH: payload.imgH,
            items: payload.items,
        });
        this.evidenceRetryBusy = false;
        if (!outcome.ok) {
            this.setData({ evidenceRetryBusy: false });
            wx.showToast({ title: outcome.message, icon: "none", duration: 2500 });
            return;
        }
        const remaining = outcome.results
            .filter((rr) => !rr.ok && rr.error !== "NOT_FOUND")
            .map((rr) => payload.items[rr.index])
            .filter((it) => it !== undefined);
        if (remaining.length === 0) {
            this.pendingEvidence = null;
            this.setData({ evidenceRetryBusy: false });
            this.buildEvidencePendingView();
            if (this.batchFinished) {
                (0, photo_session_1.clearPhotoSession)();
            }
            else {
                this.persistSession();
            }
            wx.showToast({ title: "照片都关联好了", icon: "none", duration: 2500 });
            return;
        }
        this.pendingEvidence = { fileId: payload.fileId, imgW: payload.imgW, imgH: payload.imgH, items: remaining };
        this.setData({ evidenceRetryBusy: false });
        this.buildEvidencePendingView();
        if (!this.batchFinished) {
            this.persistSession();
        }
        wx.showToast({ title: "还有 " + remaining.length + " 件照片没关联上,可再点重试", icon: "none", duration: 2500 });
    },
    /* ---------------- 圈选模式(屏⑤) ---------------- */
    onEnterCircle() {
        if (!this.vlAuthGranted) {
            // B4:未授权云端识别(或本页访问内已拒)——圈选入口灰化,只提示,不发起识别
            wx.showToast({
                title: "未授权云端识别,重新进入时会再询问;可手动添加或语音建候选",
                icon: "none",
                duration: 2500,
            });
            return;
        }
        this.setData({
            mode: "circle",
            circle: { drawing: false, rect: null, recognizing: false, errorText: "", result: null },
        });
        void this.ensurePrepared();
        void this.queryCircleRect();
    },
    onExitCircle() {
        this.setData({ mode: "confirm" });
    },
    async ensurePrepared() {
        if (this.prepared !== null) {
            return this.prepared;
        }
        if (this.data.photoPath === "") {
            return null;
        }
        const prepared = await (0, photo_vl_1.preparePhotoForVl)(this.data.photoPath);
        if (prepared.ok) {
            this.prepared = prepared;
            return prepared;
        }
        wx.showToast({ title: "照片读取失败,请重拍", icon: "none" });
        this.setData({ mode: "confirm" });
        return null;
    },
    /** 圈选容器几何(触点 px → 归一 0-1 的换算基准;查不到时按等比假设全幅映射) */
    queryCircleRect() {
        return new Promise((resolve) => {
            if (typeof wx === "undefined" || !wx.createSelectorQuery || typeof wx.createSelectorQuery !== "function") {
                this.circleRectEl = { left: 0, top: 0, width: 375, height: 281 };
                resolve();
                return;
            }
            try {
                wx.createSelectorQuery()
                    .select("#circlePhoto")
                    .boundingClientRect((rect) => {
                    if (rect && typeof rect.left === "number") {
                        this.circleRectEl = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
                    }
                    else {
                        this.circleRectEl = { left: 0, top: 0, width: 375, height: 281 };
                    }
                    resolve();
                })
                    .exec();
            }
            catch (e) {
                this.circleRectEl = { left: 0, top: 0, width: 375, height: 281 };
                resolve();
            }
        });
    },
    circlePointOf(e) {
        const touch = e.touches && e.touches[0] ? e.touches[0] : e.changedTouches && e.changedTouches[0];
        const rect = this.circleRectEl || { left: 0, top: 0, width: 375, height: 281 };
        const cx = touch ? touch.clientX : 0;
        const cy = touch ? touch.clientY : 0;
        return { x: cx - rect.left, y: cy - rect.top };
    },
    onCircleTouchStart(e) {
        const p = this.circlePointOf(e);
        this.circleStart = p;
        this.circleBox = null;
        this.setData({
            circle: { ...this.data.circle, drawing: true, rect: { left: p.x, top: p.y, width: 0, height: 0 } },
        });
    },
    onCircleTouchMove(e) {
        if (this.circleStart === null) {
            return;
        }
        const p = this.circlePointOf(e);
        const s = this.circleStart;
        const rect = {
            left: Math.min(s.x, p.x),
            top: Math.min(s.y, p.y),
            width: Math.abs(p.x - s.x),
            height: Math.abs(p.y - s.y),
        };
        this.setData({ circle: { ...this.data.circle, rect } });
    },
    async onCircleTouchEnd() {
        const start = this.circleStart;
        const rect = this.data.circle.rect;
        this.circleStart = null;
        if (start === null || rect === null) {
            return;
        }
        this.setData({ circle: { ...this.data.circle, drawing: false } });
        if (rect.width < CIRCLE_MIN_PX || rect.height < CIRCLE_MIN_PX) {
            this.setData({ circle: { ...this.data.circle, rect: null } });
            wx.showToast({ title: "圈大一点,框住想知道的东西", icon: "none" });
            return;
        }
        const boxRect = this.circleRectEl || { left: 0, top: 0, width: rect.width, height: rect.height };
        // 触点 px → 原图 0-1(containPointToNormalized;容器等比,信箱边外 clamp)
        const p1 = (0, photo_box_1.containPointToNormalized)(start.x, start.y, this.data.imgW, this.data.imgH, boxRect.width, boxRect.height);
        const p2 = (0, photo_box_1.containPointToNormalized)(start.x + rect.width, start.y + rect.height, this.data.imgW, this.data.imgH, boxRect.width, boxRect.height);
        const box = {
            x1: Math.min(p1.x, p2.x),
            y1: Math.min(p1.y, p2.y),
            x2: Math.max(p1.x, p2.x),
            y2: Math.max(p1.y, p2.y),
        };
        this.circleBox = box;
        // R2:捕获代数——圈选链路在途步骤(读盘/识别)续行前核对,页面已走即静默丢弃
        const epoch = this.captureEpoch;
        const prepared = await this.ensurePrepared();
        if (epoch !== this.captureEpoch) {
            return;
        }
        if (prepared === null) {
            return;
        }
        this.setData({ circle: { ...this.data.circle, recognizing: true, errorText: "", result: null } });
        const outcome = await (0, photo_vl_1.recognizeWithVl)(prepared, { mode: "region", region: box });
        if (epoch !== this.captureEpoch) {
            return; // R2:圈选识别回包迟到(页面已走):不上屏
        }
        if (this.data.mode !== "circle") {
            return; // 用户已退出圈选:迟到结果不上屏
        }
        if (outcome.ok) {
            const first = outcome.items[0];
            if (first === undefined) {
                this.setData({
                    circle: { ...this.data.circle, recognizing: false, errorText: "这个区域没认出东西,重圈试试", result: null },
                });
                return;
            }
            this.setData({
                circle: {
                    ...this.data.circle,
                    recognizing: false,
                    errorText: "",
                    result: {
                        name: first.name,
                        confText: "置信度" + CONFIDENCE_LABEL[first.confidence],
                        reasonText: "依据:你圈的框 + 整张照片一起看的;点「加进清单」才入列,且默认不勾选。",
                    },
                },
            });
            return;
        }
        // 圈选识别失败:结果卡如实提示 + 「不是,重圈」;已有候选零影响(§7.5)
        this.setData({
            circle: { ...this.data.circle, recognizing: false, errorText: outcome.message, result: null },
        });
    },
    /** 不是,重圈(原型 resetCircle) */
    onCircleResetTap() {
        this.circleBox = null;
        this.setData({
            circle: { drawing: false, rect: null, recognizing: false, errorText: "", result: null },
        });
    },
    /** 加进清单(候选):入列 = 未勾选,沿用用户圈选框(src=circle) */
    onCircleAddTap() {
        const c = this.data.circle;
        if (c.result === null || this.circleBox === null) {
            return;
        }
        const row = (0, intake_draft_1.makeCircleRow)({ name: c.result.name, qty_note: "", confidence: "mid", box: this.circleBox }, this.circleBox);
        this.rowsRaw = this.rowsRaw.concat([row]);
        this.rebuildRows();
        this.persistSession();
        this.circleBox = null;
        this.setData({
            mode: "confirm",
            circle: { drawing: false, rect: null, recognizing: false, errorText: "", result: null },
        });
        wx.showToast({ title: "已加为候选(未勾选)", icon: "none" });
    },
    /* ---------------- 会话 ---------------- */
    persistSession() {
        if (this.batchId === "") {
            return;
        }
        (0, photo_session_1.updatePhotoSession)({
            batchId: this.batchId,
            file: {
                localPath: this.data.photoPath,
                imgW: this.data.imgW,
                imgH: this.data.imgH,
                fileId: this.fileId,
            },
            batchLocation: this.data.batchLocation,
            rows: this.rowsRaw,
            scope: this.sessionScope !== null ? this.sessionScope : { householdId: null, generation: 0 },
            // C3:续联载荷随会话保留(直至重试成功或用户离开);null 序列化前归一
            pendingEvidence: this.pendingEvidence,
            createdAt: this.sessionCreatedAt,
        });
    },
    noop() { },
});
/* ---------------- 小工具 ---------------- */
function round2(v) {
    return Math.round(v * 100) / 100;
}
