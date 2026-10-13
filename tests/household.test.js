"use strict";

/**
 * issue #34 P0+P1-A(家庭共享 v0)离线合同测试:
 * - HH-SRC:lib/household.js 三副本(itemsApi 源 + locations/households 副本)
 *   逐字节防漂移(照 tests/locations.test.js TS-SRC 模式);
 * - HH-RSLV:可信家庭三向验证(活跃指针 → 有效会员 → 家庭未解散)——
 *   active 命中共享家庭 / 无 active 回退个人 / 查询异常失败关闭 / 孤儿指针
 *   失败关闭 / 已解散家庭失败关闭 / households 元数据缺或非法失败关闭(P0-4
 *   + P1 硬门 A,逐分支锁定),外加指针不唯一、指针字段非法、role 非法;
 * - HH-GLUE:index.js 胶水层接入解析:共享家庭定向写入、失败关闭零写入、
 *   个人家庭回退与存量算法逐字节一致、list 响应带 household_id(共享另带
 *   scope_revision)、共享态写硬门(FAMILY_SWITCHED / FAMILY_STALE_SCOPE);
 * - HH-F2:写入硬门——共享家庭缺 expected_household_id → FAMILY_SWITCHED、
 *   expected_scope_revision 缺失/过期 → FAMILY_STALE_SCOPE(零写入)、一致放行;
 *   个人家庭维持 P0 宽松口径(缺省放行、携带则校验、revision 忽略零回归);
 * - HH-LST:两函数 list 响应 household_id 断言(仅 list 携带;scope_revision
 *   仅共享家庭携带)。
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

/**
 * 种下一个「三向验证通过」的共享家庭成员(P1-A 起 households 元数据行
 * 是解析的第三向):households(_id 即 household_id)+ active 指针 + 会员行。
 * opts:{ role, display_name, scope_revision, dissolved }
 */
async function seedMembership(db, openid, householdId, opts) {
  opts = opts || {};
  await db.collection("households").add({
    data: {
      _id: householdId,
      display_name: opts.display_name || "我的家",
      dissolved: opts.dissolved === true,
      scope_revision: opts.scope_revision || 1,
      created_at: "2026-10-13T00:00:00.000Z"
    }
  });
  await db.collection("active_household").add({
    data: { member_key: household.memberKeyOf(openid), household_id: householdId, updated_at: "2026-10-13T00:00:00.000Z" }
  });
  await db.collection("household_members").add({
    data: {
      household_id: householdId,
      member_key: household.memberKeyOf(openid),
      role: opts.role || "owner",
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

// ---------- HH-SRC:三副本同源(照 TS-SRC 模式) ----------

test("HH-SRC:lib/household.js 三副本(locations/households)剥离声明头后与源文件逐字节一致,声明头含同源与三方同步标记", function () {
  var marker = "---- 副本正文(与源文件逐字节一致)----";
  var source = fs.readFileSync(path.join(ROOT, "cloudfunctions", "itemsApi", "lib", "household.js"), "utf8");
  var copies = [
    ["locations", path.join(ROOT, "cloudfunctions", "locations", "lib", "household.js")],
    ["households", path.join(ROOT, "cloudfunctions", "households", "lib", "household.js")]
  ];
  for (var i = 0; i < copies.length; i++) {
    var name = copies[i][0];
    var copy = fs.readFileSync(copies[i][1], "utf8");
    var idx = copy.indexOf(marker);
    assert.notStrictEqual(idx, -1, name + " 副本应含同源声明分界标记");
    var header = copy.slice(0, idx);
    assert.ok(header.indexOf("逐字节") !== -1, name + " 声明头应标明逐字节同源");
    assert.ok(header.indexOf("三方同步") !== -1, name + " 声明头应含三方同步要求");
    var commentEnd = copy.indexOf("*/", idx);
    assert.notStrictEqual(commentEnd, -1, name + " 声明头应闭合");
    var body = copy.slice(copy.indexOf("\n", commentEnd) + 1);
    assert.strictEqual(body, source, name + " 副本正文应与源文件逐字节一致(防漂移)");
  }
});

// ---------- HH-RSLV:解析四分支 + 防御分支 ----------

test("HH-RSLV-1:三向验证通过 → 返回该共享 household_id 与 shared/scope_revision/role/display_name", async function () {
  var db = createMemoryDb();
  await seedMembership(db, "o-member-1", SHARED_1, { scope_revision: 4, display_name: "山脚的家" });
  var res = await household.resolveActiveHousehold(db, "o-member-1");
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.householdId, SHARED_1);
  assert.equal(res.shared, true);
  assert.equal(res.scopeRevision, 4);
  assert.equal(res.role, "owner");
  assert.equal(res.displayName, "山脚的家");
});

test("HH-RSLV-2:无 active 记录 → 回退个人家庭(存量算法逐字节不变)且不写新集合", async function () {
  var db = createMemoryDb();
  var res = await household.resolveActiveHousehold(db, "o-single-1");
  assert.equal(res.ok, true);
  assert.equal(res.householdId, "hh_" + sha256("o-single-1").slice(0, 32));
  assert.equal(res.shared, false);
  assert.equal(res.scopeRevision, null);
  assert.equal(res.role, null);
  assert.equal(res.displayName, null);
  // 存量算法收口断言:personalHouseholdId 与旧 index.js 内联派生完全一致
  assert.equal(res.householdId, household.personalHouseholdId("o-single-1"));
  // 解析绝不写入任何新集合(解析只读;写入路径在 households 函数)
  assert.equal((await rawDocs(db, "active_household")).data.length, 0);
  assert.equal((await rawDocs(db, "household_members")).data.length, 0);
  assert.equal((await rawDocs(db, "households")).data.length, 0);
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

// ---------- HH-RSLV 三向验证第三向(P1 硬门 A 第 1 条,不能遗漏) ----------

test("HH-RSLV-8:家庭已解散(dissolved=true)→ HOUSEHOLD_UNAVAILABLE 失败关闭,绝不回退个人家庭", async function () {
  var db = createMemoryDb();
  await seedMembership(db, "o-sealed-1", SHARED_1, { dissolved: true });
  var res = await household.resolveActiveHousehold(db, "o-sealed-1");
  assert.equal(res.ok, false);
  assert.equal(res.error, "HOUSEHOLD_UNAVAILABLE");
  assert.equal(res.reason, "household_dissolved");
  assert.equal(res.householdId, undefined);
});

test("HH-RSLV-9:households 元数据行缺失(会员行在)→ 失败关闭,绝不当作已解散或个人家庭", async function () {
  var db = createMemoryDb();
  await db.collection("active_household").add({
    data: { member_key: household.memberKeyOf("o-nodoc-1"), household_id: SHARED_1, updated_at: "t" }
  });
  await db.collection("household_members").add({
    data: { household_id: SHARED_1, member_key: household.memberKeyOf("o-nodoc-1"), role: "member", joined_at: "t", invited_by: null }
  });
  var res = await household.resolveActiveHousehold(db, "o-nodoc-1");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "household_doc_missing");
});

test("HH-RSLV-10:households 集合查询异常 → 失败关闭", async function () {
  var db = createMemoryDb();
  await seedMembership(db, "o-hhf-1", SHARED_1);
  var broken = throwingCollectionDb(db, "households");
  var res = await household.resolveActiveHousehold(broken, "o-hhf-1");
  assert.equal(res.ok, false);
  assert.equal(res.error, "HOUSEHOLD_UNAVAILABLE");
  assert.equal(res.reason, "household_query_failed");
  assert.equal(res.householdId, undefined);
});

test("HH-RSLV-11:households 字段非法(dissolved 非布尔/scope_revision 非正整数)或会员 role 非法 → 失败关闭", async function () {
  var db = createMemoryDb();
  await seedMembership(db, "o-bad-rev", SHARED_1);
  await db.collection("households").where({ _id: SHARED_1 }).update({ data: { scope_revision: "3" } });
  var badRev = await household.resolveActiveHousehold(db, "o-bad-rev");
  assert.equal(badRev.ok, false);
  assert.equal(badRev.reason, "household_invalid_state");

  var db2 = createMemoryDb();
  await seedMembership(db2, "o-bad-dis", SHARED_1);
  await db2.collection("households").where({ _id: SHARED_1 }).update({ data: { dissolved: "no" } });
  var badDis = await household.resolveActiveHousehold(db2, "o-bad-dis");
  assert.equal(badDis.ok, false);
  assert.equal(badDis.reason, "household_invalid_state");

  var db3 = createMemoryDb();
  await seedMembership(db3, "o-bad-role", SHARED_1);
  await db3.collection("household_members").where({ _id: (await rawDocs(db3, "household_members")).data[0]._id }).update({ data: { role: "admin" } });
  var badRole = await household.resolveActiveHousehold(db3, "o-bad-role");
  assert.equal(badRole.ok, false);
  assert.equal(badRole.reason, "member_invalid_role");
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

test("HH-GLUE-1:itemsApi 胶水层命中共享家庭 → 携带一致 marker 时写入与 list 响应都定向共享域", async function () {
  var db = createMemoryDb();
  await seedMembership(db, "o-shared-user", SHARED_1);
  var stub = makeItemsApiStub("o-shared-user", db);
  var entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "itemsApi", "index.js"), stub.sdk);

  // P1-A 起共享家庭写操作必须携带一致 marker(缺省拒绝见 HH-GLUE-4)
  var created = await entry.main({
    action: "create",
    operation_id: "hh-glue-op-1",
    name: "共享家钥匙",
    location_text: "客厅抽屉",
    expected_household_id: SHARED_1,
    expected_scope_revision: 1
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

test("HH-GLUE-4:itemsApi 胶水层共享家庭写硬门——缺 expected_household_id → FAMILY_SWITCHED 零写入;旧 scope_revision → FAMILY_STALE_SCOPE 零写入;一致 → 写入共享域且 list 带 scope_revision", async function () {
  var db = createMemoryDb();
  await seedMembership(db, "o-hard-gate", SHARED_1, { scope_revision: 5, role: "member" });
  var stub = makeItemsApiStub("o-hard-gate", db);
  var entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "itemsApi", "index.js"), stub.sdk);

  // 缺 expected_household_id(共享态):FAMILY_SWITCHED、零写入(P1 硬门 B 第 1 条)
  var noMarker = await entry.main({
    action: "create",
    operation_id: "glue-gate-op-1",
    name: "不应写入",
    location_text: "x"
  });
  assert.equal(noMarker.ok, false);
  assert.equal(noMarker.error, "FAMILY_SWITCHED");
  assert.equal(typeof noMarker.message, "string");
  assert.equal((await rawDocs(db, "items")).data.length, 0);

  // household_id 一致但缺 scope_revision:FAMILY_STALE_SCOPE、零写入
  var noRev = await entry.main({
    action: "create",
    operation_id: "glue-gate-op-2",
    name: "不应写入",
    location_text: "x",
    expected_household_id: SHARED_1
  });
  assert.equal(noRev.ok, false);
  assert.equal(noRev.error, "FAMILY_STALE_SCOPE");
  assert.equal((await rawDocs(db, "items")).data.length, 0);

  // 旧 scope_revision(成员变更后的过窗请求):FAMILY_STALE_SCOPE、零写入
  var staleRev = await entry.main({
    action: "create",
    operation_id: "glue-gate-op-3",
    name: "不应写入",
    location_text: "x",
    expected_household_id: SHARED_1,
    expected_scope_revision: 4
  });
  assert.equal(staleRev.ok, false);
  assert.equal(staleRev.error, "FAMILY_STALE_SCOPE");
  assert.equal((await rawDocs(db, "items")).data.length, 0);

  // 两 marker 一致:放行,写入共享域
  var okWrite = await entry.main({
    action: "create",
    operation_id: "glue-gate-op-4",
    name: "共享家钥匙",
    location_text: "客厅抽屉",
    expected_household_id: SHARED_1,
    expected_scope_revision: 5
  });
  assert.equal(okWrite.ok, true, JSON.stringify(okWrite));
  var stored = await rawDocs(db, "items");
  assert.equal(stored.data.length, 1);
  assert.equal(stored.data[0].household_id, SHARED_1);

  // list 响应:共享家庭携带 household_id + scope_revision
  var listed = await entry.main({ action: "list" });
  assert.equal(listed.ok, true);
  assert.equal(listed.household_id, SHARED_1);
  assert.equal(listed.scope_revision, 5);
});

test("HH-GLUE-5:locations 胶水层共享家庭写硬门与 list scope_revision;个人家庭 list 无 scope_revision", async function () {
  var db = createMemoryDb({ uniqueIndexes: { locations: [["household_id", "parent_id", "name_norm"]] } });
  await seedMembership(db, "o-loc-gate", SHARED_1, { scope_revision: 2 });
  var stub = makeLocationsStub("o-loc-gate", db);
  var entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "locations", "index.js"), stub.sdk);

  var noMarker = await entry.main({ action: "ensurePath", path: ["书房"] });
  assert.equal(noMarker.ok, false);
  assert.equal(noMarker.error, "FAMILY_SWITCHED");
  assert.equal((await rawDocs(db, "locations")).data.length, 0, "缺 marker 必须零写入(不建 home 根)");

  var stale = await entry.main({
    action: "ensurePath",
    path: ["书房"],
    expected_household_id: SHARED_1,
    expected_scope_revision: 1
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "FAMILY_STALE_SCOPE");
  assert.equal((await rawDocs(db, "locations")).data.length, 0);

  var okWrite = await entry.main({
    action: "ensurePath",
    path: ["书房"],
    expected_household_id: SHARED_1,
    expected_scope_revision: 2
  });
  assert.equal(okWrite.ok, true, JSON.stringify(okWrite));

  var listed = await entry.main({ action: "list" });
  assert.equal(listed.ok, true);
  assert.equal(listed.household_id, SHARED_1);
  assert.equal(listed.scope_revision, 2);

  // 个人家庭:list 带 household_id、不带 scope_revision(单人零回归)
  var db2 = createMemoryDb({ uniqueIndexes: { locations: [["household_id", "parent_id", "name_norm"]] } });
  var stub2 = makeLocationsStub("o-loc-single", db2);
  var entry2 = loadCloudFunction(path.join(ROOT, "cloudfunctions", "locations", "index.js"), stub2.sdk);
  var listed2 = await entry2.main({ action: "list" });
  assert.equal(listed2.ok, true);
  assert.equal(listed2.household_id, "hh_" + sha256("o-loc-single").slice(0, 32));
  assert.equal(listed2.scope_revision, undefined, "个人家庭 list 不携带 scope_revision");
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

  // 个人家庭对 expected_scope_revision 无语义:携带任意值一律忽略(P0 宽松口径零回归)
  var withRev = await itemsHandler(
    { action: "create", operation_id: "f2-op-5", name: "温度计", location_text: "药箱", expected_scope_revision: 99 },
    deps
  );
  assert.equal(withRev.ok, true, "个人家庭携带 expected_scope_revision 不得拒绝");
  assert.equal((await rawDocs(db, "items")).data.length, 3);
});

test("HH-F2-SHARED-ITEMS:共享家庭硬门——缺 household_id → FAMILY_SWITCHED;缺/旧 scope_revision → FAMILY_STALE_SCOPE;类型非法 → INVALID_INPUT;全部零写入", async function () {
  var db = createMemoryDb();
  var deps = {
    db: db,
    now: function () {
      return "2026-10-13T00:00:00.000Z";
    },
    genId: function () {
      return "g1";
    },
    householdId: SHARED_1,
    householdShared: true,
    scopeRevision: 7,
    logger: { log: function () {} }
  };

  var cases = [
    [{ action: "create", operation_id: "sg-1", name: "x", location_text: "y" }, "FAMILY_SWITCHED"],
    [{ action: "create", operation_id: "sg-2", name: "x", location_text: "y", expected_household_id: "hh_other" }, "FAMILY_SWITCHED"],
    [{ action: "create", operation_id: "sg-3", name: "x", location_text: "y", expected_household_id: SHARED_1 }, "FAMILY_STALE_SCOPE"],
    [{ action: "create", operation_id: "sg-4", name: "x", location_text: "y", expected_household_id: SHARED_1, expected_scope_revision: 6 }, "FAMILY_STALE_SCOPE"],
    [{ action: "create", operation_id: "sg-5", name: "x", location_text: "y", expected_household_id: SHARED_1, expected_scope_revision: 8 }, "FAMILY_STALE_SCOPE"],
    [{ action: "create", operation_id: "sg-6", name: "x", location_text: "y", expected_household_id: 42 }, "INVALID_INPUT"],
    [{ action: "create", operation_id: "sg-7", name: "x", location_text: "y", expected_household_id: SHARED_1, expected_scope_revision: "7" }, "INVALID_INPUT"]
  ];
  for (var i = 0; i < cases.length; i++) {
    var res = await itemsHandler(cases[i][0], deps);
    assert.equal(res.ok, false, "case " + i + " 应被拒绝");
    assert.equal(res.error, cases[i][1], "case " + i + " 错误码");
    assert.equal(typeof res.message, "string", "case " + i + " 应有中文提示");
  }
  assert.equal((await rawDocs(db, "items")).data.length, 0, "硬门拒绝必须零写入");

  // 一致:放行
  var ok = await itemsHandler(
    {
      action: "create",
      operation_id: "sg-ok",
      name: "护照",
      location_text: "书房抽屉",
      expected_household_id: SHARED_1,
      expected_scope_revision: 7
    },
    deps
  );
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal((await rawDocs(db, "items")).data.length, 1);

  // update/delete 同为写路径:旧 revision 同样拦截(零改动)
  var item = (await rawDocs(db, "items")).data[0];
  var staleUpd = await itemsHandler(
    { action: "update", item_id: item._id, expected_version: 1, name: "改名", expected_household_id: SHARED_1, expected_scope_revision: 6 },
    deps
  );
  assert.equal(staleUpd.error, "FAMILY_STALE_SCOPE");
  var after = (await db.collection("items").doc(item._id).get()).data;
  assert.equal(after.name, "护照", "被拦截的 update 不得改动内容");
});

test("HH-F2-SHARED-LOCS:共享家庭硬门覆盖全部位置树写入口(ensurePath/linkItem 双代表),list 响应带 scope_revision", async function () {
  var db = createMemoryDb({ uniqueIndexes: { locations: [["household_id", "parent_id", "name_norm"]] } });
  var deps = {
    db: db,
    now: function () {
      return "2026-10-13T00:00:00.000Z";
    },
    genId: function () {
      return "l1";
    },
    digest: digest16,
    householdId: SHARED_1,
    householdShared: true,
    scopeRevision: 3,
    logger: { log: function () {} }
  };

  var noMarker = await locHandler({ action: "ensurePath", path: ["书房"] }, deps);
  assert.equal(noMarker.ok, false);
  assert.equal(noMarker.error, "FAMILY_SWITCHED");
  var stale = await locHandler(
    { action: "ensurePath", path: ["书房"], expected_household_id: SHARED_1, expected_scope_revision: 2 },
    deps
  );
  assert.equal(stale.error, "FAMILY_STALE_SCOPE");
  assert.equal((await rawDocs(db, "locations")).data.length, 0, "硬门拒绝不建 home 根");

  var ok = await locHandler(
    { action: "ensurePath", path: ["书房"], expected_household_id: SHARED_1, expected_scope_revision: 3 },
    deps
  );
  assert.equal(ok.ok, true, JSON.stringify(ok));

  // linkItem 写路径:先造物品(同家庭、经硬门),再验证旧 revision 拦截且版本不动
  var itemDeps = {
    db: db,
    now: function () {
      return "2026-10-13T00:00:00.000Z";
    },
    genId: function () {
      return "g9";
    },
    householdId: SHARED_1,
    householdShared: true,
    scopeRevision: 3,
    logger: { log: function () {} }
  };
  var created = await itemsHandler(
    { action: "create", operation_id: "sg-loc-1", name: "充电宝", location_text: "书房", expected_household_id: SHARED_1, expected_scope_revision: 3 },
    itemDeps
  );
  assert.equal(created.ok, true);
  var node = (await rawDocs(db, "locations")).data.find(function (n) {
    return n.name === "书房";
  });
  var staleLink = await locHandler(
    {
      action: "linkItem",
      item_id: created.item.item_id,
      node_id: node._id,
      expected_version: 1,
      update_id: "u-sg-1",
      expected_household_id: SHARED_1,
      expected_scope_revision: 2
    },
    deps
  );
  assert.equal(staleLink.error, "FAMILY_STALE_SCOPE");
  var itemDoc = (await db.collection("items").doc(created.item.item_id).get()).data;
  assert.equal(itemDoc.version, 1, "被拦截的 linkItem 不得推进版本");

  // 只读 list 不参与校验,响应含 household_id + scope_revision
  var listed = await locHandler({ action: "list" }, deps);
  assert.equal(listed.ok, true);
  assert.equal(listed.household_id, SHARED_1);
  assert.equal(listed.scope_revision, 3);
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

test("HH-LST:两函数 list 响应携带 household_id 且仅 list 携带(query/get/ensurePath 响应不含);scope_revision 仅共享家庭携带", async function () {
  var db = createMemoryDb();
  var deps = itemsDeps(db, HOUSEHOLD_A);
  await itemsHandler({ action: "create", operation_id: "lst-op-1", name: "钥匙", location_text: "玄关" }, deps);

  var listed = await itemsHandler({ action: "list" }, deps);
  assert.equal(listed.ok, true);
  assert.equal(listed.household_id, HOUSEHOLD_A);
  assert.equal(listed.scope_revision, undefined, "个人家庭 list 不携带 scope_revision");
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
  assert.equal(locListed.scope_revision, undefined, "个人家庭 locations.list 不携带 scope_revision");

  var ensured = await locHandler({ action: "ensurePath", path: ["书房"] }, locsDeps(locDb, HOUSEHOLD_A));
  assert.equal(ensured.ok, true);
  assert.equal(ensured.household_id, undefined, "ensurePath 响应不携带 household_id(仅 list)");
});
