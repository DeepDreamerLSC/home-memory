"use strict";
/*
 * 批量保存的行状态纯函数(确认页接线,逻辑下沉便于测试):
 * 「一次确认」只是交互上的一次操作,不是数据库原子事务——
 * 每行独立走 create 幂等(行内固定 operation_id),失败可单行重试,
 * 已保存的行不再提交。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rowsToSave = rowsToSave;
exports.firstInvalidMsg = firstInvalidMsg;
exports.allCheckedSaved = allCheckedSaved;
exports.batchSummary = batchSummary;
/** 待保存的行:勾选且未 saved(首次 pending 与重试 failed 都算) */
function rowsToSave(rows) {
    return rows.filter((r) => r.checked && r.status !== "saved");
}
/** 校验必填:返回第一个不合规行的人类可读提示,合规返回空串 */
function firstInvalidMsg(rows) {
    for (const r of rows) {
        if (!r.checked)
            continue;
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
function allCheckedSaved(rows) {
    return rows.every((r) => !r.checked || r.status === "saved");
}
/** 汇总(按钮文案与结果反馈用) */
function batchSummary(rows) {
    let checked = 0;
    let saved = 0;
    let failed = 0;
    for (const r of rows) {
        if (!r.checked)
            continue;
        checked += 1;
        if (r.status === "saved")
            saved += 1;
        if (r.status === "failed")
            failed += 1;
    }
    return { total: rows.length, checked, saved, failed };
}
