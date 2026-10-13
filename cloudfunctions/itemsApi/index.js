"use strict";

/**
 * itemsApi 薄适配层:仅做 wx-server-sdk 胶水。
 * - cloud.init 用 { env: cloud.DYNAMIC_CURRENT_ENV }
 * - 身份只取 cloud.getWXContext().OPENID;openid 缺失返回 UNAUTHORIZED
 * - 可信家庭解析(issue #34 P0+P1-A,lib/household.js,与 locations/households
 *   逐字节同源,三向验证:活跃指针 → 有效会员 → 家庭未解散):
 *   活跃共享家庭且三向验证通过 → 该 household_id(含 role/scope_revision);
 *   无活跃记录 → 回退 "hh_" + sha256(openid) 前 32 位(存量用户零感知);
 *   任何查询异常/孤儿指针/已解散 → HOUSEHOLD_UNAVAILABLE 失败关闭,
 *   绝不回退个人家庭继续读写(P0-4)
 * - 组装 deps(db、now、genId、householdId、logger)后交给 lib/handler.js,返回其结果
 * 客户端传来的 household_id/openid 一律忽略(不透传、不读取)。
 */

var cloud = require("wx-server-sdk");
var crypto = require("crypto");

var handlerModule = require("./lib/handler");
var handler = handlerModule.handler;
var ERROR_MESSAGES = handlerModule.ERROR_MESSAGES;
var resolveActiveHousehold = require("./lib/household").resolveActiveHousehold;

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function makeLogger() {
  return {
    // handler 传入的 entry 只含 action/error/ms/count,这里直接落控制台
    log: function (entry) {
      console.log(JSON.stringify(entry));
    }
  };
}

exports.main = async function (event) {
  var startedAt = Date.now();
  var wxContext = cloud.getWXContext();
  var openid = wxContext && wxContext.OPENID;
  if (!openid) {
    return {
      ok: false,
      error: "UNAUTHORIZED",
      message: ERROR_MESSAGES.UNAUTHORIZED
    };
  }

  var db = cloud.database();
  // 可信家庭解析收口(issue #34 P0):household_id 只由服务端从可信 OPENID 解析得出
  var resolved = await resolveActiveHousehold(db, openid);
  if (resolved.ok !== true) {
    // 失败关闭:只记错误码与简短 reason(不含身份/家庭数据),绝不回退个人家庭
    console.log(JSON.stringify({ error: resolved.error, reason: resolved.reason }));
    return { ok: false, error: resolved.error, message: resolved.message };
  }

  var deps = {
    db: db,
    now: function () {
      return new Date().toISOString();
    },
    genId: function () {
      return crypto.randomBytes(12).toString("hex");
    },
    householdId: resolved.householdId,
    // 写入硬门上下文(issue #34 P1-A):共享家庭(三向验证通过)强制
    // expected_household_id + expected_scope_revision;个人家庭维持宽松口径
    householdShared: resolved.shared === true,
    scopeRevision: resolved.shared === true ? resolved.scopeRevision : null,
    logger: makeLogger()
  };
  return handler(event, deps);
};
