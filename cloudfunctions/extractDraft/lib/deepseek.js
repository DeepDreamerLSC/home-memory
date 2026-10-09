"use strict";

/*
 * DeepSeek Chat Completions 客户端(仅用 Node 内置 https 模块)。
 * 契约(docs/API_CONTRACT.md「extractDraft 协议」):
 *   - 地址 https://api.deepseek.com/chat/completions,model "deepseek-flash",temperature 0.1;
 *   - 请求体显式包含 "thinking":{"type":"disabled"} 禁用思考,并要求只输出 JSON(response_format json_object);
 *   - 超时 20 秒(可用 timeoutMs 覆盖);
 *   - API key 只由调用方传参传入,本模块不读环境变量、不打印任何请求内容或 key。
 * 失败语义:网络错误、超时、HTTP 非 200、响应缺内容时直接 reject,
 * 由 handler 捕获后统一映射为 AI_UNAVAILABLE(见 lib/handler.js)。
 */

const https = require("https");

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_TIMEOUT_MS = 20000;

function callDeepSeek(promptText, apiKey, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof promptText !== "string" || promptText.length === 0) {
      reject(new Error("EMPTY_PROMPT"));
      return;
    }
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      reject(new Error("MISSING_API_KEY"));
      return;
    }
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

    const body = JSON.stringify({
      model: "deepseek-flash",
      temperature: 0.1,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: promptText }],
    });

    const req = https.request(
      DEEPSEEK_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            reject(new Error("HTTP_" + res.statusCode));
            return;
          }
          let data;
          try {
            data = JSON.parse(raw);
          } catch (e) {
            reject(new Error("BAD_RESPONSE_BODY"));
            return;
          }
          const content =
            data &&
            data.choices &&
            data.choices[0] &&
            data.choices[0].message &&
            data.choices[0].message.content;
          if (typeof content !== "string") {
            reject(new Error("NO_CONTENT"));
            return;
          }
          resolve(content);
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("TIMEOUT"));
    });
    req.on("error", (err) => reject(err));

    req.write(body);
    req.end();
  });
}

module.exports = { callDeepSeek };
