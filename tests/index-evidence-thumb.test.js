"use strict";

/**
 * 拍照识物首页搜索/找物结果行证据缩略(#3,IMPLEMENTATION.md §6 低成本增强):
 * 查询结果上屏后按需批量 photoEvidenceGet(≤10),有证据的行带 evidenceUrl
 * (照片替代首字图标);失败/无证据静默保持纯文字行;结果已收起或换新后
 * 旧响应绝不回写。
 *
 * 被测对象是 `npm run build:mp` 产物 miniprogram/pages/index/index.js
 * (Page 构造器用桩捕获后按真实 setData 语义直调 onQueryTap,与
 * tests/item-evidence.test.js 同款)。离线纪律:零网络、零外部依赖、
 * 不 require wx-server-sdk;证据行全部为合成数据。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");

/* ---------------- wx 桩 + Page 桩 ---------------- */

var toasts = [];
var modals = [];
var cloudCalls = [];

/** itemsApi.query 的返回(合成) */
var queryItems = [];
/** photoEvidenceGet 的证据行(合成) */
var evidenceRows = [];
/** photoEvidenceGet 是否失败 */
var evidenceFails = false;

function resetEnv() {
  toasts = [];
  modals = [];
  cloudCalls = [];
  queryItems = [];
  evidenceRows = [];
  evidenceFails = false;
}

function localIso(y, m, d, h) {
  return new Date(y, m - 1, d, h || 10, 30, 0).toISOString();
}

function queryItem(id, name) {
  return {
    item_id: id,
    name: name,
    location_text: "客厅电视柜 · 第一层",
    note: "",
    version: 1,
    updated_at: localIso(2026, 10, 17, 9),
  };
}

function evRow(itemId, overrides) {
  return Object.assign(
    {
      item_id: itemId,
      file_id: "cloud://photo-evidence/default/202610/" + itemId + ".jpg",
      photo_url: "https://tmp.example/" + itemId + ".jpg",
      box: null,
      img_w: 1024,
      img_h: 768,
      captured_location_text: "客厅电视柜 · 第一层",
      source: "vl",
      created_at: localIso(2026, 10, 17, 10),
    },
    overrides,
  );
}

function router(name, data) {
  if (name === "households" && data.action === "status") {
    return { ok: true, household_id: "default", shared: false };
  }
  if (name === "itemsApi") {
    if (data.action === "query") {
      return { ok: true, items: queryItems, match_type: "fuzzy" };
    }
    if (data.action === "photoEvidenceGet") {
      if (evidenceFails) {
        return Promise.reject(new Error("换链服务不可用"));
      }
      return { ok: true, household_id: "default", evidence: evidenceRows };
    }
  }
  return Promise.reject(new Error("意外调用 " + name + ":" + (data && data.action)));
}

function installWx() {
  globalThis.wx = {
    showToast: function (o) {
      toasts.push(o);
    },
    showModal: function (o) {
      modals.push(o);
      if (o.success) {
        o.success({ confirm: true });
      }
    },
    navigateTo: function () {},
    navigateBack: function () {},
    reLaunch: function () {},
    getStorageSync: function () { return ""; },
    setStorageSync: function () {},
    removeStorageSync: function () {},
    cloud: {
      callFunction: function (o) {
        cloudCalls.push({ name: o.name, data: JSON.parse(JSON.stringify(o.data)) });
        Promise.resolve()
          .then(function () {
            return router(o.name, o.data);
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
  };
}

var pageConfig = null;
globalThis.Page = function (config) {
  pageConfig = config;
};

installWx();
require(path.join(ROOT, "miniprogram", "pages", "index", "index.js"));

function setPath(obj, key, value) {
  var parts = key.replace(/\]/g, "").split(/[.[]/);
  var cur = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function makePage() {
  var page = {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData: function (patch) {
      Object.keys(patch).forEach(function (k) {
        if (k.indexOf(".") === -1 && k.indexOf("[") === -1) {
          page.data[k] = patch[k];
        } else {
          setPath(page.data, k, patch[k]);
        }
      });
    },
  };
  Object.keys(pageConfig).forEach(function (k) {
    if (k !== "data") {
      page[k] = pageConfig[k];
    }
  });
  return page;
}

function evidenceCalls() {
  return cloudCalls.filter(function (c) {
    return c.name === "itemsApi" && c.data.action === "photoEvidenceGet";
  });
}

function settlePromises() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 20);
  });
}

/** 直接驱动搜索(不进 onLoad/onShow 的地图加载链) */
async function runQuery(page, keyword) {
  page.setData({ queryText: keyword });
  await pageConfig.onQueryTap.call(page);
  await settlePromises();
}

/* ---------------- 主线 ---------------- */

test("查询结果上屏后按需批量拉证据:有证据的行带 evidenceUrl,无证据的行保持纯文字", async function () {
  resetEnv();
  queryItems = [queryItem("it-a", "7号电池"), queryItem("it-b", "牙膏")];
  evidenceRows = [evRow("it-a")];
  var page = makePage();
  await runQuery(page, "电池");

  var calls = evidenceCalls();
  assert.equal(calls.length, 1, "查询后恰拉一次证据");
  assert.deepEqual(
    calls[0].data.item_ids,
    ["it-a", "it-b"],
    "按结果 item_ids 批量查询",
  );
  assert.equal(page.data.queryResults.length, 2, "结果行数不变");
  assert.equal(page.data.queryResults[0].evidenceUrl, "https://tmp.example/it-a.jpg", "有证据行拿到缩略链接");
  assert.equal(page.data.queryResults[1].evidenceUrl, undefined, "无证据行不编造缩略");
  assert.equal(page.data.queryResults[0].location_text, "客厅电视柜 · 第一层", "行内位置仍是文字记录(照片不冒充当前位置)");
});

test("photoEvidenceGet 失败:静默——行保持纯文字,无 toast/modal,查询结果不受影响", async function () {
  resetEnv();
  queryItems = [queryItem("it-a", "7号电池")];
  evidenceFails = true;
  var page = makePage();
  await runQuery(page, "电池");

  assert.equal(evidenceCalls().length, 1, "确实发起过");
  assert.equal(page.data.queryResults.length, 1, "结果保留");
  assert.equal(page.data.queryResults[0].evidenceUrl, undefined, "缩略缺失静默");
  assert.equal(toasts.length, 0, "零 toast(增强露出)");
  assert.equal(modals.length, 0, "零 modal");
});

test("单次上限 10:超过 10 行只查前 10 个 item_id,其余行保持纯文字", async function () {
  resetEnv();
  queryItems = [];
  for (var i = 0; i < 12; i++) {
    queryItems.push(queryItem("it-" + i, "物品" + i));
  }
  evidenceRows = queryItems.map(function (it) { return evRow(it.item_id); });
  var page = makePage();
  await runQuery(page, "物品");

  var calls = evidenceCalls();
  assert.equal(calls.length, 1, "只拉一次");
  assert.equal(calls[0].data.item_ids.length, 10, "photoEvidenceGet 单次 ≤10(API 契约)");
  assert.deepEqual(
    calls[0].data.item_ids,
    queryItems.slice(0, 10).map(function (it) { return it.item_id; }),
    "取前 10 个(结果按相关度排序,前排优先)",
  );
  assert.equal(page.data.queryResults[9].evidenceUrl, "https://tmp.example/it-9.jpg", "前 10 行有缩略");
  assert.equal(page.data.queryResults[10].evidenceUrl, undefined, "第 11 行保持纯文字");
  assert.equal(page.data.queryResults[11].evidenceUrl, undefined, "第 12 行保持纯文字");
});

test("换链失败的证据行(空链接)不产生缩略;每件只取最新一张", async function () {
  resetEnv();
  queryItems = [queryItem("it-a", "7号电池"), queryItem("it-b", "棉柔巾")];
  evidenceRows = [
    evRow("it-a", { photo_url: "https://tmp.example/old.jpg", created_at: localIso(2026, 9, 1, 10) }),
    evRow("it-a", { created_at: localIso(2026, 10, 17, 10) }),
    evRow("it-b", { photo_url: "" }),
  ];
  var page = makePage();
  await runQuery(page, "电池");

  assert.equal(page.data.queryResults[0].evidenceUrl, "https://tmp.example/it-a.jpg", "取最新一张");
  assert.equal(page.data.queryResults[1].evidenceUrl, undefined, "空链接没有可渲染 src,该行保持纯文字");
});

test("用户已收起结果:在途证据响应回来不回写(不复活已收起的结果)", async function () {
  resetEnv();
  queryItems = [queryItem("it-a", "7号电池")];
  evidenceRows = [evRow("it-a")];
  var page = makePage();
  page.setData({ queryText: "电池" });
  var queryPromise = pageConfig.onQueryTap.call(page);
  // 查询在途时先不 settle;等第一轮 setData(queryResults 上屏)后立刻收起
  await new Promise(function (r) { setTimeout(r, 5); });
  pageConfig.onCollapseResultsTap.call(page);
  assert.equal(page.data.queried, false, "结果已收起");
  assert.equal(page.data.queryResults.length, 0, "结果已清空");
  await queryPromise;
  await settlePromises();

  assert.equal(page.data.queryResults.length, 0, "证据响应不回写已收起的结果");
  assert.equal(page.data.queried, false);
});
