"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rowsToSave = rowsToSave;
exports.firstInvalidMsg = firstInvalidMsg;
exports.allCheckedSaved = allCheckedSaved;
exports.batchSummary = batchSummary;
exports.shouldDefaultChecked = shouldDefaultChecked;
exports.rowVagueQuoteInput = rowVagueQuoteInput;
exports.rowReminderInput = rowReminderInput;
exports.draftMountPathPreview = draftMountPathPreview;
exports.mountPathFromPick = mountPathFromPick;
exports.saveRowWithMount = saveRowWithMount;
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
 * 行 → create 的可选 remind_vague_quote 参数(纯函数,0.6.0 真机反馈 Fix 4):
 * 行内无日期且带有 vague 标记时返回该子串,否则 undefined 不携带
 * (与 reminder 互斥:用户选了明确日期就不带 vague,与服务端口径一致)。
 */
function rowVagueQuoteInput(row) {
    if (row.remindAt !== "" || row.remindVagueQuote === "") {
        return undefined;
    }
    return row.remindVagueQuote;
}
/**
 * 行 → create 的可选 reminder 参数(纯函数,PR #52 B3 下沉便于测试):
 * 行内无日期(服务端因归属不明置空 / 用户清过) → undefined 不带提醒,
 * 绝不写入错误归属的提醒;日期仍是原话提取值(或换算候选值)时才携带 quote
 * (选择器改过的没有原话锚点);remind_converted(三件 A 换算标记)与 quote
 * 同条件携带——仅「行是换算候选且日期没被用户改过」时为 true。
 */
function rowReminderInput(row) {
    if (row.remindAt === "" || row.remindKind === "") {
        return undefined;
    }
    const anchored = row.remindAt === row.remindOrigin && row.remindQuote !== "";
    return {
        due_date: row.remindAt,
        kind: row.remindKind,
        ...(anchored
            ? {
                quote: row.remindQuote,
                ...(row.remindConverted ? { remind_converted: true } : {}),
            }
            : {}),
    };
}
/** 与 locations 节点名同限:1-6 段,每段去空白 1-30 码点 */
const MOUNT_PATH_MAX_SEGMENTS = 6;
const MOUNT_SEGMENT_MAX_CODEPOINTS = 30;
function codePointLength(s) {
    return Array.from(s).length;
}
/** 路径段形状复核(纯函数):非数组/超限/含空段或超长段一律不通过,不猜 */
function isValidPathSegments(path) {
    if (!Array.isArray(path) || path.length < 1 || path.length > MOUNT_PATH_MAX_SEGMENTS) {
        return false;
    }
    return path.every((seg) => typeof seg === "string" &&
        codePointLength(seg.trim()) >= 1 &&
        codePointLength(seg.trim()) <= MOUNT_SEGMENT_MAX_CODEPOINTS);
}
/**
 * 草稿 → 「放进」路径预览(纯函数):仅 certain=true 且形状合法才透传,
 * 否则空数组(=确认卡不显示「放进」行,照旧先进「尚未归类」)。
 * 服务端已硬门(certain=false 强制 mount_path null),这里是客户端第二道
 * 门——certain=false 即使带路径也一律丢弃,绝不猜、绝不静默挂。
 */
function draftMountPathPreview(d) {
    if (d.certain !== true || !isValidPathSegments(d.mount_path)) {
        return [];
    }
    return d.mount_path.map((seg) => seg.trim());
}
/**
 * locations 选择器回传 → 替换路径(纯函数):只信严格结构
 * (数组、1-6 段、每段非空 ≤30 码点),异常回传返回空数组不写。
 */
function mountPathFromPick(p) {
    if (!isValidPathSegments(p.path)) {
        return [];
    }
    return p.path.map((seg) => seg.trim());
}
/**
 * 单件保存编排(确认卡「确认记住」的落地,#18 红线语义升级):
 * create 成功后,行内带最终「放进」路径才调 ensureAndLink 建路径并挂上
 * (路径已在确认卡明示、用户点确认 = 已确认)。挂靠失败(网络/版本冲突/
 * 跨家庭)绝不回滚已保存物品——物品保留,如实返回 mountFailed 由调用方
 * 提示「先在尚未归类,稍后详情整理」;create 失败原样抛出(行 failed,
 * 原键重试)。批量件各自独立走本编排,一件挂靠失败不影响其余件。
 */
async function saveRowWithMount(row, create, link) {
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
    }
    catch {
        // 物品已记住:不回滚、不重试、不抛错(行仍是 saved),如实交由调用方提示
        return { mountFailed: true };
    }
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
