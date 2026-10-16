"use strict";

/*
 * 本地 LLM 客户端(mlx_lm.server,OpenAI 兼容;仅用 Node 内置 http/https 模块)。
 * extractDraft 的主路引擎:macOS 上 mlx_lm.server 跑 Qwen3.6-35B-A3B-4bit,经
 * Cloudflare 隧道暴露为公网 https 域名(Caddy 层 Bearer 鉴权),地址/密钥/模型
 * 一律由云函数环境变量注入,绝不硬编码(仓库 public):
 *   LOCAL_LLM_BASE   含 /v1 的基址(如 https://llm.chiraliumai.cn/v1)
 *   LOCAL_LLM_TOKEN  Caddy 层 Bearer token
 *   LOCAL_LLM_MODEL  模型路径(如 /Users/.../Qwen3.6-35B-A3B-4bit)
 *   LOCAL_LLM_TIMEOUT_MS 可选,默认 15000
 * 接口与 lib/deepseek.js 对齐:输入 prompt 文本、resolve 补全文本,便于 handler
 * 无感切换;失败 reject(错误只带错误码,绝不带 token/地址/prompt 原文),
 * 由 handler 捕获后降级 DeepSeek(见 lib/handler.js 主备逻辑)。
 * 与 deepseek 的差异(实测口径,2026-10-16 公网链路验证):
 *   - 不发 response_format(mlx 不支持 json_object);也不发 thinking
 *     (DeepSeek 专属参数),改发 chat_template_kwargs {enable_thinking:false}——
 *     不带时该模型默认思考且是最高档,思考内容进独立 reasoning 字段、
 *     choices[0].message.content 为空,提取链路会拿到空文本;
 *   - 自定义 User-Agent(Cloudflare 边缘机器人检测会把默认 UA 403 拒掉);
 *   - mlx 无 json_object 保证,响应可能包 markdown 围栏:剥离围栏与首尾空白后
 *     再返回(评测 runner 同款口径:strip 后以 ``` 开头按围栏剥离);
 *   - content 为空/缺失视为引擎失败(NO_CONTENT/EMPTY_CONTENT),交由
 *     handler 立即降级 DeepSeek。
 */

const https = require("https");
const http = require("http");

const DEFAULT_TIMEOUT_MS = 15000;
const USER_AGENT = "home-memory-cloudfn/1.0";

function readConfig() {
  return {
    base: process.env.LOCAL_LLM_BASE,
    token: process.env.LOCAL_LLM_TOKEN,
    model: process.env.LOCAL_LLM_MODEL,
  };
}

/*
 * 环境变量三件套任一缺失 → false,handler/胶水层据此只走 DeepSeek,
 * 行为与现状逐字节一致(未配置即零改动回归)。
 */
function isConfigured() {
  const c = readConfig();
  return (
    typeof c.base === "string" &&
    c.base.length > 0 &&
    typeof c.token === "string" &&
    c.token.length > 0 &&
    typeof c.model === "string" &&
    c.model.length > 0
  );
}

/*
 * 剥离 markdown 围栏与首尾空白:trim 后若以 ``` 开头,剥掉开栏行
 * (``` 或 ```json)与末尾 ``` 再 trim;只剩围栏碎片(无换行)时返回空串。
 * 与评测 runner 同款口径,validate.js 的首 { 末 } 截取是第二道防线。
 */
function stripResponseFence(text) {
  let t = typeof text === "string" ? text.trim() : "";
  if (t.indexOf("```") === 0) {
    const nl = t.indexOf("\n");
    if (nl === -1) return "";
    t = t.slice(nl + 1);
    const close = t.lastIndexOf("```");
    if (close !== -1) t = t.slice(0, close);
    t = t.trim();
  }
  return t;
}

function resolveTimeoutMs(explicit) {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const raw = process.env.LOCAL_LLM_TIMEOUT_MS;
  const n = typeof raw === "string" && raw !== "" ? Number(raw) : NaN;
  if (!isNaN(n) && n > 0) return n;
  return DEFAULT_TIMEOUT_MS;
}

function callLocalLLM(promptText, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof promptText !== "string" || promptText.length === 0) {
      reject(new Error("EMPTY_PROMPT"));
      return;
    }
    if (!isConfigured()) {
      reject(new Error("NOT_CONFIGURED"));
      return;
    }
    const c = readConfig();
    // 基址含 /v1,剥尾部斜杠后拼 /chat/completions(OpenAI 兼容路径)。
    const url = c.base.replace(/\/+$/, "") + "/chat/completions";
    const timeout = resolveTimeoutMs(timeoutMs);
    // https 上公网隧道;http 仅供本地调试与离线测试(127.0.0.1 stub)。
    const transport = url.indexOf("https://") === 0 ? https : http;

    const body = JSON.stringify({
      model: c.model,
      messages: [{ role: "user", content: promptText }],
      temperature: 0.1,
      max_tokens: 2000,
      chat_template_kwargs: { enable_thinking: false },
    });

    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + c.token,
          "User-Agent": USER_AGENT,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          // 响应体绝不落日志;状态码非 200 只记错误码。
          if (res.statusCode !== 200) {
            reject(new Error("HTTP_" + res.statusCode));
            return;
          }
          const raw = Buffer.concat(chunks).toString("utf8");
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
          const stripped = stripResponseFence(content);
          if (stripped === "") {
            reject(new Error("EMPTY_CONTENT"));
            return;
          }
          resolve(stripped);
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("TIMEOUT"));
    });
    // 错误对象只保留错误码:Node 原生网络错误可能携带主机名等环境信息,
    // 统一改写为 NETWORK_ERROR,绝不外泄 token/地址/prompt。
    req.on("error", (err) => {
      reject(err && err.message === "TIMEOUT" ? err : new Error("NETWORK_ERROR"));
    });

    req.write(body);
    req.end();
  });
}

module.exports = {
  callLocalLLM,
  isConfigured,
  stripResponseFence,
  DEFAULT_TIMEOUT_MS,
};
