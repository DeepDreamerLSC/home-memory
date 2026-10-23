"use strict";
/**
 * 数量管理客户端纯函数(issue #102 Q1,docs/design/quantity/Q0-CONTRACT.md):
 * UNIT_SET 镜像(§2.2)、投影缺键归一(§2.4/B8)、数量槽与详情文案(§10.1 冻结词表)、
 * displayNoteFor(§10.2 防「旧 ×N 与新数量」双展示的兜底)。
 *
 * 纪律:
 * - quantity 是用户确认值;任何客户端代码不得从 note 文本/VL 提示/observation 数
 *   推断已确认数量(L1);
 * - 未确认(双 null)一律「待核对」,绝不显示误导性的「×1件」(issue §1.3);
 * - 存储 note 一字不改,displayNoteFor 只是展示层剥词元,且仅服务并排渲染表面
 *   (主规则是「note 折叠不并排」,PR #103 决定 2)。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_UNIT = exports.QUANTITY_MAX = exports.UNIT_SET = void 0;
exports.isUnit = isUnit;
exports.isValidExistingQuantity = isValidExistingQuantity;
exports.isValidCreateQuantity = isValidCreateQuantity;
exports.normalizeQuantityFields = normalizeQuantityFields;
exports.isQuantityConfirmed = isQuantityConfirmed;
exports.quantitySlotText = quantitySlotText;
exports.quantityConfirmedText = quantityConfirmedText;
exports.displayNoteFor = displayNoteFor;
exports.parseQuantityText = parseQuantityText;
/** unit 冻结闭集(L5):与 cloudfunctions/itemsApi/lib/handler.js UNIT_SET 逐字一致,只增不减 */
exports.UNIT_SET = [
    "件", "个", "包", "盒", "瓶", "袋", "支", "双", "套", "卷", "张", "本", "罐", "只",
];
/** 上限冻结常量(L4):新建 1..9999,已有 0..9999 */
exports.QUANTITY_MAX = 9999;
/** 默认单位(issue §1.2) */
exports.DEFAULT_UNIT = "件";
function isUnit(v) {
    return typeof v === "string" && exports.UNIT_SET.indexOf(v) !== -1;
}
/** 已有记录可接受的数量(0..9999 整数) */
function isValidExistingQuantity(v) {
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= exports.QUANTITY_MAX;
}
/** 新建可接受的数量(1..9999 整数) */
function isValidCreateQuantity(v) {
    return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= exports.QUANTITY_MAX;
}
/**
 * 投影缺键/异常归一(§2.4):quantity/unit 合法成组才算已确认,否则三字段全 null
 * (新客户端 × 旧服务端的部署窗口里投影缺键 ≡ 未确认;半态/越界/闭集外同样按未确认读,
 * 绝不伪造)。confirmed_at 非 string 读 null(I1 放宽分支:不丢已确认数量)。
 */
function normalizeQuantityFields(item) {
    const q = item.quantity;
    const u = item.unit;
    const confirmed = isValidExistingQuantity(q) && isUnit(u);
    const at = item.quantity_confirmed_at;
    return {
        ...item,
        quantity: confirmed ? q : null,
        unit: confirmed ? u : null,
        quantity_confirmed_at: confirmed && typeof at === "string" ? at : null,
    };
}
/** 数量是否已确认(投影字段口径) */
function isQuantityConfirmed(quantity, unit) {
    return isValidExistingQuantity(quantity) && isUnit(unit);
}
/**
 * 列表右槽文案(§10.1):已确认 `×{quantity}{unit}`(单位紧随,0 也如实);
 * 未确认(双 null / 缺键)中性标记「待核对」——无数字。
 */
function quantitySlotText(quantity, unit) {
    if (isQuantityConfirmed(quantity, unit)) {
        return "×" + String(quantity) + String(unit);
    }
    return "待核对";
}
/** ISO 时间戳 → MM-DD(非法返回 "");只切字符串,不做时区推算 */
function shortMonthDay(iso) {
    if (typeof iso !== "string") {
        return "";
    }
    const t = Date.parse(iso);
    if (Number.isNaN(t)) {
        return "";
    }
    const d = new Date(t);
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
/**
 * 详情头文案(§10.1):「上次确认 ×N单位 · MM-DD」;确认时间缺失/非法时退化为无时间后缀
 * (绝不因时间戳异常丢掉用户确认过的数量);未确认 → 「待核对」。
 */
function quantityConfirmedText(quantity, unit, confirmedAt) {
    if (!isQuantityConfirmed(quantity, unit)) {
        return "待核对";
    }
    const base = "上次确认 " + quantitySlotText(quantity, unit);
    const day = shortMonthDay(confirmedAt);
    return day === "" ? base : base + " · " + day;
}
/** 旧拼法形状(intake-draft composeNote 产物):`×N` + 可选空白 + 可选后缀 */
const LEGACY_NOTE_RE = /^×\s*\d+(\s+(.*))?$/;
const DEFAULT_SUFFIX = "备注";
/**
 * displayNoteFor(§10.2 冻结纯函数,并排渲染表面的兜底):
 * - 未确认 → note 原样(旧 ×N 是仅有的信息,不隐藏、不升格);
 * - 已确认 + 旧形状 `^×N` → 剥掉 ×N 词元只展示后缀;后缀为默认占位「备注」或剥后为空
 *   → 整条不展示("");
 * - 已确认 + 非旧形状 → 原样(自由备注与数量无关,绝不含数字就隐藏)。
 * 存储 note 一字不改;正则只此一条,不做更聪明的解析。
 */
function displayNoteFor(note, quantityConfirmed) {
    const text = typeof note === "string" ? note : "";
    if (!quantityConfirmed) {
        return text;
    }
    const m = text.match(LEGACY_NOTE_RE);
    if (m === null) {
        return text;
    }
    const suffix = (m[2] || "").trim();
    if (suffix === "" || suffix === DEFAULT_SUFFIX) {
        return "";
    }
    return suffix;
}
/**
 * 详情/确认页数量输入解析:空串 → null(未填,不携带);其余必须是 0..9999 整数字符串
 * (允许 min 由调用方裁:详情 0、新建 1),否则返回 "INVALID"。
 * 不 parseFloat 取整、不接受小数/负号/空格之外的任何形态。
 */
function parseQuantityText(text, min) {
    const t = typeof text === "string" ? text.trim() : "";
    if (t === "") {
        return null;
    }
    if (!/^\d{1,4}$/.test(t)) {
        return "INVALID";
    }
    const n = Number(t);
    if (!Number.isInteger(n) || n < min || n > exports.QUANTITY_MAX) {
        return "INVALID";
    }
    return n;
}
