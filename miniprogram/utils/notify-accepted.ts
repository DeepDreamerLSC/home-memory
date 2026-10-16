/**
 * 「已成功开启订阅」本地标记(#36,0.9.6 抽公用):
 * 展示启发式——详情页 chip「到期时微信提醒我 ›」据它决定是否露出;权威
 * 订阅记录在服务端 remind_subscriptions,本标记不参与任何发送决策。
 * 键按家庭作用域隔离(换家庭即另一份标记),storage 全部 best-effort
 * (读写失败不抛错不重试,最坏表现=chip 多露/少露一次)。
 * 0.9.6 生命周期(#36 用户反馈):
 * - 订阅 accept → mark(chip 收起);
 * - 设/改提醒成功且用户有意向 → clear(chip 重新露出:一次性订阅额度随每次
 *   发送消耗,新提醒需要新的授权机会);
 * - 已处理成功 → clear(该物品提醒已完成、天然不再进推送;清标记让之后的
 *   新提醒能重新询问/开启)。
 */
import { householdScopeSuffix } from "./household-scope";

const NOTIFY_ACCEPTED_KEY = "wx-notify-accepted";

interface StorageLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

/** 生产存储:wx 同步三原语(惰性取,测试外 wx 必在) */
function wxStorage(): StorageLike {
  return {
    get: (k) => wx.getStorageSync(k),
    set: (k, v) => wx.setStorageSync(k, v),
    remove: (k) => wx.removeStorageSync(k),
  };
}

let activeStorage: StorageLike | null = null;

/** 测试注入(与 household-scope 等模块同款纪律);传 null 回到 wx 存储 */
export function __setNotifyAcceptedStorageForTest(s: StorageLike | null): void {
  activeStorage = s;
}

function storage(): StorageLike {
  return activeStorage !== null ? activeStorage : wxStorage();
}

function scopedKey(): string {
  return NOTIFY_ACCEPTED_KEY + householdScopeSuffix();
}

/** 读标记(best-effort;读失败/无存储/形状异常一律按未开启) */
export function isNotifyAccepted(): boolean {
  try {
    return storage().get(scopedKey()) === true;
  } catch (e) {
    return false;
  }
}

/** 写标记(best-effort;写失败不影响本次会话收起入口) */
export function markNotifyAccepted(): void {
  try {
    storage().set(scopedKey(), true);
  } catch (e) {
    // best-effort:展示启发式标记,失败不重试不抛出
  }
}

/** 清标记(best-effort;删除失败最坏=chip 暂不露出,下次生命周期事件再清) */
export function clearNotifyAccepted(): void {
  try {
    storage().remove(scopedKey());
  } catch (e) {
    // best-effort
  }
}
