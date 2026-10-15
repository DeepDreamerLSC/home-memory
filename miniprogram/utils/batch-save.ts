import type { RemindKind } from "../types";

/*
 * 批量保存的行状态纯函数(确认页接线,逻辑下沉便于测试):
 * 「一次确认」只是交互上的一次操作,不是数据库原子事务——
 * 每行独立走 create 幂等(行内固定 operation_id),失败可单行重试,
 * 已保存的行不再提交。
 */

export type BatchRowStatus = "pending" | "saving" | "saved" | "failed";

export interface BatchRow {
  /** 行标识(stable key,setData 路径用) */
  key: string;
  name: string;
  locationText: string;
  checked: boolean;
  status: BatchRowStatus;
  /** failed 时的可读原因 */
  failMsg: string;
  /** 行内固定创建幂等键:重试沿用,内容修改后仍沿用(服务端同键同内容幂等/异内容冲突兜底) */
  operationId: string;
}

/** 待保存的行:勾选且未 saved(首次 pending 与重试 failed 都算) */
export function rowsToSave<T extends BatchRow>(rows: T[]): T[] {
  return rows.filter((r) => r.checked && r.status !== "saved");
}

/** 校验必填:返回第一个不合规行的人类可读提示,合规返回空串 */
export function firstInvalidMsg(rows: BatchRow[]): string {
  for (const r of rows) {
    if (!r.checked) continue;
    if (!r.name.trim()) {
      return "第 " + (rows.indexOf(r) + 1) + " 件还没写名称";
    }
    if (!r.locationText.trim()) {
      return "第 " + (rows.indexOf(r) + 1) + " 件还没写位置";
    }
  }
  return "";
}

/** 是否全部收尾:所有勾选行都 saved(未勾选行忽略) */
export function allCheckedSaved(rows: BatchRow[]): boolean {
  return rows.every((r) => !r.checked || r.status === "saved");
}

/** 汇总(按钮文案与结果反馈用) */
export function batchSummary(rows: BatchRow[]): {
  total: number;
  checked: number;
  saved: number;
  failed: number;
} {
  let checked = 0;
  let saved = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.checked) continue;
    checked += 1;
    if (r.status === "saved") saved += 1;
    if (r.status === "failed") failed += 1;
  }
  return { total: rows.length, checked, saved, failed };
}

/**
 * 默认勾选决策(下沉以便测试;PR #48 复审 B3):位置确定的(certain)且有专属
 * 原话证据、锚定不共享才默认勾选。位置没听清的(certain=false)即使有原话证据
 * 也一律不默认勾——「⚠ 位置待核实 + 已勾选」会让整批提交卡在必填校验上;
 * 补充位置后由用户明确勾选(单件 C1b 保留「填了位置自动允许确认」的专用分支,
 * 见确认页 onRowLocationInput)。
 */
export function shouldDefaultChecked(
  sourceQuote: string,
  anchorShared: boolean,
  certain: boolean,
): boolean {
  return certain && sourceQuote !== "" && !anchorShared;
}

/** 确认页行上的提醒字段(rowReminderInput 的输入形状,纯数据便于测试) */
export interface ReminderRowFields {
  /** 行内提醒日期(YYYY-MM-DD;""=不带提醒——含服务端因归属不明置空的行) */
  remindAt: string;
  /** 提取到的提醒类别(冻结词表);行内无日期时为 "" */
  remindKind: RemindKind | "";
  /** 提取时的原话锚定日期:行内日期仍是这个值才随行提交 quote */
  remindOrigin: string;
  /** 日期在原话中的逐字子串 */
  remindQuote: string;
}

/** 行内提醒随 create 提交的形态 */
export interface ReminderInputOfRow {
  due_date: string;
  kind: RemindKind;
  quote?: string;
}

/** 行内「时间没换算」标记的字段形状(rowVagueQuoteInput 的输入) */
export interface VagueQuoteRowFields {
  /** 行内提醒日期(YYYY-MM-DD;""=不带提醒) */
  remindAt: string;
  /** 服务端标记的「说了时间但没换算」原话子串;无标记为 "" */
  remindVagueQuote: string;
}

/**
 * 行 → create 的可选 remind_vague_quote 参数(纯函数,0.6.0 真机反馈 Fix 4):
 * 行内无日期且带有 vague 标记时返回该子串,否则 undefined 不携带
 * (与 reminder 互斥:用户选了明确日期就不带 vague,与服务端口径一致)。
 */
export function rowVagueQuoteInput(
  row: VagueQuoteRowFields,
): string | undefined {
  if (row.remindAt !== "" || row.remindVagueQuote === "") {
    return undefined;
  }
  return row.remindVagueQuote;
}

/**
 * 行 → create 的可选 reminder 参数(纯函数,PR #52 B3 下沉便于测试):
 * 行内无日期(服务端因归属不明置空 / 用户清过) → undefined 不带提醒,
 * 绝不写入错误归属的提醒;日期仍是原话提取值时才携带 quote
 * (选择器改过的没有原话锚点)。
 */
export function rowReminderInput(
  row: ReminderRowFields,
): ReminderInputOfRow | undefined {
  if (row.remindAt === "" || row.remindKind === "") {
    return undefined;
  }
  return {
    due_date: row.remindAt,
    kind: row.remindKind,
    ...(row.remindAt === row.remindOrigin && row.remindQuote !== ""
      ? { quote: row.remindQuote }
      : {}),
  };
}

/* ---------------- 「放进」挂靠(issue #45 十七轮,#18 红线语义升级) ---------------- */

/** 确认页行上的「放进」字段形状(draftMountPathPreview / saveRowWithMount 的输入) */
export interface RowMountFields {
  /**
   * 「放进」行当前路径(最终提交口径):空数组 = 不显示该行、不挂靠
   * (无预览或未选择)。这是预览的落地形态——点「确认记住」才建路径,
   * 绝不静默建路径。
   */
  mountPath: string[];
  /** 行内固定挂靠幂等键(与 operationId 同批生成;响应丢失重试同内容收敛) */
  mountUpdateId: string;
}

/** 草稿侧「放进」预览的输入形状(宽松:服务端已硬门,客户端只做形状复核) */
export interface DraftMountFields {
  certain?: unknown;
  mount_path?: unknown;
}

/** 与 locations 节点名同限:1-6 段,每段去空白 1-30 码点 */
const MOUNT_PATH_MAX_SEGMENTS = 6;
const MOUNT_SEGMENT_MAX_CODEPOINTS = 30;

function codePointLength(s: string): number {
  return Array.from(s).length;
}

/** 路径段形状复核(纯函数):非数组/超限/含空段或超长段一律不通过,不猜 */
function isValidPathSegments(path: unknown): path is string[] {
  if (!Array.isArray(path) || path.length < 1 || path.length > MOUNT_PATH_MAX_SEGMENTS) {
    return false;
  }
  return path.every(
    (seg) =>
      typeof seg === "string" &&
      codePointLength(seg.trim()) >= 1 &&
      codePointLength(seg.trim()) <= MOUNT_SEGMENT_MAX_CODEPOINTS,
  );
}

/**
 * 草稿 → 「放进」路径预览(纯函数):仅 certain=true 且形状合法才透传,
 * 否则空数组(=确认卡不显示「放进」行,照旧先进「尚未归类」)。
 * 服务端已硬门(certain=false 强制 mount_path null),这里是客户端第二道
 * 门——certain=false 即使带路径也一律丢弃,绝不猜、绝不静默挂。
 */
export function draftMountPathPreview(d: DraftMountFields): string[] {
  if (d.certain !== true || !isValidPathSegments(d.mount_path)) {
    return [];
  }
  return (d.mount_path as string[]).map((seg) => seg.trim());
}

/**
 * locations 选择器回传 → 替换路径(纯函数):只信严格结构
 * (数组、1-6 段、每段非空 ≤30 码点),异常回传返回空数组不写。
 */
export function mountPathFromPick(p: { path?: unknown }): string[] {
  if (!isValidPathSegments(p.path)) {
    return [];
  }
  return (p.path as string[]).map((seg) => seg.trim());
}

/** create 的返回形状(挂靠需要 item_id 与 create 后版本) */
export type CreateReturningItemFn<T> = (
  row: T,
) => Promise<{ item_id: string; version: number }>;

/** 挂靠调用(注入真实 callLocationsApi(ensureAndLink) 或测试替身) */
export type EnsureAndLinkFn = (args: {
  item_id: string;
  expected_version: number;
  path: string[];
  update_id: string;
}) => Promise<void>;

/** saveRowWithMount 结果:mountFailed=true = 物品已保存但挂靠没成(绝不回滚) */
export interface SaveRowWithMountOutcome {
  mountFailed: boolean;
}

/**
 * 单件保存编排(确认卡「确认记住」的落地,#18 红线语义升级):
 * create 成功后,行内带最终「放进」路径才调 ensureAndLink 建路径并挂上
 * (路径已在确认卡明示、用户点确认 = 已确认)。挂靠失败(网络/版本冲突/
 * 跨家庭)绝不回滚已保存物品——物品保留,如实返回 mountFailed 由调用方
 * 提示「先在尚未归类,稍后详情整理」;create 失败原样抛出(行 failed,
 * 原键重试)。批量件各自独立走本编排,一件挂靠失败不影响其余件。
 */
export async function saveRowWithMount<T extends BatchRow & RowMountFields>(
  row: T,
  create: CreateReturningItemFn<T>,
  link: EnsureAndLinkFn,
): Promise<SaveRowWithMountOutcome> {
  const item = await create(row);
  if (row.mountPath.length === 0) {
    return { mountFailed: false };
  }
  try {
    await link({
      item_id: item.item_id,
      expected_version: item.version,
      path: row.mountPath,
      update_id: row.mountUpdateId,
    });
    return { mountFailed: false };
  } catch {
    // 物品已记住:不回滚、不重试、不抛错(行仍是 saved),如实交由调用方提示
    return { mountFailed: true };
  }
}

/** 单行写入(注入真实 create 或测试替身) */
export type CreateFn<T extends BatchRow> = (row: T) => Promise<void>;

/** 每次行状态变化回调(成功 error 为 undefined,失败携带原始异常供调用方分类) */
export type RowUpdateFn<T extends BatchRow> = (row: T, error?: unknown) => void;

/**
 * 逐行保存编排(在传入快照的拷贝上推进,绝不引用调用方可变状态):
 * 勾选且未 saved 的行依次 saving → create → saved/failed;
 * 已保存行跳过;失败行保留原 operation_id 供重试(同键同内容幂等)。
 * 返回推进后的新数组,调用方据此判定收尾(allCheckedSaved/batchSummary)。
 */
export async function runBatchSave<T extends BatchRow>(
  rows: T[],
  create: CreateFn<T>,
  onRowUpdate: RowUpdateFn<T>,
): Promise<T[]> {
  const work = rows.map((r) => ({ ...r }));
  const todo = rowsToSave(work);
  for (const row of todo) {
    row.status = "saving";
    row.failMsg = "";
    onRowUpdate(row);
    try {
      await create(row);
      row.status = "saved";
      onRowUpdate(row);
    } catch (e) {
      row.status = "failed";
      row.failMsg = e instanceof Error && e.message ? e.message : String(e);
      onRowUpdate(row, e);
    }
  }
  return work;
}
