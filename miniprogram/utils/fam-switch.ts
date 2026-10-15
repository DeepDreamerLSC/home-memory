/**
 * 「切换家庭」三选弹层共享编排(issue #45 十七轮 B 线,docs §2.5):
 * - 弹层三行固定:我的家 / 我们家 · 家庭名 / 家庭管理页,由当前家庭作用域拼出
 *   (当前家庭带 ✓ 与「当前」标记);文案全为用户词,不出现指针/作用域等开发词;
 * - 共享家庭名取自 household-scope 的展示名记忆(status 响应捕获);个人态下
 *   上一家的名字已随切换清空,弹层如实只显示「我们家」(不猜、不留旧名);
 * - 首页与家庭管理页共用本拼装;切换执行收口在 households-api.switchFamily
 *   (既有 captureAndInvalidate 链,不另起缓存体系),本模块不碰任何存储。
 */
import { householdScopeName, isHouseholdScopeShared } from "./household-scope";

/** 弹层行标识:mine=我的家 / shared=我们家 / admin=家庭管理页入口 */
export type FamSwitchOptionKey = "mine" | "shared" | "admin";

/** 弹层一行(标题 + 副文 + 是否当前家庭) */
export interface FamSwitchOption {
  key: FamSwitchOptionKey;
  title: string;
  sub: string;
  current: boolean;
}

/** 当前家庭落在哪一行(未捕获/个人 = mine) */
export function currentFamSwitchKey(): FamSwitchOptionKey {
  return isHouseholdScopeShared() ? "shared" : "mine";
}

/**
 * 拼出三选弹层的行(打开弹层时现拼,保证「当前」标记与家庭名实时):
 * 我的家(只有你一人 · 记录不共享)/ 我们家 · 家庭名(共享中)/ 家庭管理 ›。
 */
export function famSwitchSheetOptions(): FamSwitchOption[] {
  const current = currentFamSwitchKey();
  const name = householdScopeName();
  return [
    {
      key: "mine",
      title: "我的家",
      sub: "只有你一人 · 记录不共享" + (current === "mine" ? " · 当前" : ""),
      current: current === "mine",
    },
    {
      key: "shared",
      title: name !== null && name.length > 0 ? "我们家 · " + name : "我们家",
      sub: "共享中 · 和家人一起记" + (current === "shared" ? " · 当前" : ""),
      current: current === "shared",
    },
    {
      key: "admin",
      title: "家庭管理 ›",
      sub: "邀请家人 / 成员 / 设置",
      current: false,
    },
  ];
}
