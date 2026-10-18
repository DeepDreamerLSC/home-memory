#!/usr/bin/env node
"use strict";

/*
 * AI Eval runner(#83 E0-C;真跑基线由运行阶段执行,本脚本是可复跑资产)。
 *
 * 用法:
 *   node scripts/eval/run.js --set dev --out docs/eval/2026-10-18-dev-local.md
 *   node scripts/eval/run.js --set val --out docs/eval/2026-10-18-val-local.md
 *   node scripts/eval/run.js --set all --out docs/eval/2026-10-18-all-local.md
 *   node scripts/eval/run.js --set dev --out /tmp/smoke.md --limit 2   # 自测 smoke(小样本)
 * 报告 .md 旁自动落同名 .json 结果文件(单例记录+汇总统计;同样只含隐私安全字段)。
 * 可选:--timeout-ms <n>(默认 60000;亦尊重 LOCAL_LLM_TIMEOUT_MS)。
 * --set 不含 legacy-contract(铁律①:v1 历史合同存档不参评)。
 *
 * 每例两路(铁律②:归因分层,缺一不可):
 *   ① 生产链:handler(protocol:2)/ locationSplit / draftEditParse,注入
 *      deps.callLocalLLM=本地 A3B、deps.callLLM=即抛 stub(评测禁用 DeepSeek 降级:
 *      本地引擎失败如实记 local_engine_failed,绝不真调 DS);引擎回调处顺带截获
 *      生产链实际发出的首份 prompt 与首答(retry 计数、采样一致性核对用,只留内存)。
 *   ② 模型原始:callLocalLLM 直调同款首份 prompt + 裸 JSON 解析(无重试、无修补、
 *      无服务端硬门),用「模型层 essentials」(按任务改写路径)单独判分。
 *      生产 PASS 而模型层不过 = 修补救回 → 修复贡献统计。
 *
 * 判分(tests/fixtures/eval/README.md §2 语义):essentials 全过=PASS / 部分过=
 * PARTIAL / 全不过或形状崩(ok!==true、抛异常)=FAIL。模型层另有三态:
 * unparseable=裸解析失败(生产若过=重试救的)、unavailable=直调引擎失败
 * (归因不完整,不计修补救回)、skipped=生产链未触引擎。
 *
 * 铁律③:本 runner 只生成「新冻结基线」报告,不与任何历史结果比较、不宣称
 * 修复前后提升;报告头部固定携带此声明与样例集版本号。
 *
 * 密钥与隐私纪律(仓库 public):token 只在运行时从环境变量 LOCAL_LLM_TOKEN 或
 * ~/Desktop/work/hm-llm-infra/.token 读取(代码只允许出现该路径字符串,绝不出现
 * token 内容),绝不打印;报告/控制台只落样例 id、判定、失败字段路径+差异码、
 * expect(expect 是仓库内合成样例资产)、engine、耗时、样例集版本——绝不落
 * prompt 原文、输入原文、模型输出原文、位置/物品实际内容。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const EVAL_DIR = path.join(ROOT, "tests", "fixtures", "eval");
const { handler, locationSplit, draftEditParse } = require(
  path.join(ROOT, "cloudfunctions", "extractDraft", "lib", "handler")
);
const { callLocalLLM } = require(
  path.join(ROOT, "cloudfunctions", "extractDraft", "lib", "local-llm")
);

/** 本地推理 token 文件(纪律:代码只允许出现该路径字符串) */
const TOKEN_FILE = path.join(os.homedir(), "Desktop", "work", "hm-llm-infra", ".token");
/** 引擎默认值与 /tmp 复现先例同款,均可经环境变量覆盖;base 与 lib/local-llm.js 注释中的公网示例一致 */
const DEFAULT_LOCAL_LLM_BASE = "https://llm.chiraliumai.cn/v1";
const DEFAULT_LOCAL_LLM_MODEL = "/Users/linsuchang/Desktop/work/models/Qwen3.6-35B-A3B-4bit";
const DEFAULT_TIMEOUT_MS = 60000;
/** 模型层裸锚定门的段数/段长上限(镜像 handler.js LOC_SPLIT_MAX_SEGMENTS / SEGMENT_MAX) */
const LOC_BARE_MAX_SEGMENTS = 6;
const LOC_BARE_SEGMENT_MAX = 30;

const TASK_LABEL = { extract: "提取v2", locsplit: "位置拆分", editparse: "语音编辑" };

/* ================= CLI ================= */

function parseArgs(argv) {
  const out = { set: null, out: null, limit: 0, timeoutMs: 0, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--set") out.set = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else fail(2, "未知参数:" + a + "(--help 看用法)");
  }
  if (out.help) {
    process.stdout.write(
      [
        "用法:node scripts/eval/run.js --set dev|val|all --out docs/eval/<日期>-<set>-local.md [--limit n] [--timeout-ms n]",
        "  --set        dev / val / all(dev+val;legacy-contract 永不参评)",
        "  --out        报告输出路径(缺省 docs/eval/<今天>-<set>-local.md)",
        "  --limit      只跑前 n 例(自测 smoke);按任务轮转选取,小样本也盖住三任务",
        "  --timeout-ms 单次引擎调用超时(默认 " + DEFAULT_TIMEOUT_MS + ")",
        "  token 只从 env LOCAL_LLM_TOKEN 或 " + TOKEN_FILE + " 读取,绝不打印",
        "",
      ].join("\n")
    );
    process.exit(0);
  }
  if (out.set !== "dev" && out.set !== "val" && out.set !== "all") {
    fail(2, "--set 必须是 dev|val|all");
  }
  if (argv.indexOf("--limit") !== -1 && (!isFinite(out.limit) || out.limit < 1)) {
    fail(2, "--limit 必须是正整数");
  }
  if (argv.indexOf("--timeout-ms") !== -1 && (!isFinite(out.timeoutMs) || out.timeoutMs < 1000)) {
    fail(2, "--timeout-ms 必须 ≥1000");
  }
  if (!out.out) {
    out.out = path.join(ROOT, "docs", "eval", todayLocal() + "-" + out.set + "-local.md");
  }
  return out;
}

function fail(code, msg) {
  process.stderr.write("[eval-run] " + msg + "\n");
  process.exit(code);
}

function todayLocal() {
  const d = new Date();
  const pad = (n) => (n < 10 ? "0" + n : String(n));
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/* ================= 引擎配置(密钥纪律见文件头) ================= */

function loadEngineConfig(explicitTimeoutMs) {
  const token = process.env.LOCAL_LLM_TOKEN || readFileTrim(TOKEN_FILE);
  if (!token) {
    process.stderr.write(
      [
        "[eval-run] 未取到本地推理 token:环境变量 LOCAL_LLM_TOKEN 未设,且读不到 " + TOKEN_FILE,
        "[eval-run] 二者任一可用即可;token 绝不会被打印或写入任何文件。",
        "",
      ].join("\n")
    );
    process.exit(2);
  }
  const base = process.env.LOCAL_LLM_BASE || DEFAULT_LOCAL_LLM_BASE;
  const model = process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_LLM_MODEL;
  // local-llm.js 调用时读环境变量;此处注入(token 只进本进程环境,不落盘)。
  process.env.LOCAL_LLM_BASE = base;
  process.env.LOCAL_LLM_MODEL = model;
  process.env.LOCAL_LLM_TOKEN = token;
  const envT = Number(process.env.LOCAL_LLM_TIMEOUT_MS);
  const timeoutMs =
    explicitTimeoutMs && explicitTimeoutMs >= 1000
      ? explicitTimeoutMs
      : isFinite(envT) && envT >= 1000
        ? envT
        : DEFAULT_TIMEOUT_MS;
  return { base, model, timeoutMs };
}

function readFileTrim(p) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch (e) {
    return "";
  }
}

/* ================= 样例装载 ================= */

function loadSet(name) {
  const dir = path.join(EVAL_DIR, name);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

/** --limit 小样本也要盖住三任务:按任务轮转选取 */
function selectCases(samples, limit) {
  if (!limit || limit >= samples.length) return samples.slice();
  const queues = { extract: [], locsplit: [], editparse: [] };
  for (const s of samples) queues[s.task].push(s);
  const order = ["extract", "locsplit", "editparse"];
  const picked = [];
  while (picked.length < limit && order.some((n) => queues[n].length > 0)) {
    for (const n of order) {
      if (picked.length >= limit) break;
      const s = queues[n].shift();
      if (s) picked.push(s);
    }
  }
  return picked;
}

function samplesVersion() {
  const m = readFileTrim(path.join(EVAL_DIR, "README.md")).match(/- 版本:\*\*(v\d+)\*\*/);
  return m ? m[1] : "unknown";
}

/* ================= 判分内核(README §2 语义;导出供离线自检) ================= */

function resolvePath(root, p) {
  if (root === undefined || root === null) return null;
  let cur = root;
  for (const part of p.split(".")) {
    if (cur === null || cur === undefined) return null;
    cur = cur[part];
  }
  return cur === undefined ? null : cur;
}

function sortish(v) {
  if (Array.isArray(v)) return v.map(sortish);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortish(v[k]);
    return o;
  }
  return v;
}

function deepEqual(a, b) {
  return JSON.stringify(sortish(a)) === JSON.stringify(sortish(b));
}

/** ops:equals / contains / null(+模型层专用 non_null);失败给差异码,不带实际值内容 */
function judgeOne(target, e) {
  const v = resolvePath(target, e.path);
  if (e.op === "null") return v === null ? null : "expect_null_got_value";
  if (e.op === "non_null") return v !== null ? null : "expect_non_null_got_null";
  if (e.op === "equals") {
    if (deepEqual(v, e.expect)) return null;
    return v === null && e.expect !== null ? "missing_or_null" : "value_diff";
  }
  if (e.op === "contains") {
    if (typeof v === "string" && typeof e.expect === "string" && v.includes(e.expect)) return null;
    if (Array.isArray(v) && v.some((el) => deepEqual(el, e.expect))) return null;
    return "not_contained";
  }
  return "unknown_op";
}

function judgeEssentials(target, essentials) {
  const failed = [];
  for (const e of essentials) {
    const code = judgeOne(target, e);
    if (code) failed.push({ path: e.path, op: e.op, expect: e.expect, code });
  }
  const passedCount = essentials.length - failed.length;
  const verdict = failed.length === 0 ? "PASS" : passedCount > 0 ? "PARTIAL" : "FAIL";
  return { verdict, failed, passedCount, total: essentials.length };
}

function shapeErrorCode(res, exception) {
  if (exception) return "EXCEPTION:" + String(exception).slice(0, 60);
  if (!res || typeof res !== "object") return "NO_RESPONSE";
  if (res.ok !== true) return String(res.error || "NOT_OK");
  return null;
}

/**
 * 模型层 essentials:同一最小可判集按任务改写到模型原始输出形状上。
 * 每项带 srcPath(原 essentials 路径)供「生产过/模型层挂」的逐字段配对。
 * - extract:drafts→items、truncated→has_more;若样例期望 remind_converted=true
 *   (服务端闭集换算指纹),模型层的正确行为是「只标 vague、绝不折算」——remind
 *   四字段改判 null、remind_vague_quote 改判 non_null(README §6;prompt 规则 7/8)。
 * - locsplit:只判 path 根(fallback 是生产层概念),另加裸锚定门 locBareAnchorOk。
 * - editparse:字段同名,原样判模型原始 parsed;服务端强制 needs_pick/降级即修补差。
 */
function modelLayerEssentials(sample) {
  if (sample.task === "extract") {
    const hasConverted = sample.essentials.some(
      (e) => /(^|\.)remind_converted$/.test(e.path) && e.op === "equals" && e.expect === true
    );
    return sample.essentials.map((e) => {
      let p = e.path.replace(/^drafts\./, "items.");
      if (p === "truncated") p = "has_more";
      if (hasConverted) {
        if (/^items\.\d+\.remind_(at|kind|quote|converted)$/.test(p)) {
          return { path: p, op: "null", srcPath: e.path };
        }
        if (/^items\.\d+\.remind_vague_quote$/.test(p) && e.op === "null") {
          return { path: p, op: "non_null", srcPath: e.path };
        }
      }
      return { path: p, op: e.op, expect: e.expect, srcPath: e.path };
    });
  }
  if (sample.task === "locsplit") {
    return sample.essentials
      .filter((e) => e.path.split(".")[0] === "path")
      .map((e) => ({ path: e.path, op: e.op, expect: e.expect, srcPath: e.path }));
  }
  return sample.essentials.map((e) => ({ path: e.path, op: e.op, expect: e.expect, srcPath: e.path }));
}

/** 裸 JSON 解析(直调后无重试无修补:截首 { 末 } 再 parse;失败=undefined) */
function parseBareJson(text) {
  if (typeof text !== "string") return undefined;
  const t = text.trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s === -1 || e <= s) return undefined;
  try {
    return JSON.parse(t.slice(s, e + 1));
  } catch (err) {
    return undefined;
  }
}

/** 模型层裸锚定门(handler 段级硬门的镜像,不含方位词修补):逐字子串+有序+段数/段长 */
function locBareAnchorOk(userText, segments) {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > LOC_BARE_MAX_SEGMENTS) {
    return false;
  }
  let from = 0;
  for (const seg of segments) {
    if (typeof seg !== "string") return false;
    const t = seg.trim();
    const len = Array.from(t).length;
    if (len < 1 || len > LOC_BARE_SEGMENT_MAX) return false;
    const idx = userText.indexOf(t, from);
    if (idx === -1) return false;
    from = idx + t.length;
  }
  return true;
}

/* ================= 单例执行(两路) ================= */

async function runCase(sample, cfg) {
  const rec = {
    id: sample.id,
    task: sample.task,
    set: sample.id.indexOf("dev-") === 0 ? "dev" : "val",
    prod: { verdict: null, failed: [], shapeError: null, ms: null, engine: null },
    model: { status: null, verdict: null, failed: [], ms: null, anchorOk: null },
    flags: {},
  };

  const prompts = []; // 截获生产链发出的 prompt(只留内存:②直调复用首份 + retry 计数)
  let firstRaw = null; // 生产链引擎首答原文(只留内存,做采样一致性核对;绝不落盘)
  let dsFallbackAttempted = false;
  const deps = {
    callLocalLLM: async (p) => {
      prompts.push(p); // 先记再调:引擎失败时②仍可尝试直调,区分「引擎挂」与「偶发」
      const outText = await callLocalLLM(p, cfg.timeoutMs);
      if (firstRaw === null) firstRaw = outText;
      return outText;
    },
    callLLM: async () => {
      dsFallbackAttempted = true; // 评测禁用 DeepSeek:本地引擎失败即记,不真降级
      throw new Error("DEEPSEEK_DISABLED_IN_EVAL");
    },
    logger: () => {},
  };
  if (sample.deps) {
    deps.today = () => new Date(sample.deps.today + "T12:00:00");
    deps.anchorToday = () => sample.deps.anchorToday;
  }

  /* ① 生产链 */
  let res = null;
  let prodException = null;
  const t0 = Date.now();
  try {
    if (sample.task === "extract") res = await handler(sample.input, deps);
    else if (sample.task === "locsplit") res = await locationSplit(sample.input, deps);
    else res = await draftEditParse(sample.input, deps);
  } catch (e) {
    prodException = (e && e.message) || String(e);
  }
  rec.prod.ms = Date.now() - t0;
  rec.prod.shapeError = shapeErrorCode(res, prodException);
  rec.prod.engine = res && res.engine ? res.engine : null;
  rec.prod.judged = judgeEssentials(res || {}, sample.essentials);
  rec.prod.verdict = rec.prod.shapeError ? "FAIL" : rec.prod.judged.verdict;
  if (dsFallbackAttempted) rec.flags.local_engine_failed = true;
  if (prompts.length > 1) rec.flags.retry_used = true;

  /* ② 模型原始:直调同款首份 prompt + 裸 JSON 解析(无重试无修补) */
  let rawParsed = null; // ②的裸解析结果(只留内存做归因,绝不落盘)
  if (prompts.length === 0) {
    rec.model.status = "skipped"; // 生产链没触引擎(如 INVALID_INPUT):无模型层可判
  } else {
    const t1 = Date.now();
    let rawText = null;
    let rawErr = null;
    try {
      rawText = await callLocalLLM(prompts[0], cfg.timeoutMs);
    } catch (e) {
      rawErr = String((e && e.message) || "ENGINE_ERROR").slice(0, 40);
    }
    rec.model.ms = Date.now() - t1;
    if (rawErr) {
      rec.model.status = "unavailable"; // 引擎层失败 ≠ 模型质量失败:归因不完整
      rec.flags.raw_engine_error = rawErr;
    } else {
      const parsed = parseBareJson(rawText);
      if (
        parsed === undefined ||
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        rec.model.status = "unparseable";
      } else {
        rawParsed = parsed;
        rec.model.status = "parsed";
        const mEss = modelLayerEssentials(sample);
        const judged = judgeEssentials(parsed, mEss);
        let extraFailed = [];
        if (sample.task === "locsplit") {
          rec.model.anchorOk = locBareAnchorOk(
            String(sample.input.text || "").trim(),
            parsed.path
          );
          if (!rec.model.anchorOk) {
            extraFailed = [
              { path: "path(裸锚定)", op: "anchor", expect: null, code: "anchor_fail", srcPath: "path" },
            ];
          }
        }
        rec.model.failed = judged.failed.concat(extraFailed);
        rec.model.verdict =
          rec.model.failed.length === 0 ? "PASS" : judged.passedCount > 0 ? "PARTIAL" : "FAIL";
        // 采样一致性:temperature=0.1 下生产首答与②直调可能不同;只记布尔,不落内容
        const firstParsed = firstRaw === null ? undefined : parseBareJson(firstRaw);
        if (firstParsed !== undefined) {
          rec.flags.raw_deviation = !deepEqual(firstParsed, parsed);
        }
      }
    }
  }

  /* 归因/修补指纹(生产 PASS 而模型层挂 = 修补救回;各任务另记专属指纹) */
  const prodOk = res && res.ok === true;
  if (prodOk && rawParsed !== null) {
    if (sample.task === "locsplit") {
      if (res.fallback === true) rec.flags.loc_fallback = true;
      else if (!deepEqual(rawParsed.path ?? null, Array.isArray(res.path) ? res.path : null)) {
        rec.flags.loc_repair_rewrote = true; // 段相同靠修补改写(方位词合并/前移)
      }
    } else if (sample.task === "editparse") {
      if (rawParsed.needs_pick !== true && res.needs_pick === true) {
        rec.flags.ed_coerced_pick = true; // 服务端强制 needs_pick(draft_id 对不上候选)
      }
      if (rawParsed.intent !== res.intent) rec.flags.ed_intent_changed = true;
    }
  }
  if (prodOk && sample.task === "extract" && Array.isArray(res.drafts)) {
    if (res.drafts.some((d) => d && d.remind_converted === true)) {
      rec.flags.ex_server_converted = true; // 服务端闭集换算指纹(README §6)
    }
  }
  // 逐字段修补差:生产过、模型层挂的 essentials(srcPath 配对)
  if (rec.model.status === "parsed") {
    const prodFailed = new Set(rec.prod.judged.failed.map((f) => f.path));
    rec.flags.repair_flipped = rec.model.failed
      .filter((f) => f.srcPath && !prodFailed.has(f.srcPath))
      .map((f) => f.srcPath);
  }
  // 修补救回(修复贡献统计的分子):生产 PASS 且模型层可判而不过
  rec.rescued =
    rec.prod.verdict === "PASS" &&
    rec.model.status === "parsed" &&
    rec.model.verdict !== "PASS";

  return rec;
}

/* ================= 汇总与报告 ================= */

function modelCell(rec) {
  if (rec.model.status === null || rec.model.status === "skipped") return "SKIP";
  if (rec.model.status === "unavailable") return "UNAVAIL";
  if (rec.model.status === "unparseable") return "UNPARSE";
  return rec.model.verdict;
}

function flagsCell(rec) {
  const parts = [];
  if (rec.flags.local_engine_failed) parts.push("本地引擎失败");
  if (rec.flags.retry_used) parts.push("重试");
  if (rec.flags.raw_engine_error) parts.push("直调失败");
  if (rec.flags.raw_deviation) parts.push("两路采样不一致");
  if (rec.flags.loc_fallback) parts.push("兜底单段");
  if (rec.flags.loc_repair_rewrote) parts.push("修补改写段");
  if (rec.flags.ed_coerced_pick) parts.push("服务端强制点选");
  if (rec.flags.ed_intent_changed) parts.push("服务端改intent");
  if (rec.flags.ex_server_converted) parts.push("服务端换算");
  if (rec.rescued) parts.push("修补救回");
  return parts.length > 0 ? parts.join(",") : "-";
}

function mdEscape(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function cap(s, n) {
  const t = String(s);
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function expectText(e) {
  if (e.op === "null") return "";
  return cap(mdEscape(JSON.stringify(e.expect)), 100);
}

function groupRecords(recs) {
  const groups = [];
  const keys = new Set(recs.map((r) => r.set + "/" + r.task));
  for (const set of ["dev", "val"]) {
    for (const task of ["extract", "locsplit", "editparse"]) {
      const k = set + "/" + task;
      if (!keys.has(k)) continue;
      groups.push({
        key: k,
        set,
        task,
        list: recs.filter((r) => r.set === set && r.task === task).sort((a, b) => (a.id < b.id ? -1 : 1)),
      });
    }
  }
  return groups;
}

function statLine(list) {
  const pass = list.filter((r) => r.prod.verdict === "PASS").length;
  const partial = list.filter((r) => r.prod.verdict === "PARTIAL").length;
  const fail = list.filter((r) => r.prod.verdict === "FAIL").length;
  const modelPass = list.filter((r) => r.model.verdict === "PASS").length;
  const rescued = list.filter((r) => r.rescued).length;
  const rate = list.length === 0 ? "-" : (pass / list.length * 100).toFixed(0) + "%";
  return { pass, partial, fail, modelPass, rescued, rate };
}

/** 需人工复核 = 生产层非 PASS(PARTIAL/FAIL):机器判非全过,需按各例「人工判据」复核 */
function needsHumanIds(recs) {
  return recs.filter((r) => r.prod.verdict !== "PASS").map((r) => r.id);
}

function buildReport(ctx) {
  const { args, cfg, version, recs, totalMs, chosenCount } = ctx;
  const sets = args.set === "all" ? "dev+val" : args.set;
  const lines = [];
  lines.push("# 本地 A3B 评测报告:" + sets + " 集(样例集 " + version + ")");
  lines.push("");
  lines.push(
    "> 本报告为**新冻结基线**(" + todayLocal() + ",本地 A3B via 隧道),不作任何与历史质量的比较论断——历史不可重放(#83 评审铁律 3)。"
  );
  lines.push("");
  lines.push("- 生成:" + new Date().toISOString() + ",总耗时 " + totalMs + "ms,共 " + recs.length + " 例" + (args.limit ? "(--limit " + args.limit + ",按任务轮转选取)" : "") + "。");
  lines.push("- 命令:node scripts/eval/run.js --set " + args.set + " --out " + args.out + (args.limit ? " --limit " + args.limit : ""));
  lines.push("- 引擎:local(mlx_lm.server," + path.basename(cfg.model) + ",OpenAI 兼容);温度/max_tokens 由 lib/local-llm.js 固定(temperature 0.1);单调用超时 " + cfg.timeoutMs + "ms。");
  lines.push("- DeepSeek 降级在评测中禁用(注入即抛 stub):本地引擎失败如实记「本地引擎失败」,不真调 DS。");
  lines.push("- 铁律①:legacy-contract(v1 历史合同)不参评;铁律②:每例双判——「生产链终态(含修补)」与「模型原始(直调+裸解析)」;铁律③:本报告只立新冻结基线,不与历史结果比较、不宣称修复前后提升。");
  lines.push("- 隐私:本报告不含 prompt/输入/模型输出原文与位置物品实际内容;失败明细=字段路径+差异码+expect(仓库内合成样例资产)。");
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push("| 分组 | n | PASS | PARTIAL | FAIL | 生产通过率 | 模型层PASS | 修补救回 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const g of groupRecords(recs)) {
    const s = statLine(g.list);
    lines.push(
      "| " + g.set + "/" + TASK_LABEL[g.task] + " | " + g.list.length + " | " + s.pass + " | " + s.partial + " | " + s.fail + " | " + s.rate + " | " + s.modelPass + " | " + s.rescued + " |"
    );
  }
  const all = statLine(recs);
  lines.push(
    "| 合计 | " + recs.length + " | " + all.pass + " | " + all.partial + " | " + all.fail + " | " + all.rate + " | " + all.modelPass + " | " + all.rescued + " |"
  );
  lines.push("");
  lines.push("说明:「模型层PASS」分母含可判例(parsed);UNPARSE(裸解析失败)/UNAVAIL(直调引擎失败)/SKIP 不计其中,见明细表。生产通过率=PASS/(PASS+PARTIAL+FAIL)。");
  lines.push("");
  const human = needsHumanIds(recs);
  lines.push(
    "需人工复核:**" + human.length + " 例**" + (human.length ? "(" + human.join(", ") + ")" : "") +
    "——定义:生产层 PARTIAL/FAIL(机器判非全过),需按失败清单中各例「人工判据」复核是模型真错还是 essentials 锁太死。"
  );
  const unavailIds = recs.filter((r) => r.model.status === "unavailable").map((r) => r.id);
  if (unavailIds.length) {
    lines.push(
      "归因不完整(模型层直调引擎失败,不计修补救回):" + unavailIds.length + " 例(" + unavailIds.join(", ") + ")。"
    );
  }
  lines.push("");
  lines.push("## 明细");
  lines.push("");
  for (const g of groupRecords(recs)) {
    lines.push("### " + g.set + " / " + TASK_LABEL[g.task] + "(" + g.list.length + " 例)");
    lines.push("");
    lines.push("| id | 生产层 | 模型层 | engine | 生产ms | 原始ms | 修补/归因标志 |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const r of g.list) {
      lines.push(
        "| " + r.id + " | " + r.prod.verdict + (r.prod.shapeError ? "·" + mdEscape(r.prod.shapeError) : "") + " | " + modelCell(r) + " | " + (r.prod.engine || "-") + " | " + r.prod.ms + " | " + (r.model.ms === null ? "-" : r.model.ms) + " | " + flagsCell(r) + " |"
      );
    }
    lines.push("");
  }
  lines.push("## 失败清单(生产层非 PASS;含人工判据引用)");
  lines.push("");
  const failedRecs = recs.filter((r) => r.prod.verdict !== "PASS");
  if (failedRecs.length === 0) {
    lines.push("(无)");
  }
  for (const r of failedRecs) {
    const sample = ctx.sampleById[r.id];
    lines.push("### " + r.id + "(" + r.set + "/" + TASK_LABEL[r.task] + ")— " + r.prod.verdict);
    lines.push("");
    if (r.prod.shapeError) {
      lines.push("- 形状:" + mdEscape(r.prod.shapeError) + "(生产链未产出可判形状)");
    }
    if (r.prod.shapeError === null || r.prod.judged.failed.length > 0) {
      lines.push("- 缺失 essentials:");
      for (const f of r.prod.judged.failed) {
        lines.push("  - `" + f.path + "` op=" + f.op + (expectText(f) ? " expect=" + expectText(f) : "") + " → 差异码 " + f.code);
      }
    }
    lines.push("- 人工判据:" + cap(mdEscape(sample.human_criteria), 220));
    lines.push(
      "- 归因:模型层=" + modelCell(r) + (r.model.status === "parsed" && r.model.verdict !== "PASS" ? "(模型层未过:" + r.model.failed.map((f) => f.path + ":" + f.code).join(", ") + ")" : "") + ";标志:" + flagsCell(r)
    );
    lines.push("");
  }
  lines.push("## 修复贡献统计(生产 PASS 而模型层可判不过 = 靠修补从错变对)");
  lines.push("");
  const rescuedIds = recs.filter((r) => r.rescued).map((r) => r.id);
  lines.push("- 修补救回合计:**" + rescuedIds.length + " 例**" + (rescuedIds.length ? ":" + rescuedIds.join(", ") : ""));
  const tally = (pred, label) => {
    const ids = recs.filter((r) => r.prod.verdict === "PASS" && pred(r)).map((r) => r.id);
    lines.push("- " + label + ":" + ids.length + " 例" + (ids.length ? "(" + ids.join(", ") + ")" : ""));
  };
  tally((r) => r.flags.retry_used && r.model.status === "unparseable", "坏 JSON 靠带错重试救回");
  tally((r) => r.flags.loc_repair_rewrote, "位置拆分靠方位词修补改写(模型原始段≠终态段)");
  tally((r) => r.flags.ed_coerced_pick, "语音编辑靠服务端强制 needs_pick 收口");
  tally((r) => r.flags.ex_server_converted, "提取靠服务端闭集换算填 remind(模型只标 vague)");
  const flipped = recs.filter((r) => r.flags.repair_flipped && r.flags.repair_flipped.length > 0);
  lines.push(
    "- 逐字段修补差(生产过、模型层挂):" + flipped.length + " 例" + (flipped.length ? "(" + flipped.map((r) => r.id + ":" + r.flags.repair_flipped.join("+")).join("; ") + ")" : "")
  );
  const unavail = recs.filter((r) => r.model.status === "unavailable");
  if (unavail.length) {
    lines.push("- 归因不完整(直调引擎失败,不计入修补救回):" + unavail.map((r) => r.id).join(", "));
  }
  const deviated = recs.filter((r) => r.flags.raw_deviation);
  if (deviated.length) {
    lines.push("- 采样提示:以下例两路(生产首答 vs 直调)输出不一致(temperature 0.1 非确定),归因以两路各自判定为准:" + deviated.map((r) => r.id).join(", "));
  }
  lines.push("");
  return lines.join("\n");
}

/* ================= JSON 结果文件(与 .md 同名 .json;字段同样隐私安全) ================= */

function buildResultsJson(ctx) {
  const { args, cfg, version, recs, totalMs } = ctx;
  const perGroup = groupRecords(recs).map((g) => {
    const s = statLine(g.list);
    return { set: g.set, task: g.task, n: g.list.length, pass: s.pass, partial: s.partial, fail: s.fail, modelPass: s.modelPass, rescued: s.rescued };
  });
  const all = statLine(recs);
  return {
    kind: "home-memory-eval-results",
    baseline_statement:
      "新冻结基线(" + todayLocal() + ",本地 A3B via 隧道);不作任何与历史质量的比较论断——历史不可重放(#83 评审铁律 3)。",
    generated: new Date().toISOString(),
    command: "node scripts/eval/run.js --set " + args.set + " --out " + args.out + (args.limit ? " --limit " + args.limit : ""),
    samples_version: version,
    engine: {
      type: "local-mlx-openai-compat",
      model: path.basename(cfg.model),
      temperature: 0.1,
      timeout_ms: cfg.timeoutMs,
      deepseek_fallback: "disabled(评测注入即抛 stub,本地引擎失败如实记)",
    },
    summary: {
      total: recs.length,
      pass: all.pass,
      partial: all.partial,
      fail: all.fail,
      prod_pass_rate: all.rate,
      model_raw_pass: all.modelPass,
      rescued_by_repair: all.rescued,
      needs_human: needsHumanIds(recs).length,
      needs_human_ids: needsHumanIds(recs),
      attribution_incomplete_ids: recs.filter((r) => r.model.status === "unavailable").map((r) => r.id),
      per_group: perGroup,
    },
    total_ms: totalMs,
    cases: recs,
  };
}

/* ================= main ================= */

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadEngineConfig(args.timeoutMs);
  const sets = args.set === "all" ? ["dev", "val"] : [args.set];
  const samples = [];
  for (const s of sets) samples.push(...loadSet(s));
  if (samples.length === 0) fail(2, "所选集合没有样例:" + sets.join(","));
  const chosen = selectCases(samples, args.limit);
  const version = samplesVersion();
  const t0 = Date.now();
  const recs = [];
  for (let i = 0; i < chosen.length; i++) {
    const s = chosen[i];
    let rec = null;
    try {
      rec = await runCase(s, cfg);
    } catch (e) {
      // runner 自身异常:记 FAIL 继续(报告只落异常码,不落内容)
      rec = {
        id: s.id,
        task: s.task,
        set: s.id.indexOf("dev-") === 0 ? "dev" : "val",
        prod: {
          verdict: "FAIL",
          failed: [],
          shapeError: "RUNNER_EXCEPTION:" + String((e && e.message) || e).slice(0, 60),
          ms: null,
          engine: null,
          judged: { verdict: "FAIL", failed: [], passedCount: 0, total: s.essentials.length },
        },
        model: { status: "skipped", verdict: null, failed: [], ms: null, anchorOk: null },
        flags: {},
        rescued: false,
      };
    }
    recs.push(rec);
    process.stdout.write(
      "[" + (i + 1) + "/" + chosen.length + "] " + rec.id + " " + TASK_LABEL[rec.task] +
        " 生产=" + rec.prod.verdict + (rec.prod.shapeError ? "·" + rec.prod.shapeError : "") +
        " 模型层=" + modelCell(rec) +
        " " + (rec.prod.engine || "-") +
        " " + rec.prod.ms + "ms/" + (rec.model.ms === null ? "-" : rec.model.ms + "ms") +
        " " + flagsCell(rec) + "\n"
    );
  }
  const sampleById = {};
  for (const s of samples) sampleById[s.id] = s;
  const report = buildReport({
    args,
    cfg,
    version,
    recs,
    totalMs: Date.now() - t0,
    chosenCount: chosen.length,
    sampleById,
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, report, "utf8");
  const jsonPath = args.out.replace(/\.md$/, "") + ".json";
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(buildResultsJson({ args, cfg, version, recs, totalMs: Date.now() - t0 }), null, 2),
    "utf8"
  );
  const all = statLine(recs);
  process.stdout.write(
    "\n共 " + recs.length + " 例:PASS " + all.pass + " / PARTIAL " + all.partial + " / FAIL " + all.fail +
    ";修补救回 " + all.rescued + ";需人工复核 " + needsHumanIds(recs).length +
    ";报告已写入 " + args.out + " 与 " + jsonPath + "\n"
  );
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write("[eval-run] 执行异常:" + String((e && e.message) || e).slice(0, 200) + "\n");
    process.exit(1);
  });
}

module.exports = {
  resolvePath,
  deepEqual,
  judgeOne,
  judgeEssentials,
  modelLayerEssentials,
  parseBareJson,
  locBareAnchorOk,
  runCase,
  loadSet,
  selectCases,
  samplesVersion,
};
