"use strict";

/**
 * PR #56 架构复审 F4-B3 回归:冲突面板已弹(冲突未裁定)且待提交位置仍不同于
 * 已确认基准时,「整理位置」两个入口(onTidyTap→onMountTap 解析、confirmMount
 * 候选分段确认)与异步写入前(doLinkToNode 选择器回传)都不得发起
 * ensurePath / linkItem。
 *
 * 复审情景:两端把 location_text 改为 B/C,B 的冲突面板已出现且未选边,
 * 但 refreshForConflict 已对齐 version;旧代码直接「整理位置」可把
 * location_node_id 指向按本地 C 解析的位置,服务器 location_text 仍是
 * A 的 B(locations handler 仅写 node id)——位置事实分裂。
 *
 * 被测对象是 `npm run build:mp` 产物 miniprogram/pages/item/item.js
 * (Page 构造器用桩捕获后按真实 setData 语义直调方法,驱动页面状态流转
 * 而非字符串扫描),零外部依赖。红绿纪律:未修复代码上必须失败
 * (locations 写请求已发出),修复后转绿。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");

/* ---------------- wx 桩 + Page 桩(先装好再 require 详情页产物) ---------------- */

var toasts = [];
var modals = [];
var cloudCalls = [];

/** 服务端投影:itemsApi.get 返回的物品(冲突刷新用) */
var serverItem = null;

function resetEnv() {
  toasts = [];
  modals = [];
  cloudCalls = [];
  serverItem = null;
}

function router(name, data) {
  if (name === "households" && data.action === "status") {
    return { ok: true, household_id: "default", shared: false };
  }
  if (name === "itemsApi") {
    if (data.action === "remindList") {
      return { ok: true, reminders: [], household_id: "default" };
    }
    if (data.action === "get") {
      if (serverItem === null) {
        return Promise.reject(new Error("get 不可用"));
      }
      return { ok: true, item: serverItem };
    }
    if (data.action === "update") {
      // 选边后的文本保存:按提交内容回投影(版本推进)
      return {
        ok: true,
        item: {
          item_id: data.item_id,
          name: data.name !== undefined ? data.name : serverItem.name,
          location_text:
            data.location_text !== undefined ? data.location_text : serverItem.location_text,
          note: data.note !== undefined ? data.note : serverItem.note,
          version: serverItem.version + 1,
          updated_at: "2026-10-14T03:30:00.000Z",
        },
      };
    }
  }
  if (name === "locations") {
    if (data.action === "parseLocation") {
      return {
        ok: true,
        parse: {
          need_confirm: false,
          order_violation: false,
          segments: [{ name: "书房", confidence: 0.9 }],
          merge_suggestions: [],
        },
      };
    }
    if (data.action === "ensurePath") {
      return {
        ok: true,
        nodes: [{ location_id: "loc-parsed" }],
        created: [true],
      };
    }
    if (data.action === "linkItem") {
      return {
        ok: true,
        item: {
          item_id: data.item_id,
          version: 6,
          updated_at: "2026-10-14T03:00:00.000Z",
        },
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
require(path.join(ROOT, "miniprogram", "pages", "item", "item.js"));

/** setData 路径语法桩("conflicts[0].choice" 等;与真实 setData 同语义) */
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
      item_id: "it-b3",
      name: "护照",
      location_text: "玄关抽屉",
      note: "",
      version: 4,
      updated_at: "2026-10-14T02:00:00.000Z",
    },
    overrides,
  );
}

function locationsWriteCalls() {
  return cloudCalls.filter(function (c) {
    return (
      c.name === "locations" &&
      (c.data.action === "ensurePath" || c.data.action === "linkItem")
    );
  });
}

function settlePromises() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 20);
  });
}

/**
 * 驱动到复审情景:基准位置「玄关抽屉」,本机改「书房书桌」,远端改「主卧柜子」
 * → refreshForConflict 真实执行 → 位置冲突面板弹出、version 已对齐、未选边。
 */
async function conflictPendingPage() {
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  // 本机先改位置(保存会在真实环境撞版本,这里直接进冲突刷新同一入口)
  page.setData({ locationText: "书房书桌" });
  serverItem = summaryItem({ version: 5, location_text: "主卧柜子" });
  var result = await pageConfig.refreshForConflict.call(page);
  await settlePromises();
  assert.equal(result, "refreshed", "冲突刷新成功");
  assert.equal(page.data.version, 5, "version 已对齐远端(复审指出的危险前提)");
  assert.equal(page.data.conflicts.length, 1, "位置字段进冲突面板");
  assert.equal(page.data.conflicts[0].key, "location");
  assert.equal(page.data.conflicts[0].choice, null, "尚未选边");
  assert.equal(page.data.conflictPending, true, "冲突未裁定");
  assert.equal(page.data.locationText, "书房书桌", "表单位置是本地未裁定文本");
  assert.equal(page.original.location, "主卧柜子", "已确认基准是对方值");
  return page;
}

/* ---------------- F4-B3 主线:三个入口全部守门 ---------------- */

test("F4-B3-主:冲突未选边且位置异于基准,三个入口都不发 ensurePath/linkItem", async function () {
  resetEnv();
  var page = await conflictPendingPage();

  // 入口一:⋯ 菜单「整理位置」(onTidyTap → onMountTap)
  pageConfig.onTidyTap.call(page);
  await settlePromises();
  assert.equal(
    cloudCalls.filter(function (c) {
      return c.name === "locations" && c.data.action === "parseLocation";
    }).length,
    0,
    "入口一(onTidyTap→onMountTap):连解析都不发起,提示先选边保存",
  );
  assert.ok(
    toasts.some(function (t) {
      return t.title.indexOf("保存") !== -1;
    }),
    "提示先选保留哪一版并保存:" + JSON.stringify(toasts.map(function (t) { return t.title; })),
  );
  assert.equal(page.data.mountPanelOpen, false, "候选分段面板不出现");

  // 入口二:选择器异步回传(doLinkToNode,panel 期间状态可能已变)
  cloudCalls.length = 0;
  toasts = [];
  await pageConfig.doLinkToNode.call(page, "loc-9", ["书房", "书桌"]);
  await settlePromises();
  assert.equal(locationsWriteCalls().length, 0, "入口二(doLinkToNode):linkItem 未被调用");
  assert.equal(page.data.version, 5, "版本未被整理位置推进(没有任何挂载写入)");
  assert.ok(
    toasts.some(function (t) {
      return t.title.indexOf("保存") !== -1;
    }),
    "异步写入前同样提示先选边保存",
  );

  // 入口三:候选分段确认(confirmMount;面板是在冲突前解析好的,守门必须挡在写入前)
  page.setData({
    mountPanelOpen: true,
    mountSegments: [
      { idx: 0, name: "书房", confidenceText: "90%", needConfirm: false, hintName: "" },
    ],
  });
  cloudCalls.length = 0;
  toasts = [];
  await pageConfig.confirmMount.call(page);
  await settlePromises();
  assert.equal(locationsWriteCalls().length, 0, "入口三(confirmMount):ensurePath/linkItem 未被调用");
  assert.equal(page.data.mountPanelOpen, true, "候选面板保留,等用户先去处理冲突");
  // 服务端视角:location_text 仍是对方值,location_node_id 未被本地未裁定文本改写
  assert.equal(page.original.location, "主卧柜子", "已确认基准未被污染");
});

test("F4-B3-收敛:选边保存后(基准重置)整理位置恢复可用", async function () {
  resetEnv();
  var page = await conflictPendingPage();
  // 用户显式选「保留我的修改」并保存:文本以最新 expected_version 落库,
  // applySummary 重置基准、收起面板——此后整理位置回到既有可用路径
  pageConfig.applyConflictChoice.call(page, "location", "local");
  await pageConfig.onSaveTap.call(page);
  await settlePromises();
  assert.equal(page.data.conflicts.length, 0, "选边保存后面板收起");
  assert.equal(page.original.location, "书房书桌", "基准已重置为用户保存的值");

  cloudCalls.length = 0;
  toasts = [];
  pageConfig.onTidyTap.call(page);
  await settlePromises();
  assert.equal(
    cloudCalls.filter(function (c) {
      return c.name === "locations" && c.data.action === "parseLocation";
    }).length,
    1,
    "冲突裁定并保存后:整理位置恢复解析(既有行为不受影响)",
  );
  assert.equal(page.data.mountPanelOpen, true, "候选分段面板正常出现");
});

test("F4-B3-对照:位置字段已与基准收敛时,即使面板还在(其他字段未选完)也不拦整理", async function () {
  resetEnv();
  var page = await conflictPendingPage();
  // 再制造一个备注冲突;位置字段选「采用最新记录」(表单与基准一致):
  // 门禁条件是「冲突未裁定 且 待提交位置仍不同于已确认基准」,位置已收敛即放行
  serverItem = summaryItem({ version: 6, location_text: "主卧柜子", note: "家人备注" });
  page.setData({ note: "我的备注" });
  await pageConfig.refreshForConflict.call(page);
  await settlePromises();
  pageConfig.applyConflictChoice.call(page, "location", "remote");
  assert.equal(page.data.locationText, "主卧柜子", "位置已收敛到已确认基准");
  assert.equal(page.data.conflictPending, true, "备注仍未选边,面板还在");

  cloudCalls.length = 0;
  pageConfig.onTidyTap.call(page);
  await settlePromises();
  assert.equal(
    cloudCalls.filter(function (c) {
      return c.name === "locations" && c.data.action === "parseLocation";
    }).length,
    1,
    "位置与基准一致:解析放行(复审门禁条件的另一半边界)",
  );
});

test("F4-B3-常态:无冲突时普通编辑态(位置异于基准)整理位置照常可用", async function () {
  resetEnv();
  var page = makePage();
  pageConfig.applySummary.call(page, summaryItem());
  // 用户在编辑框改了位置但没保存(常态,无冲突面板):既有行为允许先整理
  page.setData({ locationText: "阳台柜子" });
  assert.equal(page.data.conflicts.length, 0, "无冲突态");

  pageConfig.onTidyTap.call(page);
  await settlePromises();
  assert.equal(page.data.mountPanelOpen, true, "常态整理位置不受门禁影响");

  cloudCalls.length = 0;
  await pageConfig.confirmMount.call(page);
  await settlePromises();
  assert.equal(locationsWriteCalls().length, 2, "常态:ensurePath + linkItem 照常发起");
});
