"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rowsToSave = rowsToSave;
exports.firstInvalidMsg = firstInvalidMsg;
exports.allCheckedSaved = allCheckedSaved;
exports.batchSummary = batchSummary;
exports.shouldDefaultChecked = shouldDefaultChecked;
exports.rowReminderInput = rowReminderInput;
exports.runBatchSave = runBatchSave;
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
/**
 * 默认勾选决策(下沉以便测试;PR #48 复审 B3):位置确定的(certain)且有专属
 * 原话证据、锚定不共享才默认勾选。位置没听清的(certain=false)即使有原话证据
 * 也一律不默认勾——「⚠ 位置待核实 + 已勾选」会让整批提交卡在必填校验上;
 * 补充位置后由用户明确勾选(单件 C1b 保留「填了位置自动允许确认」的专用分支,
 * 见确认页 onRowLocationInput)。
 */
function shouldDefaultChecked(sourceQuote, anchorShared, certain) {
    return certain && sourceQuote !== "" && !anchorShared;
}
/**
 * C2 行 → create 的可选 reminder 参数(纯函数,PR #52 B3 下沉便于测试):
 * 行内无日期(服务端因归属不明置空 / 用户清过) → undefined 不带提醒,
 * 绝不写入错误归属的提醒;日期仍是原话提取值时才携带 quote
 * (选择器改过的没有原话锚点)。
 */
function rowReminderInput(row) {
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
/**
 * 逐行保存编排(在传入快照的拷贝上推进,绝不引用调用方可变状态):
 * 勾选且未 saved 的行依次 saving → create → saved/failed;
 * 已保存行跳过;失败行保留原 operation_id 供重试(同键同内容幂等)。
 * 返回推进后的新数组,调用方据此判定收尾(allCheckedSaved/batchSummary)。
 */
async function runBatchSave(rows, create, onRowUpdate) {
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
        }
        catch (e) {
            row.status = "failed";
            row.failMsg = e instanceof Error && e.message ? e.message : String(e);
            onRowUpdate(row, e);
        }
    }
    return work;
}
