"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
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
    },
    onShow() {
        this.loadRecent();
    },
    onMemoInput(e) {
        this.setData({ memoText: e.detail && e.detail.value ? e.detail.value : "" });
    },
    onQueryInput(e) {
        this.setData({ queryText: e.detail && e.detail.value ? e.detail.value : "" });
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
