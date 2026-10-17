"use strict";

/*
 * 拍照识物(#3)extractDraft.vlRecognize + lib/vl.js 离线测试
 * (IMPLEMENTATION §1.1/§3.1/§4.1,仿 tests/extractDraft-local-llm.test.js 模式)。
 * 只 require cloudfunctions/extractDraft 下的 lib 与入口(stub wx-server-sdk),
 * 零外部依赖、零外网:vl 的 HTTP 集成用例走 127.0.0.1 本地服务扮演 VL 端点。
 * 覆盖:
 * - lib/vl.js:isVlConfigured 三件套、normalizeVlBox(0-1000 整数→0-1;
 *   越界/小数/NaN/Infinity/负数/像素值/退化框一律整框丢弃)、围栏剥离、
 *   请求契约(POST {base}/chat/completions、Bearer、自定义 UA、
 *   temperature 0.1 + max_tokens 2000 + 关思考的防退化参数、text+image_url
 *   双 content、无 response_format/thinking)、超时/HTTP 500/缺 content/空 content
 *   失败语义,错误只带错误码(不含 token/地址/base64);
 * - handler.vlRecognize:参数校验 INVALID_INPUT 各形态(image_base64 缺失/空/
 *   data: 前缀/含空白/非 base64 字符/解码 0 字节/超长度上界不解码直接拒、img_w/
 *   img_h/mode/region)、超 4,000,000 字符拒绝(callFunction 5MB 事件上限对齐,B5)、未注入 callVL(三件套缺任一)→
 *   vl_not_configured(engine unavailable 不抛错)、成功链(坐标归一/越界丢框
 *   物品保留/confidence 词表外 low/qty_note 截断/非法名丢弃/>10 件截断 truncated、
 *   客户端 base64 原样直传不二次编码)、坏 JSON 带错误重试一次(仍败 vl_bad_output,
 *   无降级引擎)、region 模式提示词(0-1×1000)、日志纪律(只记计数与错误码);
 * - 隐私红线(#65 V0.4 合同第五项边界):照片在用户最终确认保存之前绝不上传云端——
 *   识别只收本地压缩图的 image_base64,handler/胶水不读云存储(stub 的
 *   downloadFile 一旦被调用即抛错,作为红线回归守卫);
 * - index.js 胶水(stub wx-server-sdk 真加载):vlRecognize 路由、只注入 callVL;
 *   VL 未配置返回 vl_not_configured;与 DEEPSEEK/LOCAL_LLM 并存互不影响;
 *   config.json timeout 60。
 * 日志纪律:任何输出(日志条目、错误信息)绝不含 token 字符串与图片 base64。
 */

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const { vlRecognize } = require("../cloudfunctions/extractDraft/lib/handler");
const vl = require("../cloudfunctions/extractDraft/lib/vl");

const ROOT = path.join(__dirname, "..");

const IMG_W = 1024;
const IMG_H = 768;
const FAKE_JPEG = Buffer.from("fake-jpeg-bytes-for-offline-test-only");
/** 客户端本地压缩图的裸 base64(小程序 readFile encoding:"base64" 原样产物) */
const IMAGE_B64 = FAKE_JPEG.toString("base64");
const VL_TOKEN = "hm-vl-test-token-9f2c-do-not-log";
const VL_MODEL = "/Users/…/Qwen3-VL-8B-Instruct-4bit";
/** PR #67 B5:大小门=4,000,000 字符(callFunction 5MB 事件上限对齐;原 10MB 解码门已废除) */
const VL_MAX_CHARS = 4000000;

const GOOD_VL_REPLY = JSON.stringify({
  items: [
    { name: "黑色耳机", qty_note: "", confidence: "high", box: [281, 163, 394, 309] },
    { name: "黄色薯片罐", qty_note: "约2罐", confidence: "mid", box: [273, 389, 593, 507] },
  ],
});

// ---------- 公共工具 ----------

const ENV_KEYS = [
  "VL_BASE",
  "VL_TOKEN",
  "VL_MODEL",
  "VL_TIMEOUT_MS",
  "DEEPSEEK_API_KEY",
  "LOCAL_LLM_BASE",
  "LOCAL_LLM_TOKEN",
  "LOCAL_LLM_MODEL",
  "LOCAL_LLM_TIMEOUT_MS",
];

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

/* callVL 脚本 mock:项为 Error 则抛错、为字符串则作为模型输出;记录每次调用。
 * 红线守卫:deps 刻意带一个一旦被调用就抛错的 downloadFile——handler 不得再有任何
 * 读云存储的路径(识别只收本地压缩图 base64)。 */
function makeVlDeps(script, opts) {
  opts = opts || {};
  const calls = [];
  const logs = [];
  const deps = {
    downloadFile: async () => {
      throw new Error("红线:vlRecognize 不得读云存储(照片确认前不上传)");
    },
    logger: (m) => logs.push(m),
  };
  if (!opts.noCallVL) {
    deps.callVL = async (prompt, imageBase64) => {
      calls.push({ prompt, imageBase64 });
      const item = script[Math.min(calls.length - 1, script.length - 1)];
      if (item instanceof Error) throw item;
      return item;
    };
  }
  return { deps, calls, logs };
}

function vlEvent(extra) {
  return Object.assign({ action: "vlRecognize", image_base64: IMAGE_B64, img_w: IMG_W, img_h: IMG_H }, extra);
}

// ---------- lib/vl.js:isVlConfigured 与未配置语义 ----------

test("vl:isVlConfigured 三件套齐全才 true,任一缺失即 false;未配置调用拒绝 NOT_CONFIGURED", async () => {
  const full = {
    VL_BASE: "https://vl.example.cn/v1",
    VL_TOKEN: "t",
    VL_MODEL: "m",
  };
  await withEnv(full, async () => {
    assert.strictEqual(vl.isVlConfigured(), true, "三件套齐全应视为已配置");
  });
  for (const missing of ["VL_BASE", "VL_TOKEN", "VL_MODEL"]) {
    const env = Object.assign({}, full);
    env[missing] = undefined;
    await withEnv(env, async () => {
      assert.strictEqual(vl.isVlConfigured(), false, missing + " 缺失应视为未配置");
    });
  }
  await withEnv({}, async () => {
    assert.strictEqual(vl.isVlConfigured(), false, "全缺失应视为未配置");
    await assert.rejects(
      () => vl.callVlModel("提示词", "aGVsbG8="),
      (e) => e.message === "NOT_CONFIGURED"
    );
    await assert.rejects(
      () => vl.callVlModel("", "aGVsbG8="),
      (e) => e.message === "EMPTY_PROMPT"
    );
    await assert.rejects(
      () => vl.callVlModel("提示词", ""),
      (e) => e.message === "EMPTY_IMAGE"
    );
  });
  assert.strictEqual(vl.DEFAULT_TIMEOUT_MS, 30000, "默认超时应为 30000ms");
});

// ---------- lib/vl.js:normalizeVlBox(§3.1 坐标红线) ----------

test("vl:normalizeVlBox 0-1000 整数归一到 0-1(实测原型 real-1 坐标)", () => {
  assert.deepStrictEqual(vl.normalizeVlBox([230, 485, 379, 868]), {
    x1: 0.23,
    y1: 0.485,
    x2: 0.379,
    y2: 0.868,
  });
  assert.deepStrictEqual(vl.normalizeVlBox([0, 0, 1000, 1000]), {
    x1: 0,
    y1: 0,
    x2: 1,
    y2: 1,
  });
});

test("vl:normalizeVlBox 不可信框一律丢弃为 null(物品候选保留由调用方负责)", () => {
  const bad = [
    [-1, 100, 500, 400], // 负数
    [0, 0, 1200, 500], // 像素值(>1000)
    [273.5, 100, 500, 400], // 小数(模型自作主张换了量纲,绝不猜)
    [0.273, 0.389, 0.593, 0.507], // 0-1 小数(禁按值域猜量纲的核心场景)
    [NaN, 100, 500, 400],
    [Infinity, 100, 500, 400],
    [100, 100, 100, 400], // x2 === x1 退化框(面积 0)
    [300, 300, 200, 400], // x2 < x1
    [100, 400, 500, 300], // y2 < y1
    [100, 100, 500], // 缺项
    [100, 100, 500, 400, 600], // 多项
    "273,389,593,507", // 非数组
    null,
    undefined,
  ];
  for (const box of bad) {
    assert.strictEqual(vl.normalizeVlBox(box), null, "应整框丢弃:" + JSON.stringify(box));
  }
});

// ---------- lib/vl.js:围栏剥离 ----------

test("vl:stripResponseFence 剥围栏口径(裸文本/围栏/围栏无闭合/纯围栏碎片)", () => {
  assert.strictEqual(vl.stripResponseFence("  " + GOOD_VL_REPLY + "\n"), GOOD_VL_REPLY);
  assert.strictEqual(vl.stripResponseFence("```json\n{}\n```"), "{}");
  assert.strictEqual(vl.stripResponseFence("```\n{}\n```"), "{}");
  assert.strictEqual(vl.stripResponseFence("```json\n{"), "{", "无闭合围栏也剥掉开栏行");
  assert.strictEqual(vl.stripResponseFence("```"), "", "纯围栏碎片返回空串(按空内容失败处理)");
  assert.strictEqual(vl.stripResponseFence("   "), "");
});

// ---------- lib/vl.js:请求契约与围栏剥离(HTTP 集成,127.0.0.1 stub) ----------

test("vl:请求契约(路径/Bearer/自定义 UA/防退化参数/text+image_url 双 content)与围栏剥离", async () => {
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
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "```json\n" + GOOD_VL_REPLY + "\n```" } }],
        })
      );
    });
  });
  try {
    await withEnv(
      { VL_BASE: "http://127.0.0.1:" + port + "/v1", VL_TOKEN: VL_TOKEN, VL_MODEL: VL_MODEL },
      async () => {
        const out = await vl.callVlModel("识别提示词", FAKE_JPEG.toString("base64"), 2000);
        assert.strictEqual(out, GOOD_VL_REPLY, "围栏与首尾空白应剥离后返回裸 JSON 文本");
      }
    );
    assert.strictEqual(seen.method, "POST");
    assert.strictEqual(seen.url, "/v1/chat/completions", "应请求 {base}/chat/completions(base 含 /v1)");
    assert.strictEqual(seen.auth, "Bearer " + VL_TOKEN, "应携带 Bearer 鉴权");
    assert.ok(
      typeof seen.ua === "string" && seen.ua.length > 0 && seen.ua.indexOf("Node.js") === -1,
      "必须发自定义 User-Agent(Cloudflare 边缘会 403 默认 UA),实测值:" + seen.ua
    );
    assert.strictEqual(seen.body.model, VL_MODEL);
    assert.strictEqual(seen.body.temperature, 0.1);
    assert.strictEqual(seen.body.max_tokens, 2000);
    assert.deepStrictEqual(
      seen.body.chat_template_kwargs,
      { enable_thinking: false },
      "必须带 chat_template_kwargs 关思考(防退化参数)"
    );
    assert.ok(!("response_format" in seen.body), "VL 端不保证 response_format,绝不发送");
    assert.ok(!("thinking" in seen.body), "thinking 是 DeepSeek 专属参数,绝不发送");
    assert.ok(Array.isArray(seen.body.messages) && seen.body.messages.length === 1);
    const msg = seen.body.messages[0];
    assert.strictEqual(msg.role, "user");
    assert.ok(Array.isArray(msg.content) && msg.content.length === 2, "content 应为 text+image_url 数组");
    assert.strictEqual(msg.content[0].type, "text");
    assert.strictEqual(msg.content[0].text, "识别提示词");
    assert.strictEqual(msg.content[1].type, "image_url");
    assert.strictEqual(
      msg.content[1].image_url.url,
      "data:image/jpeg;base64," + FAKE_JPEG.toString("base64"),
      "图片应以 data URI 形式随消息上送"
    );
  } finally {
    server.close();
  }
});

test("vl:超时拒绝 TIMEOUT(VL_TIMEOUT_MS 生效;显式参数优先)", async () => {
  const { server, port } = await startStubServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: GOOD_VL_REPLY } }] }));
    }, 400);
  });
  try {
    await withEnv(
      {
        VL_BASE: "http://127.0.0.1:" + port + "/v1",
        VL_TOKEN: VL_TOKEN,
        VL_MODEL: VL_MODEL,
        VL_TIMEOUT_MS: "80",
      },
      async () => {
        await assert.rejects(() => vl.callVlModel("提示词", "aGVsbG8="), (e) => e.message === "TIMEOUT");
        await assert.rejects(() => vl.callVlModel("提示词", "aGVsbG8=", 100), (e) => e.message === "TIMEOUT");
      }
    );
  } finally {
    server.close();
  }
});

test("vl:HTTP 500 拒绝 HTTP_500;缺 content 拒绝 NO_CONTENT;空 content 拒绝 EMPTY_CONTENT;错误不带 token/地址/base64", async () => {
  const replyWith = (status, message) => (req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    const entry = { reasoning: "长篇思考……" };
    if (message !== undefined) entry.content = message;
    res.end(JSON.stringify({ choices: [{ message: entry }] }));
  };
  const cases = [
    { label: "HTTP 500", expected: "HTTP_500", serve: replyWith(500, GOOD_VL_REPLY) },
    { label: "content 缺失(思考占了 reasoning)", expected: "NO_CONTENT", serve: replyWith(200, undefined) },
    { label: "content 空串", expected: "EMPTY_CONTENT", serve: replyWith(200, "") },
    { label: "content 纯围栏碎片", expected: "EMPTY_CONTENT", serve: replyWith(200, "```") },
  ];
  const messages = [];
  for (const c of cases) {
    const { server, port } = await startStubServer(c.serve);
    try {
      await withEnv(
        { VL_BASE: "http://127.0.0.1:" + port + "/v1", VL_TOKEN: VL_TOKEN, VL_MODEL: VL_MODEL },
        async () => {
          await assert.rejects(
            () => vl.callVlModel("提示词", "aGVsbG8=", 2000),
            (e) => {
              messages.push(e.message);
              return e.message === c.expected;
            },
            c.label + " 应拒绝 " + c.expected
          );
        }
      );
    } finally {
      server.close();
    }
  }
  for (const m of messages) {
    assert.ok(m.indexOf(VL_TOKEN) === -1, "错误信息不得包含 token:" + m);
    assert.ok(m.indexOf("127.0.0.1") === -1, "错误信息不得包含服务地址:" + m);
  }
});

test("vl:网络层错误统一改写为 NETWORK_ERROR(不外泄 Node 原生错误详情)", async () => {
  await withEnv(
    { VL_BASE: "http://127.0.0.1:1/v1", VL_TOKEN: VL_TOKEN, VL_MODEL: VL_MODEL },
    async () => {
      await assert.rejects(
        () => vl.callVlModel("提示词", "aGVsbG8=", 300),
        (e) => e.message === "NETWORK_ERROR"
      );
    }
  );
});

// ---------- handler.vlRecognize:参数校验(INVALID_INPUT,引擎未参与) ----------

test("vlRecognize:照片参数校验——image_base64/img_w/img_h/mode/region 各非法形态一律 INVALID_INPUT", async () => {
  const cases = [
    { label: "image_base64 缺失", event: { action: "vlRecognize", img_w: IMG_W, img_h: IMG_H } },
    { label: "image_base64 空串", event: vlEvent({ image_base64: "" }) },
    { label: "image_base64 非字符串", event: vlEvent({ image_base64: FAKE_JPEG }) },
    { label: "image_base64 带 data: 前缀(契约是裸 base64)", event: vlEvent({ image_base64: "data:image/jpeg;base64," + IMAGE_B64 }) },
    { label: "image_base64 含换行/空白", event: vlEvent({ image_base64: IMAGE_B64.slice(0, 8) + "\n" + IMAGE_B64.slice(8) }) },
    { label: "image_base64 含非 base64 字符", event: vlEvent({ image_base64: IMAGE_B64.slice(0, 8) + "%" + IMAGE_B64.slice(8) }) },
    { label: "image_base64 仅填充符", event: vlEvent({ image_base64: "==" }) },
    { label: "image_base64 解码为 0 字节", event: vlEvent({ image_base64: "A" }) },
    { label: "img_w 缺失", event: { action: "vlRecognize", image_base64: IMAGE_B64, img_h: IMG_H } },
    { label: "img_w 为 0", event: vlEvent({ img_w: 0 }) },
    { label: "img_w 非整数", event: vlEvent({ img_w: 1024.5 }) },
    { label: "img_w 超 10000", event: vlEvent({ img_w: 10001 }) },
    { label: "img_h 为负", event: vlEvent({ img_h: -1 }) },
    { label: "mode 非法", event: vlEvent({ mode: "zoom" }) },
    { label: "region 模式缺 region", event: vlEvent({ mode: "region" }) },
    { label: "region 越界(>1)", event: vlEvent({ mode: "region", region: { x1: 0, y1: 0, x2: 1.2, y2: 0.9 } }) },
    { label: "region 退化(x2<=x1)", event: vlEvent({ mode: "region", region: { x1: 0.29, y1: 0.69, x2: 0.06, y2: 0.93 } }) },
    { label: "region 含 NaN", event: vlEvent({ mode: "region", region: { x1: 0.06, y1: NaN, x2: 0.29, y2: 0.93 } }) },
  ];
  for (const c of cases) {
    const t = makeVlDeps([GOOD_VL_REPLY]);
    const res = await vlRecognize(c.event, t.deps);
    assert.strictEqual(res.ok, false, c.label + " 应失败");
    assert.strictEqual(res.error, "INVALID_INPUT", c.label);
    assert.strictEqual(res.message, "照片参数不合法", c.label);
    assert.strictEqual(t.calls.length, 0, c.label + ":引擎未参与");
    assert.strictEqual(t.logs[t.logs.length - 1].error, "INVALID_INPUT", c.label + ":日志记错误码");
    assert.ok(!("image_base64" in t.logs[t.logs.length - 1]), c.label + ":日志不落 base64");
  }
});

// ---------- handler.vlRecognize:图片大小门与引擎可用性 ----------

test("vlRecognize:image_base64 超 4,000,000 字符 → INVALID_INPUT;恰 4,000,000 字符放行(callFunction 5MB 事件上限对齐,PR #67 B5)", async () => {
  const t = makeVlDeps([GOOD_VL_REPLY]);
  const res = await vlRecognize(vlEvent({ image_base64: "A".repeat(VL_MAX_CHARS + 1) }), t.deps);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "INVALID_INPUT");
  assert.strictEqual(res.message, "照片参数不合法");
  assert.strictEqual(t.calls.length, 0, "超限绝不送引擎");

  // 恰 4,000,000 字符(解码 ≈3MB,连同事件 JSON 外壳在 5MB 事件上限内)放行
  const okT = makeVlDeps([GOOD_VL_REPLY]);
  const okRes = await vlRecognize(vlEvent({ image_base64: "A".repeat(VL_MAX_CHARS) }), okT.deps);
  assert.strictEqual(okRes.ok, true, "恰 4,000,000 字符不应拒绝:" + JSON.stringify(okRes));
  assert.strictEqual(okT.calls.length, 1);

  // 边界外一格按字符门直接拒(原 10MB 解码门在 5MB 事件上限下形同虚设,已废除)
  const bigT = makeVlDeps([GOOD_VL_REPLY]);
  const bigRes = await vlRecognize(vlEvent({ image_base64: "A".repeat(VL_MAX_CHARS + 4) }), bigT.deps);
  assert.strictEqual(bigRes.ok, false);
  assert.strictEqual(bigRes.error, "INVALID_INPUT");
  assert.strictEqual(bigT.calls.length, 0);
});

test("vlRecognize:参数门先于引擎门——callVL 未注入时超限图片仍是 INVALID_INPUT(客户端 bug 不伪装成不可用)", async () => {
  const t = makeVlDeps([], { noCallVL: true });
  const res = await vlRecognize(vlEvent({ image_base64: "A".repeat(VL_MAX_CHARS + 1) }), t.deps);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "INVALID_INPUT");
});

test("vlRecognize:callVL 未注入(三件套缺任一)→ engine unavailable,不抛错", async () => {
  const t = makeVlDeps([], { noCallVL: true });
  const res = await vlRecognize(vlEvent(), t.deps);
  assert.deepStrictEqual(res, {
    ok: false,
    error: "AI_UNAVAILABLE",
    message: "拍照识别暂不可用,可手动添加",
    manual_fallback: true,
    reason: "vl_not_configured",
    engine: "vl-local",
  });
});

test("vlRecognize:引擎抛错 → AI_UNAVAILABLE vl_call_failed,恰一次调用(无重试、无降级引擎)", async () => {
  const t = makeVlDeps([new Error("TIMEOUT")]);
  const res = await vlRecognize(vlEvent(), t.deps);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "AI_UNAVAILABLE");
  assert.strictEqual(res.reason, "vl_call_failed");
  assert.strictEqual(res.manual_fallback, true);
  assert.strictEqual(res.engine, "vl-local");
  assert.strictEqual(t.calls.length, 1, "引擎层失败不进 JSON 重试");
});

// ---------- handler.vlRecognize:成功链与输出清洗 ----------

test("vlRecognize:成功——0-1000 框归一 0-1、img 回显、engine=vl-local、客户端 base64 原样直传(不二次编码)", async () => {
  const t = makeVlDeps([GOOD_VL_REPLY]);
  const res = await vlRecognize(vlEvent(), t.deps);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.engine, "vl-local");
  assert.strictEqual(res.img_w, IMG_W);
  assert.strictEqual(res.img_h, IMG_H);
  assert.strictEqual(res.truncated, undefined, "未超 10 件不带 truncated");
  assert.strictEqual(res.items.length, 2);
  assert.deepStrictEqual(res.items[0], {
    name: "黑色耳机",
    qty_note: "",
    confidence: "high",
    box: { x1: 0.281, y1: 0.163, x2: 0.394, y2: 0.309 },
  });
  assert.deepStrictEqual(res.items[1].box, { x1: 0.273, y1: 0.389, x2: 0.593, y2: 0.507 });
  assert.strictEqual(t.calls.length, 1);
  assert.strictEqual(t.calls[0].imageBase64, IMAGE_B64, "base64 应为 event.image_base64 原样,不读云存储、不二次编码");
  assert.ok(!("file_id" in res), "响应不回显任何云存储标识(确认前不存在 file_id)");
  assert.ok(t.calls[0].prompt.indexOf("四个 0-1000 的整数") !== -1, "提示词必须显式声明 0-1000 量纲");
  assert.ok(t.calls[0].prompt.indexOf("(0,0) 在左上角") !== -1);
  assert.ok(t.calls[0].prompt.indexOf("最多输出 10 件") !== -1, "提示词必须含件数上限");
});

test("vlRecognize:越界框整框丢弃(box=null)但物品候选保留;confidence 词表外 low;qty_note 超 40 截断;非法名件丢弃", async () => {
  const reply = JSON.stringify({
    items: [
      { name: "白色数据线", qty_note: "", confidence: "mid", box: [614, 521, 897, 879] },
      { name: "黑色小盒子", qty_note: "", confidence: "low", box: [868, 790, 1200, 873] }, // 像素越界 → 丢框
      { name: "黑色电源适配器", qty_note: "", confidence: "mid", box: [0.28, 0.16, 0.6, 0.42] }, // 0-1 小数 → 丢框
      { name: "旧遥控器", qty_note: "数".repeat(45), confidence: "sorta", box: [-5, 10, 100, 200] }, // 负数丢框;confidence 归 low;qty_note 截 40
      { name: "", qty_note: "", confidence: "high", box: [10, 10, 20, 20] }, // 空名 → 丢件
      { name: "   ", qty_note: "", confidence: "high", box: [10, 10, 20, 20] }, // 空白名 → 丢件
    ],
  });
  const t = makeVlDeps([reply]);
  const res = await vlRecognize(vlEvent(), t.deps);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.items.length, 4, "两件非法名被丢弃,其余保留");
  assert.deepStrictEqual(res.items[0].box, { x1: 0.614, y1: 0.521, x2: 0.897, y2: 0.879 });
  assert.strictEqual(res.items[1].name, "黑色小盒子");
  assert.strictEqual(res.items[1].box, null, "像素越界框丢弃,物品保留");
  assert.strictEqual(res.items[2].box, null, "0-1 小数框丢弃(绝不猜量纲)");
  assert.strictEqual(res.items[3].confidence, "low", "confidence 词表外按 low");
  assert.strictEqual(res.items[3].qty_note.length, 40, "qty_note 超 40 码点截断");
  assert.strictEqual(res.items[3].box, null, "负数框丢弃");
});

test("vlRecognize:超过 10 件只取前 10 并如实带 truncated:true", async () => {
  const items = [];
  for (let i = 0; i < 12; i++) {
    items.push({ name: "物品" + (i + 1), qty_note: "", confidence: "low", box: null });
  }
  const t = makeVlDeps([JSON.stringify({ items })]);
  const res = await vlRecognize(vlEvent(), t.deps);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.items.length, 10);
  assert.strictEqual(res.truncated, true);
  assert.strictEqual(res.items[9].name, "物品10");
});

test("vlRecognize:mode=region——提示词带圈选区域(0-1×1000 整数)与整图联合判定;full 模式不带", async () => {
  const t = makeVlDeps([GOOD_VL_REPLY]);
  await vlRecognize(
    vlEvent({ mode: "region", region: { x1: 0.06, y1: 0.69, x2: 0.29, y2: 0.93 } }),
    t.deps
  );
  assert.ok(t.calls[0].prompt.indexOf("x1=60,y1=690,x2=290,y2=930") !== -1, "0-1 圈选应 ×1000 写进提示词");
  assert.ok(t.calls[0].prompt.indexOf("请优先识别该区域内的物品,结合整张照片一起判断") !== -1);

  const full = makeVlDeps([GOOD_VL_REPLY]);
  await vlRecognize(vlEvent(), full.deps);
  assert.ok(full.calls[0].prompt.indexOf("用户圈出的区域") === -1, "full 模式不带圈选上下文");
});

// ---------- handler.vlRecognize:坏 JSON 重试 ----------

test("vlRecognize:坏 JSON 带错误重试一次,重试成功 → ok;重试 prompt 回传上次输出与解析错误", async () => {
  const t = makeVlDeps(["哎呀我看到了一抽屉东西~", GOOD_VL_REPLY]);
  const res = await vlRecognize(vlEvent(), t.deps);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(t.calls.length, 2, "恰两次调用");
  assert.ok(t.calls[1].prompt.indexOf("【上次输出】") !== -1);
  assert.ok(t.calls[1].prompt.indexOf("【解析错误】") !== -1);
  assert.ok(t.calls[1].prompt.indexOf("哎呀我看到了一抽屉东西") !== -1);
});

test("vlRecognize:两次坏 JSON → AI_UNAVAILABLE vl_bad_output(无降级引擎)", async () => {
  const t = makeVlDeps(["这不是 JSON", "还是不行 { 未闭合"]);
  const res = await vlRecognize(vlEvent(), t.deps);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "AI_UNAVAILABLE");
  assert.strictEqual(res.reason, "vl_bad_output");
  assert.strictEqual(res.engine, "vl-local");
  assert.strictEqual(res.manual_fallback, true);
  assert.strictEqual(t.calls.length, 2, "只重试一次");
});

// ---------- handler.vlRecognize:日志纪律 ----------

test("vlRecognize:日志只记 action/elapsedMs/engine/itemcount/error/reason,绝不落 base64/识别结果/prompt 原文", async () => {
  const t = makeVlDeps([GOOD_VL_REPLY]);
  await vlRecognize(vlEvent(), t.deps);
  const bad = makeVlDeps([], { noCallVL: true });
  await vlRecognize(vlEvent(), bad.deps);
  const entries = t.logs.concat(bad.logs);
  const serialized = JSON.stringify(entries);
  assert.ok(serialized.indexOf(FAKE_JPEG.toString("base64")) === -1, "日志不得包含 base64");
  assert.ok(serialized.indexOf("黑色耳机") === -1, "日志不得包含识别结果");
  assert.ok(serialized.indexOf("黄色薯片罐") === -1);
  assert.ok(serialized.indexOf("四个 0-1000 的整数") === -1, "日志不得包含 prompt 原文");
  for (const entry of entries) {
    assert.strictEqual(entry.action, "vlRecognize");
    assert.strictEqual(entry.engine, "vl-local");
    for (const key of Object.keys(entry)) {
      assert.ok(
        ["action", "elapsedMs", "engine", "itemcount", "error", "reason"].includes(key),
        "日志出现越界字段:" + key
      );
    }
  }
  assert.strictEqual(t.logs[t.logs.length - 1].itemcount, 2, "成功日志记识别件数");
  assert.strictEqual(bad.logs[bad.logs.length - 1].error, "AI_UNAVAILABLE");
  assert.strictEqual(bad.logs[bad.logs.length - 1].reason, "vl_not_configured");
});

// ---------- index.js 胶水(stub wx-server-sdk 真加载) ----------

/** 临时把 wx-server-sdk 替换为 stub 并(重新)加载云函数入口(tests/glue.test.js 手法) */
function loadCloudFunction(entryPath, stubSdk) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "wx-server-sdk") {
      return stubSdk;
    }
    return origLoad.apply(this, arguments);
  };
  for (const key of Object.keys(require.cache)) {
    if (key.indexOf(path.join(ROOT, "cloudfunctions")) === 0) {
      delete require.cache[key];
    }
  }
  try {
    return require(entryPath);
  } finally {
    Module._load = origLoad;
  }
}

/** stub wx-server-sdk:downloadFile 一旦被调用即记录并抛错(红线守卫:胶水层不得读云存储) */
function makeExtractDraftStub(downloads) {
  return {
    init: function () {},
    getWXContext: function () {
      return {};
    },
    DYNAMIC_CURRENT_ENV: "env-dynamic",
    downloadFile: function (options) {
      downloads.push(options && options.fileID);
      return Promise.reject(new Error("红线:vlRecognize 胶水不得读云存储(照片确认前不上传)"));
    },
  };
}

test("胶水:vlRecognize 路由——VL 三件套指向 127.0.0.1,image_base64 直达 VL 端点,云存储零触碰,全链 ok", async () => {
  const seen = {};
  const { server, port } = await startStubServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: GOOD_VL_REPLY } }] }));
    });
  });
  try {
    const downloads = [];
    const entry = loadCloudFunction(
      path.join(ROOT, "cloudfunctions", "extractDraft", "index.js"),
      makeExtractDraftStub(downloads)
    );
    await withEnv(
      {
        VL_BASE: "http://127.0.0.1:" + port + "/v1",
        VL_TOKEN: VL_TOKEN,
        VL_MODEL: VL_MODEL,
        DEEPSEEK_API_KEY: undefined,
        LOCAL_LLM_BASE: undefined,
        LOCAL_LLM_TOKEN: undefined,
        LOCAL_LLM_MODEL: undefined,
      },
      async () => {
        const res = await entry.main(vlEvent());
        assert.strictEqual(res.ok, true, JSON.stringify(res));
        assert.strictEqual(res.engine, "vl-local");
        assert.strictEqual(res.items.length, 2);
        assert.strictEqual(downloads.length, 0, "胶水层不得调用 cloud.downloadFile(确认前照片不在云端)");
        assert.strictEqual(
          seen.body.messages[0].content[1].image_url.url,
          "data:image/jpeg;base64," + IMAGE_B64,
          "HTTP 端应收到客户端直传的 base64(原样)"
        );

        // 旧式 file_id 事件(已删除的路径)不再被接受:无 image_base64 即 INVALID_INPUT,且不碰云存储
        const legacyFileId = await entry.main({
          action: "vlRecognize",
          file_id: "cloud://test-env.1234/photo-evidence/x.jpg",
          img_w: IMG_W,
          img_h: IMG_H,
        });
        assert.strictEqual(legacyFileId.ok, false);
        assert.strictEqual(legacyFileId.error, "INVALID_INPUT", "file_id 路径已删除,不留红线旁路");
        assert.strictEqual(downloads.length, 0);

        // VL 已配置不改变无 action 事件的现状:key 缺失仍是 missing_api_key(并存互不影响)
        const legacy = await entry.main({ text: "钥匙放玄关抽屉" });
        assert.strictEqual(legacy.ok, false);
        assert.strictEqual(legacy.error, "AI_UNAVAILABLE");
        assert.strictEqual(legacy.engine, "deepseek");
      }
    );
  } finally {
    server.close();
  }
});

test("胶水:VL 未配置(缺 VL_MODEL)→ vl_not_configured;与 DEEPSEEK/LOCAL_LLM 配置无关", async () => {
  const downloads = [];
  const entry = loadCloudFunction(
    path.join(ROOT, "cloudfunctions", "extractDraft", "index.js"),
    makeExtractDraftStub(downloads)
  );
  await withEnv(
    {
      VL_BASE: "http://127.0.0.1:9/v1",
      VL_TOKEN: "t",
      VL_MODEL: undefined,
      DEEPSEEK_API_KEY: undefined,
      LOCAL_LLM_BASE: undefined,
      LOCAL_LLM_TOKEN: undefined,
      LOCAL_LLM_MODEL: undefined,
    },
    async () => {
      const res = await entry.main(vlEvent());
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, "AI_UNAVAILABLE");
      assert.strictEqual(res.reason, "vl_not_configured");
      assert.strictEqual(res.manual_fallback, true);
      assert.strictEqual(res.engine, "vl-local");
    }
  );
});

test("配置:extractDraft config.json timeout 提到 60(VL 推理余量,客户端超时 70s)", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(ROOT, "cloudfunctions", "extractDraft", "config.json"), "utf8")
  );
  assert.strictEqual(config.timeout, 60);
});
