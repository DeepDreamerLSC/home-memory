"use strict";
/**
 * 位置树跳转高亮纯工具(issue #121 第二波批次甲 ④,v2 横幅架构预审 6418877302)。
 *
 * 纯函数、零 wx 依赖:输入只是当前页面栈的**描述**(层数 + 各层是否已是目标
 * locations 页),输出导航方案;执行(wx.navigateTo / navigateBack / redirectTo)
 * 归调用方,页面接线归批次乙(PR-B #122),本期只定协议。
 *
 * 裁定要点(部分 GO):
 * - **不统一强制 redirectTo**:栈中已有目标层时优先回退(navigateBack 不加层,
 *   永不触碰 10 层上限),只有栈近满(≥ STACK_FULL_REDIRECT_THRESHOLD,微信
 *   页面栈上限 10 层、预留 1 层)且需要新压层时才 redirectTo 兜底;
 * - 栈中已有目标层的两种形态:
 *   - 目标就是当前页(典型 = 树内小移,当前就在目标页或其祖先)→ method="none",
 *     原地刷新由调用方处理;
 *   - 目标在栈内更深处 → method="navigateBackToTarget",stepsBack=回退层数;
 * - url 携带 node_id 与 highlight(HIGHLIGHT_QUERY_KEY = "hl")参数;hl 协议:
 *   locations 页批次乙接线时读取该参数,对目标节点/物品做 800ms 短高亮,
 *   本期只定参数名与透传,不做任何页面行为。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STACK_FULL_REDIRECT_THRESHOLD = exports.HIGHLIGHT_QUERY_KEY = void 0;
exports.buildLocationsUrl = buildLocationsUrl;
exports.buildLocationNavPlan = buildLocationNavPlan;
/** locations 页短高亮查询键:批次乙接线时 locations 页 onLoad 读取(options.hl) */
exports.HIGHLIGHT_QUERY_KEY = "hl";
/** 栈近满兜底阈值:微信页面栈上限 10 层,达到 9 层时新压层改 redirectTo(预留 1 层) */
exports.STACK_FULL_REDIRECT_THRESHOLD = 9;
/** locations 页路径(与 pages/locations 既有 URL 约定一致,node_id 参数名不变) */
const LOCATIONS_PAGE_PATH = "/pages/locations/locations";
/** 规范化 locations URL:node_id 非空必带;highlight 非空才追加 &hl=…;均 encodeURIComponent */
function buildLocationsUrl(targetNodeId, highlight) {
    const params = [];
    if (targetNodeId)
        params.push("node_id=" + encodeURIComponent(targetNodeId));
    if (highlight)
        params.push(exports.HIGHLIGHT_QUERY_KEY + "=" + encodeURIComponent(highlight));
    if (params.length === 0)
        return LOCATIONS_PAGE_PATH;
    return LOCATIONS_PAGE_PATH + "?" + params.join("&");
}
/**
 * 计算导航方案(纯函数,不调 wx):
 * 1. 栈中已有目标层(自顶向下最近的一个):顶层 = none;更深处 = navigateBackToTarget
 *    (stepsBack = 顶层到目标层的层数)。回退不加层,栈满也不改判 redirect;
 * 2. 栈中无目标层:currentPagesCount ≥ STACK_FULL_REDIRECT_THRESHOLD → redirectTo
 *    (栈满兜底,架构明确不统一强制);否则 navigateTo。
 */
function buildLocationNavPlan(currentPagesCount, opts) {
    const targetNodeId = opts.targetNodeId || "";
    const url = buildLocationsUrl(targetNodeId, opts.highlight);
    const stack = opts.stackNodeIds || [];
    // 栈描述自底向顶;找「最靠近顶层」的目标层(树内小移时通常就是顶层或其祖先)
    let targetIndexFromTop = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i];
        if (typeof entry === "string" && entry === targetNodeId) {
            targetIndexFromTop = stack.length - 1 - i;
            break;
        }
    }
    if (targetIndexFromTop === 0) {
        return { method: "none", url, stepsBack: 0 };
    }
    if (targetIndexFromTop > 0) {
        return { method: "navigateBackToTarget", url, stepsBack: targetIndexFromTop };
    }
    // 栈中无目标:需要新压一层;栈近满(≥9,上限 10 预留 1 层)时 redirectTo 兜底
    if (currentPagesCount >= exports.STACK_FULL_REDIRECT_THRESHOLD) {
        return { method: "redirectTo", url, stepsBack: 0 };
    }
    return { method: "navigateTo", url, stepsBack: 0 };
}
