"use strict";
/**
 * 拍照识物证据回放视图(#3,IMPLEMENTATION.md §6):photoEvidenceGet 证据行 →
 * 页面渲染视图的纯数据映射,零 wx 依赖。
 *
 * 文案纪律(设计合同 V0.4「照片=历史证据」):
 * - 照片只说明「拍摄于某日 · 当时记录在哪」,绝不冒充当前位置;
 * - 位置已变更时以文字位置为准,旧照片仅作证据(原型屏⑥围巾案例);
 * - 证据行没有 → 整卡不渲染(null),不存在「假证据」。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapEvidenceView = mapEvidenceView;
exports.pickEvidenceUrls = pickEvidenceUrls;
/** ISO 时间 → MM-DD(与页面 shortDate 同口径);非法时间返回空串,不编造日期 */
function monthDay(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) {
        return "";
    }
    const d = new Date(t);
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
/** 证据行时间戳(降序排序用);非法时间按最旧处理,不猜 */
function evidenceTime(row) {
    const t = Date.parse(row.created_at);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
/** 单行 → 渲染视图(文案纪律的唯一来源) */
function toPhotoView(row, currentLocationText) {
    const md = monthDay(row.created_at);
    const captured = row.captured_location_text;
    // 拍摄日期解析不出时不编造:去掉日期段,只保留「当时记录」的如实留痕
    const badge = (md ? "📷 拍摄于 " + md : "📷 留证照片") + " · 当时记录:" + captured;
    const current = currentLocationText.trim();
    const changed = captured.trim() !== current;
    return {
        key: row.file_id,
        photoUrl: row.photo_url,
        urlFail: row.photo_url === "",
        aspect: row.img_w > 0 && row.img_h > 0 ? row.img_w + " / " + row.img_h : "1 / 1",
        box: row.box === null
            ? null
            : {
                left: round2(row.box.x1 * 100),
                top: round2(row.box.y1 * 100),
                width: round2((row.box.x2 - row.box.x1) * 100),
                height: round2((row.box.y2 - row.box.y1) * 100),
            },
        badge,
        changed,
        subText: changed
            ? "现在:" + current + "(以文字为准);旧照片仅作证据"
            : "照片与当前记录一致",
    };
}
/**
 * 证据行集合 → 详情页证据卡视图。空集合 → null(整卡不渲染,无证据降级);
 * 非空按 created_at 降序取最新一张主显,其余进「更早的照片」列表。
 */
function mapEvidenceView(rows, currentLocationText) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return null;
    }
    const sorted = rows.slice().sort((a, b) => evidenceTime(b) - evidenceTime(a));
    const views = sorted.map((row) => toPhotoView(row, currentLocationText));
    return {
        latest: views[0],
        older: views.slice(1),
        olderCount: views.length - 1,
    };
}
/**
 * 搜索/找物结果行的证据缩略(#3):批量证据行 → item_id → 可显示的临时链接。
 * 只取每件 created_at 最新且换链成功(photo_url 非空)的一张——云存储文件
 * 跨成员不可直读,空链接没有可渲染的 src,一律不返回(该行保持纯文字)。
 */
function pickEvidenceUrls(rows, itemIds) {
    const wanted = new Set(itemIds);
    const latest = new Map();
    if (!Array.isArray(rows)) {
        return {};
    }
    for (const row of rows) {
        if (!wanted.has(row.item_id) || row.photo_url === "") {
            continue;
        }
        const prev = latest.get(row.item_id);
        if (prev === undefined || evidenceTime(row) > evidenceTime(prev)) {
            latest.set(row.item_id, row);
        }
    }
    const urls = {};
    latest.forEach((row, id) => {
        urls[id] = row.photo_url;
    });
    return urls;
}
