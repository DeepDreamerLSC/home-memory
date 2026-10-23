"use strict";

/**
 * Q2 客户端语音数量操作(issue #102 / Q0-CONTRACT §7.8 客户端确认流):
 * - 路由词表(detectQuantityOpSignal):加/减/设为句进数量流,移动/找回句
 *   就地提示零写入,新建句(「买了…」「剪刀放书房」「加湿器」)零回归走既有
 *   create 提取(意图词表 create/add/subtract/set/unknown 的 create 臂);
 * - 候选检索:itemsApi list → 名称在原话中的行(≤12)进 quantityIntentParse,
 *   绝不让模型直填 item_id;
 * - 确认页:原数量→变化→结果+位置/单位展示、needs_pick 不默认选中、
 *   单位不匹配/未确认行失败关闭、quantityAdjust 载荷(update_id+expected_version)、
 *   VERSION_CONFLICT 先展示最新值再显式重核对(绝不自动套旧 delta)、
 *   响应丢失同 payload 重试(最多生效一次)、取消零写入。
 * 被测对象是 `npm run build:mp` 产物 .js(package.json pretest 已保证先编译)。
 * 红绿纪律:本文件在未实现的代码上必须失败,实现后全绿。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var voiceQuantity = require("../miniprogram/utils/voice-quantity");
var voiceEntry = require("../miniprogram/utils/voice-entry");

/* ---------------- wx 桩 ---------------- */

function makeWxStub(opts) {
  opts = opts || {};
  var storage = new Map();
  var toasts = [];
  var modals = [];
  var navs = [];
  var backCount = 0;
  var cloudCalls = [];
  var stub = {
    toasts: toasts,
    modals: modals,
    navs: navs,
    backCount: backCount,
    cloudCalls: cloudCalls,
    wx: {
      getStorageSync: function (k) {
        return storage.has(k) ? storage.get(k) : "";
      },
      setStorageSync: function (k, v) {
        storage.set(k, v);
      },
      removeStorageSync: function (k) {
        storage.delete(k);
      },
      showToast: function (o) {
        toasts.push(o.title);
      },
      showModal: function (o) {
        modals.push(o);
        if (opts.onModal) {
          opts.onModal(o);
        }
      },
      showActionSheet: function () {},
      navigateTo: function (o) {
        navs.push(o.url);
      },
      navigateBack: function () {
        stub.backCount += 1;
      },
      cloud: {
        callFunction: function (o) {
          cloudCalls.push(o);
          Promise.resolve()
            .then(function () {
              return opts.router(o.name, o.data);
            })
            .then(
              function (result) {
                o.success({ result: result });
              },
              function (err) {
                o.fail({ errMsg: String((err && err.message) || err) });
              },
            );
        },
      },
    },
  };
  return stub;
}

function summaryItem(over) {
  return Object.assign(
    {
      item_id: "it-1",
      name: "棉柔巾",
      location_text: "卫生间镜柜",
      note: "",
      version: 3,
      updated_at: "2026-10-20T08:00:00.000Z",
      quantity: 5,
      unit: "包",
      quantity_confirmed_at: "2026-10-18T12:00:00.000Z",
    },
    over || {},
  );
}

function parseResult(over) {
  return Object.assign(
    {
      ok: true,
      engine: "deepseek",
      intent: "add",
      needs_pick: false,
      item_query: "棉柔巾",
      delta: 2,
      unit: "包",
      source_quote: "加两包",
      match: { candidate_index: 0, matched_word: "棉柔巾" },
    },
    over || {},
  );
}

function settle(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms || 40);
  });
}

/* ---------------- 路由词表(纯函数) ---------------- */

test("词表:加/减/设为句 → op;「还有」也进数量流由解析层判 unknown", function () {
  assert.equal(voiceQuantity.detectQuantityOpSignal("卫生间棉柔巾加两包"), "op");
  assert.equal(voiceQuantity.detectQuantityOpSignal("棉柔巾再来一包"), null, "「再来」不在一期词表,按现状走 create");
  assert.equal(voiceQuantity.detectQuantityOpSignal("用掉三包棉柔巾"), "op");
  assert.equal(voiceQuantity.detectQuantityOpSignal("棉柔巾用了两包"), "op");
  assert.equal(voiceQuantity.detectQuantityOpSignal("棉柔巾少了两包"), "op");
  assert.equal(voiceQuantity.detectQuantityOpSignal("棉柔巾减两包"), "op");
  assert.equal(voiceQuantity.detectQuantityOpSignal("棉柔巾现在有四包"), "op");
  assert.equal(voiceQuantity.detectQuantityOpSignal("棉柔巾改成四包"), "op");
  assert.equal(voiceQuantity.detectQuantityOpSignal("棉柔巾还有四包"), "op");
});

test("词表:移动/找回句 → move/find(零写入提示);新建句 → null(走既有 create 提取)", function () {
  assert.equal(voiceQuantity.detectQuantityOpSignal("把两包棉柔巾拿到卧室"), "move");
  assert.equal(voiceQuantity.detectQuantityOpSignal("两包棉柔巾搬到卧室"), "move");
  assert.equal(voiceQuantity.detectQuantityOpSignal("找一下棉柔巾"), "find");
  assert.equal(voiceQuantity.detectQuantityOpSignal("棉柔巾在哪里"), "find");
  // create 臂:绝不因含数量词或「加」字(加湿器)误入数量流
  assert.equal(voiceQuantity.detectQuantityOpSignal("买了三包棉柔巾放卫生间"), null);
  assert.equal(voiceQuantity.detectQuantityOpSignal("剪刀放书房"), null);
  assert.equal(voiceQuantity.detectQuantityOpSignal("加湿器放书房"), null);
  assert.equal(voiceQuantity.detectQuantityOpSignal("两盒抽纸放客厅"), null);
  assert.equal(voiceQuantity.detectQuantityOpSignal(""), null);
});

/* ---------------- 候选检索(纯函数) ---------------- */

test("候选检索:名称(归一)出现在原话中的行入选,封顶 12,按 item_id 去重", function () {
  var items = [
    summaryItem({ item_id: "it-1" }),
    summaryItem({ item_id: "it-2", name: "抽纸", location_text: "客厅" }),
    summaryItem({ item_id: "it-3", name: "棉柔巾加大款", location_text: "卧室" }),
    summaryItem({ item_id: "it-1" }),
  ];
  var got = voiceQuantity.buildQuantityCandidates("卫生间棉柔巾加两包", items);
  assert.equal(got.length, 1, "只收名称在原话中的行(加大款不在原话里)");
  assert.equal(got[0].item_id, "it-1");
  assert.equal(got[0].quantity, 5);
  assert.equal(got[0].unit, "包");
  assert.equal(got[0].version, 3);

  var many = [];
  for (var i = 0; i < 15; i++) {
    many.push(summaryItem({ item_id: "it-m" + i }));
  }
  assert.equal(voiceQuantity.buildQuantityCandidates("棉柔巾加两包", many).length, 12, "封顶 12");
  var legacy = voiceQuantity.buildQuantityCandidates("旧抽纸加两包", [
    summaryItem({ item_id: "it-l", name: "旧抽纸", quantity: null, unit: null, quantity_confirmed_at: null }),
  ]);
  assert.equal(legacy[0].quantity, null, "未确认行原样进候选(确认页展示待核对)");
});

test("数量预览:add/subtract/set 算术与失败关闭(BELOW_ZERO/OVER_MAX/UNCONFIRMED)", function () {
  assert.deepEqual(voiceQuantity.previewQuantity("add", 2, 5), { ok: true, result: 7 });
  assert.deepEqual(voiceQuantity.previewQuantity("subtract", 3, 5), { ok: true, result: 2 });
  assert.deepEqual(voiceQuantity.previewQuantity("set", 4, 5), { ok: true, result: 4 });
  assert.deepEqual(voiceQuantity.previewQuantity("set", 0, 5), { ok: true, result: 0 });
  assert.deepEqual(voiceQuantity.previewQuantity("subtract", 3, 2), { ok: false, reason: "BELOW_ZERO" });
  assert.deepEqual(voiceQuantity.previewQuantity("add", 2, 9998), { ok: false, reason: "OVER_MAX" });
  assert.deepEqual(voiceQuantity.previewQuantity("add", 2, null), { ok: false, reason: "UNCONFIRMED" });
  assert.deepEqual(voiceQuantity.previewQuantity("subtract", 1, null), { ok: false, reason: "UNCONFIRMED" });
});

/* ---------------- 语音入口路由(经 build 产物 voice-entry) ---------------- */

function setupEntry(router) {
  var stub = makeWxStub({ router: router });
  globalThis.wx = stub.wx;
  voiceEntry.__resetVoiceEntryForTest();
  voiceQuantity.__resetVoiceQuantityForTest();
  var host = {
    onStateChange: function () {},
    onTranscript: function () {},
    fallbackToText: function () {},
  };
  var handle = voiceEntry.attachVoiceEntry(host);
  return { stub: stub, handle: handle };
}

function defaultListRouter(extra) {
  return function (name, data) {
    if (name === "itemsApi" && data.action === "list") {
      return {
        ok: true,
        items: [summaryItem()],
        household_id: "hh_11111111111111111111111111111111",
      };
    }
    if (name === "extractDraft" && data.action === "quantityIntentParse") {
      return (extra && extra.parse) || parseResult();
    }
    if (name === "extractDraft") {
      return {
        ok: true,
        original_text: "买了三包棉柔巾放卫生间",
        drafts: [
          {
            name: "棉柔巾",
            location_text: "卫生间",
            certain: true,
            qualifiers: [],
            source_quote: "买了三包棉柔巾放卫生间",
          },
        ],
        truncated: false,
      };
    }
    return Promise.reject(new Error("意外调用 " + name + ":" + JSON.stringify(data)));
  };
}

test("路由:数量句 → 先 list 检索候选再 quantityIntentParse,跳数量确认页;绝不走 create 提取", async function () {
  var ctx = setupEntry(defaultListRouter());
  await ctx.handle.extract("卫生间棉柔巾加两包");
  await settle();
  assert.equal(ctx.stub.cloudCalls.length, 2, "一次 list + 一次解析");
  assert.equal(ctx.stub.cloudCalls[0].name, "itemsApi");
  assert.equal(ctx.stub.cloudCalls[0].data.action, "list");
  assert.equal(ctx.stub.cloudCalls[1].name, "extractDraft");
  assert.equal(ctx.stub.cloudCalls[1].data.action, "quantityIntentParse");
  assert.ok(Array.isArray(ctx.stub.cloudCalls[1].data.candidates), "候选随请求传入(不是数据库事实)");
  assert.equal(ctx.stub.cloudCalls[1].data.candidates.length, 1);
  assert.equal(ctx.stub.cloudCalls[1].data.candidates[0].item_id, "it-1");
  assert.equal(ctx.stub.navs.length, 1);
  assert.equal(ctx.stub.navs[0], "/pages/quantity-voice/quantity-voice");
  // 提议已交给确认页(模块 handoff)
  var handoff = voiceQuantity.takeQuantityConfirm();
  assert.ok(handoff, "确认页载荷经 handoff 交付");
  assert.equal(handoff.proposal.intent, "add");
  assert.equal(handoff.proposal.amount, 2);
  assert.equal(handoff.proposal.unit, "包");
  assert.equal(handoff.candidates.length, 1);
  ctx.handle.detach();
});

test("路由:移动句 → 就地提示不支持,零云调用零跳转", async function () {
  var ctx = setupEntry(defaultListRouter());
  await ctx.handle.extract("把两包棉柔巾拿到卧室");
  await settle();
  assert.equal(ctx.stub.cloudCalls.length, 0, "移动句零云调用");
  assert.equal(ctx.stub.navs.length, 0);
  assert.ok(ctx.stub.toasts.length > 0);
  ctx.handle.detach();
});

test("路由:找回句 → 就地引导搜索,零云调用零写入", async function () {
  var ctx = setupEntry(defaultListRouter());
  await ctx.handle.extract("找一下棉柔巾");
  await settle();
  assert.equal(ctx.stub.cloudCalls.length, 0);
  assert.equal(ctx.stub.navs.length, 0);
  assert.ok(ctx.stub.toasts.length > 0);
  ctx.handle.detach();
});

test("路由:解析回 unknown(还有歧义)→ 提示换说法,不跳页零写入", async function () {
  var ctx = setupEntry(
    defaultListRouter({
      parse: parseResult({ intent: "unknown", ambiguity: "maybe_total", delta: undefined, unit: undefined, match: undefined }),
    }),
  );
  await ctx.handle.extract("棉柔巾还有四包");
  await settle();
  assert.equal(ctx.stub.navs.length, 0);
  assert.equal(voiceQuantity.takeQuantityConfirm(), null, "unknown 不进确认页");
  assert.ok(ctx.stub.toasts.length > 0);
  ctx.handle.detach();
});

test("路由回归锚:新建句仍走既有 extractDraft create 提取并跳确认页(零回归)", async function () {
  var ctx = setupEntry(defaultListRouter());
  await ctx.handle.extract("买了三包棉柔巾放卫生间");
  await settle();
  assert.equal(ctx.stub.cloudCalls.length, 1);
  assert.equal(ctx.stub.cloudCalls[0].name, "extractDraft");
  assert.equal(ctx.stub.cloudCalls[0].data.protocol, 2);
  assert.equal(ctx.stub.navs.length, 1);
  assert.ok(ctx.stub.navs[0].indexOf("/pages/confirm/confirm?sid=") === 0);
  ctx.handle.detach();
});

/* ---------------- 确认页(build 产物页面) ---------------- */

var pageConfig;
var pageWxStub;

function installPageWx(router) {
  pageWxStub = makeWxStub({ router: router });
  globalThis.wx = pageWxStub.wx;
  globalThis.Page = function (config) {
    pageConfig = config;
  };
  // 重新加载页面模块以捕获新 Page 配置(handoff 状态在模块内,重载后为空,由用例注入)
  delete require.cache[require.resolve("../miniprogram/pages/quantity-voice/quantity-voice")];
  require("../miniprogram/pages/quantity-voice/quantity-voice");
  voiceQuantity.__resetVoiceQuantityForTest();
  return pageWxStub;
}

function pageOf(config) {
  var page = {
    data: JSON.parse(JSON.stringify(config.data)),
    setData: function (patch) {
      var keys = Object.keys(patch);
      var cur = page.data;
      for (var i = 0; i < keys.length; i++) {
        cur[keys[i]] = patch[keys[i]];
      }
    },
  };
  Object.keys(config).forEach(function (k) {
    if (k !== "data") page[k] = config[k];
  });
  return page;
}

function quantityAdjustRouter(result) {
  var calls = [];
  return {
    calls: calls,
    router: function (name, data) {
      if (name === "itemsApi" && data.action === "quantityAdjust") {
        calls.push(JSON.parse(JSON.stringify(data)));
        return typeof result === "function" ? result(calls.length, data) : result;
      }
      return Promise.reject(new Error("意外调用 " + name + ":" + data.action));
    },
  };
}

function okAdjustRes(over) {
  return {
    ok: true,
    item: summaryItem(Object.assign({ quantity: 7, version: 4 }, over || {})),
  };
}

test("确认页:单候选命中 → 直接确认视图,展示原数量→结果与位置/单位、原话保留", function () {
  var stub = installPageWx(function () {
    return Promise.reject(new Error("不应触云"));
  });
  voiceQuantity.beginQuantityConfirm({
    text: "卫生间棉柔巾加两包",
    proposal: { intent: "add", itemQuery: "棉柔巾", amount: 2, unit: "包", sourceQuote: "加两包", needsPick: false, matchIndex: 0 },
    candidates: [
      { item_id: "it-1", name: "棉柔巾", location_text: "卫生间镜柜", quantity: 5, unit: "包", version: 3 },
    ],
  });
  var page = pageOf(pageConfig);
  page.onLoad({});
  assert.equal(page.data.phase, "confirm");
  assert.equal(page.data.targetName, "棉柔巾");
  assert.equal(page.data.targetLocation, "卫生间镜柜");
  assert.equal(page.data.quote, "加两包");
  assert.equal(page.data.amountText, "2");
  assert.equal(page.data.previewLabel, "5 → 7");
  assert.equal(page.data.blockReason, "");
  assert.equal(stub.cloudCalls.length, 0, "进入确认视图零写入");
});

test("确认页:needs_pick 多候选 → 点选阶段不默认选中;未选定零写入", function () {
  installPageWx(function () {
    return Promise.reject(new Error("不应触云"));
  });
  voiceQuantity.beginQuantityConfirm({
    text: "棉柔巾加两包",
    proposal: { intent: "add", itemQuery: "棉柔巾", amount: 2, unit: "包", sourceQuote: "加两包", needsPick: true, matchIndex: null },
    candidates: [
      { item_id: "it-a", name: "棉柔巾", location_text: "客厅电视柜", quantity: 3, unit: "包", version: 1 },
      { item_id: "it-b", name: "棉柔巾", location_text: "卧室柜子", quantity: 2, unit: "盒", version: 5 },
    ],
  });
  var page = pageOf(pageConfig);
  page.onLoad({});
  assert.equal(page.data.phase, "pick");
  assert.equal(page.data.selectedIdx, -1, "模糊目标不默认选中(PR #103 决定 5)");
  // 用户点选第二件后进入确认视图,原数量/单位随目标切换
  page.onCandidateTap({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.data.phase, "confirm");
  assert.equal(page.data.targetLocation, "卧室柜子");
  assert.equal(page.data.previewLabel, "2 → 4");
});

test("确认页守卫:单位与目标不符禁止确认(E12 客户端预拦);未确认行增减禁止(E10 预拦);set 于未确认行可携单位确认", async function () {
  var qa = quantityAdjustRouter(okAdjustRes());
  installPageWx(qa.router);

  // 单位不符:提议「包」,目标记录是「盒」
  voiceQuantity.beginQuantityConfirm({
    text: "棉柔巾加两包",
    proposal: { intent: "add", itemQuery: "棉柔巾", amount: 2, unit: "包", sourceQuote: "加两包", needsPick: false, matchIndex: 0 },
    candidates: [{ item_id: "it-1", name: "棉柔巾", location_text: "卫生间镜柜", quantity: 5, unit: "盒", version: 3 }],
  });
  var mismatch = pageOf(pageConfig);
  mismatch.onLoad({});
  assert.equal(mismatch.data.phase, "confirm");
  assert.notEqual(mismatch.data.blockReason, "", "单位不符必须禁止确认");
  await mismatch.onConfirmTap();
  assert.equal(qa.calls.length, 0, "客户端预拦零云调用");

  // 未确认行 + add
  voiceQuantity.beginQuantityConfirm({
    text: "旧抽纸加两包",
    proposal: { intent: "add", itemQuery: "旧抽纸", amount: 2, unit: "包", sourceQuote: "加两包", needsPick: false, matchIndex: 0 },
    candidates: [{ item_id: "it-2", name: "旧抽纸", location_text: "客厅电视柜", quantity: null, unit: null, version: 2 }],
  });
  var unconfirmed = pageOf(pageConfig);
  unconfirmed.onLoad({});
  assert.notEqual(unconfirmed.data.blockReason, "", "未确认行增减必须先核对");
  await unconfirmed.onConfirmTap();
  assert.equal(qa.calls.length, 0);

  // 未确认行 + set(首次确认):选单位后可确认,unit 随载荷
  voiceQuantity.beginQuantityConfirm({
    text: "旧抽纸现在有四包",
    proposal: { intent: "set", itemQuery: "旧抽纸", amount: 4, unit: "包", sourceQuote: "四包", needsPick: false, matchIndex: 0 },
    candidates: [{ item_id: "it-2", name: "旧抽纸", location_text: "客厅电视柜", quantity: null, unit: null, version: 2 }],
  });
  var firstConfirm = pageOf(pageConfig);
  firstConfirm.onLoad({});
  assert.equal(firstConfirm.data.blockReason, "", "set 于未确认行携单位即可首次确认");
  assert.equal(firstConfirm.data.previewLabel, "待核对 → 4");
  await firstConfirm.onConfirmTap();
  assert.equal(qa.calls.length, 1);
  assert.equal(qa.calls[0].mode, "set");
  assert.equal(qa.calls[0].amount, 4);
  assert.equal(qa.calls[0].unit, "包");
  assert.equal(qa.calls[0].expected_version, 2);
  assert.ok(qa.calls[0].update_id, "update_id 必带");
});

test("确认页:确认 → quantityAdjust {item_id,expected_version,update_id,mode,amount,unit};成功后退页", async function () {
  var qa = quantityAdjustRouter(okAdjustRes());
  installPageWx(qa.router);
  voiceQuantity.beginQuantityConfirm({
    text: "卫生间棉柔巾加两包",
    proposal: { intent: "add", itemQuery: "棉柔巾", amount: 2, unit: "包", sourceQuote: "加两包", needsPick: false, matchIndex: 0 },
    candidates: [{ item_id: "it-1", name: "棉柔巾", location_text: "卫生间镜柜", quantity: 5, unit: "包", version: 3 }],
  });
  var page = pageOf(pageConfig);
  page.onLoad({});
  await page.onConfirmTap();
  assert.equal(qa.calls.length, 1);
  assert.equal(qa.calls[0].action, "quantityAdjust");
  assert.equal(qa.calls[0].item_id, "it-1");
  assert.equal(qa.calls[0].mode, "add");
  assert.equal(qa.calls[0].amount, 2);
  assert.equal(qa.calls[0].unit, "包");
  assert.equal(qa.calls[0].expected_version, 3, "expected_version 用候选读到的 version,绝不页面自造");
  assert.ok(qa.calls[0].update_id.length >= 1);
  await settle();
  assert.ok(pageWxStub.backCount >= 1, "成功后返回");
});

test("确认页:库存不足 subtract 预览失败关闭,零云调用", async function () {
  var qa = quantityAdjustRouter(okAdjustRes());
  installPageWx(qa.router);
  voiceQuantity.beginQuantityConfirm({
    text: "棉柔巾用掉三包",
    proposal: { intent: "subtract", itemQuery: "棉柔巾", amount: 3, unit: "包", sourceQuote: "三包", needsPick: false, matchIndex: 0 },
    candidates: [{ item_id: "it-1", name: "棉柔巾", location_text: "卫生间镜柜", quantity: 2, unit: "包", version: 3 }],
  });
  var page = pageOf(pageConfig);
  page.onLoad({});
  assert.notEqual(page.data.blockReason, "");
  await page.onConfirmTap();
  assert.equal(qa.calls.length, 0, "客户端先拦,服务端 QUANTITY_BELOW_ZERO 双门兜底");
});

test("确认页:VERSION_CONFLICT → 先展示家人最新值;重核对进入 set 模式且不自动套旧 delta,新确认用新 update_id+新版本", async function () {
  var qa = quantityAdjustRouter(function (n, data) {
    if (n === 1) {
      return {
        ok: false,
        error: "VERSION_CONFLICT",
        message: "内容已被修改,已为你刷新,请重试",
        current: summaryItem({ quantity: 7, unit: "包", version: 8 }),
      };
    }
    return okAdjustRes({ quantity: data.amount, version: 9 });
  });
  installPageWx(qa.router);
  voiceQuantity.beginQuantityConfirm({
    text: "卫生间棉柔巾加两包",
    proposal: { intent: "add", itemQuery: "棉柔巾", amount: 2, unit: "包", sourceQuote: "加两包", needsPick: false, matchIndex: 0 },
    candidates: [{ item_id: "it-1", name: "棉柔巾", location_text: "卫生间镜柜", quantity: 5, unit: "包", version: 3 }],
  });
  var page = pageOf(pageConfig);
  page.onLoad({});
  await page.onConfirmTap();
  await settle();
  assert.equal(page.data.phase, "conflict", "冲突先进展示,不直接写入");
  assert.ok(page.data.conflictLabel.indexOf("7") !== -1, "展示最新值 ×7包");

  // 显式重核对:进入 set 模式、金额清空(绝不自动 +2)
  page.onConflictReconfirmTap();
  assert.equal(page.data.phase, "confirm");
  assert.equal(page.data.modeIndex, 2, "重核对默认「设为当前总数」");
  assert.equal(page.data.amountText, "", "绝不自动套旧 delta");
  assert.equal(page.data.currentLabel, "×7包");

  // 用户核对实物后填 6 再确认:新 update_id、刷新后的 expected_version=8
  page.onAmountInput({ detail: { value: "6" } });
  await page.onConfirmTap();
  assert.equal(qa.calls.length, 2);
  assert.equal(qa.calls[1].mode, "set");
  assert.equal(qa.calls[1].amount, 6);
  assert.equal(qa.calls[1].expected_version, 8);
  assert.notEqual(qa.calls[1].update_id, qa.calls[0].update_id, "改值必须生成新操作");
});

test("确认页:响应丢失(网络失败)→ 结果不明弹窗;重试复用同 update_id+expected_version+payload(最多生效一次)", async function () {
  var qa = quantityAdjustRouter(function (n) {
    if (n === 1) {
      return Promise.reject(new Error("response lost"));
    }
    return { ok: true, item: summaryItem({ quantity: 7, version: 4 }), replayed: true };
  });
  var stub = installPageWx(qa.router);
  voiceQuantity.beginQuantityConfirm({
    text: "卫生间棉柔巾加两包",
    proposal: { intent: "add", itemQuery: "棉柔巾", amount: 2, unit: "包", sourceQuote: "加两包", needsPick: false, matchIndex: 0 },
    candidates: [{ item_id: "it-1", name: "棉柔巾", location_text: "卫生间镜柜", quantity: 5, unit: "包", version: 3 }],
  });
  var page = pageOf(pageConfig);
  page.onLoad({});
  await page.onConfirmTap();
  await settle();
  assert.equal(qa.calls.length, 1);
  assert.equal(page.data.phase, "confirm", "结果不明不进冲突态,等用户裁决");
  assert.equal(stub.modals.length, 1, "必须弹「结果不明」说明");
  assert.ok(String(stub.modals[0].content).indexOf("可能已保存") !== -1);
  // 用户选「重试」:同一 update_id + 原 expected_version + 原 payload
  stub.modals[0].success({ confirm: true });
  await settle();
  assert.equal(qa.calls.length, 2);
  assert.equal(qa.calls[1].update_id, qa.calls[0].update_id, "重试复用原 update_id");
  assert.equal(qa.calls[1].expected_version, qa.calls[0].expected_version);
  assert.equal(qa.calls[1].amount, qa.calls[0].amount);
  assert.equal(qa.calls[1].mode, qa.calls[0].mode);
  await settle();
  assert.ok(stub.backCount >= 1, "重试成功(含 replayed)后退页");
});

test("确认页:取消 → 直接退页零写入;handoff 缺失 → 如实提示并退页", async function () {
  var qa = quantityAdjustRouter(okAdjustRes());
  var stub = installPageWx(qa.router);
  voiceQuantity.beginQuantityConfirm({
    text: "卫生间棉柔巾加两包",
    proposal: { intent: "add", itemQuery: "棉柔巾", amount: 2, unit: "包", sourceQuote: "加两包", needsPick: true, matchIndex: null },
    candidates: [{ item_id: "it-1", name: "棉柔巾", location_text: "卫生间镜柜", quantity: 5, unit: "包", version: 3 }],
  });
  var page = pageOf(pageConfig);
  page.onLoad({});
  page.onCancelTap();
  assert.ok(stub.backCount >= 1);
  assert.equal(qa.calls.length, 0, "取消零写入");

  // handoff 缺失(直达页面/已被消费):如实提示并退页
  var orphan = pageOf(pageConfig);
  orphan.onLoad({});
  assert.ok(stub.toasts.length > 0);
  assert.ok(stub.backCount >= 2);
});
