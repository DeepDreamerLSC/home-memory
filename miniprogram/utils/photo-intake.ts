/**
 * 拍照识物页面侧编排(#3,薄粘合层;IMPLEMENTATION.md §4.1):
 *
 * - takePhoto():chooseMedia(count:1, camera+album, compressed)→ 授权失败分类
 *   (§7.3:errMsg 含 "auth" → modal「需要相机权限」,去设置 / 从相册选兜底;
 *   相册本身无需授权;两次都取消 → 页面返回上一页);
 * - 识别不走本文件:交给 utils/photo-vl.ts 的 recognizePhotoFile(tempPath)
 *   (本地压缩→实测宽高→base64 直传 vlRecognize;**不上传**,prepared 只存页面内存);
 * - commitPhotoBatch():用户点「确认,记住了」后**先** wx.cloud.uploadFile 同一张
 *   压缩图(本批首次且唯一的上云动作;fileId 已取得则复用,绝不重复上传),
 *   **再**调 itemsApi.photoCommit 逐件落行;上传失败 → 整批不提交、如实提示可
 *   重试、云端零残留;
 * - 上传路径规则(§10.4):photo-evidence/{householdScopeId()}/{yyyyMM}/{uuid}.jpg
 *   (householdScopeId 未捕获时为 "default")。
 *
 * 隐私红线:照片在用户最终确认保存之前绝不上传云端——本文件唯一触上传的
 * commitPhotoBatch 只由保存确认弹层的「确认,记住了」按钮到达。
 *
 * 全部 wx API 依赖注入(partial 覆盖默认实现,离线测试零 wx);
 * 日志纪律:失败只记动作与错误码,绝不 log 图片路径内容/base64/物品名。
 */

import { callItemsApi, uuid } from "./api";
import { householdScopeId } from "./household-scope";
import { composeNote } from "./intake-draft";
import type { IntakeRow } from "./intake-draft";
import { recognizePhotoFile } from "./photo-vl";
import type { PhotoVlFileOutcome } from "./photo-vl";
import type {
  ItemsApiEvent,
  PhotoCommitItem,
  PhotoCommitResponse,
  PhotoCommitResultRow,
} from "../types";

type PhotoCommitEvent = Extract<ItemsApiEvent, { action: "photoCommit" }>;

/** 注入面:页面/测试只需覆盖关心的成员,其余落回 wx 默认实现 */
export interface PhotoIntakeDeps {
  chooseMedia(opts: {
    count?: number;
    mediaType?: string[];
    sourceType?: string[];
    sizeType?: string[];
    success: (res: { tempFiles: { tempFilePath: string }[] }) => void;
    fail: (err: { errMsg?: string }) => void;
  }): void;
  showModal(o: {
    title?: string;
    content?: string;
    confirmText?: string;
    cancelText?: string;
    success: (r: { confirm: boolean; cancel: boolean }) => void;
    fail?: () => void;
  }): void;
  openSetting(o: { success?: () => void; fail?: () => void }): void;
  getSetting(o: {
    success: (r: { authSetting: Record<string, boolean | undefined> }) => void;
    fail?: () => void;
  }): void;
  uploadFile(o: {
    cloudPath: string;
    filePath: string;
    success: (r: { fileID: string }) => void;
    fail: (err: { errMsg?: string }) => void;
  }): void;
  recognize(tempPath: string): Promise<PhotoVlFileOutcome>;
  commit(event: PhotoCommitEvent): Promise<PhotoCommitResponse>;
  uuid(): string;
  now(): Date;
}

function wxAvailable(): boolean {
  return typeof wx !== "undefined" && wx !== null;
}

const defaultDeps: PhotoIntakeDeps = {
  chooseMedia: (opts) => {
    if (!wxAvailable() || typeof wx.chooseMedia !== "function") {
      opts.fail({ errMsg: "chooseMedia:fail unavailable" });
      return;
    }
    wx.chooseMedia({
      count: opts.count,
      mediaType: opts.mediaType as "image"[] | undefined,
      sourceType: opts.sourceType as ("album" | "camera")[] | undefined,
      sizeType: opts.sizeType as ("original" | "compressed")[] | undefined,
      success: (res) =>
        opts.success({
          tempFiles: (res.tempFiles || []).map((f) => ({ tempFilePath: f.tempFilePath })),
        }),
      fail: (err) => opts.fail(err),
    });
  },
  showModal: (o) => {
    if (!wxAvailable() || typeof wx.showModal !== "function") {
      if (o.fail) {
        o.fail();
      }
      return;
    }
    wx.showModal({
      title: o.title,
      content: o.content,
      confirmText: o.confirmText,
      cancelText: o.cancelText,
      success: (r) => o.success({ confirm: r.confirm, cancel: r.cancel }),
      fail: () => {
        if (o.fail) {
          o.fail();
        }
      },
    });
  },
  openSetting: (o) => {
    if (!wxAvailable() || typeof wx.openSetting !== "function") {
      if (o.fail) {
        o.fail();
      }
      return;
    }
    wx.openSetting({ success: () => o.success && o.success(), fail: () => o.fail && o.fail() });
  },
  getSetting: (o) => {
    if (!wxAvailable() || typeof wx.getSetting !== "function") {
      if (o.fail) {
        o.fail();
      }
      return;
    }
    wx.getSetting({
      success: (r) => {
        const src = (r.authSetting || {}) as Record<string, boolean | undefined>;
        const authSetting: Record<string, boolean | undefined> = {};
        for (const k of Object.keys(src)) {
          authSetting[k] = src[k];
        }
        o.success({ authSetting });
      },
      fail: () => o.fail && o.fail(),
    });
  },
  uploadFile: (o) => {
    if (!wxAvailable() || !wx.cloud || typeof wx.cloud.uploadFile !== "function") {
      o.fail({ errMsg: "uploadFile:fail cloud unavailable" });
      return;
    }
    wx.cloud.uploadFile({
      cloudPath: o.cloudPath,
      filePath: o.filePath,
      success: (r) =>
        typeof r.fileID === "string" && r.fileID !== ""
          ? o.success({ fileID: r.fileID })
          : o.fail({ errMsg: "uploadFile: empty fileID" }),
      fail: (err) => o.fail(err),
    });
  },
  recognize: (tempPath) => recognizePhotoFile(tempPath),
  commit: (event) => callItemsApi(event),
  uuid: () => uuid(),
  now: () => new Date(),
};

/** 测试注入的依赖片段(undefined = 未注入);与显式入参合并,显式入参优先 */
let testDepsPartial: Partial<PhotoIntakeDeps> = {};

function resolveDeps(partial?: Partial<PhotoIntakeDeps>): PhotoIntakeDeps {
  return Object.assign({}, defaultDeps, testDepsPartial, partial);
}

// ---------- 拍照入口(§7.3 授权失败分类) ----------

/** 拍一张:成功给本地临时文件路径;放弃分类给页面(返回上一页/留在入口) */
export type TakePhotoOutcome =
  | { ok: true; tempFilePath: string }
  /** 用户明确放弃(两次都取消)→ 页面返回上一页 */
  | { ok: false; kind: "cancel" }
  /** 用户去系统设置开权限(页面留在入口态,回来可再拍) */
  | { ok: false; kind: "auth" };

function isAuthDenied(errMsg: string): boolean {
  // errMsg 含 "auth"(权限拒绝)→ 走授权分类;其余(用户直接取消相机/相册)不同
  return errMsg.indexOf("auth") !== -1;
}

function chooseOnce(
  d: PhotoIntakeDeps,
  sourceType: string[],
): Promise<{ ok: true; tempFilePath: string } | { ok: false; errMsg: string }> {
  return new Promise((resolve) => {
    d.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType,
      sizeType: ["compressed"],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        if (f && typeof f.tempFilePath === "string" && f.tempFilePath !== "") {
          resolve({ ok: true, tempFilePath: f.tempFilePath });
          return;
        }
        resolve({ ok: false, errMsg: "chooseMedia: empty tempFiles" });
      },
      fail: (err) => resolve({ ok: false, errMsg: (err && err.errMsg) || "chooseMedia:fail" }),
    });
  });
}

/** 相册兜底一次(相册本身无需授权;取消即放弃) */
function chooseFromAlbum(d: PhotoIntakeDeps): Promise<TakePhotoOutcome> {
  const r = chooseOnce(d, ["album"]);
  return r.then((res) =>
    res.ok ? { ok: true, tempFilePath: res.tempFilePath } : { ok: false, kind: "cancel" },
  );
}

/** 拍照入口:相机+相册 → 授权被拒分类兜底(§7.3) */
export async function takePhoto(deps?: Partial<PhotoIntakeDeps>): Promise<TakePhotoOutcome> {
  const d = resolveDeps(deps);
  const first = await chooseOnce(d, ["camera", "album"]);
  if (first.ok) {
    return { ok: true, tempFilePath: first.tempFilePath };
  }
  if (!isAuthDenied(first.errMsg)) {
    // 用户直接取消(没到权限层):视为放弃,由页面决定返回
    return { ok: false, kind: "cancel" };
  }
  // 权限被拒:讲清楚 + 两条路(去设置 / 从相册选——相册无需授权)
  const goSettings = await new Promise<boolean>((resolve) => {
    d.showModal({
      title: "需要相机权限",
      content: "拍照识物需要使用相机。可以到设置中开启,或从相册选一张。",
      confirmText: "去设置",
      cancelText: "从相册选",
      success: (r) => resolve(r.confirm === true),
      fail: () => resolve(false),
    });
  });
  if (goSettings) {
    d.openSetting({ success: () => {}, fail: () => {} });
    return { ok: false, kind: "auth" };
  }
  return chooseFromAlbum(d);
}

/** 相机授权预查(页面入口态提示用;不发起授权弹窗) */
export function ensurePhotoAuth(
  deps?: Partial<PhotoIntakeDeps>,
): Promise<"authorized" | "prompt" | "denied"> {
  const d = resolveDeps(deps);
  return new Promise((resolve) => {
    d.getSetting({
      success: (r) => {
        const auth = r.authSetting["scope.camera"];
        resolve(auth === true ? "authorized" : auth === false ? "denied" : "prompt");
      },
      fail: () => resolve("prompt"),
    });
  });
}

// ---------- 保存确认后的上传 + 批量建档(§7.6) ----------

/** 上传云存储路径:photo-evidence/{scopeId}/{yyyyMM}/{uuid}.jpg(§10.4) */
export function photoCloudPath(scopeId: string, now: Date, id: string): string {
  const m = now.getMonth() + 1;
  const yyyyMM = String(now.getFullYear()) + (m < 10 ? "0" + m : String(m));
  return "photo-evidence/" + scopeId + "/" + yyyyMM + "/" + id + ".jpg";
}

/**
 * 候选行 → photoCommit items(纯函数):
 * - location_text:该件例外优先,否则批次位置(客户端合成);
 * - note:"×{qty} {suffix}"(数量只是备注);
 * - reminder:行内可选提醒(kind 冻结词表;日期选择器选的,无 quote/非换算候选);
 * - photo:全行绑本批照片——box 取行框(null=整照关联),source 按行来源
 *   (circle=用户圈选,其余=vl 识别批)。
 */
export function buildPhotoCommitItems(
  rows: readonly IntakeRow[],
  batchLocation: string,
  photo: { file_id: string; img_w: number; img_h: number },
): PhotoCommitItem[] {
  return rows.map((r) => {
    const exc = typeof r.exc === "string" ? r.exc.trim() : "";
    const item: PhotoCommitItem = {
      operation_id: r.operationId,
      name: r.name,
      location_text: exc !== "" ? exc : batchLocation.trim(),
      note: composeNote(r.qty, r.suffix),
      photo: {
        file_id: photo.file_id,
        img_w: photo.img_w,
        img_h: photo.img_h,
        box: r.box,
        source: r.src === "circle" ? "circle" : "vl",
      },
    };
    if (r.remind && typeof r.remind.due_date === "string" && r.remind.due_date !== "") {
      item.reminder = {
        due_date: r.remind.due_date,
        kind: r.remind.kind,
        remind_converted: false,
      };
    }
    return item;
  });
}

/** commitPhotoBatch 入参 */
export interface CommitPhotoBatchInput {
  batchId: string;
  /** 已过滤的待存行(checked && !done;失败重试行沿用原 operation_id) */
  rows: readonly IntakeRow[];
  batchLocation: string;
  /** 本地压缩图(识别用的同一张;确认后上传的就是它) */
  localPath: string;
  imgW: number;
  imgH: number;
  /** 已取得的 fileID(重试复用,绝不重复上传);首次保存为 null */
  fileId: string | null;
}

export type CommitPhotoBatchOutcome =
  | { ok: true; fileId: string; results: PhotoCommitResultRow[] }
  /** 上传失败:整批不提交、云端零残留、会话保留可重试 */
  | { ok: false; stage: "upload"; message: string }
  /** photoCommit 调用失败(网络/服务错误):fileId 已取得并回带,重试不再上传 */
  | { ok: false; stage: "commit"; message: string; fileId: string };

function uploadOnce(
  d: PhotoIntakeDeps,
  cloudPath: string,
  filePath: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    d.uploadFile({
      cloudPath,
      filePath,
      success: (r) => resolve(r.fileID),
      fail: (err) => reject(new Error((err && err.errMsg) || "uploadFile:fail")),
    });
  });
}

/**
 * 用户已确认后的唯一上云动作编排:先上传(首次)得 file_id,再 photoCommit。
 * 上传失败 → 整批不提交(云端零残留);photoCommit 抛错 → 如实回带已得 fileId。
 */
export async function commitPhotoBatch(
  input: CommitPhotoBatchInput,
  deps?: Partial<PhotoIntakeDeps>,
): Promise<CommitPhotoBatchOutcome> {
  const d = resolveDeps(deps);
  let fileId = input.fileId;
  if (fileId === null || fileId === "") {
    if (input.rows.length === 0) {
      return { ok: false, stage: "commit", message: "没有要保存的候选", fileId: "" };
    }
    try {
      fileId = await uploadOnce(
        d,
        photoCloudPath(householdScopeId(), d.now(), d.uuid()),
        input.localPath,
      );
    } catch (e) {
      // 只记动作与错误码,绝不 log 文件内容
      console.error("[photo-intake] 照片上传失败:", (e instanceof Error && e.message) || "");
      return { ok: false, stage: "upload", message: "照片上传失败,请重试" };
    }
  }
  const items = buildPhotoCommitItems(input.rows, input.batchLocation, {
    file_id: fileId,
    img_w: input.imgW,
    img_h: input.imgH,
  });
  try {
    const res = await d.commit({
      action: "photoCommit",
      batch_id: input.batchId,
      items,
    });
    return { ok: true, fileId, results: res.results };
  } catch (e) {
    const message =
      e instanceof Error && e.message ? e.message : "保存失败,请稍后重试";
    return { ok: false, stage: "commit", message, fileId };
  }
}

/** 测试钩子:注入 wx API 依赖(partial 覆盖;null = 还原生产依赖) */
export function __setPhotoIntakeDepsForTest(partial: Partial<PhotoIntakeDeps> | null): void {
  testDepsPartial = partial === null ? {} : partial;
}
