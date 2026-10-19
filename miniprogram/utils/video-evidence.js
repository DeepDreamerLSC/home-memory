"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toVideoEvidenceView = toVideoEvidenceView;
exports.mapVideoEvidenceView = mapVideoEvidenceView;
exports.pickVideoEvidence = pickVideoEvidence;
function secondsText(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return m + ":" + (sec < 10 ? "0" + sec : String(sec));
}
function mapHighlightViews(row) {
    const list = Array.isArray(row.highlights) ? row.highlights : [];
    return list.map((h, index) => ({
        key: h.start_ms + "-" + h.end_ms + "-" + index,
        startMs: h.start_ms,
        endMs: h.end_ms,
        timeText: secondsText(h.start_ms) + " - " + secondsText(h.end_ms),
        hasBox: h.box !== null && h.box !== undefined,
    }));
}
function monthDay(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t))
        return "";
    const d = new Date(t);
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
function byCreatedDesc(a, b) {
    const ta = Date.parse(a.created_at);
    const tb = Date.parse(b.created_at);
    return (Number.isNaN(tb) ? -Infinity : tb) - (Number.isNaN(ta) ? -Infinity : ta);
}
function toVideoEvidenceView(row, currentLocationText) {
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
        durationMs: typeof row.duration_ms === "number" && Number.isFinite(row.duration_ms) ? row.duration_ms : 0,
        highlightVersion: Number.isInteger(row.highlight_version) && row.highlight_version >= 0 ? row.highlight_version : 0,
        highlightCount: Array.isArray(row.highlights) ? row.highlights.length : 0,
        highlights: mapHighlightViews(row),
    };
}
function mapVideoEvidenceView(rows, currentLocationText) {
    if (Array.isArray(rows) === false || rows.length === 0)
        return null;
    const valid = rows.filter((r) => r.consent_version === "v1");
    if (valid.length === 0)
        return null;
    const sorted = valid.slice().sort(byCreatedDesc);
    const views = sorted.map((r) => toVideoEvidenceView(r, currentLocationText));
    return { latest: views[0], older: views.slice(1), olderCount: views.length - 1 };
}
/** 搜索结果行的视频角标:每件只取最新一条换链成功、授权版本有效的视频。 */
function pickVideoEvidence(rows, itemIds) {
    const wanted = new Set(itemIds);
    const latest = new Map();
    for (const row of rows) {
        if (row.consent_version !== "v1" || wanted.has(row.item_id) === false || row.video_url === "")
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
