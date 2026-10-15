"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const households_api_1 = require("../../utils/households-api");
const locations_api_1 = require("../../utils/locations-api");
const household_scope_1 = require("../../utils/household-scope");
const remind_ui_1 = require("../../utils/remind-ui");
/** 页面 query 参数不会自动解码;容错解码(已解码或含非法 % 时原样返回) */
function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    }
    catch {
        return s;
    }
}
/** 记录更新日期短文案(如 10-08,与首页一致;updated_at 不代表位置确认时间);非法时间如实返回空串 */
function shortDate(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) {
        return "";
    }
    const d = new Date(t);
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
/**
 * 解析跳转方带来的空间路径(进入时的容器层 path,JSON 字符串数组)。
 * 只信严格结构:非数组 / 含非字符串 / 超过 6 段一律视为没有,不猜。
 */
function parseSpacePath(raw) {
    if (!raw) {
        return [];
    }
    try {
        const p = JSON.parse(safeDecode(raw));
        if (!Array.isArray(p) || p.length === 0 || p.length > 6) {
            return [];
        }
        if (!p.every((seg) => typeof seg === "string" && seg.trim().length > 0)) {
            return [];
        }
        return p.map((seg) => seg.trim());
    }
    catch {
        return [];
    }
}
Page({
    data: {
        itemId: "",
        name: "",
        locationText: "",
        note: "",
        version: 0,
        updatedAtText: "",
        lastConfirmedText: "",
        spacePath: [],
        editPanelOpen: false,
        moreOpen: false,
        familyShared: false,
        saving: false,
        deleting: false,
        mounting: false,
        mountPanelOpen: false,
        mountSegments: [],
        mountNeedConfirm: false,
        mountOrderViolation: false,
        mountSaving: false,
        expire: null,
        remindAt: "",
        remindGeneration: -1,
        today: (0, remind_ui_1.localTodayYmd)(),
        remindBusy: false,
        vagueQuote: "",
    },
    /** 最近一次加载到的内容,用于判断是否有修改 */
    original: { name: "", location: "", note: "" },
    pendingRetry: null,
    onLoad(options) {
        // 空间路径来自进入时的容器层(首页地图 / 空间页点开的条目);
        // 搜索等入口没有路径就不显示,只用原话,不自造
        this.setData({
            spacePath: parseSpacePath(options.path),
            familyShared: (0, household_scope_1.isHouseholdScopeShared)(),
        });
        const rawItemId = options.item_id;
        if (rawItemId) {
            // 按 id 直接打开(生成向导的 skipped 件、结果页跳转):get 单查不受 list 分页影响
            this.setData({ itemId: safeDecode(rawItemId) });
            void this.loadById(safeDecode(rawItemId));
            return;
        }
        const raw = options.data;
        let summary = null;
        if (raw) {
            try {
                const p = JSON.parse(safeDecode(raw));
                if (typeof p.item_id === "string" &&
                    typeof p.name === "string" &&
                    typeof p.location_text === "string" &&
                    typeof p.note === "string" &&
                    typeof p.version === "number" &&
                    typeof p.updated_at === "string") {
                    summary = {
                        item_id: p.item_id,
                        name: p.name,
                        location_text: p.location_text,
                        note: p.note,
                        version: p.version,
                        updated_at: p.updated_at,
                    };
                }
            }
            catch (e) {
                console.error("[item] 详情参数解析失败", e);
            }
        }
        if (!summary) {
            wx.showModal({
                title: "无法打开",
                content: "记录参数缺失或已失效,请返回重试。",
                showCancel: false,
                success: () => {
                    this.goBack();
                },
            });
            return;
        }
        this.applySummary(summary);
    },
    onShow() {
        // 家庭上下文可能切换(创建/加入/退出):「分享给家人」只在共享家庭显示
        this.setData({ familyShared: (0, household_scope_1.isHouseholdScopeShared)() });
        // 保质期行(#36):进页/回页时按服务端提醒刷新;加载失败静默不显示(增强露出)
        void this.refreshReminderRow();
    },
    onNameInput(e) {
        this.setData({ name: e.detail && e.detail.value ? e.detail.value : "" });
    },
    onLocationInput(e) {
        this.setData({
            locationText: e.detail && e.detail.value ? e.detail.value : "",
        });
    },
    onNoteInput(e) {
        this.setData({ note: e.detail && e.detail.value ? e.detail.value : "" });
    },
    /** 编辑折叠:常态只读,点开才出现表单;保存成功后自动收回 */
    onEditToggle() {
        this.setData({ editPanelOpen: !this.data.editPanelOpen });
    },
    applySummary(s) {
        this.original = {
            name: s.name,
            location: s.location_text,
            note: s.note,
        };
        // PR #48 复审 B2:updated_at 在名称/备注/位置任意修改时都会刷新,不能冒充
        // 「位置确认时间」——文案只如实说明记录更新时间
        const short = shortDate(s.updated_at);
        // vagueQuote(Fix 4)只在 get(详情)响应携带;update 等其余投影不带时
        // 保留现值——编辑内容不会动掉「当时提到时间」的留痕
        const vague = typeof s.remind_vague_quote === "string"
            ? s.remind_vague_quote || ""
            : this.data.vagueQuote;
        this.setData({
            itemId: s.item_id,
            name: s.name,
            locationText: s.location_text,
            note: s.note,
            version: s.version,
            updatedAtText: (0, api_1.formatDateTime)(s.updated_at),
            lastConfirmedText: short
                ? "记录更新于 " + short
                : s.updated_at
                    ? "记录更新于 " + (0, api_1.formatDateTime)(s.updated_at)
                    : "",
            vagueQuote: vague,
        });
    },
    /** 保存修改:itemsApi update,带 expected_version */
    async onSaveTap() {
        if (this.data.saving || this.data.deleting) {
            return;
        }
        const name = this.data.name.trim();
        const locationText = this.data.locationText.trim();
        const note = this.data.note.trim();
        if (!name) {
            wx.showToast({ title: "请填写物品名称", icon: "none" });
            return;
        }
        if (!locationText) {
            wx.showToast({ title: "位置为必填项,请填写位置", icon: "none" });
            return;
        }
        const changes = {};
        if (name !== this.original.name) {
            changes.name = name;
        }
        if (locationText !== this.original.location) {
            changes.location_text = locationText;
        }
        if (note !== this.original.note) {
            changes.note = note;
        }
        if (Object.keys(changes).length === 0) {
            wx.showToast({ title: "内容没有变化", icon: "none" });
            return;
        }
        // 同样内容的重试复用同一 update_id:服务端据此把「自己刚写入但响应丢失」的重放
        // 识别为 replayed 成功,而不是误报 VERSION_CONFLICT;内容一变即生成新 update_id。
        const retry = this.pendingRetry;
        const samePayload = retry !== null &&
            retry.changes.name === changes.name &&
            retry.changes.location_text === changes.location_text &&
            retry.changes.note === changes.note;
        const updateId = samePayload ? retry.updateId : (0, api_1.uuid)();
        this.setData({ saving: true });
        try {
            const res = await (0, api_1.callItemsApi)({
                action: "update",
                item_id: this.data.itemId,
                expected_version: this.data.version,
                update_id: updateId,
                ...changes,
            });
            this.pendingRetry = null;
            const it = res.item;
            this.applySummary({
                item_id: it.item_id,
                name: it.name,
                location_text: it.location_text,
                note: it.note,
                version: it.version,
                updated_at: it.updated_at,
            });
            // 保存成功:收回编辑,回到只读答案
            this.setData({ editPanelOpen: false });
            wx.showToast({ title: "已保存", icon: "success" });
        }
        catch (e) {
            // 记录失败的更新供重试复用 update_id(仅同样内容的重试)
            this.pendingRetry = { updateId, changes };
            if (e instanceof api_1.ApiError && e.code === "VERSION_CONFLICT") {
                // 提示后只对齐版本与元数据,保留用户未保存的编辑(绝不无提示覆盖)
                wx.showToast({
                    title: "内容已被修改,已更新版本号,请检查后重试",
                    icon: "none",
                    duration: 2500,
                });
                const result = await this.refreshLatest();
                if (result === "notfound") {
                    wx.showModal({
                        title: "记录不存在",
                        content: "没有找到这条记录,可能已被删除。",
                        showCancel: false,
                        success: () => {
                            this.goBack();
                        },
                    });
                }
            }
            else {
                wx.showModal({
                    title: "保存失败",
                    content: (0, api_1.errorMessage)(e),
                    showCancel: false,
                });
            }
        }
        finally {
            this.setData({ saving: false });
        }
    },
    /**
     * 拉取最新内容(get 按 id 单查,不受 list 分页截断影响)。
     * 只对齐版本号/更新时间/基准内容,不覆盖表单里用户未保存的编辑。
     */
    async refreshLatest() {
        try {
            const res = await (0, api_1.callItemsApi)({ action: "get", item_id: this.data.itemId });
            // 字段级三方合并:用户真正编辑过的字段(与刷新前基准不同)保留用户的未提交编辑;
            // 未编辑的字段采纳服务端最新值(可能来自另一设备),避免下次保存把别处的新改动连带覆盖。
            const prev = this.original;
            const mergedName = this.data.name.trim() !== prev.name ? this.data.name : res.item.name;
            const mergedLocation = this.data.locationText.trim() !== prev.location
                ? this.data.locationText
                : res.item.location_text;
            const mergedNote = this.data.note.trim() !== prev.note ? this.data.note : res.item.note;
            this.original = {
                name: res.item.name,
                location: res.item.location_text,
                note: res.item.note,
            };
            this.setData({
                name: mergedName,
                locationText: mergedLocation,
                note: mergedNote,
                version: res.item.version,
                updatedAtText: (0, api_1.formatDateTime)(res.item.updated_at),
            });
            return "refreshed";
        }
        catch (e) {
            wx.showModal({
                title: "刷新失败",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
            return "error";
        }
    },
    /* ---------------- 「⋯」次级菜单(编辑/整理/删除都收进这里) ---------------- */
    onMoreTap() {
        this.setData({ moreOpen: true });
    },
    onSheetClose() {
        this.setData({ moreOpen: false });
    },
    /**
     * 分享给家人(仅共享家庭显示):这里如实说明语义——共享家庭里这条记录
     * 本来就人人可见,没有单独分享这个动作,也不假装写入。
     */
    onShareTap() {
        this.setData({ moreOpen: false });
        wx.showModal({
            title: "分享给家人",
            content: "这条记录已经在「我们家」的共享记录里,家里每个人打开就能看到,不用再单独分享。",
            confirmText: "知道了",
            showCancel: false,
        });
    },
    /** 整理位置:收起菜单后走既有 parseLocation → 逐段核对 → ensurePath + linkItem */
    onTidyTap() {
        this.setData({ moreOpen: false });
        void this.onMountTap();
    },
    /** 删除:先收起菜单,再 wx.showModal 二次确认 */
    onDeleteTap() {
        this.setData({ moreOpen: false });
        if (this.data.saving || this.data.deleting) {
            return;
        }
        const name = this.data.name.trim() || "这条记录";
        wx.showModal({
            title: "确认删除",
            content: "删除「" + name + "」后无法恢复,确定删除吗?",
            confirmText: "删除",
            confirmColor: "#d93025",
            cancelText: "取消",
            success: (r) => {
                if (!r.confirm) {
                    return;
                }
                this.confirmDelete();
            },
        });
    },
    async confirmDelete() {
        this.setData({ deleting: true });
        try {
            await (0, api_1.callItemsApi)({ action: "delete", item_id: this.data.itemId });
            wx.showToast({ title: "已删除", icon: "success" });
            setTimeout(() => {
                this.goBack();
            }, 800);
        }
        catch (e) {
            wx.showModal({
                title: "删除失败",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
        }
        finally {
            this.setData({ deleting: false });
        }
    },
    goBack() {
        wx.navigateBack({
            fail: () => {
                wx.reLaunch({ url: "/pages/index/index" });
            },
        });
    },
    async loadById(id) {
        try {
            const res = await (0, api_1.callItemsApi)({ action: "get", item_id: id });
            this.applySummary(res.item);
        }
        catch (e) {
            wx.showModal({
                title: "无法打开",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
                success: () => {
                    this.goBack();
                },
            });
        }
    },
    /**
     * 整理位置:parseLocation 零写库出候选分段 → 用户逐段核对(可改)→
     * ensurePath + linkItem。AI 不可用时兜底为手动选位置(选择模式)。
     */
    async onMountTap() {
        if (this.data.saving || this.data.deleting || this.data.mounting) {
            return;
        }
        const text = this.data.locationText.trim();
        if (!text) {
            wx.showToast({ title: "这条记录还没有位置描述,先在编辑里补一句", icon: "none" });
            return;
        }
        this.setData({ mounting: true });
        try {
            const res = await (0, locations_api_1.callLocationsApi)({
                action: "parseLocation",
                text,
            });
            const parse = res.parse;
            const hints = new Map();
            for (const s of parse.merge_suggestions) {
                if (!hints.has(s.segment_index)) {
                    hints.set(s.segment_index, s.existing_name);
                }
            }
            this.setData({
                mountPanelOpen: true,
                mountNeedConfirm: parse.need_confirm,
                mountOrderViolation: parse.order_violation,
                mountSegments: parse.segments.map((seg, i) => ({
                    idx: i,
                    name: seg.name,
                    confidenceText: Math.round(seg.confidence * 100) + "%",
                    needConfirm: seg.confidence < 0.8,
                    hintName: hints.get(i) || "",
                })),
            });
        }
        catch (e) {
            if ((0, locations_api_1.isLocationsApiErrorWithCode)(e, "AI_UNAVAILABLE")) {
                wx.showModal({
                    title: "AI 暂时不可用",
                    content: "解析不了这句位置,要改为手动选一个已有位置吗?",
                    confirmText: "手动选位置",
                    cancelText: "取消",
                    success: (r) => {
                        if (r.confirm) {
                            this.openLocationPicker();
                        }
                    },
                });
                return;
            }
            wx.showModal({
                title: "解析失败",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
        }
        finally {
            this.setData({ mounting: false });
        }
    },
    onMountSegmentInput(e) {
        const index = Number(e.currentTarget.dataset.index);
        const value = e.detail && e.detail.value ? e.detail.value : "";
        const rows = this.data.mountSegments.slice();
        if (!rows[index]) {
            return;
        }
        rows[index] = { ...rows[index], name: value };
        this.setData({ mountSegments: rows });
    },
    /** AI 不可用的手动兜底:进 locations 选择模式,选中后直接 linkItem */
    openLocationPicker() {
        wx.navigateTo({
            url: "/pages/locations/locations?picker=1&title=" +
                encodeURIComponent("把「" + (this.data.name || "这件物品") + "」放到哪个位置…"),
            events: {
                pickNode: (d) => {
                    void this.doLinkToNode(d.location_id, d.path);
                    // 退栈统一由发起页计算(选择器页自身不再逐层退,#29 后续):
                    // 选择器页只叠在本页正上方,一次退掉全部。
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
    async doLinkToNode(nodeId, path) {
        this.setData({ mountSaving: true });
        try {
            const res = await (0, locations_api_1.callLocationsApi)({
                action: "linkItem",
                item_id: this.data.itemId,
                node_id: nodeId,
                expected_version: this.data.version,
                update_id: (0, api_1.uuid)(),
            });
            this.setData({
                version: res.item.version,
                updatedAtText: (0, api_1.formatDateTime)(res.item.updated_at),
                // 刚亲手选定的位置:大卡如实跟进(选择器回传的展示用路径)
                spacePath: Array.isArray(path) ? path : this.data.spacePath,
            });
            wx.showToast({ title: "已记到这个位置", icon: "success" });
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "VERSION_CONFLICT") {
                wx.showToast({
                    title: "内容已被修改,已更新版本号,请重试",
                    icon: "none",
                    duration: 2500,
                });
                await this.refreshLatest();
            }
            else {
                wx.showModal({
                    title: "整理失败",
                    content: (0, api_1.errorMessage)(e),
                    showCancel: false,
                });
            }
        }
        finally {
            this.setData({ mountSaving: false });
        }
    },
    /** 确认候选分段:ensurePath(用户确认后的唯一建节点入口)→ linkItem(版本条件更新) */
    async confirmMount() {
        if (this.data.mountSaving) {
            return;
        }
        const names = this.data.mountSegments
            .map((s) => s.name.trim())
            .filter((n) => n.length > 0);
        if (names.length === 0) {
            wx.showToast({ title: "至少填一段位置", icon: "none" });
            return;
        }
        this.setData({ mountSaving: true });
        try {
            const ensured = await (0, locations_api_1.callLocationsApi)({
                action: "ensurePath",
                path: names,
                created_from: "parse",
            });
            const target = ensured.nodes[ensured.nodes.length - 1];
            if (!target) {
                throw new Error("服务返回异常");
            }
            const res = await (0, locations_api_1.callLocationsApi)({
                action: "linkItem",
                item_id: this.data.itemId,
                node_id: target.location_id,
                expected_version: this.data.version,
                update_id: (0, api_1.uuid)(),
            });
            this.setData({
                version: res.item.version,
                updatedAtText: (0, api_1.formatDateTime)(res.item.updated_at),
                mountPanelOpen: false,
                // 刚确认并记入的位置分段:大卡如实跟进(与 ensurePath 收到的完全一致)
                spacePath: names,
            });
            wx.showToast({ title: "已记到这个位置", icon: "success" });
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "VERSION_CONFLICT") {
                // 物品被并发修改:走既有刷新逻辑对齐版本(保留未保存编辑),由用户检查后重试
                wx.showToast({
                    title: "内容已被修改,已更新版本号,请重试",
                    icon: "none",
                    duration: 2500,
                });
                const result = await this.refreshLatest();
                if (result === "notfound") {
                    wx.showModal({
                        title: "记录不存在",
                        content: "没有找到这条记录,可能已被删除。",
                        showCancel: false,
                        success: () => {
                            this.goBack();
                        },
                    });
                }
            }
            else {
                wx.showModal({
                    title: "整理失败",
                    content: (0, api_1.errorMessage)(e),
                    showCancel: false,
                });
            }
        }
        finally {
            this.setData({ mountSaving: false });
        }
    },
    cancelMount() {
        this.setData({ mountPanelOpen: false, mountSegments: [] });
    },
    /* ---------------- 提醒的查看与处理(#36 三阶段) ---------------- */
    /**
     * 拉当前家庭 active 提醒,取这件的那一行上屏。展示前先清旧行并经
     * households 资格复核(硬门 C,口径同 R1/首页);家庭切换(作用域代
     * 数变化)后旧家庭响应不上屏。加载失败
     * 静默隐藏保质期行(增强露出,不影响详情主体)。
     */
    async refreshReminderRow() {
        // 先收起旧保质期行:被移除/切换家庭后冷启动,展示前不得残留旧家庭提醒
        this.setData({ expire: null, remindAt: "", remindGeneration: -1 });
        await (0, households_api_1.ensureScopeVerified)();
        // 复核可能揭示家庭漂移并递增代数:请求前重新捕获,响应后才校验
        const scopeGen = (0, household_scope_1.captureScopeGeneration)();
        try {
            const res = await (0, api_1.callItemsApi)({ action: "remindList" });
            if (!(0, household_scope_1.isScopeGenerationCurrent)(scopeGen)) {
                // 在途期间家庭已切换(含响应揭示的漂移):旧家庭的保质期行立即收起,
                // 不显示旧家庭数据;下次 onShow 会按新作用域重拉
                this.setData({ expire: null, remindAt: "", remindGeneration: -1 });
                return;
            }
            this.applyReminderRow(res.reminders.find((r) => r.item_id === this.data.itemId) || null);
        }
        catch (e) {
            // 静默:不显示保质期行,详情页其余内容照常
        }
    },
    applyReminderRow(row) {
        if (row === null) {
            // 已确认这件当前无提醒:轮次号记 0(补录语义的 expected_generation)
            this.setData({ expire: null, remindAt: "", remindGeneration: 0 });
            return;
        }
        this.setData({
            expire: {
                mainText: (0, remind_ui_1.expireMainText)(row.due_date),
                dueDate: row.due_date,
                kind: row.kind,
            },
            remindAt: row.due_date,
            remindGeneration: typeof row.generation === "number" ? row.generation : -1,
        });
    },
    /** 保质期行「已处理」:二次确认后 remindComplete(不带 period_days;下次提醒到详情里自己选日子) **/
    async onExpireDoneTap() {
        if (this.data.remindBusy) {
            return;
        }
        const expire = this.data.expire;
        if (!expire) {
            return;
        }
        const confirmed = await (0, remind_ui_1.askUseUp)(this.data.name);
        if (!confirmed) {
            return; // 用户取消:不动、不写
        }
        this.setData({ remindBusy: true });
        try {
            await (0, api_1.callItemsApi)({
                action: "remindComplete",
                item_id: this.data.itemId,
                ...(this.data.remindGeneration >= 1
                    ? { expected_generation: this.data.remindGeneration }
                    : {}),
                // 完成日按用户本地自然日随请求携带(PR #52 Low-3):服务端不靠运行时区猜
                complete_date: (0, remind_ui_1.localTodayYmd)(),
            });
            this.setData({ expire: null, remindAt: "", remindGeneration: 0 });
            // 完成后不弹固定周期选项(#36 真机反馈 Fix 2):下次提醒时间由用户到详情里选日子
            wx.showToast({
                title: "已处理。要下次提醒,到详情里选日子",
                icon: "none",
                duration: 2500,
            });
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "VERSION_CONFLICT") {
                if (e.cleared === true) {
                    // PR #52 R3-1:完成置 done 后、认领前提醒被家人清除——本轮已完成,
                    // 服务端清除栅栏挡住了再生:如实告知,不再生成下一轮
                    wx.showToast({ title: "已处理;提醒已被清除,不再生成下次", icon: "none", duration: 2500 });
                    await this.refreshReminderRow();
                    return;
                }
                if (e.superseded === true) {
                    // PR #52 R4-1:完成置 done 后、认领前提醒被家人重新设置——再生认领
                    // 绑定原完成轮次被原子拒绝:如实告知本轮不再生成,新提醒原样保留
                    wx.showToast({ title: "已处理;提醒刚被重新设置,不再生成下次", icon: "none", duration: 2500 });
                    await this.refreshReminderRow();
                    return;
                }
                // 这轮已被家人处理并换了新提醒(PR #52 B1):刷新看最新,绝不误伤
                wx.showToast({ title: "这条刚被家人处理过,已刷新", icon: "none" });
                await this.refreshReminderRow();
                return;
            }
            wx.showModal({
                title: "没办成",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
        }
        finally {
            this.setData({ remindBusy: false });
        }
    },
    /**
     * 编辑折叠「提醒」选日子(#36:picker mode=date 弹层,唯一手动日期来源):
     * 没有提醒的物品在这里补录,有提醒的在这里改期——都走 remindSet,把提醒
     * 设为所选的日子(服务端替换该物品的提醒,不堆积)。picker 回填必为合法
     * YYYY-MM-DD,异常值不写;校验与 picker 范围两端一致——今天可设(到期分组
     * 本就有「今天到期」),过去的日子与超 10 年的拒绝(PR #52 Low-3,按用户
     * 本地自然日判定)。请求携带页面所见轮次号(PR #52 B1):这一轮已被家人
     * 换过 → VERSION_CONFLICT,刷新后重选,绝不静默覆盖别人的新提醒
     * (0=页面确认无提醒的补录)。
     */
    async onRemindDateChange(e) {
        if (this.data.remindBusy) {
            return;
        }
        const value = e.detail && typeof e.detail.value === "string" ? e.detail.value : "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return; // picker 形状异常:不写
        }
        if (value === this.data.remindAt) {
            return; // 没变
        }
        const problem = (0, remind_ui_1.pickerDateProblem)(value);
        if (problem !== "") {
            wx.showToast({ title: problem, icon: "none" });
            return;
        }
        const hadReminder = this.data.remindAt !== "";
        this.setData({ remindBusy: true });
        try {
            const res = await (0, api_1.callItemsApi)({
                action: "remindSet",
                item_id: this.data.itemId,
                due_date: value,
                ...(this.data.remindGeneration >= 0
                    ? { expected_generation: this.data.remindGeneration }
                    : {}),
            });
            if (res.reminder) {
                this.applyReminderRow(res.reminder);
                wx.showToast({
                    title: hadReminder
                        ? "提醒已改到 " + (0, remind_ui_1.monthDayText)(res.reminder.due_date)
                        : "已带上提醒:" + (0, remind_ui_1.monthDayText)(res.reminder.due_date) + " 到期",
                    icon: "none",
                });
            }
            else {
                // 不应发生(remindSet 必回所设行):回查一次,如实收敛
                await this.refreshReminderRow();
            }
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "VERSION_CONFLICT") {
                wx.showToast({
                    title: hadReminder ? "这条提醒刚被家人改过,已刷新" : "这条刚带上提醒,已刷新",
                    icon: "none",
                    duration: 2500,
                });
                await this.refreshReminderRow();
                return;
            }
            wx.showModal({
                title: hadReminder ? "提醒没改成" : "提醒没带上",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
        }
        finally {
            this.setData({ remindBusy: false });
        }
    },
    /** 编辑折叠「提醒」✕:连日期一起清除(remindClear,带所见轮次号);日期唯一作用就是出现在「快到期」,没有「存日期但不提醒」 */
    async onRemindFieldClear() {
        if (this.data.remindBusy || !this.data.remindAt) {
            return;
        }
        this.setData({ remindBusy: true });
        try {
            await (0, api_1.callItemsApi)({
                action: "remindClear",
                item_id: this.data.itemId,
                ...(this.data.remindGeneration >= 1
                    ? { expected_generation: this.data.remindGeneration }
                    : {}),
            });
            this.setData({ expire: null, remindAt: "", remindGeneration: 0 });
            wx.showToast({ title: "已不带提醒", icon: "none" });
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "VERSION_CONFLICT") {
                // 这一轮已被家人处理过:刷新看最新,绝不静默删掉别人的新提醒
                wx.showToast({ title: "这条提醒刚被家人改过,已刷新", icon: "none", duration: 2500 });
                await this.refreshReminderRow();
                return;
            }
            wx.showModal({
                title: "没改成",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
        }
        finally {
            this.setData({ remindBusy: false });
        }
    },
    noop() { },
});
