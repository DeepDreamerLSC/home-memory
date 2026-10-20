"use strict";
// extractDraft.videoTargetRecognize 单帧目标识别离线合同测试(零外网)。
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  videoTargetRecognize,
  validateVideoTargetOutput,
} = require("../cloudfunctions/extractDraft/lib/handler");

const TARGET = "黑色耳机";
const IMAGE_B64 = Buffer.from("fake-video-frame-jpeg-bytes").toString("base64");
const GOOD = JSON.stringify({ found: true, confidence: "high", box: [100, 200, 300, 400] });

function makeDeps(script, opts) {
  opts = opts || {};
  const calls = [];
  const logs = [];
  const deps = {
    logger: (m) => logs.push(m),
  };
  if (opts.noCallVL !== true) {
    deps.callVL = async (prompt, imageBase64) => {
      calls.push({ prompt: prompt, imageBase64: imageBase64 });
      const item = script[Math.min(calls.length - 1, script.length - 1)];
      if (item instanceof Error) throw item;
      return item;
    };
  }
  return { deps: deps, calls: calls, logs: logs };
}

function event(extra) {
  return Object.assign({
    action: "videoTargetRecognize",
    target_name: TARGET,
    image_base64: IMAGE_B64,
    img_w: 1024,
    img_h: 768,
  }, extra || {});
}

function logsDoNotLeak(logs, extraRaw) {
  const text = JSON.stringify(logs);
  assert.equal(text.indexOf(TARGET), -1, "日志不得含 target_name");
  assert.equal(text.indexOf(IMAGE_B64), -1, "日志不得含图片 base64");
  if (extraRaw) assert.equal(text.indexOf(extraRaw), -1, "日志不得含模型原文");
  const allowed = new Set(["action", "elapsedMs", "engine", "targetLen", "error", "reason", "hit"]);
  for (const item of logs) {
    for (const key of Object.keys(item)) {
      assert.equal(allowed.has(key), true, "日志只允许白名单字段: " + key);
    }
  }
}

test("VTARGET-OK:合法框 0-1000 严格归一为 0-1,prompt 含目标名且只调一次 VL", async () => {
  const t = makeDeps([GOOD]);
  const res = await videoTargetRecognize(event(), t.deps);
  assert.deepEqual(res, {
    ok: true,
    hit: true,
    box: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 },
    confidence: "high",
  });
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].imageBase64, IMAGE_B64);
  assert.equal(t.calls[0].prompt.indexOf(TARGET) !== -1, true, "目标名只用于当次 prompt");
  assert.equal(t.logs.length, 1);
  assert.equal(t.logs[0].hit, true);
  logsDoNotLeak(t.logs, GOOD);
});

test("VTARGET-NO-HIT:found=false / 非法框 / box=null 均为成功但不可确认候选", async () => {
  const replies = [
    JSON.stringify({ found: false, confidence: "low", box: [1, 2, 3, 4] }),
    JSON.stringify({ found: true, confidence: "mid", box: [300, 200, 200, 400] }),
    JSON.stringify({ found: true, confidence: "low", box: null }),
    JSON.stringify({ found: true, confidence: "low", box: [1.5, 2, 3, 4] }),
    JSON.stringify({ found: true, confidence: "low", box: [0, 0, 1001, 400] }),
  ];
  for (const reply of replies) {
    const t = makeDeps([reply]);
    const res = await videoTargetRecognize(event(), t.deps);
    assert.equal(res.ok, true, reply);
    assert.equal(res.hit, false);
    assert.equal(res.box, null);
    assert.equal(t.calls.length, 1, "可疑框不重试,按不可确认成功返回");
    logsDoNotLeak(t.logs, reply);
  }
  assert.equal(validateVideoTargetOutput(GOOD).hit, true);
});

test("VTARGET-RETRY:坏 JSON 与字段形状失败都带错误重试一次,第二次合法即成功", async () => {
  for (const first of ["not-json-at-all", JSON.stringify({ found: "yes", confidence: "high", box: [1, 2, 3, 4] })]) {
    const t = makeDeps([first, GOOD]);
    const res = await videoTargetRecognize(event(), t.deps);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.hit, true);
    assert.equal(t.calls.length, 2);
    assert.equal(t.calls[1].prompt.indexOf("【上次输出】") !== -1, true, "重试 prompt 携带上次输出供纠错");
    assert.equal(t.calls[1].prompt.indexOf(first) !== -1, true);
    logsDoNotLeak(t.logs, first);
  }
});

test("VTARGET-UNAVAILABLE:两次坏 JSON → AI_UNAVAILABLE;引擎抛错/未配置同码且日志脱敏", async () => {
  const bad1 = "raw-model-output-secret-1";
  const bad2 = "raw-model-output-secret-2";
  const t = makeDeps([bad1, bad2]);
  const res = await videoTargetRecognize(event(), t.deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "AI_UNAVAILABLE");
  assert.equal(res.manual_fallback, true);
  assert.equal(t.calls.length, 2, "坏 JSON 必须重试一次后失败");
  assert.equal(t.logs[0].reason, "vl_bad_output");
  logsDoNotLeak(t.logs, bad1);
  logsDoNotLeak(t.logs, bad2);

  const thrown = makeDeps([new Error("network raw host/token secret")]);
  const failed = await videoTargetRecognize(event(), thrown.deps);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "AI_UNAVAILABLE");
  assert.equal(thrown.calls.length, 1, "引擎层失败不进入 JSON 重试");
  assert.equal(thrown.logs[0].reason, "vl_call_failed");
  assert.equal(JSON.stringify(thrown.logs).indexOf("token secret"), -1);

  const noVl = makeDeps([GOOD], { noCallVL: true });
  const unavailable = await videoTargetRecognize(event(), noVl.deps);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, "AI_UNAVAILABLE");
  assert.equal(unavailable.manual_fallback, true);
  assert.equal(noVl.logs[0].reason, "vl_not_configured");
  logsDoNotLeak(noVl.logs, GOOD);
});

test("VTARGET-INVALID:目标名/裸 base64/尺寸任一非法 → INVALID_INPUT 且零调用零日志泄露", async () => {
  const badEvents = [
    event({ target_name: undefined }),
    event({ target_name: "   " }),
    event({ target_name: "物".repeat(41) }),
    event({ target_name: 123 }),
    event({ image_base64: "data:image/jpeg;base64," + IMAGE_B64 }),
    event({ image_base64: "abc def" }),
    event({ image_base64: "" }),
    event({ image_base64: "x".repeat(4000001) }),
    event({ img_w: 0 }),
    event({ img_w: 1.5 }),
    event({ img_w: 10001 }),
    event({ img_h: -1 }),
    event({ img_h: 10001 }),
  ];
  for (const e of badEvents) {
    const t = makeDeps([GOOD]);
    const res = await videoTargetRecognize(e, t.deps);
    assert.equal(res.ok, false, JSON.stringify(e));
    assert.equal(res.error, "INVALID_INPUT");
    assert.equal(t.calls.length, 0, "输入门必须在 VL 调用之前");
    const text = JSON.stringify(t.logs);
    assert.equal(text.indexOf(TARGET), -1);
    assert.equal(text.indexOf(IMAGE_B64), -1);
  }

  const sanitized = makeDeps([JSON.stringify({ found: true, confidence: "high", box: [0, 0, 1000, 1000] })]);
  const res = await videoTargetRecognize(event({ target_name: "  目标物品  " }), sanitized.deps);
  assert.equal(res.ok, true, "目标名 trim 后合法");
  assert.equal(sanitized.calls[0].prompt.indexOf("\n目标物品") !== -1, true);
});
