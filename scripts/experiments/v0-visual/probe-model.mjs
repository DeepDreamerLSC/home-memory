#!/usr/bin/env node
/**
 * Issue #3 V0 实验探针:向所选视觉模型发一张测试图,验证多物品候选 prompt 的真实返回。
 *
 * 性质:连通性/规格验证(与 docs/experiments/issue3-v0-model-report.md 的桌面调研互补)。
 * 隐私红线(issue #3):仅使用非真实家庭影像的测试图;授权前不上传真实素材;
 * 绝不打印 API key;不把图片数据写日志;密钥只从环境变量读取,不硬编码。
 *
 * 用法:
 *   node probe-model.mjs ./test-image.jpg
 *   PROVIDER=dashscope node probe-model.mjs ./test-image.jpg
 *   PROVIDER=custom API_URL=... MODEL=... API_KEY_ENV=MY_KEY node probe-model.mjs ./test-image.jpg
 *
 * 无 key 时打印配置指引并以退出码 0 结束(先例:tests/samples-live.js)。
 * 依赖:Node.js >= 18(内置 fetch),零 npm 依赖。
 */

import { readFileSync } from "node:fs";
import { basename, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPT_PATH = resolve(SCRIPT_DIR, "prompts/single-image.md");
const TIMEOUT_MS = 60_000;

/** 智谱图片接口限制(docs/experiments/issue3-v0-model-report.md 一节):
 *  格式 jpg/png/jpeg,单张 ≤5M,像素 ≤6000×6000。阿里限制更宽,按两者取交集做前置校验。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png"]);

const PROVIDERS = {
  zhipu: {
    label: "智谱 BigModel(选型报告主选,默认)",
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4.6v-flash", // 免费(2026-10-10 定价页);可用 MODEL 覆盖
    keyEnv: "BIGMODEL_API_KEY",
    keyHint: "https://bigmodel.cn 控制台 → API Keys 页创建",
  },
  dashscope: {
    label: "阿里云百炼(对照/备胎)",
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", // 旧域名,文档注明仍可用;401/404 时按报告「待验证」第 3 条换 workspace 专属域名
    model: "qwen3.8-flash",
    keyEnv: "DASHSCOPE_API_KEY",
    keyHint: "阿里云百炼控制台 → API-KEY(注意地域绑定,跨地域 401)",
  },
};

function fail(message) {
  console.error(`[probe-model] ${message}`);
  process.exit(1);
}

function printGuidanceAndExitOk(providers, providerName) {
  console.log("[probe-model] 未检测到 API key——这是配置指引,不是失败。");
  console.log("");
  for (const [name, p] of Object.entries(providers)) {
    const mark = name === providerName ? "(当前默认)" : "";
    console.log(`  ${p.label}${mark}`);
    console.log(`    1) 获取 key:${p.keyHint}`);
    console.log(`    2) export ${p.keyEnv}=<你的key>`);
    console.log(`    3) PROVIDER=${name} node probe-model.mjs <测试图路径>`);
    console.log("");
  }
  console.log("  测试图要求:jpg/jpeg/png、≤5MB;必须是非真实家庭影像(隐私红线)。");
  console.log("  已退出(码 0)。配置好 key 后重跑即可。");
  process.exit(0);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt") args.prompt = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--provider") args.provider = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

function help() {
  console.log(`用法: node probe-model.mjs <测试图路径> [选项]

选项:
  --provider NAME   zhipu(默认)| dashscope | custom
  --model ID        覆盖默认模型(默认:zhipu=glm-4.6v-flash,dashscope=qwen3.8-flash)
  --prompt PATH     prompt 模板路径(默认 prompts/single-image.md)
  --help            本帮助

环境变量(密钥绝不硬编码、绝不打印):
  PROVIDER          服务商选择,同 --provider
  MODEL             模型覆盖,同 --model
  BIGMODEL_API_KEY  智谱 key(PROVIDER=zhipu)
  DASHSCOPE_API_KEY 阿里 key(PROVIDER=dashscope)
  API_URL           PROVIDER=custom 时必填(OpenAI 兼容 chat/completions 地址)
  API_KEY_ENV       PROVIDER=custom 时必填(读哪个环境变量拿 key)`);
}

function mimeOf(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  return null;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    help();
    process.exit(args._.length === 0 && !args.help ? 1 : 0);
  }

  const providerName = args.provider || process.env.PROVIDER || "zhipu";
  if (providerName === "custom") {
    const url = process.env.API_URL;
    const model = args.model || process.env.MODEL;
    const keyEnv = process.env.API_KEY_ENV;
    if (!url || !model || !keyEnv) {
      fail("PROVIDER=custom 需要 API_URL、MODEL、API_KEY_ENV 三个环境变量(见 --help)。");
    }
    PROVIDERS.custom = {
      label: `自定义端点(${url})`,
      url,
      model,
      keyEnv,
      keyHint: "自行确认该端点的 key 获取方式",
    };
  } else if (!PROVIDERS[providerName]) {
    fail(`未知 PROVIDER:${providerName}(可选 zhipu | dashscope | custom)。`);
  }

  const provider = PROVIDERS[providerName];
  const model = args.model || process.env.MODEL || provider.model;
  const apiKey = process.env[provider.keyEnv];

  if (!apiKey) {
    printGuidanceAndExitOk(PROVIDERS, providerName);
  }

  const imagePath = resolve(args._[0]);
  const mime = mimeOf(imagePath);
  if (!mime || !ALLOWED_MIME.has(mime)) {
    fail(`图片格式不支持:${basename(imagePath)}。仅 jpg/jpeg/png(智谱接口限制,见调研报告)。`);
  }
  let imageBytes;
  try {
    imageBytes = readFileSync(imagePath);
  } catch (err) {
    fail(`读取图片失败:${imagePath}(${err.code || err.message})`);
  }
  if (imageBytes.byteLength > MAX_IMAGE_BYTES) {
    fail(`图片 ${(imageBytes.byteLength / 1048576).toFixed(1)}MB 超过 5MB 上限(智谱接口限制)。请压缩后重试。`);
  }

  const promptPath = resolve(args.prompt || DEFAULT_PROMPT_PATH);
  let promptText;
  try {
    promptText = readFileSync(promptPath, "utf8");
  } catch {
    fail(`读取 prompt 模板失败:${promptPath}`);
  }

  const body = {
    model,
    temperature: 0.1,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: promptText },
          { type: "image_url", image_url: { url: `data:${mime};base64,${imageBytes.toString("base64")}` } },
        ],
      },
    ],
  };

  const startedAt = Date.now();
  console.log(`[probe-model] provider=${providerName} model=${model} image=${basename(imagePath)} (${(imageBytes.byteLength / 1024).toFixed(0)}KB)`);
  console.log(`[probe-model] prompt=${promptPath}`);
  console.log("[probe-model] 发送请求(图片以 base64 内联,不落日志)…");

  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    response = await fetch(provider.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`, // 只进请求头,绝不打印
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    if (err.name === "AbortError") {
      fail(`请求超时(>${TIMEOUT_MS / 1000}s)。检查网络或换端点。`);
    }
    fail(`网络错误:${err.message}`);
  }

  const elapsed = Date.now() - startedAt;
  const responseText = await response.text();

  console.log(`[probe-model] HTTP ${response.status} ${response.statusText || ""} 耗时 ${elapsed}ms`);

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    console.log("[probe-model] 响应不是 JSON,原文前 2000 字:");
    console.log(responseText.slice(0, 2000));
    process.exit(1);
  }

  if (!response.ok) {
    // 只回显错误结构与 message,不回显请求头
    console.log("[probe-model] 接口返回错误:");
    console.log(JSON.stringify({ error: parsed.error ?? parsed, usage: parsed.usage }, null, 2).slice(0, 2000));
    process.exit(1);
  }

  const content = parsed?.choices?.[0]?.message?.content;
  console.log("[probe-model] —— 模型回复原文 ——");
  console.log(typeof content === "string" ? content : JSON.stringify(content, null, 2));

  const candidates = extractJson(typeof content === "string" ? content : JSON.stringify(content));
  if (candidates && Array.isArray(candidates.items)) {
    console.log(`[probe-model] —— 解析出 ${candidates.items.length} 个物品候选(候选≠事实,不写 items)——`);
  } else {
    console.log("[probe-model] 未能从回复中解析出 items JSON——记录原文,人工判断(prompt 或模型问题)。");
  }

  if (parsed.usage) {
    console.log("[probe-model] 用量:", JSON.stringify(parsed.usage));
  }
  console.log(`[probe-model] 完成。总耗时 ${Date.now() - startedAt}ms。`);
}

main();
