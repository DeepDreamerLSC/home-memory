"use strict";

/**
 * transcribe 云函数离线测试:
 * - TC3 签名:结构正确 + 确定性(同输入同签名)+ 关键派生要素;
 * - index.js 胶水:key 缺失降级、入参校验(离线安全,不发网络请求)。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var Module = require("node:module");

var ROOT = path.join(__dirname, "..");
var { buildSignedHeaders } = require(path.join(ROOT, "cloudfunctions", "transcribe", "lib", "tc3"));

function signOnce() {
  return buildSignedHeaders(
    "AKIDtest",
    "secretKeyTest",
    "asr.tencentcloudapi.com",
    "asr",
    "SentenceRecognition",
    "2019-06-14",
    JSON.stringify({ a: 1 }),
    1760000000
  );
}

test("tc3:签名头结构完整、字段正确", function () {
  var h = signOnce();
  assert.equal(h.Host, "asr.tencentcloudapi.com");
  assert.equal(h["X-TC-Action"], "SentenceRecognition");
  assert.equal(h["X-TC-Version"], "2019-06-14");
  assert.equal(h["X-TC-Timestamp"], "1760000000");
  assert.ok(h.Authorization.indexOf("TC3-HMAC-SHA256 ") === 0);
  assert.ok(h.Authorization.indexOf("Credential=AKIDtest/2025-10-09/asr/tc3_request") !== -1, "凭证范围含日期/服务/tc3_request");
  assert.ok(/Signature=[0-9a-f]{64}$/.test(h.Authorization), "签名为 64 位十六进制");
});

test("tc3:同输入签名确定;换 key/时间戳/payload 签名变化", function () {
  var h1 = signOnce();
  var h2 = signOnce();
  assert.equal(h1.Authorization, h2.Authorization, "同输入必须同签名");

  var h3 = buildSignedHeaders("AKIDtest", "anotherKey", "asr.tencentcloudapi.com", "asr", "SentenceRecognition", "2019-06-14", JSON.stringify({ a: 1 }), 1760000000);
  assert.notEqual(h1.Authorization, h3.Authorization);

  var h4 = buildSignedHeaders("AKIDtest", "secretKeyTest", "asr.tencentcloudapi.com", "asr", "SentenceRecognition", "2019-06-14", JSON.stringify({ a: 2 }), 1760000000);
  assert.notEqual(h1.Authorization, h4.Authorization);

  var h5 = buildSignedHeaders("AKIDtest", "secretKeyTest", "asr.tencentcloudapi.com", "asr", "SentenceRecognition", "2019-06-14", JSON.stringify({ a: 1 }), 1760000060);
  assert.notEqual(h1.Authorization, h5.Authorization, "时间戳变化必须影响签名(防重放要素)");
});

function loadTranscribe() {
  for (var key of Object.keys(require.cache)) {
    if (key.indexOf(path.join(ROOT, "cloudfunctions", "transcribe")) === 0) {
      delete require.cache[key];
    }
  }
  return require(path.join(ROOT, "cloudfunctions", "transcribe", "index.js"));
}

test("transcribe 胶水:密钥缺失返回 ASR_UNAVAILABLE + manual_fallback(离线零网络)", async function () {
  var savedId = process.env.TENCENT_SECRET_ID;
  var savedKey = process.env.TENCENT_SECRET_KEY;
  delete process.env.TENCENT_SECRET_ID;
  delete process.env.TENCENT_SECRET_KEY;
  try {
    var fn = loadTranscribe();
    var res = await fn.main({ audio_base64: "QVVESU8=", voice_format: "wav" });
    assert.equal(res.ok, false);
    assert.equal(res.error, "ASR_UNAVAILABLE");
    assert.equal(res.manual_fallback, true);
  } finally {
    if (savedId !== undefined) { process.env.TENCENT_SECRET_ID = savedId; }
    if (savedKey !== undefined) { process.env.TENCENT_SECRET_KEY = savedKey; }
  }
});

test("transcribe 胶水:入参缺失/格式非法一律 INVALID_INPUT,绝不发起调用", async function () {
  var fn = loadTranscribe();
  var r1 = await fn.main({});
  assert.equal(r1.error, "INVALID_INPUT");
  var r2 = await fn.main({ audio_base64: "QVVESU8=", voice_format: "" });
  assert.equal(r2.error, "INVALID_INPUT");
  var r3 = await fn.main({ audio_base64: "", voice_format: "wav" });
  assert.equal(r3.error, "INVALID_INPUT");
  var long = new Array(1024 * 1024 + 10).join("A");
  var r4 = await fn.main({ audio_base64: long, voice_format: "wav" });
  assert.equal(r4.error, "INVALID_INPUT", "超长音频直接拒绝");
});
