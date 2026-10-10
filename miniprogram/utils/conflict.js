"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FIELD_LABELS = void 0;
exports.mergeLatest = mergeLatest;
exports.chosenValue = chosenValue;
exports.buildUpdateChanges = buildUpdateChanges;
/** 字段展示名,与详情页表单 label 一致 */
exports.FIELD_LABELS = {
    name: "名称",
    location: "位置",
    note: "备注",
};
const FIELDS = ["name", "location", "note"];
/**
 * 运行时容错:旧文档可能缺 note 字段(服务端 project 已兜底为空串,这里再守一层),
 * 非字符串值一律按空串参与比较,保证比较与输出永远是字符串,
 * 避免把 undefined 写回表单导致后续 .trim() 抛错。
 */
function norm(value) {
    return typeof value === "string" ? value : "";
}
/**
 * 对 base(进页/上次对齐时的基准)、local(用户当前输入)、remote(服务端最新)
 * 逐字段比较。传入的值应已按保存口径 trim(base/remote 为服务端原文)。
 */
function mergeLatest(base, local, remote) {
    const conflicts = [];
    const merged = { name: "", location: "", note: "" };
    for (const key of FIELDS) {
        const b = norm(base[key]);
        const l = norm(local[key]);
        const r = norm(remote[key]);
        if (l !== b && r !== b && l !== r) {
            conflicts.push({
                key,
                label: exports.FIELD_LABELS[key],
                localValue: l,
                remoteValue: r,
            });
            merged[key] = l;
        }
        else {
            merged[key] = l !== b ? l : r;
        }
    }
    return { conflicts, merged };
}
/** 冲突字段的选定值:页面回填表单与测试断言共用同一语义 */
function chosenValue(field, choice) {
    return choice === "local" ? field.localValue : field.remoteValue;
}
/**
 * 由「当前表单值 vs 基准」计算 update 要提交的 changes:
 * 与详情页保存口径一致——只有与基准不同的字段才提交,全部一致返回空对象(无修改)。
 */
function buildUpdateChanges(base, current) {
    const changes = {};
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
