"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PENDING_HIGHLIGHT_TTL_MS = void 0;
exports.setPendingLocationHighlight = setPendingLocationHighlight;
exports.consumePendingLocationHighlight = consumePendingLocationHighlight;
exports.locationsStackNodeIds = locationsStackNodeIds;
exports.navToLocationLayer = navToLocationLayer;
/**
 * 位置树跳转执行器(issue #121 第二波批次乙 ④,消费批次甲 #123 的
 * nav-highlight 纯工具;v2 横幅架构预审 6418877302)。
 *
 * 批次甲只定协议(纯函数,零 wx);本模块是它的**唯一执行侧**:
 * - 把当前页面栈描述成 stackNodeIds(locations 页 = 其 nodeId,根层空串,
 *   其余层 null),交给 buildLocationNavPlan 裁决;
 * - navigateBackToTarget:先写模块级 pending 高亮再回退——回退不重跑 onLoad,
 *   目标位置页在 onShow 里消费(consumePendingLocationHighlight);
 * - navigateTo / redirectTo:url 已带 node_id 与 hl 参数,目标页 onLoad 读取;
 * - none:零导航,原地刷新与高亮由调用方处理(树内小移挂回本层)。
 *
 * pending 高亮带 TTL:用户取消回退/改道后残留的过期条目绝不迟投。
 */
const nav_highlight_1 = require("./nav-highlight");
/** pending 高亮存活上限:回退类导航在数百毫秒内完成,10s 足够宽且不迟投 */
exports.PENDING_HIGHLIGHT_TTL_MS = 10000;
/** 模块级 pending 高亮(navigateBack 回退场景;不依赖目标页 onLoad) */
let pendingHighlight = null;
/** 写入 pending 高亮(执行回退前调用;now 可注入便于测试) */
function setPendingLocationHighlight(nodeId, highlight, now = Date.now()) {
    pendingHighlight = { nodeId: nodeId || "", highlight: highlight || "", at: now };
}
/**
 * 目标层 onShow 消费:nodeId 匹配且未过期 → 返回高亮 id 并清空;
 * 不匹配(别的层)→ 返回空串且**保留**(TTL 内正确的页仍可消费);
 * 过期 → 清空并返回空串。
 */
function consumePendingLocationHighlight(nodeId, now = Date.now()) {
    const entry = pendingHighlight;
    if (entry === null) {
        return "";
    }
    if (now - entry.at > exports.PENDING_HIGHLIGHT_TTL_MS) {
        pendingHighlight = null;
        return "";
    }
    if (entry.nodeId !== (nodeId || "")) {
        return "";
    }
    pendingHighlight = null;
    return entry.highlight;
}
/** 当前页面栈的 locations 描述:locations 页 = 其 nodeId(根层空串),其余 null */
function locationsStackNodeIds() {
    if (typeof getCurrentPages !== "function") {
        return [];
    }
    return getCurrentPages().map((page) => {
        const route = page.route;
        if (typeof route !== "string" || !route.endsWith("pages/locations/locations")) {
            return null;
        }
        const nodeId = page.nodeId;
        return typeof nodeId === "string" ? nodeId : "";
    });
}
/**
 * 跳到目标位置层(带短高亮目标):按 buildLocationNavPlan 执行。
 * 返回执行的方法(none = 未导航,调用方原地刷新/高亮)。
 */
function navToLocationLayer(targetNodeId, highlight = "") {
    const pagesCount = typeof getCurrentPages === "function" ? getCurrentPages().length : 1;
    const plan = (0, nav_highlight_1.buildLocationNavPlan)(pagesCount, {
        targetNodeId,
        highlight,
        stackNodeIds: locationsStackNodeIds(),
    });
    if (plan.method === "none") {
        return "none";
    }
    if (plan.method === "navigateBackToTarget") {
        // 回退不重跑 onLoad:先写 pending,目标页 onShow 消费
        if (highlight) {
            setPendingLocationHighlight(targetNodeId, highlight);
        }
        wx.navigateBack({
            delta: plan.stepsBack,
            fail: () => {
                // 回退异常兜底:改走前进(仍带 hl 参数,目标页 onLoad 读取)
                wx.navigateTo({ url: plan.url, fail: () => { } });
            },
        });
        return "navigateBackToTarget";
    }
    if (plan.method === "redirectTo") {
        wx.redirectTo({ url: plan.url, fail: () => { } });
        return "redirectTo";
    }
    wx.navigateTo({ url: plan.url, fail: () => { } });
    return "navigateTo";
}
