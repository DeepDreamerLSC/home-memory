/**
 * PR B 场景扫描客户端原语：
 * - 未知目标，多物品逐帧识别；帧计划复用 PR A 的 buildFramePlan；
 * - 抽帧复用 createVideoFrameSession（长边/质量/base64 上限/取消同源）；
 * - 每帧 observation 独立保留，绝不按同名/相邻帧自动合并物理身份；
 * - 用户显式生成 draft、合并/拆分后才可能形成最终 item；
 * - AI 原始候选/confidence 只在本页内存，不写 storage/云/服务端。
 */
import type {
  VideoEvidenceHighlightInput,
  VideoSceneCommitItem,
  VlCandidate,
} from "../types";
import type { Box } from "./photo-box";
import { uuid } from "./api";
import { normalizeForMatch } from "./item-match";
import {
  buildFramePlan,
  createVideoFrameSession,
  isVideoTargetError,
  VideoTargetError,
} from "./video-target";
import type {
  VideoFrameSession,
  VideoFrameSource,
  VideoTargetFramePlan,
} from "./video-target";

export const SCENE_ITEMS_MAX = 12;
export const SCENE_HIGHLIGHTS_MAX = 8;
export const SCENE_HIGHLIGHT_WINDOW_MS = 1500;

export type SceneFramePlan = VideoTargetFramePlan;

/** 用户确认页的一帧观察线索；不是物品事实，不持久化到服务端。 */
export interface SceneObservation {
  obsId: string;
  frameIndex: number;
  timeMs: number;
  windowStartMs: number;
  windowEndMs: number;
  framePath: string;
  frameWidth: number;
  frameHeight: number;
  name: string;
  qtyNote: string;
  confidence: "high" | "mid" | "low";
  box: Box | null;
}

export interface SceneFrameFailure {
  frameIndex: number;
  timeMs: number;
  message: string;
}

export interface SceneRecognizeFrameInput {
  image_base64: string;
  img_w: number;
  img_h: number;
}

export type SceneRecognizeFrameResult =
  | { ok: true; items: VlCandidate[]; truncated?: boolean }
  | { ok: false; error: string; message?: string };

export type SceneScanOutcome =
  | {
      ok: true;
      observations: SceneObservation[];
      framesTotal: number;
      framesScanned: number;
      failures: SceneFrameFailure[];
      truncatedFrames: number[];
      manualFallback: boolean;
    }
  | {
      ok: false;
      kind: "cancelled" | "unsupported" | "extract_failed" | "bad_response";
      message: string;
      observations: SceneObservation[];
      failures: SceneFrameFailure[];
    };

export interface SceneScanOptions {
  source: VideoFrameSource;
  durationMs: number;
  session?: VideoFrameSession;
  callRecognize: (input: SceneRecognizeFrameInput) => Promise<SceneRecognizeFrameResult>;
  onProgress?: (done: number, total: number, failures: number) => void;
  onObservation?: (observation: SceneObservation) => void;
}

export function planSceneFrames(durationMs: number): SceneFramePlan[] {
  return buildFramePlan(durationMs, { supplemental: true }).slice(0, 8);
}

function sceneError(error: unknown): string {
  if (isVideoTargetError(error)) return error.message;
  if (error && typeof error === "object") {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  }
  return "场景识别失败";
}

function observationId(): string {
  return "obs-" + uuid();
}

function normalizeBox(box: Box | null | undefined): Box | null {
  if (box === null || box === undefined) return null;
  const vals = [box.x1, box.y1, box.x2, box.y2];
  if (vals.every((v) => typeof v === "number" && Number.isFinite(v)) === false) return null;
  if (box.x1 < 0 || box.y1 < 0 || box.x2 > 1 || box.y2 > 1) return null;
  if (box.x1 >= box.x2 || box.y1 >= box.y2) return null;
  return { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 };
}

export async function scanSceneVideo(options: SceneScanOptions): Promise<SceneScanOutcome> {
  const plans = planSceneFrames(options.durationMs);
  const observations: SceneObservation[] = [];
  const failures: SceneFrameFailure[] = [];
  const truncatedFrames: number[] = [];
  if (plans.length === 0) {
    return { ok: false, kind: "extract_failed", message: "视频时长无效", observations, failures };
  }

  let session: VideoFrameSession;
  try {
    session = options.session || createVideoFrameSession(options.source, { durationMs: options.durationMs });
  } catch (e) {
    const kind = isVideoTargetError(e) && e.code === "unsupported" ? "unsupported" : "extract_failed";
    return { ok: false, kind, message: sceneError(e), observations, failures };
  }

  let scanned = 0;
  for (let i = 0; i < plans.length; i++) {
    if (session.cancelled) {
      return { ok: false, kind: "cancelled", message: "场景识别已取消", observations, failures };
    }
    const plan = plans[i];
    try {
      const frame = await session.captureAt(plan.timeMs, plan.frameIndex);
      if (session.cancelled) {
        return { ok: false, kind: "cancelled", message: "场景识别已取消", observations, failures };
      }
      const result = await options.callRecognize({
        image_base64: frame.base64,
        img_w: frame.width,
        img_h: frame.height,
      });
      scanned += 1;
      if (result.ok !== true) {
        failures.push({ frameIndex: plan.frameIndex, timeMs: plan.timeMs, message: result.message || result.error || "AI 识别暂不可用" });
      } else {
        if (result.truncated === true) truncatedFrames.push(plan.frameIndex);
        for (const item of result.items) {
          const name = typeof item.name === "string" ? item.name.trim() : "";
          if (name === "") continue;
          const observation: SceneObservation = {
            obsId: observationId(),
            frameIndex: frame.frameIndex,
            timeMs: frame.timeMs,
            windowStartMs: plan.windowStartMs,
            windowEndMs: plan.windowEndMs,
            framePath: frame.path,
            frameWidth: frame.width,
            frameHeight: frame.height,
            name,
            qtyNote: typeof item.qty_note === "string" ? item.qty_note : "",
            confidence: item.confidence === "high" || item.confidence === "mid" || item.confidence === "low" ? item.confidence : "low",
            box: normalizeBox(item.box),
          };
          observations.push(observation);
          if (options.onObservation) options.onObservation(observation);
        }
      }
    } catch (e) {
      if (session.cancelled || (isVideoTargetError(e) && e.code === "cancelled")) {
        return { ok: false, kind: "cancelled", message: "场景识别已取消", observations, failures };
      }
      failures.push({ frameIndex: plan.frameIndex, timeMs: plan.timeMs, message: sceneError(e) });
    }
    if (options.onProgress) options.onProgress(scanned, plans.length, failures.length);
  }

  return {
    ok: true,
    observations,
    framesTotal: plans.length,
    framesScanned: scanned,
    failures,
    truncatedFrames,
    manualFallback: observations.length === 0,
  };
}

/** 确认页草稿；draftKey/operationId 在冻结提交前保持稳定。 */
export interface SceneDraftItem {
  draftKey: string;
  observationIds: string[];
  manualHighlights: VideoEvidenceHighlightInput[];
  name: string;
  target: "new" | "existing";
  operationId: string;
  itemId: string;
  locationText: string;
  note: string;
  checked: boolean;
}

export interface SceneObservationGroup {
  nameKey: string;
  label: string;
  observations: SceneObservation[];
}

/**
 * 分组键(R0 契约 §1.1):委托 item-match 的 normalizeForMatch——与五级匹配
 * 同一口径(trim → NFKC → 小写 → 删空白 → 删常见标点)。「同名」只有一种定义:
 * 全半角(Ｍａｇ≡Mag)、空白与常见标点差异(充电器、≡充电器)归同键。
 * 这是字符级规范化,不是同义词归并;模糊匹配(isFuzzyMatch)不进分组。
 * 键为空(名称仅由标点/空白构成)由调用方回退 obsId 各成单条组。
 */
function nameKeyOf(name: string): string {
  return normalizeForMatch(name);
}

export function groupSceneObservations(observations: SceneObservation[]): SceneObservationGroup[] {
  const groups = new Map<string, SceneObservationGroup>();
  for (const obs of observations) {
    const key = nameKeyOf(obs.name) || obs.obsId;
    const prev = groups.get(key);
    if (prev === undefined) {
      groups.set(key, { nameKey: key, label: obs.name, observations: [obs] });
    } else {
      prev.observations.push(obs);
    }
  }
  return Array.from(groups.values());
}

export function newSceneDraft(partial?: Partial<SceneDraftItem>): SceneDraftItem {
  return {
    draftKey: partial?.draftKey || uuid(),
    observationIds: partial?.observationIds ? partial.observationIds.slice() : [],
    manualHighlights: partial?.manualHighlights ? partial.manualHighlights.map((h) => ({ ...h })) : [],
    name: partial?.name || "",
    target: partial?.target || "new",
    operationId: partial?.operationId || uuid(),
    itemId: partial?.itemId || "",
    locationText: partial?.locationText || "",
    note: partial?.note || "",
    checked: partial?.checked !== false,
  };
}

/**
 * 把用户选中的 observation 生成草稿。
 * mergeSameName===false（默认）：一条观察一个草稿，同名也分开，符合“同名绝不自动合并”。
 * mergeSameName===true：用户显式开启后，才按显示名归组为一个草稿。
 */
export function createDraftsFromObservations(
  observations: SceneObservation[],
  selectedIds: string[],
  options?: { mergeSameName?: boolean; batchLocation?: string },
): SceneDraftItem[] {
  const wanted = new Set(selectedIds);
  const selected = observations.filter((o) => wanted.has(o.obsId));
  if (options?.mergeSameName === true) {
    const groups = new Map<string, SceneObservation[]>();
    for (const obs of selected) {
      const key = nameKeyOf(obs.name) || obs.obsId;
      const list = groups.get(key);
      if (list === undefined) groups.set(key, [obs]);
      else list.push(obs);
    }
    return Array.from(groups.values()).map((list) =>
      newSceneDraft({
        observationIds: list.map((o) => o.obsId),
        name: list[0].name,
        locationText: options?.batchLocation || "",
        checked: true,
      }),
    );
  }
  return selected.map((obs) =>
    newSceneDraft({
      observationIds: [obs.obsId],
      name: obs.name,
      locationText: options?.batchLocation || "",
      checked: true,
    }),
  );
}

/** 用户显式合并多个草稿为一件；observation 不重复，仍保留各自 highlight。 */
export function mergeSceneDrafts(drafts: SceneDraftItem[], draftKeys: string[]): SceneDraftItem | null {
  const wanted = new Set(draftKeys);
  const picked = drafts.filter((d) => wanted.has(d.draftKey));
  if (picked.length < 2) return null;
  if (picked.some((d) => d.target === "existing")) return null;
  const obsIds: string[] = [];
  const manual: VideoEvidenceHighlightInput[] = [];
  for (const d of picked) {
    for (const id of d.observationIds) if (obsIds.indexOf(id) === -1) obsIds.push(id);
    for (const h of d.manualHighlights) manual.push({ ...h });
  }
  const first = picked[0];
  return newSceneDraft({
    draftKey: first.draftKey,
    operationId: first.operationId,
    name: first.name,
    locationText: first.locationText,
    note: first.note,
    observationIds: obsIds,
    manualHighlights: manual,
    checked: true,
  });
}

/**
 * 用户显式把一件拆成多件。每个 observation 一件；手动补的高亮也各自一件。
 * 同名是允许的，新 draft 拥有独立 operation_id，提交后是独立 item_id。
 */
export function splitSceneDraft(draft: SceneDraftItem): SceneDraftItem[] {
  if (draft.observationIds.length + draft.manualHighlights.length <= 1) return [draft];
  const out: SceneDraftItem[] = draft.observationIds.map((obsId) =>
    newSceneDraft({
      name: draft.name,
      locationText: draft.locationText,
      note: draft.note,
      observationIds: [obsId],
      checked: true,
    }),
  );
  for (const h of draft.manualHighlights) {
    out.push(
      newSceneDraft({
        name: draft.name,
        locationText: draft.locationText,
        note: draft.note,
        manualHighlights: [{ ...h }],
        checked: true,
      }),
    );
  }
  return out;
}

function clampHighlight(
  input: VideoEvidenceHighlightInput,
  durationMs: number,
): VideoEvidenceHighlightInput | null {
  const duration = Math.floor(durationMs);
  if (Number.isFinite(duration) === false || duration < 1) return null;
  let start = Math.max(0, Math.min(duration - 1, Math.floor(input.start_ms)));
  let end = Math.min(duration, Math.floor(input.end_ms));
  if (end <= start) end = Math.min(duration, start + 1);
  if (end <= start) {
    start = Math.max(0, duration - 1);
    end = duration;
  }
  if (end <= start) return null;
  const box = input.box === null ? null : normalizeBox(input.box);
  if (input.box !== null && box === null) return null;
  const out: VideoEvidenceHighlightInput = { start_ms: start, end_ms: end, box };
  const frameMs = input.frame_ms === undefined ? start : Math.floor(input.frame_ms);
  out.frame_ms = Math.max(start, Math.min(end - 1, frameMs));
  return out;
}

/** 一个 observation → 一条用户确认高亮；start 是代表帧，框对应 start。 */
export function observationHighlight(
  observation: SceneObservation,
  durationMs: number,
): VideoEvidenceHighlightInput {
  const duration = Math.max(1, Math.floor(durationMs));
  const start = Math.max(0, Math.min(duration - 1, Math.floor(observation.timeMs)));
  const end = Math.min(duration, start + SCENE_HIGHLIGHT_WINDOW_MS);
  return {
    start_ms: start,
    end_ms: end > start ? end : duration,
    box: observation.box === null ? null : { ...observation.box },
    frame_ms: start,
  };
}

export function buildDraftHighlights(
  draft: SceneDraftItem,
  observations: SceneObservation[],
  durationMs: number,
): VideoEvidenceHighlightInput[] {
  const byId = new Map(observations.map((o) => [o.obsId, o]));
  const out: VideoEvidenceHighlightInput[] = [];
  const seen = new Set<string>();
  for (const id of draft.observationIds) {
    const obs = byId.get(id);
    if (obs === undefined) continue;
    const cleaned = clampHighlight(observationHighlight(obs, durationMs), durationMs);
    if (cleaned === null) continue;
    const key = JSON.stringify(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  for (const raw of draft.manualHighlights) {
    const cleaned = clampHighlight(raw, durationMs);
    if (cleaned === null) continue;
    const key = JSON.stringify(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  out.sort((a, b) => (a.start_ms !== b.start_ms ? a.start_ms - b.start_ms : a.end_ms - b.end_ms));
  return out;
}

export type SceneCommitBuildResult =
  | { ok: true; items: VideoSceneCommitItem[] }
  | { ok: false; message: string };

export function buildSceneCommitItems(
  drafts: SceneDraftItem[],
  observations: SceneObservation[],
  durationMs: number,
): SceneCommitBuildResult {
  const picked = drafts.filter((d) => d.checked);
  if (picked.length < 1) return { ok: false, message: "请至少勾选一件物品" };
  if (picked.length > SCENE_ITEMS_MAX) return { ok: false, message: "一次最多确认 " + SCENE_ITEMS_MAX + " 件，请分批处理" };
  const existingSeen = new Set<string>();
  const items: VideoSceneCommitItem[] = [];
  for (const draft of picked) {
    const name = draft.name.trim();
    const location = draft.locationText.trim();
    const highlights = buildDraftHighlights(draft, observations, durationMs);
    if (highlights.length < 1) return { ok: false, message: name ? "「" + name + "」还没有可确认的高亮" : "有一件物品还没有可确认的高亮" };
    if (highlights.length > SCENE_HIGHLIGHTS_MAX) return { ok: false, message: "单件最多 " + SCENE_HIGHLIGHTS_MAX + " 条高亮，请取消多余线索后再保存" };
    if (draft.target === "existing") {
      if (draft.itemId === "") return { ok: false, message: "请选择要关联的已有物品" };
      if (existingSeen.has(draft.itemId)) return { ok: false, message: "同一件已有物品不能在一次提交中出现两次" };
      existingSeen.add(draft.itemId);
      items.push({
        draft_key: draft.draftKey,
        target: "existing",
        item_id: draft.itemId,
        highlights,
      });
    } else {
      if (name === "") return { ok: false, message: "请给每件新物品填写名称" };
      if (location === "") return { ok: false, message: "请给每件新物品填写位置" };
      if (draft.operationId === "") return { ok: false, message: "草稿参数异常，请重试" };
      items.push({
        draft_key: draft.draftKey,
        target: "new",
        operation_id: draft.operationId,
        name,
        location_text: location,
        note: draft.note.trim(),
        highlights,
      });
    }
  }
  return { ok: true, items };
}

/** 视图辅助：确认页只展示，不代表服务端状态。 */
export function sceneConfidenceText(confidence: "high" | "mid" | "low"): string {
  if (confidence === "high") return "较有把握";
  if (confidence === "mid") return "可能";
  return "不确定";
}

export function sceneHighlightCount(
  draft: SceneDraftItem,
  observations: SceneObservation[],
  durationMs: number,
): number {
  return buildDraftHighlights(draft, observations, durationMs).length;
}
