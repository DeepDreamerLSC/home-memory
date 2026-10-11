"use strict";

/*
 * extractDraft 离线测试(node:test + node:assert,零外部依赖)。
 * 只 require cloudfunctions/extractDraft 下的 lib,绝不 require wx-server-sdk。
 * 覆盖:成功、不肯定给空位置、幻觉防护、拆分、空名、坏 JSON 重试、callLLM 抛错、
 * text 超长/为空,以及逐条样例驱动 validateDraft 与 mock callLLM 驱动 handler。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { handler, buildPrompt } = require("../cloudfunctions/extractDraft/lib/handler");
const { validateDraft } = require("../cloudfunctions/extractDraft/lib/validate");

const SAMPLES_DIR = path.join(__dirname, "fixtures", "samples");
const samples = fs
  .readdirSync(SAMPLES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, f), "utf8")));

const codePointLength = (s) => Array.from(s.replace(/\s+/g, "")).length;

// ---------- 公共工具 ----------

function userTextFromPrompt(prompt) {
  const marker = "【用户输入】\n";
  const start = prompt.indexOf(marker);
  assert.notStrictEqual(start, -1, "prompt 应包含【用户输入】标记");
  let rest = prompt.slice(start + marker.length);
  const retryIdx = rest.indexOf("\n\n【上次输出】");
  if (retryIdx !== -1) rest = rest.slice(0, retryIdx);
  return rest;
}

// 按样例构造「模型原始输出文本」:draft 样例输出对应 JSON;
// needs_split 样例输出 needs_split true;error 样例输出空白名称。
function rawFromSample(sample) {
  const e = sample.expect;
  if (e.draft) {
    return JSON.stringify({
      name: e.draft.name,
      location_text: e.draft.location_text,
      certain: e.draft.certain,
      qualifiers: e.draft.qualifiers,
      needs_split: false,
    });
  }
  if (e.needs_split) {
    return JSON.stringify({
      name: "物品",
      location_text: "",
      certain: false,
      qualifiers: [],
      needs_split: true,
    });
  }
  return JSON.stringify({
    name: "   ",
    location_text: "",
    certain: false,
    qualifiers: [],
    needs_split: false,
  });
}

// 故意包上 markdown 围栏或废话,考验解析。
function wrapRaw(i, raw) {
  const mode = i % 3;
  if (mode === 1) return "```json\n" + raw + "\n```";
  if (mode === 2) return "好的,提取结果如下:\n" + raw + "\n如果还需要调整请告诉我。";
  return raw;
}

function mockFromSample(sample, opts) {
  opts = opts || {};
  const calls = [];
  return {
    calls,
    callLLM: async (prompt) => {
      calls.push(prompt);
      const text = userTextFromPrompt(prompt);
      assert.strictEqual(text, sample.text, "callLLM 应收到对应样例原文");
      let raw = rawFromSample(sample);
      if (
        opts.hallucinateLocation &&
        sample.expect.draft &&
        sample.expect.draft.certain === false
      ) {
        // 幻觉场景:模型 certain 为 false 却编了一个位置。
        raw = JSON.stringify({
          name: sample.expect.draft.name,
          location_text: "卧室抽屉",
          certain: false,
          qualifiers: [],
          needs_split: false,
        });
      }
      if (typeof opts.wrapMode === "number") raw = wrapRaw(opts.wrapMode, raw);
      return raw;
    },
  };
}

function seqMock(responses) {
  const calls = [];
  return {
    calls,
    callLLM: async (prompt) => {
      calls.push(prompt);
      const item = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (item instanceof Error) throw item;
      return item;
    },
  };
}

const noopLogger = () => {};

function assertExpect(sample, res) {
  const e = sample.expect;
  if (e.draft) {
    assert.strictEqual(res.ok, true, sample.id + " 应成功");
    assert.deepStrictEqual(res.draft, e.draft, sample.id + " draft 应与 expect 一致");
  } else if (e.needs_split) {
    assert.strictEqual(res.ok, true, sample.id + " 应成功");
    assert.strictEqual(res.needs_split, true, sample.id + " 应为 needs_split");
    assert.strictEqual(res.message, "一次只记一件物品,请分开说", sample.id);
  } else {
    assert.strictEqual(res.ok, false, sample.id + " 应失败");
    assert.strictEqual(res.error, e.error, sample.id + " 错误码应为 " + e.error);
  }
}

// ---------- 样例集本身 ----------

test("样例集:至少 15 条,覆盖契约七类情形,边界字数正确", () => {
  assert.ok(samples.length >= 15, "样例至少 15 条,实际 " + samples.length);
  const categories = new Set(samples.map((s) => s.category));
  for (const required of [
    "典型一句话",
    "带限定语",
    "多件需拆分",
    "口语化模糊位置",
    "无位置信息",
    "可容忍别字",
    "长度边界",
  ]) {
    assert.ok(categories.has(required), "缺少类别:" + required);
  }
  const s13 = samples.find((s) => s.id === "s13");
  const s14 = samples.find((s) => s.id === "s14");
  assert.strictEqual(codePointLength(s13.text), 500, "s13 应恰好 500 字");
  assert.strictEqual(codePointLength(s14.text), 1, "s14 应为 1 字");
});

test("样例逐条:validateDraft 对模型原始输出(裸 JSON / 围栏 / 废话包装)均符合 expect", () => {
  samples.forEach((sample) => {
    const raw = rawFromSample(sample);
    for (const variant of [raw, wrapRaw(1, raw), wrapRaw(2, raw)]) {
      const res = validateDraft(variant, sample.text);
      assertExpect(sample, res);
    }
  });
});

// ---------- handler:样例驱动 ----------

test("handler:成功提取(输出包装围栏/废话也能解析),draft 与 expect 一致", async () => {
  const draftSamples = samples.filter((s) => s.expect.draft);
  assert.ok(draftSamples.length >= 8);
  for (let i = 0; i < draftSamples.length; i++) {
    const sample = draftSamples[i];
    const mock = mockFromSample(sample, { wrapMode: i % 3 });
    const res = await handler(
      { text: sample.text },
      { callLLM: mock.callLLM, logger: noopLogger }
    );
    assertExpect(sample, res);
    assert.strictEqual(mock.calls.length, 1, sample.id + " 只应调用一次");
  }
});

test("handler:不肯定的样例,草稿位置必须为空且 certain 为 false", async () => {
  const uncertain = samples.filter((s) => s.expect.draft && s.expect.draft.certain === false);
  assert.ok(uncertain.length >= 4);
  for (const sample of uncertain) {
    const mock = mockFromSample(sample);
    const res = await handler(
      { text: sample.text },
      { callLLM: mock.callLLM, logger: noopLogger }
    );
    assert.strictEqual(res.ok, true, sample.id);
    assert.strictEqual(res.draft.location_text, "", sample.id);
    assert.strictEqual(res.draft.certain, false, sample.id);
  }
});

test("handler:幻觉防护——模型 certain 为 false 却给了位置,最终 draft 位置必须为空", async () => {
  const sample = samples.find((s) => s.expect.draft && s.expect.draft.certain === false);
  assert.ok(sample, "应存在不肯定样例");
  const mock = mockFromSample(sample, { hallucinateLocation: true });
  const res = await handler(
    { text: sample.text },
    { callLLM: mock.callLLM, logger: noopLogger }
  );
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.draft.location_text, "", "幻觉位置必须被清空");
  assert.strictEqual(res.draft.certain, false);
  assert.deepStrictEqual(res.draft, sample.expect.draft, "最终应与 expect 一致");

  // 直接对 validateDraft 断言同一规则。
  const raw = JSON.stringify({
    name: sample.expect.draft.name,
    location_text: "厨房第三个抽屉",
    certain: false,
    qualifiers: ["编的"],
    needs_split: false,
  });
  const res2 = validateDraft(raw, sample.text);
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(res2.draft.location_text, "");
  assert.strictEqual(res2.draft.certain, false);
});

test("handler:多件物品返回 needs_split 与固定提示语", async () => {
  const splitSamples = samples.filter((s) => s.expect.needs_split);
  assert.ok(splitSamples.length >= 2, "至少 2 条拆分样例");
  for (const sample of splitSamples) {
    const mock = mockFromSample(sample);
    const res = await handler(
      { text: sample.text },
      { callLLM: mock.callLLM, logger: noopLogger }
    );
    assert.strictEqual(res.ok, true, sample.id);
    assert.strictEqual(res.needs_split, true, sample.id);
    assert.strictEqual(res.message, "一次只记一件物品,请分开说", sample.id);
    assert.strictEqual(mock.calls.length, 1, sample.id);
  }
});

test("handler:空名称返回 AI_UNAVAILABLE(可手动回退)", async () => {
  const sample = samples.find((s) => s.expect.error === "AI_UNAVAILABLE");
  assert.ok(sample, "应存在空名称样例");
  const mock = mockFromSample(sample);
  const res = await handler(
    { text: sample.text },
    { callLLM: mock.callLLM, logger: noopLogger }
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "AI_UNAVAILABLE");
  assert.strictEqual(res.manual_fallback, true);
});

// ---------- handler:失败与重试 ----------

test("handler:坏 JSON 带错误重试一次,重试成功返回草稿", async () => {
  const sample = samples.find((s) => s.expect.draft && s.expect.draft.certain === true);
  const mock = seqMock(["哎呀,我不太明白你的意思呢~", rawFromSample(sample)]);
  const res = await handler(
    { text: sample.text },
    { callLLM: mock.callLLM, logger: noopLogger }
  );
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.draft, sample.expect.draft);
  assert.strictEqual(mock.calls.length, 2, "应恰好调用两次");
  assert.ok(mock.calls[1].includes("【上次输出】"), "重试 prompt 应回传上次输出");
  assert.ok(mock.calls[1].includes("【解析错误】"), "重试 prompt 应带解析错误");
  assert.ok(mock.calls[1].includes("哎呀"), "重试 prompt 应包含上次原始输出内容");
});

test("handler:坏 JSON 重试一次仍是坏 JSON,返回 AI_UNAVAILABLE", async () => {
  const sample = samples.find((s) => s.expect.draft);
  const mock = seqMock(["这不是 JSON", "还是不行 { 未闭合"]);
  const res = await handler(
    { text: sample.text },
    { callLLM: mock.callLLM, logger: noopLogger }
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "AI_UNAVAILABLE");
  assert.strictEqual(mock.calls.length, 2, "只重试一次,不再三连调");
});

test("handler:callLLM 抛错返回 AI_UNAVAILABLE 且 manual_fallback 为 true", async () => {
  const sample = samples.find((s) => s.expect.draft);
  const mock = seqMock([new Error("HTTP_503")]);
  const res = await handler(
    { text: sample.text },
    { callLLM: mock.callLLM, logger: noopLogger }
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "AI_UNAVAILABLE");
  assert.strictEqual(res.manual_fallback, true);
  assert.strictEqual(mock.calls.length, 1);
});

test("handler:重试阶段 callLLM 抛错同样返回 AI_UNAVAILABLE", async () => {
  const sample = samples.find((s) => s.expect.draft);
  const mock = seqMock(["bad json", new Error("TIMEOUT")]);
  const res = await handler(
    { text: sample.text },
    { callLLM: mock.callLLM, logger: noopLogger }
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "AI_UNAVAILABLE");
  assert.strictEqual(res.manual_fallback, true);
  assert.strictEqual(mock.calls.length, 2);
});

// ---------- handler:入参校验 ----------

test("handler:text 超长/为空/纯空白/非字符串一律 INVALID_INPUT 且不调用 LLM", async () => {
  const cases = [
    { label: "501 字", text: "记".repeat(501) },
    { label: "空字符串", text: "" },
    { label: "纯空白", text: "   \n\t  " },
    { label: "数字", text: 123 },
    { label: "null", text: null },
    { label: "undefined", text: undefined },
  ];
  for (const c of cases) {
    const mock = seqMock(["不应被调用"]);
    const res = await handler(
      { text: c.text },
      { callLLM: mock.callLLM, logger: noopLogger }
    );
    assert.strictEqual(res.ok, false, c.label);
    assert.strictEqual(res.error, "INVALID_INPUT", c.label);
    assert.strictEqual(mock.calls.length, 0, c.label + " 不应调用 LLM");
  }
  const mock2 = seqMock(["不应被调用"]);
  const res2 = await handler({}, { callLLM: mock2.callLLM, logger: noopLogger });
  assert.strictEqual(res2.error, "INVALID_INPUT", "缺 text 字段");
  assert.strictEqual(mock2.calls.length, 0);

  // 500 字边界是合法输入(s13 样例已在成功用例中覆盖)。
  const mock3 = seqMock([rawFromSample(samples.find((s) => s.id === "s13"))]);
  const res3 = await handler(
    { text: samples.find((s) => s.id === "s13").text },
    { callLLM: mock3.callLLM, logger: noopLogger }
  );
  assert.strictEqual(res3.ok, true, "恰好 500 字应通过");
});

test("handler:缺 logger 也能正常工作(纯函数容错)", async () => {
  const sample = samples.find((s) => s.expect.draft);
  const mock = mockFromSample(sample);
  const res = await handler({ text: sample.text }, { callLLM: mock.callLLM });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.draft, sample.expect.draft);
});

// ---------- 日志纪律 ----------

test("日志只记文本长度、耗时、错误码,不含原文与提取结果", async () => {
  const sample = samples.find((s) => s.expect.draft && s.expect.draft.certain === true);
  const mock = mockFromSample(sample);
  const logs = [];
  const res = await handler(
    { text: sample.text },
    { callLLM: mock.callLLM, logger: (meta) => logs.push(meta) }
  );
  assert.strictEqual(res.ok, true);
  assert.ok(logs.length >= 1, "成功路径至少一条日志");
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes(sample.text), "日志不得包含原文");
  assert.ok(!serialized.includes(sample.expect.draft.name), "日志不得包含物品名");
  assert.ok(!serialized.includes(sample.expect.draft.location_text), "日志不得包含位置");
  for (const entry of logs) {
    for (const key of Object.keys(entry)) {
      assert.ok(
        ["textLength", "elapsedMs", "error"].includes(key),
        "日志出现越界字段:" + key
      );
    }
    assert.strictEqual(typeof entry.textLength, "number");
    assert.strictEqual(typeof entry.elapsedMs, "number");
    assert.ok(entry.elapsedMs >= 0);
  }
  assert.strictEqual(logs[logs.length - 1].textLength, codePointLength(sample.text));

  // 失败路径同样只记错误码。
  const mock2 = seqMock([new Error("HTTP_500")]);
  const logs2 = [];
  await handler(
    { text: sample.text },
    { callLLM: mock2.callLLM, logger: (meta) => logs2.push(meta) }
  );
  assert.strictEqual(logs2[logs2.length - 1].error, "AI_UNAVAILABLE");

  const mock3 = seqMock(["x"]);
  const logs3 = [];
  await handler(
    { text: "记".repeat(501) },
    { callLLM: mock3.callLLM, logger: (meta) => logs3.push(meta) }
  );
  assert.strictEqual(logs3[logs3.length - 1].error, "INVALID_INPUT");
});

// ---------- validateDraft 规则细节 ----------

test("validateDraft:certain 为 true 但空位置按不肯定处理", () => {
  const res = validateDraft(
    JSON.stringify({ name: "手电", location_text: "", certain: true, qualifiers: [] }),
    "手电"
  );
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.draft.certain, false);
  assert.strictEqual(res.draft.location_text, "");
});

test("validateDraft:长度与类型规则", () => {
  const cases = [
    { label: "name 超过 50 字", raw: { name: "长".repeat(51), location_text: "柜子", certain: true, qualifiers: [] } },
    { label: "location 超过 200 字", raw: { name: "钥匙", location_text: "柜".repeat(201), certain: true, qualifiers: [] } },
    { label: "qualifier 超过 20 字", raw: { name: "钥匙", location_text: "柜子", certain: true, qualifiers: ["长".repeat(21)] } },
    { label: "qualifier 非字符串", raw: { name: "钥匙", location_text: "柜子", certain: true, qualifiers: [1] } },
    { label: "qualifiers 非数组", raw: { name: "钥匙", location_text: "柜子", certain: true, qualifiers: "右边" } },
    { label: "certain 非布尔", raw: { name: "钥匙", location_text: "柜子", certain: "yes", qualifiers: [] } },
    { label: "needs_split 非布尔", raw: { name: "钥匙", location_text: "柜子", certain: true, qualifiers: [], needs_split: "true" } },
    { label: "name 缺失", raw: { location_text: "柜子", certain: true, qualifiers: [] } },
  ];
  for (const c of cases) {
    const res = validateDraft(JSON.stringify(c.raw), "原文");
    assert.strictEqual(res.ok, false, c.label);
    assert.strictEqual(res.error, "AI_UNAVAILABLE", c.label);
    assert.strictEqual(res.retryable, undefined, c.label + " 不属于可重试解析失败");
  }

  // name 为空白字符串 → AI_UNAVAILABLE。
  const resName = validateDraft(
    JSON.stringify({ name: " \t ", location_text: "", certain: false, qualifiers: [] }),
    "原文"
  );
  assert.strictEqual(resName.error, "AI_UNAVAILABLE");

  // name 去空白后统计长度(内部空白不计数)。
  const resSpaces = validateDraft(
    JSON.stringify({ name: "a b", location_text: "柜 子", certain: true, qualifiers: [] }),
    "原文"
  );
  assert.strictEqual(resSpaces.ok, true);
  assert.strictEqual(resSpaces.draft.name, "ab");
  assert.strictEqual(resSpaces.draft.location_text, "柜子");
});

test("validateDraft:仅 qualifiers 数量允许截断为 5 个", () => {
  const res = validateDraft(
    JSON.stringify({
      name: "钥匙",
      location_text: "柜子",
      certain: true,
      qualifiers: ["一", "二", "三", "四", "五", "六", "七"],
    }),
    "原文"
  );
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.draft.qualifiers, ["一", "二", "三", "四", "五"]);
});

test("validateDraft:JSON 解析失败返回可重试标记", () => {
  const bads = [
    undefined,
    null,
    42,
    "",
    "   ",
    "这不是 JSON",
    "还是不行 { 未闭合",
    "[1,2,3]",
    "null",
    "一句话",
  ];
  for (const bad of bads) {
    const res = validateDraft(bad, "原文");
    assert.strictEqual(res.ok, false, "坏输入应 ok:false");
    assert.strictEqual(res.retryable, true, "应标记可重试:" + JSON.stringify(bad));
    assert.ok(typeof res.reason === "string" && res.reason.length > 0, "应带原因");
  }
});

test("validateDraft:needs_split 优先于其余字段校验", () => {
  const res = validateDraft(JSON.stringify({ needs_split: true, name: "" }), "原文");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.needs_split, true);
  assert.strictEqual(res.message, "一次只记一件物品,请分开说");
});

// ---------- buildPrompt ----------

test("buildPrompt:包含契约要点、用户输入与重试上下文", () => {
  const prompt = buildPrompt("降压药在厨房");
  assert.ok(prompt.includes("【用户输入】\n降压药在厨房"));
  for (const keyword of [
    "家庭物品位置提取器",
    "位置必须来自原文",
    "禁止猜测",
    "qualifiers",
    "needs_split",
    "certain",
    "只输出一个 JSON 对象",
  ]) {
    assert.ok(prompt.includes(keyword), "system prompt 缺少要点:" + keyword);
  }
  const retryPrompt = buildPrompt("降压药在厨房", {
    previousOutput: "上次烂输出",
    reason: "输出不是合法的 JSON 对象",
  });
  assert.ok(retryPrompt.includes("【上次输出】\n上次烂输出"));
  assert.ok(retryPrompt.includes("【解析错误】\n输出不是合法的 JSON 对象"));
});

// ---------- 协议 v2:多件拆分 validateDrafts ----------

const { validateDrafts } = require("../cloudfunctions/extractDraft/lib/validate");

function rawItems(items) {
  return JSON.stringify({ items });
}

test("v2 校验:一句话两件正确拆分,source_quote 为原话子串", function () {
  const original = "钥匙放在玄关抽屉,充电宝放在客厅电视柜";
  const result = validateDrafts(
    rawItems([
      { name: "钥匙", location_text: "玄关抽屉", certain: true, qualifiers: [], source_quote: "钥匙放在玄关抽屉" },
      { name: "充电宝", location_text: "客厅电视柜", certain: true, qualifiers: [], source_quote: "充电宝放在客厅电视柜" },
    ]),
    original,
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts.length, 2);
  assert.equal(result.drafts[0].source_quote, "钥匙放在玄关抽屉");
  assert.equal(result.drafts[1].location_text, "客厅电视柜");
});

test("v2 校验:多件共用同一位置合法(评审点名的串配防护场景)", function () {
  const original = "钥匙和充电宝都在玄关抽屉";
  const result = validateDrafts(
    rawItems([
      { name: "钥匙", location_text: "玄关抽屉", certain: true, qualifiers: [], source_quote: "钥匙和充电宝都在玄关抽屉" },
      { name: "充电宝", location_text: "玄关抽屉", certain: true, qualifiers: [], source_quote: "钥匙和充电宝都在玄关抽屉" },
    ]),
    original,
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts[0].location_text, "玄关抽屉");
  assert.equal(result.drafts[1].location_text, "玄关抽屉");
});

test("v2 校验:source_quote 不是原话子串时置空(证据缺失标记),不废整件", function () {
  const result = validateDrafts(
    rawItems([
      { name: "钥匙", location_text: "玄关抽屉", certain: true, qualifiers: [], source_quote: "钥匙在火星" },
    ]),
    "钥匙放在玄关抽屉",
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts[0].source_quote, "", "编造的证据必须被置空");
  assert.equal(result.drafts[0].name, "钥匙", "证据缺失不影响物品本身");
});

test("v2 校验:单件也走数组形态(长度 1)", function () {
  const result = validateDrafts(
    rawItems([{ name: "药膏", location_text: "", certain: false, qualifiers: [], source_quote: "药膏放哪来着" }]),
    "药膏放哪来着",
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].certain, false);
  assert.equal(result.drafts[0].location_text, "", "certain=false 强制空位置(幻觉防护延续)");
});

test("v2 校验:items 为空 / 超过 5 件 / 坏 JSON 的拒绝路径", function () {
  assert.equal(validateDrafts(rawItems([]), "随便说").ok, false);
  const six = Array.from({ length: 6 }, (_, i) => ({
    name: "物品" + i,
    location_text: "桌上",
    certain: true,
    qualifiers: [],
    source_quote: "物品" + i,
  }));
  assert.notEqual(validateDrafts(rawItems(six), "物品0物品1物品2物品3物品4物品5").ok, true, "超上限必须拒绝(重试兜底)");
  const bad = validateDrafts("这不是JSON", "原文");
  assert.equal(bad.retryable, true, "坏 JSON 走重试");
});

test("v2 校验:某件名称非法整次拒绝(不静默丢件)", function () {
  const result = validateDrafts(
    rawItems([
      { name: "钥匙", location_text: "玄关", certain: true, qualifiers: [], source_quote: "钥匙在玄关" },
      { name: "   ", location_text: "桌上", certain: true, qualifiers: [], source_quote: "桌上" },
    ]),
    "钥匙在玄关,还有个东西在桌上",
  );
  assert.equal(result.ok, false);
});

// ---------- 协议 v2:handler 路由 ----------

test("handler 路由:protocol:2 走 v2 prompt 与 drafts 响应", async function () {
  const original = "钥匙放玄关抽屉,充电宝放客厅电视柜";
  const reply = rawItems([
    { name: "钥匙", location_text: "玄关抽屉", certain: true, qualifiers: [], source_quote: "钥匙放玄关抽屉" },
    { name: "充电宝", location_text: "客厅电视柜", certain: true, qualifiers: [], source_quote: "充电宝放客厅电视柜" },
  ]);
  let seenPrompt = "";
  const result = await handler({ text: original, protocol: 2 }, {
    logger() {},
    callLLM(prompt) {
      seenPrompt = prompt;
      return Promise.resolve(reply);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.drafts.length, 2);
  assert.equal(result.original_text, original);
  assert.ok(seenPrompt.indexOf("items") !== -1, "v2 请求必须用拆分版 prompt");
});

test("handler 路由:不带 protocol 的旧客户端维持 v1 行为(兼容硬门)", async function () {
  const result = await handler({ text: "钥匙放玄关抽屉,充电宝放客厅" }, {
    logger() {},
    callLLM() {
      return Promise.resolve(JSON.stringify({ needs_split: true }));
    },
  });
  assert.deepEqual(result, { ok: true, needs_split: true, message: "一次只记一件物品,请分开说" });
});

// ---------- has_more 截断提示(评审阻断 1:超 5 件绝不静默) ----------

test("v2 校验:has_more=true 透传 truncated(超 5 件前 5 条 + 截断标记)", function () {
  const items = Array.from({ length: 5 }, (_, i) => ({
    name: "物品" + i,
    location_text: "桌上",
    certain: true,
    qualifiers: [],
    source_quote: "物品" + i,
  }));
  const result = validateDrafts(JSON.stringify({ items, has_more: true }), "物品0物品1物品2物品3物品4还有更多");
  assert.equal(result.ok, true);
  assert.equal(result.drafts.length, 5);
  assert.equal(result.truncated, true, "截断必须显式透传,不得静默");
});

test("v2 校验:has_more 缺省为 false;非布尔拒绝", function () {
  const ok = validateDrafts(
    rawItems([{ name: "钥匙", location_text: "玄关", certain: true, qualifiers: [], source_quote: "钥匙在玄关" }]),
    "钥匙在玄关",
  );
  assert.equal(ok.truncated, false);
  const bad = validateDrafts(
    JSON.stringify({ items: [{ name: "钥匙", certain: true, qualifiers: [], source_quote: "钥匙", location_text: "玄关" }], has_more: "yes" }),
    "钥匙在玄关",
  );
  assert.equal(bad.ok, false);
});

test("handler v2:响应透传 truncated", async function () {
  const result = await handler({ text: "甲在桌上乙在桌上丙在桌上丁在桌上戊在桌上还有很多", protocol: 2 }, {
    logger() {},
    callLLM() {
      return Promise.resolve(JSON.stringify({
        items: Array.from({ length: 5 }, (_, i) => ({ name: "物" + i, location_text: "桌上", certain: true, qualifiers: [], source_quote: "物" + i })),
        has_more: true,
      }));
    },
  });
  assert.equal(result.truncated, true);
  assert.equal(result.ok, true);
});

// ---------- 位置锚定校验(评审二轮:合法片段不得为错误配对背书) ----------

test("v2 位置锚定:位置不在其证据片段内 → 按「不肯定」降级,不废件也不放行(交叉配对反例)", function () {
  // 原话两件两位置,模型把钥匙配到「客厅」(充电宝的位置):quote 合法但配对错误
  const result = validateDrafts(
    rawItems([
      { name: "钥匙", location_text: "客厅电视柜", certain: true, qualifiers: [], source_quote: "钥匙放在玄关抽屉" },
    ]),
    "钥匙放在玄关抽屉,充电宝放在客厅电视柜",
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts[0].certain, false, "位置未锚定在证据内必须降级为不肯定");
  assert.equal(result.drafts[0].location_text, "", "降级时位置清空,交用户补填");
  assert.equal(result.drafts[0].name, "钥匙", "物品本身保留");
  assert.equal(result.drafts[0].source_quote, "钥匙放在玄关抽屉", "合法证据仍保留展示");
});

test("v2 位置锚定:编造的位置(原话完全没有)同样降级;正确配对不受影响", function () {
  const fabricated = validateDrafts(
    rawItems([{ name: "钥匙", location_text: "冰箱里", certain: true, qualifiers: [], source_quote: "钥匙在桌上" }]),
    "钥匙在桌上",
  );
  assert.equal(fabricated.drafts[0].certain, false, "编造位置降级");

  const ok = validateDrafts(
    rawItems([{ name: "钥匙", location_text: "桌上", certain: true, qualifiers: [], source_quote: "钥匙在桌上" }]),
    "钥匙在桌上",
  );
  assert.equal(ok.drafts[0].certain, true, "位置锚定在证据内则保留");
  assert.equal(ok.drafts[0].location_text, "桌上");
});

test("v2 位置锚定:共享位置合法通过(两件 quote 均含共同位置)", function () {
  const result = validateDrafts(
    rawItems([
      { name: "钥匙", location_text: "玄关抽屉", certain: true, qualifiers: [], source_quote: "钥匙和充电宝都在玄关抽屉" },
      { name: "充电宝", location_text: "玄关抽屉", certain: true, qualifiers: [], source_quote: "钥匙和充电宝都在玄关抽屉" },
    ]),
    "钥匙和充电宝都在玄关抽屉",
  );
  assert.equal(result.drafts[0].certain, true);
  assert.equal(result.drafts[1].certain, true);
});

test("v2 位置锚定:source_quote 为空时以整句原话为锚(证据缺失不放松位置防线)", function () {
  const result = validateDrafts(
    rawItems([{ name: "钥匙", location_text: "冰箱里", certain: true, qualifiers: [], source_quote: "编造的引用" }]),
    "钥匙在桌上",
  );
  // quote 非子串被置空 → 锚退化为整句原话,「冰箱里」不在原话 → 降级
  assert.equal(result.drafts[0].source_quote, "");
  assert.equal(result.drafts[0].certain, false);
});

test("v2 漏报反例:模型只回 5 件且 has_more=false 时校验器无法判漏 —— 由前端「恰好 5 件也提示核对」兜底", async function () {
  const five = Array.from({ length: 5 }, (_, i) => ({ name: "物" + i, location_text: "桌上", certain: true, qualifiers: [], source_quote: "物" + i }));
  const result = await handler({ text: "物0物1物2物3物4在桌上,还有物5物6", protocol: 2 }, {
    logger() {},
    callLLM() {
      return Promise.resolve(JSON.stringify({ items: five, has_more: false })); // 模型漏报
    },
  });
  assert.equal(result.drafts.length, 5);
  assert.equal(result.truncated, false, "漏报时校验器确实无法察觉");
  // 因此确认页对 rows.length>=5 一律显示核对提示(不依赖 has_more),见 confirm.wxml
});

// ---------- anchor_shared(三轮:整句证据含多件名 → 待人工核对) ----------

test("v2 锚定共享:quote 是含两件名称的整句 → anchor_shared=true(不默认确认)", function () {
  const result = validateDrafts(
    rawItems([
      { name: "钥匙", location_text: "玄关抽屉", certain: true, qualifiers: [], source_quote: "钥匙放在玄关抽屉,充电宝放在客厅电视柜" },
      { name: "充电宝", location_text: "客厅电视柜", certain: true, qualifiers: [], source_quote: "钥匙放在玄关抽屉,充电宝放在客厅电视柜" },
    ]),
    "钥匙放在玄关抽屉,充电宝放在客厅电视柜",
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts[0].anchor_shared, true, "整句含他件名称 → 归属无法确定性排除,须人工核对");
  assert.equal(result.drafts[1].anchor_shared, true);
});

test("v2 锚定共享:专属片段(只含本件名)→ anchor_shared=false,可默认勾选", function () {
  const result = validateDrafts(
    rawItems([
      { name: "钥匙", location_text: "玄关抽屉", certain: true, qualifiers: [], source_quote: "钥匙放在玄关抽屉" },
      { name: "充电宝", location_text: "客厅电视柜", certain: true, qualifiers: [], source_quote: "充电宝放在客厅电视柜" },
    ]),
    "钥匙放在玄关抽屉,充电宝放在客厅电视柜",
  );
  assert.equal(result.drafts[0].anchor_shared, false);
  assert.equal(result.drafts[1].anchor_shared, false);
});
