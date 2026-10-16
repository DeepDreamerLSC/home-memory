"use strict";

/*
 * 相对时间换算器(#36 真机反馈三件 A,产品拍板:产品换算,用户只确认)。
 * convertRelativeQuote(quote, todayYmd) → "YYYY-MM-DD" | null:
 * 只换算**带明确数量锚的闭集模式**,换算结果是确认卡上的候选(用户可改可清,
 * 延续「不猜日期」的确认纪律);闭集之外(无数量锚/模糊/月精度/周期/需基准日
 * 换算)一律返回 null,灰行「时间没换算」保持诚实。
 *
 * 闭集(2026-10 三件 A 冻结):
 * - 「明天」「后天」「大后天」:今天 +1/+2/+3 天(纯天数加);
 * - 「N天/N周/N个月/N月 + 后(之後/以后)」:N 为阿拉伯数字或中文数字
 *   (一二两三四五六七八九十,支持组合如十五、二十、二十五);天/周按纯天数加,
 *   个月/月按月算术(同日+N月,月末 clamp:2026-10-31+6月→2027-04-30,
 *   绝不编造不存在的日历日);
 * - 「半个月后」= +15 天(纯天数加)、「半年后」= +6 个月(月算术);
 *   「半天」舍(闭集明确不用);
 * - 总天数护栏:<1(今天/过去)或 >3650(十年,与 itemsApi REMIND_PERIOD_MAX
 *   同源)返回 null;
 * - 模式不匹配返回 null——**不做**「下个月」「下周」这类无数量锚的换算。
 *
 * 纯函数:quote 非字符串/空、todayYmd 非 YYYY-MM-DD 真实日历日 → null,
 * 绝不抛错、绝不退回「当前时间」猜锚点(锚点必须由调用方显式给)。
 */

var YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
var DAY_MS = 24 * 60 * 60 * 1000;
var TZ_SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
/** 总天数护栏上界(十年;与 itemsApi 的 REMIND_PERIOD_MAX 同源) */
var MAX_DAYS = 3650;
/** 中文数字闭集(仅个位与十位组合,一二两三四五六七八九十) */
var CN_DIGITS = { "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };

function pad2(n) {
  return n < 10 ? "0" + String(n) : String(n);
}

function daysInMonth(year, month) {
  var leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** YYYY-MM-DD 且为真实日历日 */
function isValidYmd(s) {
  if (typeof s !== "string" || !YMD_RE.test(s)) {
    return false;
  }
  var year = Number(s.slice(0, 4));
  var month = Number(s.slice(5, 7));
  var day = Number(s.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  return day <= daysInMonth(year, month);
}

/** 纯天数加(UTC 日历日算术,跨月/跨年自然进位;与 itemsApi addDays 同口径) */
function addDaysYmd(ymd, days) {
  var t = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  var d = new Date(t + days * DAY_MS);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

/** 月算术:同日 +N 月,目标月天数不足时 clamp 到月末(绝不编造日历日) */
function addMonthsClampYmd(ymd, months) {
  var year = Number(ymd.slice(0, 4));
  var month = Number(ymd.slice(5, 7));
  var day = Number(ymd.slice(8, 10));
  var total = year * 12 + (month - 1) + months;
  var ny = Math.floor(total / 12);
  var nm = (total % 12) + 1;
  return ny + "-" + pad2(nm) + "-" + pad2(Math.min(day, daysInMonth(ny, nm)));
}

/** 两个 YYYY-MM-DD 的日历日差(今天到结果的总天数,护栏判定用) */
function diffDays(fromYmd, toYmd) {
  var from = Date.UTC(Number(fromYmd.slice(0, 4)), Number(fromYmd.slice(5, 7)) - 1, Number(fromYmd.slice(8, 10)));
  var to = Date.UTC(Number(toYmd.slice(0, 4)), Number(toYmd.slice(5, 7)) - 1, Number(toYmd.slice(8, 10)));
  return Math.round((to - from) / DAY_MS);
}

/**
 * 中文数字(闭集:个位与十位组合,如 三/十五/二十/二十五/两)→ 数值;
 * 形状外(空/含闭集外字符/超两位)返回 null。
 */
function parseChineseNumber(s) {
  if (typeof s !== "string" || s === "" || s.length > 3) {
    return null;
  }
  for (var i = 0; i < s.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(CN_DIGITS, s[i]) && s[i] !== "十") {
      return null;
    }
  }
  var tenIdx = s.indexOf("十");
  if (tenIdx === -1) {
    return s.length === 1 ? CN_DIGITS[s] : null; // 组合无「十」(如「二五」)不认
  }
  if (s.indexOf("十", tenIdx + 1) !== -1) {
    return null; // 多个「十」(二十十四这类畸形)不认
  }
  var before = s.slice(0, tenIdx);
  var after = s.slice(tenIdx + 1);
  var tens = before === "" ? 1 : CN_DIGITS[before];
  if (tens === undefined) {
    return null;
  }
  if (after === "") {
    return tens * 10;
  }
  if (after.length !== 1) {
    return null;
  }
  var ones = CN_DIGITS[after];
  if (ones === undefined) {
    return null;
  }
  return tens * 10 + ones;
}

/* 明天/后天/大后天(大后天在前,防被「后天」前缀吞掉;锚点即数量,无后缀) */
var DAY_AFTER_RE = /大后天|后天|明天/;
/* N + 单位 + 后缀:单位仅 天/周/个月/月;后缀 后/之後/以后 */
var N_UNIT_AFTER_RE = /([0-9]+|[一二两三四五六七八九十]{1,3})(个月|月|天|周)(之後|以后|后)/;
/* 半 的闭集特例:半个月 = 15 天、半年 = +6 月;其余「半」一律不换算 */
var HALF_MONTH_RE = /半个月(之後|以后|后)/;
var HALF_YEAR_RE = /半年(之後|以后|后)/;

/**
 * 把 vague 原文(原话子串,如「半年后」「十五天后」「大后天」)换算为具体日期。
 * 返回 YYYY-MM-DD;闭集外/越界/形状非法一律 null(调用方维持灰行现状)。
 */
function convertRelativeQuote(quote, todayYmd) {
  if (typeof quote !== "string" || quote === "" || !isValidYmd(todayYmd)) {
    return null;
  }
  var result = null;

  var dayAfter = quote.match(DAY_AFTER_RE);
  if (dayAfter !== null) {
    var plus = dayAfter[0] === "明天" ? 1 : dayAfter[0] === "后天" ? 2 : 3;
    result = addDaysYmd(todayYmd, plus);
  }

  if (result === null) {
    var halfMonth = quote.match(HALF_MONTH_RE);
    if (halfMonth !== null) {
      result = addDaysYmd(todayYmd, 15); // 半个月 = 15 天(纯天数加)
    }
  }

  if (result === null) {
    var halfYear = quote.match(HALF_YEAR_RE);
    if (halfYear !== null) {
      result = addMonthsClampYmd(todayYmd, 6); // 半年 = +6 个月(月算术)
    }
  }

  if (result === null) {
    var m = quote.match(N_UNIT_AFTER_RE);
    if (m !== null) {
      var n = /^[0-9]+$/.test(m[1]) ? Number(m[1]) : parseChineseNumber(m[1]);
      if (n !== null && n >= 0) {
        if (m[2] === "天") {
          result = addDaysYmd(todayYmd, n);
        } else if (m[2] === "周") {
          result = addDaysYmd(todayYmd, n * 7);
        } else {
          result = addMonthsClampYmd(todayYmd, n); // 个月 / 月:月算术 + 月末 clamp
        }
      }
    }
  }

  if (result === null) {
    return null;
  }
  var days = diffDays(todayYmd, result);
  if (days < 1 || days > MAX_DAYS) {
    return null; // 今天/过去与超十年:闭集护栏,维持灰行
  }
  return result;
}

/**
 * 服务端今天(Asia/Shanghai 自然日,UTC+8 固定偏移,中国无夏令时)——
 * 换算锚点:提取时刻的北京日期,与 remindNotify 到期窗口同口径,
 * 绝不按云函数运行时区(默认 UTC)把北京的「今天」折早一天。
 */
function shanghaiTodayYmd(now) {
  var t = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(t)) {
    return null;
  }
  var d = new Date(t + TZ_SHANGHAI_OFFSET_MS);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

module.exports = {
  convertRelativeQuote: convertRelativeQuote,
  shanghaiTodayYmd: shanghaiTodayYmd,
};
