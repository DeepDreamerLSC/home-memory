"use strict";

/**
 * itemsApi 纯函数 handler(docs/API_CONTRACT.md「itemsApi 协议」)。
 * handler(event, deps):身份只来自 deps.householdId,绝不从 event 读取任何身份字段;
 * 依赖注入以便离线测试。校验失败绝不写入;查询与列表永远过滤 deleted 为 false。
 */

var normalizeName = require("./normalize").normalizeName;

var COLLECTION = "items";
var NAME_MAX = 50;
var LOCATION_MAX = 200;
var NOTE_MAX = 200;
var OPERATION_ID_MAX = 64;
var QUERY_LIMIT = 20;
var LIST_DEFAULT = 50;
var LIST_MAX = 50;
// CloudBase 云函数端单次 get() 默认最多返回 100 条;query/list 必须显式分页拉全量,
// 否则家庭文档超过 100 条后被静默截断(query 漏匹配、list 降序基于截断集)。
var PAGE_SIZE = 100;
// 护栏:超过 100 页(1 万条)视为异常,如实抛错绝不静默截断(PR1 家庭规模远小于此)。
var MAX_PAGES = 100;

var ERROR_MESSAGES = {
  INVALID_INPUT: "输入不合法,请检查后重试",
  NOT_FOUND: "没有找到这条记录",
  VERSION_CONFLICT: "内容已被修改,已为你刷新,请重试",
  UNAUTHORIZED: "请先登录"
};

function fail(error) {
  return { ok: false, error: error, message: ERROR_MESSAGES[error] };
}

function isString(v) {
  return typeof v === "string";
}

/** 校验并清洗必填文本:去首尾空白后长度在 [min, max],非法返回 null */
function cleanRequired(v, max) {
  if (!isString(v)) {
    return null;
  }
  var trimmed = v.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    return null;
  }
  return trimmed;
}

/** 校验可选文本:未传返回 undefined;可传空串;去首尾空白后长度 ≤ max,非法返回 null */
function cleanOptional(v, max) {
  if (v === undefined) {
    return undefined;
  }
  if (!isString(v)) {
    return null;
  }
  var trimmed = v.trim();
  if (trimmed.length > max) {
    return null;
  }
  return trimmed;
}

/** 校验 item_id:非空字符串 */
function validItemId(v) {
  return isString(v) && v.length >= 1;
}

function collection(deps) {
  return deps.db.collection(COLLECTION);
}

/** query/list 返回的用户可见投影,绝不包含内部字段 */
function project(doc) {
  return {
    item_id: doc._id,
    name: doc.name,
    location_text: doc.location_text,
    note: doc.note,
    version: doc.version,
    updated_at: doc.updated_at
  };
}

/** updated_at 降序(ISO 字符串按字典序比较) */
function byUpdatedDesc(a, b) {
  if (a.updated_at === b.updated_at) {
    return 0;
  }
  return a.updated_at < b.updated_at ? 1 : -1;
}

/**
 * create:入参 { action, operation_id, name, location_text, note? }
 * 幂等:(household_id, operation_id) 已有则返回已有文档并 duplicated:true。
 */
async function createItem(event, deps) {
  var operationId = event.operation_id;
  if (!isString(operationId) || operationId.length < 1 || operationId.length > OPERATION_ID_MAX) {
    return fail("INVALID_INPUT");
  }
  var name = cleanRequired(event.name, NAME_MAX);
  if (name === null) {
    return fail("INVALID_INPUT");
  }
  var locationText = cleanRequired(event.location_text, LOCATION_MAX);
  if (locationText === null) {
    return fail("INVALID_INPUT");
  }
  var note = cleanOptional(event.note, NOTE_MAX);
  if (note === null) {
    return fail("INVALID_INPUT");
  }

  // 先查后插实现幂等(README 建议线上为 (household_id, operation_id) 建唯一索引兜底)
  var existing = await collection(deps)
    .where({ household_id: deps.householdId, operation_id: operationId })
    .get();
  if (existing.data && existing.data.length > 0) {
    return { ok: true, item: existing.data[0], duplicated: true };
  }

  var now = deps.now();
  var item = {
    _id: "it_" + deps.genId(),
    household_id: deps.householdId,
    name: name,
    name_norm: normalizeName(name),
    location_text: locationText,
    note: note === undefined ? "" : note,
    version: 1,
    deleted: false,
    operation_id: operationId,
    created_at: now,
    updated_at: now
  };
  await collection(deps).add({ data: item });
  return { ok: true, item: item, duplicated: false };
}

/**
 * update:入参 { action, item_id, expected_version, location_text?, name?, note? }
 * 乐观并发:条件更新 version 等于 expected_version;命中 0 条再区分 VERSION_CONFLICT / NOT_FOUND。
 */
async function updateItem(event, deps) {
  if (!validItemId(event.item_id)) {
    return fail("INVALID_INPUT");
  }
  var expectedVersion = event.expected_version;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return fail("INVALID_INPUT");
  }

  var changes = {};
  if (event.name !== undefined) {
    var name = cleanRequired(event.name, NAME_MAX);
    if (name === null) {
      return fail("INVALID_INPUT");
    }
    changes.name = name;
    changes.name_norm = normalizeName(name);
  }
  if (event.location_text !== undefined) {
    var locationText = cleanRequired(event.location_text, LOCATION_MAX);
    if (locationText === null) {
      return fail("INVALID_INPUT");
    }
    changes.location_text = locationText;
  }
  if (event.note !== undefined) {
    var note = cleanOptional(event.note, NOTE_MAX);
    if (note === null) {
      return fail("INVALID_INPUT");
    }
    changes.note = note;
  }
  if (Object.keys(changes).length === 0) {
    return fail("INVALID_INPUT");
  }

  changes.version = expectedVersion + 1;
  changes.updated_at = deps.now();

  var res = await collection(deps)
    .where({
      _id: event.item_id,
      household_id: deps.householdId,
      deleted: false,
      version: expectedVersion
    })
    .update({ data: changes });
  var updated = (res && res.stats && res.stats.updated) || 0;
  if (updated >= 1) {
    var after = await collection(deps)
      .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
      .get();
    return { ok: true, item: after.data[0] };
  }

  // 命中 0 条:同一 _id 与 household 且未删仍存在 → 版本冲突;否则 NOT_FOUND
  var still = await collection(deps)
    .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
    .get();
  if (still.data && still.data.length > 0) {
    return fail("VERSION_CONFLICT");
  }
  return fail("NOT_FOUND");
}

/**
 * delete:入参 { action, item_id }
 * 软删除:置 deleted 为 true,并把 name、name_norm、location_text、note 全部抹成空字符串。
 */
async function deleteItem(event, deps) {
  if (!validItemId(event.item_id)) {
    return fail("INVALID_INPUT");
  }
  var res = await collection(deps)
    .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
    .update({ data: { deleted: true, name: "", name_norm: "", location_text: "", note: "" } });
  var updated = (res && res.stats && res.stats.updated) || 0;
  if (updated >= 1) {
    return { ok: true };
  }
  return fail("NOT_FOUND");
}

/**
 * 拉取当前家庭全部未删除文档(query/list 共用)。
 * CloudBase 云函数端 get() 单次最多返回 100 条,这里用 .skip() + .limit() 逐页拉全量;
 * 匹配与排序仍在内存完成,契约语义不变。超出护栏页数时抛错(绝不静默返回部分数据)。
 */
async function fetchActiveItems(deps) {
  var out = [];
  for (var page = 0; page < MAX_PAGES; page++) {
    var res = await collection(deps)
      .where({ household_id: deps.householdId, deleted: false })
      .skip(out.length)
      .limit(PAGE_SIZE)
      .get();
    var batch = (res && res.data) || [];
    for (var i = 0; i < batch.length; i++) {
      out.push(batch[i]);
    }
    if (batch.length < PAGE_SIZE) {
      return out;
    }
  }
  throw new Error("items query exceeded " + MAX_PAGES * PAGE_SIZE + " documents");
}

/**
 * query:入参 { action, q }
 * name_norm 精确匹配优先、其次前缀、最后包含,各自按 updated_at 降序,合并去重,最多 20 条。
 */
async function queryItems(event, deps) {
  if (!isString(event.q)) {
    return fail("INVALID_INPUT");
  }
  var q = event.q.trim();
  if (q.length < 1) {
    return fail("INVALID_INPUT");
  }
  var nq = normalizeName(q);
  if (nq === "") {
    // 查询词归一化后为空(如纯标点)无法与任何名称匹配,按无结果处理
    return { ok: true, items: [], match_type: "none" };
  }

  var docs = await fetchActiveItems(deps);
  var exact = [];
  var prefix = [];
  var contains = [];
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    if (!isString(d.name_norm)) {
      continue;
    }
    if (d.name_norm === nq) {
      exact.push(d);
    } else if (d.name_norm.indexOf(nq) === 0) {
      prefix.push(d);
    } else if (d.name_norm.indexOf(nq) !== -1) {
      contains.push(d);
    }
  }
  exact.sort(byUpdatedDesc);
  prefix.sort(byUpdatedDesc);
  contains.sort(byUpdatedDesc);

  var merged = [];
  var seen = Object.create(null);
  var ordered = exact.concat(prefix, contains);
  for (var j = 0; j < ordered.length; j++) {
    if (merged.length >= QUERY_LIMIT) {
      break;
    }
    if (seen[ordered[j]._id]) {
      continue;
    }
    seen[ordered[j]._id] = true;
    merged.push(ordered[j]);
  }

  var matchType =
    exact.length > 0 ? "exact" : prefix.length > 0 ? "prefix" : contains.length > 0 ? "contains" : "none";
  return { ok: true, items: merged.map(project), match_type: matchType };
}

/**
 * list:入参 { action, limit? }
 * deleted 为 false,updated_at 降序,limit 默认 50、最大 50。
 */
async function listItems(event, deps) {
  var limit = LIST_DEFAULT;
  if (event.limit !== undefined) {
    if (!Number.isInteger(event.limit) || event.limit < 1) {
      return fail("INVALID_INPUT");
    }
    limit = Math.min(event.limit, LIST_MAX);
  }
  var docs = await fetchActiveItems(deps);
  docs.sort(byUpdatedDesc); // fetchActiveItems 返回新建数组,可原地排序
  return { ok: true, items: docs.slice(0, limit).map(project) };
}

var ACTIONS = {
  create: createItem,
  update: updateItem,
  delete: deleteItem,
  query: queryItems,
  list: listItems
};

/**
 * 日志只输出 action、错误码、耗时、计数;绝不输出原文、身份、物品名、位置。
 */
function logResult(deps, action, result, startedAt) {
  if (!deps || !deps.logger || typeof deps.logger.log !== "function") {
    return;
  }
  var entry = {
    action: isString(action) ? action : null,
    error: result && result.ok === false ? result.error : null,
    ms: Date.now() - startedAt
  };
  if (result && result.ok) {
    entry.count = Array.isArray(result.items) ? result.items.length : 1;
  } else {
    entry.count = 0;
  }
  try {
    deps.logger.log(entry);
  } catch (e) {
    // 日志失败绝不影响业务结果
  }
}

/**
 * 纯函数入口:handler(event, deps)
 * deps = { db, now(), genId(), householdId, logger }
 * 返回 { ok:true, ... } 或 { ok:false, error, message(中文) }。
 */
async function handler(event, deps) {
  var startedAt = Date.now();
  var action = event && event.action;
  var result;
  try {
    if (!deps || !deps.householdId) {
      result = fail("UNAUTHORIZED");
    } else if (!isString(action) || !ACTIONS[action]) {
      // 未知 action、缺必填 action 一律 INVALID_INPUT
      result = fail("INVALID_INPUT");
    } else {
      result = await ACTIONS[action](event, deps);
    }
  } catch (err) {
    // 基础设施异常不属于契约四种业务错误码:如实记日志(仅 action/错误码/耗时/计数)后向上抛出,
    // 绝不静默、绝不假装业务成功。
    logResult(deps, action, { ok: false, error: "INTERNAL" }, startedAt);
    throw err;
  }
  logResult(deps, action, result, startedAt);
  return result;
}

module.exports = {
  handler: handler,
  ERROR_MESSAGES: ERROR_MESSAGES
};
