"use strict";

/**
 * 拍照识物详情页证据回放卡(#3,IMPLEMENTATION.md §6)页面胶水回归:
 * onShow 按需拉取 photoEvidenceGet、证据视图上屏(含「位置已变更」历史
 * 语义)、无证据降级(失败静默整卡不渲染 / 成功无行显「去补拍」)、
 * 换链失败点按重试、重拍入口跳 photo 页。
 *
 * 被测对象是 `npm run build:mp` 产物 miniprogram/pages/item/item.js
 * (Page 构造器用桩捕获后按真实 setData 语义直调方法,与
 * tests/item-mount-conflict-gate.test.js 同款)。离线纪律:零网络、
 * 零外部依赖、不 require wx-server-sdk;证据行全部为合成数据。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");

/* ---------------- wx 桩 + Page 桩(先装好再 require 详情页产物) ---------------- */

var toasts = [];
var modals = [];
var navigations = [];
var cloudCalls = [];

/** photoEvidenceGet 的证据行(合成;默认单行有框) */
var evidenceRows = null;
/** photoEvidenceGet 是否失败 */
var evidenceFails = false;

function resetEnv() {
  toasts = [];
  modals = [];
  navigations = [];
  cloudCalls = [];
  evidenceRows = null;
  evidenceFails = false;
}

function localIso(y, m, d, h) {
  return new Date(y, m - 1, d, h || 10, 30, 0).toISOString();
}

function evRow(overrides) {
  return Object.assign(
    {
      item_id: "it-ev",
      file_id: "cloud://photo-evidence/default/202610/a.jpg",
      photo_url: "https://tmp.example/a.jpg",
      box: { x1: 0.273, y1: 0.389, x2: 0.593, y2: 0.507 },
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
    if (data.action === "remindList") {
      return { ok: true, reminders: [], household_id: "default" };
    }
    if (data.action === "photoEvidenceGet") {
      if (evidenceFails) {
        return Promise.reject(new Error("换链服务不可用"));
      }
      return {
        ok: true,
        household_id: "default",
        evidence: evidenceRows === null ? [] : evidenceRows,
      };
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
    navigateTo: function (o) {
      navigations.push(o && o.url);
    },
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
require(path.join(ROOT, "miniprogram", "pages", "item", "item.js"));

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

function summaryItem(overrides) {
  return Object.assign(
    {
      item_id: "it-ev",
      name: "7号电池",
      location_text: "客厅电视柜 · 第一层",
      note: "×24",
      version: 4,
      updated_at: localIso(2026, 10, 17, 9),
    },
    overrides,
  );
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

/** 进页:applySummary(位置基准)→ onShow(拉提醒 + 拉证据) */
async function openPage() {
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  pageConfig.onShow.call(page);
  await settlePromises();
  return page;
}

/* ---------------- 主线:拉取与数据映射上屏 ---------------- */

test("onShow 按需拉 photoEvidenceGet(单件):有证据行 → 证据卡就绪 + 折叠态", async function () {
  resetEnv();
  evidenceRows = [evRow()];
  var page = await openPage();

  var calls = evidenceCalls();
  assert.equal(calls.length, 1, "onShow 恰好拉一次");
  assert.deepEqual(calls[0].data.item_ids, ["it-ev"], "按 item_ids 批量查询");
  assert.equal(page.data.evidenceReady, true, "证据卡就绪");
  assert.equal(page.data.evidenceNoPhoto, false, "不是无证据行态");
  assert.equal(page.data.evidenceOpen, false, "默认折叠");
  var ev = page.data.evidence;
  assert.notEqual(ev, null, "视图已派生");
  assert.equal(
    ev.latest.badge,
    "📷 拍摄于 10-17 · 当时记录:客厅电视柜 · 第一层",
    "角标:当时记录,不冒充现在",
  );
  assert.deepEqual(
    ev.latest.box,
    { left: 27.3, top: 38.9, width: 32, height: 11.8 },
    "0-1 框已换算为百分比",
  );
});

test("历史语义:拍摄时位置 ≠ 当前记录 → changed +「现在:…(以文字为准);旧照片仅作证据」", async function () {
  resetEnv();
  evidenceRows = [evRow({ captured_location_text: "玄关柜 · 第二层" })];
  var page = await openPage();

  var latest = page.data.evidence.latest;
  assert.equal(latest.changed, true, "位置已变更判定(纯客户端)");
  assert.equal(
    latest.subText,
    "现在:客厅电视柜 · 第一层(以文字为准);旧照片仅作证据",
    "副文案以文字位置为准",
  );
});

test("历史语义:拍摄时位置与当前一致 →「照片与当前记录一致」", async function () {
  resetEnv();
  evidenceRows = [evRow()];
  var page = await openPage();
  var latest = page.data.evidence.latest;
  assert.equal(latest.changed, false);
  assert.equal(latest.subText, "照片与当前记录一致");
});

test("多行证据:最新主显,其余进「更早的照片」列表并可展开收起", async function () {
  resetEnv();
  evidenceRows = [
    evRow({ file_id: "cloud://old.jpg", photo_url: "https://tmp.example/old.jpg", created_at: localIso(2026, 9, 30, 10), captured_location_text: "书房" }),
    evRow({ created_at: localIso(2026, 10, 17, 10) }),
  ];
  var page = await openPage();

  assert.equal(page.data.evidence.latest.photoUrl, "https://tmp.example/a.jpg", "最新主显");
  assert.equal(page.data.evidence.olderCount, 1, "更早 1 张");
  assert.equal(page.data.evidenceOlderOpen, false, "更早列表默认收起");
  pageConfig.onEvidenceOlderToggle.call(page);
  assert.equal(page.data.evidenceOlderOpen, true, "点按展开");
  pageConfig.onEvidenceOlderToggle.call(page);
  assert.equal(page.data.evidenceOlderOpen, false, "再点收起");
});

/* ---------------- 无证据降级 ---------------- */

test("拉取失败:静默——无 toast/modal,整卡不渲染,详情主体不受影响", async function () {
  resetEnv();
  evidenceFails = true;
  var page = await openPage();

  assert.equal(evidenceCalls().length, 1, "确实发起过拉取");
  assert.equal(page.data.evidenceReady, false, "证据卡不渲染");
  assert.equal(page.data.evidenceNoPhoto, false, "失败不等于「没拍过照」:去补拍行也不显示");
  assert.equal(page.data.evidence, null);
  assert.equal(toasts.length, 0, "零 toast(增强露出绝不打扰详情主体)");
  assert.equal(modals.length, 0, "零 modal");
  assert.equal(page.data.name, "7号电池", "详情主体照常");
});

test("拉取成功但无证据行:显示「去补拍」行(evidenceNoPhoto),不出证据卡", async function () {
  resetEnv();
  evidenceRows = [];
  var page = await openPage();

  assert.equal(page.data.evidenceNoPhoto, true, "去补拍行显示");
  assert.equal(page.data.evidenceReady, false, "证据卡不渲染");
  assert.equal(page.data.evidence, null);
});

/* ---------------- 交互:展开 / 重试 / 重拍 ---------------- */

test("折叠条点按展开,再点收起", async function () {
  resetEnv();
  evidenceRows = [evRow()];
  var page = await openPage();

  pageConfig.onEvidenceTap.call(page);
  assert.equal(page.data.evidenceOpen, true, "点按展开");
  pageConfig.onEvidenceTap.call(page);
  assert.equal(page.data.evidenceOpen, false, "再点收起");
});

test("换链失败(photo_url 空):点按证据区 = 重新调 photoEvidenceGet 重试", async function () {
  resetEnv();
  evidenceRows = [evRow({ photo_url: "" })];
  var page = await openPage();
  assert.equal(page.data.evidence.latest.urlFail, true, "urlFail 标记");

  evidenceRows = [evRow({ photo_url: "https://tmp.example/retry.jpg" })];
  pageConfig.onEvidenceTap.call(page);
  await settlePromises();
  assert.equal(evidenceCalls().length, 2, "重试重新拉取");
  assert.equal(page.data.evidence.latest.urlFail, false, "换链恢复后失败标记消解");
  assert.equal(page.data.evidence.latest.photoUrl, "https://tmp.example/retry.jpg");
});

test("重拍更新/去补拍入口:跳 photo 页开新一批(不带恢复参数)", async function () {
  resetEnv();
  evidenceRows = [evRow()];
  var page = await openPage();
  pageConfig.onRetakeTap.call(page);
  assert.deepEqual(navigations, ["/pages/photo/photo"], "navigateTo photo 页");
  assert.equal(toasts.length, 0, "跳转成功不出错提示");
});

test("itemId 为空(进页参数缺失态)不发起证据拉取", async function () {
  resetEnv();
  var page = makePage();
  page.data.itemId = "";
  await pageConfig.refreshEvidence.call(page);
  await settlePromises();
  assert.equal(evidenceCalls().length, 0, "没有 item 就没有查询");
  assert.equal(page.data.evidenceNoPhoto, false, "也不误显「去补拍」");
});
