"use strict";

/**
 * locations 纯函数 handler(docs/design/location-tree.md §5)。
 * handler(event, deps):身份只来自 deps.householdId,绝不从 event 读取任何身份字段;
 * deps = { db, now(), genId(), digest(s), householdId, logger, callLLM?(仅 LLM action 需要) }。
 * - db 类 action:list/ensurePath/rename/move/merge/delete/linkItem/unlinkItem/applyScan;
 * - LLM 类 action(parseLocation/scanHousehold)在 lib/parse.js,这里 lazy require 避免循环依赖;
 * - 对 items 的一切挂载写入(§6.4)都是版本条件更新:同一版本计数器、同一
 *   last_update_id/last_update_fingerprint 回写、同 itemsApi.update 三重条件重放识别,
 *   系统内不存在对 items 文档 version 的无条件改写;
 * - 日志只记 action/error/ms/count,绝不记录位置名/物品名/原文/身份。
 */

var normalizeName = require("./normalize").normalizeName;
var tree = require("./tree");
var checkWriteScopeBinding = require("./household").checkWriteScopeBinding;

var LOC_COLLECTION = "locations";
var ITEMS_COLLECTION = "items";
var HISTORY_COLLECTION = "item_location_history";
var NODE_NAME_MAX = 30; // 节点名去首尾空白后 1-30 字(码点)
var PATH_MAX_SEGMENTS = tree.PATH_MAX_DEPTH; // path 1-6 段
var OPERATION_ID_MAX = 64;
var HOME_NAME = "我的家";
var CREATED_FROM_VALUES = ["bootstrap", "scan", "parse", "manual"];
// CloudBase 云函数端 get() 默认最多 100 条;全量统计必须分页拉取(itemsApi 同款取舍)
var PAGE_SIZE = 100;
var MAX_PAGES = 100;
// applyScan 确认单元数量上限(与 scanHousehold 的 30 件增量池对齐)
var APPLY_BRANCHES_MAX = 30;
var APPLY_MOUNTS_MAX = 30;

var ERROR_MESSAGES = {
  INVALID_INPUT: "输入不合法,请检查后重试",
  NOT_FOUND: "没有找到这个位置",
  UNAUTHORIZED: "请先登录",
  VERSION_CONFLICT: "物品内容已被修改,已为你刷新,请重试",
  NODE_NOT_EMPTY: "这里还有东西,先移走物品和子位置才能删除",
  NODE_CONFLICT: "目标位置已有同名节点,或不能移动到自己下面",
  AI_UNAVAILABLE: "AI 暂时不可用,可稍后重试或手动选择位置",
  FAMILY_SWITCHED: "家庭已切换,本次操作未保存,请确认当前家庭后重试",
  FAMILY_STALE_SCOPE: "家庭刚发生成员或作用域变化,本次操作未保存,请刷新后重试"
};

function fail(error, message) {
  return { ok: false, error: error, message: message || ERROR_MESSAGES[error] };
}

function isString(v) {
  return typeof v === "string";
}

/**
 * home 根判定(issue #30 PR A):结构化判根——parent_id 为空串的唯一节点
 * (ensureHomeRoot 保证)。不再读取 type 字段:type 由深度派生、move 不重算,
 * 存量文档的 type 已可漂移,只有 parent_id 才是可靠的结构事实。
 */
function isHomeRoot(node) {
  return node.parent_id === "";
}

function codePointLength(s) {
  return Array.from(s).length;
}

/** 节点名/段名校验:去首尾空白后 1-30 字(码点),非法返回 null */
function cleanNodeName(v) {
  if (!isString(v)) {
    return null;
  }
  var trimmed = v.trim();
  if (codePointLength(trimmed) < 1 || codePointLength(trimmed) > NODE_NAME_MAX) {
    return null;
  }
  return trimmed;
}

function validUpdateId(v) {
  return isString(v) && v.length >= 1 && v.length <= OPERATION_ID_MAX;
}

function validItemId(v) {
  return isString(v) && v.length >= 1;
}

function validPositiveVersion(v) {
  return Number.isInteger(v) && v >= 1;
}

/** 识别 CloudBase 唯一索引拒绝并发插入的错误(E11000 duplicate key,itemsApi 同款) */
function isDuplicateKeyError(e) {
  var msg = e && e.message ? String(e.message) : "";
  return msg.indexOf("E11000") !== -1 || msg.indexOf("duplicate key") !== -1;
}

/** 修改内容的稳定指纹(键排序 JSON,itemsApi handler.js:67-75 同款算法);覆盖 { location_node_id } */
function changesFingerprint(changes) {
  var keys = Object.keys(changes).sort();
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    parts.push(JSON.stringify(keys[i]) + ":" + JSON.stringify(changes[keys[i]]));
  }
  return "{" + parts.join(",") + "}";
}

/** 三重条件重放识别(itemsApi update 同款):版本恰为 expected+1、update_id 相同、指纹一致 */
function isReplay(doc, expectedVersion, updateId, fingerprint) {
  return (
    doc.version === expectedVersion + 1 &&
    doc.last_update_id === updateId &&
    doc.last_update_fingerprint === fingerprint
  );
}

function locCol(deps) {
  return deps.db.collection(LOC_COLLECTION);
}

function itemsCol(deps) {
  return deps.db.collection(ITEMS_COLLECTION);
}

/** 位置变更历史(append-only 预留层,§5.11):仅 locations 函数写入,V1 无读取入口 */
function histCol(deps) {
  return deps.db.collection(HISTORY_COLLECTION);
}

function digestOf(deps, s) {
  if (!deps || typeof deps.digest !== "function") {
    throw new Error("deps.digest is required");
  }
  return deps.digest(s);
}

/**
 * 分页拉全量(skip/limit 逐页,itemsApi fetchActiveItems 同款模式与护栏):
 * 超过护栏页数抛错,绝不静默截断。nodes 与 items 的全量统计都走这里。
 */
async function fetchAllPages(deps, name, cond) {
  var out = [];
  for (var page = 0; page < MAX_PAGES; page++) {
    var res = await deps.db.collection(name).where(cond).skip(out.length).limit(PAGE_SIZE).get();
    var batch = (res && res.data) || [];
    for (var i = 0; i < batch.length; i++) {
      out.push(batch[i]);
    }
    if (batch.length < PAGE_SIZE) {
      return out;
    }
  }
  throw new Error(name + " query exceeded " + MAX_PAGES * PAGE_SIZE + " documents");
}

/** 本家庭全部位置节点 */
async function fetchHouseholdNodes(deps) {
  return fetchAllPages(deps, LOC_COLLECTION, { household_id: deps.householdId });
}

/** 本家庭全部未删除物品(挂载统计、扫描池共用) */
async function fetchActiveItems(deps) {
  return fetchAllPages(deps, ITEMS_COLLECTION, { household_id: deps.householdId, deleted: false });
}

/**
 * 保证 home 根存在(惰性创建,幂等):唯一索引拒绝并发双建,捕获 E11000 后回查复用。
 * list 根层请求与 ensurePath 都会经过这里;rename/move/merge/delete 只操作已存在节点,不建根。
 */
async function ensureHomeRoot(deps) {
  var norm = normalizeName(HOME_NAME);
  var existing = await locCol(deps)
    .where({ household_id: deps.householdId, parent_id: "", name_norm: norm })
    .get();
  if (existing.data && existing.data.length > 0) {
    return existing.data[0];
  }
  var now = deps.now();
  var doc = {
    _id: "lc_" + deps.genId(),
    household_id: deps.householdId,
    parent_id: "",
    name: HOME_NAME,
    name_norm: norm,
    type: "home",
    path: [],
    created_from: "bootstrap",
    created_at: now,
    updated_at: now
  };
  try {
    await locCol(deps).add({ data: doc });
    return doc;
  } catch (e) {
    if (!isDuplicateKeyError(e)) {
      throw e;
    }
    var after = await locCol(deps)
      .where({ household_id: deps.householdId, parent_id: "", name_norm: norm })
      .get();
    if (after.data && after.data.length > 0) {
      return after.data[0];
    }
    throw e;
  }
}

/** 查 (household_id, parent_id, name_norm) 命中的子节点,无则 null */
async function findChildByNorm(deps, parentId, nameNorm) {
  var res = await locCol(deps)
    .where({ household_id: deps.householdId, parent_id: parentId, name_norm: nameNorm })
    .get();
  return res.data && res.data.length > 0 ? res.data[0] : null;
}

/** 按 id 查本家庭节点,无则 null(跨家庭/已删同样表现为查不到) */
async function findNodeById(deps, nodeId) {
  var res = await locCol(deps).where({ _id: nodeId, household_id: deps.householdId }).get();
  return res.data && res.data.length > 0 ? res.data[0] : null;
}

/**
 * 创建节点(add + E11000 回查复用,绝不双建)。调用方保证 path/type 已算好。
 */
async function createNode(deps, parentId, name, path, type, createdFrom) {
  var now = deps.now();
  var doc = {
    _id: "lc_" + deps.genId(),
    household_id: deps.householdId,
    parent_id: parentId,
    name: name,
    name_norm: normalizeName(name),
    type: type,
    path: path,
    created_from: createdFrom,
    created_at: now,
    updated_at: now
  };
  try {
    await locCol(deps).add({ data: doc });
    return doc;
  } catch (e) {
    if (!isDuplicateKeyError(e)) {
      throw e;
    }
    var raced = await findChildByNorm(deps, parentId, doc.name_norm);
    if (raced) {
      return raced;
    }
    throw e;
  }
}

/**
 * 沿路径逐段 find-or-create(§5.3,全系统唯一建节点入口;applyScan 内部复用,created_from:"scan")。
 * 先保证 home 根存在;每段命中即复用、未命中则建(type 按深度映射)。
 * 返回 { nodes(与 segments 等长), created(布尔数组) }。
 */
async function ensurePathSegments(deps, segments, createdFrom) {
  var root = await ensureHomeRoot(deps);
  var current = root;
  var nodes = [];
  var created = [];
  for (var i = 0; i < segments.length; i++) {
    var name = segments[i];
    var child = await findChildByNorm(deps, current._id, normalizeName(name));
    if (child) {
      nodes.push(child);
      created.push(false);
    } else {
      child = await createNode(
        deps,
        current._id,
        name,
        current.path.concat([name]),
        tree.typeForDepth(current.path.length + 1),
        createdFrom
      );
      nodes.push(child);
      created.push(true);
    }
    current = child;
  }
  return { nodes: nodes, created: created };
}

/**
 * 挂载计数预计算:对每个挂载到存在节点的未删物品,沿 parent 链向根累加,
 * 使 count[nodeId] = 该节点整棵子树(自身+后代)挂载的未删物品数(§5.1)。
 * 悬挂挂载(location_node_id 指向不存在的节点)不计入,单独统计。
 */
function buildItemCountMap(nodes, items) {
  var byId = tree.indexById(nodes);
  var counts = Object.create(null);
  var dangling = 0;
  for (var i = 0; i < items.length; i++) {
    var mountedAt = items[i].location_node_id;
    if (mountedAt === undefined || mountedAt === null || mountedAt === "") {
      continue;
    }
    var cur = byId[mountedAt];
    if (!cur) {
      dangling += 1; // 悬挂:按未挂载处理,计数如实上报(读侧容忍)
      continue;
    }
    while (cur) {
      counts[cur._id] = (counts[cur._id] || 0) + 1;
      cur = cur.parent_id === "" ? null : byId[cur.parent_id];
    }
  }
  return { counts: counts, dangling: dangling };
}

/** 直接子节点数预计算 */
function buildChildCountMap(nodes) {
  var counts = Object.create(null);
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].parent_id !== "") {
      counts[nodes[i].parent_id] = (counts[nodes[i].parent_id] || 0) + 1;
    }
  }
  return counts;
}

/** LocationNodeSummary 投影(list.node/children、ensurePath/rename/move/merge 响应共用) */
function summarize(node, itemCounts, childCounts) {
  return {
    location_id: node._id,
    name: node.name,
    type: node.type,
    path: node.path,
    item_count: itemCounts[node._id] || 0,
    child_count: childCounts[node._id] || 0,
    created_from: node.created_from,
    updated_at: node.updated_at
  };
}

/** 拉全量后带计数投影(结构写操作响应共用) */
async function summarizeWithStats(deps, node) {
  var nodes = await fetchHouseholdNodes(deps);
  var items = await fetchActiveItems(deps);
  var stats = buildItemCountMap(nodes, items);
  return summarize(node, stats.counts, buildChildCountMap(nodes));
}

/** items 的 list 投影(与 itemsApi project 同字段) */
function projectItem(doc) {
  return {
    item_id: doc._id,
    name: doc.name,
    location_text: doc.location_text,
    note: doc.note,
    version: doc.version,
    updated_at: doc.updated_at
  };
}

function byItemCountDescNameAsc(a, b) {
  if (a.item_count !== b.item_count) {
    return a.item_count > b.item_count ? -1 : 1;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function byUpdatedDesc(a, b) {
  if (a.updated_at === b.updated_at) {
    return 0;
  }
  return a.updated_at < b.updated_at ? 1 : -1;
}

/**
 * 版本条件更新 items 的挂载字段(所有挂载写入的唯一路径,§6.4 第 4 条)。
 * source 用于位置变更历史(§5.11,append-only 预留):真实变更(from ≠ to)追加一条
 * {item_id, from_node_id, to_node_id, changed_at, source};重放/0 命中走不进本分支,
 * 历史天然不重复;from == to 的空变更不记录;历史写失败不阻断挂载主流程(且不落日志)。
 */
async function conditionalMountUpdate(deps, item, locationNodeId, updateId, source) {
  var changes = { location_node_id: locationNodeId };
  var fingerprint = changesFingerprint(changes);
  var res = await itemsCol(deps)
    .where({
      _id: item._id,
      household_id: deps.householdId,
      deleted: false,
      version: item.version
    })
    .update({
      data: {
        location_node_id: locationNodeId,
        version: item.version + 1,
        updated_at: deps.now(),
        last_update_id: updateId,
        last_update_fingerprint: fingerprint
      }
    });
  if (res && res.stats && res.stats.updated >= 1 && source) {
    var fromNodeId = item.location_node_id === undefined ? null : item.location_node_id;
    if (fromNodeId !== locationNodeId) {
      try {
        await histCol(deps).add({
          data: {
            household_id: deps.householdId,
            item_id: item._id,
            from_node_id: fromNodeId,
            to_node_id: locationNodeId,
            changed_at: deps.now(),
            source: source
          }
        });
      } catch (histErr) {
        // 历史是预留审计层:追加失败不影响挂载结果,也不写入任何日志
      }
    }
  }
  return {
    updated: (res && res.stats && res.stats.updated) || 0,
    fingerprint: fingerprint,
    updateId: updateId
  };
}

/**
 * 摘除补偿(delete/merge 收尾共用,§1.1 第②层):对悬挂在被删节点上的未删物品
 * 逐件条件摘除(置 null、version+1、派生标识)。返回 { compensated, skipped }。
 */
async function compensateUnmount(deps, victims, updateIdOf) {
  var compensated = 0;
  var skipped = 0;
  for (var i = 0; i < victims.length; i++) {
    var item = victims[i];
    var updateId = updateIdOf(item);
    var res = await conditionalMountUpdate(deps, item, null, updateId, "compensate");
    if (res.updated >= 1) {
      compensated += 1;
      continue;
    }
    skipped += 1; // 又被并发修改:跳过,读侧容忍兜底(重进向导可再挂)
  }
  return { compensated: compensated, skipped: skipped };
}

// ---------------------------------------------------------------------------
// action:list(§5.1)
// ---------------------------------------------------------------------------

/**
 * list:树浏览(纯读 + 根层惰性建 home 根)。
 * 返回 parent(或 home 根)的直接子节点与直接挂载物品;item_count 为整棵子树计数;
 * unmounted_count = 未删且未挂载(缺失/null/悬挂)物品数;dangling_mounts 为其中悬挂件数。
 */
async function listAction(event, deps) {
  var parentId = event.parent_id;
  if (parentId !== undefined && !isString(parentId)) {
    return fail("INVALID_INPUT");
  }
  var parent;
  if (parentId === undefined || parentId === "") {
    parent = await ensureHomeRoot(deps);
  } else {
    parent = await findNodeById(deps, parentId);
    if (!parent) {
      return fail("NOT_FOUND");
    }
  }

  var nodes = await fetchHouseholdNodes(deps);
  var items = await fetchActiveItems(deps);
  var stats = buildItemCountMap(nodes, items);
  var childCounts = buildChildCountMap(nodes);

  var children = [];
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].parent_id === parent._id) {
      children.push(summarize(nodes[i], stats.counts, childCounts));
    }
  }
  children.sort(byItemCountDescNameAsc);

  var mountedHere = [];
  var unmounted = 0;
  var byId = tree.indexById(nodes);
  for (var k = 0; k < items.length; k++) {
    var it = items[k];
    var at = it.location_node_id;
    if (at === parent._id) {
      mountedHere.push(projectItem(it));
    }
    if (at === undefined || at === null || at === "" || !byId[at]) {
      unmounted += 1; // 统一口径:缺失、null 或指向不存在的节点都算未挂载
    }
  }
  mountedHere.sort(byUpdatedDesc);

  // household_id(issue #34 P0):服务端解析的当前家庭(sha256 派生或共享家庭 id,
  // 非 PII),供客户端捕获家庭作用域;共享家庭另带 scope_revision(issue #34 P1-A,
  // 写请求前捕获作用域+修订的来源);仅此只读 action 与 itemsApi.list 携带这些字段
  var res = {
    ok: true,
    household_id: deps.householdId,
    node: summarize(parent, stats.counts, childCounts),
    children: children,
    items: mountedHere,
    unmounted_count: unmounted,
    dangling_mounts: stats.dangling
  };
  if (deps.householdShared === true) {
    res.scope_revision = deps.scopeRevision;
  }
  return res;
}

// ---------------------------------------------------------------------------
// action:ensurePath(§5.3)
// ---------------------------------------------------------------------------

/** 校验路径段数组(1-6 段、每段去首尾空白 1-30 码点),返回清洗后数组或 null */
function cleanPathSegments(raw) {
  if (!Array.isArray(raw)) {
    return null;
  }
  if (raw.length < 1 || raw.length > PATH_MAX_SEGMENTS) {
    return null;
  }
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var seg = cleanNodeName(raw[i]);
    if (seg === null) {
      return null;
    }
    out.push(seg);
  }
  return out;
}

/** ensurePath:确认后沿路径建缺失节点(唯一建节点入口,路径即幂等键,不碰 items) */
async function ensurePathAction(event, deps) {
  var segments = cleanPathSegments(event.path);
  if (segments === null) {
    return fail("INVALID_INPUT");
  }
  var createdFrom = event.created_from === undefined ? "manual" : event.created_from;
  if (CREATED_FROM_VALUES.indexOf(createdFrom) === -1 || createdFrom === "bootstrap") {
    return fail("INVALID_INPUT");
  }
  var ensured = await ensurePathSegments(deps, segments, createdFrom);
  var nodes = await fetchHouseholdNodes(deps);
  var items = await fetchActiveItems(deps);
  var stats = buildItemCountMap(nodes, items);
  var childCounts = buildChildCountMap(nodes);
  return {
    ok: true,
    nodes: ensured.nodes.map(function (n) {
      return summarize(n, stats.counts, childCounts);
    }),
    created: ensured.created
  };
}

// ---------------------------------------------------------------------------
// action:rename(§5.4)
// ---------------------------------------------------------------------------

/** rename:节点改名 + 自身与全部后代 path 级联重写;绝不碰 items */
async function renameAction(event, deps) {
  if (!validItemId(event.node_id)) {
    return fail("INVALID_INPUT");
  }
  var name = cleanNodeName(event.name);
  if (name === null) {
    return fail("INVALID_INPUT");
  }
  var node = await findNodeById(deps, event.node_id);
  if (!node) {
    return fail("NOT_FOUND");
  }
  if (isHomeRoot(node)) {
    return fail("INVALID_INPUT");
  }
  var nodes = await fetchHouseholdNodes(deps);
  var newNorm = normalizeName(name);
  var siblings = tree.directChildren(nodes, node.parent_id);
  for (var i = 0; i < siblings.length; i++) {
    if (siblings[i]._id !== node._id && siblings[i].name_norm === newNorm) {
      return fail("NODE_CONFLICT");
    }
  }
  var cascaded = tree.cascadedPathsAfterRename(nodes, node, name);
  await locCol(deps)
    .where({ _id: node._id, household_id: deps.householdId })
    .update({ data: { name: name, name_norm: newNorm, path: cascaded[0].path, updated_at: deps.now() } });
  for (var j = 1; j < cascaded.length; j++) {
    await locCol(deps).doc(cascaded[j]._id).update({ data: { path: cascaded[j].path } });
  }
  var fresh = await findNodeById(deps, node._id);
  return { ok: true, node: await summarizeWithStats(deps, fresh) };
}

// ---------------------------------------------------------------------------
// action:move(§5.5)
// ---------------------------------------------------------------------------

/** move:节点移动 + path 前缀整体重写;防环、防同层重名、防超深;不碰 items */
async function moveAction(event, deps) {
  if (!validItemId(event.node_id) || !validItemId(event.new_parent_id)) {
    return fail("INVALID_INPUT");
  }
  var node = await findNodeById(deps, event.node_id);
  if (!node) {
    return fail("NOT_FOUND");
  }
  var newParent = await findNodeById(deps, event.new_parent_id);
  if (!newParent) {
    return fail("NOT_FOUND");
  }
  if (isHomeRoot(node) || isHomeRoot(newParent)) {
    return fail("INVALID_INPUT");
  }
  var nodes = await fetchHouseholdNodes(deps);
  if (newParent._id === node._id || tree.isDescendant(nodes, node._id, newParent._id)) {
    return fail("NODE_CONFLICT", "不能移动到自己下面");
  }
  var nodeNorm = node.name_norm;
  var newSiblings = tree.directChildren(nodes, newParent._id);
  for (var i = 0; i < newSiblings.length; i++) {
    if (newSiblings[i]._id !== node._id && newSiblings[i].name_norm === nodeNorm) {
      return fail("NODE_CONFLICT");
    }
  }
  var newPrefixLen = newParent.path.length + 1;
  var subtreeRel = tree.maxRelativeDepth(nodes, node._id);
  if (newPrefixLen + subtreeRel > PATH_MAX_SEGMENTS) {
    return fail("INVALID_INPUT", "层级太深了");
  }
  var cascaded = tree.cascadedPathsAfterAdopt(nodes, node, newParent.path);
  await locCol(deps)
    .where({ _id: node._id, household_id: deps.householdId })
    .update({
      data: {
        parent_id: newParent._id,
        path: cascaded[0].path,
        updated_at: deps.now()
      }
    });
  for (var j = 1; j < cascaded.length; j++) {
    await locCol(deps).doc(cascaded[j]._id).update({ data: { path: cascaded[j].path } });
  }
  var fresh = await findNodeById(deps, node._id);
  return { ok: true, node: await summarizeWithStats(deps, fresh) };
}

// ---------------------------------------------------------------------------
// action:merge(§5.6)
// ---------------------------------------------------------------------------

/** merge 中止响应:VERSION_CONFLICT + 冲突件清单(名称只出现在响应,绝不进日志) */
function mergeConflictAbort(conflicts) {
  return {
    ok: false,
    error: "VERSION_CONFLICT",
    message: "部分物品刚被修改,请重试",
    detail: { conflicted: conflicts }
  };
}

/** merge 物品阶段(含后置校验循环):逐件条件重挂,冲突即中止;返回 { remounted } 或 { abort:[..] } */
async function mergeRemountPhase(deps, source, target) {
  var remounted = 0;
  var guard = 0;
  while (true) {
    var mounted = await fetchAllPages(deps, ITEMS_COLLECTION, {
      household_id: deps.householdId,
      deleted: false,
      location_node_id: source._id
    });
    if (mounted.length === 0) {
      return { remounted: remounted };
    }
    guard += 1;
    if (guard > 5) {
      throw new Error("merge remount exceeded retry guard");
    }
    for (var i = 0; i < mounted.length; i++) {
      var item = mounted[i];
      var updateId = "merge:" + deps.digest(source._id + "→" + target._id + ":" + item._id);
      var res = await conditionalMountUpdate(deps, item, target._id, updateId, "merge");
      if (res.updated >= 1) {
        remounted += 1;
        continue;
      }
      // 0 命中:重读一次,区分「已完成重放 / 已删 / 真冲突」(§5.6 步骤 1)
      var cur = await itemsCol(deps)
        .where({ _id: item._id, household_id: deps.householdId, deleted: false })
        .get();
      if (!cur.data || cur.data.length === 0) {
        continue; // 已被删除:无需重挂,继续下一件
      }
      var doc = cur.data[0];
      if (doc.location_node_id === target._id) {
        continue; // 上次或本次已完成
      }
      if (isReplay(doc, item.version, res.updateId, res.fingerprint)) {
        continue; // 派生标识重放识别:已完成
      }
      return { abort: [{ item_id: item._id, current_version: doc.version }] };
    }
  }
}

/**
 * merge:合并重复节点。逐件条件重挂载(冲突即中止、重试收敛)→ 后置校验 →
 * 子树挂靠(id 不变,后代物品零改动)→ 硬删 source → 补偿摘除。
 */
async function mergeAction(event, deps) {
  if (!validItemId(event.source_node_id) || !validItemId(event.target_node_id)) {
    return fail("INVALID_INPUT");
  }
  var source = await findNodeById(deps, event.source_node_id);
  var target = await findNodeById(deps, event.target_node_id);
  if (!source) {
    // source 查不到:跨家庭/不存在(NOT_FOUND),或重试时已被上次 merge 硬删(already_merged)。
    // 用「本家庭是否存在该 merge 的派生标识写入痕迹」区分:同 source/target 的确定性 digest,
    // 跨家庭调用不可能命中本家庭的写入痕迹(itemsApi/locations 都只写自己家庭)。
    if (!target) {
      return fail("NOT_FOUND");
    }
    var items = await fetchActiveItems(deps);
    var prefixCore = event.source_node_id + "→" + event.target_node_id + ":";
    var merged = false;
    for (var p = 0; p < items.length; p++) {
      if (items[p].last_update_id === "merge:" + deps.digest(prefixCore + items[p]._id)) {
        merged = true;
        break;
      }
    }
    if (!merged) {
      return fail("NOT_FOUND");
    }
    return {
      ok: true,
      node: await summarizeWithStats(deps, target),
      remounted: 0,
      compensated: 0,
      compensated_skipped: 0,
      detail: { already_merged: true }
    };
  }
  if (!target) {
    return fail("NOT_FOUND");
  }
  if (source._id === target._id) {
    return fail("NODE_CONFLICT");
  }
  if (isHomeRoot(source) || isHomeRoot(target)) {
    return fail("INVALID_INPUT"); // home 根不可合并(§1.1)
  }
  var nodes = await fetchHouseholdNodes(deps);
  if (tree.isDescendant(nodes, source._id, target._id)) {
    return fail("NODE_CONFLICT"); // target 是 source 的后代
  }
  var sourceChildren = tree.directChildren(nodes, source._id);
  if (sourceChildren.length > 0 && source.path.length !== target.path.length) {
    // 纯结构规则(issue #30 PR A,替代 PR #28 的类型检查;path 可能为空数组——根,
    // 但根已在上方 isHomeRoot 拦截,这里按 path.length 比较深度):source 带直接子节点
    // 且与 target 不同深度 → 拒绝,子树嫁接到不同深度会整体改变其层级结构,引导先移动;
    // 叶子 source(无直接子节点)任意深度允许——只重挂物品、删 source,不移动任何子树
    // (issue #27);同深度带子树允许——子树随挂靠仅换同层前缀,结构不变。
    return fail(
      "INVALID_INPUT",
      "两者层级不同,不能直接合并;可先把「" + source.name + "」移动到与目标同级,或把它里面的位置移走后再合并"
    );
  }
  var targetChildren = tree.directChildren(nodes, target._id);
  var targetNorms = Object.create(null);
  for (var t = 0; t < targetChildren.length; t++) {
    targetNorms[targetChildren[t].name_norm] = true;
  }
  var clashing = [];
  for (var c = 0; c < sourceChildren.length; c++) {
    if (targetNorms[sourceChildren[c].name_norm]) {
      clashing.push(sourceChildren[c].name_norm);
    }
  }
  if (clashing.length > 0) {
    return { ok: false, error: "NODE_CONFLICT", message: ERROR_MESSAGES.NODE_CONFLICT, detail: { clashing_names: clashing } };
  }

  // 1. 物品阶段:逐件条件重挂载 + 冲突即中止(后置校验在 mergeRemountPhase 的循环内)
  var phase = await mergeRemountPhase(deps, source, target);
  if (phase.abort) {
    return mergeConflictAbort(phase.abort);
  }

  // 2. 结构阶段:source 直接子节点挂靠 target(id 不变,后代物品无需任何改动)
  for (var s = 0; s < sourceChildren.length; s++) {
    var child = sourceChildren[s];
    if (child.parent_id !== source._id) {
      continue; // 幂等:已被上次 merge 挂到 target
    }
    var cascaded = tree.cascadedPathsAfterAdopt(nodes, child, target.path);
    var moved = await locCol(deps)
      .where({ _id: child._id, household_id: deps.householdId, parent_id: source._id })
      .update({ data: { parent_id: target._id, path: cascaded[0].path, updated_at: deps.now() } });
    if ((moved && moved.stats && moved.stats.updated) === 0) {
      continue; // 并发已改:不覆盖
    }
    for (var d = 1; d < cascaded.length; d++) {
      await locCol(deps).doc(cascaded[d]._id).update({ data: { path: cascaded[d].path } });
    }
  }

  // 3. 硬删 source,随即补偿扫描摘除悬挂挂载(§1.1 第②层)
  await locCol(deps).doc(source._id).remove();
  var victims = await fetchAllPages(deps, ITEMS_COLLECTION, {
    household_id: deps.householdId,
    deleted: false,
    location_node_id: source._id
  });
  var comp = await compensateUnmount(deps, victims, function (item) {
    return "compensate:" + deps.digest(source._id + ":" + item._id);
  });

  var freshTarget = await findNodeById(deps, target._id);
  return {
    ok: true,
    node: await summarizeWithStats(deps, freshTarget),
    remounted: phase.remounted,
    compensated: comp.compensated,
    compensated_skipped: comp.skipped
  };
}

// ---------------------------------------------------------------------------
// action:delete(§5.7)
// ---------------------------------------------------------------------------

/**
 * delete:硬删除。空节点保护(物品永远不能被结构操作丢弃);force 也拦有物品子树;
 * 无物品的空分支整支硬删;删后补偿扫描摘除悬挂挂载。
 */
async function deleteAction(event, deps) {
  if (!validItemId(event.node_id)) {
    return fail("INVALID_INPUT");
  }
  if (event.force !== undefined && typeof event.force !== "boolean") {
    return fail("INVALID_INPUT");
  }
  var node = await findNodeById(deps, event.node_id);
  if (!node) {
    return fail("NOT_FOUND");
  }
  if (isHomeRoot(node)) {
    return fail("INVALID_INPUT");
  }
  var nodes = await fetchHouseholdNodes(deps);
  var sub = tree.collectSubtree(nodes, node._id);
  var subtreeIds = Object.create(null);
  for (var i = 0; i < sub.ids.length; i++) {
    subtreeIds[sub.ids[i]] = true;
  }
  var items = await fetchActiveItems(deps);
  var mountedInSubtree = [];
  for (var k = 0; k < items.length; k++) {
    var at = items[k].location_node_id;
    if (at !== undefined && at !== null && at !== "" && subtreeIds[at]) {
      mountedInSubtree.push(items[k]);
    }
  }
  var itemCount = mountedInSubtree.length;
  var descendantCount = sub.ids.length - 1;
  var force = event.force === true;
  if (itemCount > 0 || (!force && descendantCount > 0)) {
    return {
      ok: false,
      error: "NODE_NOT_EMPTY",
      message: ERROR_MESSAGES.NODE_NOT_EMPTY,
      detail: { item_count: itemCount, descendant_count: descendantCount }
    };
  }

  for (var r = 0; r < sub.ids.length; r++) {
    await locCol(deps).doc(sub.ids[r]).remove();
  }
  // 补偿扫描:拦截「计数时为 0 → 并发 linkItem 写入 → 硬删」的交错(§5.7)
  var dangling = await fetchActiveItems(deps);
  var victims = [];
  for (var v = 0; v < dangling.length; v++) {
    var at2 = dangling[v].location_node_id;
    if (at2 !== undefined && at2 !== null && at2 !== "" && subtreeIds[at2]) {
      victims.push(dangling[v]);
    }
  }
  var comp = await compensateUnmount(deps, victims, function (item) {
    return "compensate:" + deps.digest(item.location_node_id + ":" + item._id);
  });
  return {
    ok: true,
    deleted_nodes: sub.ids.length,
    compensated: comp.compensated,
    compensated_skipped: comp.skipped
  };
}

// ---------------------------------------------------------------------------
// action:linkItem / unlinkItem(§5.8)
// ---------------------------------------------------------------------------

/** linkItem/unlinkItem 共用:条件更新 0 命中后的回查分流(重放识别 / 冲突 / 不存在) */
async function resolveMountMiss(deps, itemId, expectedVersion, updateId, fingerprint) {
  var cur = await itemsCol(deps)
    .where({ _id: itemId, household_id: deps.householdId, deleted: false })
    .get();
  if (!cur.data || cur.data.length === 0) {
    return fail("NOT_FOUND");
  }
  var doc = cur.data[0];
  if (isReplay(doc, expectedVersion, updateId, fingerprint)) {
    return { ok: true, replayed: true, item: { item_id: doc._id, version: doc.version, updated_at: doc.updated_at } };
  }
  return fail("VERSION_CONFLICT");
}

/** linkItem:把物品挂到节点(itemsApi.update 同构:条件更新 + 三重重放识别) */
async function linkItemAction(event, deps) {
  if (!validItemId(event.item_id) || !validItemId(event.node_id)) {
    return fail("INVALID_INPUT");
  }
  if (!validPositiveVersion(event.expected_version) || !validUpdateId(event.update_id)) {
    return fail("INVALID_INPUT");
  }
  var node = await findNodeById(deps, event.node_id);
  if (!node) {
    return fail("NOT_FOUND");
  }
  if (isHomeRoot(node)) {
    return fail("INVALID_INPUT"); // 物品不允许直接挂在 home 根上(§1.1)
  }
  var item = await itemsCol(deps)
    .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
    .get();
  if (!item.data || item.data.length === 0) {
    return fail("NOT_FOUND");
  }
  // 乐观并发:条件 version = 客户端声明的 expected_version(itemsApi.update 同构),
  // 绝不以「读到的当前 version」放行并发过期写入;from_node_id 取读取到的当前挂载
  // (文档若在读取后被并发改动,version 条件必然失配,历史不会记错来源)。
  var res = await conditionalMountUpdate(
    deps,
    {
      _id: event.item_id,
      version: event.expected_version,
      location_node_id: item.data[0].location_node_id
    },
    event.node_id,
    event.update_id,
    "link"
  );
  if (res.updated >= 1) {
    var after = await itemsCol(deps)
      .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
      .get();
    var fresh = after.data[0];
    return { ok: true, item: { item_id: fresh._id, version: fresh.version, updated_at: fresh.updated_at } };
  }
  return resolveMountMiss(deps, event.item_id, event.expected_version, event.update_id, res.fingerprint);
}

/** unlinkItem:摘除物品挂载(置 null;未挂载物品照常版本 +1,与 itemsApi 语义一致) */
async function unlinkItemAction(event, deps) {
  if (!validItemId(event.item_id)) {
    return fail("INVALID_INPUT");
  }
  if (!validPositiveVersion(event.expected_version) || !validUpdateId(event.update_id)) {
    return fail("INVALID_INPUT");
  }
  var item = await itemsCol(deps)
    .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
    .get();
  if (!item.data || item.data.length === 0) {
    return fail("NOT_FOUND");
  }
  var res = await conditionalMountUpdate(
    deps,
    {
      _id: event.item_id,
      version: event.expected_version,
      location_node_id: item.data[0].location_node_id
    },
    null,
    event.update_id,
    "unlink"
  );
  if (res.updated >= 1) {
    var after = await itemsCol(deps)
      .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
      .get();
    var fresh = after.data[0];
    return { ok: true, item: { item_id: fresh._id, version: fresh.version, updated_at: fresh.updated_at } };
  }
  return resolveMountMiss(deps, event.item_id, event.expected_version, event.update_id, res.fingerprint);
}

// ---------------------------------------------------------------------------
// action:applyScan(§5.10)
// ---------------------------------------------------------------------------

/**
 * applyScan:向导确认结果的一次性提交。参数校验(零写入)→ branches 逐条 ensurePath →
 * mounts 逐件「完整 path ensurePath 到末段 + 版本条件更新挂载」,逐件状态零静默。
 */
async function applyScanAction(event, deps) {
  if (!validUpdateId(event.operation_id)) {
    return fail("INVALID_INPUT");
  }
  var branchesRaw = event.branches === undefined ? [] : event.branches;
  var mountsRaw = event.mounts === undefined ? [] : event.mounts;
  if (!Array.isArray(branchesRaw) || !Array.isArray(mountsRaw)) {
    return fail("INVALID_INPUT");
  }
  if (branchesRaw.length > APPLY_BRANCHES_MAX || mountsRaw.length > APPLY_MOUNTS_MAX) {
    return fail("INVALID_INPUT");
  }
  if (branchesRaw.length === 0 && mountsRaw.length === 0) {
    return fail("INVALID_INPUT");
  }
  var branches = [];
  for (var b = 0; b < branchesRaw.length; b++) {
    var segs = cleanPathSegments(branchesRaw[b] && branchesRaw[b].path);
    if (segs === null) {
      return fail("INVALID_INPUT");
    }
    branches.push(segs);
  }
  var mounts = [];
  for (var m = 0; m < mountsRaw.length; m++) {
    var mount = mountsRaw[m];
    if (!mount || !validItemId(mount.item_id) || !validPositiveVersion(mount.expected_version)) {
      return fail("INVALID_INPUT");
    }
    var mSegs = cleanPathSegments(mount.path);
    if (mSegs === null) {
      return fail("INVALID_INPUT");
    }
    mounts.push({ item_id: mount.item_id, expected_version: mount.expected_version, path: mSegs });
  }

  var branchResults = [];
  for (var i = 0; i < branches.length; i++) {
    var ensured = await ensurePathSegments(deps, branches[i], "scan");
    branchResults.push({
      path: branches[i],
      created: ensured.created,
      location_ids: ensured.nodes.map(function (n) {
        return n._id;
      })
    });
  }

  var mountResults = [];
  for (var j = 0; j < mounts.length; j++) {
    var one = mounts[j];
    var pathEnsured = await ensurePathSegments(deps, one.path, "scan");
    var targetId = pathEnsured.nodes[pathEnsured.nodes.length - 1]._id;
    var updateId = "scan:" + deps.digest(event.operation_id + ":" + one.item_id);
    // 扫描池只收未挂载物品,from_node_id 按 null 记(§5.9;item 构造体不带该字段)
    var res = await conditionalMountUpdate(
      deps,
      { _id: one.item_id, version: one.expected_version },
      targetId,
      updateId,
      "apply_scan"
    );
    if (res.updated >= 1) {
      mountResults.push({ item_id: one.item_id, status: "mounted", version: one.expected_version + 1 });
      continue;
    }
    var cur = await itemsCol(deps)
      .where({ _id: one.item_id, household_id: deps.householdId, deleted: false })
      .get();
    if (!cur.data || cur.data.length === 0) {
      mountResults.push({ item_id: one.item_id, status: "not_found" });
      continue;
    }
    var doc = cur.data[0];
    if (isReplay(doc, one.expected_version, updateId, res.fingerprint) || doc.location_node_id === targetId) {
      mountResults.push({ item_id: one.item_id, status: "already", version: doc.version });
      continue;
    }
    mountResults.push({ item_id: one.item_id, status: "conflict", current_version: doc.version });
  }

  return { ok: true, result: { branches: branchResults, mounts: mountResults } };
}

// ---------------------------------------------------------------------------
// 路由与日志(§2/§3)
// ---------------------------------------------------------------------------

var DB_ACTIONS = {
  list: listAction,
  ensurePath: ensurePathAction,
  rename: renameAction,
  move: moveAction,
  merge: mergeAction,
  delete: deleteAction,
  linkItem: linkItemAction,
  unlinkItem: unlinkItemAction,
  applyScan: applyScanAction
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
 * 两参数仅做一致性校验,不具任何授权效力;list 与 LLM 类 action 只读,不参与校验。
 */
var WRITE_DB_ACTIONS = {
  ensurePath: true,
  rename: true,
  move: true,
  merge: true,
  delete: true,
  linkItem: true,
  unlinkItem: true,
  applyScan: true
};

var LLM_ACTIONS = { parseLocation: true, scanHousehold: true };

/**
 * 日志只输出 action、错误码、耗时、计数;绝不输出原文、身份、位置名、物品名(itemsApi 同款)。
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
 * 纯函数入口:handler(event, deps)。
 * deps = { db, now(), genId(), digest(s), householdId, householdShared?,
 * scopeRevision?, logger, callLLM?(仅 LLM action 需要) }
 * (householdShared/scopeRevision 由 index.js 从解析结果注入:共享家庭写硬门依据)
 * 返回 { ok:true, ... } 或 { ok:false, error, message(中文) };基础设施异常记日志后原样上抛。
 */
async function handler(event, deps) {
  var startedAt = Date.now();
  var action = event && event.action;
  var result;
  try {
    if (!deps || !deps.householdId) {
      result = fail("UNAUTHORIZED");
    } else if (!isString(action) || (!DB_ACTIONS[action] && !LLM_ACTIONS[action])) {
      result = fail("INVALID_INPUT");
    } else if (WRITE_DB_ACTIONS[action]) {
      // F2 写入硬门(issue #34 P0+P1-A):共享家庭强制作用域绑定(缺 marker /
      // 旧修订 → FAMILY_SWITCHED / FAMILY_STALE_SCOPE,零写入);个人家庭维持
      // P0 宽松口径(可选 marker)。gate 返回 null = 放行。
      // WRITE_DB_ACTIONS 与 LLM_ACTIONS 不相交,此处只可能是 db 类写 action
      var gate = checkWriteScopeBinding(
        deps.householdId,
        deps.householdShared === true,
        deps.scopeRevision,
        event
      );
      result = gate === null ? await DB_ACTIONS[action](event, deps) : gate;
    } else if (LLM_ACTIONS[action]) {
      // LLM 编排与 db 胶水分离(§4.1);此处 lazy require 避免循环依赖
      var parseMod = require("./parse");
      result = await parseMod[action](event, deps);
    } else {
      result = await DB_ACTIONS[action](event, deps);
    }
  } catch (err) {
    // 基础设施异常不属于契约业务错误码:如实记日志(仅 action/错误码/耗时/计数)后向上抛出
    logResult(deps, action, { ok: false, error: "INTERNAL" }, startedAt);
    throw err;
  }
  logResult(deps, action, result, startedAt);
  return result;
}

module.exports = {
  handler: handler,
  fail: fail,
  ERROR_MESSAGES: ERROR_MESSAGES,
  changesFingerprint: changesFingerprint,
  fetchHouseholdNodes: fetchHouseholdNodes,
  fetchActiveItems: fetchActiveItems
};
