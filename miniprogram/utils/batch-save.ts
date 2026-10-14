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
