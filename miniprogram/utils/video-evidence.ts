/**
 * 视频证据回放视图(单件留证 + 用户确认片段定位)。
 *
 * 边界:
 * - 只展示 user_confirmed highlights;AI candidate/confidence 永不进入读模型;
 * - 视频只作为「当时记录在哪」的历史证据,不冒充当前位置;
 * - 普通入口默认折叠;定位只产生 seek,绝不在这里或页面胶水里自动 play。
 */
import type { VideoEvidenceHighlight, VideoEvidenceRow } from "../types";

export interface VideoHighlightBoxView {
  /** 0-100,直接用于播放器容器百分比定位 */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface VideoEvidenceHighlightView {
  key: string;
  startMs: number;
  endMs: number;
  /** 兼容 PR A 已上屏的短文案,如 "0:01 - 0:03" */
  timeText: string;
  timeLabel: string;
  rangeText: string;
  hasBox: boolean;
  box: VideoHighlightBoxView | null;
}

export interface VideoEvidenceView {
  evidenceId: string;
  itemId: string;
  key: string;
  fileId: string;
  videoUrl: string;
  urlFail: boolean;
  playable: boolean;
  aspect: string;
  badge: string;
  dateText: string;
  changed: boolean;
  subText: string;
  createdAt: string;
  durationMs: number;
  highlightVersion: number;
  highlightCount: number;
  highlights: VideoEvidenceHighlightView[];
  primaryHighlight: VideoEvidenceHighlightView | null;
}

export interface VideoEvidenceCollectionView {
  latest: VideoEvidenceView;
  older: VideoEvidenceView[];
  olderCount: number;
  all: VideoEvidenceView[];
}

export interface VideoPlaybackHint {
  evidenceId: string;
  startMs: number | null;
  endMs: number | null;
}

export interface VideoPlaybackBadge extends VideoPlaybackHint {
  playable: boolean;
  badgeText: string;
}

export type PlaybackFallbackReason =
  | "none"
  | "explicit_not_found"
  | "explicit_highlight_missing"
  | "explicit_url_failed"
  | "no_confirmed_highlight"
  | "all_urls_failed";

export interface VideoPlaybackTarget {
  mode: "highlight" | "video" | "unavailable" | "none";
  itemId: string;
  evidenceId: string | null;
  requestedEvidenceId: string | null;
  highlightKey: string | null;
  startMs: number;
  fallbackReason: PlaybackFallbackReason;
}

function secondsText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m + ":" + (sec < 10 ? "0" + sec : String(sec));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && Array.isArray(v) === false;
}

function mapHighlightBox(box: unknown): { ok: true; value: VideoHighlightBoxView | null } | { ok: false } {
  if (box === null || box === undefined) return { ok: true, value: null };
  if (isRecord(box) === false) return { ok: false };
  const x1 = box.x1;
  const y1 = box.y1;
  const x2 = box.x2;
  const y2 = box.y2;
  const values = [x1, y1, x2, y2];
  if (values.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) === false) {
    return { ok: false };
  }
  const left = x1 as number;
  const top = y1 as number;
  const right = x2 as number;
  const bottom = y2 as number;
  if (right <= left || bottom <= top) return { ok: false };
  return {
    ok: true,
    value: {
      left: round2(left * 100),
      top: round2(top * 100),
      width: round2((right - left) * 100),
      height: round2((bottom - top) * 100),
    },
  };
}

function parseHighlight(
  highlight: VideoEvidenceHighlight,
  index: number,
  durationMs: number,
): VideoEvidenceHighlightView | null {
  if (isRecord(highlight) === false) return null;
  if (highlight.source !== "user_confirmed") return null;
  const start = highlight.start_ms;
  const end = highlight.end_ms;
  if (Number.isSafeInteger(start) === false || Number.isSafeInteger(end) === false) return null;
  if ((start as number) < 0 || (end as number) <= (start as number)) return null;
  if (durationMs > 0 && (end as number) > durationMs) return null;
  const box = mapHighlightBox(highlight.box);
  if (box.ok === false) return null;
  return {
    key: start + "-" + end + "-" + index,
    startMs: start as number,
    endMs: end as number,
    timeText: secondsText(start as number) + " - " + secondsText(end as number),
    timeLabel: secondsText(start as number),
    rangeText: secondsText(start as number) + "–" + secondsText(end as number),
    hasBox: box.value !== null,
    box: box.value,
  };
}

function mapHighlightViews(row: VideoEvidenceRow): VideoEvidenceHighlightView[] {
  const list = Array.isArray(row.highlights) ? row.highlights : [];
  const duration = typeof row.duration_ms === "number" && Number.isFinite(row.duration_ms) ? row.duration_ms : 0;
  const parsed = list
    .map((h, index) => ({ h, index, view: parseHighlight(h, index, duration) }))
    .filter((entry): entry is { h: VideoEvidenceHighlight; index: number; view: VideoEvidenceHighlightView } => entry.view !== null);
  parsed.sort((a, b) => {
    if (a.view.startMs !== b.view.startMs) return a.view.startMs - b.view.startMs;
    if (a.view.endMs !== b.view.endMs) return a.view.endMs - b.view.endMs;
    return a.index - b.index;
  });
  return parsed.map((entry, index) => ({
    ...entry.view,
    key: entry.view.startMs + "-" + entry.view.endMs + "-" + index,
  }));
}

/** 行内默认点:先有框,再按 start/end 升序;不按 AI confidence(读模型也没有) */
export function defaultVideoHighlightView(
  highlights: VideoEvidenceHighlightView[] | null | undefined,
): VideoEvidenceHighlightView | null {
  if (Array.isArray(highlights) === false || highlights.length === 0) return null;
  const boxed = highlights.find((h) => h.hasBox === true);
  return boxed === undefined ? highlights[0] : boxed;
}

function monthDay(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
  return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function byCreatedDesc(a: VideoEvidenceRow, b: VideoEvidenceRow): number {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  return (Number.isNaN(tb) ? -Infinity : tb) - (Number.isNaN(ta) ? -Infinity : ta);
}

export function toVideoEvidenceView(
  row: VideoEvidenceRow,
  currentLocationText: string,
): VideoEvidenceView {
  const md = monthDay(row.created_at);
  const captured = row.captured_location_text;
  const changed = captured.trim() !== currentLocationText.trim();
  const highlights = mapHighlightViews(row);
  const durationMs = typeof row.duration_ms === "number" && Number.isFinite(row.duration_ms) ? row.duration_ms : 0;
  return {
    evidenceId: row.evidence_id,
    itemId: row.item_id,
    key: row.file_id,
    fileId: row.file_id,
    videoUrl: row.video_url,
    urlFail: row.video_url === "",
    playable: row.video_url !== "" && durationMs > 0,
    aspect: row.video_w > 0 && row.video_h > 0 ? row.video_w + " / " + row.video_h : "16 / 9",
    badge: (md ? "🎬 拍摄于 " + md : "🎬 留证视频") + " · 当时记录:" + captured,
    dateText: md || "留证视频",
    changed,
    subText: changed
      ? "现在:" + currentLocationText.trim() + "(以文字为准);旧视频仅作证据"
      : "视频与当前记录一致",
    createdAt: row.created_at,
    durationMs,
    highlightVersion: Number.isInteger(row.highlight_version) && row.highlight_version >= 0 ? row.highlight_version : 0,
    highlightCount: highlights.length,
    highlights,
    primaryHighlight: defaultVideoHighlightView(highlights),
  };
}

export function mapVideoEvidenceView(
  rows: VideoEvidenceRow[],
  currentLocationText: string,
): VideoEvidenceCollectionView | null {
  if (Array.isArray(rows) === false || rows.length === 0) return null;
  const valid = rows.filter((r) => r.consent_version === "v1");
  if (valid.length === 0) return null;
  const sorted = valid.slice().sort(byCreatedDesc);
  const views = sorted.map((r) => toVideoEvidenceView(r, currentLocationText));
  return { latest: views[0], older: views.slice(1), olderCount: views.length - 1, all: views };
}

/**
 * 选择当前 item 的最佳可播目标。只使用该 item 的 row;同一 file_id 出现在
 * 其他 item 行时不会进入这里。显式目标失效时回退默认链,并保留 requestedEvidenceId。
 */
export function selectVideoPlaybackTarget(
  views: VideoEvidenceView[],
  itemId: string,
  hint?: VideoPlaybackHint | null,
): VideoPlaybackTarget {
  const rows = Array.isArray(views) ? views.filter((v) => v.itemId === itemId) : [];
  const requestedEvidenceId = hint && hint.evidenceId ? hint.evidenceId : null;
  const requested = requestedEvidenceId === null ? undefined : rows.find((v) => v.evidenceId === requestedEvidenceId);
  let fallbackReason: PlaybackFallbackReason = "none";

  if (requestedEvidenceId !== null) {
    if (requested === undefined) {
      fallbackReason = "explicit_not_found";
    } else if (requested.playable === false) {
      fallbackReason = "explicit_url_failed";
    } else if (hint !== null && hint !== undefined && hint.startMs !== null && hint.endMs !== null) {
      const exact = requested.highlights.find(
        (h) => h.startMs === hint.startMs && h.endMs === hint.endMs,
      );
      if (exact !== undefined) {
        return {
          mode: "highlight",
          itemId,
          evidenceId: requested.evidenceId,
          requestedEvidenceId,
          highlightKey: exact.key,
          startMs: exact.startMs,
          fallbackReason: "none",
        };
      }
      fallbackReason = "explicit_highlight_missing";
    } else if (hint !== null && hint !== undefined) {
      return {
        mode: "video",
        itemId,
        evidenceId: requested.evidenceId,
        requestedEvidenceId,
        highlightKey: null,
        startMs: 0,
        fallbackReason: "none",
      };
    }
  }

  let fallbackRows = rows;
  if (requested !== undefined && requested.playable === false) {
    const requestedIndex = rows.findIndex((v) => v.evidenceId === requested.evidenceId);
    if (requestedIndex >= 0) fallbackRows = rows.slice(requestedIndex + 1);
  }
  const playable = fallbackRows.filter((v) => v.playable === true);
  const withHighlight = playable.filter((v) => v.highlights.length > 0);
  if (withHighlight.length > 0) {
    const chosen = withHighlight[0];
    const highlight = defaultVideoHighlightView(chosen.highlights);
    if (highlight !== null) {
      return {
        mode: "highlight",
        itemId,
        evidenceId: chosen.evidenceId,
        requestedEvidenceId,
        highlightKey: highlight.key,
        startMs: highlight.startMs,
        fallbackReason,
      };
    }
  }
  if (playable.length > 0) {
    const chosen = playable[0];
    return {
      mode: "video",
      itemId,
      evidenceId: chosen.evidenceId,
      requestedEvidenceId,
      highlightKey: null,
      startMs: 0,
      fallbackReason: fallbackReason === "none" ? "no_confirmed_highlight" : fallbackReason,
    };
  }
  if (rows.length > 0) {
    const chosen = requested === undefined ? rows[0] : requested;
    return {
      mode: "unavailable",
      itemId,
      evidenceId: chosen.evidenceId,
      requestedEvidenceId,
      highlightKey: null,
      startMs: 0,
      fallbackReason: requestedEvidenceId !== null ? "explicit_url_failed" : "all_urls_failed",
    };
  }
  return {
    mode: "none",
    itemId,
    evidenceId: null,
    requestedEvidenceId,
    highlightKey: null,
    startMs: 0,
    fallbackReason,
  };
}

/** 搜索结果行角标:每件只使用自己的 rows/highlights,不跨 file_id/item 合并。 */
export function pickVideoPlaybackHints(
  rows: VideoEvidenceRow[],
  itemIds: string[],
): Record<string, VideoPlaybackBadge> {
  const out: Record<string, VideoPlaybackBadge> = {};
  if (Array.isArray(rows) === false || Array.isArray(itemIds) === false) return out;
  const grouped = new Map<string, VideoEvidenceRow[]>();
  const wanted = new Set(itemIds);
  for (const row of rows) {
    if (wanted.has(row.item_id) === false) continue;
    const list = grouped.get(row.item_id);
    if (list === undefined) grouped.set(row.item_id, [row]);
    else list.push(row);
  }
  grouped.forEach((group, itemId) => {
    const view = mapVideoEvidenceView(group, "");
    if (view === null) return;
    const target = selectVideoPlaybackTarget(view.all, itemId, null);
    if (target.mode === "none" || target.evidenceId === null) return;
    const selected = view.all.find((v) => v.evidenceId === target.evidenceId);
    if (selected === undefined) return;
    if (target.mode === "unavailable") {
      out[itemId] = {
        evidenceId: selected.evidenceId,
        startMs: null,
        endMs: null,
        playable: false,
        badgeText: "▶ 暂不可播",
      };
      return;
    }
    if (target.mode === "highlight" && target.highlightKey !== null) {
      const highlight = selected.highlights.find((h) => h.key === target.highlightKey);
      if (highlight !== undefined) {
        out[itemId] = {
          evidenceId: selected.evidenceId,
          startMs: highlight.startMs,
          endMs: highlight.endMs,
          playable: true,
          badgeText: "▶ " + highlight.timeLabel,
        };
        return;
      }
    }
    out[itemId] = {
      evidenceId: selected.evidenceId,
      startMs: null,
      endMs: null,
      playable: true,
      badgeText: "▶ 视频",
    };
  });
  return out;
}

/** 搜索结果行的视频角标:每件只取最新一条换链成功、授权版本有效的视频。 */
export function pickVideoEvidence(
  rows: VideoEvidenceRow[],
  itemIds: string[],
): Record<string, { file_id: string; video_url: string }> {
  const wanted = new Set(itemIds);
  const latest = new Map<string, VideoEvidenceRow>();
  for (const row of rows) {
    if (row.consent_version !== "v1" || wanted.has(row.item_id) === false || row.video_url === "") continue;
    const prev = latest.get(row.item_id);
    if (prev === undefined || byCreatedDesc(row, prev) < 0) latest.set(row.item_id, row);
  }
  const out: Record<string, { file_id: string; video_url: string }> = {};
  latest.forEach((row, id) => {
    out[id] = { file_id: row.file_id, video_url: row.video_url };
  });
  return out;
}
