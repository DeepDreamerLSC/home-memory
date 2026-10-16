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
 * 拍照识物(#3)新增 action 路由(IMPLEMENTATION §4.2):
 * - event.action === "vlRecognize":走 handler.vlRecognize,只注入 callVL(lib/vl.js);
 *   照片以客户端本地压缩图的 image_base64 直传(#65 V0.4 隐私红线:确认保存前
 *   绝不上传云端,本函数不读云存储、不落任何持久层——与 transcribe 音频 base64
 *   同款先例);VL_BASE/VL_TOKEN/VL_MODEL 三件套任一缺失时不注入 callVL,
 *   handler 返回 AI_UNAVAILABLE reason:"vl_not_configured"(engine unavailable,
 *   不抛错);VL 链路不接 DeepSeek 降级(无视觉模型),与 DEEPSEEK/LOCAL_LLM
 *   并存互不影响;
 * - event.action === "draftEditParse":走 handler.draftEditParse,与提取共用
 *   local→DeepSeek 双引擎 deps;
 * - 不带 action(旧调用/语音提取)走既有提取,逐字节一致(现状锁)。
 */

const cloud = require("wx-server-sdk");
const { handler, vlRecognize, draftEditParse } = require("./lib/handler");
const { callDeepSeek } = require("./lib/deepseek");
const localLlm = require("./lib/local-llm");
const vl = require("./lib/vl");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async function (event) {
  const action = event && typeof event === "object" && typeof event.action === "string" ? event.action : null;

  if (action === "vlRecognize") {
    // 视觉识别:只依赖 VL 三件套;未配置时不注入 callVL(handler 返回 vl_not_configured)。
    // 图片经 event.image_base64 直传(本地压缩图),不读云存储(隐私红线,无 file_id 路径)。
    return vlRecognize(event, {
      callVL: vl.isVlConfigured()
        ? (promptText, imageBase64) => vl.callVlModel(promptText, imageBase64)
        : undefined,
      logger: (meta) => console.log(JSON.stringify(meta)),
    });
  }

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
  const deps = {
    callLLM: (promptText) => callDeepSeek(promptText, apiKey, 20000),
    // 本地三件套未配置时不注入,handler 只走 DeepSeek(现状锁)。
    callLocalLLM: localConfigured
      ? (promptText) => localLlm.callLocalLLM(promptText)
      : undefined,
    logger: (meta) => console.log(JSON.stringify(meta)),
  };
  if (action === "draftEditParse") {
    return draftEditParse(event, deps);
  }
  return handler(event, deps);
};
