"use strict";
// PR-B(issue #116,D0-CONTRACT.md v4 §3/§3.1/§4):deleteLocation mode:"unmount" +
// deleting 子树冻结门 + B1 检查点恢复机器。本文件全部为「测试先行」反例:
// 阶段一 CAS 三分支 / 冲突熔断 / 六步序列逐中断点故障注入 / 补偿冲突不静默 /
// 嵌套 unmount 拒绝 / 并发检查点条件写 / 同根重放续跑 / 旧 delete(force)关死 /
// 逐入口子树冻结 / unlinkItem 放行 / 摘挂值恒 null / 检查点损坏失败关闭 /
// list·deletePreview 投影 / 既有结构零回归的服务端半边。
var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("node:crypto");

var locHandler = require("../cloudfunctions/locations/lib/handler").handler;
var changesFingerprint = require("../cloudfunctions/locations/lib/handler").changesFingerprint;
var itemsHandler = require("../cloudfunctions/itemsApi/lib/handler").handler;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

var HOUSEHOLD_A = "hh_11111111111111111111111111111111";

function digest16(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

var GLOBAL_SEQ = 0;

function makeDeps(db, householdId) {
  var clock = 1760000000000;
  return {
    db: db,
    householdId: householdId || HOUSEHOLD_A,
    householdShared: false,
    scopeRevision: null,
    now: function () {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    genId: function () {
      GLOBAL_SEQ += 1;
      return "n" + GLOBAL_SEQ;
    },
    digest: digest16,
    logger: { log: function () {} }
  };
}

function freshDb() {
  return createMemoryDb({
    uniqueIndexes: {
      locations: [["household_id", "parent_id", "name_norm"]],
      location_scans: [["household_id", "scan_id"]],
      video_evidence: [["household_id", "item_id", "file_id"]]
    }
  });
}

function fresh() {
  var db = freshDb();
  return { db: db, deps: makeDeps(db) };
}

async function rawDocs(db, name) {
  var res = await db.collection(name).where({}).get();
  return res.data;
}

async function ensurePath(deps, segments) {
  var res = await locHandler({ action: "ensurePath", path: segments, created_from: "manual" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
}

async function createItem(deps, opId, name, locationText) {
  var res = await itemsHandler(
    { action: "create", operation_id: opId, name: name, location_text: locationText },
    deps
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.item.item_id;
}

async function linkItem(deps, itemId, nodeId, version, updateId) {
  var res = await locHandler(
    { action: "linkItem", item_id: itemId, node_id: nodeId, expected_version: version, update_id: updateId },
    deps
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
}

async function seedScan(db, scanId, locationId, status, extra) {
  var doc = Object.assign({
    _id: "ls_" + scanId,
    household_id: HOUSEHOLD_A,
    scan_id: scanId,
    location_id: locationId,
    location_path_snapshot: ["书房"],
    location_text_snapshot: "书房",
    file_id: "cloud://bucket/video-evidence/" + HOUSEHOLD_A + "/" + scanId + ".mp4",
    asset_id: "va_" + scanId,
    upload_ticket: "vt_" + scanId,
    duration_ms: 12000,
    video_w: 1280,
    video_h: 720,
    candidate_count: 3,
    confirmed_count: 1,
    confirmed_item_ids: [],
    created_at: "2026-10-18T00:00:00.000Z",
    updated_at: "2026-10-18T00:00:00.000Z",
    status: status || "active"
  }, extra || {});
  await db.collection("location_scans").add({ data: doc });
  return doc;
}

/** 标准树:书房/书柜/第一层 + 厨房(第一层自身永不带 deleting 字段——P0-1 反例场景) */
async function setupTree(t) {
  var study = await ensurePath(t.deps, ["书房"]);
  var shelf = await ensurePath(t.deps, ["书房", "书柜"]);
  var inner = await ensurePath(t.deps, ["书房", "书柜", "第一层"]);
  await ensurePath(t.deps, ["厨房"]);
  var nodes = await rawDocs(t.db, "locations");
  return {
    rootId: nodes.find(function (n) { return n.parent_id === ""; })._id,
    studyId: study.nodes[0].location_id,
    shelfId: shelf.nodes[shelf.nodes.length - 1].location_id,
    layerId: inner.nodes[inner.nodes.length - 1].location_id,
    kitchenId: nodes.find(function (n) { return n.name === "厨房"; })._id
  };
}

function unmount(deps, nodeId) {
  return locHandler({ action: "deleteLocation", node_id: nodeId, mode: "unmount" }, deps);
}

/* ---------------- 故障注入 wrapper(逐中断点) ---------------- */

/**
 * faults 元素:
 *   { collection, op:"docRemove", id?, at, action?, noThrow? }
 *   { collection, op:"whereUpdate", patchHas?, at, action?, noThrow?, armOn?, sabotage? }
 * at=第 N 次命中(1 起,只在该次触发);armOn={collection,patchHas} 先见到该写入才武装;
 * noThrow=true 只执行 action 不抛错;sabotage=命中时先改库再放行原条件写(令其自然失配)。
 */
function faultDb(db, faults) {
  var counters = faults.map(function () { return 0; });
  var armed = faults.map(function (f) { return !f.armOn; });
  return {
    collection: function (name) {
      var col = db.collection(name);
      return {
        where: function (cond) {
          var q = col.where(cond);
          function wrap(qq) {
            return {
              get: function (o) { return qq.get(o); },
              skip: function (n) { return wrap(qq.skip(n)); },
              limit: function (n) { return wrap(qq.limit(n)); },
              remove: function () { return qq.remove(); },
              update: function (options) {
                var data = options && options.data;
                for (var j = 0; j < faults.length; j++) {
                  var fa = faults[j];
                  if (armed[j] && fa.armOn) continue; // 已武装无需重复
                  if (fa.armOn && fa.armOn.collection === name && data &&
                    data[fa.armOn.patchHas] !== undefined) {
                    armed[j] = true;
                  }
                }
                for (var i = 0; i < faults.length; i++) {
                  var f = faults[i];
                  if (!armed[i]) continue;
                  if (f.collection !== name || f.op !== "whereUpdate") continue;
                  if (f.patchHas !== undefined && (!data || data[f.patchHas] === undefined)) continue;
                  counters[i] += 1;
                  if (counters[i] === f.at) {
                    return Promise.resolve().then(f.action || function () {}).then(function () {
                      if (f.sabotage) {
                        return f.sabotage().then(function () { return qq.update(options); });
                      }
                      if (f.noThrow) return qq.update(options);
                      throw new Error("fault:whereUpdate:" + name + ":" + f.patchHas);
                    });
                  }
                }
                return qq.update(options);
              }
            };
          }
          return wrap(q);
        },
        doc: function (id) {
          var d = col.doc(id);
          return {
            get: d.get.bind(d),
            update: function (o) { return d.update(o); },
            remove: function () {
              for (var i = 0; i < faults.length; i++) {
                var f = faults[i];
                if (!armed[i]) continue;
                if (f.collection !== name || f.op !== "docRemove") continue;
                if (f.id !== undefined && f.id !== id) continue;
                counters[i] += 1;
                if (counters[i] === f.at) {
                  return Promise.resolve().then(f.action || function () {}).then(function () {
                    if (f.noThrow) return d.remove();
                    throw new Error("fault:docRemove:" + name + ":" + id);
                  });
                }
              }
              return d.remove();
            }
          };
        },
        add: function (o) { return col.add(o); }
      };
    }
  };
}

/**
 * 并发抢写 wrapper(检查点条件写竞争):当本方发起含 patchKey 的条件写时,
 * 先让「竞争者」改写文档(改 updated_at / 直接立点),再放行本方条件写——
 * 本方条件(updated_at 已读旧值)必然失配,驱动「败者」分流。
 */
function raceCheckpointDb(db, patchKey, rival) {
  var fired = false;
  var wrapped = faultDb(db, []);
  var origCollection = wrapped.collection.bind(wrapped);
  return {
    collection: function (name) {
      var col = origCollection(name);
      if (name !== "locations") return col;
      var inner = db.collection(name);
      return {
        where: function (cond) {
          var q = inner.where(cond);
          return {
            get: function (o) { return q.get(o); },
            skip: function (n) { return q.skip(n); },
            limit: function (n) { return q.limit(n); },
            remove: function () { return q.remove(); },
            update: function (options) {
              if (!fired && options && options.data && options.data[patchKey] !== undefined) {
                fired = true;
                return Promise.resolve().then(rival).then(function () { return q.update(options); });
              }
              return q.update(options);
            }
          };
        },
        doc: col.doc.bind(col),
        add: col.add.bind(col)
      };
    }
  };
}

/**
 * 并发修改注入(阶段一/补偿 CAS 竞争,locations-delete-cascade sabotageMountDb 同款):
 * 目标物品的条件挂载更新落库前先执行 sabotage(模拟他处抢先推进版本)。
 */
function sabotageMountDb(db, targetItemId, sabotage) {
  var fired = false;
  return {
    collection: function (name) {
      var col = db.collection(name);
      if (name !== "items") return col;
      return {
        where: function (cond) {
          var inner = col.where(cond);
          function wrap(q) {
            return {
              get: function (o) { return q.get(o); },
              skip: function (n) { return wrap(q.skip(n)); },
              limit: function (n) { return wrap(q.limit(n)); },
              update: function (options) {
                if (
                  !fired &&
                  cond._id === targetItemId &&
                  cond.version !== undefined &&
                  options && options.data && "location_node_id" in options.data
                ) {
                  fired = true;
                  return Promise.resolve().then(sabotage).then(function () {
                    return q.update(options);
                  });
                }
                return q.update(options);
              }
            };
          }
          return wrap(inner);
        },
        doc: col.doc.bind(col),
        add: col.add.bind(col)
      };
    }
  };
}

/** 造一个「阶段二已中断」的冻结树:书房带 deleting 检查点、物品已全解挂、后代未删 */
async function freezeMidOp(t, ids, opts) {
  opts = opts || {};
  var a = await createItem(t.deps, "op-mid-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-mid-a");
  if (opts.scan !== false) {
    await seedScan(t.db, "scan-mid", ids.layerId);
  }
  var faults = [{ collection: "locations", op: "docRemove", at: 1 }];
  var trapDeps = Object.assign({}, t.deps, { db: faultDb(t.db, faults) });
  var res = await unmount(trapDeps, ids.studyId);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "UNMOUNT_INCOMPLETE");
  return { itemA: a, res: res };
}

/* ================= 阶段一 + 六步全链 ================= */

test("UNMOUNT-FULL:逐件 CAS 置 null、location_text 保留、子树硬删含根、scan 标 location_deleted、检查点随根消失", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-un-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.shelfId, 1, "u-un-a");
  var b = await createItem(t.deps, "op-un-b", "相册", "书柜第一层");
  await linkItem(t.deps, b, ids.layerId, 1, "u-un-b");
  var outside = await createItem(t.deps, "op-un-out", "锅", "厨房");
  await linkItem(t.deps, outside, ids.kitchenId, 1, "u-un-out");
  await t.db.collection("video_evidence").add({ data: {
    _id: "ve_un_a", household_id: HOUSEHOLD_A, item_id: a,
    file_id: "cloud://bucket/e/" + a + ".mp4", created_at: "2026-10-01T00:00:00.000Z"
  } });
  await seedScan(t.db, "scan-un-shelf", ids.shelfId);
  await seedScan(t.db, "scan-un-layer", ids.layerId);
  await seedScan(t.db, "scan-un-kitchen", ids.kitchenId);
  var evidenceBefore = JSON.parse(JSON.stringify(await rawDocs(t.db, "video_evidence")));

  var res = await unmount(t.deps, ids.studyId);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.deleted_nodes, 3, "书房+书柜+第一层");
  assert.equal(res.unmounted, 2, "子树内 2 件解挂");
  assert.equal(res.compensated, 0);
  assert.equal(res.scans_marked, 2, "子树内 2 条 active scan");

  var items = await rawDocs(t.db, "items");
  var docA = items.find(function (d) { return d._id === a; });
  var docB = items.find(function (d) { return d._id === b; });
  var docOut = items.find(function (d) { return d._id === outside; });
  assert.ok(docA.location_node_id === null, "摘挂写值恒为 null(字符串 \"\" 即红)");
  assert.ok(docB.location_node_id === null, "摘挂写值恒为 null");
  assert.equal(docA.location_text, "书房的书柜", "location_text 原样保留(历史文本)");
  assert.equal(docB.location_text, "书柜第一层");
  assert.equal(docA.last_update_id, "lunmount:" + digest16(ids.studyId + ":" + a));
  assert.equal(docA.version, 3, "linkItem v1→2 后 unmount 条件解挂 v2→3");
  assert.equal(docA.deleted, false, "绝不删物品");
  assert.equal(docOut.location_node_id, ids.kitchenId, "子树外挂载不动");
  assert.equal(items.length, 3, "物品一个不删");

  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.studyId; }), false, "根最后删除");
  assert.equal(nodes.some(function (n) { return n._id === ids.shelfId; }), false, "后代硬删");
  assert.equal(nodes.some(function (n) { return n._id === ids.layerId; }), false);
  assert.equal(nodes.filter(function (n) { return n.deleting !== undefined; }).length, 0, "检查点随根消失");

  var scans = await rawDocs(t.db, "location_scans");
  var byScan = {};
  for (var i = 0; i < scans.length; i++) byScan[scans[i].scan_id] = scans[i];
  assert.equal(byScan["scan-un-shelf"].status, "location_deleted");
  assert.ok(byScan["scan-un-shelf"].location_deleted_at);
  assert.equal(byScan["scan-un-layer"].status, "location_deleted");
  assert.equal(byScan["scan-un-kitchen"].status, "active", "子树外 scan 不动");
  assert.deepEqual(await rawDocs(t.db, "video_evidence"), evidenceBefore, "证据行零变化");
});

test("UNMOUNT-TOP-ROOM:顶层房间(父为 home 根)unmount 可用——不套 migrate 的顶层限制", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-top-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-top-a");
  var res = await unmount(t.deps, ids.studyId);
  assert.equal(res.ok, true, JSON.stringify(res));
  var doc = (await rawDocs(t.db, "items")).find(function (d) { return d._id === a; });
  assert.equal(doc.location_node_id, null);
  assert.equal((await rawDocs(t.db, "locations")).some(function (n) { return n._id === ids.studyId; }), false);
});

test("PHASE1-REPLAY:0 命中回查命中同 update_id 派生标识 → 重放幂等跳过,不再 +1", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-rp-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.shelfId, 1, "u-rp-a"); // v2, mounted
  var updateId = "lunmount:" + digest16(ids.shelfId + ":" + a);
  var fingerprint = changesFingerprint({ location_node_id: null });
  // 竞争窗口:同 op 的并发请求已按同 update_id 解挂(v2→v3,null),本方 CAS(v2)失配
  var trapDb = sabotageMountDb(t.db, a, function () {
    return t.db.collection("items").doc(a).update({
      data: {
        location_node_id: null, version: 3, updated_at: "2026-10-20T00:00:00.000Z",
        last_update_id: updateId, last_update_fingerprint: fingerprint
      }
    });
  });
  var res = await unmount(Object.assign({}, t.deps, { db: trapDb }), ids.shelfId);
  assert.equal(res.ok, true, JSON.stringify(res));
  var doc = (await rawDocs(t.db, "items")).find(function (d) { return d._id === a; });
  assert.equal(doc.version, 3, "重放识别后不再推进版本");
  assert.ok(doc.location_node_id === null);
  assert.equal((await rawDocs(t.db, "locations")).some(function (n) { return n._id === ids.shelfId; }), false, "无冲突即完成六步");
});

test("PHASE1-ALREADY-UNMOUNTED:枚举到他处已解挂(非同 op)→ 跳过,不登记冲突", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-al-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.shelfId, 1, "u-al-a");
  var trapDb = sabotageMountDb(t.db, a, function () {
    return t.db.collection("items").doc(a).update({
      data: {
        location_node_id: null, version: 3, updated_at: "2026-10-20T00:00:00.000Z",
        last_update_id: "someone-else-unlink", last_update_fingerprint: changesFingerprint({ location_node_id: null })
      }
    });
  });
  var res = await unmount(Object.assign({}, t.deps, { db: trapDb }), ids.shelfId);
  assert.equal(res.ok, true, JSON.stringify(res));
  var doc = (await rawDocs(t.db, "items")).find(function (d) { return d._id === a; });
  assert.equal(doc.version, 3, "已解挂跳过:版本不再推进");
  assert.ok(doc.location_node_id === null);
});

test("PHASE1-CONFLICT-BREAKER:版本冲突 → UNMOUNT_CONFLICT 熔断,零节点删除、scan 不动;重试收敛", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var m1 = await createItem(t.deps, "op-cb-1", "酱油", "书房的书柜");
  await linkItem(t.deps, m1, ids.shelfId, 1, "u-cb-1");
  var m2 = await createItem(t.deps, "op-cb-2", "醋", "书房的书柜");
  await linkItem(t.deps, m2, ids.shelfId, 1, "u-cb-2");
  await seedScan(t.db, "scan-cb", ids.shelfId);

  var trapDb = sabotageMountDb(t.db, m2, function () {
    return t.db.collection("items").doc(m2).update({
      data: { version: 4, note: "他处并发修改" }
    });
  });
  var aborted = await unmount(Object.assign({}, t.deps, { db: trapDb }), ids.shelfId);
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error, "UNMOUNT_CONFLICT");
  assert.equal(aborted.unmounted, 1, "冲突前已解挂 1 件如实上报");
  assert.equal(aborted.nodes_deleted, 0, "熔断:零节点删除");
  assert.deepEqual(aborted.conflicts, [{
    item_id: m2, current_version: 4, location_text: "书房的书柜"
  }], "冲突件附 current 与 location_text");

  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.shelfId; }), true, "节点一个不删");
  assert.equal(nodes.filter(function (n) { return n.deleting !== undefined; }).length, 0, "不立检查点");
  var scans = await rawDocs(t.db, "location_scans");
  assert.equal(scans[0].status, "active", "scan 不动");
  var items = await rawDocs(t.db, "items");
  var docM2 = items.find(function (d) { return d._id === m2; });
  assert.equal(docM2.location_node_id, ids.shelfId, "冲突件挂载不动");
  assert.equal(docM2.version, 4, "版本不回拨、绝不自动重试");

  // 用户核对后重新发起:新预览只含剩余物品,收敛完成
  var ok = await unmount(t.deps, ids.shelfId);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.unmounted, 1);
  var docM2After = (await rawDocs(t.db, "items")).find(function (d) { return d._id === m2; });
  assert.ok(docM2After.location_node_id === null);
});

/* ================= 阶段二:逐中断点故障注入 + 惰性恢复 ================= */

/** 六步收敛后的公共终态断言(所有中断点重跑后必须到达同一终态) */
async function assertConverged(t, ids, extraItems) {
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.studyId; }), false, "根已删");
  assert.equal(nodes.some(function (n) { return n._id === ids.shelfId; }), false, "后代全删");
  assert.equal(nodes.some(function (n) { return n._id === ids.layerId; }), false);
  assert.equal(nodes.filter(function (n) { return n.deleting !== undefined; }).length, 0, "检查点消失");
  var items = await rawDocs(t.db, "items");
  for (var i = 0; i < (extraItems || []).length; i++) {
    var doc = items.find(function (d) { return d._id === extraItems[i]; });
    assert.ok(doc.location_node_id === null, "悬挂件被补偿置 null:" + extraItems[i]);
    assert.equal(doc.deleted, false);
  }
  var scans = await rawDocs(t.db, "location_scans");
  for (var s = 0; s < scans.length; s++) {
    assert.equal(scans[s].status, "location_deleted", "清单 scan 全部 location_deleted");
  }
}

test("INJECT-1-POINT-AFTER-CHECKPOINT:立点后、首删前中断 → UNMOUNT_INCOMPLETE pending.phase=nodes,重跑续跑收敛", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-i1-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-i1-a");
  await seedScan(t.db, "scan-i1", ids.layerId);
  var trapDeps = Object.assign({}, t.deps, { db: faultDb(t.db, [
    { collection: "locations", op: "docRemove", at: 1 }
  ]) });
  var res = await unmount(trapDeps, ids.studyId);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "UNMOUNT_INCOMPLETE");
  assert.equal(res.pending.op_id, "unmount:" + digest16(ids.studyId));
  assert.equal(res.pending.phase, "nodes");
  assert.equal(res.pending.status, "pending");
  assert.equal(res.pending.counts.unmounted, 1);
  var root = (await rawDocs(t.db, "locations")).find(function (n) { return n._id === ids.studyId; });
  assert.ok(root.deleting, "检查点在(先立点后删除)");
  assert.deepEqual(root.deleting.subtree_node_ids, [ids.studyId, ids.shelfId, ids.layerId]);
  assert.equal((await rawDocs(t.db, "items")).find(function (d) { return d._id === a; }).location_node_id, null, "阶段一成果保留");
  assert.equal((await rawDocs(t.db, "location_scans"))[0].status, "active", "scan 未标");
  // 惰性恢复:重入(用户显式触发)从检查点续跑
  var resume = await unmount(t.deps, ids.studyId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  await assertConverged(t, ids, [a]);
});

test("INJECT-2-MID-NODES:后代删除半途中断 → 后代部分已删、清单在、重跑从 nodes 续", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-i2-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-i2-a");
  await seedScan(t.db, "scan-i2", ids.layerId);
  var trapDeps = Object.assign({}, t.deps, { db: faultDb(t.db, [
    { collection: "locations", op: "docRemove", at: 2 }
  ]) });
  var res = await unmount(trapDeps, ids.studyId);
  assert.equal(res.error, "UNMOUNT_INCOMPLETE");
  assert.equal(res.pending.phase, "nodes");
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.shelfId; }), false, "第 1 个后代已删");
  assert.equal(nodes.some(function (n) { return n._id === ids.layerId; }), true, "第 2 个后代尚在(中断)");
  var resume = await unmount(t.deps, ids.studyId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  await assertConverged(t, ids, [a]);
});

test("INJECT-3-BEFORE-COMPENSATE:窗口期挂入的悬挂件 + 补偿中断 → phase=compensate,重跑补偿收敛", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-i3-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-i3-a");
  var late = await createItem(t.deps, "op-i3-late", "迟到者", "书房的书柜");
  await seedScan(t.db, "scan-i3", ids.layerId);
  var trapDeps = Object.assign({}, t.deps, { db: faultDb(t.db, [
    // 首个后代删除时不抛错,但借机直接挂入 late(模拟部署窗口内旧写端趁隙挂载,绕过冻结门)
    { collection: "locations", op: "docRemove", at: 1, noThrow: true, action: function () {
      return t.db.collection("items").doc(late).update({
        data: { location_node_id: ids.layerId, last_update_id: "stale-writer" }
      });
    } },
    // 检查点立点(含 deleting 的 locations 写)之后,第 1 次物品挂载条件写(=补偿 CAS)抛错
    { collection: "items", op: "whereUpdate", patchHas: "location_node_id", at: 1,
      armOn: { collection: "locations", patchHas: "deleting" } }
  ]) });
  var res = await unmount(trapDeps, ids.studyId);
  assert.equal(res.error, "UNMOUNT_INCOMPLETE", JSON.stringify(res));
  assert.equal(res.pending.phase, "compensate", "节点阶段已完成");
  var docLate = (await rawDocs(t.db, "items")).find(function (d) { return d._id === late; });
  assert.equal(docLate.location_node_id, ids.layerId, "悬挂件仍在(补偿被中断)");
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.studyId; }), true, "根保留");
  assert.equal(nodes.some(function (n) { return n._id === ids.layerId; }), false, "后代已删(悬挂因此成立)");
  var resume = await unmount(t.deps, ids.studyId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  assert.ok(resume.compensated >= 1, "悬挂件在续跑中被补偿");
  await assertConverged(t, ids, [a, late]);
});

test("INJECT-4-BEFORE-SCANS:scan 标记中断 → phase=scans、补偿已完成,重跑标记收敛", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-i4-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-i4-a");
  await seedScan(t.db, "scan-i4", ids.layerId);
  var trapDeps = Object.assign({}, t.deps, { db: faultDb(t.db, [
    { collection: "location_scans", op: "whereUpdate", at: 1 }
  ]) });
  var res = await unmount(trapDeps, ids.studyId);
  assert.equal(res.error, "UNMOUNT_INCOMPLETE");
  assert.equal(res.pending.phase, "scans");
  assert.equal((await rawDocs(t.db, "items")).find(function (d) { return d._id === a; }).location_node_id, null, "物品已解挂");
  assert.equal((await rawDocs(t.db, "location_scans"))[0].status, "active", "scan 未标");
  var resume = await unmount(t.deps, ids.studyId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  await assertConverged(t, ids, [a]);
});

test("INJECT-5-BEFORE-FINAL:phase 推进至 final 的条件写中断 → phase=scans、scan 已标,重跑终检删根", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-i5-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-i5-a");
  await seedScan(t.db, "scan-i5", ids.layerId);
  var trapDeps = Object.assign({}, t.deps, { db: faultDb(t.db, [
    // deleting 写序列:①立点=1,nodes→compensate=2,compensate→scans=3,scans→final=4
    { collection: "locations", op: "whereUpdate", patchHas: "deleting", at: 4 }
  ]) });
  var res = await unmount(trapDeps, ids.studyId);
  assert.equal(res.error, "UNMOUNT_INCOMPLETE", JSON.stringify(res));
  assert.equal(res.pending.phase, "scans", "final 推进失败:phase 停在 scans");
  assert.equal((await rawDocs(t.db, "location_scans"))[0].status, "location_deleted", "scan 已标");
  assert.equal((await rawDocs(t.db, "locations")).some(function (n) { return n._id === ids.studyId; }), true, "根未删");
  var resume = await unmount(t.deps, ids.studyId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  await assertConverged(t, ids, [a]);
});

test("INJECT-6-BEFORE-ROOT-REMOVE:删根前中断 → phase=final、其余全完成,重跑仅删根", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-i6-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-i6-a");
  await seedScan(t.db, "scan-i6", ids.layerId);
  var trapDeps = Object.assign({}, t.deps, { db: faultDb(t.db, [
    { collection: "locations", op: "docRemove", id: ids.studyId, at: 1 }
  ]) });
  var res = await unmount(trapDeps, ids.studyId);
  assert.equal(res.error, "UNMOUNT_INCOMPLETE");
  assert.equal(res.pending.phase, "final");
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.studyId; }), true, "根在 ⇒ 检查点在");
  assert.equal(nodes.some(function (n) { return n._id === ids.layerId; }), false, "后代已删");
  assert.equal((await rawDocs(t.db, "location_scans"))[0].status, "location_deleted");
  var resume = await unmount(t.deps, ids.studyId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  assert.equal(resume.deleted_nodes, 3);
  await assertConverged(t, ids, [a]);
});

test("COMPENSATE-CONFLICT:补偿 CAS 冲突 → status=conflict、根保留、响应附冲突件,不静默容忍;核对后续跑收敛", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-cc-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-cc-a");
  var late = await createItem(t.deps, "op-cc-late", "迟到者", "书房的书柜");
  await seedScan(t.db, "scan-cc", ids.layerId);
  // 窗口期挂入(②删除中途) + 补偿时版本被他处推进(冲突)
  var trapDb = faultDb(t.db, [
    { collection: "locations", op: "docRemove", at: 1, noThrow: true, action: function () {
      return t.db.collection("items").doc(late).update({
        data: { location_node_id: ids.layerId, last_update_id: "stale-writer" }
      });
    } },
    { collection: "items", op: "whereUpdate", patchHas: "location_node_id", at: 1,
      armOn: { collection: "locations", patchHas: "deleting" },
      sabotage: function () {
        return t.db.collection("items").doc(late).update({
          data: { version: 2, note: "他处并发修改" }
        });
      } }
  ]);
  var mountedDeps = Object.assign({}, t.deps, { db: trapDb });
  var res = await unmount(mountedDeps, ids.studyId);
  assert.equal(res.error, "UNMOUNT_CONFLICT", JSON.stringify(res));
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].item_id, late);
  assert.ok(res.conflicts[0].current_version >= 1, "冲突件附 current_version");
  assert.equal(res.conflicts[0].location_text, "书房的书柜");
  assert.ok(res.pending, "阶段二冲突附检查点态");
  assert.equal(res.pending.status, "conflict");

  var root = (await rawDocs(t.db, "locations")).find(function (n) { return n._id === ids.studyId; });
  assert.equal(root.deleting.status, "conflict", "检查点如实置 conflict");
  assert.equal(root.deleting.phase, "compensate");
  var docLate = (await rawDocs(t.db, "items")).find(function (d) { return d._id === late; });
  assert.equal(docLate.location_node_id, ids.layerId, "冲突件挂着,绝不自动重试");

  // 用户核对(把迟到者摘出冻结子树)后续跑:重扫只含未决件,收敛
  await t.db.collection("items").doc(late).update({
    data: { location_node_id: null, last_update_id: "user-resolved" }
  });
  var resume = await unmount(t.deps, ids.studyId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  await assertConverged(t, ids, [a, late]);
});

/* ================= 检查点并发 ================= */

test("CHECKPOINT-CONDITIONAL-WRITE:立点条件写被并发抢先(仅改 updated_at)→ 失败关闭零删除,重入重新立点", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-cw-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-cw-a");
  var rootDoc = (await rawDocs(t.db, "locations")).find(function (n) { return n._id === ids.studyId; });
  var raceDb = raceCheckpointDb(t.db, "deleting", function () {
    // 竞争者:并发改写根文档(不含检查点,如 rename),updated_at 已变
    return t.db.collection("locations").doc(ids.studyId).update({
      data: { name: "书房改", updated_at: "2026-10-21T00:00:00.000Z" }
    });
  });
  var res = await unmount(Object.assign({}, t.deps, { db: raceDb }), ids.studyId);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "UNMOUNT_INCOMPLETE");
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.studyId; }), true, "零删除");
  assert.equal(nodes.some(function (n) { return n._id === ids.layerId; }), true);
  assert.equal(nodes.filter(function (n) { return n.deleting !== undefined; }).length, 0, "未立点");
  assert.equal((await rawDocs(t.db, "items")).find(function (d) { return d._id === a; }).location_node_id, null, "阶段一成果保留");
  void rootDoc;
  // 重入:节点未动、清单重算一致,重新立点后完成
  var ok = await unmount(t.deps, ids.studyId);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  await assertConverged(t, ids, [a]);
});

test("CHECKPOINT-SAME-ROOT-REPLAY:并发双开同根 → 败者识别现存检查点(op_id 确定性同值)转续跑,无双检查点", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-sr-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-sr-a");
  var raceDb = raceCheckpointDb(t.db, "deleting", function () {
    // 竞争者:先一步完成条件立点(同节点确定性 op_id,冻结同一清单)
    return t.db.collection("locations").where({
      _id: ids.studyId, household_id: HOUSEHOLD_A
    }).update({
      data: {
        deleting: {
          op_id: "unmount:" + digest16(ids.studyId), node_id: ids.studyId,
          subtree_node_ids: [ids.studyId, ids.shelfId, ids.layerId],
          phase: "nodes", counts: { unmounted: 1, compensated: 0, conflicts: 0 },
          created_at: "2026-10-21T00:00:00.000Z", status: "pending"
        },
        updated_at: "2026-10-21T00:00:01.000Z"
      }
    });
  });
  var res = await unmount(Object.assign({}, t.deps, { db: raceDb }), ids.studyId);
  assert.equal(res.ok, true, JSON.stringify(res), "败者转同根重放续跑,最终收敛");
  await assertConverged(t, ids, [a]);
});

/* ---------- P0-1(评审 5654328065):cp_rev 互斥,同毫秒不失效 ---------- */

/** 全链 where 包装(get/skip/limit 直通,update 交 onUpdate 观测) */
function observingWhereDb(db, onUpdate) {
  return {
    collection: function (name) {
      var col = db.collection(name);
      return {
        where: function (cond) {
          var q = col.where(cond);
          function wrap(qq) {
            return {
              get: function (o) { return qq.get(o); },
              skip: function (n) { return wrap(qq.skip(n)); },
              limit: function (n) { return wrap(qq.limit(n)); },
              remove: function () { return qq.remove(); },
              update: function (options) { return onUpdate(cond, options, qq); }
            };
          }
          return wrap(q);
        },
        doc: function (id) { return col.doc(id); },
        add: function (o) { return col.add(o); }
      };
    }
  };
}

/**
 * 同毫秒双立点门闩:两个写入者的立点条件写(where 带 cp_rev:0 且 patch 带
 * deleting+cp_rev:1)都到齐后才放行执行——保证双方都完成了「读 fresh(cp_rev=0)」
 * 再落笔,updated_at 全程同值(恒定 now 注入),互斥只能由 cp_rev 承担。
 */
function sameMsEstablishGateDb(db, stats) {
  var arrivals = 0;
  var release;
  var gate = new Promise(function (res) { release = res; });
  return observingWhereDb(db, function (cond, options, q) {
    var d = options && options.data;
    var isEstablish = !!(d && d.deleting !== undefined && d.cp_rev === 1 && cond.cp_rev === 0);
    if (!isEstablish) {
      return q.update(options);
    }
    stats.attempts += 1;
    arrivals += 1;
    if (arrivals === 2) release();
    return gate.then(function () {
      return q.update(options).then(function (res) {
        if (res && res.stats && res.stats.updated >= 1) stats.wins += 1;
        return res;
      });
    });
  });
}

test("CP-REV-SAME-MS-DOUBLE-ESTABLISH:同毫秒(恒定 now 注入,updated_at 全程同值)双立点 → cp_rev 条件写恰一个成功,败者读得现存 deleting 转同根重放续跑,终态收敛零残留", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var stats = { attempts: 0, wins: 0 };
  var gateDb = sameMsEstablishGateDb(t.db, stats);
  var fixedNow = function () { return "2099-01-01T00:00:00.000Z"; };
  var depsA = Object.assign({}, t.deps, { db: gateDb, now: fixedNow });
  var depsB = Object.assign({}, t.deps, { db: gateDb, now: fixedNow });

  var results = await Promise.all([unmount(depsA, ids.studyId), unmount(depsB, ids.studyId)]);

  assert.equal(stats.attempts, 2, "两个写入者都发起了立点条件写");
  assert.equal(stats.wins, 1, "同毫秒双立点:cp_rev 谓词只允许恰好一个成功(updated_at 同值,不再参与互斥)");
  for (var i = 0; i < results.length; i++) {
    assert.equal(results[i].ok, true, JSON.stringify(results[i]), "胜者完成 / 败者同根重放续跑,双双收敛");
  }
  await assertConverged(t, ids, []);
});

test("CP-REV-ADVANCE-SAME-MS:同毫秒并发续跑交错推进 → 每笔成功的检查点写 cp_rev 严格 +1、phase 严格单调(compensate→scans→final 各恰一笔),不回退不双写,终态收敛", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-msa-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-msa-a");
  await seedScan(t.db, "scan-msa", ids.layerId);
  // 前置:立点(cp_rev 0→1)后首删即断 → phase=nodes 检查点悬置
  var r1 = await unmount(
    Object.assign({}, t.deps, { db: faultDb(t.db, [{ collection: "locations", op: "docRemove", at: 1 }]) }),
    ids.studyId
  );
  assert.equal(r1.error, "UNMOUNT_INCOMPLETE");
  assert.equal(r1.pending.phase, "nodes");

  var written = [];
  var recordDb = observingWhereDb(t.db, function (cond, options, q) {
    var d = options && options.data;
    if (!(d && d.deleting !== undefined && d.deleting.phase)) {
      return q.update(options);
    }
    return q.update(options).then(function (res) {
      if (res && res.stats && res.stats.updated >= 1) {
        written.push({ phase: d.deleting.phase, cp_rev: d.cp_rev });
      }
      return res;
    });
  });
  var fixedNow = function () { return "2099-01-02T00:00:00.000Z"; };
  var depsC = Object.assign({}, t.deps, { db: recordDb, now: fixedNow });
  var depsD = Object.assign({}, t.deps, { db: recordDb, now: fixedNow });

  var results = await Promise.all([unmount(depsC, ids.studyId), unmount(depsD, ids.studyId)]);

  assert.deepEqual(
    written.map(function (w) { return w.phase; }),
    ["compensate", "scans", "final"],
    "同毫秒交错下每个 phase 迁移恰一笔成功推进(实测:" + JSON.stringify(written) + ")"
  );
  assert.deepEqual(
    written.map(function (w) { return w.cp_rev; }),
    [2, 3, 4],
    "成功检查点写 cp_rev 严格 +1 单调(立点=1,此后 2/3/4)"
  );
  for (var i = 0; i < results.length; i++) {
    assert.equal(results[i].ok, true, JSON.stringify(results[i]));
  }
  await assertConverged(t, ids, [a]);
});

/* ---------- P0-2(评审 5654328065):写入时保护 + 终态孤儿扫描 ---------- */

/** 原始形状检查点(绕过条件写直接落库,驱动「立点后」前置态) */
async function rawCheckpoint(db, rootId, subtreeIds, extra) {
  var cp = {
    op_id: "unmount:" + digest16(rootId), node_id: rootId,
    subtree_node_ids: subtreeIds,
    phase: "nodes", counts: { unmounted: 0, compensated: 0, conflicts: 0 },
    created_at: "2026-10-22T00:00:00.000Z", status: "pending"
  };
  Object.assign(cp, extra || {});
  await db.collection("locations").doc(rootId).update({
    data: { deleting: cp, updated_at: "2026-10-22T00:00:00.000Z" }
  });
  return cp;
}

/**
 * 立点竞态注入:unmount 的立点条件写落库前,先执行 rival(模拟「校验/门已通过」
 * 的并发写者趁隙写入)——冻结清单在此之前已按无孤儿树算好,新节点必在清单外。
 */
function rivalAtEstablishDb(db, rival) {
  var fired = false;
  return {
    collection: function (name) {
      var col = db.collection(name);
      if (name !== "locations") return col;
      return {
        where: function (cond) {
          var q = col.where(cond);
          function wrap(qq) {
            return {
              get: function (o) { return qq.get(o); },
              skip: function (n) { return wrap(qq.skip(n)); },
              limit: function (n) { return wrap(qq.limit(n)); },
              remove: function () { return qq.remove(); },
              update: function (options) {
                if (!fired && options && options.data && options.data.deleting !== undefined) {
                  fired = true;
                  return Promise.resolve().then(rival).then(function () { return qq.update(options); });
                }
                return qq.update(options);
              }
            };
          }
          return wrap(q);
        },
        doc: function (id) { return col.doc(id); },
        add: function (o) { return col.add(o); }
      };
    }
  };
}

/** 直接落一个清单外新节点(绕过全部服务端门,代表窗口期已过校验的建节点请求) */
async function addOrphanNode(db, id, parentId, name) {
  await db.collection("locations").add({ data: {
    _id: id, household_id: HOUSEHOLD_A, parent_id: parentId,
    name: name, name_norm: name, type: "container",
    path: ["书房", "书柜", "第一层", name],
    created_from: "manual",
    created_at: "2026-10-22T00:00:00.000Z",
    updated_at: "2026-10-22T00:00:00.000Z",
    cp_rev: 0
  } });
  return id;
}

test("ORPHAN-SWEEP-PRECHECK-RACE:预检通过→立点→清单外新增子节点(含挂载物品与 active scan)→ 终检孤儿扫描发现并入本轮删除,补偿/标记随清单扩展,终态零残留", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var orphanItem = await createItem(t.deps, "op-orph-a", "窗口期挂入的物品", "书房");
  var orphanId = "lc-orphan-race";
  var trapDeps = Object.assign({}, t.deps, { db: rivalAtEstablishDb(t.db, function () {
    // 立点条件写落库前:一个「校验已通过」的建节点请求写入(清单已算好,不含它)
    return addOrphanNode(t.db, orphanId, ids.layerId, "窗口期新抽屉").then(function () {
      return t.db.collection("items").doc(orphanItem).update({
        data: { location_node_id: orphanId, last_update_id: "raced-writer" }
      });
    }).then(function () {
      return seedScan(t.db, "scan-orph", orphanId);
    });
  }) });
  await seedScan(t.db, "scan-orph-layer", ids.layerId);

  var res = await unmount(trapDeps, ids.studyId);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.deleted_nodes, 4, "清单 3 节点 + 清单外孤儿 1 并入删除");
  assert.equal(res.compensated, 1, "孤儿上的挂载物品由终检补偿(清单扩展后重扫)");
  assert.equal(res.scans_marked, 2, "清单内 scan + 孤儿 scan 各 1");

  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.length, 2, "零残留:仅 home 根 + 厨房");
  assert.equal(nodes.some(function (n) { return n._id === orphanId; }), false, "孤儿节点被并入删除");
  var docItem = (await rawDocs(t.db, "items")).find(function (d) { return d._id === orphanItem; });
  assert.ok(docItem.location_node_id === null, "孤儿上挂载的物品已解挂,绝不遗留无父孤儿挂载");
  var scans = await rawDocs(t.db, "location_scans");
  for (var s = 0; s < scans.length; s++) {
    assert.equal(scans[s].status, "location_deleted", "孤儿 scan 一并标记:" + scans[s].scan_id);
  }
});

test("ORPHAN-SWEEP-CHAIN:孤儿链(清单外子节点 + 其孙辈)同被终检抓全并入删除,孙辈断链经增长后的已删集合续判", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var childId = "lc-orphan-chain-1";
  var grandId = "lc-orphan-chain-2";
  var trapDeps = Object.assign({}, t.deps, { db: rivalAtEstablishDb(t.db, function () {
    return addOrphanNode(t.db, childId, ids.layerId, "窗口期子节点").then(function () {
      return addOrphanNode(t.db, grandId, childId, "窗口期孙节点");
    });
  }) });
  var res = await unmount(trapDeps, ids.studyId);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.deleted_nodes, 5, "清单 3 + 孤儿链 2");
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.length, 2, "零残留(孤儿链整条扫清)");
  assert.equal(nodes.some(function (n) { return n._id === childId; }), false);
  assert.equal(nodes.some(function (n) { return n._id === grandId; }), false);
});

test("ORPHAN-SWEEP-REMOVE-FAULT:孤儿删除持续失败(超轮无法收敛)→ status=conflict 如实报告绝不假报成功;重入续跑收敛", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var orphanId = "lc-orphan-fault";
  var trapDeps = Object.assign({}, t.deps, { db: faultDb(t.db, [
    { collection: "locations", op: "whereUpdate", patchHas: "deleting", at: 1, noThrow: true,
      action: function () { return addOrphanNode(t.db, orphanId, ids.layerId, "窗口期新抽屉"); } },
    { collection: "locations", op: "docRemove", id: orphanId, at: 1 } // 孤儿 remove 恒抛
  ]) });
  var res = await unmount(trapDeps, ids.studyId);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "UNMOUNT_CONFLICT", "无法收敛 ⇒ conflict 语义,绝不假报成功");
  assert.equal(res.pending.status, "conflict", "检查点如实置 conflict");
  assert.equal(res.detail.reason, "sweep_failed");
  var nodesMid = await rawDocs(t.db, "locations");
  assert.equal(nodesMid.some(function (n) { return n._id === ids.studyId; }), true, "根保留(检查点在)");
  assert.equal(nodesMid.some(function (n) { return n._id === orphanId; }), true, "孤儿暂存,等续跑");

  var resume = await unmount(t.deps, ids.studyId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  assert.equal(resume.deleted_nodes, 4, "续跑扫清清单+孤儿");
  assert.equal((await rawDocs(t.db, "locations")).length, 2, "零残留");
});

test("ORPHAN-SWEEP-SCAN-FAILED:终检孤儿扫描的节点全量读失败 → conflict 如实报告(不假报成功、不假报收敛);重入续跑收敛", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  function scanFailDb(db) {
    var armed = false;
    var fired = false;
    return {
      collection: function (name) {
        var col = db.collection(name);
        if (name !== "locations") return col;
        return {
          where: function (cond) {
            var q = col.where(cond);
            function wrap(qq) {
              return {
                get: function () {
                  var isFullFetch = cond && Object.keys(cond).length === 1 && cond.household_id !== undefined;
                  if (armed && !fired && isFullFetch) {
                    fired = true;
                    return Promise.reject(new Error("fault:locations:fullScan"));
                  }
                  return qq.get();
                },
                skip: function (n) { return wrap(qq.skip(n)); },
                limit: function (n) { return wrap(qq.limit(n)); },
                remove: function () { return qq.remove(); },
                update: function (options) {
                  if (options && options.data && options.data.deleting !== undefined) {
                    armed = true; // 立点之后,终检的全量扫描才算「孤儿扫描」
                  }
                  return qq.update(options);
                }
              };
            }
            return wrap(q);
          },
          doc: function (id) { return col.doc(id); },
          add: function (o) { return col.add(o); }
        };
      }
    };
  }
  var res = await unmount(
    Object.assign({}, t.deps, { db: scanFailDb(t.db) }),
    ids.studyId
  );
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "UNMOUNT_CONFLICT", "扫描失败 ⇒ conflict 如实报告");
  assert.equal(res.pending.status, "conflict");
  assert.equal(res.detail.reason, "sweep_failed");
  var nodesMid = await rawDocs(t.db, "locations");
  assert.equal(nodesMid.some(function (n) { return n._id === ids.studyId; }), true, "根保留");
  // 阶段②③④已完成:书柜/第一层 属清单内合法删除;保全的是 根+厨房——绝无清单外误删
  assert.equal(nodesMid.length, 3, "home 根 + 书房(带检查点)+ 厨房,清单外零误删");
  var resume = await unmount(t.deps, ids.studyId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  await assertConverged(t, ids, []);
});

/* ---------- 评审 5660849034:存量受控初始化(listAction 字段缺席迁移笔)+ 纯整数 CAS,时间戳互斥谓词全消灭(v4.4;取代 v4.3「引导笔仅 bump+立点笔合一」与 v4.2 两笔初始化) ---------- */

/** 存量形状:移除全部 location 文档的 cp_rev(模拟本合同落地前出生的节点) */
async function stripCpRev(db) {
  var docs = (await db.collection("locations").where({}).get()).data;
  for (var i = 0; i < docs.length; i++) {
    await db.collection("locations").doc(docs[i]._id).remove();
    var legacy = Object.assign({}, docs[i]);
    delete legacy.cp_rev;
    await db.collection("locations").add({ data: legacy });
  }
}

/** 根文档原始形状直读(不投影) */
async function rootRawDoc(db, rootId) {
  var rows = (await db.collection("locations").where({ _id: rootId }).get()).data;
  return rows[0] || null;
}

/** 迁移笔识别:cond 的 cp_rev 值为字段缺席哨兵({ __hm_field_absent__: true } 形状) */
function isMigrationPen(cond) {
  return !!(
    cond && cond.cp_rev !== null && typeof cond.cp_rev === "object" &&
    cond.cp_rev.__hm_field_absent__ === true
  );
}

/**
 * 并发迁移门闩(LEGACY-MIGRATION-ABSENT-COND):同一 _id 的迁移笔都到齐后才放行
 * 执行——两笔都按「读到的无 cp_rev 形状」建好谓词后才落笔,字段缺席条件只允许
 * 恰一笔命中(第一笔把 cp_rev 从无到 0,第二笔谓词必失配),绝不覆盖已存在值。
 */
function migrationRaceGateDb(db, targetId, stats) {
  var arrivals = 0;
  var release;
  var gate = new Promise(function (res) { release = res; });
  return observingWhereDb(db, function (cond, options, q) {
    if (!(cond && cond._id === targetId && isMigrationPen(cond))) {
      return q.update(options);
    }
    arrivals += 1;
    stats.pens += 1;
    if (arrivals === 2) release();
    return gate.then(function () {
      return q.update(options).then(function (res) {
        if (res && res.stats && res.stats.updated >= 1) {
          stats.wins += 1;
        } else {
          stats.misses += 1;
        }
        return res;
      });
    });
  });
}

test("LEGACY-MIGRATION-ABSENT-COND:listAction 读到无 cp_rev 节点 → 字段缺席谓词迁移笔写入 cp_rev:0;再次 list 零新笔;两个并发 listAction 对同一节点恰一笔迁移成功(失配笔绝不覆盖已存在值);迁移后 unmount 正常收敛", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  await stripCpRev(t.db);
  // 单次 list:全部存量节点各恰一笔迁移笔,写后 cp_rev=0(整数),节点其余字段不动
  var pens1 = { count: 0 };
  var countDb1 = observingWhereDb(t.db, function (cond, options, q) {
    if (isMigrationPen(cond)) pens1.count += 1;
    return q.update(options);
  });
  var res1 = await locHandler({ action: "list" }, Object.assign({}, t.deps, { db: countDb1 }));
  assert.equal(res1.ok, true, JSON.stringify(res1));
  assert.equal(pens1.count, 5, "5 个存量节点各恰一笔迁移笔(谓词=cp_rev 字段缺席,零时间戳)");
  var nodes1 = await rawDocs(t.db, "locations");
  assert.equal(nodes1.length, 5);
  for (var i = 0; i < nodes1.length; i++) {
    assert.ok(
      Number.isInteger(nodes1[i].cp_rev) && nodes1[i].cp_rev === 0,
      "迁移后 cp_rev=0:" + nodes1[i]._id + "(实测:" + JSON.stringify(nodes1[i].cp_rev) + ")"
    );
  }
  // 再次 list:全部节点已带 cp_rev ⇒ 零新迁移笔(字段缺席谓词对存在值恒失配,幂等收敛)
  var pens2 = { count: 0 };
  var countDb2 = observingWhereDb(t.db, function (cond, options, q) {
    if (isMigrationPen(cond)) pens2.count += 1;
    return q.update(options);
  });
  await locHandler({ action: "list" }, Object.assign({}, t.deps, { db: countDb2 }));
  assert.equal(pens2.count, 0, "已迁移节点不再发笔");

  // 并发:两个 listAction 都按存量形状读到 → 同一节点两笔迁移笔,恰一笔命中
  await stripCpRev(t.db);
  var stats = { pens: 0, wins: 0, misses: 0 };
  var raceDb = migrationRaceGateDb(t.db, ids.studyId, stats);
  var results = await Promise.all([
    locHandler({ action: "list" }, Object.assign({}, t.deps, { db: raceDb })),
    locHandler({ action: "list" }, Object.assign({}, t.deps, { db: raceDb }))
  ]);
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.equal(results[1].ok, true, JSON.stringify(results[1]));
  assert.equal(stats.pens, 2, "两个并发 listAction 对书房根各发一笔迁移笔");
  assert.equal(stats.wins, 1, "字段缺席条件:恰一笔把 cp_rev 从无写到 0");
  assert.equal(stats.misses, 1, "另一笔谓词失配(cp_rev 已存在),绝不二次覆盖/回写");
  var rootAfter = await rootRawDoc(t.db, ids.studyId);
  assert.ok(Number.isInteger(rootAfter.cp_rev) && rootAfter.cp_rev === 0, "终态 cp_rev=0");

  // 迁移完成后 unmount 立点走纯整数 CAS(0→1),正常收敛(原 STOCK-CP-REV-BOOTSTRAP 场景)
  var un = await unmount(t.deps, ids.studyId);
  assert.equal(un.ok, true, JSON.stringify(un));
  assert.equal(un.deleted_nodes, 3, "受控迁移不改变删除计数");
  await assertConverged(t, ids, []);
});

test("LEGACY-UNMOUNT-WITHOUT-MIGRATION:直接调 unmount(未走 listAction)遇缺 cp_rev 根 → 阶段一之前失败关闭 INVALID_INPUT(明确提示走删除预览),零解挂零写入零删除;走一次 list 后同一请求成功(受控迁移闭环)", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var item = await createItem(t.deps, "op-legacy-direct", "字典", "书房的书柜");
  await linkItem(t.deps, item, ids.layerId, 1, "u-legacy-direct");
  await stripCpRev(t.db);
  var res = await unmount(t.deps, ids.studyId);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "INVALID_INPUT", "缺 cp_rev 根:失败关闭,受控迁移路径");
  assert.ok(
    res.message.indexOf("请先进入该位置的删除预览再重试") !== -1,
    "错误消息明确引导受控迁移入口(实测:" + res.message + ")"
  );
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.length, 5, "零删除:全部节点仍在");
  var root = nodes.find(function (n) { return n._id === ids.studyId; });
  assert.equal(root.deleting, undefined, "未立检查点");
  assert.equal(root.cp_rev, undefined, "unmount 路径绝不就地初始化(迁移只发生在 list 读路径)");
  var itemDoc = (await rawDocs(t.db, "items")).find(function (d) { return d._id === item; });
  assert.equal(itemDoc.location_node_id, ids.layerId, "阶段一未执行:挂载未被解挂(失败关闭先于一切副作用)");
  // 受控迁移闭环:走一次 list(惰性迁移)后,同一 unmount 请求即成功
  var listed = await locHandler({ action: "list" }, t.deps);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  var ok = await unmount(t.deps, ids.studyId);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  await assertConverged(t, ids, [item]);
});

test("STOCK-CP-REV-SAME-MS-DOUBLE-ESTABLISH:存量根经 list 迁移(cp_rev=0)后,恒定时间戳(updated_at 全程同值)双立点 → 纯整数 CAS 恰一个成功,败者读得现存 deleting 转同根重放续跑,双双收敛零残留(存量互斥不再依赖时间戳)", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  await stripCpRev(t.db);
  await locHandler({ action: "list" }, t.deps); // 受控迁移:全部节点 cp_rev=0
  var stats = { attempts: 0, wins: 0 };
  var gateDb = sameMsEstablishGateDb(t.db, stats);
  var fixedNow = function () { return "2099-01-01T00:00:00.000Z"; };
  var depsA = Object.assign({}, t.deps, { db: gateDb, now: fixedNow });
  var depsB = Object.assign({}, t.deps, { db: gateDb, now: fixedNow });

  var results = await Promise.all([unmount(depsA, ids.studyId), unmount(depsB, ids.studyId)]);

  assert.equal(stats.attempts, 2, "两个写入者都发起了整数 CAS 立点笔(谓词 cp_rev=0)");
  assert.equal(stats.wins, 1, "同毫秒双立点:纯整数 CAS 只允许恰好一个成功(updated_at 同值,不参与互斥)");
  for (var i = 0; i < results.length; i++) {
    assert.equal(results[i].ok, true, JSON.stringify(results[i]), "胜者完成 / 败者同根重放续跑,双双收敛");
  }
  await assertConverged(t, ids, []);
});

/**
 * 迟到立点门闩(评审 5660849034 点名的确定性交错,v4.4 口径):双立点笔都到齐后才
 * 放行**先到者(A)**执行;后到者(B,谓词持旧 cp_rev=0)持续挂起。A 立点(cp_rev
 * 0→1)→ 推进笔把 cp_rev 写到 2 → A 的下一笔检查点写(cp_rev=3)被注入故障打断,
 * A 以 UNMOUNT_INCOMPLETE 落定、库内检查点停在 cp_rev=2;此刻才放行 B 的迟到立点
 * 笔执行——即「B 的立点笔晚于 A 推进到 cp_rev=2 之后才执行」。恒定时间戳注入:
 * updated_at 全程同值,迟到立点笔的 updated_at 谓词照样命中,**只能由 cp_rev 谓词
 * 拦下**(v4.3 时间戳引导在同毫秒下恰在此处失效:迟到立点命中旧 updated_at 谓词,
 * 把已推进的 cp_rev=2/orphan_ids 覆盖回 1/nodes——评审点名漏洞)。
 * probe:{ releaseLate()(外部放行迟到笔), lateUpdated(B 笔命中数),
 * before(A 落定后、B 执行前根形状), after(B 迟到笔执行后根形状) }
 */
function lateEstablishGateDb(db, probe) {
  var establishArrivals = 0;
  var releaseBoth;
  var bothArrived = new Promise(function (res) { releaseBoth = res; });
  var releaseLate;
  var lateGate = new Promise(function (res) { releaseLate = res; });
  var sawAdvance2 = false;
  var faulted = false;
  probe.releaseLate = releaseLate;
  return observingWhereDb(db, function (cond, options, q) {
    var d = options && options.data;
    if (!(d && d.deleting !== undefined)) {
      return q.update(options); // 非检查点笔直通
    }
    var isEstablish = !!(d.cp_rev === 1 && cond.cp_rev === 0);
    if (isEstablish) {
      establishArrivals += 1;
      if (establishArrivals === 2) releaseBoth();
      if (establishArrivals === 1) {
        // A(先到):两笔到齐后立即执行,随后一路推进直至被故障打断
        return bothArrived.then(function () {
          return q.update(options);
        });
      }
      // B(后到、迟到):挂起到 A 落定、外部调 probe.releaseLate() 后才执行
      return lateGate.then(function () {
        return q.update(options).then(function (res) {
          probe.lateUpdated = res && res.stats ? res.stats.updated : -1;
          return rootRawDoc(db, cond._id).then(function (doc) {
            probe.after = doc;
            return res;
          });
        });
      });
    }
    // 检查点推进笔:cp_rev=2 落库后,武装「打断下一笔(cp_rev=3)」——打断先于执行,
    // 库内检查点停在 cp_rev=2
    if (sawAdvance2 && !faulted && d.cp_rev === 3) {
      faulted = true;
      return Promise.reject(new Error("fault:late-establish:advance3"));
    }
    return q.update(options).then(function (res) {
      if (res && res.stats && res.stats.updated >= 1 && d.cp_rev === 2) {
        sawAdvance2 = true;
      }
      return res;
    });
  });
}

test("STOCK-LATE-ESTABLISH-AFTER-ADVANCE:A 立点+推进到 cp_rev=2 后,B 的迟到立点(恒定时间戳,updated_at 谓词同值仍命中)才执行 → cp_rev 谓词失配 0 命中,已推进检查点(含 subtree_node_ids/counts 及 orphan_ids 等全部清单字段)分毫未动,B 转同根重放续跑收敛(评审 5660849034 点名交错;v4.3 同毫秒迟到立点覆盖漏洞的反例位)", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  await stripCpRev(t.db);
  await locHandler({ action: "list" }, t.deps); // 受控迁移:全部节点 cp_rev=0
  // 恒定时间戳 = 根当前 updated_at:B 的迟到立点笔 updated_at 谓词全程同值命中,
  // 0 命中只能归因于 cp_rev 谓词失配(这正是被消灭的时间戳互斥缺口)
  var rootDoc = await rootRawDoc(t.db, ids.studyId);
  var sameMs = rootDoc.updated_at;
  var fixedNow = function () { return sameMs; };
  var probe = {};
  var gateDb = lateEstablishGateDb(t.db, probe);
  var depsA = Object.assign({}, t.deps, { db: gateDb, now: fixedNow });
  var depsB = Object.assign({}, t.deps, { db: gateDb, now: fixedNow });

  var pA = unmount(depsA, ids.studyId);
  var pB = unmount(depsB, ids.studyId);
  // 先到立点者(runner,不绑定具体请求)一路推进直至被注入故障打断落定;后到的
  // 迟到立点笔此刻仍挂起(未执行),库内检查点稳定停在 cp_rev=2
  var runnerRes = await Promise.race([pA, pB]);

  assert.equal(runnerRes.ok, false, JSON.stringify(runnerRes));
  assert.equal(runnerRes.error, "UNMOUNT_INCOMPLETE", "先到立点者被注入故障打断,如实未完成");
  probe.before = await rootRawDoc(t.db, ids.studyId);
  assert.ok(probe.before, "先到者落定后根形状已采样");
  assert.equal(probe.before.cp_rev, 2, "库内检查点停在 cp_rev=2(推进笔已落库)");
  assert.equal(probe.before.deleting.phase, "compensate", "phase 已推进到 compensate(不再是立点时的 nodes)");
  probe.releaseLate(); // 此刻才放行迟到立点笔(晚于推进到 cp_rev=2 之后)
  var settled = await Promise.all([pA, pB]);

  assert.equal(probe.lateUpdated, 0, "迟到立点笔 0 命中——cp_rev 谓词失配(updated_at 同值已命中,全靠整数 CAS 拦下)");
  assert.deepEqual(probe.after.deleting, probe.before.deleting, "已推进检查点整体分毫未动(含 subtree_node_ids/counts/orphan_ids 等全部清单字段,绝无覆盖回 nodes/低版本)");
  assert.equal(probe.after.cp_rev, 2, "cp_rev 仍为 2,版本号零回退");
  assert.equal(
    settled.filter(function (r) { return r.ok === true; }).length,
    1,
    "恰一个请求收敛完成(迟到者转同根重放续跑),另一请求如实 UNMOUNT_INCOMPLETE:" +
      JSON.stringify(settled.map(function (r) { return r.ok + "/" + r.error; }))
  );
  await assertConverged(t, ids, []);
});

/** 组合注入:locations 走 rival 包装(立点竞态写入孤儿)、items 走 sabotage 包装(补偿 CAS 抛错) */
function combineLocItemsDb(baseDb, locationsWrapper, itemsWrapper) {
  return {
    collection: function (name) {
      if (name === "locations") return locationsWrapper.collection(name);
      if (name === "items") return itemsWrapper.collection(name);
      return baseDb.collection(name);
    }
  };
}

test("ORPHAN-PERSIST-BEFORE-DELETE:孤儿发现→orphan_ids 并入检查点持久化→删除孤儿→补偿前中断 → 续跑凭检查点完成补偿与 scan 标记,终态零残留", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var orphanItem = await createItem(t.deps, "op-persist-a", "孤儿上的物品", "书房");
  var orphanId = "lc-orphan-persist";
  var locationsSide = rivalAtEstablishDb(t.db, function () {
    return addOrphanNode(t.db, orphanId, ids.layerId, "窗口期新抽屉").then(function () {
      return t.db.collection("items").doc(orphanItem).update({
        data: { location_node_id: orphanId, last_update_id: "raced-writer" }
      });
    }).then(function () {
      return seedScan(t.db, "scan-persist", orphanId);
    });
  });
  var itemsSide = sabotageMountDb(t.db, orphanItem, function () {
    throw new Error("fault:compensate-orphan-item");
  });
  var trapDeps = Object.assign({}, t.deps, {
    db: combineLocItemsDb(t.db, locationsSide, itemsSide)
  });

  var res = await unmount(trapDeps, ids.studyId);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "UNMOUNT_INCOMPLETE", "孤儿删除后、补偿前中断 ⇒ 如实报告未完成");
  assert.equal(res.pending.phase, "final", "终检阶段中断,检查点在");

  // 核心断言(修 2):孤儿 id 在物理删除**前**已持久并入检查点——即使本进程消亡,
  // 续跑也能凭检查点找到该孤儿完成补偿/标记,而不是留下无凭据的悬挂
  var rootDoc = (await rawDocs(t.db, "locations")).find(function (n) { return n._id === ids.studyId; });
  assert.ok(rootDoc && rootDoc.deleting, "根与检查点保留");
  assert.ok(Array.isArray(rootDoc.deleting.orphan_ids), "orphan_ids 已持久化:" + JSON.stringify(rootDoc.deleting));
  assert.deepEqual(rootDoc.deleting.orphan_ids, [orphanId], "孤儿 id 恰在检查点删除清单");
  var nodesMid = await rawDocs(t.db, "locations");
  assert.equal(nodesMid.some(function (n) { return n._id === orphanId; }), false, "孤儿节点已物理删除(删除先于补偿)");
  assert.equal(nodesMid.some(function (n) { return n._id === ids.layerId; }), false, "清单内后代已删");
  var scanMid = (await rawDocs(t.db, "location_scans")).find(function (s) { return s.scan_id === "scan-persist"; });
  assert.equal(scanMid.status, "active", "孤儿 scan 尚未标记(补偿/标记前中断)");
  var itemMid = (await rawDocs(t.db, "items")).find(function (d) { return d._id === orphanItem; });
  assert.equal(itemMid.location_node_id, orphanId, "孤儿物品尚未补偿(悬挂在已删孤儿上)");

  var resume = await unmount(t.deps, ids.studyId);
  assert.equal(resume.ok, true, JSON.stringify(resume), "续跑凭 orphan_ids 恢复补偿与标记");
  assert.equal(resume.compensated, 1, "孤儿上的挂载物品被补偿置 null");
  assert.equal(resume.scans_marked, 1, "孤儿 scan 被标记 location_deleted");
  assert.equal(resume.deleted_nodes, 4, "清单 3 + 孤儿 1");
  await assertConverged(t, ids, [orphanItem]);
});

test("ORPHAN-IDS-CORRUPT:检查点 orphan_ids 形状非法(非数组)→ UNMOUNT_CHECKPOINT_CORRUPT,零续跑零删除", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  await rawCheckpoint(t.db, ids.studyId, [ids.studyId, ids.shelfId, ids.layerId], { orphan_ids: "bogus" });
  var res = await unmount(t.deps, ids.studyId);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "UNMOUNT_CHECKPOINT_CORRUPT");
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.length, 5, "零删除零续跑");
});

/** 删根后复扫描失败注入:根 doc 移除后的下一次 locations 全量读抛错 */
function postRescanFailDb(db, rootId) {
  var rootRemoved = false;
  var fired = false;
  return {
    collection: function (name) {
      var col = db.collection(name);
      if (name !== "locations") return col;
      return {
        where: function (cond) {
          var q = col.where(cond);
          function wrap(qq) {
            return {
              get: function () {
                var isFullFetch = cond && Object.keys(cond).length === 1 && cond.household_id !== undefined;
                if (rootRemoved && !fired && isFullFetch) {
                  fired = true;
                  return Promise.reject(new Error("fault:post-root-rescan"));
                }
                return qq.get();
              },
              skip: function (n) { return wrap(qq.skip(n)); },
              limit: function (n) { return wrap(qq.limit(n)); },
              remove: function () { return qq.remove(); },
              update: function (options) { return qq.update(options); }
            };
          }
          return wrap(q);
        },
        doc: function (id) {
          var d = col.doc(id);
          return {
            get: d.get.bind(d),
            update: function (o) { return d.update(o); },
            remove: function () {
              return d.remove().then(function (r) {
                if (id === rootId) rootRemoved = true;
                return r;
              });
            }
          };
        },
        add: function (o) { return col.add(o); }
      };
    }
  };
}

test("POST-ROOT-RESCAN-NO-FALSE-SUCCESS:终检通过→删根瞬间并发建子节点(写入时保护窗口)→ 删根后轻量复扫发现新孤儿 ⇒ 绝不假报完整成功(ok:false 带残留清单与处置建议,检查点已随根删除不造 pending)", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var lateChildId = "lc-post-root-late";
  var trapDeps = Object.assign({}, t.deps, { db: faultDb(t.db, [
    { collection: "locations", op: "docRemove", id: ids.studyId, at: 1, noThrow: true,
      action: function () { return addOrphanNode(t.db, lateChildId, ids.studyId, "删根瞬间新节点"); } }
  ]) });
  var res = await unmount(trapDeps, ids.studyId);
  assert.equal(res.ok, false, JSON.stringify(res), "删根后复扫发现新孤儿 ⇒ 不得假报 ok:true");
  assert.equal(res.error, "UNMOUNT_INCOMPLETE");
  assert.equal(res.pending, null, "检查点已随根删除:如实置 null,不造恢复凭据");
  assert.deepEqual(res.detail.post_root_orphans, [lateChildId], "残留孤儿 id 清单如实随响应返回");
  assert.equal(res.detail.rescan_failed, false);
  assert.equal(typeof res.detail.advice, "string", "附处置建议");
  // 文案口径(评审 5660650680 附带要求):不承诺从已删位置重新发起删除/自动恢复,
  // 只建议人工核对——原根已硬删,普通位置页不一定能导航或重新删除残留孤儿
  assert.ok(res.message.indexOf("人工核对") !== -1, "message 建议人工核对:" + res.message);
  assert.ok(res.message.indexOf("重新对该位置发起删除") === -1, "message 不得承诺从已删位置重新发起删除");
  assert.ok(res.detail.advice.indexOf("人工核对") !== -1, "advice 建议人工核对");
  assert.ok(res.detail.advice.indexOf("重新发起删除") === -1, "advice 不得承诺重新发起删除");
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.studyId; }), false, "根确已删");
  assert.equal(nodes.some(function (n) { return n._id === lateChildId; }), true, "残留孤儿如实保留(不无凭据硬删)");
  assert.equal(nodes.length, 3, "home 根 + 厨房 + 残留孤儿");
});

test("POST-ROOT-RESCAN-FAILED:删根后复扫读失败 ⇒ 无法证实零残留 ⇒ ok:false 如实返回(不假报成功)", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var res = await unmount(
    Object.assign({}, t.deps, { db: postRescanFailDb(t.db, ids.studyId) }),
    ids.studyId
  );
  assert.equal(res.ok, false, JSON.stringify(res), "复扫失败同样绝不假报成功");
  assert.equal(res.error, "UNMOUNT_INCOMPLETE");
  assert.equal(res.pending, null);
  assert.equal(res.detail.rescan_failed, true);
  assert.equal(res.detail.post_root_orphans, null);
  await assertConverged(t, ids, []);
});

test("WRITE-GUARD-LAST-MOMENT:ensurePath 入口门通过后、建节点写入前立点 → createNode 写入前最后一刻复查冻结集拦下,零新节点;入口门(非竞态)行为不变", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  function gateRaceDb(db, onGatePassed) {
    var fired = false;
    return {
      collection: function (name) {
        var col = db.collection(name);
        if (name !== "locations") return col;
        return {
          where: function (cond) {
            var q = col.where(cond);
            function wrap(qq) {
              return {
                get: function () {
                  var isFullFetch = cond && Object.keys(cond).length === 1 && cond.household_id !== undefined;
                  if (!fired && isFullFetch) {
                    fired = true;
                    // 入口门快照先取到(不含检查点 ⇒ 门通过),放行前立点落库:
                    // 此后 createNode 的最后一刻复查读到的即冻结态
                    return qq.get().then(function (r) {
                      return onGatePassed().then(function () { return r; });
                    });
                  }
                  return qq.get();
                },
                skip: function (n) { return wrap(qq.skip(n)); },
                limit: function (n) { return wrap(qq.limit(n)); },
                remove: function () { return qq.remove(); },
                update: function (options) { return qq.update(options); }
              };
            }
            return wrap(q);
          },
          doc: function (id) { return col.doc(id); },
          add: function (o) { return col.add(o); }
        };
      }
    };
  }
  var raceDb = gateRaceDb(t.db, function () {
    return rawCheckpoint(t.db, ids.studyId, [ids.studyId, ids.shelfId, ids.layerId]);
  });
  var res = await ensurePathRaw(Object.assign({}, t.deps, { db: raceDb }), ["书房", "新箱子"]);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "INVALID_INPUT");
  assert.deepEqual(res.detail, { reason: "deleting" }, "写入时保护:最后一刻复查拦下");
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.length, 5, "零新节点(新箱子 未落库)");
  assert.equal(nodes.filter(function (n) { return n.deleting !== undefined; }).length, 1, "检查点在");
  // 非竞态路径:入口门自身照旧拦(既有 FREEZE-GATE 反例行为不变)
  var again = await ensurePathRaw(t.deps, ["书房", "新箱子"]);
  assert.deepEqual(again.detail, { reason: "deleting" }, "入口门照常生效");
  // 续跑收敛后放行
  var resume = await unmount(t.deps, ids.studyId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  var after = await ensurePathRaw(t.deps, ["书房", "新箱子"]);
  assert.equal(after.ok, true, JSON.stringify(after), "检查点消失后恢复建节点");
});

/* ================= 嵌套 unmount 与旧入口关死 ================= */

test("NESTED-UNMOUNT:祖先带 deleting 时对后代发起 unmount → INVALID_INPUT({reason:deleting});对 deleting 根重入 → 续跑(唯一例外)", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  await freezeMidOp(t, ids);
  var nested = await unmount(t.deps, ids.layerId);
  assert.equal(nested.ok, false);
  assert.equal(nested.error, "INVALID_INPUT");
  assert.deepEqual(nested.detail, { reason: "deleting" });
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.filter(function (n) { return n.deleting !== undefined; }).length, 1, "不立第二检查点");
  // 对 deleting 根自身重入 = 续跑,唯一放行例外
  var resume = await unmount(t.deps, ids.studyId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  assert.equal((await rawDocs(t.db, "locations")).filter(function (n) { return n.deleting !== undefined; }).length, 0);
});

test("OLD-DELETE-FORCE:旧 delete(含 force)作用于 deleting 根或子树内节点 → 一律 INVALID_INPUT({reason:deleting}),检查点不丢", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  await freezeMidOp(t, ids);
  // 阶段一已摘空:force 的空判本会满足——冻结门必须把它关死
  var onRoot = await locHandler({ action: "delete", node_id: ids.studyId, force: true }, t.deps);
  assert.equal(onRoot.ok, false);
  assert.equal(onRoot.error, "INVALID_INPUT");
  assert.deepEqual(onRoot.detail, { reason: "deleting" });
  var onDescendant = await locHandler({ action: "delete", node_id: ids.layerId, force: true }, t.deps);
  assert.equal(onDescendant.error, "INVALID_INPUT");
  assert.deepEqual(onDescendant.detail, { reason: "deleting" });
  var noForce = await locHandler({ action: "delete", node_id: ids.shelfId }, t.deps);
  assert.deepEqual(noForce.detail, { reason: "deleting" });
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.some(function (n) { return n._id === ids.studyId; }), true, "带检查点的根不被旧 delete 吞掉");
  assert.equal(nodes.filter(function (n) { return n.deleting !== undefined; }).length, 1);
});

test("OLD-DELETE-FORCE-ANCESTOR:后代根带 pending 检查点时,祖先侧 delete(force) 整支硬删 = 吞检查点 ⇒ INVALID_INPUT({reason:deleting});终检只核对自己清单,清单内悬挂件与 active scan 的恢复凭据绝不允许随后代根文档一起消失", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var x = await createItem(t.deps, "op-dp-x", "字典", "书房的书柜");
  await linkItem(t.deps, x, ids.layerId, 1, "u-dp-x");
  var y = await createItem(t.deps, "op-dp-y", "台灯", "书房的书柜");
  await seedScan(t.db, "scan-dp", ids.layerId);
  // unmount(书柜):删 第一层 前注入「部署窗口期物品挂入」,nodes→compensate 推进处中断
  var trapDeps = Object.assign({}, t.deps, { db: faultDb(t.db, [
    { collection: "locations", op: "docRemove", at: 1, noThrow: true,
      action: function () {
        return t.db.collection("items").doc(y).update({
          data: { location_node_id: ids.layerId, version: 2 }
        });
      } },
    { collection: "locations", op: "whereUpdate", patchHas: "deleting", at: 2 } // #1=立点,#2=nodes→compensate
  ]) });
  var r1 = await unmount(trapDeps, ids.shelfId);
  assert.equal(r1.error, "UNMOUNT_INCOMPLETE", JSON.stringify(r1));
  var nodesMid = await rawDocs(t.db, "locations");
  var shelfDoc = nodesMid.find(function (n) { return n._id === ids.shelfId; });
  assert.ok(shelfDoc && shelfDoc.deleting && shelfDoc.deleting.phase === "nodes", "前置:书柜带 pending 检查点");
  assert.equal(nodesMid.some(function (n) { return n._id === ids.layerId; }), false, "前置:第一层已硬删");
  var yMid = (await rawDocs(t.db, "items")).find(function (d) { return d._id === y; });
  assert.equal(yMid.location_node_id, ids.layerId, "前置:Y 悬挂在已删 第一层 上(仅检查点清单知道它)");

  // 祖先侧 delete(force 书房):自身与祖先均无 deleting、子树也无物品——空判本会满足
  var r2 = await locHandler({ action: "delete", node_id: ids.studyId, force: true }, t.deps);
  assert.equal(r2.ok, false, JSON.stringify(r2));
  assert.equal(r2.error, "INVALID_INPUT");
  assert.deepEqual(r2.detail, { reason: "deleting" }, "两个删除域交叉:后代域清单必须整支保全");
  var nodesAfter = await rawDocs(t.db, "locations");
  assert.equal(nodesAfter.filter(function (n) { return n.deleting !== undefined; }).length, 1, "检查点不丢");
  assert.equal(nodesAfter.some(function (n) { return n._id === ids.studyId; }), true, "书房 不被吞");
  var yAfter = (await rawDocs(t.db, "items")).find(function (d) { return d._id === y; });
  assert.equal(yAfter.location_node_id, ids.layerId, "悬挂件证据保全(等续跑补偿)");
  assert.equal((await rawDocs(t.db, "location_scans"))[0].status, "active", "scan 不被祖先域顺手终结");

  // 收敛路径先续跑后代域,再删祖先:门随检查点消失而解除
  var resume = await unmount(t.deps, ids.shelfId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  assert.equal(resume.compensated, 1, "窗口期悬挂件 Y 由后代域补偿");
  var delAnc = await locHandler({ action: "delete", node_id: ids.studyId, force: true }, t.deps);
  assert.equal(delAnc.ok, true, JSON.stringify(delAnc));
  assert.equal(delAnc.deleted_nodes, 1, "收敛后书房 子树仅剩自身");
  void x;
});

test("NESTED-UNMOUNT-ANCESTOR:后代根带 pending 检查点时,祖先 unmount 同为删除域交叉 ⇒ INVALID_INPUT({reason:deleting}) 零写,不吞后代清单", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var x = await createItem(t.deps, "op-na-x", "字典", "书房的书柜");
  await linkItem(t.deps, x, ids.layerId, 1, "u-na-x");
  var y = await createItem(t.deps, "op-na-y", "台灯", "书房的书柜");
  await seedScan(t.db, "scan-na", ids.layerId);
  var trapDeps = Object.assign({}, t.deps, { db: faultDb(t.db, [
    { collection: "locations", op: "docRemove", at: 1, noThrow: true,
      action: function () {
        return t.db.collection("items").doc(y).update({
          data: { location_node_id: ids.layerId, version: 2 }
        });
      } },
    { collection: "locations", op: "whereUpdate", patchHas: "deleting", at: 2 }
  ]) });
  var r1 = await unmount(trapDeps, ids.shelfId);
  assert.equal(r1.error, "UNMOUNT_INCOMPLETE");
  var r2 = await unmount(t.deps, ids.studyId);
  assert.equal(r2.ok, false, JSON.stringify(r2));
  assert.equal(r2.error, "INVALID_INPUT");
  assert.deepEqual(r2.detail, { reason: "deleting" });
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.filter(function (n) { return n.deleting !== undefined; }).length, 1, "不立第二检查点");
  assert.equal(nodes.some(function (n) { return n._id === ids.studyId; }), true);
  var yDoc = (await rawDocs(t.db, "items")).find(function (d) { return d._id === y; });
  assert.equal(yDoc.location_node_id, ids.layerId, "悬挂件不动,等后代域续跑");
  // 后代域续跑收敛;收敛后祖先 unmount 放行
  var resume = await unmount(t.deps, ids.shelfId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  var anc = await unmount(t.deps, ids.studyId);
  assert.equal(anc.ok, true, JSON.stringify(anc));
  void x;
});

test("DESCENDANT-PENDING-MIGRATE-PURGE:pending 检查点在目标的后代上时,deleteLocation migrate/purge 同走冻结门 INVALID_INPUT({reason:deleting}),检查点保全;子树外 migrate 不误伤", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var drawer = await ensurePath(t.deps, ["书房", "书柜", "第一层", "抽屉"]);
  var drawerId = drawer.nodes[drawer.nodes.length - 1].location_id;
  var a = await createItem(t.deps, "op-mp-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, drawerId, 1, "u-mp-a");
  // 第一层 带 pending 检查点(立点后首删即断,phase=nodes)
  var trapDeps = Object.assign({}, t.deps, { db: faultDb(t.db, [
    { collection: "locations", op: "docRemove", at: 1 }
  ]) });
  var r1 = await unmount(trapDeps, ids.layerId);
  assert.equal(r1.error, "UNMOUNT_INCOMPLETE", JSON.stringify(r1));
  var layerDoc = (await rawDocs(t.db, "locations")).find(function (n) { return n._id === ids.layerId; });
  assert.ok(layerDoc && layerDoc.deleting, "前置:第一层 带 pending 检查点");
  var expectFrozen = async function (res, label) {
    assert.equal(res.ok, false, label);
    assert.equal(res.error, "INVALID_INPUT", label);
    assert.deepEqual(res.detail, { reason: "deleting" }, label);
  };
  await expectFrozen(
    await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "migrate" }, t.deps), "migrate 祖先");
  await expectFrozen(
    await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "purge" }, t.deps), "purge 祖先");
  await expectFrozen(
    await locHandler({ action: "deleteLocation", node_id: ids.studyId, mode: "purge" }, t.deps), "purge 隔代祖先");
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.length, 6, "零删除(根+书房+书柜+第一层+抽屉+厨房)");
  assert.equal(nodes.filter(function (n) { return n.deleting !== undefined; }).length, 1, "检查点保全");
  // 后代域收敛后,migrate/purge 恢复既有语义(REGRESS 交叉钩子)
  var resume = await unmount(t.deps, ids.layerId);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  var mig = await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "migrate" }, t.deps);
  assert.equal(mig.ok, true, JSON.stringify(mig));
  var docA = (await rawDocs(t.db, "items")).find(function (d) { return d._id === a; });
  assert.equal(docA.location_node_id, null, "unmount 已解挂,migrate 无件可迁");
});

test("PHASE-ADVANCE-INTERLEAVE:并发续跑者已把 phase 推进到 scans,陈旧续跑者(读到 nodes)的条件推进必须失配不写——phase 单调不回退,以库内最新态续,全程收敛", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-ia-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-ia-a");
  await seedScan(t.db, "scan-ia", ids.layerId);
  // 首跑:立点后首删即断 → phase=nodes、后代未删
  var r1 = await unmount(
    Object.assign({}, t.deps, { db: faultDb(t.db, [{ collection: "locations", op: "docRemove", at: 1 }]) }),
    ids.studyId
  );
  assert.equal(r1.error, "UNMOUNT_INCOMPLETE");
  assert.equal(r1.pending.phase, "nodes");

  // 续跑者 A 读到 phase=nodes;A 首删后代时,竞争者 B 已把检查点条件推进到 scans
  // (直接改库代表 B 的条件写先成功);记录 A 此后所有 deleting 写入的 phase,
  // 任何回退写(compensate/nodes)都违反「单调 nodes→compensate→scans→final」
  var writtenPhases = [];
  var innerDb = faultDb(t.db, [
    { collection: "locations", op: "docRemove", at: 1, noThrow: true,
      action: function () {
        // 竞争者 B:整份检查点推进到 scans(updated_at 一并前移,A 的陈旧 CAS 必失配)
        return t.db.collection("locations").doc(ids.studyId).get().then(function (got) {
          var cp = Object.assign({}, got.data.deleting, { phase: "scans" });
          return t.db.collection("locations").doc(ids.studyId).update({
            data: { deleting: cp, updated_at: "2099-01-01T00:00:00.000Z" }
          });
        });
      } }
  ]);
  var recordDb = {
    collection: function (name) {
      var col = innerDb.collection(name);
      if (name !== "locations") return col;
      return {
        where: function (cond) {
          var q = col.where(cond);
          return {
            get: function (o) { return q.get(o); },
            skip: function (n) { return q.skip(n); },
            limit: function (n) { return q.limit(n); },
            remove: function () { return q.remove(); },
            update: function (options) {
              var d = options && options.data;
              if (d && d.deleting !== undefined && d.deleting && d.deleting.phase) {
                writtenPhases.push(d.deleting.phase);
              }
              return q.update(options);
            }
          };
        },
        doc: col.doc.bind(col),
        add: function (o) { return col.add(o); }
      };
    }
  };
  var r2 = await unmount(Object.assign({}, t.deps, { db: recordDb }), ids.studyId);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(
    writtenPhases,
    ["final"],
    "A 的 nodes→compensate 推进必须失配不写(库内已是 scans);唯一的合法推进是 scans→final,实测写入序列:" + JSON.stringify(writtenPhases)
  );
  await assertConverged(t, ids, [a]);
});

test("CHECKPOINT-WRITE-THROWS:立点条件写抛错(wx-server-sdk 文档超上限表现为异常而非 0 命中)⇒ 失败关闭零删除、按 UNMOUNT_INCOMPLETE 返回,不裸抛 INTERNAL;重入重新立点收敛", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-cwt-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.layerId, 1, "u-cwt-a");
  var throwPointDb = {
    collection: function (name) {
      var col = t.db.collection(name);
      if (name !== "locations") return col;
      return {
        where: function (cond) {
          var q = col.where(cond);
          return {
            get: function (o) { return q.get(o); },
            skip: function (n) { return q.skip(n); },
            limit: function (n) { return q.limit(n); },
            remove: function () { return q.remove(); },
            update: function (options) {
              if (options && options.data && options.data.deleting !== undefined) {
                return Promise.reject(new Error("document size exceeds limit"));
              }
              return q.update(options);
            }
          };
        },
        doc: function (id) { return col.doc(id); },
        add: function (o) { return col.add(o); }
      };
    }
  };
  var res = await unmount(Object.assign({}, t.deps, { db: throwPointDb }), ids.studyId);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "UNMOUNT_INCOMPLETE", "置点抛错=失败关闭,绝不裸抛 INTERNAL");
  assert.ok(res.pending && res.pending.phase === "nodes", "如实附 pending 摘要");
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.length, 5, "零删除");
  assert.equal(nodes.filter(function (n) { return n.deleting !== undefined; }).length, 0, "未立点");
  var docA = (await rawDocs(t.db, "items")).find(function (d) { return d._id === a; });
  assert.equal(docA.location_node_id, null, "阶段一成果保留");
  // 重入:节点未动、清单重算一致,重新立点后完成
  var ok = await unmount(t.deps, ids.studyId);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  await assertConverged(t, ids, [a]);
});

/* ================= deleting 子树冻结门:逐入口反例(目标自身无标记、祖先在删) ================= */

test("FREEZE-GATE:linkItem/ensureAndLink/ensurePath/applyScan/rename/move/merge/deleteLocation(migrate·purge) 逐入口拒绝,零写入;子树外放行;unlinkItem 放行", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  await freezeMidOp(t, ids);
  var expectFrozen = async function (res, label) {
    assert.equal(res.ok, false, label);
    assert.equal(res.error, "INVALID_INPUT", label);
    assert.deepEqual(res.detail, { reason: "deleting" }, label);
  };

  // linkItem 挂到后代(第一层自身无 deleting 字段——P0-1 反例)
  var free1 = await createItem(t.deps, "op-fg-1", "钉子", "厨房");
  await expectFrozen(
    await locHandler({ action: "linkItem", item_id: free1, node_id: ids.layerId, expected_version: 1, update_id: "u-fg-1" }, t.deps),
    "linkItem→后代");
  // ensureAndLink:末段为后代 / 在子树下新建(挂载与建节点两动作都冻)
  await expectFrozen(
    await locHandler({ action: "ensureAndLink", item_id: free1, path: ["书房", "书柜", "第一层"], expected_version: 1, update_id: "u-fg-2" }, t.deps),
    "ensureAndLink→后代");
  await expectFrozen(
    await locHandler({ action: "ensureAndLink", item_id: free1, path: ["书房", "新柜子"], expected_version: 1, update_id: "u-fg-3" }, t.deps),
    "ensureAndLink 子树下建节点");
  // ensurePath 在子树下建节点
  await expectFrozen(await ensurePathRaw(t.deps, ["书房", "新箱子"]), "ensurePath 子树下建节点");
  // applyScan:branches 路径入子树 / mounts 路径入子树(整批零写)
  await expectFrozen(
    await locHandler({ action: "applyScan", operation_id: "op-fg-scan-1", branches: [{ path: ["书房", "第一层"] }] }, t.deps),
    "applyScan branch 入子树");
  await expectFrozen(
    await locHandler({ action: "applyScan", operation_id: "op-fg-scan-2", mounts: [{ item_id: free1, expected_version: 1, path: ["书房", "书柜"] }] }, t.deps),
    "applyScan mount 入子树");
  // rename / move(任一端) / merge(source 或 target)
  await expectFrozen(await locHandler({ action: "rename", node_id: ids.studyId, name: "新书房" }, t.deps), "rename deleting 根");
  await expectFrozen(await locHandler({ action: "rename", node_id: ids.layerId, name: "第二层" }, t.deps), "rename 后代");
  await expectFrozen(await locHandler({ action: "move", node_id: ids.layerId, new_parent_id: ids.kitchenId }, t.deps), "move 后代迁出");
  await expectFrozen(await locHandler({ action: "move", node_id: ids.kitchenId, new_parent_id: ids.studyId }, t.deps), "move 迁入 deleting 子树");
  await expectFrozen(
    await locHandler({ action: "merge", source_node_id: ids.layerId, target_node_id: ids.kitchenId }, t.deps), "merge source 在子树内");
  await expectFrozen(
    await locHandler({ action: "merge", source_node_id: ids.kitchenId, target_node_id: ids.layerId }, t.deps), "merge target 在子树内");
  // deleteLocation migrate/purge 作用于子树内节点(含根)
  await expectFrozen(
    await locHandler({ action: "deleteLocation", node_id: ids.layerId, mode: "migrate" }, t.deps), "migrate 后代");
  await expectFrozen(
    await locHandler({ action: "deleteLocation", node_id: ids.studyId, mode: "purge" }, t.deps), "purge deleting 根");

  // 零写入核查:树结构不变、free1 未被挂载、无新节点
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.length, 5, "节点零增删");
  assert.equal(nodes.filter(function (n) { return n.deleting !== undefined; }).length, 1);
  var docFree = (await rawDocs(t.db, "items")).find(function (d) { return d._id === free1; });
  assert.ok(
    docFree.location_node_id === null || docFree.location_node_id === undefined || docFree.location_node_id === "",
    "free1 未被挂进冻结子树"
  );

  // 子树外照常放行(不得误伤)
  var okLink = await locHandler({ action: "linkItem", item_id: free1, node_id: ids.kitchenId, expected_version: 1, update_id: "u-fg-ok" }, t.deps);
  assert.equal(okLink.ok, true, JSON.stringify(okLink));

  // unlinkItem 放行:冻结子树内的挂载(绕门注入)可摘除,方向与收敛一致
  await t.db.collection("items").doc(free1).update({
    data: { location_node_id: ids.layerId, version: 3, last_update_id: "raw-mount" }
  });
  var unlink = await locHandler({ action: "unlinkItem", item_id: free1, expected_version: 3, update_id: "u-fg-unlink" }, t.deps);
  assert.equal(unlink.ok, true, JSON.stringify(unlink));
});

async function ensurePathRaw(deps, segments) {
  return locHandler({ action: "ensurePath", path: segments, created_from: "manual" }, deps);
}

/* ================= 预览 / 投影 / 检查点损坏 ================= */

test("PREVIEW-PENDING:deleting 根的 deletePreview 附 pending_unmount 摘要(响应属用户数据,不进日志)", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var mid = await freezeMidOp(t, ids);
  var preview = await locHandler({ action: "deletePreview", node_id: ids.studyId }, t.deps);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.deleting, true);
  assert.equal(preview.pending_unmount.op_id, "unmount:" + digest16(ids.studyId));
  assert.equal(preview.pending_unmount.phase, "nodes");
  assert.equal(preview.pending_unmount.status, "pending");
  assert.equal(preview.pending_unmount.counts.unmounted, 1);
  assert.ok(preview.pending_unmount.created_at);
  // 非 deleting 节点预览:不携带新字段
  var kitchen = await locHandler({ action: "deletePreview", node_id: ids.kitchenId }, t.deps);
  assert.equal(kitchen.ok, true);
  assert.equal(kitchen.deleting, undefined);
  assert.equal(kitchen.pending_unmount, undefined);
  void mid;
});

test("LIST-DELETING-PROJECTION:list children 仅 deleting 节点携带 deleting:true;unmount 后物品进根层未归类投影", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var mid = await freezeMidOp(t, ids);
  var res = await locHandler({ action: "list" }, t.deps);
  assert.equal(res.ok, true);
  var byId = {};
  for (var i = 0; i < res.children.length; i++) byId[res.children[i].location_id] = res.children[i];
  assert.equal(byId[ids.studyId].deleting, true, "deleting 子节点置灰布尔");
  assert.equal(byId[ids.kitchenId].deleting, undefined, "非 deleting 节点不携带新字段(白名单投影)");
  // 阶段一解挂的物品进入根层「尚未归类」投影(unmount 去向可见)
  var rootList = await locHandler({ action: "list" }, t.deps);
  assert.ok(Array.isArray(rootList.unmounted_items));
  var unmountedIds = rootList.unmounted_items.map(function (r) { return r.item_id; });
  assert.ok(unmountedIds.indexOf(mid.itemA) !== -1, "已解挂物品出现在「尚未归类」投影");
  void res;
});

test("UNMOUNTED-CAP:根层投影上限 50、unmounted_count 为全量 M(客户端「仅显示最近 50 件,共 M 件」文案的数据源)", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  for (var i = 0; i < 55; i++) {
    await createItem(t.deps, "op-cap-" + i, "物件" + i, "书房");
  }
  var a = await createItem(t.deps, "op-cap-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.shelfId, 1, "u-cap-a");
  var res = await unmount(t.deps, ids.shelfId);
  assert.equal(res.ok, true, JSON.stringify(res));
  var rootList = await locHandler({ action: "list" }, t.deps);
  assert.equal(rootList.unmounted_count, 56, "M=全量未挂载数");
  assert.equal(rootList.unmounted_items.length, 50, "投影恒截断到 50");
});

test("CHECKPOINT-CORRUPT:清单空/phase 非法/op_id 不符 → UNMOUNT_CHECKPOINT_CORRUPT,零删除零标记零续跑", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  await seedScan(t.db, "scan-corrupt", ids.layerId);
  var cases = [
    { subtree_node_ids: [] },
    { phase: "halfway" },
    { op_id: "unmount:" + digest16("别的节点") }
  ];
  for (var c = 0; c < cases.length; c++) {
    var t2 = fresh();
    var ids2 = await setupTree(t2);
    await seedScan(t2.db, "scan-corrupt-" + c, ids2.layerId);
    var cp = {
      op_id: "unmount:" + digest16(ids2.studyId), node_id: ids2.studyId,
      subtree_node_ids: [ids2.studyId, ids2.shelfId, ids2.layerId],
      phase: "nodes", counts: { unmounted: 0, compensated: 0, conflicts: 0 },
      created_at: "2026-10-21T00:00:00.000Z", status: "pending"
    };
    Object.assign(cp, cases[c]);
    await t2.db.collection("locations").doc(ids2.studyId).update({ data: { deleting: cp } });
    var res = await unmount(t2.deps, ids2.studyId);
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, "UNMOUNT_CHECKPOINT_CORRUPT", "case " + c);
    var nodes = await rawDocs(t2.db, "locations");
    assert.equal(nodes.length, 5, "case " + c + ":零删除");
    assert.equal((await rawDocs(t2.db, "location_scans"))[0].status, "active", "case " + c + ":scan 不动");
  }
  void t; void ids;
});

test("CHECKPOINT-CORRUPT-PREVIEW:损坏检查点的 deletePreview 只报 deleting:true、不编 pending_unmount 摘要", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  await t.db.collection("locations").doc(ids.studyId).update({
    data: { deleting: { garbage: true } }
  });
  var preview = await locHandler({ action: "deletePreview", node_id: ids.studyId }, t.deps);
  assert.equal(preview.ok, true);
  assert.equal(preview.deleting, true);
  assert.equal(preview.pending_unmount, undefined, "不猜测续跑:损坏态不给摘要");
  var resume = await unmount(t.deps, ids.studyId);
  assert.equal(resume.ok, false);
  assert.equal(resume.error, "UNMOUNT_CHECKPOINT_CORRUPT");
});

/* ================= 既有语义回归钩子 ================= */

test("REGRESS-EXISTING:migrate/purge 在无 deleting 节点上行为不变(冻结门不误伤既有三按钮)", async () => {
  var t = fresh();
  var ids = await setupTree(t);
  var a = await createItem(t.deps, "op-rg-a", "字典", "书房的书柜");
  await linkItem(t.deps, a, ids.shelfId, 1, "u-rg-a");
  var mig = await locHandler({ action: "deleteLocation", node_id: ids.shelfId, mode: "migrate" }, t.deps);
  assert.equal(mig.ok, true, JSON.stringify(mig));
  var doc = (await rawDocs(t.db, "items")).find(function (d) { return d._id === a; });
  assert.equal(doc.location_node_id, ids.studyId, "migrate 语义不变");
});
