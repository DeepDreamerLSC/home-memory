"use strict";

/*
 * 拍照识物(#3)extractDraft.locationSplit(位置层级拆分,§1.6 真机 2026-10-17)
 * 离线测试(仿 tests/photo-draft-edit.test.js 模式)。只 require
 * cloudfunctions/extractDraft 下的 lib 与入口(stub wx-server-sdk),零外网。覆盖:
 * - 成功形状:无分隔符中文(「书房桌子右边抽屉」)→ 三段层级路径(engine=local,
 *   DeepSeek 零请求);单实体 → 单段整串;
 * - prompt 组装:【原文】标记 + 原文 + 逐字锚定/最多 6 段/单段整串指令;
 * - 服务端硬门(不信任模型):编造段(非原文逐字子串)/乱序/超 6 段/超 30 码点段
 *   → 整串单段兜底 {ok:true,path:[text],fallback:true},绝不带模型段上树;
 * - 输入校验:text 去空白 1-200 码点,非法 INVALID_INPUT(引擎未参与);
 * - 引擎链:local 抛错/空文本降级 DeepSeek、双失败 AI_UNAVAILABLE、坏 JSON 带
 *   错误重试一次仍走同一引擎(质量失败不降级)、未注入 local 只走 DeepSeek;
 * - 日志纪律:只记 {action,textLength,segCount,engine,error?},绝不记位置原文
 *   与拆分结果;
 * - index.js 胶水(stub wx-server-sdk 真加载):locationSplit 路由走本地引擎
 *   (LOCAL_LLM 三件套指向 127.0.0.1,DEEPSEEK key 缺失也不外呼)。
 */

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const Module = require("node:module");

const {
  locationSplit,
  buildLocationSplitPrompt,
  LOCATION_SPLIT_SYSTEM_PROMPT,
} = require("../cloudfunctions/extractDraft/lib/handler");

const ROOT = path.join(__dirname, "..");

const TEXT = "书房桌子右边抽屉";

// ---------- 公共工具 ----------

/* 双引擎脚本 mock:script 项为 Error 则抛错、为字符串则作为模型输出;记录 prompt。 */
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

async function runSplit(engines, event, logs) {
  return locationSplit(event || splitEvent(), {
    callLLM: engines ? engines.callLLM : undefined,
    callLocalLLM: engines ? engines.callLocalLLM : undefined,
    logger: (m) => {
      if (logs) logs.push(m);
    },
  });
}

function splitEvent(extra) {
  return Object.assign({ action: "locationSplit", text: TEXT }, extra);
}

// ---------- 成功形状 ----------

test("多段:无分隔符中文拆成从大到小层级(逐字锚定通过,engine=local,DeepSeek 零请求)", async () => {
  const e = makeEngines([JSON.stringify({ path: ["书房", "桌子", "右边抽屉"] })], [
    new Error("不应被调用"),
  ]);
  const res = await runSplit(e);
  assert.deepStrictEqual(res, {
    ok: true,
    engine: "local",
    path: ["书房", "桌子", "右边抽屉"],
    fallback: false,
  });
  assert.strictEqual(e.calls.local.length, 1);
  assert.strictEqual(e.calls.deepseek.length, 0);
});

test("单段:拆不出层级(单实体)→ 单段整串,fallback=false", async () => {
  const e = makeEngines([JSON.stringify({ path: ["玄关"] })], []);
  const res = await runSplit(e, splitEvent({ text: "玄关" }));
  assert.deepStrictEqual(res, {
    ok: true,
    engine: "local",
    path: ["玄关"],
    fallback: false,
  });
});

test("跳过连接字:段间允许跳过「的」/空白等连接字(段仍是逐字子串、按序)", async () => {
  const e = makeEngines([JSON.stringify({ path: ["主卧", "床头柜"] })], []);
  const res = await runSplit(e, splitEvent({ text: "主卧的床头柜" }));
  assert.deepStrictEqual(res.path, ["主卧", "床头柜"]);
  assert.strictEqual(res.fallback, false);
});

// ---------- prompt 组装 ----------

test("prompt 组装:【原文】标记 + 原文;系统提示含逐字锚定/最多 6 段/单段整串/只输出 JSON", async () => {
  const prompt = buildLocationSplitPrompt(TEXT, null);
  assert.ok(prompt.indexOf(LOCATION_SPLIT_SYSTEM_PROMPT) === 0, "系统提示在前");
  assert.ok(prompt.indexOf("【原文】") !== -1, "必须有【原文】标记");
  assert.ok(prompt.indexOf(TEXT) !== -1, "原文随提示词上送");
  assert.ok(prompt.indexOf("逐字取自原文") !== -1);
  assert.ok(prompt.indexOf("不得改写、缩写、编造") !== -1);
  assert.ok(prompt.indexOf("最多 6 段") !== -1);
  assert.ok(prompt.indexOf("单段整串") !== -1);
  assert.ok(prompt.indexOf('{"path":["…"]}') !== -1, "只输出一个 JSON 对象的形状示例");

  const e = makeEngines([JSON.stringify({ path: ["书房"] })], []);
  await runSplit(e);
  assert.strictEqual(e.calls.local[0], prompt, "handler 用同一拼装函数组 prompt");
});

// ---------- 段级硬门(不信任模型 → 整串单段兜底) ----------

test("硬门:编造段(非原文逐字子串)→ 整串单段兜底 fallback:true", async () => {
  const e = makeEngines([JSON.stringify({ path: ["书房", "书桌", "抽屉"] })], [
    new Error("不应被调用"),
  ]);
  const res = await runSplit(e);
  assert.deepStrictEqual(res, {
    ok: true,
    engine: "local",
    path: [TEXT],
    fallback: true,
  });
  assert.strictEqual(e.calls.local.length, 1, "段级硬门不过不重试(不是 JSON 问题)");
});

test("硬门:乱序(后段出现在前段之前)→ 单段兜底", async () => {
  const e = makeEngines([JSON.stringify({ path: ["抽屉", "桌子", "书房"] })], []);
  const res = await runSplit(e);
  assert.deepStrictEqual(res.path, [TEXT]);
  assert.strictEqual(res.fallback, true);
});

test("硬门:超 6 段 / 段超 30 码点 / 段非字符串 / 空段 → 单段兜底", async () => {
  const long31 = "长".repeat(31);
  const cases = [
    JSON.stringify({ path: ["一", "二", "三", "四", "五", "六", "七"] }), // 7 段
    JSON.stringify({ path: [long31] }), // 31 码点段
    JSON.stringify({ path: ["书房", 42] }), // 非字符串段
    JSON.stringify({ path: ["书房", "   "] }), // 空白段
    JSON.stringify({ path: [] }), // 0 段
  ];
  for (const reply of cases) {
    const e = makeEngines([reply], []);
    const res = await runSplit(e);
    assert.strictEqual(res.ok, true, "兜底不是失败:" + reply);
    assert.deepStrictEqual(res.path, [TEXT], "整串单段:" + reply);
    assert.strictEqual(res.fallback, true, "fallback 标记:" + reply);
  }
});

test("硬门:恰好 6 段、每段恰 30 码点 → 合法通过(fallback:false)", async () => {
  const seg30 = "字".repeat(30);
  const text = "一二三四五六";
  const e = makeEngines([JSON.stringify({ path: ["一", "二", "三", "四", "五", "六"] })], []);
  const res = await runSplit(e, splitEvent({ text }));
  assert.deepStrictEqual(res.path, ["一", "二", "三", "四", "五", "六"]);
  assert.strictEqual(res.fallback, false);

  const e2 = makeEngines([JSON.stringify({ path: [seg30] })], []);
  const res2 = await runSplit(e2, splitEvent({ text: seg30 }));
  assert.deepStrictEqual(res2.path, [seg30]);
  assert.strictEqual(res2.fallback, false);
});

// ---------- JSON 形状问题(可重试) ----------

test("坏 JSON:path 缺失/顶层非对象 → 带错误重试一次;重试 prompt 回传上次输出与错误", async () => {
  const e = makeEngines(
    ['{"segments":["书房"]}', JSON.stringify({ path: ["书房", "桌子", "右边抽屉"] })],
    [new Error("不应被调用")],
  );
  const res = await runSplit(e);
  assert.deepStrictEqual(res.path, ["书房", "桌子", "右边抽屉"]);
  assert.strictEqual(e.calls.local.length, 2, "恰好重试一次");
  assert.ok(e.calls.local[1].indexOf("【上次输出】") !== -1);
  assert.ok(e.calls.local[1].indexOf("【解析错误】") !== -1);
  assert.ok(e.calls.local[1].indexOf("path 字段缺失或不是数组") !== -1);
});

test("坏 JSON:两次仍坏 → AI_UNAVAILABLE(模型质量失败不降级,DeepSeek 零请求)", async () => {
  const e = makeEngines(["这不是 JSON", "还是不行"], [new Error("不应被调用")]);
  const res = await runSplit(e);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "AI_UNAVAILABLE");
  assert.strictEqual(res.engine, "local");
  assert.strictEqual(e.calls.local.length, 2);
  assert.strictEqual(e.calls.deepseek.length, 0);
});

// ---------- 输入校验(INVALID_INPUT,引擎未参与) ----------

test("输入校验:text 缺失/去空白为空/超 200 码点 → INVALID_INPUT", async () => {
  const cases = [
    { label: "text 缺失", event: { action: "locationSplit" } },
    { label: "text 非字符串", event: { action: "locationSplit", text: 42 } },
    { label: "text 去空白为空", event: splitEvent({ text: "   \n  " }) },
    { label: "text 超 200 码点", event: splitEvent({ text: "字".repeat(201) }) },
  ];
  for (const c of cases) {
    const logs = [];
    const res = await runSplit(null, c.event, logs);
    assert.strictEqual(res.ok, false, c.label);
    assert.strictEqual(res.error, "INVALID_INPUT", c.label);
    assert.strictEqual(res.message, "位置描述不合法", c.label);
    const last = logs[logs.length - 1];
    assert.strictEqual(last.error, "INVALID_INPUT", c.label + ":日志记错误码");
    assert.strictEqual(last.engine, null, c.label + ":引擎未参与");
  }
});

// ---------- 引擎链(local→DeepSeek 降级) ----------

test("引擎链:local 抛错 → 立即降级 DeepSeek,engine=deepseek", async () => {
  const e = makeEngines([new Error("TIMEOUT")], [JSON.stringify({ path: ["书房", "桌子"] })]);
  const res = await runSplit(e);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.engine, "deepseek");
  assert.deepStrictEqual(res.path, ["书房", "桌子"]);
  assert.strictEqual(e.calls.local.length, 1);
  assert.strictEqual(e.calls.deepseek.length, 1, "降级后 DeepSeek 恰好一次");
});

test("引擎链:local 空文本 → 视为引擎失败降级 DeepSeek(emptyOutputIsFailure 语义)", async () => {
  const e = makeEngines(["   "], [JSON.stringify({ path: [TEXT] })]);
  const res = await runSplit(e);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.engine, "deepseek");
  assert.deepStrictEqual(res.path, [TEXT]);
});

test("引擎链:双失败 → AI_UNAVAILABLE + manual_fallback,engine=deepseek", async () => {
  const e = makeEngines([new Error("HTTP_500")], [new Error("HTTP_500")]);
  const res = await runSplit(e);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "AI_UNAVAILABLE");
  assert.strictEqual(res.manual_fallback, true);
  assert.strictEqual(res.engine, "deepseek");
});

test("现状锁:未注入 callLocalLLM → 只走 DeepSeek 一次,engine=deepseek", async () => {
  const calls = [];
  const res = await locationSplit(splitEvent(), {
    callLLM: async (p) => {
      calls.push(p);
      return JSON.stringify({ path: ["书房", "桌子", "右边抽屉"] });
    },
    logger() {},
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.engine, "deepseek");
  assert.strictEqual(calls.length, 1);
});

// ---------- 日志纪律 ----------

test("日志纪律:只记 action/textLength/segCount/engine/error,不含位置原文与拆分结果", async () => {
  const logs = [];
  const ok = makeEngines([JSON.stringify({ path: ["书房", "桌子", "右边抽屉"] })], []);
  await runSplit(ok, null, logs);
  const fb = makeEngines([JSON.stringify({ path: ["编造的段"] })], []);
  await runSplit(fb, null, logs);
  const bad = makeEngines([new Error("HTTP_500")], [new Error("HTTP_500")]);
  await runSplit(bad, null, logs);
  const serialized = JSON.stringify(logs);
  assert.ok(serialized.indexOf(TEXT) === -1, "日志不得包含位置原文");
  assert.ok(serialized.indexOf("书房") === -1, "日志不得包含拆分结果段名");
  for (const entry of logs) {
    assert.strictEqual(entry.action, "locationSplit");
    assert.strictEqual(typeof entry.textLength, "number");
    for (const key of Object.keys(entry)) {
      assert.ok(
        ["action", "textLength", "segCount", "engine", "error"].includes(key),
        "日志出现越界字段:" + key
      );
    }
  }
  assert.strictEqual(logs[0].segCount, 3, "成功日志记段数");
  assert.strictEqual(logs[0].error, undefined);
  assert.strictEqual(logs[1].segCount, 1, "兜底日志记单段");
  assert.strictEqual(logs[logs.length - 1].error, "AI_UNAVAILABLE");
  assert.strictEqual(logs[logs.length - 1].segCount, 0);
});

// ---------- index.js 胶水(stub wx-server-sdk 真加载,零外网) ----------

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

const ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "LOCAL_LLM_BASE",
  "LOCAL_LLM_TOKEN",
  "LOCAL_LLM_MODEL",
  "LOCAL_LLM_TIMEOUT_MS",
  "VL_BASE",
  "VL_TOKEN",
  "VL_MODEL",
];

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

test("胶水:locationSplit 路由——本地引擎(127.0.0.1 stub)全链 ok,engine=local", async () => {
  const { server, port } = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        // 隐私断言:上送本地引擎的 prompt 只含提示词与原文,不含任何密钥类环境变量
        if (body.indexOf("draft-edit-glue-token") !== -1) {
          res.writeHead(500);
          res.end("{}");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ path: ["书房", "桌子", "右边抽屉"] }) } }],
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
  try {
    const entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "extractDraft", "index.js"), {
      init: function () {},
      getWXContext: function () {
        return {};
      },
      DYNAMIC_CURRENT_ENV: "env-dynamic",
    });
    await withEnv(
      {
        DEEPSEEK_API_KEY: undefined,
        LOCAL_LLM_BASE: "http://127.0.0.1:" + port + "/v1",
        LOCAL_LLM_TOKEN: "draft-edit-glue-token",
        LOCAL_LLM_MODEL: "/models/Qwen3.6-35B-A3B-4bit",
      },
      async () => {
        const res = await entry.main(splitEvent());
        assert.strictEqual(res.ok, true, JSON.stringify(res));
        assert.strictEqual(res.engine, "local");
        assert.deepStrictEqual(res.path, ["书房", "桌子", "右边抽屉"]);
        assert.strictEqual(res.fallback, false);
      }
    );
  } finally {
    server.close();
  }
});
