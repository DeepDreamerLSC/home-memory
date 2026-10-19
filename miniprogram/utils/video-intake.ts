/**
 * 视频建档编排:选视频 -> 客户端抽帧识别 -> 用户勾选 -> 确认后上传原视频
 * -> itemsApi.videoCommit 批量建档 + 证据行。
 *
 * 隐私纪律:识别阶段只把抽出的帧临时传给 vlRecognize;原视频只在用户最终
 * 确认保存后上传,上传路径首段是本家庭 household_id(服务端归属硬门依据)。
 */
import { callItemsApi, uuid } from "./api";
import type {
  VideoCommitItem,
  VideoCommitResponse,
  VideoEvidenceRetryResponse,
  VideoHighlightInput,
  VideoInput,
} from "../types";
import { videoCloudPath } from "./video-evidence";

export interface PickedVideo {
  path: string;
  duration_ms: number;
  width: number;
  height: number;
  thumbPath: string;
  size: number;
}

export interface VideoIntakeRow {
  draftId: string;
  name: string;
  qty: number;
  qtyNote: string;
  checked: boolean;
  confidence: "high" | "mid" | "low";
  seenCount: number;
  highlights: VideoHighlightInput[];
}

export interface VideoIntakeDeps {
  chooseMedia(opt: {
    count: number;
    mediaType: ["video"];
    sourceType: ["camera", "album"];
    maxDuration: number;
    camera: "back";
  }): Promise<{ tempFiles: Array<{ tempFilePath: string; duration: number; width: number; height: number; thumbTempFilePath: string; size: number }> }>;
  uploadFile(opt: { cloudPath: string; filePath: string }): Promise<{ fileID: string }>;
  commit(event: {
    action: "videoCommit";
    batch_id: string;
    video: VideoInput;
    items: VideoCommitItem[];
  }): Promise<VideoCommitResponse>;
  retry(event: {
    action: "videoEvidenceRetry";
    video: VideoInput;
    items: Array<{ item_id: string; highlights?: VideoHighlightInput[] }>;
  }): Promise<VideoEvidenceRetryResponse>;
}

function wxAvailable(): boolean {
  return typeof wx !== "undefined" && wx !== null;
}

const defaultDeps: VideoIntakeDeps = {
  chooseMedia: (opt) =>
    new Promise((resolve, reject) => {
      wx.chooseMedia({
        ...opt,
        success: (res) => resolve({ tempFiles: res.tempFiles }),
        fail: (err) => reject(new Error((err && err.errMsg) || "chooseMedia:fail")),
      });
    }),
  uploadFile: (opt) =>
    new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath: opt.cloudPath,
        filePath: opt.filePath,
        success: (res) => resolve({ fileID: res.fileID }),
        fail: (err) => reject(new Error((err && err.errMsg) || "uploadFile:fail")),
      });
    }),
  commit: (event) => callItemsApi(event),
  retry: (event) => callItemsApi(event),
};

function depsOf(partial?: Partial<VideoIntakeDeps>): VideoIntakeDeps {
  return Object.assign({}, defaultDeps, partial || {});
}

export async function pickVideo(partial?: Partial<VideoIntakeDeps>): Promise<PickedVideo | null> {
  const d = depsOf(partial);
  try {
    const res = await d.chooseMedia({
      count: 1,
      mediaType: ["video"],
      sourceType: ["camera", "album"],
      maxDuration: 60,
      camera: "back",
    });
    const f = res.tempFiles && res.tempFiles[0];
    if (f === undefined || typeof f.tempFilePath !== "string") return null;
    return {
      path: f.tempFilePath,
      duration_ms: Math.max(1, Math.round((f.duration || 0) * 1000)),
      width: Math.max(1, Math.round(f.width || 0)),
      height: Math.max(1, Math.round(f.height || 0)),
      thumbPath: f.thumbTempFilePath || "",
      size: f.size || 0,
    };
  } catch (e) {
    return null;
  }
}

function composeNote(qty: number, qtyNote: string): string {
  const n = Math.max(1, Math.round(qty));
  const extra = qtyNote.trim();
  return extra === "" ? "×" + n : "×" + n + " " + extra;
}

export function buildVideoCommitItems(
  rows: readonly VideoIntakeRow[],
  batchLocation: string,
): VideoCommitItem[] {
  return rows
    .filter((r) => r.checked && r.name.trim() !== "")
    .map((r) => ({
      operation_id: r.draftId,
      name: r.name.trim(),
      location_text: batchLocation.trim(),
      note: composeNote(r.qty, r.qtyNote),
      highlights: r.highlights,
    }));
}

export interface CommitVideoInput {
  batchId: string;
  rows: readonly VideoIntakeRow[];
  batchLocation: string;
  video: PickedVideo;
  scopeId: string;
  /** 已取得的 fileID(重试复用,绝不重复上传) */
  fileId: string | null;
}

export interface CommitVideoOutcome {
  ok: boolean;
  fileId: string;
  video: VideoInput;
  results: VideoCommitResponse["results"];
  evidenceFailed: string[];
  message: string;
}

/** 用户确认后的唯一上传 + 建档编排;重试沿用 fileId,操作幂等。 */
export async function commitVideoBatch(
  input: CommitVideoInput,
  partial?: Partial<VideoIntakeDeps>,
): Promise<CommitVideoOutcome> {
  const d = depsOf(partial);
  const items = buildVideoCommitItems(input.rows, input.batchLocation);
  if (items.length === 0) {
    return {
      ok: false,
      fileId: input.fileId || "",
      video: { file_id: "", duration_ms: input.video.duration_ms, video_w: input.video.width, video_h: input.video.height },
      results: [],
      evidenceFailed: [],
      message: "请至少保留一件物品",
    };
  }
  let fileId = input.fileId;
  if (fileId === null || fileId === "") {
    try {
      const uploaded = await d.uploadFile({
        cloudPath: videoCloudPath(input.scopeId, new Date(), uuid()),
        filePath: input.video.path,
      });
      fileId = uploaded.fileID;
    } catch (e) {
      return {
        ok: false,
        fileId: "",
        video: { file_id: "", duration_ms: input.video.duration_ms, video_w: input.video.width, video_h: input.video.height },
        results: [],
        evidenceFailed: [],
        message: "视频上传失败,请稍后重试",
      };
    }
  }
  const video: VideoInput = {
    file_id: fileId,
    duration_ms: input.video.duration_ms,
    video_w: input.video.width,
    video_h: input.video.height,
  };
  try {
    const res = await d.commit({
      action: "videoCommit",
      batch_id: input.batchId,
      video,
      items,
    });
    return {
      ok: true,
      fileId,
      video,
      results: res.results,
      evidenceFailed: Array.isArray(res.evidence_failed) ? res.evidence_failed : [],
      message: "",
    };
  } catch (e) {
    return { ok: false, fileId, video, results: [], evidenceFailed: [], message: "视频建档失败,请稍后重试" };
  }
}

/** 证据写入失败后的幂等补关联;返回仍失败的 item_id(空=全部成功)。 */
export async function retryVideoEvidence(
  video: VideoInput,
  rows: readonly VideoIntakeRow[],
  itemIdByIndex: Record<number, string>,
  partial?: Partial<VideoIntakeDeps>,
): Promise<string[]> {
  const d = depsOf(partial);
  const picked = rows.filter((r) => r.checked);
  const items = picked.map((r, i) => ({ item_id: itemIdByIndex[i] || "", highlights: r.highlights }));
  if (items.some((x) => x.item_id === "")) return items.map((x) => x.item_id).filter((x) => x !== "");
  const res = await d.retry({ action: "videoEvidenceRetry", video, items });
  return res.results.filter((r) => r.ok === false).map((r) => r.item_id);
}
