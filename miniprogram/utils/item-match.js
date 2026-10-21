"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ITEM_MATCH_SUGGESTIONS_MAX = void 0;
exports.normalizeForMatch = normalizeForMatch;
exports.editDistance = editDistance;
exports.buildItemMatchSuggestions = buildItemMatchSuggestions;
/** 建议列表上限(§3:截断 5 条) */
exports.ITEM_MATCH_SUGGESTIONS_MAX = 5;
/** 编辑距离容忍:查询归一化后 ≤4 码点容 1,更长容 2(§3 第 2 级原文) */
const LEV_SHORT_MAX_LEN = 4;
/** 归一化后删除的常见标点(§3 原文集:半角与全角形式都列,NFKC 不可用时同样删) */
const PUNCTUATION = [
    ",",
    ",",
    "、",
    "。",
    "·",
    "・",
    ".",
    "-",
    "-",
    "_",
    "/",
    "(",
    ")",
    "(",
    ")",
    "[",
    "]",
    "【",
    "】",
    ":",
    ":",
];
/**
 * 匹配用归一化:trim → Unicode NFKC(全半角统一)→ 转小写 → 删全部空白
 * (\s,与 B 的 nameKeyOf 同款)→ 删常见标点。
 */
function normalizeForMatch(s) {
    let out = (s || "").trim();
    if (out === "")
        return "";
    try {
        out = out.normalize("NFKC");
    }
    catch (e) {
        // 极老运行时无 normalize:退化为只做后续步骤,同名判断仍成立
    }
    out = out.toLowerCase().replace(/\s+/g, "");
    let cleaned = "";
    for (const ch of out) {
        if (PUNCTUATION.indexOf(ch) === -1)
            cleaned += ch;
    }
    return cleaned;
}
/** 编辑距离(Levenshtein);两串任一为空返回另一串长度 */
function editDistance(a, b) {
    if (a === b)
        return 0;
    if (a.length === 0)
        return b.length;
    if (b.length === 0)
        return a.length;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++)
        prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        const swap = prev;
        prev = cur;
        cur = swap;
    }
    return prev[b.length];
}
/** 第 2/4 级模糊判定:双向包含或编辑距离在容忍内(查询长度 ≤4 容 1,否则容 2) */
function isFuzzyMatch(nq, nName) {
    if (nq === "" || nName === "")
        return false;
    if (nName.indexOf(nq) !== -1 || nq.indexOf(nName) !== -1)
        return true;
    const tolerance = nq.length <= LEV_SHORT_MAX_LEN ? 1 : 2;
    return editDistance(nq, nName) <= tolerance;
}
/**
 * 五级顺序匹配(§3):
 * 1 子树内严格同名 → 2 子树内模糊 → 3 全家庭严格同名(排除已出现)→
 * 4 全家庭模糊(排除已出现)→ 5 无建议(返回空数组,页面保持「新建物品」)。
 * 输出按级别升序、同级按名称字典序,截断 5 条;同池同名物品可并列出现,
 * 绝不合并——哪一件是「这一件」只能由用户点选认定。
 */
function buildItemMatchSuggestions(query, pools) {
    const nq = normalizeForMatch(query);
    if (nq === "")
        return [];
    const pathByNodeId = new Map();
    const subtreeIds = new Set();
    for (const node of pools.subtree) {
        subtreeIds.add(node.location_id);
        pathByNodeId.set(node.location_id, node.path.join(" / "));
    }
    const seen = new Set();
    const rows = [];
    const push = (item, level) => {
        if (seen.has(item.item_id))
            return;
        seen.add(item.item_id);
        const mounted = item.location_node_id !== "" && subtreeIds.has(item.location_node_id);
        const display = mounted
            ? pathByNodeId.get(item.location_node_id) || item.location_text
            : item.location_text || "未归位";
        rows.push({
            item_id: item.item_id,
            name: item.name,
            location_display: display,
            location_fallback: !mounted,
            mounted_in_subtree: mounted,
            level,
            version: item.version,
            normName: normalizeForMatch(item.name),
        });
    };
    for (const item of pools.subtree_items) {
        if (normalizeForMatch(item.name) === nq)
            push(item, 1);
    }
    for (const item of pools.subtree_items) {
        if (seen.has(item.item_id) === false && isFuzzyMatch(nq, normalizeForMatch(item.name))) {
            push(item, 2);
        }
    }
    for (const item of pools.household_items) {
        if (seen.has(item.item_id) === false && normalizeForMatch(item.name) === nq) {
            push(item, 3);
        }
    }
    for (const item of pools.household_items) {
        if (seen.has(item.item_id) === false && isFuzzyMatch(nq, normalizeForMatch(item.name))) {
            push(item, 4);
        }
    }
    rows.sort((a, b) => {
        if (a.level !== b.level)
            return a.level - b.level;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return rows.slice(0, exports.ITEM_MATCH_SUGGESTIONS_MAX).map((row) => ({
        item_id: row.item_id,
        name: row.name,
        location_display: row.location_display,
        location_fallback: row.location_fallback,
        mounted_in_subtree: row.mounted_in_subtree,
        level: row.level,
        version: row.version,
    }));
}
