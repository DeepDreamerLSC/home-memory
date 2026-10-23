"use strict";

/*
 * 冻结数字解析器(issue #102 / docs/design/quantity/Q0-CONTRACT.md §7.8.2):
 * quantity 意图的唯一数字语义实现点——Q1 的 extractDraft v2 数量三项锚定
 * (validate.js)与 Q2 的 quantityIntentParse 共用,绝不各写一份。
 *
 * 规则(冻结):
 * - 阿拉伯数字串(0-9,十进制,无千分位)或中文数字(一二两三四五六七八九十
 *   及百/千组合:十五、二十三、一百、两千;「两」=2),紧跟一个 UNIT_SET 成员;
 * - 上限 9999;新建数量恒 ≥1(0 解析为失败);小数(「1.5」)、「半」「几」
 *   「一些」「万」位 → 解析失败 → null;
 * - 数字串前紧邻 [0-9.] 时不认(「1.5包」不得被剥成「5包」);
 * - 取 quote 内第一个合法匹配(确定性),调用方再与模型自报值逐项比对。
 * UNIT_SET 与 itemsApi handler / 客户端 utils/quantity.ts 逐字一致(各云函数
 * 独立部署不能跨 require,由测试锁定)。
 */

const QUANTITY_MAX = 9999;
const UNIT_SET = ["件", "个", "包", "盒", "瓶", "袋", "支", "双", "套", "卷", "张", "本", "罐", "只"];

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_MULTIPLIERS = { 十: 10, 百: 100, 千: 1000 };

const NUMBER_TOKEN_RE = /([0-9]+|[零一二两三四五六七八九十百千]+)(件|个|包|盒|瓶|袋|支|双|套|卷|张|本|罐|只)/g;

/* 中文数字 → 整数;非法/空返回 null(不含「万」位,上限由调用方裁) */
function parseChineseNumber(text) {
  if (typeof text !== "string" || text === "") return null;
  let total = 0;
  let pending = 0;
  let sawAny = false;
  for (const ch of text) {
    if (Object.prototype.hasOwnProperty.call(CN_DIGITS, ch)) {
      pending = CN_DIGITS[ch];
      sawAny = true;
    } else if (Object.prototype.hasOwnProperty.call(CN_MULTIPLIERS, ch)) {
      const mul = CN_MULTIPLIERS[ch];
      if (pending === 0 && mul === 10) pending = 1; // 「十五」「十」首位省略「一」
      total += pending * mul;
      pending = 0;
      sawAny = true;
    } else {
      return null;
    }
  }
  if (!sawAny) return null;
  return total + pending;
}

/*
 * 从 quote 解析「数字+单位」:成功返回 { number, unit };失败 null。
 * 只做机械匹配,不理解语义、不推算(「一箱」「一打」「500ml」一律 null)。
 */
function parseQuantityQuote(quote) {
  if (typeof quote !== "string" || quote === "") return null;
  NUMBER_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = NUMBER_TOKEN_RE.exec(quote)) !== null) {
    const prev = match.index > 0 ? quote.charAt(match.index - 1) : "";
    if (/[0-9.]/.test(prev)) {
      continue; // 「1.5包」:「5包」前紧邻小数点,不认
    }
    const token = match[1];
    let number;
    if (/^[0-9]+$/.test(token)) {
      number = Number(token);
    } else {
      number = parseChineseNumber(token);
    }
    if (number === null || !Number.isInteger(number) || number < 1 || number > QUANTITY_MAX) {
      return null;
    }
    return { number, unit: match[2] };
  }
  return null;
}

module.exports = { UNIT_SET, QUANTITY_MAX, parseChineseNumber, parseQuantityQuote };
