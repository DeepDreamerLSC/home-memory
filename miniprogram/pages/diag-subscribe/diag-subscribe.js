"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const appearance_page_1 = require("../../utils/appearance-page");
/**
 * 订阅手势诊断页(#36 鸿蒙真机手势排查,仅 develop 环境可从物品详情页进入):
 * 背景=0.9.3 真机(鸿蒙微信 8.0.22.35)原生 button + 规范调用(bindtap 回调内
 * 第一条 wx API 就是 requestSubscribeMessage)仍稳定报「can only be invoked
 * by user TAP gesture」;同一份代码在开发者工具(基础库 3.17.4)真实 tap 可
 * 弹出授权框,模板服务端已生效(工具实证)。本页把所有变量剥到最少做二分:
 *   - 素 <button>(零自定义样式包装、零 hover 属性)+ tap 回调内第一条语句
 *     裸调 wx.requestSubscribeMessage(不经 utils/subscribe 封装、不经页面
 *     data 读取、页面本身无 voice-bar 等任何其他组件);
 *   - 环境面板:platform/system/SDKVersion/wxVersion/envVersion/appVersion;
 *   - 每次点击的结果(成功含模板状态 / 失败含完整 errMsg)+ 时间记录在屏,
 *     可连点多次看稳定性,一次截图即齐全部证据。
 * 判读:素按钮仍报手势错=平台级实锤(社区帖/升级微信);素按钮能弹授权框=
 * 物品页上下文特异性(voice-bar/hover 属性/wxss 逐项剥离)。
 */
const subscribe_1 = require("../../utils/subscribe");
function pad2(n) {
    return n < 10 ? "0" + n : String(n);
}
function nowTime() {
    const d = new Date();
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}
function collectEnvLines() {
    const lines = [];
    try {
        const info = wx.getSystemInfoSync();
        lines.push("platform: " + info.platform);
        lines.push("system: " + info.system);
        lines.push("SDKVersion: " + info.SDKVersion);
        lines.push("wxVersion: " + info.version);
    }
    catch (e) {
        lines.push("getSystemInfoSync: 异常");
    }
    try {
        const acc = wx.getAccountInfoSync();
        lines.push("envVersion: " + (acc.miniProgram ? acc.miniProgram.envVersion : "unknown"));
        lines.push("appVersion: " + (acc.miniProgram ? acc.miniProgram.version || "-" : "unknown"));
    }
    catch (e) {
        lines.push("getAccountInfoSync: 异常");
    }
    return lines;
}
Page({
    onShow() { (0, appearance_page_1.applyPageAppearance)(this); },
    data: {
        envLines: [],
        results: [],
    },
    onLoad() {
        this.setData({ envLines: collectEnvLines() });
    },
    /**
     * 手势纪律:tap 回调内第一条 wx 调用就是订阅请求(零桥接、零前置读取),
     * 与官方示例完全一致;结果只写页面 data(不在回调里做任何其他 wx 调用)。
     */
    onRawTap() {
        wx.requestSubscribeMessage({
            tmplIds: [subscribe_1.EXPIRY_REMIND_TEMPLATE_ID],
            success: (res) => {
                const status = res[subscribe_1.EXPIRY_REMIND_TEMPLATE_ID];
                this.pushResult(true, "success / 模板状态: " + (typeof status === "string" ? status : "unknown"));
            },
            fail: (err) => {
                this.pushResult(false, (err && err.errMsg) || "unknown");
            },
        });
    },
    /**
     * 实验 B(#36 0.9.6):wx.showModal 确认回调里直接调订阅——验证 modal 的
     * 「确认」点击是否保手势(picker bindchange 已证实无手势;若本实验在真机
     * 通过,详情页选日期路径即可做成「问一句→确认→授权弹窗」一步到位)。
     */
    onModalTap() {
        wx.showModal({
            title: "微信到期提醒",
            content: "点「确认」后直接请求订阅授权(手势实验)",
            confirmText: "确认",
            cancelText: "取消",
            success: (r) => {
                if (r.confirm !== true) {
                    this.pushResult(false, "modal: 取消,未发请求");
                    return;
                }
                wx.requestSubscribeMessage({
                    tmplIds: [subscribe_1.EXPIRY_REMIND_TEMPLATE_ID],
                    success: (res) => {
                        const status = res[subscribe_1.EXPIRY_REMIND_TEMPLATE_ID];
                        this.pushResult(true, "modal确认后 success / " + (typeof status === "string" ? status : "unknown"));
                    },
                    fail: (err) => {
                        this.pushResult(false, "modal确认后 " + ((err && err.errMsg) || "unknown"));
                    },
                });
            },
        });
    },
    pushResult(ok, text) {
        const clipped = Array.from(text).slice(0, 80).join("");
        const next = [{ ok, time: nowTime(), text: clipped }].concat(this.data.results);
        this.setData({ results: next.slice(0, 30) });
    },
});
