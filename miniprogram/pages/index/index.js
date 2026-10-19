"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const voice_entry_1 = require("../../utils/voice-entry");
const draft_session_1 = require("../../utils/draft-session");
const photo_session_1 = require("../../utils/photo-session");
const evidence_view_1 = require("../../utils/evidence-view");
const video_evidence_1 = require("../../utils/video-evidence");
const remind_ui_1 = require("../../utils/remind-ui");
const household_scope_1 = require("../../utils/household-scope");
const households_api_1 = require("../../utils/households-api");
const fam_switch_1 = require("../../utils/fam-switch");
const locations_api_1 = require("../../utils/locations-api");
const locations_cache_1 = require("../../utils/locations-cache");
/** list 响应根层的未挂物品投影 → 渲染行(缺字段/旧服务端响应一律空数组) */
function toUnmountedRows(rows) {
    if (!Array.isArray(rows)) {
        return [];
    }
    return rows.map((r) => ({
        item_id: r.item_id,
        name: r.name,
        locationText: r.location_text,
        initial: r.name.length > 0 ? r.name[0] : "?",
    }));
}
function toDisplayItems(items) {
    return items.map((item) => ({ ...item, updated_at_short: shortDate(item.updated_at) }));
}
/** 记录更新日期短文案(如 10-08;updated_at 不代表位置确认时间);非法时间如实返回空串 */
function shortDate(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) {
        return "";
    }
    const d = new Date(t);
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
/** 格子计数文案:件数优先;没东西但有子位置时如实说明 */
function roomCountText(node) {
    if (node.item_count > 0) {
        return node.item_count + " 件东西";
    }
    if (node.child_count > 0) {
        return node.child_count + " 个更细的位置";
    }
    return "还没记东西";
}
Page({
    data: {
        queryText: "",
        querying: false,
        queried: false,
        queryKeyword: "",
        queryResults: [],
        queryError: "",
        resumeSession: null,
        photoResume: null,
        dueBanner: null,
        familyShared: false,
        firstUse: false,
        mapLoading: true,
        mapRefreshing: false,
        mapStale: false,
        mapError: "",
        mapTitle: "家里有什么",
        backLabel: "",
        isRootView: true,
        containerName: "",
        rooms: [],
        directItems: [],
        unmountedCount: 0,
        unmountedView: false,
        unmountedItems: [],
        acting: false,
        voiceState: "idle",
        transcribing: false,
        extracting: false,
        recordSeconds: 0,
        partialText: "",
        ctaPressed: false,
        famSheetVisible: false,
        famSheetOptions: [],
        switchingFamily: false,
    },
    voiceEntry: null,
    requestSeq: (0, locations_cache_1.createRequestSeq)(),
    renderedCurrentView: false,
    renderedScopeGen: null,
    queriedScopeGen: null,
    lastFirstUse: true,
    viewStack: [],
    currentNodeId: "",
    currentNodePath: [],
    onLoad(options) {
        // Page options 会被浅拷贝共享,实例字段按本页实例重建(locations 页同款防护)
        this.requestSeq = (0, locations_cache_1.createRequestSeq)();
        this.renderedCurrentView = false;
        this.renderedScopeGen = null;
        this.queriedScopeGen = null;
        this.lastFirstUse = true;
        this.viewStack = [];
        this.currentNodeId = "";
        this.currentNodePath = [];
        this.ensureVoiceEntry();
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
    onShow() {
        this.refreshFamilyChip();
        void this.loadMapLayer();
        // 未完成草稿会话恢复入口(中途退出/进程回收;原幂等键续存,不重复建档)。
        // 展示前资格复核(硬门 C):先等服务端家庭上下文验证,未验证期间不把
        // 旧家庭的未完成批次当作当前可访问内容展示;验证失败时保持无横幅
        void (0, households_api_1.ensureScopeVerified)().then(() => {
            this.setData({
                resumeSession: this.currentResumeSession(),
                photoResume: this.currentPhotoResume(),
            });
        });
        // 到期横幅(#36):同样资格复核后拉取;失败静默,不影响地图
        void this.refreshDueBanner();
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
    },
    /** 家庭上下文头刷新(来自 household-scope 记忆;app 前台复核后已最新) */
    refreshFamilyChip() {
        this.setData({ familyShared: (0, household_scope_1.isHouseholdScopeShared)() });
    },
    /**
     * 语音录入入口(utils/voice-entry 单例共享模块):状态机全在模块内,
     * 本页只挂宿主(H0 大 CTA 的渲染与文字回退);底部常驻条是 voice-bar 组件,
     * 自带宿主,按压方(presser)路由保证回退与提示只回发起方。
     */
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
        });
    },
    onTalkTouchStart(e) {
        if (this.voiceEntry === null) {
            return;
        }
        this.setData({ ctaPressed: true });
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
        this.setData({ ctaPressed: false });
        if (this.voiceEntry !== null) {
            this.voiceEntry.pressEnd();
        }
    },
    onTalkTouchCancel() {
        this.setData({ ctaPressed: false });
        if (this.voiceEntry !== null) {
            this.voiceEntry.pressCancel();
        }
    },
    /** 录音授权被拒选「用文字」:进文字核对页(与 voice-bar 的回退一致) */
    voiceFallbackToText() {
        if (this.voiceEntry !== null) {
            this.voiceEntry.invalidate();
        }
        this.setData({ voiceState: "idle", transcribing: false, extracting: false, partialText: "" });
        wx.navigateTo({
            url: "/pages/confirm/confirm?manual=true",
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    onTextRecordTap() {
        wx.navigateTo({
            url: "/pages/confirm/confirm?manual=true",
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    /* ---------------- 找东西(H1b:命中按物品分组,就地展示) ---------------- */
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
        // 家庭切换(创建/加入/退出/被移除)会递增作用域代数:查询在途回来时
        // 家庭已变,旧家庭的结果与失败提示都不上屏(T5:无旧家庭缓存穿透)
        const scopeGen = (0, household_scope_1.captureScopeGeneration)();
        this.setData({ querying: true, queryError: "" });
        try {
            const res = await (0, api_1.callItemsApi)({ action: "query", q });
            if (!(0, household_scope_1.isScopeGenerationCurrent)(scopeGen)) {
                return; // 查询在途期间家庭已切换:旧家庭结果不上屏
            }
            this.queriedScopeGen = scopeGen;
            this.setData({
                queried: true,
                queryKeyword: q,
                queryResults: toDisplayItems(res.items),
            });
            // 证据缩略(#3):结果先以纯文字上屏,缩略异步补(失败静默不补)
            const resultIds = res.items.map((it) => it.item_id);
            void this.attachQueryEvidence(resultIds, scopeGen);
            void this.attachQueryVideo(resultIds, scopeGen);
        }
        catch (e) {
            if (!(0, household_scope_1.isScopeGenerationCurrent)(scopeGen)) {
                return; // 同上:旧家庭的失败提示也不上屏
            }
            this.queriedScopeGen = scopeGen;
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
    /**
     * 搜索/找物结果行的证据缩略(#3 §6,结构现成的低成本增强):按需批量
     * photoEvidenceGet(单次 ≤10,超出的行保持纯文字——结果按相关度排序,
     * 前排优先),每件取最新一张换链成功的临时链接。守卫与查询同源:
     * 在途家庭切换、用户已收起结果或已发起下一次搜索(queriedScopeGen 变了)
     * 时绝不回写 queryResults。缩略只是「有留证」的示意,行内位置仍以
     * 文字记录为准(语义在详情页证据卡展开说明)。
     */
    async attachQueryEvidence(ids, scopeGen) {
        const top = ids.slice(0, 10);
        if (top.length === 0) {
            return;
        }
        try {
            const res = await (0, api_1.callItemsApi)({
                action: "photoEvidenceGet",
                item_ids: top,
            });
            if (!(0, household_scope_1.isScopeGenerationCurrent)(scopeGen) ||
                this.queriedScopeGen !== scopeGen) {
                return; // 在途家庭切换 / 结果已收起或已换新:不回写
            }
            const urls = (0, evidence_view_1.pickEvidenceUrls)(res.evidence, top);
            const rows = this.data.queryResults.map((r) => urls[r.item_id] !== undefined ? { ...r, evidenceUrl: urls[r.item_id] } : r);
            this.setData({ queryResults: rows });
        }
        catch (e) {
            // 静默:缩略属增强露出,拉不到就保持纯文字行,绝不出错提示
        }
    },
    async attachQueryVideo(ids, scopeGen) {
        const top = ids.slice(0, 10);
        if (top.length === 0)
            return;
        try {
            const res = await (0, api_1.callItemsApi)({ action: "videoEvidenceGet", item_ids: top });
            if ((0, household_scope_1.isScopeGenerationCurrent)(scopeGen) === false || this.queriedScopeGen !== scopeGen)
                return;
            const videos = (0, video_evidence_1.pickVideoEvidence)(res.evidence, top);
            const rows = this.data.queryResults.map((r) => videos[r.item_id] !== undefined ? { ...r, hasVideo: true } : r);
            this.setData({ queryResults: rows });
        }
        catch (e) {
            // 视频角标是增强露出,失败静默
        }
    },
    onResultTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        const item = this.data.queryResults[index];
        if (item) {
            this.openItem(item);
        }
    },
    onCollapseResultsTap() {
        this.queriedScopeGen = null;
        this.setData({ queried: false, queryKeyword: "", queryResults: [], queryError: "" });
    },
    onResumeTap() {
        const resume = this.data.resumeSession;
        if (resume === null) {
            return;
        }
        this.setData({ resumeSession: null });
        wx.navigateTo({
            url: "/pages/confirm/confirm?sid=" + resume.sid,
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    /** 未完成批次数据按当前家庭作用域读取(键隔离,P0;验证后才读,硬门 C) */
    currentResumeSession() {
        const unfinished = (0, draft_session_1.getUnfinishedDraftSession)();
        if (unfinished === null) {
            return null;
        }
        return { sid: unfinished.sid, count: unfinished.payload.drafts.length };
    },
    /** 拍照批恢复(#3):按当前家庭作用域键读未完成拍照会话(同硬门 C 口径) */
    currentPhotoResume() {
        const unfinished = (0, photo_session_1.getUnfinishedPhotoSession)();
        if (unfinished === null) {
            return null;
        }
        // 真实状态分诊(架构评审 2026-10-17:全记完只剩照片待关联时,不再误报「没记完」)
        const notDone = unfinished.rows.filter((r) => !r.done).length;
        if (notDone > 0) {
            return { count: notDone, mode: "review" };
        }
        const pending = unfinished.pendingEvidence;
        if (pending !== null && pending !== undefined && pending.items.length > 0) {
            return { count: pending.items.length, mode: "evidence" };
        }
        return null;
    },
    onPhotoResumeTap() {
        if (this.data.photoResume === null) {
            return;
        }
        this.setData({ photoResume: null });
        wx.navigateTo({
            url: "/pages/photo/photo?resume=1",
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    /** 拍照识物入口(#3):新批拍照(确认前照片不持久化、不写云存储;识别临时传输需首次授权) */
    onPhotoRecordTap() {
        wx.navigateTo({
            url: "/pages/photo/photo",
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    onVideoRecordTap() {
        wx.navigateTo({
            url: "/pages/video/video",
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    /* ---------------- 家庭地图(H1:容器视图整页切换,X1/X2 全守卫) ---------------- */
    /**
     * 拉取当前视图层:缓存先行 + 条件刷新(issue #23 分层缓存),迟到响应不上屏
     * (issue #24 请求序号),在途写失效作废补拉(缓存失效代数),家庭切换
     * (作用域代数)时旧家庭响应不上屏、视图回根层按新家庭重载——加载中绝不
     * 拿上个家庭的旧数据冒充当前内容。作用域未经服务端验证时不读持久化缓存。
     */
    async loadMapLayer(force, retryOnStaleGen) {
        const scopeGen = (0, household_scope_1.captureScopeGeneration)();
        if ((this.renderedScopeGen !== null &&
            !(0, household_scope_1.isScopeGenerationCurrent)(this.renderedScopeGen)) ||
            (this.queriedScopeGen !== null &&
                !(0, household_scope_1.isScopeGenerationCurrent)(this.queriedScopeGen))) {
            // 家庭已切换(创建/加入/退出/被移除):屏上旧家庭内容立即清空——含
            // H1b 搜索结果(旧家庭的搜索会整页压住新家庭地图)、视图回根层,再按
            // 当前家庭加载(X1 硬约束:不先显示旧家庭再等纠正)
            this.viewStack = [];
            this.currentNodeId = "";
            this.currentNodePath = [];
            this.renderedCurrentView = false;
            this.renderedScopeGen = null;
            this.queriedScopeGen = null;
            this.lastFirstUse = true;
            this.setData({
                rooms: [],
                directItems: [],
                unmountedCount: 0,
                unmountedView: false,
                unmountedItems: [],
                mapTitle: "家里有什么",
                backLabel: "",
                isRootView: true,
                containerName: "",
                firstUse: false,
                mapError: "",
                mapStale: false,
                mapRefreshing: false,
                mapLoading: true,
                queried: false,
                queryKeyword: "",
                queryResults: [],
                queryError: "",
                // 到期横幅随作用域一起清(#36):不把旧家庭的到期数带到新家庭
                dueBanner: null,
            });
        }
        const nodeId = this.viewStack.length > 0
            ? this.viewStack[this.viewStack.length - 1].id
            : "";
        const seq = this.requestSeq.next();
        const cacheGen = (0, locations_cache_1.captureCacheGeneration)();
        const cached = !(0, household_scope_1.isScopeVerified)() ? null : (0, locations_cache_1.readLocationsLayer)(nodeId);
        const plan = (0, locations_cache_1.planLocationsLoad)({
            cached,
            fresh: cached !== null && (0, locations_cache_1.isLocationsCacheFresh)(cached),
            force: force === true,
            pickMode: false,
            rendered: this.renderedCurrentView,
        });
        if (plan.useCache && cached !== null) {
            this.renderMap(cached.response); // 缓存先行上屏:有旧内容绝不整页骨架
        }
        this.setData({
            mapLoading: plan.skeleton,
            mapRefreshing: plan.fetch && !plan.skeleton,
            mapStale: false,
            mapError: "",
        });
        if (!plan.fetch) {
            return; // TTL 内直接用缓存、不触发云函数
        }
        try {
            const res = await (0, locations_api_1.callLocationsApi)(nodeId ? { action: "list", parent_id: nodeId } : { action: "list" });
            if (!this.requestSeq.isCurrent(seq)) {
                return; // 迟到响应:既不 setData 也不写缓存
            }
            if (!(0, locations_cache_1.isCacheGenerationCurrent)(cacheGen)) {
                // 在途期间发生过写失效(其他页面改名/移动/挂载…):旧树不上屏不写
                // 缓存,补拉一次;连续写场景由 retryOnStaleGen 挡住不无限循环
                if (retryOnStaleGen !== false) {
                    void this.loadMapLayer(force, false);
                }
                else {
                    this.setData({ mapLoading: false, mapRefreshing: false, mapStale: true });
                }
                return;
            }
            if (!(0, household_scope_1.isScopeGenerationCurrent)(scopeGen)) {
                // 在途期间家庭切换:旧家庭响应不上屏不写缓存;回根层按新家庭重载
                //(搜索结果同样按 queriedScopeGen 在入口守卫里一并收起)
                this.viewStack = [];
                this.currentNodeId = "";
                this.currentNodePath = [];
                this.renderedCurrentView = false;
                this.renderedScopeGen = null;
                this.queriedScopeGen = null;
                this.lastFirstUse = true;
                this.setData({
                    rooms: [],
                    directItems: [],
                    unmountedCount: 0,
                    unmountedView: false,
                    unmountedItems: [],
                    mapTitle: "家里有什么",
                    backLabel: "",
                    isRootView: true,
                    containerName: "",
                    firstUse: false,
                    mapError: "",
                    mapStale: false,
                    mapRefreshing: false,
                    mapLoading: true,
                    queried: false,
                    queryKeyword: "",
                    queryResults: [],
                    queryError: "",
                    // 到期横幅随作用域一起清(#36):不把旧家庭的到期数带到新家庭
                    dueBanner: null,
                });
                void this.loadMapLayer(false, false);
                return;
            }
            (0, locations_cache_1.writeLocationsLayer)(nodeId, res, Date.now(), cacheGen);
            this.renderMap(res); // 刷新成功:原位 setData 更新,不闪屏
            this.setData({ mapLoading: false, mapRefreshing: false, mapStale: false, mapError: "" });
        }
        catch (e) {
            if (!this.requestSeq.isCurrent(seq)) {
                return;
            }
            if (this.renderedCurrentView) {
                // 刷新失败:保留旧树 + 如实提示可重试;不更新缓存时间戳
                this.setData({ mapLoading: false, mapRefreshing: false, mapStale: true });
            }
            else {
                this.setData({ mapLoading: false, mapRefreshing: false, mapError: (0, api_1.errorMessage)(e) });
            }
        }
    },
    /** list 响应(缓存或服务端)→ 上屏数据;容器视图栈与响应保持一致 */
    renderMap(res) {
        const isRoot = res.node.type === "home";
        if (isRoot) {
            this.viewStack = [];
        }
        else if (this.viewStack.length === 0 ||
            this.viewStack[this.viewStack.length - 1].id !== res.node.location_id) {
            // 防御:视图栈与响应不一致(不应发生的异常路径)——退回根层重载,
            // 不用 path 名字自造层级(祖先 id 客户端拿不到)
            this.viewStack = [];
            this.renderedCurrentView = false;
            void this.loadMapLayer(false, false);
            return;
        }
        else {
            this.viewStack[this.viewStack.length - 1].name = res.node.name;
        }
        this.currentNodeId = res.node.location_id;
        this.currentNodePath = res.node.path || [];
        const rooms = res.children.map((c) => ({
            location_id: c.location_id,
            name: c.name,
            initial: c.name.length > 0 ? c.name[0] : "?",
            countText: roomCountText(c),
        }));
        this.renderedCurrentView = true;
        this.renderedScopeGen = (0, household_scope_1.captureScopeGeneration)();
        const firstUse = isRoot && rooms.length === 0 && res.items.length === 0 && res.unmounted_count === 0;
        // 首件已记住(H0 → H1):旧的空搜索结果不再挡着地图,自动收起
        if (this.lastFirstUse && !firstUse && this.data.queried) {
            this.queriedScopeGen = null;
            this.setData({ queried: false, queryKeyword: "", queryResults: [], queryError: "" });
        }
        this.lastFirstUse = firstUse;
        // 停在「尚未归类」明细视图时(Fix 3):后台刷新只更新数据,抬头/返回胶囊
        // 仍保持该视图的文案,不被根层标题顶掉
        const inUnmountedView = this.data.unmountedView;
        this.setData({
            firstUse,
            mapTitle: inUnmountedView
                ? "尚未归类 · " + res.unmounted_count + " 件待核实"
                : isRoot
                    ? "家里有什么"
                    : res.node.name + "里有什么",
            backLabel: inUnmountedView
                ? "家里"
                : isRoot
                    ? ""
                    : res.node.path.length >= 2
                        ? res.node.path[res.node.path.length - 2]
                        : "家里",
            isRootView: isRoot,
            containerName: isRoot ? "" : res.node.name,
            rooms,
            directItems: toDisplayItems(res.items),
            unmountedCount: res.unmounted_count,
            unmountedItems: isRoot ? toUnmountedRows(res.unmounted_items) : this.data.unmountedItems,
        });
    },
    /** X2 失败态「再试一次」/「当前为上次记录」提示条:点按强制刷新 */
    onRetryTap() {
        void this.loadMapLayer(true);
    },
    /** 点格子:整页切入该容器(中间区域整体替换,抬头随之变化) */
    onRoomTap(e) {
        if (this.data.acting) {
            return;
        }
        const index = Number(e.currentTarget.dataset.index);
        const room = this.data.rooms[index];
        if (!room) {
            return;
        }
        const fromRoot = this.data.isRootView;
        this.viewStack.push({ id: room.location_id, name: room.name });
        this.renderedCurrentView = false;
        this.setData({
            isRootView: false,
            backLabel: fromRoot ? "家里" : this.data.containerName,
            containerName: room.name,
            mapTitle: room.name + "里有什么",
            rooms: [],
            directItems: [],
            unmountedCount: 0,
            unmountedView: false,
        });
        void this.loadMapLayer();
    },
    /**
     * 「尚未归类」通栏格点入(#36 0.6.0 真机反馈 Fix 3):容器视图式整页切换——
     * 抬头「尚未归类 · N 件待核实」、返回胶囊「‹ 家里」;行 = 首字块 + 名称 +
     * 原话位置 + 灰标「位置待核实」。明细来自根层 list 响应投影(跟随现有
     * locations 缓存失效规则);旧缓存没有明细时强制刷新一次,不给空列表。
     */
    onUnmountedTap() {
        if (this.data.acting) {
            return;
        }
        if (this.data.unmountedCount <= 0) {
            return;
        }
        const staleCache = this.data.unmountedItems.length === 0 && this.data.unmountedCount > 0;
        this.renderedCurrentView = false;
        this.setData({
            unmountedView: true,
            mapTitle: "尚未归类 · " + this.data.unmountedCount + " 件待核实",
            backLabel: "家里",
            rooms: [],
            directItems: [],
        });
        void this.loadMapLayer(staleCache);
    },
    /** 明细行点击:按 item_id 进物品详情(原话在那里核对,整理位置也在那里) */
    onUnmountedRowTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        const row = this.data.unmountedItems[index];
        if (!row) {
            return;
        }
        wx.navigateTo({
            url: "/pages/item/item?item_id=" + encodeURIComponent(row.item_id),
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    /** 返回胶囊:逐层退回(栈内上一层 id 是钻入时记下的,不靠推测);「尚未归类」视图退回家里 */
    onBackTap() {
        if (this.data.acting) {
            return;
        }
        if (this.data.unmountedView) {
            this.renderedCurrentView = false;
            this.setData({
                unmountedView: false,
                mapTitle: "家里有什么",
                backLabel: "",
                rooms: [],
                directItems: [],
            });
            void this.loadMapLayer();
            return;
        }
        this.viewStack.pop();
        this.renderedCurrentView = false;
        const parent = this.viewStack.length > 0 ? this.viewStack[this.viewStack.length - 1] : null;
        this.setData({
            isRootView: parent === null,
            containerName: parent ? parent.name : "",
            mapTitle: parent ? parent.name + "里有什么" : "家里有什么",
            backLabel: parent
                ? this.viewStack.length >= 2
                    ? this.viewStack[this.viewStack.length - 2].name
                    : "家里"
                : "",
            rooms: [],
            directItems: [],
        });
        void this.loadMapLayer();
    },
    onDirectItemTap(e) {
        const index = Number(e.currentTarget.dataset.index);
        const item = this.data.directItems[index];
        if (item) {
            // 容器条目直接记在当前层:把这条路径带给详情页(只读大卡「上次记在」);
            // 搜索结果不知道路径,不传(详情页只用原话,不猜)
            this.openItem(item, !this.data.isRootView ? this.currentNodePath : []);
        }
    },
    openItem(item, spacePath = []) {
        const summary = {
            item_id: item.item_id,
            name: item.name,
            location_text: item.location_text,
            note: item.note,
            version: item.version,
            updated_at: item.updated_at,
        };
        const params = ["data=" + encodeURIComponent(JSON.stringify(summary))];
        if (spacePath.length > 0) {
            params.push("path=" + encodeURIComponent(JSON.stringify(spacePath)));
        }
        wx.navigateTo({
            url: "/pages/item/item?" + params.join("&"),
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    /* ---------------- 容器「⋯」整理位置(复用 locations 页动作与确认交互) ---------------- */
    onContainerMore() {
        if (this.data.acting) {
            return;
        }
        const current = this.currentContainer();
        if (current === null) {
            return;
        }
        wx.showActionSheet({
            itemList: ["改名", "移动到…", "合并到…"],
            success: (r) => {
                if (r.tapIndex === 0) {
                    this.renameContainer(current);
                }
                else if (r.tapIndex === 1) {
                    this.moveContainer(current);
                }
                else if (r.tapIndex === 2) {
                    this.mergeContainer(current);
                }
            },
            fail: () => { },
        });
    },
    currentContainer() {
        const top = this.viewStack.length > 0 ? this.viewStack[this.viewStack.length - 1] : null;
        // 当前层数据未就绪(加载中/失败,currentNodeId 还是上一层的)或已在根层:无目标
        if (top === null || top.id !== this.currentNodeId) {
            return null;
        }
        return {
            location_id: this.currentNodeId,
            name: this.data.containerName,
            path: this.currentNodePath,
        };
    },
    renameContainer(node) {
        wx.showModal({
            title: "改名",
            editable: true,
            placeholderText: node.name,
            success: (r) => {
                if (!r.confirm) {
                    return;
                }
                const name = (r.content || "").trim();
                if (!name) {
                    wx.showToast({ title: "名称不能为空", icon: "none" });
                    return;
                }
                if (name === node.name) {
                    return;
                }
                void this.doRename(node, name);
            },
        });
    },
    async doRename(node, name) {
        this.setData({ acting: true });
        try {
            await (0, locations_api_1.callLocationsApi)({
                action: "rename",
                node_id: node.location_id,
                name,
            });
            wx.showToast({ title: "已改名", icon: "success" });
            await this.loadMapLayer(true);
        }
        catch (e) {
            wx.showModal({ title: "改名失败", content: (0, api_1.errorMessage)(e), showCancel: false });
        }
        finally {
            this.setData({ acting: false });
        }
    },
    /** 移动当前容器:进选择模式选「新父位置」(home 根不可作目标,服务端同理拒绝) */
    moveContainer(node) {
        this.openPicker("把「" + node.name + "」移到…", node.path.join("/"), (picked) => {
            void this.doMove(node, picked);
        });
    },
    async doMove(node, newParentId) {
        if (this.data.acting) {
            return;
        }
        this.setData({ acting: true });
        try {
            await (0, locations_api_1.callLocationsApi)({
                action: "move",
                node_id: node.location_id,
                new_parent_id: newParentId,
            });
            wx.showToast({ title: "已移动", icon: "success" });
            // 容器搬了家:视图栈里的祖先层已过时(客户端拿不到新祖先 id),
            // 如实回根层重新看整张地图,不猜层级
            this.viewStack = [];
            this.currentNodeId = "";
            this.currentNodePath = [];
            this.renderedCurrentView = false;
            this.setData({
                isRootView: true,
                containerName: "",
                mapTitle: "家里有什么",
                backLabel: "",
                rooms: [],
                directItems: [],
            });
            await this.loadMapLayer(true);
        }
        catch (e) {
            wx.showModal({ title: "移动失败", content: (0, api_1.errorMessage)(e), showCancel: false });
        }
        finally {
            this.setData({ acting: false });
        }
    },
    /** 合并重复位置:人工确认后进选择模式选目标(不自动合并) */
    mergeContainer(node) {
        wx.showModal({
            title: "合并重复位置",
            content: "把「" + node.name + "」并进另一个位置:物品会一起挪过去,这个位置会消失。继续?",
            confirmText: "选目标",
            cancelText: "取消",
            success: (r) => {
                if (!r.confirm) {
                    return;
                }
                this.openPicker("把「" + node.name + "」并进…", node.path.join("/"), (picked) => {
                    void this.doMerge(node, picked);
                });
            },
        });
    },
    async doMerge(node, targetId) {
        if (this.data.acting) {
            return;
        }
        this.setData({ acting: true });
        try {
            const res = await (0, locations_api_1.callLocationsApi)({
                action: "merge",
                source_node_id: node.location_id,
                target_node_id: targetId,
            });
            const comp = res.compensated || 0;
            wx.showToast({
                title: comp > 0
                    ? "已合并;" + comp + " 件刚挂上来的物品已自动摘除"
                    : "已合并",
                icon: comp > 0 ? "none" : "success",
                duration: comp > 0 ? 3000 : 1500,
            });
            // 这个位置已消失:退回上一层(父层 id 是钻入时记下的,仍有效)
            this.viewStack.pop();
            this.currentNodeId = "";
            this.currentNodePath = [];
            this.renderedCurrentView = false;
            const parent = this.viewStack.length > 0 ? this.viewStack[this.viewStack.length - 1] : null;
            this.setData({
                isRootView: parent === null,
                containerName: parent ? parent.name : "",
                mapTitle: parent ? parent.name + "里有什么" : "家里有什么",
                backLabel: parent
                    ? this.viewStack.length >= 2
                        ? this.viewStack[this.viewStack.length - 2].name
                        : "家里"
                    : "",
                rooms: [],
                directItems: [],
            });
            await this.loadMapLayer(true);
        }
        catch (e) {
            // merge 冲突中止是「可重试」的收敛语义:如实提示后由用户重走一次合并
            wx.showModal({ title: "合并失败", content: (0, api_1.errorMessage)(e), showCancel: false });
        }
        finally {
            this.setData({ acting: false });
        }
    },
    /** 以选择模式进 locations 页,选中后经 EventChannel 回传(退栈由本页统一计算) */
    openPicker(title, excludePath, onPick) {
        const params = ["picker=1", "title=" + encodeURIComponent(title)];
        if (excludePath) {
            params.push("exclude_path=" + encodeURIComponent(excludePath));
        }
        wx.navigateTo({
            url: "/pages/locations/locations?" + params.join("&"),
            events: {
                pickNode: (d) => {
                    onPick(d.location_id);
                    // 选择器页只叠在本页正上方,一次退掉全部(#29 后续真机反馈:
                    // 多页各自 navigateBack 在导航风暴中会被吞掉)
                    const pages = getCurrentPages();
                    const idx = pages.indexOf(this);
                    const delta = pages.length - 1 - idx;
                    if (idx !== -1 && delta > 0) {
                        wx.navigateBack({ delta, fail: () => { } });
                    }
                },
            },
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    /**
     * 「我们家/我的家」入口(十七轮 B 线):
     * - 个人家庭态:照旧直接进家庭管理页(要共享去那里创建/加入);
     * - 共享态:打开三选弹层(我的家 / 我们家·家庭名 / 家庭管理页);
     * - 加载态(X1)不切换:骨架屏期间不拿弹层换家,避免旧家庭数据冒充(§6);
     * - 切换进行中不重复打开。
     */
    onFamilyTap() {
        if (this.data.switchingFamily) {
            return;
        }
        if (this.data.mapLoading) {
            wx.showToast({ title: "正在加载,稍等一下再切换家庭", icon: "none" });
            return;
        }
        if (!(0, household_scope_1.isHouseholdScopeShared)()) {
            wx.navigateTo({
                url: "/pages/family/family",
                fail: () => {
                    wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
                },
            });
            return;
        }
        this.setData({
            famSheetVisible: true,
            famSheetOptions: (0, fam_switch_1.famSwitchSheetOptions)(),
        });
    },
    /** 三选弹层关闭(蒙层点击/取消;切换进行中不可中途关) */
    onFamSheetClose() {
        if (this.data.switchingFamily) {
            return;
        }
        this.setData({ famSheetVisible: false });
    },
    onFamSheetCloseTap() {
        this.onFamSheetClose();
    },
    noop() { },
    /**
     * 三选弹层选行:
     * - 家庭管理页:关层进 F1(创建/邀请/成员/退出/解散都在那里);
     * - 当前家庭:只提示「已在当前家庭」,不发起切换;
     * - 另一个家:执行 households.switch(只是换当前家庭指针,数据各归各家)。
     */
    onFamSheetPick(e) {
        if (this.data.switchingFamily) {
            return;
        }
        const key = String((e.currentTarget.dataset || {}).key || "");
        if (key === "admin") {
            this.setData({ famSheetVisible: false });
            wx.navigateTo({
                url: "/pages/family/family",
                fail: () => {
                    wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
                },
            });
            return;
        }
        if (key !== "mine" && key !== "shared") {
            return;
        }
        const option = this.data.famSheetOptions.find((o) => o.key === key);
        if (!option) {
            return;
        }
        if (option.current) {
            this.setData({ famSheetVisible: false });
            wx.showToast({ title: "已在当前家庭", icon: "none" });
            return;
        }
        void this.doFamilySwitch(key === "mine" ? "personal" : "shared");
    },
    /**
     * 执行切换家庭(十七轮 B 线;#34 合同不弱化):
     * - households.switch 只更新服务端当前家庭指针;成功后 switchFamily 内部
     *   走既有捕获链(作用域代数递增 + 位置树缓存清空 + 家庭名/自资料按新家
     *   重置,再补一次 status 刷新自资料),不另起任何缓存体系;
     * - 成功后本页整页刷新:家庭上下文头(我们家/我的家)、地图(经 loadMapLayer
     *   入口守卫先清屏给骨架屏,绝不先显示上一家数据,含搜索结果与快到期横幅)、
     *   未完成批次横幅(按新家庭的作用域键读,旧家草稿互不可达)——与 onShow
     *   同一条刷新链;失败如实提示,作用域未动、屏上内容保持当前家庭(不半切)。
     */
    async doFamilySwitch(target) {
        if (this.data.switchingFamily) {
            return;
        }
        this.setData({ switchingFamily: true });
        try {
            const res = await (0, households_api_1.switchFamily)(target);
            this.setData({ famSheetVisible: false });
            const name = res.shared && res.display_name ? res.display_name : "";
            wx.showToast({
                title: res.shared ? "已切到「我们家 · " + name + "」" : "已切到「我的家」",
                icon: "none",
                duration: 2000,
            });
            // 与 onShow 同链刷新:上下文头 → 地图(先骨架屏再按新家重载)→ 未完成批次 → 快到期
            this.refreshFamilyChip();
            this.setData({ resumeSession: this.currentResumeSession(), photoResume: this.currentPhotoResume() });
            void this.loadMapLayer();
            void this.refreshDueBanner();
        }
        catch (e) {
            // 失败不切:服务端文案如实提示;作用域/屏上内容都是当前家庭,保持不动
            this.setData({ famSheetVisible: false });
            wx.showModal({ title: "切换失败", content: (0, api_1.errorMessage)(e), showCancel: false });
        }
        finally {
            this.setData({ switchingFamily: false });
        }
    },
    /**
     * 到期横幅(#36 三阶段):remindList 有 active 且(已过期或 7 天内)时上屏
     * 「⏰ N 件已过期,M 件这几天到期」。横幅属增强:加载失败静默隐藏、
     * 绝不影响地图;家庭切换(作用域代数变化)后在途响应不上屏。
     * 展示前先经 households 资格复核(硬门 C),不显示旧家庭数据。
     */
    async refreshDueBanner() {
        await (0, households_api_1.ensureScopeVerified)();
        const scopeGen = (0, household_scope_1.captureScopeGeneration)();
        try {
            const res = await (0, api_1.callItemsApi)({ action: "remindList" });
            if (!(0, household_scope_1.isScopeGenerationCurrent)(scopeGen)) {
                return; // 在途期间家庭已切换:旧家庭的到期数不上屏
            }
            const counts = (0, remind_ui_1.countDue)(res.reminders);
            if (counts.overdue === 0 && counts.soon === 0) {
                this.setData({ dueBanner: null });
                return;
            }
            this.setData({
                dueBanner: { ...counts, text: (0, remind_ui_1.dueBannerText)(counts) },
            });
        }
        catch (e) {
            // 失败静默:横幅不显示,地图照常
            if ((0, household_scope_1.isScopeGenerationCurrent)(scopeGen)) {
                this.setData({ dueBanner: null });
            }
        }
    },
    /** 点横幅:进「快到期的东西」(R1) */
    onDueBannerTap() {
        wx.navigateTo({
            url: "/pages/reminders/reminders",
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
});
