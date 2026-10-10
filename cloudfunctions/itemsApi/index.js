"use strict";

/**
 * itemsApi 薄适配层:仅做 wx-server-sdk 胶水。
 * - cloud.init 用 { env: cloud.DYNAMIC_CURRENT_ENV }
 * - 身份只取 cloud.getWXContext().OPENID;openid 缺失返回 UNAUTHORIZED
 * - household_id = "hh_" + sha256(openid) 十六进制前 32 位(避免裸 openid 落库)
 * - 组装 deps(db、now、genId、householdId、logger)后交给 lib/handler.js,返回其结果
 * 客户端传来的 household_id/openid 一律忽略(不透传、不读取)。
 */

var cloud = require("wx-server-sdk");
var crypto = require("crypto");

var handlerModule = require("./lib/handler");
var handler = handlerModule.handler;
var ERROR_MESSAGES = handlerModule.ERROR_MESSAGES;

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function deriveHouseholdId(openid) {
  var hex = crypto.createHash("sha256").update(openid, "utf8").digest("hex");
  return "hh_" + hex.slice(0, 32);
}

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

  var deps = {
    db: cloud.database(),
    now: function () {
      return new Date().toISOString();
    },
    genId: function () {
      return crypto.randomBytes(12).toString("hex");
    },
    householdId: deriveHouseholdId(openid),
    logger: makeLogger()
  };
  return handler(event, deps);
};
