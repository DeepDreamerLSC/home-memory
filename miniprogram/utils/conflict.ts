/**
 * 字段级冲突判定(纯函数,无 wx 依赖,供详情页与离线测试共用)。
 *
 * 背景(issue #6):详情页保存触发 VERSION_CONFLICT 后会拉取服务端最新记录。
 * 此前对「两个设备改了同一字段」的场景只做静默三方合并,用户看不到服务端的值,
 * 再次保存即以新版本静默覆盖,不构成「知悉对方修改后的明确选择」。
 * 这里把判定下沉为纯函数:local != base 且 remote != base 且 local != remote
 * 的字段判为冲突,由页面进入冲突态 UI 让用户显式选择;
 * 其余字段维持既有三方合并语义,不做整表单回退。
 */

/** 详情页可编辑字段,与 itemsApi update 的可更新字段一一对应 */
export type EditableField = "name" | "location" | "note";

/** 字段展示名,与详情页表单 label 一致 */
export const FIELD_LABELS: Record<EditableField, string> = {
  name: "名称",
  location: "位置",
  note: "备注",
};

/** 一方(name/location/note)的字段值快照 */
export type FieldValues = Record<EditableField, string>;

/** 冲突字段的用户选择:保留我的修改(local)或采用最新记录(remote) */
export type ConflictChoice = "local" | "remote";

/** 单个冲突字段:并排展示「你的修改」与「最新记录」所需的两版值 */
export type ConflictField = {
  key: EditableField;
  label: string;
  localValue: string;
  remoteValue: string;
};

/** 三方逐字段比较的结果 */
export type MergeOutcome = {
  /** 冲突字段(三方各不相同);为空数组表示无冲突,维持静默三方合并 */
  conflicts: ConflictField[];
  /**
   * 各字段应回填表单的值:冲突字段暂取 local(等待用户显式选择,面板上可选远端);
   * 非冲突字段为三方合并结果——用户改过(local != base)保留 local,否则采纳 remote。
   */
  merged: FieldValues;
};

const FIELDS: EditableField[] = ["name", "location", "note"];

/**
 * 对 base(进页/上次对齐时的基准)、local(用户当前输入)、remote(服务端最新)
 * 逐字段比较。传入的值应已按保存口径 trim(base/remote 为服务端原文)。
 */
export function mergeLatest(
  base: FieldValues,
  local: FieldValues,
  remote: FieldValues
): MergeOutcome {
  const conflicts: ConflictField[] = [];
  const merged: FieldValues = { name: "", location: "", note: "" };
  for (const key of FIELDS) {
    const b = base[key];
    const l = local[key];
    const r = remote[key];
    if (l !== b && r !== b && l !== r) {
      conflicts.push({
        key,
        label: FIELD_LABELS[key],
        localValue: l,
        remoteValue: r,
      });
      merged[key] = l;
    } else {
      merged[key] = l !== b ? l : r;
    }
  }
  return { conflicts, merged };
}

/** 冲突字段的选定值:页面回填表单与测试断言共用同一语义 */
export function chosenValue(
  field: ConflictField,
  choice: ConflictChoice
): string {
  return choice === "local" ? field.localValue : field.remoteValue;
}

/** update 请求的 changes 形态(与 itemsApi update 的可更新字段名一致) */
export type UpdateChanges = {
  name?: string;
  location_text?: string;
  note?: string;
};

/**
 * 由「当前表单值 vs 基准」计算 update 要提交的 changes:
 * 与详情页保存口径一致——只有与基准不同的字段才提交,全部一致返回空对象(无修改)。
 */
export function buildUpdateChanges(
  base: FieldValues,
  current: FieldValues
): UpdateChanges {
  const changes: UpdateChanges = {};
  if (current.name !== base.name) {
    changes.name = current.name;
  }
  if (current.location !== base.location) {
    changes.location_text = current.location;
  }
  if (current.note !== base.note) {
    changes.note = current.note;
  }
  return changes;
}
