"use strict";

/**
 * households 云函数入口(issue #34 P1-A):wx-server-sdk 胶水层
 * (itemsApi/index.js 同款纪律)。
 * - cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });身份只取
 *   cloud.getWXContext().OPENID,缺失返回 UNAUTHORIZED;event 里的身份字段
 *   (household_id/openid/member_key/role)一律忽略不读,绝不作为授权凭据;
 * - 可信家庭解析(lib/household.js,与 itemsApi/locations 逐字节同源副本,
 *   三向验证:活跃指针 → 有效会员 → 家庭未解散):个人家庭回退存量算法、
 *   共享家庭带 role/scope_revision/display_name;任何查询异常/不一致 →
 *   HOUSEHOLD_UNAVAILABLE 失败关闭,绝不回退个人家庭继续操作;
 * - deps.genToken():邀请令牌,base64url(24 密码学随机字节)=192bit ≥ 128bit,
 *   裸令牌只在 inviteCreate 响应出现一次,库中只存 sha256(令牌);
 * - 日志只记 action/error/ms/count,绝不落 openid/member_key/裸令牌/令牌哈希/
 *   家庭名/household_id;
 * - 业务逻辑全部在 lib/handler.js(纯函数,依赖注入,便于离线测试);
 *   households/household_members/active_household/household_invites 集合为
 *   控制台人工步骤(权限「所有用户不可读不可写」),本函数不做惰性建集合:
 *   缺集合时按失败关闭处理,如实报 HOUSEHOLD_UNAVAILABLE。
 */

var cloud = require("wx-server-sdk");
var crypto = require("crypto");

var handlerModule = require("./lib/handler");
var handler = handlerModule.handler;
var householdLib = require("./lib/household");
var resolveActiveHousehold = householdLib.resolveActiveHousehold;
var memberKeyOf = householdLib.memberKeyOf;

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function makeLogger() {
  return {
    // handler 传入的 entry 只含 action/error/ms/count,这里直接落控制台
    log: function (entry) {
      console.log(JSON.stringify(entry));
    }
  };
}

exports.main = async function (event) {
  var wxContext = cloud.getWXContext();
  var openid = wxContext && wxContext.OPENID;
  if (!openid) {
    return {
      ok: false,
      error: "UNAUTHORIZED",
      message: handlerModule.ERROR_MESSAGES.UNAUTHORIZED
    };
  }

  var db = cloud.database();
  // 可信家庭解析收口:三向验证(活跃指针/有效会员/未解散),失败关闭
  var resolved = await resolveActiveHousehold(db, openid);
  if (resolved.ok !== true) {
    // 只记错误码与简短 reason(不含身份/家庭数据),绝不回退个人家庭
    console.log(
      JSON.stringify({ action: event && event.action, error: resolved.error, reason: resolved.reason })
    );
    return { ok: false, error: resolved.error, message: resolved.message };
  }

  var deps = {
    db: db,
    now: function () {
      return new Date().toISOString();
    },
    genId: function () {
      return crypto.randomBytes(12).toString("hex");
    },
    genToken: function () {
      // 192bit 密码学随机,base64url URL 安全(分享卡片 path 直接可用)
      return crypto.randomBytes(24).toString("base64url");
    },
    sha256: function (s) {
      return crypto.createHash("sha256").update(s, "utf8").digest("hex");
    },
    memberKey: memberKeyOf(openid),
    resolved: resolved,
    logger: makeLogger()
  };
  return handler(event, deps);
};
