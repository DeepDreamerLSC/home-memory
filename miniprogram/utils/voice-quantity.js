"use strict";
/**
 * 语音数量操作客户端纯函数与交接(issue #102 Q2 / docs/design/quantity/
 * Q0-CONTRACT.md §7.8 客户端确认流):
 * - 意图词表路由(issue §3:新建 create / 增加 add / 减少 subtract / 设为 set /
 *   不确定 unknown——create 臂 = 词表不命中,零回归走既有 extractDraft 提取,
 *   Q0 §4.6 冻结「买了/新增」不产生数量语义只走 create):
 *   「拿到/搬到…」移动句与「找一下/在哪…」找回句就地提示(一期不做跨位置
 *   数量搬移,找回走既有查询),绝不折算成增减、绝不未确认写入;
 * - 候选检索:itemsApi list 的行中「名称(归一)出现在原话里」的进候选(≤12),
 *   候选随 quantityIntentParse 请求传入(不是数据库事实),目标 item_id 必须
 *   由用户在确认页点选——模型绝不直填 item_id 写库;
 * - 数量预览:原数量→结果的算术与失败关闭(库存不足/超上限/未确认行);
 * - 确认页交接:解析提议 + 候选经模块 handoff 交给 pages/quantity-voice,
 *   页面未消费前保持,消费即清(取消 = 丢弃,零写入)。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUANTITY_CANDIDATES_MAX = void 0;
exports.detectQuantityOpSignal = detectQuantityOpSignal;
exports.buildQuantityCandidates = buildQuantityCandidates;
exports.previewQuantity = previewQuantity;
exports.candidateQuantityText = candidateQuantityText;
exports.beginQuantityConfirm = beginQuantityConfirm;
exports.takeQuantityConfirm = takeQuantityConfirm;
exports.__resetVoiceQuantityForTest = __resetVoiceQuantityForTest;
const item_match_1 = require("./item-match");
const quantity_1 = require("./quantity");
/** 候选上限(与服务端 quantityIntentParse 的 0-12 项合同一致) */
exports.QUANTITY_CANDIDATES_MAX = 12;
/* ---------------- 路由词表(纯函数,客户端侧;服务端硬门在 quantityIntentParse) ---------------- */
/** 数字字(阿拉伯 + 中文,与冻结数字解析器 §7.8.2 的可解析集合一致) */
const NUM_CHAR = "[0-9一二两三四五六七八九十百千]";
/**
 * 移动句词表:「拿到/搬到/拿去/挪到/移去」——注意「放到」**不在**客户端路由
 * (「剪刀放到书房」是高频新建句,误入数量流会造成语音新建回归;带数量的
 * 「放到」句若经其他信号进入解析,服务端 QI_MOVE_MARKERS 仍按 §7.8 兜底 other)
 */
const MOVE_RE = /(拿到|搬到|拿去|挪到|移到|移去)/;
/** 找回句词表 */
const FIND_RE = /(找一下|找一找|找找|在哪里|在哪儿|哪儿有|哪里有|帮我找)/;
/** 增加句:加/添 紧跟(可隔「了」)数字 */
const ADD_RE = new RegExp("(加|添)了?\\s*" + NUM_CHAR);
/** 减少句:用掉/用了/少了/减(了) 紧跟数字 */
const SUB_RE = new RegExp("(用掉|用了|少了|减了?|耗掉)了?\\s*" + NUM_CHAR);
/** 设为句:现在有/改成/设为/换成/一共/只剩/还剩 + (可有/了) + 数字 */
const SET_RE = new RegExp("(现在有|现在还|改成|设为|换成|一共|总共|只剩|还剩)[了有]?\\s*" + NUM_CHAR);
/** 总数歧义句:「还有 N」说不清是加还是总数 → 进数量流由解析层判 unknown(maybe_total) */
const MAYBE_RE = new RegExp("还有\\s*" + NUM_CHAR);
/**
 * 词表路由(纯函数):
 * - move/find → 就地提示(零云调用零写入);
 * - op → 数量流(list 检索候选 → quantityIntentParse 提议 → 确认页);
 * - null(新建陈述,含「买了 3 包」「加湿器」这类含数字/含「加」字但非操作的句子)
 *   → 零回归走既有 extractDraft create 提取。
 * 词表宁可漏判(漏判 = 现状 create 流,用户在确认页可改)绝不误判把新建句
 * 挡在数量流里。
 */
function detectQuantityOpSignal(text) {
    const t = typeof text === "string" ? text : "";
    if (t === "") {
        return null;
    }
    if (MOVE_RE.test(t)) {
        return "move";
    }
    if (FIND_RE.test(t)) {
        return "find";
    }
    if (ADD_RE.test(t) || SUB_RE.test(t) || SET_RE.test(t) || MAYBE_RE.test(t)) {
        return "op";
    }
    return null;
}
/**
 * 候选检索:名称(归一)出现在原话中的行入选(双向不必要——物品名比原话短,
 * 名称 ⊆ 原话即为「话里提到了它」);按 item_id 去重、封顶 12。
 * 未确认行(双 null)原样进候选,确认页展示「待核对」并按 E10 先核对引导。
 */
function buildQuantityCandidates(text, items) {
    const normText = (0, item_match_1.normalizeForMatch)(text);
    if (normText === "" || Array.isArray(items) === false) {
        return [];
    }
    const seen = new Set();
    const out = [];
    for (const item of items) {
        if (item === null || typeof item !== "object") {
            continue;
        }
        const normName = (0, item_match_1.normalizeForMatch)(item.name);
        if (normName === "" || seen.has(item.item_id)) {
            continue;
        }
        if (normText.indexOf(normName) === -1) {
            continue;
        }
        // version 是确认页 expected_version 的唯一来源(types.ts「绝不页面自造」),
        // 与服务端 quantityIntentParse 候选门同口径:必须正整数;不合法的行整行
        // 跳过(宁可漏判,绝不伪造 version 送进 CAS)。
        if (Number.isInteger(item.version) === false || item.version < 1) {
            continue;
        }
        seen.add(item.item_id);
        out.push({
            item_id: item.item_id,
            name: item.name,
            location_text: item.location_text,
            quantity: typeof item.quantity === "number" ? item.quantity : null,
            // L5 镜像:闭集外 unit 一律按「未确认」表达(null),绝不随候选进入
            // quantityIntentParse(服务端闭集硬门会将整个请求判 INVALID_INPUT)
            unit: (0, quantity_1.isUnit)(item.unit) ? item.unit : null,
            version: item.version,
        });
        if (out.length >= exports.QUANTITY_CANDIDATES_MAX) {
            break;
        }
    }
    return out;
}
/**
 * 原数量 → 结果的计算与失败关闭(客户端预拦;服务端同口径硬门兜底):
 * - add/subtract 须已确认数量(UNCONFIRMED → 先到详情页核对);
 * - subtract 结果 < 0 → BELOW_ZERO(库存不足);
 * - 结果 > 9999 → OVER_MAX;
 * - set 允许 0(= 确认目前没有,绝不删物品)。
 */
function previewQuantity(mode, amount, current) {
    if (mode !== "set" && current === null) {
        return { ok: false, reason: "UNCONFIRMED" };
    }
    if (typeof amount !== "number" ||
        Number.isInteger(amount) === false ||
        amount < 0 ||
        amount > quantity_1.QUANTITY_MAX) {
        return { ok: false, reason: "OVER_MAX" };
    }
    if (mode === "set") {
        return { ok: true, result: amount };
    }
    const base = current;
    const result = mode === "add" ? base + amount : base - amount;
    if (result < 0) {
        return { ok: false, reason: "BELOW_ZERO" };
    }
    if (result > quantity_1.QUANTITY_MAX) {
        return { ok: false, reason: "OVER_MAX" };
    }
    return { ok: true, result };
}
/** 候选行展示文案(§10.1 词表:×N单位 / 待核对) */
function candidateQuantityText(quantity, unit) {
    return (0, quantity_1.quantitySlotText)(quantity, unit);
}
/* ---------------- 确认页交接(模块 handoff) ---------------- */
let pendingPayload = null;
/** 语音入口在跳转确认页前存入提议与候选 */
function beginQuantityConfirm(payload) {
    pendingPayload = payload;
}
/** 确认页 onLoad 消费(一次性;未消费前保持,取消即丢弃) */
function takeQuantityConfirm() {
    const payload = pendingPayload;
    pendingPayload = null;
    return payload;
}
/** 测试钩子:复位 handoff 状态 */
function __resetVoiceQuantityForTest() {
    pendingPayload = null;
}
