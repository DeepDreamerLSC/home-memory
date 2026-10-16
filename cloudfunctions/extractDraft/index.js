"use strict";

/*
 * extractDraft 云函数入口:wx-server-sdk 胶水层。
 * - cloud.init 使用 DYNAMIC_CURRENT_ENV(跟随当前云环境);
 * - DeepSeek API key 只从云函数环境变量 DEEPSEEK_API_KEY 读取,绝不打印 key 本身;
 * - 本地主路(issue #36 本地 A3B):LOCAL_LLM_BASE/LOCAL_LLM_TOKEN/LOCAL_LLM_MODEL
 *   三件套齐全(local-llm.isConfigured)时注入 callLocalLLM,handler 先走本地、
 *   失败自动降级 DeepSeek;三件套任一缺失时不注入,只走 DeepSeek,行为与
 *   历史逐字节一致。密钥/地址/模型一律环境变量,绝不硬编码(仓库 public)。
 * - 双引擎都未配置(无 key 且本地未配置)才直接返回 AI_UNAVAILABLE
 *   (manual_fallback 为 true);本地已配置但缺 key 时仍可主路走本地。
 * - 业务逻辑全部在 lib/handler.js(纯函数,依赖注入,便于离线测试)。
 */

const cloud = require("wx-server-sdk");
const { handler } = require("./lib/handler");
const { callDeepSeek } = require("./lib/deepseek");
const localLlm = require("./lib/local-llm");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async function (event) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const localConfigured = localLlm.isConfigured();
  if (!apiKey && !localConfigured) {
    // 只记错误码与原因,不输出任何 key 内容。
    console.log(JSON.stringify({ error: "AI_UNAVAILABLE", reason: "missing_api_key" }));
    return {
      ok: false,
      error: "AI_UNAVAILABLE",
      message: "AI 暂时不可用,可手动录入",
      manual_fallback: true,
      engine: "deepseek",
    };
  }
  return handler(event, {
    callLLM: (promptText) => callDeepSeek(promptText, apiKey, 20000),
    // 本地三件套未配置时不注入,handler 只走 DeepSeek(现状锁)。
    callLocalLLM: localConfigured
      ? (promptText) => localLlm.callLocalLLM(promptText)
      : undefined,
    logger: (meta) => console.log(JSON.stringify(meta)),
  });
};
