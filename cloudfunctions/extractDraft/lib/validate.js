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
 */

const NAME_MAX = 50;
const LOCATION_MAX = 200;
const QUALIFIER_MAX = 20;
const QUALIFIERS_MAX = 5;
const QUOTE_MAX = 200;
const ITEMS_MAX = 5;

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
 */
function validateDrafts(rawText, originalText) {
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
    drafts.push(Object.assign({}, result.draft, { source_quote: sourceQuote }));
  }
  return { ok: true, drafts, truncated: hasMore };
}

module.exports = { validateDraft, validateDrafts };
