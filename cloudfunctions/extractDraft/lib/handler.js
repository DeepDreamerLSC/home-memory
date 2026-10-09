"use strict";

/*
 * extractDraft 纯函数 handler:event = { text },deps = { callLLM(promptText), logger }。
 * - 构造 system prompt(契约要点)与用户消息,组装成完整提示词交给 callLLM;
 * - 模型输出经 validateDraft 校验;JSON 解析失败会携带错误重试一次,仍失败返回 AI_UNAVAILABLE;
 * - callLLM 抛错(含超时、HTTP 非 200)返回 AI_UNAVAILABLE 且 manual_fallback 为 true;
 * - text 去空白后不在 1-500 字范围返回 INVALID_INPUT;
 * - 日志只记文本长度、耗时、错误码,绝不记录原文与提取结果。
 */

const { validateDraft } = require("./validate");

const TEXT_MAX = 500;
const USER_MARKER = "【用户输入】";
const RETRY_OUTPUT_MARKER = "【上次输出】";
const RETRY_ERROR_MARKER = "【解析错误】";

const SYSTEM_PROMPT = [
  "你是家庭物品位置提取器。用户会用一句话描述一件物品及其位置,你只负责提取,不负责回答或闲聊。",
  "规则:",
  "1. 从这句话里提取一件物品的名称(name)与位置(location_text)。",
  "2. 位置必须来自原文,禁止猜测、推理或编造;不能确定位置时 certain 为 false,且 location_text 为空字符串。",
  "3. 「右边」「第二个」「最下层」等具有定位作用的方位/序号限定语放进 qualifiers 数组;「某个」「好像」「大概」等表示不确定的模糊词不是限定语,不要放进 qualifiers(certain 为 false 时 qualifiers 应为空数组)。",
  "4. 一句话里出现多件物品时 needs_split 为 true。",
  "只输出一个 JSON 对象,不要输出任何其他文字、解释或代码块围栏。字段:",
  "- name:字符串,不超过 50 字",
  "- location_text:字符串,不超过 200 字,可为空字符串",
  "- certain:布尔,表示位置是否肯定",
  "- qualifiers:字符串数组,每项不超过 20 字,最多 5 个",
  "- needs_split:布尔,默认 false",
].join("\n");

function codePointLength(s) {
  return Array.from(s).length;
}

function stripAllWhitespace(s) {
  return s.replace(/\s+/g, "");
}

function buildPrompt(userText, retryInfo) {
  let prompt = SYSTEM_PROMPT + "\n\n" + USER_MARKER + "\n" + userText;
  if (retryInfo) {
    prompt +=
      "\n\n" +
      RETRY_OUTPUT_MARKER +
      "\n" +
      retryInfo.previousOutput +
      "\n" +
      RETRY_ERROR_MARKER +
      "\n" +
      retryInfo.reason +
      "\n请重新输出,只输出一个符合上述字段要求的 JSON 对象,不要包含任何其他文字或代码块围栏。";
  }
  return prompt;
}

function invalidInputResult() {
  return {
    ok: false,
    error: "INVALID_INPUT",
    message: "请输入一句话描述物品和位置(去空白后 1-500 字)",
  };
}

function aiUnavailableResult() {
  return {
    ok: false,
    error: "AI_UNAVAILABLE",
    message: "AI 暂时不可用,可手动录入",
    manual_fallback: true,
  };
}

async function handler(event, deps) {
  const startedAt = Date.now();
  const logger = deps && typeof deps.logger === "function" ? deps.logger : function () {};
  const callLLM = deps ? deps.callLLM : undefined;
  const elapsedMs = () => Date.now() - startedAt;

  const rawText = event && typeof event.text === "string" ? event.text : null;
  if (rawText === null) {
    logger({ textLength: 0, elapsedMs: elapsedMs(), error: "INVALID_INPUT" });
    return invalidInputResult();
  }
  const textLength = codePointLength(stripAllWhitespace(rawText));
  if (textLength < 1 || textLength > TEXT_MAX) {
    logger({ textLength, elapsedMs: elapsedMs(), error: "INVALID_INPUT" });
    return invalidInputResult();
  }

  const userText = rawText.trim();

  let output;
  try {
    output = await callLLM(buildPrompt(userText));
  } catch (e) {
    logger({ textLength, elapsedMs: elapsedMs(), error: "AI_UNAVAILABLE" });
    return aiUnavailableResult();
  }

  let result = validateDraft(output, userText);
  if (!result.ok && result.retryable) {
    // JSON 解析失败:带错误提示回传 LLM,只重试一次。
    let retryOutput;
    try {
      retryOutput = await callLLM(
        buildPrompt(userText, { previousOutput: output, reason: result.reason })
      );
    } catch (e) {
      logger({ textLength, elapsedMs: elapsedMs(), error: "AI_UNAVAILABLE" });
      return aiUnavailableResult();
    }
    result = validateDraft(retryOutput, userText);
  }

  if (result.ok) {
    logger({ textLength, elapsedMs: elapsedMs() });
    return result;
  }
  logger({ textLength, elapsedMs: elapsedMs(), error: "AI_UNAVAILABLE" });
  return aiUnavailableResult();
}

module.exports = { handler, buildPrompt, SYSTEM_PROMPT };
