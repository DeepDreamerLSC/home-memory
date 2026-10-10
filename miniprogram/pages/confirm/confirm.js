"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const batch_save_1 = require("../../utils/batch-save");
const draft_session_1 = require("../../utils/draft-session");
Page({
    data: {
        isManual: false,
        name: "",
        locationText: "",
        note: "",
        saving: false,
        operationId: "",
        originalText: "",
        truncated: false,
        rows: [],
        batchSaving: false,
        checkedCount: 0,
    },
    /** 草稿会话 id(onUnload 清理用) */
    sid: "",
    onLoad(options) {
        if (options.manual === "true") {
            this.setData({ isManual: true, operationId: (0, api_1.uuid)() });
            return;
        }
        const sid = options.sid;
        if (!sid) {
            this.setData({ isManual: true, operationId: (0, api_1.uuid)() });
            return;
        }
        const payload = (0, draft_session_1.getDraftSession)(sid);
        if (payload === null) {
            // 会话过期/进程回收:如实提示并回首页重新提取,绝不编造空草稿
            wx.showToast({ title: "草稿已过期,请重新提取", icon: "none", duration: 2000 });
            setTimeout(() => {
                wx.reLaunch({ url: "/pages/index/index" });
            }, 800);
            return;
        }
        this.sid = sid;
        const rows = payload.drafts.map((d, i) => ({
            key: "row-" + i,
            name: d.name,
            locationText: d.location_text,
            // 无原话证据的候选默认不勾选:先经用户核对,再勾上保存
            checked: d.source_quote !== "",
            status: "pending",
            failMsg: "",
            operationId: (0, api_1.uuid)(),
            certain: d.certain,
            qualifiersText: d.qualifiers.join("、"),
            sourceQuote: d.source_quote,
        }));
        this.setData({
            isManual: false,
            originalText: payload.originalText,
            truncated: payload.truncated,
            rows,
            checkedCount: (0, batch_save_1.batchSummary)(rows).checked,
        });
    },
    onUnload() {
        if (this.sid !== "") {
            (0, draft_session_1.clearDraftSession)(this.sid);
        }
    },
    // ---------- 手动单表单(旧路径) ----------
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
    // ---------- 批量列表(Issue #14) ----------
    onRowNameInput(e) {
        const index = Number(e.currentTarget.dataset.index);
        this.setData({
            ["rows[" + index + "].name"]: e.detail && e.detail.value ? e.detail.value : "",
        });
    },
    onRowLocationInput(e) {
        const index = Number(e.currentTarget.dataset.index);
        this.setData({
            ["rows[" + index + "].locationText"]: e.detail && e.detail.value ? e.detail.value : "",
        });
    },
    onRowToggle(e) {
        const index = Number(e.currentTarget.dataset.index);
        const row = this.data.rows[index];
        // 整批提交中冻结全部勾选状态:本轮开始时的选择即本轮写入的选择
        if (this.data.batchSaving) {
            return;
        }
        if (!row || row.status === "saving" || row.status === "saved") {
            return; // 已保存的行不可取消(事实已入库)
        }
        const rows = this.data.rows.slice();
        rows[index] = { ...row, checked: !row.checked };
        this.setData({ ["rows[" + index + "].checked"]: !row.checked, checkedCount: (0, batch_save_1.batchSummary)(rows).checked });
    },
    onRowDetail(e) {
        const index = Number(e.currentTarget.dataset.index);
        const row = this.data.rows[index];
        if (!row || !row.itemId) {
            return;
        }
        wx.navigateTo({
            url: "/pages/item/item?data=" + encodeURIComponent(JSON.stringify(row.existing)),
        });
    },
    /**
     * 批量保存:逐行 create(行内固定 operation_id,重试沿用同键同内容走幂等);
     * 「一次确认」不是数据库原子事务——逐行如实反馈,失败行可重试,已保存行不再提交。
     */
    async onSaveBatchTap() {
        if (this.data.batchSaving) {
            return;
        }
        const invalid = (0, batch_save_1.firstInvalidMsg)(this.data.rows);
        if (invalid !== "") {
            wx.showToast({ title: invalid, icon: "none" });
            return;
        }
        const todo = (0, batch_save_1.rowsToSave)(this.data.rows);
        if (todo.length === 0) {
            wx.showToast({ title: "没有要保存的物品", icon: "none" });
            return;
        }
        this.setData({ batchSaving: true });
        for (const row of todo) {
            const index = this.data.rows.findIndex((r) => r.key === row.key);
            if (index === -1)
                continue;
            this.setData({ ["rows[" + index + "].status"]: "saving", ["rows[" + index + "].failMsg"]: "" });
            try {
                await (0, api_1.callItemsApi)({
                    action: "create",
                    operation_id: row.operationId,
                    name: row.name.trim(),
                    location_text: row.locationText.trim(),
                });
                this.setData({ ["rows[" + index + "].status"]: "saved" });
            }
            catch (e) {
                // 部分失败:只标当前行,其余行继续;绝不整批回滚或静默
                let failMsg = (0, api_1.errorMessage)(e);
                if (e instanceof api_1.ApiError && e.code === "OPERATION_CONFLICT") {
                    failMsg = "这条已保存过且内容不同,请到详情页修改";
                    const existing = e.existing;
                    if (existing && existing.item_id) {
                        this.setData({
                            ["rows[" + index + "].existing"]: existing,
                            ["rows[" + index + "].itemId"]: existing.item_id,
                        });
                    }
                }
                this.setData({
                    ["rows[" + index + "].status"]: "failed",
                    ["rows[" + index + "].failMsg"]: failMsg,
                });
            }
        }
        this.setData({ batchSaving: false });
        const summary = (0, batch_save_1.batchSummary)(this.data.rows);
        if ((0, batch_save_1.allCheckedSaved)(this.data.rows)) {
            wx.showToast({ title: "记住了,下次问我。", icon: "success" });
            setTimeout(() => {
                this.backToHome();
            }, 800);
            return;
        }
        wx.showToast({
            title: "已保存 " + summary.saved + " 件," + summary.failed + " 件失败可重试",
            icon: "none",
            duration: 2500,
        });
    },
    backToHome() {
        wx.navigateBack({
            fail: () => {
                wx.reLaunch({ url: "/pages/index/index" });
            },
        });
    },
});
