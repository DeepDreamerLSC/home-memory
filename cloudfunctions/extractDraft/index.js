"use strict";

/*
 * extractDraft 云函数入口:wx-server-sdk 胶水层。
 * - cloud.init 使用 DYNAMIC_CURRENT_ENV(跟随当前云环境);
 * - API key 只从云函数环境变量 DEEPSEEK_API_KEY 读取,缺失时直接返回
 *   AI_UNAVAILABLE(manual_fallback 为 true),绝不打印 key 本身;
 * - 业务逻辑全部在 lib/handler.js(纯函数,依赖注入,便于离线测试)。
 */

const cloud = require("wx-server-sdk");
const { handler } = require("./lib/handler");
const { callDeepSeek } = require("./lib/deepseek");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async function (event) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    // 只记错误码与原因,不输出任何 key 内容。
    console.log(JSON.stringify({ error: "AI_UNAVAILABLE", reason: "missing_api_key" }));
    return {
      ok: false,
      error: "AI_UNAVAILABLE",
      message: "AI 暂时不可用,可手动录入",
      manual_fallback: true,
    };
  }
  return handler(event, {
    callLLM: (promptText) => callDeepSeek(promptText, apiKey, 20000),
    logger: (meta) => console.log(JSON.stringify(meta)),
  });
};
