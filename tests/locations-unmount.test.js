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
