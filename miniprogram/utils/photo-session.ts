/*
 * 拍照识物批会话(#3,仿 utils/draft-session.ts 逐条纪律):
 * - 存储键 "home-memory:photo-session" + householdScopeSuffix()(作用域隔离,
 *   issue #34 F3 同款):拍照批归属产生它的家庭,切换家庭后旧批不可达、回切恢复,
 *   绝不自动迁移;
 * - TTL 24 小时,过期如实视为不存在(提示重拍,绝不编造);
 * - 只保留最新一个批(photo 页中途退出保留恢复入口);全部入库或放弃离开时清除;
 * - fileId 在用户确认上传前恒为 null(确认前云端零残留,#65 V0.4 合同第五项边界);
 *   一旦取得随会话保留,重试不重复上传(§7.6);
 * - base64 绝不入会话存储(只在页面内存;恢复后按 localPath 重新 prepare);
 * - localPath 为本地临时文件路径(小程序临时文件可能被系统回收:恢复时页面用
 *   wx.getFileSystemManager().access 复核,文件不存在 → 如实提示重拍,不编造);
 * - 会话归属家庭在**开批时**捕获(scope 字段,PR #67 B1):保存时把该
 *   expected_household_id 随 photoCommit 上送,服务端与当前派生家庭不一致 →
 *   SCOPE_MISMATCH 拒绝——中途切换家庭后旧批绝不改投新家庭(客户端也会拦)。
 */

import { uuid } from "./api";
import {
  captureScopeGeneration,
  householdScopeId,
  householdScopeSuffix,
  isHouseholdScopeCaptured,
} from "./household-scope";
import type { IntakeRow } from "./intake-draft";

/** 会话里的照片文件态(fileId 确认前恒 null) */
export interface PhotoSessionFile {
  /** 本地临时文件路径(压缩产物:识别与确认后上传的是同一张) */
  localPath: string;
  /** 压缩图实测宽高(坐标基准) */
  imgW: number;
  imgH: number;
  /** 云存储 fileID;用户确认上传前恒为 null(确认前云端零残留) */
  fileId: string | null;
}

/** 开批时捕获的家庭作用域(PR #67 B1:会话归属家庭,此后不再跟随当前作用域漂移) */
export interface PhotoSessionScope {
  /** 开批时的 household_id;未捕获(单人回退)为 null */
  householdId: string | null;
  /** 开批时的作用域代数(scope_generation,仅记录;跨页实例不作漂移判据) */
  generation: number;
}

export interface PhotoSessionPayload {
  /** 批 id(uuid):photoCommit 的 batch_id(仅日志聚合口径) */
  batchId: string;
  file: PhotoSessionFile;
  /** 批次默认位置(候选默认继承;空串=还没填) */
  batchLocation: string;
  /** 候选行(三态/失败态随行;operation_id 幂等键入列即生成此后稳定) */
  rows: IntakeRow[];
  /** 开批时捕获的家庭作用域(B1:保存一致性绑定的唯一来源) */
  scope: PhotoSessionScope;
  createdAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;
/** 存储键基础段;实际键 = 基础段 + 家庭作用域后缀(逐读写动态解析,F3) */
const STORAGE_KEY_BASE = "home-memory:photo-session";

type PhotoStorage = Pick<
  WechatMiniprogram.Wx,
  "getStorageSync" | "setStorageSync" | "removeStorageSync"
>;

/** 测试注入的存储(undefined = 未注入);优先级最高 */
let testStorage: PhotoStorage | null | undefined;
/** 无 wx / 无注入时的模块内后备(仅同进程) */
let memoryFallback: PhotoSessionPayload | null = null;

/** 解析当前可用存储(逐调用解析;口径与 draft-session 一致) */
function activeStorage(): PhotoStorage | null {
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

/** 当前作用域的实际存储键:切换家庭后键天然不同,旧家庭拍照批不可达(F3) */
function storageKey(): string {
  return STORAGE_KEY_BASE + householdScopeSuffix();
}

/** 指定会话作用域的存储键(B1:终止会话时按会话自己的家庭键清除,
 *  当前作用域已漂移到别家时 clearPhotoSession() 清不到旧键) */
function storageKeyForScope(scope: PhotoSessionScope | null): string {
  if (scope === null || scope.householdId === null) {
    return STORAGE_KEY_BASE;
  }
  return STORAGE_KEY_BASE + ":hh-" + scope.householdId;
}

/** 载荷最小形状门(旧版本残留/损坏条目视同不存在,不进渲染路径) */
function isUsablePayload(v: unknown): v is PhotoSessionPayload {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return false;
  }
  const p = v as { batchId?: unknown; file?: unknown; rows?: unknown; createdAt?: unknown };
  if (typeof p.batchId !== "string" || p.batchId === "") {
    return false;
  }
  const f = p.file as { localPath?: unknown; imgW?: unknown; imgH?: unknown } | null | undefined;
  if (
    typeof f !== "object" ||
    f === null ||
    typeof f.localPath !== "string" ||
    f.localPath === "" ||
    typeof f.imgW !== "number" ||
    typeof f.imgH !== "number"
  ) {
    return false;
  }
  if (!Array.isArray(p.rows)) {
    return false;
  }
  return typeof p.createdAt === "number" && Number.isFinite(p.createdAt);
}

/** scope 字段形状门:null householdId(单人回退)合法;损坏视为整条载荷损坏 */
function parseScope(v: unknown): PhotoSessionScope | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return null;
  }
  const s = v as { householdId?: unknown; generation?: unknown };
  if (s.householdId !== null && typeof s.householdId !== "string") {
    return null;
  }
  if (typeof s.householdId === "string" && s.householdId.trim() === "") {
    return null;
  }
  if (typeof s.generation !== "number" || !Number.isInteger(s.generation) || s.generation < 0) {
    return null;
  }
  return { householdId: s.householdId, generation: s.generation };
}

/** 读取后归一:无 scope(旧版本残留)按未捕获回退;scope 损坏则整条视为不存在 */
function normalizePayload(v: unknown): PhotoSessionPayload | null {
  if (!isUsablePayload(v)) {
    return null;
  }
  const raw = v as PhotoSessionPayload & { scope?: unknown };
  const scope = parseScope(raw.scope);
  if (raw.scope !== undefined && scope === null) {
    return null;
  }
  return {
    ...raw,
    scope: scope !== null ? scope : { householdId: null, generation: 0 },
  };
}

function readPersisted(): PhotoSessionPayload | null {
  const storage = activeStorage();
  if (storage !== null) {
    let raw: unknown;
    try {
      raw = storage.getStorageSync(storageKey());
    } catch (e) {
      return null; // 读失败=miss(best-effort,不当错误冒泡)
    }
    return normalizePayload(raw);
  }
  return memoryFallback;
}

function writePersisted(payload: PhotoSessionPayload): void {
  const storage = activeStorage();
  if (storage !== null) {
    try {
      storage.setStorageSync(storageKey(), payload);
    } catch (e) {
      // 写失败:本次不持久化,不影响当前页面(恢复入口按无会话处理)
    }
    return;
  }
  memoryFallback = payload;
}

function clearPersisted(): void {
  const storage = activeStorage();
  if (storage !== null) {
    try {
      storage.removeStorageSync(storageKey());
    } catch (e) {
      // 清失败:残留条目按 TTL/形状门自然失效
    }
    return;
  }
  memoryFallback = null;
}

function isExpired(payload: PhotoSessionPayload, now: number): boolean {
  return now - payload.createdAt > TTL_MS;
}

/** 捕获当前家庭作用域为会话作用域(B1:开批时调用一次,此后不再漂移) */
export function capturePhotoSessionScope(): PhotoSessionScope {
  return {
    householdId: isHouseholdScopeCaptured() ? householdScopeId() : null,
    generation: captureScopeGeneration(),
  };
}

/** 开新一批拍照会话(成为当前会话);batchId 在此生成,此后全程稳定;
 *  会话归属家庭在此时捕获(scope 字段),保存时据此做一致性绑定 */
export function startPhotoSession(
  file: PhotoSessionFile,
  rows: IntakeRow[],
  batchLocation: string,
): PhotoSessionPayload {
  const payload: PhotoSessionPayload = {
    batchId: uuid(),
    file: { localPath: file.localPath, imgW: file.imgW, imgH: file.imgH, fileId: file.fileId ?? null },
    batchLocation,
    rows,
    scope: capturePhotoSessionScope(),
    createdAt: Date.now(),
  };
  writePersisted(payload);
  return payload;
}

/** 回写会话(行状态/批次位置/fileId 逐次更新;会话已被替换/清除则忽略,不复活旧批) */
export function updatePhotoSession(payload: PhotoSessionPayload): void {
  const persisted = readPersisted();
  if (persisted === null || persisted.batchId !== payload.batchId) {
    return; // 迟到回写不得顶掉新批次的恢复入口(CAS 守卫,与 draft-session 同款)
  }
  writePersisted(payload);
}

/** 清除会话(全部入库/放弃离开;幂等) */
export function clearPhotoSession(): void {
  clearPersisted();
}

/** 按会话自己的作用域键清除(B1:漂移/SCOPE_MISMATCH 终止会话用——会话存在
 *  开批家庭的键下,当前作用域已切走时普通 clear 清不到;幂等) */
export function clearPhotoSessionForScope(scope: PhotoSessionScope | null): void {
  const storage = activeStorage();
  const key = storageKeyForScope(scope);
  if (storage !== null) {
    try {
      storage.removeStorageSync(key);
    } catch (e) {
      // 清失败:残留条目按 TTL/形状门自然失效
    }
    return;
  }
  if (memoryFallback !== null) {
    memoryFallback = null;
  }
}

/** 首页恢复横幅/页面恢复用:读未完成会话;过期清除后如实返回 null(绝不编造) */
export function getUnfinishedPhotoSession(
  now: number = Date.now(),
): PhotoSessionPayload | null {
  const persisted = readPersisted();
  if (persisted === null) {
    return null;
  }
  if (isExpired(persisted, now)) {
    clearPersisted();
    return null;
  }
  return persisted;
}

/** 测试钩子:注入存储(null = 强制用模块内后备) */
export function __setPhotoSessionStorageForTest(storage: PhotoStorage | null): void {
  testStorage = storage;
}

/** 还原测试注入与内存后备 */
export function __resetPhotoSessionForTest(): void {
  testStorage = undefined;
  memoryFallback = null;
}
