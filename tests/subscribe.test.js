"use strict";

/**
 * issue #36 V1.5(小程序端订阅授权封装 miniprogram/utils/subscribe.ts)测试:
 * - SB-MAP:授权结果映射(纯函数 isSubscribeAccepted)——accept 才记录,
 *   reject/ban/filter/形状异常一律不记录、不抛错;
 * - SB-FLOW:requestExpirySubscribe 全流程(stub globalThis.wx)——在手势链内
 *   同步发起 wx.requestSubscribeMessage、accept 才调 remindNotify
 *   recordSubscription;拒绝/接口失败/低版本基础库一律静默降级应用内提醒,
 *   绝不 toast、绝不阻塞保存流程;SB-FLOW-5:onAccepted 回调(详情页显式
 *   入口用)只在 accept 且记录已发起后同步调用;
 * - SB-CONST:模板 ID 单一常量收敛,与 remindNotify 云函数侧同值;
 * - SB-GESTURE(#36 0.9.2,请求前置零桥接调用):recording wx(Proxy 记录
 *   每一次 wx API 调用顺序)——requestExpirySubscribe 内第一条 wx API
 *   调用必须是 wx.requestSubscribeMessage;getAccountInfoSync(同步桥接
 *   调用,会破坏 iOS 点击手势上下文)只允许出现在请求之后的回调里;
 *   低版本提前 return 路径零 wx 调用。这是真回归锁:任何人把「请求前先
 *   查环境/先 toast/先读存储」加回来,序列断言立刻红。
 * require 的是编译产物 subscribe.js(npm run build:mp 生成,pretest 已先行构建)。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var subscribe = require("../miniprogram/utils/subscribe.js");

var TEMPLATE_ID = "fM4crRcrPk2kQ5iRL0WwTPoRhNS7Da8skrWqfcEdBSM";

function restoreWx(prev) {
  if (prev === undefined) {
    delete globalThis.wx;
  } else {
    globalThis.wx = prev;
  }
}

// ---------- SB-CONST:模板 ID 常量收敛 ----------

test("SB-CONST-1:模板 ID 单一常量导出,与云函数 remindNotify 同值", function () {
  assert.equal(subscribe.EXPIRY_REMIND_TEMPLATE_ID, TEMPLATE_ID);
});

// ---------- SB-MAP:授权结果映射(纯函数) ----------

test("SB-MAP-1:accept → 记录;reject/ban/filter → 不记录", function () {
  var accept = {};
  accept[TEMPLATE_ID] = "accept";
  assert.equal(subscribe.isSubscribeAccepted(accept), true, "accept 才记录");

  var reject = {};
  reject[TEMPLATE_ID] = "reject";
  assert.equal(subscribe.isSubscribeAccepted(reject), false, "用户拒绝:不记录");

  var ban = {};
  ban[TEMPLATE_ID] = "ban";
  assert.equal(subscribe.isSubscribeAccepted(ban), false, "被封禁:不记录");

  var filter = {};
  filter[TEMPLATE_ID] = "filter";
  assert.equal(subscribe.isSubscribeAccepted(filter), false, "被过滤:不记录");
});

test("SB-MAP-2:形状异常(缺模板键/null/非对象/值非字符串)一律不记录、不抛错", function () {
  assert.equal(subscribe.isSubscribeAccepted({}), false);
  assert.equal(subscribe.isSubscribeAccepted(null), false);
  assert.equal(subscribe.isSubscribeAccepted(undefined), false);
  assert.equal(subscribe.isSubscribeAccepted("accept"), false);
  assert.equal(subscribe.isSubscribeAccepted(0), false);
  var numeric = {};
  numeric[TEMPLATE_ID] = 1;
  assert.equal(subscribe.isSubscribeAccepted(numeric), false);
});

// ---------- SB-FLOW:requestExpirySubscribe 全流程(stub wx) ----------

test("SB-FLOW-1:accept → 调 remindNotify recordSubscription(带模板授权后置动作)", async function () {
  var prevWx = globalThis.wx;
  var calls = [];
  globalThis.wx = {
    requestSubscribeMessage: function (o) {
      calls.push({ kind: "subscribe", tmplIds: o.tmplIds });
      var res = {};
      res[TEMPLATE_ID] = "accept";
      o.success(res);
    },
    cloud: {
      callFunction: function (o) {
        calls.push({ kind: "callFunction", name: o.name, data: o.data });
      }
    },
    showToast: function () {
      calls.push({ kind: "showToast" });
    }
  };
  try {
    subscribe.requestExpirySubscribe();
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.equal(calls.length, 2, "一次订阅弹窗 + 一次云函数记录");
    assert.deepEqual(calls[0].tmplIds, [TEMPLATE_ID], "弹窗模板即单一常量");
    assert.equal(calls[1].name, "remindNotify");
    assert.equal(calls[1].data.action, "recordSubscription");
    assert.equal(calls.some(function (c) {
      return c.kind === "showToast";
    }), false, "绝不 toast(静默降级)");
  } finally {
    restoreWx(prevWx);
  }
});

test("SB-FLOW-2:reject → 不调云函数;requestSubscribeMessage fail → 不调、不抛错", async function () {
  var prevWx = globalThis.wx;
  var calls = [];
  globalThis.wx = {
    requestSubscribeMessage: function (o) {
      calls.push("subscribe");
      var res = {};
      res[TEMPLATE_ID] = "reject";
      o.success(res);
    },
    cloud: {
      callFunction: function () {
        calls.push("callFunction");
      }
    }
  };
  try {
    subscribe.requestExpirySubscribe();
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.deepEqual(calls, ["subscribe"], "拒绝授权:只弹窗不落库");
  } finally {
    restoreWx(prevWx);
  }

  calls = [];
  globalThis.wx = {
    requestSubscribeMessage: function (o) {
      calls.push("subscribe");
      o.fail({ errMsg: "requestSubscribeMessage:fail" });
    },
    cloud: {
      callFunction: function () {
        calls.push("callFunction");
      }
    }
  };
  try {
    assert.doesNotThrow(function () {
      subscribe.requestExpirySubscribe();
    }, "接口失败静默吞掉,绝不抛错阻塞保存");
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.deepEqual(calls, ["subscribe"], "失败路径不触发云函数");
  } finally {
    restoreWx(prevWx);
  }
});

test("SB-FLOW-3:低版本基础库(无 requestSubscribeMessage)与无云能力(无 wx.cloud)一律静默降级", function () {
  var prevWx = globalThis.wx;
  globalThis.wx = {
    cloud: {
      callFunction: function () {
        throw new Error("不应被调用");
      }
    }
  };
  try {
    assert.doesNotThrow(function () {
      subscribe.requestExpirySubscribe();
    }, "无 requestSubscribeMessage:静默跳过");
  } finally {
    restoreWx(prevWx);
  }

  globalThis.wx = {
    requestSubscribeMessage: function (o) {
      var res = {};
      res[TEMPLATE_ID] = "accept";
      o.success(res);
    }
    // 无 wx.cloud:accept 后记录调用也应静默跳过
  };
  try {
    assert.doesNotThrow(function () {
      subscribe.requestExpirySubscribe();
    }, "无云能力:静默降级应用内提醒");
  } finally {
    restoreWx(prevWx);
  }
});

test("SB-FLOW-4:云函数失败(callFunction fail / 返回 ok:false)静默吞掉,不 toast 不抛错", async function () {
  var prevWx = globalThis.wx;
  var toasts = [];
  globalThis.wx = {
    requestSubscribeMessage: function (o) {
      var res = {};
      res[TEMPLATE_ID] = "accept";
      o.success(res);
    },
    cloud: {
      callFunction: function (o) {
        o.fail({ errMsg: "cloud.callFunction:fail" });
      }
    },
    showToast: function () {
      toasts.push(1);
    }
  };
  try {
    assert.doesNotThrow(function () {
      subscribe.requestExpirySubscribe();
    });
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.equal(toasts.length, 0, "落库失败不 toast:提醒仍有应用内提醒页兜底");
  } finally {
    restoreWx(prevWx);
  }
});

// SB-FLOW-5(#36 真机手势规则:详情页显式入口 onNotifyChipTap 的回调扩展):
// accept 且 recordSubscription 已发起 → 发起后同步回调(不 await 云函数结果);
// reject/fail/低版本/无云能力(记录未发起)一律不回调。现有调用点
// (确认卡保存/详情保存修改)不传回调,行为零变化(SB-FLOW-1..4 同款路径)。
test("SB-FLOW-5:onAccepted——accept 且记录已发起 → 发起后同步调用;reject/fail/低版本/无云能力 → 不调用", async function () {
  // accept + 云函数记录发起:回调在记录发起之后同步调用(顺序锁定)
  var prevWx = globalThis.wx;
  var order = [];
  globalThis.wx = {
    requestSubscribeMessage: function (o) {
      var res = {};
      res[TEMPLATE_ID] = "accept";
      o.success(res);
    },
    cloud: {
      callFunction: function () {
        order.push("record");
      }
    }
  };
  try {
    subscribe.requestExpirySubscribe(function () {
      order.push("onAccepted");
    });
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.deepEqual(order, ["record", "onAccepted"], "accept:记录发起后同步回调一次");
  } finally {
    restoreWx(prevWx);
  }

  // accept 但无云能力:记录未发起 → 不回调(显式入口保留,可稍后重试)
  order = [];
  globalThis.wx = {
    requestSubscribeMessage: function (o) {
      var res = {};
      res[TEMPLATE_ID] = "accept";
      o.success(res);
    }
  };
  try {
    subscribe.requestExpirySubscribe(function () {
      order.push("onAccepted");
    });
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.deepEqual(order, [], "无云能力:记录未发起,不回调");
  } finally {
    restoreWx(prevWx);
  }

  // reject:授权未通过 → 不回调
  order = [];
  globalThis.wx = {
    requestSubscribeMessage: function (o) {
      var res = {};
      res[TEMPLATE_ID] = "reject";
      o.success(res);
    },
    cloud: {
      callFunction: function () {
        order.push("record");
      }
    }
  };
  try {
    subscribe.requestExpirySubscribe(function () {
      order.push("onAccepted");
    });
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.deepEqual(order, [], "reject:不回调");
  } finally {
    restoreWx(prevWx);
  }

  // fail(如手势规则拒绝):不回调、不抛错
  order = [];
  globalThis.wx = {
    requestSubscribeMessage: function (o) {
      o.fail({ errMsg: "requestSubscribeMessage:fail can only be invoked by user TAP gesture" });
    },
    cloud: {
      callFunction: function () {
        order.push("record");
      }
    }
  };
  try {
    assert.doesNotThrow(function () {
      subscribe.requestExpirySubscribe(function () {
        order.push("onAccepted");
      });
    }, "fail 静默吞掉");
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.deepEqual(order, [], "fail:不回调");
  } finally {
    restoreWx(prevWx);
  }

  // 低版本基础库(无 requestSubscribeMessage):不回调
  order = [];
  globalThis.wx = {
    cloud: {
      callFunction: function () {
        order.push("record");
      }
    }
  };
  try {
    subscribe.requestExpirySubscribe(function () {
      order.push("onAccepted");
    });
    assert.deepEqual(order, [], "低版本基础库:不回调");
  } finally {
    restoreWx(prevWx);
  }
});

// ---------- SB-PAGE:确认页/详情页接线(被测对象为 build:mp 编译产物) ----------

var path = require("node:path");
var ROOT = path.join(__dirname, "..");
var ds = require("../miniprogram/utils/draft-session.js");
var householdScope = require("../miniprogram/utils/household-scope.js");
var cache = require("../miniprogram/utils/locations-cache.js");

/** 订阅弹窗授权开关:accept 会连带触发 remindNotify recordSubscription */
var subscribeDecision = "accept";
var subscribeCalls = [];
var pageCloudCalls = [];
var pageToasts = [];

function pageInstallWx(router) {
  globalThis.wx = {
    showToast: function (o) {
      pageToasts.push(o);
    },
    showModal: function (o) {
      if (o.success) {
        o.success({ confirm: true });
      }
    },
    navigateTo: function () {},
    navigateBack: function () {},
    reLaunch: function () {},
    getStorageSync: function () {
      return "";
    },
    setStorageSync: function () {},
    removeStorageSync: function () {},
    requestSubscribeMessage: function (o) {
      subscribeCalls.push(o.tmplIds);
      var res = {};
      res[TEMPLATE_ID] = subscribeDecision;
      if (subscribeDecision === "accept" || subscribeDecision === "reject") {
        o.success(res);
      } else {
        o.fail({ errMsg: "requestSubscribeMessage:fail" });
      }
    },
    cloud: {
      callFunction: function (o) {
        pageCloudCalls.push({ name: o.name, data: JSON.parse(JSON.stringify(o.data)) });
        Promise.resolve()
          .then(function () {
            return router(o.name, o.data);
          })
          .then(
            function (result) {
              // 订阅记录是 fire-and-forget(不传 success),其余调用按回调语义回填
              if (o.success) {
                o.success({ result: result });
              }
            },
            function (err) {
              if (o.fail) {
                o.fail({ errMsg: String((err && err.message) || err) });
              }
            }
          );
      }
    }
  };
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
    }
  };
}

function pageResetEnv() {
  subscribeDecision = "accept";
  subscribeCalls = [];
  pageCloudCalls = [];
  pageToasts = [];
  // 页面在 loadPages 时捕获的只是 Page 配置,wx 桩在调用时才生效:按被测页重装对应路由
  pageInstallWx(confirmRouter);
  ds.__resetDraftSessionForTest();
  ds.__setDraftSessionStorageForTest(makeFakeStorage());
  householdScope.__resetHouseholdScopeForTest();
  cache.__resetLocationsCacheForTest();
}

function setPath(obj, key, value) {
  var parts = key.replace(/\]/g, "").split(/[.[]/);
  var cur = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function makePageFrom(config) {
  var page = {
    data: JSON.parse(JSON.stringify(config.data)),
    setData: function (patch) {
      Object.keys(patch).forEach(function (k) {
        if (k.indexOf(".") === -1 && k.indexOf("[") === -1) {
          page.data[k] = patch[k];
        } else {
          setPath(page.data, k, patch[k]);
        }
      });
    }
  };
  // 真实页面实例自带 Page 的自定义属性(original/remindOriginal/pendingRetry/sid 等)
  // 与方法;与既有页测试桩同款,一并挂上(data 已单独深拷贝)
  Object.keys(config).forEach(function (k) {
    if (k !== "data") {
      page[k] = config[k];
    }
  });
  return page;
}

function settle() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 20);
  });
}

/* ---------------- 确认页:onSaveBatchTap 手势链内同步请求订阅 ---------------- */

var confirmRouterCalls = [];
function confirmRouter(name, data) {
  confirmRouterCalls.push({ name: name, action: data && data.action });
  if (name === "itemsApi" && data.action === "create") {
    return {
      ok: true,
      duplicated: false,
      item: {
        item_id: "it-" + data.operation_id,
        name: data.name,
        location_text: data.location_text,
        note: "",
        version: 3,
        updated_at: "2026-10-15T10:00:00.000Z"
      }
    };
  }
  if (name === "remindNotify" && data.action === "recordSubscription") {
    return { ok: true };
  }
  return Promise.reject(new Error("意外调用 " + name + ":" + (data && data.action)));
}

var confirmConfig = null;
var itemConfig = null;

(function loadPages() {
  globalThis.getCurrentPages = function () {
    return [];
  };
  // 确认页
  pageInstallWx(confirmRouter);
  globalThis.Page = function (options) {
    confirmConfig = options;
  };
  require(path.join(ROOT, "miniprogram", "pages", "confirm", "confirm.js"));
  // 详情页
  globalThis.Page = function (config) {
    itemConfig = config;
  };
  require(path.join(ROOT, "miniprogram", "pages", "item", "item.js"));
})();

function remindedDraft(overrides) {
  return Object.assign(
    {
      name: "鲜牛奶",
      location_text: "冰箱冷藏层",
      certain: true,
      qualifiers: [],
      source_quote: "鲜牛奶放冰箱冷藏层,十一月二十号到期",
      anchor_shared: false,
      remind_at: "2026-11-20",
      remind_kind: "有效期",
      remind_quote: "十一月二十号到期",
      remind_vague_quote: null,
      mount_path: null
    },
    overrides
  );
}

test("SB-PAGE-CONF-1:带提醒行保存——tap 手势链内同步请求订阅,accept 后记录订阅,保存照旧完成", async function () {
  pageResetEnv();
  confirmRouterCalls = [];
  var page = makePageFrom(confirmConfig);
  var sid = ds.createDraftSession("原话整句", [remindedDraft()], false);
  confirmConfig.onLoad.call(page, { sid: sid });

  await confirmConfig.onSaveBatchTap.call(page);
  await settle();

  assert.equal(subscribeCalls.length, 1, "恰好一次订阅授权请求");
  assert.deepEqual(subscribeCalls[0], [TEMPLATE_ID], "弹窗模板即单一常量");
  assert.ok(
    pageCloudCalls.some(function (c) {
      return c.name === "remindNotify" && c.data.action === "recordSubscription";
    }),
    "accept 后记录订阅(remindNotify recordSubscription)"
  );
  assert.ok(
    pageCloudCalls.some(function (c) {
      return c.name === "itemsApi" && c.data.action === "create";
    }),
    "保存流程照旧完成(订阅失败也不阻塞)"
  );
  assert.equal(page.data.rows.filter(function (r) {
    return r.status === "saved";
  }).length, 1, "行 saved");
});

test("SB-PAGE-CONF-2:无提醒行保存——不请求订阅,保存照旧;拒绝授权同样不阻塞保存", async function () {
  pageResetEnv();
  confirmRouterCalls = [];
  var page = makePageFrom(confirmConfig);
  var sid = ds.createDraftSession(
    "原话整句",
    [remindedDraft({ remind_at: null, remind_kind: null, remind_quote: null })],
    false
  );
  confirmConfig.onLoad.call(page, { sid: sid });

  await confirmConfig.onSaveBatchTap.call(page);
  await settle();
  assert.equal(subscribeCalls.length, 0, "没有任何提醒写入:不请求订阅");
  assert.ok(
    pageCloudCalls.some(function (c) {
      return c.name === "itemsApi" && c.data.action === "create";
    }),
    "保存照旧"
  );

  // 带提醒行但用户拒绝授权:不记录订阅、保存不受影响
  pageResetEnv();
  subscribeDecision = "reject";
  confirmRouterCalls = [];
  var page2 = makePageFrom(confirmConfig);
  var sid2 = ds.createDraftSession("原话整句", [remindedDraft()], false);
  confirmConfig.onLoad.call(page2, { sid: sid2 });
  await confirmConfig.onSaveBatchTap.call(page2);
  await settle();
  assert.equal(subscribeCalls.length, 1, "弹窗照常请求");
  assert.ok(
    !pageCloudCalls.some(function (c) {
      return c.name === "remindNotify";
    }),
    "拒绝授权:不记录订阅"
  );
  assert.equal(page2.data.rows.filter(function (r) {
    return r.status === "saved";
  }).length, 1, "拒绝授权后保存照旧完成");
});

/* ---------------- 详情页:onSaveTap 写提醒时请求(真实按钮 tap);picker 直写不请求
   (bindchange 无点击手势,#36 真机手势规则);显式入口「到期时微信提醒我 ›」承接 picker
   路径的授权;清除不请求 ---------------- */

var itemRemindListRow = null;
function itemRouter(name, data) {
  if (name === "households" && data.action === "status") {
    return { ok: true, household_id: "default", shared: false };
  }
  if (name === "remindNotify" && data.action === "recordSubscription") {
    return { ok: true };
  }
  if (name === "itemsApi") {
    if (data.action === "remindList") {
      return { ok: true, reminders: itemRemindListRow ? [itemRemindListRow] : [], household_id: "default" };
    }
    if (data.action === "remindSet") {
      return {
        ok: true,
        reminder: { item_id: data.item_id, due_date: data.due_date, kind: "下次维护", generation: 9 }
      };
    }
    if (data.action === "remindClear") {
      return { ok: true };
    }
  }
  return Promise.reject(new Error("意外调用 " + name + ":" + (data && data.action)));
}

function itemPageResetEnv() {
  pageResetEnv();
  pageInstallWx(itemRouter);
  itemRemindListRow = null;
}

function itemSummary() {
  return {
    item_id: "it-sub",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    note: "",
    version: 4,
    updated_at: "2026-10-14T02:00:00.000Z"
  };
}

// 回归依据(#36 0.9.0 iOS 真机实测):详情页 picker mode=date 的 bindchange
// (滚轮选完)回调不在用户 tap 手势链内,此处调 wx.requestSubscribeMessage
// 100% 报「requestSubscribeMessage:fail can only be invoked by user TAP
// gesture」(真机 toast 被截断只见「…fail c…」),只产生错误 toast 噪音。
// 本测试改写自旧断言(picker 直写会请求订阅)——按新行为锁定:picker 路径
// 不请求订阅,授权入口移至保质期行下方「到期时微信提醒我 ›」显式入口
// (onNotifyChipTap,SB-PAGE-ITEM-4);onSaveTap 的按钮 tap 路径照旧请求
// (SB-PAGE-ITEM-3 锁定)。
test("SB-PAGE-ITEM-1:设置到期提醒(picker 选日子直写)——不请求订阅授权(真机手势规则),remindSet 照常发出", async function () {
  itemPageResetEnv();
  var page = makePageFrom(itemConfig);
  itemConfig.applySummary.call(page, itemSummary());
  await itemConfig.refreshReminderRow.call(page); // 远端确认无提醒(轮次 0)
  await settle();
  assert.equal(page.data.remindGeneration, 0, "前置:轮次已知");

  await itemConfig.onRemindDateChange.call(page, { detail: { value: "2026-11-25" } });
  await settle();

  assert.equal(subscribeCalls.length, 0, "picker bindchange 无点击手势:不请求订阅(必然失败的调用已移除)");
  assert.ok(
    pageCloudCalls.some(function (c) {
      return c.name === "itemsApi" && c.data.action === "remindSet" && c.data.due_date === "2026-11-25";
    }),
    "提醒照常写入(订阅入口移走不影响保存)"
  );
  assert.equal(page.data.remindAt, "2026-11-25", "提醒照常上屏");
  // 直写成功后显式入口条件成立:有生效提醒且本地未标记已开启(点击流程见 SB-PAGE-ITEM-4)
  assert.equal(page.data.notifyAccepted, false, "未开启过订阅:显式入口可露出");
});

test("SB-PAGE-ITEM-2:清除提醒(onRemindFieldClear)——不请求订阅授权", async function () {
  itemPageResetEnv();
  itemRemindListRow = {
    item_id: "it-sub",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-11-01",
    kind: "有效期",
    generation: 5
  };
  var page = makePageFrom(itemConfig);
  itemConfig.applySummary.call(page, itemSummary());
  await itemConfig.refreshReminderRow.call(page);
  await settle();
  assert.equal(page.data.remindAt, "2026-11-01", "前置:已有提醒");

  await itemConfig.onRemindFieldClear.call(page);
  await settle();

  assert.equal(subscribeCalls.length, 0, "清除提醒不请求订阅");
  assert.ok(
    pageCloudCalls.some(function (c) {
      return c.name === "itemsApi" && c.data.action === "remindClear";
    }),
    "清除照常执行"
  );
});

test("SB-PAGE-ITEM-3:保存修改补写提醒(remindSet)请求订阅;补清除(remindClear)不请求", async function () {
  // 待补写 set:表单候选日期 ≠ 已确认基准,轮次已知
  itemPageResetEnv();
  var page = makePageFrom(itemConfig);
  itemConfig.applySummary.call(page, itemSummary());
  await itemConfig.refreshReminderRow.call(page); // 无提醒:remindOriginal ""、轮次 0
  await settle();
  page.setData({ remindAt: "2026-12-01" }); // 遗留的待补写候选

  await itemConfig.onSaveTap.call(page);
  await settle();
  assert.equal(subscribeCalls.length, 1, "保存会写入提醒:请求订阅");
  assert.ok(
    pageCloudCalls.some(function (c) {
      return c.name === "itemsApi" && c.data.action === "remindSet" && c.data.due_date === "2026-12-01";
    }),
    "补写照常完成"
  );

  // 待补写 clear:基准有提醒、表单清空
  itemPageResetEnv();
  itemRemindListRow = {
    item_id: "it-sub",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-11-01",
    kind: "有效期",
    generation: 5
  };
  var page2 = makePageFrom(itemConfig);
  itemConfig.applySummary.call(page2, itemSummary());
  await itemConfig.refreshReminderRow.call(page2);
  await settle();
  page2.setData({ remindAt: "" }); // 待补写的清除

  await itemConfig.onSaveTap.call(page2);
  await settle();
  assert.equal(subscribeCalls.length, 0, "保存的是清除提醒:不请求订阅");
  assert.ok(
    pageCloudCalls.some(function (c) {
      return c.name === "itemsApi" && c.data.action === "remindClear";
    }),
    "清除照常完成"
  );
});

/* ---------------- 详情页:「到期时微信提醒我 ›」显式入口(#36 真机手势规则) ---------------- */

/** 给 pageInstallWx 装好的 wx 换成可查验的 storage(其余桩不动),返回 store */
function patchPageStorage() {
  var store = {};
  globalThis.wx.getStorageSync = function (k) {
    return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : "";
  };
  globalThis.wx.setStorageSync = function (k, v) {
    store[k] = v;
  };
  globalThis.wx.removeStorageSync = function (k) {
    delete store[k];
  };
  return store;
}

test("SB-PAGE-ITEM-4:显式订阅入口——有提醒未开启才露出;真实 tap 请求授权,accept 后写本地标记并收起", async function () {
  // 前置:远端已有生效提醒,本地未标记「已成功开启」→ 入口显示条件成立
  itemPageResetEnv();
  var store = patchPageStorage();
  itemRemindListRow = {
    item_id: "it-sub",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-11-01",
    kind: "有效期",
    generation: 5
  };
  var page = makePageFrom(itemConfig);
  itemConfig.applySummary.call(page, itemSummary());
  await itemConfig.refreshReminderRow.call(page); // 作用域经服务端复核后重读本地标记
  await settle();
  assert.equal(page.data.remindAt, "2026-11-01", "前置:有生效提醒");
  assert.equal(page.data.notifyAccepted, false, "本地未标记已开启:入口显示(remindAt && !notifyAccepted)");

  // 真实 tap:请求订阅授权;accept 且记录发起后 → 写本地标记 + 收起入口
  await itemConfig.onNotifyChipTap.call(page);
  await settle();
  assert.equal(subscribeCalls.length, 1, "显式入口 tap:恰好一次订阅授权请求");
  assert.deepEqual(subscribeCalls[0], [TEMPLATE_ID], "弹窗模板即单一常量");
  assert.ok(
    pageCloudCalls.some(function (c) {
      return c.name === "remindNotify" && c.data.action === "recordSubscription";
    }),
    "accept 后记录订阅照常发起"
  );
  assert.equal(store["wx-notify-accepted"], true, "本地标记写入家庭作用域键(标记=展示启发式)");
  assert.equal(page.data.notifyAccepted, true, "入口收起(不再显示)");

  // 拒绝授权:不写标记、入口保留(可再点),不阻塞任何流程
  itemPageResetEnv();
  var store2 = patchPageStorage();
  subscribeDecision = "reject";
  itemRemindListRow = {
    item_id: "it-sub",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-11-01",
    kind: "有效期",
    generation: 5
  };
  var page2 = makePageFrom(itemConfig);
  itemConfig.applySummary.call(page2, itemSummary());
  await itemConfig.refreshReminderRow.call(page2);
  await settle();
  await itemConfig.onNotifyChipTap.call(page2);
  await settle();
  assert.equal(subscribeCalls.length, 1, "拒绝路径同样请求过授权");
  assert.equal(store2["wx-notify-accepted"], undefined, "拒绝:不写本地标记");
  assert.equal(page2.data.notifyAccepted, false, "拒绝:入口保留可再点");
});

test("SB-PAGE-ITEM-5:显式订阅入口的显示条件——已开启过(本地标记在)或无提醒都不露出", async function () {
  // 本地已标记「已成功开启」:即使有生效提醒,入口也不显示(notifyAccepted=true)
  itemPageResetEnv();
  var store = patchPageStorage();
  store["wx-notify-accepted"] = true; // 上次 accept 留下的家庭作用域标记
  itemRemindListRow = {
    item_id: "it-sub",
    name: "降压药",
    location_text: "厨房第二个抽屉",
    due_date: "2026-11-01",
    kind: "有效期",
    generation: 5
  };
  var page = makePageFrom(itemConfig);
  itemConfig.applySummary.call(page, itemSummary());
  await itemConfig.refreshReminderRow.call(page);
  await settle();
  assert.equal(page.data.remindAt, "2026-11-01", "前置:有生效提醒");
  assert.equal(page.data.notifyAccepted, true, "已开启过:入口不显示");

  // 无生效提醒:remindAt 为空,入口条件不成立(双保险门禁同样不请求)
  itemPageResetEnv();
  patchPageStorage();
  var page2 = makePageFrom(itemConfig);
  itemConfig.applySummary.call(page2, itemSummary());
  await itemConfig.refreshReminderRow.call(page2); // 远端确认无提醒
  await settle();
  assert.equal(page2.data.remindAt, "", "前置:无生效提醒");
  await itemConfig.onNotifyChipTap.call(page2);
  await settle();
  assert.equal(subscribeCalls.length, 0, "无提醒双保险:不请求订阅");
});

// ---------- SB-DIAG(#36 0.9.2 升级):订阅授权失败的版本分支诊断 ----------
// release 静默(现状);develop/trial 的 fail → console.warn 完整 errMsg +
// wx.showModal 全文(title「订阅失败」/content 完整 errMsg **不截断**/
// showCancel:false;#36 0.9.1 iOS 实测:toast 的 title 真机无论传多长
// 只显示约 30 字,三轮真机反馈都只见「fail c…」——modal 多行全文可截图,
// fail 不再 toast;success → 保留小 toast 授权结果状态(短文本 toast 足够);
// getAccountInfoSync 异常/缺失 → 保守按 release 静默(测试锁此行为)。

function makeEnvWx(envVersion, opts) {
  opts = opts || {};
  var wxStub = {
    requestSubscribeMessage: function (o) {
      if (opts.failErr) {
        o.fail({ errMsg: opts.failErr });
        return;
      }
      var res = {};
      res[TEMPLATE_ID] = opts.status || "accept";
      o.success(res);
    },
    showToast: function (o) {
      (opts.toasts = opts.toasts || []).push(o);
    },
    showModal: function (o) {
      (opts.modals = opts.modals || []).push(o);
    }
  };
  if (envVersion !== "missing") {
    wxStub.getAccountInfoSync = function () {
      if (envVersion === "throw") {
        throw new Error("getAccountInfoSync boom");
      }
      if (envVersion === "malformed") {
        return { miniProgram: null };
      }
      return { miniProgram: { envVersion: envVersion } };
    };
  }
  return wxStub;
}

test("SB-DIAG-1:develop fail → console.warn 完整 errMsg + modal「订阅失败」全文不截断(showCancel:false),不再 toast", async function () {
  var prevWx = globalThis.wx;
  var prevWarn = console.warn;
  var warns = [];
  console.warn = function () {
    warns.push(Array.prototype.slice.call(arguments).join(" "));
  };
  // 真机实测同款错误文本 + 长尾:超过 toast 60 字截断口径,证明 modal 全文
  // 不截断(#36 0.9.1 三轮真机只见「fail c…」,modal 必须全文可截图)
  var longErr =
    "requestSubscribeMessage:fail can only be invoked by user TAP gesture 吧啦吧啦很多字很多字吧啦吧啦很多字很多字吧啦吧啦很多字很多字";
  var opts = {};
  globalThis.wx = makeEnvWx("develop", { failErr: longErr, toasts: opts.toasts || (opts.toasts = []), modals: opts.modals || (opts.modals = []) });
  try {
    subscribe.requestExpirySubscribe();
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.equal(warns.length, 1, "warn 恰一次");
    assert.ok(warns[0].indexOf(longErr) !== -1, "warn 携带完整 errMsg(定位用)");
    assert.equal(opts.toasts.length, 0, "fail 不再 toast(真机 toast 只显约 30 字,显示不全没意义)");
    assert.equal(opts.modals.length, 1, "modal 恰一次");
    assert.equal(opts.modals[0].title, "订阅失败", "modal 标题");
    assert.equal(opts.modals[0].content, longErr, "modal content 完整 errMsg 全文(不截断,可截图回报)");
    assert.ok(
      opts.modals[0].content.indexOf("can only be invoked by user TAP gesture") !== -1,
      "关键错误名全文可见(0.9.1 toast 只剩「fail c」)"
    );
    assert.equal(opts.modals[0].showCancel, false, "单按钮 modal,不打断用户");
  } finally {
    console.warn = prevWarn;
    restoreWx(prevWx);
  }
});

test("SB-DIAG-2:release fail → 静默(现状零变化):不 warn、不 toast、不 modal", async function () {
  var prevWx = globalThis.wx;
  var prevWarn = console.warn;
  var warns = [];
  console.warn = function () {
    warns.push(1);
  };
  var toasts = [];
  var modals = [];
  globalThis.wx = makeEnvWx("release", { failErr: "requestSubscribeMessage:fail", toasts: toasts, modals: modals });
  try {
    subscribe.requestExpirySubscribe();
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.equal(warns.length, 0, "release 不 warn");
    assert.equal(toasts.length, 0, "release 不 toast(现状静默)");
    assert.equal(modals.length, 0, "release 不 modal(诊断升级只限 develop/trial)");
  } finally {
    console.warn = prevWarn;
    restoreWx(prevWx);
  }
});

test("SB-DIAG-3:develop success → toast「订阅:accept/reject」(不 modal);release success → 静默(记录照常)", async function () {
  var prevWx = globalThis.wx;
  var toasts = [];
  var modals = [];
  var calls = [];
  globalThis.wx = makeEnvWx("develop", { status: "accept", toasts: toasts, modals: modals });
  globalThis.wx.cloud = {
    callFunction: function (o) {
      calls.push(o.data.action);
    }
  };
  try {
    subscribe.requestExpirySubscribe();
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.deepEqual(calls, ["recordSubscription"], "accept 记录像常");
    assert.equal(toasts.length, 1, "develop toast 授权结果");
    assert.equal(toasts[0].title, "订阅:accept");
    assert.equal(toasts[0].duration, 4000, "success 保留小 toast duration 4000");
    assert.equal(modals.length, 0, "success 不 modal(短状态 toast 足够)");
  } finally {
    restoreWx(prevWx);
  }

  // reject:不记录,但仍 toast 状态
  prevWx = globalThis.wx;
  toasts = [];
  modals = [];
  calls = [];
  globalThis.wx = makeEnvWx("develop", { status: "reject", toasts: toasts, modals: modals });
  globalThis.wx.cloud = {
    callFunction: function (o) {
      calls.push(o.data.action);
    }
  };
  try {
    subscribe.requestExpirySubscribe();
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.equal(calls.length, 0, "reject 不记录");
    assert.equal(toasts[0].title, "订阅:reject", "拒绝也如实 toast 状态");
    assert.equal(modals.length, 0, "success 路径不 modal");
  } finally {
    restoreWx(prevWx);
  }

  // release success:静默(既有 SB-FLOW 断言同款行为,此处显式锁 envVersion=release)
  prevWx = globalThis.wx;
  toasts = [];
  modals = [];
  calls = [];
  globalThis.wx = makeEnvWx("release", { status: "accept", toasts: toasts, modals: modals });
  globalThis.wx.cloud = {
    callFunction: function (o) {
      calls.push(o.data.action);
    }
  };
  try {
    subscribe.requestExpirySubscribe();
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.deepEqual(calls, ["recordSubscription"], "release 记录像常");
    assert.equal(toasts.length, 0, "release 成功不 toast(静默现状)");
    assert.equal(modals.length, 0, "release 成功不 modal");
  } finally {
    restoreWx(prevWx);
  }
});

test("SB-DIAG-4:getAccountInfoSync 异常/缺失/形状异常 → 保守按 release 静默(fail 不 toast 不 modal 不 warn)", async function () {
  var prevWarn = console.warn;
  var warns = [];
  console.warn = function () {
    warns.push(1);
  };
  var cases = ["throw", "missing", "malformed"];
  try {
    for (var i = 0; i < cases.length; i++) {
      var prevWx = globalThis.wx;
      var toasts = [];
      var modals = [];
      globalThis.wx = makeEnvWx(cases[i], { failErr: "requestSubscribeMessage:fail", toasts: toasts, modals: modals });
      subscribe.requestExpirySubscribe();
      await new Promise(function (r) {
        setTimeout(r, 10);
      });
      assert.equal(toasts.length, 0, cases[i] + ":异常兜底保守静默=release 行为(不 toast)");
      assert.equal(modals.length, 0, cases[i] + ":不 modal");
      assert.equal(warns.length, 0, cases[i] + ":不 warn");
      restoreWx(prevWx);
    }
  } finally {
    console.warn = prevWarn;
  }
});

// ---------- SB-GESTURE(#36 0.9.2,请求前置零桥接调用):wx 调用序列结构断言 ----------
// 根因推理:0.9.1 真机(iOS)显式 bindtap 入口仍报「fail c…」(can only be
// invoked by user TAP gesture)——怀疑手势窗口内的同步桥接调用(如
// getAccountInfoSync)破坏了点击手势上下文。行为约束:wx.requestSubscribeMessage
// 必须是 requestExpirySubscribe 内**第一条** wx API 调用,环境诊断只能
// 事后在回调里做。用 Proxy recording wx 记录全部 wx 调用顺序锁死——
// 任何人把「请求前先查环境/先 toast/先读存储」加回来,这里立刻红。

/**
 * recording wx:Proxy 记录每一次 wx API 方法调用(属性读取不记录)。
 * opts.impl:方法名 → 真实行为(如 requestSubscribeMessage 回填 success);
 * opts.missing:按「API 不存在」处理(get 返回 undefined,模拟低版本基础库);
 * 返回 { calls: 调用名序列, wx: 可直接赋给 globalThis.wx 的 Proxy }。
 */
function makeGestureWx(opts) {
  opts = opts || {};
  var impl = opts.impl || {};
  var missing = opts.missing || [];
  var calls = [];
  var proxy = new Proxy(
    {},
    {
      get: function (target, prop) {
        if (typeof prop === "symbol") {
          return undefined;
        }
        if (prop === "cloud") {
          return {
            callFunction: function () {
              calls.push("cloud.callFunction");
            }
          };
        }
        if (missing.indexOf(prop) !== -1) {
          return undefined;
        }
        return function () {
          calls.push(String(prop));
          if (typeof impl[prop] === "function") {
            return impl[prop].apply(null, arguments);
          }
        };
      }
    }
  );
  return { calls: calls, wx: proxy };
}

test("SB-GESTURE-1:develop success 全链路——第一条 wx API 调用必须是 wx.requestSubscribeMessage(getAccountInfoSync 只能在其后)", async function () {
  var prevWx = globalThis.wx;
  var acceptRes = {};
  acceptRes[TEMPLATE_ID] = "accept";
  var rec = makeGestureWx({
    impl: {
      requestSubscribeMessage: function (o) {
        o.success(acceptRes);
      },
      getAccountInfoSync: function () {
        return { miniProgram: { envVersion: "develop" } };
      },
      showToast: function () {},
      showModal: function () {}
    }
  });
  globalThis.wx = rec.wx;
  try {
    subscribe.requestExpirySubscribe(function () {});
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.equal(
      rec.calls[0],
      "requestSubscribeMessage",
      "请求前置零桥接调用:第一条 wx API 调用必须是订阅请求本身(任何先行的 getAccountInfoSync/存储/toast 都会破坏 iOS 点击手势上下文)"
    );
    assert.ok(
      rec.calls.indexOf("requestSubscribeMessage") < rec.calls.indexOf("getAccountInfoSync"),
      "getAccountInfoSync(同步桥接调用)只能出现在请求之后的回调里,绝不先于请求"
    );
    // 全链路仍完整:请求 → 记录(accept)→ 环境诊断 → 状态 toast
    assert.deepEqual(
      rec.calls,
      ["requestSubscribeMessage", "cloud.callFunction", "getAccountInfoSync", "showToast"],
      "develop accept 全链路调用序列(诊断在请求之后)"
    );
  } finally {
    restoreWx(prevWx);
  }
});

test("SB-GESTURE-2:develop fail 路径同样请求先行;fail 诊断走 modal 不走 toast", async function () {
  var prevWx = globalThis.wx;
  var rec = makeGestureWx({
    impl: {
      requestSubscribeMessage: function (o) {
        o.fail({ errMsg: "requestSubscribeMessage:fail can only be invoked by user TAP gesture" });
      },
      getAccountInfoSync: function () {
        return { miniProgram: { envVersion: "develop" } };
      },
      showToast: function () {},
      showModal: function () {}
    }
  });
  globalThis.wx = rec.wx;
  try {
    subscribe.requestExpirySubscribe();
    await new Promise(function (r) {
      setTimeout(r, 10);
    });
    assert.equal(rec.calls[0], "requestSubscribeMessage", "fail 路径同样:订阅请求是第一条 wx API 调用");
    assert.ok(
      rec.calls.indexOf("requestSubscribeMessage") < rec.calls.indexOf("getAccountInfoSync"),
      "fail 诊断的环境检查同样只能在请求之后"
    );
    assert.deepEqual(
      rec.calls,
      ["requestSubscribeMessage", "getAccountInfoSync", "showModal"],
      "fail 路径序列:请求 → 环境诊断 → modal 全文(toast 已移除)"
    );
  } finally {
    restoreWx(prevWx);
  }
});

test("SB-GESTURE-3:低版本(无 requestSubscribeMessage)提前 return——零 wx API 调用(不发任何桥接调用)", function () {
  var prevWx = globalThis.wx;
  var rec = makeGestureWx({
    missing: ["requestSubscribeMessage"],
    impl: {
      getAccountInfoSync: function () {
        return { miniProgram: { envVersion: "develop" } };
      },
      showToast: function () {},
      showModal: function () {}
    }
  });
  globalThis.wx = rec.wx;
  try {
    assert.doesNotThrow(function () {
      subscribe.requestExpirySubscribe();
    }, "低版本降级不抛错");
    assert.equal(rec.calls.length, 0, "不发请求的降级路径同样零桥接调用(getAccountInfoSync 也不该被调)");
  } finally {
    restoreWx(prevWx);
  }
});
