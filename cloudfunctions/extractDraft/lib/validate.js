"use strict";

/*
 * validateDraft(rawText, originalText):对模型原始输出文本做服务端校验与修正。
 * 返回四种结果:
 *   { ok:false, retryable:true, reason }                     —— JSON 解析失败(handler 会带错误重试一次)
 *   { ok:true, needs_split:true, message }                   —— 一句话含多件物品
 *   { ok:false, error:"AI_UNAVAILABLE" }                     —— 名称/长度/类型等硬校验失败
 *   { ok:true, draft:{ name, location_text, certain, qualifiers } }
 * 修正规则(契约 docs/API_CONTRACT.md「extractDraft 协议」):
 *   - certain 为 false 时强制 location_text 为空字符串(幻觉防护);
 *   - certain 为 true 但 location_text 为空则按不肯定处理(certain 置 false);
 *   - name 去空白后为空返回 AI_UNAVAILABLE;name > 50 字、location_text > 200 字、
 *     qualifier 单项 > 20 字、字段类型不符一律拒绝;
 *   - 仅允许对 qualifiers 数量截断(最多 5 个)。
 * originalText 按契约签名保留;当前校验规则不依赖原文包含性检查,
 * 「位置必须来自原文」由 system prompt 约束模型,服务端以 certain 规则兜底。
 */

const NAME_MAX = 50;
const LOCATION_MAX = 200;
const QUALIFIER_MAX = 20;
const QUALIFIERS_MAX = 5;

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

  // name:必为字符串,去所有空白后 1-50 字。
  if (!has("name") || typeof parsed.name !== "string") return unavailable();
  const name = stripWhitespace(parsed.name);
  if (name === "" || codePointLength(name) > NAME_MAX) return unavailable();

  // certain:缺省按 false(不确定)处理;出现则必须是布尔。
  let certain = false;
  if (has("certain")) {
    if (typeof parsed.certain !== "boolean") return unavailable();
    certain = parsed.certain;
  }

  // location_text:可为空;出现则必须是字符串,去所有空白后 ≤200 字。
  let locationText = "";
  if (has("location_text")) {
    if (typeof parsed.location_text !== "string") return unavailable();
    locationText = stripWhitespace(parsed.location_text);
    if (codePointLength(locationText) > LOCATION_MAX) return unavailable();
  }

  // qualifiers:字符串数组;单项去空白后 ≤20 字;数量超过 5 截断(唯一允许的截断)。
  let qualifiers = [];
  if (has("qualifiers")) {
    if (!Array.isArray(parsed.qualifiers)) return unavailable();
    const cleaned = [];
    for (const item of parsed.qualifiers) {
      if (typeof item !== "string") return unavailable();
      const qualifier = stripWhitespace(item);
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

  return {
    ok: true,
    draft: { name, location_text: locationText, certain, qualifiers },
  };
}

module.exports = { validateDraft };
