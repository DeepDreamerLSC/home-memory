"use strict";
/**
 * 家庭作用域(issue #34 P0 + P1-B,F3/硬门 B/C 基础):
 * - 作用域上下文的唯一来源是服务端响应(itemsApi.list 与 locations.list 携带
 *   household_id,共享家庭另携 scope_revision;households.status/create/join
 *   携带完整 household_id/shared/scope_revision)。服务端权威,客户端捕获的值
 *   只用于本地键隔离与写请求一致性绑定(expected_*),不具任何授权效力;
 * - 捕获后存内存并 best-effort 持久化(storage 记忆):冷启动先还原作用域再读
 *   位置缓存/未完成草稿,保证按正确家庭的键命中(24h 缓存语义不因重启失效);
 * - 捕获不到(旧云函数响应无该字段/单人阶段)时 householdScopeId() 返回稳定
 *   回退值 "default"、householdScopeSuffix() 返回空串——locations-cache 与
 *   draft-session 的存储键与单人现状逐字节一致,零回归;
 * - locations-cache 的存储键、draft-session 的会话/持久化键、首页未完成批次
 *   检查统一拼接 ":hh-<household_id>" 后缀:切换家庭后键天然不同,旧家庭的
 *   缓存/草稿互不可达(F3/产品决策 3:草稿原地保留、回切恢复、绝不自动迁移);
 * - 作用域代数(scopeGeneration,issue #34 P1-B 硬门 C/F2):作用域 id 变化
 *   (创建/加入/退出/被移除/解散,或服务端 list 响应揭示的漂移)时递增。
 *   调用方(页面)在发请求前捕获、响应后校验,家庭切换后在途旧响应不上屏;
 *   locations-cache 的失效代数由 API 层在「捕获变化」时显式 clearLocationsCache()
 *   接入(合同:既有 requestSeq/invalidationGeneration 不随家庭切换自动失效,
 *   必须显式接入切换 epoch);
 * - 展示前资格复核(硬门 C1):isScopeVerified() 只在「服务端响应捕获」后为
 *   true——storage 还原的作用域记忆不算已验证。未验证期间不得把持久化缓存/
 *   旧家庭最近物品当作当前可访问内容展示;前台切回(app onShow)先
 *   invalidateScopeVerification() 再经 households.status 重新验证;
 * - 写请求一致性绑定(P1-B,F2 客户端半边):scopeWriteMarkers() 供
 *   callItemsApi/callLocationsApi 的写类 action 拼装 expected_household_id
 *   (个人/共享都带,服务端携带则校验,挡 A→B 漂移)与 expected_scope_revision
 *   (共享态必带,挡成员变更后的旧请求误写与 ABA 重放);绑定值缺失时不编造,
 *   由服务端硬门拒绝(FAMILY_SWITCHED/FAMILY_STALE_SCOPE)后走「提示 + 拉
 *   status 刷新 + 用户重试」,绝不静默重试;
 * - storage 一律 best-effort:读写失败不抛出、不影响业务语义(与 locations-cache
 *   同款口径)。测试可注入存储(无 wx 时仅内存记忆)。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_HOUSEHOLD_SCOPE_ID = void 0;
exports.captureHouseholdId = captureHouseholdId;
exports.captureHouseholdScope = captureHouseholdScope;
exports.captureHouseholdScopeName = captureHouseholdScopeName;
exports.householdScopeName = householdScopeName;
exports.captureHouseholdSelfProfile = captureHouseholdSelfProfile;
exports.householdSelfProfile = householdSelfProfile;
exports.householdScopeId = householdScopeId;
exports.isHouseholdScopeCaptured = isHouseholdScopeCaptured;
exports.isHouseholdScopeShared = isHouseholdScopeShared;
exports.householdScopeSuffix = householdScopeSuffix;
exports.scopeWriteMarkers = scopeWriteMarkers;
exports.captureScopeGeneration = captureScopeGeneration;
exports.isScopeGenerationCurrent = isScopeGenerationCurrent;
exports.isScopeVerified = isScopeVerified;
exports.invalidateScopeVerification = invalidateScopeVerification;
exports.__setHouseholdScopeStorageForTest = __setHouseholdScopeStorageForTest;
exports.__resetHouseholdScopeForTest = __resetHouseholdScopeForTest;
const SCOPE_STORAGE_KEY = "home-memory:household-scope";
/** 稳定回退值:单人阶段(未捕获到服务端 household_id)的作用域标识 */
exports.DEFAULT_HOUSEHOLD_SCOPE_ID = "default";
/** household_id 合法长度上限(个人家庭 id 恒 35 字符,上限只拦异常值) */
const HOUSEHOLD_ID_MAX_LENGTH = 128;
/**
 * 共享家庭 id 前缀(服务端合同:"hh_f_" + 随机 hex,与个人家庭
 * "hh_" + 32 位 hex 的存量算法不可混淆——个人 id 只有一个下划线,
 * 不会有 "hh_f_" 前缀)。storage 还原的旧版纯字符串记忆用它判定共享性。
 */
const SHARED_ID_PREFIX = "hh_f_";
/** 测试注入的存储(undefined = 未注入);优先级最高 */
let testStorage;
/** 已捕获的家庭作用域(null = 未捕获,单人阶段) */
let captured = null;
/** 是否已从持久层做过首次还原 */
let loaded = false;
/**
 * 作用域代数(id 变化即递增):家庭切换后在途旧响应不上屏(硬门 C/F2)。
 * 与 locations-cache 的失效代数相互独立,后者由 API 层显式 clearLocationsCache 接入。
 */
let scopeGeneration = 0;
/**
 * 展示前资格复核(硬门 C1):仅服务端响应捕获后为 true;storage 还原不算。
 * 前台切回时由 app 重置,经 households.status 重新验证。
 */
let verified = false;
function activeStorage() {
    if (testStorage !== undefined) {
        return testStorage;
    }
    if (typeof wx !== "undefined" &&
        typeof wx.getStorageSync === "function" &&
        typeof wx.setStorageSync === "function" &&
        typeof wx.removeStorageSync === "function") {
        return wx;
    }
    return null;
}
function isSharedIdShape(id) {
    return id.indexOf(SHARED_ID_PREFIX) === 0;
}
/** 旧版纯字符串记忆兼容:只有 id,共享性按合同前缀推断、修订号未知 */
function fromLegacyString(id) {
    return { id, shared: isSharedIdShape(id), revision: null };
}
/** 首次访问时从持久层还原(逐调用解析存储,理由同 locations-cache:测试 stub 时机) */
function ensureLoaded() {
    if (loaded) {
        return;
    }
    loaded = true;
    const storage = activeStorage();
    if (storage === null) {
        return;
    }
    try {
        const raw = storage.getStorageSync(SCOPE_STORAGE_KEY);
        if (typeof raw === "string" && raw.length > 0) {
            // P0 记忆格式:纯 household_id 字符串
            const trimmed = raw.trim();
            if (trimmed.length > 0 &&
                trimmed.length <= HOUSEHOLD_ID_MAX_LENGTH &&
                trimmed !== exports.DEFAULT_HOUSEHOLD_SCOPE_ID) {
                captured = fromLegacyString(trimmed);
            }
            return;
        }
        if (typeof raw === "object" &&
            raw !== null &&
            !Array.isArray(raw) &&
            typeof raw.id === "string" &&
            typeof raw.shared === "boolean") {
            const payload = raw;
            const trimmed = payload.id.trim();
            if (trimmed.length > 0 &&
                trimmed.length <= HOUSEHOLD_ID_MAX_LENGTH &&
                trimmed !== exports.DEFAULT_HOUSEHOLD_SCOPE_ID) {
                captured = {
                    id: trimmed,
                    shared: payload.shared,
                    revision: typeof payload.revision === "number" &&
                        Number.isInteger(payload.revision) &&
                        payload.revision >= 1
                        ? payload.revision
                        : null,
                };
            }
        }
    }
    catch (e) {
        // best-effort:读失败按未捕获处理(键后缀为空,行为回到单人现状)
    }
}
function persist(scope) {
    const storage = activeStorage();
    if (storage === null) {
        return; // 无持久层:仅内存记忆,进程回收后回到回退值(如实降级)
    }
    try {
        const payload = {
            id: scope.id,
            shared: scope.shared,
            revision: scope.revision,
        };
        storage.setStorageSync(SCOPE_STORAGE_KEY, payload);
    }
    catch (e) {
        // best-effort:持久化失败不影响本会话作用域
    }
}
/** household_id 合法性(非空、限长、"default" 保留字不可用) */
function isUsableHouseholdId(v) {
    const trimmed = v.trim();
    return (trimmed.length > 0 &&
        trimmed.length <= HOUSEHOLD_ID_MAX_LENGTH &&
        trimmed !== exports.DEFAULT_HOUSEHOLD_SCOPE_ID);
}
function isUsableRevision(v) {
    return typeof v === "number" && Number.isInteger(v) && v >= 1;
}
/**
 * 捕获落地共用:更新内存 + best-effort 持久化 + 标记已验证。
 * 作用域 id 变化(家庭切换/漂移)时递增作用域代数并返回 true,调用方
 * (API 层)据此显式 clearLocationsCache() 接入既有失效代数;id 不变仅
 * 刷新修订号时不递增(同一家庭的成员变更不是切换)。
 */
function applyCapture(id, shared, revision) {
    ensureLoaded();
    const changed = captured === null || captured.id !== id;
    if (!changed &&
        captured !== null &&
        captured.shared === shared &&
        captured.revision === revision) {
        verified = true;
        return false; // 完全相同:幂等,不动代数
    }
    captured = { id, shared, revision };
    persist(captured);
    verified = true;
    if (changed) {
        scopeGeneration += 1;
    }
    return changed;
}
/**
 * 从 list 响应捕获服务端解析的家庭作用域(itemsApi.list / locations.list;
 * P1-A 起共享家庭响应附带 scope_revision,缺省即个人家庭;非法值静默忽略,
 * 保持原作用域)。返回是否发生作用域切换(id 变化)。
 */
function captureHouseholdId(householdId, scopeRevision) {
    if (typeof householdId !== "string" || !isUsableHouseholdId(householdId)) {
        return false;
    }
    const id = householdId.trim();
    const revision = isUsableRevision(scopeRevision) ? scopeRevision : null;
    const shared = revision !== null || isSharedIdShape(id);
    return applyCapture(id, shared, revision);
}
/**
 * 从 households 响应(status/create/join)捕获完整作用域上下文。
 * 返回是否发生作用域切换(id 变化)。
 */
function captureHouseholdScope(householdId, shared, scopeRevision) {
    if (typeof householdId !== "string" || !isUsableHouseholdId(householdId)) {
        return false;
    }
    const id = householdId.trim();
    const isShared = shared === true || isSharedIdShape(id);
    const revision = isUsableRevision(scopeRevision) ? scopeRevision : null;
    return applyCapture(id, isShared, revision);
}
/** 当前作用域 id:已捕获的家庭 id,或稳定回退 "default"(单人阶段) */
/**
 * 当前家庭显示名记忆(独立存储键,不进 scope 载荷,避免动已验证的格式):
 * households.status/create/join 的 display_name 捕获于此;个人家庭为 null。
 * 切换家庭未携带新名时清空,绝不让上一家的名字跟着走。
 */
const NAME_STORAGE_KEY = "home-memory:household-name";
let rememberedName = undefined;
function persistName(name) {
    const storage = activeStorage();
    if (storage === null) {
        return;
    }
    try {
        if (name === null) {
            storage.removeStorageSync(NAME_STORAGE_KEY);
        }
        else {
            storage.setStorageSync(NAME_STORAGE_KEY, name);
        }
    }
    catch (e) {
        // best-effort:名字仅用于展示,失败不影响任何行为
    }
}
/** 捕获家庭显示名(仅 string 非空写入;null 显式清空;undefined 不动) */
function captureHouseholdScopeName(name) {
    if (name === undefined) {
        return;
    }
    if (typeof name === "string" && name.length > 0 && name.length <= 60) {
        rememberedName = name;
        persistName(name);
        return;
    }
    rememberedName = null;
    persistName(null);
}
/** 当前家庭显示名(未捕获/个人家庭为 null;读失败按未捕获处理) */
function householdScopeName() {
    if (rememberedName === undefined) {
        const storage = activeStorage();
        rememberedName = null;
        if (storage !== null) {
            try {
                const raw = storage.getStorageSync(NAME_STORAGE_KEY);
                if (typeof raw === "string" && raw.length > 0 && raw.length <= 60) {
                    rememberedName = raw;
                }
            }
            catch (e) {
                // best-effort
            }
        }
    }
    return rememberedName;
}
/**
 * 本人展示资料记忆(主页头像入口渲染;与家庭名同样的独立键策略):
 * 来源=status 响应的 self_nickname/self_avatar_file_id 与 updateProfile 回显;
 * 个人家庭/未捕获为 null。切换家庭未携带新资料时清空。
 */
const SELF_NICK_KEY = "home-memory:self-nick";
const SELF_AVATAR_KEY = "home-memory:self-avatar";
let rememberedSelf;
function readKey(key) {
    const storage = activeStorage();
    if (storage === null) {
        return null;
    }
    try {
        const raw = storage.getStorageSync(key);
        return typeof raw === "string" && raw.length > 0 && raw.length <= 300 ? raw : null;
    }
    catch (e) {
        return null;
    }
}
function writeKey(key, value) {
    const storage = activeStorage();
    if (storage === null) {
        return;
    }
    try {
        if (value === null) {
            storage.removeStorageSync(key);
        }
        else {
            storage.setStorageSync(key, value);
        }
    }
    catch (e) {
        // best-effort:资料仅展示用
    }
}
/** 捕获本人资料(undefined 不动;null 显式清空;家庭切换时整体清) */
function captureHouseholdSelfProfile(p) {
    if (rememberedSelf === undefined) {
        rememberedSelf = {
            nickname: readKey(SELF_NICK_KEY),
            avatarFileId: readKey(SELF_AVATAR_KEY),
        };
    }
    if (p.nickname !== undefined) {
        rememberedSelf.nickname = p.nickname && p.nickname.length > 0 ? p.nickname : null;
        writeKey(SELF_NICK_KEY, rememberedSelf.nickname);
    }
    if (p.avatar_file_id !== undefined) {
        rememberedSelf.avatarFileId =
            p.avatar_file_id && p.avatar_file_id.length > 0 ? p.avatar_file_id : null;
        writeKey(SELF_AVATAR_KEY, rememberedSelf.avatarFileId);
    }
}
/** 当前本人资料(未捕获/个人家庭为 null) */
function householdSelfProfile() {
    if (rememberedSelf === undefined) {
        captureHouseholdSelfProfile({});
    }
    return {
        nickname: rememberedSelf ? rememberedSelf.nickname : null,
        avatarFileId: rememberedSelf ? rememberedSelf.avatarFileId : null,
    };
}
function householdScopeId() {
    ensureLoaded();
    return captured !== null ? captured.id : exports.DEFAULT_HOUSEHOLD_SCOPE_ID;
}
/** 是否已捕获真实家庭作用域(false = 单人回退) */
function isHouseholdScopeCaptured() {
    ensureLoaded();
    return captured !== null;
}
/** 当前作用域是否为共享家庭(未捕获 = false) */
function isHouseholdScopeShared() {
    ensureLoaded();
    return captured !== null && captured.shared;
}
/**
 * 存储键/会话键的作用域后缀:未捕获时为空串(键与单人现状逐字节一致),
 * 捕获后为 ":hh-<household_id>"(形如 :hh-hh_9f2a…)。
 */
function householdScopeSuffix() {
    ensureLoaded();
    return captured !== null ? ":hh-" + captured.id : "";
}
/**
 * 写请求一致性标记(F2 客户端半边):
 * - 未捕获(旧云函数窗口/单人首启):null——不编造,行为与 0.4.7 逐字节一致;
 * - 已捕获:必带 expected_household_id(个人/共享都带:服务端携带则校验,
 *   挡作用域漂移);共享家庭且修订号已知时另带 expected_scope_revision
 *   (服务端共享硬门必需;修订号未知时不编造,由服务端 FAMILY_STALE_SCOPE
 *   拒绝后走刷新重试路径)。
 * 标记仅是一致性前置条件,绝不构成授权。
 */
function scopeWriteMarkers() {
    ensureLoaded();
    if (captured === null) {
        return null;
    }
    const markers = {
        expected_household_id: captured.id,
    };
    if (captured.shared && captured.revision !== null) {
        markers.expected_scope_revision = captured.revision;
    }
    return markers;
}
/** 捕获当前作用域代数(发请求前调用,响应后用 isScopeGenerationCurrent 校验) */
function captureScopeGeneration() {
    return scopeGeneration;
}
/** 响应回来时代数是否仍有效(false = 期间发生过家庭切换,响应作废不上屏) */
function isScopeGenerationCurrent(generation) {
    return generation === scopeGeneration;
}
/**
 * 展示前资格复核(硬门 C1):当前作用域是否有服务端响应背书。
 * false = 仅 storage 记忆/完全未捕获——不得把持久化家庭缓存当作可访问内容展示。
 */
function isScopeVerified() {
    return verified;
}
/**
 * 作废验证状态(前台切回时由 app 调用):此后必须等 households.status 或
 * 服务端 list 响应重新捕获,才恢复 verified。
 */
function invalidateScopeVerification() {
    verified = false;
}
/* ---------------- 测试钩子 ---------------- */
/** 注入存储(null = 强制无持久层);只在测试里用 */
function __setHouseholdScopeStorageForTest(storage) {
    testStorage = storage;
}
/** 还原测试注入与内存状态(不含已注入存储里的内容,由测试自行清理) */
function __resetHouseholdScopeForTest() {
    testStorage = undefined;
    captured = null;
    loaded = false;
    scopeGeneration = 0;
    verified = false;
}
