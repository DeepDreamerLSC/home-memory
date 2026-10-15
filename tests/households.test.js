"use strict";

/**
 * issue #34 P1-A(households 云函数:共享家庭生命周期/邀请/成员管理)离线合同测试:
 * - HHH-LC:生命周期全链 create → inviteCreate → inviteInfo → join → leave →
 *   removeMember → dissolve(owner 最后一人规则 / 移除后指针重置 / 幂等 join /
 *   V1 一家庭边界 / 解散后重建 / 解散软封存数据不删);
 * - HHH-INV:令牌生命周期——只存 sha256 哈希(裸令牌绝不落库)/ 过期 / 撤销 /
 *   多次使用 / inviteInfo 不暴露 PII / owner 独管;
 * - HHH-REV:scope_revision 递增与 FAMILY_STALE_SCOPE 拒写(成员变更后的过窗
 *   旧请求)/ 退出与被移除后旧作用域请求不可再写入共享域;
 * - HHH-FC:失败关闭分支(元数据集合查询异常 → HOUSEHOLD_UNAVAILABLE,绝不
 *   伪装成业务错误、绝不回退);
 * - HHH-LOG:日志只落 action/error/ms/count 计量字段,无 openid/member_key/
 *   裸令牌/令牌哈希/家庭名/household_id(照 TS-LOG 模式);
 * - HHH-GLUE:index.js 胶水层真实加载(stub wx-server-sdk):UNAUTHORIZED /
 *   个人与共享 status / 真实 genToken 令牌强度与哈希落库;
 * - HHH-SW(issue #45 十七轮):switch 切换家庭——personal 永远可回 / shared 须在册
 *   且未解散 / 指针唯一原子、scope_revision 不递增 / 被移除与解散后不可再切共享 /
 *   日志零敏感 / 真实入口解析收口。
 * 零网络、零外部依赖;绝不 require wx-server-sdk。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var crypto = require("node:crypto");
var Module = require("node:module");

var householdLib = require("../cloudfunctions/itemsApi/lib/household");
var hhHandler = require("../cloudfunctions/households/lib/handler").handler;
var itemsHandler = require("../cloudfunctions/itemsApi/lib/handler").handler;
var locHandler = require("../cloudfunctions/locations/lib/handler").handler;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

var ROOT = path.join(__dirname, "..");

function sha256hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function digest16(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

function makeDb() {
  return createMemoryDb({
    uniqueIndexes: {
      household_members: [["household_id", "member_key"]],
      active_household: [["member_key"]],
      household_invites: [["token_hash"]],
      locations: [["household_id", "parent_id", "name_norm"]]
    }
  });
}

function rawDocs(db, name) {
  return db.collection(name).where({}).get();
}

/** 可控时钟:邀请过期测试需要推进时间 */
function makeClock() {
  return { t: Date.parse("2026-10-13T12:00:00.000Z") };
}

// 全局递增序号:多个 deps 各自建家庭/邀请时 household_id/invite_id/令牌互不冲突
// (真实环境为 crypto 随机,离线测试用全局序列保证唯一性)
var globalIdSeq = 0;
var globalTokenSeq = 0;

/**
 * 组装 households handler 的 deps(真实解析器先行三向解析,与 index.js 同构)。
 * opts.clock 共享时钟;opts.logger 注入日志捕获;opts.genToken 注入确定性令牌。
 */
async function makeDeps(db, openid, opts) {
  opts = opts || {};
  var resolved = await householdLib.resolveActiveHousehold(db, openid);
  var clock = opts.clock || makeClock();
  return {
    db: db,
    now: function () {
      return new Date(clock.t).toISOString();
    },
    genId: function () {
      globalIdSeq += 1;
      return "id" + globalIdSeq;
    },
    genToken: opts.genToken || function () {
      globalTokenSeq += 1;
      return "T" + String(globalTokenSeq).padStart(6, "0") + "x".repeat(26);
    },
    sha256: sha256hex,
    memberKey: householdLib.memberKeyOf(openid),
    resolved: resolved,
    logger: opts.logger || { log: function () {} },
    clock: clock,
    openid: openid
  };
}

/** 按当前库状态重新解析并刷新 deps.resolved(生命周期操作后调用方需要新上下文) */
async function refreshResolved(deps, openid) {
  deps.resolved = await householdLib.resolveActiveHousehold(deps.db, openid);
  return deps;
}

/** 创建家庭并刷新 deps.resolved(index.js 每次请求都重新解析,测试同构) */
async function createFamily(deps, displayName) {
  var event = { action: "create" };
  if (displayName !== undefined) {
    event.display_name = displayName;
  }
  var result = await hhHandler(event, deps);
  await refreshResolved(deps, deps.openid);
  return result;
}

// ---------- HHH-LC:生命周期全链 ----------

test("HHH-LC-1:create → invite → join → leave → dissolve 全链:修订号递增、指针切换、软封存、数据不删", async function () {
  var db = makeDb();
  var clock = makeClock();
  var a = await makeDeps(db, "o-owner-1", { clock: clock });
  var b = await makeDeps(db, "o-member-1", { clock: clock });

  // create:全新空白共享家庭,owner 成员,active 指针切换
  var created = await createFamily(a, "山脚的家");
  assert.equal(created.ok, true, JSON.stringify(created));
  var hid = created.household_id;
  assert.ok(/^hh_f_/.test(hid), "共享家庭 id 应为独立随机前缀 hh_f_,与个人家庭 sha256 派生不可混淆");
  assert.equal(created.role, "owner");
  assert.equal(created.scope_revision, 1);
  assert.equal(created.display_name, "山脚的家");
  assert.equal(created.shared, true);
  var hhDoc = (await db.collection("households").doc(hid).get()).data;
  assert.equal(hhDoc.dissolved, false);
  assert.equal(hhDoc.display_name, "山脚的家");
  var members = (await rawDocs(db, "household_members")).data;
  assert.equal(members.length, 1);
  assert.equal(members[0].role, "owner");
  assert.equal(members[0].household_id, hid);
  var pointer = (await rawDocs(db, "active_household")).data;
  assert.equal(pointer.length, 1);
  assert.equal(pointer[0].household_id, hid);

  // A 的 status:共享家庭
  await refreshResolved(a, "o-owner-1");
  var aStatus = await hhHandler({ action: "status" }, a);
  assert.equal(aStatus.ok, true);
  assert.equal(aStatus.shared, true);
  assert.equal(aStatus.household_id, hid);
  assert.equal(aStatus.role, "owner");
  assert.equal(aStatus.scope_revision, 1);

  // 私人家庭数据不迁移:A 的个人家庭 items 保持为空(空白共享家庭,决策 1)
  // (个人域零写入断言:items 全库只有显式写入共享域的记录,见下方)

  // inviteCreate:裸令牌只出现一次
  var invite = await hhHandler({ action: "inviteCreate" }, a);
  assert.equal(invite.ok, true, JSON.stringify(invite));
  var token = invite.invite.token;
  assert.equal(typeof token, "string");
  assert.ok(token.length >= 32, "令牌应为 ≥128bit 的随机串");

  // inviteInfo:只给 display_name,不暴露成员 PII / household_id
  var info = await hhHandler({ action: "inviteInfo", token: token }, b);
  assert.equal(info.ok, true, JSON.stringify(info));
  assert.equal(info.display_name, "山脚的家");
  assert.deepEqual(Object.keys(info).sort(), ["display_name", "ok"]);

  // B 加入:会员行 + 指针切换 + 修订号 +1
  var joined = await hhHandler({ action: "join", token: token }, b);
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(joined.joined, true);
  assert.equal(joined.role, "member");
  assert.equal(joined.scope_revision, 2);
  assert.equal(joined.household_id, hid);
  await refreshResolved(b, "o-member-1");
  var bStatus = await hhHandler({ action: "status" }, b);
  assert.equal(bStatus.shared, true);
  assert.equal(bStatus.role, "member");
  assert.equal(bStatus.scope_revision, 2);
  assert.equal(bStatus.household_id, hid);

  // 写入共享域(经 itemsApi 硬门,证明 join 后的成员可写)
  var bItems = {
    db: db,
    now: function () {
      return "2026-10-13T00:00:00.000Z";
    },
    genId: function () {
      return "bi1";
    },
    householdId: hid,
    householdShared: true,
    scopeRevision: 2,
    logger: { log: function () {} }
  };
  var itemWrite = await itemsHandler(
    { action: "create", operation_id: "lc-item-1", name: "共享家钥匙", location_text: "客厅", expected_household_id: hid, expected_scope_revision: 2 },
    bItems
  );
  assert.equal(itemWrite.ok, true, JSON.stringify(itemWrite));

  // owner 在成员未退出前不能 leave / dissolve
  var blockedLeave = await hhHandler({ action: "leave" }, a);
  assert.equal(blockedLeave.ok, false);
  assert.equal(blockedLeave.error, "OWNER_NOT_LAST");
  var blockedDissolve = await hhHandler({ action: "dissolve" }, a);
  assert.equal(blockedDissolve.error, "OWNER_NOT_LAST");

  // B leave:指针回个人家庭、会员行删除、修订号 +1
  var left = await hhHandler({ action: "leave" }, b);
  assert.equal(left.ok, true, JSON.stringify(left));
  await refreshResolved(b, "o-member-1");
  var bAfter = await hhHandler({ action: "status" }, b);
  assert.equal(bAfter.shared, false);
  assert.equal(bAfter.household_id, householdLib.personalHouseholdId("o-member-1"));
  var memberRows = (await rawDocs(db, "household_members")).data;
  assert.equal(memberRows.length, 1, "只剩 owner 会员行");
  var bPointer = (await rawDocs(db, "active_household")).data.filter(function (r) {
    return r.member_key === householdLib.memberKeyOf("o-member-1");
  });
  assert.equal(bPointer.length, 0, "B 的指针应已移除(回个人家庭)");

  // 修订号:B 退出后 +1(=3)
  await refreshResolved(a, "o-owner-1");
  var aStatus3 = await hhHandler({ action: "status" }, a);
  assert.equal(aStatus3.scope_revision, 3);

  // 最后一人 owner 不能 leave,只能 dissolve
  var lastLeave = await hhHandler({ action: "leave" }, a);
  assert.equal(lastLeave.error, "OWNER_MUST_DISSOLVE");

  // dissolve:软封存、邀请全废、指针回个人家庭、数据永不删除
  var dissolved = await hhHandler({ action: "dissolve" }, a);
  assert.equal(dissolved.ok, true, JSON.stringify(dissolved));
  assert.equal(dissolved.dissolved, true);
  var sealed = (await db.collection("households").doc(hid).get()).data;
  assert.equal(sealed.dissolved, true);
  assert.equal(sealed.scope_revision, 4, "dissolve 也是成员变更事件,修订号 +1");
  var invites = (await rawDocs(db, "household_invites")).data;
  assert.equal(invites.length, 1);
  assert.equal(invites[0].revoked, true, "解散时全部邀请令牌作废");
  await refreshResolved(a, "o-owner-1");
  var aAfter = await hhHandler({ action: "status" }, a);
  assert.equal(aAfter.shared, false);
  assert.equal(aAfter.household_id, householdLib.personalHouseholdId("o-owner-1"));
  // 数据软封存:共享域 items 原地保留,永不删除
  var items = (await rawDocs(db, "items")).data;
  assert.equal(items.length, 1);
  assert.equal(items[0].household_id, hid);
  // 解散后旧令牌不可再入会
  var rejoin = await hhHandler({ action: "join", token: token }, b);
  assert.equal(rejoin.ok, false);
  assert.equal(rejoin.error, "NOT_FOUND");
});

test("HHH-LC-2:removeMember——指针重置回个人家庭、会员行删除、修订号 +1、数据零触碰", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-owner-2");
  var b = await makeDeps(db, "o-member-2");
  var created = await createFamily(a);
  assert.equal(created.ok, true);
  var hid = created.household_id;
  var invite = await hhHandler({ action: "inviteCreate" }, a);
  var joined = await hhHandler({ action: "join", token: invite.invite.token }, b);
  assert.equal(joined.ok, true);

  // B 先在共享域写一件物品(被移除后数据原地保留)
  await refreshResolved(b, "o-member-2");
  var bItems = {
    db: db,
    now: function () {
      return "2026-10-13T00:00:00.000Z";
    },
    genId: function () {
      return "rm1";
    },
    householdId: hid,
    householdShared: true,
    scopeRevision: 2,
    logger: { log: function () {} }
  };
  await itemsHandler(
    { action: "create", operation_id: "rm-item-1", name: "B 的物品", location_text: "书房", expected_household_id: hid, expected_scope_revision: 2 },
    bItems
  );

  // 非成员/普通成员不能移除
  await refreshResolved(a, "o-owner-2");
  var notOwner = await hhHandler({ action: "removeMember", member_key: householdLib.memberKeyOf("o-member-2") }, b);
  assert.equal(notOwner.ok, false);
  assert.equal(notOwner.error, "FORBIDDEN");

  // owner 移除 B:指针重置 + 会员行删除 + 修订号 +1
  var removed = await hhHandler({ action: "removeMember", member_key: householdLib.memberKeyOf("o-member-2") }, a);
  assert.equal(removed.ok, true, JSON.stringify(removed));
  await refreshResolved(b, "o-member-2");
  var bStatus = await hhHandler({ action: "status" }, b);
  assert.equal(bStatus.shared, false, "被移除后立即回到个人家庭");
  assert.equal(bStatus.household_id, householdLib.personalHouseholdId("o-member-2"));
  var memberRows = (await rawDocs(db, "household_members")).data;
  assert.equal(memberRows.length, 1);
  await refreshResolved(a, "o-owner-2");
  var aStatus = await hhHandler({ action: "status" }, a);
  assert.equal(aStatus.scope_revision, 3, "移除成员后修订号 +1");
  // 数据零触碰
  var items = (await rawDocs(db, "items")).data;
  assert.equal(items.length, 1);
  assert.equal(items[0].household_id, hid);

  // 重复移除 / 未知成员 / 移除自己 / 非法 member_key
  var again = await hhHandler({ action: "removeMember", member_key: householdLib.memberKeyOf("o-member-2") }, a);
  assert.equal(again.error, "NOT_FOUND");
  var unknown = await hhHandler({ action: "removeMember", member_key: sha256hex("nobody") }, a);
  assert.equal(unknown.error, "NOT_FOUND");
  var self = await hhHandler({ action: "removeMember", member_key: householdLib.memberKeyOf("o-owner-2") }, a);
  assert.equal(self.error, "INVALID_INPUT");
  var malformed = await hhHandler({ action: "removeMember", member_key: "not-hex" }, a);
  assert.equal(malformed.error, "INVALID_INPUT");
});

test("HHH-LC-3:memberList(owner)——owner 在前、is_self 标记、含摘要句柄不含 PII 字段", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-owner-3");
  var b = await makeDeps(db, "o-member-3");
  var created = await createFamily(a);
  var invite = await hhHandler({ action: "inviteCreate" }, a);
  await hhHandler({ action: "join", token: invite.invite.token }, b);

  await refreshResolved(a, "o-owner-3");
  var list = await hhHandler({ action: "memberList" }, a);
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.members.length, 2);
  assert.equal(list.members[0].role, "owner");
  assert.equal(list.members[0].is_self, true);
  assert.equal(list.members[1].role, "member");
  assert.equal(list.members[1].is_self, false);
  assert.equal(list.members[1].member_key, householdLib.memberKeyOf("o-member-3"));
  var allowed = ["member_key", "role", "joined_at", "invited_by", "is_self", "nickname", "avatar_file_id"].sort();
  assert.deepEqual(Object.keys(list.members[1]).sort(), allowed, "成员投影键集(展示资料 nickname/avatar 为用户自设、仅家庭互见)");

  // 普通成员可读(真机反馈:家庭成员互见是基本感知;管理动作仍 owner)
  await refreshResolved(b, "o-member-3");
  var memberView = await hhHandler({ action: "memberList" }, b);
  assert.equal(memberView.ok, true, "普通成员应能看到成员列表");
  assert.equal(memberView.members.length, list.members.length);
});

// ---------- HHH-PRF:updateProfile(头像昵称填写能力;真机反馈:成员需可辨认) ----------

test("HHH-PRF:updateProfile 只写自己的会员行;memberList 回显;输入校验;个人家庭拒绝", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "prf-owner");
  var created = await createFamily(a);
  var invite = await hhHandler({ action: "inviteCreate" }, a);
  await hhHandler({ action: "join", token: invite.invite.token }, await makeDeps(db, "prf-member"));

  // 设置自己的昵称+头像(合法 cloud://)
  var upd = await hhHandler({ action: "updateProfile", nickname: "老爸", avatar_file_id: "cloud://env.abc/avatars/x.jpg" }, a);
  assert.equal(upd.ok, true, JSON.stringify(upd));
  var lst = await hhHandler({ action: "memberList" }, a);
  var self = lst.members.filter(function (m) { return m.is_self; })[0];
  assert.equal(self.nickname, "老爸");
  assert.equal(self.avatar_file_id, "cloud://env.abc/avatars/x.jpg");
  var other = lst.members.filter(function (m) { return !m.is_self; })[0];
  assert.equal(other.nickname, null, "未设置的成员资料为 null");
  assert.equal(other.avatar_file_id, null);
  void created;

  // 昵称校验:超长(>20)/控制字符
  assert.equal((await hhHandler({ action: "updateProfile", nickname: "一二三四五六七八九十一二三四五六七八九十一" }, a)).error, "INVALID_INPUT");
  assert.equal((await hhHandler({ action: "updateProfile", nickname: "a\u0007b" }, a)).error, "INVALID_INPUT");
  // 头像校验:非 cloud:// 前缀拒绝(只收本环境云存储文件,防外链注入)
  assert.equal((await hhHandler({ action: "updateProfile", avatar_file_id: "https://evil/x.png" }, a)).error, "INVALID_INPUT");
  // 清空昵称合法(空白 trim 后置空)
  assert.equal((await hhHandler({ action: "updateProfile", nickname: "  " }, a)).ok, true);
  // 空补丁拒绝
  assert.equal((await hhHandler({ action: "updateProfile" }, a)).error, "INVALID_INPUT");
  // 个人家庭(未共享)无会员行,householdFail 拒绝
  var solo = await makeDeps(makeDb(), "prf-solo");
  assert.equal((await hhHandler({ action: "updateProfile", nickname: "我" }, solo)).error !== undefined, true);
});

test("HHH-LC-4:幂等 join(已是本家庭成员 → 直接成功)+ V1 一家庭边界(别家成员拒绝 join/create)", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-owner-4");
  var b = await makeDeps(db, "o-member-4");
  var c = await makeDeps(db, "o-outsider-4");
  var created = await createFamily(a);
  var hid = created.household_id;
  var invite = await hhHandler({ action: "inviteCreate" }, a);
  var token = invite.invite.token;

  var first = await hhHandler({ action: "join", token: token }, b);
  assert.equal(first.ok, true);
  assert.equal(first.joined, true);

  // 重复点确认:幂等直接成功,不双建会员行、不重复 +1
  var second = await hhHandler({ action: "join", token: token }, b);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.joined, false);
  assert.equal(second.already_member, true);
  var memberRows = (await rawDocs(db, "household_members")).data.filter(function (r) {
    return r.household_id === hid;
  });
  assert.equal(memberRows.length, 2);
  var hhDoc = (await db.collection("households").doc(hid).get()).data;
  assert.equal(hhDoc.scope_revision, 2, "幂等 join 不重复递增修订号");

  // 已在共享家庭的成员:加入另一家庭 → 明确拒绝;再 create → 明确拒绝
  var otherCreated = await createFamily(c);
  assert.equal(otherCreated.ok, true);
  var otherInvite = await hhHandler({ action: "inviteCreate" }, c);
  var crossJoin = await hhHandler({ action: "join", token: otherInvite.invite.token }, b);
  assert.equal(crossJoin.ok, false);
  assert.equal(crossJoin.error, "ALREADY_IN_FAMILY");
  await refreshResolved(b, "o-member-4");
  var recreate = await hhHandler({ action: "create" }, b);
  assert.equal(recreate.error, "ALREADY_IN_FAMILY");

  // 无家庭的第三者不能凭空 create 幂等键绕过:正常创建不受影响
  var d = await makeDeps(db, "o-fresh-4");
  var dCreate = await createFamily(d);
  assert.equal(dCreate.ok, true);
});

test("HHH-LC-5:解散后可重新创建(封存家庭会员行不阻碍新建);dissolve 幂等自愈(封存后中断重试补齐清理)", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-owner-5");
  var created = await createFamily(a);
  var hid = created.household_id;
  var invite = await hhHandler({ action: "inviteCreate" }, a);

  // 模拟「封存后中断」:手动完成封存,但保留指针与未废邀请
  await db.collection("households").where({ _id: hid }).update({
    data: { dissolved: true, dissolved_at: "2026-10-13T12:00:00.000Z" }
  });
  // 此时解析失败关闭(指针指向已解散家庭)
  var stuck = await householdLib.resolveActiveHousehold(db, "o-owner-5");
  assert.equal(stuck.ok, false);
  assert.equal(stuck.reason, "household_dissolved");

  // dissolve 重试走自愈路径:补齐撤销邀请 + 指针回收
  var healed = await hhHandler({ action: "dissolve" }, a);
  assert.equal(healed.ok, true, JSON.stringify(healed));
  assert.equal(healed.dissolved, true);
  assert.equal(healed.already_dissolved, true);
  var invites = (await rawDocs(db, "household_invites")).data;
  assert.equal(invites[0].revoked, true);
  var pointers = (await rawDocs(db, "active_household")).data;
  assert.equal(pointers.length, 0);

  // 解散后重新创建:封存家庭会员行不阻碍
  await refreshResolved(a, "o-owner-5");
  var again = await createFamily(a);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.notEqual(again.household_id, hid);
  var memberRows = (await rawDocs(db, "household_members")).data;
  assert.equal(memberRows.length, 2, "封存行 + 新家庭行");

  // 非.owner 不能 dissolve;不在共享家庭不能 leave/dissolve
  var b = await makeDeps(db, "o-member-5");
  var noFamily = await hhHandler({ action: "leave" }, b);
  assert.equal(noFamily.error, "NOT_FOUND");
  var noFamily2 = await hhHandler({ action: "dissolve" }, b);
  assert.equal(noFamily2.error, "NOT_FOUND");
});

// ---------- HHH-INV:令牌生命周期 ----------

test("HHH-INV-1:服务端只存 sha256(令牌)——库中任何字段不含裸令牌,哈希与令牌一一对应", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-owner-6");
  await createFamily(a);
  var invite = await hhHandler({ action: "inviteCreate" }, a);
  var token = invite.invite.token;
  var rows = (await rawDocs(db, "household_invites")).data;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, sha256hex(token), "只存 sha256(令牌)");
  var dump = JSON.stringify(rows);
  assert.equal(dump.indexOf(token), -1, "库中绝不出现裸令牌");
  assert.equal(rows[0].revoked, false);
  assert.equal(rows[0].expires_at, new Date(Date.parse("2026-10-13T12:00:00.000Z") + 7 * 86400 * 1000).toISOString(), "默认 7 天过期");
});

test("HHH-INV-2:撤销立即生效——inviteInfo/join 双双 NOT_FOUND,重复撤销幂等,owner 独管", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-owner-7");
  var b = await makeDeps(db, "o-member-7");
  await createFamily(a);
  var invite = await hhHandler({ action: "inviteCreate" }, a);
  var token = invite.invite.token;

  var revoked = await hhHandler({ action: "inviteRevoke", invite_id: invite.invite.invite_id }, a);
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  assert.equal(revoked.revoked, true);

  var info = await hhHandler({ action: "inviteInfo", token: token }, b);
  assert.equal(info.ok, false);
  assert.equal(info.error, "NOT_FOUND");
  var join = await hhHandler({ action: "join", token: token }, b);
  assert.equal(join.error, "NOT_FOUND");

  var again = await hhHandler({ action: "inviteRevoke", invite_id: invite.invite.invite_id }, a);
  assert.equal(again.ok, true);
  assert.equal(again.already_revoked, true);

  var unknown = await hhHandler({ action: "inviteRevoke", invite_id: "inv_missing" }, a);
  assert.equal(unknown.error, "NOT_FOUND");
  var bad = await hhHandler({ action: "inviteRevoke" }, a);
  assert.equal(bad.error, "INVALID_INPUT");

  // 普通成员撤销(先加入再试)
  var invite2 = await hhHandler({ action: "inviteCreate" }, a);
  await hhHandler({ action: "join", token: invite2.invite.token }, b);
  await refreshResolved(b, "o-member-7");
  var denied = await hhHandler({ action: "inviteRevoke", invite_id: invite2.invite.invite_id }, b);
  assert.equal(denied.error, "FORBIDDEN");
  var deniedCreate = await hhHandler({ action: "inviteCreate" }, b);
  assert.equal(deniedCreate.error, "FORBIDDEN");
});

test("HHH-INV-3:过期令牌——超过 expires_at 后 info/join 均 NOT_FOUND;未过期可用", async function () {
  var db = makeDb();
  var clock = makeClock();
  var a = await makeDeps(db, "o-owner-8", { clock: clock });
  var b = await makeDeps(db, "o-member-8", { clock: clock });
  await createFamily(a);
  var invite = await hhHandler({ action: "inviteCreate" }, a);
  var token = invite.invite.token;

  // 未过期:info 正常
  var info = await hhHandler({ action: "inviteInfo", token: token }, b);
  assert.equal(info.ok, true);

  // 推进时钟 7 天 + 1 秒
  clock.t += 7 * 86400 * 1000 + 1000;
  var expiredInfo = await hhHandler({ action: "inviteInfo", token: token }, b);
  assert.equal(expiredInfo.error, "NOT_FOUND");
  var expiredJoin = await hhHandler({ action: "join", token: token }, b);
  assert.equal(expiredJoin.error, "NOT_FOUND");
  // 邀请列表标记 expired
  var list = await hhHandler({ action: "inviteList" }, a);
  assert.equal(list.ok, true);
  assert.equal(list.invites[0].expired, true);
});

test("HHH-INV-4:多次使用——同一令牌两个不同用户先后加入,均为成员", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-owner-9");
  var b = await makeDeps(db, "o-member-9a");
  var c = await makeDeps(db, "o-member-9b");
  var created = await createFamily(a);
  var invite = await hhHandler({ action: "inviteCreate" }, a);
  var token = invite.invite.token;

  var j1 = await hhHandler({ action: "join", token: token }, b);
  assert.equal(j1.ok, true);
  var j2 = await hhHandler({ action: "join", token: token }, c);
  assert.equal(j2.ok, true, JSON.stringify(j2));
  var memberRows = (await rawDocs(db, "household_members")).data.filter(function (r) {
    return r.household_id === created.household_id;
  });
  assert.equal(memberRows.length, 3, "owner + 两名受邀成员");
});

test("HHH-INV-5:inviteList 不含令牌与哈希;owner 独管;个人用户调用 owner 类 action → NOT_FOUND", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-owner-10");
  await createFamily(a);
  await hhHandler({ action: "inviteCreate" }, a);
  await hhHandler({ action: "inviteCreate" }, a);
  var list = await hhHandler({ action: "inviteList" }, a);
  assert.equal(list.ok, true);
  assert.equal(list.invites.length, 2);
  var dump = JSON.stringify(list);
  var rawInvites = (await rawDocs(db, "household_invites")).data;
  assert.equal(dump.indexOf(rawInvites[0].token_hash), -1, "inviteList 不暴露令牌哈希");
  for (var i = 0; i < list.invites.length; i++) {
    var keys = Object.keys(list.invites[i]).sort();
    assert.deepEqual(keys, ["created_at", "expired", "expires_at", "invite_id", "revoked"], "邀请投影白名单");
  }
  // created_at 降序
  assert.ok(list.invites[0].created_at >= list.invites[1].created_at);

  // 单人用户(无共享家庭)
  var single = await makeDeps(db, "o-single-10");
  var noFamily = await hhHandler({ action: "inviteCreate" }, single);
  assert.equal(noFamily.error, "NOT_FOUND");
  var noList = await hhHandler({ action: "inviteList" }, single);
  assert.equal(noList.error, "NOT_FOUND");
});

test("HHH-INV-6:令牌格式校验与未知令牌——非字符串/过短/过长 INVALID_INPUT;合法格式但不存在 NOT_FOUND", async function () {
  var db = makeDb();
  var b = await makeDeps(db, "o-holder-11");
  var bad1 = await hhHandler({ action: "inviteInfo", token: 42 }, b);
  assert.equal(bad1.error, "INVALID_INPUT");
  var bad2 = await hhHandler({ action: "inviteInfo", token: "short" }, b);
  assert.equal(bad2.error, "INVALID_INPUT");
  var bad3 = await hhHandler({ action: "inviteInfo", token: "x".repeat(200) }, b);
  assert.equal(bad3.error, "INVALID_INPUT");
  var badJoin = await hhHandler({ action: "join", token: null }, b);
  assert.equal(badJoin.error, "INVALID_INPUT");
  var unknown = await hhHandler({ action: "inviteInfo", token: "T0000000000000000000000000000" }, b);
  assert.equal(unknown.error, "NOT_FOUND");
});

// ---------- HHH-REV:scope_revision 与跨家庭写安全 ----------

test("HHH-REV-1:成员变更事件逐次递增修订号(create=1 → join=2 → remove/leave=3 → dissolve=+1)", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-owner-12");
  var b = await makeDeps(db, "o-member-12");
  var created = await createFamily(a);
  var hid = created.household_id;
  assert.equal((await db.collection("households").doc(hid).get()).data.scope_revision, 1);

  var invite = await hhHandler({ action: "inviteCreate" }, a);
  await hhHandler({ action: "join", token: invite.invite.token }, b);
  assert.equal((await db.collection("households").doc(hid).get()).data.scope_revision, 2, "join +1");

  await hhHandler({ action: "removeMember", member_key: householdLib.memberKeyOf("o-member-12") }, a);
  assert.equal((await db.collection("households").doc(hid).get()).data.scope_revision, 3, "remove +1");

  await hhHandler({ action: "dissolve" }, a);
  var sealed = (await db.collection("households").doc(hid).get()).data;
  assert.equal(sealed.scope_revision, 4, "dissolve +1");
  assert.equal(sealed.dissolved, true);
});

test("HHH-REV-2:过窗旧请求拒写——成员变更后以旧 revision 写 items/locations → FAMILY_STALE_SCOPE 零写入;刷新后放行", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-owner-13");
  var b = await makeDeps(db, "o-member-13");
  var created = await createFamily(a);
  var hid = created.household_id;

  var invite = await hhHandler({ action: "inviteCreate" }, a);
  await hhHandler({ action: "join", token: invite.invite.token }, b);
  // B 的客户端在修订号 2 时捕获作用域;此后第三名成员加入 → 修订号 3
  var c = await makeDeps(db, "o-member-13b");
  var invite2 = await hhHandler({ action: "inviteCreate" }, a);
  await hhHandler({ action: "join", token: invite2.invite.token }, c);
  var revNow = (await db.collection("households").doc(hid).get()).data.scope_revision;
  assert.equal(revNow, 3);

  // 服务端视角是当前修订号(deps.scopeRevision,由解析器注入);客户端携带过窗旧捕获
  var staleDeps = {
    db: db,
    now: function () {
      return "2026-10-13T00:00:00.000Z";
    },
    genId: function () {
      return "s1";
    },
    householdId: hid,
    householdShared: true,
    scopeRevision: revNow,
    logger: { log: function () {} }
  };
  var stale = await itemsHandler(
    { action: "create", operation_id: "rev-op-1", name: "过窗物品", location_text: "x", expected_household_id: hid, expected_scope_revision: revNow - 1 },
    staleDeps
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "FAMILY_STALE_SCOPE");
  var items = (await rawDocs(db, "items")).data;
  assert.equal(items.length, 0, "过窗请求零写入");

  var staleLoc = await locHandler(
    { action: "ensurePath", path: ["书房"], expected_household_id: hid, expected_scope_revision: revNow - 1 },
    {
      db: db,
      now: function () {
        return "2026-10-13T00:00:00.000Z";
      },
      genId: function () {
        return "sl1";
      },
      digest: digest16,
      householdId: hid,
      householdShared: true,
      scopeRevision: revNow,
      logger: { log: function () {} }
    }
  );
  assert.equal(staleLoc.error, "FAMILY_STALE_SCOPE");
  assert.equal((await rawDocs(db, "locations")).data.length, 0);

  // 刷新(list 拿到新修订号)后放行:客户端捕获与服务端当前修订号一致
  var okWrite = await itemsHandler(
    { action: "create", operation_id: "rev-op-2", name: "新鲜物品", location_text: "x", expected_household_id: hid, expected_scope_revision: revNow },
    staleDeps
  );
  assert.equal(okWrite.ok, true, JSON.stringify(okWrite));
});

test("HHH-REV-3:退出/被移除后,旧作用域请求不可再写入共享域(解析回个人家庭 + marker 失配双保险)", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-owner-14");
  var b = await makeDeps(db, "o-member-14");
  var created = await createFamily(a);
  var hid = created.household_id;
  var invite = await hhHandler({ action: "inviteCreate" }, a);
  await hhHandler({ action: "join", token: invite.invite.token }, b);

  // B 被移除;其客户端还持有旧作用域(hid + revision 2)发起写请求
  await hhHandler({ action: "removeMember", member_key: householdLib.memberKeyOf("o-member-14") }, a);
  var bResolved = await householdLib.resolveActiveHousehold(db, "o-member-14");
  assert.equal(bResolved.ok, true);
  assert.equal(bResolved.shared, false, "被移除后解析回个人家庭");

  var bItems = {
    db: db,
    now: function () {
      return "2026-10-13T00:00:00.000Z";
    },
    genId: function () {
      return "bo1";
    },
    householdId: bResolved.householdId,
    householdShared: bResolved.shared === true,
    scopeRevision: bResolved.scopeRevision,
    logger: { log: function () {} }
  };
  var ghost = await itemsHandler(
    { action: "create", operation_id: "ghost-op-1", name: "幽灵写入", location_text: "x", expected_household_id: hid, expected_scope_revision: 2 },
    bItems
  );
  assert.equal(ghost.ok, false);
  assert.equal(ghost.error, "FAMILY_SWITCHED", "个人家庭解析 + 携带共享家庭 marker → 失配拒绝");
  var items = (await rawDocs(db, "items")).data;
  assert.equal(items.length, 0, "共享域零写入");
});

// ---------- HHH-SINGLE:单人(私人)宽松口径零回归 ----------

test("HHH-SINGLE:个人用户 status 回个人家庭;items/locations 写操作无 marker 放行、携带 revision 忽略(handler 级,P0 口径不变)", async function () {
  var db = makeDb();
  var single = await makeDeps(db, "o-single-15");
  var st = await hhHandler({ action: "status" }, single);
  assert.equal(st.ok, true);
  assert.equal(st.shared, false);
  assert.equal(st.household_id, householdLib.personalHouseholdId("o-single-15"));
  assert.equal(st.role, null);
  assert.equal(st.scope_revision, null);

  var personal = householdLib.personalHouseholdId("o-single-15");
  var deps = {
    db: db,
    now: function () {
      return "2026-10-13T00:00:00.000Z";
    },
    genId: function () {
      return "p1";
    },
    householdId: personal,
    logger: { log: function () {} }
  };
  var noMarker = await itemsHandler({ action: "create", operation_id: "single-op-1", name: "私人钥匙", location_text: "玄关" }, deps);
  assert.equal(noMarker.ok, true, "个人家庭无 marker 维持 P0 现状");
  var withRev = await itemsHandler(
    { action: "create", operation_id: "single-op-2", name: "私人温度计", location_text: "药箱", expected_household_id: personal, expected_scope_revision: 12345 },
    deps
  );
  assert.equal(withRev.ok, true, "个人家庭携带 expected_scope_revision 一律忽略");
  assert.equal((await rawDocs(db, "items")).data.length, 2);
});

// ---------- HHH-FC:失败关闭 ----------

/** 把指定集合的 where().get()/update()/remove()/add() 全部变为 reject */
function throwingCollectionDb(base, collectionName) {
  return {
    collection: function (name) {
      if (name !== collectionName) {
        return base.collection(name);
      }
      return {
        where: function () {
          return {
            get: function () {
              return Promise.reject(new Error("simulated: collection " + name + " unavailable"));
            },
            update: function () {
              return Promise.reject(new Error("simulated: collection " + name + " unavailable"));
            },
            remove: function () {
              return Promise.reject(new Error("simulated: collection " + name + " unavailable"));
            }
          };
        },
        add: function () {
          return Promise.reject(new Error("simulated: collection " + name + " unavailable"));
        },
        doc: base.collection(name).doc
      };
    }
  };
}

test("HHH-FC-1:元数据集合查询/写入异常 → HOUSEHOLD_UNAVAILABLE 明确终止,绝不伪装成业务错误、绝不回退", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-owner-16");
  await createFamily(a);

  // households 集合异常:create 失败关闭(零新增家庭)
  var brokenA = Object.assign({}, a, { db: throwingCollectionDb(db, "households") });
  var resCreate = await hhHandler({ action: "create" }, brokenA);
  assert.equal(resCreate.ok, false);
  assert.equal(resCreate.error, "HOUSEHOLD_UNAVAILABLE");
  assert.equal(typeof resCreate.message, "string");

  // household_invites 异常:inviteInfo 绝不把异常伪装成「邀请不存在」
  var b = await makeDeps(db, "o-holder-16");
  var brokenB = Object.assign({}, b, { db: throwingCollectionDb(db, "household_invites") });
  var resInfo = await hhHandler({ action: "inviteInfo", token: "T0000000000000000000000000000" }, brokenB);
  assert.equal(resInfo.error, "HOUSEHOLD_UNAVAILABLE");

  // active_household 异常:dissolve 失败关闭
  var brokenC = Object.assign({}, a, { db: throwingCollectionDb(db, "active_household") });
  var resDissolve = await hhHandler({ action: "dissolve" }, brokenC);
  assert.equal(resDissolve.error, "HOUSEHOLD_UNAVAILABLE");

  // household_members 异常:join 前置校验失败关闭
  await refreshResolved(a, "o-owner-16");
  var invite = await hhHandler({ action: "inviteCreate" }, a);
  var brokenD = Object.assign({}, b, { db: throwingCollectionDb(db, "household_members") });
  var resJoin = await hhHandler({ action: "join", token: invite.invite.token }, brokenD);
  assert.equal(resJoin.error, "HOUSEHOLD_UNAVAILABLE");

  // 失败关闭零残留:未产生任何家庭/会员/指针
  assert.equal((await rawDocs(db, "households")).data.length, 1, "仅原有的一个家庭,异常路径未新增");
});

// ---------- HHH-LOG:日志脱敏 ----------

test("HHH-LOG:日志字段仅白名单(action/error/ms/count),不含 openid/member_key/裸令牌/令牌哈希/家庭名/household_id", async function () {
  var db = makeDb();
  var entries = [];
  var logger = { log: function (e) { entries.push(e); } };
  var a = await makeDeps(db, "o-owner-log", { logger: logger });
  var b = await makeDeps(db, "o-member-log", { logger: logger });

  var created = await createFamily(a, "日志山庄");
  var hid = created.household_id;
  var invite = await hhHandler({ action: "inviteCreate" }, a);
  var token = invite.invite.token;
  var tokenHash = sha256hex(token);
  await hhHandler({ action: "inviteInfo", token: token }, b);
  await hhHandler({ action: "join", token: token }, b);
  await refreshResolved(b, "o-member-log");
  await hhHandler({ action: "status" }, b);
  await hhHandler({ action: "memberList" }, a);
  await hhHandler({ action: "inviteRevoke", invite_id: "inv_none" }, a);
  await hhHandler({ action: "leave" }, b);
  await hhHandler({ action: "dissolve" }, a);
  await hhHandler({ action: "nope" }, a);

  assert.ok(entries.length >= 10, "应有多条日志,实际 " + entries.length);
  var dump = JSON.stringify(entries);
  for (var i = 0; i < entries.length; i++) {
    var keys = Object.keys(entries[i]);
    for (var k = 0; k < keys.length; k++) {
      assert.ok(
        ["action", "error", "ms", "count"].indexOf(keys[k]) !== -1,
        "日志出现越界字段:" + keys[k]
      );
    }
  }
  assert.equal(dump.indexOf("o-owner-log"), -1, "日志不得出现 openid");
  assert.equal(dump.indexOf(householdLib.memberKeyOf("o-owner-log")), -1, "日志不得出现 member_key");
  assert.equal(dump.indexOf(token), -1, "日志不得出现裸令牌");
  assert.equal(dump.indexOf(tokenHash), -1, "日志不得出现令牌哈希");
  assert.equal(dump.indexOf("日志山庄"), -1, "日志不得出现家庭名");
  assert.equal(dump.indexOf(hid), -1, "日志不得出现 household_id");
});

// ---------- HHH-GLUE:index.js 真实加载(stub wx-server-sdk) ----------

/** 临时把 wx-server-sdk 替换为 stub 并(重新)加载云函数入口(照 tests/glue.test.js 手法) */
function loadCloudFunction(entryPath, stubSdk) {
  var origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "wx-server-sdk") {
      return stubSdk;
    }
    return origLoad.apply(this, arguments);
  };
  for (var key of Object.keys(require.cache)) {
    if (key.indexOf(path.join(ROOT, "cloudfunctions")) === 0) {
      delete require.cache[key];
    }
  }
  try {
    return require(entryPath);
  } finally {
    Module._load = origLoad;
  }
}

function makeHouseholdsStub(openid, db) {
  return {
    DYNAMIC_CURRENT_ENV: "env-dynamic",
    init: function () {},
    getWXContext: function () {
      return openid ? { OPENID: openid } : {};
    },
    database: function () {
      return db;
    }
  };
}

test("HHH-GLUE-1:真实入口——缺 OPENID → UNAUTHORIZED;个人用户 status 回个人家庭;未知 action INVALID_INPUT", async function () {
  var db = makeDb();
  var anon = loadCloudFunction(path.join(ROOT, "cloudfunctions", "households", "index.js"), makeHouseholdsStub(null, db));
  var unauthed = await anon.main({ action: "status" });
  assert.equal(unauthed.ok, false);
  assert.equal(unauthed.error, "UNAUTHORIZED");
  assert.equal(typeof unauthed.message, "string");

  var entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "households", "index.js"), makeHouseholdsStub("o-glue-single", db));
  var st = await entry.main({ action: "status" });
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.shared, false);
  assert.equal(st.household_id, householdLib.personalHouseholdId("o-glue-single"));

  var bad = await entry.main({ action: "nope" });
  assert.equal(bad.error, "INVALID_INPUT");
});

test("HHH-GLUE-2:真实入口全链 create → inviteCreate(真实 crypto 令牌)→ join → status;令牌 ≥192bit、库中只存哈希", async function () {
  var db = makeDb();
  var a = loadCloudFunction(path.join(ROOT, "cloudfunctions", "households", "index.js"), makeHouseholdsStub("o-glue-owner", db));
  var created = await a.main({ action: "create", display_name: "胶水之家" });
  assert.equal(created.ok, true, JSON.stringify(created));

  var invite = await a.main({ action: "inviteCreate" });
  assert.equal(invite.ok, true, JSON.stringify(invite));
  var token = invite.invite.token;
  assert.ok(token.length >= 32, "base64url(24 字节)=32 字符,192bit ≥ 128bit");
  assert.ok(/^[A-Za-z0-9_-]+$/.test(token), "令牌 URL 安全(分享卡片 path 可直接携带)");
  var rows = (await rawDocs(db, "household_invites")).data;
  assert.equal(rows[0].token_hash, sha256hex(token));

  var b = loadCloudFunction(path.join(ROOT, "cloudfunctions", "households", "index.js"), makeHouseholdsStub("o-glue-member", db));
  var joined = await b.main({ action: "join", token: token });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  var st = await b.main({ action: "status" });
  assert.equal(st.ok, true);
  assert.equal(st.shared, true);
  assert.equal(st.role, "member");
  assert.equal(st.display_name, "胶水之家");
  assert.equal(st.household_id, created.household_id);
});

// ---------- HHH-SW:switch 切换家庭(issue #45 十七轮;#34 合同不弱化) ----------
// 只更新 active 指针 + 客户端作用域刷新:不迁移数据、不递增 scope_revision;
// personal 永远可回;shared 须在册且未解散;被移除/解散后不可再切共享。

test("HHH-SW-1:个人用户——switch personal 永远可回且幂等;switch shared 无在册家庭 NOT_FOUND;target 非法 INVALID_INPUT", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-sw-single");

  var toPersonal = await hhHandler({ action: "switch", target: "personal" }, a);
  assert.equal(toPersonal.ok, true, JSON.stringify(toPersonal));
  assert.equal(toPersonal.already, true, "本就在个人家庭:幂等成功");
  assert.equal(toPersonal.shared, false);
  assert.equal(toPersonal.household_id, householdLib.personalHouseholdId("o-sw-single"), "status 摘要给个人家庭 id");
  assert.equal(toPersonal.role, null);
  assert.equal(toPersonal.scope_revision, null);
  assert.equal(toPersonal.display_name, null);

  var toShared = await hhHandler({ action: "switch", target: "shared" }, a);
  assert.equal(toShared.ok, false, "从未加入共享家庭");
  assert.equal(toShared.error, "NOT_FOUND", "无在册家庭明确拒绝,不猜");
  assert.equal(toShared.message, "你还没有加入共享家庭");

  var badTarget = await hhHandler({ action: "switch", target: "别的" }, a);
  assert.equal(badTarget.error, "INVALID_INPUT");
  var noTarget = await hhHandler({ action: "switch" }, a);
  assert.equal(noTarget.error, "INVALID_INPUT");
});

test("HHH-SW-2:owner 来回切换——指针唯一且原子、解析域跟随、scope_revision 不递增、重复切幂等", async function () {
  var db = makeDb();
  var entries = [];
  var logger = { log: function (e) { entries.push(e); } };
  var a = await makeDeps(db, "o-sw-owner", { logger: logger });
  var created = await createFamily(a, "山腰的家");
  var hid = created.household_id;

  // 共享 → 个人:撤指针,此后解析确定性回个人家庭
  var toPersonal = await hhHandler({ action: "switch", target: "personal" }, a);
  assert.equal(toPersonal.ok, true, JSON.stringify(toPersonal));
  assert.equal(toPersonal.already, false);
  assert.equal(toPersonal.shared, false);
  assert.equal(toPersonal.household_id, householdLib.personalHouseholdId("o-sw-owner"));
  var pointers = (await rawDocs(db, "active_household")).data.filter(function (r) {
    return r.member_key === householdLib.memberKeyOf("o-sw-owner");
  });
  assert.equal(pointers.length, 0, "指针行已删除(active 指针唯一)");
  var resolvedPersonal = await householdLib.resolveActiveHousehold(db, "o-sw-owner");
  assert.equal(resolvedPersonal.ok, true);
  assert.equal(resolvedPersonal.shared, false, "itemsApi/locations 解析域跟随指针回个人家庭");

  // 个人 → 共享:在册且未解散 → 指针恢复,修订号不递增(切换不是成员变更事件)
  var backShared = await hhHandler({ action: "switch", target: "shared" }, a);
  assert.equal(backShared.ok, true, JSON.stringify(backShared));
  assert.equal(backShared.already, false);
  assert.equal(backShared.shared, true);
  assert.equal(backShared.household_id, hid);
  assert.equal(backShared.role, "owner");
  assert.equal(backShared.display_name, "山腰的家");
  assert.equal(backShared.scope_revision, created.scope_revision, "switch 不递增 scope_revision(#34 合同)");
  var pointers2 = (await rawDocs(db, "active_household")).data.filter(function (r) {
    return r.member_key === householdLib.memberKeyOf("o-sw-owner");
  });
  assert.equal(pointers2.length, 1, "指针唯一(单行,不双写)");
  assert.equal(pointers2[0].household_id, hid);
  var resolvedShared = await householdLib.resolveActiveHousehold(db, "o-sw-owner");
  assert.equal(resolvedShared.ok, true);
  assert.equal(resolvedShared.householdId, hid, "解析域跟随指针回共享家庭");

  // 重复切同一个家庭:幂等
  var again = await hhHandler({ action: "switch", target: "shared" }, a);
  assert.equal(again.ok, true);
  assert.equal(again.already, true, "已在目标家庭:幂等成功");
  var pointers3 = (await rawDocs(db, "active_household")).data.filter(function (r) {
    return r.member_key === householdLib.memberKeyOf("o-sw-owner");
  });
  assert.equal(pointers3.length, 1, "幂等路径不产生第二行指针");

  // 家庭数据零迁移:共享域 items 原地不动,个人域未被触碰(数据不搬家)
  var hhItems = (await rawDocs(db, "items")).data.filter(function (r) {
    return r.household_id === hid;
  });
  assert.equal(hhItems.length, 0, "切换不复制/不迁移任何家庭数据");

  // 日志零敏感:switch 只落白名单计量字段
  var dump = JSON.stringify(entries);
  assert.equal(dump.indexOf("o-sw-owner"), -1, "日志不得出现 openid");
  assert.equal(dump.indexOf(householdLib.memberKeyOf("o-sw-owner")), -1, "日志不得出现 member_key");
  assert.equal(dump.indexOf("山腰的家"), -1, "日志不得出现家庭名");
  assert.equal(dump.indexOf(hid), -1, "日志不得出现 household_id");
  for (var i = 0; i < entries.length; i++) {
    var keys = Object.keys(entries[i]);
    for (var k = 0; k < keys.length; k++) {
      assert.ok(
        ["action", "error", "ms", "count"].indexOf(keys[k]) !== -1,
        "switch 日志出现越界字段:" + keys[k]
      );
    }
  }
});

test("HHH-SW-3:成员被移除后不可再切共享(在册已失)——switch shared NOT_FOUND,解析保持个人家庭", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-sw-owner2");
  var b = await makeDeps(db, "o-sw-member2");
  var created = await createFamily(a, "被移除之家");
  var hid = created.household_id;
  var invite = await hhHandler({ action: "inviteCreate" }, a);
  var joined = await hhHandler({ action: "join", token: invite.invite.token }, b);
  assert.equal(joined.ok, true, JSON.stringify(joined));
  await refreshResolved(b, "o-sw-member2");

  // 成员先切回个人,再切回共享:资格在册,来回自由
  var toPersonal = await hhHandler({ action: "switch", target: "personal" }, b);
  assert.equal(toPersonal.ok, true);
  var backShared = await hhHandler({ action: "switch", target: "shared" }, b);
  assert.equal(backShared.ok, true, JSON.stringify(backShared));
  assert.equal(backShared.household_id, hid);

  // owner 移除成员(指针被重置回个人家庭)→ 在册已失,不可再切共享
  await refreshResolved(a, "o-sw-owner2");
  var memberRows = (await rawDocs(db, "household_members")).data.filter(function (r) {
    return r.member_key === householdLib.memberKeyOf("o-sw-member2");
  });
  var removed = await hhHandler({ action: "removeMember", member_key: memberRows[0].member_key }, a);
  assert.equal(removed.ok, true, JSON.stringify(removed));
  var denied = await hhHandler({ action: "switch", target: "shared" }, b);
  assert.equal(denied.ok, false, "被移除后不可切共享");
  assert.equal(denied.error, "NOT_FOUND");
  var afterRemove = await householdLib.resolveActiveHousehold(db, "o-sw-member2");
  assert.equal(afterRemove.shared, false, "解析保持个人家庭,共享域不可再进入");
});

test("HHH-SW-4:家庭解散后不可切共享(未解散门);owner 解散后指针已在个人家庭", async function () {
  var db = makeDb();
  var a = await makeDeps(db, "o-sw-dissolve");
  var created = await createFamily(a, "解散之家");
  var hid = created.household_id;
  var dissolved = await hhHandler({ action: "dissolve" }, a);
  assert.equal(dissolved.ok, true, JSON.stringify(dissolved));

  var denied = await hhHandler({ action: "switch", target: "shared" }, a);
  assert.equal(denied.ok, false, "已解散家庭的会员行是封存记录,不可切换进入");
  assert.equal(denied.error, "NOT_FOUND");
  var resolved = await householdLib.resolveActiveHousehold(db, "o-sw-dissolve");
  assert.equal(resolved.shared, false, "解散后指针已在个人家庭");
});

test("HHH-SW-GLUE:真实入口 switch——A create 后 B(A)切个人/切共享经 index.js 解析收口", async function () {
  var db = makeDb();
  var entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "households", "index.js"), makeHouseholdsStub("o-glue-sw", db));
  var created = await entry.main({ action: "create", display_name: "胶水切换之家" });
  assert.equal(created.ok, true, JSON.stringify(created));
  var toPersonal = await entry.main({ action: "switch", target: "personal" });
  assert.equal(toPersonal.ok, true, JSON.stringify(toPersonal));
  assert.equal(toPersonal.shared, false);
  var backShared = await entry.main({ action: "switch", target: "shared" });
  assert.equal(backShared.ok, true, JSON.stringify(backShared));
  assert.equal(backShared.shared, true);
  assert.equal(backShared.household_id, created.household_id);
});
