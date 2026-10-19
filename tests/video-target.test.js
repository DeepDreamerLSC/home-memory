const test = require("node:test");
const assert = require("node:assert/strict");

const target = require("../miniprogram/utils/video-target.js");

function fakeDecoder(options) {
  const opts = options || {};
  const handlers = Object.create(null);
  let frameCalls = 0;
  return {
    started: 0,
    seeks: [],
    stopped: 0,
    removed: 0,
    on(event, cb) { handlers[event] = cb; },
    off(event, cb) { if (handlers[event] === cb) delete handlers[event]; },
    start(source) {
      this.started += 1;
      this.source = source;
      setTimeout(() => { if (handlers.start) handlers.start(); }, 0);
    },
    seek(position) {
      this.seeks.push(position);
      setTimeout(() => { if (handlers.seek) handlers.seek(); }, 0);
    },
    getFrameData() {
      frameCalls += 1;
      if (opts.framesBeforeData && frameCalls <= opts.framesBeforeData) return null;
      return {
        data: new Uint8ClampedArray(opts.width * opts.height * 4),
        width: opts.width,
        height: opts.height,
      };
    },
    stop() { this.stopped += 1; },
    remove() { this.removed += 1; },
  };
}

function fakeCanvas() {
  const ctx = {
    lastImageData: null,
    createImageData(width, height) {
      return { data: new Uint8ClampedArray(width * height * 4), width, height };
    },
    putImageData(imageData) { this.lastImageData = imageData; },
  };
  const canvas = { getContext(type) { assert.equal(type, "2d"); return ctx; } };
  return { canvas, ctx };
}

function makeSession(overrides) {
  const events = { cleaned: [] };
  const decoder = fakeDecoder({ width: 2, height: 2 });
  const canvasInfo = fakeCanvas();
  const session = target.createVideoFrameSession("https://example.test/video.mp4", Object.assign({
    decoder,
    durationMs: 10000,
    createCanvas: () => canvasInfo.canvas,
    canvasToTempFilePath: () => "/tmp/frame.jpg",
    readFileBase64: () => "QUJD",
    cleanupFile: (path) => events.cleaned.push(path),
    maxBase64Chars: 100,
  }, overrides || {}));
  return { session, decoder, canvasInfo, events };
}

test("帧计划:10/35/65/90 + 补帧 22.5/50/77.5/97.5,且时间窗正确", () => {
  assert.deepEqual(target.planFrameTimes(10000, { supplemental: false }), [1000, 3500, 6500, 9000]);
  const all = target.buildFramePlan(10000);
  assert.equal(all.length, 8);
  assert.deepEqual(all.map((x) => x.timeMs), [1000, 3500, 6500, 9000, 2250, 5000, 7750, 9750]);
  assert.equal(all[0].windowStartMs, 250);
  assert.equal(all[0].windowEndMs, 1750);
  assert.equal(all[0].phase, "initial");
  assert.equal(all[4].phase, "supplemental");
});

test("抽帧会话:一次 start、逐次 seek、导出 base64、cancel 清理临时文件", async () => {
  const made = makeSession();
  const frame = await made.session.captureAt(1200, 3);
  assert.equal(made.decoder.started, 1);
  assert.deepEqual(made.decoder.seeks, [1.2]);
  assert.equal(frame.path, "/tmp/frame.jpg");
  assert.equal(frame.timeMs, 1200);
  assert.equal(frame.frameIndex, 3);
  assert.equal(frame.base64, "QUJD");
  await made.session.cancel();
  assert.equal(made.session.cancelled, true);
  assert.equal(made.decoder.stopped, 1);
  assert.equal(made.decoder.removed, 1);
  assert.deepEqual(made.events.cleaned, ["/tmp/frame.jpg"]);
});

test("抽帧会话:cancel 后 captureAt 必须拒绝且不继续解码", async () => {
  const made = makeSession();
  await made.session.cancel();
  await assert.rejects(() => made.session.captureAt(1000, 0), (error) => error && error.code === "cancelled");
  assert.equal(made.decoder.started, 0);
});

test("抽帧会话:不支持 VideoDecoder 时抛 unsupported", () => {
  assert.throws(
    () => target.createVideoFrameSession("https://example.test/video.mp4", { wx: {} }),
    (error) => error && error.code === "unsupported"
  );
});

test("抽帧会话:base64 超限抛 too_large,不返回候选", async () => {
  const made = makeSession({ readFileBase64: () => "TOO_LONG_BASE64", maxBase64Chars: 4 });
  await assert.rejects(() => made.session.captureAt(1000, 0), (error) => error && error.code === "too_large");
  await made.session.cancel();
  assert.deepEqual(made.events.cleaned, ["/tmp/frame.jpg"]);
});

test("抽帧会话:解码帧未就绪时轮询后成功", async () => {
  const decoder = fakeDecoder({ width: 2, height: 2, framesBeforeData: 2 });
  const canvasInfo = fakeCanvas();
  const session = target.createVideoFrameSession("https://example.test/video.mp4", {
    decoder,
    durationMs: 10000,
    createCanvas: () => canvasInfo.canvas,
    canvasToTempFilePath: () => "/tmp/frame.jpg",
    readFileBase64: () => "QUJD",
    framePollIntervalMs: 1,
    framePollCount: 5,
  });
  const frame = await session.captureAt(1000, 0);
  assert.equal(frame.width, 2);
  await session.cancel();
});

function fakeFrameSession() {
  const calls = [];
  let cancelled = false;
  return {
    get cancelled() { return cancelled; },
    calls,
    async captureAt(timeMs, frameIndex) {
      calls.push({ timeMs, frameIndex });
      return {
        path: "/tmp/candidate-" + frameIndex + ".jpg",
        width: 100,
        height: 80,
        timeMs,
        frameIndex,
        base64: "QUJD",
      };
    },
    async cancel() { cancelled = true; },
  };
}

test("目标编排:初始无命中时补 4 帧,命中后逐帧候选不合并", async () => {
  const session = fakeFrameSession();
  let recognizeCalls = 0;
  const result = await target.findVideoTargetCandidates({
    durationMs: 10000,
    targetName: "雨伞",
    session,
    callRecognize: async () => {
      recognizeCalls += 1;
      if (recognizeCalls < 5) return { ok: true, hit: false, box: null, confidence: "low" };
      return { ok: true, hit: true, box: { x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9 }, confidence: "high" };
    },
  });
  assert.equal(recognizeCalls, 5);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].timeMs, 2250);
  assert.equal(result.candidates[0].windowStartMs, 1500);
  assert.equal(result.candidates[0].windowEndMs, 3000);
  assert.equal(result.stoppedEarly, true);
  assert.equal(session.calls.length, 5);
});

test("目标编排:初始高置信命中后停止补帧", async () => {
  const session = fakeFrameSession();
  let recognizeCalls = 0;
  const result = await target.findVideoTargetCandidates({
    durationMs: 10000,
    targetName: "雨伞",
    session,
    callRecognize: async () => {
      recognizeCalls += 1;
      return { ok: true, hit: true, box: { x1: 0.1, y1: 0.1, x2: 0.7, y2: 0.8 }, confidence: "high" };
    },
  });
  assert.equal(recognizeCalls, 4);
  assert.equal(result.candidates.length, 4);
  assert.equal(result.stoppedEarly, true);
});

test("目标编排:低置信候选保留但不会触发提前停止", async () => {
  const session = fakeFrameSession();
  let recognizeCalls = 0;
  const result = await target.findVideoTargetCandidates({
    durationMs: 10000,
    targetName: "雨伞",
    session,
    callRecognize: async () => {
      recognizeCalls += 1;
      if (recognizeCalls === 1) return { ok: true, hit: true, box: { x1: 0.1, y1: 0.1, x2: 0.7, y2: 0.8 }, confidence: "low" };
      return { ok: true, hit: false, box: null, confidence: "low" };
    },
  });
  assert.equal(recognizeCalls, 8);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.stoppedEarly, false);
});

test("目标编排:AI 不可用时抛 recognize_unavailable", async () => {
  const session = fakeFrameSession();
  await assert.rejects(
    () => target.findVideoTargetCandidates({
      durationMs: 10000,
      targetName: "雨伞",
      session,
      callRecognize: async () => ({ ok: false, error: "AI_UNAVAILABLE" }),
    }),
    (error) => error && error.code === "recognize_unavailable"
  );
});

test("候选展示:时间文案与 0-1 框转百分比样式", () => {
  assert.equal(target.videoTimeText(0), "0:00");
  assert.equal(target.videoTimeText(65000), "1:05");
  assert.equal(target.highlightWindowText(1000, 2250), "0:01 - 0:02");
  assert.equal(
    target.boxPercentStyle({ x1: 0.1, y1: 0.2, x2: 0.6, y2: 0.8 }),
    "left:10%;top:20%;width:50%;height:60%"
  );
  assert.equal(target.boxPercentStyle(null), "display:none");
});
