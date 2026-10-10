"use strict";

/**
 * transcribe 云函数入口:音频 base64 → 文字(腾讯云一句话识别)。
 * - 密钥只从环境变量 TENCENT_SECRET_ID / TENCENT_SECRET_KEY 读取,缺失直接降级;
 * - 日志只记音频大小、格式、耗时、错误码;绝不打印音频数据与识别结果(隐私);
 * - 任何失败返回 { ok:false, error:"ASR_UNAVAILABLE" } 由客户端回退文字,绝不静默。
 */

const { recognizeOnce } = require("./lib/asr");

const MAX_AUDIO_BYTES = 1024 * 1024; // 与一句话识别 base64 ≤1MB 对齐(原始约 750KB)
const TIMEOUT_MS = 15000;

cloudInit();

function cloudInit() {
  try {
    const cloud = require("wx-server-sdk");
    cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  } catch (e) {
    // 本地测试环境下无 wx-server-sdk,入口胶水由 tests/glue 覆盖
  }
}

exports.main = async function (event) {
  const startedAt = Date.now();
  const log = (entry) => console.log(JSON.stringify(entry));

  const audioBase64 = event && typeof event.audio_base64 === "string" ? event.audio_base64 : "";
  const voiceFormat = event && typeof event.voice_format === "string" ? event.voice_format : "";
  if (!audioBase64 || !/^[a-z0-9]+$/i.test(voiceFormat)) {
    log({ error: "INVALID_INPUT", elapsedMs: Date.now() - startedAt });
    return { ok: false, error: "INVALID_INPUT", message: "语音数据不合法" };
  }
  if (audioBase64.length > MAX_AUDIO_BYTES) {
    log({ error: "INVALID_INPUT", elapsedMs: Date.now() - startedAt });
    return { ok: false, error: "INVALID_INPUT", message: "语音太长了,请分句说" };
  }

  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) {
    log({ error: "ASR_UNAVAILABLE", reason: "missing_keys", elapsedMs: Date.now() - startedAt });
    return {
      ok: false,
      error: "ASR_UNAVAILABLE",
      message: "语音识别暂不可用,可手动录入",
      manual_fallback: true,
      reason: "missing_keys"
    };
  }

  try {
    const res = await recognizeOnce(audioBase64, voiceFormat, secretId, secretKey, TIMEOUT_MS);
    log({ audioChars: audioBase64.length, elapsedMs: Date.now() - startedAt });
    return { ok: true, text: res.text.trim() };
  } catch (e) {
    var reason = (e && e.detail) || (e && e.code) || "unknown";
    log({ error: "ASR_UNAVAILABLE", reason: reason, elapsedMs: Date.now() - startedAt });
    return {
      ok: false,
      error: "ASR_UNAVAILABLE",
      message: "语音识别失败,请重试或改用文字",
      manual_fallback: true,
      reason: reason
    };
  }
};
