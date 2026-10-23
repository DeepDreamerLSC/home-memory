"use strict";

/**
 * Q1 语音新建数量预填(extractDraft v2 数量三项,issue #102 / Q0-CONTRACT §4.6):
 * 每件 draft 增 quantity/unit/quantity_quote 三项同现同缺;服务端硬门 =
 * 冻结数字解析器(lib/quantity.js)从 quantity_quote 解析出的「数字+单位」
 * 必须与模型报的 quantity/unit 完全一致,且 quote 是原话逐字子串;锚定失败
 * 三项整体置 null(物品照常提取,绝不废件)。「买了」不产生 add 语义(客户端
 * 仅预填);v1 响应零变化。
 * 红绿纪律:本文件在未实现数量的代码上必须失败,实现后全绿。
 */

const test = require("node:test");
const assert = require("node:assert");

const { handler } = require("../cloudfunctions/extractDraft/lib/handler");
const { validateDrafts } = require("../cloudfunctions/extractDraft/lib/validate");
const quantity = require("../cloudfunctions/extractDraft/lib/quantity");

function rawItems(items) {
  return JSON.stringify({ items, has_more: false });
}

function baseItem(over) {
  return Object.assign(
    {
      name: "棉柔巾",
      location_text: "卫生间",
      certain: true,
      qualifiers: [],
      source_quote: "买了三包棉柔巾放卫生间",
    },
    over || {}
  );
}

// ---------- 冻结数字解析器(§7.8.2) ----------

test("parseQuantityQuote:阿拉伯数字 + UNIT_SET 单位", () => {
  assert.deepEqual(quantity.parseQuantityQuote("3包"), { number: 3, unit: "包" });
  assert.deepEqual(quantity.parseQuantityQuote("12瓶"), { number: 12, unit: "瓶" });
  assert.deepEqual(quantity.parseQuantityQuote("买了2盒"), { number: 2, unit: "盒" });
});

test("parseQuantityQuote:中文数字(一..十/两/组合十五二十三一百两千)", () => {
  assert.deepEqual(quantity.parseQuantityQuote("一包"), { number: 1, unit: "包" });
  assert.deepEqual(quantity.parseQuantityQuote("两包"), { number: 2, unit: "包" });
  assert.deepEqual(quantity.parseQuantityQuote("三包"), { number: 3, unit: "包" });
  assert.deepEqual(quantity.parseQuantityQuote("十包"), { number: 10, unit: "包" });
  assert.deepEqual(quantity.parseQuantityQuote("十五包"), { number: 15, unit: "包" });
  assert.deepEqual(quantity.parseQuantityQuote("二十三包"), { number: 23, unit: "包" });
  assert.deepEqual(quantity.parseQuantityQuote("一百包"), { number: 100, unit: "包" });
  assert.deepEqual(quantity.parseQuantityQuote("两千包"), { number: 2000, unit: "包" });
});

test("parseQuantityQuote:闭集外单位/小数/模糊/超上限 → null", () => {
  assert.equal(quantity.parseQuantityQuote("一箱"), null, "箱不在闭集");
  assert.equal(quantity.parseQuantityQuote("1.5升"), null, "小数不解析");
  assert.equal(quantity.parseQuantityQuote("几包"), null, "模糊量词不解析");
  assert.equal(quantity.parseQuantityQuote("半打"), null);
  assert.equal(quantity.parseQuantityQuote("一些"), null);
  assert.equal(quantity.parseQuantityQuote("一万包"), null, "超 9999 上限");
  assert.equal(quantity.parseQuantityQuote("500ml"), null, "ml 不在闭集");
});

// ---------- validateDrafts 数量三项 ----------

test("v2 数量三项:quote 锚定成功 → drafts 携带 quantity/unit/quantity_quote", () => {
  const result = validateDrafts(
    rawItems([baseItem({ quantity: 3, unit: "包", quantity_quote: "三包" })]),
    "买了三包棉柔巾放卫生间",
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts.length, 1);
  const d = result.drafts[0];
  assert.equal(d.quantity, 3);
  assert.equal(d.unit, "包");
  assert.equal(d.quantity_quote, "三包");
});

test("v2 数量三项:quote 非原话逐字子串 → 三项全 null(物品照常提取)", () => {
  const result = validateDrafts(
    rawItems([baseItem({ quantity: 3, unit: "包", quantity_quote: "三个" })]),
    "买了三包棉柔巾放卫生间",
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts[0].quantity, null);
  assert.equal(result.drafts[0].unit, null);
  assert.equal(result.drafts[0].quantity_quote, null);
});

test("v2 数量三项:模型推算(『一箱』折报 24)→ 锚定失败三项全 null,绝不采信", () => {
  const result = validateDrafts(
    rawItems([
      {
        name: "纸巾",
        location_text: "客厅",
        certain: true,
        qualifiers: [],
        source_quote: "买了一箱纸巾放客厅",
        quantity: 24,
        unit: "包",
        quantity_quote: "一箱",
      },
    ]),
    "买了一箱纸巾放客厅",
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts[0].quantity, null, "模型按箱装数推算的 24 绝不落草稿");
  assert.equal(result.drafts[0].unit, null);
});

test("v2 数量三项:模型报数与 quote 解析不一致(quote 三包报 4)→ 三项全 null", () => {
  const result = validateDrafts(
    rawItems([baseItem({ quantity: 4, unit: "包", quantity_quote: "三包" })]),
    "买了三包棉柔巾放卫生间",
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts[0].quantity, null);
});

test("v2 数量三项:unit 与 quote 解析出的单位不一致 → 三项全 null", () => {
  const result = validateDrafts(
    rawItems([baseItem({ quantity: 3, unit: "盒", quantity_quote: "三包" })]),
    "买了三包棉柔巾放卫生间",
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts[0].quantity, null);
});

test("v2 数量三项:半态/类型非法/越界 → 三项全 null", () => {
  const half = validateDrafts(
    rawItems([baseItem({ quantity: 3 })]),
    "买了三包棉柔巾放卫生间",
  );
  assert.equal(half.drafts[0].quantity, null, "只携 quantity 半态 → 全 null");
  const strQty = validateDrafts(
    rawItems([baseItem({ quantity: "3", unit: "包", quantity_quote: "三包" })]),
    "买了三包棉柔巾放卫生间",
  );
  assert.equal(strQty.drafts[0].quantity, null, "字符串数量 → 全 null");
  const overMax = validateDrafts(
    rawItems([baseItem({ quantity: 10000, unit: "包", quantity_quote: "一万包" })]),
    "买了一万包棉柔巾放卫生间",
  );
  assert.equal(overMax.drafts[0].quantity, null, "越界 → 全 null");
  const zero = validateDrafts(
    rawItems([baseItem({ quantity: 0, unit: "包", quantity_quote: "零包" })]),
    "买了零包棉柔巾放卫生间",
  );
  assert.equal(zero.drafts[0].quantity, null, "新建恒 ≥1,0 → 全 null");
});

test("v2 数量三项:未说数量(三项缺席)→ draft 携带三项 null;闭集外单位('一打')→ null", () => {
  const none = validateDrafts(
    rawItems([baseItem()]),
    "买了三包棉柔巾放卫生间",
  );
  assert.equal(none.drafts[0].quantity, null);
  assert.equal(none.drafts[0].unit, null);
  assert.equal(none.drafts[0].quantity_quote, null);

  const outside = validateDrafts(
    rawItems([
      {
        name: "鸡蛋",
        location_text: "厨房",
        certain: true,
        qualifiers: [],
        source_quote: "买了一打鸡蛋放厨房",
        quantity: 12,
        unit: "个",
        quantity_quote: "一打",
      },
    ]),
    "买了一打鸡蛋放厨房",
  );
  assert.equal(outside.drafts[0].quantity, null, "「一打」解析不出闭集数量 → 全 null(确认页预填 1/件 + 待核对)");
});

test("v2 数量三项:多件各自独立锚定(数量不串行)", () => {
  const result = validateDrafts(
    rawItems([
      {
        name: "棉柔巾",
        location_text: "卫生间",
        certain: true,
        qualifiers: [],
        source_quote: "三包棉柔巾放卫生间",
        quantity: 3,
        unit: "包",
        quantity_quote: "三包",
      },
      {
        name: "抽纸",
        location_text: "客厅",
        certain: true,
        qualifiers: [],
        source_quote: "两盒抽纸放客厅",
        quantity: 2,
        unit: "盒",
        quantity_quote: "两盒",
      },
    ]),
    "三包棉柔巾放卫生间,两盒抽纸放客厅",
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts[0].quantity, 3);
  assert.equal(result.drafts[0].unit, "包");
  assert.equal(result.drafts[1].quantity, 2);
  assert.equal(result.drafts[1].unit, "盒");
});

// ---------- handler 路由(v1 零变化 / v2 携带) ----------

test("handler v2 路由:成功 drafts 携带数量三项;prompt 含数量提取指令", async () => {
  const original = "买了3包棉柔巾放卫生间";
  let seenPrompt = "";
  const result = await handler({ text: original, protocol: 2 }, {
    logger() {},
    callLLM(prompt) {
      seenPrompt = prompt;
      return Promise.resolve(
        rawItems([
          {
            name: "棉柔巾",
            location_text: "卫生间",
            certain: true,
            qualifiers: [],
            source_quote: original,
            quantity: 3,
            unit: "包",
            quantity_quote: "3包",
          },
        ]),
      );
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].quantity, 3);
  assert.equal(result.drafts[0].unit, "包");
  assert.equal(result.drafts[0].quantity_quote, "3包");
  assert.ok(seenPrompt.indexOf("quantity") !== -1, "v2 prompt 必须教模型输出数量三项");
});

test("handler v1 路由:不带 protocol 的响应零变化(无数量键)", async () => {
  const result = await handler({ text: "剪刀放书房" }, {
    logger() {},
    callLLM() {
      return Promise.resolve(
        JSON.stringify({ name: "剪刀", location_text: "书房", certain: true, qualifiers: [] }),
      );
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.draft.quantity, undefined, "v1 draft 绝不出现数量键");
  assert.equal(result.draft.unit, undefined);
});
