"use strict";

/**
 * itemsApi 纯函数 handler(docs/API_CONTRACT.md「itemsApi 协议」)。
 * handler(event, deps):身份只来自 deps.householdId,绝不从 event 读取任何身份字段;
 * 依赖注入以便离线测试。校验失败绝不写入;查询与列表永远过滤 deleted 为 false。
 */

var normalizeName = require("./normalize").normalizeName;
var checkWriteScopeBinding = require("./household").checkWriteScopeBinding;

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
  UNAUTHORIZED: "请先登录",
  OPERATION_CONFLICT: "这条已保存过且内容与当前填写不同,请到详情页修改",
  FAMILY_SWITCHED: "家庭已切换,本次操作未保存,请确认当前家庭后重试",
  FAMILY_STALE_SCOPE: "家庭刚发生成员或作用域变化,本次操作未保存,请刷新后重试"
};

function fail(error) {
  return { ok: false, error: error, message: ERROR_MESSAGES[error] };
}

/** 同 operation_id 重放时的内容比对(创建幂等只对「同键同内容」成立) */
function sameCreateContent(doc, name, locationText, note) {
  var noteNorm = note === undefined ? "" : note;
  return (
    doc.name === name &&
    doc.location_text === locationText &&
    (doc.note || "") === noteNorm
  );
}

/**
 * 同键异内容(或命中已删文档):明确冲突,绝不静默返回旧数据。
 * deleted 为 true 时不带 existing(内容已抹空,进详情页无意义)。
 */
function operationConflict(doc) {
  if (doc && doc.deleted) {
    return {
      ok: false,
      error: "OPERATION_CONFLICT",
      message: "这条记录已删除过,本次操作未保存,请重新记一件"
    };
  }
  return {
    ok: false,
    error: "OPERATION_CONFLICT",
    message: ERROR_MESSAGES.OPERATION_CONFLICT,
    existing: project(doc)
  };
}

/** 修改内容的稳定指纹(键排序后的 JSON 字符串):重放识别除 update_id 外还要求内容一致 */
function changesFingerprint(changes) {
  var keys = Object.keys(changes).sort();
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    parts.push(JSON.stringify(keys[i]) + ":" + JSON.stringify(changes[keys[i]]));
  }
  return "{" + parts.join(",") + "}";
}

function validUpdateId(v) {
  return isString(v) && v.length >= 1 && v.length <= OPERATION_ID_MAX;
}

/** 识别 CloudBase 唯一索引拒绝并发插入的错误(E11000 duplicate key) */
function isDuplicateKeyError(e) {
  var msg = e && e.message ? String(e.message) : "";
  return msg.indexOf("E11000") !== -1 || msg.indexOf("duplicate key") !== -1;
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

  // 幂等只对「同键同内容」成立:命中未删除的同键记录时,
  // 内容一致 → duplicated:true 稳定返回;内容不同 → OPERATION_CONFLICT(绝不静默吞掉用户的修改)。
  var existing = await collection(deps)
    .where({ household_id: deps.householdId, operation_id: operationId, deleted: false })
    .get();
  if (existing.data && existing.data.length > 0) {
    var doc = existing.data[0];
    if (sameCreateContent(doc, name, locationText, note)) {
      return { ok: true, item: project(doc), duplicated: true };
    }
    return operationConflict(doc);
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
  try {
    await collection(deps).add({ data: item });
  } catch (e) {
    // 并发重放:唯一索引 (household_id, operation_id) 拒绝第二笔插入。
    // 回查后返回稳定结果:同内容 duplicated、异内容或命中已删 → OPERATION_CONFLICT。
    if (!isDuplicateKeyError(e)) {
      throw e;
    }
    var after = await collection(deps)
      .where({ household_id: deps.householdId, operation_id: operationId })
      .get();
    if (after.data && after.data.length > 0) {
      var raced = after.data[0];
      if (!raced.deleted && sameCreateContent(raced, name, locationText, note)) {
        return { ok: true, item: project(raced), duplicated: true };
      }
      return operationConflict(raced);
    }
    // 回查不到属于异常场景:按原始错误上抛,绝不假装成功。
    throw e;
  }
  return { ok: true, item: project(item), duplicated: false };
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
  // update_id(可选):同一次逻辑修改的标识,用于「响应丢失后重试」的重放识别
  var updateId = event.update_id;
  if (updateId !== undefined && !validUpdateId(updateId)) {
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

  // 指纹只覆盖用户内容字段(在注入 version/updated_at/last_update_* 元数据之前计算)
  var fingerprint = changesFingerprint(changes);

  changes.version = expectedVersion + 1;
  changes.updated_at = deps.now();
  if (updateId !== undefined) {
    changes.last_update_id = updateId;
    changes.last_update_fingerprint = fingerprint;
  }

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
    return { ok: true, item: project(after.data[0]) };
  }

  // 命中 0 条:同一 _id 与 household 且未删仍存在 → 版本冲突;否则 NOT_FOUND
  var still = await collection(deps)
    .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
    .get();
  if (still.data && still.data.length > 0) {
    var current = still.data[0];
    // 重放识别(三重条件):版本恰为 expected+1、last_update_id 相同、且修改内容指纹一致。
    // 相同 update_id 但内容不同 → 一律 VERSION_CONFLICT,绝不把新内容当重放吞掉。
    if (
      updateId !== undefined &&
      current.version === expectedVersion + 1 &&
      current.last_update_id === updateId &&
      current.last_update_fingerprint === fingerprint
    ) {
      return { ok: true, item: project(current), replayed: true };
    }
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
 * 响应带 household_id(issue #34 P0):服务端解析的当前家庭(sha256 派生或共享
 * 家庭 id,非 PII),供客户端捕获家庭作用域(缓存/草稿键隔离的依据)。
 * 共享家庭另带 scope_revision(issue #34 P1-A):写请求前的 expected_scope_revision
 * 捕获来源。集合权限不变;仅此只读 action 与 locations.list 携带这些字段。
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
  var res = { ok: true, household_id: deps.householdId, items: docs.slice(0, limit).map(project) };
  if (deps.householdShared === true) {
    // 共享家庭附带 scope_revision(issue #34 P1-A):客户端写请求前捕获作用域+修订,
    // 作为 expected_scope_revision 的来源(仅一致性前置条件,不授权)
    res.scope_revision = deps.scopeRevision;
  }
  return res;
}

/**
 * get:入参 { action:"get", item_id }
 * 按 id 单查(带 household 条件,过滤已删),供详情页冲突刷新等场景使用,
 * 不受 list 分页截断影响。
 */
async function getItem(event, deps) {
  if (!validItemId(event.item_id)) {
    return fail("INVALID_INPUT");
  }
  var got = await collection(deps)
    .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
    .get();
  if (got.data && got.data.length > 0) {
    return { ok: true, item: project(got.data[0]) };
  }
  return fail("NOT_FOUND");
}

var ACTIONS = {
  create: createItem,
  update: updateItem,
  delete: deleteItem,
  get: getItem,
  query: queryItems,
  list: listItems
};

/**
 * 写类 action(issue #34 P0 F2 + P1-A 写入硬门,lib/household.js 的
 * checkWriteScopeBinding 统一裁定):
 * - 共享家庭(解析为 shared):必须携带与解析一致的 expected_household_id 与
 *   expected_scope_revision(客户端从 list 响应捕获)。缺失/不一致 →
 *   FAMILY_SWITCHED / FAMILY_STALE_SCOPE,零业务写入,绝不静默改投当前家庭;
 *   单调 scope_revision 挡成员变更后的旧请求误写与 A→B→A 的 ABA 重放
 *   (P1 硬门 B 第 1、2 条);
 * - 个人(单人)家庭:维持 P0 宽松口径——expected_household_id 可选(携带则
 *   校验,不一致 FAMILY_SWITCHED)、expected_scope_revision 忽略,0.4.7 及
 *   以前客户端单人零回归。
 * 两参数仅做一致性校验,不具任何授权效力;身份与家庭归属始终由服务端独立解析。
 */
var WRITE_ACTIONS = { create: true, update: true, delete: true };

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
 * deps = { db, now(), genId(), householdId, householdShared?, scopeRevision?, logger }
 * (householdShared/scopeRevision 由 index.js 从解析结果注入:共享家庭写硬门依据)
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
    } else if (WRITE_ACTIONS[action]) {
      // F2 写入硬门(issue #34 P0+P1-A):共享家庭强制作用域绑定(缺 marker /
      // 旧修订 → FAMILY_SWITCHED / FAMILY_STALE_SCOPE,零写入);个人家庭维持
      // P0 宽松口径(可选 marker)。gate 返回 null = 放行
      var gate = checkWriteScopeBinding(
        deps.householdId,
        deps.householdShared === true,
        deps.scopeRevision,
        event
      );
      result = gate === null ? await ACTIONS[action](event, deps) : gate;
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
