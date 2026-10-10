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
exports.createSessionGuard = createSessionGuard;
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
function createSessionGuard() {
    let current = 0;
    return {
        begin() {
            current += 1;
            return current;
        },
        invalidate() {
            current += 1;
        },
        isCurrent(session) {
            return session === current;
        },
    };
}
/**
 * 录音格式:mp3/16k/单声道/24kbps(压缩编码)。
 * 不用 wav(PCM):60 秒约 1.9MB、base64 约 2.5MB,贴近调用与接口上限;
 * mp3 下 60 秒仅约 180KB(base64 约 240KB),远小于 3MB 接口限额。
 */
exports.VOICE_FORMAT = "mp3";
function createVoiceController(callbacks, deps) {
    let seq = 0;
    /** 当前权威会话;新会话开始即替代并作废旧的 */
    let active = null;
    /** recorder.onStart 是否已为当前会话回调(松手早于实际启动时为 false) */
    let started = false;
    /** 耗时埋点:录音起止 */
    let pressStartAt = 0;
    let stopAt = 0;
    const endIfActive = (s) => {
        if (s !== null && active === s) {
            active = null;
        }
    };
    deps.recorder.onStart(() => {
        const s = active;
        if (s === null || s.cancelled) {
            // 迟到的启动回调,且会话已作废(松手/切换/离开早于 recorder.onStart):
            // 立即停止录音,不回调页面、不上传
            try {
                deps.recorder.stop();
            }
            catch (e) { /* 已停止 */ }
            return;
        }
        started = true;
        pressStartAt = Date.now();
        callbacks.onStart();
    });
    deps.recorder.onStop((res) => {
        const s = active;
        stopAt = Date.now();
        if (s === null || s.cancelled) {
            endIfActive(s);
            return; // 已作废的录音:丢弃文件,不上传
        }
        const recordMs = stopAt - pressStartAt;
        callbacks.onTranscribing();
        void (async () => {
            try {
                const base64 = await deps.readFileBase64(res.tempFilePath);
                const result = await deps.transcribe(base64, exports.VOICE_FORMAT);
                // 转写返回时再次校验:被取消或已被新会话替代 → 旧结果永久失效
                if (s.cancelled || active !== s) {
                    endIfActive(s);
                    return;
                }
                const text = result.ok ? cleanTranscript(result.text) : "";
                appendTiming({
                    recordMs,
                    asrMs: Date.now() - stopAt,
                    chars: text.length,
                    at: new Date().toISOString(),
                });
                if (result.ok) {
                    callbacks.onStop(text);
                }
                else if (result.error === "INVALID_INPUT") {
                    callbacks.onError("RECORD_TOO_SHORT", voiceErrorMessage("RECORD_TOO_SHORT"));
                }
                else {
                    callbacks.onError("ASR_UNAVAILABLE", result.message || voiceErrorMessage("ASR_UNAVAILABLE"));
                }
                endIfActive(s);
            }
            catch (e) {
                if (s.cancelled || active !== s) {
                    endIfActive(s);
                    return;
                }
                const msg = e instanceof Error ? e.message : String(e);
                if (/readFile|base64/i.test(msg)) {
                    callbacks.onError("READ_FAIL", voiceErrorMessage("READ_FAIL"));
                }
                else {
                    callbacks.onError("ASR_UNAVAILABLE", voiceErrorMessage("ASR_UNAVAILABLE"));
                }
                endIfActive(s);
            }
        })();
    });
    deps.recorder.onError(() => {
        const s = active;
        if (s === null || s.cancelled) {
            endIfActive(s);
            return;
        }
        endIfActive(s);
        callbacks.onError("RECORD_FAIL", voiceErrorMessage("RECORD_FAIL"));
    });
    return {
        begin() {
            // 替代性会话:旧会话(含在途 ASR)永久作废
            if (active !== null) {
                active.cancelled = true;
            }
            const s = { id: (seq += 1), cancelled: false };
            active = s;
            started = false;
            try {
                deps.recorder.start({
                    format: exports.VOICE_FORMAT,
                    duration: 60000,
                    sampleRate: 16000,
                    numberOfChannels: 1,
                    encodeBitRate: 24000,
                    frameSize: 4
                });
            }
            catch (e) {
                endIfActive(s);
                callbacks.onError("RECORD_FAIL", voiceErrorMessage("RECORD_FAIL"));
            }
            return s;
        },
        stop(session) {
            const s = session;
            if (s !== active || s.cancelled) {
                return;
            }
            if (!started) {
                // 松手早于 recorder.onStart:作废本次,停止录音且不上传
                s.cancelled = true;
                try {
                    deps.recorder.stop();
                }
                catch (e) { /* 已停止 */ }
                return;
            }
            try {
                deps.recorder.stop();
            }
            catch (e) {
                callbacks.onError("RECORD_FAIL", voiceErrorMessage("RECORD_FAIL"));
            }
        },
        cancel(session) {
            const s = session;
            s.cancelled = true;
            if (s === active) {
                try {
                    deps.recorder.stop();
                }
                catch (e) { /* 已停止 */ }
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
