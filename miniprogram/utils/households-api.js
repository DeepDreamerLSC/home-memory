"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidateScopeVerification = void 0;
exports.fetchHouseholdStatus = fetchHouseholdStatus;
exports.verifyHouseholdScope = verifyHouseholdScope;
exports.ensureScopeVerified = ensureScopeVerified;
exports.isScopeVerifiedForDisplay = isScopeVerifiedForDisplay;
exports.notifyFamilyScopeDrift = notifyFamilyScopeDrift;
exports.createFamily = createFamily;
exports.joinFamily = joinFamily;
exports.leaveFamily = leaveFamily;
exports.dissolveFamily = dissolveFamily;
exports.createInvite = createInvite;
exports.revokeInvite = revokeInvite;
exports.fetchInviteList = fetchInviteList;
exports.fetchInviteInfo = fetchInviteInfo;
exports.updateHouseholdProfile = updateHouseholdProfile;
exports.fetchMemberList = fetchMemberList;
exports.removeFamilyMember = removeFamilyMember;
/**
 * households 云函数调用封装(issue #34 P1-B,类型化):
 * - 统一 wx.cloud.callFunction 调用与超时控制(照 utils/api.ts 口径);
 * - 服务端错误码映射为可直接展示的中文文案(服务端 message 缺失时兜底);
 * - 对 ok:true 响应做最小结构校验,结构不符按异常响应处理(如实提示);
 * - 作用域编排:status/create/join 响应经 captureHouseholdScope 捕获服务端
 *   权威作用域(id/shared/scope_revision);作用域 id 变化时显式
 *   clearLocationsCache()——把家庭切换接入 locations-cache 既有失效代数
 *   (冻结合同 F2:既有 requestSeq/invalidationGeneration 不随家庭切换自动
 *   失效,必须显式接入切换 epoch);leave/removeMember/dissolve 的响应不含
 *   新家庭 id,统一追加一次 status 捕获个人家庭作用域;
 * - 资格复核(硬门 C):verifyHouseholdScope 比对「服务端 active 家庭 == 本地
 *   存储作用域」;不一致(被移除/家庭解散/异地切换)即捕获新作用域 + 清缓存,
 *   经 onDrift 回调如实提示,绝不展示旧缓存;
 * - F2 漂移处置:notifyFamilyScopeDrift 供 api/locations-api 在
 *   FAMILY_SWITCHED / FAMILY_STALE_SCOPE 时触发「拉 status 刷新作用域」,
 *   绝不静默重试原写请求(用户看到服务端如实文案后自行重试)。
 *
 * 本模块不读取、不传输任何身份字段;household_id/openid 一律由服务端派生,
 * event 里的身份字段一律忽略不读。
 */
const api_1 = require("./api");
const locations_cache_1 = require("./locations-cache");
const household_scope_1 = require("./household-scope");
const HOUSEHOLDS_FUNCTION = "households";
/** households 全部为轻量元数据操作,数秒内返回 */
const HOUSEHOLDS_TIMEOUT_MS = 15000;
/** 服务端错误码 → 默认中文文案(服务端 message 缺失时兜底;与服务端 ERROR_MESSAGES 同口径) */
const HOUSEHOLDS_MESSAGES = {
    INVALID_INPUT: "输入不合法,请检查后重试",
    UNAUTHORIZED: "请先登录",
    NOT_FOUND: "邀请或家庭成员不存在,或已失效",
    FORBIDDEN: "只有家庭创建者才能执行这个操作",
    ALREADY_IN_FAMILY: "你已在一个共享家庭里,退出或解散后才能再加入或新建",
    OWNER_NOT_LAST: "还有其他成员在家庭里,先移除他们或等他们退出,才能退出或解散",
    OWNER_MUST_DISSOLVE: "家庭里只剩你一个人,不能退出,只能解散家庭",
    HOUSEHOLD_UNAVAILABLE: "暂时无法确认当前家庭,请稍后重试",
};
const BAD_RESPONSE_MESSAGE = "服务返回异常,请稍后重试";
const DEFAULT_ERROR_MESSAGE = "服务暂时不可用,请稍后重试";
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** 把服务端 ok:false 体转换为 ApiError;优先使用服务端中文 message */
function toHouseholdsServerError(code, message) {
    const codeText = typeof code === "string" && code.length > 0 ? code : api_1.CLIENT_BAD_RESPONSE;
    const fallback = HOUSEHOLDS_MESSAGES[codeText];
    const serverMessage = typeof message === "string" && message.trim().length > 0 ? message : "";
    return new api_1.ApiError(codeText, serverMessage || fallback || DEFAULT_ERROR_MESSAGE);
}
function callCloudFunction(name, data, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (!wx.cloud) {
            reject(new api_1.ApiError(api_1.CLIENT_NETWORK, "当前微信版本过低,无法使用云能力,请升级微信后重试"));
            return;
        }
        let done = false;
        const timer = setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            reject(new api_1.ApiError(api_1.CLIENT_TIMEOUT, "请求超时,请检查网络后重试"));
        }, timeoutMs);
        wx.cloud.callFunction({
            name,
            data: data,
            success: (res) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                resolve(res.result);
            },
            fail: (err) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                console.error("[households-api] 云函数调用失败:", name, err && err.errMsg);
                reject(new api_1.ApiError(api_1.CLIENT_NETWORK, "网络异常,请稍后重试"));
            },
        });
    });
}
/** 捕获服务端权威作用域;id 变化(切换/漂移)时显式清空位置树缓存(接入失效代数) */
function captureAndInvalidate(householdId, shared, scopeRevision, displayName) {
    const changed = (0, household_scope_1.captureHouseholdScope)(householdId, shared, scopeRevision);
    if (changed) {
        (0, locations_cache_1.clearLocationsCache)();
        if (displayName === undefined) {
            (0, household_scope_1.captureHouseholdScopeName)(null); // 换家未携带新名:清空,不跟旧名
        }
    }
    if (displayName !== undefined) {
        (0, household_scope_1.captureHouseholdScopeName)(displayName);
    }
}
/**
 * households 调用统一入口:结构校验 + 错误映射。
 * ok:false → ApiError(message 为服务端中文文案);结构异常 → CLIENT_BAD_RESPONSE。
 */
async function callHouseholds(event) {
    const result = await callCloudFunction(HOUSEHOLDS_FUNCTION, event, HOUSEHOLDS_TIMEOUT_MS);
    if (!isRecord(result)) {
        throw new api_1.ApiError(api_1.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    if (result.ok === false) {
        throw toHouseholdsServerError(result.error, result.message);
    }
    if (result.ok !== true) {
        throw new api_1.ApiError(api_1.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    return result;
}
/* ---------------- status 与资格复核(硬门 C) ---------------- */
/** status 响应的最小结构校(个人态 role/revision/display_name 为 null) */
function parseStatus(r) {
    const bad = () => new api_1.ApiError(api_1.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    if (typeof r.household_id !== "string" || typeof r.shared !== "boolean") {
        throw bad();
    }
    const role = r.role === "owner" || r.role === "member"
        ? r.role
        : r.role === null || r.role === undefined
            ? null
            : undefined;
    if (role === undefined) {
        throw bad();
    }
    if (r.shared === true) {
        if (typeof r.scope_revision !== "number" ||
            !Number.isInteger(r.scope_revision) ||
            r.scope_revision < 1) {
            throw bad();
        }
    }
    else if (r.scope_revision !== null && r.scope_revision !== undefined) {
        throw bad();
    }
    return {
        ok: true,
        household_id: r.household_id,
        shared: r.shared,
        role,
        scope_revision: typeof r.scope_revision === "number" ? r.scope_revision : null,
        display_name: typeof r.display_name === "string" ? r.display_name : null,
    };
}
/**
 * 拉取 households.status 并捕获服务端权威作用域(不静默吞错)。
 * 个人态同样捕获(个人家庭 id 回写本地作用域记忆,离开共享家庭后键切回个人键)。
 */
async function fetchHouseholdStatus() {
    const r = await callHouseholds({ action: "status" });
    const status = parseStatus(r);
    captureAndInvalidate(status.household_id, status.shared, status.scope_revision, status.display_name === undefined ? null : status.display_name);
    return status;
}
/** 前台切回时重置验证状态后再复核(app.onShow 用;复用 household-scope 同名函数) */
var household_scope_2 = require("./household-scope");
Object.defineProperty(exports, "invalidateScopeVerification", { enumerable: true, get: function () { return household_scope_2.invalidateScopeVerification; } });
let pendingVerify = null;
/**
 * 展示前资格复核(硬门 C1):拉 status 捕获服务端权威作用域,比对本地记忆;
 * 不一致(被移除/家庭解散/异地切换)时捕获新作用域 + 清缓存,并经 onDrift
 * 如实提示。并发调用共享同一笔请求(dedup)。已验证时直接补一次轻量复核
 * 仍然执行——调用方(启动/前台恢复/家庭操作后)语义都是「此刻要新事实」。
 */
async function verifyHouseholdScope(onDrift) {
    const fromId = (0, household_scope_1.householdScopeId)();
    const fromShared = (0, household_scope_1.isHouseholdScopeShared)();
    if (pendingVerify !== null) {
        return pendingVerify;
    }
    const run = (async () => {
        try {
            const status = await fetchHouseholdStatus();
            if (onDrift !== undefined &&
                status.household_id !== fromId) {
                onDrift({
                    fromId,
                    toId: status.household_id,
                    fromShared,
                    toShared: status.shared,
                });
            }
            return status;
        }
        finally {
            pendingVerify = null;
        }
    })();
    pendingVerify = run;
    return run;
}
/** best-effort 资格复核(app 启动/前台恢复、页面 banner 前置):绝不抛错 */
async function ensureScopeVerified() {
    try {
        return await verifyHouseholdScope();
    }
    catch (e) {
        // 网络失败等:保持未验证态(缓存不展示,直连服务端如实报错),绝不伪装已验证
        return null;
    }
}
/** 当前作用域是否已有服务端响应背书(未验证期间不得展示持久化家庭缓存) */
function isScopeVerifiedForDisplay() {
    return (0, household_scope_1.isScopeVerified)();
}
/**
 * F2 漂移处置(api/locations-api 在 FAMILY_SWITCHED/FAMILY_STALE_SCOPE 时调用):
 * 拉 status 刷新本地作用域(捕获新 id/修订号),绝不自动重试原写请求——
 * 服务端文案已如实提示「家庭状态刚变化,请确认后重试」,由用户重试。
 */
function notifyFamilyScopeDrift(e) {
    if (!(e instanceof api_1.ApiError)) {
        return false;
    }
    if (e.code !== "FAMILY_SWITCHED" && e.code !== "FAMILY_STALE_SCOPE") {
        return false;
    }
    void fetchHouseholdStatus().catch(() => {
        // 刷新失败:保持现状(下次写请求仍会被服务端硬门拒绝并如实提示)
    });
    return true;
}
/* ---------------- 生命周期 action ---------------- */
/** create:新建空白共享家庭。成功后捕获共享作用域(id+修订号)并清位置树缓存。 */
async function createFamily(displayName) {
    const event = displayName !== undefined && displayName.length > 0
        ? { action: "create", display_name: displayName }
        : { action: "create" };
    const r = await callHouseholds(event);
    if (typeof r.household_id !== "string" ||
        r.shared !== true ||
        typeof r.scope_revision !== "number" ||
        typeof r.display_name !== "string") {
        throw new api_1.ApiError(api_1.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    captureAndInvalidate(r.household_id, true, r.scope_revision, r.display_name === undefined ? null : r.display_name);
    return {
        ok: true,
        household_id: r.household_id,
        display_name: r.display_name,
        role: "owner",
        scope_revision: r.scope_revision,
        shared: true,
    };
}
/** join(持令牌者):成功(含幂等 already_member)后捕获共享作用域并清缓存。 */
async function joinFamily(token) {
    const r = await callHouseholds({ action: "join", token });
    if (typeof r.household_id !== "string" ||
        typeof r.display_name !== "string" ||
        (r.role !== "owner" && r.role !== "member") ||
        typeof r.scope_revision !== "number") {
        throw new api_1.ApiError(api_1.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    captureAndInvalidate(r.household_id, true, r.scope_revision, r.display_name === undefined ? null : r.display_name);
    return {
        ok: true,
        joined: r.joined === true,
        already_member: r.already_member === true,
        household_id: r.household_id,
        display_name: r.display_name,
        role: r.role,
        scope_revision: r.scope_revision,
    };
}
/**
 * leave:普通成员退出。成功后(F3:主动退出 → V1 优先清理)在作用域切回个人
 * 前先清掉共享域的位置树缓存(此刻存储键仍是共享家庭键),再追加 status 捕获
 * 个人作用域(捕获切换即再清一次,幂等);status 刷新失败不改变「已退出」事实,
 * 旧作用域 marker 的写请求会被服务端硬门拒绝并触发漂移刷新,绝不误写。
 */
async function leaveFamily() {
    await callHouseholds({ action: "leave" });
    (0, locations_cache_1.clearLocationsCache)();
    try {
        await fetchHouseholdStatus();
    }
    catch (e) {
        // leave 已成功;刷新失败由服务端硬门 + 漂移刷新兜底
    }
}
/** dissolve(owner,仅当最后一人):解散后同样先清共享域缓存,再捕获个人作用域。 */
async function dissolveFamily() {
    await callHouseholds({ action: "dissolve" });
    (0, locations_cache_1.clearLocationsCache)();
    try {
        await fetchHouseholdStatus();
    }
    catch (e) {
        // dissolve 已成功;刷新失败由服务端硬门 + 漂移刷新兜底
    }
}
/* ---------------- 邀请与成员(owner 独管/持令牌者) ---------------- */
/** inviteCreate(owner):裸令牌只在本次响应出现一次,由页面立即用于分享卡片,不持久化。 */
async function createInvite() {
    const r = await callHouseholds({ action: "inviteCreate" });
    const invite = r.invite;
    if (!isRecord(invite) ||
        typeof invite.invite_id !== "string" ||
        typeof invite.token !== "string" ||
        typeof invite.expires_at !== "string") {
        throw new api_1.ApiError(api_1.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    return {
        invite_id: invite.invite_id,
        token: invite.token,
        expires_at: invite.expires_at,
    };
}
/** inviteRevoke(owner):撤销邀请令牌,立即失效。 */
async function revokeInvite(inviteId) {
    await callHouseholds({ action: "inviteRevoke", invite_id: inviteId });
}
/** inviteList(owner):全部邀请元数据(不含令牌)。 */
async function fetchInviteList() {
    const r = await callHouseholds({ action: "inviteList" });
    const raw = r.invites;
    if (!Array.isArray(raw)) {
        throw new api_1.ApiError(api_1.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    return raw
        .filter((v) => isRecord(v) &&
        typeof v.invite_id === "string" &&
        typeof v.created_at === "string" &&
        typeof v.expires_at === "string" &&
        typeof v.revoked === "boolean" &&
        typeof v.expired === "boolean")
        .map((v) => ({
        invite_id: v.invite_id,
        created_at: v.created_at,
        expires_at: v.expires_at,
        revoked: v.revoked,
        expired: v.expired,
    }));
}
/** inviteInfo(持令牌者):令牌预检,只返回家庭名(不暴露成员 PII/household_id)。 */
async function fetchInviteInfo(token) {
    const r = await callHouseholds({ action: "inviteInfo", token });
    if (typeof r.display_name !== "string") {
        throw new api_1.ApiError(api_1.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    return { ok: true, display_name: r.display_name };
}
/** memberList(owner):成员清单(owner 在前、按加入时间升序)。 */
/** 设置本人在本家庭的展示资料(头像昵称填写能力;只写自己的会员行) */
async function updateHouseholdProfile(profile) {
    const event = { action: "updateProfile", ...profile };
    const r = await callHouseholds(event);
    if (r.ok !== true || typeof r.profile !== "object" || r.profile === null) {
        throw new api_1.ApiError(api_1.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    return { ok: true, profile: r.profile };
}
async function fetchMemberList() {
    const r = await callHouseholds({ action: "memberList" });
    const raw = r.members;
    if (!Array.isArray(raw)) {
        throw new api_1.ApiError(api_1.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    const members = raw
        .filter((v) => isRecord(v) &&
        typeof v.member_key === "string" &&
        (v.role === "owner" || v.role === "member") &&
        typeof v.joined_at === "string")
        .map((v) => ({
        member_key: v.member_key,
        role: v.role,
        joined_at: v.joined_at,
        invited_by: typeof v.invited_by === "string" ? v.invited_by : null,
        is_self: v.is_self === true,
        nickname: typeof v.nickname === "string" && v.nickname.length > 0 ? v.nickname : null,
        avatar_file_id: typeof v.avatar_file_id === "string" && v.avatar_file_id.length > 0 ? v.avatar_file_id : null,
    }));
    return { ok: true, members };
}
/** removeMember(owner):移除成员(对方数据零触碰,仅解除挂靠)。 */
async function removeFamilyMember(memberKey) {
    await callHouseholds({ action: "removeMember", member_key: memberKey });
}
