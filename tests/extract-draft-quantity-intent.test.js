"use strict";

/**
 * Q2 语音数量意图解析(extractDraft.quantityIntentParse,issue #102 /
 * Q0-CONTRACT §7.8):零写提议层——模型只提议 {intent,item_query,delta|value,
 * unit,source_quote},服务端硬门(数字锚定/移动与找回句式/编造候选/歧义标注)
 * 降级绝不猜;目标 item_id 必须来自客户端传入的候选,由用户确认选择。
 * 覆盖反例矩阵 §12-E1-E8/E11/E12(解析侧)与 §7.8.2 冻结数字解析器锚定。
 * 红绿纪律:本文件在未实现 quantityIntentParse 的代码上必须失败,实现后全绿。
 */

const test = require("node:test");
const assert = require("node:assert");

const { quantityIntentParse } = require("../cloudfunctions/extractDraft/lib/handler");

function cand(over) {
  return Object.assign(
    {
      item_id: "it-1",
      name: "棉柔巾",
      location_text: "卫生间镜柜",
      quantity: 5,
      unit: "包",
      version: 3,
    },
    over || {},
  );
}

function model(o) {
  return Promise.resolve(JSON.stringify(o));
}

function depsWith(output, logs) {
  return {
    callLLM() {
      return typeof output === "function" ? output() : model(output);
    },
    logger(e) {
      if (logs) logs.push(e);
    },
  };
}

/** 常规成功提议:add {intent,item_query,delta,unit,source_quote,candidate_index} */
const ADD_TWO = {
  intent: "add",
  item_query: "棉柔巾",
  delta: 2,
  unit: "包",
  source_quote: "加两包",
  candidate_index: 0,
};

// ---------- E1-E3:加/减/设为语义区分(锚定通过) ----------

test("E1 「卫生间棉柔巾加两包」→ add,delta=+2,unit=包,quote 锚定,单候选命中不强制点选", async () => {
  const res = await quantityIntentParse(
    { action: "quantityIntentParse", text: "卫生间棉柔巾加两包", candidates: [cand()] },
    depsWith(ADD_TWO),
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.intent, "add");
  assert.equal(res.delta, 2);
  assert.equal(res.unit, "包");
  assert.equal(res.source_quote, "加两包");
  assert.equal(res.needs_pick, false);
  assert.equal(res.match && res.match.candidate_index, 0);
  assert.equal(res.match && res.match.matched_word, "棉柔巾");
  assert.equal(res.ambiguity, undefined);
});

test("E2 「用掉三包棉柔巾」→ subtract,delta=-3(模型报正数也归一为负)", async () => {
  const neg = await quantityIntentParse(
    { action: "quantityIntentParse", text: "用掉三包棉柔巾", candidates: [cand()] },
    depsWith({ intent: "subtract", item_query: "棉柔巾", delta: -3, unit: "包", source_quote: "三包", candidate_index: 0 }),
  );
  assert.equal(neg.ok, true);
  assert.equal(neg.intent, "subtract");
  assert.equal(neg.delta, -3);
  assert.equal(neg.unit, "包");

  const pos = await quantityIntentParse(
    { action: "quantityIntentParse", text: "用掉三包棉柔巾", candidates: [cand()] },
    depsWith({ intent: "subtract", item_query: "棉柔巾", delta: 3, unit: "包", source_quote: "三包", candidate_index: 0 }),
  );
  assert.equal(pos.ok, true);
  assert.equal(pos.intent, "subtract");
  assert.equal(pos.delta, -3, "subtract 的 delta 符号由 intent 决定,不信模型手滑");
});

test("E3 「卫生间棉柔巾现在有四包」→ set,value=4(中文数字锚定)", async () => {
  const res = await quantityIntentParse(
    { action: "quantityIntentParse", text: "卫生间棉柔巾现在有四包", candidates: [cand()] },
    depsWith({ intent: "set", item_query: "棉柔巾", value: 4, unit: "包", source_quote: "四包", candidate_index: 0 }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.intent, "set");
  assert.equal(res.value, 4);
  assert.equal(res.delta, undefined);
  assert.equal(res.unit, "包");
});

// ---------- E4-E6:歧义/移动/找回(绝不静默执行) ----------

test("E4 「棉柔巾还有四包」→ unknown + ambiguity=maybe_total,绝不按 set/add 执行", async () => {
  const res = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾还有四包", candidates: [cand()] },
    depsWith({ intent: "set", item_query: "棉柔巾", value: 4, unit: "包", source_quote: "四包", candidate_index: 0 }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.intent, "unknown");
  assert.equal(res.ambiguity, "maybe_total");
  assert.equal(res.value, undefined, "unknown 不携带值,绝不给执行层留抓手");
  assert.equal(res.delta, undefined);
  assert.equal(res.unit, undefined);
  assert.equal(res.needs_pick, false, "maybe_total 不置 needs_pick(用户换说法重解析)");
});

test("E4b 模型自报 unknown+maybe_total 原样透传", async () => {
  const res = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾大概还有四包", candidates: [cand()] },
    depsWith({ intent: "unknown", item_query: "棉柔巾", ambiguity: "maybe_total" }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.intent, "unknown");
  assert.equal(res.ambiguity, "maybe_total");
});

test("E5 「把两包棉柔巾拿到卧室」→ other(移动句式,模型报 add 也被硬门压下),不携带数量", async () => {
  const res = await quantityIntentParse(
    { action: "quantityIntentParse", text: "把两包棉柔巾拿到卧室", candidates: [cand()] },
    depsWith(Object.assign({}, ADD_TWO, { source_quote: "两包", delta: 2 })),
  );
  assert.equal(res.ok, true);
  assert.equal(res.intent, "other");
  assert.equal(res.delta, undefined, "移动句绝不折算成 subtract/add");
  assert.equal(res.unit, undefined);
  assert.equal(res.needs_pick, false);
});

test("E6 「找一下棉柔巾」→ other(找回查询),绝不触碰数量", async () => {
  const res = await quantityIntentParse(
    { action: "quantityIntentParse", text: "找一下棉柔巾", candidates: [cand()] },
    depsWith({ intent: "set", item_query: "棉柔巾", value: 4, unit: "包", source_quote: "四包" }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.intent, "other");
  assert.equal(res.value, undefined);
});

// ---------- E7/E8/E11/E12:目标选择与编造 ----------

test("E7 候选同名多位置命中 → needs_pick=true,match 缺席(目标必须用户点选)", async () => {
  const res = await quantityIntentParse(
    {
      action: "quantityIntentParse",
      text: "卫生间棉柔巾加两包",
      candidates: [cand({ item_id: "it-a", location_text: "卫生间镜柜" }), cand({ item_id: "it-b", location_text: "卧室柜子" })],
    },
    depsWith(Object.assign({}, ADD_TWO, { candidate_index: 0 })),
  );
  assert.equal(res.ok, true);
  assert.equal(res.intent, "add", "提议完整,但目标必须点选");
  assert.equal(res.delta, 2);
  assert.equal(res.needs_pick, true);
  assert.equal(res.match, undefined);
});

test("E8 模型编造 candidates 外下标 → 丢弃 match、needs_pick=true", async () => {
  const res = await quantityIntentParse(
    { action: "quantityIntentParse", text: "卫生间棉柔巾加两包", candidates: [cand()] },
    depsWith(Object.assign({}, ADD_TWO, { candidate_index: 5 })),
  );
  assert.equal(res.ok, true);
  assert.equal(res.intent, "add");
  assert.equal(res.needs_pick, true);
  assert.equal(res.match, undefined);
});

test("E8b 模型指向名称对不上的候选(在界内)→ 同样丢弃 match、needs_pick=true", async () => {
  const res = await quantityIntentParse(
    {
      action: "quantityIntentParse",
      text: "卫生间棉柔巾加两包",
      candidates: [cand(), cand({ item_id: "it-2", name: "抽纸", location_text: "客厅" })],
    },
    depsWith(Object.assign({}, ADD_TWO, { candidate_index: 1 })),
  );
  assert.equal(res.ok, true);
  assert.equal(res.needs_pick, true);
  assert.equal(res.match, undefined);
});

test("E11 无位置词 + 候选池两件同名不同位置 → needs_pick:true + ambiguity:location_unclear", async () => {
  const res = await quantityIntentParse(
    {
      action: "quantityIntentParse",
      text: "棉柔巾加两包",
      candidates: [cand({ item_id: "it-a", location_text: "客厅电视柜" }), cand({ item_id: "it-b", location_text: "卧室柜子" })],
    },
    depsWith(Object.assign({}, ADD_TWO, { source_quote: "加两包" })),
  );
  assert.equal(res.ok, true);
  assert.equal(res.intent, "add");
  assert.equal(res.needs_pick, true);
  assert.equal(res.ambiguity, "location_unclear");
});

test("E12 同名两件不同单位(包/盒)→ needs_pick:true + ambiguity:unit_unclear", async () => {
  const res = await quantityIntentParse(
    {
      action: "quantityIntentParse",
      text: "棉柔巾加两包",
      candidates: [cand({ item_id: "it-a", unit: "包" }), cand({ item_id: "it-b", location_text: "卧室柜子", unit: "盒", quantity: 2 })],
    },
    depsWith(Object.assign({}, ADD_TWO)),
  );
  assert.equal(res.ok, true);
  assert.equal(res.needs_pick, true);
  assert.equal(res.ambiguity, "unit_unclear");
});

test("候选池为空(未命中)→ needs_pick:true,无 ambiguity,提议完整", async () => {
  const res = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [] },
    depsWith(Object.assign({}, ADD_TWO)),
  );
  assert.equal(res.ok, true);
  assert.equal(res.intent, "add");
  assert.equal(res.needs_pick, true);
  assert.equal(res.ambiguity, undefined);
  assert.equal(res.match, undefined);
});

// ---------- 数字锚定硬门(§7.8 硬门 1;L1 解析侧防线) ----------

test("锚定失败:quote 解不出闭集数量(「一箱」折报 24)→ unknown,绝不采信推算", async () => {
  const res = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾加一箱", candidates: [cand()] },
    depsWith({ intent: "add", item_query: "棉柔巾", delta: 24, unit: "包", source_quote: "一箱", candidate_index: 0 }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.intent, "unknown");
  assert.equal(res.delta, undefined);
});

test("锚定失败:quote 非原话逐字子串 / 数量不一致 / 小数 / 闭集外单位 → unknown", async () => {
  const notSub = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [cand()] },
    depsWith({ intent: "add", item_query: "棉柔巾", delta: 2, unit: "包", source_quote: "两盒" }),
  );
  assert.equal(notSub.intent, "unknown");

  const mismatch = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [cand()] },
    depsWith({ intent: "add", item_query: "棉柔巾", delta: 5, unit: "包", source_quote: "两包" }),
  );
  assert.equal(mismatch.intent, "unknown");

  const decimal = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾加1.5包", candidates: [cand()] },
    depsWith({ intent: "add", item_query: "棉柔巾", delta: 1.5, unit: "包", source_quote: "1.5包" }),
  );
  assert.equal(decimal.intent, "unknown");

  const outside = await quantityIntentParse(
    { action: "quantityIntentParse", text: "喷雾加500ml", candidates: [cand()] },
    depsWith({ intent: "add", item_query: "喷雾", delta: 500, unit: "ml", source_quote: "500ml" }),
  );
  assert.equal(outside.intent, "unknown");
});

test("锚定失败:quote 单位与模型报单位不一致(quote 两包报盒)→ unknown", async () => {
  const res = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [cand()] },
    depsWith({ intent: "add", item_query: "棉柔巾", delta: 2, unit: "盒", source_quote: "两包" }),
  );
  assert.equal(res.intent, "unknown");
});

test("set 0 不可由语音锚定(「零包」解析不出 ≥1 数量)→ unknown(归零走详情页显式操作)", async () => {
  const res = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾现在是零包", candidates: [cand()] },
    depsWith({ intent: "set", item_query: "棉柔巾", value: 0, unit: "包", source_quote: "零包" }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.intent, "unknown");
  assert.equal(res.value, undefined);
});

test("intent 闭集外('increase')/缺 delta/缺 unit → 一律 unknown", async () => {
  const badIntent = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [cand()] },
    depsWith({ intent: "increase", item_query: "棉柔巾", delta: 2, unit: "包", source_quote: "加两包" }),
  );
  assert.equal(badIntent.intent, "unknown");

  const noDelta = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [cand()] },
    depsWith({ intent: "add", item_query: "棉柔巾", unit: "包", source_quote: "加两包" }),
  );
  assert.equal(noDelta.intent, "unknown");

  const noUnit = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [cand()] },
    depsWith({ intent: "add", item_query: "棉柔巾", delta: 2, source_quote: "加两包" }),
  );
  assert.equal(noUnit.intent, "unknown");
});

// ---------- 输入校验(INVALID_INPUT,引擎未参与) ----------

test("INVALID_INPUT:text 空/超 200 码点、candidates 缺席/13 项/形状错", async () => {
  let calls = 0;
  const deps = {
    callLLM() {
      calls += 1;
      return model({ intent: "other" });
    },
    logger() {},
  };
  const bad = [
    { action: "quantityIntentParse", text: "", candidates: [] },
    { action: "quantityIntentParse", text: "   ", candidates: [] },
    { action: "quantityIntentParse", text: "长".repeat(201), candidates: [] },
    { action: "quantityIntentParse", candidates: [] },
    { action: "quantityIntentParse", text: "棉柔巾加两包" },
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: new Array(13).fill(cand()) },
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [{ name: "棉柔巾", location_text: "卫生间", version: 1 }] },
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [{ item_id: "it", name: "", location_text: "卫生间", version: 1 }] },
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [{ item_id: "it", name: "棉柔巾", location_text: "卫生间" }] },
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [{ item_id: "it", name: "棉柔巾", location_text: "卫生间", version: "3" }] },
  ];
  for (const ev of bad) {
    const res = await quantityIntentParse(ev, deps);
    assert.equal(res.ok, false, JSON.stringify(ev));
    assert.equal(res.error, "INVALID_INPUT");
  }
  assert.equal(calls, 0, "参数校验失败不得触碰引擎");
});

// ---------- 引擎链与日志纪律 ----------

test("引擎链:坏 JSON 重试一次,仍失败 → AI_UNAVAILABLE;重试后成功 → ok", async () => {
  let calls = 0;
  const fail = {
    callLLM() {
      calls += 1;
      return Promise.resolve(calls === 1 ? "not-json" : JSON.stringify({ intent: "other" }));
    },
    logger() {},
  };
  const recovered = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [] },
    fail,
  );
  assert.equal(recovered.ok, true);
  assert.equal(calls, 2);

  let calls2 = 0;
  const alwaysBad = {
    callLLM() {
      calls2 += 1;
      return Promise.resolve("not-json");
    },
    logger() {},
  };
  const dead = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [] },
    alwaysBad,
  );
  assert.equal(dead.ok, false);
  assert.equal(dead.error, "AI_UNAVAILABLE");
  assert.equal(calls2, 2);
});

test("本地引擎主路:callLocalLLM 成功 → engine='local';失败降级 deepseek", async () => {
  const localOk = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [cand()] },
    {
      callLLM() {
        return model(ADD_TWO);
      },
      callLocalLLM() {
        return model(ADD_TWO);
      },
      logger() {},
    },
  );
  assert.equal(localOk.ok, true);
  assert.equal(localOk.engine, "local");

  const fallback = await quantityIntentParse(
    { action: "quantityIntentParse", text: "棉柔巾加两包", candidates: [cand()] },
    {
      callLLM() {
        return model(ADD_TWO);
      },
      callLocalLLM() {
        return Promise.reject(new Error("local down"));
      },
      logger() {},
    },
  );
  assert.equal(fallback.ok, true);
  assert.equal(fallback.engine, "deepseek");
});

test("日志纪律:只记 action/textLength/candidateCount/elapsedMs/engine/intent/error,绝不落原文与解析结果", async () => {
  const logs = [];
  await quantityIntentParse(
    { action: "quantityIntentParse", text: "卫生间棉柔巾加两包", candidates: [cand()] },
    depsWith(ADD_TWO, logs),
  );
  assert.equal(logs.length, 1);
  const entry = logs[0];
  assert.equal(entry.action, "quantityIntentParse");
  assert.equal(entry.textLength, 9);
  assert.equal(entry.candidateCount, 1);
  assert.equal(entry.engine, "deepseek");
  assert.equal(entry.intent, "add");
  const keys = Object.keys(entry).sort();
  for (const k of keys) {
    assert.equal(
      ["action", "textLength", "candidateCount", "elapsedMs", "engine", "intent", "error"].indexOf(k) !== -1,
      true,
      "日志字段必须在白名单内:" + k,
    );
  }
});
