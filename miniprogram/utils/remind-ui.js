"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PERIOD_DAYS_MAX = void 0;
exports.isPeriodicKind = isPeriodicKind;
exports.localTodayYmd = localTodayYmd;
exports.daysUntilLocal = daysUntilLocal;
exports.pickerDateProblem = pickerDateProblem;
exports.duePill = duePill;
exports.monthDayText = monthDayText;
exports.expireMainText = expireMainText;
exports.countDue = countDue;
exports.dueBannerText = dueBannerText;
exports.askUseUp = askUseUp;
const DAY_MS = 86400000;
/** 周期再生的天数上限(与服务端 REMIND_PERIOD_MAX 同源,超出即拒绝) */
exports.PERIOD_DAYS_MAX = 3650;
/** 周期物品判定:kind=下次维护(维护类周期语义;再生提醒也固定这个 kind) */
function isPeriodicKind(kind) {
    return kind === "下次维护";
}
function pad(n) {
    return n < 10 ? "0" + n : String(n);
}
/** 用户本地自然日今天(YYYY-MM-DD)——家庭提醒日期合同的客户端基准 */
function localTodayYmd(now = new Date()) {
    return (now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()));
}
/** 距本地今天的日历天数(负数=已过期,0=今天) */
function daysUntilLocal(due, now = new Date()) {
    const today = localTodayYmd(now);
    return Math.round((Date.parse(due + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / DAY_MS);
}
/**
 * item 页改期 picker 的提交前校验(与 picker start=今天 的可选范围两端一致):
 * 今天可设(到期分组里「今天到期」本就存在),过去的日子与超 10 年的拒绝。
 * 返回可展示的问题文案,空串=可提交。
 */
function pickerDateProblem(value, now = new Date()) {
    const days = daysUntilLocal(value, now);
    if (days < 0) {
        return "选今天或往后的日子";
    }
    if (days > exports.PERIOD_DAYS_MAX) {
        return "最多记十年内";
    }
    return "";
}
/** 日期胶囊三态文案:已过期(danger)/ N 天后(banner-bg)/ 明年 4 月(card-inset) */
function duePill(due, now = new Date()) {
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
function farDateText(due, now) {
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
function monthDayText(due, now = new Date()) {
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
function expireMainText(due, now = new Date()) {
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
function countDue(reminders, now = new Date()) {
    let overdue = 0;
    let soon = 0;
    for (const r of reminders) {
        const days = daysUntilLocal(r.due_date, now);
        if (days < 0) {
            overdue += 1;
        }
        else if (days <= 7) {
            soon += 1;
        }
    }
    return { overdue, soon };
}
/** 首页横幅文案:「1 件已过期,2 件这几天到期」(只拼非零段) */
function dueBannerText(counts) {
    const parts = [];
    if (counts.overdue > 0) {
        parts.push(counts.overdue + " 件已过期");
    }
    if (counts.soon > 0) {
        parts.push(counts.soon + " 件这几天到期");
    }
    return parts.join(",");
}
/** 周期选项(「用完了」后问下次时间用;天数口径与服务端再生规则一致) */
const PERIOD_CHOICES = [
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
function askUseUp(name, kind) {
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
