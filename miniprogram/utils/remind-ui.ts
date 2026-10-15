/**
 * 提醒的查看与处理(issue #36 三阶段)——R1 快到期页 / 首页到期横幅 /
 * 详情页保质期行共用的展示与「用完了」流程。
 *
 * 日期纪律(#36 冻结 + PR #52 Low-3 合同)在展示侧的口径:
 * - 家庭提醒日期一律按用户本地自然日:分组界线与「还剩几天」按用户本地
 *   日历日计算(已过期 = due < 今天;这几天 = 7 天内含今天;再往后 = 其余);
 * - 「用完了」的完成日与周期天数也以用户本地自然日为可信输入随请求携带
 *   (complete_date),服务端不靠运行时区猜;item 页改期 picker 的可选范围
 *   (今天可选)与提交前校验(今天可设)两端一致;
 * - 只对服务端下发的 YYYY-MM-DD 做日历日算术,绝不解析模糊表述、
 *   绝不从文本推算日期;到期只在小程序内露出,无任何推送/通知承诺。
 */
import type { RemindRow } from "../types";

const DAY_MS = 86400000;
/** 周期再生的天数上限(与服务端 REMIND_PERIOD_MAX 同源,超出即拒绝) */
export const PERIOD_DAYS_MAX = 3650;

/** 周期物品判定:kind=下次维护(维护类周期语义;再生提醒也固定这个 kind) */
export function isPeriodicKind(kind: string): boolean {
  return kind === "下次维护";
}

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

/**
 * item 页改期 picker 的提交前校验(与 picker start=今天 的可选范围两端一致):
 * 今天可设(到期分组里「今天到期」本就存在),过去的日子与超 10 年的拒绝。
 * 返回可展示的问题文案,空串=可提交。
 */
export function pickerDateProblem(value: string, now: Date = new Date()): string {
  const days = daysUntilLocal(value, now);
  if (days < 0) {
    return "选今天或往后的日子";
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

/** 「用完了」下一步的用户决定:null=取消;periodDays=null=不定下次;正数=周期天数 */
export interface UseUpDecision {
  periodDays: number | null;
}

/** 周期选项(「用完了」后问下次时间用;天数口径与服务端再生规则一致) */
const PERIOD_CHOICES: ReadonlyArray<{ label: string; days: number }> = [
  { label: "7 天后", days: 7 },
  { label: "30 天后", days: 30 },
  { label: "90 天后", days: 90 },
  { label: "半年后", days: 180 },
  { label: "一年后", days: 365 },
];

/**
 * 「用完了」两步确认(R1 行上与详情页保质期行共用):
 * 1) 先确认(绝不一点就收掉提醒);
 * 2) 周期物品(kind=下次维护)再问下次时间——选项式周期(原生 action sheet,
 *    无自由文本,不违背日期纪律);「不定下次时间」= 收掉后不再生。
 * 用户任一步取消 → null,页面不动、不写任何数据。
 */
export function askUseUp(
  name: string,
  kind: string,
): Promise<UseUpDecision | null> {
  const label = name || "这件东西";
  return new Promise((resolve) => {
    wx.showModal({
      title: "用完了吗",
      content: "把「" + label + "」这次的到期提醒收掉。",
      confirmText: "用完了",
      cancelText: "取消",
      success: (r) => {
        if (!r.confirm) {
          resolve(null);
          return;
        }
        if (!isPeriodicKind(kind)) {
          resolve({ periodDays: null });
          return;
        }
        wx.showActionSheet({
          alertText: "「" + label + "」下次什么时候到期?",
          itemList: PERIOD_CHOICES.map((c) => c.label).concat(["不定下次时间"]),
          success: (a) => {
            const choice = PERIOD_CHOICES[a.tapIndex];
            resolve(choice ? { periodDays: choice.days } : { periodDays: null });
          },
          fail: () => {
            // 收起选项 = 整个流程取消(要「不定下次」有明确那一项),不写任何数据
            resolve(null);
          },
        });
      },
      fail: () => resolve(null),
    });
  });
}
