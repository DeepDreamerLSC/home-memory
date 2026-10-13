"use strict";
/**
 * 家庭作用域(issue #34 P0,F3 基础):
 * - 作用域 id 的唯一来源是服务端 list 响应里的 household_id(itemsApi.list 与
 *   locations.list;sha256 派生或共享家庭随机 id,非 PII)。服务端权威,
 *   客户端捕获的值只用于本地键隔离,不具任何授权效力;
 * - 捕获后存内存并 best-effort 持久化(storage 记忆):冷启动先还原作用域再读
 *   位置缓存/未完成草稿,保证按正确家庭的键命中(24h 缓存语义不因重启失效);
 * - 捕获不到(旧云函数响应无该字段/单人阶段)时 householdScopeId() 返回稳定
 *   回退值 "default"、householdScopeSuffix() 返回空串——locations-cache 与
 *   draft-session 的存储键与单人现状逐字节一致,零回归;
 * - locations-cache 的存储键、draft-session 的会话/持久化键、首页未完成批次
 *   检查统一拼接 ":hh-<household_id>" 后缀:切换家庭后键天然不同,旧家庭的
 *   缓存/草稿互不可达(F3)。P0 无切换入口;成员被移除后的本地清理是 P1 交付;
 * - storage 一律 best-effort:读写失败不抛出、不影响业务语义(与 locations-cache
 *   同款口径)。测试可注入存储(无 wx 时仅内存记忆)。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_HOUSEHOLD_SCOPE_ID = void 0;
exports.captureHouseholdId = captureHouseholdId;
exports.householdScopeId = householdScopeId;
exports.isHouseholdScopeCaptured = isHouseholdScopeCaptured;
exports.householdScopeSuffix = householdScopeSuffix;
exports.__setHouseholdScopeStorageForTest = __setHouseholdScopeStorageForTest;
exports.__resetHouseholdScopeForTest = __resetHouseholdScopeForTest;
const SCOPE_STORAGE_KEY = "home-memory:household-scope";
/** 稳定回退值:单人阶段(未捕获到服务端 household_id)的作用域标识 */
exports.DEFAULT_HOUSEHOLD_SCOPE_ID = "default";
/** household_id 合法长度上限(个人家庭 id 恒 35 字符,上限只拦异常值) */
const HOUSEHOLD_ID_MAX_LENGTH = 128;
/** 测试注入的存储(undefined = 未注入);优先级最高 */
let testStorage;
/** 已捕获的家庭作用域(null = 未捕获,单人阶段) */
let captured = null;
/** 是否已从持久层做过首次还原 */
let loaded = false;
function activeStorage() {
    if (testStorage !== undefined) {
        return testStorage;
    }
    if (typeof wx !== "undefined" &&
        typeof wx.getStorageSync === "function" &&
        typeof wx.setStorageSync === "function") {
        return wx;
    }
    return null;
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
        if (typeof raw === "string" &&
            raw.length > 0 &&
            raw.length <= HOUSEHOLD_ID_MAX_LENGTH &&
            raw !== exports.DEFAULT_HOUSEHOLD_SCOPE_ID) {
            captured = raw;
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
        storage.setStorageSync(SCOPE_STORAGE_KEY, scope);
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
/**
 * 从 list 响应捕获服务端解析的家庭 id(非法值静默忽略,保持原作用域)。
 * 捕获值变化时更新内存并 best-effort 持久化;调用方无需关心是否变化。
 */
function captureHouseholdId(householdId) {
    if (typeof householdId !== "string" || !isUsableHouseholdId(householdId)) {
        return;
    }
    const next = householdId.trim();
    ensureLoaded();
    if (captured === next) {
        return;
    }
    captured = next;
    persist(next);
}
/** 当前作用域 id:已捕获的家庭 id,或稳定回退 "default"(单人阶段) */
function householdScopeId() {
    ensureLoaded();
    return captured !== null ? captured : exports.DEFAULT_HOUSEHOLD_SCOPE_ID;
}
/** 是否已捕获真实家庭作用域(false = 单人回退) */
function isHouseholdScopeCaptured() {
    ensureLoaded();
    return captured !== null;
}
/**
 * 存储键/会话键的作用域后缀:未捕获时为空串(键与单人现状逐字节一致),
 * 捕获后为 ":hh-<household_id>"(形如 :hh-hh_9f2a…)。
 */
function householdScopeSuffix() {
    ensureLoaded();
    return captured !== null ? ":hh-" + captured : "";
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
}
