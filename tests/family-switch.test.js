"use strict";

/**
 * 切换家庭(issue #45 十七轮 B 线,客户端)的离线测试:
 * 被测对象是 `npm run build:mp` 产物(pretest 已保证先编译),零外部依赖。
 * #34 合同不弱化:切换器只是 households.switch 更新当前家庭指针 + 客户端沿
 * 既有 fetchHouseholdStatus / captureAndInvalidate 链刷新作用域,不另起缓存体系。
 *
 * 覆盖:
 * - FS-API:households-api.switchFamily——请求结构 {action:"switch",target};
 *   成功捕获新作用域(作用域代数递增 + 位置树缓存清空 + 家庭名按新家重置)
 *   并追加一次 status(刷新家庭名/自资料);switch→status 调用序列在册;
 *   响应结构不符 → CLIENT_BAD_RESPONSE 且作用域不动;status 刷新失败不回滚
 *   「已切换」事实;
 * - FS-SHEET:首页 fam-chip 三选弹层——共享态点开(我的家 / 我们家·家庭名 ✓当前 /
 *   家庭管理页,中文文案在册);个人态照旧直接进家庭管理页;加载态(X1)不切换;
 *   点当前家庭只提示「已在当前家庭」不发起切换;「家庭管理页」行进 F1;
 * - FS-SWITCH-OK:切换成功刷新链(mock)——弹层关、toast 明示已切到、
 *   上下文头(我们家→我的家)、地图先清屏给骨架屏再按新家庭重载、
 *   搜索结果(queried 系列)与快到期横幅随作用域清、未完成批次横幅按新家庭
 *   作用域键读(旧家草稿互不可达、原地保留回切恢复);
 * - FS-SWITCH-FAIL:失败如实提示不切——服务端文案原样呈现,作用域/缓存失效
 *   代数/屏上内容全部保持当前家庭,无任何重载调用;
 * - FS-STALE:切后旧家庭数据不上屏——切换前在途的旧家庭 list 响应迟到,
 *   被请求序号/作用域代数守卫丢弃,屏上只出新家庭内容;
 * - FS-F1:家庭管理页顶部当前家庭行——点开同一弹层(个人态「我的家」为当前,
 *   上一家名字不跟过来),切回共享家庭成功后回首页(navigateBack),
 *   作用域/家庭名捕获为新家;
 * - FS-STATIC:两页 wxml 中文文案与弹层接线静态在册。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");
var householdScope = require("../miniprogram/utils/household-scope.js");
var householdsApi = require("../miniprogram/utils/households-api.js");
var apiLib = require("../miniprogram/utils/api.js");
var famSwitch = require("../miniprogram/utils/fam-switch.js");
var cache = require("../miniprogram/utils/locations-cache.js");
var ds = require("../miniprogram/utils/draft-session.js");
var voiceEntry = require("../miniprogram/utils/voice-entry.js");

/* ---------------- wx 桩 + Page 桩(先装好再 require 页面产物) ---------------- */

var toasts = [];
var modals = [];
var navs = [];
var backDeltas = [];
var reLaunches = [];
var cloudCalls = [];
var routerImpl = null; // 每个用例注入(name, data) → 响应 / Promise / reject

globalThis.wx = {
  cloud: {
    callFunction: function (opts) {
      cloudCalls.push({ name: opts.name, data: JSON.parse(JSON.stringify(opts.data)) });
      Promise.resolve()
        .then(function () {
          if (routerImpl === null) {
            return Promise.reject(new Error("意外调用 " + opts.name + ":" + (opts.data && opts.data.action)));
          }
          return routerImpl(opts.name, opts.data);
        })
        .then(
          function (result) {
            opts.success({ result: result });
          },
          function (err) {
            opts.fail({ errMsg: String((err && err.message) || err) });
          }
        );
    },
  },
  showToast: function (o) {
    toasts.push(o);
  },
  showModal: function (o) {
    modals.push(o);
  },
  showActionSheet: function () {},
  navigateTo: function (o) {
    navs.push(o);
  },
  navigateBack: function (o) {
    backDeltas.push(o);
  },
  reLaunch: function (o) {
    reLaunches.push(o);
  },
  setNavigationBarTitle: function () {},
};

globalThis.getCurrentPages = function () {
  return [];
};

var indexOptions = null;
var familyOptions = null;
globalThis.Page = function (options) {
  indexOptions = options;
};
require(path.join(ROOT, "miniprogram/pages/index/index.js"));
globalThis.Page = function (options) {
  familyOptions = options;
};
require(path.join(ROOT, "miniprogram/pages/family/family.js"));

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
  };
}

function setup() {
  var storage = makeFakeStorage();
  householdScope.__setHouseholdScopeStorageForTest(storage);
  cache.__setLocationsCacheStorageForTest(storage);
  ds.__setDraftSessionStorageForTest(storage);
  return storage;
}

function resetEnv() {
  toasts = [];
  modals = [];
  navs = [];
  backDeltas = [];
  reLaunches = [];
  cloudCalls = [];
  routerImpl = null;
  householdScope.__resetHouseholdScopeForTest();
  cache.__resetLocationsCacheForTest();
  ds.__resetDraftSessionForTest();
  voiceEntry.__resetVoiceEntryForTest();
}

function tick(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms || 10);
  });
}

/** 页面实例桩:实例字段按 onLoad 重建(与真实运行时同款防护),setData 真合并 */
function makePage(options) {
  var page = {
    data: JSON.parse(JSON.stringify(options.data)),
    setData: function (patch) {
      Object.keys(patch).forEach(function (k) {
        page.data[k] = patch[k];
      });
    },
  };
  Object.keys(options).forEach(function (k) {
    if (k !== "data" && typeof options[k] === "function") {
      page[k] = options[k];
    }
  });
  return page;
}

function bootIndexPage() {
  var page = makePage(indexOptions);
  indexOptions.onLoad.call(page, {});
  return page;
}

/** 模拟点弹层行 */
function pick(page, key) {
  page.onFamSheetPick({ currentTarget: { dataset: { key: key } } });
}

/* ---------------- 固定测试数据 ---------------- */

var SHARED_ID = "hh_f_shared0000000000000000001";
var PERSONAL_ID = "hh_personal111111111111111111111111111";
var SHARED_BACK_ID = "hh_f_back0000000000000000000000001";

function sharedScope() {
  householdScope.captureHouseholdScope(SHARED_ID, true, 3);
  householdScope.captureHouseholdScopeName("三口之家");
}

function personalStatus() {
  return {
    ok: true,
    household_id: PERSONAL_ID,
    shared: false,
    role: null,
    scope_revision: null,
    display_name: null,
    self_nickname: null,
    self_avatar_file_id: null,
  };
}

function sharedBackStatus() {
  return {
    ok: true,
    household_id: SHARED_BACK_ID,
    shared: true,
    role: "member",
    scope_revision: 2,
    display_name: "三口之家",
    self_nickname: null,
    self_avatar_file_id: null,
  };
}

function switchToPersonalResponse() {
  return {
    ok: true,
    target: "personal",
    already: false,
    household_id: PERSONAL_ID,
    shared: false,
    role: null,
    scope_revision: null,
    display_name: null,
  };
}

function switchToSharedResponse() {
  return {
    ok: true,
    target: "shared",
    already: false,
    household_id: SHARED_BACK_ID,
    shared: true,
    role: "member",
    scope_revision: 2,
    display_name: "三口之家",
  };
}

/** locations list 根层响应(householdId/房间名可控) */
function listResponse(householdId, roomName, itemCount) {
  return {
    ok: true,
    household_id: householdId,
    node: { location_id: "root", name: "家", type: "home", path: [] },
    children: [
      {
        location_id: "loc-" + roomName,
        name: roomName,
        type: "room",
        path: [roomName],
        item_count: itemCount,
        child_count: 0,
        created_from: "manual",
        updated_at: "2026-10-15T10:00:00.000Z",
      },
    ],
    items: [],
    unmounted_count: 0,
    dangling_mounts: 0,
  };
}

function remindListResponse(householdId, rows) {
  return { ok: true, household_id: householdId, reminders: rows || [] };
}

function makeDrafts() {
  return [
    {
      name: "护照",
      location_text: "书房抽屉",
      certain: true,
      qualifiers: [],
      source_quote: "护照在书房抽屉",
    },
  ];
}

/** 延迟应答闸门:release(value) 前挂起 */
function gate() {
  var resolveFn = null;
  var promise = new Promise(function (r) {
    resolveFn = r;
  });
  return { promise: promise, release: resolveFn };
}

/* ---------------- FS-API:switchFamily 封装 ---------------- */

test("FS-API-1:switch 请求结构 {action:'switch',target};成功捕获新作用域+清缓存+追加 status(家庭名/自资料按新家重置)", async function () {
  var storage = setup();
  try {
    sharedScope();
    var genBefore = householdScope.captureScopeGeneration();
    var cacheGenBefore = cache.captureCacheGeneration();
    routerImpl = function (name, data) {
      if (data.action === "switch") {
        return switchToPersonalResponse();
      }
      if (data.action === "status") {
        return personalStatus();
      }
      throw new Error("意外调用 " + name + ":" + data.action);
    };
    var res = await householdsApi.switchFamily("personal");
    assert.deepEqual(cloudCalls, [
      { name: "households", data: { action: "switch", target: "personal" } },
      { name: "households", data: { action: "status" } },
    ], "调用序列:switch → status(既有链刷新家庭名/自资料)");
    assert.equal(res.target, "personal");
    assert.equal(res.shared, false);
    assert.equal(res.already, false);
    assert.equal(res.household_id, PERSONAL_ID);
    assert.equal(householdScope.householdScopeId(), PERSONAL_ID, "作用域切到个人家庭");
    assert.equal(householdScope.isHouseholdScopeShared(), false);
    assert.equal(householdScope.householdScopeName(), null, "上一家的名字不跟过来");
    assert.ok(
      householdScope.captureScopeGeneration() > genBefore,
      "作用域代数递增(在途旧响应不上屏的依据)"
    );
    assert.ok(
      cache.captureCacheGeneration() > cacheGenBefore,
      "位置树缓存显式清空(接入既有失效代数,不另起缓存体系)"
    );
  } finally {
    resetEnv();
  }
});

test("FS-API-2:个人切回共享——display_name 捕获为新家庭名,修订号入写标记", async function () {
  setup();
  try {
    householdScope.captureHouseholdScope(PERSONAL_ID, false, null);
    routerImpl = function (name, data) {
      if (data.action === "switch") {
        return switchToSharedResponse();
      }
      if (data.action === "status") {
        return sharedBackStatus();
      }
      throw new Error("意外调用 " + name + ":" + data.action);
    };
    var res = await householdsApi.switchFamily("shared");
    assert.equal(res.shared, true);
    assert.equal(res.role, "member");
    assert.equal(res.scope_revision, 2);
    assert.equal(householdScope.householdScopeId(), SHARED_BACK_ID);
    assert.equal(householdScope.householdScopeName(), "三口之家", "家庭名按新家捕获");
    assert.deepEqual(householdScope.scopeWriteMarkers(), {
      expected_household_id: SHARED_BACK_ID,
      expected_scope_revision: 2,
    });
  } finally {
    resetEnv();
  }
});

test("FS-API-3:响应结构不符 → CLIENT_BAD_RESPONSE,作用域不动、无 status 跟随", async function () {
  setup();
  try {
    sharedScope();
    var idBefore = householdScope.householdScopeId();
    var genBefore = householdScope.captureScopeGeneration();
    routerImpl = function () {
      return { ok: true, target: "personal" }; // 缺 household_id/shared
    };
    await assert.rejects(
      function () {
        return householdsApi.switchFamily("personal");
      },
      function (e) {
        return e.code === "CLIENT_BAD_RESPONSE" && e instanceof apiLib.ApiError;
      }
    );
    assert.deepEqual(cloudCalls.map(function (c) {
      return c.data.action;
    }), ["switch"], "结构校验失败不追加 status");
    assert.equal(householdScope.householdScopeId(), idBefore);
    assert.equal(householdScope.captureScopeGeneration(), genBefore, "作用域未动");
  } finally {
    resetEnv();
  }
});

test("FS-API-4:switch 已成功、status 刷新失败 → 不回滚「已切换」事实(服务端硬门兜底)", async function () {
  setup();
  try {
    sharedScope();
    routerImpl = function (name, data) {
      if (data.action === "switch") {
        return switchToPersonalResponse();
      }
      return { ok: false, error: "HOUSEHOLD_UNAVAILABLE", message: "暂时无法确认当前家庭,请稍后重试" };
    };
    var res = await householdsApi.switchFamily("personal");
    assert.equal(res.household_id, PERSONAL_ID);
    assert.equal(householdScope.householdScopeId(), PERSONAL_ID, "switch 响应已捕获,不因 status 失败回滚");
  } finally {
    resetEnv();
  }
});

/* ---------------- FS-SHEET:首页三选弹层 ---------------- */

test("FS-SHEET-1:共享态点 fam-chip → 三选弹层(我的家 / 我们家·家庭名 ✓当前 / 家庭管理页)", function () {
  setup();
  try {
    sharedScope();
    var page = bootIndexPage();
    page.setData({ mapLoading: false }); // 模拟地图已上屏(非 X1 加载态)
    page.onFamilyTap();
    assert.equal(page.data.famSheetVisible, true, "弹层打开");
    assert.deepEqual(page.data.famSheetOptions, [
      { key: "mine", title: "我的家", sub: "只有你一人 · 记录不共享", current: false },
      { key: "shared", title: "我们家 · 三口之家", sub: "共享中 · 和家人一起记 · 当前", current: true },
      { key: "admin", title: "家庭管理 ›", sub: "邀请家人 / 成员 / 设置", current: false },
    ], "三行文案与当前标记(中文用户词在册)");
    assert.deepEqual(navs, [], "不开管理页");
  } finally {
    resetEnv();
  }
});

test("FS-SHEET-2:个人家庭态点 fam-chip 照旧直接进家庭管理页,不出弹层", function () {
  setup();
  try {
    householdScope.captureHouseholdScope(PERSONAL_ID, false, null);
    var page = bootIndexPage();
    page.setData({ mapLoading: false });
    page.onFamilyTap();
    assert.equal(page.data.famSheetVisible, false, "个人态不出三选弹层");
    assert.equal(navs.length, 1);
    assert.equal(navs[0].url, "/pages/family/family");
  } finally {
    resetEnv();
  }
});

test("FS-SHEET-3:加载态(X1)不切换——骨架屏期间点 fam-chip 只提示,不开弹层不进管理页", function () {
  setup();
  try {
    sharedScope();
    var page = bootIndexPage();
    assert.equal(page.data.mapLoading, true, "初始为加载态");
    page.onFamilyTap();
    assert.equal(page.data.famSheetVisible, false);
    assert.deepEqual(navs, []);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].title, "正在加载,稍等一下再切换家庭");
  } finally {
    resetEnv();
  }
});

test("FS-SHEET-4:点「家庭管理页」行 → 关层进 F1;点当前家庭行 → 只提示「已在当前家庭」,不发起切换", async function () {
  setup();
  try {
    sharedScope();
    var page = bootIndexPage();
    page.setData({ mapLoading: false });
    page.onFamilyTap();
    pick(page, "admin");
    assert.equal(page.data.famSheetVisible, false);
    assert.equal(navs.length, 1);
    assert.equal(navs[0].url, "/pages/family/family");

    page.onFamilyTap();
    pick(page, "shared"); // 当前家庭
    assert.equal(page.data.famSheetVisible, false, "提示后关层");
    assert.equal(toasts[toasts.length - 1].title, "已在当前家庭");
    assert.deepEqual(cloudCalls, [], "绝不发起 households.switch");
    assert.equal(householdScope.householdScopeId(), SHARED_ID, "作用域未动");
    await tick();
  } finally {
    resetEnv();
  }
});

/* ---------------- FS-SWITCH-OK:切换成功刷新链(mock) ---------------- */

test("FS-SWITCH-OK:共享切个人成功——弹层关、toast 明示、上下文头翻转、先清屏给骨架屏再按新家庭重载、搜索结果与快到期横幅随作用域清、未完成批次按新家读", async function () {
  setup();
  try {
    sharedScope();
    // 旧家庭有一批没记完的草稿(横幅在屏)+ 旧家庭内容在屏
    ds.createDraftSession("共享家原话", makeDrafts(), false);
    var page = bootIndexPage();
    page.renderedCurrentView = true;
    page.renderedScopeGen = householdScope.captureScopeGeneration();
    page.setData({
      mapLoading: false,
      rooms: [{ location_id: "loc-客厅", name: "客厅", initial: "客", countText: "5 件东西" }],
      queried: true,
      queryKeyword: "钥匙",
      queryResults: [{ item_id: "it-old", name: "钥匙", location_text: "玄关", note: "", version: 1, updated_at: "2026-10-14T10:00:00.000Z", updated_at_short: "10-14" }],
      queryError: "",
      dueBanner: { text: "1 件已过期", overdue: 1, soon: 0 },
      resumeSession: { sid: "sid-shared", count: 1 },
    });

    var listGate = gate(); // 新家庭的地图响应挂起,先观察清屏骨架
    var remindGate = gate(); // 新家庭的快到期响应也挂起,先观察横幅清空
    routerImpl = function (name, data) {
      if (data.action === "switch") {
        return switchToPersonalResponse();
      }
      if (data.action === "status") {
        return personalStatus();
      }
      if (name === "locations" && data.action === "list") {
        return listGate.promise;
      }
      if (data.action === "remindList") {
        return remindGate.promise;
      }
      throw new Error("意外调用 " + name + ":" + data.action);
    };

    page.onFamilyTap();
    pick(page, "mine");
    await tick(30);

    // switch + 追加 status 已完成;新家庭地图在途:屏上必须已是清屏骨架,不拿上一家数据冒充
    assert.equal(page.data.famSheetVisible, false, "弹层关");
    assert.equal(page.data.switchingFamily, false, "切换态复位");
    assert.deepEqual(
      page.data.rooms, [],
      "旧家庭房间先清空(#34:先骨架屏,不先显示上一家再等纠正)"
    );
    assert.equal(page.data.mapLoading, true, "骨架屏(X1)在屏");
    assert.equal(page.data.queried, false, "旧家庭搜索结果收起");
    assert.deepEqual(page.data.queryResults, []);
    assert.equal(page.data.dueBanner, null, "旧家庭的快到期横幅随作用域清");
    assert.equal(page.data.resumeSession, null, "旧家庭的未完成批次横幅按新家庭作用域键读(互不可达)");
    assert.equal(page.data.familyShared, false, "上下文头:我们家 → 我的家");
    assert.equal(toasts[toasts.length - 1].title, "已切到「我的家」", "toast 明示去向");
    assert.equal(householdScope.householdScopeId(), PERSONAL_ID);

    // 新家庭地图回来:按新家庭上屏
    listGate.release(listResponse(PERSONAL_ID, "书房", 2));
    await tick(30);
    assert.equal(page.data.mapLoading, false);
    assert.equal(page.data.rooms.length, 1);
    assert.equal(page.data.rooms[0].name, "书房", "地图按新家庭重载");
    assert.equal(page.data.rooms[0].countText, "2 件");

    // 新家庭的快到期回来:横幅按新家庭自己的数据重载(不是旧家的数字)
    var yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    var pad = function (n) {
      return n < 10 ? "0" + n : String(n);
    };
    remindGate.release(
      remindListResponse(PERSONAL_ID, [
        {
          item_id: "it-pers-1",
          name: "个人家的物品",
          location_text: "书房",
          due_date:
            yesterday.getFullYear() + "-" + pad(yesterday.getMonth() + 1) + "-" + pad(yesterday.getDate()),
          kind: "expiry",
        },
      ]),
    );
    await tick(30);
    assert.ok(page.data.dueBanner !== null, "快到期横幅按新家庭重载");
    assert.equal(page.data.dueBanner.overdue, 1);
    assert.equal(page.data.dueBanner.text, "1 件已过期");

    // 旧家庭草稿原地保留:切回共享作用域即可见(#34 缓存/草稿按 :hh-<id> 隔离)
    assert.equal(ds.getUnfinishedDraftSession(), null, "个人家庭键下无草稿");
    householdScope.captureHouseholdScope(SHARED_ID, true, 3);
    var resumed = ds.getUnfinishedDraftSession();
    assert.ok(resumed !== null, "旧家庭草稿原地保留,回切恢复");
    assert.equal(resumed.payload.drafts.length, 1);
  } finally {
    resetEnv();
  }
});

/* ---------------- FS-SWITCH-FAIL:失败如实提示不切 ---------------- */

test("FS-SWITCH-FAIL:服务端拒绝 → 服务端文案原样呈现;作用域/缓存代数/屏上内容全部不动", async function () {
  setup();
  try {
    sharedScope();
    var page = bootIndexPage();
    page.renderedCurrentView = true;
    page.renderedScopeGen = householdScope.captureScopeGeneration();
    page.refreshFamilyChip(); // 模拟 onShow 的上下文头刷新
    page.setData({
      mapLoading: false,
      rooms: [{ location_id: "loc-客厅", name: "客厅", initial: "客", countText: "5 件东西" }],
    });
    assert.equal(page.data.familyShared, true, "切换前上下文头=我们家");
    var genBefore = householdScope.captureScopeGeneration();
    var cacheGenBefore = cache.captureCacheGeneration();

    routerImpl = function (name, data) {
      if (data.action === "switch") {
        return { ok: false, error: "NOT_FOUND", message: "你还没有加入共享家庭" };
      }
      throw new Error("意外调用 " + name + ":" + data.action);
    };

    page.onFamilyTap();
    pick(page, "mine");
    await tick(30);

    assert.equal(page.data.famSheetVisible, false, "失败后弹层关");
    assert.equal(modals.length, 1, "如实提示(不吞错)");
    assert.equal(modals[0].title, "切换失败");
    assert.equal(modals[0].content, "你还没有加入共享家庭", "服务端中文文案原样呈现");
    assert.equal(householdScope.householdScopeId(), SHARED_ID, "作用域未切");
    assert.equal(householdScope.isHouseholdScopeShared(), true);
    assert.equal(householdScope.captureScopeGeneration(), genBefore, "作用域代数未动");
    assert.equal(cache.captureCacheGeneration(), cacheGenBefore, "缓存未动");
    assert.equal(page.data.familyShared, true);
    assert.equal(page.data.rooms.length, 1, "屏上仍是当前家庭内容(不半切)");
    assert.equal(page.data.rooms[0].name, "客厅");
    assert.deepEqual(
      cloudCalls.map(function (c) {
        return c.name + ":" + c.data.action;
      }),
      ["households:switch"],
      "失败不触发任何重载/刷新调用"
    );
  } finally {
    resetEnv();
  }
});

/* ---------------- FS-STALE:切后旧家庭数据不上屏 ---------------- */

test("FS-STALE:切换前在途的旧家庭 list 响应迟到被丢弃,屏上只出新家庭内容", async function () {
  setup();
  try {
    sharedScope();
    var page = bootIndexPage();
    page.renderedCurrentView = true;
    page.renderedScopeGen = householdScope.captureScopeGeneration();
    page.setData({
      mapLoading: false,
      mapRefreshing: true, // 旧家庭后台刷新在途(轻量指示)
      rooms: [{ location_id: "loc-客厅", name: "客厅", initial: "客", countText: "5 件东西" }],
    });

    var oldListGate = gate(); // 切换前就在途的旧家庭 list
    var newFamilyListed = false;
    routerImpl = function (name, data) {
      if (data.action === "switch") {
        return switchToPersonalResponse();
      }
      if (data.action === "status") {
        return personalStatus();
      }
      if (name === "locations" && data.action === "list") {
        if (!newFamilyListed) {
          newFamilyListed = true;
          return oldListGate.promise; // 切换前的旧家庭在途请求
        }
        return listResponse(PERSONAL_ID, "书房", 2); // 切换后的新家庭请求
      }
      if (data.action === "remindList") {
        return remindListResponse(PERSONAL_ID, []);
      }
      throw new Error("意外调用 " + name + ":" + data.action);
    };

    // 旧家庭后台刷新发起(在途)
    var refreshing = page.loadMapLayer(true);
    await tick(10);

    // 用户切家庭;成功后入口守卫清屏,发出新家庭请求并先回来
    page.onFamilyTap();
    pick(page, "mine");
    await tick(30);
    assert.equal(page.data.rooms.length, 1);
    assert.equal(page.data.rooms[0].name, "书房", "新家庭内容已上屏");

    // 旧家庭的迟到响应此刻才回来:必须被丢弃,不得覆盖新家庭内容
    oldListGate.release(listResponse(SHARED_ID, "客厅", 5));
    await refreshing;
    await tick(30);
    assert.equal(page.data.rooms.length, 1);
    assert.equal(page.data.rooms[0].name, "书房", "旧家庭迟到响应不上屏(请求序号/作用域代数守卫)");
  } finally {
    resetEnv();
  }
});

/* ---------------- FS-F1:家庭管理页顶部当前家庭行 ---------------- */

test("FS-F1:个人态顶部当前家庭行点开同一弹层(我的家=当前,旧家名不跟来);切回共享成功 → 回首页 + 作用域/家庭名捕获为新家", async function () {
  setup();
  try {
    householdScope.captureHouseholdScope(PERSONAL_ID, false, null);
    routerImpl = function () {
      return personalStatus();
    };
    var page = makePage(familyOptions);
    familyOptions.onShow.call(page);
    await tick(30);
    assert.equal(page.data.shared, false, "个人态");

    page.onFamSwitchTap();
    assert.equal(page.data.famSheetVisible, true);
    assert.deepEqual(page.data.famSheetOptions, [
      { key: "mine", title: "我的家", sub: "只有你一人 · 记录不共享 · 当前", current: true },
      { key: "shared", title: "我们家", sub: "共享中 · 和家人一起记", current: false },
      { key: "admin", title: "家庭管理 ›", sub: "邀请家人 / 成员 / 设置", current: false },
    ], "个人态:我的家为当前;上一家名字已清,如实只显示「我们家」不猜");

    routerImpl = function (name, data) {
      if (data.action === "switch") {
        return switchToSharedResponse();
      }
      if (data.action === "status") {
        return sharedBackStatus();
      }
      throw new Error("意外调用 " + name + ":" + data.action);
    };
    pick(page, "shared");
    await tick(30);

    assert.equal(page.data.famSheetVisible, false);
    assert.equal(backDeltas.length, 1, "切换成功后回首页(地图按新家庭刷新)");
    assert.equal(toasts[toasts.length - 1].title, "已切到「我们家 · 三口之家」");
    assert.equal(householdScope.householdScopeId(), SHARED_BACK_ID);
    assert.equal(householdScope.isHouseholdScopeShared(), true);
    assert.equal(householdScope.householdScopeName(), "三口之家");
  } finally {
    resetEnv();
  }
});

test("FS-F1-FAIL:F1 切换失败 → 服务端文案如实提示,停留本页不回首页", async function () {
  setup();
  try {
    householdScope.captureHouseholdScope(PERSONAL_ID, false, null);
    routerImpl = function () {
      return personalStatus();
    };
    var page = makePage(familyOptions);
    familyOptions.onShow.call(page);
    await tick(30);
    page.onFamSwitchTap();
    routerImpl = function () {
      return { ok: false, error: "HOUSEHOLD_UNAVAILABLE", message: "暂时无法确认当前家庭,请稍后重试" };
    };
    pick(page, "shared");
    await tick(30);
    assert.equal(modals.length, 1);
    assert.equal(modals[0].title, "切换失败");
    assert.equal(modals[0].content, "暂时无法确认当前家庭,请稍后重试");
    assert.deepEqual(backDeltas, [], "不回首页");
    assert.equal(householdScope.householdScopeId(), PERSONAL_ID, "作用域未切");
  } finally {
    resetEnv();
  }
});

/* ---------------- FS-STATIC:wxml 中文文案与接线静态在册 ---------------- */

test("FS-STATIC:两页弹层/当前家庭行中文文案在册,无开发词(挂载/节点/指针/scope)", function () {
  var indexWxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/index/index.wxml"), "utf8");
  var familyWxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/family/family.wxml"), "utf8");
  [indexWxml, familyWxml].forEach(function (wxml) {
    assert.ok(wxml.indexOf("切换家庭") !== -1, "弹层标题「切换家庭」");
    assert.ok(wxml.indexOf("famSheetOptions") !== -1, "三行由 famSheetOptions 渲染");
    assert.ok(wxml.indexOf("onFamSheetPick") !== -1, "选行接线");
    ["挂载", "节点", "指针", "scope"].forEach(function (word) {
      assert.ok(wxml.indexOf(word) === -1, "弹层文案不出现开发词:" + word);
    });
  });
  assert.ok(familyWxml.indexOf("当前家庭 · 点开可切换") !== -1, "F1 顶部当前家庭行(十七轮)");
  assert.ok(familyWxml.indexOf("我们家 · {{ displayName") !== -1, "共享态行带家庭名");
  assert.ok(familyWxml.indexOf("bindtap=\"onFamSwitchTap\"") !== -1, "当前家庭行可点开切换");
});
