"use strict";
/**
 * 拍照识物候选草稿的纯函数状态机(#3,零 wx 依赖):
 * 三态(候选/保留/已确认记住)、qty+suffix 数量备注单一来源、位置例外、
 * 语音受限编辑的逐字段应用、保存最终确认数据派生、计数单一来源、
 * 圈选/语音补录入列工厂。
 *
 * 依据:docs/design/issue3-photo-intake/IMPLEMENTATION.md §4.1(photo-intake ③ 候选行
 * 纯函数)、§5(语音受限编辑契约)、§8(屏级行为基准);
 * 行为逐条对照原型 docs/design/issue3-photo-intake/prototype.html script
 * (V0.4.1:语音只改勾选的字段、勾选状态不被动变更;V0.4.2:qty+suffix 分开存,
 * 步进器与备注单一来源;终审:确认弹层只汇总已勾选物品的例外)。
 *
 * 纪律:
 * - 全部函数纯:入参不被改动,变更返回新对象;draftId/operationId 全程稳定
 *   (锁定、应用、计数一律按 draftId,绝不按行号——行号会因删行重排漂移);
 * - 「已确认记住」(done)是终态:done 行不可再勾选/取消勾选;
 * - 数量(issue #102 Q1 起,Q0-CONTRACT §4.3):qty 是「数量预填提示 → 用户确认值」,
 *   保存时随 photoCommit 的 quantity/unit 字段落库,不再拼进 note;VL qty_note 的
 *   文字部分(suffix)永不解析成 unit(unit 只来自选择器,默认「件」);行上
 *   「待核对」标记直到用户触碰步进器/单位选择器(qtyTouched);
 * - 入列工厂建的新行恒带 unit;**unit 缺席 = pre-Q1 会话恢复的行**,保存层按
 *   冻结载荷旧形态重放(note=×N 拼法、不注入 quantity/unit,E13/B9);
 * - 语音应用绝不改勾选(保留)状态,0 勾选字段不执行。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseIntakeQtyNote = parseIntakeQtyNote;
exports.composeNote = composeNote;
exports.makeAiRow = makeAiRow;
exports.makeVoiceAddedRow = makeVoiceAddedRow;
exports.makeCircleRow = makeCircleRow;
exports.makeManualRow = makeManualRow;
exports.rowStateOf = rowStateOf;
exports.rowStateLabel = rowStateLabel;
exports.boxTagPrefix = boxTagPrefix;
exports.qtyNoteText = qtyNoteText;
exports.quickVerifyRows = quickVerifyRows;
exports.toggleRowChecked = toggleRowChecked;
exports.setRowsChecked = setRowsChecked;
exports.stepRowQty = stepRowQty;
exports.setRowUnit = setRowUnit;
exports.markRowSaved = markRowSaved;
exports.markRowFailed = markRowFailed;
exports.applyDraftEdits = applyDraftEdits;
exports.intakeCounts = intakeCounts;
exports.intakeCountView = intakeCountView;
exports.deriveSaveConfirm = deriveSaveConfirm;
const api_1 = require("./api");
const quantity_1 = require("./quantity");
/** 数量域:1-99(抽不到数字按 1,IMPLEMENTATION.md §4.1 ②) */
const QTY_MIN = 1;
const QTY_MAX = 99;
const DEFAULT_SUFFIX = "备注";
function idOf(genId) {
    return (genId === undefined ? api_1.uuid : genId)();
}
/**
 * AI 的 qty_note → { qty, suffix }(IMPLEMENTATION.md §4.1 ②):
 * - qty = 备注中第一段连续数字(十进制整数),夹到 1-99;抽不到数字 = 1;
 * - suffix = 去掉该段数字后的剩余文本(trim);为空 = 「备注」。
 * 只做机械拆分,绝理解/推算数量语义(数量为 AI 估计,核对更稳)。
 */
function parseIntakeQtyNote(qtyNote) {
    const note = typeof qtyNote === "string" ? qtyNote : "";
    const m = note.match(/\d+/);
    let qty = QTY_MIN;
    let rest = note;
    if (m !== null && m.index !== undefined) {
        qty = clampQty(parseInt(m[0], 10));
        rest = note.slice(0, m.index) + note.slice(m.index + m[0].length);
    }
    const suffix = rest.trim();
    return { qty, suffix: suffix === "" ? DEFAULT_SUFFIX : suffix };
}
function clampQty(v) {
    if (!Number.isFinite(v)) {
        return QTY_MIN;
    }
    return Math.min(QTY_MAX, Math.max(QTY_MIN, Math.floor(v)));
}
/**
 * 拼行内数量备注文案(单一展示来源):
 * `"×" + qty + " " + suffix`,折叠多余空白;suffix 空按「备注」、qty 夹回 1-99 域。
 * 原型行内 meta 即 `×{qty}{suffix}`(V0.4.2:屏幕数字与草稿同一份数据)。
 */
function composeNote(qty, suffix) {
    const q = clampQty(qty);
    const s = (typeof suffix === "string" ? suffix : "").trim();
    return ("×" + q + " " + (s === "" ? DEFAULT_SUFFIX : s))
        .replace(/\s+/g, " ")
        .trim();
}
// ---------- 入列工厂(draftId / operationId 入列即生成,此后全程稳定) ----------
/**
 * AI 识别候选入列(vlRecognize 响应行):
 * AI 预选规则——confidence="high" 默认勾选(保留),mid/low 默认不勾(候选);
 * box 透传(0-1,null=无框整照关联);数量备注过 parseIntakeQtyNote。
 */
function makeAiRow(item, genId) {
    const { qty, suffix } = parseIntakeQtyNote(item.qty_note);
    return {
        draftId: idOf(genId),
        name: item.name,
        qty,
        suffix,
        unit: quantity_1.DEFAULT_UNIT,
        qtyTouched: false,
        exc: null,
        src: "ai",
        confidence: item.confidence,
        box: item.box,
        checked: item.confidence === "high",
        done: false,
        failMsg: "",
        operationId: idOf(genId),
    };
}
/**
 * 语音补遗漏入列(draftEditParse intent="add"):未勾选候选、无框(box=null
 * 整照关联)、src="voice"。confidence 恒 "low"——该行没有 VL 识别依据,
 * 仅保持 PhotoCandidate 形状完整;无框即不参与任何框样式。
 */
function makeVoiceAddedRow(name, qtyNote, genId) {
    const { qty, suffix } = parseIntakeQtyNote(qtyNote);
    return {
        draftId: idOf(genId),
        name,
        qty,
        suffix,
        unit: quantity_1.DEFAULT_UNIT,
        qtyTouched: false,
        exc: null,
        src: "voice",
        confidence: "low",
        box: null,
        checked: false,
        done: false,
        failMsg: "",
        operationId: idOf(genId),
    };
}
/**
 * 圈选补识别入列(屏⑤:点「加进清单」才入列,入列 = 未勾选候选):
 * src="circle"、沿用用户圈选的框(红虚线语义,保存时 source="circle")、
 * 名称/数量备注/置信度取圈选识别结果卡。
 */
function makeCircleRow(item, circledBox, genId) {
    const { qty, suffix } = parseIntakeQtyNote(item.qty_note);
    return {
        draftId: idOf(genId),
        name: item.name,
        qty,
        suffix,
        unit: quantity_1.DEFAULT_UNIT,
        qtyTouched: false,
        exc: null,
        src: "circle",
        confidence: item.confidence,
        box: circledBox,
        checked: false,
        done: false,
        failMsg: "",
        operationId: idOf(genId),
    };
}
/**
 * 手动补录入列(§7.1 VL 不可用降级 / 「＋手动添加物品」行):未勾选候选、
 * 无框(box=null 整照关联)、src="manual"。confidence 恒 "low"——无 VL 依据,
 * 仅保持形状完整;保存时照常绑本批照片(source="vl",box=null)。
 */
function makeManualRow(name, qtyNote, genId) {
    const { qty, suffix } = parseIntakeQtyNote(qtyNote);
    return {
        draftId: idOf(genId),
        name,
        qty,
        suffix,
        unit: quantity_1.DEFAULT_UNIT,
        qtyTouched: false,
        exc: null,
        src: "manual",
        confidence: "low",
        box: null,
        checked: false,
        done: false,
        failMsg: "",
        operationId: idOf(genId),
    };
}
// ---------- 三态流转(原型 toggleRow / updateCounts / syncTag) ----------
/** 行的归一化状态:candidate=候选(未勾)keep=保留(勾选)done=已确认记住 */
function rowStateOf(row) {
    return row.done ? "done" : row.checked ? "keep" : "candidate";
}
/** 行状态徽标文案(原型三态徽标:候选/保留/已记住) */
function rowStateLabel(row) {
    return row.done ? "已记住" : row.checked ? "保留" : "候选";
}
/** 照片框标签前缀(原型 syncTag:框标签与清单状态单一来源同步) */
function boxTagPrefix(row) {
    return row.done ? "已记住·" : row.checked ? "保留·" : "候选·";
}
/** 行内数量备注文案(×N 后缀;步进器改 qty 后文案随之更新,同一份数据) */
function qtyNoteText(row) {
    return composeNote(row.qty, row.suffix);
}
/**
 * 勾选/取消勾选(候选 ↔ 保留):done 行不可再变更(原型 toggleRow 对 done 直接
 * 返回);qty/draftId 等一切其他字段不动。
 */
/**
 * 快速核实(真机反馈 2026-10-17:逐件勾选繁琐):一键批量设定勾选状态。
 * mode:"all"=全部保留 | "high"=只保留高可信(confidence==="high")| "none"=清空;
 * done 行是终态(已入库)永不动;返回新数组(纯函数,与 setRowsChecked(全量布尔)互补)。
 */
function quickVerifyRows(rows, mode) {
    return rows.map((r) => r.done
        ? r
        : { ...r, checked: mode === "all" ? true : mode === "high" ? r.confidence === "high" : false });
}
function toggleRowChecked(row) {
    if (row.done) {
        return row;
    }
    return { ...row, checked: !row.checked };
}
/** 全选 / 清空:只动未 done 行,已确认记住的行不受影响(§8) */
function setRowsChecked(rows, checked) {
    return rows.map((r) => (r.done ? r : { ...r, checked }));
}
/**
 * 数量步进器(±1):下限 1(原型 step 的 Math.max(1,…)),上限夹 99(与
 * parseIntakeQtyNote 的 qty 域一致);不改勾选态、draftId、operationId。
 * 步进值落在域内不变时返回原引用(无变更)。用户触碰步进器 = 数量确认
 * (issue #102 Q1):qtyTouched 置 true,行上「待核对」标记随之消失。
 */
function stepRowQty(row, delta) {
    const next = clampQty(row.qty + delta);
    if (next === row.qty && row.qtyTouched === true) {
        return row;
    }
    return { ...row, qty: next, qtyTouched: true };
}
/**
 * 单位选择器切换(issue #102 Q1):unit 只来自用户的选择器选择(UNIT_SET 闭集,
 * 默认「件」);闭集外值原样返回绝不写入(防御)。触碰选择器同样是数量确认
 * (qtyTouched=true),行上「待核对」标记随之消失。
 */
function setRowUnit(row, unit) {
    if (!(0, quantity_1.isUnit)(unit) || unit === row.unit) {
        return row;
    }
    return { ...row, unit, qtyTouched: true };
}
/** photoCommit 该行成功 → 「已确认记住」(终态) */
function markRowSaved(row) {
    return { ...row, done: true, failMsg: "" };
}
/** photoCommit 该行失败:保留候选/保留态与原 operationId(可单行重试),只记失败文案 */
function markRowFailed(row, failMsg) {
    return { ...row, done: false, failMsg: typeof failMsg === "string" && failMsg !== "" ? failMsg : "保存失败,可重试" };
}
// ---------- 语音受限编辑(屏③ diff sheet 的逐字段应用,§5) ----------
/**
 * 应用 diff sheet 勾选的字段编辑(原型 applyDiff,V0.4.1 修复项):
 * - 只应用 pickedFields 里勾选的编辑行(0 勾选 = 不执行,返回原行引用);
 * - name → 改名;qty_note → 过 parseIntakeQtyNote 得 qty+suffix;
 *   location → 设该件位置例外(exc=new,不继承批次位置);
 * - 应用 ≥1 处后 src 置 "voice"(行/框标签同步由页面重渲染);
 * - **绝不改勾选(保留)状态**,也不动 done/failMsg/draftId/operationId/box;
 * - 白名单外的 field 一律跳过(服务端已有硬门,此处防御)。
 */
function applyDraftEdits(row, edits, pickedFields) {
    const picked = new Set(pickedFields);
    let next = null;
    let applied = 0;
    for (const e of edits) {
        if (e === null || typeof e !== "object") {
            continue;
        }
        if (e.field !== "name" && e.field !== "qty_note" && e.field !== "location") {
            continue;
        }
        if (!picked.has(e.field)) {
            continue;
        }
        const value = typeof e.new === "string" ? e.new.trim() : "";
        if (value === "") {
            continue; // 服务端硬门保证非空;防御性跳过,绝不写空值
        }
        if (next === null) {
            next = { ...row };
        }
        if (e.field === "name") {
            next.name = value;
        }
        else if (e.field === "qty_note") {
            const parsed = parseIntakeQtyNote(value);
            next.qty = parsed.qty;
            next.suffix = parsed.suffix;
        }
        else {
            next.exc = value; // 位置例外:只改这一件的位置,不碰其他字段/其他行
        }
        applied++;
    }
    if (applied === 0 || next === null) {
        return { row, applied: 0 }; // 0 勾选 = 不执行(引用不变,可被 toBe 断言)
    }
    next.src = "voice";
    return { row: next, applied };
}
/** 计数的唯一数值来源:头部文案、保存按钮、确认弹层都从这组数派生 */
function intakeCounts(rows) {
    let keep = 0;
    let done = 0;
    let unchecked = 0;
    for (const r of rows) {
        if (r.done) {
            done++;
        }
        else if (r.checked) {
            keep++;
        }
        else {
            unchecked++;
        }
    }
    return { total: rows.length, keep, done, unchecked };
}
/** 计数的展示形态(原型 updateCounts 的两条头部/按钮文案,含 0 勾选禁用)。
 * 计数词一律「条」(记录条数,Q0-CONTRACT §10.1):「件」自 Q1 起是 UNIT_SET
 * 真实单位,不再借用作计数词,避免与逐件行「×3包」同屏时误读为单位。 */
function intakeCountView(rows) {
    const c = intakeCounts(rows);
    if (c.done > 0) {
        return {
            headText: "已确认记住 " + c.done + " 条 · 本批完成",
            saveText: "✓ 已入库",
            saveDisabled: true,
        };
    }
    return {
        headText: "保留 " + c.keep + " / " + c.total + "(待核对)",
        saveText: "存 " + c.keep + " 条",
        saveDisabled: c.keep === 0,
    };
}
/**
 * 派生保存最终确认弹层的全部数据(原型 confirmSave):
 * - 例外只汇总 checked && !done && exc 非空的行(V0.4.2 终审:未保留候选不进确认清单);
 * - 汇总件数按未 done 行计(有 done 行时保存入口本身已禁用,数值仍如实给出);
 * - 纯派生:不改任何行。
 */
function deriveSaveConfirm(rows, batchLocation) {
    const c = intakeCounts(rows);
    const exceptions = [];
    rows.forEach((r, i) => {
        if (r.done || !r.checked) {
            return;
        }
        const exc = typeof r.exc === "string" ? r.exc.trim() : "";
        if (exc === "") {
            return;
        }
        exceptions.push({ index: i + 1, draftId: r.draftId, name: r.name, exc });
    });
    const exceptionLines = exceptions.map((e) => "📍 #d" + e.index + " " + e.name + " → " + e.exc);
    return {
        batchLocation,
        total: c.total,
        keepCount: c.keep,
        skipCount: c.unchecked,
        doneCount: c.done,
        saveDisabled: c.done > 0 || c.keep === 0,
        hasExceptions: exceptions.length > 0,
        exceptions,
        exceptionLines,
        exceptionText: exceptions.length > 0
            ? exceptionLines.join("\n")
            : "无例外,全部继承本批位置",
        summaryText: "保留 " + c.keep + " 条写入 · 未勾选 " + c.unchecked + " 条不保存",
    };
}
