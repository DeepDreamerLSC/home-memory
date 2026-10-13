"use strict";

/*
 * 可信家庭解析(issue #34 P0,F1/P0-4;itemsApi 与 locations 两个函数族共用,
 * extractDraft/transcribe 为无状态服务,明确不引入本解析)。
 * 解析口径(冻结版 F1):
 *   - member_key = sha256(OPENID) 十六进制全文:从可信 OPENID 在服务端派生的
 *     稳定摘要,绝不持久化裸 OPENID(README 隐私红线);
 *   - 个人家庭 household_id = "hh_" + sha256(OPENID) 前 32 位(存量算法逐字节
 *     不变,单人用户零感知);
 *   - resolveActiveHousehold(db, OPENID) 解析当前活跃家庭:
 *       1) 查 active_household(member_key 唯一):明确无记录 → 确定性回退个人家庭;
 *       2) 命中 → 必须在 household_members 存在 (household_id, member_key) 会员行;
 *          孤儿指针(指针在、会员行不在,如被移除/退出后指针未清)→ 失败关闭;
 *       3) 任何查询异常(含集合未创建)、指针不唯一、指针字段非法 → 一律
 *          HOUSEHOLD_UNAVAILABLE 失败关闭,绝不回退个人家庭继续读写
 *          (宁拒一次操作,不把任一家庭的数据错写进另一个家庭);
 *   - 解析结果只作为服务端 DB where 条件,客户端传入的任何身份/家庭字段不具授权效力。
 * 数据集合(P0 为控制台人工步骤,权限「所有用户不可读不可写」;P0 无任何写入路径,
 * 创建/邀请/退出/移除在 P1 落地):
 *   - household_members:{ household_id, member_key, role("owner"|"member"),
 *     joined_at, invited_by },组合唯一索引 (household_id, member_key);
 *   - active_household:{ member_key, household_id, updated_at },唯一索引 (member_key)。
 */

var crypto = require("crypto");

var ACTIVE_COLLECTION = "active_household";
var MEMBERS_COLLECTION = "household_members";

var ERROR_MESSAGES = {
  HOUSEHOLD_UNAVAILABLE: "暂时无法确认当前家庭,请稍后重试"
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

/**
 * 解析当前可信家庭。
 * db 为 wx-server-sdk 的 cloud.database();openid 必须来自 cloud.getWXContext().OPENID。
 * 返回 { ok:true, householdId } 或 { ok:false, error:"HOUSEHOLD_UNAVAILABLE",
 * message(中文), reason(简短机器码,仅日志/排障用,不含身份或家庭数据) }。
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
    return { ok: true, householdId: personalHouseholdId(openid) };
  }
  if (activeRows.length > 1) {
    // 唯一索引 (member_key) 缺失或损坏才会出现:指针不唯一,失败关闭
    return householdUnavailable("active_not_unique");
  }
  var householdId = activeRows[0].household_id;
  if (typeof householdId !== "string" || householdId.length === 0) {
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
  if (rowsOf(memberRes).length === 0) {
    // 孤儿活跃指针:指针在、会员行不存在 → 失败关闭
    return householdUnavailable("orphan_active_pointer");
  }
  return { ok: true, householdId: householdId };
}

module.exports = {
  resolveActiveHousehold: resolveActiveHousehold,
  memberKeyOf: memberKeyOf,
  personalHouseholdId: personalHouseholdId,
  ERROR_MESSAGES: ERROR_MESSAGES
};
