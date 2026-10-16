"use strict";
/**
 * 到期提醒订阅消息封装(issue #36 V1.5):
 * - requestExpirySubscribe():在用户 tap 手势链内同步发起
 *   wx.requestSubscribeMessage(必须在保存等异步流程之前同步调用,晚于
 *   await 会脱离手势链被微信拒绝);用户 accept 才调 remindNotify 云函数
 *   recordSubscription 落订阅记录;
 * - 任何失败(拒绝授权 / 低版本基础库 / 无云能力 / 云函数失败)一律静默吞掉:
 *   降级为应用内提醒页,绝不 toast、绝不阻塞保存流程;
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
/** accept 后置动作:记录订阅到服务端;fire-and-forget,任何失败静默吞掉 */
function recordSubscription() {
    if (!wx.cloud || !wx.cloud.callFunction) {
        return;
    }
    wx.cloud.callFunction({
        name: REMIND_NOTIFY_FUNCTION,
        data: { action: "recordSubscription" },
        fail: () => {
            // 静默:降级应用内提醒,不打扰保存流程
        },
    });
}
/**
 * 请求「保质期到期提醒」订阅授权。
 * 硬性约束:必须在用户 tap 手势链内同步调用(调用方在 tap/picker 回调开头
 * 第一时间调用,绝不 await 之后再调);拒绝/失败一律静默——提醒仍有应用内
 * 「提醒页」兜底,保存流程照旧。
 */
function requestExpirySubscribe() {
    if (!wx.requestSubscribeMessage) {
        return; // 低版本基础库:静默降级应用内提醒
    }
    wx.requestSubscribeMessage({
        tmplIds: [exports.EXPIRY_REMIND_TEMPLATE_ID],
        success: (res) => {
            if (isSubscribeAccepted(res)) {
                recordSubscription();
            }
        },
        fail: () => {
            // 静默:不 toast、不阻塞
        },
    });
}
