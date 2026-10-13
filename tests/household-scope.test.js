"use strict";

/**
 * 家庭作用域(issue #34 P0,F3 基础)的离线测试。
 * 被测对象是 `npm run build:mp` 产出的编译产物(pretest 已保证先编译),零外部依赖。
 *
 * 覆盖:
 * 1. 单人回退:未捕获时 householdScopeId() === "default"、后缀为空串,
 *    locations-cache / draft-session 的存储键与单人现状逐字节一致(零回归);
 * 2. 键规则:捕获 household_id 后,locations-cache 存储键、draft-session
 *    持久化键与内存会话键都拼接 ":hh-<id>" 后缀;
 * 3. 作用域隔离:不同作用域互不可见(缓存读 miss、草稿会话与未完成批次检查
 *    均不可见),回切即恢复(草稿原地保留,不迁移不丢失);
 * 4. api 层捕获:itemsApi.list 与 locations.list 响应的 household_id 经
 *    callItemsApi / callLocationsApi 捕获;响应缺省时保持回退(旧云函数窗口);
 * 5. 非法输入(非字符串/空串/default/超长)静默忽略。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var householdScope = require("../miniprogram/utils/household-scope.js");
var cache = require("../miniprogram/utils/locations-cache.js");
var ds = require("../miniprogram/utils/draft-session.js");
var locationsApi = require("../miniprogram/utils/locations-api.js");
var itemsApi = require("../miniprogram/utils/api.js");

var T0 = Date.now();
var SCOPE_KEY = "home-memory:household-scope";
var CACHE_BASE = "home-memory:locations-cache";
var DRAFT_BASE = "home-memory:draft-session";

/** 与页面渲染层级同构的 list 响应(通过 locations-cache 的条目形状校验) */
function makeListResponse(opts) {
  opts = opts || {};
  return {
    ok: true,
    household_id: opts.householdId,
    node: {
      location_id: opts.nodeId || "home-root",
      name: "家",
      type: "home",
      path: [],
      item_count: 0,
      child_count: 0,
      created_from: "bootstrap",
      updated_at: "2026-10-13T00:00:00.000Z"
    },
    children: [],
    items: [],
    unmounted_count: 0,
    dangling_mounts: 0
  };
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
    }
  };
}

/** 每个测试独立的三模块注入与还原(作用域变化不跨测试泄漏) */
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

test("HS-SINGLE:未捕获时作用域为 default,缓存/草稿键与单人现状逐字节一致(零回归)", function () {
  var storage = setup();
  try {
    assert.equal(householdScope.householdScopeId(), "default");
    assert.equal(householdScope.isHouseholdScopeCaptured(), false);
    assert.equal(householdScope.householdScopeSuffix(), "");

    cache.writeLocationsLayer("root", makeListResponse(), T0);
    var sid = ds.createDraftSession("原文", makeDrafts(), false);

    var keys = Object.keys(storage.__dump());
    assert.deepEqual(keys.sort(), [DRAFT_BASE, CACHE_BASE], "单人阶段键与现状逐字节一致");
    assert.ok(cache.readLocationsLayer("root", T0 + 1000) !== null, "缓存按旧键可读");
    assert.ok(ds.getDraftSession(sid) !== null, "草稿按旧键可读");
    assert.ok(ds.getUnfinishedDraftSession() !== null, "未完成批次检查按旧键可读");
  } finally {
    teardown();
  }
});

test("HS-CAPTURE:捕获后 locations-cache 存储键与 draft-session 持久化键都带 :hh-<id> 后缀", function () {
  var storage = setup();
  try {
    householdScope.captureHouseholdId("hh_abcdef0123456789");
    assert.equal(householdScope.householdScopeId(), "hh_abcdef0123456789");
    assert.equal(householdScope.householdScopeSuffix(), ":hh-hh_abcdef0123456789");

    cache.writeLocationsLayer("root", makeListResponse({ householdId: "hh_abcdef0123456789" }), T0);
    ds.createDraftSession("原文", makeDrafts(), false);

    var keys = Object.keys(storage.__dump()).sort();
    assert.deepEqual(keys, [
      DRAFT_BASE + ":hh-hh_abcdef0123456789",
      SCOPE_KEY,
      CACHE_BASE + ":hh-hh_abcdef0123456789"
    ]);
    // 作用域本身也持久化(冷启动先还原作用域,缓存才能按正确键命中)
    assert.equal(storage.__dump()[SCOPE_KEY], "hh_abcdef0123456789");
    assert.ok(cache.readLocationsLayer("root", T0 + 1000) !== null);
  } finally {
    teardown();
  }
});

test("HS-ISO:不同作用域互不可见,回切即恢复;进程回收后按作用域键从持久层还原", function () {
  setup();
  try {
    householdScope.captureHouseholdId("hh_family_a");
    cache.writeLocationsLayer("root", makeListResponse({ householdId: "hh_family_a" }), T0);
    var sid = ds.createDraftSession("A 家庭原文", makeDrafts(), false);
    assert.ok(cache.readLocationsLayer("root", T0 + 1000) !== null);
    assert.ok(ds.getUnfinishedDraftSession() !== null);

    // 切到 B:缓存 miss、草稿会话与未完成批次检查都不可见(键天然不同)
    householdScope.captureHouseholdId("hh_family_b");
    assert.equal(cache.readLocationsLayer("root", T0 + 1000), null, "B 作用域读不到 A 的缓存");
    assert.equal(ds.getDraftSession(sid), null, "B 作用域读不到 A 的草稿会话");
    assert.equal(ds.getUnfinishedDraftSession(), null, "首页未完成批次检查在 B 作用域为空");

    // B 作用域写入的是自己的数据
    cache.writeLocationsLayer("root", makeListResponse({ householdId: "hh_family_b" }), T0);
    var sidB = ds.createDraftSession("B 家庭原文", makeDrafts(), false);
    assert.ok(cache.readLocationsLayer("root", T0 + 1000) !== null);

    // 回切 A:原地恢复(不迁移、不丢失)
    householdScope.captureHouseholdId("hh_family_a");
    var restored = cache.readLocationsLayer("root", T0 + 1000);
    assert.ok(restored !== null, "回切 A 后缓存按 A 键恢复可见");
    assert.equal(restored.response.household_id, "hh_family_a");
    assert.ok(ds.getDraftSession(sid) !== null, "回切 A 后草稿按 A 键恢复可见");
    var unfinished = ds.getUnfinishedDraftSession();
    assert.equal(unfinished.sid, sid, "未完成批次入口恢复为 A 的会话");
    assert.equal(ds.getDraftSession(sidB), null, "B 的会话在 A 作用域不可见");

    // 进程回收(清内存会话)后:按 A 作用域键从持久层还原
    ds.simulateProcessRestartForTest();
    assert.ok(ds.getDraftSession(sid) !== null, "重启后按作用域持久键恢复 A 会话");
  } finally {
    teardown();
  }
});

test("HS-PERSIST:作用域经 storage 记忆,模块状态重置后冷启动还原(缓存先于网络可用)", function () {
  var storage = setup();
  try {
    householdScope.captureHouseholdId("hh_remembered");
    cache.writeLocationsLayer("root", makeListResponse({ householdId: "hh_remembered" }), T0);

    // 模拟进程重启:内存作用域丢失,storage 仍在
    householdScope.__resetHouseholdScopeForTest();
    householdScope.__setHouseholdScopeStorageForTest(storage);
    assert.equal(householdScope.householdScopeId(), "hh_remembered", "冷启动先还原作用域");
    assert.ok(cache.readLocationsLayer("root", T0 + 1000) !== null, "缓存按正确作用域键命中");
  } finally {
    teardown();
  }
});

test("HS-INVALID:captureHouseholdId 忽略非法输入(非字符串/空串/纯空白/default/超长)", function () {
  setup();
  try {
    householdScope.captureHouseholdId(123);
    householdScope.captureHouseholdId(null);
    householdScope.captureHouseholdId(undefined);
    householdScope.captureHouseholdId("");
    householdScope.captureHouseholdId("   ");
    householdScope.captureHouseholdId("default");
    householdScope.captureHouseholdId(new Array(200).join("x"));
    assert.equal(householdScope.isHouseholdScopeCaptured(), false, "非法输入一律不捕获");
    assert.equal(householdScope.householdScopeSuffix(), "");

    // 已捕获后,非法输入不得冲掉既有作用域
    householdScope.captureHouseholdId("hh_stable");
    householdScope.captureHouseholdId("default");
    householdScope.captureHouseholdId(42);
    assert.equal(householdScope.householdScopeId(), "hh_stable");
  } finally {
    teardown();
  }
});

test("HS-API:itemsApi.list 与 locations.list 响应的 household_id 经 API 封装捕获;缺省保持回退", async function () {
  setup();
  try {
    // locations 通道
    globalThis.wx = {
      cloud: {
        callFunction: function (opts) {
          if (opts.name === "locations") {
            opts.success({ result: makeListResponse({ householdId: "hh_from_locations" }) });
          } else if (opts.name === "itemsApi") {
            opts.success({ result: { ok: true, household_id: "hh_from_items", items: [] } });
          }
        }
      }
    };
    assert.equal(householdScope.isHouseholdScopeCaptured(), false);
    var locRes = await locationsApi.callLocationsApi({ action: "list" });
    assert.equal(locRes.ok, true);
    assert.equal(householdScope.householdScopeId(), "hh_from_locations");

    // itemsApi 通道(重置后单独验证)
    householdScope.__resetHouseholdScopeForTest();
    var itemRes = await itemsApi.callItemsApi({ action: "list" });
    assert.equal(itemRes.ok, true);
    assert.equal(householdScope.householdScopeId(), "hh_from_items");

    // 旧云函数窗口:响应缺 household_id → 保持回退,不报错
    householdScope.__resetHouseholdScopeForTest();
    globalThis.wx.cloud.callFunction = function (opts) {
      opts.success({
        result: {
          ok: true,
          node: makeListResponse().node,
          children: [],
          items: [],
          unmounted_count: 0,
          dangling_mounts: 0
        }
      });
    };
    var legacyRes = await locationsApi.callLocationsApi({ action: "list" });
    assert.equal(legacyRes.ok, true);
    assert.equal(householdScope.householdScopeId(), "default", "缺省字段不改变回退作用域");
  } finally {
    teardown();
  }
});
