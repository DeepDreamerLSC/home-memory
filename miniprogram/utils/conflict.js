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
 *
 * 移植自 PR #12(feat/issue6-conflict-choice),按 main 的 D1 详情页合同扩展:
 * 新详情页编辑折叠里多了「提醒」字段(#36),同样纳入双值对比——提醒值口径为
 * YYYY-MM-DD 日期串,空串 = 不带提醒;提醒写路径走 remindSet/remindClear
 * (expected_generation 轮次号),不进 update 的 changes,见 buildUpdateChanges。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FIELD_LABELS = void 0;
exports.carryUnresolved = carryUnresolved;
exports.mergeLatest = mergeLatest;
exports.chosenValue = chosenValue;
exports.conflictUnresolved = conflictUnresolved;
exports.resolveRemindChoice = resolveRemindChoice;
exports.buildUpdateChanges = buildUpdateChanges;
/** 字段展示名,与详情页表单 label 一致 */
exports.FIELD_LABELS = {
    name: "名称",
    location: "位置",
    note: "备注",
    remind: "提醒",
};
const FIELDS = ["name", "location", "note", "remind"];
/**
 * 运行时容错:旧文档可能缺 note 字段(服务端 project 已兜底为空串,这里再守一层),
 * 非字符串值一律按空串参与比较,保证比较与输出永远是字符串,
 * 避免把 undefined 写回表单导致后续 .trim() 抛错。
 */
function norm(value) {
    return typeof value === "string" ? value : "";
}
/**
 * 刷新后重判冲突时,把上一轮「未选边」的字段留在面板里。
 *
 * 背景:冲突刷新会把基准对齐到远端;此后再次触发冲突刷新(保存 / 改提醒 /
 * 整理位置)时,这些字段会退化成「仅本机修改」而被三方合并静默保留——
 * 面板一收、门禁即失守,用户还没选过,对方的修改就会被无声覆盖。
 * 规则:未选边且本轮未重判为冲突的字段,只要当前表单值与最新远端值仍不一致,
 * 就以两版现值重建冲突条目;已选边的字段不保留(用户已明确表态,按普通编辑
 * 对待);两版值已一致(对方改成了相同值)的字段自然出面板,无需裁决。
 *
 * @param previous 上一轮面板条目(带 choice;choice=null 表示未选边)
 * @param fresh 本轮 mergeLatest 新判出的冲突字段(已在面板里,无需保留旧条目)
 * @param current 当前表单值(local,应与 mergeLatest 的 local 同口径)
 * @param remote 最新远端值(与 mergeLatest 的 remote 同口径;提醒远端不可得的
 *   场景由调用方单独保留原条目,不走本函数)
 */
function carryUnresolved(previous, fresh, current, remote) {
    const carried = [];
    for (const entry of previous) {
        if (entry.choice !== null) {
            continue; // 已显式选边:不再是待裁决冲突
        }
        if (fresh.some((c) => c.key === entry.key)) {
            continue; // 本轮已重判为冲突:沿用新判出的两版值
        }
        const localNow = norm(current[entry.key]);
        const remoteNow = norm(remote[entry.key]);
        if (localNow !== remoteNow) {
            carried.push({
                key: entry.key,
                label: exports.FIELD_LABELS[entry.key],
                localValue: localNow,
                remoteValue: remoteNow,
            });
        }
    }
    return carried;
}
/**
 * 对 base(进页/上次对齐时的基准)、local(用户当前输入)、remote(服务端最新)
 * 逐字段比较。传入的值应已按保存口径 trim(base/remote 为服务端原文;
 * remind 为日期串,空串 = 不带提醒)。
 */
function mergeLatest(base, local, remote) {
    const conflicts = [];
    const merged = { name: "", location: "", note: "", remind: "" };
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
/** 冲突面板是否仍有未选择的字段:页面据此禁用保存(测试同源断言这条门禁) */
function conflictUnresolved(entries) {
    return entries.some((entry) => entry.choice === null);
}
/**
 * 提醒冲突选边后的落地口径:选远端 = 回显远端值即停,不自动再写;
 * 选本地 = 回显用户值,且与最新记录不一致(冲突判定保证)时按既有
 * remindSet(有日期)/remindClear(清空)路径、以刷新后的最新轮次号补写。
 */
function resolveRemindChoice(field, choice) {
    const picked = chosenValue(field, choice);
    if (choice === "remote" || picked === field.remoteValue) {
        return { displayDate: field.remoteValue, writeAction: null, writeDate: "" };
    }
    return {
        displayDate: picked,
        writeAction: picked === "" ? "clear" : "set",
        writeDate: picked,
    };
}
/**
 * 由「当前表单值 vs 基准」计算 update 要提交的 changes:
 * 与详情页保存口径一致——只有与基准不同的字段才提交,全部一致返回空对象(无修改)。
 * 只覆盖 name/location/note 三个文本字段:提醒不在 itemsApi update 合同里
 * (服务端只认 name/location_text/note),提醒的差异走 remindSet/remindClear,
 * 绝不混进 update changes。
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
