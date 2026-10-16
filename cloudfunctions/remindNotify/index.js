"use strict";

/**
 * remindNotify 云函数入口(issue #36 V1.5 到期微信提醒推送):wx-server-sdk
 * 胶水层(itemsApi/index.js 同款纪律)。
 * - cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
 * - 带 action 的调用(小程序端):身份只取 cloud.getWXContext().OPENID,
 *   缺失返回 UNAUTHORIZED;event 里的身份字段(household_id/openid/member_key)
 *   一律忽略不读,绝不作为授权凭据;
 * - action=recordSubscription:先经 lib/household.js(与 itemsApi/locations/
 *   households 逐字节同源副本)三向解析当前家庭——无 active 指针回退个人家庭
 *   (存量算法,单人用户同样能订阅到期推送);孤儿指针/已解散/查询异常一律
 *   HOUSEHOLD_UNAVAILABLE 失败关闭,零写入;
 * - 无 action 的调用(timer 触发器 / 控制台手动触发):每日到期扫描推送;
 * - 发送经 cloud.openapi.subscribeMessage.send(miniprogramState:"formal");
 * - 日志只记计数/布尔/错误码(handler.js logResult),绝不落 openid/member_key/
 *   物品名/位置/家庭名/提醒日期明细。
 */

var cloud = require("wx-server-sdk");

var handlerModule = require("./lib/handler");
var handler = handlerModule.handler;
var householdLib = require("./lib/household");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function makeLogger() {
  return {
    // handler 传入的 entry 只含 action/error/ms/count 与计数,这里直接落控制台
    log: function (entry) {
      console.log(JSON.stringify(entry));
    }
  };
}

exports.main = async function (event) {
  var db = cloud.database();
  var deps = {
    db: db,
    now: function () {
      return new Date().toISOString();
    },
    // member_key 派生算法与 households 函数逐字一致:sha256(openid) 十六进制全文
    memberKeyOf: householdLib.memberKeyOf,
    // 订阅消息发送(openapi 注入,便于离线测试时替换):正式版状态,
    // 跳转页面固定为提醒页(pages/reminders/reminders)
    send: function (args) {
      return cloud.openapi.subscribeMessage.send({
        touser: args.touser,
        templateId: args.templateId,
        page: args.page,
        miniprogramState: "formal",
        data: args.data
      });
    },
    logger: makeLogger()
  };

  if (event && typeof event.action === "string") {
    var wxContext = cloud.getWXContext();
    var openid = wxContext && wxContext.OPENID;
    if (!openid) {
      return {
        ok: false,
        error: "UNAUTHORIZED",
        message: handlerModule.ERROR_MESSAGES.UNAUTHORIZED
      };
    }
    // 可信家庭解析收口(三向验证:活跃指针 → 有效会员 → 家庭未解散);
    // 无活跃指针确定性回个人家庭——与 itemsApi/households 完全同口径
    var resolved = await householdLib.resolveActiveHousehold(db, openid);
    if (resolved.ok !== true) {
      // 只记错误码与简短 reason(不含身份/家庭数据),绝不静默回退
      console.log(JSON.stringify({ error: resolved.error, reason: resolved.reason }));
      return { ok: false, error: resolved.error, message: resolved.message };
    }
    deps.memberKey = householdLib.memberKeyOf(openid);
    deps.openid = openid;
    deps.resolved = resolved;
  }
  return handler(event, deps);
};
