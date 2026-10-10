"use strict";

/**
 * 位置树纯函数工具(docs/design/location-tree.md §4.1)。
 * 输入一律是「已按 household 过滤」的节点数组,不做任何 IO;
 * 子树收集、path 级联重写、同级同名校验、深度与类型映射都在这里,
 * 供 handler.js(rename/move/merge/delete/list)复用。
 */

var PATH_MAX_DEPTH = 6; // path.length ∈ [1,6](1=room,2=furniture,≥3=container)

/** 深度(从根数起,不含 home 根)→ 类型映射;超出 6 层返回 null */
function typeForDepth(depth) {
  if (depth === 1) {
    return "room";
  }
  if (depth === 2) {
    return "furniture";
  }
  if (depth >= 3 && depth <= PATH_MAX_DEPTH) {
    return "container";
  }
  return null;
}

/** 本家庭节点数组 → id→node 映射 */
function indexById(nodes) {
  var map = Object.create(null);
  for (var i = 0; i < nodes.length; i++) {
    map[nodes[i]._id] = nodes[i];
  }
  return map;
}

/**
 * 收集 rootId 及其全部后代(内存沿 parent_id 链下钻)。
 * 返回 { ids: [rootId...后代], nodes: [根...后代] };rootId 不在 nodes 中返回空结果。
 */
function collectSubtree(nodes, rootId) {
  var byParent = Object.create(null); // parent_id -> [node]
  var root = null;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n._id === rootId) {
      root = n;
    }
    if (!Object.prototype.hasOwnProperty.call(byParent, n.parent_id)) {
      byParent[n.parent_id] = [];
    }
    byParent[n.parent_id].push(n);
  }
  if (root === null) {
    return { ids: [], nodes: [] };
  }
  var ids = [root._id];
  var subtree = [root];
  var queue = [root];
  while (queue.length > 0) {
    var cur = queue.shift();
    var children = byParent[cur._id] || [];
    for (var c = 0; c < children.length; c++) {
      ids.push(children[c]._id);
      subtree.push(children[c]);
      queue.push(children[c]);
    }
  }
  return { ids: ids, nodes: subtree };
}

/** nodeId 是否是 ancestorId 的后代(不含自身) */
function isDescendant(nodes, ancestorId, nodeId) {
  var byId = indexById(nodes);
  var cur = byId[nodeId];
  while (cur && cur.parent_id !== "") {
    if (cur.parent_id === ancestorId) {
      return true;
    }
    cur = byId[cur.parent_id];
  }
  return false;
}

/**
 * rootId 子树的最大相对深度(按 path 长度差):root 自身 0,最深后代 = 后代 path 长度 - root path 长度。
 * path 前缀一致性由建树逻辑保证,长度差即相对深度。
 */
function maxRelativeDepth(nodes, rootId) {
  var sub = collectSubtree(nodes, rootId);
  if (sub.nodes.length === 0) {
    return 0;
  }
  var rootLen = sub.nodes[0].path.length;
  var max = 0;
  for (var i = 1; i < sub.nodes.length; i++) {
    var rel = sub.nodes[i].path.length - rootLen;
    if (rel > max) {
      max = rel;
    }
  }
  return max;
}

/** 直接子节点(nodes 已按 household 过滤) */
function directChildren(nodes, parentId) {
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].parent_id === parentId) {
      out.push(nodes[i]);
    }
  }
  return out;
}

/**
 * rename 级联:node 与全部后代的 path 中,本节点名字所在下标(path.length-1)替换为新名。
 * 返回 [{ _id, path }](含本节点),调用方逐个写回;不修改入参数组本身。
 */
function cascadedPathsAfterRename(nodes, node, newName) {
  var sub = collectSubtree(nodes, node._id);
  var idx = node.path.length - 1;
  var out = [];
  for (var i = 0; i < sub.nodes.length; i++) {
    var n = sub.nodes[i];
    var path = n.path.slice();
    path[idx] = newName;
    out.push({ _id: n._id, path: path });
  }
  return out;
}

/**
 * move/merge 结构级联:node 迁到 newParent 下之后的 node 与全部后代 path 重写。
 * node 新 path = newParent.path + [node.name];后代 = 新前缀 + 旧相对后缀。
 * 返回 [{ _id, path }](含本节点自身)。
 */
function cascadedPathsAfterAdopt(nodes, node, newParentPath) {
  var sub = collectSubtree(nodes, node._id);
  var oldPrefixLen = node.path.length;
  var newPrefix = newParentPath.concat([node.name]);
  var out = [];
  for (var i = 0; i < sub.nodes.length; i++) {
    var n = sub.nodes[i];
    out.push({ _id: n._id, path: newPrefix.concat(n.path.slice(oldPrefixLen)) });
  }
  return out;
}

module.exports = {
  PATH_MAX_DEPTH: PATH_MAX_DEPTH,
  typeForDepth: typeForDepth,
  indexById: indexById,
  collectSubtree: collectSubtree,
  isDescendant: isDescendant,
  maxRelativeDepth: maxRelativeDepth,
  directChildren: directChildren,
  cascadedPathsAfterRename: cascadedPathsAfterRename,
  cascadedPathsAfterAdopt: cascadedPathsAfterAdopt
};
