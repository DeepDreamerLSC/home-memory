"use strict";

/*
 * validateDraft(rawText, originalText) —— 协议 v1(旧客户端):单件草稿。
 * validateDrafts(rawText, originalText) —— 协议 v2(protocol:2):多件草稿数组。
 * 返回四种结果:
 *   { ok:false, retryable:true, reason }                     —— JSON 解析失败(handler 会带错误重试一次)
 *   { ok:true, needs_split:true, message }                   —— v1:一句话含多件物品(v2 不再返回此形态)
 *   { ok:false, error:"AI_UNAVAILABLE" }                     —— 名称/长度/类型等硬校验失败
 *   { ok:true, draft:{...} } / { ok:true, drafts:[{...}] }   —— 成功
 * 修正规则(契约 docs/API_CONTRACT.md「extractDraft 协议」):
 *   - certain 为 false 时强制 location_text 为空字符串(幻觉防护);
 *   - certain 为 true 但 location_text 为空则按不肯定处理(certain 置 false);
 *   - name 去空白后为空返回 AI_UNAVAILABLE;name > 50 字、location_text > 200 字、
 *     qualifier 单项 > 20 字、字段类型不符一律拒绝;
 *   - 仅允许对 qualifiers 数量截断(最多 5 个);
 *   - v2:items 数组 1-5 件,超限或为空返回 AI_UNAVAILABLE(重试机制兜底);
 *   - v2:source_quote 必须是原话的逐字子串(去空白比对),不是则置空字符串
 *     (证据缺失标记,不废整件——位置/名称仍按上述规则校验)。
 *   - v2:提醒候选三项 remind_at(YYYY-MM-DD)/remind_kind(有效期|开封后|下次维护)/
 *     remind_quote(日期在原话中的逐字子串)同现同缺;任一项缺失、类型不符、
 *     日期非合法日历日、类别越界或 quote 锚定失败,三项整体置 null
 *     (#36 冻结纪律:锚定失败=不带提醒,绝不废件、绝不半带)。
 *     锚定是双重的:quote 必须是原话逐字子串,且 quote 里必须真的说了
 *     remind_at 这个日期(显式年份原样、无年份按最近未来补全;模糊表述
 *     解析不出任何日期候选,折算值/无关日期对不上候选,同样三项全 null;
 *     显式年份片段遮蔽后无年份正则不得二次剥取,PR #52 B2)。
 *   - v2:日期归属限定(PR #52 B3,多件保守门):多件时任一件的 remind_quote
 *     还必须落在该件自己的 source_quote 内、且不与其他物品竞争该日期段,
 *     否则该件三项全 null(物品照常提取,日期由用户在详情页自己补)。
 */

const NAME_MAX = 50;
const LOCATION_MAX = 200;
const QUALIFIER_MAX = 20;
const QUALIFIERS_MAX = 5;
const QUOTE_MAX = 200;
const ITEMS_MAX = 5;
const REMIND_QUOTE_MAX = 200;
const REMIND_KINDS = ["有效期", "开封后", "下次维护"];
const REMIND_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/* quote 内绝对日期的原话形态:显式年份(2027年6月30号)、无年份(11月20号)、
 * ISO(2026-11-20)。只认阿拉伯数字——中文数字日期(「十一月二十号」)解析不出
 * 候选,按锚定失败处理(不带提醒,日期由用户在确认页自己选)。 */
const REMIND_QUOTE_FULL_DATE_RE = /(\d{4})年(\d{1,2})月(\d{1,2})[号日]/g;
const REMIND_QUOTE_MD_DATE_RE = /(\d{1,2})月(\d{1,2})[号日]/g;
const REMIND_QUOTE_ISO_DATE_RE = /(\d{4})-(\d{1,2})-(\d{1,2})/g;

const SPLIT_MESSAGE = "一次只记一件物品,请分开说";

function codePointLength(s) {
  return Array.from(s).length;
}

function stripWhitespace(s) {
  return s.replace(/\s+/g, "");
}

function unavailable() {
  return { ok: false, error: "AI_UNAVAILABLE" };
}

/* YYYY-MM-DD 且为真实存在的日历日(如 2026-02-30 非法)。 */
function isValidCalendarDate(date) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function pad2(n) {
  return n < 10 ? "0" + String(n) : String(n);
}

/* 当前本地日期 YYYY-MM-DD:无年份日期补全的兜底基准(handler 正常注入 prompt 同款今天)。 */
function localTodayYmd() {
  const d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

/*
 * 从 quote 里解析出全部绝对日期候选(YYYY-MM-DD 字符串数组):
 * - 显式年份(2027年6月30号 / 2026-11-20):按原样归一;
 * - 无年份(11月20号):按【今天】补全为最近的未来日期——今年的该月该日
 *   已过则用下一年,与 prompt 告诉模型的补全规则同款(today 非法时兜底
 *   当前本地日期,绝不抛错);
 * - 显式年份片段遮蔽(PR #52 复审 B2):已被显式年份提法占据的片段不再
 *   参与无年份二次匹配——「2028年11月20号」只产出 2028-11-20 一个候选,
 *   绝不再从同段剥出「11月20号」补全成今年,让模型违规折报的
 *   2026-11-20 错误通过对应锚定;
 * - 月/日越界的提法(13月/32号)构造不出合法候选,自然锚定失败;
 * - 模糊/相对表述(「下个月」「快过期了」「到2027年3月」)解析不出任何候选。
 */
function quoteDateCandidates(quote, todayYmd) {
  const today = REMIND_DATE_RE.test(todayYmd) ? todayYmd : localTodayYmd();
  const out = [];
  const pushWithYear = (year, month, day) => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return;
    out.push(year + "-" + pad2(month) + "-" + pad2(day));
  };
  // 已被显式年份提法占据的 [start, end) 片段:无年份匹配与之重叠即跳过
  const masked = [];
  const overlapsMasked = (start, end) =>
    masked.some(([ms, me]) => start < me && ms < end);
  let match;
  REMIND_QUOTE_FULL_DATE_RE.lastIndex = 0;
  while ((match = REMIND_QUOTE_FULL_DATE_RE.exec(quote)) !== null) {
    pushWithYear(Number(match[1]), Number(match[2]), Number(match[3]));
    masked.push([match.index, match.index + match[0].length]);
  }
  REMIND_QUOTE_ISO_DATE_RE.lastIndex = 0;
  while ((match = REMIND_QUOTE_ISO_DATE_RE.exec(quote)) !== null) {
    pushWithYear(Number(match[1]), Number(match[2]), Number(match[3]));
    masked.push([match.index, match.index + match[0].length]);
  }
  REMIND_QUOTE_MD_DATE_RE.lastIndex = 0;
  while ((match = REMIND_QUOTE_MD_DATE_RE.exec(quote)) !== null) {
    if (overlapsMasked(match.index, match.index + match[0].length)) {
      continue; // 显式年份片段的内部再匹配:遮蔽,不产出候选
    }
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const thisYear = Number(today.slice(0, 4));
    const thisYearDate = thisYear + "-" + pad2(month) + "-" + pad2(day);
    if (thisYearDate >= today) {
      out.push(thisYearDate);
    } else {
      out.push(thisYear + 1 + "-" + pad2(month) + "-" + pad2(day));
    }
  }
  return out;
}

/*
 * 提醒候选三项校验(v2,#36 冻结日期纪律的服务端硬门):
 * remind_at 缺失/null → 三项全 null(没有「只带类别不带日期」或「只带日期不锚定」的半态);
 * remind_at 类型/格式/日历非法、remind_kind 越界、remind_quote 缺失/超长/非原话逐字子串
 * → 同样三项全 null(锚定失败=不带,不废件;名称与位置契约不受影响)。
 * 双重锚定:逐字子串之外,quote 内还必须解析得出 remind_at 这个日期——
 * 模型把模糊表述折算成日期(quote=「下个月」+折算值)、或配一个与 quote
 * 无关的日期,都过不了这道门,同样三项全 null。
 */
function validateReminderFields(item, normalizedOriginal, todayYmd) {
  const none = { remind_at: null, remind_kind: null, remind_quote: null };
  const has = (key) => Object.prototype.hasOwnProperty.call(item, key);
  if (!has("remind_at") || item.remind_at === null || item.remind_at === undefined) {
    return none;
  }
  if (typeof item.remind_at !== "string") return none;
  const date = item.remind_at.trim();
  if (!REMIND_DATE_RE.test(date) || !isValidCalendarDate(date)) return none;
  if (!has("remind_kind") || REMIND_KINDS.indexOf(item.remind_kind) === -1) return none;
  if (!has("remind_quote") || typeof item.remind_quote !== "string") return none;
  const quote = stripWhitespace(item.remind_quote);
  if (quote === "" || codePointLength(quote) > REMIND_QUOTE_MAX) return none;
  // 逐字锚定:日期证据必须是原话子串(去空白比对,同 source_quote 口径)。
  if (normalizedOriginal.indexOf(quote) === -1) return none;
  // 对应锚定:quote 里必须真的说了这个日期(候选集合含 quote 内全部绝对日期
  // 提法,无年份按最近未来补全)。折算值/编造值/月份精度对不上 → 三项全 null。
  if (quoteDateCandidates(quote, todayYmd).indexOf(date) === -1) return none;
  return { remind_at: date, remind_kind: item.remind_kind, remind_quote: item.remind_quote.trim() };
}

/*
 * 从模型原始输出中提取 JSON 对象:
 * 先整体解析,失败则截取第一个 "{" 到最后一个 "}" 之间的内容再解析
 * (容忍 markdown 围栏与前后废话);仍失败返回 undefined。
 */
function extractJsonObject(rawText) {
  if (typeof rawText !== "string") return undefined;
  const trimmed = rawText.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    /* 继续尝试截取 */
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last <= first) return undefined;
  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch (e) {
    return undefined;
  }
}

/*
 * 单件草稿的字段校验与修正(v1/v2 共用):
 * 返回 { ok:true, draft } 或 { ok:false, error:"AI_UNAVAILABLE" }。
 */
function validateItemFields(item) {
  const has = (key) => Object.prototype.hasOwnProperty.call(item, key);

  if (!has("name") || typeof item.name !== "string") return unavailable();
  const name = stripWhitespace(item.name);
  if (name === "" || codePointLength(name) > NAME_MAX) return unavailable();

  let certain = false;
  if (has("certain")) {
    if (typeof item.certain !== "boolean") return unavailable();
    certain = item.certain;
  }

  let locationText = "";
  if (has("location_text")) {
    if (typeof item.location_text !== "string") return unavailable();
    locationText = stripWhitespace(item.location_text);
    if (codePointLength(locationText) > LOCATION_MAX) return unavailable();
  }

  let qualifiers = [];
  if (has("qualifiers")) {
    if (!Array.isArray(item.qualifiers)) return unavailable();
    const cleaned = [];
    for (const entry of item.qualifiers) {
      if (typeof entry !== "string") return unavailable();
      const qualifier = stripWhitespace(entry);
      if (codePointLength(qualifier) > QUALIFIER_MAX) return unavailable();
      if (qualifier !== "") cleaned.push(qualifier);
    }
    qualifiers = cleaned.slice(0, QUALIFIERS_MAX);
  }

  // 修正规则:certain 为 false 强制空位置;certain 为 true 但位置为空按不肯定。
  if (!certain) {
    locationText = "";
  } else if (locationText === "") {
    certain = false;
  }

  return { ok: true, draft: { name, location_text: locationText, certain, qualifiers } };
}

function validateDraft(rawText, originalText) {
  const parsed = extractJsonObject(rawText);
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return { ok: false, retryable: true, reason: "输出不是合法的 JSON 对象" };
  }
  const has = (key) => Object.prototype.hasOwnProperty.call(parsed, key);

  // needs_split 为 true 时优先返回拆分提示,不再校验其余字段。
  if (has("needs_split")) {
    if (typeof parsed.needs_split !== "boolean") return unavailable();
    if (parsed.needs_split) {
      return { ok: true, needs_split: true, message: SPLIT_MESSAGE };
    }
  }

  const result = validateItemFields(parsed);
  if (!result.ok) return result;
  return { ok: true, draft: result.draft };
}

/*
 * 协议 v2:模型输出 { items: [ { name, location_text, certain, qualifiers, source_quote } ], has_more }。
 * source_quote 非原话子串时置空(证据缺失),其余字段按单件规则校验;
 * has_more 为 true 表示原话超过 5 件被截取前 5(绝不静默:透传 truncated 由确认页引导分批)。
 * todayYmd(handler 注入 prompt 同款今天,YYYY-MM-DD):提醒 quote 对应锚定里
 * 无年份日期的补全基准;缺省/非法时用当前本地日期,不影响其余契约。
 */
function validateDrafts(rawText, originalText, todayYmd) {
  const parsed = extractJsonObject(rawText);
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return { ok: false, retryable: true, reason: "输出不是合法的 JSON 对象" };
  }
  if (!Array.isArray(parsed.items) || parsed.items.length < 1) {
    return unavailable();
  }
  if (parsed.items.length > ITEMS_MAX) {
    return unavailable();
  }
  let hasMore = false;
  if (Object.prototype.hasOwnProperty.call(parsed, "has_more")) {
    if (typeof parsed.has_more !== "boolean") return unavailable();
    hasMore = parsed.has_more;
  }
  const normalizedOriginal = stripWhitespace(String(originalText || ""));
  const drafts = [];
  for (const item of parsed.items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return unavailable();
    }
    const result = validateItemFields(item);
    if (!result.ok) return result;

    let sourceQuote = "";
    if (Object.prototype.hasOwnProperty.call(item, "source_quote")) {
      if (typeof item.source_quote !== "string") return unavailable();
      const quote = stripWhitespace(item.source_quote);
      if (codePointLength(quote) > QUOTE_MAX) return unavailable();
      // 证据校验:必须是原话逐字子串(去空白比对);不是则置空,由确认页标「来源不充分」。
      if (quote !== "" && normalizedOriginal.indexOf(quote) !== -1) {
        sourceQuote = item.source_quote.trim();
      }
    }

    // 位置锚定校验(确定性的归属防线,合法片段不得为错误配对背书):
    // certain=true 时位置必须出现在其证据片段内(source_quote 为空时退而要求在原话内),
    // 否则按「不肯定」降级——位置清空,交确认页让用户补,不废件也不放行。
    let draft = result.draft;
    if (draft.certain && draft.location_text !== "") {
      const normalizedQuote = stripWhitespace(sourceQuote);
      const anchor = normalizedQuote !== "" ? normalizedQuote : normalizedOriginal;
      if (anchor.indexOf(draft.location_text) === -1) {
        draft = Object.assign({}, draft, { certain: false, location_text: "" });
      }
    }
    drafts.push(
      Object.assign(
        {},
        draft,
        { source_quote: sourceQuote },
        validateReminderFields(item, normalizedOriginal, todayYmd),
      ),
    );
  }
  // 日期归属限定(PR #52 复审 B3,保守门,仅多件时):remind_quote 只要求在
  // 整句原话中,模型可把 A 物品的日期赋给 B(锚定两道门都过,一键确认即错误
  // 提醒)。多件时仅当该件有单件可验证的日期归属证据才携带提醒:remind_quote
  // 必须落在该件自己的 source_quote 内,且不与其他物品竞争该日期段(日期证据
  // 同时落在别的物品的证据片段里 = 共享锚/交叉,无法判明归属)。判不明 →
  // 三项全 null,该物品照常提取,日期由用户以后在详情页自己补。单件不受影响
  // (日期不可能属于别的物品)。
  if (drafts.length > 1) {
    const normalizedSources = drafts.map((d) => stripWhitespace(d.source_quote));
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      if (d.remind_at === null) continue;
      const dateQuote = stripWhitespace(d.remind_quote);
      const own = normalizedSources[i];
      let keep =
        dateQuote !== "" && own !== "" && own.indexOf(dateQuote) !== -1;
      if (keep) {
        keep = !drafts.some(
          (_other, j) =>
            j !== i &&
            normalizedSources[j] !== "" &&
            normalizedSources[j].indexOf(dateQuote) !== -1,
        );
      }
      if (!keep) {
        d.remind_at = null;
        d.remind_kind = null;
        d.remind_quote = null;
      }
    }
  }
  // 锚定共享标记:证据片段同时含其他物品的名称(典型:模型把整句原话当 quote,
  // 多件多位置都在其中,交叉配对无法排除)——这类候选必须人工核对,
  // 前端默认不勾选。专属片段(只含本件名称)锚定可信,可默认勾选。
  for (const d of drafts) {
    const normalizedQuote = stripWhitespace(d.source_quote);
    d.anchor_shared =
      normalizedQuote !== "" &&
      drafts.some(
        (other) =>
          other !== d &&
          other.name !== d.name &&
          other.name.length >= 2 &&
          normalizedQuote.indexOf(other.name) !== -1,
      );
  }
  return { ok: true, drafts, truncated: hasMore };
}

module.exports = { validateDraft, validateDrafts };
