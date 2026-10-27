"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.locationIconArtwork = locationIconArtwork;
/**
 * 位置节点语义图标视图适配(issue #121 第二波批次乙 ⑥,消费批次甲 #123 的
 * location-icons 纯工具;v2 横幅 6418877302)。
 *
 * 批次甲定映射与回退,本模块只做「接线适配」:节点名 → 双主题图标路径对。
 * 纪律(与批次甲硬门一致):
 * - hasLocationIconAsset(iconName) !== true → 双空串:调用方一律回退现状
 *   (树行首字徽章逐字不变;现状本无徽章的面(选择器行/归到行/页头)零渲染,
 *   资产未产出期间零视觉漂移);
 * - 明暗跟随不在此做分支:light/dark 双路径同时给出,由页面既有的
 *   .theme-light/.theme-dark(appearance CSS 变量)自动显隐;
 * - 纯函数、零 wx 依赖,资产管线落地后翻转 hasLocationIconAsset 即全局点亮。
 */
const location_icons_1 = require("./location-icons");
const EMPTY_ARTWORK = { icon: "", iconDark: "" };
/** 节点名 → 图标视图字段(存在才给路径;否则双空串) */
function locationIconArtwork(nodeName) {
    const icon = (0, location_icons_1.locationIconName)(nodeName || "");
    if (!(0, location_icons_1.hasLocationIconAsset)(icon)) {
        return { ...EMPTY_ARTWORK };
    }
    return {
        icon: (0, location_icons_1.locationIconSrc)(icon, "light"),
        iconDark: (0, location_icons_1.locationIconSrc)(icon, "dark"),
    };
}
