"use strict";

/**
 * locations 云函数入口:wx-server-sdk 胶水层(itemsApi/index.js 同款纪律)。
 * - cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });身份只取 cloud.getWXContext().OPENID,
 *   缺失返回 UNAUTHORIZED;event 里的身份字段(household_id/openid)一律忽略不读;
 * - household_id = "hh_" + sha256(openid) 十六进制前 32 位(itemsApi 完全同款,
 *   保证 itemsApi 与 locations 两个函数落到同一家庭);
 * - deps.digest(s):sha256 十六进制前 16 位,供 merge/compensate/applyScan 的
 *   内部派生标识使用(§5.8 规格恒 ≤27 字符);
 * - DEEPSEEK_API_KEY 只从云函数环境变量读取(仅 LLM action parseLocation/scanHousehold
 *   需要),缺失时返回 AI_UNAVAILABLE 且 manual_fallback:true,绝不打印 key 本身;
 *   LLM 调用走 lib/deepseek.js(与 extractDraft 逐字节同源的副本);
 * - locations 集合不存在时幂等创建(db.createCollection 包 try/catch,已存在时报错被吞);
 * - 业务逻辑全部在 lib/handler.js + lib/parse.js(纯函数,依赖注入,便于离线测试)。
 */

var cloud = require("wx-server-sdk");
var crypto = require("crypto");

var handlerModule = require("./lib/handler");
var handler = handlerModule.handler;
var ERROR_MESSAGES = handlerModule.ERROR_MESSAGES;
var callDeepSeek = require("./lib/deepseek").callDeepSeek;

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var LLM_ACTIONS = { parseLocation: true, scanHousehold: true };
var LLM_TIMEOUT_DEFAULT_MS = 15000; // 单块调用超时(近义比对由 parse.js 显式传 10s)

function deriveHouseholdId(openid) {
  var hex = crypto.createHash("sha256").update(openid, "utf8").digest("hex");
  return "hh_" + hex.slice(0, 32);
}

function digest16(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

function makeLogger() {
  return {
    // handler 传入的 entry 只含 action/error/ms/count(或 LLM 类计量字段),直接落控制台
    log: function (entry) {
      console.log(JSON.stringify(entry));
    }
  };
}

exports.main = async function (event) {
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
  // 集合不存在时幂等创建(已存在时 CloudBase 报错,吞掉;后续读写会自然暴露真实问题)
  try {
    await db.createCollection("locations");
  } catch (e) {
    /* 已存在或暂不可用 */
  }

  var action = event && event.action;
  var deps = {
    db: db,
    now: function () {
      return new Date().toISOString();
    },
    genId: function () {
      return crypto.randomBytes(12).toString("hex");
    },
    digest: digest16,
    householdId: deriveHouseholdId(openid),
    logger: makeLogger()
  };

  if (LLM_ACTIONS[action]) {
    var apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      // 只记错误码与原因,不输出任何 key 内容
      console.log(JSON.stringify({ action: action, error: "AI_UNAVAILABLE", reason: "missing_api_key" }));
      return {
        ok: false,
        error: "AI_UNAVAILABLE",
        message: ERROR_MESSAGES.AI_UNAVAILABLE,
        manual_fallback: true
      };
    }
    deps.callLLM = function (promptText, timeoutMs) {
      return callDeepSeek(promptText, apiKey, timeoutMs || LLM_TIMEOUT_DEFAULT_MS);
    };
  }

  return handler(event, deps);
};
