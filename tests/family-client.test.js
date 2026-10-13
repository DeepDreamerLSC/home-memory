"use strict";

/**
 * issue #34 P1-B(家庭共享客户端:作用域升级/写绑定/资格复核/错误分类/零写入
 * e2e)的离线测试。被测对象是 `npm run build:mp` 产出的编译产物(pretest 已
 * 保证先编译),零外部依赖。
 *
 * 覆盖:
 * - HFB-CAP:作用域捕获升级——list 响应附带 scope_revision → 共享态+修订号;
 *   缺省 → 个人态;"hh_f_" 前缀推断;P0 纯字符串 storage 记忆兼容还原;
 *   作用域代数只在 id 变化时递增;非法修订号忽略;
 * - HFB-BIND:F2 写绑定参数拼装——共享态写请求自动附 expected_household_id
 *   + expected_scope_revision;个人态只附 expected_household_id;未捕获不带
 *   (与 0.4.7 逐字节一致);只读 action 不绑定;
 * - HFB-VERIFY:资格复核判定(硬门 C)——服务端 active 与本地不一致 → 漂移
 *   回调 + 捕获新作用域 + 缓存清空(失效代数递增);一致 → 无漂移;storage
 *   还原不算已验证;服务端异常 → 保持未验证;
 * - HFB-ERR:错误分类与漂移处置——FAMILY_SWITCHED/FAMILY_STALE_SCOPE 抛
 *   ApiError(服务端中文文案)并触发 households.status 刷新(绝不静默重试
 *   原写请求);刷新捕获新修订号后下一次写自动带新值;非家庭类错误不触发;
 * - HFB-API:households-api 封装——join 成功捕获共享作用域+清缓存;leave
 *   后追加 status 捕获个人作用域;服务端 message 缺失时兜底文案;
 * - HFB-DRAFT:草稿按家庭键隔离沿用——加入后个人草稿不可见,退出回切恢复;
 * - HFB-E2E:零写入 e2e(households mock 层 + 真服务端 handler + memoryDb):
 *   创建 → 邀请 → 加入 → 双方带绑定写入共享域 → owner 移除成员 → 被移除方
 *   旧作用域写请求被服务端硬门拒绝(零写入共享域)→ 漂移刷新回个人家庭 →
 *   重试写入落在个人域。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("node:crypto");

var householdScope = require("../miniprogram/utils/household-scope.js");
var cache = require("../miniprogram/utils/locations-cache.js");
var ds = require("../miniprogram/utils/draft-session.js");
var itemsApi = require("../miniprogram/utils/api.js");
var locationsApi = require("../miniprogram/utils/locations-api.js");
var householdsApi = require("../miniprogram/utils/households-api.js");
var householdLib = require("../cloudfunctions/itemsApi/lib/household");
var hhHandler = require("../cloudfunctions/households/lib/handler").handler;
var itemsHandler = require("../cloudfunctions/itemsApi/lib/handler").handler;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

var SCOPE_KEY = "home-memory:household-scope";
var T0 = Date.now();

function sha256hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function makeFakeStorage() {
  var store = {};
  return {
    getStorageSync: function (k) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : "";
    },
    setStorageSync: function (k, v) {
      store[k] = v;
    },
    removeStorageSync: function (k) {
      delete store[k];
    },
    __dump: function () {
      return store;
    },
    __set: function (k, v) {
      store[k] = v;
    }
  };
}

function setup() {
  var storage = makeFakeStorage();
  householdScope.__setHouseholdScopeStorageForTest(storage);
  cache.__setLocationsCacheStorageForTest(storage);
  ds.__setDraftSessionStorageForTest(storage);
  return storage;
}

function teardown() {
  householdScope.__resetHouseholdScopeForTest();
  cache.__resetLocationsCacheForTest();
  ds.__resetDraftSessionForTest();
  if (typeof globalThis.wx !== "undefined") {
    delete globalThis.wx;
  }
}

/** 安装 wx.cloud.callFunction mock:router(name, data) 可同步或返回 Promise */
function installWxCloud(router) {
  globalThis.wx = {
    cloud: {
      callFunction: function (opts) {
        Promise.resolve().then(function () {
          return router(opts.name, opts.data);
        }).then(
          function (result) {
            opts.success({ result: result });
          },
          function (err) {
            opts.fail({ errMsg: String((err && err.message) || err) });
          }
        );
      }
    }
  };
}

function tick(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms || 10);
  });
}

function makeDrafts() {
  return [
    {
      name: "护照",
      location_text: "书房抽屉",
      certain: true,
      qualifiers: [],
      source_quote: "护照在书房抽屉"
    }
  ];
}

// ---------- HFB-CAP:作用域捕获升级 ----------

test("HFB-CAP-1:list 响应携带 scope_revision → 捕获共享态+修订号,写标记两件齐", function () {
  setup();
  try {
    var changed = householdScope.captureHouseholdId("hh_f_shared0001", 3);
    assert.equal(changed, true, "首次捕获即作用域变化");
    assert.equal(householdScope.householdScopeId(), "hh_f_shared0001");
    assert.equal(householdScope.isHouseholdScopeShared(), true);
    assert.deepEqual(householdScope.scopeWriteMarkers(), {
      expected_household_id: "hh_f_shared0001",
      expected_scope_revision: 3
    });
  } finally {
    teardown();
  }
});

test("HFB-CAP-2:个人家庭(无修订号、非 hh_f_ 前缀)→ 共享=false,写标记只带 household_id", function () {
  setup();
  try {
    householdScope.captureHouseholdId("hh_abc123def456abc123def456abc12345");
    assert.equal(householdScope.isHouseholdScopeShared(), false);
    assert.deepEqual(householdScope.scopeWriteMarkers(), {
      expected_household_id: "hh_abc123def456abc123def456abc12345"
    });
  } finally {
    teardown();
  }
});

test("HFB-CAP-3:hh_f_ 前缀但修订号未知 → 推断共享,绝不编造修订号(服务端会拒并走刷新)", function () {
  setup();
  try {
    householdScope.captureHouseholdId("hh_f_norev0000000001");
    assert.equal(householdScope.isHouseholdScopeShared(), true);
    assert.deepEqual(householdScope.scopeWriteMarkers(), {
      expected_household_id: "hh_f_norev0000000001"
    });
  } finally {
    teardown();
  }
});

test("HFB-CAP-4:P0 纯字符串 storage 记忆兼容还原:共享性按前缀推断、修订号未知", function () {
  var storage = setup();
  try {
    storage.__set(SCOPE_KEY, "hh_f_legacy00000001");
    householdScope.__resetHouseholdScopeForTest();
    householdScope.__setHouseholdScopeStorageForTest(storage);
    assert.equal(householdScope.householdScopeId(), "hh_f_legacy00000001");
    assert.equal(householdScope.isHouseholdScopeShared(), true);
    assert.deepEqual(householdScope.scopeWriteMarkers(), {
      expected_household_id: "hh_f_legacy00000001"
    });
  } finally {
    teardown();
  }
});

test("HFB-CAP-5:作用域代数只在 id 变化时递增;同 id 修订号刷新不递增(成员变更≠切换)", function () {
  setup();
  try {
    householdScope.captureHouseholdId("hh_f_a", 1);
    var g1 = householdScope.captureScopeGeneration();
    householdScope.captureHouseholdId("hh_f_a", 2); // 同家庭,他人加入 → 修订号 +1
    assert.equal(householdScope.captureScopeGeneration(), g1, "同家庭修订号刷新不算切换");
    assert.deepEqual(householdScope.scopeWriteMarkers(), {
      expected_household_id: "hh_f_a",
      expected_scope_revision: 2
    });
    householdScope.captureHouseholdId("hh_f_b", 1); // 换家庭
    assert.equal(householdScope.captureScopeGeneration(), g1 + 1, "id 变化递增作用域代数");
    assert.equal(householdScope.isScopeGenerationCurrent(g1), false);
  } finally {
    teardown();
  }
});

test("HFB-CAP-6:非法修订号(非整数/负数/0)忽略,按缺省处理", function () {
  setup();
  try {
    householdScope.captureHouseholdId("hh_f_x", 1.5);
    householdScope.captureHouseholdId("hh_f_x", 0);
    householdScope.captureHouseholdId("hh_f_x", -2);
    householdScope.captureHouseholdId("hh_f_x", "3");
    assert.deepEqual(householdScope.scopeWriteMarkers(), {
      expected_household_id: "hh_f_x"
    });
  } finally {
    teardown();
  }
});

// ---------- HFB-BIND:F2 写绑定参数拼装 ----------

test("HFB-BIND-1:共享态 itemsApi 写请求自动附双 marker;get/list 只读不绑定", async function () {
  setup();
  try {
    householdScope.captureHouseholdId("hh_f_bind000001", 7);
    var seen = [];
    installWxCloud(function (name, data) {
      seen.push({ name: name, data: data });
      if (data.action === "create") {
        return { ok: true, item: { item_id: "it_1" }, duplicated: false };
      }
      if (data.action === "get") {
        return { ok: true, item: { item_id: "it_1" } };
      }
      return { ok: true, household_id: "hh_f_bind000001", scope_revision: 7, items: [] };
    });
    await itemsApi.callItemsApi({
      action: "create",
      operation_id: "op-bind-1",
      name: "充电宝",
      location_text: "书房抽屉"
    });
    assert.deepEqual(seen[0].data, {
      action: "create",
      operation_id: "op-bind-1",
      name: "充电宝",
      location_text: "书房抽屉",
      expected_household_id: "hh_f_bind000001",
      expected_scope_revision: 7
    });
    await itemsApi.callItemsApi({ action: "get", item_id: "it_1" });
    assert.equal(
      "expected_household_id" in seen[1].data, false, "只读 action 不携带绑定"
    );
    await itemsApi.callItemsApi({ action: "list" });
    assert.equal("expected_household_id" in seen[2].data, false);
  } finally {
    teardown();
  }
});

test("HFB-BIND-2:个人态写请求只附 expected_household_id(携带则校验的服务端口径)", async function () {
  setup();
  try {
    householdScope.captureHouseholdId("hh_personal111111111111111111111111111");
    var seen = [];
    installWxCloud(function (name, data) {
      seen.push(data);
      return { ok: true, item: { item_id: "it_2" }, duplicated: false };
    });
    await itemsApi.callItemsApi({
      action: "delete",
      item_id: "it_2"
    });
    assert.deepEqual(seen[0], {
      action: "delete",
      item_id: "it_2",
      expected_household_id: "hh_personal111111111111111111111111111"
    });
  } finally {
    teardown();
  }
});

test("HFB-BIND-3:未捕获(旧云函数窗口/单人首启)写请求不带 marker,与 0.4.7 逐字节一致", async function () {
  setup();
  try {
    var seen = [];
    installWxCloud(function (name, data) {
      seen.push(data);
      return { ok: true, item: { item_id: "it_3" }, duplicated: false };
    });
    await itemsApi.callItemsApi({
      action: "create",
      operation_id: "op-bind-3",
      name: "钥匙",
      location_text: "玄关碗"
    });
    assert.deepEqual(seen[0], {
      action: "create",
      operation_id: "op-bind-3",
      name: "钥匙",
      location_text: "玄关碗"
    });
  } finally {
    teardown();
  }
});

test("HFB-BIND-4:locations 写类 action(ensurePath/rename)绑定,list 不绑定", async function () {
  setup();
  try {
    householdScope.captureHouseholdId("hh_f_bind000002", 4);
    var seen = [];
    installWxCloud(function (name, data) {
      seen.push(data);
      if (data.action === "ensurePath") {
        return { ok: true, nodes: [], created: [] };
      }
      if (data.action === "rename") {
        return { ok: true, node: { location_id: "n1", name: "x", type: "room", path: [] } };
      }
      return {
        ok: true,
        household_id: "hh_f_bind000002",
        scope_revision: 4,
        node: { location_id: "root", name: "家", type: "home", path: [] },
        children: [],
        items: [],
        unmounted_count: 0,
        dangling_mounts: 0
      };
    });
    await locationsApi.callLocationsApi({
      action: "ensurePath",
      path: ["书房", "书桌"]
    });
    assert.deepEqual(seen[0], {
      action: "ensurePath",
      path: ["书房", "书桌"],
      expected_household_id: "hh_f_bind000002",
      expected_scope_revision: 4
    });
    await locationsApi.callLocationsApi({
      action: "rename",
      node_id: "n1",
      name: "x"
    });
    assert.deepEqual(seen[1], {
      action: "rename",
      node_id: "n1",
      name: "x",
      expected_household_id: "hh_f_bind000002",
      expected_scope_revision: 4
    });
    await locationsApi.callLocationsApi({ action: "list" });
    assert.equal("expected_household_id" in seen[2], false);
  } finally {
    teardown();
  }
});

test("HFB-BIND-5:list 响应携带 household_id+scope_revision → 捕获共享态,后续写自动带修订号", async function () {
  setup();
  try {
    var n = 0;
    installWxCloud(function (name, data) {
      n += 1;
      if (data.action === "list") {
        return { ok: true, household_id: "hh_f_via_list", scope_revision: 9, items: [] };
      }
      return { ok: true, item: { item_id: "it_4" }, duplicated: false };
    });
    await itemsApi.callItemsApi({ action: "list" });
    assert.equal(householdScope.isHouseholdScopeShared(), true);
    await itemsApi.callItemsApi({
      action: "create",
      operation_id: "op-bind-5",
      name: "伞",
      location_text: "门口"
    });
    assert.equal(n, 2);
    assert.deepEqual(householdScope.scopeWriteMarkers(), {
      expected_household_id: "hh_f_via_list",
      expected_scope_revision: 9
    });
  } finally {
    teardown();
  }
});

// ---------- HFB-VERIFY:资格复核判定(硬门 C) ----------

test("HFB-VERIFY-1:本地共享作用域 vs 服务端个人 → 漂移回调+捕获新作用域+缓存失效代数递增+已验证", async function () {
  setup();
  try {
    householdScope.captureHouseholdScope("hh_f_gone", true, 5);
    cache.writeLocationsLayer("root", {
      ok: true,
      household_id: "hh_f_gone",
      node: { location_id: "root", name: "家", type: "home", path: [] },
      children: [],
      items: [],
      unmounted_count: 0,
      dangling_mounts: 0
    }, T0);
    var genBefore = cache.captureCacheGeneration();
    var drifts = [];
    installWxCloud(function (name, data) {
      assert.equal(name, "households");
      assert.deepEqual(data, { action: "status" });
      return {
        ok: true,
        household_id: "hh_personal_back",
        shared: false,
        role: null,
        scope_revision: null,
        display_name: null
      };
    });
    var status = await householdsApi.verifyHouseholdScope(function (d) {
      drifts.push(d);
    });
    assert.equal(status.shared, false);
    assert.equal(status.household_id, "hh_personal_back");
    assert.equal(drifts.length, 1);
    assert.deepEqual(drifts[0], {
      fromId: "hh_f_gone",
      toId: "hh_personal_back",
      fromShared: true,
      toShared: false
    });
    assert.equal(householdScope.householdScopeId(), "hh_personal_back");
    assert.equal(householdScope.isHouseholdScopeShared(), false);
    assert.ok(
      cache.captureCacheGeneration() > genBefore,
      "作用域切换显式接入失效代数(清缓存)"
    );
    assert.equal(householdScope.isScopeVerified(), true);
  } finally {
    teardown();
  }
});

test("HFB-VERIFY-2:服务端 active 与本地一致 → 无漂移回调,修订号刷新", async function () {
  setup();
  try {
    householdScope.captureHouseholdScope("hh_f_same", true, 5);
    var drifts = [];
    installWxCloud(function () {
      return {
        ok: true,
        household_id: "hh_f_same",
        shared: true,
        role: "member",
        scope_revision: 6,
        display_name: "我家"
      };
    });
    var status = await householdsApi.verifyHouseholdScope(function (d) {
      drifts.push(d);
    });
    assert.equal(drifts.length, 0);
    assert.equal(status.role, "member");
    assert.deepEqual(householdScope.scopeWriteMarkers(), {
      expected_household_id: "hh_f_same",
      expected_scope_revision: 6
    });
  } finally {
    teardown();
  }
});

test("HFB-VERIFY-3:storage 还原不算已验证;服务端捕获后才验证;invalidate 重置", async function () {
  var storage = setup();
  try {
    storage.__set(SCOPE_KEY, { id: "hh_f_stored", shared: true, revision: 2 });
    householdScope.__resetHouseholdScopeForTest();
    householdScope.__setHouseholdScopeStorageForTest(storage);
    assert.equal(householdScope.isScopeVerified(), false, "storage 记忆无服务端背书");
    installWxCloud(function () {
      return {
        ok: true,
        household_id: "hh_f_stored",
        shared: true,
        role: "owner",
        scope_revision: 2,
        display_name: "我家"
      };
    });
    await householdsApi.ensureScopeVerified();
    assert.equal(householdScope.isScopeVerified(), true);
    householdScope.invalidateScopeVerification();
    assert.equal(householdScope.isScopeVerified(), false, "前台切回重置验证");
  } finally {
    teardown();
  }
});

test("HFB-VERIFY-4:status 失败 → verify 抛错、ensureScopeVerified 返回 null 且保持未验证", async function () {
  setup();
  try {
    installWxCloud(function () {
      return { ok: false, error: "HOUSEHOLD_UNAVAILABLE", message: "暂时无法确认当前家庭,请稍后重试" };
    });
    await assert.rejects(
      function () {
        return householdsApi.verifyHouseholdScope();
      },
      function (e) {
        return e.code === "HOUSEHOLD_UNAVAILABLE";
      }
    );
    var r = await householdsApi.ensureScopeVerified();
    assert.equal(r, null);
    assert.equal(householdScope.isScopeVerified(), false, "失败绝不伪装已验证");
  } finally {
    teardown();
  }
});

// ---------- HFB-ERR:错误分类与漂移处置 ----------

test("HFB-ERR-1:FAMILY_STALE_SCOPE → ApiError 带服务端文案,触发 status 刷新,原写请求不重试", async function () {
  setup();
  try {
    householdScope.captureHouseholdScope("hh_f_drift", true, 5);
    var calls = [];
    installWxCloud(function (name, data) {
      calls.push(name + ":" + data.action);
      if (name === "itemsApi") {
        return {
          ok: false,
          error: "FAMILY_STALE_SCOPE",
          message: "家庭刚发生成员或作用域变化,本次操作未保存,请刷新后重试"
        };
      }
      return {
        ok: true,
        household_id: "hh_f_drift",
        shared: true,
        role: "member",
        scope_revision: 6,
        display_name: "我家"
      };
    });
    await assert.rejects(
      function () {
        return itemsApi.callItemsApi({
          action: "create",
          operation_id: "op-err-1",
          name: "x",
          location_text: "y"
        });
      },
      function (e) {
        return (
          e instanceof itemsApi.ApiError &&
          e.code === "FAMILY_STALE_SCOPE" &&
          e.message === "家庭刚发生成员或作用域变化,本次操作未保存,请刷新后重试"
        );
      }
    );
    await tick();
    assert.deepEqual(calls, ["itemsApi:create", "households:status"], "一次写 + 一次刷新,绝不重试写");
    assert.deepEqual(householdScope.scopeWriteMarkers(), {
      expected_household_id: "hh_f_drift",
      expected_scope_revision: 6
    }, "刷新捕获新修订号,用户重试即带新值");
  } finally {
    teardown();
  }
});

test("HFB-ERR-2:FAMILY_SWITCHED 同样触发刷新;非家庭类错误不触发", async function () {
  setup();
  try {
    householdScope.captureHouseholdScope("hh_f_drift2", true, 1);
    var calls = [];
    var rejectSwitched = true;
    installWxCloud(function (name, data) {
      calls.push(name + ":" + data.action);
      if (rejectSwitched) {
        return {
          ok: false,
          error: "FAMILY_SWITCHED",
          message: "家庭已切换,本次操作未保存,请确认当前家庭后重试"
        };
      }
      if (name === "households") {
        return {
          ok: true,
          household_id: "hh_f_drift2",
          shared: true,
          role: "member",
          scope_revision: 2,
          display_name: null
        };
      }
      return { ok: false, error: "NOT_FOUND", message: "没有找到这条记录" };
    });
    await assert.rejects(
      function () {
        return locationsApi.callLocationsApi({
          action: "rename",
          node_id: "n1",
          name: "新名"
        });
      },
      function (e) {
        return e.code === "FAMILY_SWITCHED";
      }
    );
    await tick();
    rejectSwitched = false;
    calls.length = 0;
    await assert.rejects(
      function () {
        return locationsApi.callLocationsApi({
          action: "delete",
          node_id: "n1"
        });
      },
      function (e) {
        return e.code === "NOT_FOUND";
      }
    );
    await tick();
    assert.deepEqual(calls, ["locations:delete"], "非家庭类错误不触发 status 刷新");
  } finally {
    teardown();
  }
});

// ---------- HFB-API:households-api 封装 ----------

test("HFB-API-1:join 成功(含幂等 already_member)→ 捕获共享作用域+清缓存", async function () {
  setup();
  try {
    var genBefore = cache.captureCacheGeneration();
    installWxCloud(function (name, data) {
      assert.deepEqual(data, { action: "join", token: "tok_minimum123456" });
      return {
        ok: true,
        joined: false,
        already_member: true,
        household_id: "hh_f_joined",
        display_name: "测试家",
        role: "member",
        scope_revision: 3
      };
    });
    var res = await householdsApi.joinFamily("tok_minimum123456");
    assert.equal(res.already_member, true);
    assert.equal(res.display_name, "测试家");
    assert.equal(householdScope.householdScopeId(), "hh_f_joined");
    assert.equal(householdScope.isHouseholdScopeShared(), true);
    assert.ok(cache.captureCacheGeneration() > genBefore, "加入切换作用域即清缓存");
  } finally {
    teardown();
  }
});

test("HFB-API-2:inviteInfo 失效 NOT_FOUND → ApiError 带服务端文案;message 缺失时用兜底文案", async function () {
  setup();
  try {
    var first = true;
    installWxCloud(function (name, data) {
      if (first) {
        first = false;
        return { ok: false, error: "NOT_FOUND", message: "邀请不存在或已失效" };
      }
      return { ok: false, error: "FORBIDDEN" };
    });
    await assert.rejects(
      function () {
        return householdsApi.fetchInviteInfo("tok_dead0000000000");
      },
      function (e) {
        return e.code === "NOT_FOUND" && e.message === "邀请不存在或已失效";
      }
    );
    await assert.rejects(
      function () {
        return householdsApi.fetchInviteInfo("tok_dead0000000000");
      },
      function (e) {
        return e.code === "FORBIDDEN" && e.message === "只有家庭创建者才能执行这个操作";
      }
    );
  } finally {
    teardown();
  }
});

test("HFB-API-3:leaveFamily 成功后追加 status 捕获个人作用域(调用序列 leave→status)", async function () {
  setup();
  try {
    householdScope.captureHouseholdScope("hh_f_leaving", true, 2);
    var calls = [];
    installWxCloud(function (name, data) {
      calls.push(name + ":" + data.action);
      if (data.action === "leave") {
        return { ok: true };
      }
      return {
        ok: true,
        household_id: "hh_personal_after",
        shared: false,
        role: null,
        scope_revision: null,
        display_name: null
      };
    });
    await householdsApi.leaveFamily();
    assert.deepEqual(calls, ["households:leave", "households:status"]);
    assert.equal(householdScope.householdScopeId(), "hh_personal_after");
    assert.equal(householdScope.isHouseholdScopeShared(), false);
  } finally {
    teardown();
  }
});

// ---------- HFB-DRAFT:草稿按家庭键隔离沿用 ----------

test("HFB-DRAFT:个人草稿在加入共享家庭后不可见,退出回切个人家庭即恢复", function () {
  setup();
  try {
    householdScope.captureHouseholdId("hh_personal_draft1111111111111111111111");
    var sid = ds.createDraftSession("个人原文", makeDrafts(), false);
    assert.ok(ds.getUnfinishedDraftSession() !== null);

    // 加入共享家庭(作用域切换):个人草稿键不可达,绝不自动迁移
    householdScope.captureHouseholdScope("hh_f_familydraft", true, 1);
    assert.equal(ds.getDraftSession(sid), null);
    assert.equal(ds.getUnfinishedDraftSession(), null, "首页横幅在新家庭不可见");
    ds.createDraftSession("共享原文", makeDrafts(), false);

    // 退出回个人家庭:个人草稿原地恢复,共享草稿不可见
    householdScope.captureHouseholdScope("hh_personal_draft1111111111111111111111", false, null);
    assert.ok(ds.getDraftSession(sid) !== null, "回切即恢复");
    assert.ok(ds.getUnfinishedDraftSession() !== null);
  } finally {
    teardown();
  }
});

// ---------- HFB-E2E:零写入 e2e(households mock 层 + 真服务端 handler) ----------

test("HFB-E2E-1:创建→邀请→加入→双端带绑定写入共享域→移除成员→旧作用域写被硬门拒绝→漂移回个人域", async function () {
  var storage = setup();
  try {
    var db = createMemoryDb({
      uniqueIndexes: {
        household_members: [["household_id", "member_key"]],
        active_household: [["member_key"]],
        household_invites: [["token_hash"]]
      }
    });
    var clock = { t: Date.parse("2026-10-13T12:00:00.000Z") };
    var idSeq = 0;
    var tokenSeq = 0;
    var currentOpenid = "openid-owner";

    function hhDeps(openid) {
      return householdLib.resolveActiveHousehold(db, openid).then(function (resolved) {
        return {
          db: db,
          now: function () {
            return new Date(clock.t).toISOString();
          },
          genId: function () {
            idSeq += 1;
            return "e2e" + idSeq;
          },
          genToken: function () {
            tokenSeq += 1;
            return "E2ETOKEN" + String(tokenSeq).padStart(6, "0") + "x".repeat(20);
          },
          sha256: sha256hex,
          memberKey: householdLib.memberKeyOf(openid),
          resolved: resolved,
          logger: { log: function () {} }
        };
      });
    }

    function itemsDeps(openid) {
      return householdLib.resolveActiveHousehold(db, openid).then(function (resolved) {
        var seq = 0;
        return {
          db: db,
          now: function () {
            clock.t += 1000;
            return new Date(clock.t).toISOString();
          },
          genId: function () {
            seq += 1;
            return "it_e2e_" + seq;
          },
          householdId: resolved.householdId,
          householdShared: resolved.shared === true,
          scopeRevision: resolved.shared === true ? resolved.scopeRevision : null,
          logger: { log: function () {} }
        };
      });
    }

    installWxCloud(function (name, data) {
      if (name === "households") {
        return hhDeps(currentOpenid).then(function (deps) {
          return hhHandler(data, deps);
        });
      }
      if (name === "itemsApi") {
        return itemsDeps(currentOpenid).then(function (deps) {
          return itemsHandler(data, deps);
        });
      }
      throw new Error("unexpected function " + name);
    });

    // 0)B 先在个人家庭写入一件(list 捕获 B 个人作用域——与真实 App 启动
    //   后首页 list 捕获路径同构)
    currentOpenid = "openid-b";
    var bPersonal = await itemsApi.callItemsApi({
      action: "create",
      operation_id: "op-b-personal",
      name: "B 的私人物品",
      location_text: "B 家抽屉"
    });
    assert.equal(bPersonal.ok, true);
    await itemsApi.callItemsApi({ action: "list" });
    var bPersonalHousehold = householdScope.householdScopeId();
    assert.notEqual(bPersonalHousehold.indexOf("hh_f_"), 0, "B 初始为个人家庭");

    // 1)owner 创建共享家庭(客户端捕获共享作用域+修订号 1)
    currentOpenid = "openid-owner";
    var created = await householdsApi.createFamily("测试家");
    assert.equal(created.role, "owner");
    assert.equal(created.scope_revision, 1);
    var familyId = created.household_id;
    assert.equal(familyId.indexOf("hh_f_"), 0);

    // 2)owner 生成邀请 → inviteInfo 预检
    var invite = await householdsApi.createInvite();
    assert.ok(invite.token.length >= 16);
    var info = await householdsApi.fetchInviteInfo(invite.token);
    assert.equal(info.display_name, "测试家");

    // 3)owner 带绑定写入共享域(自动 marker:hh_f_* + revision 1)
    await itemsApi.callItemsApi({
      action: "create",
      operation_id: "op-owner-shared",
      name: "owner 的共享物品",
      location_text: "客厅柜子"
    });
    var sharedItems = (await db.collection("items")
      .where({ household_id: familyId })
      .get()).data;
    assert.equal(sharedItems.length, 1, "owner 写入落在共享家庭域");

    // 4)B 凭令牌加入(服务端真实校验+幂等语义;客户端捕获共享作用域)
    currentOpenid = "openid-b";
    var joined = await householdsApi.joinFamily(invite.token);
    assert.equal(joined.joined, true);
    assert.equal(joined.role, "member");
    assert.equal(householdScope.householdScopeId(), familyId, "B 客户端作用域切到共享家庭");

    // 5)B 带绑定写入共享域(服务端硬门校验 expected_household_id+revision 通过)
    await itemsApi.callItemsApi({
      action: "create",
      operation_id: "op-b-shared",
      name: "B 的共享物品",
      location_text: "书房架子"
    });
    assert.equal(
      (await db.collection("items").where({ household_id: familyId }).get()).data.length,
      2,
      "B 写入也落在共享家庭域"
    );

    // 6)owner 移除 B(服务端指针重置+修订号 +1)
    currentOpenid = "openid-owner";
    var members = await householdsApi.fetchMemberList();
    var bMember = members.members.filter(function (m) {
      return !m.is_self;
    })[0];
    assert.ok(bMember, "成员清单含 B");
    await householdsApi.removeFamilyMember(bMember.member_key);

    // 7)B 用旧作用域(B 客户端仍缓存共享 id/修订号)再写 → 服务端解析回个人
    //    家庭,expected_household_id 不匹配 → FAMILY_SWITCHED,零写入共享域;
    //    客户端触发漂移刷新(status 捕获 B 个人作用域)
    currentOpenid = "openid-b";
    await assert.rejects(
      function () {
        return itemsApi.callItemsApi({
          action: "create",
          operation_id: "op-b-after-remove",
          name: "不该出现的物品",
          location_text: "任何地方"
        });
      },
      function (e) {
        return e.code === "FAMILY_SWITCHED";
      }
    );
    await tick();
    assert.equal(
      (await db.collection("items").where({ household_id: familyId }).get()).data.length,
      2,
      "被移除后零写入共享域"
    );
    assert.equal(
      householdScope.householdScopeId(),
      bPersonalHousehold,
      "漂移刷新后 B 客户端回到个人家庭作用域"
    );

    // 8)B 重试(自动带个人家庭 marker,个人宽松口径)→ 写入落在 B 个人域
    await itemsApi.callItemsApi({
      action: "create",
      operation_id: "op-b-retry",
      name: "B 重新记录",
      location_text: "B 家桌上"
    });
    var bItems = (await db.collection("items")
      .where({ household_id: bPersonalHousehold })
      .get()).data;
    assert.equal(bItems.length, 2, "重试写入落在 B 个人域");
    assert.equal(
      (await db.collection("items").where({ household_id: familyId }).get()).data.length,
      2,
      "共享域最终仍只有 2 件(owner 1 + 加入期间 B 1)"
    );
  } finally {
    teardown();
  }
});
