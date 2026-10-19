/**
 * 视频抽帧识别的纯逻辑:
 * 1) 按固定规则规划采样时间点;
 * 2) 逐帧调用视觉模型并收集候选;
 * 3) 同名候选跨帧聚合 -> 一个待确认行 + 多段时间窗/框。
 *
 * 研究纪律:跨帧没有可靠 IoU,因此只按名称归并,不按框位置自动判同物;
 * 同名多件仍由用户在确认页拆开/改名,绝不静默合并真实多件。
 */
import type { Box } from "./photo-box";
import type { VlCandidate, VlConfidence } from "../types";
import type { VideoHighlightInput } from "../types";

export interface PlannedVideoFrame {
  time_ms: number;
}

export interface VideoFrameRecognition {
  time_ms: number;
  items: VlCandidate[];
}

export interface VideoRecognizedCandidate {
  name: string;
  qty_note: string;
  confidence: VlConfidence;
  box: Box | null;
  /** 出现在多少个采样帧里(只作提示,不参与自动确认) */
  seen_count: number;
  highlights: VideoHighlightInput[];
}

export interface VideoRecognizeDeps {
  recognizeFrame(frame: { time_ms: number; base64: string; width: number; height: number }): Promise<VlCandidate[]>;
}

const CONF_RANK: Record<VlConfidence, number> = { low: 1, mid: 2, high: 3 };

/** 均匀采样:避开首尾各 5%,最多 maxFrames 个点;至少 1 个点。 */
export function planVideoFrameTimes(durationMs: number, maxFrames: number): number[] {
  if (Number.isFinite(durationMs) === false || durationMs <= 0) return [];
  const n = Math.max(1, Math.min(Math.floor(maxFrames), 12));
  if (durationMs <= 1500) return [Math.round(durationMs / 2)];
  const start = Math.round(durationMs * 0.05);
  const end = Math.round(durationMs * 0.95);
  if (n === 1) return [Math.round((start + end) / 2)];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round(start + ((end - start) * i) / (n - 1)));
  }
  return out;
}

function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "");
}

function boxArea(box: Box | null): number {
  return box === null ? 0 : Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

function better(a: VlCandidate, b: VlCandidate): boolean {
  const ca = CONF_RANK[a.confidence];
  const cb = CONF_RANK[b.confidence];
  if (ca !== cb) return ca > cb;
  return boxArea(a.box) > boxArea(b.box);
}

/** 一次采样帧命中 -> 时间窗;相邻帧窗口按 sampling gap 合并。 */
export function aggregateVideoRecognitions(
  recognitions: VideoFrameRecognition[],
  durationMs: number,
  maxCandidates: number,
): VideoRecognizedCandidate[] {
  const buckets = new Map<string, {
    best: VlCandidate;
    occurrences: Array<{ time: number; item: VlCandidate }>;
    seenTimes: Set<number>;
  }>();
  for (const frame of recognitions) {
    if (frame.time_ms < 0 || frame.time_ms > durationMs) continue;
    for (const item of frame.items) {
      if (typeof item.name !== "string" || item.name.trim() === "") continue;
      const key = normName(item.name);
      if (key === "") continue;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { best: { ...item }, occurrences: [], seenTimes: new Set<number>() };
        buckets.set(key, bucket);
      }
      if (better(item, bucket.best)) bucket.best = { ...item };
      const existing = bucket.occurrences.find((o) => o.time === frame.time_ms);
      if (existing === undefined) {
        bucket.occurrences.push({ time: frame.time_ms, item: { ...item } });
        bucket.seenTimes.add(frame.time_ms);
      } else if (better(item, existing.item)) {
        existing.item = { ...item };
      }
    }
  }
  const out: VideoRecognizedCandidate[] = [];
  buckets.forEach((bucket) => {
    const highlights: VideoHighlightInput[] = bucket.occurrences
      .slice()
      .sort((a, b) => a.time - b.time)
      .map((occ) => ({
        start_ms: Math.max(0, occ.time - 300),
        end_ms: Math.min(durationMs, occ.time + 300),
        box: occ.item.box,
        source: "vl" as const,
      }))
      .filter((h) => h.end_ms > h.start_ms);
    out.push({
      name: bucket.best.name.trim(),
      qty_note: bucket.best.qty_note,
      confidence: bucket.best.confidence,
      box: bucket.best.box,
      seen_count: bucket.seenTimes.size,
      highlights,
    });
  });
  out.sort((a, b) => {
    if (a.seen_count !== b.seen_count) return b.seen_count - a.seen_count;
    return CONF_RANK[b.confidence] - CONF_RANK[a.confidence];
  });
  return out.slice(0, Math.max(1, Math.min(maxCandidates, 10)));
}

/** 顺序逐帧识别;单帧失败整段失败(不把半批候选伪装成全量结果)。 */
export async function recognizeVideoFrames(
  frames: Array<{ time_ms: number; base64: string; width: number; height: number }>,
  deps: VideoRecognizeDeps,
): Promise<VideoFrameRecognition[]> {
  const out: VideoFrameRecognition[] = [];
  for (const frame of frames) {
    const items = await deps.recognizeFrame(frame);
    out.push({ time_ms: frame.time_ms, items });
  }
  return out;
}

export interface ExtractedVideoFrame {
  time_ms: number;
  base64: string;
  width: number;
  height: number;
}

interface DecoderLike {
  start(opt: { source: string; abortAudio?: boolean; mode?: number }): Promise<unknown>;
  seek(position: number): Promise<unknown>;
  getFrameData(): { data: ArrayBuffer; width: number; height: number; pkPts: number };
  remove(): Promise<unknown>;
  on(event: string, cb: (res: unknown) => void): void;
  off(event: string, cb: (res: unknown) => void): void;
}

export interface VideoFrameExtractionDeps {
  createVideoDecoder(): DecoderLike;
  createOffscreenCanvas(opt: { type: "2d"; width: number; height: number }): {
    getContext(type: "2d"): {
      createImageData(w: number, h: number): { data: Uint8ClampedArray; width: number; height: number };
      putImageData(img: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number): void;
    };
  };
  canvasToTempFilePath(opt: {
    canvas: unknown;
    fileType: "jpg";
    quality: number;
    destWidth: number;
    destHeight: number;
  }): Promise<string>;
  getImageInfo(path: string): Promise<{ width: number; height: number }>;
  readFileBase64(path: string): Promise<string>;
}

function wxAvailable(): boolean {
  return typeof wx !== "undefined" && wx !== null;
}

const defaultExtractionDeps: VideoFrameExtractionDeps = {
  createVideoDecoder: () => wx.createVideoDecoder() as unknown as DecoderLike,
  createOffscreenCanvas: (opt) => wx.createOffscreenCanvas(opt) as unknown as ReturnType<VideoFrameExtractionDeps["createOffscreenCanvas"]>,
  canvasToTempFilePath: (opt) =>
    new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        ...(opt as unknown as WechatMiniprogram.CanvasToTempFilePathOption),
        success: (res) => resolve(res.tempFilePath),
        fail: (err) => reject(new Error((err && err.errMsg) || "canvasToTempFilePath:fail")),
      });
    }),
  getImageInfo: (src) =>
    new Promise((resolve, reject) => {
      wx.getImageInfo({
        src,
        success: (res) => resolve({ width: res.width, height: res.height }),
        fail: (err) => reject(new Error((err && err.errMsg) || "getImageInfo:fail")),
      });
    }),
  readFileBase64: (filePath) =>
    new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: "base64",
        success: (res) => resolve(typeof res.data === "string" ? res.data : ""),
        fail: (err) => reject(new Error((err && err.errMsg) || "readFile:fail")),
      });
    }),
};

function waitDecoderEvent(decoder: DecoderLike, event: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let done = false;
    const cb = (res: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      decoder.off(event, cb);
      resolve(res);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      decoder.off(event, cb);
      reject(new Error("DECODER_TIMEOUT"));
    }, timeoutMs);
    decoder.on(event, cb);
  });
}

/**
 * 真实端抽帧:VideoDecoder.seek -> getFrameData -> OffscreenCanvas -> JPEG -> base64。
 * 失败一律抛错,不返回半批帧;调用方走「视频识别暂不可用」降级。
 * 这是 A 方案(直接视频识别)不可用时的等价路径:模型看到的仍是帧,但原始
 * 视频完整保留用于查找回放与高亮。
 */
export async function extractVideoFrames(
  videoPath: string,
  durationMs: number,
  maxFrames: number,
  deps?: Partial<VideoFrameExtractionDeps>,
): Promise<ExtractedVideoFrame[]> {
  const d = Object.assign({}, defaultExtractionDeps, deps || {});
  const times = planVideoFrameTimes(durationMs, maxFrames);
  if (times.length === 0) throw new Error("INVALID_DURATION");
  const decoder = d.createVideoDecoder();
  try {
    const started = waitDecoderEvent(decoder, "start", 10000);
    await decoder.start({ source: videoPath, abortAudio: true, mode: 0 });
    await started;
    const frames: ExtractedVideoFrame[] = [];
    for (const time of times) {
      const seeked = waitDecoderEvent(decoder, "seek", 10000);
      await decoder.seek(time);
      await seeked;
      const frame = decoder.getFrameData();
      if (frame === null || frame === undefined || frame.width < 1 || frame.height < 1) {
        throw new Error("EMPTY_FRAME");
      }
      const canvas = d.createOffscreenCanvas({ type: "2d", width: frame.width, height: frame.height });
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(frame.width, frame.height);
      const src = new Uint8ClampedArray(frame.data);
      if (src.length < img.data.length) throw new Error("SHORT_FRAME_DATA");
      img.data.set(src.subarray(0, img.data.length));
      ctx.putImageData(img, 0, 0);
      const path = await d.canvasToTempFilePath({
        canvas,
        fileType: "jpg",
        quality: 0.72,
        destWidth: frame.width,
        destHeight: frame.height,
      });
      const info = await d.getImageInfo(path);
      const base64 = await d.readFileBase64(path);
      if (base64 === "") throw new Error("EMPTY_FRAME_BASE64");
      frames.push({ time_ms: time, base64, width: info.width, height: info.height });
    }
    return frames;
  } finally {
    try {
      await decoder.remove();
    } catch (e) {
      // 清理失败不影响已成功提取的帧
    }
  }
}
