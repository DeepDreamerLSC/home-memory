"use strict";
/**
 * 语音数量确认页(issue #102 Q2 / Q0-CONTRACT §7.8 客户端确认流):
 * 语音/文字入口经词表路由 + quantityIntentParse 提议后跳入本页。
 * - 目标必须用户点选(词表未唯一命中/needs_pick 时不默认选中,PR #103 决定 5);
 * - 确认视图展示「原话(切换模式仍保留,决定 4)、目标位置、原数量 → 变化 →
 *   结果、单位」,任何写入前可取消(取消 = 丢弃,零写入);
 * - 失败关闭:单位与目标不符禁止确认(UNIT_MISMATCH 客户端预拦)、未确认行
 *   增减禁止(QUANTITY_UNCONFIRMED 预拦,先到详情页核对)、库存不足/超上限
 *   预拦(服务端同口径硬门兜底);
 * - 提交 quantityAdjust:update_id(uuid)+expected_version(候选读到的 version,
 *   绝不页面自造);VERSION_CONFLICT 先用响应 current 展示家人最新值,用户
 *   显式重核对(默认「设为当前总数」、金额清空——绝不自动套旧 delta)后才
 *   以新 update_id+新版本再发;服务端已应答的确定性零写拒绝(NOT_FOUND/
 *   FAMILY_SWITCHED 等 §7.7 矩阵)按服务端文案 toast,不进重试;仅响应丢失
 *   (网络失败/超时/响应损坏)保留原 payload,重试复用同一
 *   update_id+expected_version+payload(服务端三重识别重放,最多生效一次),
 *   绝不盲目再扣减。
 */
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const quantity_1 = require("../../utils/quantity");
const voice_quantity_1 = require("../../utils/voice-quantity");
/** 展示模式顺序:增加 / 减少 / 设为(与 quantityAdjust mode 一一对应) */
const MODES = ["add", "subtract", "set"];
const MODE_LABELS = ["增加", "减少", "设为当前总数"];
/** 冲突重核对/结果不明后的服务端兜底 reason 文案(Q0-CONTRACT §6 枚举) */
const REASON_MESSAGES = {
    QUANTITY_BELOW_ZERO: "数量不足,不能减到负数",
    QUANTITY_OVER_MAX: "超过 9999 上限",
    QUANTITY_UNCONFIRMED: "这条还没核对过数量,请先到详情页核对",
    UNIT_REQUIRED: "请选择单位后再确认",
    UNIT_MISMATCH: "单位与这条记录不一致,请分别核对",
    QUANTITY_OUT_OF_RANGE: "数量需为 0-9999 的整数",
    QUANTITY_NOT_INTEGER: "数量需为整数",
    UNIT_UNSUPPORTED: "单位不适用,请到详情页修改",
    PARAM_SHAPE: "参数不合法,请重试",
};
Page({
    data: {
        phase: "pick",
        text: "",
        quote: "",
        itemQuery: "",
        modeIndex: 0,
        modeOptions: MODE_LABELS.slice(),
        amountText: "",
        unit: null,
        unitPickVisible: false,
        unitIndex: 0,
        unitOptions: quantity_1.UNIT_SET.slice(),
        candidates: [],
        selectedIdx: -1,
        targetName: "",
        targetLocation: "",
        currentLabel: "待核对",
        targetConfirmed: false,
        previewLabel: "",
        blockReason: "",
        conflictLabel: "",
        saving: false,
    },
    payload: null,
    target: null,
    conflictRefresh: null,
    pendingRetry: null,
    onLoad() {
        const payload = (0, voice_quantity_1.takeQuantityConfirm)();
        if (payload === null) {
            // 直达/已被消费:没有可确认的提议,如实提示并退页(零写入)
            wx.showToast({ title: "操作已过期,请再说一次", icon: "none", duration: 2000 });
            wx.navigateBack();
            return;
        }
        this.payload = payload;
        this.setData({
            text: payload.text,
            quote: payload.proposal.sourceQuote !== "" ? payload.proposal.sourceQuote : payload.text,
            itemQuery: payload.proposal.itemQuery,
            candidates: payload.candidates.map((c) => ({
                item_id: c.item_id,
                name: c.name,
                locationText: c.location_text !== "" ? c.location_text : "未归位",
                quantityText: (0, voice_quantity_1.candidateQuantityText)(c.quantity, c.unit),
            })),
            selectedIdx: -1,
        });
        const matchIndex = payload.proposal.matchIndex;
        if (payload.proposal.needsPick !== true &&
            matchIndex !== null &&
            matchIndex >= 0 &&
            matchIndex < payload.candidates.length) {
            // 服务端已唯一锁定候选(名称唯一命中且模型未编造):直接进确认视图,
            // 用户仍可取消;其余一律点选
            this.enterConfirm(payload.candidates[matchIndex]);
            return;
        }
        this.setData({ phase: "pick" });
    },
    onCandidateTap(e) {
        if (this.payload === null) {
            return;
        }
        const idx = Number(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.index : -1);
        const candidates = this.payload.candidates;
        if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
            return;
        }
        this.setData({ selectedIdx: idx });
        this.enterConfirm(candidates[idx]);
    },
    /** 切换增/减/设为模式:原话保留供核对(P #103 决定 4),预览与拦截重算 */
    onModeTap(e) {
        const idx = Number(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.index : -1);
        if (idx < 0 || idx >= MODES.length || this.data.phase !== "confirm") {
            return;
        }
        this.setData({ modeIndex: idx });
        this.refreshConfirmView();
    },
    onAmountInput(e) {
        this.setData({ amountText: e && e.detail && e.detail.value ? e.detail.value : "" });
        this.refreshConfirmView();
    },
    onUnitChange(e) {
        if (this.data.phase !== "confirm") {
            return;
        }
        const idx = Number(e && e.detail ? e.detail.value : 0);
        const unit = Number.isInteger(idx) && idx >= 0 && idx < quantity_1.UNIT_SET.length ? quantity_1.UNIT_SET[idx] : null;
        if (unit === null) {
            return;
        }
        this.setData({ unitIndex: idx, unit });
        this.refreshConfirmView();
    },
    async onConfirmTap() {
        if (this.data.saving || this.payload === null || this.target === null) {
            return;
        }
        if (this.data.blockReason !== "") {
            wx.showToast({ title: this.data.blockReason, icon: "none", duration: 2500 });
            return;
        }
        const mode = MODES[this.data.modeIndex];
        const parsed = (0, quantity_1.parseQuantityText)(this.data.amountText, mode === "set" ? 0 : 1);
        if (parsed === null || parsed === "INVALID") {
            return;
        }
        const target = this.target;
        const targetConfirmed = (0, quantity_1.isValidExistingQuantity)(target.quantity) && (0, quantity_1.isUnit)(target.unit);
        const unit = targetConfirmed ? target.unit : this.data.unit;
        if (unit === null || !(0, quantity_1.isUnit)(unit)) {
            return;
        }
        // 结果不明的重试:同 payload 复用同 update_id(服务端三重识别重放);
        // 任何值/版本变化 = 新操作,生成新 update_id
        const retry = this.pendingRetry;
        const samePayload = retry !== null &&
            retry.mode === mode &&
            retry.amount === parsed &&
            retry.unit === unit &&
            retry.expectedVersion === target.version;
        const updateId = samePayload && retry !== null ? retry.updateId : (0, api_1.uuid)();
        this.setData({ saving: true });
        try {
            const res = await (0, api_1.callItemsApi)({
                action: "quantityAdjust",
                item_id: target.item_id,
                expected_version: target.version,
                update_id: updateId,
                mode,
                amount: parsed,
                unit,
            });
            this.pendingRetry = null;
            const shown = (0, quantity_1.isValidExistingQuantity)(res.item.quantity) && (0, quantity_1.isUnit)(res.item.unit)
                ? "已更新为 ×" + res.item.quantity + res.item.unit
                : "已更新";
            wx.showToast({ title: shown, icon: "success" });
            wx.navigateBack();
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "VERSION_CONFLICT") {
                this.pendingRetry = null;
                const cur = e.current;
                if (cur && cur.item_id) {
                    // 冲突必带 current(§7.6):先展示最新值,绝不自动套旧 delta;
                    // 结果不明时引导核对实物总数(§14.1-5)
                    this.conflictRefresh = this.candidateFromSummary(cur);
                    const label = (0, voice_quantity_1.candidateQuantityText)((0, quantity_1.isValidExistingQuantity)(cur.quantity) ? cur.quantity : null, (0, quantity_1.isUnit)(cur.unit) ? cur.unit : null);
                    this.setData({
                        phase: "conflict",
                        conflictLabel: "家人已更新为 " + label + "。请核对实物总数后重新确认(不会自动套用刚才的变化)。",
                        saving: false,
                    });
                }
                else {
                    // 旧服务端无 current:如实引导到详情页核对
                    this.setData({ saving: false });
                    wx.showToast({
                        title: "内容已被修改,请到物品详情核对后再操作",
                        icon: "none",
                        duration: 2500,
                    });
                }
                return;
            }
            if (e instanceof api_1.ApiError && e.detail && typeof e.detail.reason === "string") {
                // 服务端兜底门(§7.7)确定性拒绝:不重试,按 reason 给可操作文案
                this.pendingRetry = null;
                this.setData({ saving: false });
                const reason = e.detail.reason;
                wx.showToast({
                    title: REASON_MESSAGES[reason] !== undefined ? REASON_MESSAGES[reason] : e.message,
                    icon: "none",
                    duration: 2500,
                });
                return;
            }
            if (e instanceof api_1.ApiError &&
                e.code !== api_1.CLIENT_TIMEOUT &&
                e.code !== api_1.CLIENT_NETWORK &&
                e.code !== api_1.CLIENT_BAD_RESPONSE) {
                // 服务端已应答的结构化错误(§7.7 确定性零写拒绝:NOT_FOUND /
                // FAMILY_SWITCHED / FAMILY_STALE_SCOPE / HOUSEHOLD_UNAVAILABLE /
                // UNAUTHORIZED / 无 detail 的 INVALID_INPUT 等):服务端明确未写入,
                // 结果不是「不明」——按服务端文案 toast,绝不弹「可能已保存」误导、
                // 绝不诱导注定失败的同键重试(§7.5 结果不明仅限响应丢失场景)。
                this.pendingRetry = null;
                this.setData({ saving: false });
                wx.showToast({ title: (0, api_1.errorMessage)(e), icon: "none", duration: 2500 });
                return;
            }
            // 结果不明(仅传输层:网络失败/超时/响应损坏,或非 ApiError 的意外异常):
            // 保留原 payload,同键重试最多生效一次;取消 = 稍后到详情页核对,
            // 绝不自动重放旧 delta
            this.pendingRetry = {
                updateId,
                itemId: target.item_id,
                expectedVersion: target.version,
                mode,
                amount: parsed,
                unit,
            };
            this.setData({ saving: false });
            wx.showModal({
                title: "结果不明",
                content: "网络中断,这次数量修改可能已保存。重试会按同一笔操作续查(不会重复生效);取消请稍后在物品详情核对数量。",
                confirmText: "重试",
                cancelText: "稍后核对",
                success: (r) => {
                    if (r.confirm) {
                        void this.onConfirmTap();
                    }
                    else {
                        wx.navigateBack();
                    }
                },
            });
        }
    },
    /**
     * 冲突后的显式重核对:以响应 current 的最新值进入「设为当前总数」,
     * 金额清空(绝不自动套旧 delta),核对实物后由用户重新填写。
     */
    onConflictReconfirmTap() {
        const cur = this.conflictRefresh;
        if (cur === null) {
            return;
        }
        this.enterConfirm(cur, MODES.indexOf("set"), "");
        this.setData({ phase: "confirm" });
    },
    /** 取消 = 丢弃提议,零写入 */
    onCancelTap() {
        this.pendingRetry = null;
        wx.navigateBack();
    },
    /* ---------------- 内部 ---------------- */
    /** 进入确认视图(modeIndex/amountText 缺省取提议值;冲突重核对传 set/"") */
    enterConfirm(target, modeIndex, amountText) {
        const payload = this.payload;
        if (payload === null) {
            return;
        }
        this.target = target;
        const targetConfirmed = (0, quantity_1.isValidExistingQuantity)(target.quantity) && (0, quantity_1.isUnit)(target.unit);
        const proposalMode = MODES.indexOf(payload.proposal.intent);
        const nextMode = modeIndex !== undefined && modeIndex >= 0 ? modeIndex : proposalMode >= 0 ? proposalMode : 0;
        const nextAmount = amountText !== undefined
            ? amountText
            : payload.proposal.amount !== null
                ? String(payload.proposal.amount)
                : "";
        const unit = targetConfirmed ? target.unit : payload.proposal.unit;
        const unitIndex = unit !== null ? Math.max(0, quantity_1.UNIT_SET.indexOf(unit)) : 0;
        this.setData({
            phase: "confirm",
            targetName: target.name,
            targetLocation: target.location_text !== "" ? target.location_text : "未归位",
            currentLabel: (0, voice_quantity_1.candidateQuantityText)(targetConfirmed ? target.quantity : null, targetConfirmed ? target.unit : null),
            targetConfirmed,
            modeIndex: nextMode,
            amountText: nextAmount,
            unit,
            unitIndex,
        });
        this.refreshConfirmView();
    },
    /** 重算预览(原数量 → 结果)与客户端预拦(独立计算:被拦截也展示预览供核对) */
    refreshConfirmView() {
        const target = this.target;
        const payload = this.payload;
        if (target === null || payload === null) {
            return;
        }
        const mode = MODES[this.data.modeIndex];
        const parsed = (0, quantity_1.parseQuantityText)(this.data.amountText, mode === "set" ? 0 : 1);
        const targetConfirmed = (0, quantity_1.isValidExistingQuantity)(target.quantity) && (0, quantity_1.isUnit)(target.unit);
        let previewLabel = "";
        if (parsed !== null && parsed !== "INVALID" && (targetConfirmed || mode === "set")) {
            const preview = (0, voice_quantity_1.previewQuantity)(mode, parsed, targetConfirmed ? target.quantity : null);
            if (preview.ok) {
                previewLabel =
                    (targetConfirmed ? String(target.quantity) : "待核对") + " → " + preview.result;
            }
        }
        let blockReason = "";
        if (parsed === null) {
            blockReason = mode === "set" ? "请填写核对后的总数" : "请填写数量";
        }
        else if (parsed === "INVALID") {
            blockReason = mode === "set" ? "总数需为 0-9999 的整数" : "数量需为 1-9999 的整数";
        }
        else if (!targetConfirmed && mode !== "set") {
            blockReason = "这条还没核对过数量,请先到详情页「设为当前总数」核对后再增减";
        }
        else if (targetConfirmed &&
            payload.proposal.unit !== null &&
            payload.proposal.unit !== target.unit) {
            blockReason =
                "说的单位与这条记录的单位不一致,请分别核对后再操作(不能把" +
                    payload.proposal.unit +
                    "加到" +
                    target.unit +
                    "上)";
        }
        else {
            const preview = (0, voice_quantity_1.previewQuantity)(mode, parsed, targetConfirmed ? target.quantity : null);
            if (!preview.ok) {
                if (preview.reason === "BELOW_ZERO") {
                    blockReason =
                        "数量不足:现有 " + target.quantity + target.unit + ",不能减 " + parsed;
                }
                else if (preview.reason === "OVER_MAX") {
                    blockReason = "超过 9999 上限";
                }
                else if (preview.reason === "UNCONFIRMED") {
                    blockReason = "这条还没核对过数量,请先到详情页核对";
                }
            }
        }
        // set 于未确认行 = 首次确认:必须选单位(§7.1 UNIT_REQUIRED 客户端半边)
        const unitPickVisible = !targetConfirmed && mode === "set";
        if (blockReason === "" && unitPickVisible && !(0, quantity_1.isUnit)(this.data.unit)) {
            blockReason = "请选择单位后再确认";
        }
        this.setData({
            previewLabel,
            blockReason,
            targetConfirmed,
            unitPickVisible,
        });
    },
    /** VERSION_CONFLICT 的 current 投影 → 候选行(重核对基准) */
    candidateFromSummary(s) {
        return {
            item_id: s.item_id,
            name: s.name,
            location_text: s.location_text,
            quantity: (0, quantity_1.isValidExistingQuantity)(s.quantity) ? s.quantity : null,
            unit: (0, quantity_1.isUnit)(s.unit) ? s.unit : null,
            version: s.version,
        };
    },
});
