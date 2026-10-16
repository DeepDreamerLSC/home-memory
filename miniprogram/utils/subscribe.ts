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
 * - 手势上下文不变式(#36 0.9.2,修 iOS「fail c…」):requestExpirySubscribe
 *   内 wx.requestSubscribeMessage 必须是**第一条 wx API 调用**——请求之前
 *   零桥接调用(isReleaseEnv 的 wx.getAccountInfoSync 属同步桥接调用,
 *   只允许出现在 success/fail 回调内部,诊断决定事后做;任何「请求前先查
 *   环境/先读存储/先 toast」的改动都会破坏 iOS 点击手势上下文,测试
 *   SB-GESTURE 系列按 wx 调用序列锁死此顺序);
 * - 诊断分支(#36 真机反馈三件 C 起,0.9.2 升级):release 保持静默;
 *   develop/trial 的 fail 回调 console.warn 完整 errMsg + wx.showModal
 *   全文展示(title「订阅失败」/content 完整 errMsg 不截断/showCancel:false;
 *   #36 0.9.1 iOS 实测:toast 的 title 真机无论传多长只显示约 30 字,
 *   三轮真机反馈都只见「fail c…」,关键错误名永远看不全——modal 支持多行
 *   全文且可截图,toast 只留给 success 的短状态)、success 回调小 toast
 *   授权结果状态(订阅:accept/reject/…);getAccountInfoSync 异常/缺失时
 *   保守按 release 静默(它在回调内,异常只影响诊断展示不影响请求);
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

/**
 * accept 后置动作:记录订阅到服务端;fire-and-forget,任何失败静默吞掉。
 * 返回记录是否已发起(无云能力时 false——调用方据此决定是否触发 onAccepted:
 * 记录没发起就不算「已成功开启」,显式入口保留可稍后重试)。
 */
function recordSubscription(): boolean {
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

/**
 * 码点截断(success 诊断 toast 的授权状态只保留前 60 字,其余省略号;
 * 0.9.2 起 fail 诊断不再用 toast——改 diagnoseModal 完整 errMsg 全文)
 */
function clampCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) {
    return text;
  }
  return chars.slice(0, max).join("") + "…";
}

/**
 * 诊断 toast(仅 success 回调的授权结果短状态:develop/trial 专用,release
 * 由调用方拦下,绝不打扰正式用户)。截断 60 字、duration 4000。fail 诊断
 * 0.9.2 起改走 diagnoseModal(toast 真机只显约 30 字,错误全文看不全)。
 */
function diagnoseToast(titlePrefix: string, detail: string): void {
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
 * 诊断 modal(#36 0.9.2,fail 回调专用;develop/trial,release 由调用方
 * 拦下):content 放**完整 errMsg 不截断**——#36 0.9.1 iOS 实测 toast 的
 * title 无论传多长真机只显示约 30 字,三轮真机反馈都只见「fail c…」,
 * 手势规则类错误的关键错误名永远看不全;modal 的 content 支持多行长文本、
 * 不会视觉截断且可截图回报。showCancel:false 单按钮,不打断用户。
 */
function diagnoseModal(errMsg: string): void {
  if (typeof wx.showModal !== "function") {
    return; // 极低版本兜底:诊断展示缺失时静默(诊断代码绝不抛错)
  }
  wx.showModal({
    title: "订阅失败",
    content: errMsg,
    showCancel: false,
  });
}

/**
 * 请求「保质期到期提醒」订阅授权。
 * 硬性约束 1(tap 手势链):必须在用户 tap 手势链内同步调用(调用方在 tap
 * 回调开头第一时间调用,绝不 await 之后再调;picker 的 bindchange 滚轮选完
 * 回调不算点击手势,真机必报「requestSubscribeMessage:fail can only be
 * invoked by user TAP gesture」——#36 0.9.0 iOS 实测,授权入口须是真实 tap)。
 * 硬性约束 2(#36 0.9.2,请求前置零桥接调用):函数内 wx.requestSubscribeMessage
 * 必须是第一条 wx API 调用——请求之前零 wx 调用(isReleaseEnv 的
 * getAccountInfoSync 属同步桥接调用,只能在 success/fail 回调内事后做;
 * iOS 点击手势上下文会被手势窗口内的其他桥接调用破坏,SB-GESTURE 测试
 * 按 wx 调用序列锁死)。低版本提前 return(无 requestSubscribeMessage)是
 * 不发请求的降级,保留。
 * onAccepted(#36 真机手势规则):可选回调,授权 accept 且 recordSubscription
 * 已发起后同步调用(不 await 云函数结果;reject/fail/低版本/无云能力——
 * 记录未发起——一律不调用)。现有调用点(确认卡保存/详情保存修改)不传
 * 回调,行为零变化。
 * 失败口径(#36 真机反馈三件 C 起):release 一律静默——提醒仍有应用内
 * 「提醒页」兜底,保存流程照旧;develop/trial(开发者工具/体验版)可见诊断:
 * - fail 回调:console.warn 完整 errMsg + wx.showModal 全文(title「订阅失败」/
 *   content 完整 errMsg 不截断/showCancel:false;#36 0.9.2 起——0.9.1 iOS
 *   实测 toast 真机只显约 30 字,「fail c…」看不全没法定位,modal 全文
 *   多行可截图,体验版复现后截图回报即可定位);
 * - success 回调:toast 该模板的授权结果状态(「订阅:accept/reject/ban/filter」)。
 */
export function requestExpirySubscribe(onAccepted?: () => void): void {
  // 请求前零 wx API 调用:此处只做属性存在性检查(不发桥接调用),诊断的
  // getAccountInfoSync 一律推迟到 success/fail 回调内(SB-GESTURE 锁序)
  if (!wx.requestSubscribeMessage) {
    return; // 低版本基础库:静默降级应用内提醒
  }
  wx.requestSubscribeMessage({
    tmplIds: [EXPIRY_REMIND_TEMPLATE_ID],
    success: (res) => {
      if (isSubscribeAccepted(res)) {
        if (recordSubscription() && onAccepted) {
          onAccepted(); // 记录已发起(不 await 结果):accept 后置动作同步回调
        }
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
      diagnoseModal(errMsg || "unknown");
    },
  });
}
