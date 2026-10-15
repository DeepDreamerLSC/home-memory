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

// ---------- v2 保质期/提醒候选(issue #36:日期只来自原话,逐字锚定,模糊一律不带) ----------

// 固定「今天」= 2026-10-15(与语料金标基准日 2026-10-13 同期),无年份日期按它补全。
const FIXED_TODAY = () => new Date(2026, 9, 15);

/*
 * 金标正例 8 句:前 4 句取自 scripts/experiments/reminder-spike/corpus.jsonl 里
 * 原话明说日精度到期日的全部 4 句(c09/c10/c11/c20);后 4 句为同风格补充句
 * (D0 原型教句「感冒药…11月20号到期」见 issue45-handoff 十五轮记录),
 * 补足 有效期/开封后/下次维护 三类与「多件仅一件带日期」场景。
 */
const REMIND_GOLD = [
  {
    id: "c09-corpus",
    text: "10月20号之前要还图书馆的书,放玄关的置物篮里。",
    replyItems: [
      { name: "图书馆的书", location_text: "玄关的置物篮里", certain: true, qualifiers: [], source_quote: "10月20号之前要还图书馆的书,放玄关的置物篮里", remind_at: "2026-10-20", remind_kind: "下次维护", remind_quote: "10月20号" },
    ],
    expect: [{ remind_at: "2026-10-20", remind_kind: "下次维护", remind_quote: "10月20号" }],
  },
  {
    id: "c10-corpus",
    text: "11月15号给爸妈寄冬衣,羽绒服在主卧衣帽间的行李箱里。",
    replyItems: [
      { name: "羽绒服", location_text: "主卧衣帽间的行李箱里", certain: true, qualifiers: [], source_quote: "羽绒服在主卧衣帽间的行李箱里", remind_at: "2026-11-15", remind_kind: "下次维护", remind_quote: "11月15号" },
    ],
    expect: [{ remind_at: "2026-11-15", remind_kind: "下次维护", remind_quote: "11月15号" }],
  },
  {
    id: "c11-corpus",
    text: "房租11月30号要续,合同放在书房文件盒里。",
    replyItems: [
      { name: "租房合同", location_text: "书房文件盒里", certain: true, qualifiers: [], source_quote: "合同放在书房文件盒里", remind_at: "2026-11-30", remind_kind: "下次维护", remind_quote: "11月30号" },
    ],
    expect: [{ remind_at: "2026-11-30", remind_kind: "下次维护", remind_quote: "11月30号" }],
  },
  {
    id: "c20-corpus",
    text: "投影仪的购机发票在客厅电视柜抽屉里,2027年6月30号保修到期。",
    replyItems: [
      { name: "投影仪购机发票", location_text: "客厅电视柜抽屉里", certain: true, qualifiers: [], source_quote: "投影仪的购机发票在客厅电视柜抽屉里,2027年6月30号保修到期", remind_at: "2027-06-30", remind_kind: "有效期", remind_quote: "2027年6月30号" },
    ],
    expect: [{ remind_at: "2027-06-30", remind_kind: "有效期", remind_quote: "2027年6月30号" }],
  },
  {
    id: "d0-teach",
    text: "感冒药放药箱第一格,11月20号到期。",
    replyItems: [
      { name: "感冒药", location_text: "药箱第一格", certain: true, qualifiers: [], source_quote: "感冒药放药箱第一格,11月20号到期", remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "11月20号" },
    ],
    expect: [{ remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "11月20号" }],
  },
  {
    id: "after-open",
    text: "婴幼儿米粉开封了,11月30号之前要吃完,放厨房吊柜里。",
    replyItems: [
      { name: "婴幼儿米粉", location_text: "厨房吊柜里", certain: true, qualifiers: [], source_quote: "婴幼儿米粉开封了,11月30号之前要吃完", remind_at: "2026-11-30", remind_kind: "开封后", remind_quote: "11月30号" },
    ],
    expect: [{ remind_at: "2026-11-30", remind_kind: "开封后", remind_quote: "11月30号" }],
  },
  {
    id: "next-maintenance",
    text: "咖啡机的除垢提醒是2027年1月10号,咖啡机在餐边柜上。",
    replyItems: [
      { name: "咖啡机", location_text: "餐边柜上", certain: true, qualifiers: [], source_quote: "咖啡机的除垢提醒是2027年1月10号,咖啡机在餐边柜上", remind_at: "2027-01-10", remind_kind: "下次维护", remind_quote: "2027年1月10号" },
    ],
    expect: [{ remind_at: "2027-01-10", remind_kind: "下次维护", remind_quote: "2027年1月10号" }],
  },
  {
    id: "multi-one-dated",
    text: "牛奶放冰箱门架上,11月20号过期,抹布在洗碗池边上。",
    replyItems: [
      { name: "牛奶", location_text: "冰箱门架上", certain: true, qualifiers: [], source_quote: "牛奶放冰箱门架上,11月20号过期", remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "11月20号" },
      { name: "抹布", location_text: "洗碗池边上", certain: true, qualifiers: [], source_quote: "抹布在洗碗池边上" },
    ],
    expect: [
      { remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "11月20号" },
      { remind_at: null, remind_kind: null, remind_quote: null },
    ],
  },
];

function remindTrio(draft) {
  return { remind_at: draft.remind_at, remind_kind: draft.remind_kind, remind_quote: draft.remind_quote };
}

async function runV2(text, reply, opts) {
  opts = opts || {};
  const calls = [];
  const res = await handler({ text, protocol: 2 }, {
    logger: opts.logger || function () {},
    today: opts.today || FIXED_TODAY,
    callLLM(prompt) {
      calls.push(prompt);
      return Promise.resolve(reply);
    },
  });
  return { res, prompt: calls[0], calls };
}

test("v2 提醒金标:原话明说绝对日期 → remind 三项逐句符合金标(prompt 附【今天】)", async function () {
  for (const gold of REMIND_GOLD) {
    const { res, prompt } = await runV2(gold.text, rawItems(gold.replyItems));
    assert.equal(res.ok, true, gold.id + " 应成功");
    assert.equal(res.drafts.length, gold.expect.length, gold.id + " 件数不符");
    for (let i = 0; i < gold.expect.length; i++) {
      assert.deepStrictEqual(
        remindTrio(res.drafts[i]),
        gold.expect[i],
        gold.id + " 第 " + (i + 1) + " 件提醒候选应为 " + JSON.stringify(gold.expect[i]),
      );
    }
    assert.ok(prompt.includes("【今天】2026-10-15"), gold.id + " v2 prompt 应附今天日期供无年份日期补全");
    assert.ok(prompt.includes(gold.text), gold.id + " prompt 应包含用户原话");
  }
});

test("v2 提醒金标:类别为中文枚举 有效期/开封后/下次维护,quote 是原话逐字子串", async function () {
  for (const gold of REMIND_GOLD) {
    const { res } = await runV2(gold.text, rawItems(gold.replyItems));
    for (const draft of res.drafts) {
      if (draft.remind_at === null) continue;
      assert.ok(["有效期", "开封后", "下次维护"].includes(draft.remind_kind), gold.id + " 类别越界:" + draft.remind_kind);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(draft.remind_at), gold.id + " 日期应为 YYYY-MM-DD:" + draft.remind_at);
      assert.ok(gold.text.indexOf(draft.remind_quote) !== -1, gold.id + " 日期证据必须是原话逐字子串:" + draft.remind_quote);
    }
  }
});

// 反例:模糊/相对/月精度/需换算 —— 一律三项全 null(日期由用户在确认页自己选)。
// folded = 模型违反纪律时最可能折算出的日期(对抗值):反例测试必须真实喂给
// mock 模型,验证服务端硬门(quote↔remind_at 对应锚定)把它们拦下来置 null,
// 而不是只测「模型自觉输出 null」的透传(那样删掉校验逻辑测试也照样绿)。
const REMIND_NEGATIVE = [
  {
    id: "vague-下个月",
    text: "下个月要换净水器滤芯,滤芯在厨房抽屉里。",
    quote: "下个月",
    folded: "2026-11-15",
  },
  {
    id: "vague-快过期了(c27 近义)",
    text: "洗洁精快过期了,好像才用了一半,放在水槽下面的柜子里。",
    quote: "快过期了",
    folded: "2026-10-22",
  },
  {
    id: "vague-大概冬天",
    text: "猫粮大概冬天之前要买新的,放玄关柜子下层。",
    quote: "大概冬天",
    folded: "2026-12-15",
  },
  {
    id: "vague-差不多半年(c27)",
    text: "防晒霜差不多半年就该换了,在化妆包里。",
    quote: "差不多半年",
    folded: "2027-04-15",
  },
  {
    id: "relative-下周三类(c08 下周五)",
    text: "跟同事借的书下周五要还,书在床头柜第一格。",
    quote: "下周五",
    folded: "2026-10-23",
  },
  {
    id: "relative-半年后(c01)",
    text: "净水器的备用滤芯放在厨房水槽下面的柜子里,半年后提醒我换。",
    quote: "半年后",
    folded: "2027-04-15",
  },
  {
    id: "recurring-每三个月(c05)",
    text: "空气净化器的滤网在客厅电视柜第二层,每三个月换一次。",
    quote: "每三个月",
    folded: "2027-01-15",
  },
  {
    id: "month-precision(c18 保修到2027年3月)",
    text: "扫地机器人的保修卡在书房文件盒第二层,保修到2027年3月。",
    quote: "到2027年3月",
    folded: "2027-03-15",
  },
  {
    id: "production-conversion(c15 生产日期+保质期)",
    text: "这箱常温奶的生产日期是10月5号,保质期六个月,放阳台储物架上。",
    quote: "10月5号",
    folded: "2027-04-05",
  },
  {
    id: "after-open-no-date(c12 开封后三个月)",
    text: "婴儿配方奶粉开封后一个月内要吃完,现在放餐边柜第二层。",
    quote: "开封后一个月内",
    folded: "2026-11-15",
  },
];

test("v2 提醒反例(对抗):模糊/相对/月精度/需换算折算成日期也穿透不了服务端硬门 → 三项全 null,物品照常提取不废件", async function () {
  for (const neg of REMIND_NEGATIVE) {
    const item = {
      name: "物品",
      location_text: "某处",
      certain: true,
      qualifiers: [],
      source_quote: neg.text,
      remind_at: neg.folded, // 模型违反纪律折算出的日期
      remind_kind: "下次维护",
      remind_quote: neg.quote, // 模糊表述的原话逐字子串(逐字锚定本可通过)
    };
    const { res } = await runV2(neg.text, rawItems([item]));
    assert.equal(res.ok, true, neg.id + " 拦下提醒也必须成功");
    assert.equal(res.drafts[0].name, "物品", neg.id + " 物品照常提取不废件");
    assert.deepStrictEqual(
      remindTrio(res.drafts[0]),
      { remind_at: null, remind_kind: null, remind_quote: null },
      neg.id + "「" + neg.quote + "」折算成 " + neg.folded + " 绝不能穿透服务端",
    );
  }
});

test("v2 提醒反例(自觉):模型按纪律输出三项 null → 原样透传不带提醒", async function () {
  const neg = REMIND_NEGATIVE[0];
  const { res } = await runV2(
    neg.text,
    rawItems([{ name: "物品", location_text: "某处", certain: true, qualifiers: [], source_quote: neg.text, remind_at: null, remind_kind: null, remind_quote: null }]),
  );
  assert.equal(res.ok, true);
  assert.deepStrictEqual(remindTrio(res.drafts[0]), { remind_at: null, remind_kind: null, remind_quote: null });
});

test("v2 prompt 纪律:模糊/相对/月精度/换算反例逐字在册,无年份按最近未来补全", async function () {
  const { prompt } = await runV2("感冒药放药箱第一格,11月20号到期。", rawItems([
    { name: "感冒药", location_text: "药箱第一格", certain: true, qualifiers: [], source_quote: "感冒药放药箱第一格", remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "11月20号" },
  ]));
  for (const banned of [
    "下个月",
    "快过期了",
    "大概冬天",
    "差不多半年",
    "下周三",
    "半年后",
    "每三个月",
    "保修到2027年3月",
    "生产日期是10月5号保质期六个月",
    "开封后三个月",
  ]) {
    assert.ok(prompt.includes(banned), "prompt 纪律必须逐字点名反例:" + banned);
  }
  assert.ok(prompt.includes("只接受原话里明确说了的绝对日期"), "必须写明唯一日期来源");
  assert.ok(prompt.includes("按【今天】补全为最近的未来日期"), "无年份日期必须写明补全规则");
  assert.ok(prompt.includes("禁止根据物品名称猜任何日期"), "必须禁止按物品名猜周期");
  for (const kind of ["有效期", "开封后", "下次维护"]) {
    assert.ok(prompt.includes(kind), "prompt 应定义类别:" + kind);
  }
  // 既有 v2 契约零变化:拆分/证据/限定语规则原样保留。
  for (const kept of ["最多 5 件", "has_more", "source_quote", "qualifiers", "禁止改写或拼接原文"]) {
    assert.ok(prompt.includes(kept), "v2 既有规则不得被提醒增补挤掉:" + kept);
  }
});

// ---------- v2 提醒服务端硬门:锚定/格式失败置 null,绝不废件 ----------

const ANCHOR_ORIGINAL = "感冒药放药箱第一格,11月20号到期。";
// 直调 validateDrafts 的固定「今天」(与 runV2 的 FIXED_TODAY 同一天):
// 对应锚定里无年份日期按它补全最近未来,直调用例据此保持确定性。
const ANCHOR_TODAY = "2026-10-15";
const ANCHOR_BASE = {
  name: "感冒药",
  location_text: "药箱第一格",
  certain: true,
  qualifiers: [],
  source_quote: "感冒药放药箱第一格",
};

test("v2 提醒锚定:quote 改写原话(非逐字子串)→ 三项置 null,物品与位置原样保留", function () {
  const result = validateDrafts(
    rawItems([Object.assign({}, ANCHOR_BASE, {
      remind_at: "2026-11-20",
      remind_kind: "有效期",
      remind_quote: "十一月二十号到期", // 模型把数字改写成了汉字,不再是逐字子串
    })]),
    ANCHOR_ORIGINAL,
    ANCHOR_TODAY,
  );
  assert.equal(result.ok, true, "锚定失败绝不废件");
  assert.equal(result.drafts[0].name, "感冒药");
  assert.equal(result.drafts[0].location_text, "药箱第一格");
  assert.equal(result.drafts[0].certain, true);
  assert.deepStrictEqual(remindTrio(result.drafts[0]), { remind_at: null, remind_kind: null, remind_quote: null });
});

test("v2 提醒对应锚定:quote 是原话子串但没说这个日期(折算值/无关日期)→ 三项全 null", function () {
  const probes = [
    {
      label: "模糊表述折算成日期(quote=下个月)",
      original: "下个月要换净水器滤芯,滤芯在厨房抽屉里。",
      fields: { remind_at: "2026-11-15", remind_kind: "下次维护", remind_quote: "下个月" },
    },
    {
      label: "quote 里的日期与 remind_at 无关",
      fields: { remind_at: "2030-01-01", remind_kind: "有效期", remind_quote: "11月20号" },
    },
    {
      label: "无年份日期折去已过的今年(应补全为明年)",
      fields: { remind_at: "2026-06-30", remind_kind: "有效期", remind_quote: "6月30号" },
    },
    {
      label: "月精度折算成月中(quote=到2027年3月)",
      original: "扫地机器人的保修卡在书房文件盒第二层,保修到2027年3月。",
      fields: { remind_at: "2027-03-15", remind_kind: "有效期", remind_quote: "到2027年3月" },
    },
    {
      label: "中文数字日期解析不出候选(锚定失败=不带)",
      original: "感冒药放药箱,十一月二十号到期。",
      fields: { remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "十一月二十号到期" },
    },
  ];
  for (const p of probes) {
    const result = validateDrafts(
      rawItems([Object.assign({}, ANCHOR_BASE, p.fields)]),
      p.original || ANCHOR_ORIGINAL,
      ANCHOR_TODAY,
    );
    assert.equal(result.ok, true, p.label + " 不废件");
    assert.deepStrictEqual(
      remindTrio(result.drafts[0]),
      { remind_at: null, remind_kind: null, remind_quote: null },
      p.label + " 应三项全 null",
    );
  }
});

test("v2 提醒对应锚定:quote 里真的说了这个日期(显式年份/无年份补全/ISO/带上下文)→ 保留", function () {
  const probes = [
    { label: "无年份,今年未来", original: "感冒药放药箱第一格,11月20号到期。", fields: { remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "11月20号" } },
    { label: "无年份,带日期后缀上下文", original: "感冒药放药箱第一格,11月20号到期。", fields: { remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "11月20号到期" } },
    { label: "显式年份", original: "投影仪的购机发票在客厅电视柜抽屉里,2027年6月30号保修到期。", fields: { remind_at: "2027-06-30", remind_kind: "有效期", remind_quote: "2027年6月30号" } },
    { label: "无年份,今年已过补全明年", original: "图书馆的书10月5号之前要还,放玄关的置物篮里。", fields: { remind_at: "2027-10-05", remind_kind: "下次维护", remind_quote: "10月5号" } },
    { label: "ISO 形态", original: "签证 2026-11-20 到期,放书房抽屉里。", fields: { remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "2026-11-20" } },
  ];
  for (const p of probes) {
    const result = validateDrafts(
      rawItems([Object.assign({}, ANCHOR_BASE, p.fields)]),
      p.original,
      ANCHOR_TODAY,
    );
    assert.equal(result.ok, true, p.label);
    assert.equal(result.drafts[0].remind_at, p.fields.remind_at, p.label + " 应保留");
    assert.equal(result.drafts[0].remind_quote, p.fields.remind_quote);
  }
});

test("v2 提醒硬门:格式/日历/类别/缺项各种违规一律三项全 null(不废件)", function () {
  const bad = [
    { label: "日期 11 月 32 日", fields: { remind_at: "2026-11-32", remind_kind: "有效期", remind_quote: "11月20号" } },
    { label: "2 月 30 日不存在", fields: { remind_at: "2026-02-30", remind_kind: "有效期", remind_quote: "11月20号" } },
    { label: "月份 13", fields: { remind_at: "2026-13-01", remind_kind: "有效期", remind_quote: "11月20号" } },
    { label: "斜杠格式", fields: { remind_at: "2026/11/20", remind_kind: "有效期", remind_quote: "11月20号" } },
    { label: "纯数字串", fields: { remind_at: "20261120", remind_kind: "有效期", remind_quote: "11月20号" } },
    { label: "非字符串(数字)", fields: { remind_at: 20261120, remind_kind: "有效期", remind_quote: "11月20号" } },
    { label: "类别越界", fields: { remind_at: "2026-11-20", remind_kind: "到期", remind_quote: "11月20号" } },
    { label: "类别缺失", fields: { remind_at: "2026-11-20", remind_quote: "11月20号" } },
    { label: "quote 缺失", fields: { remind_at: "2026-11-20", remind_kind: "有效期" } },
    { label: "quote 空串", fields: { remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "" } },
    { label: "quote 超长 201 字", fields: { remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "号".repeat(201) } },
    { label: "quote 编造(原话没有)", fields: { remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "12月31号到期" } },
  ];
  for (const c of bad) {
    const result = validateDrafts(rawItems([Object.assign({}, ANCHOR_BASE, c.fields)]), ANCHOR_ORIGINAL, ANCHOR_TODAY);
    assert.equal(result.ok, true, c.label + " 不废件");
    assert.deepStrictEqual(
      remindTrio(result.drafts[0]),
      { remind_at: null, remind_kind: null, remind_quote: null },
      c.label + " 应三项全 null",
    );
    assert.equal(result.drafts[0].name, "感冒药", c.label + " 物品保留");
  }
});

test("v2 提醒半态禁止:有日期无类别、有类别无日期、只带 quote —— 一律整体不带", function () {
  const half = [
    { label: "只有日期", fields: { remind_at: "2026-11-20" } },
    { label: "只有类别", fields: { remind_kind: "有效期" } },
    { label: "只有 quote", fields: { remind_quote: "11月20号" } },
    { label: "日期 null + 类别 + quote", fields: { remind_at: null, remind_kind: "有效期", remind_quote: "11月20号" } },
  ];
  for (const c of half) {
    const result = validateDrafts(rawItems([Object.assign({}, ANCHOR_BASE, c.fields)]), ANCHOR_ORIGINAL, ANCHOR_TODAY);
    assert.equal(result.ok, true, c.label);
    assert.deepStrictEqual(remindTrio(result.drafts[0]), { remind_at: null, remind_kind: null, remind_quote: null }, c.label);
  }
});

test("v2 提醒合法细节:日期去首尾空白、quote 取原话逐字串(去空白比对口径同 source_quote)", function () {
  const result = validateDrafts(
    rawItems([Object.assign({}, ANCHOR_BASE, {
      remind_at: " 2026-11-20 ",
      remind_kind: "有效期",
      remind_quote: "11月20号",
    })]),
    ANCHOR_ORIGINAL,
    ANCHOR_TODAY,
  );
  assert.equal(result.drafts[0].remind_at, "2026-11-20", "首尾空白应被规范化");
  assert.equal(result.drafts[0].remind_quote, "11月20号");
});

// ---------- v2 既有行为零变化 + v1 零变化 ----------

test("v2 提醒不影响既有行为:has_more 透传、位置锚定降级、anchor_shared 照常计算", function () {
  // 位置交叉配对被降级的同时,合法提醒候选保留(两条防线互不干扰)。
  const result = validateDrafts(
    rawItems([
      { name: "牛奶", location_text: "洗碗池边上", certain: true, qualifiers: [], source_quote: "牛奶放冰箱门架上,11月20号过期", remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "11月20号" },
      { name: "抹布", location_text: "洗碗池边上", certain: true, qualifiers: [], source_quote: "抹布在洗碗池边上" },
    ]),
    "牛奶放冰箱门架上,11月20号过期,抹布在洗碗池边上",
    ANCHOR_TODAY,
  );
  assert.equal(result.truncated, false);
  assert.equal(result.drafts[0].certain, false, "位置配错仍必须降级(提醒增补不放松位置防线)");
  assert.equal(result.drafts[0].location_text, "");
  assert.equal(result.drafts[0].remind_at, "2026-11-20", "位置降级不牵连合法提醒候选");
  assert.equal(result.drafts[0].remind_kind, "有效期");

  // 整句 quote 含他件名称 → anchor_shared 照常置真。
  const shared = validateDrafts(
    rawItems([
      { name: "牛奶", location_text: "冰箱门架上", certain: true, qualifiers: [], source_quote: "牛奶放冰箱门架上,11月20号过期,抹布在洗碗池边上", remind_at: "2026-11-20", remind_kind: "有效期", remind_quote: "11月20号" },
      { name: "抹布", location_text: "洗碗池边上", certain: true, qualifiers: [], source_quote: "牛奶放冰箱门架上,11月20号过期,抹布在洗碗池边上" },
    ]),
    "牛奶放冰箱门架上,11月20号过期,抹布在洗碗池边上",
    ANCHOR_TODAY,
  );
  assert.equal(shared.drafts[0].anchor_shared, true, "anchor_shared 行为不变");
  assert.equal(shared.drafts[1].anchor_shared, true);
});

test("v2 handler:带提醒候选时 truncated 与 drafts 透传如常", async function () {
  // PR #52 B3 后多件时提醒须落在该件自己的 source_quote 内:物0 的证据片段
  // 带上日期(归属可验证),其余件的片段不含该日期(不竞争)
  const items = Array.from({ length: 5 }, (_, i) => ({
    name: "物" + i,
    location_text: "桌上",
    certain: true,
    qualifiers: [],
    source_quote: i === 0 ? "物0在桌上,11月20号过期" : "物" + i,
    remind_at: i === 0 ? "2026-11-20" : null,
    remind_kind: i === 0 ? "有效期" : null,
    remind_quote: i === 0 ? "11月20号" : null,
  }));
  const ORIGINAL = "物0在桌上,11月20号过期,还有物1物2物3物4也放桌上,以及物5";
  const { res } = await runV2(ORIGINAL, JSON.stringify({ items, has_more: true }));
  assert.equal(res.ok, true);
  assert.equal(res.truncated, true, "has_more 透传不受提醒增补影响");
  assert.equal(res.drafts.length, 5);
  assert.equal(res.drafts[0].remind_at, "2026-11-20");
  assert.equal(res.original_text, ORIGINAL);
});

test("v1 零变化:模型输出多带 remind 字段也被忽略,draft 形状与旧契约完全一致", async function () {
  const raw = JSON.stringify({
    name: "感冒药",
    location_text: "药箱",
    certain: true,
    qualifiers: [],
    needs_split: false,
    remind_at: "2026-11-20",
    remind_kind: "有效期",
    remind_quote: "11月20号",
  });
  const res = validateDraft(raw, "感冒药放药箱,11月20号到期。");
  assert.equal(res.ok, true);
  assert.deepStrictEqual(res.draft, { name: "感冒药", location_text: "药箱", certain: true, qualifiers: [] }, "v1 draft 不得出现 remind 字段");

  // handler 全链路:v1 prompt 不附【今天】、不谈提醒;响应 draft 无 remind 键。
  const calls = [];
  const res2 = await handler({ text: "感冒药放药箱,11月20号到期。" }, {
    logger() {},
    callLLM(prompt) {
      calls.push(prompt);
      return Promise.resolve(raw);
    },
  });
  assert.equal(res2.ok, true);
  assert.deepStrictEqual(res2.draft, { name: "感冒药", location_text: "药箱", certain: true, qualifiers: [] });
  assert.ok(!calls[0].includes("【今天】"), "v1 prompt 必须逐字节不变(不注入今天)");
  assert.ok(!calls[0].includes("remind"), "v1 prompt 不得出现提醒字段");
});

test("v2 今天注入:缺 deps.today 用真实日期,非法值兜底当前日期,prompt 恒有合法 YYYY-MM-DD", async function () {
  const reply = rawItems([{ name: "钥匙", location_text: "玄关", certain: true, qualifiers: [], source_quote: "钥匙在玄关" }]);
  const mk = (deps) => handler({ text: "钥匙在玄关", protocol: 2 }, Object.assign({ logger() {} }, deps, {
    callLLM(prompt) {
      calls.push(prompt);
      return Promise.resolve(reply);
    },
  }));
  let calls = [];
  await mk({});
  assert.ok(/【今天】\d{4}-\d{2}-\d{2}/.test(calls[0]), "缺省注入真实今天");
  calls = [];
  await mk({ today: () => "不是日期" });
  assert.ok(/【今天】\d{4}-\d{2}-\d{2}/.test(calls[0]), "非法 today 兜底为当前日期");
});

// ---------- PR #52 复审 B2:显式年份片段遮蔽(无年份二次匹配) ----------

test("B2 显式年份遮蔽:原话「2028年11月20号」+ 模型违规折报 2026-11-20 → 三项全 null 拦截", function () {
  const original = "滤芯在厨房,2028年11月20号要更换。";
  const result = validateDrafts(
    rawItems([
      {
        name: "滤芯",
        location_text: "厨房",
        certain: true,
        qualifiers: [],
        source_quote: "滤芯在厨房,2028年11月20号要更换",
        // 模型违规:把显式年份日期折报成无年份补全值(今天 2026-10-15 → 今年 11-20)
        remind_at: "2026-11-20",
        remind_kind: "下次维护",
        remind_quote: "2028年11月20号",
      },
    ]),
    original,
    ANCHOR_TODAY,
  );
  assert.equal(result.ok, true, "锚定失败绝不废件");
  // 反例核心:quote 确实是原话逐字子串(逐字锚定本可通过,负例才有效),
  // 但遮蔽后该段只产出 2028-11-20 一个候选,折报的 2026-11-20 必须被
  // 对应锚定拦下——三项全 null,物品照常提取
  assert.notEqual(
    original.replace(/\s+/g, "").indexOf("2028年11月20号"),
    -1,
    "前置自检:quote 是原话逐字子串(去空白比对)",
  );
  assert.equal(result.drafts[0].name, "滤芯");
  assert.equal(result.drafts[0].location_text, "厨房");
  assert.deepStrictEqual(
    remindTrio(result.drafts[0]),
    { remind_at: null, remind_kind: null, remind_quote: null },
    "显式年份片段不得再被无年份正则剥出补全成今年",
  );
});

test("B2 显式年份遮蔽:原话「2028年11月20号」+ 正确报 2028-11-20 → 三项保留通过", function () {
  const original = "滤芯在厨房,2028年11月20号要更换。";
  const result = validateDrafts(
    rawItems([
      {
        name: "滤芯",
        location_text: "厨房",
        certain: true,
        qualifiers: [],
        source_quote: "滤芯在厨房,2028年11月20号要更换",
        remind_at: "2028-11-20",
        remind_kind: "下次维护",
        remind_quote: "2028年11月20号",
      },
    ]),
    original,
    ANCHOR_TODAY,
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts[0].remind_at, "2028-11-20", "如实报显式年份日期:保留");
  assert.equal(result.drafts[0].remind_kind, "下次维护");
  assert.equal(result.drafts[0].remind_quote, "2028年11月20号");
});

test("B2 遮蔽不误伤:同 quote 里显式年份日期与独立无年份日期并存 → 各自产出候选,互不遮蔽", function () {
  const original = "会员卡2027年6月30号年检,另外11月20号前要交物业费。";
  const base = {
    name: "会员卡",
    location_text: "钱包",
    certain: true,
    qualifiers: [],
    source_quote: "会员卡2027年6月30号年检",
  };
  // 显式年份候选照常(遮蔽只作用于同段的无年份再匹配)
  const explicit = validateDrafts(
    rawItems([Object.assign({}, base, {
      remind_at: "2027-06-30",
      remind_kind: "下次维护",
      remind_quote: "2027年6月30号年检",
    })]),
    original,
    ANCHOR_TODAY,
  );
  assert.equal(explicit.drafts[0].remind_at, "2027-06-30");
  // 独立的无年份提法(不在任何显式年份片段内)仍按最近未来补全
  const noYear = validateDrafts(
    rawItems([Object.assign({}, base, {
      remind_at: "2026-11-20",
      remind_kind: "下次维护",
      remind_quote: "11月20号前要交物业费",
    })]),
    original,
    ANCHOR_TODAY,
  );
  assert.equal(noYear.drafts[0].remind_at, "2026-11-20", "独立无年份日期不受遮蔽影响");
  // 但显式年份片段内部的「6月30号」不再单独产出 2026-06-30/2027-06-30 之外的无年份候选:
  // 折报 2026-06-30(今天 2026-10-15 已过,无年份本应补 2027)必须拦下
  const folded = validateDrafts(
    rawItems([Object.assign({}, base, {
      remind_at: "2026-06-30",
      remind_kind: "下次维护",
      remind_quote: "2027年6月30号年检",
    })]),
    original,
    ANCHOR_TODAY,
  );
  assert.deepStrictEqual(
    remindTrio(folded.drafts[0]),
    { remind_at: null, remind_kind: null, remind_quote: null },
    "显式年份段内剥出的无年份折算值必须拦截",
  );
});

// ---------- PR #52 复审 B3:日期归属限定到物品(多件保守门) ----------

const B3_ORIGINAL = "滤芯在厨房,2027年11月20号要更换;钥匙在玄关。";

test("B3 负例:模型把滤芯的日期赋给钥匙(source_quote=钥匙在玄关)→ 钥匙三项全 null,滤芯照常带提醒", function () {
  const result = validateDrafts(
    rawItems([
      {
        name: "滤芯",
        location_text: "厨房",
        certain: true,
        qualifiers: [],
        source_quote: "滤芯在厨房,2027年11月20号要更换",
        remind_at: "2027-11-20",
        remind_kind: "下次维护",
        remind_quote: "2027年11月20号",
      },
      {
        name: "钥匙",
        location_text: "玄关",
        certain: true,
        qualifiers: [],
        source_quote: "钥匙在玄关",
        // 模型交叉配对:日期证据是整句原话的逐字子串、也真的说了这个日期,
        // 两道既有锚定门都过——但没有单件可验证的归属证据
        remind_at: "2027-11-20",
        remind_kind: "下次维护",
        remind_quote: "2027年11月20号要更换",
      },
    ]),
    B3_ORIGINAL,
    ANCHOR_TODAY,
  );
  assert.equal(result.ok, true, "归属判不明绝不废件");
  // 滤芯:日期落在自己的 source_quote 内,归属可验证 → 保留
  assert.equal(result.drafts[0].remind_at, "2027-11-20", "有专属日期归属证据的物品保留提醒");
  assert.equal(result.drafts[0].remind_quote, "2027年11月20号");
  // 钥匙:remind_quote 不在自己的 source_quote 内 → 三项全 null,物品照常提取
  assert.equal(result.drafts[1].name, "钥匙");
  assert.equal(result.drafts[1].location_text, "玄关");
  assert.deepStrictEqual(
    remindTrio(result.drafts[1]),
    { remind_at: null, remind_kind: null, remind_quote: null },
    "A 的日期赋给 B:归属不明不带提醒,由用户以后在详情页补",
  );
});

test("B3 正例:A 有专属日期、B 无日期 → A 保留提醒,B 三项本就 null,互不影响", function () {
  const result = validateDrafts(
    rawItems([
      {
        name: "滤芯",
        location_text: "厨房",
        certain: true,
        qualifiers: [],
        source_quote: "滤芯在厨房,2027年11月20号要更换",
        remind_at: "2027-11-20",
        remind_kind: "下次维护",
        remind_quote: "2027年11月20号",
      },
      {
        name: "钥匙",
        location_text: "玄关",
        certain: true,
        qualifiers: [],
        source_quote: "钥匙在玄关",
        remind_at: null,
        remind_kind: null,
        remind_quote: null,
      },
    ]),
    B3_ORIGINAL,
    ANCHOR_TODAY,
  );
  assert.equal(result.drafts[0].remind_at, "2027-11-20", "A 的专属日期照常保留");
  assert.equal(result.drafts[0].remind_kind, "下次维护");
  assert.deepStrictEqual(remindTrio(result.drafts[1]), { remind_at: null, remind_kind: null, remind_quote: null });
});

test("B3 共享锚/竞争:同一日期证据同时落在两件的 source_quote 内(整句共享)→ 两件都不自动填", function () {
  const shared = "感冒药放药箱第一格,维生素放第二格,都是2027年11月20号到期。";
  const result = validateDrafts(
    rawItems([
      {
        name: "感冒药",
        location_text: "药箱第一格",
        certain: true,
        qualifiers: [],
        source_quote: "感冒药放药箱第一格,维生素放第二格,都是2027年11月20号到期",
        remind_at: "2027-11-20",
        remind_kind: "有效期",
        remind_quote: "2027年11月20号",
      },
      {
        name: "维生素",
        location_text: "药箱第二格",
        certain: true,
        qualifiers: [],
        source_quote: "感冒药放药箱第一格,维生素放第二格,都是2027年11月20号到期",
        remind_at: "2027-11-20",
        remind_kind: "有效期",
        remind_quote: "2027年11月20号",
      },
    ]),
    shared,
    ANCHOR_TODAY,
  );
  // 日期证据同时是两件的共享锚(都在整句内):无法判明归谁,两件都不自动填,
  // 物品照常提取,由用户以后在详情页自己补
  assert.equal(result.drafts[0].name, "感冒药");
  assert.equal(result.drafts[1].name, "维生素");
  assert.deepStrictEqual(
    remindTrio(result.drafts[0]),
    { remind_at: null, remind_kind: null, remind_quote: null },
    "共享锚:归属不明不带提醒",
  );
  assert.deepStrictEqual(remindTrio(result.drafts[1]), { remind_at: null, remind_kind: null, remind_quote: null });
});

test("B3 单件不受影响:一件时日期证据在整句原话中即可(不可能属于别的物品)", function () {
  const result = validateDrafts(
    rawItems([
      {
        name: "感冒药",
        location_text: "药箱第一格",
        certain: true,
        qualifiers: [],
        source_quote: "感冒药放药箱第一格",
        remind_at: "2027-11-20",
        remind_kind: "有效期",
        remind_quote: "2027年11月20号",
      },
    ]),
    "感冒药放药箱第一格,2027年11月20号到期。",
    ANCHOR_TODAY,
  );
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].remind_at, "2027-11-20", "单件时归属门不启用(既有行为)");
});

// ---------- #36 0.6.0 真机反馈 Fix 4:remind_vague_quote(时间没换算透明化) ----------
// 这是透明化修复,不是换算:「半年后」绝不换算成任何日期,只把「说了时间但
// 没换算」的原话子串如实标出来,用户不再被静默丢弃。

var VAGUE_ORIGINAL = "净水器的备用滤芯放在厨房水槽下面的柜子里,半年后提醒我换。";

test("v2 vague 正例:原话有模糊时间、提醒三项 null → remind_vague_quote 逐字保留(不换算)", async function () {
  var { res } = await runV2(VAGUE_ORIGINAL, rawItems([
    {
      name: "净水器备用滤芯",
      location_text: "厨房水槽下面的柜子里",
      certain: true,
      qualifiers: [],
      source_quote: "净水器的备用滤芯放在厨房水槽下面的柜子里",
      remind_at: null,
      remind_kind: null,
      remind_quote: null,
      remind_vague_quote: "半年后",
    },
  ]));
  assert.equal(res.ok, true);
  assert.deepStrictEqual(remindTrio(res.drafts[0]), { remind_at: null, remind_kind: null, remind_quote: null }, "绝不换算成日期");
  assert.equal(res.drafts[0].remind_vague_quote, "半年后", "时间没换算的原话子串如实保留");
});

test("v2 vague 互斥:同件带明确日期(remind_at 三项)→ vague 一律 null", function () {
  var result = validateDrafts(
    rawItems([Object.assign({}, ANCHOR_BASE, {
      remind_at: "2026-11-20",
      remind_kind: "有效期",
      remind_quote: "11月20号",
      remind_vague_quote: "半年后", // 模型不该给:明确日期优先
    })]),
    ANCHOR_ORIGINAL,
    ANCHOR_TODAY,
  );
  assert.equal(result.drafts[0].remind_at, "2026-11-20", "明确日期照常保留");
  assert.equal(result.drafts[0].remind_vague_quote, null, "明确日期与 vague 互斥");
});

test("v2 vague 反例:无时间词(模型自觉不给)/子串校验失败/无时间词的子串 → 一律 null,不废件", function () {
  // 无时间词:模型自觉输出 null → 原样透传
  var none = validateDrafts(
    rawItems([{ name: "钥匙", location_text: "玄关", certain: true, qualifiers: [], source_quote: "钥匙在玄关", remind_vague_quote: null }]),
    "钥匙在玄关",
    ANCHOR_TODAY,
  );
  assert.equal(none.drafts[0].remind_vague_quote, null);
  assert.equal(none.drafts[0].name, "钥匙");

  // 子串校验失败:编了一个原话里没有的时间说法 → 置 null
  var fabricated = validateDrafts(
    rawItems([{ name: "钥匙", location_text: "玄关", certain: true, qualifiers: [], source_quote: "钥匙在玄关", remind_vague_quote: "三个月后" }]),
    "钥匙在玄关",
    ANCHOR_TODAY,
  );
  assert.equal(fabricated.drafts[0].remind_vague_quote, null, "非原话子串必须置 null");
  assert.equal(fabricated.drafts[0].name, "钥匙", "锚定失败不废件");

  // 是原话子串但没有时间词 → 不是时间表述,置 null
  var notTime = validateDrafts(
    rawItems([{ name: "钥匙", location_text: "玄关", certain: true, qualifiers: [], source_quote: "钥匙在玄关", remind_vague_quote: "玄关" }]),
    "钥匙在玄关",
    ANCHOR_TODAY,
  );
  assert.equal(notTime.drafts[0].remind_vague_quote, null, "无时间词的子串不算时间表述");

  // 非字符串 / 超长 → null
  var badType = validateDrafts(
    rawItems([{ name: "钥匙", location_text: "玄关", certain: true, qualifiers: [], source_quote: "钥匙在玄关", remind_vague_quote: 42 }]),
    "钥匙在玄关",
    ANCHOR_TODAY,
  );
  assert.equal(badType.drafts[0].remind_vague_quote, null);
  var tooLong = validateDrafts(
    rawItems([{ name: "钥匙", location_text: "玄关", certain: true, qualifiers: [], source_quote: "钥匙在玄关", remind_vague_quote: "半年后" + "的".repeat(200) }]),
    "钥匙在玄关",
    ANCHOR_TODAY,
  );
  assert.equal(tooLong.drafts[0].remind_vague_quote, null, "超长一律 null");
});

test("v2 vague 词形:下个月/快过期了/大概冬天/到2027年3月 等时间词形态都认(只是标记,不换算)", function () {
  var probes = [
    { text: "下个月要换净水器滤芯,滤芯在厨房抽屉里。", quote: "下个月" },
    { text: "洗洁精快过期了,放在水槽下面的柜子里。", quote: "快过期了" },
    { text: "猫粮大概冬天之前要买新的,放玄关柜子下层。", quote: "大概冬天" },
    { text: "扫地机器人的保修卡在书房文件盒第二层,保修到2027年3月。", quote: "到2027年3月" },
  ];
  for (var i = 0; i < probes.length; i++) {
    var p = probes[i];
    var result = validateDrafts(
      rawItems([{ name: "物品", location_text: "某处", certain: true, qualifiers: [], source_quote: p.text, remind_vague_quote: p.quote }]),
      p.text,
      ANCHOR_TODAY,
    );
    assert.equal(result.ok, true);
    assert.equal(result.drafts[0].remind_vague_quote, p.quote, "「" + p.quote + "」应保留");
    assert.equal(result.drafts[0].remind_at, null, "同时绝不换算成日期");
  }
});

test("v2 vague 纪律:prompt 新增透明标记规则,但第 7 条不猜日期纪律一字不改", async function () {
  var { prompt } = await runV2(VAGUE_ORIGINAL, rawItems([
    { name: "净水器备用滤芯", location_text: "厨房水槽下面的柜子里", certain: true, qualifiers: [], source_quote: "净水器的备用滤芯放在厨房水槽下面的柜子里", remind_at: null, remind_kind: null, remind_quote: null, remind_vague_quote: "半年后" },
  ]));
  // 新规则在册:只标记、绝不换算、与明确日期互斥
  assert.ok(prompt.indexOf("remind_vague_quote") !== -1, "prompt 应定义 remind_vague_quote");
  assert.ok(prompt.indexOf("只标记,绝不换算") !== -1, "必须写明只标记不换算");
  assert.ok(prompt.indexOf("没提到任何时间") !== -1, "没时间则 null");
  // 既有纪律原样在册(一字不改的反向验证:关键句逐字仍在;反例句逐字在册
  // 由既有「v2 prompt 纪律」测试覆盖,此处不重复)
  assert.ok(prompt.indexOf("一律 remind_at=null、remind_kind=null、remind_quote=null") !== -1);
  assert.ok(prompt.indexOf("禁止根据物品名称猜任何日期、保质期或周期") !== -1);
  // v1 零变化:v1 prompt 不出现 vague 字段
  var v1calls = [];
  await handler({ text: "钥匙在玄关" }, {
    logger() {},
    callLLM(p) { v1calls.push(p); return Promise.resolve(JSON.stringify({ name: "钥匙", location_text: "玄关", certain: true, qualifiers: [] })); },
  });
  assert.ok(v1calls[0].indexOf("remind_vague_quote") === -1, "v1 prompt 不得出现 vague 字段");
});

test("v2 vague 对抗:模型把模糊时间折算成日期 → 日期被硬门拦下;vague 按最终 remind_at 判定保留(透明化)", async function () {
  var { res } = await runV2(VAGUE_ORIGINAL, rawItems([
    {
      name: "净水器备用滤芯",
      location_text: "厨房水槽下面的柜子里",
      certain: true,
      qualifiers: [],
      source_quote: "净水器的备用滤芯放在厨房水槽下面的柜子里",
      remind_at: "2027-04-15", // 模型违规折算
      remind_kind: "下次维护",
      remind_quote: "半年后",
      remind_vague_quote: "半年后",
    },
  ]));
  assert.equal(res.ok, true, "不废件");
  assert.deepStrictEqual(remindTrio(res.drafts[0]), { remind_at: null, remind_kind: null, remind_quote: null }, "折算日期必须被拦下");
  // 互斥按最终 remind_at 判定:折算被拦后提醒三项为 null,原话确实说了时间——
  // vague 如实保留,用户看到「时间没换算:『半年后』」而不是静默丢弃
  assert.equal(res.drafts[0].remind_vague_quote, "半年后", "拦下折算后透明标记如实保留");
});

// ---------- 十七轮「放进」路径预览 mount_path(#18 红线语义升级) ----------
// 仅 certain=true 且位置分层明确时逐字投影;模糊/错序/编造/纯方位首段一律 null 不猜;
// v1 与 remind/vague 字段零回归。这是预览不是写入——建路径要等用户确认后
// 由 locations.ensureAndLink 落地(绝不静默建路径)。

test("v2 mount_path 正例:位置明确分层 → 路径逐字投影(主卧/柜子上);单层位置给单段数组", async function () {
  var { res } = await runV2("降压药放在主卧的柜子上。", rawItems([
    { name: "降压药", location_text: "主卧的柜子上", certain: true, qualifiers: [], source_quote: "降压药放在主卧的柜子上", mount_path: ["主卧", "柜子上"] },
  ]));
  assert.equal(res.ok, true);
  assert.deepStrictEqual(res.drafts[0].mount_path, ["主卧", "柜子上"], "明确分层的路径如实投影");

  var single = validateDrafts(
    rawItems([{ name: "钥匙", location_text: "玄关", certain: true, qualifiers: [], source_quote: "钥匙放玄关", mount_path: ["玄关"] }]),
    "钥匙放玄关",
    ANCHOR_TODAY,
  );
  assert.deepStrictEqual(single.drafts[0].mount_path, ["玄关"], "单层位置给单段数组(确认卡能明示「放进玄关」)");
});

test("v2 mount_path 正例:多件时逐件独立投影,一件模糊不带不影响另一件", function () {
  var result = validateDrafts(
    rawItems([
      { name: "感冒药", location_text: "药箱第一格", certain: true, qualifiers: [], source_quote: "感冒药放药箱第一格", mount_path: ["药箱", "第一格"] },
      { name: "充电线", location_text: "", certain: false, qualifiers: [], source_quote: "充电线不知道放哪了", mount_path: null },
    ]),
    "感冒药放药箱第一格,充电线不知道放哪了。",
    ANCHOR_TODAY,
  );
  assert.equal(result.ok, true);
  assert.deepStrictEqual(result.drafts[0].mount_path, ["药箱", "第一格"], "确定件照常带路径");
  assert.equal(result.drafts[1].mount_path, null, "不确定件一律 null(先进未归类)");
});

test("v2 mount_path 反例:certain=false 时模型违规给了路径 → 强制 null", function () {
  var result = validateDrafts(
    rawItems([
      { name: "充电线", location_text: "", certain: false, qualifiers: [], source_quote: "充电线好像在桌上", mount_path: ["桌子"] },
    ]),
    "充电线好像在桌上。",
    ANCHOR_TODAY,
  );
  assert.equal(result.ok, true);
  assert.equal(result.drafts[0].certain, false);
  assert.equal(result.drafts[0].mount_path, null, "certain=false 一律不挂路径(红线:先进未归类)");
});

test("v2 mount_path 反例:模糊说法不猜——「某个柜子」整段照 location_text 才可能通过,拆层必被锚定拦下", function () {
  // 模型对模糊位置自觉给 null:透传
  var honest = validateDrafts(
    rawItems([{ name: "扳手", location_text: "某个柜子里", certain: true, qualifiers: [], source_quote: "扳手在某个柜子里", mount_path: null }]),
    "扳手在某个柜子里。",
    ANCHOR_TODAY,
  );
  assert.equal(honest.drafts[0].mount_path, null, "模型不给 → null");
  assert.equal(honest.drafts[0].location_text, "某个柜子里", "位置本身照常保留");

  // 模型把模糊位置硬拆成编造层(「柜子」在、「里」也在,但「卧室」是编的)→ 锚定拦下
  var guessed = validateDrafts(
    rawItems([{ name: "扳手", location_text: "某个柜子里", certain: true, qualifiers: [], source_quote: "扳手在某个柜子里", mount_path: ["卧室", "柜子"] }]),
    "扳手在某个柜子里。",
    ANCHOR_TODAY,
  );
  assert.equal(guessed.drafts[0].mount_path, null, "段不在该件 location_text 内 → null 不猜");
  assert.equal(guessed.drafts[0].name, "扳手", "路径置 null 不废件");
});

test("v2 mount_path 反例:错序 / 编造 / 拼接段一律 null(有序不重叠锚定)", function () {
  // 错序:段都在位置文本里,但顺序与原文不一致
  var reversed = validateDrafts(
    rawItems([{ name: "降压药", location_text: "主卧的柜子上", certain: true, qualifiers: [], source_quote: "降压药放在主卧的柜子上", mount_path: ["柜子上", "主卧"] }]),
    "降压药放在主卧的柜子上。",
    ANCHOR_TODAY,
  );
  assert.equal(reversed.drafts[0].mount_path, null, "错序必须拦下(游标只前进)");

  // 拼接:把两段拼成一个不存在的名字
  var joined = validateDrafts(
    rawItems([{ name: "降压药", location_text: "主卧的柜子上", certain: true, qualifiers: [], source_quote: "降压药放在主卧的柜子上", mount_path: ["主卧", "柜子上", "主卧柜子上"] }]),
    "降压药放在主卧的柜子上。",
    ANCHOR_TODAY,
  );
  assert.equal(joined.drafts[0].mount_path, null, "拼接段锚定失败 → null");
});

test("v2 mount_path 反例:形状非法(非数组/空数组/超 6 段/非字符串段/空段/超 30 码点段)→ null 不废件", function () {
  var cases = [
    { label: "非数组", mount_path: "主卧" },
    { label: "空数组", mount_path: [] },
    { label: "超 6 段", mount_path: ["a", "b", "c", "d", "e", "f", "g"] },
    { label: "非字符串段", mount_path: ["主卧", 42] },
    { label: "空白段", mount_path: ["主卧", "   "] },
    { label: "超 30 码点段", mount_path: ["主卧", "柜".repeat(31)] },
  ];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    var result = validateDrafts(
      rawItems([{ name: "降压药", location_text: "主卧的柜子上", certain: true, qualifiers: [], source_quote: "降压药放在主卧的柜子上", mount_path: c.mount_path }]),
      "降压药放在主卧的柜子上。",
      ANCHOR_TODAY,
    );
    assert.equal(result.ok, true, c.label + ":不废件");
    assert.equal(result.drafts[0].mount_path, null, c.label + ":一律 null");
  }
});

test("v2 mount_path 方位词:非首段纯方位并入前段(既有分段逻辑);首段即纯方位 → 整体 null 不猜", function () {
  // 「书房书桌上面」:模型给出纯方位段「上面」→ 并入前段,路径为 书房/书桌
  var merged = validateDrafts(
    rawItems([{ name: "台灯", location_text: "书房书桌上面", certain: true, qualifiers: [], source_quote: "台灯在书房书桌上面", mount_path: ["书房", "书桌", "上面"] }]),
    "台灯在书房书桌上面。",
    ANCHOR_TODAY,
  );
  assert.deepStrictEqual(merged.drafts[0].mount_path, ["书房", "书桌"], "纯方位段不另立层级(方位词不单独成段)");

  // 首段即纯方位:方位词不能当房间/大区域 → 整体不猜
  var locativeRoot = validateDrafts(
    rawItems([{ name: "台灯", location_text: "上面一层", certain: true, qualifiers: [], source_quote: "台灯在上面一层", mount_path: ["上面", "一层"] }]),
    "台灯在上面一层。",
    ANCHOR_TODAY,
  );
  assert.equal(locativeRoot.drafts[0].mount_path, null, "首段纯方位 → null(拿不准不给路径)");
  assert.equal(locativeRoot.drafts[0].location_text, "上面一层", "位置原文照常保留");
});

test("v2 mount_path 零回归:与提醒三项/vague 并存互不影响;certain 降级时路径随位置一起清空", function () {
  // 同件带明确日期 + 路径:两组字段互不干扰
  var both = validateDrafts(
    rawItems([Object.assign({}, ANCHOR_BASE, {
      mount_path: ["药箱", "第一格"],
      remind_at: "2026-11-20",
      remind_kind: "有效期",
      remind_quote: "11月20号",
    })]),
    ANCHOR_ORIGINAL,
    ANCHOR_TODAY,
  );
  assert.equal(both.drafts[0].remind_at, "2026-11-20", "提醒三项照常");
  assert.deepStrictEqual(both.drafts[0].mount_path, ["药箱", "第一格"], "路径照常");

  // 位置锚定校验把该件降级(位置不在证据片段内)→ 位置清空,certain=false,路径一并 null
  var downgraded = validateDrafts(
    rawItems([
      { name: "钥匙", location_text: "火星", certain: true, qualifiers: [], source_quote: "钥匙放玄关", mount_path: ["火星"] },
    ]),
    "钥匙放玄关。",
    ANCHOR_TODAY,
  );
  assert.equal(downgraded.drafts[0].certain, false, "位置锚定失败按不肯定处理(既有契约)");
  assert.equal(downgraded.drafts[0].mount_path, null, "降级后路径一律 null");
});

test("v2 mount_path 零回归:v1 响应不带 mount_path(模型多给的字段被忽略)", async function () {
  var res = await handler({ text: "降压药放在主卧的柜子上" }, {
    logger() {},
    callLLM() {
      return Promise.resolve(JSON.stringify({
        name: "降压药",
        location_text: "主卧的柜子上",
        certain: true,
        qualifiers: [],
        mount_path: ["主卧", "柜子上"], // v1 模型多给:必须被忽略
      }));
    },
  });
  assert.equal(res.ok, true);
  assert.deepStrictEqual(
    res.draft,
    { name: "降压药", location_text: "主卧的柜子上", certain: true, qualifiers: [] },
    "v1 draft 形状零变化(不出现 mount_path)",
  );
});

test("v2 mount_path 纪律:prompt 定义该字段与「绝不猜测」规则;第 7 条不猜日期纪律原样在册", async function () {
  var { prompt } = await runV2("降压药放在主卧的柜子上。", rawItems([
    { name: "降压药", location_text: "主卧的柜子上", certain: true, qualifiers: [], source_quote: "降压药放在主卧的柜子上", mount_path: ["主卧", "柜子上"] },
  ]));
  assert.ok(prompt.indexOf("mount_path") !== -1, "prompt 应定义 mount_path");
  assert.ok(prompt.indexOf("绝不猜测、绝不编造层次") !== -1, "必须写明分层不猜");
  assert.ok(prompt.indexOf("certain 为 false 的物品 mount_path 必须为 null") !== -1, "必须写明不确定不给路径");
  assert.ok(prompt.indexOf("纯方位词不能单独成一层") !== -1, "必须写明方位词不单独成层");
  // 既有 v2 契约零变化(既有纪律句逐字在册)
  assert.ok(prompt.indexOf("一律 remind_at=null、remind_kind=null、remind_quote=null") !== -1, "第 7 条不猜日期纪律一字不改");
  assert.ok(prompt.indexOf("禁止改写或拼接原文") !== -1, "证据规则不得被挤掉");
});
