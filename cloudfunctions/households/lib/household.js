/*
 * 【逐字节同源副本】本注释块以下的内容与 cloudfunctions/itemsApi/lib/household.js
 * 逐字节一致(households 云函数持有同款副本),修改任一份必须三方同步
 * (纪律同 lib/deepseek.js 副本;漂移由 tests/household.test.js 的 HH-SRC
 * 逐字节比对测试拦截)。
 * ---- 副本正文(与源文件逐字节一致)----
 */
"use strict";

/*
 * 可信家庭解析与写入硬门(issue #34 P0+P1-A,F1/P0-4/P1 硬门 A/B;
 * itemsApi、locations、households 三个函数族共用,extractDraft/transcribe
 * 为无状态服务,明确不引入本解析)。
 * 解析口径(冻结版 F1 + P1 硬门 A「三向验证」):
 *   - member_key = sha256(OPENID) 十六进制全文:从可信 OPENID 在服务端派生的
 *     稳定摘要,绝不持久化裸 OPENID(README 隐私红线);
 *   - 个人家庭 household_id = "hh_" + sha256(OPENID) 前 32 位(存量算法逐字节
 *     不变,单人用户零感知);
 *   - resolveActiveHousehold(db, OPENID) 解析当前活跃家庭(所有读写一律三向验证):
 *       1) 查 active_household(member_key 唯一):明确无记录 → 确定性回退个人家庭;
 *       2) 命中 → 必须在 household_members 存在 (household_id, member_key) 会员行
 *          且 role 合法,孤儿指针(指针在、会员行不在,如被移除/退出后指针未清)
 *          → 失败关闭;
 *       3) 共享家庭必须在 households 存在元数据行且 dissolved === false、
 *          scope_revision 为正整数;已解散/缺元数据/字段非法 → 失败关闭。
 *          P0 只验「会员行存在」,不足以支撑移除/解散后的访问撤权,P1-A 收紧
 *          (P1 硬门 A 第 1 条,不能遗漏);
 *       4) 任何查询异常(含集合未创建)、指针不唯一、指针字段非法 → 一律
 *          HOUSEHOLD_UNAVAILABLE 失败关闭,绝不回退个人家庭继续读写
 *          (宁拒一次操作,不把任一家庭的数据错写进另一个家庭);
 *   - 解析结果只作为服务端 DB where 条件,客户端传入的任何身份/家庭字段不具授权效力。
 * 写入硬门 checkWriteScopeBinding(P1 硬门 B,P1-A 落地):
 *   - 共享家庭(解析为 shared)的写操作必须携带与解析一致的 expected_household_id
 *     与 expected_scope_revision:缺失/不一致 → FAMILY_SWITCHED / FAMILY_STALE_SCOPE,
 *     零业务写入。marker 只是一致性前置条件,绝不授权;household_id 比对挡 A→B
 *     漂移,单调 scope_revision 另挡成员变更后的旧请求误写与 A→B→A 的 ABA 重放
 *     (P1 硬门 B 第 2 条,不能遗漏);
 *   - 个人(单人)家庭维持 P0 宽松口径:expected_household_id 可选(携带则校验),
 *     expected_scope_revision 无语义、一律忽略——0.4.7 及以前客户端单人零回归。
 * 数据集合(P0/P1-A 为控制台人工步骤,权限「所有用户不可读不可写」):
 *   - household_members:{ household_id, member_key, role("owner"|"member"),
 *     joined_at, invited_by },组合唯一索引 (household_id, member_key);
 *   - active_household:{ member_key, household_id, updated_at },唯一索引 (member_key);
 *   - households(P1-A):{ _id 即 household_id, display_name, dissolved,
 *     scope_revision, created_at, dissolved_at? },_id 天然唯一,无需额外唯一索引;
 *   - household_invites(P1-A):{ household_id, token_hash(sha256(裸令牌),裸令牌
 *     绝不落库、绝不进日志), created_by, created_at, expires_at, revoked,
 *     revoked_at? },唯一索引 (token_hash)。
 */

var crypto = require("crypto");

var ACTIVE_COLLECTION = "active_household";
var MEMBERS_COLLECTION = "household_members";
var HOUSEHOLDS_COLLECTION = "households";

var ERROR_MESSAGES = {
  HOUSEHOLD_UNAVAILABLE: "暂时无法确认当前家庭,请稍后重试",
  // 以下三条与 itemsApi/locations 的 lib/handler.js 同名错误文案一致(副本同步纪律)
  INVALID_INPUT: "输入不合法,请检查后重试",
  FAMILY_SWITCHED: "家庭已切换,本次操作未保存,请确认当前家庭后重试",
  FAMILY_STALE_SCOPE: "家庭刚发生成员或作用域变化,本次操作未保存,请刷新后重试"
};

/** 会员身份摘要:sha256(OPENID) 十六进制全文(稳定、单向,不落裸 OPENID) */
function memberKeyOf(openid) {
  return crypto.createHash("sha256").update(openid, "utf8").digest("hex");
}

/** 个人家庭 ID(存量算法保持不变):"hh_" + sha256(OPENID) 前 32 位 */
function personalHouseholdId(openid) {
  return "hh_" + memberKeyOf(openid).slice(0, 32);
}

/** 失败关闭结果:终止本次操作,绝不回退个人家庭(P0-4) */
function householdUnavailable(reason) {
  return {
    ok: false,
    error: "HOUSEHOLD_UNAVAILABLE",
    message: ERROR_MESSAGES.HOUSEHOLD_UNAVAILABLE,
    reason: reason
  };
}

function rowsOf(res) {
  return (res && res.data) || [];
}

function isString(v) {
  return typeof v === "string";
}

/**
 * 解析当前可信家庭(读写一律三向验证:活跃指针 → 有效会员 → 家庭未解散)。
 * db 为 wx-server-sdk 的 cloud.database();openid 必须来自 cloud.getWXContext().OPENID。
 * 返回:
 *   { ok:true, householdId, shared:false, scopeRevision:null, role:null, displayName:null }
 *     —— 明确无活跃共享家庭,确定性回退个人家庭(存量单人用户零感知);
 *   { ok:true, householdId, shared:true, scopeRevision(正整数), role("owner"|"member"),
 *     displayName } —— 活跃共享家庭(三向验证全部通过);
 *   { ok:false, error:"HOUSEHOLD_UNAVAILABLE", message(中文), reason(简短机器码,
 *     仅日志/排障用,不含身份或家庭数据) } —— 失败关闭。
 */
async function resolveActiveHousehold(db, openid) {
  var memberKey = memberKeyOf(openid);

  var activeRes;
  try {
    activeRes = await db
      .collection(ACTIVE_COLLECTION)
      .where({ member_key: memberKey })
      .get();
  } catch (e) {
    // 查询异常(含集合未创建/索引问题):失败关闭,绝不当作「未加入」回落个人
    return householdUnavailable("active_query_failed");
  }
  var activeRows = rowsOf(activeRes);
  if (activeRows.length === 0) {
    // 明确无活跃共享家庭:确定性回退个人家庭(存量单人用户零感知)
    return {
      ok: true,
      householdId: personalHouseholdId(openid),
      shared: false,
      scopeRevision: null,
      role: null,
      displayName: null
    };
  }
  if (activeRows.length > 1) {
    // 唯一索引 (member_key) 缺失或损坏才会出现:指针不唯一,失败关闭
    return householdUnavailable("active_not_unique");
  }
  var householdId = activeRows[0].household_id;
  if (!isString(householdId) || householdId.length === 0) {
    return householdUnavailable("active_invalid_pointer");
  }

  var memberRes;
  try {
    memberRes = await db
      .collection(MEMBERS_COLLECTION)
      .where({ household_id: householdId, member_key: memberKey })
      .get();
  } catch (e) {
    return householdUnavailable("member_query_failed");
  }
  var memberRows = rowsOf(memberRes);
  if (memberRows.length === 0) {
    // 孤儿活跃指针:指针在、会员行不存在 → 失败关闭
    return householdUnavailable("orphan_active_pointer");
  }
  var role = memberRows[0].role;
  if (role !== "owner" && role !== "member") {
    return householdUnavailable("member_invalid_role");
  }

  // 三向验证第三向:共享家庭元数据(存在、未解散、修订号合法)
  var householdRes;
  try {
    householdRes = await db
      .collection(HOUSEHOLDS_COLLECTION)
      .where({ _id: householdId })
      .get();
  } catch (e) {
    return householdUnavailable("household_query_failed");
  }
  var householdRows = rowsOf(householdRes);
  if (householdRows.length !== 1) {
    // 会员行在、家庭元数据缺:不一致态 → 失败关闭(绝不当作已解散或个人家庭)
    return householdUnavailable("household_doc_missing");
  }
  var household = householdRows[0];
  if (household.dissolved === true) {
    // 已解散(软封存):任何人都不得再解析进入;指针应已在解散时清理,
    // 残留即不一致态 → 失败关闭,绝不静默回退个人家庭改写旧请求
    return householdUnavailable("household_dissolved");
  }
  if (household.dissolved !== false) {
    return householdUnavailable("household_invalid_state");
  }
  var scopeRevision = household.scope_revision;
  if (!Number.isInteger(scopeRevision) || scopeRevision < 1) {
    return householdUnavailable("household_invalid_state");
  }
  return {
    ok: true,
    householdId: householdId,
    shared: true,
    scopeRevision: scopeRevision,
    role: role,
    displayName: isString(household.display_name) ? household.display_name : null
  };
}

/**
 * 写入硬门(issue #34 P1-A,P1 硬门 B:共享态强制作用域绑定)。
 * 供 itemsApi / locations 的写类 action 在进入业务逻辑前调用;
 * householdId / shared / scopeRevision 来自服务端解析结果(deps),绝不来自 event。
 * 返回 null = 放行;返回 { ok:false, error, message } = 拒绝(handler 直接作为结果,
 * 零业务写入):
 *   - 共享家庭:expected_household_id 缺失或与解析不一致 → FAMILY_SWITCHED;
 *     expected_scope_revision 缺失或与 households.scope_revision 不一致 →
 *     FAMILY_STALE_SCOPE(成员变更/家庭切换后的旧请求,防误写与 ABA 重放);
 *     两 marker 类型非法 → INVALID_INPUT;
 *   - 个人(单人)家庭:维持 P0 宽松口径——expected_household_id 缺省放行、
 *     携带则校验(不一致 FAMILY_SWITCHED);expected_scope_revision 无语义、忽略。
 * marker 仅做一致性前置校验,绝不授权:身份与家庭归属始终由服务端独立解析。
 */
function checkWriteScopeBinding(householdId, shared, scopeRevision, event) {
  var expectedHouseholdId = event ? event.expected_household_id : undefined;

  if (shared === true) {
    if (expectedHouseholdId === undefined) {
      // 共享家庭写操作必须携带作用域绑定(P0 的可选口径只保留给单人家庭)
      return { ok: false, error: "FAMILY_SWITCHED", message: ERROR_MESSAGES.FAMILY_SWITCHED };
    }
    if (!isString(expectedHouseholdId)) {
      return { ok: false, error: "INVALID_INPUT", message: ERROR_MESSAGES.INVALID_INPUT };
    }
    if (expectedHouseholdId !== householdId) {
      return { ok: false, error: "FAMILY_SWITCHED", message: ERROR_MESSAGES.FAMILY_SWITCHED };
    }
    var expectedRevision = event.expected_scope_revision;
    if (expectedRevision === undefined) {
      return { ok: false, error: "FAMILY_STALE_SCOPE", message: ERROR_MESSAGES.FAMILY_STALE_SCOPE };
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      return { ok: false, error: "INVALID_INPUT", message: ERROR_MESSAGES.INVALID_INPUT };
    }
    if (expectedRevision !== scopeRevision) {
      return { ok: false, error: "FAMILY_STALE_SCOPE", message: ERROR_MESSAGES.FAMILY_STALE_SCOPE };
    }
    return null;
  }

  // 个人(单人)家庭:P0 宽松口径,0.4.7 客户端零回归
  if (expectedHouseholdId !== undefined) {
    if (!isString(expectedHouseholdId)) {
      return { ok: false, error: "INVALID_INPUT", message: ERROR_MESSAGES.INVALID_INPUT };
    }
    if (expectedHouseholdId !== householdId) {
      return { ok: false, error: "FAMILY_SWITCHED", message: ERROR_MESSAGES.FAMILY_SWITCHED };
    }
  }
  return null;
}

module.exports = {
  resolveActiveHousehold: resolveActiveHousehold,
  checkWriteScopeBinding: checkWriteScopeBinding,
  memberKeyOf: memberKeyOf,
  personalHouseholdId: personalHouseholdId,
  ERROR_MESSAGES: ERROR_MESSAGES
};
