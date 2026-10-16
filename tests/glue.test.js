"use strict";

/*
 * 胶水层测试(glue):用 stub 的 wx-server-sdk 真实加载两个云函数的 index.js,
 * 验证 require 链正确、exports.main 可调用、身份派生与 key 缺失回退。
 *
 * 背景:itemsApi/index.js 曾把 require("./lib/handler") 的模块对象当函数调用,
 * 离线的 handler 纯函数测试覆盖不到这一层,部署到真实环境才暴露
 * 「TypeError: handler is not a function」。本文件把这一层纳入离线回归。
 * 全程零外网:extractDraft 侧通过不设置 DEEPSEEK_API_KEY 走 key 缺失分支;
 * 本地主路场景用 127.0.0.1 的 node:http stub 扮演 mlx_lm.server。
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { createMemoryDb } = require("./helpers/memoryDb");

const ROOT = path.join(__dirname, "..");

/** 临时把 wx-server-sdk 替换为 stub 并(重新)加载某个云函数入口 */
function loadCloudFunction(entryPath, stubSdk) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "wx-server-sdk") return stubSdk;
    return origLoad.apply(this, arguments);
  };
  // 清掉 cloudfunctions 的缓存,保证拿到新实例
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(ROOT, "cloudfunctions"))) {
      delete require.cache[key];
    }
  }
  try {
    return require(entryPath);
  } finally {
    Module._load = origLoad;
  }
}

function makeItemsApiStub(openid) {
  const db = createMemoryDb();
  return {
    sdk: {
      init: function () {},
      getWXContext: function () {
        return openid ? { OPENID: openid } : {};
      },
      database: function () {
        return db;
      },
      DYNAMIC_CURRENT_ENV: Symbol("DYNAMIC_CURRENT_ENV"),
    },
    db: db,
  };
}

test("胶水层:itemsApi/index.js require 链正确,create → query 全链路走通", async function () {
  const stub = makeItemsApiStub("o-glue-user-1");
  const entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "itemsApi", "index.js"), stub.sdk);

  assert.strictEqual(typeof entry.main, "function", "exports.main 应为函数(require 链断裂会变 undefined)");

  const created = await entry.main({
    action: "create",
    operation_id: "glue-op-1",
    name: "测试钥匙",
    location_text: "玄关第二个抽屉",
  });
  assert.strictEqual(created.ok, true, "create 应成功:" + JSON.stringify(created));
  assert.strictEqual(created.duplicated, false);
  assert.strictEqual(created.item.version, 1);
  assert.ok(String(created.item.item_id).indexOf("it_") === 0, "item_id 应以 it_ 开头");
  // household 派生经存储层直查断言(响应为投影形态,不含内部字段)
  const stored = await stub.db.collection("items").where({}).get();
  assert.strictEqual(stored.data.length, 1, "应恰好写入一件");
  const expectedHousehold = "hh_" + crypto.createHash("sha256").update("o-glue-user-1", "utf8").digest("hex").slice(0, 32);
  assert.strictEqual(stored.data[0].household_id, expectedHousehold, "household_id 应由 OPENID 按契约公式派生");

  const queried = await entry.main({ action: "query", q: "测试钥匙" });
  assert.strictEqual(queried.ok, true);
  assert.strictEqual(queried.items.length, 1);
  assert.strictEqual(queried.items[0].location_text, "玄关第二个抽屉");
});

test("胶水层:itemsApi OPENID 缺失返回 UNAUTHORIZED(不炸、不写入)", async function () {
  const stub = makeItemsApiStub(null);
  const entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "itemsApi", "index.js"), stub.sdk);

  const res = await entry.main({
    action: "create",
    operation_id: "glue-op-2",
    name: "不应写入",
    location_text: "不应写入",
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "UNAUTHORIZED");
  assert.strictEqual(typeof res.message, "string");
});

test("胶水层:extractDraft/index.js key 缺失且本地未配置返回 AI_UNAVAILABLE + manual_fallback(零网络)", async function () {
  const savedKey = process.env.DEEPSEEK_API_KEY;
  const savedLocal = {};
  for (const k of ["LOCAL_LLM_BASE", "LOCAL_LLM_TOKEN", "LOCAL_LLM_MODEL", "LOCAL_LLM_TIMEOUT_MS"]) {
    savedLocal[k] = process.env[k];
    delete process.env[k];
  }
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const stub = makeItemsApiStub("o-glue-user-2"); // 任意 stub,extractDraft 不用 db
    const entry = loadCloudFunction(
      path.join(ROOT, "cloudfunctions", "extractDraft", "index.js"),
      stub.sdk
    );
    assert.strictEqual(typeof entry.main, "function", "exports.main 应为函数");

    const res = await entry.main({ text: "钥匙放在玄关第二个抽屉" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "AI_UNAVAILABLE");
    assert.strictEqual(res.manual_fallback, true);
    assert.strictEqual(res.engine, "deepseek", "未配置本地时 engine 恒 deepseek");
  } finally {
    if (savedKey !== undefined) {
      process.env.DEEPSEEK_API_KEY = savedKey;
    }
    for (const k of Object.keys(savedLocal)) {
      if (savedLocal[k] !== undefined) process.env[k] = savedLocal[k];
      else delete process.env[k];
    }
  }
});

test("胶水层:本地三件套已配置且 key 缺失 → 主路走本地(127.0.0.1 stub),engine=local", async function () {
  // 本地 http 服务扮演 mlx_lm.server(OpenAI 兼容,内容带围栏),
  // 验证 index.js → handler → local-llm 全链路(零外网)。
  const seen = {};
  const server = http.createServer(function (req, res) {
    seen.auth = req.headers.authorization;
    const chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () {
      seen.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const content = "```json\n" + JSON.stringify({
        name: "钥匙",
        location_text: "玄关第二个抽屉",
        certain: true,
        qualifiers: ["第二个"],
      }) + "\n```";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: content } }] }));
    });
  });
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;

  const savedKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.LOCAL_LLM_BASE = "http://127.0.0.1:" + port + "/v1";
  process.env.LOCAL_LLM_TOKEN = "glue-local-token";
  process.env.LOCAL_LLM_MODEL = "/models/Qwen3.6-35B-A3B-4bit";
  try {
    const stub = makeItemsApiStub("o-glue-user-3");
    const entry = loadCloudFunction(
      path.join(ROOT, "cloudfunctions", "extractDraft", "index.js"),
      stub.sdk
    );
    const res = await entry.main({ text: "钥匙放在玄关第二个抽屉" });
    assert.strictEqual(res.ok, true, "本地主路应成功:" + JSON.stringify(res));
    assert.strictEqual(res.engine, "local", "engine 应标记 local");
    assert.strictEqual(res.draft.name, "钥匙");
    assert.strictEqual(seen.auth, "Bearer glue-local-token", "应带 Bearer 鉴权");
    assert.deepStrictEqual(seen.body.chat_template_kwargs, { enable_thinking: false }, "必须关思考");
  } finally {
    if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
    for (const k of ["LOCAL_LLM_BASE", "LOCAL_LLM_TOKEN", "LOCAL_LLM_MODEL"]) delete process.env[k];
    server.close();
  }
});

test("胶水层:本地已配置但网关 500 且 key 缺失 → 双引擎失败 AI_UNAVAILABLE,engine=deepseek", async function () {
  const server = http.createServer(function (req, res) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad gateway" }));
  });
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;

  const savedKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.LOCAL_LLM_BASE = "http://127.0.0.1:" + port + "/v1";
  process.env.LOCAL_LLM_TOKEN = "glue-local-token";
  process.env.LOCAL_LLM_MODEL = "/models/Qwen3.6-35B-A3B-4bit";
  try {
    const stub = makeItemsApiStub("o-glue-user-4");
    const entry = loadCloudFunction(
      path.join(ROOT, "cloudfunctions", "extractDraft", "index.js"),
      stub.sdk
    );
    const res = await entry.main({ text: "钥匙放在玄关第二个抽屉" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "AI_UNAVAILABLE");
    assert.strictEqual(res.manual_fallback, true);
    assert.strictEqual(res.engine, "deepseek", "本地失守降级 DeepSeek,key 又缺 → 终局 engine=deepseek");
  } finally {
    if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
    for (const k of ["LOCAL_LLM_BASE", "LOCAL_LLM_TOKEN", "LOCAL_LLM_MODEL"]) delete process.env[k];
    server.close();
  }
});
