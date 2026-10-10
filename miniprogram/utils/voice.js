"use strict";
/**
 * 语音录入封装:原生录音(wx.getRecorderManager)→ 云函数 transcribe(腾讯云 ASR)→ 文字。
 *
 * 设计:
 * - 接线收敛在 createVoiceController 一处,recorder/文件读取/转写调用均可注入便于离线测试;
 * - 纯逻辑(错误映射、耗时埋点、上滑取消判定、转写清洗)为独立纯函数;
 * - 任何失败如实上抛(码 + 中文文案),由页面给出重试与文字回退,绝不静默丢弃;
 * - 录音授权(scope.record)由页面在进入语音模式时先行处理。
 * 注:不做实时转写(录完识别),识别中状态由页面呈现。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VOICE_FORMAT = exports.VOICE_ERROR_MESSAGES = void 0;
exports.voiceErrorMessage = voiceErrorMessage;
exports.summarizeTimings = summarizeTimings;
exports.isSlideUpCancel = isSlideUpCancel;
exports.cleanTranscript = cleanTranscript;
exports.isMeaningfulTranscript = isMeaningfulTranscript;
exports.resetVoiceCancelled = resetVoiceCancelled;
exports.markVoiceCancelled = markVoiceCancelled;
exports.createVoiceController = createVoiceController;
exports.loadTimings = loadTimings;
exports.createDefaultVoiceDeps = createDefaultVoiceDeps;
exports.ensureRecordAuth = ensureRecordAuth;
/** 本地流程错误文案 */
exports.VOICE_ERROR_MESSAGES = {
    RECORD_FAIL: "录音启动失败,请重试或改用文字",
    RECORD_TOO_SHORT: "说话时间太短,请按住说完再松手",
    READ_FAIL: "读取录音失败,请重试",
    ASR_UNAVAILABLE: "语音识别暂不可用,请重试或改用文字",
};
function voiceErrorMessage(code) {
    return exports.VOICE_ERROR_MESSAGES[code] || "语音处理失败,请重试或改用文字";
}
/** 聚合最近 N 条埋点,输出 p50(耗时分解用) */
function summarizeTimings(timings, recentN = 20) {
    const recent = timings.slice(-recentN);
    if (recent.length === 0) {
        return { count: 0, recordP50: 0, asrP50: 0, charsAvg: 0 };
    }
    const sorted = (key) => recent.map((t) => t[key]).sort((a, b) => a - b);
    const p50 = (arr) => arr[Math.floor(arr.length / 2)];
    const recordSorted = sorted("recordMs");
    const asrSorted = sorted("asrMs");
    const charsAvg = recent.reduce((sum, t) => sum + t.chars, 0) / recent.length;
    return {
        count: recent.length,
        recordP50: p50(recordSorted),
        asrP50: p50(asrSorted),
        charsAvg: Math.round(charsAvg),
    };
}
/** 上滑取消判定:触点向上位移超过阈值即视为取消(经典微信交互) */
function isSlideUpCancel(startY, currentY, threshold = 60) {
    return startY - currentY > threshold;
}
/** 去除转写文本首尾空白与常见口头标点(仅首尾,不改中间内容) */
function cleanTranscript(text) {
    return text
        .trim()
        .replace(/^[,。、,.\s]+/, "")
        .replace(/[,。、,.\s]+$/, "");
}
/**
 * 转写是否有可提取的有效内容:剥掉语气填充词(嗯/啊/哦等)与标点后
 * 不足 2 字视为环境噪音(如"嗯。"),不应进入 AI 提取——
 * 否则噪音文本会被判"提不出物品名"而误报 AI 不可用。
 */
function isMeaningfulTranscript(text) {
    const stripped = text.replace(/[嗯啊哦呃唉诶呀哈\s,。、,.\?!!?~～]/g, "");
    return stripped.length >= 2;
}
/** 录音识别中标记为取消:丢弃最终结果,不再回调 onStop */
let cancelled = false;
function resetVoiceCancelled() {
    cancelled = false;
}
function markVoiceCancelled() {
    cancelled = true;
}
exports.VOICE_FORMAT = "wav";
function createVoiceController(callbacks, deps) {
    let pressStartAt = 0;
    let stopAt = 0;
    deps.recorder.onStart(() => {
        pressStartAt = Date.now();
        resetVoiceCancelled();
        callbacks.onStart();
    });
    deps.recorder.onStop((res) => {
        stopAt = Date.now();
        const recordMs = stopAt - pressStartAt;
        if (cancelled) {
            return; // 上滑取消:丢弃本次录音
        }
        callbacks.onTranscribing();
        void (async () => {
            try {
                const base64 = await deps.readFileBase64(res.tempFilePath);
                const result = await deps.transcribe(base64, exports.VOICE_FORMAT);
                const text = result.ok ? cleanTranscript(result.text) : "";
                appendTiming({
                    recordMs,
                    asrMs: Date.now() - stopAt,
                    chars: text.length,
                    at: new Date().toISOString(),
                });
                if (cancelled) {
                    return;
                }
                if (result.ok) {
                    callbacks.onStop(text);
                }
                else if (result.error === "INVALID_INPUT") {
                    callbacks.onError("RECORD_TOO_SHORT", voiceErrorMessage("RECORD_TOO_SHORT"));
                }
                else {
                    callbacks.onError("ASR_UNAVAILABLE", result.message || voiceErrorMessage("ASR_UNAVAILABLE"));
                }
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (/readFile|base64/i.test(msg)) {
                    callbacks.onError("READ_FAIL", voiceErrorMessage("READ_FAIL"));
                }
                else {
                    callbacks.onError("ASR_UNAVAILABLE", voiceErrorMessage("ASR_UNAVAILABLE"));
                }
            }
        })();
    });
    deps.recorder.onError(() => {
        if (cancelled) {
            return;
        }
        callbacks.onError("RECORD_FAIL", voiceErrorMessage("RECORD_FAIL"));
    });
    return {
        start() {
            try {
                // 16kHz 单声道 wav:腾讯云一句话识别推荐输入
                deps.recorder.start({
                    format: exports.VOICE_FORMAT,
                    duration: 60000,
                    sampleRate: 16000,
                    numberOfChannels: 1,
                    frameSize: 4
                });
                return true;
            }
            catch (e) {
                callbacks.onError("RECORD_FAIL", voiceErrorMessage("RECORD_FAIL"));
                return false;
            }
        },
        stop() {
            try {
                deps.recorder.stop();
            }
            catch (e) {
                callbacks.onError("RECORD_FAIL", voiceErrorMessage("RECORD_FAIL"));
            }
        },
    };
}
const TIMINGS_KEY = "voice_timings";
const MAX_TIMINGS = 50;
function appendTiming(timing) {
    try {
        const raw = wx.getStorageSync(TIMINGS_KEY);
        const list = Array.isArray(raw) ? raw : [];
        list.push(timing);
        wx.setStorageSync(TIMINGS_KEY, list.slice(-MAX_TIMINGS));
    }
    catch (e) {
        // 埋点失败不影响主流程
    }
}
/** 读取埋点(导出耗时分解用) */
function loadTimings() {
    try {
        const raw = wx.getStorageSync(TIMINGS_KEY);
        return Array.isArray(raw) ? raw : [];
    }
    catch (e) {
        return [];
    }
}
/** 生产依赖:小程序原生能力 + 云函数 */
function createDefaultVoiceDeps() {
    const recorder = wx.getRecorderManager();
    const fs = wx.getFileSystemManager();
    return {
        recorder,
        readFileBase64(filePath) {
            return new Promise((resolve, reject) => {
                fs.readFile({
                    filePath,
                    encoding: "base64",
                    success: (r) => {
                        const data = typeof r.data === "string" ? r.data : "";
                        if (data) {
                            resolve(data);
                        }
                        else {
                            reject(new Error("readFile empty"));
                        }
                    },
                    fail: (e) => reject(new Error("readFile fail: " + (e && e.errMsg))),
                });
            });
        },
        transcribe(audioBase64, voiceFormat) {
            return new Promise((resolve) => {
                wx.cloud.callFunction({
                    name: "transcribe",
                    data: { audio_base64: audioBase64, voice_format: voiceFormat },
                    success: (r) => {
                        const result = r.result;
                        if (result &&
                            typeof result === "object" &&
                            result.ok === true &&
                            typeof result.text === "string") {
                            resolve({ ok: true, text: result.text });
                        }
                        else if (result && typeof result === "object") {
                            const err = result;
                            resolve({
                                ok: false,
                                error: typeof err.error === "string" ? err.error : "ASR_UNAVAILABLE",
                                message: typeof err.message === "string" ? err.message : undefined,
                            });
                        }
                        else {
                            resolve({ ok: false, error: "ASR_UNAVAILABLE" });
                        }
                    },
                    fail: () => resolve({ ok: false, error: "ASR_UNAVAILABLE" }),
                });
            });
        },
    };
}
/** 录音授权:先查询,未决则发起 authorize;返回"已授权/被拒/未知" */
function ensureRecordAuth() {
    return new Promise((resolve) => {
        wx.getSetting({
            success(res) {
                const auth = res.authSetting["scope.record"];
                if (auth === true) {
                    resolve("authorized");
                    return;
                }
                if (auth === false) {
                    resolve("denied");
                    return;
                }
                wx.authorize({
                    scope: "scope.record",
                    success() {
                        resolve("authorized");
                    },
                    fail() {
                        resolve("denied");
                    },
                });
            },
            fail() {
                resolve("prompt");
            },
        });
    });
}
