/**
 * 语音录入封装(微信官方「同声传译」插件)。
 *
 * 设计:
 * - 插件 manager 的接线收敛在 createVoiceController 一处,回调式;
 * - 纯逻辑(错误映射、耗时埋点、上滑取消判定)拆为可离线测试的独立函数;
 * - 任何失败都如实上抛(码 + 中文文案),由页面给出重试与文字回退,
 *   绝不静默丢弃;录音授权(scope.record)由页面在进入语音模式时先行处理。
 */

/** 插件错误 ret 码 → 中文文案(与页面回退提示一致) */
export const VOICE_ERROR_MESSAGES: Record<number, string> = {
  [-6]: "未授予录音权限,请在设置中开启",
  [-10003]: "没有听清,请靠近一点再试",
  [-10006]: "说话时间太短,请按住说完再松手",
  [-10011]: "录音太长了,请分句说",
  [-10012]: "网络异常,语音识别失败",
  [-10013]: "语音识别失败,请重试",
};

/** 把插件 onError 的 ret 映射为可展示文案;未知码如实标注 */
export function voiceErrorMessage(ret: number): string {
  return VOICE_ERROR_MESSAGES[ret] || "语音识别失败(错误码 " + ret + "),请重试或改用文字";
}

/** 录音分段耗时埋点(毫秒),issue PR2 要求实测耗时分解 */
export interface VoiceTiming {
  /** 按住时长(录音) */
  recordMs: number;
  /** 松开 → 最终识别结果返回 */
  asrMs: number;
  /** 转写文本长度(字符数) */
  chars: number;
  at: string;
}

/** 聚合最近 N 条埋点,输出 p50/p95(耗时分解用) */
export function summarizeTimings(timings: VoiceTiming[], recentN = 20): {
  count: number;
  recordP50: number;
  asrP50: number;
  charsAvg: number;
} {
  const recent = timings.slice(-recentN);
  if (recent.length === 0) {
    return { count: 0, recordP50: 0, asrP50: 0, charsAvg: 0 };
  }
  const sorted = (key: "recordMs" | "asrMs") =>
    recent.map((t) => t[key]).sort((a, b) => a - b);
  const p50 = (arr: number[]) => arr[Math.floor(arr.length / 2)];
  const recordSorted = sorted("recordMs");
  const asrSorted = sorted("asrMs");
  const charsAvg =
    recent.reduce((sum, t) => sum + t.chars, 0) / recent.length;
  return {
    count: recent.length,
    recordP50: p50(recordSorted),
    asrP50: p50(asrSorted),
    charsAvg: Math.round(charsAvg),
  };
}

/** 上滑取消判定:触点向上位移超过阈值即视为取消(经典微信交互) */
export function isSlideUpCancel(
  startY: number,
  currentY: number,
  threshold = 60,
): boolean {
  return startY - currentY > threshold;
}

/** 去除转写文本首尾空白与常见口头填充(仅首尾,不改中间内容) */
export function cleanTranscript(text: string): string {
  return text
    .trim()
    .replace(/^[,。、,.\s]+/, "")
    .replace(/[,。、,.\s]+$/, "");
}

export interface VoiceControllerCallbacks {
  /** 录音开始 */
  onStart(): void;
  /** 实时中间识别结果 */
  onRecognize(partialText: string): void;
  /** 最终结果(已清洗;可为空字符串,代表无有效内容) */
  onStop(text: string): void;
  /** 失败(ret 为插件错误码;code 为本地归因) */
  onError(code: "PERMISSION" | "ASR" | "UNKNOWN", message: string, ret?: number): void;
}

export interface VoiceController {
  /** 开始录音识别;返回 false 表示插件不可用(此时页面应直接回退文字输入) */
  start(): boolean;
  /** 停止并等待最终结果 */
  stop(): void;
}

/** 录音识别中标记为取消:丢弃最终结果,不再回调 onStop */
let cancelled = false;

export function resetVoiceCancelled(): void {
  cancelled = false;
}

export function markVoiceCancelled(): void {
  cancelled = true;
}

/**
 * 接线同声传译插件。manager 由调用方注入便于测试;缺省时尝试 requirePlugin。
 * onStart/onRecognize/onStop/onError 的语义见 VoiceControllerCallbacks。
 */
export function createVoiceController(
  callbacks: VoiceControllerCallbacks,
  manager?: {
    onStart(cb: () => void): void;
    onRecognize(cb: (res: { result: string }) => void): void;
    onStop(cb: (res: { result: string }) => void): void;
    onError(cb: (res: { ret: number; msg?: string }) => void): void;
    start(options: Record<string, unknown>): void;
    stop(): void;
  } | null,
): VoiceController {
  let pressStartAt = 0;
  let stopAt = 0;
  if (manager === null || manager === undefined) {
    return {
      start() {
        callbacks.onError("UNKNOWN", "语音插件不可用,请改用文字输入");
        return false;
      },
      stop() {},
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
    const timing: VoiceTiming = {
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
      } catch (e) {
        callbacks.onError("UNKNOWN", "语音启动失败,请改用文字输入");
        return false;
      }
    },
    stop() {
      stopAt = Date.now();
      try {
        mgr.stop();
      } catch (e) {
        callbacks.onError("UNKNOWN", "语音停止失败,请重试");
      }
    },
  };
}

const TIMINGS_KEY = "voice_timings";
const MAX_TIMINGS = 50;

function appendTiming(timing: VoiceTiming): void {
  try {
    const raw = wx.getStorageSync(TIMINGS_KEY);
    const list: VoiceTiming[] = Array.isArray(raw) ? (raw as VoiceTiming[]) : [];
    list.push(timing);
    wx.setStorageSync(TIMINGS_KEY, list.slice(-MAX_TIMINGS));
  } catch (e) {
    // 埋点失败不影响主流程
  }
}

/** 读取埋点(导出耗时分解用) */
export function loadTimings(): VoiceTiming[] {
  try {
    const raw = wx.getStorageSync(TIMINGS_KEY);
    return Array.isArray(raw) ? (raw as VoiceTiming[]) : [];
  } catch (e) {
    return [];
  }
}

/** 惰性创建的控制器;插件未就绪时返回 null */
export function initVoiceController(
  callbacks: VoiceControllerCallbacks,
): VoiceController | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = requirePlugin("WechatSI") as any;
    const manager = plugin.getRecordRecognitionManager();
    return createVoiceController(callbacks, manager);
  } catch (e) {
    return createVoiceController(callbacks, null);
  }
}

/** 录音授权:先查询,未决则发起 authorize;返回"已授权/可发起/被拒" */
export function ensureRecordAuth(): Promise<"authorized" | "prompt" | "denied"> {
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
