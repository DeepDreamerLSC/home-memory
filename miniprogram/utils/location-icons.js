"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCATION_ICON_NAMES = exports.FALLBACK_LOCATION_ICON = void 0;
exports.locationIconName = locationIconName;
exports.locationIconSrc = locationIconSrc;
exports.hasLocationIconAsset = hasLocationIconAsset;
/**
 * 位置节点语义图标映射纯工具(issue #121 第二波批次甲 ⑥,v2 横幅 6418877302 GO)。
 *
 * 纯函数、零 wx 依赖:节点名 → 图标名(英文 snake id)→ 资产路径约定。
 * 映射与回退先行验证;**图标资产管线由 codex 设计线随后产出**,页面接线归
 * 批次乙(PR-B #122)。
 *
 * 优先级纪律(撞车根源,测试钉死):
 * - 精确词优先于包含词:归一化后的名字与关键词全等命中(第一遍)先于任何
 *   包含命中(第二遍);
 * - 包含扫描按规则表顺序,高优先词在前:「冰箱」先于泛「柜」、「抽屉」先于
 *   泛「柜」;同理鞋柜/电视柜/书柜(书架系)先于泛「柜」,泛「柜」先于「床」
 *   (床头柜归柜系);具体家具词先于房间词(「厨房抽屉」是抽屉不是厨房);
 *   房间词先于泛物品词(「书房」不是书);多字符物品词先于单字符泛词
 *   (「工具箱」是工具、「药箱」是药、「书包」是书);
 * - 无匹配 → "other"。
 *
 * 归一化复用 item-match 的 normalizeForMatch 口径(trim → NFKC 全半角统一 →
 * 小写 → 删全部空白 → 删常见标点)。
 *
 * graceful degradation 硬门:hasLocationIconAsset 本期恒 false(资产未产出),
 * 调用方必须回退现状首字徽章;资产清单落地后由资产管线/批次乙改为真实判定。
 */
const item_match_1 = require("./item-match");
/** 图标名 → 关键词(已按包含优先级排序;首关键词即该图标的典型名) */
const ICON_RULES = [
    // —— 高优先家具(先于泛「柜」;顺序即优先级,不可乱) ——
    { icon: "fridge", keywords: ["冰箱", "冰柜"] },
    { icon: "drawer", keywords: ["抽屉"] },
    { icon: "shelf", keywords: ["书柜", "书架", "置物架", "收纳架", "架子"] },
    { icon: "shoe_cabinet", keywords: ["鞋柜"] },
    { icon: "tv_stand", keywords: ["电视柜", "电视"] },
    { icon: "washing_machine", keywords: ["洗衣机"] },
    // 泛「柜」兜底归衣柜系;先于「床」→ 床头柜归柜系
    { icon: "wardrobe", keywords: ["衣柜", "衣橱", "柜子", "橱柜", "柜"] },
    { icon: "desk", keywords: ["书桌", "办公桌", "桌子", "梳妆台"] },
    { icon: "bed", keywords: ["床"] },
    // —— 房间级 ——
    { icon: "room_study", keywords: ["书房"] },
    { icon: "room_bed", keywords: ["卧室", "主卧", "次卧", "睡房", "卧房"] },
    { icon: "room_kitchen", keywords: ["厨房"] },
    { icon: "room_bath", keywords: ["卫生间", "洗手间", "盥洗室", "浴室", "厕所"] },
    { icon: "room_living", keywords: ["客厅", "起居室"] },
    { icon: "room_balcony", keywords: ["阳台", "露台"] },
    { icon: "room_entry", keywords: ["玄关", "门厅", "入户"] },
    { icon: "room_dining", keywords: ["餐厅", "饭厅"] },
    { icon: "room_storage", keywords: ["储物间", "杂物间", "储藏室"] },
    // —— 容器/物品级(多字符词先于单字符泛词) ——
    { icon: "towel", keywords: ["毛巾"] },
    { icon: "tool", keywords: ["工具箱", "工具"] },
    { icon: "medicine", keywords: ["药箱", "药品", "药"] },
    { icon: "book", keywords: ["书本", "书籍", "书"] },
    { icon: "can", keywords: ["易拉罐", "罐头", "罐"] },
    { icon: "bottle", keywords: ["瓶子", "瓶"] },
    { icon: "bag", keywords: ["袋子", "背包", "袋", "包"] },
    { icon: "box", keywords: ["箱子", "盒子", "箱", "盒"] },
];
/** 兜底图标名 */
exports.FALLBACK_LOCATION_ICON = "other";
/** 图标名封闭清单(规则表推导 + other);资产管线按此命名产出 png */
exports.LOCATION_ICON_NAMES = (() => {
    const names = [];
    for (const rule of ICON_RULES) {
        if (names.indexOf(rule.icon) === -1)
            names.push(rule.icon);
    }
    names.push(exports.FALLBACK_LOCATION_ICON);
    return names;
})();
/**
 * 节点名 → 图标名(纯函数):
 * 第一遍精确(归一化后与关键词全等,规则表顺序内取先);
 * 第二遍包含(规则表顺序内取先,即优先级表);无匹配 → "other"。
 */
function locationIconName(nodeName) {
    const norm = (0, item_match_1.normalizeForMatch)(nodeName || "");
    if (norm === "")
        return exports.FALLBACK_LOCATION_ICON;
    for (const rule of ICON_RULES) {
        if (rule.keywords.indexOf(norm) !== -1)
            return rule.icon;
    }
    for (const rule of ICON_RULES) {
        for (const kw of rule.keywords) {
            if (norm.indexOf(kw) !== -1)
                return rule.icon;
        }
    }
    return exports.FALLBACK_LOCATION_ICON;
}
/**
 * 图标名 → 资产路径约定:`/assets/location-icons/{name}{-dark?}.png`。
 * 空名归一为 other;theme 只有 dark 追加 -dark 后缀(light 无后缀)。
 * 只做字符串拼装,不做存在性判断(见 hasLocationIconAsset)。
 */
function locationIconSrc(iconName, theme) {
    const name = iconName || exports.FALLBACK_LOCATION_ICON;
    const suffix = theme === "dark" ? "-dark" : "";
    return "/assets/location-icons/" + name + suffix + ".png";
}
/**
 * 资产存在性占位判定:本期资产未产出,统一返回 false → 调用方回退现状首字
 * 徽章(graceful degradation 硬门)。资产管线落地后改为按真实清单判定
 * (届时同步补资产缺失用例);接线在批次乙。
 */
function hasLocationIconAsset(_iconName) {
    return false;
}
