"use strict";

/**
 * households 纯函数 handler(issue #34 P1-A,docs/API_CONTRACT.md「households 协议」)。
 * handler(event, deps):身份只来自 deps.memberKey 与 deps.resolved(服务端从可信
 * OPENID 经 lib/household.js 三向解析得出),绝不从 event 读取任何身份字段;
 * 依赖注入以便离线测试。
 * deps = { db, now(), genId(), genToken(), sha256(s), memberKey, resolved, logger }。
 *
 * action 面:
 *   - create:新建空白共享家庭(全新 household_id,不复制任何私人数据),创建者
 *     成为 owner 并把 active 指针切到共享家庭;V1 边界:已在任一未解散共享家庭
 *     → ALREADY_IN_FAMILY 明确拒绝,绝不静默转家;
 *   - inviteCreate / inviteRevoke / inviteList(owner 独管):邀请令牌为服务端
 *     crypto 随机 ≥128bit,库中只存 sha256(裸令牌绝不落库、绝不进日志),
 *     默认 7 天过期、多次使用、可随时撤销;裸令牌只在 inviteCreate 响应出现一次;
 *   - inviteInfo(持令牌者):只返回家庭 display_name,不暴露任何成员身份 PII、
 *     不暴露 household_id;令牌不存在/已撤销/已过期/家庭已解散统一 NOT_FOUND,
 *     查询异常 → HOUSEHOLD_UNAVAILABLE 失败关闭(绝不把异常伪装成「不存在」);
 *   - join(持令牌者):幂等(已是本家庭成员 → 补齐指针直接成功);已在别的
 *     未解散共享家庭 → ALREADY_IN_FAMILY;建会员行(role=member)+ active 指针
 *     切换;每次成员变更事件 households.scope_revision +1;
 *   - leave:普通成员退出——先撤 active 指针(立即回到个人家庭)再删会员行;
 *     owner 在其他成员未全部退出前不能退出(OWNER_NOT_LAST),最后一人只能
 *     解散(OWNER_MUST_DISSOLVE);
 *   - removeMember(owner):移除成员——对方 active 指针若指向本家庭则重置回其
 *     个人家庭,删会员行;不可移除自己;对方数据零触碰(仅解除挂靠);
 *   - dissolve(owner,仅当最后一人):households.dissolved=true 软封存 + 全部
 *     邀请令牌作废 + active 指针切回个人家庭;家庭数据(items/locations)永不
 *     删除;幂等可重试(封存后中断的重试走自愈路径补齐清理);
 *   - memberList(owner):成员清单(member_key 为服务端派生摘要句柄,供
 *     removeMember 寻址;系统不存昵称等 PII);
 *   - status:当前活跃家庭概要(household_id/role/scope_revision/shared/
 *     display_name),P1-B 启动/恢复资格复核的依据;
 *   - switch(十七轮切换家庭,#34 合同不弱化):target="personal" 永远可回
 *     (撤指针行,解析确定性回个人家庭);target="shared" 需在册且未解散;
 *     只做 active 指针的单行原子切换(不迁移数据、不递增 scope_revision),
 *     返回新家庭 status 摘要供客户端整页刷新作用域。
 *
 * 纪律:
 *   - 失败关闭:任何元数据查询/写入异常 → HOUSEHOLD_UNAVAILABLE 明确终止,
 *     绝不回退、绝不静默;无跨文档事务,半完成状态全部设计为「可重试收敛」
 *     (幂等键 + 唯一索引 + 条件更新 + 自愈重试,见各 action 注释);
 *   - 日志只记 action/error/ms/count,绝不落 openid/member_key/裸令牌/令牌哈希/
 *     家庭名/household_id;
 *   - 撤销回滚只删除「本次刚写入的行」,绝不触碰任何家庭数据(数据永不删除红线)。
 */

var HOUSEHOLDS_COLLECTION = "households";
var INVITES_COLLECTION = "household_invites";
var MEMBERS_COLLECTION = "household_members";
var ACTIVE_COLLECTION = "active_household";

var DISPLAY_NAME_DEFAULT = "我的家";
var DISPLAY_NAME_MAX = 30; // 码点
var INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 默认 7 天
var PAGE_SIZE = 100;
var MAX_PAGES = 10; // 元数据集合护栏(家庭/邀请规模远小于此)
var BUMP_RETRIES = 5; // scope_revision 条件更新(CAS)重试上限
var MEMBER_KEY_PATTERN = /^[0-9a-f]{64}$/;
var TOKEN_MIN = 16;
var TOKEN_MAX = 128;
var INVITE_ID_MAX = 64;

var ERROR_MESSAGES = {
  INVALID_INPUT: "输入不合法,请检查后重试",
  UNAUTHORIZED: "请先登录",
  NOT_FOUND: "邀请或家庭成员不存在,或已失效",
  FORBIDDEN: "只有家庭创建者才能执行这个操作",
  ALREADY_IN_FAMILY: "你已在一个共享家庭里,退出或解散后才能再加入或新建",
  OWNER_NOT_LAST: "还有其他成员在家庭里,先移除他们或等他们退出,才能退出或解散",
  OWNER_MUST_DISSOLVE: "家庭里只剩你一个人,不能退出,只能解散家庭",
  HOUSEHOLD_UNAVAILABLE: "暂时无法确认当前家庭,请稍后重试"
};

function fail(error, message) {
  return { ok: false, error: error, message: message || ERROR_MESSAGES[error] };
}

/** 失败关闭结果(与 lib/household.js 同口径):明确错误终止,绝不回退 */
function householdFail(reason) {
  return {
    ok: false,
    error: "HOUSEHOLD_UNAVAILABLE",
    message: ERROR_MESSAGES.HOUSEHOLD_UNAVAILABLE,
    reason: reason
  };
}

function isString(v) {
  return typeof v === "string";
}

function codePointLength(s) {
  return Array.from(s).length;
}

/** 家庭名校验:缺省 → 默认「我的家」;字符串去空白后 1-30 码点;非法返回 null */
function cleanDisplayName(v) {
  if (v === undefined) {
    return DISPLAY_NAME_DEFAULT;
  }
  if (!isString(v)) {
    return null;
  }
  var trimmed = v.trim();
  if (codePointLength(trimmed) < 1 || codePointLength(trimmed) > DISPLAY_NAME_MAX) {
    return null;
  }
  return trimmed;
}

/** 邀请令牌格式:非空字符串、长度 16-128(真正的强度由 genToken 的随机字节数保证) */
function validToken(v) {
  return isString(v) && v.length >= TOKEN_MIN && v.length <= TOKEN_MAX;
}

function validInviteId(v) {
  return isString(v) && v.length >= 1 && v.length <= INVITE_ID_MAX;
}

function validMemberKey(v) {
  return isString(v) && MEMBER_KEY_PATTERN.test(v);
}

/** 识别 CloudBase 唯一索引拒绝并发插入的错误(E11000 duplicate key,itemsApi 同款) */
function isDuplicateKeyError(e) {
  var msg = e && e.message ? String(e.message) : "";
  return msg.indexOf("E11000") !== -1 || msg.indexOf("duplicate key") !== -1;
}

function householdsCol(deps) {
  return deps.db.collection(HOUSEHOLDS_COLLECTION);
}

function invitesCol(deps) {
  return deps.db.collection(INVITES_COLLECTION);
}

function membersCol(deps) {
  return deps.db.collection(MEMBERS_COLLECTION);
}

function activeCol(deps) {
  return deps.db.collection(ACTIVE_COLLECTION);
}

/**
 * 分页拉全量(skip/limit 逐页,itemsApi fetchActiveItems 同款模式与护栏):
 * 超过护栏页数抛错,绝不静默截断。
 */
async function fetchAll(deps, name, cond) {
  var out = [];
  for (var page = 0; page < MAX_PAGES; page++) {
    var res = await deps.db.collection(name).where(cond).skip(out.length).limit(PAGE_SIZE).get();
    var batch = (res && res.data) || [];
    for (var i = 0; i < batch.length; i++) {
      out.push(batch[i]);
    }
    if (batch.length < PAGE_SIZE) {
      return out;
    }
  }
  throw new Error(name + " query exceeded " + MAX_PAGES * PAGE_SIZE + " documents");
}

/** 按 _id 查家庭元数据行,无则 null */
async function getHouseholdDoc(deps, householdId) {
  var res = await householdsCol(deps).where({ _id: householdId }).get();
  return res && res.data && res.data.length > 0 ? res.data[0] : null;
}

/**
 * scope_revision +1(成员变更事件:create 初始化为 1,join/leave/removeMember/
 * dissolve 各 +1)。条件更新(where dissolved:false 且 scope_revision 等于读到的
 * 当前值)保证单调不回退;并发交错时重试收敛。家庭已解散 → { sealed:true },
 * 调用方按各自语义处理(leave/remove 忽略;join 回滚)。
 */
async function bumpScopeRevision(deps, householdId) {
  for (var i = 0; i < BUMP_RETRIES; i++) {
    var household = await getHouseholdDoc(deps, householdId);
    if (!household) {
      throw new Error("households doc missing during scope_revision bump");
    }
    if (household.dissolved === true) {
      return { sealed: true };
    }
    if (household.dissolved !== false || !Number.isInteger(household.scope_revision)) {
      throw new Error("households doc invalid during scope_revision bump");
    }
    var rev = household.scope_revision;
    var res = await householdsCol(deps)
      .where({ _id: householdId, dissolved: false, scope_revision: rev })
      .update({ data: { scope_revision: rev + 1 } });
    if (res && res.stats && res.stats.updated >= 1) {
      return { sealed: false, revision: rev + 1 };
    }
  }
  throw new Error("scope_revision bump contention exceeded retries");
}

/** 作废家庭全部未撤销邀请(dissolve 收尾共用,幂等) */
async function revokeAllInvites(deps, householdId, now) {
  await invitesCol(deps)
    .where({ household_id: householdId, revoked: false })
    .update({ data: { revoked: true, revoked_at: now } });
}

/** 撤销 join 本次刚写入的会员行(只删自己刚建的行,绝不触碰家庭数据) */
async function rollbackMembership(deps, householdId, memberKey) {
  await membersCol(deps).where({ household_id: householdId, member_key: memberKey }).remove();
}

/** owner 上下文守卫:resolved 必须是共享家庭且 role=owner;返回 null 或拒绝结果 */
function requireOwnerContext(deps) {
  var resolved = deps.resolved;
  if (!resolved || resolved.ok !== true) {
    return householdFail("resolver_missing");
  }
  if (resolved.shared !== true) {
    return fail("NOT_FOUND", "你当前不在共享家庭里");
  }
  if (resolved.role !== "owner") {
    return fail("FORBIDDEN");
  }
  return null;
}

/**
 * 设/补 active 指针(幂等路径共用):行不存在则插入;唯一索引冲突则回读,
 * 已指向目标家庭 → 收敛成功;指向别处 → 返回 { conflict:true } 由调用方裁定。
 */
async function setActivePointer(deps, memberKey, householdId, now) {
  try {
    await activeCol(deps).add({
      data: { member_key: memberKey, household_id: householdId, updated_at: now }
    });
    return { ok: true };
  } catch (e) {
    if (!isDuplicateKeyError(e)) {
      throw e;
    }
    var res = await activeCol(deps).where({ member_key: memberKey }).get();
    var rows = (res && res.data) || [];
    if (rows.length === 1 && rows[0].household_id === householdId) {
      return { ok: true };
    }
    return { conflict: true };
  }
}

// ---------------------------------------------------------------------------
// action:status
// ---------------------------------------------------------------------------

/**
 * status:当前活跃家庭概要。个人家庭 → shared:false(household_id 为存量算法
 * 派生值);共享家庭 → 三向验证通过后的 household_id/role/scope_revision/
 * display_name。P1-B 冷启动/前台恢复/成员变更后资格复核的依据。
 */
/**
 * updateProfile:设置本人在本家庭的展示资料(昵称/头像)。
 * 微信 2022 起收回静默获取昵称头像(wx.getUserProfile 只回匿名),官方路径
 * 是「头像昵称填写能力」——客户端 chooseAvatar 按钮 + type=nickname 输入,
 * 用户主动设置,此处只校验与落库。只写自己的会员行(resolver 派生 member_key,
 * 请求里带别人 member_key 一律忽略);展示性变更不递增 scope_revision
 * (成员事件才递增,F2 写入门不受影响)。
 */
async function updateProfileAction(event, deps) {
  var r = deps.resolved;
  if (!r || r.ok !== true || r.shared !== true) {
    return householdFail("not_shared");
  }
  var patch = {};
  if (event.nickname !== undefined) {
    if (typeof event.nickname !== "string") {
      return fail("INVALID_INPUT", "昵称格式不正确");
    }
    var nick = event.nickname.trim();
    if (nick.length > 20) {
      return fail("INVALID_INPUT", "昵称最长 20 字");
    }
    // 拒绝控制字符(昵称仅展示用,不做富文本)
    for (var i = 0; i < nick.length; i++) {
      if (nick.charCodeAt(i) < 32) {
        return fail("INVALID_INPUT", "昵称含不可见字符");
      }
    }
    patch.nickname = nick.length > 0 ? nick : "";
  }
  if (event.avatar_file_id !== undefined) {
    if (event.avatar_file_id === null || event.avatar_file_id === "") {
      patch.avatar_file_id = "";
    } else if (
      typeof event.avatar_file_id !== "string" ||
      event.avatar_file_id.length > 300 ||
      event.avatar_file_id.indexOf("cloud://") !== 0
    ) {
      return fail("INVALID_INPUT", "头像地址不合法");
    } else {
      patch.avatar_file_id = event.avatar_file_id;
    }
  }
  if (Object.keys(patch).length === 0) {
    return fail("INVALID_INPUT", "没有要更新的资料");
  }
  await deps.db
    .collection(MEMBERS_COLLECTION)
    .where({ household_id: r.householdId, member_key: deps.memberKey })
    .update({ data: patch });
  return { ok: true, profile: patch };
}

async function statusAction(event, deps) {
  var r = deps.resolved;
  if (!r || r.ok !== true) {
    return householdFail("resolver_missing");
  }
  if (r.shared !== true) {
    return {
      ok: true,
      household_id: r.householdId,
      shared: false,
      role: null,
      scope_revision: null,
      display_name: null,
      self_nickname: null,
      self_avatar_file_id: null
    };
  }
  var own = await fetchAll(deps, MEMBERS_COLLECTION, {
    household_id: r.householdId,
    member_key: deps.memberKey
  });
  var me = own[0] || {};
  return {
    ok: true,
    household_id: r.householdId,
    shared: true,
    role: r.role,
    scope_revision: r.scopeRevision,
    display_name: r.displayName,
    // 本人展示资料(主页头像入口用;仅自己可见自己的这份)
    self_nickname: typeof me.nickname === "string" && me.nickname.length > 0 ? me.nickname : null,
    self_avatar_file_id:
      typeof me.avatar_file_id === "string" && me.avatar_file_id.length > 0 ? me.avatar_file_id : null
  };
}

// ---------------------------------------------------------------------------
// action:create
// ---------------------------------------------------------------------------

/**
 * create:新建空白共享家庭。全新随机 household_id("hh_f_" + 随机 hex,与个人家庭
 * 的 sha256 派生 id 不可混淆),不复制/不迁移任何人的私人数据(F1/决策 1);
 * 创建者成为 owner 成员,active 指针切到共享家庭。
 * 并发收敛:同一用户并发 create 时,active_household 唯一索引 (member_key) 拒绝
 * 第二笔指针插入 → 捕获后清理本次半成品(移除刚建的会员行、空家庭标记 dissolved
 * 软封存,不删除任何数据)→ 明确 ALREADY_IN_FAMILY,绝不留下双家庭。
 */
async function createAction(event, deps) {
  var displayName = cleanDisplayName(event.display_name);
  if (displayName === null) {
    return fail("INVALID_INPUT");
  }
  var memberKey = deps.memberKey;

  // V1 边界:已在任一未解散共享家庭 → 明确拒绝(绝不静默转家/双家庭)
  var memberships = await fetchAll(deps, MEMBERS_COLLECTION, { member_key: memberKey });
  for (var i = 0; i < memberships.length; i++) {
    var household = await getHouseholdDoc(deps, memberships[i].household_id);
    if (!household) {
      // 会员行在、家庭元数据缺:不一致态 → 失败关闭
      return householdFail("household_doc_missing");
    }
    if (household.dissolved !== true) {
      return fail("ALREADY_IN_FAMILY");
    }
    // 已解散(软封存)家庭的会员行是封存记录,不阻碍新建
  }

  // 陈旧指针防御:无有效会员却存在指针 = 不一致态 → 失败关闭(与解析器同口径)
  var activeRows = await fetchAll(deps, ACTIVE_COLLECTION, { member_key: memberKey });
  if (activeRows.length > 1) {
    return householdFail("active_not_unique");
  }
  if (activeRows.length === 1) {
    return householdFail("orphan_active_pointer");
  }

  var now = deps.now();
  var householdId = "hh_f_" + deps.genId();
  await householdsCol(deps).add({
    data: {
      _id: householdId,
      display_name: displayName,
      dissolved: false,
      scope_revision: 1,
      created_at: now
    }
  });
  await membersCol(deps).add({
    data: {
      household_id: householdId,
      member_key: memberKey,
      role: "owner",
      joined_at: now,
      invited_by: null
    }
  });
  try {
    await activeCol(deps).add({
      data: { member_key: memberKey, household_id: householdId, updated_at: now }
    });
  } catch (e) {
    if (!isDuplicateKeyError(e)) {
      throw e;
    }
    // 并发 create 竞态:另一笔先拿到指针 → 收敛为明确拒绝,清理本次半成品。
    // 空家庭标记 dissolved 软封存(无任何数据,软封存不可见不可加入)。
    await rollbackMembership(deps, householdId, memberKey);
    await householdsCol(deps)
      .where({ _id: householdId, dissolved: false })
      .update({ data: { dissolved: true, dissolved_at: now } });
    return fail("ALREADY_IN_FAMILY");
  }
  return {
    ok: true,
    household_id: householdId,
    display_name: displayName,
    role: "owner",
    scope_revision: 1,
    shared: true
  };
}

// ---------------------------------------------------------------------------
// action:inviteCreate / inviteRevoke / inviteList(owner)
// ---------------------------------------------------------------------------

/**
 * inviteCreate(owner):生成邀请令牌。令牌为 genToken() 产出的密码学随机值
 * (≥128bit;index.js 注入 base64url(24 字节)=192bit),服务端只存 sha256(令牌)
 * (token_hash 唯一索引),裸令牌只在本次响应出现一次、绝不落库绝不进日志。
 * 默认 7 天过期、多次使用(家庭场景一次发多人)、可随时撤销。
 */
async function inviteCreateAction(event, deps) {
  var guard = requireOwnerContext(deps);
  if (guard) {
    return guard;
  }
  var householdId = deps.resolved.householdId;
  var token = deps.genToken();
  var tokenHash = deps.sha256(token);
  var now = deps.now();
  var expiresAt = new Date(new Date(now).getTime() + INVITE_TTL_MS).toISOString();
  var inviteId = "inv_" + deps.genId();
  await invitesCol(deps).add({
    data: {
      _id: inviteId,
      household_id: householdId,
      token_hash: tokenHash,
      created_by: deps.memberKey,
      created_at: now,
      expires_at: expiresAt,
      revoked: false
    }
  });
  return { ok: true, invite: { invite_id: inviteId, token: token, expires_at: expiresAt } };
}

/** inviteRevoke(owner):撤销邀请令牌,立即失效;重复撤销幂等收敛 */
async function inviteRevokeAction(event, deps) {
  var guard = requireOwnerContext(deps);
  if (guard) {
    return guard;
  }
  var householdId = deps.resolved.householdId;
  if (!validInviteId(event.invite_id)) {
    return fail("INVALID_INPUT");
  }
  var res = await invitesCol(deps)
    .where({ _id: event.invite_id, household_id: householdId })
    .get();
  var rows = (res && res.data) || [];
  if (rows.length === 0) {
    return fail("NOT_FOUND", "没有这个邀请");
  }
  if (rows[0].revoked === true) {
    return { ok: true, invite_id: event.invite_id, already_revoked: true };
  }
  var updated = await invitesCol(deps)
    .where({ _id: event.invite_id, household_id: householdId, revoked: false })
    .update({ data: { revoked: true, revoked_at: deps.now() } });
  if (updated && updated.stats && updated.stats.updated >= 1) {
    return { ok: true, invite_id: event.invite_id, revoked: true };
  }
  // 条件更新 0 命中:并发已撤销 → 幂等收敛
  return { ok: true, invite_id: event.invite_id, already_revoked: true };
}

/**
 * inviteList(owner):本家庭全部邀请(不含令牌与令牌哈希,只给管理所需的
 * 元数据与有效性标记),created_at 降序。
 */
async function inviteListAction(event, deps) {
  var guard = requireOwnerContext(deps);
  if (guard) {
    return guard;
  }
  var householdId = deps.resolved.householdId;
  var now = deps.now();
  var rows = await fetchAll(deps, INVITES_COLLECTION, { household_id: householdId });
  var invites = rows.map(function (r) {
    return {
      invite_id: r._id,
      created_at: r.created_at,
      expires_at: r.expires_at,
      revoked: r.revoked === true,
      expired: typeof r.expires_at === "string" ? r.expires_at <= now : true
    };
  });
  invites.sort(function (a, b) {
    return a.created_at === b.created_at ? 0 : a.created_at < b.created_at ? 1 : -1;
  });
  return { ok: true, invites: invites };
}

// ---------------------------------------------------------------------------
// action:inviteInfo(持令牌者,加入确认页数据)
// ---------------------------------------------------------------------------

/**
 * inviteInfo:令牌有效性预检(存在/未过期/未撤销/家庭未解散)+ 家庭 display_name。
 * 不暴露任何成员身份 PII、不暴露 household_id;所有失效形态统一 NOT_FOUND
 * (不给持令牌者探测面)。查询异常 → HOUSEHOLD_UNAVAILABLE 失败关闭,
 * 绝不把异常伪装成「邀请不存在」。
 */
async function inviteInfoAction(event, deps) {
  if (!validToken(event.token)) {
    return fail("INVALID_INPUT");
  }
  var res = await invitesCol(deps)
    .where({ token_hash: deps.sha256(event.token) })
    .get();
  var rows = (res && res.data) || [];
  if (rows.length === 0) {
    return fail("NOT_FOUND", "邀请不存在或已失效");
  }
  var invite = rows[0];
  if (invite.revoked === true) {
    return fail("NOT_FOUND", "邀请不存在或已失效");
  }
  if (typeof invite.expires_at !== "string" || invite.expires_at <= deps.now()) {
    return fail("NOT_FOUND", "邀请不存在或已失效");
  }
  var household = await getHouseholdDoc(deps, invite.household_id);
  if (!household || household.dissolved === true) {
    return fail("NOT_FOUND", "邀请不存在或已失效");
  }
  return {
    ok: true,
    display_name: isString(household.display_name) ? household.display_name : DISPLAY_NAME_DEFAULT
  };
}

// ---------------------------------------------------------------------------
// action:join(持令牌者)
// ---------------------------------------------------------------------------

/**
 * join:校验令牌 → 幂等(已是本家庭成员 → 补齐 active 指针直接成功)→
 * 建会员行(role=member)→ scope_revision +1 → active 指针切到该家庭。
 * 一人可属多家庭是数据模型容量,V1 产品边界:已在其他未解散共享家庭 →
 * ALREADY_IN_FAMILY 明确拒绝,绝不静默切换。
 * 写入顺序与半完成恢复(无跨文档事务,全部可重试收敛):
 *   会员行 → 修订号 → 指针 → 终验;
 *   - 校验邀请后家庭被解散:终验发现 → 回滚本次刚写的会员行与指针 → NOT_FOUND;
 *   - 建会员行后、指针前中断:会员行在而指针缺 → 解析回个人家庭(安全方向),
 *     重试 join 走幂等路径补齐指针;
 *   - 指针唯一索引冲突(同用户并发):回读已指向本家庭 → 收敛成功;指向别家 →
 *     回滚会员行 → ALREADY_IN_FAMILY。
 */
async function joinAction(event, deps) {
  if (!validToken(event.token)) {
    return fail("INVALID_INPUT");
  }
  var memberKey = deps.memberKey;
  var inviteRes = await invitesCol(deps)
    .where({ token_hash: deps.sha256(event.token) })
    .get();
  var inviteRows = (inviteRes && inviteRes.data) || [];
  if (inviteRows.length === 0) {
    return fail("NOT_FOUND", "邀请不存在或已失效");
  }
  var invite = inviteRows[0];
  if (invite.revoked === true) {
    return fail("NOT_FOUND", "邀请不存在或已失效");
  }
  if (typeof invite.expires_at !== "string" || invite.expires_at <= deps.now()) {
    return fail("NOT_FOUND", "邀请不存在或已失效");
  }
  var householdId = invite.household_id;
  var household = await getHouseholdDoc(deps, householdId);
  if (!household) {
    // 邀请在、家庭元数据缺:不一致态 → 失败关闭
    return householdFail("household_doc_missing");
  }
  if (household.dissolved === true) {
    return fail("NOT_FOUND", "邀请不存在或已失效");
  }
  var displayName = isString(household.display_name)
    ? household.display_name
    : DISPLAY_NAME_DEFAULT;
  var now = deps.now();

  // 会员状态判定:幂等 / 一家庭边界(已解散家庭的会员行是封存记录,忽略)
  var memberships = await fetchAll(deps, MEMBERS_COLLECTION, { member_key: memberKey });
  for (var i = 0; i < memberships.length; i++) {
    var m = memberships[i];
    var mHousehold = await getHouseholdDoc(deps, m.household_id);
    if (!mHousehold) {
      return householdFail("household_doc_missing");
    }
    if (mHousehold.dissolved === true) {
      continue;
    }
    if (m.household_id === householdId) {
      // 幂等:已是本家庭成员 → 补齐指针后直接成功(重复点确认/中断重试的收敛点)
      var again = await setActivePointer(deps, memberKey, householdId, now);
      if (again.conflict) {
        return householdFail("active_conflict");
      }
      return {
        ok: true,
        joined: false,
        already_member: true,
        household_id: householdId,
        display_name: displayName,
        role: m.role,
        scope_revision: mHousehold.scope_revision
      };
    }
    return fail("ALREADY_IN_FAMILY");
  }

  // 陈旧指针防御:无有效会员却存在指针 = 不一致态 → 失败关闭
  var activeRows = await fetchAll(deps, ACTIVE_COLLECTION, { member_key: memberKey });
  if (activeRows.length > 1) {
    return householdFail("active_not_unique");
  }
  if (activeRows.length === 1) {
    return householdFail("orphan_active_pointer");
  }

  // 建会员行(并发同家庭加入由唯一索引拒绝 → 回查走幂等路径)
  try {
    await membersCol(deps).add({
      data: {
        household_id: householdId,
        member_key: memberKey,
        role: "member",
        joined_at: now,
        invited_by: invite.created_by
      }
    });
  } catch (e) {
    if (!isDuplicateKeyError(e)) {
      throw e;
    }
    var after = await membersCol(deps)
      .where({ household_id: householdId, member_key: memberKey })
      .get();
    if (!after.data || after.data.length === 0) {
      throw e; // 非重复键形态的异常:如实上抛失败关闭
    }
    return {
      ok: true,
      joined: false,
      already_member: true,
      household_id: householdId,
      display_name: displayName,
      role: after.data[0].role,
      scope_revision: household.scope_revision
    };
  }

  // 成员变更事件:scope_revision +1(期间家庭被解散 → 回滚本次会员行)
  var bump = await bumpScopeRevision(deps, householdId);
  if (bump.sealed) {
    await rollbackMembership(deps, householdId, memberKey);
    return fail("NOT_FOUND", "邀请不存在或已失效");
  }

  // active 指针切换到共享家庭
  var pointer = await setActivePointer(deps, memberKey, householdId, now);
  if (pointer.conflict) {
    await rollbackMembership(deps, householdId, memberKey);
    return fail("ALREADY_IN_FAMILY");
  }

  // 终验:防「校验邀请后家庭被解散」竞态落成坏终态(指针指向已解散家庭)
  var finalHousehold = await getHouseholdDoc(deps, householdId);
  if (!finalHousehold || finalHousehold.dissolved === true) {
    await activeCol(deps).where({ member_key: memberKey, household_id: householdId }).remove();
    await rollbackMembership(deps, householdId, memberKey);
    return fail("NOT_FOUND", "邀请不存在或已失效");
  }

  return {
    ok: true,
    joined: true,
    household_id: householdId,
    display_name: displayName,
    role: "member",
    scope_revision: bump.revision
  };
}

// ---------------------------------------------------------------------------
// action:leave
// ---------------------------------------------------------------------------

/**
 * leave:普通成员退出。先撤 active 指针(新请求立即回到个人家庭;先撤指针是
 * 安全方向——中断至多留下「会员行在而指针缺」,解析回个人家庭,重试可收敛),
 * 再删会员行,最后 scope_revision +1。
 * owner 规则:其他成员未全部退出 → OWNER_NOT_LAST;只剩 owner 一人 →
 * OWNER_MUST_DISSOLVE(最后一人只能解散,不产生无人管理的活跃家庭)。
 */
async function leaveAction(event, deps) {
  var r = deps.resolved;
  if (!r || r.ok !== true) {
    return householdFail("resolver_missing");
  }
  if (r.shared !== true) {
    return fail("NOT_FOUND", "你当前不在共享家庭里");
  }
  var householdId = r.householdId;
  var memberKey = deps.memberKey;

  if (r.role === "owner") {
    var members = await fetchAll(deps, MEMBERS_COLLECTION, { household_id: householdId });
    var others = 0;
    for (var i = 0; i < members.length; i++) {
      if (members[i].member_key !== memberKey) {
        others += 1;
      }
    }
    if (others > 0) {
      return fail("OWNER_NOT_LAST");
    }
    return fail("OWNER_MUST_DISSOLVE");
  }

  var now = deps.now();
  await activeCol(deps).where({ member_key: memberKey, household_id: householdId }).remove();
  await membersCol(deps).where({ household_id: householdId, member_key: memberKey }).remove();
  await bumpScopeRevision(deps, householdId); // sealed(并发解散)→ 忽略
  return { ok: true };
}

// ---------------------------------------------------------------------------
// action:removeMember(owner)
// ---------------------------------------------------------------------------

/**
 * removeMember(owner):移除成员。对方数据零触碰,仅解除挂靠:若对方 active
 * 指针指向本家庭则重置回其个人家庭(只删指向本家庭的指针行,绝不误伤),
 * 删会员行,scope_revision +1。不可移除自己;member_key 为 memberList 下发的
 * 服务端派生摘要句柄(不可逆,不构成身份 PII)。
 * 撤权即时性:指针删除后,对方下一次解析即回个人家庭;已通过写入硬门并在途
 * 的旧请求存在不可撤销窗口(无跨文档事务,诚实记录),scope_revision +1 使
 * 其后的旧作用域请求一律 FAMILY_STALE_SCOPE 拒绝。
 */
async function removeMemberAction(event, deps) {
  var guard = requireOwnerContext(deps);
  if (guard) {
    return guard;
  }
  var householdId = deps.resolved.householdId;
  var targetKey = event.member_key;
  if (!validMemberKey(targetKey)) {
    return fail("INVALID_INPUT");
  }
  if (targetKey === deps.memberKey) {
    return fail("INVALID_INPUT", "不能移除自己");
  }
  var res = await membersCol(deps)
    .where({ household_id: householdId, member_key: targetKey })
    .get();
  if (!res.data || res.data.length === 0) {
    return fail("NOT_FOUND", "没有这个成员");
  }
  await activeCol(deps).where({ member_key: targetKey, household_id: householdId }).remove();
  await membersCol(deps).where({ household_id: householdId, member_key: targetKey }).remove();
  await bumpScopeRevision(deps, householdId); // sealed(并发解散)→ 忽略
  return { ok: true };
}

// ---------------------------------------------------------------------------
// action:dissolve(owner,仅当最后一人)
// ---------------------------------------------------------------------------

/**
 * dissolve:解散家庭(软封存)。households.dissolved=true + 全部邀请令牌作废 +
 * owner active 指针切回个人家庭;家庭数据(items/locations)永不删除——封存后
 * 无人可再解析进入,数据原地保留(红线:删除任何数据)。
 * 幂等与自愈:自行读指针而不经 resolved(解析器对「指针指向已解散家庭」失败
 * 关闭,dissolve 必须能在中断后重试补齐清理):已解散 → 补齐撤销邀请与指针
 * 清理后返回 already_dissolved;封存用条件更新(where dissolved:false)防并发
 * 交错。顺序:撤邀请 → 封存 → 撤指针;封存后中断的重试走自愈路径收敛。
 */
async function dissolveAction(event, deps) {
  var memberKey = deps.memberKey;
  var activeRows = await fetchAll(deps, ACTIVE_COLLECTION, { member_key: memberKey });
  if (activeRows.length > 1) {
    return householdFail("active_not_unique");
  }
  if (activeRows.length === 0) {
    return fail("NOT_FOUND", "你当前不在共享家庭里");
  }
  var householdId = activeRows[0].household_id;
  if (!isString(householdId) || householdId.length === 0) {
    return householdFail("active_invalid_pointer");
  }
  var memberRows = await membersCol(deps)
    .where({ household_id: householdId, member_key: memberKey })
    .get();
  if (!memberRows.data || memberRows.data.length === 0) {
    return householdFail("orphan_active_pointer");
  }
  if (memberRows.data[0].role !== "owner") {
    return fail("FORBIDDEN");
  }
  var household = await getHouseholdDoc(deps, householdId);
  if (!household) {
    return householdFail("household_doc_missing");
  }
  var now = deps.now();

  if (household.dissolved === true) {
    // 幂等自愈:上次 dissolve 在封存后中断 → 补齐清理(邀请作废 + 指针回收)
    await revokeAllInvites(deps, householdId, now);
    await activeCol(deps).where({ member_key: memberKey, household_id: householdId }).remove();
    return { ok: true, dissolved: true, already_dissolved: true };
  }
  if (household.dissolved !== false || !Number.isInteger(household.scope_revision)) {
    return householdFail("household_invalid_state");
  }

  // 仅当最后一人:还有其他成员 → 拒绝(先移除或等他们退出)
  var members = await fetchAll(deps, MEMBERS_COLLECTION, { household_id: householdId });
  for (var i = 0; i < members.length; i++) {
    if (members[i].member_key !== memberKey) {
      return fail("OWNER_NOT_LAST");
    }
  }

  await revokeAllInvites(deps, householdId, now);

  // 软封存 + 修订号 +1(dissolve 是成员变更事件);条件更新防并发交错
  var sealed = false;
  for (var attempt = 0; attempt < BUMP_RETRIES; attempt++) {
    var fresh = await getHouseholdDoc(deps, householdId);
    if (!fresh) {
      return householdFail("household_doc_missing");
    }
    if (fresh.dissolved === true) {
      sealed = true;
      break;
    }
    var res = await householdsCol(deps)
      .where({ _id: householdId, dissolved: false, scope_revision: fresh.scope_revision })
      .update({
        data: { dissolved: true, dissolved_at: now, scope_revision: fresh.scope_revision + 1 }
      });
    if (res && res.stats && res.stats.updated >= 1) {
      sealed = true;
      break;
    }
  }
  if (!sealed) {
    return householdFail("dissolve_contention");
  }

  await activeCol(deps).where({ member_key: memberKey, household_id: householdId }).remove();
  return { ok: true, dissolved: true };
}

// ---------------------------------------------------------------------------
// action:switch(十七轮切换家庭)
// ---------------------------------------------------------------------------

/**
 * 个人家庭 household_id 从 member_key 派生(与 lib/household.js
 * personalHouseholdId 同款存量算法:"hh_" + sha256(openid) 前 32 位;
 * memberKey 即 sha256(openid) 全文,故等价于 "hh_" + memberKey 前 32 位)。
 */
function personalHouseholdIdOf(memberKey) {
  return "hh_" + memberKey.slice(0, 32);
}

/**
 * 指针单行原子切换(读 → 条件更新 → 复核收敛):
 * - 无行 → 插入(唯一索引冲突 = 并发切换,回读复核下一轮判定);
 * - 已指向目标 → 幂等(already:true);
 * - 指向别处 → where 旧值条件更新(0 命中 = 并发已改,重读复核重试)。
 * active_household 唯一索引 (member_key) 保证任一时刻指针唯一(active 指针唯一,
 * #34 合同不弱化——switch 只更新这行指针,不另起炉灶、不迁移任何家庭数据)。
 */
async function switchActivePointer(deps, memberKey, householdId, now) {
  for (var attempt = 0; attempt < BUMP_RETRIES; attempt++) {
    var rows = await fetchAll(deps, ACTIVE_COLLECTION, { member_key: memberKey });
    if (rows.length > 1) {
      return { failed: true, result: householdFail("active_not_unique") };
    }
    if (rows.length === 0) {
      try {
        await activeCol(deps).add({
          data: { member_key: memberKey, household_id: householdId, updated_at: now }
        });
        return { already: false };
      } catch (e) {
        if (!isDuplicateKeyError(e)) {
          throw e;
        }
        continue; // 并发插入:回读复核(下一轮按指向判定)
      }
    }
    if (rows[0].household_id === householdId) {
      return { already: true };
    }
    var res = await activeCol(deps)
      .where({ member_key: memberKey, household_id: rows[0].household_id })
      .update({ data: { household_id: householdId, updated_at: now } });
    if (res && res.stats && res.stats.updated >= 1) {
      return { already: false };
    }
    // 0 命中:并发交错已改指针 → 重读复核
  }
  return { failed: true, result: householdFail("switch_contention") };
}

/**
 * switch:切换当前家庭(issue #45 十七轮 B 线;#34 合同不弱化——只更新 active
 * 指针 + 客户端作用域刷新,不另起流程、不迁移数据、不递增 scope_revision)。
 * - target:"personal":永远可回;删除本成员的 active 指针行,之后一切解析
 *   确定性回个人家庭(无行 = 已在个人家庭,幂等成功);
 * - target:"shared":必须在册(存在未解散共享家庭的会员行)且未解散;无在册
 *   家庭(被移除/已退出/从未加入)→ NOT_FOUND;会员行在而家庭元数据缺/字段
 *   非法 → 失败关闭;多个未解散在册家庭(数据模型容量外的异常态)→ 失败关闭;
 * - 返回新家庭 status 摘要(household_id/shared/role/scope_revision/display_name,
 *   与 status action 同口径),客户端据此整页刷新作用域数据。
 */
async function switchAction(event, deps) {
  if (event.target !== "personal" && event.target !== "shared") {
    return fail("INVALID_INPUT", "target 只能是 personal 或 shared");
  }
  var memberKey = deps.memberKey;

  if (event.target === "personal") {
    var rows = await fetchAll(deps, ACTIVE_COLLECTION, { member_key: memberKey });
    if (rows.length > 1) {
      return householdFail("active_not_unique");
    }
    var alreadyPersonal = rows.length === 0;
    if (rows.length === 1) {
      await activeCol(deps).where({ member_key: memberKey }).remove();
    }
    return {
      ok: true,
      target: "personal",
      already: alreadyPersonal,
      household_id: personalHouseholdIdOf(memberKey),
      shared: false,
      role: null,
      scope_revision: null,
      display_name: null
    };
  }

  // target === "shared":校验在册且未解散的共享家庭
  var memberships = await fetchAll(deps, MEMBERS_COLLECTION, { member_key: memberKey });
  var candidates = [];
  for (var i = 0; i < memberships.length; i++) {
    var hh = await getHouseholdDoc(deps, memberships[i].household_id);
    if (!hh) {
      // 会员行在、家庭元数据缺:不一致态 → 失败关闭(绝不当作可切换或不可切换猜)
      return householdFail("household_doc_missing");
    }
    if (hh.dissolved === true) {
      continue; // 已解散(软封存)的会员行是封存记录,不可切换进入
    }
    if (hh.dissolved !== false || !Number.isInteger(hh.scope_revision)) {
      return householdFail("household_invalid_state");
    }
    candidates.push({ membership: memberships[i], household: hh });
  }
  if (candidates.length === 0) {
    return fail("NOT_FOUND", "你还没有加入共享家庭");
  }
  if (candidates.length > 1) {
    // V1 产品边界是一人一个未解散共享家庭;多行属数据模型容量外的异常态 → 失败关闭
    return householdFail("multiple_memberships");
  }
  var entry = candidates[0];
  var householdId = entry.membership.household_id;
  var switched = await switchActivePointer(deps, memberKey, householdId, deps.now());
  if (switched.failed) {
    return switched.result;
  }
  return {
    ok: true,
    target: "shared",
    already: switched.already,
    household_id: householdId,
    shared: true,
    role: entry.membership.role,
    scope_revision: entry.household.scope_revision,
    display_name: isString(entry.household.display_name)
      ? entry.household.display_name
      : DISPLAY_NAME_DEFAULT
  };
}

// ---------------------------------------------------------------------------
// action:memberList(owner)
// ---------------------------------------------------------------------------

/**
 * memberList(owner):成员清单。member_key 是服务端从可信 OPENID 派生的摘要句柄
 * (removeMember 寻址用,不可逆、不构成身份 PII);系统不存昵称/头像等 PII。
 * owner 在前,其余按加入时间升序。
 */
async function memberListAction(event, deps) {
  // 全体成员可读(真机反馈:加入后连家人有谁都看不到;家庭成员互见是基本感知;
  // 管理动作 invite/remove/dissolve 仍 owner 独有)。resolver 已保证调用者是
  // 本家庭的活跃成员,无需再验 owner。
  var householdId = deps.resolved.householdId;
  var rows = await fetchAll(deps, MEMBERS_COLLECTION, { household_id: householdId });
  var members = rows.map(function (r) {
    return {
      member_key: r.member_key,
      role: r.role,
      joined_at: r.joined_at,
      invited_by: r.invited_by === undefined ? null : r.invited_by,
      // 展示资料(用户经「头像昵称填写能力」自设;仅家庭成员互见,绝不进日志)
      nickname: typeof r.nickname === "string" && r.nickname.length > 0 ? r.nickname : null,
      avatar_file_id: typeof r.avatar_file_id === "string" && r.avatar_file_id.length > 0 ? r.avatar_file_id : null,
      is_self: r.member_key === deps.memberKey
    };
  });
  members.sort(function (a, b) {
    if (a.role !== b.role) {
      return a.role === "owner" ? -1 : 1;
    }
    return a.joined_at === b.joined_at ? 0 : a.joined_at < b.joined_at ? -1 : 1;
  });
  return { ok: true, members: members };
}

// ---------------------------------------------------------------------------
// 路由与日志
// ---------------------------------------------------------------------------

var ACTIONS = {
  create: createAction,
  inviteCreate: inviteCreateAction,
  inviteRevoke: inviteRevokeAction,
  inviteList: inviteListAction,
  inviteInfo: inviteInfoAction,
  join: joinAction,
  leave: leaveAction,
  removeMember: removeMemberAction,
  dissolve: dissolveAction,
  memberList: memberListAction,
  status: statusAction,
  updateProfile: updateProfileAction,
  switch: switchAction
};

/**
 * 日志只输出 action、错误码、耗时、计数;绝不输出 openid/member_key、
 * 裸令牌/令牌哈希、家庭名、household_id(itemsApi 同款纪律)。
 */
function logResult(deps, action, result, startedAt) {
  if (!deps || !deps.logger || typeof deps.logger.log !== "function") {
    return;
  }
  var entry = {
    action: isString(action) ? action : null,
    error: result && result.ok === false ? result.error : null,
    ms: Date.now() - startedAt
  };
  entry.count = result && result.ok ? 1 : 0;
  try {
    deps.logger.log(entry);
  } catch (e) {
    // 日志失败绝不影响业务结果
  }
}

/**
 * 纯函数入口:handler(event, deps)。
 * 返回 { ok:true, ... } 或 { ok:false, error, message(中文) };
 * 元数据查询/写入异常 → HOUSEHOLD_UNAVAILABLE 明确错误终止(失败关闭,
 * 绝不回退、绝不静默;部分写入按各 action 的幂等重试收敛设计恢复)。
 */
async function handler(event, deps) {
  var startedAt = Date.now();
  var action = event && event.action;
  var result;
  try {
    if (!deps || !deps.memberKey) {
      result = fail("UNAUTHORIZED");
    } else if (!isString(action) || !ACTIONS[action]) {
      result = fail("INVALID_INPUT");
    } else {
      result = await ACTIONS[action](event, deps);
    }
  } catch (err) {
    // 失败关闭:元数据集合查询/写入异常(含未创建/索引故障)不伪装成业务
    // 错误,统一 HOUSEHOLD_UNAVAILABLE 明确终止;日志只记错误码,不落异常详情
    result = householdFail("metadata_query_failed");
  }
  logResult(deps, action, result, startedAt);
  return result;
}

module.exports = {
  handler: handler,
  ERROR_MESSAGES: ERROR_MESSAGES
};
