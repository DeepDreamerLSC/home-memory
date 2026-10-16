"use strict";

/**
 * 订阅「已开启」本地标记(utils/notify-accepted.ts,#36 0.9.6 抽公用)测试:
 * 1. 生命周期:默认未开启 → mark 后已开启 → clear 后未开启(单人作用域后缀 "");
 * 2. best-effort:get/set/remove 抛错一律不抛出,读按未开启;
 * 3. 键含家庭作用域后缀(共享家庭下与单人互不可见,由 householdScopeSuffix 拼接)。
 * 被测对象为编译产物(pretest 已先 build:mp)。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var notifyAccepted = require("../miniprogram/utils/notify-accepted.js");
var householdScope = require("../miniprogram/utils/household-scope.js");

function makeFakeStorage(opts) {
  opts = opts || {};
  var store = {};
  return {
    get: function (k) {
      if (opts.getThrows) {
        throw new Error("storage boom");
      }
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : "";
    },
    set: function (k, v) {
      if (opts.setThrows) {
        throw new Error("storage boom");
      }
      store[k] = v;
    },
    remove: function (k) {
      if (opts.removeThrows) {
        throw new Error("storage boom");
      }
      delete store[k];
    },
    __dump: function () {
      return store;
    },
  };
}

function setup(storage) {
  householdScope.__setHouseholdScopeStorageForTest(storage);
  notifyAccepted.__setNotifyAcceptedStorageForTest(storage);
}

function teardown() {
  householdScope.__resetHouseholdScopeForTest();
  householdScope.__setHouseholdScopeStorageForTest(null);
  notifyAccepted.__setNotifyAcceptedStorageForTest(null);
}

test("NA-1:生命周期——默认未开启,mark 后开启,clear 后回到未开启", function () {
  var storage = makeFakeStorage();
  setup(storage);
  try {
    assert.equal(notifyAccepted.isNotifyAccepted(), false, "默认未开启");
    notifyAccepted.markNotifyAccepted();
    assert.equal(notifyAccepted.isNotifyAccepted(), true, "mark 后已开启");
    notifyAccepted.clearNotifyAccepted();
    assert.equal(notifyAccepted.isNotifyAccepted(), false, "clear 后未开启");
    var keys = Object.keys(storage.__dump());
    assert.equal(keys.length, 0, "clear 后存储无残留键");
  } finally {
    teardown();
  }
});

test("NA-2:best-effort——存储三原语抛错一律吞掉,读按未开启", function () {
  setup(makeFakeStorage({ getThrows: true, setThrows: true, removeThrows: true }));
  try {
    assert.doesNotThrow(function () {
      notifyAccepted.markNotifyAccepted();
    }, "set 抛错不冒出");
    assert.equal(notifyAccepted.isNotifyAccepted(), false, "get 抛错按未开启");
    assert.doesNotThrow(function () {
      notifyAccepted.clearNotifyAccepted();
    }, "remove 抛错不冒出");
  } finally {
    teardown();
  }
});

test("NA-3:键含家庭作用域后缀——共享家庭标记与单人互不可见", function () {
  var storage = makeFakeStorage();
  setup(storage);
  try {
    // 单人(未捕获)作用域:mark 一次
    notifyAccepted.markNotifyAccepted();
    assert.equal(notifyAccepted.isNotifyAccepted(), true);

    // 捕获共享家庭(与生产同款入口):后缀变化 → 标记不可见
    householdScope.captureHouseholdId("hh_abcdef0123456789");
    assert.equal(notifyAccepted.isNotifyAccepted(), false, "共享作用域读不到单人标记");
    notifyAccepted.markNotifyAccepted();
    assert.equal(notifyAccepted.isNotifyAccepted(), true, "共享作用域自己的标记可读");
    assert.equal(
      Object.keys(storage.__dump()).length,
      2,
      "两个作用域两个键(隔离不覆盖)"
    );
  } finally {
    householdScope.__resetHouseholdScopeForTest();
    teardown();
  }
});
