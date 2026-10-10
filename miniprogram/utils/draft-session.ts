import { uuid } from "./api";
import type { DraftWithQuote } from "../types";

/*
 * 临时草稿会话(评审要求:确认页不得再用 URL 传整段草稿):
 * 首页提取完成后把 { 原话, 草稿数组 } 存入内存会话,navigateTo 只带 sid;
 * 确认页按 sid 取用,保存完成或离开页面即清;小程序进程被回收时会话随之消失,
 * 确认页如实提示「草稿已过期」并引导回首页重新提取,绝不静默丢件。
 */

export interface DraftSessionPayload {
  originalText: string;
  drafts: DraftWithQuote[];
  /** 原话超过 5 件被截取前 5(确认页提示分批,绝不静默) */
  truncated: boolean;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000;

const sessions = new Map<string, DraftSessionPayload>();

function prune(now: number): void {
  for (const [sid, payload] of sessions) {
    if (now - payload.createdAt > TTL_MS) {
      sessions.delete(sid);
    }
  }
}

/** 存入一批草稿,返回会话 id(由确认页 URL 携带) */
export function createDraftSession(
  originalText: string,
  drafts: DraftWithQuote[],
  truncated: boolean,
): string {
  const sid = uuid();
  sessions.set(sid, { originalText, drafts, truncated, createdAt: Date.now() });
  return sid;
}

/** 按 sid 取会话;过期或不存在返回 null(调用方如实提示,不编造空草稿) */
export function getDraftSession(sid: string, now: number = Date.now()): DraftSessionPayload | null {
  const payload = sessions.get(sid);
  if (!payload) {
    return null;
  }
  if (now - payload.createdAt > TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  return payload;
}

/** 清除会话(保存完成/放弃离开;幂等) */
export function clearDraftSession(sid: string): void {
  sessions.delete(sid);
}

/** 清掉全部过期会话;返回剩余数量(now 可注入,测试用) */
export function pruneDraftSessions(now: number = Date.now()): number {
  prune(now);
  return sessions.size;
}
