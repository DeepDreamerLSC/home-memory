/**
 * 「我的家」空间树 list 响应的本机缓存(issue #23,冷启动等待的感知层优化):
 * - 云函数冷启动实测 3-4s、热态 0.5s。本缓存让有缓存时首屏立即呈现上次树形,
 *   2 分钟 TTL 内甚至不再触发云函数(降低冷启动触发频率);冷启动客观时长不变,
 *   属感知层优化,不是对冷启动本身的修复;
 * - 按层缓存 list 响应(key = parent_id,根层为 "root"):只缓存节点结构与
 *   物品摘要(与页面已展示的同级数据),绝不缓存语音原文/prompt/日志;
 * - 第一版失效策略为全量:任何一次成功写操作(经 locations-api 的变更类 action、
 *   itemsApi 的 create/update/delete)统一清空整棵树缓存,不做节点级精细化。
 *   失效收口在 API 层封装里,页面不许自己记「该清哪层」;
 * - 隐私与账号维度:缓存的是完整 list 响应,含 items[*].location_text 家庭位置
 *   原始文字——按「敏感的应用本地缓存」口径管理(与 draft-session 同级敏感面),
 *   本地保留不超过 24 小时。不宣称小程序 storage 天然按用户/家庭隔离(未验证,
 *   也不能由此推出换号无需处理);当前单身份自用阶段用单键,未来支持家庭切换
 *   时必须显式清理或按家庭作用域隔离;
 * - 本模块对 storage 一律 best-effort(P1-2):读写清理失败不抛出、不改变 API
 *   成败语义;连续故障时本会话禁用缓存直接降级为始终请求服务端;
 * - TTL(2 分钟)只是性能策略不是正确性保证:下拉刷新 / 选择位置模式(picker=1,
 *   影响真实数据的操作前重新校验)/ 本机刚发生写操作(失效后自然重拉)一律
 *   绕过 TTL 直连服务端。
 *
 * 测试可注入:存储(显式注入,无 wx 时模块内后备)与时钟(now 参数)。
 */
import type { ListLocationsResponse } from "../types";

/** 性能 TTL:2 分钟内可直接上屏、不触发云函数;过期仅意味着「该刷新了」,数据仍可先上屏 */
const LOCATIONS_CACHE_TTL_MS = 2 * 60 * 1000;
/** 绝对过期:单层缓存最多保留 24 小时,超时如实视为不存在(app 启动时清理) */
const LOCATIONS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const STORAGE_KEY = "home-memory:locations-cache";

/** 缓存的某一层 list 响应(savedAt 为写入时钟,毫秒) */
export interface LocationsCacheEntry {
  savedAt: number;
  response: ListLocationsResponse;
}

/** 全部层放在同一个 storage 条目里:整树失效 / 启动清理都是一次写,不做键枚举 */
interface LocationsCachePayload {
  layers: Record<string, LocationsCacheEntry>;
}

type CacheStorage = Pick<
  WechatMiniprogram.Wx,
  "getStorageSync" | "setStorageSync" | "removeStorageSync"
>;

/** 测试注入的存储(undefined = 未注入);优先级最高 */
let testStorage: CacheStorage | null | undefined;
/** 无 wx / 无注入时的模块内后备(仅同进程,进程回收即丢——如实降级,不伪装持久) */
let memoryFallback: LocationsCachePayload | null = null;
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
function activeStorage(): CacheStorage | null {
  if (storageBroken) {
    return null; // 熔断后本会话禁用缓存:读=miss、写/清=no-op,直连服务端
  }
  if (testStorage !== undefined) {
    return testStorage;
  }
  if (
    typeof wx !== "undefined" &&
    typeof wx.getStorageSync === "function" &&
    typeof wx.setStorageSync === "function" &&
    typeof wx.removeStorageSync === "function"
  ) {
    return wx;
  }
  return null;
}

/** storage 调用统一包裹(P1-2 best-effort):异常吃掉并熔断,绝不向上抛 */
function safeStorage<T>(op: () => T): T | null {
  try {
    return op();
  } catch (e) {
    storageBroken = true;
    return null;
  }
}

/** 层键:根层(parent_id 缺省)固定 "root",其余用 parent_id */
export function locationsLayerKey(parentId: string): string {
  return parentId ? parentId : "root";
}

function isPayload(v: unknown): v is LocationsCachePayload {
  return typeof v === "object" && v !== null && !Array.isArray(v) &&
    typeof (v as { layers?: unknown }).layers === "object" &&
    (v as { layers: unknown }).layers !== null;
}

/**
 * 缓存条目内部形状校验(P1-2 收尾,窄复核):旧版本残留/损坏的条目——如
 * response 为 null、node/children/items 缺失——不得进入渲染路径,否则
 * renderList 访问 res.node.type 直接 TypeError 且发生在请求 try 之前,
 * 页面永远回退不了云端。非法条目视 cache miss,并 best-effort 删掉该层。
 */
function isUsableEntry(v: unknown): v is LocationsCacheEntry {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const entry = v as { savedAt?: unknown; response?: unknown };
  if (typeof entry.savedAt !== "number" || !Number.isFinite(entry.savedAt)) {
    return false;
  }
  const response = entry.response;
  if (typeof response !== "object" || response === null) {
    return false;
  }
  const node = (response as { node?: { type?: unknown } }).node;
  if (typeof node !== "object" || node === null || typeof node.type !== "string") {
    return false;
  }
  if (!Array.isArray((response as { children?: unknown }).children)) {
    return false;
  }
  if (!Array.isArray((response as { items?: unknown }).items)) {
    return false;
  }
  if (typeof (response as { unmounted_count?: unknown }).unmounted_count !== "number") {
    return false;
  }
  if (typeof (response as { dangling_mounts?: unknown }).dangling_mounts !== "number") {
    return false;
  }
  return true;
}

function readPayload(): LocationsCachePayload {
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

function writePayload(payload: LocationsCachePayload): void {
  const storage = activeStorage();
  if (storage !== null) {
    safeStorage(() => storage.setStorageSync(STORAGE_KEY, payload));
    return; // 写失败:本次不持久化,不影响当前渲染与 API 语义
  }
  memoryFallback = payload;
}

function clearPayload(): void {
  const storage = activeStorage();
  if (storage !== null) {
    safeStorage(() => storage.removeStorageSync(STORAGE_KEY));
    return;
  }
  memoryFallback = null;
}

function isExpired(entry: LocationsCacheEntry, now: number): boolean {
  return now - entry.savedAt > LOCATIONS_CACHE_MAX_AGE_MS;
}

/**
 * 读某一层的缓存;超过 24 小时绝对过期的层如实返回 null(同时顺手清掉)。
 * 注意:返回的 entry 可能已过性能 TTL——是否「可直接用而不发请求」由
 * isLocationsCacheFresh 判断,是否「可先上屏再刷新」由调用方按渲染状态决定。
 */
export function readLocationsLayer(
  parentId: string,
  now: number = Date.now(),
): LocationsCacheEntry | null {
  const payload = readPayload();
  const key = locationsLayerKey(parentId);
  const entry = payload.layers[key];
  if (!entry) {
    return null;
  }
  if (!isUsableEntry(entry)) {
    // 内部损坏(形状合法的持久层里嵌着坏条目):降级为 miss 并顺手清掉,
    // 页面因此照常走云端请求,绝不让坏数据进入渲染路径
    delete payload.layers[key];
    writePayload(payload);
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
export function isLocationsCacheFresh(
  entry: LocationsCacheEntry,
  now: number = Date.now(),
): boolean {
  return now - entry.savedAt <= LOCATIONS_CACHE_TTL_MS;
}

/**
 * 写入某一层的 list 响应。generation 为请求发出时捕获的失效代数(P1-1):
 * 在途期间发生过写失效(代数已变)则拒绝写入——旧树不得按新 savedAt 复活。
 * 页面侧仍须先过请求序号校验(见 createRequestSeq):两者共同覆盖页内并发与跨页迟到。
 */
export function writeLocationsLayer(
  parentId: string,
  response: ListLocationsResponse,
  now: number = Date.now(),
  generation?: number,
): void {
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
export function clearLocationsCache(): void {
  invalidationGeneration += 1;
  clearPayload();
}

/** 捕获当前失效代数(P1-1):请求发出前调用,响应回来用 isCacheGenerationCurrent 校验 */
export function captureCacheGeneration(): number {
  return invalidationGeneration;
}

/** 响应回来时代数是否仍然有效(false = 在途期间发生过写失效,响应作废) */
export function isCacheGenerationCurrent(generation: number): boolean {
  return generation === invalidationGeneration;
}

/** 清理超过 24 小时的层,返回剩余层数(app 启动时调用;now 可注入) */
export function pruneLocationsCache(now: number = Date.now()): number {
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
    } else {
      writePayload(payload);
    }
  }
  return Object.keys(payload.layers).length;
}

/* ---------------- 页面加载决策(纯函数,离线可测) ---------------- */

/** loadNode 的渲染/请求决策结果 */
export interface LocationsLoadPlan {
  /** 先把缓存/已有内容上屏(不整页骨架) */
  useCache: boolean;
  /** 显示整页骨架(屏上没有任何可展示内容) */
  skeleton: boolean;
  /** 需要请求服务端 */
  fetch: boolean;
}

/**
 * 决定本次进入某层怎么渲染、要不要发请求(约束 1 / 3 的收口):
 * - pickMode(选择位置)一律绕过缓存直连服务端:它是影响真实数据操作前的校验;
 * - force(下拉刷新)绕过 TTL 直连服务端:缓存只用于先上屏;
 * - TTL 内且非强制:直接用缓存、不发请求(降低冷启动触发频率的主路径);
 * - 缓存已过 TTL:先上屏旧树,后台静默刷新(fetch=true);
 * - 无缓存:屏上没内容则骨架,屏上已有内容(如写操作刚失效缓存)只轻量刷新。
 */
export function planLocationsLoad(input: {
  cached: LocationsCacheEntry | null;
  fresh: boolean;
  force: boolean;
  pickMode: boolean;
  rendered: boolean;
}): LocationsLoadPlan {
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

/* ---------------- 请求序号守卫(约束 4,DG-2 同类防护) ---------------- */

export interface LocationsRequestSeq {
  /** 发起新请求前取号(自增) */
  next(): number;
  /** 响应回来时校验:只有最新一次请求的响应才允许上屏与写缓存 */
  isCurrent(seq: number): boolean;
  /** 当前序号(测试观测用) */
  current(): number;
}

/**
 * 递增请求序号,防旧响应覆盖新数据(PR #17 的 DG-2 迟到回调问题的同类防护):
 * 每次发请求前 next() 取号并捕获到本地,响应回来(成功或失败)时 isCurrent()
 * 不通过则整个丢弃——不 setData、不写缓存。放在 util 里使其可离线测试。
 */
export function createRequestSeq(): LocationsRequestSeq {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(seq: number): boolean {
      return seq === current;
    },
    current(): number {
      return current;
    },
  };
}

/* ---------------- 测试钩子 ---------------- */

/** 注入存储(null = 强制用模块内后备);只在测试里用 */
export function __setLocationsCacheStorageForTest(
  storage: CacheStorage | null,
): void {
  testStorage = storage;
}

/** 还原全部测试注入与内存后备 */
export function __resetLocationsCacheForTest(): void {
  testStorage = undefined;
  memoryFallback = null;
  storageBroken = false;
  invalidationGeneration = 0;
}
