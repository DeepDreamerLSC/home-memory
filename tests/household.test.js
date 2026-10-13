"use strict";

/**
 * issue #34 P0(家庭共享 v0)离线合同测试:
 * - HH-SRC:lib/household.js 双副本逐字节防漂移(照 tests/locations.test.js TS-SRC 模式);
 * - HH-RSLV:可信家庭解析四分支——active 命中共享家庭 / 无 active 回退个人 /
 *   查询异常失败关闭 / 孤儿 active 指针失败关闭(P0-4,逐分支锁定),
 *   外加指针不唯一、指针字段非法、members 查询异常;
 * - HH-GLUE:index.js 胶水层接入解析:共享家庭定向写入、失败关闭零写入、
 *   个人家庭回退与存量算法逐字节一致、list 响应带 household_id;
 * - HH-F2:写类 action 的 expected_household_id——一致放行 / 不一致
 *   FAMILY_SWITCHED(零写入)/ 缺省维持现状;只读 action 不参与校验;
 * - HH-LST:两函数 list 响应 household_id 断言(仅 list 携带)。
 * 零网络、零外部依赖;胶水测试用 stub 替身加载,绝不 require wx-server-sdk。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var crypto = require("node:crypto");
var Module = require("node:module");

var household = require("../cloudfunctions/itemsApi/lib/household");
var itemsHandler = require("../cloudfunctions/itemsApi/lib/handler").handler;
var locHandler = require("../cloudfunctions/locations/lib/handler").handler;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

var ROOT = path.join(__dirname, "..");

var HOUSEHOLD_A = "hh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
var SHARED_1 = "hh_shared_1111";

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function digest16(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

function rawDocs(db, name) {
  return db.collection(name).where({}).get();
}

async function seedMembership(db, openid, householdId) {
  await db.collection("active_household").add({
    data: { member_key: household.memberKeyOf(openid), household_id: householdId, updated_at: "2026-10-13T00:00:00.000Z" }
  });
  await db.collection("household_members").add({
    data: {
      household_id: householdId,
      member_key: household.memberKeyOf(openid),
      role: "owner",
      joined_at: "2026-10-13T00:00:00.000Z",
      invited_by: null
    }
  });
}

/** 指定集合的 where().get() 恒 reject(模拟集合未创建/索引故障/网络异常) */
function throwingCollectionDb(base, collectionName) {
  return {
    collection: function (name) {
      if (name !== collectionName) {
        return base.collection(name);
      }
      return {
        where: function () {
          return {
            get: function () {
              return Promise.reject(new Error("simulated: collection " + name + " unavailable"));
            }
          };
        }
      };
    }
  };
}

// ---------- HH-SRC:副本同源(照 TS-SRC 模式) ----------

test("HH-SRC:lib/household.js 副本剥离声明头后与源文件逐字节一致,声明头含同源与双向同步标记", function () {
  var marker = "---- 副本正文(与源文件逐字节一致)----";
  var copy = fs.readFileSync(path.join(ROOT, "cloudfunctions", "locations", "lib", "household.js"), "utf8");
  var source = fs.readFileSync(path.join(ROOT, "cloudfunctions", "itemsApi", "lib", "household.js"), "utf8");
  var idx = copy.indexOf(marker);
  assert.notStrictEqual(idx, -1, "locations 副本应含同源声明分界标记");
  var header = copy.slice(0, idx);
  assert.ok(header.indexOf("逐字节") !== -1, "声明头应标明逐字节同源");
  assert.ok(header.indexOf("双向同步") !== -1, "声明头应含双向同步要求");
  var commentEnd = copy.indexOf("*/", idx);
  assert.notStrictEqual(commentEnd, -1, "声明头应闭合");
  var body = copy.slice(copy.indexOf("\n", commentEnd) + 1);
  assert.strictEqual(body, source, "副本正文应与源文件逐字节一致(防漂移)");
});

// ---------- HH-RSLV:解析四分支 + 防御分支 ----------

test("HH-RSLV-1:active 命中且会员行存在 → 返回该共享 household_id", async function () {
  var db = createMemoryDb();
  await seedMembership(db, "o-member-1", SHARED_1);
  var res = await household.resolveActiveHousehold(db, "o-member-1");
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.householdId, SHARED_1);
});

test("HH-RSLV-2:无 active 记录 → 回退个人家庭(存量算法逐字节不变)且不写新集合", async function () {
  var db = createMemoryDb();
  var res = await household.resolveActiveHousehold(db, "o-single-1");
  assert.equal(res.ok, true);
  assert.equal(res.householdId, "hh_" + sha256("o-single-1").slice(0, 32));
  // 存量算法收口断言:personalHouseholdId 与旧 index.js 内联派生完全一致
  assert.equal(res.householdId, household.personalHouseholdId("o-single-1"));
  // 解析绝不写入任何新集合(P0 无会员写入路径)
  assert.equal((await rawDocs(db, "active_household")).data.length, 0);
  assert.equal((await rawDocs(db, "household_members")).data.length, 0);
});

test("HH-RSLV-3:active_household 查询异常 → HOUSEHOLD_UNAVAILABLE 失败关闭,绝不回退个人家庭", async function () {
  var db = createMemoryDb();
  var broken = throwingCollectionDb(db, "active_household");
  var res = await household.resolveActiveHousehold(broken, "o-single-2");
  assert.equal(res.ok, false);
  assert.equal(res.error, "HOUSEHOLD_UNAVAILABLE");
  assert.equal(res.reason, "active_query_failed");
  assert.equal(res.householdId, undefined, "失败关闭结果不得携带任何 household_id");
  assert.equal(typeof res.message, "string");
});

test("HH-RSLV-4:孤儿 active 指针(会员行缺失)→ HOUSEHOLD_UNAVAILABLE 失败关闭", async function () {
  var db = createMemoryDb();
  // 活跃指针在、会员行不在(被移除/退出后指针未清的真实形态)
  await db.collection("active_household").add({
    data: { member_key: household.memberKeyOf("o-orphan-1"), household_id: SHARED_1, updated_at: "2026-10-13T00:00:00.000Z" }
  });
  var res = await household.resolveActiveHousehold(db, "o-orphan-1");
  assert.equal(res.ok, false);
  assert.equal(res.error, "HOUSEHOLD_UNAVAILABLE");
  assert.equal(res.reason, "orphan_active_pointer");
  assert.equal(res.householdId, undefined);
});

test("HH-RSLV-5:household_members 查询异常 → HOUSEHOLD_UNAVAILABLE 失败关闭", async function () {
  var db = createMemoryDb();
  await seedMembership(db, "o-member-2", SHARED_1);
  var broken = throwingCollectionDb(db, "household_members");
  var res = await household.resolveActiveHousehold(broken, "o-member-2");
  assert.equal(res.ok, false);
  assert.equal(res.error, "HOUSEHOLD_UNAVAILABLE");
  assert.equal(res.reason, "member_query_failed");
  assert.equal(res.householdId, undefined);
});

test("HH-RSLV-6:active 指针不唯一(唯一索引缺失形态)或字段非法 → 失败关闭", async function () {
  var db = createMemoryDb();
  var key = household.memberKeyOf("o-dup-1");
  await db.collection("active_household").add({ data: { member_key: key, household_id: SHARED_1, updated_at: "t" } });
  await db.collection("active_household").add({ data: { member_key: key, household_id: "hh_shared_2222", updated_at: "t" } });
  var dup = await household.resolveActiveHousehold(db, "o-dup-1");
  assert.equal(dup.ok, false);
  assert.equal(dup.error, "HOUSEHOLD_UNAVAILABLE");
  assert.equal(dup.reason, "active_not_unique");

  var db2 = createMemoryDb();
  await db2.collection("active_household").add({ data: { member_key: household.memberKeyOf("o-bad-1"), household_id: "", updated_at: "t" } });
  var bad = await household.resolveActiveHousehold(db2, "o-bad-1");
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "active_invalid_pointer");

  var db3 = createMemoryDb();
  await db3.collection("active_household").add({ data: { member_key: household.memberKeyOf("o-bad-2"), household_id: 12345, updated_at: "t" } });
  var badType = await household.resolveActiveHousehold(db3, "o-bad-2");
  assert.equal(badType.ok, false);
  assert.equal(badType.reason, "active_invalid_pointer");
});

test("HH-RSLV-7:不同 OPENID 的 member_key 互不相同,且不等于裸 openid(隐私红线)", function () {
  var k1 = household.memberKeyOf("o-alpha");
  var k2 = household.memberKeyOf("o-beta");
  assert.notEqual(k1, k2);
  assert.equal(k1, sha256("o-alpha"));
  assert.equal(k1.length, 64);
  assert.ok(k1.indexOf("o-alpha") === -1, "member_key 不得含裸 openid 片段");
});

// ---------- HH-GLUE:index.js 胶水层真实加载 ----------

/** 临时把 wx-server-sdk 替换为 stub 并(重新)加载云函数入口(照 tests/glue.test.js 手法) */
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

function makeItemsApiStub(openid, db) {
  return {
    db: db,
    sdk: {
      DYNAMIC_CURRENT_ENV: "env-dynamic",
      init: function () {},
      getWXContext: function () {
        return openid ? { OPENID: openid } : {};
      },
      database: function () {
        return db;
      }
    }
  };
}

function makeLocationsStub(openid, db) {
  return {
    db: db,
    sdk: {
      DYNAMIC_CURRENT_ENV: "env-dynamic",
      init: function () {},
      getWXContext: function () {
        return openid ? { OPENID: openid } : {};
      },
      database: function () {
        return {
          collection: db.collection.bind(db),
          createCollection: async function () {}
        };
      }
    }
  };
}

test("HH-GLUE-1:itemsApi 胶水层命中共享家庭 → 写入与 list 响应都定向共享域", async function () {
  var db = createMemoryDb();
  await seedMembership(db, "o-shared-user", SHARED_1);
  var stub = makeItemsApiStub("o-shared-user", db);
  var entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "itemsApi", "index.js"), stub.sdk);

  var created = await entry.main({
    action: "create",
    operation_id: "hh-glue-op-1",
    name: "共享家钥匙",
    location_text: "客厅抽屉"
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  var stored = await rawDocs(db, "items");
  assert.equal(stored.data.length, 1);
  assert.equal(stored.data[0].household_id, SHARED_1, "写入门共享家庭");

  var listed = await entry.main({ action: "list" });
  assert.equal(listed.ok, true);
  assert.equal(listed.household_id, SHARED_1, "list 响应应携带服务端解析的 household_id");
});

test("HH-GLUE-2:itemsApi 解析失败(active 查询异常)→ HOUSEHOLD_UNAVAILABLE 且零写入", async function () {
  var db = createMemoryDb();
  var broken = throwingCollectionDb(db, "active_household");
  // 注意:stub.database 必须返回 broken(解析走 database().collection)
  var stub = {
    sdk: {
      DYNAMIC_CURRENT_ENV: "env-dynamic",
      init: function () {},
      getWXContext: function () {
        return { OPENID: "o-closed-user" };
      },
      database: function () {
        return broken;
      }
    }
  };
  var entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "itemsApi", "index.js"), stub.sdk);
  var res = await entry.main({
    action: "create",
    operation_id: "hh-glue-op-2",
    name: "不应写入",
    location_text: "不应写入"
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, "HOUSEHOLD_UNAVAILABLE");
  assert.equal(typeof res.message, "string");
  assert.equal((await rawDocs(db, "items")).data.length, 0, "失败关闭必须零写入");
});

test("HH-GLUE-3:locations 胶水层个人家庭回退与存量算法一致;list 响应带 household_id;解析失败零写入", async function () {
  var db = createMemoryDb({ uniqueIndexes: { locations: [["household_id", "parent_id", "name_norm"]] } });
  var stub = makeLocationsStub("o-loc-user", db);
  var entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "locations", "index.js"), stub.sdk);

  var listed = await entry.main({ action: "list" });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  var expected = "hh_" + sha256("o-loc-user").slice(0, 32);
  assert.equal(listed.household_id, expected, "无 active 记录时回退个人家庭并随 list 返回");
  var nodes = await rawDocs(db, "locations");
  assert.equal(nodes.data.length, 1);
  assert.equal(nodes.data[0].household_id, expected);

  // 解析失败(active 查询异常)→ 失败关闭零写入
  var db2 = createMemoryDb({ uniqueIndexes: { locations: [["household_id", "parent_id", "name_norm"]] } });
  var broken = throwingCollectionDb(db2, "active_household");
  var stub2 = {
    sdk: {
      DYNAMIC_CURRENT_ENV: "env-dynamic",
      init: function () {},
      getWXContext: function () {
        return { OPENID: "o-loc-user-2" };
      },
      database: function () {
        return {
          collection: broken.collection.bind(broken),
          createCollection: async function () {}
        };
      }
    }
  };
  var entry2 = loadCloudFunction(path.join(ROOT, "cloudfunctions", "locations", "index.js"), stub2.sdk);
  var res = await entry2.main({ action: "ensurePath", path: ["书房"] });
  assert.equal(res.ok, false);
  assert.equal(res.error, "HOUSEHOLD_UNAVAILABLE");
  assert.equal((await rawDocs(db2, "locations")).data.length, 0, "失败关闭必须零写入(不建 home 根)");
});

// ---------- HH-F2 + HH-LST:expected_household_id 与 list 响应(handler 级) ----------

function itemsDeps(db, householdId) {
  var seq = 0;
  return {
    db: db,
    now: function () {
      return "2026-10-13T00:00:00.000Z";
    },
    genId: function () {
      seq += 1;
      return "g" + seq;
    },
    householdId: householdId,
    logger: { log: function () {} }
  };
}

function locsDeps(db, householdId) {
  var seq = 100;
  return {
    db: db,
    now: function () {
      return "2026-10-13T00:00:00.000Z";
    },
    genId: function () {
      seq += 1;
      return "l" + seq;
    },
    digest: digest16,
    householdId: householdId,
    logger: { log: function () {} }
  };
}

test("HH-F2-ITEMS:expected_household_id 一致放行 / 不一致 FAMILY_SWITCHED 零写入 / 缺省维持现状", async function () {
  var db = createMemoryDb();
  var deps = itemsDeps(db, HOUSEHOLD_A);

  // 缺省:维持现状(P0 客户端不发此参数)
  var ok1 = await itemsHandler(
    { action: "create", operation_id: "f2-op-1", name: "护照", location_text: "书房抽屉" },
    deps
  );
  assert.equal(ok1.ok, true);
  assert.equal((await rawDocs(db, "items")).data.length, 1);

  // 一致:放行
  var ok2 = await itemsHandler(
    { action: "create", operation_id: "f2-op-2", name: "户口本", location_text: "书房抽屉", expected_household_id: HOUSEHOLD_A },
    deps
  );
  assert.equal(ok2.ok, true, JSON.stringify(ok2));

  // 不一致:FAMILY_SWITCHED、零写入
  var bad = await itemsHandler(
    { action: "create", operation_id: "f2-op-3", name: "不应写入", location_text: "x", expected_household_id: "hh_otherfamily" },
    deps
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "FAMILY_SWITCHED");
  assert.equal(typeof bad.message, "string");
  assert.equal((await rawDocs(db, "items")).data.length, 2, "FAMILY_SWITCHED 必须零写入");

  // 非字符串类型:INVALID_INPUT(校验优先,零写入)
  var badType = await itemsHandler(
    { action: "create", operation_id: "f2-op-4", name: "不应写入", location_text: "x", expected_household_id: 42 },
    deps
  );
  assert.equal(badType.ok, false);
  assert.equal(badType.error, "INVALID_INPUT");
  assert.equal((await rawDocs(db, "items")).data.length, 2);

  // update/delete 同为写路径:不一致同样拦截(update 路径零改动)
  var item = (await rawDocs(db, "items")).data[0];
  var badUpd = await itemsHandler(
    { action: "update", item_id: item._id, expected_version: 1, name: "改名", expected_household_id: "hh_otherfamily" },
    deps
  );
  assert.equal(badUpd.ok, false);
  assert.equal(badUpd.error, "FAMILY_SWITCHED");
  var after = (await db.collection("items").doc(item._id).get()).data;
  assert.equal(after.name, "护照", "被拦截的 update 不得改动内容");
  assert.equal(after.version, 1);

  // 只读 action 不参与校验:list 携带不一致 expected 也不受影响(且响应含 household_id)
  var listed = await itemsHandler({ action: "list", expected_household_id: "hh_otherfamily" }, deps);
  assert.equal(listed.ok, true);
  assert.equal(listed.household_id, HOUSEHOLD_A);
});

test("HH-F2-LOCS:expected_household_id 一致放行 / 不一致 FAMILY_SWITCHED 零写入(ensurePath 与 linkItem 双写路径)", async function () {
  var db = createMemoryDb({ uniqueIndexes: { locations: [["household_id", "parent_id", "name_norm"]] } });
  var deps = locsDeps(db, HOUSEHOLD_A);

  // 缺省:维持现状
  var ok1 = await locHandler({ action: "ensurePath", path: ["书房"] }, deps);
  assert.equal(ok1.ok, true, JSON.stringify(ok1));

  // 一致:放行
  var ok2 = await locHandler({ action: "ensurePath", path: ["客厅"], expected_household_id: HOUSEHOLD_A }, deps);
  assert.equal(ok2.ok, true);

  // 不一致:FAMILY_SWITCHED、零写入(节点数不变)
  var before = (await rawDocs(db, "locations")).data.length;
  var bad = await locHandler({ action: "ensurePath", path: ["阳台"], expected_household_id: "hh_otherfamily" }, deps);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "FAMILY_SWITCHED");
  assert.equal(typeof bad.message, "string");
  assert.equal((await rawDocs(db, "locations")).data.length, before, "FAMILY_SWITCHED 必须零写入");

  // linkItem 写路径:先造物品(经 itemsApi handler,同家庭),再验证不一致拦截且版本不动
  var created = await itemsHandler(
    { action: "create", operation_id: "f2-loc-item-1", name: "充电宝", location_text: "书房" },
    itemsDeps(db, HOUSEHOLD_A)
  );
  assert.equal(created.ok, true);
  var node = (await rawDocs(db, "locations")).data.find(function (n) {
    return n.name === "书房";
  });
  var badLink = await locHandler(
    {
      action: "linkItem",
      item_id: created.item.item_id,
      node_id: node._id,
      expected_version: 1,
      update_id: "u-f2-1",
      expected_household_id: "hh_otherfamily"
    },
    deps
  );
  assert.equal(badLink.ok, false);
  assert.equal(badLink.error, "FAMILY_SWITCHED");
  var itemDoc = (await db.collection("items").doc(created.item.item_id).get()).data;
  assert.equal(itemDoc.version, 1, "被拦截的 linkItem 不得推进版本");
  assert.equal(itemDoc.location_node_id, undefined);

  // 只读 list 不参与校验,且响应含 household_id
  var listed = await locHandler({ action: "list", expected_household_id: "hh_otherfamily" }, deps);
  assert.equal(listed.ok, true);
  assert.equal(listed.household_id, HOUSEHOLD_A);
});

test("HH-LST:两函数 list 响应携带 household_id 且仅 list 携带(query/get/ensurePath 响应不含)", async function () {
  var db = createMemoryDb();
  var deps = itemsDeps(db, HOUSEHOLD_A);
  await itemsHandler({ action: "create", operation_id: "lst-op-1", name: "钥匙", location_text: "玄关" }, deps);

  var listed = await itemsHandler({ action: "list" }, deps);
  assert.equal(listed.ok, true);
  assert.equal(listed.household_id, HOUSEHOLD_A);
  // 投影条目仍不含任何内部字段
  assert.equal(listed.items[0].household_id, undefined);

  var queried = await itemsHandler({ action: "query", q: "钥匙" }, deps);
  assert.equal(queried.ok, true);
  assert.equal(queried.household_id, undefined, "query 响应不携带 household_id(仅 list)");

  var got = await itemsHandler({ action: "get", item_id: (await rawDocs(db, "items")).data[0]._id }, deps);
  assert.equal(got.ok, true);
  assert.equal(got.household_id, undefined, "get 响应不携带 household_id(仅 list)");

  var locDb = createMemoryDb({ uniqueIndexes: { locations: [["household_id", "parent_id", "name_norm"]] } });
  var locListed = await locHandler({ action: "list" }, locsDeps(locDb, HOUSEHOLD_A));
  assert.equal(locListed.ok, true);
  assert.equal(locListed.household_id, HOUSEHOLD_A);

  var ensured = await locHandler({ action: "ensurePath", path: ["书房"] }, locsDeps(locDb, HOUSEHOLD_A));
  assert.equal(ensured.ok, true);
  assert.equal(ensured.household_id, undefined, "ensurePath 响应不携带 household_id(仅 list)");
});
