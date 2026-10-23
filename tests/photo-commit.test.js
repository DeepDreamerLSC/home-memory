"use strict";

/*
 * 拍照识物(#3)itemsApi.photoCommit / photoEvidenceGet 离线合同测试
 * (IMPLEMENTATION §1.3/§1.4/§2,仿 tests/remind-notify.test.js / itemsApi.test.js 模式)。
 * 只 require cloudfunctions/itemsApi 下的 lib 与入口(stub wx-server-sdk),零外部依赖、
 * 零外网;数据层用 tests/helpers/memoryDb 并配置 photo_evidence 唯一索引
 * (household_id, item_id, file_id)——与线上控制台索引同构。
 * 覆盖:
 * - PC-COMMIT:逐件建档(items 走既有 createItem 路径:operation_id 幂等/提醒
 *   slot 全套)+ photo_evidence 证据行(_id 前缀 pe_/0-1 box/原图宽高/
 *   captured_location_text=本件提交位置/来源 vl|circle);不带 photo 的件
 *   evidence_saved:false 不落证据行;不引入 items.quantity/photo_evidence 数量字段;
 * - PC-IDEM:原键原内容重放 → duplicated:true、items 不增、证据行不重
 *   (evidence_saved:false);
 * - PC-PARTIAL:同键异内容 OPERATION_CONFLICT 只进该件失败项,不拦其余件
 *   (部分成功语义,已成功件不动);
 * - PC-VALIDATE:任一件纯参数非法(含 photo.box 越界/source 非法/reminder 非法/
 *   note 超长/batch_id 形状/items 0 或 11 件)→ 整批 INVALID_INPUT 零写入;
 * - PC-RACE:证据行 add 撞唯一索引(E11000)→ 回查见孪生收敛 evidence_saved:true;
 * - PC-GATE:共享家庭双 marker 硬门——缺 marker FAMILY_SWITCHED 零写入,
 *   带齐 marker 放行;
 * - PE-SCOPE:photoEvidenceGet 作用域隔离(跨家庭互不可见)+ household_id 回显 +
 *   共享家庭 scope_revision;每件 created_at 降序前 3;file_id 去重换链;
 *   单文件换链失败 photo_url:"";getTempFileUrls 抛错/未注入全部降级空链接
 *   绝不废查询;item_ids 形状非法 INVALID_INPUT;
 * - PC-LOG:日志只记 action/error/ms/count(成功件数),绝不落物品名/位置/
 *   batch 明细;
 * - PC-GLUE:index.js 胶水真实加载(stub wx-server-sdk)——photoCommit 与
 *   photoEvidenceGet 全链,getTempFileUrls 注入(cloud.getTempFileURL stub);
 *   config.json timeout 20。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var crypto = require("node:crypto");
var Module = require("node:module");

var handler = require("../cloudfunctions/itemsApi/lib/handler").handler;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

var ROOT = path.join(__dirname, "..");

var HOUSEHOLD_A = "hh_11111111111111111111111111111111";
var HOUSEHOLD_B = "hh_22222222222222222222222222222222";
var T0 = "2026-10-17T08:00:00.000Z";

function makeDeps(db, householdId, opts) {
  opts = opts || {};
  var seq = 0;
  var clock = 1760000000000;
  return {
    db: db,
    householdId: householdId,
    householdShared: opts.shared === true,
    scopeRevision: opts.shared === true ? (opts.scopeRevision || 1) : null,
    now: function () {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    genId: function () {
      seq += 1;
      return "n" + seq;
    },
    getTempFileUrls: opts.getTempFileUrls,
    logger: opts.logger || { log: function () {} }
  };
}

function freshDb() {
  return createMemoryDb({
    uniqueIndexes: {
      photo_evidence: [["household_id", "item_id", "file_id"]]
    }
  });
}

/** 构造 photo 绑定:file_id 默认按上传路径约定(PR #67 B2)取 HOUSEHOLD_A 前缀
 *  cloud://bucket/photo-evidence/<HOUSEHOLD_A>/<name>.jpg;他家前缀/来路不明的
 *  形态用 extra.file_id 显式给。 */
function photo(name, extra) {
  extra = extra || {};
  return {
    file_id:
      extra.file_id !== undefined
        ? extra.file_id
        : "cloud://bucket/photo-evidence/" + HOUSEHOLD_A + "/" + name + ".jpg",
    img_w: extra.img_w || 1024,
    img_h: extra.img_h || 768,
    box: extra.box !== undefined ? extra.box : { x1: 0.27, y1: 0.39, x2: 0.59, y2: 0.51 },
    source: extra.source || "vl"
  };
}

function commitEvent(items, extra) {
  return Object.assign({ action: "photoCommit", batch_id: "batch-00000001", items: items }, extra || {});
}

function item(opId, name, locationText, extra) {
  extra = extra || {};
  var it = {
    operation_id: opId,
    name: name,
    location_text: locationText
  };
  if (extra.note !== undefined) it.note = extra.note;
  if (extra.reminder !== undefined) it.reminder = extra.reminder;
  if (extra.photo !== undefined) it.photo = extra.photo;
  return it;
}

async function rawDocs(db, name) {
  var res = await db.collection(name).where({}).get();
  return res.data || [];
}

// ---------- PC-COMMIT:逐件建档 + 证据行 ----------

test("PC-COMMIT-1:逐件建档走既有 createItem 路径,证据行形状与位置文本按本件提交值落库", async function () {
  var db = freshDb();
  var deps = makeDeps(db, HOUSEHOLD_A);
  var res = await handler(
    commitEvent([
      item("op-a", "品客薯片罐", "厨房", { note: "×1 (空罐)", photo: photo("f1") }),
      item("op-b", "五号电池", "玄关柜 · 第二层抽屉", {
        photo: photo("f2", { box: null, source: "circle" })
      }),
      item("op-c", "黑色耳机", "玄关柜 · 第二层抽屉") // 不带照片:合法,无证据行
    ]),
    deps
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results.length, 3);
  assert.deepEqual(res.results[0], {
    index: 0,
    ok: true,
    item_id: res.results[0].item_id,
    duplicated: false,
    evidence_saved: true,
    version: 1
  });
  assert.equal(res.results[1].version, 1, "#65 ③:成功件回带建档后版本(挂树 expected_version 来源)");
  assert.equal(res.results[2].version, 1);
  assert.equal(res.results[1].evidence_saved, true);
  assert.equal(res.results[2].evidence_saved, false, "不带 photo 的件不落证据行");

  var items = await rawDocs(db, "items");
  assert.equal(items.length, 3);
  assert.equal(items[0].name, "品客薯片罐");
  assert.equal(items[0].note, "×1 (空罐)");
  assert.equal(items[0].operation_id, "op-a");
  assert.equal(items[0].household_id, HOUSEHOLD_A);
  // issue #102 Q1(Q0-CONTRACT §4.3)取代 #65「数量只是 note 文本」旧约束:
  // 旧载荷(不带 quantity)走服务端缺省 1/件;note 原样保留、绝不被解析成数量
  assert.equal(items[0].quantity, 1, "未携带数量 → 服务端缺省 1(§5 唯一落点)");
  assert.equal(items[0].unit, "件");
  assert.equal(items[0].note, "×1 (空罐)", "旧 note 一字不改,不升格为数量事实");

  var evidence = await rawDocs(db, "photo_evidence");
  assert.equal(evidence.length, 2, "只有两件带了照片");
  assert.ok(evidence[0]._id.indexOf("pe_") === 0, "_id 应为 pe_ 前缀");
  assert.equal(evidence[0].item_id, res.results[0].item_id);
  assert.equal(evidence[0].file_id, "cloud://bucket/photo-evidence/" + HOUSEHOLD_A + "/f1.jpg");
  assert.deepEqual(evidence[0].box, { x1: 0.27, y1: 0.39, x2: 0.59, y2: 0.51 }, "box 以 0-1 形态存储");
  assert.equal(evidence[0].img_w, 1024);
  assert.equal(evidence[0].img_h, 768);
  assert.equal(evidence[0].source, "vl");
  assert.equal(evidence[0].captured_location_text, "厨房", "captured_location_text 取本件刚提交的位置");
  assert.equal(evidence[0].household_id, HOUSEHOLD_A);
  assert.equal(evidence[1].box, null, "圈选行无框为 null");
  assert.equal(evidence[1].source, "circle");
  assert.equal(evidence[1].captured_location_text, "玄关柜 · 第二层抽屉");
  assert.ok(!("quantity" in evidence[0]), "photo_evidence 无数量字段");
});

test("PC-COMMIT-2:带 reminder 的件复用 createItem 提醒链(reminders 落 active 行)", async function () {
  var db = freshDb();
  var deps = makeDeps(db, HOUSEHOLD_A);
  var res = await handler(
    commitEvent([
      item("op-r", "维生素", "药箱", {
        reminder: { due_date: "2026-11-20", kind: "有效期", quote: "11月20号过期", remind_converted: false }
      })
    ]),
    deps
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results[0].ok, true);
  var reminders = await rawDocs(db, "reminders");
  var active = reminders.filter(function (r) { return r.status === "active"; });
  assert.equal(active.length, 1, "提醒行随 createItem 全套落地");
  assert.equal(active[0].item_id, res.results[0].item_id);
  assert.equal(active[0].due_date, "2026-11-20");
});

// ---------- PC-IDEM:幂等重放 ----------

test("PC-IDEM:原键原内容重放 → duplicated:true、items 不增、证据行不重(evidence_saved:false)", async function () {
  var db = freshDb();
  var deps = makeDeps(db, HOUSEHOLD_A);
  var ev = commitEvent([item("op-dup", "白色数据线", "电视柜", { photo: photo("f-dup") })]);
  var first = await handler(ev, deps);
  assert.equal(first.ok, true);
  assert.equal(first.results[0].duplicated, false);
  assert.equal(first.results[0].evidence_saved, true);

  var second = await handler(ev, deps);
  assert.equal(second.ok, true);
  assert.equal(second.results[0].duplicated, true, "同键同内容 → duplicated");
  assert.equal(second.results[0].item_id, first.results[0].item_id, "稳定返回同一 item_id");
  assert.equal(second.results[0].evidence_saved, false, "证据行已存在 → 跳过(幂等)");
  assert.equal(second.results[0].version, first.results[0].version, "#65 ③:重放回带既有文档当前版本,重试挂树据此幂等收敛");

  assert.equal((await rawDocs(db, "items")).length, 1);
  assert.equal((await rawDocs(db, "photo_evidence")).length, 1);
});

// ---------- PC-PARTIAL:部分成功语义 ----------

test("PC-PARTIAL:同键异内容 OPERATION_CONFLICT 只进该件失败项,不拦其余件", async function () {
  var db = freshDb();
  var deps = makeDeps(db, HOUSEHOLD_A);
  var first = await handler(
    commitEvent([item("op-x", "黑色小盒子", "抽屉", { photo: photo("f-x") })]),
    deps
  );
  assert.equal(first.ok, true);

  // 第二批:op-x 换内容(同键异内容 → OPERATION_CONFLICT)+ 一件全新 op-y
  var second = await handler(
    commitEvent([
      item("op-x", "黑色大盒子", "抽屉", { photo: photo("f-x2") }),
      item("op-y", "指甲刀", "抽屉", { photo: photo("f-y") })
    ]),
    deps
  );
  assert.equal(second.ok, true);
  assert.equal(second.results.length, 2);
  assert.equal(second.results[0].ok, false, "冲突件进失败项");
  assert.equal(second.results[0].index, 0);
  assert.equal(second.results[0].error, "OPERATION_CONFLICT");
  assert.ok(typeof second.results[0].message === "string" && second.results[0].message !== "");
  assert.equal(second.results[1].ok, true, "冲突不拦其余件");
  assert.equal(second.results[1].duplicated, false);

  var items = await rawDocs(db, "items");
  assert.equal(items.length, 2, "op-x 原件不动,op-y 新建,op-x 新内容零写入");
  var evidence = await rawDocs(db, "photo_evidence");
  assert.equal(evidence.length, 2, "冲突件不落新证据行,只有首op-x 与 op-y 的");
});

// ---------- PC-VALIDATE:整批参数校验零写入 ----------

test("PC-VALIDATE:任一件纯参数非法 → 整批 INVALID_INPUT 且零写入", async function () {
  var cases = [
    { label: "batch_id 过短", event: commitEvent([item("op-1", "甲", "客厅")], { batch_id: "short" }) },
    { label: "batch_id 缺失", event: { action: "photoCommit", items: [item("op-1", "甲", "客厅")] } },
    { label: "items 空数组", event: commitEvent([]) },
    {
      label: "items 超 10 件",
      event: commitEvent(Array.from({ length: 11 }, (_, i) => item("op-" + i, "物" + i, "客厅")))
    },
    { label: "件缺 operation_id", event: commitEvent([{ name: "甲", location_text: "客厅" }]) },
    { label: "件 name 空白", event: commitEvent([item("op-1", "  ", "客厅")]) },
    { label: "件 location_text 缺失", event: commitEvent([{ operation_id: "op-1", name: "甲" }]) },
    { label: "件 note 超 200 码点", event: commitEvent([item("op-1", "甲", "客厅", { note: "长".repeat(201) })]) },
    {
      label: "reminder 日期非法",
      event: commitEvent([item("op-1", "甲", "客厅", { reminder: { due_date: "2026-02-30", kind: "有效期" } })])
    },
    {
      label: "photo.box 越界(>1)",
      event: commitEvent([item("op-1", "甲", "客厅", { photo: photo("f", { box: { x1: 0, y1: 0, x2: 1.5, y2: 1 } }) })])
    },
    {
      label: "photo.box 退化(x2<x1)",
      event: commitEvent([item("op-1", "甲", "客厅", { photo: photo("f", { box: { x1: 0.9, y1: 0.1, x2: 0.1, y2: 0.9 } }) })])
    },
    {
      label: "photo.source 非法",
      event: commitEvent([item("op-1", "甲", "客厅", { photo: photo("f", { source: "guess" }) })])
    },
    {
      label: "photo.file_id 空",
      event: commitEvent([item("op-1", "甲", "客厅", { photo: photo("f", { file_id: "" }) })])
    },
    {
      label: "photo.img_w 非整数",
      event: commitEvent([item("op-1", "甲", "客厅", { photo: photo("f", { img_w: 1024.5 }) })])
    },
    {
      label: "第二件非法(第一件合法)同样整批拒绝",
      event: commitEvent([item("op-1", "甲", "客厅"), item("op-2", "", "客厅")])
    }
  ];
  for (var c = 0; c < cases.length; c++) {
    var db = freshDb();
    var deps = makeDeps(db, HOUSEHOLD_A);
    var res = await handler(cases[c].event, deps);
    assert.equal(res.ok, false, cases[c].label);
    assert.equal(res.error, "INVALID_INPUT", cases[c].label);
    assert.equal((await rawDocs(db, "items")).length, 0, cases[c].label + ":items 零写入");
    assert.equal((await rawDocs(db, "photo_evidence")).length, 0, cases[c].label + ":证据零写入");
    assert.equal((await rawDocs(db, "reminders")).length, 0, cases[c].label + ":提醒零写入");
  }
});

// ---------- PC-RACE:证据行唯一索引冲突回查收敛 ----------

/* 模拟并发孪生:photo_evidence 的第一次等值预查回空(孪生行尚未可见),
 * add 永远抛 E11000 同款错误,之后的查询走真实数据。 */
function makeTwinRaceDb(db) {
  var realCollection = db.collection.bind(db);
  var photoGets = 0;
  return {
    collection: function (name) {
      var coll = realCollection(name);
      if (name !== "photo_evidence") {
        return coll;
      }
      return {
        add: function () {
          return Promise.reject(
            new Error(
              "collection.add:fail -502001 database request fail. [FailedOperation.Insert] " +
                "bulk write error: E11000 duplicate key error collection: photo_evidence " +
                "index: uniq_household_id_item_id_file_id"
            )
          );
        },
        where: function (cond) {
          var q = coll.where(cond);
          return {
            get: function () {
              photoGets += 1;
              if (photoGets === 1) {
                return Promise.resolve({ data: [] }); // 预查窗口:孪生行不可见
              }
              return q.get(); // 回查:真实数据可见
            }
          };
        },
        doc: coll.doc
      };
    }
  };
}

test("PC-RACE:证据行 add 撞唯一索引 → 回查见孪生收敛 evidence_saved:true(并发不重)", async function () {
  var db = freshDb();
  // 预置:同键物品已建档(duplicated 路径)+ 孪生证据行已在(并发请求落库)
  await db.collection("items").add({
    data: {
      _id: "it_seed",
      household_id: HOUSEHOLD_A,
      name: "黄色薯片罐",
      name_norm: "黄色薯片罐",
      location_text: "玄关柜",
      note: "",
      version: 1,
      deleted: false,
      operation_id: "op-race",
      remind_vague_quote: "",
      created_at: T0,
      updated_at: T0
    }
  });
  await db.collection("photo_evidence").add({
    data: {
      _id: "pe_twin",
      household_id: HOUSEHOLD_A,
      item_id: "it_seed",
      file_id: "cloud://bucket/photo-evidence/" + HOUSEHOLD_A + "/f-race.jpg",
      box: null,
      img_w: 100,
      img_h: 100,
      source: "vl",
      captured_location_text: "玄关柜",
      created_at: T0
    }
  });
  var raceDb = makeTwinRaceDb(db);
  var deps = makeDeps(raceDb, HOUSEHOLD_A);
  var res = await handler(
    commitEvent([item("op-race", "黄色薯片罐", "玄关柜", { photo: photo("f-race") })]),
    deps
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[0].item_id, "it_seed", "同键同内容命中既有文档");
  assert.equal(res.results[0].duplicated, true);
  assert.equal(res.results[0].evidence_saved, true, "E11000 回查见孪生 → 当已保存(收敛)");
  assert.equal((await rawDocs(db, "photo_evidence")).length, 1, "证据行仍只有一条");
});

// ---------- PC-GATE:共享家庭双 marker 硬门 ----------

test("PC-GATE:共享家庭缺双 marker → FAMILY_SWITCHED 零写入;带齐 marker 放行", async function () {
  var db = freshDb();
  var deps = makeDeps(db, HOUSEHOLD_A, { shared: true, scopeRevision: 3 });
  var blocked = await handler(
    commitEvent([item("op-g", "护照", "书房抽屉", { photo: photo("f-g") })]),
    deps
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "FAMILY_SWITCHED");
  assert.equal((await rawDocs(db, "items")).length, 0, "硬门拦下:零写入");
  assert.equal((await rawDocs(db, "photo_evidence")).length, 0);

  var deps2 = makeDeps(db, HOUSEHOLD_A, { shared: true, scopeRevision: 3 });
  var stale = await handler(
    commitEvent([item("op-g", "护照", "书房抽屉")], {
      expected_household_id: HOUSEHOLD_A,
      expected_scope_revision: 2
    }),
    deps2
  );
  assert.equal(stale.error, "FAMILY_STALE_SCOPE", "旧修订号同样拦下");

  var deps3 = makeDeps(db, HOUSEHOLD_A, { shared: true, scopeRevision: 3 });
  var ok = await handler(
    commitEvent([item("op-g", "护照", "书房抽屉", { photo: photo("f-g") })], {
      expected_household_id: HOUSEHOLD_A,
      expected_scope_revision: 3
    }),
    deps3
  );
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.results[0].ok, true);
  assert.equal((await rawDocs(db, "items")).length, 1);
});

// ---------- PE-*:photoEvidenceGet ----------

async function seedEvidence(db, householdId, itemId, fileId, createdAt, extra) {
  extra = extra || {};
  // PR #67 B2:读取入口校验物品有效性——默认同步播种一个作用域内存活 item;
  // extra.itemState:"deleted" 播已删 item、"missing" 不播 item(测试过滤语义用)
  if (extra.itemState !== "missing") {
    await db.collection("items").add({
      data: {
        _id: itemId,
        household_id: householdId,
        name: "物品" + itemId,
        deleted: extra.itemState === "deleted",
        created_at: createdAt
      }
    });
  }
  await db.collection("photo_evidence").add({
    data: {
      _id: extra.id || "pe_" + itemId + "_" + fileId + "_" + createdAt,
      household_id: householdId,
      item_id: itemId,
      file_id: fileId,
      box: extra.box !== undefined ? extra.box : { x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.6 },
      img_w: 1024,
      img_h: 768,
      source: extra.source || "vl",
      captured_location_text: extra.location || "客厅电视柜 · 第一层",
      created_at: createdAt
    }
  });
}

test("PE-SCOPE:作用域隔离——只返回当前家庭的证据,household_id 回显,共享家庭带 scope_revision", async function () {
  var db = freshDb();
  await seedEvidence(db, HOUSEHOLD_A, "it_a1", "cloud://fa");
  await seedEvidence(db, HOUSEHOLD_B, "it_b1", "cloud://fb");

  var depsA = makeDeps(db, HOUSEHOLD_A, { getTempFileUrls: async function (ids) {
    return { fileList: ids.map(function (f) { return { fileID: f, tempFileURL: "https://tmp/" + f }; }) };
  } });
  var resA = await handler({ action: "photoEvidenceGet", item_ids: ["it_a1", "it_b1"] }, depsA);
  assert.equal(resA.ok, true);
  assert.equal(resA.household_id, HOUSEHOLD_A, "作用域回显");
  assert.equal(resA.evidence.length, 1, "B 家庭的证据不可见");
  assert.equal(resA.evidence[0].item_id, "it_a1");
  assert.equal(resA.evidence[0].file_id, "cloud://fa");
  assert.equal(resA.evidence[0].photo_url, "https://tmp/cloud://fa", "临时链接回填");
  assert.equal(resA.scope_revision, undefined, "个人家庭不带 scope_revision");

  var depsShared = makeDeps(db, HOUSEHOLD_A, {
    shared: true,
    scopeRevision: 7,
    getTempFileUrls: async function () {
      return { fileList: [] };
    }
  });
  var resS = await handler({ action: "photoEvidenceGet", item_ids: ["it_a1"] }, depsShared);
  assert.equal(resS.scope_revision, 7, "共享家庭附带 scope_revision");
});

test("PE-ORDER:每件 created_at 降序前 3;file_id 去重后换链", async function () {
  var db = freshDb();
  for (var i = 1; i <= 4; i++) {
    await seedEvidence(db, HOUSEHOLD_A, "it_many", "cloud://fm" + i, "2026-10-0" + i + "T00:00:00.000Z");
  }
  await seedEvidence(db, HOUSEHOLD_A, "it_share", "cloud://fm1", "2026-10-05T00:00:00.000Z"); // 同照片另一件
  var requested = null;
  var deps = makeDeps(db, HOUSEHOLD_A, {
    getTempFileUrls: async function (ids) {
      requested = ids;
      return { fileList: ids.map(function (f) { return { fileID: f, tempFileURL: "https://t/" + f }; }) };
    }
  });
  var res = await handler({ action: "photoEvidenceGet", item_ids: ["it_many", "it_share"] }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.evidence.length, 4, "it_many 取前 3 + it_share 1 条");
  var times = res.evidence.slice(0, 3).map(function (e) { return e.created_at; });
  assert.deepEqual(times, [
    "2026-10-04T00:00:00.000Z",
    "2026-10-03T00:00:00.000Z",
    "2026-10-02T00:00:00.000Z"
  ], "同件内按 created_at 降序,最旧的 10-01 被截掉");
  assert.deepEqual(requested, ["cloud://fm4", "cloud://fm3", "cloud://fm2", "cloud://fm1"], "file_id 去重后换链(fm1 只换一次)");
});

test("PE-URL-FAIL:单文件换链失败该行 photo_url 空;整体抛错/未注入同样降级,绝不废查询", async function () {
  var db = freshDb();
  await seedEvidence(db, HOUSEHOLD_A, "it_u1", "cloud://fu1");
  await seedEvidence(db, HOUSEHOLD_A, "it_u2", "cloud://fu2");

  var deps = makeDeps(db, HOUSEHOLD_A, {
    getTempFileUrls: async function (ids) {
      return {
        fileList: ids.map(function (f) {
          return f === "cloud://fu1"
            ? { fileID: f, tempFileURL: "", status: -1 } // 单文件换链失败
            : { fileID: f, tempFileURL: "https://ok/" + f };
        })
      };
    }
  });
  var res = await handler({ action: "photoEvidenceGet", item_ids: ["it_u1", "it_u2"] }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.evidence[0].photo_url, "", "换链失败行为空串,file_id 照返可重试");
  assert.equal(res.evidence[0].file_id, "cloud://fu1");
  assert.equal(res.evidence[1].photo_url, "https://ok/cloud://fu2");

  var throwDeps = makeDeps(db, HOUSEHOLD_A, {
    getTempFileUrls: async function () {
      throw new Error("GET_TEMP_URL_FAILED");
    }
  });
  var res2 = await handler({ action: "photoEvidenceGet", item_ids: ["it_u1"] }, throwDeps);
  assert.equal(res2.ok, true, "换链整体异常绝不废查询");
  assert.equal(res2.evidence[0].photo_url, "");

  var noLinkDeps = makeDeps(db, HOUSEHOLD_A); // 未注入 getTempFileUrls
  var res3 = await handler({ action: "photoEvidenceGet", item_ids: ["it_u1"] }, noLinkDeps);
  assert.equal(res3.ok, true);
  assert.equal(res3.evidence[0].photo_url, "");
});

test("PE-VALIDATE:item_ids 形状非法一律 INVALID_INPUT", async function () {
  var db = freshDb();
  var deps = makeDeps(db, HOUSEHOLD_A);
  var cases = [
    { action: "photoEvidenceGet" },
    { action: "photoEvidenceGet", item_ids: [] },
    { action: "photoEvidenceGet", item_ids: Array.from({ length: 11 }, (_, i) => "it_" + i) },
    { action: "photoEvidenceGet", item_ids: [""] },
    { action: "photoEvidenceGet", item_ids: [123] }
  ];
  for (var c of cases) {
    var res = await handler(c, deps);
    assert.equal(res.ok, false, JSON.stringify(c));
    assert.equal(res.error, "INVALID_INPUT");
  }
});

// ---------- PC-LOG:日志纪律 ----------

test("PC-LOG:日志只记 action/error/ms/count(成功件数),绝不落物品名/位置/batch 明细", async function () {
  var logs = [];
  var deps = makeDeps(freshDb(), HOUSEHOLD_A, {
    logger: { log: function (e) { logs.push(e); } }
  });
  await handler(
    commitEvent([
      item("op-l1", "牙刷", "洗手台", { photo: photo("fl1") }),
      item("op-l2", "毛巾", "洗手台")
    ]),
    deps
  );
  await handler(commitEvent([item("op-l3", "", "客厅")]), deps); // 整批非法
  var serialized = JSON.stringify(logs);
  assert.ok(serialized.indexOf("牙刷") === -1, "日志不得包含物品名");
  assert.ok(serialized.indexOf("洗手台") === -1, "日志不得包含位置");
  assert.ok(serialized.indexOf("batch-00000001") === -1, "日志不得包含 batch 明细");
  assert.ok(serialized.indexOf("cloud://fl1") === -1, "日志不得包含 file_id");
  for (var entry of logs) {
    for (var key of Object.keys(entry)) {
      assert.ok(["action", "error", "ms", "count"].includes(key), "日志出现越界字段:" + key);
    }
  }
  assert.equal(logs[0].count, 2, "count=成功件数");
  assert.equal(logs[0].error, null);
  assert.equal(logs[1].count, 0);
  assert.equal(logs[1].error, "INVALID_INPUT");
});

// ---------- PC-GLUE:index.js 胶水真实加载(stub wx-server-sdk) ----------

/** 临时把 wx-server-sdk 替换为 stub 并(重新)加载云函数入口(tests/remind-notify.test.js 手法) */
function loadCloudFunction(entryPath, stubSdk) {
  var origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "wx-server-sdk") {
      return stubSdk;
    }
    return origLoad.apply(this, arguments);
  };
  for (var key of Object.keys(require.cache)) {
    if (key.indexOf(path.join(ROOT, "cloudfunctions")) === 0) {
      delete require.cache[key];
    }
  }
  try {
    return require(entryPath);
  } finally {
    Module._load = origLoad;
  }
}

function sha256hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function makeItemsApiStub(openid, db, tempUrls) {
  return {
    DYNAMIC_CURRENT_ENV: "env-dynamic",
    init: function () {},
    getWXContext: function () {
      return { OPENID: openid };
    },
    database: function () {
      return db;
    },
    getTempFileURL: function (options) {
      return Promise.resolve({
        fileList: (options.fileList || []).map(function (f) {
          return { fileID: f, tempFileURL: tempUrls[f] || "", status: 0 };
        })
      });
    }
  };
}

/** 造一个活跃共享家庭(households 元数据 + 会员行 + 活跃指针),返回 household_id */
async function seedSharedActive(db, householdId, openids) {
  await db.collection("households").add({
    data: {
      _id: householdId,
      display_name: "拍照之家",
      dissolved: false,
      scope_revision: 2,
      created_at: T0
    }
  });
  for (var i = 0; i < openids.length; i++) {
    await db.collection("household_members").add({
      data: {
        household_id: householdId,
        member_key: sha256hex(openids[i]),
        role: i === 0 ? "owner" : "member",
        joined_at: T0,
        invited_by: null
      }
    });
    await db.collection("active_household").add({
      data: { member_key: sha256hex(openids[i]), household_id: householdId, updated_at: T0 }
    });
  }
  return householdId;
}

test("PC-GLUE:个人家庭经真实入口 photoCommit 建档+证据,photoEvidenceGet 经注入的 getTempFileURL 换链", async function () {
  var db = freshDb();
  // file_id 按上传路径约定带**服务端派生个人家庭**前缀(PR #67 B2 归属验证)
  var glueHousehold = "hh_" + sha256hex("o-photo-glue-user").slice(0, 32);
  var glueFileId = "cloud://bucket/photo-evidence/" + glueHousehold + "/glue-f1.jpg";
  var entry = loadCloudFunction(
    path.join(ROOT, "cloudfunctions", "itemsApi", "index.js"),
    makeItemsApiStub("o-photo-glue-user", db, (function () { var m = {}; m[glueFileId] = "https://temp/glue1"; return m; })())
  );
  var committed = await entry.main(
    commitEvent([item("op-glue", "护照", "书房抽屉", { photo: photo("glue-f1", { file_id: glueFileId }) })])
  );
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(committed.results[0].ok, true);
  assert.equal(committed.results[0].evidence_saved, true);

  var ev = await entry.main({
    action: "photoEvidenceGet",
    item_ids: [committed.results[0].item_id]
  });
  assert.equal(ev.ok, true, JSON.stringify(ev));
  assert.equal(ev.household_id, "hh_" + sha256hex("o-photo-glue-user").slice(0, 32), "个人家庭按服务端派生");
  assert.equal(ev.evidence.length, 1);
  assert.equal(ev.evidence[0].photo_url, "https://temp/glue1", "经胶水注入的 cloud.getTempFileURL 换链");
});

test("PC-GLUE:共享家庭经真实入口——缺 marker FAMILY_SWITCHED 零写入,带齐双 marker 全链 ok", async function () {
  var db = freshDb();
  var householdId = "hh_shared_photo_glue_0000000000000";
  await seedSharedActive(db, householdId, ["o-photo-owner"]);
  var entry = loadCloudFunction(
    path.join(ROOT, "cloudfunctions", "itemsApi", "index.js"),
    makeItemsApiStub("o-photo-owner", db, {})
  );
  var ev = commitEvent([item("op-sg", "户口本", "卧室保险柜")]);

  var blocked = await entry.main(ev);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "FAMILY_SWITCHED");
  assert.equal((await rawDocs(db, "items")).length, 0, "零写入");

  ev.expected_household_id = householdId;
  ev.expected_scope_revision = 2;
  var ok = await entry.main(ev);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.results[0].ok, true);

  var got = await entry.main({ action: "photoEvidenceGet", item_ids: [ok.results[0].item_id] });
  assert.equal(got.ok, true);
  assert.equal(got.household_id, householdId);
  assert.equal(got.scope_revision, 2, "共享家庭证据查询带 scope_revision");
});

test("PC-CONFIG:itemsApi config.json timeout 提到 20(photoCommit 10 件留余量)", function () {
  var fs = require("node:fs");
  var config = JSON.parse(
    fs.readFileSync(path.join(ROOT, "cloudfunctions", "itemsApi", "config.json"), "utf8")
  );
  assert.equal(config.timeout, 20);
});

// ---------- PC-SCOPE:photoCommit 会话作用域门(PR #67 B1) ----------

test("PC-SCOPE-1:expected_household_id(会话开批家庭)≠ 当前派生家庭 → SCOPE_MISMATCH 零写入,优先于共享双 marker 硬门", async function () {
  // 场景:用户在 A 家开拍照会话 → 中途切到 B 家(服务端解析活跃家庭=B)→ 点确认
  var db = freshDb();
  var depsB = makeDeps(db, HOUSEHOLD_B, { shared: true, scopeRevision: 5 });
  var res = await handler(
    commitEvent([item("op-s1", "护照", "书房抽屉", { photo: photo("f-s1") })], {
      expected_household_id: HOUSEHOLD_A,
      expected_scope_revision: 5
    }),
    depsB
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "SCOPE_MISMATCH", "错误码是 SCOPE_MISMATCH,不是通用 FAMILY_SWITCHED");
  assert.equal(res.message, "家庭已切换,本批未保存");
  assert.equal((await rawDocs(db, "items")).length, 0, "零写入:items");
  assert.equal((await rawDocs(db, "photo_evidence")).length, 0, "零写入:证据行");

  // 个人家庭派生同样适用(A 家个人批切到 B 家个人活跃家庭)
  var db2 = freshDb();
  var depsBPersonal = makeDeps(db2, HOUSEHOLD_B);
  var res2 = await handler(
    commitEvent([item("op-s1", "护照", "书房抽屉", { photo: photo("f-s1") })], {
      expected_household_id: HOUSEHOLD_A
    }),
    depsBPersonal
  );
  assert.equal(res2.error, "SCOPE_MISMATCH");
  assert.equal((await rawDocs(db2, "items")).length, 0, "个人家庭同样零写入");
});

test("PC-SCOPE-2:会话门三态——类型非法 INVALID_INPUT;一致放行走后续建档;未携带落回通用硬门", async function () {
  var db = freshDb();
  var deps = makeDeps(db, HOUSEHOLD_A);
  // 类型非法
  var bad = await handler(
    commitEvent([item("op-s2", "护照", "书房抽屉")], { expected_household_id: 12345 }),
    deps
  );
  assert.equal(bad.error, "INVALID_INPUT", "marker 类型非法与通用门同口径");

  // 一致 → 放行(个人家庭宽松口径,照常建档)
  var deps2 = makeDeps(db, HOUSEHOLD_A);
  var ok = await handler(
    commitEvent([item("op-s2", "护照", "书房抽屉", { photo: photo("f-s2") })], {
      expected_household_id: HOUSEHOLD_A
    }),
    deps2
  );
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal((await rawDocs(db, "items")).length, 1);

  // 未携带(开批时未捕获作用域)→ 落回通用硬门:共享家庭仍被 FAMILY_SWITCHED 拦下
  var db3 = freshDb();
  var depsShared = makeDeps(db3, HOUSEHOLD_A, { shared: true, scopeRevision: 2 });
  var blocked = await handler(
    commitEvent([item("op-s3", "护照", "书房抽屉")]),
    depsShared
  );
  assert.equal(blocked.error, "FAMILY_SWITCHED", "未携带不改通用硬门语义");
  assert.equal((await rawDocs(db3, "items")).length, 0);
});

// ---------- PC-OWN / PE-VALID:file_id 归属验证 + 已删物品证据过滤(PR #67 B2) ----------

test("PC-OWN-1:伪造他家前缀的 file_id → FILE_NOT_OWNED 整批零写入(他家照片绝不落本家庭证据行)", async function () {
  var db = freshDb();
  var deps = makeDeps(db, HOUSEHOLD_A);
  var foreign = "cloud://bucket/photo-evidence/" + HOUSEHOLD_B + "/1697000000000-forged.jpg";
  var res = await handler(
    commitEvent([
      item("op-ow1", "护照", "书房抽屉", { photo: photo("ow1", { file_id: foreign }) }),
      item("op-ow2", "户口本", "卧室", { photo: photo("ow2") }) // 第二件合法:同样被整批拦下
    ]),
    deps
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "FILE_NOT_OWNED");
  assert.equal(res.message, "照片文件不属于当前家庭,本批未保存");
  assert.equal((await rawDocs(db, "items")).length, 0, "零写入:items");
  assert.equal((await rawDocs(db, "photo_evidence")).length, 0, "零写入:证据行");

  // 共享家庭同样适用(先过会话门一致,再被归属门拦)
  var db2 = freshDb();
  var depsShared = makeDeps(db2, HOUSEHOLD_A, { shared: true, scopeRevision: 3 });
  var res2 = await handler(
    commitEvent([item("op-ow1", "护照", "书房抽屉", { photo: photo("ow1", { file_id: foreign }) })], {
      expected_household_id: HOUSEHOLD_A,
      expected_scope_revision: 3
    }),
    depsShared
  );
  assert.equal(res2.error, "FILE_NOT_OWNED", "共享家庭双 marker 齐备也拦归属");
  assert.equal((await rawDocs(db2, "items")).length, 0);
});

test("PC-OWN-2:解析不出云存储路径的 file_id 一律 INVALID_INPUT 零写入", async function () {
  var db = freshDb();
  var deps = makeDeps(db, HOUSEHOLD_A);
  var cases = [
    "https://cdn.example.com/evidence.jpg", // 非 cloud:// 形态
    "cloud://bucket-no-path", // 无路径段
    "cloud://bucket/", // 空路径
    "cloud://bucket/photo-evidence/../../" + HOUSEHOLD_A + "/x.jpg" // 路径穿越
  ];
  for (var i = 0; i < cases.length; i++) {
    var res = await handler(
      commitEvent([item("op-own-" + i, "护照", "书房抽屉", { photo: photo("ow", { file_id: cases[i] }) })]),
      deps
    );
    assert.equal(res.ok, false, cases[i]);
    assert.equal(res.error, "INVALID_INPUT", cases[i] + " → 参数形状错拒绝");
  }
  assert.equal((await rawDocs(db, "items")).length, 0, "零写入");
  assert.equal((await rawDocs(db, "photo_evidence")).length, 0, "零写入");
});

test("PE-VALID:已删除/不存在的 item 证据行静默过滤;存活 item 照常返回", async function () {
  var db = freshDb();
  await seedEvidence(db, HOUSEHOLD_A, "it_alive", "cloud://fv1", "2026-10-01T00:00:00.000Z");
  await seedEvidence(db, HOUSEHOLD_A, "it_deleted", "cloud://fv2", "2026-10-02T00:00:00.000Z", {
    itemState: "deleted"
  });
  await seedEvidence(db, HOUSEHOLD_A, "it_gone", "cloud://fv3", "2026-10-03T00:00:00.000Z", {
    itemState: "missing"
  });
  var deps = makeDeps(db, HOUSEHOLD_A, {
    getTempFileUrls: async function (ids) {
      return { fileList: ids.map(function (f) { return { fileID: f, tempFileURL: "https://t/" + f }; }) };
    }
  });
  var res = await handler(
    { action: "photoEvidenceGet", item_ids: ["it_alive", "it_deleted", "it_gone"] },
    deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.evidence.length, 1, "已删/不存在物品的证据行不返回(静默过滤)");
  assert.equal(res.evidence[0].item_id, "it_alive", "存活物品的证据照常返回");
  assert.equal(res.evidence[0].photo_url, "https://t/cloud://fv1");
});

// ---------- PC-EVID / PE-RETRY:证据写入失败=部分成功 + photoEvidenceRetry 幂等重试(PR #67 C3) ----------

/* 让 photo_evidence 的 add 对指定 file_id 抛基础设施错误(非 E11000):
 * photoCommit/重试的 savePhotoEvidence 在该 file 上必失败,其余照常 */
function makeEvidenceBoomDb(db, boomFileId) {
  var realCollection = db.collection.bind(db);
  return {
    collection: function (name) {
      var coll = realCollection(name);
      if (name !== "photo_evidence") {
        return coll;
      }
      return {
        add: function (options) {
          if (options && options.data && options.data.file_id === boomFileId) {
            return Promise.reject(new Error("collection.add:fail -502001 database request fail"));
          }
          return coll.add(options);
        },
        where: coll.where,
        doc: coll.doc
      };
    }
  };
}

/* 让 photo_evidence 的第一次 add 抛基础设施错误(单件失败,其余件照常落地) */
function makeFirstAddBoomDb(db) {
  var realCollection = db.collection.bind(db);
  var addCalls = 0;
  return {
    collection: function (name) {
      var coll = realCollection(name);
      if (name !== "photo_evidence") {
        return coll;
      }
      return {
        add: function (options) {
          addCalls += 1;
          if (addCalls === 1) {
            return Promise.reject(new Error("collection.add:fail -502001 database request fail"));
          }
          return coll.add(options);
        },
        where: coll.where,
        doc: coll.doc
      };
    }
  };
}

test("PC-EVID-1:证据写入失败 → 物品保留+evidence_failed 如实返回+其余件继续(部分成功语义)", async function () {
  var db = freshDb();
  var boomFile = "cloud://bucket/photo-evidence/" + HOUSEHOLD_A + "/f-boom.jpg";
  var deps = makeDeps(makeEvidenceBoomDb(db, boomFile), HOUSEHOLD_A);
  var res = await handler(
    commitEvent([
      item("op-ev1", "护照", "书房抽屉", { photo: photo("f-boom") }), // 证据写失败
      item("op-ev2", "户口本", "卧室", { photo: photo("f-ok") }), // 照常
      item("op-ev3", "钥匙", "玄关") // 无照片件照常
    ]),
    deps
  );
  assert.equal(res.ok, true, "证据写失败不废整批,整体成功返回");
  assert.equal(res.results.length, 3);
  assert.equal(res.results[0].ok, true, "物品已建,绝不因证据失败回滚");
  assert.equal(res.results[0].evidence_saved, false, "该件证据未落");
  assert.equal(res.results[1].ok, true);
  assert.equal(res.results[1].evidence_saved, true, "其余件证据照常写入");
  assert.equal(res.results[2].ok, true);
  assert.deepEqual(res.evidence_failed, [res.results[0].item_id], "evidence_failed 如实携带失败件 item_id");

  var items = await rawDocs(db, "items");
  assert.equal(items.length, 3, "物品全部保留");
  var evidence = await rawDocs(db, "photo_evidence");
  assert.equal(evidence.length, 1, "只有成功件的证据行");
  assert.equal(evidence[0].item_id, res.results[1].item_id);
});

test("PC-EVID-2:全部件证据失败 → 仍整体 ok:true,evidence_failed 全量如实", async function () {
  var db = freshDb();
  var boomFile = "cloud://bucket/photo-evidence/" + HOUSEHOLD_A + "/f-all.jpg";
  var deps = makeDeps(makeEvidenceBoomDb(db, boomFile), HOUSEHOLD_A);
  var res = await handler(
    commitEvent([
      item("op-ev-a", "甲", "客厅", { photo: photo("f-all") }),
      item("op-ev-b", "乙", "客厅", { photo: photo("f-all") }) // 同一照片两件都失败
    ]),
    deps
  );
  assert.equal(res.ok, true);
  assert.equal(res.results.every(function (r) { return r.ok; }), true, "物品全建");
  assert.equal(res.results.every(function (r) { return r.evidence_saved === false; }), true);
  assert.equal(res.evidence_failed.length, 2);
  assert.equal((await rawDocs(db, "items")).length, 2);
  assert.equal((await rawDocs(db, "photo_evidence")).length, 0, "零证据行");
});

test("PE-RETRY-1:photoEvidenceRetry 补写成功——captured_location_text 取该件当前 items.location_text", async function () {
  var db = freshDb();
  var boomFile = "cloud://bucket/photo-evidence/" + HOUSEHOLD_A + "/f-retry.jpg";
  // 第一步:photoCommit 证据失败(boom 桩),拿到 evidence_failed 的 item_id
  var commitRes = await handler(
    commitEvent([item("op-rt1", "护照", "书房抽屉", { photo: photo("f-retry") })]),
    makeDeps(makeEvidenceBoomDb(db, boomFile), HOUSEHOLD_A)
  );
  assert.equal(commitRes.ok, true);
  assert.equal(commitRes.evidence_failed.length, 1);
  var itemId = commitRes.evidence_failed[0];

  // 第二步:重试关联(正常 db)补写成功
  var res = await handler(
    {
      action: "photoEvidenceRetry",
      file_id: boomFile,
      img_w: 1024,
      img_h: 768,
      items: [{ item_id: itemId, box: { x1: 0.27, y1: 0.39, x2: 0.59, y2: 0.51 }, source: "vl" }]
    },
    makeDeps(db, HOUSEHOLD_A)
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[0].item_id, itemId);
  assert.equal(res.results[0].evidence_saved, true, "本次新写入");

  var evidence = await rawDocs(db, "photo_evidence");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].item_id, itemId);
  assert.equal(evidence[0].file_id, boomFile);
  assert.deepEqual(evidence[0].box, { x1: 0.27, y1: 0.39, x2: 0.59, y2: 0.51 });
  assert.equal(evidence[0].source, "vl");
  assert.equal(evidence[0].captured_location_text, "书房抽屉", "取该件当前 items.location_text");
});

test("PE-RETRY-2:幂等——已存在(pre-check)返回 evidence_saved:false 仍成功;E11000 孪生回查收敛", async function () {
  var db = freshDb();
  await db.collection("items").add({
    data: {
      _id: "it_rt2",
      household_id: HOUSEHOLD_A,
      name: "护照",
      location_text: "书房",
      deleted: false,
      created_at: T0,
      updated_at: T0
    }
  });
  var fileId = "cloud://bucket/photo-evidence/" + HOUSEHOLD_A + "/f-idem.jpg";
  var ev = {
    action: "photoEvidenceRetry",
    file_id: fileId,
    img_w: 800,
    img_h: 600,
    items: [{ item_id: "it_rt2", box: null, source: "circle" }]
  };
  // 第一次:写入
  var first = await handler(ev, makeDeps(db, HOUSEHOLD_A));
  assert.equal(first.results[0].ok, true);
  assert.equal(first.results[0].evidence_saved, true);

  // 第二次:同参重放,pre-check 已存在 → 幂等成功,不重复落行
  var second = await handler(ev, makeDeps(db, HOUSEHOLD_A));
  assert.equal(second.ok, true);
  assert.equal(second.results[0].ok, true);
  assert.equal(second.results[0].evidence_saved, false, "已存在=成功(幂等)");
  assert.equal((await rawDocs(db, "photo_evidence")).length, 1, "证据行绝不重复");

  // E11000 孪生窗口:add 撞唯一索引但回查见行 → 收敛当已保存
  // (makeTwinRaceDb:第一次 where 查询回空 + add 恒抛 E11000;回查走真实数据,
  //  能看到 first 已落的同键行)
  var twinDb = makeTwinRaceDb(db);
  var third = await handler(ev, makeDeps(twinDb, HOUSEHOLD_A));
  assert.equal(third.results[0].ok, true, "E11000=已存在=成功");
  assert.equal((await rawDocs(db, "photo_evidence")).length, 1, "证据行绝不重复");
});

test("PE-RETRY-3:跨家 item 拒(NOT_FOUND 逐件)+ 已删 item 拒;不拦其余件", async function () {
  var db = freshDb();
  // A 家存活件 / A 家已删件 / B 家件(跨家)
  await db.collection("items").add({
    data: { _id: "it_a_ok", household_id: HOUSEHOLD_A, name: "甲", location_text: "客厅", deleted: false, created_at: T0, updated_at: T0 }
  });
  await db.collection("items").add({
    data: { _id: "it_a_del", household_id: HOUSEHOLD_A, name: "乙", location_text: "客厅", deleted: true, created_at: T0, updated_at: T0 }
  });
  await db.collection("items").add({
    data: { _id: "it_b_x", household_id: HOUSEHOLD_B, name: "丙", location_text: "客厅", deleted: false, created_at: T0, updated_at: T0 }
  });
  var res = await handler(
    {
      action: "photoEvidenceRetry",
      file_id: "cloud://bucket/photo-evidence/" + HOUSEHOLD_A + "/f-mix.jpg",
      img_w: 1024,
      img_h: 768,
      items: [
        { item_id: "it_b_x", box: null }, // 跨家
        { item_id: "it_a_del", box: null }, // 已删
        { item_id: "it_a_ok", box: null } // 存活
      ]
    },
    makeDeps(db, HOUSEHOLD_A)
  );
  assert.equal(res.ok, true);
  assert.equal(res.results[0].ok, false, "跨家 item 拒");
  assert.equal(res.results[0].error, "NOT_FOUND");
  assert.equal(res.results[1].ok, false, "已删 item 拒");
  assert.equal(res.results[1].error, "NOT_FOUND");
  assert.equal(res.results[2].ok, true, "不拦其余件");
  var evidence = await rawDocs(db, "photo_evidence");
  assert.equal(evidence.length, 1, "只有存活件的证据行落地");
  assert.equal(evidence[0].item_id, "it_a_ok");
});

test("PE-RETRY-4:跨家 file_id 拒 → FILE_NOT_OWNED 整批零写入", async function () {
  var db = freshDb();
  await db.collection("items").add({
    data: { _id: "it_ow", household_id: HOUSEHOLD_A, name: "甲", location_text: "客厅", deleted: false, created_at: T0, updated_at: T0 }
  });
  var foreign = "cloud://bucket/photo-evidence/" + HOUSEHOLD_B + "/1697000000000-forged.jpg";
  var res = await handler(
    {
      action: "photoEvidenceRetry",
      file_id: foreign,
      img_w: 1024,
      img_h: 768,
      items: [{ item_id: "it_ow", box: null }]
    },
    makeDeps(db, HOUSEHOLD_A)
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "FILE_NOT_OWNED");
  assert.equal(res.message, "照片文件不属于当前家庭,本批未保存");
  assert.equal((await rawDocs(db, "photo_evidence")).length, 0, "零写入");

  // 解析不出路径的 file_id → INVALID_INPUT
  var bad = await handler(
    { action: "photoEvidenceRetry", file_id: "https://cdn.example.com/x.jpg", img_w: 1, img_h: 1, items: [{ item_id: "it_ow" }] },
    makeDeps(db, HOUSEHOLD_A)
  );
  assert.equal(bad.error, "INVALID_INPUT");
});

test("PE-RETRY-5:参数形状非法 → 整批 INVALID_INPUT 零写入", async function () {
  var db = freshDb();
  var deps = makeDeps(db, HOUSEHOLD_A);
  var goodFile = "cloud://bucket/photo-evidence/" + HOUSEHOLD_A + "/f-v.jpg";
  var cases = [
    { label: "file_id 空", ev: { action: "photoEvidenceRetry", file_id: "", img_w: 1, img_h: 1, items: [{ item_id: "it" }] } },
    { label: "img_w 非整数", ev: { action: "photoEvidenceRetry", file_id: goodFile, img_w: 1.5, img_h: 1, items: [{ item_id: "it" }] } },
    { label: "img_h 缺失", ev: { action: "photoEvidenceRetry", file_id: goodFile, img_w: 1, items: [{ item_id: "it" }] } },
    { label: "items 空数组", ev: { action: "photoEvidenceRetry", file_id: goodFile, img_w: 1, img_h: 1, items: [] } },
    { label: "items 11 件", ev: { action: "photoEvidenceRetry", file_id: goodFile, img_w: 1, img_h: 1, items: Array.from({ length: 11 }, function (_, i) { return { item_id: "it" + i }; }) } },
    { label: "item_id 空", ev: { action: "photoEvidenceRetry", file_id: goodFile, img_w: 1, img_h: 1, items: [{ item_id: "" }] } },
    { label: "box 越界", ev: { action: "photoEvidenceRetry", file_id: goodFile, img_w: 1, img_h: 1, items: [{ item_id: "it", box: { x1: 0, y1: 0, x2: 1.5, y2: 1 } }] } },
    { label: "source 非法", ev: { action: "photoEvidenceRetry", file_id: goodFile, img_w: 1, img_h: 1, items: [{ item_id: "it", source: "guess" }] } },
    { label: "件非对象", ev: { action: "photoEvidenceRetry", file_id: goodFile, img_w: 1, img_h: 1, items: ["it"] } }
  ];
  for (var c = 0; c < cases.length; c++) {
    var res = await handler(cases[c].ev, deps);
    assert.equal(res.ok, false, cases[c].label);
    assert.equal(res.error, "INVALID_INPUT", cases[c].label);
  }
  assert.equal((await rawDocs(db, "photo_evidence")).length, 0, "零写入");
});

test("PE-RETRY-6:共享家庭缺双 marker → FAMILY_SWITCHED 零写入(写硬门同款)", async function () {
  var db = freshDb();
  var deps = makeDeps(db, HOUSEHOLD_A, { shared: true, scopeRevision: 4 });
  var blocked = await handler(
    {
      action: "photoEvidenceRetry",
      file_id: "cloud://bucket/photo-evidence/" + HOUSEHOLD_A + "/f-gate.jpg",
      img_w: 1,
      img_h: 1,
      items: [{ item_id: "it_x" }]
    },
    deps
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "FAMILY_SWITCHED");
  assert.equal((await rawDocs(db, "photo_evidence")).length, 0);

  var deps2 = makeDeps(db, HOUSEHOLD_A, { shared: true, scopeRevision: 4 });
  var ok = await handler(
    {
      action: "photoEvidenceRetry",
      file_id: "cloud://bucket/photo-evidence/" + HOUSEHOLD_A + "/f-gate.jpg",
      img_w: 1,
      img_h: 1,
      items: [{ item_id: "it_x" }],
      expected_household_id: HOUSEHOLD_A,
      expected_scope_revision: 4
    },
    deps2
  );
  assert.equal(ok.ok, true, "带齐 marker 放行(逐件 NOT_FOUND 是运行期结果)");
  assert.equal(ok.results[0].ok, false);
  assert.equal(ok.results[0].error, "NOT_FOUND");
});

test("PE-RETRY-7:单件证据写入失败(EVIDENCE_WRITE_FAILED)只进该件失败项,不拦其余件", async function () {
  var db = freshDb();
  await db.collection("items").add({
    data: { _id: "it_r7a", household_id: HOUSEHOLD_A, name: "甲", location_text: "客厅", deleted: false, created_at: T0, updated_at: T0 }
  });
  await db.collection("items").add({
    data: { _id: "it_r7b", household_id: HOUSEHOLD_A, name: "乙", location_text: "客厅", deleted: false, created_at: T0, updated_at: T0 }
  });
  var res = await handler(
    {
      action: "photoEvidenceRetry",
      file_id: "cloud://bucket/photo-evidence/" + HOUSEHOLD_A + "/f-partial.jpg",
      img_w: 1024,
      img_h: 768,
      items: [
        { item_id: "it_r7a", box: null },
        { item_id: "it_r7b", box: null }
      ]
    },
    makeDeps(makeFirstAddBoomDb(db), HOUSEHOLD_A)
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results[0].ok, false, "第一件写失败");
  assert.equal(res.results[0].error, "EVIDENCE_WRITE_FAILED");
  assert.ok(typeof res.results[0].message === "string" && res.results[0].message !== "");
  assert.equal(res.results[1].ok, true, "不拦其余件");
  var evidence = await rawDocs(db, "photo_evidence");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].item_id, "it_r7b");
});
