/**
 * 提醒的查看与处理(issue #36 三阶段)——R1 快到期页 / 首页到期横幅 /
 * 详情页保质期行共用的展示与「已处理」流程(0.7.0 真机反馈 Fix 3:按钮字样
 * 由「用完了」统一改「已处理」——不只用完,扔了/修了/换地方了都是处理)。
 *
 * 日期纪律(#36 冻结 + PR #52 Low-3 合同)在展示侧的口径:
 * - 家庭提醒日期一律按用户本地自然日:分组界线与「还剩几天」按用户本地
 *   日历日计算(已过期 = due < 今天;这几天 = 7 天内含今天;再往后 = 其余);
 * - 「已处理」的完成日与周期天数以用户本地自然日随请求携带(complete_date,
 *   体验口径为本地日;服务端校验格式并按与服务端 UTC 当天相差 ≤1 个自然日
 *   的窗口放行——客户端时间不是可信的服务器事实,超出拒绝),服务端不靠
 *   运行时区猜;item 页改期 picker 的可选范围(今天可选)与提交前校验
 *   (今天可设)两端一致;
 * - 只对服务端下发的 YYYY-MM-DD 做日历日算术,绝不解析模糊表述、
 *   绝不从文本推算日期;到期只在小程序内露出,无任何推送/通知承诺。
 */
import type { RemindRow } from "../types";

const DAY_MS = 86400000;
/** 周期再生的天数上限(与服务端 REMIND_PERIOD_MAX 同源;item 页改期护栏用) */
export const PERIOD_DAYS_MAX = 3650;

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** 用户本地自然日今天(YYYY-MM-DD)——家庭提醒日期合同的客户端基准 */
export function localTodayYmd(now: Date = new Date()): string {
  return (
    now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate())
  );
}

/** 距本地今天的日历天数(负数=已过期,0=今天) */
export function daysUntilLocal(due: string, now: Date = new Date()): number {
  const today = localTodayYmd(now);
  return Math.round(
    (Date.parse(due + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / DAY_MS,
  );
}

/** 每日到期推送扫描的本地小时(remindNotify 定时器 0 0 8 * * * *,Asia/Shanghai) */
export const DAILY_SCAN_HOUR = 8;

/** 本地「今天 8 点的推送扫描是否已跑过」(2026-10-24 真机教训:08:49 设当天到期永不推送) */
export function dailyScanPassed(now: Date = new Date()): boolean {
  return now.getHours() >= DAILY_SCAN_HOUR;
}

/**
 * 提醒日期 picker 的可选起点(真机反馈 2026-10-26):当天 8 点前=今天(今晨扫描
 * 还会扫到它);8 点后=明天——今天的扫描已跑完、明天的窗口又不含今天,
 * 此时设「今天」的提醒永远发不出去,滚轮直接从明天起,把这个坑挡在 UI 外。
 */
export function pickerStartYmd(now: Date = new Date()): string {
  if (!dailyScanPassed(now)) return localTodayYmd(now);
  const t = new Date(now.getTime());
  t.setDate(t.getDate() + 1);
  return localTodayYmd(t);
}

/**
 * 改期 picker 的提交前校验(与 pickerStartYmd 的可选范围两端一致):
 * 8 点前今天可设(到期分组里「今天到期」本就存在);8 点后今天拒绝(推送已过);
 * 过去的日子与超 10 年的拒绝。返回可展示的问题文案,空串=可提交。
 */
export function pickerDateProblem(value: string, now: Date = new Date()): string {
  const days = daysUntilLocal(value, now);
  if (days < 0) {
    return "选今天或往后的日子";
  }
  if (days === 0 && dailyScanPassed(now)) {
    return "今天 8 点的提醒已经发过了,选明天或往后";
  }
  if (days > PERIOD_DAYS_MAX) {
    return "最多记十年内";
  }
  return "";
}

/** R1 的三分组界线(十五轮冻结):已过期 / 这几天(7 天内)/ 再往后 */
export type DueGroup = "over" | "soon" | "later";

/** 日期胶囊三态文案:已过期(danger)/ N 天后(banner-bg)/ 明年 4 月(card-inset) */
export function duePill(
  due: string,
  now: Date = new Date(),
): { group: DueGroup; text: string } {
  const days = daysUntilLocal(due, now);
  if (days < 0) {
    return { group: "over", text: "已过期" };
  }
  if (days === 0) {
    return { group: "soon", text: "今天到期" };
  }
  if (days <= 7) {
    return { group: "soon", text: days + " 天后" };
  }
  return { group: "later", text: farDateText(due, now) };
}

/** 远期紧凑日期:同年「4月12日」、明年「明年4月」、更远「2028年4月」(绝不误导是哪一年) */
function farDateText(due: string, now: Date): string {
  const y = Number(due.slice(0, 4));
  const m = Number(due.slice(5, 7));
  const thisYear = now.getFullYear();
  if (y === thisYear) {
    return m + "月" + Number(due.slice(8, 10)) + "日";
  }
  if (y === thisYear + 1) {
    return "明年" + m + "月";
  }
  return y + "年" + m + "月";
}

/** 带日的紧凑日期(回执/提示用):「11月20日」/「明年3月1日」/「2028年4月30日」 */
export function monthDayText(due: string, now: Date = new Date()): string {
  const y = Number(due.slice(0, 4));
  const md = Number(due.slice(5, 7)) + "月" + Number(due.slice(8, 10)) + "日";
  if (y === now.getFullYear()) {
    return md;
  }
  if (y === now.getFullYear() + 1) {
    return "明年" + md;
  }
  return y + "年" + md;
}

/** 详情页保质期行主文案:「有效期 2026-11-20 · 还剩 12 天」/「· 今天到期」/「· 已过期 2 天」 */
export function expireMainText(due: string, now: Date = new Date()): string {
  const days = daysUntilLocal(due, now);
  if (days < 0) {
    return "有效期 " + due + " · 已过期 " + -days + " 天";
  }
  if (days === 0) {
    return "有效期 " + due + " · 今天到期";
  }
  return "有效期 " + due + " · 还剩 " + days + " 天";
}

/** 首页到期横幅计数:已过期 / 这几天(7 天内,含今天) */
export function countDue(
  reminders: RemindRow[],
  now: Date = new Date(),
): { overdue: number; soon: number } {
  let overdue = 0;
  let soon = 0;
  for (const r of reminders) {
    const days = daysUntilLocal(r.due_date, now);
    if (days < 0) {
      overdue += 1;
    } else if (days <= 7) {
      soon += 1;
    }
  }
  return { overdue, soon };
}

/** 首页横幅文案:「1 件已过期,2 件这几天到期」(只拼非零段) */
export function dueBannerText(counts: {
  overdue: number;
  soon: number;
}): string {
  const parts: string[] = [];
  if (counts.overdue > 0) {
    parts.push(counts.overdue + " 件已过期");
  }
  if (counts.soon > 0) {
    parts.push(counts.soon + " 件这几天到期");
  }
  return parts.join(",");
}

/**
 * 「已处理」的确认交互(#36 0.6.0 真机反馈 Fix 2 + 0.7.0 Fix 3 改字样):
 * 完成后不再弹 7/30/90 天等固定周期选项——下次提醒时间由用户自己到详情页
 * 的日期选择器里选日子(服务端 period_days 参数与再生逻辑保留,API 兼容,
 * 客户端不再传)。这里只做一次二次确认(绝不一点就收掉提醒),确认后返回 true;
 * 取消返回 false,页面不动、不写任何数据。按钮字样「已处理」(原「用完了」,
 * 0.7.0 真机反馈:处理不等于用完,扔了/修了也是处理)。
 */
export function askUseUp(name: string): Promise<boolean> {
  const label = name || "这件东西";
  return new Promise((resolve) => {
    wx.showModal({
      title: "处理好了吗",
      content: "把「" + label + "」这次的到期提醒收掉。",
      confirmText: "已处理",
      cancelText: "取消",
      success: (r) => {
        resolve(r.confirm === true);
      },
      fail: () => resolve(false),
    });
  });
}

/**
 * 「已处理后问保留还是删除物品记录」(#36 真机反馈三件 B,用户功能请求):
 * remindComplete 成功后追问一次——确认(保留)= 物品记录原样保留(现状);
 * 取消(删除物品)= 调 itemsApi delete 级联清提醒并软删物品;dismiss
 * (点遮罩/系统返回,fail 回调)= **保留**(安全默认:误触删除不可逆,服务端
 * 虽是软删但客户端无恢复入口;用户原话是「不选择保留就删除」,按防误触
 * 收紧,如需改一行即可)。物品名只出现在用户自己屏幕的 UI 上,绝不进日志。
 */
export function askKeepAfterDone(name: string): Promise<"keep" | "delete" | "dismiss"> {
  const label = name || "这件东西";
  return new Promise((resolve) => {
    wx.showModal({
      title: "已处理",
      content: "「" + label + "」的记录还保留吗?",
      confirmText: "保留",
      cancelText: "删除物品",
      success: (r) => {
        resolve(r.confirm === true ? "keep" : "delete");
      },
      fail: () => {
        resolve("dismiss"); // 调用方按保留处理(安全默认)
      },
    });
  });
}
