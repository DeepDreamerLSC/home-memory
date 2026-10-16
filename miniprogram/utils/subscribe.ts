/**
 * 到期提醒订阅消息封装(issue #36 V1.5):
 * - requestExpirySubscribe():在用户 tap 手势链内同步发起
 *   wx.requestSubscribeMessage(必须在保存等异步流程之前同步调用,晚于
 *   await 会脱离手势链被微信拒绝);用户 accept 才调 remindNotify 云函数
 *   recordSubscription 落订阅记录;
 * - 静默降级:任何失败(拒绝授权 / 低版本基础库 / 无云能力 / 云函数失败)
 *   一律吞掉不阻塞:降级为应用内提醒页,绝不阻塞保存流程;
 * - 诊断分支(#36 真机反馈三件 C:定位「真机不弹窗」):release 保持静默;
 *   develop/trial 的 fail 回调 console.warn 完整 errMsg + toast
 *   「订阅失败:」+ errMsg 前 30 字、success 回调 toast 授权结果状态
 *   (0.9.0 体验版复现后回报 toast 内容即可定位);getAccountInfoSync
 *   异常/缺失时保守按 release 静默;
 * - isSubscribeAccepted(res):授权结果映射的纯函数(accept → 记录,
 *   reject/ban/filter/形状异常 → 不记录),下沉便于测试(tests/subscribe.test.js)。
 * 模板 ID 与云函数 remindNotify/lib/handler.js 的 TEMPLATE_ID 同值同源
 * (模板 ID 非密钥,各自单一常量收敛;改模板时两处同步)。
 */

/** 订阅消息模板 ID(微信公众平台「保质期到期提醒」) */
export const EXPIRY_REMIND_TEMPLATE_ID =
  "WUVZmS47BT46ukwbRhlLAqS6JoygTNXutI0KN-U5NR4C";

/** 云函数名(与 cloudfunctions/remindNotify 对应) */
const REMIND_NOTIFY_FUNCTION = "remindNotify";

/**
 * 授权结果 → 是否记录订阅(纯函数):
 * 微信在 res[tmplId] 回填该模板的状态("accept"|"reject"|"ban"|"filter"),
 * 仅 accept 记录;形状异常(缺键/非对象/值非字符串)一律不记录、不抛错。
 */
export function isSubscribeAccepted(res: unknown): boolean {
  if (typeof res !== "object" || res === null) {
    return false;
  }
  const status = (res as Record<string, unknown>)[EXPIRY_REMIND_TEMPLATE_ID];
  return status === "accept";
}

/** accept 后置动作:记录订阅到服务端;fire-and-forget,任何失败静默吞掉 */
function recordSubscription(): void {
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
 * 是否按 release 环境静默(诊断分支,#36 真机反馈三件 C:定位「真机不弹窗」):
 * - envVersion 为 develop/trial(开发者工具/体验版)→ false,失败与授权结果
 *   可见(console.warn 完整 errMsg + toast),0.9.0 体验版复现后把 toast 内容
 *   回报即可定位;
 * - release(正式版)→ true,一切静默(现状,绝不打扰正式用户);
 * - getAccountInfoSync 异常/缺失/形状异常 → **保守按 release 静默**(绝不因
 *   诊断代码本身打扰用户;测试锁此行为)。
 */
function isReleaseEnv(): boolean {
  try {
    if (typeof wx.getAccountInfoSync !== "function") {
      return true; // 低版本基础库:无从判版本,保守静默
    }
    const info = wx.getAccountInfoSync();
    const version =
      info && typeof info === "object"
        ? (info as { miniProgram?: { envVersion?: unknown } }).miniProgram
        : undefined;
    const env = version && typeof version === "object" ? version.envVersion : undefined;
    return env !== "develop" && env !== "trial";
  } catch (e) {
    return true; // 异常兜底:保守静默(release 行为)
  }
}

/** 码点截断(诊断 toast 的 errMsg 只保留前 30 字,其余省略号) */
function clampCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) {
    return text;
  }
  return chars.slice(0, max).join("") + "…";
}

/** 诊断 toast(develop/trial 专用;release 由调用方拦下,绝不打扰正式用户) */
function diagnoseToast(titlePrefix: string, detail: string): void {
  if (typeof wx.showToast !== "function") {
    return;
  }
  wx.showToast({
    title: titlePrefix + clampCodePoints(detail, 30),
    icon: "none",
    duration: 3000,
  });
}

/**
 * 请求「保质期到期提醒」订阅授权。
 * 硬性约束:必须在用户 tap 手势链内同步调用(调用方在 tap/picker 回调开头
 * 第一时间调用,绝不 await 之后再调)。
 * 失败口径(#36 真机反馈三件 C 起):release 一律静默——提醒仍有应用内
 * 「提醒页」兜底,保存流程照旧;develop/trial(开发者工具/体验版)可见诊断:
 * - fail 回调:console.warn 完整 errMsg + toast「订阅失败:」+ errMsg 前 30 字
 *   (真机反馈「不弹窗」但 fail 被静默吞掉无从定位——体验版复现后回报 toast
 *   内容即可定位);
 * - success 回调:toast 该模板的授权结果状态(「订阅:accept/reject/ban/filter」)。
 * 手势链逻辑与静默降级其余部分零改动(等真机数据再定)。
 */
export function requestExpirySubscribe(): void {
  if (!wx.requestSubscribeMessage) {
    return; // 低版本基础库:静默降级应用内提醒
  }
  wx.requestSubscribeMessage({
    tmplIds: [EXPIRY_REMIND_TEMPLATE_ID],
    success: (res) => {
      if (isSubscribeAccepted(res)) {
        recordSubscription();
      }
      if (!isReleaseEnv()) {
        const status = (res as Record<string, unknown>)[EXPIRY_REMIND_TEMPLATE_ID];
        diagnoseToast(
          "订阅:",
          typeof status === "string" ? status : "unknown",
        );
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
