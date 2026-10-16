"use strict";
/**
 * 到期提醒订阅消息封装(issue #36 V1.5):
 * - requestExpirySubscribe(onAccepted?):在用户 tap 手势链内同步发起
 *   wx.requestSubscribeMessage(必须在保存等异步流程之前同步调用,晚于
 *   await 会脱离手势链被微信拒绝;picker 的 bindchange 滚轮选完回调同样
 *   不算 tap 手势——#36 0.9.0 iOS 真机实测,报「fail can only be invoked
 *   by user TAP gesture」,详情页授权入口改由显式 tap 行承接);用户 accept
 *   才调 remindNotify 云函数 recordSubscription 落订阅记录,且记录已发起后
 *   同步回调 onAccepted(不 await 云函数结果;详情页显式入口用它写本地
 *   「已开启」标记并收起入口);reject/fail/低版本/无云能力(记录未发起)
 *   一律不回调——不传回调的既有调用点行为零变化;
 * - 静默降级:任何失败(拒绝授权 / 低版本基础库 / 无云能力 / 云函数失败)
 *   一律吞掉不阻塞:降级为应用内提醒页,绝不阻塞保存流程;
 * - 诊断分支(#36 真机反馈三件 C:定位「真机不弹窗」):release 保持静默;
 *   develop/trial 的 fail 回调 console.warn 完整 errMsg + toast
 *   「订阅失败:」+ errMsg 前 60 字(duration 4000;#36 真机手势规则期增强:
 *   0.9.0 iOS 实测 30 字/3000ms 把关键错误名截掉——真机 toast 只见
 *   「requestSubscribeMessage:fail c…」,恰为 30 字截断落在错误名首字母上)、
 *   success 回调 toast 授权结果状态;getAccountInfoSync 异常/缺失时保守按
 *   release 静默;
 * - isSubscribeAccepted(res):授权结果映射的纯函数(accept → 记录,
 *   reject/ban/filter/形状异常 → 不记录),下沉便于测试(tests/subscribe.test.js)。
 * 模板 ID 与云函数 remindNotify/lib/handler.js 的 TEMPLATE_ID 同值同源
 * (模板 ID 非密钥,各自单一常量收敛;改模板时两处同步)。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXPIRY_REMIND_TEMPLATE_ID = void 0;
exports.isSubscribeAccepted = isSubscribeAccepted;
exports.requestExpirySubscribe = requestExpirySubscribe;
/** 订阅消息模板 ID(微信公众平台「保质期到期提醒」) */
exports.EXPIRY_REMIND_TEMPLATE_ID = "WUVZmS47BT46ukwbRhlLAqS6JoygTNXutI0KN-U5NR4C";
/** 云函数名(与 cloudfunctions/remindNotify 对应) */
const REMIND_NOTIFY_FUNCTION = "remindNotify";
/**
 * 授权结果 → 是否记录订阅(纯函数):
 * 微信在 res[tmplId] 回填该模板的状态("accept"|"reject"|"ban"|"filter"),
 * 仅 accept 记录;形状异常(缺键/非对象/值非字符串)一律不记录、不抛错。
 */
function isSubscribeAccepted(res) {
    if (typeof res !== "object" || res === null) {
        return false;
    }
    const status = res[exports.EXPIRY_REMIND_TEMPLATE_ID];
    return status === "accept";
}
/**
 * accept 后置动作:记录订阅到服务端;fire-and-forget,任何失败静默吞掉。
 * 返回记录是否已发起(无云能力时 false——调用方据此决定是否触发 onAccepted:
 * 记录没发起就不算「已成功开启」,显式入口保留可稍后重试)。
 */
function recordSubscription() {
    if (!wx.cloud || !wx.cloud.callFunction) {
        return false;
    }
    wx.cloud.callFunction({
        name: REMIND_NOTIFY_FUNCTION,
        data: { action: "recordSubscription" },
        fail: () => {
            // 静默:降级应用内提醒,不打扰保存流程
        },
    });
    return true;
}
/**
 * 是否按 release 环境静默(诊断分支,#36 真机反馈三件 C:定位「真机不弹窗」):
 * - envVersion 为 develop/trial(开发者工具/体验版)→ false,失败与授权结果
 *   可见(console.warn 完整 errMsg + toast),0.9.0 体验版复现后把 toast 内容
 *   回报即可定位;
 * - release(正式版)→ true,一切静默(现状,绝不打扰正式用户);
 * - getAccountInfoSync 异常/缺失/形状异常 → **保守按 release 静默**(绝不因
 *   诊断代码本身打扰用户;测试锁此行为)。
 */
function isReleaseEnv() {
    try {
        if (typeof wx.getAccountInfoSync !== "function") {
            return true; // 低版本基础库:无从判版本,保守静默
        }
        const info = wx.getAccountInfoSync();
        const version = info && typeof info === "object"
            ? info.miniProgram
            : undefined;
        const env = version && typeof version === "object" ? version.envVersion : undefined;
        return env !== "develop" && env !== "trial";
    }
    catch (e) {
        return true; // 异常兜底:保守静默(release 行为)
    }
}
/**
 * 码点截断(诊断 toast 的 errMsg 只保留前 60 字,其余省略号;#36 真机手势
 * 规则期增强:0.9.0 iOS 实测 30 字把关键错误名截掉——真机 toast 只见
 * 「requestSubscribeMessage:fail c…」,30 字截断恰落在 "can only be invoked
 * by user TAP gesture" 的首字母 c 上)
 */
function clampCodePoints(text, max) {
    const chars = Array.from(text);
    if (chars.length <= max) {
        return text;
    }
    return chars.slice(0, max).join("") + "…";
}
/**
 * 诊断 toast(develop/trial 专用;release 由调用方拦下,绝不打扰正式用户)。
 * 截断 60 字、duration 4000(#36 真机手势规则期增强:3000ms 内读不完关键
 * 错误名;fail 与 success 共用同一诊断口径)。
 */
function diagnoseToast(titlePrefix, detail) {
    if (typeof wx.showToast !== "function") {
        return;
    }
    wx.showToast({
        title: titlePrefix + clampCodePoints(detail, 60),
        icon: "none",
        duration: 4000,
    });
}
/**
 * 请求「保质期到期提醒」订阅授权。
 * 硬性约束:必须在用户 tap 手势链内同步调用(调用方在 tap 回调开头第一
 * 时间调用,绝不 await 之后再调;picker 的 bindchange 滚轮选完回调不算
 * 点击手势,真机必报「requestSubscribeMessage:fail can only be invoked
 * by user TAP gesture」——#36 0.9.0 iOS 实测,授权入口须是真实 tap)。
 * onAccepted(#36 真机手势规则):可选回调,授权 accept 且 recordSubscription
 * 已发起后同步调用(不 await 云函数结果;reject/fail/低版本/无云能力——
 * 记录未发起——一律不调用)。现有调用点(确认卡保存/详情保存修改)不传
 * 回调,行为零变化。
 * 失败口径(#36 真机反馈三件 C 起):release 一律静默——提醒仍有应用内
 * 「提醒页」兜底,保存流程照旧;develop/trial(开发者工具/体验版)可见诊断:
 * - fail 回调:console.warn 完整 errMsg + toast「订阅失败:」+ errMsg 前 60 字
 *   (#36 真机手势规则期增强:0.9.0 iOS 实测 30 字把关键错误名截掉,60 字起
 *   手势规则类错误的关键错误名可见;体验版复现后回报 toast 内容即可定位);
 * - success 回调:toast 该模板的授权结果状态(「订阅:accept/reject/ban/filter」)。
 */
function requestExpirySubscribe(onAccepted) {
    if (!wx.requestSubscribeMessage) {
        return; // 低版本基础库:静默降级应用内提醒
    }
    wx.requestSubscribeMessage({
        tmplIds: [exports.EXPIRY_REMIND_TEMPLATE_ID],
        success: (res) => {
            if (isSubscribeAccepted(res)) {
                if (recordSubscription() && onAccepted) {
                    onAccepted(); // 记录已发起(不 await 结果):accept 后置动作同步回调
                }
            }
            if (!isReleaseEnv()) {
                const status = res[exports.EXPIRY_REMIND_TEMPLATE_ID];
                diagnoseToast("订阅:", typeof status === "string" ? status : "unknown");
            }
        },
        fail: (err) => {
            if (isReleaseEnv()) {
                return; // release 静默(现状)
            }
            const errMsg = err && typeof err.errMsg === "string" ? err.errMsg : "";
            console.warn("[subscribe] requestSubscribeMessage fail:", errMsg);
            diagnoseToast("订阅失败:", errMsg || "unknown");
        },
    });
}
