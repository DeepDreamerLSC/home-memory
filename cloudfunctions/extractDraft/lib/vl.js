"use strict";

/*
 * 本地视觉模型(VL)客户端(拍照识物 #3,OpenAI 兼容 chat/completions,仅用 Node
 * 内置 http/https 模块)。extractDraft.vlRecognize 的唯一引擎:家里 mlx 跑
 * Qwen3-VL,经公网隧道暴露(Caddy 层 Bearer 鉴权),地址/密钥/模型一律由云函数
 * 环境变量注入,绝不硬编码(仓库 public):
 *   VL_BASE        含 /v1 的基址
 *   VL_TOKEN       Caddy 层 Bearer token
 *   VL_MODEL       模型路径
 *   VL_TIMEOUT_MS  可选,默认 30000(VL 推理慢于纯文本,见 IMPLEMENTATION §1.1)
 * 纪律与 lib/local-llm.js 逐条对齐(两函数族互不 require,副本纪律同
 * extractDraft/locations 的 deepseek.js):
 *   - 三件套任一缺失 isVlConfigured() 为 false,胶水层据此不注入 callVL,
 *     handler 直接返回 vl_not_configured(engine unavailable),不抛错;
 *   - 请求体 temperature 0.1 / max_tokens 2000 / chat_template_kwargs 关思考
 *     (防退化参数,不带时模型默认思考、content 为空),不发 response_format;
 *   - 自定义 User-Agent(Cloudflare 边缘会 403 默认 UA);
 *   - 响应围栏剥离 stripResponseFence 与 local-llm.js 同款逻辑(本文件持有副本);
 *   - content 空/缺失/HTTP 非 200/网络错/超时 → reject,错误只带错误码,绝不带
 *     token/地址/图片数据/prompt 原文。
 * 坐标适配(IMPLEMENTATION §3.1 核心红线):normalizeVlBox 把模型声明的 0-1000
 * 整数框归一到 0-1;任一条件不满足整框丢弃为 null(物品候选保留,只是没有框)。
 * 绝不按值域猜量纲、绝不舍入钳制。
 */

const https = require("https");
const http = require("http");

const DEFAULT_TIMEOUT_MS = 30000;
const USER_AGENT = "home-memory-cloudfn/1.0";
const BOX_SCALE = 1000;

function readConfig() {
  return {
    base: process.env.VL_BASE,
    token: process.env.VL_TOKEN,
    model: process.env.VL_MODEL,
  };
}

/*
 * 环境变量三件套任一缺失 → false,胶水层据此不注入 callVL,handler 返回
 * AI_UNAVAILABLE(reason:"vl_not_configured",manual_fallback:true)。
 */
function isVlConfigured() {
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
 * 与 lib/local-llm.js stripResponseFence 同款逻辑(副本,互不 require)。
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
  const raw = process.env.VL_TIMEOUT_MS;
  const n = typeof raw === "string" && raw !== "" ? Number(raw) : NaN;
  if (!isNaN(n) && n > 0) return n;
  return DEFAULT_TIMEOUT_MS;
}

/*
 * 模型声明量纲(0-1000 整数,提示词唯一合法量纲)→ 存储/传输形态(0-1 double)。
 * 入参 box 形如 [x1,y1,x2,y2]。接受条件(全部满足才归一):
 *   四值均为 0-1000 的整数(Number.isInteger)且 x2>x1、y2>y1(面积 >0)。
 * 任一不满足 → 返回 null(整框丢弃,物品候选由调用方保留):
 *   小数(模型自作主张给 0-1 小数)/负数/NaN/Infinity/像素值(>1000)/缺项/
 *   退化框一视同仁判不可信——绝不按最大值猜量纲、绝不舍入或钳制后继续用。
 */
function normalizeVlBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const v = box[i];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > BOX_SCALE) {
      return null;
    }
  }
  const x1 = box[0];
  const y1 = box[1];
  const x2 = box[2];
  const y2 = box[3];
  if (!(x2 > x1) || !(y2 > y1)) return null;
  return {
    x1: x1 / BOX_SCALE,
    y1: y1 / BOX_SCALE,
    x2: x2 / BOX_SCALE,
    y2: y2 / BOX_SCALE,
  };
}

/*
 * 调视觉模型:输入提示词文本 + 图片 base64(JPEG),resolve 剥围栏后的补全文本。
 * 失败 reject(错误只带错误码),由 handler 捕获映射为 AI_UNAVAILABLE(无降级引擎)。
 */
function callVlModel(promptText, imageBase64, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof promptText !== "string" || promptText.length === 0) {
      reject(new Error("EMPTY_PROMPT"));
      return;
    }
    if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
      reject(new Error("EMPTY_IMAGE"));
      return;
    }
    if (!isVlConfigured()) {
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
      temperature: 0.1,
      max_tokens: 2000,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: promptText },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64," + imageBase64 } },
          ],
        },
      ],
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
    // 统一改写为 NETWORK_ERROR,绝不外泄 token/地址/图片数据。
    req.on("error", (err) => {
      reject(err && err.message === "TIMEOUT" ? err : new Error("NETWORK_ERROR"));
    });

    req.write(body);
    req.end();
  });
}

module.exports = {
  callVlModel,
  isVlConfigured,
  normalizeVlBox,
  stripResponseFence,
  DEFAULT_TIMEOUT_MS,
  BOX_SCALE,
};
