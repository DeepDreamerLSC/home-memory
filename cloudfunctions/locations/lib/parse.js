"use strict";

/**
 * LLM 类 action 编排:parseLocation(§5.2)与 scanHousehold(§5.9),LLM 契约见 §6。
 * - 两个 action 零写库:只读 locations/items,输出永远只是候选草案(§6.4 防火墙);
 *   建节点只能经 ensurePath(用户确认后的客户端调用)。
 * - 坏 JSON 带错误重试一次(照抄 extractDraft/lib/handler.js:103-116);仍失败整体 AI_UNAVAILABLE。
 * - scanHousehold:并行分块 + 归并后一次轻量近义比对调用;任一块或近义调用失败 → 整体
 *   AI_UNAVAILABLE,不做无提示的半成品。
 * - 日志只记 { action, text_length/items_scanned, chunks, elapsed_ms, error },
 *   绝不记录原文、物品名、位置名、prompt、模型输出、身份。
 */

var handlerMod = require("./handler");
var validate = require("./validate");
var tree = require("./tree");
var normalizeName = require("./normalize").normalizeName;

var fail = handlerMod.fail;
var fetchHouseholdNodes = handlerMod.fetchHouseholdNodes;
var fetchActiveItems = handlerMod.fetchActiveItems;

var TEXT_MAX = 200; // 与 items.location_text 同限
var TREE_CONTEXT_MAX = 120; // prompt 里的既有树上限,超出只送前两层
var SCAN_POOL_LIMIT = 30; // 增量扫描池上限(§5.9)
var SCAN_CHUNK_TARGET = 3; // 并行块数
var SCAN_CHUNK_SIZE = 10; // 单块件数上限
var CHUNK_TIMEOUT_MS = 15000; // 单块 LLM 超时(§5.9 预算)
var SYN_TIMEOUT_MS = 10000; // 近义比对调用超时
var SEGMENT_CONFIDENT_MIN = validate.SEGMENT_CONFIDENT_MIN; // 0.8,低于即强制人工确认

var SYSTEM_PROMPT = [
  "你是家庭位置结构解析器。用户给出物品的位置描述(单条或一批),你只负责拆解层级,不负责回答或闲聊。",
  "规则:",
  "1. 每条位置拆成 1-6 段,顺序从大到小(房间→家具→容器)。",
  "2. 每段名字必须逐字取自原文且按原文顺序,禁止改写、概括、推理、调序。",
  "3. 每段给 confidence(0 到 1 的小数),拿不准就给低分,宁可低分不可编造。",
  "4. 与【既有空间树】中同层同名或近义(如「主卧」与「主人房」)的段,在 merge_suggestions 里给出建议。",
  "5. 只输出一个 JSON 对象,无任何其他文字或代码块围栏。"
].join("\n");

var PARSE_SCHEMA = [
  "本次输出格式(JSON 对象):",
  "- segments:数组,1-6 项,每项 { \"name\": 段名(逐字取自原文,不超过 30 字), \"type\": \"room\"|\"furniture\"|\"container\", \"confidence\": 0-1 }",
  "- merge_suggestions:数组,每项 { \"segment_index\": 段下标(0 起), \"name\": 既有空间树中同名或近义的节点名, \"reason\": \"同名\"|\"近义\" }",
  "- uncertain:布尔,整体拿不准时为 true"
].join("\n");

var CHUNK_SCHEMA = [
  "本次输出格式(JSON 对象):",
  "- results:数组,每项对应【物品清单】中的一件:{ \"index\": 清单下标(0 起), \"segments\": 1-6 项(字段同规则), \"uncertain\": 布尔 }",
  "解析不出分层的物品,segments 给空数组。"
].join("\n");

var SYN_SYSTEM_PROMPT = [
  "你是家庭位置近义比对器。输入是候选空间树每一层的名字列表,你只负责判断哪些名字很可能指同一处,不负责回答或闲聊。",
  "规则:",
  "1. 只把「很可能指同一处」的名字归进同一组,拿不准就不要归组。",
  "2. 只输出一个 JSON 对象,无任何其他文字或代码块围栏。",
  "本次输出格式(JSON 对象):",
  "- groups:数组,每项 { \"level\": 层下标(0 起), \"names\": [该层中互为近义的名字,至少 2 个] }"
].join("\n");

var TREE_MARKER = "【既有空间树】";
var USER_MARKER = "【用户输入】";
var LIST_MARKER = "【物品清单】";
var LEVELS_MARKER = "【候选树各层名字】";
var RETRY_OUTPUT_MARKER = "【上次输出】";
var RETRY_ERROR_MARKER = "【解析错误】";

function codePointLength(s) {
  return Array.from(s).length;
}

function stripAllWhitespace(s) {
  return s.replace(/\s+/g, "");
}

function logParse(deps, entry) {
  if (deps && deps.logger && typeof deps.logger.log === "function") {
    try {
      deps.logger.log(entry);
    } catch (e) {
      // 日志失败绝不影响业务结果
    }
  }
}

function aiUnavailableResult() {
  var r = fail("AI_UNAVAILABLE");
  r.manual_fallback = true;
  return r;
}

function retryBlock(retryInfo) {
  return (
    "\n\n" +
    RETRY_OUTPUT_MARKER +
    "\n" +
    retryInfo.previousOutput +
    "\n" +
    RETRY_ERROR_MARKER +
    "\n" +
    retryInfo.reason +
    "\n请重新输出,只输出一个符合上述字段要求的 JSON 对象,不要包含任何其他文字或代码块围栏。"
  );
}

/** 既有树序列化进 prompt:≤120 节点全送,超出只送前两层(path.length ≤ 2);home 根与空树不送 */
function serializeTree(nodes) {
  var list = nodes.filter(function (n) {
    return Array.isArray(n.path) && n.path.length > 0; // home 根 path=[] 不进上下文
  });
  if (list.length > TREE_CONTEXT_MAX) {
    list = list.filter(function (n) {
      return n.path.length <= 2;
    });
  }
  if (list.length === 0) {
    return "(尚未建立任何空间)";
  }
  var lines = [];
  for (var i = 0; i < list.length; i++) {
    lines.push("- " + list[i].path.join("/"));
  }
  return lines.join("\n");
}

/**
 * 沿段序列在既有树中下钻(逐段找父节点下 name_norm 相等的子节点)。
 * 返回每段命中的既有节点(未命中为 null);首个未命中后不再下钻(父未定位则子无法定位)。
 */
function descendTree(nodes, segments) {
  var root = null;
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].parent_id === "") {
      root = nodes[i];
      break;
    }
  }
  var hits = [];
  var cur = root;
  for (var k = 0; k < segments.length; k++) {
    if (!cur) {
      hits.push(null);
      continue;
    }
    var norm = normalizeName(segments[k].name);
    var child = null;
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].parent_id === cur._id && nodes[j].name_norm === norm) {
        child = nodes[j];
        break;
      }
    }
    hits.push(child);
    cur = child;
  }
  return hits;
}

/**
 * 调 LLM 并校验,坏 JSON 带错误重试一次(照抄 extractDraft 手法)。
 * buildPrompt(retryInfo|null) → prompt;validateFn(output) → { ok, retryable?, reason? }。
 * 返回 { result }(校验通过)或 { failed:true }(调用抛错 / 硬校验失败 / 重试仍失败)。
 */
async function callValidated(deps, timeoutMs, buildPrompt, validateFn) {
  var output;
  try {
    output = await deps.callLLM(buildPrompt(null), timeoutMs);
  } catch (e) {
    return { failed: true };
  }
  var result = validateFn(output);
  if (result.ok) {
    return { result: result };
  }
  if (!result.retryable) {
    return { failed: true };
  }
  var retryOutput;
  try {
    retryOutput = await deps.callLLM(
      buildPrompt({ previousOutput: output, reason: result.reason }),
      timeoutMs
    );
  } catch (e) {
    return { failed: true };
  }
  var retry = validateFn(retryOutput);
  if (retry.ok) {
    return { result: retry };
  }
  return { failed: true };
}

/** need_confirm 规则(§5.2):低置信 / 错序 / 未锚定且无合并覆盖 / 模型自报不确定 */
function computeNeedConfirm(segments, anchoring, coveredFlags, uncertain) {
  if (uncertain || anchoring.order_violation) {
    return true;
  }
  for (var i = 0; i < segments.length; i++) {
    if (segments[i].confidence < SEGMENT_CONFIDENT_MIN) {
      return true;
    }
    if (!anchoring.anchored[i] && !coveredFlags[i]) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// parseLocation(§5.2):单条位置文本 → 层级候选,零写库
// ---------------------------------------------------------------------------

async function parseLocation(event, deps) {
  var startedAt = Date.now();
  var elapsedMs = function () {
    return Date.now() - startedAt;
  };
  var rawText = event && typeof event.text === "string" ? event.text : null;
  if (rawText === null) {
    logParse(deps, { action: "parseLocation", text_length: 0, chunks: 0, elapsed_ms: elapsedMs(), error: "INVALID_INPUT" });
    return fail("INVALID_INPUT");
  }
  var textLength = codePointLength(stripAllWhitespace(rawText));
  if (textLength < 1 || textLength > TEXT_MAX) {
    logParse(deps, { action: "parseLocation", text_length: textLength, chunks: 0, elapsed_ms: elapsedMs(), error: "INVALID_INPUT" });
    return fail("INVALID_INPUT");
  }
  if (typeof deps.callLLM !== "function") {
    throw new Error("deps.callLLM is required for parseLocation");
  }
  var userText = rawText.trim();
  var nodes = await fetchHouseholdNodes(deps);
  var treeLines = serializeTree(nodes);

  var promptBase = SYSTEM_PROMPT + "\n\n" + PARSE_SCHEMA + "\n\n" + TREE_MARKER + "\n" + treeLines + "\n\n" + USER_MARKER + "\n" + userText;
  var call = await callValidated(deps, CHUNK_TIMEOUT_MS, function (retryInfo) {
    return retryInfo ? promptBase + retryBlock(retryInfo) : promptBase;
  }, function (output) {
    return validate.validateParseOutput(output, userText);
  });
  if (call.failed) {
    logParse(deps, { action: "parseLocation", text_length: textLength, chunks: 1, elapsed_ms: elapsedMs(), error: "AI_UNAVAILABLE" });
    return aiUnavailableResult();
  }

  var parsed = call.result.parse;
  var segments = parsed.segments;
  var anchoring = validate.anchorSegments(segments, userText);

  // merge_suggestions:模型建议按「全树 name_norm 匹配」校验存在性(找不到丢弃),
  // 服务端对下钻命中的同名节点自动补全(不依赖模型)。
  var suggestions = [];
  var seen = Object.create(null); // segment_index + "|" + location_id 去重
  for (var i = 0; i < parsed.merge_suggestions.length; i++) {
    var s = parsed.merge_suggestions[i];
    var norm = normalizeName(s.name);
    var matched = null;
    for (var k = 0; k < nodes.length; k++) {
      if (nodes[k].name_norm !== norm) {
        continue;
      }
      if (matched === null || nodes[k].path.length < matched.path.length) {
        matched = nodes[k]; // 多个同名节点取路径最短(最接近房间层)
      }
    }
    if (!matched) {
      continue; // 引用不存在的节点:丢弃该条,不失败
    }
    var key = s.segment_index + "|" + matched._id;
    if (seen[key]) {
      continue;
    }
    seen[key] = true;
    suggestions.push({
      segment_index: s.segment_index,
      existing_location_id: matched._id,
      existing_name: matched.name,
      reason: s.reason
    });
  }
  var hits = descendTree(nodes, segments);
  for (var d = 0; d < hits.length; d++) {
    if (!hits[d]) {
      continue;
    }
    var autoKey = d + "|" + hits[d]._id;
    if (seen[autoKey]) {
      continue;
    }
    seen[autoKey] = true;
    suggestions.push({
      segment_index: d,
      existing_location_id: hits[d]._id,
      existing_name: hits[d].name,
      reason: "同名"
    });
  }
  suggestions.sort(function (a, b) {
    return a.segment_index - b.segment_index;
  });
  var covered = segments.map(function (seg, idx) {
    return suggestions.some(function (sg) {
      return sg.segment_index === idx;
    });
  });

  var needConfirm = computeNeedConfirm(segments, anchoring, covered, parsed.uncertain);
  var outSegments = segments.map(function (seg) {
    return { name: seg.name, type: seg.type, confidence: seg.confidence };
  });
  logParse(deps, { action: "parseLocation", text_length: textLength, chunks: 1, elapsed_ms: elapsedMs() });
  return {
    ok: true,
    parse: {
      segments: outSegments,
      need_confirm: needConfirm,
      order_violation: anchoring.order_violation,
      merge_suggestions: suggestions
    }
  };
}

// ---------------------------------------------------------------------------
// scanHousehold(§5.9):整户增量扫描,纯草案,零写库
// ---------------------------------------------------------------------------

/** 把件数组均分成至多 target 块、每块 ≤ size 件;空数组返回 [](1 件 1 块、4 件 3 块) */
function splitChunks(list, target, size) {
  if (list.length === 0) {
    return [];
  }
  var count = Math.min(target, Math.max(1, list.length));
  var chunks = [];
  for (var i = 0; i < count; i++) {
    chunks.push([]);
  }
  for (var k = 0; k < list.length; k++) {
    chunks[k % count].push(list[k]);
  }
  return chunks;
}

/** 整件是否未挂载(§5.1 统一口径):location_node_id 缺失、null,或指向不存在的节点 */
function isUnmounted(item, nodeIdSet) {
  var at = item.location_node_id;
  return at === undefined || at === null || at === "" || !nodeIdSet[at];
}

function candidateNode(name, depth) {
  return {
    name: name,
    name_norm: normalizeName(name),
    type: tree.typeForDepth(depth),
    confidence: 0,
    need_confirm: false,
    children: []
  };
}

/**
 * 归并一件的分段到候选树:同层 name_norm 去重(结构一致性由构造保证,不依赖模型自洽);
 * 同时对下钻命中既有树的层挂 merge_hints,并返回每层是否被既有树覆盖(合并覆盖)。
 */
function mergeIntoCandidate(rootChildren, segments, nodeNeedConfirm) {
  var level = rootChildren;
  for (var i = 0; i < segments.length; i++) {
    var norm = normalizeName(segments[i].name);
    var found = null;
    for (var c = 0; c < level.length; c++) {
      if (level[c].name_norm === norm) {
        found = level[c];
        break;
      }
    }
    if (!found) {
      found = candidateNode(segments[i].name, i + 1);
      level.push(found);
    }
    if (segments[i].confidence > found.confidence) {
      found.confidence = segments[i].confidence;
    }
    if (nodeNeedConfirm) {
      found.need_confirm = true;
    }
    level = found.children;
  }
}

/** 候选树投影:剥离 name_norm,空 merge_hints 不带字段 */
function projectCandidate(rootChildren) {
  return rootChildren.map(function (n) {
    var out = {
      name: n.name,
      type: n.type,
      confidence: n.confidence,
      need_confirm: n.need_confirm,
      children: projectCandidate(n.children)
    };
    if (n.merge_hints && n.merge_hints.length > 0) {
      out.merge_hints = n.merge_hints;
    }
    return out;
  });
}

/** 候选树各层名字列表(近义比对调用的输入;不含任何用户原文) */
function levelNamesOf(rootChildren) {
  var levels = [];
  var queue = rootChildren.slice();
  while (queue.length > 0) {
    var next = [];
    var names = [];
    for (var i = 0; i < queue.length; i++) {
      names.push(queue[i].name);
      next = next.concat(queue[i].children);
    }
    levels.push(names);
    queue = next;
  }
  return levels;
}

async function scanHousehold(event, deps) {
  var startedAt = Date.now();
  var elapsedMs = function () {
    return Date.now() - startedAt;
  };
  if (typeof deps.callLLM !== "function") {
    throw new Error("deps.callLLM is required for scanHousehold");
  }
  var nodes = await fetchHouseholdNodes(deps);
  var items = await fetchActiveItems(deps);
  var nodeIdSet = Object.create(null);
  for (var n = 0; n < nodes.length; n++) {
    nodeIdSet[nodes[n]._id] = true;
  }

  // 增量池 = 未删除且未挂载(统一口径,悬挂件回流;§5.9),updated_at 降序取前 30
  var unmounted = items.filter(function (it) {
    return isUnmounted(it, nodeIdSet);
  });
  unmounted.sort(function (a, b) {
    return a.updated_at === b.updated_at ? 0 : a.updated_at < b.updated_at ? 1 : -1;
  });
  var pool = unmounted.slice(0, SCAN_POOL_LIMIT);
  var truncated = unmounted.length > pool.length;

  var skipped = [];
  var llmPool = [];
  for (var p = 0; p < pool.length; p++) {
    var it = pool[p];
    if (typeof it.location_text !== "string" || it.location_text.trim() === "") {
      skipped.push({ item_id: it._id, name: it.name, reason: "位置为空" });
    } else {
      llmPool.push(it);
    }
  }
  var chunks = splitChunks(llmPool, SCAN_CHUNK_TARGET, SCAN_CHUNK_SIZE);
  var treeLines = serializeTree(nodes);

  // 并行分块:每块独立 prompt(只含本块物品与既有树),坏 JSON 重试一次;
  // 任一块最终失败 → 整体 AI_UNAVAILABLE(不部分成功)。
  var chunkResults = await Promise.all(
    chunks.map(function (chunk) {
      var lines = [];
      for (var i = 0; i < chunk.length; i++) {
        lines.push(i + ": " + chunk[i].location_text);
      }
      var promptBase =
        SYSTEM_PROMPT + "\n\n" + CHUNK_SCHEMA + "\n\n" + TREE_MARKER + "\n" + treeLines + "\n\n" + LIST_MARKER + "\n" + lines.join("\n");
      return callValidated(deps, CHUNK_TIMEOUT_MS, function (retryInfo) {
        return retryInfo ? promptBase + retryBlock(retryInfo) : promptBase;
      }, function (output) {
        return validate.validateScanChunk(output, chunk.length);
      }).then(function (call) {
        if (call.failed) {
          throw new Error("SCAN_CHUNK_FAILED");
        }
        return call.result.results;
      });
    })
  );

  var mounts = [];
  var candidateRoots = [];
  for (var c = 0; c < chunks.length; c++) {
    var chunk = chunks[c];
    var results = chunkResults[c];
    var byIndex = Object.create(null);
    for (var r = 0; r < results.length; r++) {
      byIndex[results[r].index] = results[r];
    }
    for (var k = 0; k < chunk.length; k++) {
      var item = chunk[k];
      var parsed = byIndex[k];
      if (!parsed || parsed.segments.length === 0) {
        skipped.push({ item_id: item._id, name: item.name, reason: "分段为空" });
        continue;
      }
      var segments = parsed.segments;
      var anchoring = validate.anchorSegments(segments, item.location_text);
      var hits = descendTree(nodes, segments);
      // 同名 merge_hints:候选树节点上内嵌(§5.9),同层 name_norm 相等由服务端自动判定
      mergeIntoCandidate(candidateRoots, segments, false);
      var level = candidateRoots;
      for (var h = 0; h < segments.length; h++) {
        var norm = normalizeName(segments[h].name);
        var treeNode = null;
        for (var t = 0; t < level.length; t++) {
          if (level[t].name_norm === norm) {
            treeNode = level[t];
            break;
          }
        }
        if (treeNode && hits[h] && !(treeNode.merge_hints || []).some(function (m) {
          return m.existing_location_id === hits[h]._id;
        })) {
          if (!treeNode.merge_hints) {
            treeNode.merge_hints = [];
          }
          treeNode.merge_hints.push({
            existing_location_id: hits[h]._id,
            existing_name: hits[h].name,
            reason: "同名"
          });
        }
        level = treeNode ? treeNode.children : [];
      }
      var covered = segments.map(function (seg, idx) {
        return hits[idx] !== null;
      });
      var minConf = 1;
      for (var m = 0; m < segments.length; m++) {
        if (segments[m].confidence < minConf) {
          minConf = segments[m].confidence;
        }
      }
      var needConfirm = computeNeedConfirm(segments, anchoring, covered, parsed.uncertain);
      if (needConfirm) {
        mergeIntoCandidate(candidateRoots, segments, true); // 任一件需确认 → 该路径树节点 need_confirm
      }
      mounts.push({
        item_id: item._id,
        name: item.name,
        location_text: item.location_text,
        version: item.version,
        path: segments.map(function (seg) {
          return seg.name;
        }),
        confidence: minConf,
        need_confirm: needConfirm,
        order_violation: anchoring.order_violation
      });
    }
  }

  // 归并后近义比对(第 4 次 LLM 调用):输入仅为候选树各层名字列表,不含用户原文;
  // 失败 → 整体 AI_UNAVAILABLE(近义提示是 issue 验收「同义位置能够合并或提示」的必要组成)。
  var levelNames = levelNamesOf(candidateRoots);
  var synonymGroups = [];
  if (levelNames.length > 0) {
    var synBase =
      SYN_SYSTEM_PROMPT + "\n\n" + LEVELS_MARKER + "\n" + levelNames
        .map(function (names, idx) {
          return "层" + (idx + 1) + ": [" + names.join(", ") + "]";
        })
        .join("\n");
    var synCall = await callValidated(deps, SYN_TIMEOUT_MS, function (retryInfo) {
      return retryInfo ? synBase + retryBlock(retryInfo) : synBase;
    }, function (output) {
      return validate.validateSynonymGroups(output, levelNames);
    });
    if (synCall.failed) {
      logParse(deps, { action: "scanHousehold", items_scanned: pool.length, chunks: chunks.length, elapsed_ms: elapsedMs(), error: "AI_UNAVAILABLE" });
      return aiUnavailableResult();
    }
    synonymGroups = synCall.result.groups.map(function (g) {
      return { level: g.level, names: g.names, reason: "近义" };
    });
  }

  logParse(deps, { action: "scanHousehold", items_scanned: pool.length, chunks: chunks.length, elapsed_ms: elapsedMs() });
  return {
    ok: true,
    scan: {
      scanned: pool.length,
      unmounted_total: unmounted.length,
      truncated: truncated,
      candidate_tree: projectCandidate(candidateRoots),
      synonym_groups: synonymGroups,
      mounts: mounts,
      skipped: skipped
    }
  };
}

module.exports = {
  parseLocation: parseLocation,
  scanHousehold: scanHousehold
};
