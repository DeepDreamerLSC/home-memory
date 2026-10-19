"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planVideoFrameTimes = planVideoFrameTimes;
exports.aggregateVideoRecognitions = aggregateVideoRecognitions;
exports.recognizeVideoFrames = recognizeVideoFrames;
exports.extractVideoFrames = extractVideoFrames;
const CONF_RANK = { low: 1, mid: 2, high: 3 };
/** 均匀采样:避开首尾各 5%,最多 maxFrames 个点;至少 1 个点。 */
function planVideoFrameTimes(durationMs, maxFrames) {
    if (Number.isFinite(durationMs) === false || durationMs <= 0)
        return [];
    const n = Math.max(1, Math.min(Math.floor(maxFrames), 12));
    if (durationMs <= 1500)
        return [Math.round(durationMs / 2)];
    const start = Math.round(durationMs * 0.05);
    const end = Math.round(durationMs * 0.95);
    if (n === 1)
        return [Math.round((start + end) / 2)];
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(Math.round(start + ((end - start) * i) / (n - 1)));
    }
    return out;
}
function normName(name) {
    return name.trim().toLowerCase().replace(/\s+/g, "");
}
function boxArea(box) {
    return box === null ? 0 : Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}
function better(a, b) {
    const ca = CONF_RANK[a.confidence];
    const cb = CONF_RANK[b.confidence];
    if (ca !== cb)
        return ca > cb;
    return boxArea(a.box) > boxArea(b.box);
}
/** 一次采样帧命中 -> 时间窗;相邻帧窗口按 sampling gap 合并。 */
function aggregateVideoRecognitions(recognitions, durationMs, maxCandidates) {
    const buckets = new Map();
    for (const frame of recognitions) {
        if (frame.time_ms < 0 || frame.time_ms > durationMs)
            continue;
        for (const item of frame.items) {
            if (typeof item.name !== "string" || item.name.trim() === "")
                continue;
            const key = normName(item.name);
            if (key === "")
                continue;
            let bucket = buckets.get(key);
            if (bucket === undefined) {
                bucket = { best: { ...item }, occurrences: [], seenTimes: new Set() };
                buckets.set(key, bucket);
            }
            if (better(item, bucket.best))
                bucket.best = { ...item };
            const existing = bucket.occurrences.find((o) => o.time === frame.time_ms);
            if (existing === undefined) {
                bucket.occurrences.push({ time: frame.time_ms, item: { ...item } });
                bucket.seenTimes.add(frame.time_ms);
            }
            else if (better(item, existing.item)) {
                existing.item = { ...item };
            }
        }
    }
    const out = [];
    buckets.forEach((bucket) => {
        const highlights = bucket.occurrences
            .slice()
            .sort((a, b) => a.time - b.time)
            .map((occ) => ({
            start_ms: Math.max(0, occ.time - 300),
            end_ms: Math.min(durationMs, occ.time + 300),
            box: occ.item.box,
            source: "vl",
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
        if (a.seen_count !== b.seen_count)
            return b.seen_count - a.seen_count;
        return CONF_RANK[b.confidence] - CONF_RANK[a.confidence];
    });
    return out.slice(0, Math.max(1, Math.min(maxCandidates, 10)));
}
/** 顺序逐帧识别;单帧失败整段失败(不把半批候选伪装成全量结果)。 */
async function recognizeVideoFrames(frames, deps) {
    const out = [];
    for (const frame of frames) {
        const items = await deps.recognizeFrame(frame);
        out.push({ time_ms: frame.time_ms, items });
    }
    return out;
}
function wxAvailable() {
    return typeof wx !== "undefined" && wx !== null;
}
const defaultExtractionDeps = {
    createVideoDecoder: () => wx.createVideoDecoder(),
    createOffscreenCanvas: (opt) => wx.createOffscreenCanvas(opt),
    canvasToTempFilePath: (opt) => new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
            ...opt,
            success: (res) => resolve(res.tempFilePath),
            fail: (err) => reject(new Error((err && err.errMsg) || "canvasToTempFilePath:fail")),
        });
    }),
    getImageInfo: (src) => new Promise((resolve, reject) => {
        wx.getImageInfo({
            src,
            success: (res) => resolve({ width: res.width, height: res.height }),
            fail: (err) => reject(new Error((err && err.errMsg) || "getImageInfo:fail")),
        });
    }),
    readFileBase64: (filePath) => new Promise((resolve, reject) => {
        wx.getFileSystemManager().readFile({
            filePath,
            encoding: "base64",
            success: (res) => resolve(typeof res.data === "string" ? res.data : ""),
            fail: (err) => reject(new Error((err && err.errMsg) || "readFile:fail")),
        });
    }),
};
function waitDecoderEvent(decoder, event, timeoutMs) {
    return new Promise((resolve, reject) => {
        let done = false;
        const cb = (res) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            decoder.off(event, cb);
            resolve(res);
        };
        const timer = setTimeout(() => {
            if (done)
                return;
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
async function extractVideoFrames(videoPath, durationMs, maxFrames, deps) {
    const d = Object.assign({}, defaultExtractionDeps, deps || {});
    const times = planVideoFrameTimes(durationMs, maxFrames);
    if (times.length === 0)
        throw new Error("INVALID_DURATION");
    const decoder = d.createVideoDecoder();
    try {
        const started = waitDecoderEvent(decoder, "start", 10000);
        await decoder.start({ source: videoPath, abortAudio: true, mode: 0 });
        await started;
        const frames = [];
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
            if (src.length < img.data.length)
                throw new Error("SHORT_FRAME_DATA");
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
            if (base64 === "")
                throw new Error("EMPTY_FRAME_BASE64");
            frames.push({ time_ms: time, base64, width: info.width, height: info.height });
        }
        return frames;
    }
    finally {
        try {
            await decoder.remove();
        }
        catch (e) {
            // 清理失败不影响已成功提取的帧
        }
    }
}
