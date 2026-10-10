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

/** 本地流程错误文案 */
export const VOICE_ERROR_MESSAGES: Record<string, string> = {
  RECORD_FAIL: "录音启动失败,请重试或改用文字",
  RECORD_TOO_SHORT: "说话时间太短,请按住说完再松手",
  READ_FAIL: "读取录音失败,请重试",
  ASR_UNAVAILABLE: "语音识别暂不可用,请重试或改用文字",
};

export function voiceErrorMessage(code: string): string {
  return VOICE_ERROR_MESSAGES[code] || "语音处理失败,请重试或改用文字";
}

/** 录音分段耗时埋点(毫秒),issue PR2 要求实测耗时分解 */
export interface VoiceTiming {
  /** 按住时长(录音) */
  recordMs: number;
  /** 松开 → 转写文字返回(含云函数执行 + ASR) */
  asrMs: number;
  /** 转写文本长度(字符数) */
  chars: number;
  at: string;
}

/** 聚合最近 N 条埋点,输出 p50(耗时分解用) */
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

/** 去除转写文本首尾空白与常见口头标点(仅首尾,不改中间内容) */
export function cleanTranscript(text: string): string {
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
export function isMeaningfulTranscript(text: string): boolean {
  const stripped = text.replace(/[嗯啊哦呃唉诶呀哈\s,。、,.\?!!?~～]/g, "");
  return stripped.length >= 2;
}

export interface VoiceControllerCallbacks {
  /** 录音开始 */
  onStart(): void;
  /** 录音停止、开始识别(界面可显示"识别中") */
  onTranscribing(): void;
  /** 最终结果(已清洗;空字符串代表无有效内容) */
  onStop(text: string): void;
  /** 失败(code 见 VOICE_ERROR_MESSAGES) */
  onError(code: string, message: string): void;
}

/** 依赖集合(均可注入便于离线测试) */
export interface VoiceDeps {
  recorder: {
    start(options: Record<string, unknown>): void;
    stop(): void;
    onStart(cb: () => void): void;
    onStop(cb: (res: { tempFilePath: string; duration?: number }) => void): void;
    onError(cb: (err: { errMsg?: string }) => void): void;
  };
  readFileBase64(filePath: string): Promise<string>;
  /** 云函数转写:成功 {ok:true,text},失败 {ok:false,...} */
  transcribe(audioBase64: string, voiceFormat: string): Promise<
    { ok: true; text: string } | { ok: false; error: string; message?: string }
  >;
}

export interface VoiceController {
  /** 开始录音;返回 false 表示启动失败(页面应回退文字输入) */
  start(): boolean;
  /** 停止录音并进入识别 */
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
 * 轻量按压会话标识:确保「授权回调、录音、取消、识别结果」属于同一次按压。
 * 解决的竞态:按下 → 请求录音授权(异步)→ 用户松手/离开页面/切换模式 →
 * 授权才返回 —— 此时不得再启动录音;会话已作废。
 */
export interface SessionGuard {
  /** 开始一次新的按压,返回本次会话号 */
  begin(): number;
  /** 作废当前会话(松手/离开/切换模式) */
  invalidate(): void;
  /** 会话是否仍有效 */
  isCurrent(session: number): boolean;
}

export function createSessionGuard(): SessionGuard {
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
export const VOICE_FORMAT = "mp3";

export function createVoiceController(
  callbacks: VoiceControllerCallbacks,
  deps: VoiceDeps,
): VoiceController {
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
        const result = await deps.transcribe(base64, VOICE_FORMAT);
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
        } else if (result.error === "INVALID_INPUT") {
          callbacks.onError("RECORD_TOO_SHORT", voiceErrorMessage("RECORD_TOO_SHORT"));
        } else {
          callbacks.onError("ASR_UNAVAILABLE", result.message || voiceErrorMessage("ASR_UNAVAILABLE"));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/readFile|base64/i.test(msg)) {
          callbacks.onError("READ_FAIL", voiceErrorMessage("READ_FAIL"));
        } else {
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
        // mp3/16k/单声道/24kbps:60 秒约 180KB,远小于 ASR 的 3MB(base64)限额
        deps.recorder.start({
          format: VOICE_FORMAT,
          duration: 60000,
          sampleRate: 16000,
          numberOfChannels: 1,
          encodeBitRate: 24000,
          frameSize: 4
        });
        return true;
      } catch (e) {
        callbacks.onError("RECORD_FAIL", voiceErrorMessage("RECORD_FAIL"));
        return false;
      }
    },
    stop() {
      try {
        deps.recorder.stop();
      } catch (e) {
        callbacks.onError("RECORD_FAIL", voiceErrorMessage("RECORD_FAIL"));
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

/** 生产依赖:小程序原生能力 + 云函数 */
export function createDefaultVoiceDeps(): VoiceDeps {
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
            } else {
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
            const result = (r as { result?: unknown }).result;
            if (
              result &&
              typeof result === "object" &&
              (result as { ok?: unknown }).ok === true &&
              typeof (result as { text?: unknown }).text === "string"
            ) {
              resolve({ ok: true, text: (result as { text: string }).text });
            } else if (result && typeof result === "object") {
              const err = result as { error?: unknown; message?: unknown };
              resolve({
                ok: false,
                error: typeof err.error === "string" ? err.error : "ASR_UNAVAILABLE",
                message: typeof err.message === "string" ? err.message : undefined,
              });
            } else {
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
