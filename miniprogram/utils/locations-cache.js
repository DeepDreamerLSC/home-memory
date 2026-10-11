"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.locationsLayerKey = locationsLayerKey;
exports.readLocationsLayer = readLocationsLayer;
exports.isLocationsCacheFresh = isLocationsCacheFresh;
exports.writeLocationsLayer = writeLocationsLayer;
exports.clearLocationsCache = clearLocationsCache;
exports.captureCacheGeneration = captureCacheGeneration;
exports.isCacheGenerationCurrent = isCacheGenerationCurrent;
exports.pruneLocationsCache = pruneLocationsCache;
exports.planLocationsLoad = planLocationsLoad;
exports.createRequestSeq = createRequestSeq;
exports.__setLocationsCacheStorageForTest = __setLocationsCacheStorageForTest;
exports.__resetLocationsCacheForTest = __resetLocationsCacheForTest;
/** 性能 TTL:2 分钟内可直接上屏、不触发云函数;过期仅意味着「该刷新了」,数据仍可先上屏 */
const LOCATIONS_CACHE_TTL_MS = 2 * 60 * 1000;
/** 绝对过期:单层缓存最多保留 24 小时,超时如实视为不存在(app 启动时清理) */
const LOCATIONS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = "home-memory:locations-cache";
/** 测试注入的存储(undefined = 未注入);优先级最高 */
let testStorage;
/** 无 wx / 无注入时的模块内后备(仅同进程,进程回收即丢——如实降级,不伪装持久) */
let memoryFallback = null;
/**
 * storage 故障熔断(P1-2):任一 storage 调用抛异常即置位,本会话内缓存整体
 * 禁用(读=miss、写/清=no-op),直连服务端;不恢复,重启自然复位。
 */
let storageBroken = false;
/**
 * 全局失效代数(P1-1):任何成功写操作使代数递增。请求发出时捕获代数,响应
 * 回来时代数已变 → 该响应是失效发生之前读取的旧树,不得上屏、不得写缓存。
 * 页内并发由 requestSeq 管,跨页面/跨组件的迟到写入由本代数管。
 */
let invalidationGeneration = 0;
/**
 * 解析当前可用存储。逐调用解析而非模块加载时绑定:测试里 globalThis.wx 可能被
 * 换成只含 cloud 的 stub,加载时机不同会拿到缺方法的假 wx。
 */
function activeStorage() {
    if (storageBroken) {
        return null; // 熔断后本会话禁用缓存:读=miss、写/清=no-op,直连服务端
    }
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
/** storage 调用统一包裹(P1-2 best-effort):异常吃掉并熔断,绝不向上抛 */
function safeStorage(op) {
    try {
        return op();
    }
    catch (e) {
        storageBroken = true;
        return null;
    }
}
/** 层键:根层(parent_id 缺省)固定 "root",其余用 parent_id */
function locationsLayerKey(parentId) {
    return parentId ? parentId : "root";
}
function isPayload(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v) &&
        typeof v.layers === "object" &&
        v.layers !== null;
}
function readPayload() {
    const storage = activeStorage();
    if (storage !== null) {
        const raw = safeStorage(() => storage.getStorageSync(STORAGE_KEY));
        if (raw === null) {
            return { layers: {} }; // 读失败=miss(best-effort,不当错误冒泡)
        }
        return isPayload(raw) ? raw : { layers: {} };
    }
    return memoryFallback !== null ? memoryFallback : { layers: {} };
}
function writePayload(payload) {
    const storage = activeStorage();
    if (storage !== null) {
        safeStorage(() => storage.setStorageSync(STORAGE_KEY, payload));
        return; // 写失败:本次不持久化,不影响当前渲染与 API 语义
    }
    memoryFallback = payload;
}
function clearPayload() {
    const storage = activeStorage();
    if (storage !== null) {
        safeStorage(() => storage.removeStorageSync(STORAGE_KEY));
        return;
    }
    memoryFallback = null;
}
function isExpired(entry, now) {
    return now - entry.savedAt > LOCATIONS_CACHE_MAX_AGE_MS;
}
/**
 * 读某一层的缓存;超过 24 小时绝对过期的层如实返回 null(同时顺手清掉)。
 * 注意:返回的 entry 可能已过性能 TTL——是否「可直接用而不发请求」由
 * isLocationsCacheFresh 判断,是否「可先上屏再刷新」由调用方按渲染状态决定。
 */
function readLocationsLayer(parentId, now = Date.now()) {
    const payload = readPayload();
    const key = locationsLayerKey(parentId);
    const entry = payload.layers[key];
    if (!entry) {
        return null;
    }
    if (isExpired(entry, now)) {
        delete payload.layers[key];
        writePayload(payload);
        return null;
    }
    return entry;
}
/** 性能 TTL 内(2 分钟):可直接上屏且不必发请求 */
function isLocationsCacheFresh(entry, now = Date.now()) {
    return now - entry.savedAt <= LOCATIONS_CACHE_TTL_MS;
}
/**
 * 写入某一层的 list 响应。generation 为请求发出时捕获的失效代数(P1-1):
 * 在途期间发生过写失效(代数已变)则拒绝写入——旧树不得按新 savedAt 复活。
 * 页面侧仍须先过请求序号校验(见 createRequestSeq):两者共同覆盖页内并发与跨页迟到。
 */
function writeLocationsLayer(parentId, response, now = Date.now(), generation) {
    if (generation !== undefined && generation !== invalidationGeneration) {
        return; // 失效发生在此响应在途期间:丢弃,不污染缓存
    }
    const payload = readPayload();
    // 顺手丢弃其他已绝对过期的层,控制条目体积
    for (const key of Object.keys(payload.layers)) {
        if (isExpired(payload.layers[key], now)) {
            delete payload.layers[key];
        }
    }
    payload.layers[locationsLayerKey(parentId)] = { savedAt: now, response };
    writePayload(payload);
}
/** 全量失效(整棵树):任何一次成功写操作后由 API 层调用;幂等;使失效代数 +1 */
function clearLocationsCache() {
    invalidationGeneration += 1;
    clearPayload();
}
/** 捕获当前失效代数(P1-1):请求发出前调用,响应回来用 isCacheGenerationCurrent 校验 */
function captureCacheGeneration() {
    return invalidationGeneration;
}
/** 响应回来时代数是否仍然有效(false = 在途期间发生过写失效,响应作废) */
function isCacheGenerationCurrent(generation) {
    return generation === invalidationGeneration;
}
/** 清理超过 24 小时的层,返回剩余层数(app 启动时调用;now 可注入) */
function pruneLocationsCache(now = Date.now()) {
    const payload = readPayload();
    let removed = false;
    for (const key of Object.keys(payload.layers)) {
        if (isExpired(payload.layers[key], now)) {
            delete payload.layers[key];
            removed = true;
        }
    }
    if (removed) {
        if (Object.keys(payload.layers).length === 0) {
            clearPayload();
        }
        else {
            writePayload(payload);
        }
    }
    return Object.keys(payload.layers).length;
}
/**
 * 决定本次进入某层怎么渲染、要不要发请求(约束 1 / 3 的收口):
 * - pickMode(选择位置)一律绕过缓存直连服务端:它是影响真实数据操作前的校验;
 * - force(下拉刷新)绕过 TTL 直连服务端:缓存只用于先上屏;
 * - TTL 内且非强制:直接用缓存、不发请求(降低冷启动触发频率的主路径);
 * - 缓存已过 TTL:先上屏旧树,后台静默刷新(fetch=true);
 * - 无缓存:屏上没内容则骨架,屏上已有内容(如写操作刚失效缓存)只轻量刷新。
 */
function planLocationsLoad(input) {
    if (input.pickMode) {
        return { useCache: false, skeleton: !input.rendered, fetch: true };
    }
    if (input.cached !== null && input.fresh && !input.force) {
        return { useCache: true, skeleton: false, fetch: false };
    }
    if (input.cached !== null) {
        return { useCache: true, skeleton: false, fetch: true };
    }
    return { useCache: false, skeleton: !input.rendered, fetch: true };
}
/**
 * 递增请求序号,防旧响应覆盖新数据(PR #17 的 DG-2 迟到回调问题的同类防护):
 * 每次发请求前 next() 取号并捕获到本地,响应回来(成功或失败)时 isCurrent()
 * 不通过则整个丢弃——不 setData、不写缓存。放在 util 里使其可离线测试。
 */
function createRequestSeq() {
    let current = 0;
    return {
        next() {
            current += 1;
            return current;
        },
        isCurrent(seq) {
            return seq === current;
        },
        current() {
            return current;
        },
    };
}
/* ---------------- 测试钩子 ---------------- */
/** 注入存储(null = 强制用模块内后备);只在测试里用 */
function __setLocationsCacheStorageForTest(storage) {
    testStorage = storage;
}
/** 还原全部测试注入与内存后备 */
function __resetLocationsCacheForTest() {
    testStorage = undefined;
    memoryFallback = null;
    storageBroken = false;
    invalidationGeneration = 0;
}
