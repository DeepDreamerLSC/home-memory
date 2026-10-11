"use strict";

/**
 * locations-api 客户端封装的离线测试(npm run build:mp 的编译产物,
 * pretest 已保证先编译;零外部依赖,wx.cloud 以 stub 注入)。
 *
 * 架构师建议项(issue #18 PR #19 终审):DEEPSEEK_API_KEY 缺失 → 云端快速返回
 * AI_UNAVAILABLE → 前端拿到「可判别的错误码 + 可理解提示」进入手动兜底分支。
 * 云端半环(缺 key 短路、零网络、不打印 key)已在 tests/locations.test.js
 * 胶水层测试覆盖;本文件覆盖客户端半环:错误码/文案映射与判别函数。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var FALLBACK_MESSAGE = "AI 暂时不可用,可稍后重试或手动选择位置";

/** 安装 wx.cloud.callFunction stub(回调风格,与 utils/api.ts 的 success/fail 用法一致),返回捕获的调用参数 */
function installWxStub(result) {
  var calls = [];
  globalThis.wx = {
    cloud: {
      callFunction: function (opts) {
        calls.push(opts);
        opts.success({ result: result });
      }
    }
  };
  return calls;
}

test("LA-ERR1:云端 AI_UNAVAILABLE → 前端 LocationsApiError 携带可判别错误码与可理解提示", async function () {
  var locationsApi = require("../miniprogram/utils/locations-api.js");
  var calls = installWxStub({
    ok: false,
    error: "AI_UNAVAILABLE",
    message: FALLBACK_MESSAGE,
    manual_fallback: true
  });

  var thrown = null;
  try {
    await locationsApi.callLocationsApi({ action: "scanHousehold" });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, "scanHousehold 必须以异常形式抛出,不得静默");
  assert.equal(thrown.name, "LocationsApiError");
  assert.equal(thrown.code, "AI_UNAVAILABLE", "错误码必须原样透传,供页面分支判断");
  assert.ok(
    String(thrown.message).indexOf("手动") !== -1,
    "提示文案应引导手动选择,实际:" + thrown.message
  );
  assert.equal(
    locationsApi.isLocationsApiErrorWithCode(thrown, "AI_UNAVAILABLE"),
    true,
    "判别函数应命中 AI_UNAVAILABLE(手动兜底分支的开关)"
  );
  assert.equal(
    locationsApi.isLocationsApiErrorWithCode(thrown, "VERSION_CONFLICT"),
    false,
    "判别函数不得误报其他错误码"
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "locations");
  assert.equal(calls[0].data.action, "scanHousehold");
});

test("LA-ERR2:服务端 message 缺失 → 客户端按错误码映射兜底文案(部署新环境缺 key 时用户仍能看到可理解提示)", async function () {
  var locationsApi = require("../miniprogram/utils/locations-api.js");
  installWxStub({ ok: false, error: "AI_UNAVAILABLE" });

  var thrown = null;
  try {
    await locationsApi.callLocationsApi({ action: "parseLocation", text: "书房桌子" });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown);
  assert.equal(thrown.code, "AI_UNAVAILABLE");
  assert.equal(thrown.message, FALLBACK_MESSAGE, "缺失 message 时用客户端兜底文案");
});
