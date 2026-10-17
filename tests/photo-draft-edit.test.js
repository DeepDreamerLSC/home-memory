"use strict";

/*
 * 拍照识物(#3)extractDraft.draftEditParse(语音受限编辑解析)离线测试
 * (IMPLEMENTATION §1.2/§4.1,仿 tests/extractDraft-local-llm.test.js 模式)。
 * 只 require cloudfunctions/extractDraft 下的 lib 与入口(stub wx-server-sdk),
 * 零外部依赖、零外网。覆盖:
 * - 三类 intent(edit/add/batch_location)成功形状与 prompt 组装(批次位置/
 *   候选清单/用户输入/「绝不按第N个行号锁定」指令);
 * - 服务端硬门(不信任模型输出):target.draft_id 不在候选清单 → 强制
 *   needs_pick + picks 全量 + edits 清空;edits 字段白名单/长度门/≤3 截断;
 *   needs_pick 与 edits/target 形状互斥;add/batch_location 非法降级 none;
 * - 输入校验:text 去空白 1-200 码点、batch_location 1-200、candidates 1-12、
 *   draft_id ≤32、name 1-50,非法 INVALID_INPUT;
 * - 引擎链:local 成功 engine=local、local 失败/空文本降级 DeepSeek、双失败
 *   AI_UNAVAILABLE、坏 JSON 重试一次仍走同一引擎(质量失败不降级)、未注入
 *   local 只走 DeepSeek 一次(现状锁);
 * - 日志纪律:只记 textLength/candidateCount/elapsedMs/engine/intent/error,
 *   绝不记原文/候选名/edits 内容;
 * - index.js 胶水(stub wx-server-sdk 真加载):draftEditParse 路由走本地引擎
 *   (LOCAL_LLM 三件套指向 127.0.0.1,DEEPSEEK key 缺失也不外呼)。
 */

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const Module = require("node:module");

const { draftEditParse } = require("../cloudfunctions/extractDraft/lib/handler");

const ROOT = path.join(__dirname, "..");

const TEXT = "品客的薯片罐已经空了,放厨房去";
const BATCH_LOCATION = "玄关柜 · 第二层抽屉";
const CANDIDATES = [
  { draft_id: "d-zelda", name: "塞尔达传说:旷野之息" },
  { draft_id: "d-chips", name: "黄色薯片罐" },
  { draft_id: "d-cable", name: "白色数据线" },
];

const EDIT_REPLY = JSON.stringify({
  intent: "edit",
  target: { draft_id: "d-chips", matched_word: "品客的薯片罐" },
  edits: [
    { field: "name", old: "黄色薯片罐", new: "品客薯片罐" },
    { field: "qty_note", old: "(数量不确定)", new: "(空罐)" },
    { field: "location", old: "玄关柜·第二层", new: "厨房" },
  ],
  needs_pick: false,
  picks: [],
});
const ADD_REPLY = JSON.stringify({
  intent: "add",
  added: { name: "五号电池", qty_note: "还有几节" },
  needs_pick: false,
  picks: [],
});
const LOC_REPLY = JSON.stringify({
  intent: "batch_location",
  new_location: "客厅电视柜",
  needs_pick: false,
  picks: [],
});

// ---------- 公共工具 ----------

/* 双引擎脚本 mock:script 项为 Error 则抛错、为字符串则作为模型输出;记录 prompt。 */
function makeEngines(localScript, deepseekScript) {
  const calls = { local: [], deepseek: [] };
  const step = (script, name) => async (prompt) => {
    calls[name].push(prompt);
    const item = script[Math.min(calls[name].length - 1, script.length - 1)];
    if (item instanceof Error) throw item;
    return item;
  };
  return {
    calls,
    callLLM: step(deepseekScript, "deepseek"),
    callLocalLLM: step(localScript, "local"),
  };
}

async function runParse(engines, event, logs) {
  return draftEditParse(event || editEvent(), {
    callLLM: engines ? engines.callLLM : undefined,
    callLocalLLM: engines ? engines.callLocalLLM : undefined,
    logger: (m) => {
      if (logs) logs.push(m);
    },
  });
}

function editEvent(extra) {
  return Object.assign(
    { action: "draftEditParse", text: TEXT, batch_location: BATCH_LOCATION, candidates: CANDIDATES },
    extra
  );
}

// ---------- 三类 intent 成功形状 ----------

test("edit:按内容词锁定候选,逐字段 edits 返回(engine=local,DeepSeek 零请求)", async () => {
  const e = makeEngines([EDIT_REPLY], [new Error("不应被调用")]);
  const res = await runParse(e);
  assert.deepStrictEqual(res, {
    ok: true,
    engine: "local",
    intent: "edit",
    target: { draft_id: "d-chips", matched_word: "品客的薯片罐" },
    edits: [
      { field: "name", old: "黄色薯片罐", new: "品客薯片罐" },
      { field: "qty_note", old: "(数量不确定)", new: "(空罐)" },
      { field: "location", old: "玄关柜·第二层", new: "厨房" },
    ],
    needs_pick: false,
    picks: [],
  });
  assert.strictEqual(e.calls.local.length, 1);
  assert.strictEqual(e.calls.deepseek.length, 0);
});

test("add:补遗漏新物品,added 携带名称与数量备注", async () => {
  const e = makeEngines([ADD_REPLY], [new Error("不应被调用")]);
  const res = await runParse(e);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.intent, "add");
  assert.deepStrictEqual(res.added, { name: "五号电池", qty_note: "还有几节" });
  assert.strictEqual(res.needs_pick, false);
  assert.ok(!("edits" in res) && !("target" in res), "add 分支不带 edits/target");
});

test("batch_location:改批次默认位置", async () => {
  const e = makeEngines([LOC_REPLY], [new Error("不应被调用")]);
  const res = await runParse(e);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.intent, "batch_location");
  assert.strictEqual(res.new_location, "客厅电视柜");
  assert.strictEqual(res.needs_pick, false);
});

test("none:没解析出任何操作(闲聊/无关)→ intent=none 空形状", async () => {
  const e = makeEngines([JSON.stringify({ intent: "none", needs_pick: false })], []);
  const res = await runParse(e);
  assert.deepStrictEqual(res, {
    ok: true,
    engine: "local",
    intent: "none",
    needs_pick: false,
    picks: [],
  });
});

// ---------- prompt 组装 ----------

test("prompt 组装:批次位置/候选清单(draft_id:name)/用户输入/绝不按行号锁定指令", async () => {
  const e = makeEngines([EDIT_REPLY], []);
  await runParse(e);
  const prompt = e.calls.local[0];
  assert.ok(prompt.indexOf("【当前批次位置】") !== -1);
  assert.ok(prompt.indexOf(BATCH_LOCATION) !== -1);
  assert.ok(prompt.indexOf("【候选清单】") !== -1);
  assert.ok(prompt.indexOf("- d-chips:黄色薯片罐") !== -1, "候选行应为 draft_id:name");
  assert.ok(prompt.indexOf("【用户输入】") !== -1);
  assert.ok(prompt.indexOf(TEXT) !== -1);
  assert.ok(prompt.indexOf("绝不按「第N个」") !== -1, "必须明示按内容词锁定、绝不按行号");
  assert.ok(prompt.indexOf("只取最主要的一类") !== -1, "单意图返回指令");
});

// ---------- needs_pick 分支 ----------

test("歧义:模型 draft_id 不在候选清单 → 服务端强制 needs_pick,picks=候选全量,edits 绝不执行", async () => {
  const reply = JSON.stringify({
    intent: "edit",
    target: { draft_id: "d-ghost", matched_word: "那个黑盒子" },
    edits: [{ field: "name", old: "?", new: "黑盒子" }],
    needs_pick: false,
    picks: [],
  });
  const e = makeEngines([reply], []);
  const res = await runParse(e);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.needs_pick, true);
  assert.strictEqual(res.target, null, "形状互斥:target 必须为 null");
  assert.deepStrictEqual(res.edits, [], "形状互斥:edits 必须为空");
  assert.deepStrictEqual(res.picks, [
    { draft_id: "d-zelda", name: "塞尔达传说:旷野之息" },
    { draft_id: "d-chips", name: "黄色薯片罐" },
    { draft_id: "d-cable", name: "白色数据线" },
  ]);
});

test("歧义:模型自报 needs_pick=true → picks 过滤到候选清单内(用候选自身 name);模型附带 edits/target 丢弃", async () => {
  const reply = JSON.stringify({
    intent: "edit",
    target: { draft_id: "d-chips", matched_word: "薯片罐" },
    edits: [{ field: "name", old: "黄色薯片罐", new: "品客薯片罐" }],
    needs_pick: true,
    picks: [
      { draft_id: "d-chips", name: "随便模型编的名字" },
      { draft_id: "d-nope", name: "不在清单里" },
      { draft_id: "d-cable", name: "白色数据线" },
    ],
  });
  const e = makeEngines([reply], []);
  const res = await runParse(e);
  assert.strictEqual(res.needs_pick, true);
  assert.strictEqual(res.target, null);
  assert.deepStrictEqual(res.edits, []);
  assert.deepStrictEqual(res.picks, [
    { draft_id: "d-chips", name: "黄色薯片罐" },
    { draft_id: "d-cable", name: "白色数据线" },
  ], "picks 过滤到清单内且 name 取候选自身,模型给的非法项剔除");
});

test("歧义:模型 needs_pick 但 picks 全非法/缺失 → picks 回退候选全量;intent=none 时 needs_pick 归 false", async () => {
  const reply = JSON.stringify({ intent: "edit", needs_pick: true, picks: [{ draft_id: "d-nope", name: "x" }] });
  const e = makeEngines([reply], []);
  const res = await runParse(e);
  assert.strictEqual(res.needs_pick, true);
  assert.strictEqual(res.picks.length, 3, "picks 全非法时回退全量");

  const noneReply = JSON.stringify({ intent: "none", needs_pick: true, picks: [] });
  const e2 = makeEngines([noneReply], []);
  const res2 = await runParse(e2);
  assert.strictEqual(res2.intent, "none");
  assert.strictEqual(res2.needs_pick, false, "none 没有可点选的东西,needs_pick 归 false");
});

// ---------- edits 硬门 ----------

test("edits 硬门:字段白名单外的丢弃、new 空串/超长丢弃、old 缺省空串、超 3 项截断", async () => {
  const longValue = "长".repeat(201);
  const edits = [
    { field: "name", old: "黄色薯片罐", new: "品客薯片罐" }, // 合法
    { field: "checked", old: "false", new: "true" }, // 白名单外 → 丢弃
    { field: "quantity", old: "1", new: "2" }, // 白名单外(不引入库存语义)→ 丢弃
    { field: "qty_note", new: "(空罐)" }, // old 缺省 → 保留为空串
    { field: "location", old: "A", new: "   " }, // new 空白 → 丢弃
    { field: "location", old: "A", new: longValue }, // new 超 200 码点 → 丢弃
    { field: "name", old: "B", new: "第二名" }, // 截断后第 2 项
    { field: "name", old: "C", new: "第三名" }, // 截断后第 3 项
    { field: "name", old: "D", new: "第四名" }, // 超出 3 项 → 截掉
  ];
  const reply = JSON.stringify({
    intent: "edit",
    target: { draft_id: "d-chips", matched_word: "薯片罐" },
    edits,
    needs_pick: false,
    picks: [],
  });
  const e = makeEngines([reply], []);
  const res = await runParse(e);
  assert.strictEqual(res.needs_pick, false);
  assert.deepStrictEqual(res.edits, [
    { field: "name", old: "黄色薯片罐", new: "品客薯片罐" },
    { field: "qty_note", old: "", new: "(空罐)" },
    { field: "name", old: "B", new: "第二名" },
  ], "只保留白名单内且合法的前 3 项");
});

// ---------- add/batch_location 非法降级 ----------

test("降级:add 无合法名称 / batch_location 空值 / 未知 intent → intent=none", async () => {
  const cases = [
    JSON.stringify({ intent: "add", added: { name: "   " } }),
    JSON.stringify({ intent: "add", added: { name: "长".repeat(51) } }),
    JSON.stringify({ intent: "add" }),
    JSON.stringify({ intent: "batch_location", new_location: "  " }),
    JSON.stringify({ intent: "batch_location", new_location: "长".repeat(201) } ),
    JSON.stringify({ intent: "rename-everything" }),
  ];
  for (const reply of cases) {
    const e = makeEngines([reply], []);
    const res = await runParse(e);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.intent, "none", "应降级 none:" + reply);
    assert.strictEqual(res.needs_pick, false);
  }
});

// ---------- 输入校验(INVALID_INPUT,引擎未参与) ----------

test("输入校验:text/batch_location/candidates 形状非法一律 INVALID_INPUT", async () => {
  const cases = [
    { label: "text 缺失", event: { action: "draftEditParse", batch_location: BATCH_LOCATION, candidates: CANDIDATES } },
    { label: "text 去空白为空", event: editEvent({ text: "   \n  " }) },
    { label: "text 超 200 码点", event: editEvent({ text: "字".repeat(201) }) },
    { label: "batch_location 缺失", event: { action: "draftEditParse", text: TEXT, candidates: CANDIDATES } },
    { label: "batch_location 空", event: editEvent({ batch_location: "  " }) },
    { label: "batch_location 超 200", event: editEvent({ batch_location: "长".repeat(201) }) },
    { label: "candidates 缺失", event: { action: "draftEditParse", text: TEXT, batch_location: BATCH_LOCATION } },
    { label: "candidates 空", event: editEvent({ candidates: [] }) },
    { label: "candidates 超 12", event: editEvent({ candidates: Array.from({ length: 13 }, (_, i) => ({ draft_id: "d" + i, name: "物" + i })) }) },
    { label: "draft_id 超 32", event: editEvent({ candidates: [{ draft_id: "d".repeat(33), name: "物品" }] }) },
    { label: "候选 name 空", event: editEvent({ candidates: [{ draft_id: "d1", name: " " }] }) },
  ];
  for (const c of cases) {
    const logs = [];
    const res = await runParse(null, c.event, logs);
    assert.strictEqual(res.ok, false, c.label);
    assert.strictEqual(res.error, "INVALID_INPUT", c.label);
    assert.strictEqual(res.message, "语音编辑指令不合法", c.label);
    const last = logs[logs.length - 1];
    assert.strictEqual(last.error, "INVALID_INPUT", c.label + ":日志记错误码");
    assert.strictEqual(last.intent, null, c.label + ":引擎未参与,intent 为 null");
  }
});

// ---------- 引擎链(local→DeepSeek 降级) ----------

test("引擎链:local 抛错 → 立即降级 DeepSeek,engine=deepseek", async () => {
  const e = makeEngines([new Error("TIMEOUT")], [EDIT_REPLY]);
  const res = await runParse(e);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.engine, "deepseek");
  assert.strictEqual(res.intent, "edit");
  assert.strictEqual(e.calls.local.length, 1);
  assert.strictEqual(e.calls.deepseek.length, 1, "降级后 DeepSeek 恰好一次");
});

test("引擎链:local 空文本 → 视为引擎失败降级 DeepSeek", async () => {
  const e = makeEngines(["   "], [ADD_REPLY]);
  const res = await runParse(e);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.engine, "deepseek");
  assert.strictEqual(res.intent, "add");
});

test("引擎链:双失败 → AI_UNAVAILABLE + manual_fallback,engine=deepseek", async () => {
  const e = makeEngines([new Error("HTTP_500")], [new Error("HTTP_500")]);
  const res = await runParse(e);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "AI_UNAVAILABLE");
  assert.strictEqual(res.manual_fallback, true);
  assert.strictEqual(res.engine, "deepseek");
});

test("引擎链:坏 JSON 带错误重试一次仍走 local(质量失败不降级),重试 prompt 回传上次输出", async () => {
  const e = makeEngines(["哎呀没听清~", EDIT_REPLY], [new Error("不应被调用")]);
  const res = await runParse(e);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.engine, "local");
  assert.strictEqual(e.calls.local.length, 2, "prompt 级重试照旧:恰好两次");
  assert.strictEqual(e.calls.deepseek.length, 0, "重试绝不换引擎");
  assert.ok(e.calls.local[1].indexOf("【上次输出】") !== -1);
  assert.ok(e.calls.local[1].indexOf("【解析错误】") !== -1);
});

test("引擎链:两次坏 JSON → AI_UNAVAILABLE,engine=local,DeepSeek 零请求", async () => {
  const e = makeEngines(["这不是 JSON", "还是不行"], [new Error("不应被调用")]);
  const res = await runParse(e);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "AI_UNAVAILABLE");
  assert.strictEqual(res.engine, "local");
  assert.strictEqual(e.calls.local.length, 2, "只重试一次");
  assert.strictEqual(e.calls.deepseek.length, 0, "模型质量失败不触发降级");
});

test("现状锁:未注入 callLocalLLM → 只走 DeepSeek 一次,engine=deepseek", async () => {
  const calls = [];
  const res = await draftEditParse(editEvent(), {
    callLLM: async (p) => {
      calls.push(p);
      return LOC_REPLY;
    },
    logger() {},
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.engine, "deepseek");
  assert.strictEqual(res.intent, "batch_location");
  assert.strictEqual(calls.length, 1);
});

// ---------- 日志纪律 ----------

test("日志纪律:只记 textLength/candidateCount/elapsedMs/engine/intent/error,不含原文/候选名/edits", async () => {
  const logs = [];
  const e = makeEngines([EDIT_REPLY], []);
  await runParse(e, null, logs);
  const bad = makeEngines([new Error("HTTP_500")], [new Error("HTTP_500")]);
  await runParse(bad, null, logs);
  const serialized = JSON.stringify(logs);
  assert.ok(serialized.indexOf(TEXT) === -1, "日志不得包含转写原文");
  assert.ok(serialized.indexOf("黄色薯片罐") === -1, "日志不得包含候选名");
  assert.ok(serialized.indexOf("品客薯片罐") === -1, "日志不得包含 edits 新值");
  assert.ok(serialized.indexOf(BATCH_LOCATION) === -1, "日志不得包含批次位置");
  for (const entry of logs) {
    assert.strictEqual(entry.action, "draftEditParse");
    assert.strictEqual(typeof entry.textLength, "number");
    assert.strictEqual(entry.candidateCount, 3);
    for (const key of Object.keys(entry)) {
      assert.ok(
        ["action", "textLength", "candidateCount", "elapsedMs", "engine", "intent", "error"].includes(key),
        "日志出现越界字段:" + key
      );
    }
  }
  assert.strictEqual(logs[0].intent, "edit", "成功日志记解析出的 intent");
  assert.strictEqual(logs[logs.length - 1].error, "AI_UNAVAILABLE");
  assert.strictEqual(logs[logs.length - 1].intent, null);
});

// ---------- index.js 胶水(stub wx-server-sdk 真加载,零外网) ----------

/** 临时把 wx-server-sdk 替换为 stub 并(重新)加载云函数入口(tests/glue.test.js 手法) */
function loadCloudFunction(entryPath, stubSdk) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "wx-server-sdk") {
      return stubSdk;
    }
    return origLoad.apply(this, arguments);
  };
  for (const key of Object.keys(require.cache)) {
    if (key.indexOf(path.join(ROOT, "cloudfunctions")) === 0) {
      delete require.cache[key];
    }
  }
  try {
    return require(entryPath);
  } finally {
    Module._load = origLoad;
  }
}

const ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "LOCAL_LLM_BASE",
  "LOCAL_LLM_TOKEN",
  "LOCAL_LLM_MODEL",
  "LOCAL_LLM_TIMEOUT_MS",
  "VL_BASE",
  "VL_TOKEN",
  "VL_MODEL",
];

async function withEnv(env, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    if (!env || !Object.prototype.hasOwnProperty.call(env, k)) delete process.env[k];
  }
  if (env) {
    for (const k of Object.keys(env)) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  }
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("胶水:draftEditParse 路由——本地引擎(127.0.0.1 stub)全链 ok,engine=local", async () => {
  const { server, port } = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: EDIT_REPLY } }] }));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
  try {
    const entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "extractDraft", "index.js"), {
      init: function () {},
      getWXContext: function () {
        return {};
      },
      DYNAMIC_CURRENT_ENV: "env-dynamic",
    });
    await withEnv(
      {
        DEEPSEEK_API_KEY: undefined,
        LOCAL_LLM_BASE: "http://127.0.0.1:" + port + "/v1",
        LOCAL_LLM_TOKEN: "draft-edit-glue-token",
        LOCAL_LLM_MODEL: "/models/Qwen3.6-35B-A3B-4bit",
      },
      async () => {
        const res = await entry.main(editEvent());
        assert.strictEqual(res.ok, true, JSON.stringify(res));
        assert.strictEqual(res.engine, "local");
        assert.strictEqual(res.intent, "edit");
        assert.strictEqual(res.target.draft_id, "d-chips");
      }
    );
  } finally {
    server.close();
  }
});
