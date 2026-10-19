/**
 * 视频证据回放视图(单件留证 MVP)。
 * 视频只作为「当时记录在哪」的历史证据,不冒充当前位置;客户端不根据视频
 * 自动推断物品身份或高亮归属。默认折叠,只有用户明确点击才播放。
 */
import type { VideoEvidenceRow } from "../types";

export interface VideoEvidenceView {
  evidenceId: string;
  key: string;
  fileId: string;
  videoUrl: string;
  urlFail: boolean;
  aspect: string;
  badge: string;
  changed: boolean;
  subText: string;
  createdAt: string;
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
  return {
    evidenceId: row.evidence_id,
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
    createdAt: row.created_at,
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
  return { latest: views[0], older: views.slice(1), olderCount: views.length - 1 };
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
