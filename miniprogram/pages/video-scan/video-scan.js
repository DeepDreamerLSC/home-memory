"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const appearance_page_1 = require("../../utils/appearance-page");
/**
 * PR B 场景扫描确认页：
 * - 用户主动录/选一段抽屉柜子视频；
 * - 本地抽帧 → 逐帧 vlRecognize → 多物品 observation；
 * - 用户显式生成/合并/拆分/补件后才产生待存草稿；
 * - 原视频只在最终确认后上传；同一 file_id/asset_id 为多件建 evidence；
 * - 不自动合并同名、不自动入库、不自动播放。
 */
const api_1 = require("../../utils/api");
const locations_api_1 = require("../../utils/locations-api");
const locations_cache_1 = require("../../utils/locations-cache");
const video_attach_1 = require("../../utils/video-attach");
const video_scene_1 = require("../../utils/video-scene");
const keep_screen_1 = require("../../utils/keep-screen");
const scene_groups_1 = require("../../utils/scene-groups");
const video_target_1 = require("../../utils/video-target");
const location_nav_1 = require("../../utils/location-nav");
const location_icon_view_1 = require("../../utils/location-icon-view");
const photo_vl_1 = require("../../utils/photo-vl");
const households_api_1 = require("../../utils/households-api");
const household_scope_1 = require("../../utils/household-scope");
const quantity_1 = require("../../utils/quantity");
const usage_metrics_1 = require("../../utils/usage-metrics");
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
/**
 * ④(#121 批次乙)提交结果 → 跳转高亮目标(纯函数):「归到」显式挂载
 * (new + node_id)的第一件成功件(ok 且 mounted);只记文字/挂载失败 → null。
 */
function pickSceneCommitHighlight(frozenItems, results) {
    for (const row of results) {
        if (row.ok !== true || typeof row.item_id !== "string" || row.item_id === "" || row.mounted === false) {
            continue;
        }
        const frozen = frozenItems.find((f) => f.draft_key === row.draft_key);
        if (frozen === undefined || frozen.target !== "new") {
            continue;
        }
        if (typeof frozen.node_id === "string" && frozen.node_id !== "") {
            return { nodeId: frozen.node_id, itemId: row.item_id };
        }
    }
    return null;
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
        scannedFrameIndexes: data.scannedFrameIndexes,
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
    // L2 兼容:存量会话无 scannedFrameIndexes → 空集 = 无进度,与旧版全量重扫一致
    const scannedFrameIndexes = Array.isArray(raw.scannedFrameIndexes)
        ? raw.scannedFrameIndexes.filter((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)
        : [];
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
        scannedFrameIndexes,
        drafts: raw.drafts,
        pendingUpload: pending,
        frozenItems: frozen,
    };
}
Page({
    onShow() { (0, appearance_page_1.applyPageAppearance)(this); },
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
        observations: [],
        scannedFrameIndexes: [],
        framesTotal: 0,
        drafts: [],
        mergeSelectedKeys: [],
        observationGroups: [],
        sceneStats: (0, scene_groups_1.groupStats)([], []),
        draftViews: [],
        /** (Q3)单位选择器选项(UNIT_SET 冻结顺序 = 展示序,与拍照页同一闭集) */
        unitOptions: quantity_1.UNIT_SET,
        frozenItems: [],
        pendingUpload: null,
        busy: false,
        nodeSelectorVisible: false,
        nodeSelectorFor: -1,
        nodeSelectorStack: [],
        nodeSelectorOptions: [],
        nodeSelectorLoading: false,
        nodeSelectorError: "",
        nodeSelectorPathText: "",
        nodeSelectorCanPick: false,
        nodeSelectorCanBack: false,
        nodeSelectorCurrentName: "",
    },
    /**
     * 零隐私使用埋点会话计数器(#85/#76 降本阶梯第 2 级):纯内存、不入 storage
     * (会话存储字段集保持旧版不变);计数/门/构建逻辑在 utils/usage-metrics,
     * 与 D1 页共用同一实现,页面只调用。
     */
    usage: (0, usage_metrics_1.createUsageSession)(),
    /**
     * ④(#121 批次乙)提交完成后的跳转高亮目标:「归到」显式挂载的第一件
     * (物品移动完成);null = 无(只记文字/无挂载)→「返回」原路返回。
     */
    doneHighlight: null,
    /**
     * 「归到」路径缓存(#116 PR A):node_id → 节点路径段(页面内存态,选择器
     * 选定时记下)。build 时在场做客户端第一道一致性校验;会话恢复后缓存缺失
     * 则照常透传,服务端权威校验(location_text === 节点路径)兜底。
     */
    nodePaths: {},
    /**
     * 「归到」选择器请求代次守卫(评审 5649433998 修补 1):复用 D1 locations 页
     * 同款 createRequestSeq。每次打开层级/下钻/返回(经 loadNodeSelectorLayer 取号)
     * 与关闭/清除/选中/重置(显式取号推进)都使旧请求作废;层级请求发起时捕获
     * 当次代次,响应回来(成功或失败)时代次不匹配则整个丢弃——不 setData,
     * 杜绝「快速返回再进另一层」时较慢的旧层级响应后到覆盖当前列表/面包屑。
     */
    nodeSelectorSeq: (0, locations_cache_1.createRequestSeq)(),
    onLoad() {
        const stored = parseStoredSession(storageGet(scopeKey(SESSION_PREFIX)));
        if (stored === null)
            return;
        // 恢复会话:补埋点起点(只补一次,不清计数——计数是本次页面会话的交互量)
        (0, usage_metrics_1.markUsageSessionStart)(this.usage, Date.now());
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
            scannedFrameIndexes: stored.scannedFrameIndexes,
            framesTotal: (0, video_scene_1.sceneFrameTotal)(stored.durationMs),
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
        // 零隐私使用埋点:有扫描结果但未保存就离开 → abandon ping(best-effort,至多一次;
        // uploading/committing 不报——提交仍在后台收敛,done 已由 save ping 收口)
        if ((0, usage_metrics_1.shouldReportUsageAbandon)(this.usage, this.data.phase, this.data.observations.length)) {
            (0, usage_metrics_1.markUsageAbandoned)(this.usage);
            (0, usage_metrics_1.sendUsagePing)((0, usage_metrics_1.buildVideoConfirmUsagePing)(this.usage, "video_confirm_abandon", (0, usage_metrics_1.detectUsagePlatform)(), {
                observations: this.data.observations.length,
                groups: (0, scene_groups_1.buildSceneGroupViews)(this.data.observations, this.data.drafts).length,
                drafts: this.data.drafts.length,
            }, Date.now()));
        }
        // L1:退后台/离开页面必恢复熄屏(幂等;漏恢复=常亮耗电事故)
        (0, keep_screen_1.setScanKeepScreenOn)(false);
        // 仍保留取消抽帧会话(防僵尸):变化只是逐帧进度已落盘,onShow 后可续扫
        const session = this.scanSession;
        if (session !== undefined) {
            void session.cancel();
            this.scanSession = undefined;
        }
        if (this.data.phase === "scanning") {
            this.setData({ phase: "review" });
        }
        if (this.data.observations.length > 0 || this.data.drafts.length > 0 || this.data.pendingUpload !== null
            || this.data.scannedFrameIndexes.length > 0) {
            this.saveSession();
        }
    },
    onUnload() {
        this.onHide();
    },
    saveSession() {
        if (this.data.observations.length === 0 && this.data.drafts.length === 0 && this.data.pendingUpload === null
            && this.data.scannedFrameIndexes.length === 0)
            return;
        storageSet(scopeKey(SESSION_PREFIX), makeSession(this.data, this.data.pendingUpload));
    },
    clearSession() {
        storageRemove(scopeKey(SESSION_PREFIX));
        storageRemove(scopeKey(PENDING_PREFIX));
    },
    /** R0(§5.2):组视图与统计全部由 observations+drafts 推导,组态/归属随草稿实时刷新 */
    renderObservations() {
        this.setData({
            observationGroups: (0, scene_groups_1.buildSceneGroupViews)(this.data.observations, this.data.drafts),
            sceneStats: (0, scene_groups_1.groupStats)(this.data.observations, this.data.drafts),
        });
    },
    renderDrafts() {
        const views = this.data.drafts.map((d) => {
            const highlights = d.observationIds.length + d.manualHighlights.length;
            const first = d.manualHighlights.length > 0 ? d.manualHighlights[0] : null;
            // (Q3)数量视图:未确认行显示缺省口径 1/件(quantitySet=false 提示
            // 「不填按 1 件 · 线索数不代表件数」);线索数绝不预填数量
            const unit = d.unit !== undefined && quantity_1.UNIT_SET.indexOf(d.unit) !== -1 ? d.unit : "件";
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
                // §2.1:草稿线索数 >8 时草稿卡显式警示(组卡警示随剩余数,确认后归属到草稿上继续可见)
                highlightWarning: (0, scene_groups_1.sceneHighlightWarningText)(d.observationIds.length),
                isManual: d.observationIds.length === 0 && d.manualHighlights.length > 0,
                startSecText: first === null ? "" : (first.start_ms / 1000).toFixed(1),
                endSecText: first === null ? "" : (first.end_ms / 1000).toFixed(1),
                qty: typeof d.quantity === "number" ? d.quantity : 1,
                unit,
                unitIndex: Math.max(0, quantity_1.UNIT_SET.indexOf(unit)),
                quantitySet: typeof d.quantity === "number",
                nodeText: d.nodeId !== undefined && d.nodeId !== "" ? d.locationText : "",
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
    /**
     * 识别主循环。options.skipFrameIndexes 非空 = L2 续扫:跳过已完成帧的 VL 调用,
     * 保留已持久化的 observations/drafts/sceneId(同一视频、同一 scene_id);
     * 缺省 = 全新识别(重扫/首次),从零开始。
     */
    async startSceneScan(file, options) {
        const resume = options !== undefined && Array.isArray(options.skipFrameIndexes) && options.skipFrameIndexes.length > 0;
        const sceneId = resume ? this.data.sceneId : (0, api_1.uuid)();
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
        if (resume !== true) {
            // 新一次清点 = 新一次计量:归零计数、重置会话起点(续扫是同一次清点的延续,不重置)
            (0, usage_metrics_1.resetUsageSession)(this.usage, Date.now());
        }
        // L1:识别期间防熄屏;循环结束(完成/失败/取消)与 onHide/onUnload 全路径恢复
        (0, keep_screen_1.setScanKeepScreenOn)(true);
        this.setData({
            phase: "scanning",
            sceneId,
            videoPath: file.path,
            videoDurationMs: file.durationMs,
            videoWidth: file.width,
            videoHeight: file.height,
            videoAspect: file.width > 0 && file.height > 0 ? file.width + " / " + file.height : "16 / 9",
            observations: resume === true ? this.data.observations : [],
            scannedFrameIndexes: resume === true ? this.data.scannedFrameIndexes : [],
            framesTotal: (0, video_scene_1.sceneFrameTotal)(file.durationMs),
            drafts: resume === true ? this.data.drafts : [],
            mergeSelectedKeys: [],
            frozenItems: [],
            pendingUpload: null,
            errorText: "",
            failureText: "",
            resultText: "",
            progressText: resume === true ? "正在续扫剩余帧…" : "正在抽取第 1/8 帧…",
            busy: true,
        });
        this.renderObservations();
        this.renderDrafts();
        const outcome = await (0, video_scene_1.scanSceneVideo)({
            source: { path: file.path, durationMs: file.durationMs },
            durationMs: file.durationMs,
            session,
            skipFrameIndexes: options !== undefined ? options.skipFrameIndexes : undefined,
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
            // L2:每帧识别处理完(含零候选)追加完成标记并落盘一次(每帧一次,不更高频);
            // 失败帧不算完成,续扫时自动重试
            onFrameDone: (frame) => {
                if ((this.scanEpoch || 0) !== epoch)
                    return;
                const observations = this.data.observations
                    .filter((o) => o.frameIndex !== frame.frameIndex)
                    .concat(frame.observations);
                const scannedFrameIndexes = frame.ok && this.data.scannedFrameIndexes.indexOf(frame.frameIndex) === -1
                    ? this.data.scannedFrameIndexes.concat([frame.frameIndex])
                    : this.data.scannedFrameIndexes;
                this.setData({ observations, scannedFrameIndexes }, () => {
                    this.saveSession();
                });
            },
        });
        // L1:识别循环结束(完成/失败/取消)一律恢复熄屏;放在 epoch 判定之前,任何收尾路径都不漏
        (0, keep_screen_1.setScanKeepScreenOn)(false);
        if ((this.scanEpoch || 0) !== epoch)
            return;
        if (outcome.ok === false) {
            if (outcome.kind === "cancelled") {
                this.setData({ phase: "idle", busy: false, progressText: "" });
                return;
            }
            // observations 已按帧增量累计(含续扫前的已持久化观察),不用本轮结果覆盖
            this.setData({
                phase: this.data.observations.length > 0 ? "review" : "failed",
                busy: false,
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
            failureText: [failureText, truncatedText].filter((s) => s !== "").join(" "),
            resultText: this.data.observations.length === 0
                ? "AI 暂未给出物品线索，可手动补一件；原视频仍只在最终确认后上传。"
                : "已发现 " + this.data.observations.length + " 条线索；同名线索只是提示，不会被自动合并。",
            progressText: "",
        });
        this.renderObservations();
        this.renderDrafts();
        this.saveSession();
        if (outcome.manualFallback && this.data.observations.length === 0) {
            wx.showToast({ title: "未识别到线索，可手动补件", icon: "none" });
        }
    },
    async cancelScan() {
        this.scanEpoch = (this.scanEpoch || 0) + 1;
        const session = this.scanSession;
        if (session !== undefined)
            await session.cancel();
        this.scanSession = undefined;
        // L1:用户取消路径恢复熄屏(循环返回 cancelled 时还会再恢复一次,幂等无害)
        (0, keep_screen_1.setScanKeepScreenOn)(false);
    },
    async onCancelScanTap() {
        await this.cancelScan();
        if (this.data.scannedFrameIndexes.length > 0) {
            // L2:已有落盘进度时,取消只停本轮识别,进度保留——横幅仍可「继续识别剩余帧」
            this.setData({ phase: "review", busy: false, progressText: "", errorText: "" });
            this.saveSession();
            return;
        }
        this.setData({ phase: "idle", busy: false, observations: [], drafts: [], scannedFrameIndexes: [], progressText: "", errorText: "" });
        this.clearSession();
    },
    /** L2:继续识别剩余帧——重跑 scanSceneVideo(帧计划确定性重建),跳过已完成帧的 VL 调用 */
    async onResumeScanTap() {
        if (this.data.busy)
            return;
        if (this.data.videoPath === "" || this.data.videoDurationMs <= 0)
            return;
        const available = await this.localVideoAvailable();
        if (available === false) {
            wx.showToast({ title: "本地视频临时文件已失效，请重拍", icon: "none" });
            return;
        }
        await this.startSceneScan({
            path: this.data.videoPath,
            durationMs: this.data.videoDurationMs,
            width: this.data.videoWidth,
            height: this.data.videoHeight,
            size: 0,
        }, { skipFrameIndexes: this.data.scannedFrameIndexes.slice() });
    },
    /** L2:重新扫描——清空本会话进度从头来(不发 abandon:仍在 scanning 语义内) */
    async onRescanTap() {
        if (this.data.busy)
            return;
        if (this.data.videoPath === "" || this.data.videoDurationMs <= 0)
            return;
        const available = await this.localVideoAvailable();
        if (available === false) {
            wx.showToast({ title: "本地视频临时文件已失效，请重拍", icon: "none" });
            return;
        }
        this.clearSession();
        await this.startSceneScan({
            path: this.data.videoPath,
            durationMs: this.data.videoDurationMs,
            width: this.data.videoWidth,
            height: this.data.videoHeight,
            size: 0,
        });
    },
    /** 点缩略图放大预览(组件事件 e.detail.obsId):current=该观察帧,urls=组内全部 framePath */
    onObsImageTap(e) {
        const obsId = String((e.detail && e.detail.obsId) || "");
        if (obsId === "")
            return;
        const group = this.data.observationGroups.find((g) => g.observations.some((o) => o.obsId === obsId));
        const urls = (group ? group.observations : this.data.observations)
            .map((o) => o.framePath)
            .filter((p) => typeof p === "string" && p !== "");
        const current = this.data.observations.find((o) => o.obsId === obsId);
        if (current && current.framePath) {
            wx.previewImage({ current: current.framePath, urls: urls.length > 0 ? urls : [current.framePath] });
        }
    },
    /** 行勾选是组卡内交互态(组件持有,§5.2);页面侧只保留接线,无全局跨组选择 */
    onObservationToggle() { },
    /* ---------------- R0 三动作(§2):就 1 件 / 有多件或需拆开 / 暂不确定 ---------------- */
    /** 就 1 件:生成聚合草稿的唯一入口;同帧风险组先过 §2.1 二次确认 */
    async onGroupConfirmSingle(e) {
        if (this.data.busy || this.data.phase !== "review")
            return;
        const detail = e.detail || {};
        const nameKey = String(detail.nameKey || "");
        const group = this.data.observationGroups.find((g) => g.nameKey === nameKey);
        if (group === undefined)
            return;
        const obsIds = Array.isArray(detail.obsIds) ? detail.obsIds : null;
        const confirmSet = (0, scene_groups_1.confirmSingleSet)(group, obsIds);
        if (confirmSet.length === 0)
            return;
        if (group.sameFrameRisk) {
            // §2.1 修订(PR #105 review 5626920410):弹窗时间=重复实际发生帧,非代表帧
            const riskModal = (0, scene_groups_1.sameFrameRiskModalCopy)(group.duplicateFrameTimeText);
            const sure = await new Promise((resolve) => {
                wx.showModal({
                    title: riskModal.title,
                    content: riskModal.content,
                    confirmText: riskModal.confirmText,
                    cancelText: riskModal.cancelText,
                    success: (r) => resolve(r.confirm === true),
                    fail: () => resolve(false),
                });
            });
            if (sure === false)
                return;
        }
        const draft = (0, video_scene_1.newSceneDraft)({
            observationIds: confirmSet,
            name: group.label,
            locationText: this.data.batchLocation,
            checked: true,
        });
        this.setData({ drafts: this.data.drafts.concat([draft]) }, () => {
            this.renderObservations();
            this.renderDrafts();
            this.saveSession();
        });
    },
    /** 有多件或需拆开:组卡切逐条模式(组件展开),零数据变更(§2.2) */
    onGroupConfirmMulti() { },
    /** 暂不确定:组卡折叠,零数据变更(§2.3);组保留在待确认列表与统计里 */
    onGroupDefer() { },
    /** 逐条生成(组内作用域,§7):先过 §2.4 归属门,再按一条一草稿生成 */
    onGenerateDraftsTap(e) {
        if (this.data.busy || this.data.phase !== "review")
            return;
        const detail = e.detail || {};
        const obsIds = Array.isArray(detail.obsIds) ? detail.obsIds : [];
        if (obsIds.length === 0) {
            wx.showToast({ title: "先勾选至少一条线索", icon: "none" });
            return;
        }
        const conflict = (0, scene_groups_1.claimGuard)(this.data.observations, this.data.drafts, obsIds);
        if (conflict !== null) {
            const index = this.data.observations.findIndex((o) => o.obsId === conflict.obsId);
            wx.showToast({
                title: "第 " + (index + 1) + " 条线索已用于「" + conflict.draftName + "」,先移除该草稿或拆分后再操作",
                icon: "none",
            });
            return;
        }
        const drafts = (0, video_scene_1.createDraftsFromObservations)(this.data.observations, obsIds, {
            mergeSameName: false,
            batchLocation: this.data.batchLocation,
        });
        this.setData({ drafts: this.data.drafts.concat(drafts) }, () => {
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
        // 改名影响组卡「已用于:{草稿名}」归属标签(claimText 随草稿名推导),与 D1 页同步重算组视图
        this.setData({ drafts }, () => {
            this.renderObservations();
            this.renderDrafts();
        });
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
    /* ---------------- 数量输入(issue #102 Q3,Q0-CONTRACT §9.1) ---------------- */
    /**
     * 草稿行数量步进(±1):quantity 只来自用户触碰(1 起步,钳 1..9999,首触补
     * 默认单位「件」成组);existing 行不提供数量输入(关联不碰数量,E7 边界)。
     * 步进值与 observationIds/highlights 条数完全解耦——6 条线索未触碰 = 无数量。
     */
    onDraftQtyStep(e) {
        const index = Number(e.currentTarget.dataset.index);
        const delta = Number(e.currentTarget.dataset.d);
        if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length)
            return;
        const draft = this.data.drafts[index];
        if (draft.target !== "new") {
            wx.showToast({ title: "关联已有物品不改数量,请到物品详情修改", icon: "none" });
            return;
        }
        const drafts = this.data.drafts.slice();
        drafts[index] = (0, video_scene_1.stepDraftQty)(draft, delta);
        this.setData({ drafts }, () => {
            this.renderDrafts();
            this.saveSession();
        });
    },
    /** 草稿行单位选择(UNIT_SET picker);只选单位也把数量落成 1(成组确认) */
    onDraftUnitChange(e) {
        const index = Number(e.currentTarget.dataset.index);
        const idx = Number(isRecord(e.detail) ? e.detail.value : -1);
        if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length)
            return;
        if (Number.isInteger(idx) === false || idx < 0 || idx >= quantity_1.UNIT_SET.length)
            return;
        const draft = this.data.drafts[index];
        if (draft.target !== "new") {
            wx.showToast({ title: "关联已有物品不改数量,请到物品详情修改", icon: "none" });
            return;
        }
        const drafts = this.data.drafts.slice();
        drafts[index] = (0, video_scene_1.setDraftUnit)(draft, quantity_1.UNIT_SET[idx]);
        this.setData({ drafts }, () => {
            this.renderDrafts();
            this.saveSession();
        });
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
        (0, usage_metrics_1.bumpUsageCount)(this.usage, "removes");
        const drafts = this.data.drafts.filter((_, i) => i !== index);
        const keys = this.data.mergeSelectedKeys.filter((k) => k !== removed.draftKey);
        this.setData({ drafts, mergeSelectedKeys: keys }, () => {
            this.renderObservations();
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
        (0, usage_metrics_1.bumpUsageCount)(this.usage, "splits");
        const drafts = this.data.drafts.slice();
        drafts.splice(index, 1, ...split);
        this.setData({ drafts }, () => {
            this.renderObservations();
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
        (0, usage_metrics_1.bumpUsageCount)(this.usage, "merges");
        const keys = new Set(this.data.mergeSelectedKeys);
        const firstIndex = this.data.drafts.findIndex((d) => keys.has(d.draftKey));
        const drafts = this.data.drafts.filter((d) => keys.has(d.draftKey) === false);
        drafts.splice(Math.max(0, firstIndex), 0, merged);
        this.setData({ drafts, mergeSelectedKeys: [] }, () => {
            this.renderObservations();
            this.renderDrafts();
            this.saveSession();
        });
    },
    onAddManualDraftTap() {
        const duration = Math.max(1, this.data.videoDurationMs);
        const end = Math.min(duration, 1500);
        (0, usage_metrics_1.bumpUsageCount)(this.usage, "manualAdds");
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
            this.renderObservations();
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
            drafts[index] = { ...drafts[index], target: "existing", itemId: options[picked].item_id, nodeId: undefined };
            this.setData({ drafts }, () => this.renderDrafts());
        }
        catch (err) {
            wx.showModal({ title: "读取物品失败", content: (0, api_1.errorMessage)(err), showCancel: false });
        }
    },
    /* ---------------- 「归到」逐层选择器(#116 PR A,B 页显式挂载) ----------------
     * 复用 D1 既有「弹层 + 缩进选项列表」模式;B 页无位置上下文,从 home 根下
     * 第一层开始用既有 locations list 逐层下钻(零新读侧 action)。home 根不可
     * 挂(服务端 isHomeRoot 统一判定硬门),选择器只允许选中具体层。
     */
    /** 派生渲染字段:面包屑文本/当前层可否选中(家根不可)/可否返回上一层 */
    renderNodeSelector(stack) {
        const top = stack[stack.length - 1];
        this.setData({
            nodeSelectorPathText: stack.length <= 1 ? "家" : top.path.join(" / "),
            nodeSelectorCurrentName: top.name,
            nodeSelectorCanPick: stack.length > 1,
            nodeSelectorCanBack: stack.length > 1,
        });
    },
    /** 拉当前层 children(既有 locations list;顶层 = home 根下第一层)。
     * 代次守卫(评审 5649433998 修补 1):发起前取号,响应回来(成功或失败)
     * 代次不匹配则整个丢弃——不 setData,旧层级响应绝不覆盖当前层。 */
    async loadNodeSelectorLayer() {
        const stack = this.data.nodeSelectorStack;
        const top = stack[stack.length - 1];
        if (top === undefined)
            return;
        const seq = this.nodeSelectorSeq.next();
        this.setData({ nodeSelectorLoading: true, nodeSelectorError: "" });
        try {
            const res = top.locationId === ""
                ? await (0, locations_api_1.callLocationsApi)({ action: "list" })
                : await (0, locations_api_1.callLocationsApi)({ action: "list", parent_id: top.locationId });
            if (this.nodeSelectorSeq.isCurrent(seq) !== true)
                return;
            const options = (res.children || []).map((c) => {
                const art = (0, location_icon_view_1.locationIconArtwork)(c.name);
                return {
                    locationId: c.location_id,
                    name: c.name,
                    path: c.path.slice(),
                    pathText: c.path.join(" / "),
                    hasChildren: c.child_count > 0,
                    itemCount: c.item_count,
                    icon: art.icon,
                    iconDark: art.iconDark,
                };
            });
            this.setData({ nodeSelectorOptions: options, nodeSelectorLoading: false });
        }
        catch (e) {
            if (this.nodeSelectorSeq.isCurrent(seq) !== true)
                return;
            this.setData({ nodeSelectorLoading: false, nodeSelectorError: (0, api_1.errorMessage)(e) });
        }
    },
    async onDraftNodeTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length)
            return;
        if (this.data.drafts[index].target !== "new")
            return;
        const stack = this.data.nodeSelectorStack.length > 0
            ? this.data.nodeSelectorStack
            : [{ locationId: "", name: "家", path: [] }];
        this.setData({ nodeSelectorVisible: true, nodeSelectorFor: index, nodeSelectorStack: stack, nodeSelectorOptions: [] }, () => {
            this.renderNodeSelector(stack);
        });
        await this.loadNodeSelectorLayer();
    },
    onNodeSelectorCloseTap() {
        // 关闭弹层推进代次:在途层级响应作废,迟到也不复活弹层/不写选项(评审 5649433998)
        this.nodeSelectorSeq.next();
        this.setData({ nodeSelectorVisible: false, nodeSelectorFor: -1 });
    },
    /** 选中某节点(行主体点击):写 nodeId + 权威路径文本,关闭选择器 */
    applyNodePick(node) {
        // 选中即关闭:同关闭推进代次,在途层级响应作废(评审 5649433998)
        this.nodeSelectorSeq.next();
        const index = this.data.nodeSelectorFor;
        if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length)
            return;
        const drafts = this.data.drafts.slice();
        drafts[index] = { ...drafts[index], nodeId: node.locationId, locationText: node.path.join(" / ") };
        this.nodePaths[node.locationId] = node.path.slice();
        this.setData({ drafts, nodeSelectorVisible: false, nodeSelectorFor: -1 }, () => {
            this.renderDrafts();
            this.saveSession();
        });
    },
    /** 选中当前浏览层(「就归这里」;家根不可选,由 nodeSelectorCanPick 挡住) */
    onNodePickCurrentTap() {
        if (this.data.nodeSelectorCanPick !== true) {
            wx.showToast({ title: "家里第一层不能直接挂,请进入具体位置", icon: "none" });
            return;
        }
        const stack = this.data.nodeSelectorStack;
        const top = stack[stack.length - 1];
        this.applyNodePick({ locationId: top.locationId, path: top.path });
    },
    /** 选中列表中某个子节点(行主体) */
    onNodeOptionTap(e) {
        const nodeId = String(e.currentTarget.dataset.nodeId || "");
        const option = this.data.nodeSelectorOptions.find((o) => o.locationId === nodeId);
        if (option === undefined)
            return;
        this.applyNodePick({ locationId: option.locationId, path: option.path });
    },
    /** 下钻(catchtap 阻断行选中):进入该子节点层 */
    async onNodeDrillTap(e) {
        const nodeId = String(e.currentTarget.dataset.nodeId || "");
        const option = this.data.nodeSelectorOptions.find((o) => o.locationId === nodeId);
        if (option === undefined)
            return;
        const stack = this.data.nodeSelectorStack.concat([
            { locationId: option.locationId, name: option.name, path: option.path },
        ]);
        this.setData({ nodeSelectorStack: stack, nodeSelectorOptions: [] }, () => {
            this.renderNodeSelector(stack);
        });
        await this.loadNodeSelectorLayer();
    },
    async onNodeSelectorBackTap() {
        if (this.data.nodeSelectorStack.length <= 1)
            return;
        const stack = this.data.nodeSelectorStack.slice(0, -1);
        this.setData({ nodeSelectorStack: stack, nodeSelectorOptions: [] }, () => {
            this.renderNodeSelector(stack);
        });
        await this.loadNodeSelectorLayer();
    },
    /** 清除选择:回到纯文本(不挂位置),位置文字保留可编辑 */
    onNodeSelectorClearTap() {
        // 清除即关闭:同关闭推进代次,在途层级响应作废(评审 5649433998)
        this.nodeSelectorSeq.next();
        const index = this.data.nodeSelectorFor;
        if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length)
            return;
        const drafts = this.data.drafts.slice();
        drafts[index] = { ...drafts[index], nodeId: undefined };
        this.setData({ drafts, nodeSelectorVisible: false, nodeSelectorFor: -1 }, () => {
            this.renderDrafts();
            this.saveSession();
        });
    },
    /** 弹层防冒泡占位(点面板不吃掉遮罩关闭;D1 页同款) */
    noop() { },
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
                this.nodePaths = {};
                // 重置选择器状态:推进代次,在途层级响应作废(评审 5649433998)
                this.nodeSelectorSeq.next();
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
                    scannedFrameIndexes: [],
                    framesTotal: 0,
                    drafts: [],
                    mergeSelectedKeys: [],
                    frozenItems: [],
                    pendingUpload: null,
                    busy: false,
                    nodeSelectorVisible: false,
                    nodeSelectorFor: -1,
                    nodeSelectorStack: [],
                    nodeSelectorOptions: [],
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
        const built = (0, video_scene_1.buildSceneCommitItems)(this.data.drafts, this.data.observations, this.data.videoDurationMs, this.nodePaths);
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
        this.doneHighlight = null;
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
            // #116 PR A 窗口二:ok:true 但 mounted:false 的行 = 已保存、未挂载,如实计数
            const unmountedCount = res.results.filter((r) => r.ok === true && r.mounted === false).length;
            if (res.ticket_state === "partial" || failed > 0) {
                this.setData({
                    phase: "partial",
                    busy: false,
                    errorText: "已保存 " + successCount + " 件，仍有 " + failed + " 件未完成"
                        + (unmountedCount > 0 ? "；另有 " + unmountedCount + " 件已保存、未挂载" : ""),
                    resultText: "可用同一份确认内容重试剩余件；已成功件不会重复创建。",
                    pendingUpload: pending,
                }, () => this.saveSession());
                return;
            }
            // ④ 跳转高亮目标:「归到」显式挂载的第一件成功件(ok 且 mounted);
            // 只记文字(无 node_id)/挂载失败行如实不算
            this.doneHighlight = pickSceneCommitHighlight(pending.frozenItems, res.results);
            this.setData({
                phase: "done",
                busy: false,
                errorText: "",
                // 完成文案(sceneDoneText):有「已保存、未挂载」行时如实区分,不显完整成功;
                // 全部成功(或未携带挂载)时与现状文案逐字一致。
                resultText: (0, video_scene_1.sceneDoneText)(res.results),
                pendingUpload: null,
                frozenItems: pending.frozenItems,
            }, () => {
                this.clearSession();
                this.renderDrafts();
            });
            // 零隐私使用埋点(#85/#76):保存成功一次 save ping(fire-and-forget,失败全吞;
            // 先置 savedSent,离开时不再补 abandon)
            (0, usage_metrics_1.markUsageSaved)(this.usage);
            (0, usage_metrics_1.sendUsagePing)((0, usage_metrics_1.buildVideoConfirmUsagePing)(this.usage, "video_confirm_save", (0, usage_metrics_1.detectUsagePlatform)(), {
                observations: this.data.observations.length,
                groups: (0, scene_groups_1.buildSceneGroupViews)(this.data.observations, this.data.drafts).length,
                drafts: successCount,
            }, Date.now()));
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
        // ④(#121 批次乙)有「归到」挂载结果 → 按方案跳目标位置层并短高亮该物品
        // (B 页通常从首页进入、栈内无目标层 → 前进带 hl;栈内已有则回退不加层);
        // 无挂载(只记文字)保持原路返回
        const hl = this.doneHighlight;
        if (hl !== null && hl.nodeId !== "") {
            (0, location_nav_1.navToLocationLayer)(hl.nodeId, hl.itemId);
            return;
        }
        wx.navigateBack({
            fail: () => {
                wx.showToast({ title: "返回失败，请手动返回", icon: "none" });
            },
        });
    },
});
