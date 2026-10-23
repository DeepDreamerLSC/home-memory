/*
 * 临时草稿会话(确认页不得 URL 传整段草稿;Issue #14 三轮评审:退出后保幂等恢复能力):
 * - 内存 Map 供同进程快速取用;持久层(小程序 wx storage,node/测试用注入/后备)
 *   只保留最新一个会话,供进程被回收后恢复;
 * - 确认页逐行保存时把行状态(含固定 operation_id 与已保存状态)回写会话,
 *   中途退出(部分写入结果未知)不清持久层,首页检测到未完成会话给「继续核对」入口,
 *   恢复后沿用原幂等键——已保存行不再提交,不会重复建档;
 * - 全部保存完成或用户放弃(无勾选)离开时,确认页清除会话;
 * - 过期(24 小时)如实视为不存在:提示重新提取,绝不编造空草稿;
 * - 家庭作用域(issue #34 P0,F3):持久层存储键与内存会话键统一拼接
 *   householdScopeSuffix()(捕获到服务端 household_id 后为 ":hh-<id>")。
 *   草稿归属产生它的家庭:切换家庭后旧草稿原地保留(键不同=互不可达),
 *   回切即恢复;新家庭从干净状态开始,绝不自动迁移(F3/产品决策 3)。
 *   P0 无切换入口,单人阶段后缀为空串,键与现状逐字节一致。
 */

import { uuid } from "./api";
import { householdScopeSuffix } from "./household-scope";
import type { DraftWithQuote } from "../types";

export interface DraftSessionRowState {
  key: string;
  name: string;
  locationText: string;
  checked: boolean;
  status: "pending" | "saving" | "saved" | "failed";
  failMsg: string;
  operationId: string;
  /**
   * 行内提醒日期(issue #36,YYYY-MM-DD;""=用户清除了/本就没有):
   * 用户可能在确认页经日期选择器改过或清过,恢复时以回写值为准覆盖草稿提取值。
   * 可选字段:旧版本会话缺省时确认页回落草稿提取值。
   */
  remindAt?: string;
  /** 用户动过提醒行(清除后行仍显示灰显「不提醒」),恢复时保持 */
  remindTouched?: boolean;
  /**
   * 相对时间换算候选标记(#36 真机反馈三件 A):用户经日期选择器改过日期后
   * 页面置 false(换算候选已被用户自己的选择替代);恢复时以回写值为准,
   * 缺省(旧版本会话)回落草稿提取值。
   */
  remindConverted?: boolean;
  /**
   * 「放进」行当前路径(issue #45 十七轮):用户可能经选位置「换」过,也可能
   * 因改位置文本被清成空数组(确认页 onRowLocationInput)——空数组同样是
   * 回写过的有效值,恢复时不回落草稿预览(否则旧路径回生);缺省(旧版本
   * 会话)才回落草稿预览值(无预览 = 空数组)。
   */
  mountPath?: string[];
  /**
   * 数量(issue #102 Q1):**本行数量随 create 携带时才回写**(quantityProvided
   * =语音锚定成功或用户触碰确认);缺省(pre-Q1 会话)→ 恢复后不携带
   * (E13 冻结载荷:绝不给原载荷注入数量,服务端缺省 1/件)。恢复时以回写值
   * 为准覆盖草稿提取值;单位是 UNIT_SET 成员(默认「件」)。
   */
  quantity?: number;
  unit?: string;
  /** 用户触碰过数量控件(恢复「待确认」标注用;缺省 false) */
  quantityTouched?: boolean;
}

export interface DraftSessionPayload {
  originalText: string;
  drafts: DraftWithQuote[];
  truncated: boolean;
  createdAt: number;
  /** 确认页行状态(保存中逐行回写;恢复时沿用原 operation_id 与已保存状态) */
  rows?: DraftSessionRowState[];
}

const TTL_MS = 24 * 60 * 60 * 1000;
/** 存储键基础段;实际键 = 基础段 + 家庭作用域后缀(issue #34 P0,逐读写动态解析) */
const STORAGE_KEY_BASE = "home-memory:draft-session";

type DraftStorage = Pick<
  WechatMiniprogram.Wx,
  "getStorageSync" | "setStorageSync" | "removeStorageSync"
>;

/** 测试注入的存储(undefined = 未注入);优先级最高 */
let testStorage: DraftStorage | null | undefined;
/** 无 wx / 无注入时的模块内后备(仅同进程) */
let memoryFallback: { sid: string; payload: DraftSessionPayload } | null = null;

/**
 * 解析当前可用存储(逐调用解析而非模块加载时绑定:测试里 globalThis.wx 可能是
 * 只含 cloud 的部分 stub,加载时机不同会拿到假 wx;口径与 locations-cache 一致)。
 */
function activeStorage(): DraftStorage | null {
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

/** 当前作用域的实际存储键:切换家庭后键天然不同,旧家庭草稿不可达(F3) */
function storageKey(): string {
  return STORAGE_KEY_BASE + householdScopeSuffix();
}

/** 内存会话键:sid + 作用域后缀(作用域不同则同一 sid 互不可见) */
function scopedSid(sid: string): string {
  return sid + householdScopeSuffix();
}

const sessions = new Map<string, DraftSessionPayload>();

interface PersistedEntry {
  sid: string;
  payload: DraftSessionPayload;
}

function readPersisted(): PersistedEntry | null {
  const storage = activeStorage();
  if (storage !== null) {
    const raw = storage.getStorageSync(storageKey()) as PersistedEntry | "" | undefined;
    return raw && typeof raw === "object" && typeof raw.sid === "string" && raw.payload
      ? raw
      : null;
  }
  return memoryFallback;
}

function writePersisted(entry: PersistedEntry): void {
  const storage = activeStorage();
  if (storage !== null) {
    storage.setStorageSync(storageKey(), entry);
    return;
  }
  memoryFallback = entry;
}

function clearPersisted(): void {
  const storage = activeStorage();
  if (storage !== null) {
    storage.removeStorageSync(storageKey());
    return;
  }
  memoryFallback = null;
}

function isExpired(payload: DraftSessionPayload, now: number): boolean {
  return now - payload.createdAt > TTL_MS;
}

/** 存入一批草稿(成为当前会话),返回会话 id(由确认页 URL 携带) */
export function createDraftSession(
  originalText: string,
  drafts: DraftWithQuote[],
  truncated: boolean,
): string {
  const sid = uuid();
  const payload: DraftSessionPayload = { originalText, drafts, truncated, createdAt: Date.now() };
  sessions.set(scopedSid(sid), payload);
  writePersisted({ sid, payload });
  return sid;
}

/** 按 sid 取会话;内存未命中时从持久层恢复(进程回收场景);过期返回 null(如实提示,不编造) */
export function getDraftSession(sid: string, now: number = Date.now()): DraftSessionPayload | null {
  let payload = sessions.get(scopedSid(sid)) ?? undefined;
  if (payload === undefined) {
    const persisted = readPersisted();
    if (persisted !== null && persisted.sid === sid) {
      payload = persisted.payload;
      sessions.set(scopedSid(sid), payload);
    }
  }
  if (payload === undefined) {
    return null;
  }
  if (isExpired(payload, now)) {
    sessions.delete(scopedSid(sid));
    const persisted = readPersisted();
    if (persisted !== null && persisted.sid === sid) {
      clearPersisted();
    }
    return null;
  }
  return payload;
}

/**
 * 确认页回写行状态(保存中逐行调用;会话不存在则忽略)。
 * 持久层归属检查(五轮评审 CAS 守卫):只有 sid 仍是当前持久化会话才落盘——
 * 旧确认页被放弃/替换后的迟到回调,不得把已退役的 sid 反向写回 storage,
 * 否则会顶掉新批次的恢复入口与其幂等键。内存行状态照常更新(不影响新批次)。
 */
export function updateDraftSessionRows(sid: string, rows: DraftSessionRowState[]): void {
  const payload = sessions.get(scopedSid(sid));
  if (payload === undefined) {
    return;
  }
  payload.rows = rows;
  const persisted = readPersisted();
  if (persisted === null || persisted.sid !== sid) {
    return;
  }
  writePersisted({ sid, payload });
}

/** 清除会话(保存完成/放弃离开;幂等) */
export function clearDraftSession(sid: string): void {
  sessions.delete(scopedSid(sid));
  const persisted = readPersisted();
  if (persisted !== null && persisted.sid === sid) {
    clearPersisted();
  }
}

/** 首页检测未完成会话(进程回收/中途退出后):返回 {sid,payload} 供「继续核对」入口 */
export function getUnfinishedDraftSession(
  now: number = Date.now(),
): { sid: string; payload: DraftSessionPayload } | null {
  const persisted = readPersisted();
  if (persisted === null || isExpired(persisted.payload, now)) {
    return null;
  }
  return persisted;
}

/** 清掉全部过期会话;返回剩余数量(now 可注入,测试用) */
export function pruneDraftSessions(now: number = Date.now()): number {
  const persisted = readPersisted();
  if (persisted !== null && isExpired(persisted.payload, now)) {
    clearPersisted();
  }
  for (const [sid, payload] of sessions) {
    if (isExpired(payload, now)) {
      sessions.delete(sid);
    }
  }
  return sessions.size;
}

/** 测试钩子:模拟进程回收(清内存会话,保留持久层),验证恢复路径 */
export function simulateProcessRestartForTest(): void {
  sessions.clear();
}

/** 测试钩子:注入存储(null = 强制用模块内后备);只在测试里用 */
export function __setDraftSessionStorageForTest(storage: DraftStorage | null): void {
  testStorage = storage;
}

/** 还原测试注入与内存后备 */
export function __resetDraftSessionForTest(): void {
  testStorage = undefined;
  memoryFallback = null;
}
