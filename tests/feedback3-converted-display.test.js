"use strict";

/**
 * #36 真机反馈三件 A 客户端侧:相对时间换算候选(remind_converted)的透传与展示。
 * - CVT-API:callExtractDraft 草稿映射透传 remind_vague_quote / remind_converted
 *   ——顺带锁死 Fix 4 遗留断链(旧映射漏传 vague,灰行/详情留痕整链失效,
 *   本 PR 一并修复:本测试在旧产物上必红);
 * - CVT-FN:rowReminderInput 换算标记随 quote 同条件携带(存入 reminder 文档);
 * - CVT-PAGE:确认页行状态携带 remindConverted、用户改日期即置 false;
 *   详情页 applyReminderRow 把换算源原话投到保质期行 convertedNote;
 * - CVT-WXML:C1 换算标注 / C2 换算标注 / D1 保质期行标注的渲染接线。
 * 被测对象为 build:mp 产物与 wxml 源(pretest 已先行编译)。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, "miniprogram", rel), "utf8");
}

/* ---------------- CVT-API:草稿映射透传 vague / converted ---------------- */

var api = require("../miniprogram/utils/api.js");

test("CVT-API-1:v2 草稿映射透传 remind_vague_quote(修 Fix 4 断链)与 remind_converted", async function () {
  var prevWx = globalThis.wx;
  var convertedDraft = {
    name: "净水器备用滤芯",
    location_text: "厨房水槽下面的柜子",
    certain: true,
    qualifiers: [],
    source_quote: "净水器的备用滤芯放在厨房水槽下面的柜子里",
    anchor_shared: false,
    remind_at: "2027-04-15",
    remind_kind: "下次维护",
    remind_quote: "半年后",
    remind_vague_quote: null,
    remind_converted: true,
    mount_path: null,
  };
  var vagueDraft = {
    name: "净水器滤芯",
    location_text: "厨房抽屉",
    certain: true,
    qualifiers: [],
    source_quote: "净水器滤芯在厨房抽屉",
    anchor_shared: false,
    remind_at: null,
    remind_kind: null,
    remind_quote: null,
    remind_vague_quote: "下个月",
    remind_converted: false,
    mount_path: null,
  };
  globalThis.wx = {
    cloud: {
      callFunction: function (o) {
        Promise.resolve().then(function () {
          o.success({
            result: {
              ok: true,
              drafts: [convertedDraft, vagueDraft],
              original_text: "原话整句",
              truncated: false,
            },
          });
        });
      },
    },
  };
  try {
    var res = await api.callExtractDraft("原话整句", { protocol: 2 });
    assert.equal(res.ok, true);
    // 换算件:vague 置空、converted 透传为 true、三项齐全
    assert.equal(res.drafts[0].remind_at, "2027-04-15");
    assert.equal(res.drafts[0].remind_vague_quote, null, "已换算件 vague 为 null");
    assert.equal(res.drafts[0].remind_converted, true, "换算标记透传(曾因映射漏传整链失效)");
    // 未换算件:vague 透传(灰行数据来源)、converted 严格 false
    assert.equal(res.drafts[1].remind_vague_quote, "下个月", "vague 原文子串透传(Fix 4 断链修复)");
    assert.equal(res.drafts[1].remind_converted, false, "非 true 一律 false,绝不误标");
  } finally {
    if (prevWx === undefined) {
      delete globalThis.wx;
    } else {
      globalThis.wx = prevWx;
    }
  }
});

/* ---------------- CVT-FN:rowReminderInput 换算标记随 quote 同条件携带 ---------------- */

var batchSave = require("../miniprogram/utils/batch-save.js");

test("CVT-FN-1:rowReminderInput——换算候选(日期未被改)才携带 remind_converted:true", function () {
  var base = {
    remindAt: "2027-04-15",
    remindKind: "下次维护",
    remindOrigin: "2027-04-15",
    remindQuote: "半年后",
    remindConverted: true,
  };
  var carried = batchSave.rowReminderInput(base);
  assert.equal(carried.due_date, "2027-04-15");
  assert.equal(carried.quote, "半年后", "quote 同条件携带(既有行为)");
  assert.equal(carried.remind_converted, true, "换算候选随行提交,存入 reminder 文档");

  // 用户改过日期:quote 不带(既有),converted 也不带(候选已被用户选择替代)
  var changed = batchSave.rowReminderInput(Object.assign({}, base, { remindAt: "2026-12-01" }));
  assert.equal(changed.quote, undefined);
  assert.equal(changed.remind_converted, undefined, "改过日期不带换算标记");

  // 非换算候选(原话绝对日期):quote 带但 converted 不带
  var plain = batchSave.rowReminderInput(Object.assign({}, base, { remindConverted: false, remindQuote: "11月20号" }));
  assert.equal(plain.quote, "11月20号");
  assert.equal(plain.remind_converted, undefined, "常规提醒不带换算标记");
});

/* ---------------- CVT-PAGE:确认页行状态 + 详情页保质期行投影 ---------------- */

var ds = require("../miniprogram/utils/draft-session.js");
var householdScope = require("../miniprogram/utils/household-scope.js");
var cache = require("../miniprogram/utils/locations-cache.js");

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
    },
  };
  Object.keys(config).forEach(function (k) {
    if (k !== "data") {
      page[k] = config[k];
    }
  });
  return page;
}

globalThis.wx = {
  showToast: function () {},
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
};

var confirmConfig = null;
var itemConfig = null;
(function loadPages() {
  globalThis.getCurrentPages = function () {
    return [];
  };
  globalThis.Page = function (options) {
    confirmConfig = options;
  };
  require(path.join(ROOT, "miniprogram", "pages", "confirm", "confirm.js"));
  globalThis.Page = function (config) {
    itemConfig = config;
  };
  require(path.join(ROOT, "miniprogram", "pages", "item", "item.js"));
})();

function resetEnv() {
  ds.__resetDraftSessionForTest();
  ds.__setDraftSessionStorageForTest(makeFakeStorage());
  householdScope.__resetHouseholdScopeForTest();
  cache.__resetLocationsCacheForTest();
}

test("CVT-PAGE-CONF-1:换算候选行进确认页——行携带 remindConverted/quote;用户改日期即置 false 并回写会话", async function () {
  resetEnv();
  var page = makePageFrom(confirmConfig);
  var sid = ds.createDraftSession(
    "净水器的备用滤芯放在厨房水槽下面的柜子里,半年后提醒我换。",
    [
      {
        name: "净水器备用滤芯",
        location_text: "厨房水槽下面的柜子",
        certain: true,
        qualifiers: [],
        source_quote: "净水器的备用滤芯放在厨房水槽下面的柜子里",
        anchor_shared: false,
        remind_at: "2027-04-15",
        remind_kind: "下次维护",
        remind_quote: "半年后",
        remind_vague_quote: null,
        remind_converted: true,
        mount_path: null,
      },
    ],
    false,
  );
  confirmConfig.onLoad.call(page, { sid: sid });
  var row = page.data.rows[0];
  assert.equal(row.remindAt, "2027-04-15", "行内日期=换算候选");
  assert.equal(row.remindOrigin, "2027-04-15");
  assert.equal(row.remindQuote, "半年后", "换算源文案在行上(标注取该值)");
  assert.equal(row.remindConverted, true, "行携带换算标记");
  assert.equal(row.remindVagueQuote, "", "已换算:无灰行数据");

  // 用户改日期:候选被替代,标记置 false(标注收起、随行不再提交 converted)
  await Promise.resolve(confirmConfig.onRemindDateChange.call(page, { detail: { value: "2026-12-01" } }));
  assert.equal(page.data.rows[0].remindConverted, false, "改日期即置 false");
  assert.equal(page.data.rows[0].remindAt, "2026-12-01");
  // 回写会话:进程回收后恢复不得回生换算标记
  var persisted = ds.getDraftSession(sid);
  assert.equal(persisted.rows[0].remindAt, "2026-12-01");
  assert.equal(persisted.rows[0].remindConverted, false, "标记随行回写(恢复不回生)");
});

test("CVT-PAGE-CONF-2:闭集外 vague 行照旧(灰行数据、无换算标记)", function () {
  resetEnv();
  var page = makePageFrom(confirmConfig);
  var sid = ds.createDraftSession(
    "下个月要换净水器滤芯,滤芯在厨房抽屉里。",
    [
      {
        name: "净水器滤芯",
        location_text: "厨房抽屉",
        certain: true,
        qualifiers: [],
        source_quote: "净水器滤芯在厨房抽屉",
        anchor_shared: false,
        remind_at: null,
        remind_kind: null,
        remind_quote: null,
        remind_vague_quote: "下个月",
        remind_converted: false,
        mount_path: null,
      },
    ],
    false,
  );
  confirmConfig.onLoad.call(page, { sid: sid });
  var row = page.data.rows[0];
  assert.equal(row.remindAt, "", "未换算:行内无日期(现状)");
  assert.equal(row.remindVagueQuote, "下个月", "灰行数据如实保留(现状)");
  assert.equal(row.remindConverted, false);
});

test("CVT-PAGE-ITEM-1:applyReminderRow 把换算源原话投到保质期行 convertedNote;常规行不投", function () {
  resetEnv();
  var page = makePageFrom(itemConfig);
  itemConfig.applyReminderRow.call(page, {
    item_id: "it-x",
    name: "净水器备用滤芯",
    location_text: "厨房水槽下面的柜子",
    due_date: "2027-04-15",
    kind: "下次维护",
    generation: 3,
    remind_converted: true,
    remind_quote: "半年后",
  });
  assert.equal(page.data.expire.dueDate, "2027-04-15");
  assert.equal(page.data.expire.convertedNote, "半年后", "换算源原话投到保质期行");

  itemConfig.applyReminderRow.call(page, {
    item_id: "it-x",
    name: "感冒药",
    location_text: "药箱第一格",
    due_date: "2026-11-20",
    kind: "有效期",
    generation: 4,
  });
  assert.equal(page.data.expire.convertedNote, "", "常规行(原话绝对日期)不投换算标注");
});

/* ---------------- CVT-WXML:渲染接线(C1 / C2 / D1) ---------------- */

test("CVT-WXML-1:C1 换算标注(日期旁 sum-meta 灰小字)+ C2 行内标注 + D1 保质期行标注", function () {
  var confirmWxml = read("pages/confirm/confirm.wxml");
  // C1:单件提醒行下,日期仍是提取值且行带 converted 时显示「(按『…』换算,可改可清)」
  assert.ok(
    confirmWxml.indexOf("rows[0].remindAt === rows[0].remindOrigin") !== -1,
    "C1 标注只在日期仍是换算候选时显示(用户改过即收起)",
  );
  assert.ok(confirmWxml.indexOf("由「{{ rows[0].remindQuote }}」换算") !== -1, "C1 换算源文案取行内 remindQuote");
  assert.ok(/sum-meta[^"]*converted-note/.test(confirmWxml), "C1 复用 sum-meta 灰小字样式");
  // C2:多件行内标注
  assert.ok(confirmWxml.indexOf("按『{{ item.remindQuote }}』换算") !== -1, "C2 换算源文案取行内 remindQuote");
  assert.ok(/row-meta[^"]*converted-note/.test(confirmWxml), "C2 行内灰小字标注");
  // D1:详情页保质期行标注
  var itemWxml = read("pages/item/item.wxml");
  assert.ok(itemWxml.indexOf("按『{{ expire.convertedNote }}』换算") !== -1, "D1 保质期行换算标注");
  assert.ok(/expire-sub[^"]*converted-note/.test(itemWxml), "D1 复用 expire-sub 小字样式");
  // R1 列表行不需要换算标注(现状保持)
  var r1 = read("pages/reminders/reminders.wxml");
  assert.equal(r1.indexOf("换算"), -1, "R1 列表行不渲染换算标注");
});
