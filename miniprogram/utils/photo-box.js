"use strict";
/**
 * 拍照识物坐标换算纯函数(#3,docs/design/issue3-photo-intake/IMPLEMENTATION.md §3.2):
 * 归一 0-1 坐标(相对原图左上角)↔ 显示区 px,零 wx 依赖。
 *
 * 量纲与信任链(§3.1 红线的客户端半边):
 * - 存储/API 一律 0-1 + 原图宽高(img_w/img_h 恒随行携带,是唯一反算基准);
 * - 本层只做数学变换,不做任何「看值域猜量纲」的启发式;
 * - contain(等比完整显示)是本功能默认(photo 页与详情页证据卡都用它,零裁切);
 *   cover(满宽裁切)为未来布局预留——cover 下框允许越出显示区(偏移为负,
 *   由容器 overflow:hidden 裁掉),本层不夹取;
 * - 反向换算(屏⑤圈选触点 → 0-1)在 contain 语义下进行,触点落在信箱边外时
 *   clamp 到 [0,1](规格明确的唯一夹取点);
 * - 输出为精确浮点(§3.2 公式),取整属视图层渲染细节,本层不代劳。
 *
 * 容器宽高比纪律(§3.2):页面图片容器 aspect-ratio 一律设 img_w/img_h,
 * 从根上避免裁切错位;本模块是数学兜底与圈选反算的依据,不是布局的前提。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.containRect = containRect;
exports.coverRect = coverRect;
exports.containPointToNormalized = containPointToNormalized;
/**
 * contain / cover 共用的等比适配几何:算出显示图尺寸与信箱偏移。
 * 任一维度非正数(退化输入:原图或容器宽高 ≤0)返回 null,调用方以零矩形兜底
 * (不可信尺寸 → 不渲染框,与「越界=不可信」同一纪律)。
 */
function fitGeometry(imgW, imgH, dispW, dispH, pickScale) {
    if (!(imgW > 0) || !(imgH > 0) || !(dispW > 0) || !(dispH > 0)) {
        return null;
    }
    const scale = pickScale(dispW / imgW, dispH / imgH);
    const dw2 = imgW * scale;
    const dh2 = imgH * scale;
    return { dw2, dh2, ox: (dispW - dw2) / 2, oy: (dispH - dh2) / 2 };
}
function rectFrom(box, g) {
    return {
        left: g.ox + box.x1 * g.dw2,
        top: g.oy + box.y1 * g.dh2,
        width: (box.x2 - box.x1) * g.dw2,
        height: (box.y2 - box.y1) * g.dh2,
    };
}
const ZERO_RECT = { left: 0, top: 0, width: 0, height: 0 };
/**
 * contain / aspectFit(本功能默认):scale = min(dispW/imgW, dispH/imgH),
 * 等比完整显示,信箱居中。框永远落在显示图内(上游 box ∈ [0,1] 时)。
 * 宽或高为 0 的 box(退化框)合法:得到 0 宽/高的矩形,渲染为不可见。
 */
function containRect(box, imgW, imgH, dispW, dispH) {
    const g = fitGeometry(imgW, imgH, dispW, dispH, Math.min);
    return g === null ? { ...ZERO_RECT } : rectFrom(box, g);
}
/**
 * cover / aspectFill(预留):scale = max(dispW/imgW, dispH/imgH),满宽满高裁切。
 * 偏移为负,框允许越出显示区(容器 overflow:hidden 裁掉),本层不夹取。
 */
function coverRect(box, imgW, imgH, dispW, dispH) {
    const g = fitGeometry(imgW, imgH, dispW, dispH, Math.max);
    return g === null ? { ...ZERO_RECT } : rectFrom(box, g);
}
/**
 * 反向换算(屏⑤圈选):显示区触点(px)→ 原图 0-1,contain 语义。
 * 触点落在信箱边(上下/左右留白)外时 clamp 到 [0,1]——圈选从照片边缘起笔
 * 也得到有效框,绝不产出 [-0.2, 1.3] 这类越界归一值上送服务端。
 * 退化尺寸(原图或容器宽高 ≤0)返回 {0,0}(调用方此时不该再发起圈选)。
 */
function containPointToNormalized(px, py, imgW, imgH, dispW, dispH) {
    const g = fitGeometry(imgW, imgH, dispW, dispH, Math.min);
    if (g === null) {
        return { x: 0, y: 0 };
    }
    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    return {
        x: clamp01((px - g.ox) / g.dw2),
        y: clamp01((py - g.oy) / g.dh2),
    };
}
