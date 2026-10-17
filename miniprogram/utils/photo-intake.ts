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
 *   重试、云端零残留;PR #67 C3:photoCommit 回带 evidence_failed(证据写入失败
 *   的 item_id,物品已建)→ 页面提示「已入库 N 件,其中 M 件照片待关联」并经
 *   retryPhotoEvidence(itemsApi.photoEvidenceRetry)幂等重试关联;
 * - 上传路径规则(§10.4,PR #67 B2 修订):photo-evidence/{会话家庭}/{时间戳}-{随机}.jpg
 *   ——scopeId 段是服务端 file_id 归属验证依据;会话家庭未捕获时回退 "default"。
 *
 * 隐私口径(PR #67 B4 措辞精确化):照片在用户最终确认保存之前**不持久化、
 * 不写云存储**(识别的临时传输在 utils/photo-vl,首次使用需用户授权)——本文件
 * 唯一触上传的 commitPhotoBatch 只由保存确认弹层的「确认,记住了」按钮到达。
 *
 * 全部 wx API 依赖注入(partial 覆盖默认实现,离线测试零 wx);
 * 日志纪律:失败只记动作与错误码,绝不 log 图片路径内容/base64/物品名。
 */

import { callItemsApi, isApiError, uuid } from "./api";
import { householdScopeId } from "./household-scope";
import { composeNote } from "./intake-draft";
import type { IntakeRow } from "./intake-draft";
import {
  MOUNT_PATH_MAX_SEGMENTS,
  MOUNT_SEGMENT_MAX_CODEPOINTS,
} from "./batch-save";
import { callLocationsApi } from "./locations-api";
import type { Box } from "./photo-box";
import { recognizePhotoFile } from "./photo-vl";
import type { PhotoVlFileOutcome } from "./photo-vl";
import type {
  EnsureAndLinkResponse,
  ItemsApiEvent,
  LocationsApiEvent,
  PhotoCommitItem,
  PhotoCommitResponse,
  PhotoCommitResultRow,
  PhotoEvidenceRetryResponse,
  PhotoEvidenceRetryResultRow,
} from "../types";

type PhotoCommitEvent = Extract<ItemsApiEvent, { action: "photoCommit" }>;
type PhotoEvidenceRetryEvent = Extract<ItemsApiEvent, { action: "photoEvidenceRetry" }>;

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
  evidenceRetry(event: PhotoEvidenceRetryEvent): Promise<PhotoEvidenceRetryResponse>;
  /** 位置挂树(issue #65 ③):与语音确认流程完全相同的 locations.ensureAndLink */
  ensureAndLink(
    event: Extract<LocationsApiEvent, { action: "ensureAndLink" }>,
  ): Promise<EnsureAndLinkResponse>;
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
  evidenceRetry: (event) => callItemsApi(event),
  ensureAndLink: (event) => callLocationsApi(event),
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

/**
 * 上传云存储路径:photo-evidence/{scopeId}/{时间戳}-{随机}.jpg(§10.4,PR #67 B2)。
 * scopeId 段是服务端 file_id 归属验证的依据(必须=会话开批家庭的 household_id,
 * commitPhotoBatch 已如此传入;未捕获时回退 "default",服务端将按前缀不符拒绝);
 * 文件名 = 毫秒时间戳 + "-" + 随机 id,同批同图唯一、可读性不承载任何语义。
 */
export function photoCloudPath(scopeId: string, now: Date, id: string): string {
  return "photo-evidence/" + scopeId + "/" + now.getTime() + "-" + id + ".jpg";
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
  /** 会话开批时捕获的 household_id(B1:一致性绑定与上传路径前缀的唯一来源;
   *  null=开批时未捕获作用域,不带 marker、路径前缀用 "default") */
  scopeHouseholdId: string | null;
}

export type CommitPhotoBatchOutcome =
  | {
      ok: true;
      fileId: string;
      results: PhotoCommitResultRow[];
      /**
       * 证据写入失败的 item_id 列表(PR #67 C3,部分成功语义):这些件物品已建、
       * 照片待关联——页面保留续联载荷并提示重试关联(retryPhotoEvidence)
       */
      evidenceFailed: string[];
    }
  /** 上传失败:整批不提交、云端零残留、会话保留可重试 */
  | { ok: false; stage: "upload"; message: string }
  /** photoCommit 调用失败(网络/服务错误):fileId 已取得并回带,重试不再上传;
   *  error 为服务端错误码(如 SCOPE_MISMATCH,页面据此终止会话绝不重试) */
  | { ok: false; stage: "commit"; message: string; fileId: string; error?: string };

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
 * B1(PR #67):上传路径前缀与 expected_household_id 都取**会话开批时**捕获的
 * scopeHouseholdId(绝不是提交时刻的当前作用域)——中途切到另一家后保存,
 * 服务端派生家庭与会话家庭不一致 → SCOPE_MISMATCH 零写入。
 */
export async function commitPhotoBatch(
  input: CommitPhotoBatchInput,
  deps?: Partial<PhotoIntakeDeps>,
): Promise<CommitPhotoBatchOutcome> {
  const d = resolveDeps(deps);
  const scopeId = input.scopeHouseholdId !== null ? input.scopeHouseholdId : householdScopeId();
  let fileId = input.fileId;
  if (fileId === null || fileId === "") {
    if (input.rows.length === 0) {
      return { ok: false, stage: "commit", message: "没有要保存的候选", fileId: "" };
    }
    try {
      fileId = await uploadOnce(
        d,
        photoCloudPath(scopeId, d.now(), d.uuid()),
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
  const event: PhotoCommitEvent = {
    action: "photoCommit",
    batch_id: input.batchId,
    items,
  };
  if (input.scopeHouseholdId !== null) {
    // B1:会话家庭作为一致性绑定随事件上送(api 层自动 marker 不覆盖显式携带值);
    // 服务端与当前派生家庭不一致 → SCOPE_MISMATCH(绝不改投当前家庭)
    event.expected_household_id = input.scopeHouseholdId;
  }
  try {
    const res = await d.commit(event);
    // C3:证据写入失败如实回带(物品已建、照片待关联),页面据此提供幂等重试关联
    const evidenceFailed = Array.isArray(res.evidence_failed)
      ? res.evidence_failed.filter((id): id is string => typeof id === "string" && id !== "")
      : [];
    return { ok: true, fileId, results: res.results, evidenceFailed };
  } catch (e) {
    const message =
      e instanceof Error && e.message ? e.message : "保存失败,请稍后重试";
    const code = isApiError(e) ? e.code : undefined;
    return { ok: false, stage: "commit", message, fileId, error: code };
  }
}

// ---------- 证据幂等重试关联(§7.9,PR #67 C3) ----------

/** retryPhotoEvidence 入参:photoCommit 回带的 fileId + 待关联件(item_id 与行框/来源) */
export interface RetryPhotoEvidenceInput {
  fileId: string;
  imgW: number;
  imgH: number;
  items: { item_id: string; box: Box | null; source: "vl" | "circle" }[];
}

export type RetryPhotoEvidenceOutcome =
  | { ok: true; results: PhotoEvidenceRetryResultRow[] }
  /** 调用失败(网络/服务错误):载荷保留,可再点重试 */
  | { ok: false; message: string; error?: string };

/**
 * 证据待关联件的幂等重试(itemsApi.photoEvidenceRetry):服务端重验 file_id
 * 归属(B2 同款)与逐件作用域内存活后补插 photo_evidence,唯一索引冲突=已存在=
 * 成功——重复点击、中断重放都收敛,绝不重复落证据行。任何失败如实回带,
 * 由页面保留续联载荷供再试,绝不静默吞。
 */
export async function retryPhotoEvidence(
  input: RetryPhotoEvidenceInput,
  deps?: Partial<PhotoIntakeDeps>,
): Promise<RetryPhotoEvidenceOutcome> {
  const d = resolveDeps(deps);
  const event: PhotoEvidenceRetryEvent = {
    action: "photoEvidenceRetry",
    file_id: input.fileId,
    img_w: input.imgW,
    img_h: input.imgH,
    items: input.items.map((it) => ({ item_id: it.item_id, box: it.box, source: it.source })),
  };
  try {
    const res = await d.evidenceRetry(event);
    return { ok: true, results: res.results };
  } catch (e) {
    const message = e instanceof Error && e.message ? e.message : "照片关联失败,请稍后重试";
    const code = isApiError(e) ? e.code : undefined;
    return { ok: false, message, error: code };
  }
}

// ---------- 位置挂树(issue #65 V0.4 第③条:批次位置 + 逐件例外挂到节点树) ----------

/**
 * 确定性分段(#65 ③,新增决策;真机 2026-10-17 起为兜底层):拍照流程的位置是
 * 用户手输文本(如「玄关柜 · 第二层抽屉」),没有语音链路 extractDraft v2 的
 * mount_path 提取环节;确认页手动改位置 = 清空路径不挂靠,locations 侧的
 * parseLocation 是 LLM 候选+逐段人工核对(交互式),都不是「文本→路径段」的
 * 确定性机制——本函数按「·」「/」「-」「的」与空白切分,逐段 trim、空段丢弃,
 * 单段=单层。**分隔符规则拆不开无分隔符中文**(「书房桌子右边抽屉」整串一平段),
 * 故挂树分段现在是 LLM 逐字锚定优先(extractDraft.locationSplit,页面侧
 * locPathCache 预热,见 planPhotoMounts 的 cache 参数),本函数退为兜底:
 * LLM 未返回/失败/形状不合法时用之,保证保存绝不因异步拆分在途而阻塞。
 * 切分后仍须满足挂树路径形状门(与 batch-save / 服务端 cleanPathSegments 同限:
 * 1-6 段、每段 1-30 码点);超限一律返回空数组 = 该位置不挂(location_text 已随
 * photoCommit 落库,绝不猜路径、绝不截断改名)。
 */
export function splitLocationSegments(text: string): string[] {
  const segments = (typeof text === "string" ? text : "")
    .split(/[·/\-的\s]+/)
    .map((seg) => seg.trim())
    .filter((seg) => seg !== "");
  if (segments.length < 1 || segments.length > MOUNT_PATH_MAX_SEGMENTS) {
    return [];
  }
  if (segments.some((seg) => Array.from(seg).length > MOUNT_SEGMENT_MAX_CODEPOINTS)) {
    return [];
  }
  return segments;
}

/** 挂树目标件:item_id + 建档版本 + 稳定幂等键 */
export interface PhotoMountTarget {
  item_id: string;
  /** photoCommit 回执的建档后版本(ensureAndLink 的 expected_version) */
  expected_version: number;
  /**
   * 挂树幂等键:"photo:" + 行内 operationId——行内 operationId 全程稳定
   * (失败重试/会话恢复沿用),同一件无论重试多少次挂树都用同一键;服务端
   * ensureAndLink 幂等(TS-EAL-1:重复同路径 already:true 且 version 不再 +1,
   * 同 update_id 重放收敛),绝不重复挂。
   */
  update_id: string;
}

/** 挂树计划的单个位置条目(位置文本去重后的唯一清单之一) */
export interface PhotoMountPlanEntry {
  /** 位置原文(trim;批次位置或该件例外) */
  locationText: string;
  /** 层级分段(LLM 拆分缓存优先,否则分隔符规则兜底;形状不合法的位置不进 entries) */
  path: string[];
  /** 该位置下本轮已建的件 */
  items: PhotoMountTarget[];
}

/** 挂树计划:合法位置的唯一清单 + 无法挂树的已建件数 */
export interface PhotoMountPlan {
  entries: PhotoMountPlanEntry[];
  /**
   * 无法挂树的已建件数(回执缺 version=旧云函数窗口 / 位置分段形状不合法):
   * location_text 已随 photoCommit 落库,这些件照常在「尚未归类」,不阻断不回滚
   */
  skipped: number;
}

/**
 * 挂树路径形状门(与 splitLocationSegments 产物同限):LLM 拆分缓存同样不得
 * 越 6 段/30 码点——服务端已硬校验,这里兜客户端半边(如超长单段兜底路径),
 * 不过 → 调用方回落 splitLocationSegments 的既有口径。
 */
function isValidMountPath(path: unknown): path is string[] {
  if (!Array.isArray(path) || path.length < 1 || path.length > MOUNT_PATH_MAX_SEGMENTS) {
    return false;
  }
  return path.every(
    (seg) =>
      typeof seg === "string" &&
      Array.from(seg.trim()).length >= 1 &&
      Array.from(seg.trim()).length <= MOUNT_SEGMENT_MAX_CODEPOINTS,
  );
}

/**
 * 生成本轮挂树计划(纯函数):
 * - 有效位置 = 例外优先、批次位置兜底(与 buildPhotoCommitItems 的
 *   location_text 合成完全同款),按文本去重收集;
 * - 只收本轮 photoCommit 成功(item_id + version 齐)的件;失败件不挂(重试
 *   成功后由那轮回执挂),回执缺 version(旧云函数窗口)计入 skipped;
 * - 分段优先级:可选 cache(extractDraft.locationSplit 的 LLM 逐字锚定拆分,
 *   页面 fire-and-forget 预热)有该文本且形状合法 → 用之;否则现行为
 *   splitLocationSegments 分隔符规则兜底——**绝不因异步拆分未返回而阻塞保存**,
 *   保存时刻缓存里有什么就用什么,没有就走规则;
 * - 分段形状不合法的位置(超 6 段/超 30 码点段)不进 entries,该位置下的件
 *   全部计入 skipped——location_text 已落库,绝不猜路径。
 */
export function planPhotoMounts(
  rows: readonly IntakeRow[],
  results: readonly PhotoCommitResultRow[],
  batchLocation: string,
  cache?: Readonly<Record<string, string[]>>,
): PhotoMountPlan {
  const batch = (typeof batchLocation === "string" ? batchLocation : "").trim();
  const cachedPathOf = (locationText: string): string[] | null => {
    if (
      cache !== undefined &&
      cache !== null &&
      Object.prototype.hasOwnProperty.call(cache, locationText) &&
      isValidMountPath(cache[locationText])
    ) {
      return cache[locationText];
    }
    return null;
  };
  const byLocation = new Map<string, PhotoMountPlanEntry>();
  const order: string[] = [];
  let skipped = 0;
  for (const rr of results) {
    if (!rr.ok || rr.item_id === undefined) {
      continue; // 失败件不挂(行未终态,重试成功后由那轮回执挂)
    }
    if (typeof rr.version !== "number" || !Number.isInteger(rr.version) || rr.version < 1) {
      skipped += 1; // 旧云函数窗口:无版本回执,挂不了也不误报
      continue;
    }
    const row = rows[rr.index];
    if (!row) {
      continue;
    }
    const exc = typeof row.exc === "string" ? row.exc.trim() : "";
    const locationText = exc !== "" ? exc : batch;
    if (locationText === "") {
      continue; // 理论边路(保存门已要求批次位置非空):不挂不猜
    }
    let entry = byLocation.get(locationText);
    if (entry === undefined) {
      entry = {
        locationText,
        path: cachedPathOf(locationText) ?? splitLocationSegments(locationText),
        items: [],
      };
      byLocation.set(locationText, entry);
      order.push(locationText);
    }
    entry.items.push({
      item_id: rr.item_id,
      expected_version: rr.version,
      update_id: "photo:" + row.operationId,
    });
  }
  let invalidPathItems = 0;
  const entries: PhotoMountPlanEntry[] = [];
  for (const locationText of order) {
    const entry = byLocation.get(locationText) as PhotoMountPlanEntry;
    if (entry.path.length === 0) {
      invalidPathItems += entry.items.length; // 分段形状不合法:该位置下全部件不挂
      continue;
    }
    entries.push(entry);
  }
  return { entries, skipped: skipped + invalidPathItems };
}

/** mountPhotoItems 结果 */
export interface MountPhotoItemsOutcome {
  /** 实际发起的挂树调用次数 */
  attempted: number;
  /** 挂树失败件数(网络/冲突/跨家庭;物品已保存,绝不回滚) */
  failed: number;
}

/**
 * 执行挂树计划:逐位置逐件调 locations.ensureAndLink——与语音确认流程
 * (batch-save.saveRowWithMount → confirm 页)完全相同的 API 与语义:
 * 建缺失路径 + 版本条件更新挂上;created_from="manual"(路径段来自用户手输
 * 位置的确定性拆分,不是原话 parse)。挂树失败**不回滚不阻断不重试**:物品已
 * 保存、location_text 已落库,失败件由调用方轻提示「主界面可补」(该件在
 * 「尚未归类」)。顺序执行(与语音流程逐行串行同款),一件失败不影响其余件。
 */
export async function mountPhotoItems(
  plan: PhotoMountPlan,
  deps?: Partial<Pick<PhotoIntakeDeps, "ensureAndLink">>,
): Promise<MountPhotoItemsOutcome> {
  const d = resolveDeps(deps);
  let attempted = 0;
  let failed = 0;
  for (const entry of plan.entries) {
    for (const item of entry.items) {
      attempted += 1;
      try {
        await d.ensureAndLink({
          action: "ensureAndLink",
          item_id: item.item_id,
          path: entry.path,
          expected_version: item.expected_version,
          update_id: item.update_id,
          created_from: "manual",
        });
      } catch (e) {
        // 不回滚、不重试、不抛错:物品已记住,如实计数由调用方轻提示
        failed += 1;
      }
    }
  }
  return { attempted, failed };
}

/** 测试钩子:注入 wx API 依赖(partial 覆盖;null = 还原生产依赖) */
export function __setPhotoIntakeDepsForTest(partial: Partial<PhotoIntakeDeps> | null): void {
  testDepsPartial = partial === null ? {} : partial;
}
