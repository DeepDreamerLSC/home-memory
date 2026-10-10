"use strict";
/**
 * 语音录入封装(微信官方「同声传译」插件)。
 *
 * 设计:
 * - 插件 manager 的接线收敛在 createVoiceController 一处,回调式;
 * - 纯逻辑(错误映射、耗时埋点、上滑取消判定)拆为可离线测试的独立函数;
 * - 任何失败都如实上抛(码 + 中文文案),由页面给出重试与文字回退,
 *   绝不静默丢弃;录音授权(scope.record)由页面在进入语音模式时先行处理。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VOICE_ERROR_MESSAGES = void 0;
exports.voiceErrorMessage = voiceErrorMessage;
exports.summarizeTimings = summarizeTimings;
exports.isSlideUpCancel = isSlideUpCancel;
exports.cleanTranscript = cleanTranscript;
exports.resetVoiceCancelled = resetVoiceCancelled;
exports.markVoiceCancelled = markVoiceCancelled;
exports.createVoiceController = createVoiceController;
exports.loadTimings = loadTimings;
exports.initVoiceController = initVoiceController;
exports.ensureRecordAuth = ensureRecordAuth;
/** 插件错误 ret 码 → 中文文案(与页面回退提示一致) */
exports.VOICE_ERROR_MESSAGES = {
    [-6]: "未授予录音权限,请在设置中开启",
    [-10003]: "没有听清,请靠近一点再试",
    [-10006]: "说话时间太短,请按住说完再松手",
    [-10011]: "录音太长了,请分句说",
    [-10012]: "网络异常,语音识别失败",
    [-10013]: "语音识别失败,请重试",
};
/** 把插件 onError 的 ret 映射为可展示文案;未知码如实标注 */
function voiceErrorMessage(ret) {
    return exports.VOICE_ERROR_MESSAGES[ret] || "语音识别失败(错误码 " + ret + "),请重试或改用文字";
}
/** 聚合最近 N 条埋点,输出 p50/p95(耗时分解用) */
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
/** 去除转写文本首尾空白与常见口头填充(仅首尾,不改中间内容) */
function cleanTranscript(text) {
    return text
        .trim()
        .replace(/^[,。、,.\s]+/, "")
        .replace(/[,。、,.\s]+$/, "");
}
/** 录音识别中标记为取消:丢弃最终结果,不再回调 onStop */
let cancelled = false;
function resetVoiceCancelled() {
    cancelled = false;
}
function markVoiceCancelled() {
    cancelled = true;
}
/**
 * 接线同声传译插件。manager 由调用方注入便于测试;缺省时尝试 requirePlugin。
 * onStart/onRecognize/onStop/onError 的语义见 VoiceControllerCallbacks。
 */
function createVoiceController(callbacks, manager) {
    let pressStartAt = 0;
    let stopAt = 0;
    if (manager === null || manager === undefined) {
        return {
            start() {
                callbacks.onError("UNKNOWN", "语音插件不可用,请改用文字输入");
                return false;
            },
            stop() { },
        };
    }
    const mgr = manager;
    mgr.onStart(() => {
        pressStartAt = Date.now();
        resetVoiceCancelled();
        callbacks.onStart();
    });
    mgr.onRecognize((res) => {
        callbacks.onRecognize(cleanTranscript(String(res && res.result ? res.result : "")));
    });
    mgr.onStop((res) => {
        const text = cleanTranscript(String(res && res.result ? res.result : ""));
        const timing = {
            recordMs: stopAt > 0 ? stopAt - pressStartAt : Date.now() - pressStartAt,
            asrMs: stopAt > 0 ? Date.now() - stopAt : 0,
            chars: text.length,
            at: new Date().toISOString(),
        };
        appendTiming(timing);
        if (cancelled) {
            // 用户已上滑取消:丢弃本次结果
            return;
        }
        callbacks.onStop(text);
    });
    mgr.onError((res) => {
        const ret = res && typeof res.ret === "number" ? res.ret : -1;
        const message = voiceErrorMessage(ret);
        if (cancelled) {
            return; // 取消过程中触发的错误(如松手过短)不打扰用户
        }
        callbacks.onError(ret === -6 ? "PERMISSION" : "ASR", message, ret);
    });
    return {
        start() {
            try {
                mgr.start({ duration: 60000, lang: "zh_CN" });
                return true;
            }
            catch (e) {
                callbacks.onError("UNKNOWN", "语音启动失败,请改用文字输入");
                return false;
            }
        },
        stop() {
            stopAt = Date.now();
            try {
                mgr.stop();
            }
            catch (e) {
                callbacks.onError("UNKNOWN", "语音停止失败,请重试");
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
/** 惰性创建的控制器;插件未就绪时返回 null */
function initVoiceController(callbacks) {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const plugin = requirePlugin("WechatSI");
        const manager = plugin.getRecordRecognitionManager();
        return createVoiceController(callbacks, manager);
    }
    catch (e) {
        return createVoiceController(callbacks, null);
    }
}
/** 录音授权:先查询,未决则发起 authorize;返回"已授权/可发起/被拒" */
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
