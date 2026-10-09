"use strict";

/*
 * 胶水层测试(glue):用 stub 的 wx-server-sdk 真实加载两个云函数的 index.js,
 * 验证 require 链正确、exports.main 可调用、身份派生与 key 缺失回退。
 *
 * 背景:itemsApi/index.js 曾把 require("./lib/handler") 的模块对象当函数调用,
 * 离线的 handler 纯函数测试覆盖不到这一层,部署到真实环境才暴露
 * 「TypeError: handler is not a function」。本文件把这一层纳入离线回归。
 * 全程零网络:extractDraft 侧通过不设置 DEEPSEEK_API_KEY 走 key 缺失分支。
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");
const crypto = require("node:crypto");
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
  const expectedHousehold = "hh_" + crypto.createHash("sha256").update("o-glue-user-1", "utf8").digest("hex").slice(0, 32);
  assert.strictEqual(created.item.household_id, expectedHousehold, "household_id 应由 OPENID 按契约公式派生");

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

test("胶水层:extractDraft/index.js key 缺失返回 AI_UNAVAILABLE + manual_fallback(零网络)", async function () {
  const savedKey = process.env.DEEPSEEK_API_KEY;
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
  } finally {
    if (savedKey !== undefined) {
      process.env.DEEPSEEK_API_KEY = savedKey;
    }
  }
});
