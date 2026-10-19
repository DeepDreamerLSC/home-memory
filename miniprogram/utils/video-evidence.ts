/**
 * 视频证据视图与上传路径(纯函数 + 注入式 wx 胶水)。
 * 视频是「当时记录在哪」的历史证据,不冒充当前位置。
 */
import type { VideoEvidenceRow, VideoHighlight } from "../types";

export interface VideoHighlightView {
  startMs: number;
  endMs: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface VideoEvidenceView {
  key: string;
  fileId: string;
  videoUrl: string;
  urlFail: boolean;
  aspect: string;
  badge: string;
  changed: boolean;
  subText: string;
  highlights: VideoHighlightView[];
  firstHighlightMs: number;
}

export interface VideoEvidenceCollectionView {
  latest: VideoEvidenceView;
  older: VideoEvidenceView[];
  olderCount: number;
}

function monthDay(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
  return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function byCreatedDesc(a: VideoEvidenceRow, b: VideoEvidenceRow): number {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  return (Number.isNaN(tb) ? -Infinity : tb) - (Number.isNaN(ta) ? -Infinity : ta);
}

function mapHighlight(h: VideoHighlight): VideoHighlightView | null {
  if (h.end_ms > h.start_ms === false) return null;
  if (h.box === null) {
    return { startMs: h.start_ms, endMs: h.end_ms, left: 0, top: 0, width: 0, height: 0 };
  }
  return {
    startMs: h.start_ms,
    endMs: h.end_ms,
    left: round2(h.box.x1 * 100),
    top: round2(h.box.y1 * 100),
    width: round2((h.box.x2 - h.box.x1) * 100),
    height: round2((h.box.y2 - h.box.y1) * 100),
  };
}

export function toVideoEvidenceView(
  row: VideoEvidenceRow,
  currentLocationText: string,
): VideoEvidenceView {
  const md = monthDay(row.created_at);
  const captured = row.captured_location_text;
  const changed = captured.trim() !== currentLocationText.trim();
  const highlights = row.highlights
    .map(mapHighlight)
    .filter((h): h is VideoHighlightView => h !== null);
  const first = highlights.find((h) => h.width > 0 && h.height > 0);
  return {
    key: row.file_id,
    fileId: row.file_id,
    videoUrl: row.video_url,
    urlFail: row.video_url === "",
    aspect: row.video_w > 0 && row.video_h > 0 ? row.video_w + " / " + row.video_h : "16 / 9",
    badge: (md ? "🎬 拍摄于 " + md : "🎬 留证视频") + " · 当时记录:" + captured,
    changed,
    subText: changed
      ? "现在:" + currentLocationText.trim() + "(以文字为准);旧视频仅作证据"
      : "视频与当前记录一致",
    highlights,
    firstHighlightMs: first === undefined ? 0 : Math.max(0, first.startMs - 300),
  };
}

export function mapVideoEvidenceView(
  rows: VideoEvidenceRow[],
  currentLocationText: string,
): VideoEvidenceCollectionView | null {
  if (Array.isArray(rows) === false || rows.length === 0) return null;
  const sorted = rows.slice().sort(byCreatedDesc);
  const views = sorted.map((r) => toVideoEvidenceView(r, currentLocationText));
  return { latest: views[0], older: views.slice(1), olderCount: views.length - 1 };
}

export function highlightBoxAt(
  view: VideoEvidenceView,
  currentMs: number,
): VideoHighlightView | null {
  for (const h of view.highlights) {
    if (currentMs >= h.startMs && currentMs <= h.endMs && h.width > 0 && h.height > 0) {
      return h;
    }
  }
  return null;
}

export function pickVideoEvidence(
  rows: VideoEvidenceRow[],
  itemIds: string[],
): Record<string, { file_id: string; video_url: string }> {
  const wanted = new Set(itemIds);
  const latest = new Map<string, VideoEvidenceRow>();
  for (const row of rows) {
    if (wanted.has(row.item_id) === false || row.video_url === "") continue;
    const prev = latest.get(row.item_id);
    if (prev === undefined || byCreatedDesc(row, prev) < 0) latest.set(row.item_id, row);
  }
  const out: Record<string, { file_id: string; video_url: string }> = {};
  latest.forEach((row, id) => {
    out[id] = { file_id: row.file_id, video_url: row.video_url };
  });
  return out;
}

export function videoCloudPath(scopeId: string, now: Date, id: string): string {
  return "video-evidence/" + scopeId + "/" + now.getTime() + "-" + id + ".mp4";
}
