"use strict";
// extractDraft.videoTargetRecognize 胶水路由:现有 VL 三件套直达,不依赖 DeepSeek,云存储零触碰。
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const TARGET = "黑色耳机";
const IMAGE_B64 = Buffer.from("glue-target-frame").toString("base64");
const VL_TOKEN = "target-vl-token-do-not-log";
const VL_MODEL = "target-vl-model";

const ENV_KEYS = [
  "VL_BASE", "VL_TOKEN", "VL_MODEL", "VL_TIMEOUT_MS",
  "DEEPSEEK_API_KEY", "LOCAL_LLM_BASE", "LOCAL_LLM_TOKEN", "LOCAL_LLM_MODEL",
];

async function withEnv(env, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const k of Object.keys(env || {})) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
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

function loadCloudFunction(entryPath, stubSdk) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "wx-server-sdk") return stubSdk;
    return origLoad.apply(this, arguments);
  };
  for (const key of Object.keys(require.cache)) {
    if (key.indexOf(path.join(ROOT, "cloudfunctions")) === 0) delete require.cache[key];
  }
  try {
    return require(entryPath);
  } finally {
    Module._load = origLoad;
  }
}

function makeSdk(downloads) {
  return {
    init: function () {},
    getWXContext: function () { return {}; },
    DYNAMIC_CURRENT_ENV: "env-dynamic",
    downloadFile: function (options) {
      downloads.push(options && options.fileID);
      return Promise.reject(new Error("videoTargetRecognize 不得读云存储"));
    },
  };
}

function startStubServer(onRequest) {
  return new Promise((resolve) => {
    const server = http.createServer(onRequest);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server: server, port: server.address().port });
    });
  });
}

test("胶水:videoTargetRecognize 优先路由到现有 VL,不要求 DEEPSEEK_API_KEY,不读云存储", async () => {
  let seen = null;
  const { server, port } = await startStubServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ found: true, confidence: "mid", box: [100, 200, 300, 400] }) } }],
      }));
    });
  });
  try {
    const downloads = [];
    const entry = loadCloudFunction(
      path.join(ROOT, "cloudfunctions", "extractDraft", "index.js"),
      makeSdk(downloads)
    );
    await withEnv({
      VL_BASE: "http://127.0.0.1:" + port + "/v1",
      VL_TOKEN: VL_TOKEN,
      VL_MODEL: VL_MODEL,
      DEEPSEEK_API_KEY: undefined,
      LOCAL_LLM_BASE: undefined,
      LOCAL_LLM_TOKEN: undefined,
      LOCAL_LLM_MODEL: undefined,
    }, async () => {
      const res = await entry.main({
        action: "videoTargetRecognize",
        target_name: TARGET,
        image_base64: IMAGE_B64,
        img_w: 1024,
        img_h: 768,
      });
      assert.deepEqual(res, {
        ok: true,
        hit: true,
        box: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 },
        confidence: "mid",
      });
    });
    assert.equal(seen.model, VL_MODEL);
    const messageText = seen.messages[0].content[0].text;
    assert.equal(messageText.indexOf(TARGET) !== -1, true);
    assert.equal(seen.messages[0].content[1].image_url.url, "data:image/jpeg;base64," + IMAGE_B64);
    assert.equal(downloads.length, 0, "目标识别不读云存储");
  } finally {
    server.close();
  }
});

test("胶水:VL 未配置时 videoTargetRecognize 返回 AI_UNAVAILABLE,不落到 missing_api_key 分支", async () => {
  const downloads = [];
  const entry = loadCloudFunction(
    path.join(ROOT, "cloudfunctions", "extractDraft", "index.js"),
    makeSdk(downloads)
  );
  await withEnv({
    VL_BASE: undefined,
    VL_TOKEN: undefined,
    VL_MODEL: undefined,
    DEEPSEEK_API_KEY: undefined,
    LOCAL_LLM_BASE: undefined,
    LOCAL_LLM_TOKEN: undefined,
    LOCAL_LLM_MODEL: undefined,
  }, async () => {
    const res = await entry.main({
      action: "videoTargetRecognize",
      target_name: TARGET,
      image_base64: IMAGE_B64,
      img_w: 1024,
      img_h: 768,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "AI_UNAVAILABLE");
    assert.equal(res.manual_fallback, true);
  });
  assert.equal(downloads.length, 0);
});
