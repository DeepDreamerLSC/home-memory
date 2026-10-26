"use strict";

/**
 * locations 纯函数 handler(docs/design/location-tree.md §5)。
 * handler(event, deps):身份只来自 deps.householdId,绝不从 event 读取任何身份字段;
 * deps = { db, now(), genId(), digest(s), householdId, logger, callLLM?(仅 LLM action 需要) }。
 * - db 类 action:list/ensurePath/rename/move/merge/delete/linkItem/unlinkItem/applyScan/
 *   ensureAndLink(十七轮「放进」:建缺失路径 + 挂靠一次完成);
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
  FAMILY_STALE_SCOPE: "家庭刚发生成员或作用域变化,本次操作未保存,请刷新后重试",
  // issue #116 unmount(D0-CONTRACT v4 §3.1):三个新错误码随本 PR 并入 API_CONTRACT.md
  UNMOUNT_CONFLICT: "有物品刚在别处被修改,请核对后重新预览再删除",
  UNMOUNT_INCOMPLETE: "上次的「转为未归类」还没完成,可以继续清理",
  UNMOUNT_CHECKPOINT_CORRUPT: "清理记录异常,需要人工核对,请勿重复操作"
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
  var out = {
    location_id: node._id,
    name: node.name,
    type: node.type,
    path: node.path,
    item_count: itemCounts[node._id] || 0,
    child_count: childCounts[node._id] || 0,
    created_from: node.created_from,
    updated_at: node.updated_at
  };
  // issue #116 unmount(D0 §3.1 发现点二):仅 deleting 节点携带置灰布尔,只增字段,
  // 检查点其余明细(op_id/清单/phase/counts)绝不外泄(白名单投影)
  if (node.deleting !== undefined) {
    out.deleting = true;
  }
  return out;
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
// deleting 子树冻结门(issue #116 unmount,D0-CONTRACT v4 §3.1 包内单点判定)
// ---------------------------------------------------------------------------

/**
 * 冻结判定(§3.1 子树冻结不变量):目标节点本身或任意祖先处于 deleting ⇒ 一切
 * 新增/迁入/重挂写操作拒绝。两条等价实现路径合用(终审 P0-1 认可):① 沿
 * parent 链上溯;② 目标 id ∈ 某 deleting 根检查点的 subtree_node_ids——阶段二
 * 半途父链已断的孤儿后代由此兜住,只查目标自身字段不足够。
 * itemsApi 侧的同名判定在 cloudfunctions/itemsApi/lib/video.js 的
 * resolveLocationContext(包内副本互指,两包独立部署,行为等价性由
 * tests/location-scan-deleting-gate.test.js 锁住)。unlinkItem 放行
 * (摘挂方向与收敛一致,§3.1 入口清单)。
 */
function buildFrozenIdSet(nodes) {
  var frozen = Object.create(null);
  var byId = tree.indexById(nodes);
  for (var i = 0; i < nodes.length; i++) {
    var cur = nodes[i];
    var hit = cur.deleting !== undefined;
    var walk = cur;
    while (!hit && walk.parent_id !== "") {
      var parent = byId[walk.parent_id];
      if (!parent) {
        break; // 链断(阶段二半途):由检查点清单包含关系兜底
      }
      if (parent.deleting !== undefined) {
        hit = true;
      }
      walk = parent;
    }
    if (hit) {
      frozen[cur._id] = true;
    }
    var cp = cur.deleting;
    if (cp !== null && typeof cp === "object" && Array.isArray(cp.subtree_node_ids)) {
      for (var k = 0; k < cp.subtree_node_ids.length; k++) {
        frozen[cp.subtree_node_ids[k]] = true;
      }
    }
  }
  return frozen;
}

/** 冻结门拒绝响应(§3.1:INVALID_INPUT + detail:{reason:"deleting"},零新增错误码) */
function failDeletingFrozen() {
  return {
    ok: false,
    error: "INVALID_INPUT",
    message: ERROR_MESSAGES.INVALID_INPUT,
    detail: { reason: "deleting" }
  };
}

/**
 * 路径是否进入 deleting 冻结子树(ensurePath/applyScan/ensureAndLink 的路径型
 * 入口判定;纯内存解析既有节点,不建任何节点):沿既有节点逐段下钻,任一段命中
 * 冻结节点——复用其子节点或在其下新建都拒(挂载与建节点两个动作都冻,§3.1)。
 */
function pathEntersFrozenSubtree(nodes, segments) {
  var frozen = buildFrozenIdSet(nodes);
  var byParentNorm = Object.create(null);
  var root = null;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.parent_id === "") {
      root = n;
      continue;
    }
    byParentNorm[n.parent_id + "\u0000" + n.name_norm] = n;
  }
  if (!root) {
    return false;
  }
  var current = root;
  for (var s = 0; s < segments.length; s++) {
    if (frozen[current._id] === true) {
      return true; // 在冻结节点之下继续(复用或新建)都违反冻结
    }
    var child = byParentNorm[current._id + "\u0000" + normalizeName(segments[s])];
    if (!child) {
      return false; // 剩余段将从 current 下全新创建,current 未冻结 → 放行
    }
    if (frozen[child._id] === true) {
      return true;
    }
    current = child;
  }
  return false;
}

// ---------------------------------------------------------------------------
// action:list(§5.1)
// ---------------------------------------------------------------------------

/**
 * list:树浏览(纯读 + 根层惰性建 home 根)。
 * 返回 parent(或 home 根)的直接子节点与直接挂载物品;item_count 为整棵子树计数;
 * unmounted_count = 未删且未挂载(缺失/null/悬挂)物品数;dangling_mounts 为其中悬挂件数。
 * 根层(#36 0.6.0 真机反馈 Fix 3)另附 unmounted_items 投影(item_id/name/
 * location_text,上限 50 条按 updated_at 倒序):录了「感冒药在主卧的柜子上」
 * 但位置树还没有这些节点时,首页「尚未归类」必须看得见、点得进去。投影不带
 * note/version 等其余字段,日志不记明细(与既有日志纪律一致)。
 */
var UNMOUNTED_ITEMS_MAX = 50;

/** 未挂载物品的根层投影:只给点进详情所需的最小字段 */
function projectUnmountedItem(doc) {
  return {
    item_id: doc._id,
    name: doc.name,
    location_text: doc.location_text
  };
}

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
  var isRoot = isHomeRoot(parent);

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
  var unmountedDocs = [];
  var byId = tree.indexById(nodes);
  for (var k = 0; k < items.length; k++) {
    var it = items[k];
    var at = it.location_node_id;
    if (at === parent._id) {
      mountedHere.push(projectItem(it));
    }
    if (at === undefined || at === null || at === "" || !byId[at]) {
      unmounted += 1; // 统一口径:缺失、null 或指向不存在的节点都算未挂载
      if (isRoot) {
        unmountedDocs.push(it);
      }
    }
  }
  mountedHere.sort(byUpdatedDesc);
  // 先按 updated_at 倒序、再截断到上限、最后投影:留下的必是最近的 50 件
  unmountedDocs.sort(byUpdatedDesc);
  var unmountedItems = unmountedDocs
    .slice(0, UNMOUNTED_ITEMS_MAX)
    .map(projectUnmountedItem);

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
  if (isRoot) {
    res.unmounted_items = unmountedItems;
  }
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
  // deleting 冻结门(D0 §3.1 入口清单):子树冻结清单创建后不变、不含新节点,
  // 向 deleting 子树建节点本身即违反冻结——纯读判定,零写入
  var freezeNodes = await fetchHouseholdNodes(deps);
  if (pathEntersFrozenSubtree(freezeNodes, segments)) {
    return failDeletingFrozen();
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
  // deleting 冻结门(D0 §3.1):作用于 deleting 子树内节点(含根)的结构动作一律拒
  if (buildFrozenIdSet(nodes)[node._id] === true) {
    return failDeletingFrozen();
  }
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
  // deleting 冻结门(D0 §3.1):move 任一端落在 deleting 子树内即拒
  var frozenForMove = buildFrozenIdSet(nodes);
  if (frozenForMove[node._id] === true || frozenForMove[newParent._id] === true) {
    return failDeletingFrozen();
  }
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
  // deleting 冻结门(D0 §3.1):merge 的 source 或 target 落在 deleting 子树内即拒
  var frozenForMerge = buildFrozenIdSet(nodes);
  if (frozenForMerge[source._id] === true || frozenForMerge[target._id] === true) {
    return failDeletingFrozen();
  }
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
  // deleting 冻结门(D0 v4 终审 P0-2 点名的绕过点):阶段一摘空物品后 delete(force)
  // 恰满足其空判,可把带 deleting 检查点的根整支硬删、检查点随之消失——必须关死
  if (buildFrozenIdSet(nodes)[node._id] === true) {
    return failDeletingFrozen();
  }
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
  // deleting 冻结门(D0 §3.1):重挂目标(自身或任意祖先 deleting)一律拒
  var freezeNodesForLink = await fetchHouseholdNodes(deps);
  if (buildFrozenIdSet(freezeNodesForLink)[node._id] === true) {
    return failDeletingFrozen();
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

  // deleting 冻结门(D0 §3.1):branches 与 mounts 的路径落在 deleting 子树内即拒,
  // 整批零写(逐件状态如实返回语义升级为整批显式拒绝,v4 反例矩阵口径)
  var freezeNodesForScan = await fetchHouseholdNodes(deps);
  for (var fb = 0; fb < branches.length; fb++) {
    if (pathEntersFrozenSubtree(freezeNodesForScan, branches[fb])) {
      return failDeletingFrozen();
    }
  }
  for (var fm = 0; fm < mounts.length; fm++) {
    if (pathEntersFrozenSubtree(freezeNodesForScan, mounts[fm].path)) {
      return failDeletingFrozen();
    }
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
// action:ensureAndLink(十七轮「放进」:确认卡明示路径、用户确认后的一次性提交)
// ---------------------------------------------------------------------------

/**
 * ensureAndLink:入参 { item_id, path(≥1 段,首段=房间/大区域,1-6 段每段 1-30 码点),
 * expected_version(正整数), update_id(非空 ≤64,失败重试同内容复用),
 * created_from?("scan"|"parse"|"manual",缺省 manual) }。
 * 流程:先查物品(跨家庭/已删 → NOT_FOUND,零写入——路径节点一个都不建)→
 * ensurePath 建缺失路径(用户已在确认卡看过完整路径 = 已确认,服务端不再拦;
 * 全系统唯一建节点入口复用,路径幂等)→ linkItem 同款版本条件更新挂上。
 * 幂等:重复同路径 = 成功(already:true,version 不再 +1);响应丢失重试按
 * 「已挂目标节点」收敛。挂靠失败绝不删物品(物品已在,失败如实返回,客户端
 * 提示先放「尚未归类」);绝不静默改挂到别处(不在目标上 → VERSION_CONFLICT)。
 * 共享名称合并建议不在此做(整理位置入口另行裁决)。
 */
async function ensureAndLinkAction(event, deps) {
  if (!validItemId(event.item_id)) {
    return fail("INVALID_INPUT");
  }
  if (!validPositiveVersion(event.expected_version) || !validUpdateId(event.update_id)) {
    return fail("INVALID_INPUT");
  }
  var segments = cleanPathSegments(event.path);
  if (segments === null) {
    return fail("INVALID_INPUT");
  }
  var createdFrom = event.created_from === undefined ? "manual" : event.created_from;
  if (CREATED_FROM_VALUES.indexOf(createdFrom) === -1 || createdFrom === "bootstrap") {
    return fail("INVALID_INPUT");
  }
  // 先查物品(当前家庭):不存在/已删/跨家庭 → NOT_FOUND,且零路径写入
  var item = await itemsCol(deps)
    .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
    .get();
  if (!item.data || item.data.length === 0) {
    return fail("NOT_FOUND");
  }
  var current = item.data[0];

  // deleting 冻结门(D0 §3.1):路径任一段落在 deleting 子树内即拒——该链路经
  // ensurePathSegments 自动建节点,挂载与建节点两个动作都要冻结;零路径写入
  var freezeNodesForEnsure = await fetchHouseholdNodes(deps);
  if (pathEntersFrozenSubtree(freezeNodesForEnsure, segments)) {
    return failDeletingFrozen();
  }

  // 建缺失路径(用户已在确认卡确认过完整路径;并发 E11000 回查复用,绝不双建)
  var ensured = await ensurePathSegments(deps, segments, createdFrom);
  var targetId = ensured.nodes[ensured.nodes.length - 1]._id;
  var base = {
    path: segments,
    created: ensured.created,
    location_ids: ensured.nodes.map(function (n) {
      return n._id;
    })
  };

  // 幂等:已挂同一路径 → 成功(重复点「确认记住」/响应丢失后的重试收敛点)
  if (current.location_node_id === targetId) {
    return Object.assign(
      {
        ok: true,
        already: true,
        item: { item_id: current._id, version: current.version, updated_at: current.updated_at }
      },
      base
    );
  }

  // linkItem 同构:以客户端声明的 expected_version 条件更新(同一版本链,
  // 绝不以「读到的当前 version」放行并发过期写入)
  var res = await conditionalMountUpdate(
    deps,
    {
      _id: event.item_id,
      version: event.expected_version,
      location_node_id: current.location_node_id
    },
    targetId,
    event.update_id,
    "link"
  );
  if (res.updated >= 1) {
    var after = await itemsCol(deps)
      .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
      .get();
    var fresh = after.data[0];
    return Object.assign(
      {
        ok: true,
        already: false,
        item: { item_id: fresh._id, version: fresh.version, updated_at: fresh.updated_at }
      },
      base
    );
  }
  // 0 命中回查:已挂目标(幂等)/已被并发改动(冲突)/已删(不存在)三态分流;
  // 物品本身绝不被本 action 删除——挂靠失败如实返回,物品原样保留
  var cur = await itemsCol(deps)
    .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
    .get();
  if (!cur.data || cur.data.length === 0) {
    return fail("NOT_FOUND");
  }
  var doc = cur.data[0];
  if (doc.location_node_id === targetId) {
    return Object.assign(
      {
        ok: true,
        already: true,
        replayed: true,
        item: { item_id: doc._id, version: doc.version, updated_at: doc.updated_at }
      },
      base
    );
  }
  return fail("VERSION_CONFLICT");
}

// ---------------------------------------------------------------------------
// action:deletePreview / deleteLocation(#94 D1 删除位置三按钮)
// ---------------------------------------------------------------------------

var SCANS_COLLECTION = "location_scans";
var VIDEO_EVIDENCE_COLLECTION = "video_evidence";

/** 子树 id → true 布尔表(含自身) */
function subtreeIdSet(ids) {
  var set = Object.create(null);
  for (var i = 0; i < ids.length; i++) set[ids[i]] = true;
  return set;
}

/** 物品是否挂载在子树内(未挂载/悬挂不算) */
function itemMountedInSubtree(item, subtreeIds) {
  var at = item.location_node_id;
  return at !== undefined && at !== null && at !== "" && subtreeIds[at] === true;
}

/**
 * 子树内 scan 行状态迁移(条件 update,幂等重试安全):fromStatus → toStatus +
 * 时间戳字段;只动本家庭、只动 fromStatus 行,已迁移/已删的原样不动。
 * scan 行随位置走生命周期(active → location_deleted / deleted),绝不删任何
 * 证据行/云文件/物品(§5.2)。
 */
async function markSubtreeScans(deps, subtreeIds, fromStatus, toStatus, atField) {
  var scans = await fetchAllPages(deps, SCANS_COLLECTION, {
    household_id: deps.householdId,
    status: fromStatus
  });
  var marked = 0;
  var now = deps.now();
  for (var i = 0; i < scans.length; i++) {
    if (subtreeIds[scans[i].location_id] !== true) continue;
    var patch = { status: toStatus, updated_at: now };
    patch[atField] = now;
    await deps.db.collection(SCANS_COLLECTION)
      .where({ _id: scans[i]._id, household_id: deps.householdId, status: fromStatus })
      .update({ data: patch });
    marked += 1;
  }
  return marked;
}

// ---------------------------------------------------------------------------
// unmount 检查点机器(issue #116,D0-CONTRACT v4 §3/§3.1:B1 最薄操作检查点)
// ---------------------------------------------------------------------------

var DELETING_PHASES = ["nodes", "compensate", "scans", "final"];

function phaseIndexOf(name) {
  return DELETING_PHASES.indexOf(name);
}

/**
 * 检查点投影(§3.1 发现点一:deletePreview/UNMOUNT_INCOMPLETE 响应摘要;
 * 响应属用户本人数据,清单与 op_id 明细绝不进日志)。
 */
function projectCheckpoint(cp) {
  return {
    op_id: cp.op_id,
    phase: cp.phase,
    status: cp.status,
    created_at: cp.created_at,
    counts: {
      unmounted: cp.counts.unmounted,
      compensated: cp.counts.compensated,
      conflicts: cp.counts.conflicts
    }
  };
}

/**
 * 检查点形状校验(续跑前置;违者 UNMOUNT_CHECKPOINT_CORRUPT 失败关闭,零删除零
 * 标记零续跑,绝不猜测续跑、绝不静默清标记):op_id 必须等于 node_id 的确定性
 * 派生值(同节点重入同值;op_id 只做重放识别,互斥由条件写承担)、subtree_node_ids
 * 非空字符串数组且含根、phase/status 闭集、counts 为非负整数。
 */
function validCheckpoint(cp, rootId, deps) {
  if (cp === null || typeof cp !== "object" || Array.isArray(cp)) {
    return null;
  }
  if (cp.op_id !== "unmount:" + deps.digest(rootId)) {
    return null;
  }
  if (cp.node_id !== rootId) {
    return null;
  }
  if (!Array.isArray(cp.subtree_node_ids) || cp.subtree_node_ids.length < 1) {
    return null;
  }
  var hasRoot = false;
  for (var i = 0; i < cp.subtree_node_ids.length; i++) {
    if (!isString(cp.subtree_node_ids[i])) {
      return null;
    }
    if (cp.subtree_node_ids[i] === rootId) {
      hasRoot = true;
    }
  }
  if (!hasRoot) {
    return null;
  }
  if (phaseIndexOf(cp.phase) === -1) {
    return null;
  }
  if (cp.status !== "pending" && cp.status !== "conflict") {
    return null;
  }
  if (cp.counts === null || typeof cp.counts !== "object" || Array.isArray(cp.counts)) {
    return null;
  }
  if (!Number.isInteger(cp.counts.unmounted) || cp.counts.unmounted < 0) {
    return null;
  }
  if (!Number.isInteger(cp.counts.compensated) || cp.counts.compensated < 0) {
    return null;
  }
  if (!Number.isInteger(cp.counts.conflicts) || cp.counts.conflicts < 0) {
    return null;
  }
  if (!isString(cp.created_at)) {
    return null;
  }
  return cp;
}

/**
 * 检查点读改写(条件更新,§3.1「检查点并发约束」):重读根文档取最新 updated_at,
 * 条件写整份检查点(updated_at CAS,防交错);失配 ⇒ 重读最新态返回(op_id+phase
 * 匹配才前进的语义由调用方保证,后写者失配重读再续,phase 单调不回退)。
 * 返回 {cp} / {corrupt:true} / null(根或检查点已消失,调用方终检兜底)。
 */
async function writeCheckpointStep(deps, cp, patch) {
  var fresh = await findNodeById(deps, cp.node_id);
  if (!fresh || fresh.deleting === undefined) {
    return null;
  }
  var latest = validCheckpoint(fresh.deleting, cp.node_id, deps);
  if (latest === null) {
    return { corrupt: true };
  }
  var updated = Object.assign({}, latest, patch);
  var res = await locCol(deps)
    .where({ _id: cp.node_id, household_id: deps.householdId, updated_at: fresh.updated_at })
    .update({ data: { deleting: updated, updated_at: deps.now() } });
  if (res && res.stats && res.stats.updated >= 1) {
    return { cp: updated };
  }
  var again = await findNodeById(deps, cp.node_id);
  if (again && again.deleting !== undefined) {
    var againCp = validCheckpoint(again.deleting, cp.node_id, deps);
    if (againCp === null) {
      return { corrupt: true };
    }
    return { cp: againCp };
  }
  return null;
}

/**
 * phase 条件推进(§3.1):仅当读到的 phase 恰为本轮已完成阶段才前进一位
 * (单调不回退;并发已推进 ⇒ 以读到的为准,各阶段幂等保证收敛)。
 */
async function advanceCheckpointPhase(deps, cp, completedPhase, counts) {
  if (phaseIndexOf(cp.phase) !== phaseIndexOf(completedPhase)) {
    return cp;
  }
  var r = await writeCheckpointStep(deps, cp, {
    phase: DELETING_PHASES[phaseIndexOf(completedPhase) + 1],
    counts: counts,
    status: "pending"
  });
  if (r === null) {
    return cp;
  }
  if (r.corrupt) {
    throw new Error("unmount checkpoint corrupt on advance");
  }
  return r.cp;
}

/** 补偿冲突落检查点:status:"conflict"(phase 原地保留,根与清单在,§3.1 恢复矩阵) */
async function markCheckpointConflict(deps, cp, counts) {
  var r = await writeCheckpointStep(deps, cp, { counts: counts, status: "conflict" });
  if (r !== null && r.corrupt) {
    throw new Error("unmount checkpoint corrupt on conflict");
  }
  return r !== null && r.cp ? r.cp : cp;
}

/**
 * unmount 逐件 CAS 解挂(阶段一与阶段二补偿共用,§3 P0-A):摘挂写值恒为 null,
 * update_id="lunmount:"+sha256(root_id+":"+item_id)(确定性,响应丢失重试可被
 * 三重重放识别),source="unmount"。0 命中三分支:同 update_id 重放(幂等,计入
 * 完成)/ 已解挂或已删(跳过)/ 版本冲突(登记冲突件附 current,绝不自动重试)。
 */
async function unmountDetachItems(deps, rootId, frozenIds) {
  var items = await fetchActiveItems(deps);
  var detached = 0;
  var conflicts = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!itemMountedInSubtree(item, frozenIds)) {
      continue;
    }
    var updateId = "lunmount:" + deps.digest(rootId + ":" + item._id);
    var res = await conditionalMountUpdate(deps, item, null, updateId, "unmount");
    if (res.updated >= 1) {
      detached += 1;
      continue;
    }
    var cur = await itemsCol(deps)
      .where({ _id: item._id, household_id: deps.householdId, deleted: false })
      .get();
    if (!cur.data || cur.data.length === 0) {
      continue; // 已被删除:离场,等价已不在子树
    }
    var doc = cur.data[0];
    if (isReplay(doc, item.version, updateId, res.fingerprint)) {
      detached += 1; // 同 update_id 重放:上次已完成,幂等计入
      continue;
    }
    var at = doc.location_node_id;
    if (at === undefined || at === null || at === "") {
      continue; // 已解挂(他处摘除):跳过
    }
    conflicts.push({
      item_id: doc._id,
      current_version: doc.version,
      location_text: doc.location_text
    });
  }
  return { detached: detached, conflicts: conflicts };
}

/**
 * ⑤ 终态收敛检查(§3 P0-B):清单内除根外残留节点=0 / 挂在清单上的未删物品=0 /
 * 清单 location_id 的 active scan=0;违者回补对应阶段(节点→再删、物品→补偿、
 * scan→再标,均幂等有界)或转 conflict。终态断言仍违者抛错 → 调用方按
 * UNMOUNT_INCOMPLETE 如实返回,绝不假报成功删根。
 */
async function unmountFinalConverge(deps, cp, frozenIds, counts) {
  var rootId = cp.node_id;
  for (var round = 0; round < 3; round++) {
    var nodes = await fetchHouseholdNodes(deps);
    var byId = tree.indexById(nodes);
    var leftover = [];
    for (var i = 0; i < cp.subtree_node_ids.length; i++) {
      var id = cp.subtree_node_ids[i];
      if (id !== rootId && byId[id]) {
        leftover.push(id);
      }
    }
    if (leftover.length === 0) {
      break;
    }
    for (var r = 0; r < leftover.length; r++) {
      await locCol(deps).doc(leftover[r]).remove();
    }
  }
  var comp = await unmountDetachItems(deps, rootId, frozenIds);
  if (comp.conflicts.length > 0) {
    return { compensated: counts.compensated, scansMarked: 0, conflicts: comp.conflicts };
  }
  var scansMarked = await markSubtreeScans(
    deps, frozenIds, "active", "location_deleted", "location_deleted_at"
  );
  var nodesFinal = await fetchHouseholdNodes(deps);
  var byIdFinal = tree.indexById(nodesFinal);
  for (var n = 0; n < cp.subtree_node_ids.length; n++) {
    var fid = cp.subtree_node_ids[n];
    if (fid !== rootId && byIdFinal[fid]) {
      throw new Error("unmount final check: node remains");
    }
  }
  var items = await fetchActiveItems(deps);
  for (var m = 0; m < items.length; m++) {
    if (itemMountedInSubtree(items[m], frozenIds)) {
      throw new Error("unmount final check: item remains");
    }
  }
  var activeScans = await fetchAllPages(deps, SCANS_COLLECTION, {
    household_id: deps.householdId,
    status: "active"
  });
  for (var s = 0; s < activeScans.length; s++) {
    if (frozenIds[activeScans[s].location_id] === true) {
      throw new Error("unmount final check: scan remains");
    }
  }
  return {
    compensated: counts.compensated + comp.detached,
    scansMarked: scansMarked,
    conflicts: null
  };
}

/**
 * 阶段二六步序列(§3 P0-B/B1;①检查点由调用方先立):②硬删后代(根除外,
 * doc remove 幂等)→ ③悬挂补偿(重扫冻结清单,冲突不再容忍跳过)→ ④scan 标记
 * (active→location_deleted 条件迁移幂等)→ ⑤终态收敛检查 → ⑥删根(检查点随之
 * 消失)。各阶段幂等,续跑从 checkpoint.phase 对应阶段起执行;任意步中断 ⇒
 * {ok:false, error:"UNMOUNT_INCOMPLETE", pending},绝不假报成功。
 */
async function unmountRunPhases(deps, cp) {
  var rootId = cp.node_id;
  var frozenIds = subtreeIdSet(cp.subtree_node_ids);
  var counts = {
    unmounted: cp.counts.unmounted,
    compensated: cp.counts.compensated,
    conflicts: cp.counts.conflicts
  };
  var scansMarked = 0;
  try {
    if (phaseIndexOf(cp.phase) <= phaseIndexOf("nodes")) {
      for (var i = 0; i < cp.subtree_node_ids.length; i++) {
        if (cp.subtree_node_ids[i] === rootId) {
          continue;
        }
        await locCol(deps).doc(cp.subtree_node_ids[i]).remove();
      }
      cp = await advanceCheckpointPhase(deps, cp, "nodes", counts);
    }
    if (phaseIndexOf(cp.phase) <= phaseIndexOf("compensate")) {
      var comp = await unmountDetachItems(deps, rootId, frozenIds);
      counts.compensated += comp.detached;
      if (comp.conflicts.length > 0) {
        counts.conflicts = comp.conflicts.length;
        cp = await markCheckpointConflict(deps, cp, counts);
        return {
          ok: false,
          error: "UNMOUNT_CONFLICT",
          message: ERROR_MESSAGES.UNMOUNT_CONFLICT,
          unmounted: counts.unmounted,
          conflicts: comp.conflicts,
          pending: projectCheckpoint(cp),
          detail: {
            unmounted: counts.unmounted,
            conflicts: comp.conflicts,
            pending: projectCheckpoint(cp)
          }
        };
      }
      cp = await advanceCheckpointPhase(deps, cp, "compensate", counts);
    }
    if (phaseIndexOf(cp.phase) <= phaseIndexOf("scans")) {
      scansMarked += await markSubtreeScans(
        deps, frozenIds, "active", "location_deleted", "location_deleted_at"
      );
      cp = await advanceCheckpointPhase(deps, cp, "scans", counts);
    }
    var converge = await unmountFinalConverge(deps, cp, frozenIds, counts);
    if (converge.conflicts !== null) {
      counts.conflicts = converge.conflicts.length;
      cp = await markCheckpointConflict(deps, cp, counts);
      return {
        ok: false,
        error: "UNMOUNT_CONFLICT",
        message: ERROR_MESSAGES.UNMOUNT_CONFLICT,
        unmounted: counts.unmounted,
        conflicts: converge.conflicts,
        pending: projectCheckpoint(cp),
        detail: {
          unmounted: counts.unmounted,
          conflicts: converge.conflicts,
          pending: projectCheckpoint(cp)
        }
      };
    }
    counts.compensated = converge.compensated;
    scansMarked += converge.scansMarked;
    await locCol(deps).doc(rootId).remove();
    return {
      ok: true,
      deleted_nodes: cp.subtree_node_ids.length,
      remounted: 0,
      unmounted: counts.unmounted,
      compensated: counts.compensated,
      scans_marked: scansMarked
    };
  } catch (err) {
    // 任意步中断:重读检查点如实报告 UNMOUNT_INCOMPLETE;损坏 ⇒ CORRUPT,零猜测
    var latestDoc = await findNodeById(deps, rootId);
    if (latestDoc && latestDoc.deleting !== undefined) {
      var latestCp = validCheckpoint(latestDoc.deleting, rootId, deps);
      if (latestCp === null) {
        return fail("UNMOUNT_CHECKPOINT_CORRUPT");
      }
      return {
        ok: false,
        error: "UNMOUNT_INCOMPLETE",
        message: ERROR_MESSAGES.UNMOUNT_INCOMPLETE,
        pending: projectCheckpoint(latestCp),
        detail: { pending: projectCheckpoint(latestCp) }
      };
    }
    return {
      ok: false,
      error: "UNMOUNT_INCOMPLETE",
      message: ERROR_MESSAGES.UNMOUNT_INCOMPLETE,
      pending: projectCheckpoint(cp),
      detail: { pending: projectCheckpoint(cp) }
    };
  }
}

/**
 * unmount 主体(§3 两阶段):重入分流(根已带 deleting ⇒ 直接续跑,唯一放行
 * 例外;祖先带 deleting ⇒ 嵌套拒绝,不立第二检查点)→ 阶段一逐件解挂 → 冲突
 * 熔断(P0-A)→ 步①立检查点(条件写:根文档 updated_at 未被并发改动才成功,
 * 防双开;败者读得现存 deleting 且 op_id 确定性同值 ⇒ 同根重放转续跑)。
 */
async function unmountLocationAction(deps, node, nodes) {
  var rootId = node._id;
  var fresh = await findNodeById(deps, rootId);
  if (!fresh) {
    return fail("NOT_FOUND");
  }
  if (fresh.deleting !== undefined) {
    var existing = validCheckpoint(fresh.deleting, rootId, deps);
    if (existing === null) {
      return fail("UNMOUNT_CHECKPOINT_CORRUPT");
    }
    return unmountRunPhases(deps, existing); // 恢复路径(§3.1):用户显式触发,绝不自动
  }
  if (buildFrozenIdSet(nodes)[rootId] === true) {
    return failDeletingFrozen(); // 嵌套 unmount:祖先在删(自身无标记)
  }
  // —— 阶段一:逐件 CAS 解挂(枚举子树未删物品;摘挂值恒 null)
  var sub = tree.collectSubtree(nodes, rootId);
  var detach = await unmountDetachItems(deps, rootId, subtreeIdSet(sub.ids));
  if (detach.conflicts.length > 0) {
    // 冲突熔断(P0-A):本轮不进阶段二,节点一个不删、scan 不动;用户重新预览→
    // 重新确认发起下一轮(新预览自然只含剩余物品)
    return {
      ok: false,
      error: "UNMOUNT_CONFLICT",
      message: ERROR_MESSAGES.UNMOUNT_CONFLICT,
      unmounted: detach.detached,
      conflicts: detach.conflicts,
      nodes_deleted: 0,
      detail: {
        unmounted: detach.detached,
        conflicts: detach.conflicts,
        nodes_deleted: 0
      }
    };
  }
  // —— 阶段二·步①:于待删根文档置 deleting 检查点(先立点、后删除;冻结清单
  // 以立点时的最新树为准,创建后不变)
  var nodesFresh = await fetchHouseholdNodes(deps);
  var subFresh = tree.collectSubtree(nodesFresh, rootId);
  if (subFresh.nodes.length === 0) {
    return fail("NOT_FOUND");
  }
  var checkpoint = {
    op_id: "unmount:" + deps.digest(rootId),
    node_id: rootId,
    subtree_node_ids: subFresh.ids,
    phase: "nodes",
    counts: { unmounted: detach.detached, compensated: 0, conflicts: 0 },
    created_at: deps.now(),
    status: "pending"
  };
  var wrote = await locCol(deps)
    .where({ _id: rootId, household_id: deps.householdId, updated_at: fresh.updated_at })
    .update({ data: { deleting: checkpoint, updated_at: deps.now() } });
  if (!wrote || !wrote.stats || wrote.stats.updated < 1) {
    var again = await findNodeById(deps, rootId);
    if (again && again.deleting !== undefined) {
      var againCp = validCheckpoint(again.deleting, rootId, deps);
      if (againCp === null) {
        return fail("UNMOUNT_CHECKPOINT_CORRUPT");
      }
      return unmountRunPhases(deps, againCp); // 并发双开:败者识别现存检查点转续跑
    }
    // 立点失败(含字段校验失败/文档超上限):失败关闭,零删除;重入重新立点
    // (节点未动,清单重算一致,§4「立点即断」)
    return {
      ok: false,
      error: "UNMOUNT_INCOMPLETE",
      message: ERROR_MESSAGES.UNMOUNT_INCOMPLETE,
      pending: projectCheckpoint(checkpoint),
      detail: { pending: projectCheckpoint(checkpoint) }
    };
  }
  return unmountRunPhases(deps, checkpoint);
}

/**
 * deletePreview(只读,#94 影响面计数):子树节点数(含自身)、挂载物品数、这些
 * 物品的 video_evidence 行数(逐 item 查询,分页护栏)、子树内 active scan 数、
 * migrate_available(node.path.length ≥ 2,父不是 home 根)。根节点 INVALID_INPUT
 * (根不在 children 列表、无「⋯」入口,服务端再拦一层,双重防删)。
 */
async function deletePreviewAction(event, deps) {
  if (!validItemId(event.node_id)) {
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
  var subtreeIds = subtreeIdSet(sub.ids);
  var items = await fetchActiveItems(deps);
  var mounted = [];
  for (var i = 0; i < items.length; i++) {
    if (itemMountedInSubtree(items[i], subtreeIds)) mounted.push(items[i]);
  }
  var videoCount = 0;
  for (var v = 0; v < mounted.length; v++) {
    var rows = await fetchAllPages(deps, VIDEO_EVIDENCE_COLLECTION, {
      household_id: deps.householdId,
      item_id: mounted[v]._id
    });
    videoCount += rows.length;
  }
  var activeScans = await fetchAllPages(deps, SCANS_COLLECTION, {
    household_id: deps.householdId,
    status: "active"
  });
  var scanCount = 0;
  for (var s = 0; s < activeScans.length; s++) {
    if (subtreeIds[activeScans[s].location_id] === true) scanCount += 1;
  }
  var preview = {
    ok: true,
    node_count: sub.ids.length,
    item_count: mounted.length,
    video_count: videoCount,
    scan_count: scanCount,
    migrate_available: node.path.length >= 2
  };
  // issue #116 unmount(D0 §3.1 发现点一):根带 deleting 检查点 ⇒ 附续跑提示;
  // 损坏检查点不猜测续跑(只报 deleting 布尔,续跑时 UNMOUNT_CHECKPOINT_CORRUPT 如实返回)
  if (node.deleting !== undefined) {
    preview.deleting = true;
    var pendingCp = validCheckpoint(node.deleting, node._id, deps);
    if (pendingCp !== null) {
      preview.pending_unmount = projectCheckpoint(pendingCp);
    }
  }
  return preview;
}

/**
 * migrate 重挂阶段(mergeRemountPhase 同款循环 + guard):把挂载在子树内的物品
 * 逐件条件重挂到被删节点的上一级;确定性 update_id = "locmigrate:"+digest(node_id
 * +":"+item_id)。0 命中回查:已删/已重挂/派生标识重放 → continue(幂等);
 * 真冲突 → abort 清单,调用方整体 VERSION_CONFLICT、零删除、可重试。
 * 迁移只改挂载,不改 location_text(§1 定案:结构性操作永不改写用户话语)。
 */
async function migrateRemountPhase(deps, node, subtreeIds) {
  var remounted = 0;
  var guard = 0;
  while (true) {
    var items = await fetchActiveItems(deps);
    var mounted = [];
    for (var i = 0; i < items.length; i++) {
      if (itemMountedInSubtree(items[i], subtreeIds)) mounted.push(items[i]);
    }
    if (mounted.length === 0) {
      return { remounted: remounted };
    }
    guard += 1;
    if (guard > 5) {
      throw new Error("migrate remount exceeded retry guard");
    }
    for (var m = 0; m < mounted.length; m++) {
      var item = mounted[m];
      var updateId = "locmigrate:" + deps.digest(node._id + ":" + item._id);
      var res = await conditionalMountUpdate(deps, item, node.parent_id, updateId, "migrate");
      if (res.updated >= 1) {
        remounted += 1;
        continue;
      }
      var cur = await itemsCol(deps)
        .where({ _id: item._id, household_id: deps.householdId, deleted: false })
        .get();
      if (!cur.data || cur.data.length === 0) {
        continue; // 已被删除:无需重挂,继续下一件
      }
      var doc = cur.data[0];
      if (doc.location_node_id === node.parent_id) {
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
 * deleteLocation(写类,#94 三按钮 + #116 四选):{ action:"deleteLocation", node_id,
 * mode:"migrate"|"purge"|"unmount" }。根位置各模式一律 INVALID_INPUT(删除入口在
 * 客户端已不存在,服务端硬门兜底)。
 * - migrate:物品条件重挂到上一级(冲突即中止零删除)→ 硬删子树全部节点 →
 *   补偿扫描摘除悬挂挂载 → 子树内 active scan 标 location_deleted。
 *   顶层房间(父为 home 根,物品不能直接挂根)拒绝 migrate。
 * - purge:客户端已逐件 itemsApi.delete;若仍有未删物品挂载在子树 → NODE_NOT_EMPTY
 *   + 当前清单(补删后重试,收敛式);否则硬删子树、补偿悬挂挂载、子树内 scan
 *   (含已 location_deleted)升级为 deleted。绝不在此级联证据/云文件/物品——
 *   物品软删的级联全部硬化在 itemsApi(锁序与末引用复核是 B 已验收资产)。
 * - unmount(issue #116,D0 v4 §3):物品逐件解挂转「尚未归类」(冲突熔断)→
 *   B1 检查点六步终结子树;恢复走惰性续跑(unmountLocationAction)。
 *   migrate/purge 作用于 deleting 子树内节点(含根)一律 INVALID_INPUT
 *   detail:{reason:"deleting"}(冻结门,§3.1 入口清单)。
 */
async function deleteLocationAction(event, deps) {
  if (!validItemId(event.node_id)) {
    return fail("INVALID_INPUT");
  }
  if (event.mode !== "migrate" && event.mode !== "purge" && event.mode !== "unmount") {
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
  if (event.mode === "unmount") {
    return unmountLocationAction(deps, node, nodes);
  }
  if (buildFrozenIdSet(nodes)[node._id] === true) {
    return failDeletingFrozen(); // migrate/purge 不得作用于 deleting 子树(含根)
  }
  var sub = tree.collectSubtree(nodes, node._id);
  var subtreeIds = subtreeIdSet(sub.ids);
  var remounted = 0;

  if (event.mode === "migrate") {
    if (node.path.length < 2) {
      return fail("INVALID_INPUT", "物品不能直接挂「我的家」,请先移动物品或改用全部删除");
    }
    var phase = await migrateRemountPhase(deps, node, subtreeIds);
    if (phase.abort) {
      return {
        ok: false,
        error: "VERSION_CONFLICT",
        message: "部分物品刚被修改,请重试",
        detail: { conflicted: phase.abort }
      };
    }
    remounted = phase.remounted;
  } else {
    var items = await fetchActiveItems(deps);
    var remaining = [];
    for (var r = 0; r < items.length; r++) {
      if (itemMountedInSubtree(items[r], subtreeIds)) {
        remaining.push({ item_id: items[r]._id, current_version: items[r].version });
      }
    }
    if (remaining.length > 0) {
      return {
        ok: false,
        error: "NODE_NOT_EMPTY",
        message: ERROR_MESSAGES.NODE_NOT_EMPTY,
        detail: { remaining_items: remaining }
      };
    }
  }

  // 硬删子树全部节点(与现 delete 相同的逐节点 remove),随即补偿扫描摘除
  // 「计数时为 0 → 并发 linkItem 写入 → 硬删」交错出的悬挂挂载。
  for (var d = 0; d < sub.ids.length; d++) {
    await locCol(deps).doc(sub.ids[d]).remove();
  }
  var after = await fetchActiveItems(deps);
  var victims = [];
  for (var c = 0; c < after.length; c++) {
    if (itemMountedInSubtree(after[c], subtreeIds)) victims.push(after[c]);
  }
  var comp = await compensateUnmount(deps, victims, function (item) {
    return "compensate:" + deps.digest(node._id + ":" + item._id);
  });

  // scan 状态迁移(条件 update,幂等重试安全;不删任何证据行/云文件/物品)
  var scansMarked;
  if (event.mode === "migrate") {
    scansMarked = await markSubtreeScans(deps, subtreeIds, "active", "location_deleted", "location_deleted_at");
  } else {
    scansMarked =
      (await markSubtreeScans(deps, subtreeIds, "active", "deleted", "deleted_at")) +
      (await markSubtreeScans(deps, subtreeIds, "location_deleted", "deleted", "deleted_at"));
  }
  return {
    ok: true,
    deleted_nodes: sub.ids.length,
    remounted: remounted,
    compensated: comp.compensated,
    compensated_skipped: comp.skipped,
    scans_marked: scansMarked
  };
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
  applyScan: applyScanAction,
  ensureAndLink: ensureAndLinkAction,
  deletePreview: deletePreviewAction,
  deleteLocation: deleteLocationAction
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
  applyScan: true,
  ensureAndLink: true,
  deleteLocation: true
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
