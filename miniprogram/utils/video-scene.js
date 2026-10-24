"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCENE_HIGHLIGHT_WINDOW_MS = exports.SCENE_HIGHLIGHTS_MAX = exports.SCENE_ITEMS_MAX = void 0;
exports.planSceneFrames = planSceneFrames;
exports.sceneFrameTotal = sceneFrameTotal;
exports.scanSceneVideo = scanSceneVideo;
exports.groupSceneObservations = groupSceneObservations;
exports.newSceneDraft = newSceneDraft;
exports.stepDraftQty = stepDraftQty;
exports.setDraftUnit = setDraftUnit;
exports.createDraftsFromObservations = createDraftsFromObservations;
exports.mergeSceneDrafts = mergeSceneDrafts;
exports.splitSceneDraft = splitSceneDraft;
exports.observationHighlight = observationHighlight;
exports.buildDraftHighlights = buildDraftHighlights;
exports.buildSceneCommitItems = buildSceneCommitItems;
exports.sceneConfidenceText = sceneConfidenceText;
exports.sceneHighlightCount = sceneHighlightCount;
const api_1 = require("./api");
const item_match_1 = require("./item-match");
const quantity_1 = require("./quantity");
const video_target_1 = require("./video-target");
exports.SCENE_ITEMS_MAX = 12;
exports.SCENE_HIGHLIGHTS_MAX = 8;
exports.SCENE_HIGHLIGHT_WINDOW_MS = 1500;
function planSceneFrames(durationMs) {
    return (0, video_target_1.buildFramePlan)(durationMs, { supplemental: true }).slice(0, 8);
}
/** L2 断点续扫:同一视频的帧计划确定性生成,总帧数单一来源(恢复判定用) */
function sceneFrameTotal(durationMs) {
    return planSceneFrames(durationMs).length;
}
function sceneError(error) {
    if ((0, video_target_1.isVideoTargetError)(error))
        return error.message;
    if (error && typeof error === "object") {
        const msg = error.message;
        if (typeof msg === "string" && msg.length > 0)
            return msg;
    }
    return "场景识别失败";
}
function observationId() {
    return "obs-" + (0, api_1.uuid)();
}
function normalizeBox(box) {
    if (box === null || box === undefined)
        return null;
    const vals = [box.x1, box.y1, box.x2, box.y2];
    if (vals.every((v) => typeof v === "number" && Number.isFinite(v)) === false)
        return null;
    if (box.x1 < 0 || box.y1 < 0 || box.x2 > 1 || box.y2 > 1)
        return null;
    if (box.x1 >= box.x2 || box.y1 >= box.y2)
        return null;
    return { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 };
}
async function scanSceneVideo(options) {
    const plans = planSceneFrames(options.durationMs);
    const observations = [];
    const failures = [];
    const truncatedFrames = [];
    if (plans.length === 0) {
        return { ok: false, kind: "extract_failed", message: "视频时长无效", observations, failures };
    }
    let session;
    try {
        session = options.session || (0, video_target_1.createVideoFrameSession)(options.source, { durationMs: options.durationMs });
    }
    catch (e) {
        const kind = (0, video_target_1.isVideoTargetError)(e) && e.code === "unsupported" ? "unsupported" : "extract_failed";
        return { ok: false, kind, message: sceneError(e), observations, failures };
    }
    let scanned = 0;
    const skip = new Set(options.skipFrameIndexes ? options.skipFrameIndexes : []);
    for (let i = 0; i < plans.length; i++) {
        if (session.cancelled) {
            return { ok: false, kind: "cancelled", message: "场景识别已取消", observations, failures };
        }
        const plan = plans[i];
        if (skip.has(plan.frameIndex)) {
            // L2 断点续扫:已完成帧(含零候选)不再抽帧、不再调 VL,只计入进度
            scanned += 1;
            if (options.onProgress)
                options.onProgress(scanned, plans.length, failures.length);
            continue;
        }
        try {
            const frame = await session.captureAt(plan.timeMs, plan.frameIndex);
            if (session.cancelled) {
                return { ok: false, kind: "cancelled", message: "场景识别已取消", observations, failures };
            }
            const result = await options.callRecognize({
                image_base64: frame.base64,
                img_w: frame.width,
                img_h: frame.height,
            });
            scanned += 1;
            if (result.ok !== true) {
                failures.push({ frameIndex: plan.frameIndex, timeMs: plan.timeMs, message: result.message || result.error || "AI 识别暂不可用" });
                if (options.onFrameDone)
                    options.onFrameDone({ frameIndex: plan.frameIndex, ok: false, truncated: false, observations: [] });
            }
            else {
                if (result.truncated === true)
                    truncatedFrames.push(plan.frameIndex);
                const frameObservations = [];
                for (const item of result.items) {
                    const name = typeof item.name === "string" ? item.name.trim() : "";
                    if (name === "")
                        continue;
                    const observation = {
                        obsId: observationId(),
                        frameIndex: frame.frameIndex,
                        timeMs: frame.timeMs,
                        windowStartMs: plan.windowStartMs,
                        windowEndMs: plan.windowEndMs,
                        framePath: frame.path,
                        frameWidth: frame.width,
                        frameHeight: frame.height,
                        name,
                        qtyNote: typeof item.qty_note === "string" ? item.qty_note : "",
                        confidence: item.confidence === "high" || item.confidence === "mid" || item.confidence === "low" ? item.confidence : "low",
                        box: normalizeBox(item.box),
                    };
                    observations.push(observation);
                    frameObservations.push(observation);
                    if (options.onObservation)
                        options.onObservation(observation);
                }
                // 零候选帧也回调 ok=true(完成标记与观察存在性解耦,见 SceneFrameDone)
                if (options.onFrameDone) {
                    options.onFrameDone({
                        frameIndex: plan.frameIndex,
                        ok: true,
                        truncated: result.truncated === true,
                        observations: frameObservations,
                    });
                }
            }
        }
        catch (e) {
            if (session.cancelled || ((0, video_target_1.isVideoTargetError)(e) && e.code === "cancelled")) {
                return { ok: false, kind: "cancelled", message: "场景识别已取消", observations, failures };
            }
            failures.push({ frameIndex: plan.frameIndex, timeMs: plan.timeMs, message: sceneError(e) });
            if (options.onFrameDone)
                options.onFrameDone({ frameIndex: plan.frameIndex, ok: false, truncated: false, observations: [] });
        }
        if (options.onProgress)
            options.onProgress(scanned, plans.length, failures.length);
    }
    return {
        ok: true,
        observations,
        framesTotal: plans.length,
        framesScanned: scanned,
        failures,
        truncatedFrames,
        manualFallback: observations.length === 0,
    };
}
/**
 * 分组键(R0 契约 §1.1):委托 item-match 的 normalizeForMatch——与五级匹配
 * 同一口径(trim → NFKC → 小写 → 删空白 → 删常见标点)。「同名」只有一种定义:
 * 全半角(Ｍａｇ≡Mag)、空白与常见标点差异(充电器、≡充电器)归同键。
 * 这是字符级规范化,不是同义词归并;模糊匹配(isFuzzyMatch)不进分组。
 * 键为空(名称仅由标点/空白构成)由调用方回退 obsId 各成单条组。
 */
function nameKeyOf(name) {
    return (0, item_match_1.normalizeForMatch)(name);
}
function groupSceneObservations(observations) {
    const groups = new Map();
    for (const obs of observations) {
        const key = nameKeyOf(obs.name) || obs.obsId;
        const prev = groups.get(key);
        if (prev === undefined) {
            groups.set(key, { nameKey: key, label: obs.name, observations: [obs] });
        }
        else {
            prev.observations.push(obs);
        }
    }
    return Array.from(groups.values());
}
function newSceneDraft(partial) {
    return {
        draftKey: partial?.draftKey || (0, api_1.uuid)(),
        observationIds: partial?.observationIds ? partial.observationIds.slice() : [],
        manualHighlights: partial?.manualHighlights ? partial.manualHighlights.map((h) => ({ ...h })) : [],
        name: partial?.name || "",
        target: partial?.target || "new",
        operationId: partial?.operationId || (0, api_1.uuid)(),
        itemId: partial?.itemId || "",
        locationText: partial?.locationText || "",
        note: partial?.note || "",
        checked: partial?.checked !== false,
        quantity: partial?.quantity,
        unit: partial?.unit,
    };
}
/**
 * 草稿行数量步进(issue #102 Q3,Q0-CONTRACT §9.1):quantity 只来自用户触碰
 * (±1 起步值 1,钳 1..9999),首触同时补默认单位「件」——quantity/unit 成组,
 * 绝不发出 unit 单独在场的载荷。非整数步进无效返回原引用。步进值永不由
 * observationIds/highlights 条数推导(6 条线索 ≠ 6 件)。
 */
function stepDraftQty(draft, delta) {
    if (typeof delta !== "number" || Number.isInteger(delta) === false || delta === 0) {
        return draft;
    }
    const base = typeof draft.quantity === "number" ? draft.quantity : 1;
    const next = Math.min(9999, Math.max(1, base + delta));
    if (next === draft.quantity && draft.unit !== undefined) {
        return draft;
    }
    return {
        ...draft,
        quantity: next,
        unit: draft.unit !== undefined ? draft.unit : "件",
    };
}
/**
 * 草稿行单位选择(issue #102 Q3):unit 只来自选择器(UNIT_SET 闭集),闭集外
 * 值原样返回绝不写入;只选单位也把数量落成 1(成组,服务端永不收半对)。
 */
function setDraftUnit(draft, unit) {
    if (typeof unit !== "string" || quantity_1.UNIT_SET.indexOf(unit) === -1) {
        return draft;
    }
    if (unit === draft.unit && draft.quantity !== undefined) {
        return draft;
    }
    return {
        ...draft,
        unit,
        quantity: typeof draft.quantity === "number" ? draft.quantity : 1,
    };
}
/**
 * 把用户选中的 observation 生成草稿。
 * mergeSameName===false（默认）：一条观察一个草稿，同名也分开，符合“同名绝不自动合并”。
 * mergeSameName===true：用户显式开启后，才按显示名归组为一个草稿。
 */
function createDraftsFromObservations(observations, selectedIds, options) {
    const wanted = new Set(selectedIds);
    const selected = observations.filter((o) => wanted.has(o.obsId));
    if (options?.mergeSameName === true) {
        const groups = new Map();
        for (const obs of selected) {
            const key = nameKeyOf(obs.name) || obs.obsId;
            const list = groups.get(key);
            if (list === undefined)
                groups.set(key, [obs]);
            else
                list.push(obs);
        }
        return Array.from(groups.values()).map((list) => newSceneDraft({
            observationIds: list.map((o) => o.obsId),
            name: list[0].name,
            locationText: options?.batchLocation || "",
            checked: true,
        }));
    }
    return selected.map((obs) => newSceneDraft({
        observationIds: [obs.obsId],
        name: obs.name,
        locationText: options?.batchLocation || "",
        checked: true,
    }));
}
/**
 * 用户显式合并多个草稿为一件；observation 不重复，仍保留各自 highlight。
 * 数量纪律(issue #102 Q3):合并 = 新的物品身份,原草稿上用户确认过的数量
 * 不求和、不取线索数——数量/单位一律重置为缺席,由用户在合成行上重新确认
 * (L1:quantity 只来自用户确认;线索数永不赋值数量)。
 */
function mergeSceneDrafts(drafts, draftKeys) {
    const wanted = new Set(draftKeys);
    const picked = drafts.filter((d) => wanted.has(d.draftKey));
    if (picked.length < 2)
        return null;
    if (picked.some((d) => d.target === "existing"))
        return null;
    const obsIds = [];
    const manual = [];
    for (const d of picked) {
        for (const id of d.observationIds)
            if (obsIds.indexOf(id) === -1)
                obsIds.push(id);
        for (const h of d.manualHighlights)
            manual.push({ ...h });
    }
    const first = picked[0];
    // quantity/unit 刻意不透传:合成行数量必须重新确认(见函数头注释)
    return newSceneDraft({
        draftKey: first.draftKey,
        operationId: first.operationId,
        name: first.name,
        locationText: first.locationText,
        note: first.note,
        observationIds: obsIds,
        manualHighlights: manual,
        checked: true,
    });
}
/**
 * 用户显式把一件拆成多件。每个 observation 一件；手动补的高亮也各自一件。
 * 同名是允许的，新 draft 拥有独立 operation_id，提交后是独立 item_id。
 * 数量纪律(issue #102 Q3):原草稿的数量是对「这一组」的断言,拆开即失效——
 * 拆分行一律不带数量(逐行重新确认);observationIds/高亮/时间窗各自保留。
 */
function splitSceneDraft(draft) {
    if (draft.observationIds.length + draft.manualHighlights.length <= 1)
        return [draft];
    const out = draft.observationIds.map((obsId) => newSceneDraft({
        name: draft.name,
        locationText: draft.locationText,
        note: draft.note,
        observationIds: [obsId],
        checked: true,
    }));
    for (const h of draft.manualHighlights) {
        out.push(newSceneDraft({
            name: draft.name,
            locationText: draft.locationText,
            note: draft.note,
            manualHighlights: [{ ...h }],
            checked: true,
        }));
    }
    return out;
}
function clampHighlight(input, durationMs) {
    const duration = Math.floor(durationMs);
    if (Number.isFinite(duration) === false || duration < 1)
        return null;
    let start = Math.max(0, Math.min(duration - 1, Math.floor(input.start_ms)));
    let end = Math.min(duration, Math.floor(input.end_ms));
    if (end <= start)
        end = Math.min(duration, start + 1);
    if (end <= start) {
        start = Math.max(0, duration - 1);
        end = duration;
    }
    if (end <= start)
        return null;
    const box = input.box === null ? null : normalizeBox(input.box);
    if (input.box !== null && box === null)
        return null;
    const out = { start_ms: start, end_ms: end, box };
    const frameMs = input.frame_ms === undefined ? start : Math.floor(input.frame_ms);
    out.frame_ms = Math.max(start, Math.min(end - 1, frameMs));
    return out;
}
/** 一个 observation → 一条用户确认高亮；start 是代表帧，框对应 start。 */
function observationHighlight(observation, durationMs) {
    const duration = Math.max(1, Math.floor(durationMs));
    const start = Math.max(0, Math.min(duration - 1, Math.floor(observation.timeMs)));
    const end = Math.min(duration, start + exports.SCENE_HIGHLIGHT_WINDOW_MS);
    return {
        start_ms: start,
        end_ms: end > start ? end : duration,
        box: observation.box === null ? null : { ...observation.box },
        frame_ms: start,
    };
}
function buildDraftHighlights(draft, observations, durationMs) {
    const byId = new Map(observations.map((o) => [o.obsId, o]));
    const out = [];
    const seen = new Set();
    for (const id of draft.observationIds) {
        const obs = byId.get(id);
        if (obs === undefined)
            continue;
        const cleaned = clampHighlight(observationHighlight(obs, durationMs), durationMs);
        if (cleaned === null)
            continue;
        const key = JSON.stringify(cleaned);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(cleaned);
    }
    for (const raw of draft.manualHighlights) {
        const cleaned = clampHighlight(raw, durationMs);
        if (cleaned === null)
            continue;
        const key = JSON.stringify(cleaned);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(cleaned);
    }
    out.sort((a, b) => (a.start_ms !== b.start_ms ? a.start_ms - b.start_ms : a.end_ms - b.end_ms));
    return out;
}
function buildSceneCommitItems(drafts, observations, durationMs) {
    const picked = drafts.filter((d) => d.checked);
    if (picked.length < 1)
        return { ok: false, message: "请至少勾选一件物品" };
    if (picked.length > exports.SCENE_ITEMS_MAX)
        return { ok: false, message: "一次最多确认 " + exports.SCENE_ITEMS_MAX + " 件，请分批处理" };
    const existingSeen = new Set();
    const items = [];
    for (const draft of picked) {
        const name = draft.name.trim();
        const location = draft.locationText.trim();
        const highlights = buildDraftHighlights(draft, observations, durationMs);
        if (highlights.length < 1)
            return { ok: false, message: name ? "「" + name + "」还没有可确认的高亮" : "有一件物品还没有可确认的高亮" };
        if (highlights.length > exports.SCENE_HIGHLIGHTS_MAX)
            return { ok: false, message: "单件最多 " + exports.SCENE_HIGHLIGHTS_MAX + " 条高亮，请取消多余线索后再保存" };
        if (draft.target === "existing") {
            if (draft.itemId === "")
                return { ok: false, message: "请选择要关联的已有物品" };
            if (existingSeen.has(draft.itemId))
                return { ok: false, message: "同一件已有物品不能在一次提交中出现两次" };
            existingSeen.add(draft.itemId);
            // 数量字段刻意不携带(E7 边界):existing 关联不碰数量,数量变更只走
            // update/quantityAdjust 的 CAS 路径;即便草稿行残留数量也绝不进载荷
            items.push({
                draft_key: draft.draftKey,
                target: "existing",
                item_id: draft.itemId,
                highlights,
            });
        }
        else {
            if (name === "")
                return { ok: false, message: "请给每件新物品填写名称" };
            if (location === "")
                return { ok: false, message: "请给每件新物品填写位置" };
            if (draft.operationId === "")
                return { ok: false, message: "草稿参数异常，请重试" };
            // 数量/单位(issue #102 Q3,Q0-CONTRACT §4.4/§9.1):只透传用户在草稿行
            // 显式确认的值;缺席 = 不带键(服务端缺省 1/件,签名与现行逐字节一致)。
            // observationIds/highlights 条数永不赋值数量——形状门 fail-closed 整批拒绝。
            if (draft.quantity !== undefined) {
                if ((0, quantity_1.isValidCreateQuantity)(draft.quantity) === false) {
                    return { ok: false, message: "「" + name + "」的数量需为 1-9999 的整数" };
                }
                if ((0, quantity_1.isUnit)(draft.unit) === false) {
                    return { ok: false, message: "「" + name + "」的单位无效，请重新选择" };
                }
            }
            else if (draft.unit !== undefined) {
                return { ok: false, message: "「" + name + "」的数量还没确认，请先核对数量" };
            }
            const item = {
                draft_key: draft.draftKey,
                target: "new",
                operation_id: draft.operationId,
                name,
                location_text: location,
                note: draft.note.trim(),
                highlights,
            };
            if (draft.quantity !== undefined) {
                item.quantity = draft.quantity;
                item.unit = draft.unit;
            }
            items.push(item);
        }
    }
    return { ok: true, items };
}
/** 视图辅助：确认页只展示，不代表服务端状态。 */
function sceneConfidenceText(confidence) {
    if (confidence === "high")
        return "较有把握";
    if (confidence === "mid")
        return "可能";
    return "不确定";
}
function sceneHighlightCount(draft, observations, durationMs) {
    return buildDraftHighlights(draft, observations, durationMs).length;
}
