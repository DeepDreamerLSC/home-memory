"use strict";

/**
 * LLM 输出 schema 校验与有序锚定(docs/design/location-tree.md §5.2/§5.9/§6)。
 * 纯函数:不做 IO、不读 db;既有树比对与 merge_suggestions 存在性校验在 lib/parse.js。
 * 三类返回:
 *   { ok:false, retryable:true, reason }   —— JSON 解析失败(handler 带错误重试一次)
 *   { ok:false, error:"AI_UNAVAILABLE" }   —— 形状/长度/类型硬校验失败
 *   { ok:true, ... }                        —— 清洗后的结构化输出
 * 有序不重叠锚定:每段在 normalizeName(原文) 中按顺序游标匹配——
 * 首段从头找,后续段从前一段区间之后找;能找到但按序找不到 = 错序(order_violation),
 * 全文都找不到 = 编造(未锚定);二者都强制 need_confirm(防火墙,§6.4)。
 */

var normalizeName = require("./normalize").normalizeName;

var SEGMENTS_MIN = 1;
var SEGMENTS_MAX = 6;
var SEGMENT_NAME_MAX = 30;

function codePointLength(s) {
  return Array.from(s).length;
}

function unavailable() {
  return { ok: false, error: "AI_UNAVAILABLE" };
}

/*
 * 从模型原始输出中提取 JSON 对象(照抄 extractDraft/lib/validate.js:44-61):
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

/**
 * 清洗单段:{ name(去首尾空白), confidence },type 一律按深度修正(唯一允许的修正)。
 * 返回 null 表示硬失败(name 非字符串/去空白后为空/超 30 码点、confidence 非 [0,1] 数值)。
 */
function cleanSegment(seg, depth) {
  if (!seg || typeof seg !== "object" || Array.isArray(seg)) {
    return null;
  }
  if (typeof seg.name !== "string") {
    return null;
  }
  var name = seg.name.trim();
  if (codePointLength(name) < 1 || codePointLength(name) > SEGMENT_NAME_MAX) {
    return null;
  }
  var confidence = seg.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }
  var type = depth === 1 ? "room" : depth === 2 ? "furniture" : "container";
  return { name: name, type: type, confidence: confidence };
}

/** 清洗后的段数组;任一段硬失败返回 null */
function cleanSegments(rawSegments) {
  if (!Array.isArray(rawSegments)) {
    return null;
  }
  if (rawSegments.length < SEGMENTS_MIN || rawSegments.length > SEGMENTS_MAX) {
    return null;
  }
  var out = [];
  for (var i = 0; i < rawSegments.length; i++) {
    var cleaned = cleanSegment(rawSegments[i], i + 1);
    if (cleaned === null) {
      return null;
    }
    out.push(cleaned);
  }
  return out;
}

/**
 * 有序不重叠锚定:segments 为清洗后的段数组,originalText 为该条位置原文。
 * 返回 { anchored:[bool], present:[bool], order_violation:bool }。
 * - anchored[i]:按顺序游标在 normalizeName(原文) 中锚定成功
 * - present[i]:全文(不按序)中找得到该段(找到但错序 → present 且 !anchored)
 * - order_violation:存在「找得到但按序锚定失败」的段(高置信错序也强制人工确认)
 */
function anchorSegments(segments, originalText) {
  var textNorm = normalizeName(originalText);
  var anchored = [];
  var present = [];
  var orderViolation = false;
  var cursor = 0;
  for (var i = 0; i < segments.length; i++) {
    var segNorm = normalizeName(segments[i].name);
    if (segNorm === "") {
      anchored.push(false);
      present.push(false);
      continue;
    }
    var pos = textNorm.indexOf(segNorm, cursor);
    if (pos !== -1) {
      anchored.push(true);
      present.push(true);
      cursor = pos + segNorm.length;
      continue;
    }
    var anywhere = textNorm.indexOf(segNorm) !== -1;
    anchored.push(false);
    present.push(anywhere);
    if (anywhere) {
      orderViolation = true;
    }
  }
  return { anchored: anchored, present: present, order_violation: orderViolation };
}

/**
 * parseLocation 输出校验:{ segments:[{name,type,confidence}], merge_suggestions:[{segment_index,name,reason}], uncertain:bool }
 * merge_suggestions 只做形状清洗(非法项丢弃、不失败),存在性校验与自动补全在 parse.js。
 */
function validateParseOutput(rawText, originalText) {
  const parsed = extractJsonObject(rawText);
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, retryable: true, reason: "输出不是合法的 JSON 对象" };
  }
  var segments = cleanSegments(parsed.segments);
  if (segments === null) {
    return unavailable();
  }
  var uncertain = false;
  if (parsed.uncertain !== undefined) {
    if (typeof parsed.uncertain !== "boolean") {
      return unavailable();
    }
    uncertain = parsed.uncertain;
  }
  var suggestions = [];
  if (parsed.merge_suggestions !== undefined) {
    if (!Array.isArray(parsed.merge_suggestions)) {
      return unavailable();
    }
    for (var i = 0; i < parsed.merge_suggestions.length; i++) {
      var s = parsed.merge_suggestions[i];
      if (!s || typeof s !== "object" || Array.isArray(s)) {
        continue;
      }
      if (!Number.isInteger(s.segment_index) || s.segment_index < 0 || s.segment_index >= segments.length) {
        continue;
      }
      if (typeof s.name !== "string") {
        continue;
      }
      var name = s.name.trim();
      if (codePointLength(name) < 1 || codePointLength(name) > SEGMENT_NAME_MAX) {
        continue;
      }
      var reason = typeof s.reason === "string" && s.reason.trim() !== "" ? s.reason.trim() : "近义";
      suggestions.push({ segment_index: s.segment_index, name: name, reason: reason });
    }
  }
  var anchoring = anchorSegments(segments, originalText);
  for (var j = 0; j < segments.length; j++) {
    segments[j].anchored = anchoring.anchored[j];
    segments[j].present = anchoring.present[j];
  }
  return {
    ok: true,
    parse: {
      segments: segments,
      order_violation: anchoring.order_violation,
      uncertain: uncertain,
      merge_suggestions: suggestions
    }
  };
}

/**
 * scanHousehold 单块输出校验:{ results:[{ index, segments:[...], uncertain }] }。
 * index 对应块内序号(0 起);越界/非整数的结果项丢弃(不失败);同一 index 后到先到均保留由 parse.js 归并。
 */
function validateScanChunk(rawText, chunkSize) {
  const parsed = extractJsonObject(rawText);
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, retryable: true, reason: "输出不是合法的 JSON 对象" };
  }
  if (!Array.isArray(parsed.results)) {
    return unavailable();
  }
  var results = [];
  for (var i = 0; i < parsed.results.length; i++) {
    var r = parsed.results[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      continue;
    }
    if (!Number.isInteger(r.index) || r.index < 0 || r.index >= chunkSize) {
      continue;
    }
    var uncertain = r.uncertain === true;
    if (r.segments === undefined) {
      results.push({ index: r.index, segments: [], uncertain: uncertain });
      continue;
    }
    if (Array.isArray(r.segments) && r.segments.length === 0) {
      results.push({ index: r.index, segments: [], uncertain: uncertain });
      continue;
    }
    var segments = cleanSegments(r.segments);
    if (segments === null) {
      continue; // 单件输出形状坏:丢弃该件(归入 skipped),不拖垮整块
    }
    results.push({ index: r.index, segments: segments, uncertain: uncertain });
  }
  return { ok: true, results: results };
}

/**
 * 近义比对输出校验(§6.2):{ groups:[{ level, names }] }。
 * levelNames[k] 为候选树第 k 层(0 起)的合法名字列表;
 * 名字必须全部来自该层输入列表,过滤后组内去重、<2 个丢组、越界 level 丢组。
 */
function validateSynonymGroups(rawText, levelNames) {
  const parsed = extractJsonObject(rawText);
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, retryable: true, reason: "输出不是合法的 JSON 对象" };
  }
  if (!Array.isArray(parsed.groups)) {
    return unavailable();
  }
  var groups = [];
  for (var i = 0; i < parsed.groups.length; i++) {
    var g = parsed.groups[i];
    if (!g || typeof g !== "object" || Array.isArray(g)) {
      continue;
    }
    if (!Number.isInteger(g.level) || g.level < 0 || g.level >= levelNames.length) {
      continue;
    }
    if (!Array.isArray(g.names)) {
      continue;
    }
    var allowed = levelNames[g.level];
    var seen = Object.create(null);
    var names = [];
    for (var k = 0; k < g.names.length; k++) {
      var n = g.names[k];
      if (typeof n !== "string") {
        continue;
      }
      if (allowed.indexOf(n) === -1) {
        continue; // 非法项丢弃(名字不在输入列表)
      }
      if (seen[n]) {
        continue; // 组内去重
      }
      seen[n] = true;
      names.push(n);
    }
    if (names.length >= 2) {
      groups.push({ level: g.level, names: names });
    }
  }
  return { ok: true, groups: groups };
}

module.exports = {
  SEGMENT_CONFIDENT_MIN: 0.8,
  extractJsonObject: extractJsonObject,
  anchorSegments: anchorSegments,
  validateParseOutput: validateParseOutput,
  validateScanChunk: validateScanChunk,
  validateSynonymGroups: validateSynonymGroups
};
