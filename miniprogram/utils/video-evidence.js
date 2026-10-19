"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toVideoEvidenceView = toVideoEvidenceView;
exports.mapVideoEvidenceView = mapVideoEvidenceView;
exports.highlightBoxAt = highlightBoxAt;
exports.pickVideoEvidence = pickVideoEvidence;
exports.videoCloudPath = videoCloudPath;
function monthDay(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t))
        return "";
    const d = new Date(t);
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
function byCreatedDesc(a, b) {
    const ta = Date.parse(a.created_at);
    const tb = Date.parse(b.created_at);
    return (Number.isNaN(tb) ? -Infinity : tb) - (Number.isNaN(ta) ? -Infinity : ta);
}
function mapHighlight(h) {
    if (h.end_ms > h.start_ms === false)
        return null;
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
function toVideoEvidenceView(row, currentLocationText) {
    const md = monthDay(row.created_at);
    const captured = row.captured_location_text;
    const changed = captured.trim() !== currentLocationText.trim();
    const highlights = row.highlights
        .map(mapHighlight)
        .filter((h) => h !== null);
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
function mapVideoEvidenceView(rows, currentLocationText) {
    if (Array.isArray(rows) === false || rows.length === 0)
        return null;
    const sorted = rows.slice().sort(byCreatedDesc);
    const views = sorted.map((r) => toVideoEvidenceView(r, currentLocationText));
    return { latest: views[0], older: views.slice(1), olderCount: views.length - 1 };
}
function highlightBoxAt(view, currentMs) {
    for (const h of view.highlights) {
        if (currentMs >= h.startMs && currentMs <= h.endMs && h.width > 0 && h.height > 0) {
            return h;
        }
    }
    return null;
}
function pickVideoEvidence(rows, itemIds) {
    const wanted = new Set(itemIds);
    const latest = new Map();
    for (const row of rows) {
        if (wanted.has(row.item_id) === false || row.video_url === "")
            continue;
        const prev = latest.get(row.item_id);
        if (prev === undefined || byCreatedDesc(row, prev) < 0)
            latest.set(row.item_id, row);
    }
    const out = {};
    latest.forEach((row, id) => {
        out[id] = { file_id: row.file_id, video_url: row.video_url };
    });
    return out;
}
function videoCloudPath(scopeId, now, id) {
    return "video-evidence/" + scopeId + "/" + now.getTime() + "-" + id + ".mp4";
}
