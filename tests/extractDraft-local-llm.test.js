"use strict";

/*
 * extractDraft 本地 LLM 主路 + DeepSeek 兜底(issue #36 本地 A3B)离线测试。
 * 只 require cloudfunctions/extractDraft 下的 lib,零外部依赖、零外网:
 * local-llm 的 HTTP 集成用例走 127.0.0.1 本地服务扮演 mlx_lm.server。
 * 覆盖:
 * - lib/local-llm.js:isConfigured 三件套、请求契约(POST {base}/chat/completions、
 *   Bearer 鉴权、自定义 User-Agent、单条 user 消息、temperature 0.1、max_tokens 2000、
 *   chat_template_kwargs 关思考、无 response_format/thinking)、围栏剥离、
 *   超时/HTTP 500/缺 content/空 content 的失败语义,错误只带错误码;
 * - lib/handler.js 主备:local 成功(围栏)engine=local、local 网络/空文本失败
 *   立即降级 DeepSeek engine=deepseek、双失败 AI_UNAVAILABLE、未注入 callLocalLLM
 *   只走 DeepSeek 一次(现状锁)、坏 JSON 重试一次仍走 local、v2 同口径、日志纪律。
 * 日志纪律:任何输出(日志条目、错误信息)绝不含 token 字符串。
 */

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const { handler } = require("../cloudfunctions/extractDraft/lib/handler");
const localLlm = require("../cloudfunctions/extractDraft/lib/local-llm");

const TEXT = "钥匙放在玄关第二个抽屉";
const GOOD_REPLY = JSON.stringify({
  name: "钥匙",
  location_text: "玄关第二个抽屉",
  certain: true,
  qualifiers: ["第二个"],
});
const FENCED_REPLY = "```json\n" + GOOD_REPLY + "\n```";
const LOCAL_TOKEN = "hm-local-test-token-7d3e-do-not-log";
const LOCAL_MODEL = "/Users/…/Qwen3.6-35B-A3B-4bit";

// ---------- 公共工具 ----------

const ENV_KEYS = ["LOCAL_LLM_BASE", "LOCAL_LLM_TOKEN", "LOCAL_LLM_MODEL", "LOCAL_LLM_TIMEOUT_MS"];

/* 临时注入环境变量(env 中值为 undefined 表示删除;未列出的 ENV_KEYS 一律清空)。 */
async function withEnv(env, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    if (!env || !Object.prototype.hasOwnProperty.call(env, k)) delete process.env[k];
  }
  if (env) {
    for (const k of Object.keys(env)) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  }
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function startStubServer(onRequest) {
  return new Promise((resolve) => {
    const server = http.createServer(onRequest);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/* 双引擎脚本 mock:script 项为 Error 则抛错、为字符串则作为模型输出;
 * 记录每个引擎收到的 prompt,便于断言请求次数与重试走向。 */
function makeEngines(localScript, deepseekScript) {
  const calls = { local: [], deepseek: [] };
  const step = (script, name) => async (prompt) => {
    calls[name].push(prompt);
    const item = script[Math.min(calls[name].length - 1, script.length - 1)];
    if (item instanceof Error) throw item;
    return item;
  };
  return {
    calls,
    callLLM: step(deepseekScript, "deepseek"),
    callLocalLLM: step(localScript, "local"),
  };
}

async function runHandler(engines, event) {
  return handler(event || { text: TEXT }, {
    callLLM: engines.callLLM,
    callLocalLLM: engines.callLocalLLM,
    logger() {},
  });
}

// ---------- local-llm:isConfigured 与未配置语义 ----------

test("local-llm:isConfigured 三件套齐全才 true,任一缺失即 false;未配置调用拒绝 NOT_CONFIGURED", async () => {
  const full = {
    LOCAL_LLM_BASE: "https://llm.example.cn/v1",
    LOCAL_LLM_TOKEN: "t",
    LOCAL_LLM_MODEL: "m",
  };
  await withEnv(full, async () => {
    assert.strictEqual(localLlm.isConfigured(), true, "三件套齐全应视为已配置");
  });
  for (const missing of ["LOCAL_LLM_BASE", "LOCAL_LLM_TOKEN", "LOCAL_LLM_MODEL"]) {
    const env = Object.assign({}, full);
    env[missing] = undefined;
    await withEnv(env, async () => {
      assert.strictEqual(localLlm.isConfigured(), false, missing + " 缺失应视为未配置");
    });
  }
  await withEnv({}, async () => {
    assert.strictEqual(localLlm.isConfigured(), false, "全缺失应视为未配置");
    await assert.rejects(
      () => localLlm.callLocalLLM("提示词"),
      (e) => e.message === "NOT_CONFIGURED",
    );
    await assert.rejects(
      () => localLlm.callLocalLLM(""),
      (e) => e.message === "EMPTY_PROMPT",
    );
  });
  assert.strictEqual(localLlm.DEFAULT_TIMEOUT_MS, 15000, "默认超时应为 15000ms");
});

// ---------- local-llm:请求契约与围栏剥离 ----------

test("local-llm:请求契约(路径/Bearer/自定义 UA/关思考/无 response_format)与围栏剥离", async () => {
  const seen = {};
  const { server, port } = await startStubServer((req, res) => {
    seen.method = req.method;
    seen.url = req.url;
    seen.auth = req.headers.authorization;
    seen.ua = req.headers["user-agent"];
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      // mlx 无 json_object 保证:内容可能包 markdown 围栏(评测 runner 同款口径)。
      res.end(JSON.stringify({ choices: [{ message: { content: "  " + FENCED_REPLY + "\n" } }] }));
    });
  });
  try {
    await withEnv(
      { LOCAL_LLM_BASE: "http://127.0.0.1:" + port + "/v1", LOCAL_LLM_TOKEN: LOCAL_TOKEN, LOCAL_LLM_MODEL: LOCAL_MODEL },
      async () => {
        const out = await localLlm.callLocalLLM("提示词内容(测试)", 2000);
        assert.strictEqual(out, GOOD_REPLY, "围栏与首尾空白应剥离后返回裸 JSON 文本");
      },
    );
    assert.strictEqual(seen.method, "POST");
    assert.strictEqual(seen.url, "/v1/chat/completions", "应请求 {base}/chat/completions(base 含 /v1)");
    assert.strictEqual(seen.auth, "Bearer " + LOCAL_TOKEN, "应携带 Caddy 层 Bearer 鉴权");
    assert.ok(
      typeof seen.ua === "string" && seen.ua.length > 0 && seen.ua.indexOf("Node.js") === -1,
      "必须发自定义 User-Agent(Cloudflare 边缘会 403 默认 UA),实测值:" + seen.ua,
    );
    assert.strictEqual(seen.body.model, LOCAL_MODEL);
    assert.strictEqual(seen.body.temperature, 0.1);
    assert.strictEqual(seen.body.max_tokens, 2000);
    assert.deepStrictEqual(
      seen.body.chat_template_kwargs,
      { enable_thinking: false },
      "必须带 chat_template_kwargs 关思考(实测:不带时默认最高档思考,content 为空)",
    );
    assert.ok(!("response_format" in seen.body), "mlx 不支持 response_format,绝不发送");
    assert.ok(!("thinking" in seen.body), "thinking 是 DeepSeek 专属参数,绝不发送");
    assert.deepStrictEqual(
      seen.body.messages,
      [{ role: "user", content: "提示词内容(测试)" }],
      "消息组装与 deepseek 同款:单条 user",
    );
  } finally {
    server.close();
  }
});

test("local-llm:stripResponseFence 剥围栏口径(裸文本/围栏/围栏无闭合/纯围栏碎片)", () => {
  assert.strictEqual(localLlm.stripResponseFence("  " + GOOD_REPLY + "\n"), GOOD_REPLY);
  assert.strictEqual(localLlm.stripResponseFence("```json\n{}\n```"), "{}");
  assert.strictEqual(localLlm.stripResponseFence("```\n{}\n```"), "{}");
  assert.strictEqual(localLlm.stripResponseFence("```json\n{"), "{", "无闭合围栏也剥掉开栏行");
  assert.strictEqual(localLlm.stripResponseFence("```"), "", "纯围栏碎片返回空串(按空内容失败处理)");
  assert.strictEqual(localLlm.stripResponseFence("   "), "");
});

// ---------- local-llm:失败语义与日志纪律 ----------

test("local-llm:超时拒绝 TIMEOUT(LOCAL_LLM_TIMEOUT_MS 生效;显式参数优先)", async () => {
  const { server, port } = await startStubServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: GOOD_REPLY } }] }));
    }, 400);
  });
  try {
    await withEnv(
      { LOCAL_LLM_BASE: "http://127.0.0.1:" + port + "/v1", LOCAL_LLM_TOKEN: LOCAL_TOKEN, LOCAL_LLM_MODEL: LOCAL_MODEL, LOCAL_LLM_TIMEOUT_MS: "80" },
      async () => {
        await assert.rejects(
          () => localLlm.callLocalLLM("提示词"),
          (e) => e.message === "TIMEOUT",
        );
        await assert.rejects(
          () => localLlm.callLocalLLM("提示词", 100),
          (e) => e.message === "TIMEOUT",
        );
      },
    );
  } finally {
    server.close();
  }
});

test("local-llm:HTTP 500 拒绝 HTTP_500;缺 content 拒绝 NO_CONTENT;空 content 拒绝 EMPTY_CONTENT", async () => {
  const replyWith = (status, message) => (req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    // 思考档误开时的实测形态:思考进独立 reasoning 字段,content 缺失/为空。
    const entry = { reasoning: "长篇思考……" };
    if (message !== undefined) entry.content = message;
    res.end(JSON.stringify({ choices: [{ message: entry }] }));
  };
  const cases = [
    { label: "HTTP 500", expected: "HTTP_500", serve: replyWith(500, GOOD_REPLY) },
    { label: "content 缺失(思考占了 reasoning)", expected: "NO_CONTENT", serve: replyWith(200, undefined) },
    { label: "content 空串", expected: "EMPTY_CONTENT", serve: replyWith(200, "") },
    { label: "content 纯围栏碎片", expected: "EMPTY_CONTENT", serve: replyWith(200, "```") },
  ];
  const messages = [];
  for (const c of cases) {
    const { server, port } = await startStubServer(c.serve);
    try {
      await withEnv(
        { LOCAL_LLM_BASE: "http://127.0.0.1:" + port + "/v1", LOCAL_LLM_TOKEN: LOCAL_TOKEN, LOCAL_LLM_MODEL: LOCAL_MODEL },
        async () => {
          await assert.rejects(
            () => localLlm.callLocalLLM("提示词", 2000),
            (e) => {
              messages.push(e.message);
              return e.message === c.expected;
            },
            c.label + " 应拒绝 " + c.expected,
          );
        },
      );
    } finally {
      server.close();
    }
  }
  // 日志纪律:任何错误输出(错误信息)绝不携带 token、地址与 prompt 原文。
  for (const m of messages) {
    assert.ok(m.indexOf(LOCAL_TOKEN) === -1, "错误信息不得包含 token:" + m);
    assert.ok(m.indexOf("127.0.0.1") === -1, "错误信息不得包含服务地址:" + m);
    assert.ok(m.indexOf("提示词") === -1, "错误信息不得包含 prompt 原文:" + m);
  }
});

test("local-llm:网络层错误统一改写为 NETWORK_ERROR(不外泄 Node 原生错误详情)", async () => {
  await withEnv(
    { LOCAL_LLM_BASE: "http://127.0.0.1:1/v1", LOCAL_LLM_TOKEN: LOCAL_TOKEN, LOCAL_LLM_MODEL: LOCAL_MODEL },
    async () => {
      await assert.rejects(
        () => localLlm.callLocalLLM("提示词", 300),
        (e) => e.message === "NETWORK_ERROR",
      );
    },
  );
});

// ---------- handler:本地主路成功 ----------

test("主备:local 成功(输出包围栏)→ engine=local,DeepSeek 零请求", async () => {
  const e = makeEngines([FENCED_REPLY], [new Error("不应被调用")]);
  const res = await runHandler(e);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.engine, "local");
  assert.deepStrictEqual(res.draft, { name: "钥匙", location_text: "玄关第二个抽屉", certain: true, qualifiers: ["第二个"] });
  assert.strictEqual(e.calls.local.length, 1, "local 只调一次");
  assert.strictEqual(e.calls.deepseek.length, 0, "local 成功时绝不打扰 DeepSeek");
  assert.ok(e.calls.local[0].includes(TEXT), "local 收到与 deepseek 同款组装的完整 prompt");
});

test("主备:v2 协议同样 local 主路成功,engine=local 透传", async () => {
  const reply = JSON.stringify({
    items: [
      { name: "钥匙", location_text: "玄关抽屉", certain: true, qualifiers: [], source_quote: "钥匙放玄关抽屉" },
      { name: "充电宝", location_text: "客厅电视柜", certain: true, qualifiers: [], source_quote: "充电宝放客厅电视柜" },
    ],
  });
  const e = makeEngines(["```json\n" + reply + "\n```"], [new Error("不应被调用")]);
  const res = await runHandler(e, { text: "钥匙放玄关抽屉,充电宝放客厅电视柜", protocol: 2 });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.drafts.length, 2);
  assert.strictEqual(res.engine, "local");
  assert.strictEqual(e.calls.deepseek.length, 0);
});

// ---------- handler:local 失败降级 ----------

test("主备:local 超时 → 立即降级 DeepSeek,engine=deepseek", async () => {
  const e = makeEngines([new Error("TIMEOUT")], [GOOD_REPLY]);
  const res = await runHandler(e);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.engine, "deepseek");
  assert.deepStrictEqual(res.draft.name, "钥匙");
  assert.strictEqual(e.calls.local.length, 1);
  assert.strictEqual(e.calls.deepseek.length, 1, "降级后 DeepSeek 恰好一次");
});

test("主备:local HTTP_500 → 降级 DeepSeek,engine=deepseek", async () => {
  const e = makeEngines([new Error("HTTP_500")], [GOOD_REPLY]);
  const res = await runHandler(e);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.engine, "deepseek");
  assert.strictEqual(e.calls.deepseek.length, 1);
});

test("主备:local 空文本/纯空白 → 视为引擎失败降级 DeepSeek,engine=deepseek", async () => {
  for (const empty of ["", "   \n  "]) {
    const e = makeEngines([empty], [GOOD_REPLY]);
    const res = await runHandler(e);
    assert.strictEqual(res.ok, true, "空输出:" + JSON.stringify(empty));
    assert.strictEqual(res.engine, "deepseek", "空输出必须降级:" + JSON.stringify(empty));
    assert.strictEqual(e.calls.local.length, 1, "空输出不进重试,local 只调一次");
    assert.strictEqual(e.calls.deepseek.length, 1);
  }
});

test("主备:双失败(local 超时 + DeepSeek HTTP_500)→ AI_UNAVAILABLE + manual_fallback,engine=deepseek", async () => {
  const e = makeEngines([new Error("TIMEOUT")], [new Error("HTTP_500")]);
  const res = await runHandler(e);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "AI_UNAVAILABLE");
  assert.strictEqual(res.manual_fallback, true);
  assert.strictEqual(res.engine, "deepseek");
  assert.strictEqual(e.calls.local.length, 1);
  assert.strictEqual(e.calls.deepseek.length, 1);
});

test("主备:DeepSeek 降级后走完整既有链路(坏 JSON 带错误重试一次仍失败 → AI_UNAVAILABLE)", async () => {
  const e = makeEngines([new Error("NETWORK_ERROR")], ["这不是 JSON", "还是不行 { 未闭合"]);
  const res = await runHandler(e);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "AI_UNAVAILABLE");
  assert.strictEqual(e.calls.deepseek.length, 2, "DeepSeek 侧照旧:初次 + 重试一次");
  assert.ok(e.calls.deepseek[1].includes("【上次输出】"), "重试 prompt 应回传上次输出");
  assert.ok(e.calls.deepseek[1].includes("【解析错误】"), "重试 prompt 应带解析错误");
});

// ---------- handler:重试仍走本地(模型质量失败不降级) ----------

test("主备:local 坏 JSON → 带错误重试一次仍走 local,重试成功 engine=local", async () => {
  const e = makeEngines(["哎呀,我不太明白你的意思呢~", GOOD_REPLY], [new Error("不应被调用")]);
  const res = await runHandler(e);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.engine, "local");
  assert.deepStrictEqual(res.draft.name, "钥匙");
  assert.strictEqual(e.calls.local.length, 2, "prompt 级重试照旧:恰好两次");
  assert.strictEqual(e.calls.deepseek.length, 0, "重试绝不换引擎");
  assert.ok(e.calls.local[1].includes("【上次输出】"), "重试 prompt 应回传上次输出");
  assert.ok(e.calls.local[1].includes("【解析错误】"), "重试 prompt 应带解析错误");
});

test("主备:local 两次坏 JSON → AI_UNAVAILABLE,engine=local(重试仍 local,不降级)", async () => {
  const e = makeEngines(["这不是 JSON", "还是不行 { 未闭合"], [new Error("不应被调用")]);
  const res = await runHandler(e);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "AI_UNAVAILABLE");
  assert.strictEqual(res.manual_fallback, true);
  assert.strictEqual(res.engine, "local");
  assert.strictEqual(e.calls.local.length, 2, "只重试一次,不再三连调");
  assert.strictEqual(e.calls.deepseek.length, 0, "模型质量失败(非引擎失败)不触发降级");
});

// ---------- handler:未注入 callLocalLLM 的现状锁 ----------

test("现状锁:未注入 callLocalLLM → 只走 DeepSeek 一次,engine=deepseek", async () => {
  const calls = [];
  const res = await handler({ text: TEXT }, {
    callLLM: async (p) => {
      calls.push(p);
      return GOOD_REPLY;
    },
    logger() {},
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.engine, "deepseek");
  assert.deepStrictEqual(res.draft, { name: "钥匙", location_text: "玄关第二个抽屉", certain: true, qualifiers: ["第二个"] });
  assert.strictEqual(calls.length, 1, "现状锁:恰好一次请求");

  // 各响应形态均带 engine;INVALID_INPUT 不带(LLM 未参与,与现状逐字节一致)。
  const split = await handler({ text: TEXT }, {
    callLLM: async () => JSON.stringify({ needs_split: true }),
    logger() {},
  });
  assert.strictEqual(split.needs_split, true);
  assert.strictEqual(split.engine, "deepseek");
  const bad = await handler({ text: TEXT }, {
    callLLM: async () => {
      throw new Error("HTTP_503");
    },
    logger() {},
  });
  assert.strictEqual(bad.error, "AI_UNAVAILABLE");
  assert.strictEqual(bad.engine, "deepseek");
  const invalid = await handler({ text: "" }, {
    callLLM: async () => GOOD_REPLY,
    logger() {},
  });
  assert.strictEqual(invalid.error, "INVALID_INPUT");
  assert.strictEqual(invalid.engine, undefined, "INVALID_INPUT 在引擎决策之前,不带 engine");
});

// ---------- handler:日志纪律(engine 计数,绝不含 token/原文) ----------

test("日志纪律:主备日志只记长度/耗时/错误码/engine/降级布尔,不含 token 与原文", async () => {
  const logs = [];
  const e = makeEngines([new Error("HTTP_502")], [GOOD_REPLY]);
  await handler({ text: TEXT }, {
    callLLM: e.callLLM,
    callLocalLLM: e.callLocalLLM,
    logger: (m) => logs.push(m),
  });
  const serialized = JSON.stringify(logs);
  assert.ok(serialized.indexOf(TEXT) === -1, "日志不得包含原文");
  assert.ok(serialized.indexOf("钥匙") === -1, "日志不得包含物品名");
  assert.ok(serialized.indexOf(LOCAL_TOKEN) === -1, "日志不得包含 token");
  const last = logs[logs.length - 1];
  assert.strictEqual(last.engine, "deepseek", "降级场景终局 engine=deepseek(可按 engine 计数)");
  assert.strictEqual(last.localFallback, true, "降级场景应带布尔标记");
  for (const entry of logs) {
    for (const key of Object.keys(entry)) {
      assert.ok(
        ["textLength", "elapsedMs", "error", "engine", "localFallback"].includes(key),
        "日志出现越界字段:" + key,
      );
    }
  }

  const logs2 = [];
  await handler({ text: TEXT }, {
    callLLM: e.callLLM,
    callLocalLLM: async () => FENCED_REPLY,
    logger: (m) => logs2.push(m),
  });
  assert.strictEqual(logs2[logs2.length - 1].engine, "local");
  assert.strictEqual(logs2[logs2.length - 1].localFallback, undefined, "未降级不带标记");

  const logs3 = [];
  await handler({ text: "" }, {
    callLLM: e.callLLM,
    callLocalLLM: e.callLocalLLM,
    logger: (m) => logs3.push(m),
  });
  assert.strictEqual(logs3[logs3.length - 1].error, "INVALID_INPUT");
  assert.strictEqual(logs3[logs3.length - 1].engine, undefined, "INVALID_INPUT 日志与现状一致");
});
