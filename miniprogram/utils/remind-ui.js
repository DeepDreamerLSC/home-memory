"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DAILY_SCAN_HOUR = exports.PERIOD_DAYS_MAX = void 0;
exports.localTodayYmd = localTodayYmd;
exports.daysUntilLocal = daysUntilLocal;
exports.dailyScanPassed = dailyScanPassed;
exports.pickerStartYmd = pickerStartYmd;
exports.pickerDateProblem = pickerDateProblem;
exports.duePill = duePill;
exports.monthDayText = monthDayText;
exports.expireMainText = expireMainText;
exports.countDue = countDue;
exports.dueBannerText = dueBannerText;
exports.askUseUp = askUseUp;
exports.askKeepAfterDone = askKeepAfterDone;
const DAY_MS = 86400000;
/** 周期再生的天数上限(与服务端 REMIND_PERIOD_MAX 同源;item 页改期护栏用) */
exports.PERIOD_DAYS_MAX = 3650;
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
/** 每日到期推送扫描的本地小时(remindNotify 定时器 0 0 8 * * * *,Asia/Shanghai) */
exports.DAILY_SCAN_HOUR = 8;
/** 本地「今天 8 点的推送扫描是否已跑过」(2026-10-24 真机教训:08:49 设当天到期永不推送) */
function dailyScanPassed(now = new Date()) {
    return now.getHours() >= exports.DAILY_SCAN_HOUR;
}
/**
 * 提醒日期 picker 的可选起点(真机反馈 2026-10-26):当天 8 点前=今天(今晨扫描
 * 还会扫到它);8 点后=明天——今天的扫描已跑完、明天的窗口又不含今天,
 * 此时设「今天」的提醒永远发不出去,滚轮直接从明天起,把这个坑挡在 UI 外。
 */
function pickerStartYmd(now = new Date()) {
    if (!dailyScanPassed(now))
        return localTodayYmd(now);
    const t = new Date(now.getTime());
    t.setDate(t.getDate() + 1);
    return localTodayYmd(t);
}
/**
 * 改期 picker 的提交前校验(与 pickerStartYmd 的可选范围两端一致):
 * 8 点前今天可设(到期分组里「今天到期」本就存在);8 点后今天拒绝(推送已过);
 * 过去的日子与超 10 年的拒绝。返回可展示的问题文案,空串=可提交。
 */
function pickerDateProblem(value, now = new Date()) {
    const days = daysUntilLocal(value, now);
    if (days < 0) {
        return "选今天或往后的日子";
    }
    if (days === 0 && dailyScanPassed(now)) {
        return "今天 8 点的提醒已经发过了,选明天或往后";
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
/**
 * 「已处理」的确认交互(#36 0.6.0 真机反馈 Fix 2 + 0.7.0 Fix 3 改字样):
 * 完成后不再弹 7/30/90 天等固定周期选项——下次提醒时间由用户自己到详情页
 * 的日期选择器里选日子(服务端 period_days 参数与再生逻辑保留,API 兼容,
 * 客户端不再传)。这里只做一次二次确认(绝不一点就收掉提醒),确认后返回 true;
 * 取消返回 false,页面不动、不写任何数据。按钮字样「已处理」(原「用完了」,
 * 0.7.0 真机反馈:处理不等于用完,扔了/修了也是处理)。
 */
function askUseUp(name) {
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
function askKeepAfterDone(name) {
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
