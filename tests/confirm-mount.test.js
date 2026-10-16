"use strict";

/**
 * 「放进」自动挂靠(issue #45 十七轮,#18 红线语义升级)的客户端测试:
 * 被测对象是 `npm run build:mp` 产物(pretest 已保证先编译),零外部依赖。
 *
 * 覆盖:
 * - MNT-PURE:draftMountPathPreview / mountPathFromPick / saveRowWithMount
 *   纯函数(create/link 注入 mock)——certain 门、形状门、挂靠失败不回滚;
 * - MNT-API:locations.ensureAndLink 响应结构校验(already/item.version/path/
 *   created/location_ids 逐项);
 * - MNT-PAGE:确认页接线(Page 桩 + wx.cloud.callFunction 桩 + 草稿会话注入)——
 *   「放进」行渲染数据(mount_path 非空才显示)、「换」picker 替换、保存编排
 *   (create 成功后 ensureAndLink;挂靠失败物品保留 + 如实 toast,绝不回滚)、
 *   改位置文本即清路径预览(绝不挂背离的旧路径)+ 会话恢复不回生旧路径;
 * - MNT-STATIC:wxml 渲染结构 / create 请求结构不变(源码静态断言,中文文案在册)。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");
var bs = require("../miniprogram/utils/batch-save.js");
var locationsApi = require("../miniprogram/utils/locations-api.js");
var householdScope = require("../miniprogram/utils/household-scope.js");
var cache = require("../miniprogram/utils/locations-cache.js");
var ds = require("../miniprogram/utils/draft-session.js");

/* ---------------- wx 桩 + Page 桩(先装好再 require 确认页产物) ---------------- */

var toasts = [];
var navs = []; // navigateTo 的完整 options(含 events.pickNode)
var backDeltas = [];
var cloudCalls = [];
var pageStack = [];
var linkMode = "ok"; // ok | fail | network
var failLinkItemIds = null; // 指定这些 item_id 的挂靠失败(批量逐件独立用)
var linkOkResponse = null; // 覆盖 ensureAndLink 的 ok 响应(结构校验用)

function installWx() {
  globalThis.wx = {
    cloud: {
      callFunction: function (opts) {
        cloudCalls.push({ name: opts.name, data: JSON.parse(JSON.stringify(opts.data)) });
        Promise.resolve()
          .then(function () {
            return router(opts.name, opts.data);
          })
          .then(
            function (result) {
              opts.success({ result: result });
            },
            function (err) {
              opts.fail({ errMsg: String((err && err.message) || err) });
            },
          );
      },
    },
    showToast: function (o) {
      toasts.push(o);
    },
    showModal: function (o) { if (o && typeof o.success === "function") o.success({ confirm: false, cancel: true }); },
    navigateTo: function (o) {
      navs.push(o);
    },
    navigateBack: function (o) {
      backDeltas.push(o);
    },
    reLaunch: function () {},
    setNavigationBarTitle: function () {},
  };
}

/** 云函数路由桩:itemsApi.create / locations.ensureAndLink,其余一律意外失败 */
function router(name, data) {
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
        updated_at: "2026-10-15T10:00:00.000Z",
      },
    };
  }
  if (name === "locations" && data.action === "ensureAndLink") {
    if (linkOkResponse !== null) {
      return linkOkResponse;
    }
    var failed =
      linkMode === "fail" ||
      linkMode === "network" ||
      (failLinkItemIds !== null && failLinkItemIds.indexOf(data.item_id) !== -1);
    if (failed) {
      if (linkMode === "network") {
        return Promise.reject(new Error("network down"));
      }
      return Promise.reject({
        ok: false,
        error: "VERSION_CONFLICT",
        message: "内容已被修改,已为你刷新,请重试",
      });
    }
    return {
      ok: true,
      already: false,
      item: {
        item_id: data.item_id,
        version: 4,
        updated_at: "2026-10-15T10:00:01.000Z",
      },
      path: data.path,
      created: data.path.map(function () {
        return true;
      }),
      location_ids: data.path.map(function (_, i) {
        return "loc-" + i;
      }),
    };
  }
  return Promise.reject(new Error("意外调用 " + name + ":" + (data && data.action)));
}

globalThis.getCurrentPages = function () {
  return pageStack;
};

var pageOptions = null;
globalThis.Page = function (options) {
  pageOptions = options;
};

installWx();
require(path.join(ROOT, "miniprogram/pages/confirm/confirm.js"));

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

function resetEnv() {
  toasts = [];
  navs = [];
  backDeltas = [];
  cloudCalls = [];
  pageStack = [];
  linkMode = "ok";
  failLinkItemIds = null;
  linkOkResponse = null;
  ds.__resetDraftSessionForTest();
  ds.__setDraftSessionStorageForTest(makeFakeStorage());
  householdScope.__resetHouseholdScopeForTest();
  cache.__resetLocationsCacheForTest();
}

/** setData 路径语法桩("rows[0].mountPath" 等;与真实 setData 同语义) */
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
    data: JSON.parse(JSON.stringify(pageOptions.data)),
    sid: "",
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
  // 真实页面实例自带 Page 方法(页内 this.persistRows() 等互调);一并挂上
  Object.keys(pageOptions).forEach(function (k) {
    if (typeof pageOptions[k] === "function") {
      page[k] = pageOptions[k];
    }
  });
  return page;
}

function certainDraft(overrides) {
  // 草稿形状按 0.7.0 Fix 2 新合同:位置实体/mount_path 段名为剥方位后缀的
  // 裸实体(「主卧的柜子上」→ 主卧的柜子 / [主卧,柜子]);source_quote 仍逐字原话
  return Object.assign(
    {
      name: "护照",
      location_text: "主卧的柜子",
      certain: true,
      qualifiers: [],
      source_quote: "护照在主卧的柜子上",
      anchor_shared: false,
      remind_at: null,
      remind_kind: null,
      remind_quote: null,
      remind_vague_quote: null,
      mount_path: ["主卧", "柜子"],
    },
    overrides,
  );
}

/** 建一个草稿会话并让确认页 onLoad 完成,返回页面实例 */
function loadConfirmPage(drafts) {
  var page = makePage();
  pageStack = [page];
  var sid = ds.createDraftSession("原话整句", drafts, false);
  pageOptions.onLoad.call(page, { sid: sid });
  return page;
}

/* ---------------- MNT-PURE:纯函数 ---------------- */

test("MNT-PURE-1:draftMountPathPreview——certain 且形状合法才透传;certain=false 一律空(绝不猜路径)", function () {
  assert.deepEqual(
    bs.draftMountPathPreview({ certain: true, mount_path: ["主卧", "柜子"] }),
    ["主卧", "柜子"],
    "certain + 合法数组逐段透传",
  );
  assert.deepEqual(
    bs.draftMountPathPreview({ certain: true, mount_path: [" 主卧 ", "柜子"] }),
    ["主卧", "柜子"],
    "段去空白后透传",
  );
  // #18 红线:certain=false 即使带路径也一律空(服务端已强制 null,客户端守第二道门)
  assert.deepEqual(
    bs.draftMountPathPreview({ certain: false, mount_path: ["主卧", "柜子"] }),
    [],
    "certain=false → 空(=不显示「放进」行,照旧先进「尚未归类」)",
  );
  assert.deepEqual(bs.draftMountPathPreview({ certain: true, mount_path: null }), []);
  assert.deepEqual(bs.draftMountPathPreview({ certain: true, mount_path: undefined }), []);
  assert.deepEqual(bs.draftMountPathPreview({ certain: true }), []);
  assert.deepEqual(bs.draftMountPathPreview({ certain: true, mount_path: "主卧" }), [], "非数组不透传");
  assert.deepEqual(bs.draftMountPathPreview({ certain: true, mount_path: [] }), [], "空数组不透传");
  assert.deepEqual(
    bs.draftMountPathPreview({ certain: true, mount_path: ["一", "二", "三", "四", "五", "六", "七"] }),
    [],
    "超 6 段不透传(与 locations 节点同限)",
  );
  assert.deepEqual(bs.draftMountPathPreview({ certain: true, mount_path: ["主卧", "  "] }), [], "含空白段不透传");
  assert.deepEqual(bs.draftMountPathPreview({ certain: true, mount_path: ["主卧", 42] }), [], "非字符串段不透传");
  assert.deepEqual(
    bs.draftMountPathPreview({ certain: true, mount_path: ["一".repeat(31)] }),
    [],
    "超 30 码点段不透传",
  );
  assert.deepEqual(
    bs.draftMountPathPreview({ certain: true, mount_path: ["一".repeat(30)] }),
    ["一".repeat(30)],
    "恰好 30 码点透传(边界含)",
  );
});

test("MNT-PURE-2:mountPathFromPick——picker 回传只信严格结构,异常回传空数组不写", function () {
  assert.deepEqual(bs.mountPathFromPick({ path: ["书房", "书桌"] }), ["书房", "书桌"]);
  assert.deepEqual(bs.mountPathFromPick({ path: ["玄关"] }), ["玄关"], "单段路径有效");
  assert.deepEqual(bs.mountPathFromPick({}), []);
  assert.deepEqual(bs.mountPathFromPick({ path: undefined }), []);
  assert.deepEqual(bs.mountPathFromPick({ path: [] }), [], "根层(空路径)不可选,空回传不写");
  assert.deepEqual(bs.mountPathFromPick({ path: "书房" }), []);
  assert.deepEqual(bs.mountPathFromPick({ path: ["书房", null] }), []);
});

function mountRow(overrides) {
  return Object.assign(
    {
      key: "r0",
      name: "护照",
      locationText: "主卧的柜子",
      checked: true,
      status: "pending",
      failMsg: "",
      operationId: "op-1",
      mountPath: ["主卧", "柜子"],
      mountUpdateId: "u-1",
    },
    overrides,
  );
}

test("MNT-PURE-3:saveRowWithMount——create 成功后带最终路径挂靠,link 收到 item_id/版本/固定键", async function () {
  var creates = [];
  var links = [];
  var outcome = await bs.saveRowWithMount(
    mountRow(),
    function (row) {
      creates.push(row);
      return Promise.resolve({ item_id: "it-1", version: 3 });
    },
    function (args) {
      links.push(args);
      return Promise.resolve();
    },
  );
  assert.equal(outcome.mountFailed, false);
  assert.equal(creates.length, 1, "create 恰好一次");
  assert.deepEqual(
    links,
    [{ item_id: "it-1", expected_version: 3, path: ["主卧", "柜子"], update_id: "u-1" }],
    "挂靠用 create 返回的 item_id 与版本、行内固定幂等键、最终路径",
  );
});

test("MNT-PURE-4:saveRowWithMount——无路径不挂靠;挂靠失败绝不回滚(不抛错);create 失败原样抛出", async function () {
  var links = [];
  var outcome = await bs.saveRowWithMount(
    mountRow({ mountPath: [] }),
    function () {
      return Promise.resolve({ item_id: "it-1", version: 3 });
    },
    function (args) {
      links.push(args);
      return Promise.resolve();
    },
  );
  assert.equal(outcome.mountFailed, false);
  assert.equal(links.length, 0, "无「放进」路径的行绝不调挂靠");

  // 挂靠失败(网络/冲突):物品已记住,不回滚、不抛错,如实返回 mountFailed
  var failed = await bs.saveRowWithMount(
    mountRow(),
    function () {
      return Promise.resolve({ item_id: "it-2", version: 5 });
    },
    function () {
      return Promise.reject(new Error("network down"));
    },
  );
  assert.equal(failed.mountFailed, true, "挂靠失败如实标记,不吞成成功");

  // create 失败:原样抛出(行 failed,原 operation_id 重试)
  await assert.rejects(
    bs.saveRowWithMount(
      mountRow(),
      function () {
        return Promise.reject(new Error("timeout"));
      },
      function () {
        return Promise.resolve();
      },
    ),
    /timeout/,
    "create 失败必须上抛(挂靠不发生)",
  );
});

/* ---------------- MNT-API:ensureAndLink 响应结构校验 ---------------- */

test("MNT-API-1:ensureAndLink 走写类通道,响应逐项校验;残缺结构按异常处理", async function () {
  resetEnv();
  var res = await locationsApi.callLocationsApi({
    action: "ensureAndLink",
    item_id: "it-1",
    path: ["主卧", "柜子"],
    expected_version: 3,
    update_id: "u-1",
    created_from: "parse",
  });
  assert.equal(res.ok, true);
  assert.equal(res.already, false);
  assert.equal(res.item.version, 4);
  assert.deepEqual(res.path, ["主卧", "柜子"]);
  assert.equal(cloudCalls.length, 1);
  assert.equal(cloudCalls[0].name, "locations");
  // 个人态(未捕获作用域)不编造 marker:请求原样只含业务字段
  assert.deepEqual(
    Object.keys(cloudCalls[0].data).sort(),
    ["action", "created_from", "expected_version", "item_id", "path", "update_id"],
  );

  // 残缺响应(already 缺失):结构不符按异常响应处理,绝不当作挂靠成功
  resetEnv();
  linkOkResponse = {
    ok: true,
    item: { item_id: "it-1", version: 4, updated_at: "2026-10-15T10:00:01.000Z" },
    path: ["主卧"],
    created: [true],
    location_ids: ["loc-0"],
  };
  await assert.rejects(
    locationsApi.callLocationsApi({
      action: "ensureAndLink",
      item_id: "it-1",
      path: ["主卧"],
      expected_version: 3,
      update_id: "u-2",
    }),
    function (e) {
      return e && e.code === "CLIENT_BAD_RESPONSE";
    },
    "缺 already 字段按异常响应处理(挂靠是否成功绝不含糊)",
  );
});

/* ---------------- MNT-PAGE:确认页接线(渲染 / picker 替换 / 保存编排) ---------------- */

test("MNT-PAGE-1:确认行渲染数据——mount_path 非空才显示「放进」行;certain=false 恒空", function () {
  resetEnv();
  var page = loadConfirmPage([certainDraft()]);
  var row = page.data.rows[0];
  assert.equal(row.mountPathText, "主卧 / 柜子", "C1「放进」行显示路径文本(段间「 / 」)");
  assert.deepEqual(row.mountPath, ["主卧", "柜子"]);
  assert.ok(typeof row.mountUpdateId === "string" && row.mountUpdateId.length > 0, "行内固定挂靠幂等键在册");
  assert.equal(row.checked, true, "certain 且有专属证据默认勾选(既有行为不变)");

  resetEnv();
  page = loadConfirmPage([certainDraft({ mount_path: null })]);
  assert.equal(page.data.rows[0].mountPathText, "", "无 mount_path 不显示该行(=不挂靠)");

  resetEnv();
  page = loadConfirmPage([
    certainDraft({ certain: false, location_text: "", source_quote: "护照好像在某个抽屉" }),
  ]);
  assert.equal(
    page.data.rows[0].mountPathText,
    "",
    "certain=false 一律无「放进」行(照旧先进「尚未归类」),即使恶意带路径",
  );
});

test("MNT-PAGE-2:「换」进 locations 选位置(picker 模式),选定后路径替换为所选;异常回传不写", function () {
  resetEnv();
  var page = loadConfirmPage([certainDraft()]);
  pageOptions.onMountSwapTap.call(page, { currentTarget: { dataset: { index: 0 } } });
  assert.equal(navs.length, 1, "「换」发起一次选位置");
  assert.equal(
    navs[0].url,
    "/pages/locations/locations?picker=1&title=" + encodeURIComponent("放进哪儿"),
    "复用既有 locations 选位置弹层(picker 模式)",
  );

  // 选择器逐层下钻后回传:页面栈 = [确认页, 选择器第 1 层, 选择器第 2 层]
  pageStack = [page, { route: "picker-l1" }, { route: "picker-l2" }];
  navs[0].events.pickNode({ location_id: "l9", name: "书桌", path: ["书房", "书桌"] });
  assert.equal(page.data.rows[0].mountPathText, "书房 / 书桌", "选定后「放进」路径替换为所选");
  assert.deepEqual(page.data.rows[0].mountPath, ["书房", "书桌"]);
  assert.equal(backDeltas.length, 1, "退栈由发起页统一计算(一次退掉上方全部选择器层)");
  assert.equal(backDeltas[0].delta, 2);

  // 异常回传(空路径):不写,原路径保持
  pageOptions.onMountSwapTap.call(page, { currentTarget: { dataset: { index: 0 } } });
  navs[1].events.pickNode({ location_id: "l9", name: "书桌", path: [] });
  assert.equal(page.data.rows[0].mountPathText, "书房 / 书桌", "异常回传不写,路径保持");

  // 没有该行的件(certain=false)不进选位置
  resetEnv();
  page = loadConfirmPage([certainDraft({ certain: false, location_text: "", source_quote: "护照好像在某个抽屉" })]);
  pageOptions.onMountSwapTap.call(page, { currentTarget: { dataset: { index: 0 } } });
  assert.equal(navs.length, 0, "certain=false 无「放进」行,「换」不可进");
});

test("MNT-PAGE-3:保存编排——create 成功后按最终路径 ensureAndLink;create 请求结构不变", async function () {
  resetEnv();
  var page = loadConfirmPage([certainDraft()]);
  // 先「换」一次:挂靠必须用最终路径,不是草稿预览
  pageOptions.onMountSwapTap.call(page, { currentTarget: { dataset: { index: 0 } } });
  pageStack = [page, { route: "picker-l1" }];
  navs[0].events.pickNode({ location_id: "l9", name: "书桌", path: ["书房", "书桌"] });

  await pageOptions.onSaveBatchTap.call(page);

  assert.equal(page.data.rows[0].status, "saved", "物品保存成功");
  assert.equal(cloudCalls.length, 2, "create 一次 + 挂靠一次");
  assert.equal(cloudCalls[0].name, "itemsApi");
  assert.equal(cloudCalls[0].data.action, "create");
  // create 请求结构不变:只含既有字段,不带任何挂靠/路径字段(服务端 itemsApi 零改动)
  assert.deepEqual(
    Object.keys(cloudCalls[0].data).sort(),
    ["action", "location_text", "name", "operation_id"],
    "create 事件键与十七轮前逐项一致",
  );
  assert.equal(cloudCalls[1].name, "locations");
  assert.deepEqual(cloudCalls[1].data, {
    action: "ensureAndLink",
    item_id: "it-" + page.data.rows[0].operationId,
    path: ["书房", "书桌"],
    expected_version: 3,
    update_id: page.data.rows[0].mountUpdateId,
    created_from: "parse",
  }, "挂靠带最终路径(「换」过的)、create 返回的版本与行内固定键");
  assert.deepEqual(
    toasts.map(function (t) {
      return t.title;
    }),
    ["记住了,下次问我。"],
    "挂靠成功回执沿用既有文案",
  );
});

test("MNT-PAGE-4:挂靠失败回退——物品保留(行 saved)、绝不回滚、如实 toast;网络失败同口径", async function () {
  // 服务端拒绝(版本冲突)
  resetEnv();
  linkMode = "fail";
  var page = loadConfirmPage([certainDraft()]);
  await pageOptions.onSaveBatchTap.call(page);
  assert.equal(page.data.rows[0].status, "saved", "挂靠失败物品仍为已保存(绝不回滚)");
  assert.equal(cloudCalls.length, 2, "create + ensureAndLink 各一次,没有重试风暴");
  assert.equal(
    cloudCalls.filter(function (c) {
      return c.name === "itemsApi" && c.data.action !== "create";
    }).length,
    0,
    "绝不因挂靠失败对物品做任何补救写入(无 update/delete 回滚)",
  );
  assert.deepEqual(
    toasts.map(function (t) {
      return t.title;
    }),
    ["已记住,位置还没归位,稍后在详情整理"],
    "如实告知去向(照旧在「尚未归类」)",
  );

  // 网络失败(callFunction fail)同口径
  resetEnv();
  linkMode = "network";
  page = loadConfirmPage([certainDraft()]);
  await pageOptions.onSaveBatchTap.call(page);
  assert.equal(page.data.rows[0].status, "saved", "网络失败同样物品保留");
  assert.deepEqual(
    toasts.map(function (t) {
      return t.title;
    }),
    ["已记住,位置还没归位,稍后在详情整理"],
    "网络失败同口径 toast",
  );
});

test("MNT-PAGE-5:批量每件独立——逐件 create 后逐件挂靠,一件挂靠失败不影响其余件", async function () {
  resetEnv();
  var page = loadConfirmPage([
    certainDraft({ name: "钥匙", location_text: "玄关抽屉", source_quote: "钥匙在玄关抽屉", mount_path: ["玄关", "抽屉"] }),
    certainDraft({ name: "充电宝", location_text: "客厅茶几", source_quote: "充电宝在客厅茶几", mount_path: ["客厅", "茶几"] }),
    certainDraft({
      name: "护照",
      location_text: "",
      certain: false,
      source_quote: "护照好像在书房某个抽屉",
      mount_path: null,
    }),
  ]);
  assert.equal(page.data.checkedCount, 2, "两件默认勾选,模糊件不勾(既有安全门不变)");

  // 预先标记第二件的挂靠失败(item_id = "it-" + 其行内 operation_id)
  var secondItemId = "it-" + page.data.rows[1].operationId;
  failLinkItemIds = [secondItemId];
  await pageOptions.onSaveBatchTap.call(page);

  assert.equal(page.data.rows[0].status, "saved", "第一件不受影响");
  assert.equal(page.data.rows[1].status, "saved", "挂靠失败的第二件物品照样已保存");
  assert.equal(page.data.rows[2].status, "pending", "未勾选的模糊件不进入写请求");
  var creates = cloudCalls.filter(function (c) {
    return c.data.action === "create";
  });
  var links = cloudCalls.filter(function (c) {
    return c.data.action === "ensureAndLink";
  });
  assert.equal(creates.length, 2, "每件独立 create");
  assert.equal(links.length, 2, "每件独立挂靠");
  assert.deepEqual(
    links.map(function (l) {
      return l.data.path;
    }),
    [["玄关", "抽屉"], ["客厅", "茶几"]],
    "两件各挂各的最终路径",
  );
  assert.equal(links[1].data.item_id, secondItemId, "失败的是第二件的挂靠");
  assert.deepEqual(
    toasts.map(function (t) {
      return t.title;
    }),
    ["已记住,位置还没归位,稍后在详情整理"],
    "只要有挂靠没成,回执如实提示整理位置",
  );
});

test("MNT-PAGE-6:无 mount_path 的行保存——不调挂靠,行为与十七轮前一致", async function () {
  resetEnv();
  var page = loadConfirmPage([certainDraft({ mount_path: null })]);
  await pageOptions.onSaveBatchTap.call(page);
  assert.equal(page.data.rows[0].status, "saved");
  assert.equal(
    cloudCalls.filter(function (c) {
      return c.name === "locations";
    }).length,
    0,
    "无路径预览绝不调 ensureAndLink(绝不静默建路径)",
  );
  assert.deepEqual(
    toasts.map(function (t) {
      return t.title;
    }),
    ["记住了,下次问我。"],
  );
});

test("MNT-PAGE-7:改位置文本即清「放进」预览(回「尚未归类」口径)——提交绝不挂背离的旧路径", async function () {
  resetEnv();
  var page = loadConfirmPage([certainDraft()]);
  assert.equal(page.data.rows[0].mountPathText, "主卧 / 柜子", "初始带「放进」预览");

  // 用户把「主卧的柜子」改成「书房」:预览随之清空,「放进」行不再显示
  pageOptions.onRowLocationInput.call(page, {
    currentTarget: { dataset: { index: 0 } },
    detail: { value: "书房" },
  });
  assert.equal(page.data.rows[0].locationText, "书房", "位置文本已更新");
  assert.deepEqual(page.data.rows[0].mountPath, [], "位置文本变化清空「放进」路径");
  assert.equal(page.data.rows[0].mountPathText, "", "「放进」行不再显示(不误导挂靠)");

  // 提交:location_text 存新文本,绝不 ensureAndLink 挂进「主卧/柜子」旧路径
  await pageOptions.onSaveBatchTap.call(page);
  assert.equal(page.data.rows[0].status, "saved");
  assert.equal(cloudCalls.length, 1, "只有 create,没有挂靠调用");
  assert.equal(cloudCalls[0].data.location_text, "书房", "create 存用户改后的文本");
  assert.equal(
    cloudCalls.filter(function (c) {
      return c.name === "locations";
    }).length,
    0,
    "改过位置文本的行绝不挂旧路径(#18 红线边角:挂靠目标不得背离刚编辑的文本)",
  );
  assert.deepEqual(
    toasts.map(function (t) {
      return t.title;
    }),
    ["记住了,下次问我。"],
    "回执与无路径行一致(先进「尚未归类」,与 §2.5 手补自由文本口径相同)",
  );

  // 「换」选过的路径同理:用户再改位置文本 = 否认该路径,同样清空(规则不分来源)
  resetEnv();
  page = loadConfirmPage([certainDraft()]);
  pageOptions.onMountSwapTap.call(page, { currentTarget: { dataset: { index: 0 } } });
  pageStack = [page, { route: "picker-l1" }];
  navs[0].events.pickNode({ location_id: "l9", name: "书桌", path: ["书房", "书桌"] });
  assert.deepEqual(page.data.rows[0].mountPath, ["书房", "书桌"], "「换」后路径为所选");
  pageOptions.onRowLocationInput.call(page, {
    currentTarget: { dataset: { index: 0 } },
    detail: { value: "阳台柜" },
  });
  assert.deepEqual(page.data.rows[0].mountPath, [], "改位置文本对「换」过的路径同样清空");
});

test("MNT-PAGE-8:清空的路径随会话回写——进程回收恢复不回生草稿预览的旧路径", function () {
  resetEnv();
  var page = loadConfirmPage([certainDraft()]);
  pageOptions.onRowLocationInput.call(page, {
    currentTarget: { dataset: { index: 0 } },
    detail: { value: "书房" },
  });

  // 回写会话里就是空数组(既不是缺省,也不是旧路径)
  var persisted = ds.getDraftSession(page.sid);
  assert.ok(persisted && persisted.rows, "清路径当即回写了行状态");
  assert.deepEqual(persisted.rows[0].mountPath, [], "回写值为空数组");

  // 模拟进程回收(清内存会话,持久层保留):恢复后不得回生「主卧/柜子」
  ds.simulateProcessRestartForTest();
  var page2 = makePage();
  pageStack = [page2];
  pageOptions.onLoad.call(page2, { sid: page.sid });
  assert.equal(page2.data.rows[0].locationText, "书房", "恢复出改后的位置文本");
  assert.deepEqual(page2.data.rows[0].mountPath, [], "恢复后路径仍为空(绝不回生旧路径)");
  assert.equal(page2.data.rows[0].mountPathText, "", "「放进」行恢复后同样不显示");
});

test("MNT-PAGE-9:多件(C2)只清被改的行——其余行的「将放入」预览与挂靠不受影响", async function () {
  resetEnv();
  var page = loadConfirmPage([
    certainDraft({ name: "钥匙", location_text: "玄关抽屉", source_quote: "钥匙在玄关抽屉", mount_path: ["玄关", "抽屉"] }),
    certainDraft({ name: "充电宝", location_text: "客厅茶几", source_quote: "充电宝在客厅茶几", mount_path: ["客厅", "茶几"] }),
  ]);
  // 只改第二行的位置文本:第二行预览清空,第一行保持
  pageOptions.onRowLocationInput.call(page, {
    currentTarget: { dataset: { index: 1 } },
    detail: { value: "阳台" },
  });
  assert.deepEqual(page.data.rows[0].mountPath, ["玄关", "抽屉"], "未编辑的行路径保持");
  assert.deepEqual(page.data.rows[1].mountPath, [], "被编辑的行清空");
  assert.equal(page.data.rows[1].locationText, "阳台");

  await pageOptions.onSaveBatchTap.call(page);
  var links = cloudCalls.filter(function (c) {
    return c.data.action === "ensureAndLink";
  });
  assert.equal(links.length, 1, "只有未编辑的第一件挂靠");
  assert.deepEqual(links[0].data.path, ["玄关", "抽屉"], "挂的是未编辑行的原路径");
  assert.equal(
    cloudCalls.filter(function (c) {
      return c.data.action === "create";
    })[1].data.location_text,
    "阳台",
    "被编辑行 create 存改后文本、不挂靠",
  );
});

/* ---------------- MNT-STATIC:渲染结构与请求结构的源码断言 ---------------- */

function read(rel) {
  return fs.readFileSync(path.join(ROOT, "miniprogram", rel), "utf8");
}

test("MNT-STATIC-1:confirm.wxml——C1「放进」行/C2「将放入」副文按 mountPathText 渲染,「换」接线", function () {
  var wxml = read("pages/confirm/confirm.wxml");
  // C1:「放进」行只在 mountPathText 非空时渲染(mount_path 为空不显示该行)
  var c1 = wxml.slice(wxml.indexOf('wx:if="{{ rows[0].mountPathText }}"'), wxml.indexOf('wx:if="{{ rows[0].mountPathText }}"') + 700);
  assert.ok(c1.indexOf(">放进</view>") !== -1, "「放进」行标签在册");
  assert.ok(c1.indexOf("{{ rows[0].mountPathText }}") !== -1, "路径文本在册");
  assert.ok(c1.indexOf("onMountSwapTap") !== -1, "「换」接线 onMountSwapTap");
  assert.ok(c1.indexOf("sum-edit-face\">换</view>") !== -1, "「换」复用行内小钮视觉(热区 88/面 66 先例)");
  // C2:certain 行副文「将放入:X」
  assert.ok(wxml.indexOf('wx:if="{{ item.mountPathText }}"') !== -1, "C2 副文按行渲染");
  assert.ok(wxml.indexOf("将放入:{{ item.mountPathText }}") !== -1, "C2 副文文案「将放入:X」在册");
  // 屏底信任句:有「放进」预览时明示路径也还没放
  assert.ok(
    wxml.indexOf("点「确认记住」之前,什么都不会保存;「放进」的位置也还没放。") !== -1,
    "信任句同步(确认之前路径也还没放)",
  );
  assert.ok(wxml.indexOf("你确认后,我才会真正记住。") !== -1, "既有信任句保留");
});

test("MNT-STATIC-2:confirm.wxss——C2 副文「换」触点 ≥88rpx(热区分层口径)", function () {
  var css = read("pages/confirm/confirm.wxss");
  assert.ok(/\.row-mount-swap\s*\{[^}]*min-height:\s*88rpx/.test(css), "「换」热区 ≥88rpx(44px)");
  assert.ok(/\.row-mount-text\s*\{[^}]*color:\s*var\(--text-2\)/.test(css), "副文用次级文字色");
});

test("MNT-STATIC-3:confirm.ts——create 请求结构不变(挂靠编排全在客户端);挂靠失败文案在册", function () {
  var ts = read("pages/confirm/confirm.ts");
  // create 调用块内不得出现任何挂靠/路径字段
  var createBlock = ts.slice(ts.indexOf('callItemsApi({'), ts.indexOf('callItemsApi({') + 700);
  assert.ok(createBlock.indexOf('action: "create"') !== -1);
  ["mount", "location_node_id", "path"].forEach(function (word) {
    assert.ok(createBlock.indexOf(word) === -1, "create 请求不得携带挂靠相关字段:" + word);
  });
  // 挂靠走 locations.ensureAndLink,created_from 记 parse(路径段来自确认卡明示的原话拆层)
  assert.ok(ts.indexOf('action: "ensureAndLink"') !== -1, "挂靠走 locations.ensureAndLink");
  assert.ok(ts.indexOf('created_from: "parse"') !== -1);
  assert.ok(ts.indexOf("已记住,位置还没归位,稍后在详情整理") !== -1, "挂靠失败如实文案在册");
  assert.ok(ts.indexOf("绝不回滚") !== -1, "不回滚语义注释在册");
  // 「换」复用 locations 页既有 picker 模式
  assert.ok(ts.indexOf("picker=1") !== -1 && ts.indexOf("放进哪儿") !== -1, "「换」进既有选位置弹层");
});
