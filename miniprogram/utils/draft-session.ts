import { uuid } from "./api";
import type { DraftWithQuote } from "../types";

/*
 * 临时草稿会话(确认页不得 URL 传整段草稿;Issue #14 三轮评审:退出后保幂等恢复能力):
 * - 内存 Map 供同进程快速取用;持久层(小程序 wx storage,node/测试用模块后备)
 *   只保留最新一个会话,供进程被回收后恢复;
 * - 确认页逐行保存时把行状态(含固定 operation_id 与已保存状态)回写会话,
 *   中途退出(部分写入结果未知)不清持久层,首页检测到未完成会话给「继续核对」入口,
 *   恢复后沿用原幂等键——已保存行不再提交,不会重复建档;
 * - 全部保存完成或用户放弃(无勾选)离开时,确认页清除会话;
 * - 过期(24 小时)如实视为不存在:提示重新提取,绝不编造空草稿。
 */

export interface DraftSessionRowState {
  key: string;
  name: string;
  locationText: string;
  checked: boolean;
  status: "pending" | "saving" | "saved" | "failed";
  failMsg: string;
  operationId: string;
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
const STORAGE_KEY = "home-memory:draft-session";

/** 小程序 storage;node/测试环境无 wx 时用模块后备(仅同进程) */
const storage: Pick<
  WechatMiniprogram.Wx,
  "getStorageSync" | "setStorageSync" | "removeStorageSync"
> | null = typeof wx !== "undefined" ? wx : null;

const sessions = new Map<string, DraftSessionPayload>();
let memoryFallback: { sid: string; payload: DraftSessionPayload } | null = null;

interface PersistedEntry {
  sid: string;
  payload: DraftSessionPayload;
}

function readPersisted(): PersistedEntry | null {
  if (storage !== null) {
    const raw = storage.getStorageSync(STORAGE_KEY) as PersistedEntry | "" | undefined;
    return raw && typeof raw === "object" && typeof raw.sid === "string" && raw.payload
      ? raw
      : null;
  }
  return memoryFallback;
}

function writePersisted(entry: PersistedEntry): void {
  if (storage !== null) {
    storage.setStorageSync(STORAGE_KEY, entry);
    return;
  }
  memoryFallback = entry;
}

function clearPersisted(): void {
  if (storage !== null) {
    storage.removeStorageSync(STORAGE_KEY);
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
  sessions.set(sid, payload);
  writePersisted({ sid, payload });
  return sid;
}

/** 按 sid 取会话;内存未命中时从持久层恢复(进程回收场景);过期返回 null(如实提示,不编造) */
export function getDraftSession(sid: string, now: number = Date.now()): DraftSessionPayload | null {
  let payload = sessions.get(sid) ?? undefined;
  if (payload === undefined) {
    const persisted = readPersisted();
    if (persisted !== null && persisted.sid === sid) {
      payload = persisted.payload;
      sessions.set(sid, payload);
    }
  }
  if (payload === undefined) {
    return null;
  }
  if (isExpired(payload, now)) {
    sessions.delete(sid);
    const persisted = readPersisted();
    if (persisted !== null && persisted.sid === sid) {
      clearPersisted();
    }
    return null;
  }
  return payload;
}

/** 确认页回写行状态(保存中逐行调用;会话不存在则忽略) */
export function updateDraftSessionRows(sid: string, rows: DraftSessionRowState[]): void {
  const payload = sessions.get(sid);
  if (payload === undefined) {
    return;
  }
  payload.rows = rows;
  writePersisted({ sid, payload });
}

/** 清除会话(保存完成/放弃离开;幂等) */
export function clearDraftSession(sid: string): void {
  sessions.delete(sid);
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
