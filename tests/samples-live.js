#!/usr/bin/env node
"use strict";

/*
 * 样例实测脚本(npm run samples:live):
 * - 未设置环境变量 DEEPSEEK_API_KEY:打印操作指引,退出码 0;
 * - 已设置:逐条真实调用 extractDraft 的 lib(lib/deepseek.js 经 handler 驱动),
 *   与样例 expect 对比,把 Markdown 结果表写入 docs/samples-evidence.md;
 *   存在失败样例时退出码 1,否则 0。
 * API key 只从环境变量读取,绝不写入代码、样例或日志。
 */

const fs = require("node:fs");
const nodePath = require("node:path");

const ROOT = nodePath.join(__dirname, "..");
const SAMPLES_DIR = nodePath.join(__dirname, "fixtures", "samples");
const EVIDENCE_PATH = nodePath.join(ROOT, "docs", "samples-evidence.md");
const { handler } = require(nodePath.join(ROOT, "cloudfunctions", "extractDraft", "lib", "handler"));
const { callDeepSeek } = require(nodePath.join(ROOT, "cloudfunctions", "extractDraft", "lib", "deepseek"));

function loadSamples() {
  return fs
    .readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(nodePath.join(SAMPLES_DIR, f), "utf8")));
}

function brief(result) {
  if (!result) return "无响应";
  if (result.ok === true) {
    if (result.needs_split) return "needs_split";
    return "draft " + JSON.stringify(result.draft);
  }
  return String(result.error);
}

function compareExpect(expect, result) {
  if (expect.draft) {
    if (!result || result.ok !== true || !result.draft) {
      return { pass: false, diff: "期望 draft,实际 " + brief(result) };
    }
    const diffs = [];
    for (const key of ["name", "location_text", "certain", "qualifiers"]) {
      const expected = expect.draft[key];
      const actual = result.draft[key];
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        diffs.push(key + ":期望 " + JSON.stringify(expected) + " / 实际 " + JSON.stringify(actual));
      }
    }
    return { pass: diffs.length === 0, diff: diffs.join(";") };
  }
  if (expect.needs_split) {
    const pass = !!(result && result.ok === true && result.needs_split === true);
    return { pass, diff: pass ? "" : "期望 needs_split,实际 " + brief(result) };
  }
  const pass = !!(result && result.ok === false && result.error === expect.error);
  return { pass, diff: pass ? "" : "期望 error " + expect.error + ",实际 " + brief(result) };
}

function writeEvidence(rows, failedCount) {
  const passCount = rows.length - failedCount;
  const lines = [];
  lines.push("# 样例实测证据(extractDraft)");
  lines.push("");
  lines.push("- 生成时间:" + new Date().toISOString());
  lines.push(
    "- 调用方式:tests/samples-live.js 真实调用 https://api.deepseek.com/chat/completions(model deepseek-flash,thinking disabled,20 秒超时)"
  );
  lines.push("- 样例总数:" + rows.length + ",成功:" + passCount + ",失败:" + failedCount);
  lines.push("");
  lines.push("| 样例 | 类别 | 结果 | 差异 |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of rows) {
    lines.push(
      "| " + row.id + " | " + row.category + " | " + (row.pass ? "成功" : "失败") + " | " + (row.diff || "无") + " |"
    );
  }
  lines.push("");
  fs.mkdirSync(nodePath.dirname(EVIDENCE_PATH), { recursive: true });
  fs.writeFileSync(EVIDENCE_PATH, lines.join("\n"), "utf8");
}

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.log("未检测到环境变量 DEEPSEEK_API_KEY,跳过真实调用(退出码 0)。");
    console.log("");
    console.log("操作指引:");
    console.log("  1. 在 DeepSeek 开放平台(https://platform.deepseek.com)创建 API Key;");
    console.log("  2. 在终端设置环境变量:export DEEPSEEK_API_KEY=sk-xxxxxxxx;");
    console.log("  3. 重新运行:npm run samples:live");
    console.log("  4. Markdown 结果表会写入 docs/samples-evidence.md;退出码 1 表示存在失败样例。");
    console.log("");
    console.log("提醒:云函数部署时请把 Key 配置到云开发环境变量 DEEPSEEK_API_KEY,不要写进代码、样例或日志。");
    process.exit(0);
  }

  const samples = loadSamples();
  const rows = [];
  let failed = 0;
  for (const sample of samples) {
    process.stdout.write("样例 " + sample.id + "(" + (sample.category || "") + ")… ");
    let result = null;
    try {
      result = await handler(
        { text: sample.text },
        {
          callLLM: (promptText) => callDeepSeek(promptText, apiKey, 20000),
          logger: () => {},
        }
      );
    } catch (e) {
      result = { ok: false, error: "EXCEPTION", message: String((e && e.message) || e) };
    }
    const cmp = compareExpect(sample.expect, result);
    rows.push({ id: sample.id, category: sample.category || "", pass: cmp.pass, diff: cmp.diff });
    console.log(cmp.pass ? "成功" : "失败 " + (cmp.diff || ""));
    if (!cmp.pass) failed++;
  }

  writeEvidence(rows, failed);
  console.log("");
  console.log("共 " + rows.length + " 条,成功 " + (rows.length - failed) + ",失败 " + failed);
  console.log("结果表已写入 " + EVIDENCE_PATH);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("samples-live 执行异常:", e);
  process.exit(1);
});
