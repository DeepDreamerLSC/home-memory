"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
/** 页面 query 参数不会自动解码;容错解码(已解码或含非法 % 时原样返回) */
function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    }
    catch {
        return s;
    }
}
Page({
    data: {
        isManual: false,
        certain: true,
        qualifiersText: "",
        name: "",
        locationText: "",
        note: "",
        saving: false,
        operationId: "",
    },
    onLoad(options) {
        const operationId = (0, api_1.uuid)();
        if (options.manual === "true") {
            this.setData({ operationId, isManual: true });
            return;
        }
        const raw = options.draft;
        if (raw) {
            try {
                const parsed = JSON.parse(safeDecode(raw));
                const name = typeof parsed.name === "string" ? parsed.name : "";
                const locationText = typeof parsed.location_text === "string" ? parsed.location_text : "";
                const certain = parsed.certain === true;
                const qualifiers = Array.isArray(parsed.qualifiers)
                    ? parsed.qualifiers
                        .filter((q) => typeof q === "string")
                        .slice(0, 5)
                    : [];
                this.setData({
                    operationId,
                    isManual: false,
                    certain,
                    qualifiersText: qualifiers.join("、"),
                    name,
                    locationText,
                    note: "",
                });
                return;
            }
            catch (e) {
                console.error("[confirm] 草稿解析失败", e);
                wx.showToast({
                    title: "草稿加载失败,请手动填写",
                    icon: "none",
                    duration: 2500,
                });
            }
        }
        this.setData({ operationId, isManual: true });
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
    /** 保存:itemsApi create,成功 toast「已记住」返回首页 */
    async onSaveTap() {
        if (this.data.saving) {
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
        this.setData({ saving: true });
        try {
            await (0, api_1.callItemsApi)({
                action: "create",
                operation_id: this.data.operationId,
                name,
                location_text: locationText,
                note,
            });
            wx.showToast({ title: "记住了,下次问我。", icon: "success" });
            setTimeout(() => {
                this.backToHome();
            }, 800);
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "OPERATION_CONFLICT") {
                // 同 operation_id 已保存过且内容与当前填写不同(响应丢失后修改重试的典型场景):
                // 绝不静默;给出可操作引导——跳到已保存版本的详情页再改。
                const existing = e.existing;
                if (existing && existing.item_id) {
                    wx.showModal({
                        title: "这条已保存过",
                        content: "之前已保存过一次,内容与当前填写不同。可到详情页基于已保存的版本修改。",
                        confirmText: "去详情页",
                        cancelText: "留在本页",
                        success: (r) => {
                            if (r.confirm) {
                                wx.navigateTo({
                                    url: "/pages/item/item?data=" + encodeURIComponent(JSON.stringify(existing)),
                                });
                            }
                        },
                    });
                }
                else {
                    wx.showModal({
                        title: "保存失败",
                        content: e.message,
                        showCancel: false,
                    });
                }
                return;
            }
            wx.showModal({
                title: "保存失败",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
        }
        finally {
            this.setData({ saving: false });
        }
    },
    backToHome() {
        wx.navigateBack({
            fail: () => {
                wx.reLaunch({ url: "/pages/index/index" });
            },
        });
    },
});
