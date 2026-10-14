"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const locations_api_1 = require("../../utils/locations-api");
const household_scope_1 = require("../../utils/household-scope");
/** 页面 query 参数不会自动解码;容错解码(已解码或含非法 % 时原样返回) */
function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    }
    catch {
        return s;
    }
}
/** 确认日期短文案(如 10-08,与首页一致);非法时间如实返回空串 */
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
        const short = shortDate(s.updated_at);
        this.setData({
            itemId: s.item_id,
            name: s.name,
            locationText: s.location_text,
            note: s.note,
            version: s.version,
            updatedAtText: (0, api_1.formatDateTime)(s.updated_at),
            lastConfirmedText: short
                ? "上次确认 " + short
                : s.updated_at
                    ? "更新于 " + (0, api_1.formatDateTime)(s.updated_at)
                    : "",
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
    noop() { },
});
