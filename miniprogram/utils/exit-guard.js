"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enableHomeExitGuard = enableHomeExitGuard;
exports.disableHomeExitGuard = disableHomeExitGuard;
/**
 * 首页退出确认(真机反馈 2026-10-26:手势返回在首页"百分百直接退出小程序")。
 *
 * 首页是页面栈底,iOS 右滑/安卓手势返回在栈底=退出整个小程序(平台行为,
 * 无法阻止)——用 enableAlertBeforeUnload 加一道确认,防止误触退出
 * (进行中的录音/识别/浏览上下文随退出丢失)。低版本基础库(2.12.0 前)
 * 无此 API:静默降级,行为与现状一致。
 */
function enableHomeExitGuard() {
    try {
        if (typeof wx === "undefined" || typeof wx.enableAlertBeforeUnload !== "function")
            return;
        wx.enableAlertBeforeUnload({ message: "确定要退出「我靠东西呢」吗?", fail: () => { } });
    }
    catch (e) {
        // 静默降级:防误触只是增强,绝不影响主流程
    }
}
function disableHomeExitGuard() {
    try {
        if (typeof wx === "undefined" || typeof wx.disableAlertBeforeUnload !== "function")
            return;
        wx.disableAlertBeforeUnload({ fail: () => { } });
    }
    catch (e) {
        // 同上:吞掉
    }
}
