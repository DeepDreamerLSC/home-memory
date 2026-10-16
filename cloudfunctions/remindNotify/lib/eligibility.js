"use strict";

/**
 * 发送前资格复核纯函数(issue #36 V1.5):订阅文档是「订阅那一刻」的快照,
 * 每日扫描发送前必须复核「此刻还有没有资格收这个家庭的提醒」——防
 * 「订阅后又被移出家庭/家庭解散后仍收到推送」。无 IO,事实由调用方查出后
 * 传入,便于离线测试(tests/remind-notify.test.js RN-ELIG)。
 * - openid 重算的 member_key(sha256 全文,与 households 函数同算法)与订阅
 *   文档记录不一致(文档损坏/篡改)→ 一律拒绝;
 * - 个人家庭(库中无 households 元数据行):household_id 必须与 member_key
 *   确定性派生的个人家庭 id 逐字一致(自身即全部成员,无从被移出);
 *   个人家庭 id 算法与 households/lib/handler.js 的 personalHouseholdIdOf 一致:
 *   "hh_" + member_key 前 32 位(member_key 即 sha256(openid) 全文);
 * - 共享家庭(有元数据行):dissolved 必须严格为 false(缺省/非法失败关闭),
 *   且 (household_id, member_key) 会员行仍在 household_members 中。
 */

function personalHouseholdIdOf(memberKey) {
  return "hh_" + memberKey.slice(0, 32);
}

/**
 * 是否具备本次发送资格。
 * sub:{ household_id, member_key, openid, last_sent_date? };
 * recomputedMemberKey:发送前用库中 openid 重算的 sha256(openid) 全文;
 * householdDoc:households 元数据行(个人家庭传 null);
 * memberRowExists:household_members 中是否存在 (household_id, recomputedMemberKey)。
 */
function eligibleForSend(sub, recomputedMemberKey, householdDoc, memberRowExists) {
  if (!sub || typeof sub.member_key !== "string" || typeof sub.household_id !== "string") {
    return false;
  }
  if (typeof recomputedMemberKey !== "string" || recomputedMemberKey !== sub.member_key) {
    return false;
  }
  if (householdDoc === null || householdDoc === undefined) {
    // 个人家庭:确定性派生即资格(存量算法,无法也不需要查成员表)
    return sub.household_id === personalHouseholdIdOf(sub.member_key);
  }
  if (householdDoc.dissolved !== false) {
    // 已解散(软封存)或字段非法:失败关闭
    return false;
  }
  return memberRowExists === true;
}

/** 幂等:今天已发过(last_sent_date == 今天)则跳过,防触发器重试重复打扰 */
function alreadySentToday(sub, todayYmd) {
  return !!sub && sub.last_sent_date === todayYmd;
}

module.exports = {
  personalHouseholdIdOf: personalHouseholdIdOf,
  eligibleForSend: eligibleForSend,
  alreadySentToday: alreadySentToday
};
