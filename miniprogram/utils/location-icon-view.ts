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
import {
  hasLocationIconAsset,
  locationIconName,
  locationIconSrc,
} from "./location-icons";

/** 双主题图标路径对;双空串 = 无资产(调用方回退现状) */
export interface LocationIconArtwork {
  icon: string;
  iconDark: string;
}

const EMPTY_ARTWORK: LocationIconArtwork = { icon: "", iconDark: "" };

/** 节点名 → 图标视图字段(存在才给路径;否则双空串) */
export function locationIconArtwork(nodeName: string): LocationIconArtwork {
  const icon = locationIconName(nodeName || "");
  if (!hasLocationIconAsset(icon)) {
    return { ...EMPTY_ARTWORK };
  }
  return {
    icon: locationIconSrc(icon, "light"),
    iconDark: locationIconSrc(icon, "dark"),
  };
}
