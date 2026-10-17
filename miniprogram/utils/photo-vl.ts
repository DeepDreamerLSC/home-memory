/**
 * 拍照识物客户端识别封装(#3):本地压缩 → base64 → extractDraft.vlRecognize 云函数。
 *
 * 隐私口径(#65 V0.4 合同第五项边界;PR #67 B4 措辞精确化):照片在用户最终确认
 * 保存之前**不持久化、不写云存储**——识别走 callFunction 载荷把本地压缩图的
 * base64 **临时传输**到云函数处理(传输即处理、内存态、不落盘;与语音链路
 * utils/voice.ts 的 readFile base64 → transcribe 同款先例);首次使用需用户在
 * photo 页授权(拒绝则本次不识别,只走手动/语音)。照片真正写入云存储只发生在
 * 用户确认后的保存流程(photo 页用 prepared.path 经 wx.cloud.uploadFile 得
 * file_id 再走 itemsApi.photoCommit)。
 *
 * 两段式 API:
 * - preparePhotoForVl(tempPath):压缩(长边 ≤1280、JPEG quality 70;失败则原样,
 *   如实)→ 取压缩后实际宽高(img_w/img_h 的唯一来源:识别与确认后上传的是同一张
 *   压缩图,坐标基准才一致)→ 读 base64。产物只存在内存,绝不写全局/存储。
 * - recognizeWithVl(prepared, {mode, region}):调云函数并做响应最小结构校验
 *   (形状非法整体判 bad_response,绝不半带异常件);圈选补识别(屏⑤)复用同一
 *   prepared(base64 不重复读盘),region 为用户圈选框 0-1。
 *
 * 降级(unavailable)路径:服务端 AI_UNAVAILABLE/manual_fallback、网络错、超时
 * → ok:false kind:"unavailable" manualFallback:true(页面 modal「拍照识别暂不可用,
 * 可手动添加」后仍进 photo 页,候选清单为空);INVALID_INPUT(照片太大等)→
 * kind:"invalid_photo"(提示重拍,留在入口)。
 *
 * 全部 wx API 依赖注入(partial 覆盖默认实现),离线测试零 wx。
 * 日志纪律:失败只记动作名与错误码,绝不 log base64/物品名。
 */

import type { Box } from "./photo-box";
import type { VlCandidate } from "../types";

/** 压缩目标:长边 ≤1280(IMPLEMENTATION §4.1/§7.4) */
export const PHOTO_VL_LONG_EDGE_MAX = 1280;
/** 压缩质量:JPEG quality 70 */
export const PHOTO_VL_JPEG_QUALITY = 70;
/**
 * base64 字符数上限(PR #67 B5):与服务端 vlRecognize 门同值(4,000,000 字符,
 * 为 callFunction 5MB 事件上限留 JSON 外壳余量)。压缩后仍超限 → 客户端直接
 * 判失败提示重拍,绝不发起注定超限的 callFunction。
 */
export const PHOTO_VL_MAX_BASE64_CHARS = 4000000;
/** 客户端调用超时:70s 严格大于服务端 config 60s(§4.3/§10) */
export const PHOTO_VL_CALL_TIMEOUT_MS = 70000;

const EXTRACT_DRAFT_FUNCTION = "extractDraft";

/** vlRecognize 客户端事件(image_base64 临时传输识别;确认前照片不写云存储) */
export interface VlRecognizeClientEvent {
  action: "vlRecognize";
  image_base64: string;
  /** 压缩后实际宽度 px(readFile 前经 wx.getImageInfo 实测) */
  img_w: number;
  img_h: number;
  mode?: "full" | "region";
  /** mode="region" 必带:用户圈选框 0-1(相对压缩后整图) */
  region?: { x1: number; y1: number; x2: number; y2: number };
}

/** 注入面:页面/测试只需覆盖关心的成员,其余落回 wx 默认实现 */
export interface PhotoVlDeps {
  getImageInfo(src: string): Promise<{ width: number; height: number }>;
  compressImage(
    src: string,
    quality: number,
    compressedWidth: number,
    compressedHeight: number,
  ): Promise<string>;
  readFileBase64(filePath: string): Promise<string>;
  callVl(event: VlRecognizeClientEvent): Promise<unknown>;
}

// ---------- 降级结果形态 ----------

export type PhotoVlFailureKind =
  /** 识别没成(服务端 AI_UNAVAILABLE / 网络错 / 超时)→ 可手动添加兜底 */
  | "unavailable"
  /** 服务端 INVALID_INPUT(照片太大等)→ 提示重拍,留在入口 */
  | "invalid_photo"
  /** 圈选区域形状非法(调用方 bug,页面按「不是,重圈」处理) */
  | "invalid_region"
  /** ok 响应结构非法(服务端契约回归) */
  | "bad_response"
  /** 取不到图片宽高(没有宽高就没有坐标契约,不猜,§7.4) */
  | "image_info_failed"
  /** 本地读文件失败(base64 拿不到) */
  | "read_failed";

export interface PhotoVlFailure {
  ok: false;
  kind: PhotoVlFailureKind;
  /** 可直接展示的中文文案 */
  message: string;
  /** true = 「拍照识别暂不可用,可手动添加」modal 后仍进 photo 页(空候选+手动添加) */
  manualFallback: boolean;
}

/** 识别成功(items 已过客户端最小结构校验) */
export interface PhotoVlSuccess {
  ok: true;
  items: VlCandidate[];
  imgW: number;
  imgH: number;
  /** true = 服务端截到前 10 件(如实透传,页面如实提示) */
  truncated: boolean;
}

/** 备好的识别输入:只存在内存(会话变量),绝不写 storage——确认前云端零残留 */
export interface PhotoVlPrepared {
  ok: true;
  /** 压缩产物(或压缩失败时的原文件)的本地临时路径:确认保存时上传的必须是这一张 */
  path: string;
  imgW: number;
  imgH: number;
  base64: string;
  /** true = 压缩成功;false = 压缩失败原样直传(如实,服务端 4,000,000 字符门兜底) */
  compressed: boolean;
}

export type PhotoVlPrepareResult = PhotoVlPrepared | PhotoVlFailure;
export type PhotoVlOutcome = PhotoVlSuccess | PhotoVlFailure;
/** 一步式(拍照后首次整图识别):成功时同时带回 prepared 供圈选复用与确认后上传 */
export type PhotoVlFileOutcome =
  | { ok: true; prepared: PhotoVlPrepared; items: VlCandidate[]; truncated: boolean }
  | PhotoVlFailure;

function fail(kind: PhotoVlFailureKind, message: string, manualFallback: boolean): PhotoVlFailure {
  return { ok: false, kind, message, manualFallback };
}

// ---------- 默认依赖(wx 实现;测试注入覆盖) ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function wxAvailable(): boolean {
  return typeof wx !== "undefined" && wx !== null;
}

const defaultDeps: PhotoVlDeps = {
  getImageInfo: (src) =>
    new Promise((resolve, reject) => {
      if (!wxAvailable() || typeof wx.getImageInfo !== "function") {
        reject(new Error("wx.getImageInfo unavailable"));
        return;
      }
      wx.getImageInfo({
        src,
        success: (res) => resolve({ width: res.width, height: res.height }),
        fail: (err) => reject(new Error((err && err.errMsg) || "getImageInfo:fail")),
      });
    }),
  compressImage: (src, quality, compressedWidth, compressedHeight) =>
    new Promise((resolve, reject) => {
      if (!wxAvailable() || typeof wx.compressImage !== "function") {
        reject(new Error("wx.compressImage unavailable"));
        return;
      }
      wx.compressImage({
        src,
        quality,
        compressedWidth,
        compressedHeight,
        success: (res) =>
          typeof res.tempFilePath === "string" && res.tempFilePath !== ""
            ? resolve(res.tempFilePath)
            : reject(new Error("compressImage: empty tempFilePath")),
        fail: (err) => reject(new Error((err && err.errMsg) || "compressImage:fail")),
      });
    }),
  readFileBase64: (filePath) =>
    new Promise((resolve, reject) => {
      if (
        !wxAvailable() ||
        !wx.getFileSystemManager ||
        typeof wx.getFileSystemManager !== "function"
      ) {
        reject(new Error("wx.getFileSystemManager unavailable"));
        return;
      }
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: "base64",
        success: (res) =>
          typeof res.data === "string" && res.data !== ""
            ? resolve(res.data)
            : reject(new Error("readFile: empty data")),
        fail: (err) => reject(new Error((err && err.errMsg) || "readFile:fail")),
      });
    }),
  callVl: (event) =>
    new Promise((resolve, reject) => {
      if (!wxAvailable() || !wx.cloud) {
        reject(new Error("cloud unavailable"));
        return;
      }
      let done = false;
      const timer = setTimeout(() => {
        if (done) {
          return;
        }
        done = true;
        reject(new Error("CLIENT_TIMEOUT"));
      }, PHOTO_VL_CALL_TIMEOUT_MS);
      wx.cloud.callFunction({
        name: EXTRACT_DRAFT_FUNCTION,
        data: event as unknown as WechatMiniprogram.IAnyObject,
        success: (res) => {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          resolve((res as { result?: unknown }).result);
        },
        fail: (err) => {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          // 只记函数名与错误码,绝不 log 事件体(base64 在里面)
          console.error(
            "[photo-vl] 云函数调用失败:",
            EXTRACT_DRAFT_FUNCTION,
            err && err.errMsg,
          );
          reject(new Error("CLIENT_NETWORK"));
        },
      });
    }),
};

function resolveDeps(partial?: Partial<PhotoVlDeps>): PhotoVlDeps {
  return partial === undefined ? defaultDeps : Object.assign({}, defaultDeps, partial);
}

// ---------- 第一步:压缩 + 宽高 + base64 ----------

/**
 * 备好识别输入(全部本地,零上送):
 * 1. wx.getImageInfo 取原尺寸(拿不到 → image_info_failed,没有宽高就没有坐标契约);
 * 2. 目标长边 ≤1280、quality 70 压缩(失败 → 原文件原样,如实,服务端 4,000,000 字符门兜底);
 * 3. 对**压缩后的那张**再取实际宽高(img_w/img_h 唯一来源——识别与确认后上传同图,
 *    坐标基准一致;压缩器未必精确命中目标尺寸,以实测为准);
 * 4. readFile 读裸 base64(直传云函数,不落云存储)。
 */
export async function preparePhotoForVl(
  tempPath: string,
  deps?: Partial<PhotoVlDeps>,
): Promise<PhotoVlPrepareResult> {
  const d = resolveDeps(deps);
  let original: { width: number; height: number };
  try {
    original = await d.getImageInfo(tempPath);
  } catch (e) {
    return fail("image_info_failed", "照片读取失败,请重拍", false);
  }
  if (!isFinite(original.width) || !isFinite(original.height) || !(original.width > 0) || !(original.height > 0)) {
    return fail("image_info_failed", "照片读取失败,请重拍", false);
  }

  let path = tempPath;
  let compressed = false;
  const scale = Math.min(1, PHOTO_VL_LONG_EDGE_MAX / Math.max(original.width, original.height));
  try {
    path = await d.compressImage(
      tempPath,
      PHOTO_VL_JPEG_QUALITY,
      Math.max(1, Math.round(original.width * scale)),
      Math.max(1, Math.round(original.height * scale)),
    );
    compressed = true;
  } catch (e) {
    path = tempPath; // 压缩失败:原样直传(如实);绝不编造压缩产物
  }

  let actual: { width: number; height: number };
  try {
    actual = await d.getImageInfo(path);
  } catch (e) {
    return fail("image_info_failed", "照片读取失败,请重拍", false);
  }
  if (!Number.isInteger(actual.width) || !Number.isInteger(actual.height) || actual.width < 1 || actual.height < 1) {
    return fail("image_info_failed", "照片读取失败,请重拍", false);
  }

  let base64: string;
  try {
    base64 = await d.readFileBase64(path);
  } catch (e) {
    return fail("read_failed", "照片读取失败,请重拍", false);
  }

  return { ok: true, path, imgW: actual.width, imgH: actual.height, base64, compressed };
}

// ---------- 第二步:调云函数 ----------

const CONFIDENCE_KINDS: readonly string[] = ["high", "mid", "low"];

/** box 形状门(服务端已保证 0-1 且 x2>x1/y2>y1;客户端防御,违反即契约回归) */
function validBox(v: unknown): Box | null {
  if (v === null || v === undefined) {
    return null;
  }
  if (!isRecord(v)) {
    return null;
  }
  const keys: Array<keyof Box> = ["x1", "y1", "x2", "y2"];
  const out: Box = { x1: 0, y1: 0, x2: 0, y2: 0 };
  for (const k of keys) {
    const n = v[k];
    if (typeof n !== "number" || !isFinite(n) || n < 0 || n > 1) {
      return null;
    }
    out[k] = n;
  }
  if (!(out.x2 > out.x1) || !(out.y2 > out.y1)) {
    return null;
  }
  return out;
}

/** 圈选区域校验(与服务端 validVlRegion 同口径:有限数 ∈[0,1] 且面积 >0) */
function validRegion(v: unknown): { x1: number; y1: number; x2: number; y2: number } | null {
  return validBox(v);
}

/**
 * 调 vlRecognize 并校验响应:
 * - **载荷预检门(B5)**:base64 超 4,000,000 字符 → 不发起 callFunction,直接
 *   invalid_photo「照片过大,请靠近重拍」(callFunction 事件整体上限 5MB,超限
 *   请求到不了函数;与服务端字符门同值,压缩后仍超限=极端大图,如实让用户重拍);
 * - ok:false → INVALID_INPUT 映射 invalid_photo(照片过大,请靠近重拍);AI_UNAVAILABLE
 *   映射 unavailable(manual_fallback 透传语义);其他错误码按 bad_response;
 * - ok:true → items 逐件最小结构校验(name 非空串、confidence 词表外 low、qty_note
 *   容错为空串、box 形状门),任一件硬形状非法 → 整体 bad_response(绝不半带);
 *   超 10 件 = 契约回归 → bad_response;
 * - 网络错/超时 → unavailable(识别没成,与 AI_UNAVAILABLE 同 UX:可手动添加)。
 */
export async function recognizeWithVl(
  prepared: PhotoVlPrepared,
  opts?: { mode?: "full" | "region"; region?: { x1: number; y1: number; x2: number; y2: number } },
  deps?: Partial<PhotoVlDeps>,
): Promise<PhotoVlOutcome> {
  const d = resolveDeps(deps);
  if (prepared.base64.length > PHOTO_VL_MAX_BASE64_CHARS) {
    // B5:绝不发起注定超限的调用(5MB 事件上限在网关层就会拒绝)
    return fail("invalid_photo", "照片过大,请靠近重拍", false);
  }
  const event: VlRecognizeClientEvent = {
    action: "vlRecognize",
    image_base64: prepared.base64,
    img_w: prepared.imgW,
    img_h: prepared.imgH,
  };
  if (opts !== undefined && opts.mode === "region") {
    const region = validRegion(opts.region);
    if (region === null) {
      return fail("invalid_region", "圈选区域无效,请重新圈选", false);
    }
    event.mode = "region";
    event.region = region;
  }

  let res: unknown;
  try {
    res = await d.callVl(event);
  } catch (e) {
    // 网络错/客户端超时:识别没成,与 AI_UNAVAILABLE 同一降级 UX(可手动添加)
    return fail("unavailable", "拍照识别暂不可用,可手动添加", true);
  }

  if (!isRecord(res)) {
    return fail("bad_response", "服务返回异常,请稍后重试", false);
  }
  if (res.ok === false) {
    const code = typeof res.error === "string" ? res.error : "";
    const message = typeof res.message === "string" && res.message.trim() !== "" ? res.message : "";
    if (code === "INVALID_INPUT") {
      // §7.4 固定文案:合法客户端触发 INVALID_INPUT 的唯一预期原因是大小门
      // (B5:4,000,000 字符;服务端文案「照片参数不合法」对用户无指引);
      // 留在入口重拍,不进 photo 页
      return fail("invalid_photo", "照片过大,请靠近重拍", false);
    }
    if (code === "AI_UNAVAILABLE") {
      return fail("unavailable", message || "拍照识别暂不可用,可手动添加", true);
    }
    return fail("bad_response", message || "服务返回异常,请稍后重试", false);
  }
  if (res.ok !== true || !Array.isArray(res.items)) {
    return fail("bad_response", "服务返回异常,请稍后重试", false);
  }
  if (res.items.length > 10) {
    return fail("bad_response", "服务返回异常,请稍后重试", false);
  }
  const items: VlCandidate[] = [];
  for (const raw of res.items) {
    if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.trim() === "") {
      return fail("bad_response", "服务返回异常,请稍后重试", false);
    }
    const box = raw.box === null || raw.box === undefined ? null : validBox(raw.box);
    if (box === null && raw.box !== null && raw.box !== undefined) {
      return fail("bad_response", "服务返回异常,请稍后重试", false);
    }
    items.push({
      name: raw.name,
      qty_note: typeof raw.qty_note === "string" ? raw.qty_note : "",
      confidence: CONFIDENCE_KINDS.indexOf(raw.confidence as string) !== -1
        ? (raw.confidence as VlCandidate["confidence"])
        : "low",
      box,
    });
  }
  return { ok: true, items, imgW: prepared.imgW, imgH: prepared.imgH, truncated: res.truncated === true };
}

/**
 * 一步式:拍照后首次整图识别(prepare + recognize)。
 * 成功时带回 prepared——页面存内存供:屏⑤圈选复用同一 base64、确认保存时上传
 * 同一张压缩图(prepared.path)得 file_id 走 photoCommit(坐标基准全程一致)。
 */
export async function recognizePhotoFile(
  tempPath: string,
  deps?: Partial<PhotoVlDeps>,
): Promise<PhotoVlFileOutcome> {
  const prepared = await preparePhotoForVl(tempPath, deps);
  if (!prepared.ok) {
    return prepared;
  }
  const outcome = await recognizeWithVl(prepared, undefined, deps);
  if (!outcome.ok) {
    return outcome;
  }
  return { ok: true, prepared, items: outcome.items, truncated: outcome.truncated };
}
