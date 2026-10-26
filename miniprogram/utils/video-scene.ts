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
  VideoSceneCommitNewItem,
  VlCandidate,
} from "../types";
import type { Box } from "./photo-box";
import { uuid } from "./api";
import { normalizeForMatch } from "./item-match";
import { isUnit, isValidCreateQuantity, UNIT_SET } from "./quantity";
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

/**
 * L2 断点续扫:每帧识别处理完(该帧 callRecognize 返回并处理完,含零候选)回调
 * 一次。ok=true 表示拿到确定结果(零候选也是完成——不能用「有无 observations」
 * 判断,零候选帧会被重复识别);ok=false 表示该帧识别失败(抽帧异常或 VL 返回
 * 失败),不算完成,续扫时自动重试。
 */
export interface SceneFrameDone {
  frameIndex: number;
  ok: boolean;
  truncated: boolean;
  /** 本帧新产出的观察;失败帧与零候选帧为空数组 */
  observations: SceneObservation[];
}

export interface SceneScanOptions {
  source: VideoFrameSource;
  durationMs: number;
  session?: VideoFrameSession;
  callRecognize: (input: SceneRecognizeFrameInput) => Promise<SceneRecognizeFrameResult>;
  onProgress?: (done: number, total: number, failures: number) => void;
  onObservation?: (observation: SceneObservation) => void;
  /** L2 断点续扫:这些帧此前已完成识别(含零候选),本轮跳过其 VL 调用 */
  skipFrameIndexes?: number[];
  /** L2 断点续扫:每帧识别处理完回调一次(含零候选与失败帧),页面据此落盘进度 */
  onFrameDone?: (frame: SceneFrameDone) => void;
}

export function planSceneFrames(durationMs: number): SceneFramePlan[] {
  return buildFramePlan(durationMs, { supplemental: true }).slice(0, 8);
}

/** L2 断点续扫:同一视频的帧计划确定性生成,总帧数单一来源(恢复判定用) */
export function sceneFrameTotal(durationMs: number): number {
  return planSceneFrames(durationMs).length;
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
  const skip = new Set(options.skipFrameIndexes ? options.skipFrameIndexes : []);
  for (let i = 0; i < plans.length; i++) {
    if (session.cancelled) {
      return { ok: false, kind: "cancelled", message: "场景识别已取消", observations, failures };
    }
    const plan = plans[i];
    if (skip.has(plan.frameIndex)) {
      // L2 断点续扫:已完成帧(含零候选)不再抽帧、不再调 VL,只计入进度
      scanned += 1;
      if (options.onProgress) options.onProgress(scanned, plans.length, failures.length);
      continue;
    }
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
        if (options.onFrameDone) options.onFrameDone({ frameIndex: plan.frameIndex, ok: false, truncated: false, observations: [] });
      } else {
        if (result.truncated === true) truncatedFrames.push(plan.frameIndex);
        const frameObservations: SceneObservation[] = [];
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
          frameObservations.push(observation);
          if (options.onObservation) options.onObservation(observation);
        }
        // 零候选帧也回调 ok=true(完成标记与观察存在性解耦,见 SceneFrameDone)
        if (options.onFrameDone) {
          options.onFrameDone({
            frameIndex: plan.frameIndex,
            ok: true,
            truncated: result.truncated === true,
            observations: frameObservations,
          });
        }
      }
    } catch (e) {
      if (session.cancelled || (isVideoTargetError(e) && e.code === "cancelled")) {
        return { ok: false, kind: "cancelled", message: "场景识别已取消", observations, failures };
      }
      failures.push({ frameIndex: plan.frameIndex, timeMs: plan.timeMs, message: sceneError(e) });
      if (options.onFrameDone) options.onFrameDone({ frameIndex: plan.frameIndex, ok: false, truncated: false, observations: [] });
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
  /**
   * 数量/单位(issue #102 Q3,Q0-CONTRACT §9.1):**用户在草稿行数量控件上
   * 显式确认的值**,与 observationIds/highlights 条数完全解耦——6 条线索合成
   * 1 件时数量控件未动 = 本字段缺席(提交不带数量键,服务端缺省 1/件),
   * 绝不由线索数赋值。设置时 quantity/unit 成组(1..9999 + UNIT_SET 成员),
   * 只随 target:"new" 提交;existing 关联永不携带(E7 边界)。
   * 合并/拆分产出的新草稿一律重置为缺席(总数逐行重新确认)。
   */
  quantity?: number;
  unit?: string;
  /**
   * B 页「归到」显式挂载(#116 PR A,D0-CONTRACT v2 §1):草稿行选择器选定的
   * 目标节点 id。选定时 locationText 同步写为节点路径文本(服务端权威口径);
   * 清除时移除本字段、locationText 保留用户可编辑文本(= 纯文本现状,零感知)。
   * 只随 target:"new" 提交;existing 行残留绝不进载荷(E7 类边界)。
   * 合并/拆分产出的新草稿一律重置(与数量纪律同款:归属逐行重新确认)。
   */
  nodeId?: string;
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
    quantity: partial?.quantity,
    unit: partial?.unit,
    nodeId: partial?.nodeId,
  };
}

/**
 * 草稿行数量步进(issue #102 Q3,Q0-CONTRACT §9.1):quantity 只来自用户触碰
 * (±1 起步值 1,钳 1..9999),首触同时补默认单位「件」——quantity/unit 成组,
 * 绝不发出 unit 单独在场的载荷。非整数步进无效返回原引用。步进值永不由
 * observationIds/highlights 条数推导(6 条线索 ≠ 6 件)。
 */
export function stepDraftQty(draft: SceneDraftItem, delta: number): SceneDraftItem {
  if (typeof delta !== "number" || Number.isInteger(delta) === false || delta === 0) {
    return draft;
  }
  const base = typeof draft.quantity === "number" ? draft.quantity : 1;
  const next = Math.min(9999, Math.max(1, base + delta));
  if (next === draft.quantity && draft.unit !== undefined) {
    return draft;
  }
  return {
    ...draft,
    quantity: next,
    unit: draft.unit !== undefined ? draft.unit : "件",
  };
}

/**
 * 草稿行单位选择(issue #102 Q3):unit 只来自选择器(UNIT_SET 闭集),闭集外
 * 值原样返回绝不写入;只选单位也把数量落成 1(成组,服务端永不收半对)。
 */
export function setDraftUnit(draft: SceneDraftItem, unit: string): SceneDraftItem {
  if (typeof unit !== "string" || UNIT_SET.indexOf(unit) === -1) {
    return draft;
  }
  if (unit === draft.unit && draft.quantity !== undefined) {
    return draft;
  }
  return {
    ...draft,
    unit,
    quantity: typeof draft.quantity === "number" ? draft.quantity : 1,
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

/**
 * 用户显式合并多个草稿为一件；observation 不重复，仍保留各自 highlight。
 * 数量纪律(issue #102 Q3):合并 = 新的物品身份,原草稿上用户确认过的数量
 * 不求和、不取线索数——数量/单位一律重置为缺席,由用户在合成行上重新确认
 * (L1:quantity 只来自用户确认;线索数永不赋值数量)。
 */
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
  // quantity/unit 刻意不透传:合成行数量必须重新确认(见函数头注释)
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
 * 数量纪律(issue #102 Q3):原草稿的数量是对「这一组」的断言,拆开即失效——
 * 拆分行一律不带数量(逐行重新确认);observationIds/高亮/时间窗各自保留。
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

/**
 * B 页「归到」路径缓存(#116 PR A):node_id → 节点路径段(选择器选定时记下,
 * 页面内存态)。build 时在场则做客户端第一道一致性校验(与 D1 页同款);会话
 * 恢复后缓存缺失则照常透传——服务端权威校验(location_text === 节点路径)是
 * 第二道门。
 */
export type SceneNodePaths = Record<string, readonly string[]>;

export function buildSceneCommitItems(
  drafts: SceneDraftItem[],
  observations: SceneObservation[],
  durationMs: number,
  nodePaths?: SceneNodePaths,
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
      // 数量字段刻意不携带(E7 边界):existing 关联不碰数量,数量变更只走
      // update/quantityAdjust 的 CAS 路径;即便草稿行残留数量也绝不进载荷
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
      // 数量/单位(issue #102 Q3,Q0-CONTRACT §4.4/§9.1):只透传用户在草稿行
      // 显式确认的值;缺席 = 不带键(服务端缺省 1/件,签名与现行逐字节一致)。
      // observationIds/highlights 条数永不赋值数量——形状门 fail-closed 整批拒绝。
      if (draft.quantity !== undefined) {
        if (isValidCreateQuantity(draft.quantity) === false) {
          return { ok: false, message: "「" + name + "」的数量需为 1-9999 的整数" };
        }
        if (isUnit(draft.unit) === false) {
          return { ok: false, message: "「" + name + "」的单位无效，请重新选择" };
        }
      } else if (draft.unit !== undefined) {
        return { ok: false, message: "「" + name + "」的数量还没确认，请先核对数量" };
      }
      const item: VideoSceneCommitNewItem = {
        draft_key: draft.draftKey,
        target: "new",
        operation_id: draft.operationId,
        name,
        location_text: location,
        note: draft.note.trim(),
        highlights,
      };
      // B 页「归到」(#116 PR A):显式选定节点 → 携带 node_id(显式携带才进服务端
      // 签名)。有路径缓存时校验 location_text 与节点路径逐字一致(客户端第一道
      // 门,D1 页同款);缓存缺失(会话恢复)照常透传,服务端权威校验兜底。
      if (draft.nodeId !== undefined && draft.nodeId !== "") {
        const path = nodePaths !== undefined ? nodePaths[draft.nodeId] : undefined;
        if (path !== undefined && location !== path.join(" / ")) {
          return { ok: false, message: "「" + name + "」的位置记录与所选位置不一致,请重选或清除后再改文字" };
        }
        item.node_id = draft.nodeId;
      }
      if (draft.quantity !== undefined) {
        item.quantity = draft.quantity;
        item.unit = draft.unit;
      }
      items.push(item);
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

/**
 * B 页保存完成文案(#116 PR A,D0-CONTRACT v2 §1 窗口二):凡有「已保存、
 * 未挂载」(ok:true 且 mounted:false,挂载被并发删节点/CAS 失败降级)的行,
 * 完成页文案必须如实区分,不得显示完整成功;全部挂载成功(或未携带挂载)时
 * 与现状文案逐字一致(零感知)。
 */
export function sceneDoneText(results: ReadonlyArray<{ ok: boolean; mounted?: boolean }>): string {
  const saved = results.filter((r) => r.ok === true).length;
  const unmounted = results.filter((r) => r.ok === true && r.mounted === false).length;
  if (unmounted > 0) {
    return "已为 " + saved + " 件物品保存同一段视频证据;其中 " + unmounted + " 件已保存、未挂载(所选位置刚有变化),稍后可在位置页整理。";
  }
  return "已为 " + saved + " 件物品保存同一段视频证据,每件高亮彼此独立。";
}

export function sceneHighlightCount(
  draft: SceneDraftItem,
  observations: SceneObservation[],
  durationMs: number,
): number {
  return buildDraftHighlights(draft, observations, durationMs).length;
}
