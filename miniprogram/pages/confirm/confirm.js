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
        headTitle: "",
        headSub: "",
        quoteOpen: false,
        editingName: false,
        editingLocation: false,
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
            // 默认勾选决策下沉 utils:位置确定且有专属证据、锚定不共享才默认勾;
            // 位置没听清的(certain=false)一律不默认勾(B3),补充位置后由用户明确勾选;
            // 其余(无证据/整句共享)人工核对后手动勾
            checked: (0, batch_save_1.shouldDefaultChecked)(d.source_quote, d.anchor_shared === true, d.certain === true),
            status: "pending",
            failMsg: "",
            operationId: (0, api_1.uuid)(),
            certain: d.certain,
            qualifiersText: d.qualifiers.join("、"),
            sourceQuote: d.source_quote,
            anchorShared: d.anchor_shared === true,
        }));
        // 恢复上次未完成的行状态:沿用原 operation_id(幂等恢复,不重复建档),
        // 已保存行保持 saved 不再提交
        if (payload.rows && payload.rows.length === rows.length) {
            payload.rows.forEach((saved, i) => {
                rows[i] = {
                    ...rows[i],
                    name: saved.name,
                    locationText: saved.locationText,
                    checked: saved.checked,
                    status: saved.status,
                    failMsg: saved.failMsg,
                    operationId: saved.operationId,
                };
            });
        }
        // 原话默认折叠;但任一行含警示(来源不充分/两件东西)时必须初始展开——
        // 折叠只收起原话全文,行级警示文案常驻在行上,绝不藏
        const quoteOpen = rows.some((r) => r.anchorShared || r.sourceQuote === "");
        // 标题文案(用户词汇):单件核对 / 单件补位置 / 多件清点
        const single = rows.length === 1;
        const uncertainSingle = single && !rows[0].certain;
        this.setData({
            isManual: false,
            originalText: payload.originalText,
            truncated: payload.truncated,
            rows,
            checkedCount: (0, batch_save_1.batchSummary)(rows).checked,
            headTitle: single
                ? uncertainSingle
                    ? "我听到了,但有件事要补一下"
                    : "我听到了,核对一下"
                : "识别出 " + rows.length + " 件东西",
            headSub: single
                ? uncertainSingle
                    ? "位置没听清,补一句就行。"
                    : "看一眼,没问题就确认。"
                : "逐件核对,勾选要记住的。",
            quoteOpen,
        });
    },
    /** 行状态序列化回写会话(供进程回收后恢复原幂等键与已保存状态) */
    persistRows() {
        if (this.sid === "") {
            return;
        }
        const rows = this.data.rows.map((r) => ({
            key: r.key,
            name: r.name,
            locationText: r.locationText,
            checked: r.checked,
            status: r.status,
            failMsg: r.failMsg,
            operationId: r.operationId,
        }));
        (0, draft_session_1.updateDraftSessionRows)(this.sid, rows);
    },
    onUnload() {
        if (this.sid === "") {
            return;
        }
        // 中途退出且仍有结果未知的勾选行:保留会话供首页「继续核对」恢复(原键原状态,
        // 已保存行不再提交);全部完成或已无勾选 = 干净离场,即清。
        const summary = (0, batch_save_1.batchSummary)(this.data.rows);
        if (summary.checked === summary.saved) {
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
        if (this.data.batchSaving) {
            return; // 整批提交中冻结输入:本轮写入的就是本轮开始时看到的
        }
        const index = Number(e.currentTarget.dataset.index);
        this.setData({
            ["rows[" + index + "].name"]: e.detail && e.detail.value ? e.detail.value : "",
        });
    },
    onRowLocationInput(e) {
        if (this.data.batchSaving) {
            return; // 整批提交中冻结输入
        }
        const index = Number(e.currentTarget.dataset.index);
        const value = e.detail && e.detail.value ? e.detail.value : "";
        const row = this.data.rows[index];
        if (!row) {
            return;
        }
        // 单件且「位置没听清」(C1b):补上位置才放行、清空回到禁用——
        // 只联动勾选态,保存仍走同一 onSaveBatchTap 合同(必填校验/幂等键均不变)
        if (this.data.rows.length === 1 && !row.certain && row.status === "pending") {
            const filled = value.trim() !== "";
            if (filled !== row.checked) {
                const rows = this.data.rows.slice();
                rows[index] = { ...row, locationText: value, checked: filled };
                this.setData({
                    ["rows[" + index + "].locationText"]: value,
                    ["rows[" + index + "].checked"]: filled,
                    checkedCount: (0, batch_save_1.batchSummary)(rows).checked,
                });
                return;
            }
        }
        this.setData({ ["rows[" + index + "].locationText"]: value });
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
    /** 原话折叠/展开(默认折叠;含警示场景 onLoad 已初始展开) */
    onToggleQuote() {
        this.setData({ quoteOpen: !this.data.quoteOpen });
    },
    /** 单件摘要卡「改」:切换该字段的行内编辑 */
    onToggleEdit(e) {
        const field = e.currentTarget.dataset.field;
        if (field === "name") {
            this.setData({ editingName: !this.data.editingName });
            return;
        }
        if (field === "location") {
            this.setData({ editingLocation: !this.data.editingLocation });
        }
    },
    /**
     * 批量保存:提交瞬间对整页行做不可变快照,快照里的名称/位置/幂等键即本轮写入内容
     * (UI 冻结之外的第二道防线);逐行 create 由 runBatchSave 编排,行内固定
     * operation_id,失败行重试沿用原键。「一次确认」不是数据库原子事务——逐行如实反馈。
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
        const snapshot = this.data.rows.map((r) => ({ ...r }));
        if ((0, batch_save_1.batchSummary)(snapshot).checked === 0) {
            wx.showToast({ title: "没有要保存的物品", icon: "none" });
            return;
        }
        this.setData({ batchSaving: true });
        const finalRows = await (0, batch_save_1.runBatchSave)(snapshot, (row) => (0, api_1.callItemsApi)({
            action: "create",
            operation_id: row.operationId,
            name: row.name.trim(),
            location_text: row.locationText.trim(),
        }).then(() => undefined), (row, error) => {
            const index = this.data.rows.findIndex((r) => r.key === row.key);
            if (index === -1) {
                return;
            }
            const patch = {
                ["rows[" + index + "].status"]: row.status,
                ["rows[" + index + "].failMsg"]: row.failMsg,
            };
            if (error instanceof api_1.ApiError &&
                error.code === "OPERATION_CONFLICT" &&
                error.existing &&
                error.existing.item_id) {
                patch["rows[" + index + "].failMsg"] = "这条已保存过且内容不同,请到详情页修改";
                patch["rows[" + index + "].existing"] = error.existing;
                patch["rows[" + index + "].itemId"] = error.existing.item_id;
            }
            this.setData(patch);
            this.persistRows();
        });
        this.setData({ batchSaving: false });
        const summary = (0, batch_save_1.batchSummary)(finalRows);
        if ((0, batch_save_1.allCheckedSaved)(finalRows)) {
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
