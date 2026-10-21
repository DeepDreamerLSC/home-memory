"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timeWindowForFrame = exports.VideoTargetError = exports.VIDEO_TARGET_SUPPLEMENTAL_FRACTIONS = exports.VIDEO_TARGET_INITIAL_FRACTIONS = exports.VIDEO_TARGET_FEATURE_ENABLED = exports.VIDEO_TARGET_WINDOW_RADIUS_MS = exports.VIDEO_TARGET_MAX_FRAMES = exports.VIDEO_TARGET_BASE64_MAX_CHARS = exports.VIDEO_TARGET_JPEG_QUALITY = exports.VIDEO_TARGET_FRAME_LONG_EDGE_MAX = void 0;
exports.isVideoTargetError = isVideoTargetError;
exports.frameWindow = frameWindow;
exports.initialFrameTimes = initialFrameTimes;
exports.supplementalFrameTimes = supplementalFrameTimes;
exports.planInitialFrames = planInitialFrames;
exports.planSupplementalFrames = planSupplementalFrames;
exports.buildFramePlan = buildFramePlan;
exports.planFrameTimes = planFrameTimes;
exports.createVideoFrameSession = createVideoFrameSession;
exports.findVideoTargetCandidates = findVideoTargetCandidates;
exports.videoTimeText = videoTimeText;
exports.highlightWindowText = highlightWindowText;
exports.boxPercentStyle = boxPercentStyle;
exports.videoTargetEntryState = videoTargetEntryState;
/**
 * 通用视频抽帧与「在单条视频里找目标物品」客户端原语。
 * - createVideoFrameSession 封装 wx.createVideoDecoder，一次 start、逐次 seek、取消即释放；
 * - 帧计划与时间窗为纯函数；
 * - 目标识别只通过注入的 callVideoTargetRecognize 发起，逐帧候选独立保留，
 *   默认不自动勾选任何候选，低置信也不会被推荐。
 */
exports.VIDEO_TARGET_FRAME_LONG_EDGE_MAX = 1024;
exports.VIDEO_TARGET_JPEG_QUALITY = 0.72;
exports.VIDEO_TARGET_BASE64_MAX_CHARS = 4000000;
exports.VIDEO_TARGET_MAX_FRAMES = 8;
exports.VIDEO_TARGET_WINDOW_RADIUS_MS = 750;
exports.VIDEO_TARGET_FEATURE_ENABLED = true;
exports.VIDEO_TARGET_INITIAL_FRACTIONS = [0.1, 0.35, 0.65, 0.9];
exports.VIDEO_TARGET_SUPPLEMENTAL_FRACTIONS = [0.225, 0.5, 0.775, 0.975];
class VideoTargetError extends Error {
    constructor(code, message, cause) {
        super(message);
        this.name = "VideoTargetError";
        this.code = code;
        this.cause = cause;
        Object.setPrototypeOf(this, VideoTargetError.prototype);
    }
}
exports.VideoTargetError = VideoTargetError;
function isVideoTargetError(error) {
    return error instanceof VideoTargetError;
}
function normalizedDurationMs(durationMs) {
    if (durationMs > 0 && Number.isFinite(durationMs))
        return Math.max(0, Math.floor(durationMs));
    return 0;
}
function fractionTime(durationMs, fraction) {
    const duration = normalizedDurationMs(durationMs);
    if (duration === 0)
        return 0;
    const raw = Math.round(duration * fraction);
    return Math.max(0, Math.min(duration - 1, raw));
}
function uniqueNumbers(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        if (seen.has(value) === false) {
            seen.add(value);
            out.push(value);
        }
    }
    return out;
}
function frameWindow(timeMs, durationMs) {
    const duration = normalizedDurationMs(durationMs);
    if (duration === 0)
        return { timeMs: 0, windowStartMs: 0, windowEndMs: 0 };
    const t = Math.max(0, Math.min(duration, Math.round(Number.isFinite(timeMs) ? timeMs : 0)));
    let start = Math.max(0, t - exports.VIDEO_TARGET_WINDOW_RADIUS_MS);
    let end = Math.min(duration, t + exports.VIDEO_TARGET_WINDOW_RADIUS_MS);
    if (start >= end) {
        if (t === 0) {
            start = 0;
            end = duration;
        }
        else {
            start = Math.max(0, duration - 1);
            end = duration;
        }
    }
    return { timeMs: t, windowStartMs: start, windowEndMs: end };
}
exports.timeWindowForFrame = frameWindow;
function initialFrameTimes(durationMs) {
    const duration = normalizedDurationMs(durationMs);
    if (duration === 0)
        return [];
    return uniqueNumbers(exports.VIDEO_TARGET_INITIAL_FRACTIONS.map((f) => fractionTime(duration, f)));
}
function supplementalFrameTimes(durationMs) {
    const duration = normalizedDurationMs(durationMs);
    if (duration === 0)
        return [];
    return uniqueNumbers(exports.VIDEO_TARGET_SUPPLEMENTAL_FRACTIONS.map((f) => fractionTime(duration, f)));
}
function plansFromFractions(durationMs, fractions, phase, frameIndexOffset, skipTimes) {
    const plans = [];
    const seen = new Set(skipTimes);
    for (const fraction of fractions) {
        const timeMs = fractionTime(durationMs, fraction);
        if (seen.has(timeMs))
            continue;
        seen.add(timeMs);
        plans.push({
            frameIndex: frameIndexOffset + plans.length,
            phase,
            fraction,
            ...frameWindow(timeMs, durationMs),
        });
    }
    return plans;
}
function planInitialFrames(durationMs) {
    const duration = normalizedDurationMs(durationMs);
    if (duration === 0)
        return [];
    return plansFromFractions(duration, exports.VIDEO_TARGET_INITIAL_FRACTIONS, "initial", 0, new Set());
}
function planSupplementalFrames(durationMs, options) {
    const duration = normalizedDurationMs(durationMs);
    if (duration === 0)
        return [];
    const offset = options && Number.isInteger(options.frameIndexOffset)
        ? Math.max(0, options.frameIndexOffset)
        : exports.VIDEO_TARGET_INITIAL_FRACTIONS.length;
    return plansFromFractions(duration, exports.VIDEO_TARGET_SUPPLEMENTAL_FRACTIONS, "supplemental", offset, new Set(options && options.skipTimes ? options.skipTimes : []));
}
function buildFramePlan(durationMs, options) {
    const initial = planInitialFrames(durationMs);
    if (options && options.supplemental === false)
        return initial;
    const initialTimes = initial.map((p) => p.timeMs);
    const supplemental = planSupplementalFrames(durationMs, {
        frameIndexOffset: initial.length,
        skipTimes: initialTimes,
    });
    return initial.concat(supplemental);
}
function planFrameTimes(durationMs, options) {
    return buildFramePlan(durationMs, options).map((p) => p.timeMs);
}
function getGlobalWx() {
    if (typeof wx === "undefined")
        return undefined;
    return wx;
}
function resolveWx(options) {
    return options.wx || getGlobalWx() || {};
}
function errorMessage(error) {
    if (typeof error === "string")
        return error;
    if (error && typeof error === "object") {
        const record = error;
        for (const key of ["errMsg", "message", "error"]) {
            if (typeof record[key] === "string" && record[key].length > 0) {
                return record[key];
            }
        }
    }
    return "未知错误";
}
function asVideoTargetError(error, fallback, message) {
    if (isVideoTargetError(error))
        return error;
    return new VideoTargetError(fallback, message, error);
}
function cancelledError(message) {
    return new VideoTargetError("cancelled", message);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
function sourcePath(source) {
    if (typeof source === "string")
        return source;
    return source && typeof source.path === "string" ? source.path : "";
}
function sourceDuration(source) {
    if (source && typeof source === "object" && typeof source.durationMs === "number") {
        return source.durationMs;
    }
    return undefined;
}
function probeDisplayPortrait(wxLike, src) {
    return new Promise((resolve) => {
        if (typeof wxLike.getVideoInfo !== "function") {
            resolve(false);
            return;
        }
        try {
            wxLike.getVideoInfo({ src, success: (r) => resolve((r.height || 0) > (r.width || 0)), fail: () => resolve(false) });
        }
        catch (e) {
            resolve(false);
        }
    });
}
function toClampedBytes(value) {
    if (value instanceof ArrayBuffer)
        return new Uint8ClampedArray(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8ClampedArray(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
}
function decoderEventWait(decoder, eventName, timeoutMs, action) {
    return new Promise((resolve, reject) => {
        if (typeof decoder.on !== "function") {
            reject(new VideoTargetError("unsupported", "当前基础库不支持视频解码事件"));
            return;
        }
        let settled = false;
        let timer = null;
        const cleanup = () => {
            if (timer !== null)
                clearTimeout(timer);
            if (typeof decoder.off === "function") {
                try {
                    decoder.off(eventName, handler);
                }
                catch (e) { /* ignore */ }
            }
        };
        const handler = () => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve();
        };
        timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(new VideoTargetError("extract_failed", "视频解码等待 " + eventName + " 超时"));
        }, Math.max(50, timeoutMs));
        try {
            decoder.on(eventName, handler);
            const returned = action();
            // 真机 VideoDecoder.start/seek 返回 Promise;模拟器还会直接 reject
            // "不支持此 API 调试"。事件和 Promise 任一成功都算完成,错误不能被
            // 静默吞掉,否则会被误报成事件超时。
            if (returned && typeof returned.then === "function") {
                Promise.resolve(returned).then(() => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    resolve();
                }).catch((error) => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    reject(asVideoTargetError(error, "extract_failed", "视频解码器启动/定位失败: " + errorMessage(error)));
                });
            }
        }
        catch (e) {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(asVideoTargetError(e, "extract_failed", "视频解码器启动/定位失败: " + errorMessage(e)));
        }
    });
}
function defaultCanvasFactory(wxLike, width, height) {
    if (typeof wxLike.createOffscreenCanvas !== "function") {
        throw new VideoTargetError("unsupported", "当前基础库不支持 OffscreenCanvas");
    }
    return wxLike.createOffscreenCanvas({ type: "2d", width, height });
}
function defaultCanvasToTempFilePath(wxLike, options) {
    const canvasToTempFilePath = wxLike.canvasToTempFilePath;
    if (typeof canvasToTempFilePath !== "function") {
        return Promise.reject(new VideoTargetError("unsupported", "当前基础库不支持 canvasToTempFilePath"));
    }
    return new Promise((resolve, reject) => {
        canvasToTempFilePath.call(wxLike, {
            ...options,
            success: (result) => {
                if (result && typeof result.tempFilePath === "string" && result.tempFilePath.length > 0) {
                    resolve(result.tempFilePath);
                }
                else {
                    reject(new VideoTargetError("extract_failed", "canvasToTempFilePath 未返回临时文件"));
                }
            },
            fail: (error) => reject(asVideoTargetError(error, "extract_failed", "视频帧导出失败: " + errorMessage(error))),
        });
    });
}
function defaultReadFileBase64(wxLike, path) {
    const fs = typeof wxLike.getFileSystemManager === "function" ? wxLike.getFileSystemManager() : null;
    if (fs === null || typeof fs.readFile !== "function") {
        return Promise.reject(new VideoTargetError("unsupported", "当前基础库不支持读取临时文件"));
    }
    const readFile = fs.readFile;
    return new Promise((resolve, reject) => {
        try {
            readFile.call(fs, {
                filePath: path,
                encoding: "base64",
                success: (result) => {
                    if (typeof result === "string")
                        return resolve(result);
                    if (result && typeof result.data === "string") {
                        return resolve(result.data);
                    }
                    reject(new VideoTargetError("extract_failed", "读取视频帧临时文件失败"));
                },
                fail: (error) => reject(asVideoTargetError(error, "extract_failed", "读取视频帧失败: " + errorMessage(error))),
            });
        }
        catch (e) {
            reject(asVideoTargetError(e, "extract_failed", "读取视频帧失败: " + errorMessage(e)));
        }
    });
}
function defaultCleanupFile(wxLike, path) {
    const fs = typeof wxLike.getFileSystemManager === "function" ? wxLike.getFileSystemManager() : null;
    if (fs === null || typeof fs.unlink === "function" === false)
        return;
    try {
        fs.unlink({ filePath: path, success: () => undefined, fail: () => undefined });
    }
    catch (e) { /* 临时文件清理失败不影响业务 */ }
}
function createVideoFrameSession(source, options) {
    const opts = options || {};
    const wxLike = resolveWx(opts);
    const path = sourcePath(source);
    if (path === "")
        throw new VideoTargetError("extract_failed", "视频源为空");
    const durationMs = typeof opts.durationMs === "number" ? normalizedDurationMs(opts.durationMs) : sourceDuration(source);
    const maxLongEdge = Math.max(1, Math.floor(opts.maxLongEdge || exports.VIDEO_TARGET_FRAME_LONG_EDGE_MAX));
    const jpegQuality = typeof opts.jpegQuality === "number" ? opts.jpegQuality : exports.VIDEO_TARGET_JPEG_QUALITY;
    const maxBase64Chars = Math.max(1, Math.floor(opts.maxBase64Chars || exports.VIDEO_TARGET_BASE64_MAX_CHARS));
    const startTimeoutMs = typeof opts.startTimeoutMs === "number" ? opts.startTimeoutMs : 10000;
    // 竖拍自动探测(惰性,首帧时一次):调用方未显式给 displayPortrait 时,
    // 用 wx.getVideoInfo 的展示宽高判定;探测失败按横拍(false)兜底,行为同旧版。
    const displayPortraitOverride = opts.displayPortrait;
    let displayPortraitResolved = displayPortraitOverride === undefined ? null : displayPortraitOverride;
    let displayPortraitPromise = null;
    async function resolveDisplayPortrait() {
        if (displayPortraitResolved !== null)
            return displayPortraitResolved;
        if (displayPortraitPromise === null) {
            displayPortraitPromise = (typeof path === "string" && path !== ""
                ? probeDisplayPortrait(wxLike, path)
                : Promise.resolve(false)).then((v) => { displayPortraitResolved = v; return v; });
        }
        return displayPortraitPromise;
    }
    const seekTimeoutMs = typeof opts.seekTimeoutMs === "number" ? opts.seekTimeoutMs : 5000;
    const framePollCount = typeof opts.framePollCount === "number" ? opts.framePollCount : 40;
    const framePollIntervalMs = typeof opts.framePollIntervalMs === "number" ? opts.framePollIntervalMs : 25;
    let decoder = opts.decoder || null;
    if (decoder === null) {
        if (typeof opts.createDecoder === "function")
            decoder = opts.createDecoder();
        else if (typeof opts.decoderFactory === "function")
            decoder = opts.decoderFactory();
        else if (typeof wxLike.createVideoDecoder === "function")
            decoder = wxLike.createVideoDecoder();
    }
    if (decoder === null)
        throw new VideoTargetError("unsupported", "当前基础库不支持视频解码");
    const dec = decoder;
    let startedPromise = null;
    let cancelled = false;
    const tempFiles = new Set();
    const canvasFactory = opts.createCanvas || ((w, h) => defaultCanvasFactory(wxLike, w, h));
    const canvasToTemp = opts.canvasToTempFilePath || ((o) => defaultCanvasToTempFilePath(wxLike, o));
    const readBase64 = opts.readFileBase64 || ((p) => defaultReadFileBase64(wxLike, p));
    const cleanupFile = opts.cleanupFile || ((p) => defaultCleanupFile(wxLike, p));
    function ensureNotCancelled() {
        if (cancelled)
            throw cancelledError("视频抽帧已取消");
    }
    async function ensureStarted() {
        ensureNotCancelled();
        if (typeof dec.start !== "function") {
            throw new VideoTargetError("unsupported", "视频解码器不支持 start");
        }
        const start = dec.start;
        if (startedPromise)
            return startedPromise;
        startedPromise = decoderEventWait(dec, "start", startTimeoutMs, () => {
            return start.call(dec, { source: path });
        }).catch((error) => {
            startedPromise = null;
            throw asVideoTargetError(error, "extract_failed", "视频解码器启动失败: " + errorMessage(error));
        });
        return startedPromise;
    }
    async function captureAt(timeMs, frameIndex) {
        ensureNotCancelled();
        if (Number.isFinite(timeMs) === false || timeMs < 0) {
            throw new VideoTargetError("extract_failed", "抽帧时间无效");
        }
        await ensureStarted();
        ensureNotCancelled();
        if (typeof dec.seek !== "function") {
            throw new VideoTargetError("unsupported", "视频解码器不支持 seek");
        }
        const seek = dec.seek;
        await decoderEventWait(dec, "seek", seekTimeoutMs, () => {
            // 官方 VideoDecoder.seek 参数单位是毫秒,不是秒。
            return seek.call(dec, Math.round(timeMs));
        });
        ensureNotCancelled();
        let frameData = null;
        for (let i = 0; i < Math.max(1, framePollCount); i++) {
            ensureNotCancelled();
            let candidate = null;
            try {
                candidate = typeof dec.getFrameData === "function" ? dec.getFrameData() : null;
            }
            catch (e) {
                candidate = null;
            }
            if (candidate && candidate.data && candidate.width > 0 && candidate.height > 0) {
                frameData = candidate;
                break;
            }
            await sleep(framePollIntervalMs);
        }
        ensureNotCancelled();
        if (frameData === null)
            throw new VideoTargetError("extract_failed", "视频帧尚未解码完成");
        const sourceW = Math.max(1, Math.floor(frameData.width));
        const sourceH = Math.max(1, Math.floor(frameData.height));
        const scale = Math.min(1, maxLongEdge / Math.max(sourceW, sourceH));
        const destW = Math.max(1, Math.round(sourceW * scale));
        const destH = Math.max(1, Math.round(sourceH * scale));
        const bytes = toClampedBytes(frameData.data);
        if (bytes === null)
            throw new VideoTargetError("extract_failed", "视频帧数据格式不支持");
        const canvas = canvasFactory(sourceW, sourceH);
        const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
        if (ctx === null)
            throw new VideoTargetError("unsupported", "当前基础库不支持 2D Canvas");
        let imageData = null;
        if (typeof ctx.createImageData === "function") {
            imageData = ctx.createImageData(sourceW, sourceH);
            if ((imageData.data.length === bytes.length) === false)
                imageData = null;
        }
        if (imageData === null) {
            const ctor = globalThis.ImageData;
            if (typeof ctor === "function")
                imageData = new ctor(bytes, sourceW, sourceH);
        }
        if (imageData === null)
            throw new VideoTargetError("unsupported", "当前基础库不支持 ImageData");
        imageData.data.set(bytes);
        if (typeof ctx.putImageData === "function")
            ctx.putImageData(imageData, 0, 0);
        else if (typeof ctx.drawImage === "function")
            ctx.drawImage(imageData, 0, 0, sourceW, sourceH);
        else
            throw new VideoTargetError("unsupported", "当前基础库不支持视频帧绘制");
        // 竖拍旋转(真机 2026-10-20:B 验收发现竖拍视频抽帧全部横置):解码器给的是
        // 未旋转的原始帧(横),竖拍=横帧+90° 元数据;displayPortrait 时经第二画布
        // 顺时针转 90° 再导出——旋转发生在识别与框坐标之前,全链(缩略图/识别/框)一致竖立。
        let outCanvas = canvas;
        let outW = sourceW, outH = sourceH, outDW = destW, outDH = destH;
        if (await resolveDisplayPortrait() === true && sourceW > sourceH) {
            const rotated = canvasFactory(sourceH, sourceW);
            const rctx = typeof rotated.getContext === "function" ? rotated.getContext("2d") : null;
            if (rctx === null)
                throw new VideoTargetError("unsupported", "当前基础库不支持 2D Canvas");
            if (typeof rctx.rotate !== "function" || typeof rctx.drawImage !== "function") {
                throw new VideoTargetError("unsupported", "当前基础库不支持视频帧旋转");
            }
            if (typeof rctx.save === "function")
                rctx.save();
            rctx.rotate(Math.PI / 2);
            rctx.drawImage(canvas, 0, -sourceH, sourceW, sourceH);
            if (typeof rctx.restore === "function")
                rctx.restore();
            outCanvas = rotated;
            outW = sourceH;
            outH = sourceW;
            const rScale = Math.min(1, maxLongEdge / Math.max(outW, outH));
            outDW = Math.max(1, Math.round(outW * rScale));
            outDH = Math.max(1, Math.round(outH * rScale));
        }
        const tempResult = await canvasToTemp({
            canvas: outCanvas,
            x: 0,
            y: 0,
            width: outW,
            height: outH,
            destWidth: outDW,
            destHeight: outDH,
            fileType: "jpg",
            quality: jpegQuality,
        });
        const tempPath = typeof tempResult === "string" ? tempResult : "";
        if (tempPath === "")
            throw new VideoTargetError("extract_failed", "视频帧导出未返回临时文件");
        ensureNotCancelled();
        tempFiles.add(tempPath);
        let base64 = "";
        try {
            const raw = await readBase64(tempPath);
            if (typeof raw === "string")
                base64 = raw;
            else if (raw && typeof raw.data === "string")
                base64 = raw.data;
        }
        catch (e) {
            throw asVideoTargetError(e, "extract_failed", "读取视频帧 base64 失败: " + errorMessage(e));
        }
        ensureNotCancelled();
        if (base64.length < 1 || base64.length > maxBase64Chars) {
            throw new VideoTargetError("too_large", "视频帧图片超过大小上限");
        }
        return {
            path: tempPath,
            width: outDW,
            height: outDH,
            timeMs: Math.round(timeMs),
            frameIndex: Number.isInteger(frameIndex) ? frameIndex : 0,
            base64: base64,
        };
    }
    async function cancel() {
        if (cancelled)
            return;
        cancelled = true;
        if (typeof dec.stop === "function") {
            try {
                dec.stop();
            }
            catch (e) { /* ignore */ }
        }
        if (typeof dec.remove === "function") {
            try {
                dec.remove();
            }
            catch (e) { /* ignore */ }
        }
        const paths = Array.from(tempFiles);
        tempFiles.clear();
        for (const p of paths) {
            try {
                await cleanupFile(p);
            }
            catch (e) { /* ignore */ }
        }
    }
    return { get cancelled() { return cancelled; }, durationMs, captureAt, cancel };
}
function confidenceRank(value) {
    if (value === "high")
        return 3;
    if (value === "mid")
        return 2;
    if (value === "low")
        return 1;
    return 0;
}
function normalizeBox(box) {
    if (box === null || box === undefined)
        return null;
    const values = [box.x1, box.y1, box.x2, box.y2];
    if (values.every((v) => Number.isFinite(v)) === false)
        return null;
    if (box.x1 < 0 || box.y1 < 0 || box.x2 > 1 || box.y2 > 1 || box.x1 >= box.x2 || box.y1 >= box.y2)
        return null;
    return { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 };
}
async function findVideoTargetCandidates(options) {
    const duration = normalizedDurationMs(options.durationMs);
    if (duration <= 0)
        throw new VideoTargetError("extract_failed", "视频时长无效");
    const targetName = String(options.targetName || "").trim();
    if (targetName.length < 1)
        throw new VideoTargetError("extract_failed", "目标物品为空");
    const session = options.session || createVideoFrameSession(options.source || "", options.sessionOptions);
    const initial = planInitialFrames(duration);
    const supplemental = planSupplementalFrames(duration, {
        frameIndexOffset: initial.length,
        skipTimes: initial.map((p) => p.timeMs),
    });
    const plans = initial.concat(supplemental).slice(0, exports.VIDEO_TARGET_MAX_FRAMES);
    const candidates = [];
    let processed = 0;
    let foundStrongHit = false;
    for (let i = 0; i < plans.length; i++) {
        if (session.cancelled)
            throw cancelledError("视频目标识别已取消");
        if (i >= initial.length && foundStrongHit)
            break;
        const plan = plans[i];
        const frame = await session.captureAt(plan.timeMs, plan.frameIndex);
        if (session.cancelled)
            throw cancelledError("视频目标识别已取消");
        const result = await options.callRecognize({
            target_name: targetName,
            image_base64: frame.base64,
            img_w: frame.width,
            img_h: frame.height,
        });
        processed += 1;
        if (options.onProgress)
            options.onProgress(processed, plans.length);
        if (result && result.ok === true && result.hit === true) {
            const box = normalizeBox(result.box);
            if (box !== null) {
                const confidence = result.confidence === "high" || result.confidence === "mid" || result.confidence === "low"
                    ? result.confidence
                    : "low";
                candidates.push({
                    frameIndex: frame.frameIndex,
                    timeMs: frame.timeMs,
                    windowStartMs: plan.windowStartMs,
                    windowEndMs: plan.windowEndMs,
                    box: box,
                    confidence: confidence,
                    framePath: frame.path,
                    frameWidth: frame.width,
                    frameHeight: frame.height,
                });
                if (confidenceRank(confidence) >= 2)
                    foundStrongHit = true;
            }
        }
        else if (result && result.ok === false) {
            throw new VideoTargetError("recognize_unavailable", result.error || "AI 识别暂不可用");
        }
    }
    return {
        candidates: candidates,
        framesProcessed: processed,
        stoppedEarly: foundStrongHit && processed < plans.length,
        session: session,
    };
}
function videoTimeText(ms) {
    const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return m + ":" + (sec < 10 ? "0" + sec : String(sec));
}
function highlightWindowText(startMs, endMs) {
    return videoTimeText(startMs) + " - " + videoTimeText(endMs);
}
function boxPercentStyle(box) {
    if (box === null)
        return "display:none";
    const pct = (value) => Math.round(value * 100) / 100;
    const left = pct(Math.max(0, Math.min(100, box.x1 * 100)));
    const top = pct(Math.max(0, Math.min(100, box.y1 * 100)));
    const width = pct(Math.max(0, Math.min(100 - left, (box.x2 - box.x1) * 100)));
    const height = pct(Math.max(0, Math.min(100 - top, (box.y2 - box.y1) * 100)));
    return "left:" + left + "%;top:" + top + "%;width:" + width + "%;height:" + height + "%";
}
function videoTargetEntryState(wxLike) {
    if (exports.VIDEO_TARGET_FEATURE_ENABLED === false) {
        return { enabled: false, supported: true, available: false, reason: "disabled", message: "AI 查物品已关闭，可正常回放" };
    }
    const w = wxLike || getGlobalWx() || {};
    const supported = typeof w.createVideoDecoder === "function"
        && typeof w.createOffscreenCanvas === "function"
        && typeof w.canvasToTempFilePath === "function"
        && typeof w.getFileSystemManager === "function";
    return supported
        ? { enabled: true, supported: true, available: true, reason: null, message: "" }
        : { enabled: true, supported: false, available: false, reason: "unsupported", message: "当前基础库暂不支持视频抽帧，可正常回放" };
}
