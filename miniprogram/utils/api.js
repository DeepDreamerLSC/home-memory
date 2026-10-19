"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiError = exports.CLIENT_BAD_RESPONSE = exports.CLIENT_NETWORK = exports.CLIENT_TIMEOUT = void 0;
exports.isApiError = isApiError;
exports.callItemsApi = callItemsApi;
exports.callExtractDraft = callExtractDraft;
exports.callDraftEditParse = callDraftEditParse;
exports.callLocationSplit = callLocationSplit;
exports.uuid = uuid;
exports.formatDateTime = formatDateTime;
exports.errorMessage = errorMessage;
const locations_cache_1 = require("./locations-cache");
const household_scope_1 = require("./household-scope");
const households_api_1 = require("./households-api");
const batch_save_1 = require("./batch-save");
const ITEMS_API_FUNCTION = "itemsApi";
const EXTRACT_DRAFT_FUNCTION = "extractDraft";
/** itemsApi 为薄适配层,正常应在数秒内返回 */
const ITEMS_API_TIMEOUT_MS = 15000;
/** extractDraft 服务端 LLM 超时 20 秒,客户端放宽到 30 秒,优先让服务端错误回来 */
const EXTRACT_DRAFT_TIMEOUT_MS = 30000;
/** 客户端侧错误码(与服务端契约错误码区分) */
exports.CLIENT_TIMEOUT = "CLIENT_TIMEOUT";
exports.CLIENT_NETWORK = "CLIENT_NETWORK";
exports.CLIENT_BAD_RESPONSE = "CLIENT_BAD_RESPONSE";
/** 携带错误码的异常,message 为可直接展示的中文文案 */
class ApiError extends Error {
    constructor(code, message, existing, cleared, superseded) {
        super(message);
        this.name = "ApiError";
        this.code = code;
        this.existing = existing;
        this.cleared = cleared;
        this.superseded = superseded;
    }
}
exports.ApiError = ApiError;
function isApiError(e) {
    return e instanceof ApiError;
}
/** 服务端错误码 → 默认中文文案(服务端 message 缺失时兜底) */
const ITEMS_API_MESSAGES = {
    INVALID_INPUT: "输入内容有误,请检查后重试",
    NOT_FOUND: "没有找到这条记录",
    VERSION_CONFLICT: "内容已被修改,已为你刷新,请重试",
    UNAUTHORIZED: "登录状态异常,请退出小程序后重试",
    OPERATION_CONFLICT: "这条已保存过且内容与当前填写不同,请到详情页修改",
    FAMILY_SWITCHED: "家庭已切换,本次操作未保存,请确认当前家庭后重试",
    FAMILY_STALE_SCOPE: "家庭刚发生成员或作用域变化,本次操作未保存,请刷新后重试",
    HOUSEHOLD_UNAVAILABLE: "暂时无法确认当前家庭,请稍后重试",
    /** PR #67 B1:photoCommit 会话家庭与当前派生家庭不一致(服务端 message 优先) */
    SCOPE_MISMATCH: "家庭已切换,本批未保存",
    /** PR #67 C3:photoEvidenceRetry 单件证据写入失败(服务端 message 优先) */
    EVIDENCE_WRITE_FAILED: "照片关联失败,请重试",
    VIDEO_NOT_AVAILABLE: "视频文件暂时不可用,请重试",
    VIDEO_DELETE_FAILED: "视频文件删除失败,请重试",
    VIDEO_TICKET_EXPIRED: "视频上传凭据已过期,请删除待关联视频后重新拍摄",
    VIDEO_TICKET_BUSY: "视频正在关联或清理,请稍后刷新重试",
    VIDEO_ITEM_BUSY: "这件物品正在被删除或整理,请稍后重试",
};
const EXTRACT_DRAFT_MESSAGES = {
    AI_UNAVAILABLE: "AI 暂时不可用,可手动录入",
};
/** 提醒类别冻结词表(issue #36,与服务端 remind_kind 同源) */
const REMIND_KIND_VALUES = ["有效期", "开封后", "下次维护"];
/** 服务端规范化的提醒日期形态(客户端只透传,绝不自行解析/推算日期) */
const REMIND_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * 解析单件草稿的提醒候选三项(#36 日期纪律的客户端半边):
 * 三项同现同缺才有效;残缺/形状非法(半态、非 YYYY-MM-DD、词表外、空 quote)整体置
 * null——与服务端硬门同口径:不带提醒、不废件。客户端绝不从模糊表述补算日期。
 */
function parseRemindTriple(d) {
    const at = d.remind_at;
    const kind = d.remind_kind;
    const quote = d.remind_quote;
    const atEmpty = at === null || at === undefined;
    const kindEmpty = kind === null || kind === undefined;
    const quoteEmpty = quote === null || quote === undefined;
    if (atEmpty && kindEmpty && quoteEmpty) {
        return { remind_at: null, remind_kind: null, remind_quote: null };
    }
    if (typeof at === "string" &&
        REMIND_DATE_RE.test(at) &&
        typeof kind === "string" &&
        REMIND_KIND_VALUES.indexOf(kind) !== -1 &&
        typeof quote === "string" &&
        quote.length > 0 &&
        quote.length <= 200) {
        return { remind_at: at, remind_kind: kind, remind_quote: quote };
    }
    return { remind_at: null, remind_kind: null, remind_quote: null };
}
const BAD_RESPONSE_MESSAGE = "服务返回异常,请稍后重试";
const DEFAULT_ERROR_MESSAGE = "服务暂时不可用,请稍后重试";
const NEEDS_SPLIT_DEFAULT_MESSAGE = "一次只记一件物品,请分开说";
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** 把服务端 ok:false 体转换为 ApiError;优先使用服务端中文 message,保留 existing / cleared / superseded 附加数据 */
function toServerError(code, message, fallbacks, existing, cleared, superseded) {
    const codeText = typeof code === "string" && code.length > 0 ? code : exports.CLIENT_BAD_RESPONSE;
    const fallback = fallbacks[codeText];
    const serverMessage = typeof message === "string" && message.trim().length > 0 ? message : "";
    const existingSummary = isRecord(existing)
        ? existing
        : undefined;
    return new ApiError(codeText, serverMessage || fallback || DEFAULT_ERROR_MESSAGE, existingSummary, cleared === true, superseded === true);
}
/** 调用云函数,带客户端超时;不静默吞错,失败一律 reject ApiError */
function callCloudFunction(name, data, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (!wx.cloud) {
            reject(new ApiError(exports.CLIENT_NETWORK, "当前微信版本过低,无法使用云能力,请升级微信后重试"));
            return;
        }
        let done = false;
        const timer = setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            reject(new ApiError(exports.CLIENT_TIMEOUT, "请求超时,请检查网络后重试"));
        }, timeoutMs);
        wx.cloud.callFunction({
            name,
            data: data,
            success: (res) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                resolve(res.result);
            },
            fail: (err) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                console.error("[api] 云函数调用失败:", name, err && err.errMsg);
                reject(new ApiError(exports.CLIENT_NETWORK, "网络异常,请稍后重试"));
            },
        });
    });
}
/** 对 ok:true 响应做最小结构校验,结构不符按异常响应处理(如实提示) */
function validVideoEvidenceRow(v) {
    if (isRecord(v) === false)
        return false;
    return (typeof v.evidence_id === "string" &&
        typeof v.item_id === "string" &&
        typeof v.file_id === "string" &&
        typeof v.video_url === "string" &&
        typeof v.duration_ms === "number" &&
        typeof v.video_w === "number" &&
        typeof v.video_h === "number" &&
        typeof v.captured_location_text === "string" &&
        typeof v.consent_version === "string" &&
        typeof v.created_at === "string");
}
function validateItemsOkResponse(action, r) {
    const bad = () => new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    switch (action) {
        case "create":
            if (!isRecord(r.item) || typeof r.duplicated !== "boolean") {
                throw bad();
            }
            break;
        case "update":
            if (!isRecord(r.item)) {
                throw bad();
            }
            break;
        case "get":
            if (!isRecord(r.item)) {
                throw bad();
            }
            break;
        case "query":
            if (!Array.isArray(r.items) || typeof r.match_type !== "string") {
                throw bad();
            }
            break;
        case "list":
            if (!Array.isArray(r.items)) {
                throw bad();
            }
            break;
        case "photoCommit":
            // 拍照识物批量建档(#3):逐行回执形状门——index 数值 + ok 布林必须齐,
            // 失败行 error 文案可选;残缺响应整次抛错,绝不半带部分件。
            // PR #67 C3:evidence_failed(证据写入失败的 item_id 列表)可选携带,
            // 携带时必须是字符串数组
            if (!Array.isArray(r.results) ||
                !r.results.every((row) => isRecord(row) &&
                    typeof row.index === "number" &&
                    typeof row.ok === "boolean" &&
                    (row.error === undefined || typeof row.error === "string")) ||
                (r.evidence_failed !== undefined &&
                    (!Array.isArray(r.evidence_failed) ||
                        !r.evidence_failed.every((id) => typeof id === "string")))) {
                throw bad();
            }
            break;
        case "photoEvidenceRetry":
            // 证据幂等重试关联(PR #67 C3):逐行回执形状门——index/item_id/ok 必须
            // 齐,error 可选;残缺响应整次抛错
            if (!Array.isArray(r.results) ||
                !r.results.every((row) => isRecord(row) &&
                    typeof row.index === "number" &&
                    typeof row.item_id === "string" &&
                    typeof row.ok === "boolean" &&
                    (row.error === undefined || typeof row.error === "string"))) {
                throw bad();
            }
            break;
        case "photoEvidenceGet":
            // 证据行形状门(#3):box null 或四值 0-1;换链失败 photo_url 为空串也合法
            if (!Array.isArray(r.evidence) ||
                !r.evidence.every((row) => isRecord(row) &&
                    typeof row.item_id === "string" &&
                    typeof row.file_id === "string" &&
                    typeof row.photo_url === "string" &&
                    typeof row.img_w === "number" &&
                    typeof row.img_h === "number" &&
                    typeof row.captured_location_text === "string" &&
                    typeof row.created_at === "string" &&
                    (row.source === "vl" || row.source === "circle") &&
                    (row.box === null ||
                        (isRecord(row.box) &&
                            [row.box.x1, row.box.y1, row.box.x2, row.box.y2].every((n) => typeof n === "number" && n >= 0 && n <= 1))))) {
                throw bad();
            }
            break;
        case "videoUploadBegin":
            if (typeof r.upload_ticket !== "string" ||
                typeof r.upload_path !== "string" ||
                typeof r.expires_at !== "string") {
                throw bad();
            }
            break;
        case "videoUploadReceipt":
            break;
        case "videoEvidenceAttach":
            if (validVideoEvidenceRow(r.evidence) === false || typeof r.duplicated !== "boolean")
                throw bad();
            break;
        case "videoUploadCancel":
            if (r.state !== "cancelled" && r.state !== "bound")
                throw bad();
            if (r.state === "bound" && validVideoEvidenceRow(r.evidence) === false)
                throw bad();
            break;
        case "videoEvidenceDelete":
            if (typeof r.deleted !== "number")
                throw bad();
            break;
        case "videoEvidenceGet":
            if (Array.isArray(r.evidence) === false || r.evidence.every(validVideoEvidenceRow) === false)
                throw bad();
            break;
        case "remindList":
            // 提醒行形状严格校验(issue #36):残缺行不上屏,绝不静默丢弃后部分展示;
            // generation(PR #52 B1)为可选数值——旧云函数窗口可能缺省,携带时类型必须正确;
            // remind_converted/remind_quote(三件 A 换算标记对)同为可选——仅换算行携带
            if (!Array.isArray(r.reminders) ||
                !r.reminders.every((row) => isRecord(row) &&
                    typeof row.item_id === "string" &&
                    typeof row.name === "string" &&
                    typeof row.location_text === "string" &&
                    typeof row.due_date === "string" &&
                    (row.generation === undefined || typeof row.generation === "number") &&
                    (row.remind_converted === undefined ||
                        typeof row.remind_converted === "boolean") &&
                    (row.remind_quote === undefined || typeof row.remind_quote === "string"))) {
                throw bad();
            }
            break;
        default:
            break;
    }
}
/** itemsApi 写类 action(P1-B F2:自动拼装作用域一致性绑定;#36 提醒写操作同走硬门;#3 photoCommit/photoEvidenceRetry 同走) */
const ITEMS_MUTATING_ACTIONS = new Set([
    "create",
    "update",
    "delete",
    "remindComplete",
    "remindClear",
    "remindSet",
    "photoCommit",
    "photoEvidenceRetry",
    "videoUploadBegin",
    "videoUploadReceipt",
    "videoUploadCancel",
    "videoEvidenceAttach",
    "videoEvidenceDelete",
]);
async function callItemsApi(event) {
    // F2 客户端半边:写类 action 自动附 expected_household_id / expected_scope_revision
    // (来自 household-scope 捕获的服务端权威作用域;未捕获时不编造,旧云函数窗口
    // 与 0.4.7 单人行为逐字节一致)。PR #67 B1:显式携带在 event 里的
    // expected_household_id(拍照会话开批时捕获的会话家庭)优先于自动 marker——
    // 自动 marker 取的是**提交时刻**的当前作用域,会覆盖会话绑定导致中途切家后
    // 旧批误写新家庭;event 字段后展开即优先(其余 action 均不显式携带,零回归)
    const payload = ITEMS_MUTATING_ACTIONS.has(event.action)
        ? Object.assign({}, (0, household_scope_1.scopeWriteMarkers)(), event)
        : event;
    let result;
    try {
        result = await callCloudFunction(ITEMS_API_FUNCTION, payload, ITEMS_API_TIMEOUT_MS);
    }
    catch (e) {
        // FAMILY_SWITCHED / FAMILY_STALE_SCOPE:家庭状态刚变化——触发 status 刷新
        // 作用域(捕获新 id/修订号),绝不静默重试,由用户按服务端文案重试
        (0, households_api_1.notifyFamilyScopeDrift)(e);
        throw e;
    }
    if (!isRecord(result)) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    if (result.ok === false) {
        const err = toServerError(result.error, result.message, ITEMS_API_MESSAGES, result.existing, result.cleared, result.superseded);
        (0, households_api_1.notifyFamilyScopeDrift)(err);
        throw err;
    }
    if (result.ok !== true) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    validateItemsOkResponse(event.action, result);
    if (event.action === "list" ||
        event.action === "remindList" ||
        event.action === "photoEvidenceGet" ||
        event.action === "videoEvidenceGet") {
        // issue #34 P0/P1-B:从 list / remindList 响应捕获服务端解析的家庭作用域
        // (household_id 必带;共享家庭另带 scope_revision)。捕获到作用域切换时清整树缓存,
        // 把家庭切换显式接入 locations-cache 既有失效代数(F2);
        // photoEvidenceGet(#3)同款收口(响应带 household_id/scope_revision);
        // 非法/缺省静默忽略,保持回退值(旧云函数窗口与单人阶段行为不变)
        if ((0, household_scope_1.captureHouseholdId)(result.household_id, result.scope_revision)) {
            (0, locations_cache_1.clearLocationsCache)();
        }
    }
    if (event.action === "create" ||
        event.action === "update" ||
        event.action === "delete" ||
        event.action === "photoCommit") {
        // 物品写入会影响空间树各层数据(create 影响「未归位」计数,update/delete
        // 影响层级物品摘要):整树缓存失效,失效收口在 API 层(issue #23)
        (0, locations_cache_1.clearLocationsCache)();
    }
    return result;
}
/**
 * 调用 extractDraft。ok:false(含 AI_UNAVAILABLE)一律抛 ApiError。
 * 传 { protocol: 2 } 走多件拆分协议:正常返回 drafts[](单件时长度 1);
 * v1 形态(草稿/needs_split)仅作防御性兜底(旧服务端未升级窗口)。
 */
async function callExtractDraft(text, opts) {
    const event = opts && opts.protocol === 2 ? { text, protocol: 2 } : { text };
    const result = await callCloudFunction(EXTRACT_DRAFT_FUNCTION, event, EXTRACT_DRAFT_TIMEOUT_MS);
    if (!isRecord(result)) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    if (result.ok === false) {
        throw toServerError(result.error, result.message, EXTRACT_DRAFT_MESSAGES);
    }
    if (result.ok !== true) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    if (Array.isArray(result.drafts)) {
        // 严格校验:任一件形状非法整次抛错,绝不静默丢弃异常件(部分消费会让用户以为全记了)
        if (result.drafts.length < 1 ||
            !result.drafts.every(isRecord) ||
            typeof result.original_text !== "string" ||
            !result.drafts.every((d) => typeof d.name === "string" &&
                typeof d.location_text === "string" &&
                typeof d.certain === "boolean" &&
                Array.isArray(d.qualifiers) &&
                typeof d.source_quote === "string" &&
                (typeof d.anchor_shared === "boolean" ||
                    typeof d.anchor_shared === "undefined"))) {
            throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
        }
        return {
            ok: true,
            drafts: result.drafts.map((d) => ({
                name: d.name,
                location_text: d.location_text,
                certain: d.certain,
                qualifiers: d.qualifiers.filter((q) => typeof q === "string"),
                source_quote: d.source_quote,
                anchor_shared: d.anchor_shared === true,
                // 提醒候选三项(issue #36):透传服务端已锚定的原话日期,残缺/非法整体置 null
                ...parseRemindTriple(d),
                // 「时间没换算」透明标记(0.6.0 真机反馈 Fix 4):透传服务端 vague 原文
                // 子串(字符串才透传,缺省/非法按 null)——曾因本映射漏传导致确认页
                // 灰行与详情留痕整链失效(三件 A 复审发现,此处补上断链)
                remind_vague_quote: typeof d.remind_vague_quote === "string"
                    ? (d.remind_vague_quote)
                    : null,
                // 相对时间换算标记(三件 A):仅服务端换算成功的件为 true(严格 ===,
                // 其余形态一律 false,绝不把模型/异常值当换算候选透传)
                remind_converted: d.remind_converted === true,
                // 「放进」路径预览(issue #45 十七轮):仅 certain 且形状合法才透传,
                // 否则 null(certain=false 一律 null = 确认卡不显示「放进」行,
                // 照旧先进「尚未归类」;绝不静默建路径)
                mount_path: (() => {
                    const preview = (0, batch_save_1.draftMountPathPreview)(d);
                    return preview.length > 0 ? preview : null;
                })(),
            })),
            original_text: result.original_text,
            truncated: result.truncated === true,
        };
    }
    if (result.needs_split === true) {
        const message = typeof result.message === "string" && result.message.length > 0
            ? result.message
            : NEEDS_SPLIT_DEFAULT_MESSAGE;
        return { ok: true, needs_split: true, message };
    }
    const draft = result.draft;
    if (!isRecord(draft) ||
        typeof draft.name !== "string" ||
        typeof draft.location_text !== "string" ||
        typeof draft.certain !== "boolean" ||
        !Array.isArray(draft.qualifiers)) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    return {
        ok: true,
        draft: {
            name: draft.name,
            location_text: draft.location_text,
            certain: draft.certain,
            qualifiers: draft.qualifiers.filter((q) => typeof q === "string"),
        },
    };
}
/** draftEditParse edits 行的 field 白名单(与服务端硬门同源) */
const DRAFT_EDIT_FIELDS = new Set(["name", "qty_note", "location"]);
/**
 * 拍照识物语音受限编辑解析(#3,IMPLEMENTATION.md §1.2/§4.3 ②):
 * 调 extractDraft.draftEditParse 并做五分支结构校验(intent 是判别字段)。
 * 服务端已保证:field 白名单/needs_pick 与 edits 互斥/target.draft_id ∈ candidates
 * ——客户端只做形状门(残缺响应整体抛 CLIENT_BAD_RESPONSE,绝不半带)。
 * 超时 30000(服务端 LLM 20s+ 余量,与 callExtractDraft 同款)。
 * 本函数绝不触任何写:返回的 edits 只作用于客户端本地拍照草稿。
 */
async function callDraftEditParse(event) {
    const result = await callCloudFunction(EXTRACT_DRAFT_FUNCTION, event, EXTRACT_DRAFT_TIMEOUT_MS);
    if (!isRecord(result)) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    if (result.ok === false) {
        throw toServerError(result.error, result.message, EXTRACT_DRAFT_MESSAGES);
    }
    if (result.ok !== true) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    const intent = result.intent;
    const picksValid = Array.isArray(result.picks) &&
        result.picks.every((p) => isRecord(p) && typeof p.draft_id === "string" && typeof p.name === "string");
    if (!picksValid) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    const picks = result.picks.map((p) => ({
        draft_id: p.draft_id,
        name: p.name,
    }));
    if (intent === "add") {
        if (!isRecord(result.added) || typeof result.added.name !== "string") {
            throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
        }
        return {
            ok: true,
            engine: typeof result.engine === "string" ? result.engine : "",
            intent: "add",
            added: {
                name: result.added.name,
                qty_note: typeof result.added.qty_note === "string" ? result.added.qty_note : "",
            },
            needs_pick: false,
            picks,
        };
    }
    if (intent === "batch_location") {
        if (typeof result.new_location !== "string" || result.new_location.trim() === "") {
            throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
        }
        return {
            ok: true,
            engine: typeof result.engine === "string" ? result.engine : "",
            intent: "batch_location",
            new_location: result.new_location,
            needs_pick: false,
            picks,
        };
    }
    if (intent === "none") {
        return {
            ok: true,
            engine: typeof result.engine === "string" ? result.engine : "",
            intent: "none",
            needs_pick: false,
            picks,
        };
    }
    if (intent !== "edit") {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    // intent="edit":target(可 null) + edits(0-3 行,field 白名单/new 非空)
    if (result.needs_pick !== true && result.needs_pick !== false) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    const target = result.target === null || result.target === undefined
        ? null
        : isRecord(result.target) && typeof result.target.draft_id === "string"
            ? {
                draft_id: result.target.draft_id,
                matched_word: typeof result.target.matched_word === "string" ? result.target.matched_word : "",
            }
            : null;
    if (!Array.isArray(result.edits)) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    const edits = [];
    for (const e of result.edits) {
        if (!isRecord(e) ||
            typeof e.field !== "string" ||
            !DRAFT_EDIT_FIELDS.has(e.field) ||
            typeof e.new !== "string" ||
            e.new.trim() === "") {
            throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
        }
        edits.push({
            field: e.field,
            new: e.new,
            old: typeof e.old === "string" ? e.old : "",
        });
    }
    return {
        ok: true,
        engine: typeof result.engine === "string" ? result.engine : "",
        intent: "edit",
        target,
        edits,
        needs_pick: result.needs_pick === true,
        picks,
    };
}
/**
 * 拍照识物位置层级拆分(#3,IMPLEMENTATION §1.6,真机 2026-10-17):
 * 调 extractDraft.locationSplit,把无分隔符中文位置(「书房桌子右边抽屉」)交给
 * 模型拆成从大到小的层级路径(逐字锚定纪律与语音链路 mount_path 同源)。
 * 服务端已硬校验(每段是原文逐字子串、按序、1-6 段、每段 1-30 码点;
 * 不过 → 整串单段 + fallback:true);客户端只做形状门(path 数组每项 string,
 * 残缺响应整体抛 CLIENT_BAD_RESPONSE,绝不半带)。ok:false(含 AI_UNAVAILABLE)
 * 抛 ApiError,由调用方走 splitLocationSegments 确定性兜底——绝不阻塞保存。
 * 超时 30000(与 callExtractDraft/callDraftEditParse 同款)。
 */
async function callLocationSplit(text) {
    const event = { action: "locationSplit", text };
    const result = await callCloudFunction(EXTRACT_DRAFT_FUNCTION, event, EXTRACT_DRAFT_TIMEOUT_MS);
    if (!isRecord(result)) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    if (result.ok === false) {
        throw toServerError(result.error, result.message, EXTRACT_DRAFT_MESSAGES);
    }
    if (result.ok !== true) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    if (!Array.isArray(result.path) ||
        result.path.length < 1 ||
        !result.path.every((seg) => typeof seg === "string" && seg.trim() !== "")) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    return {
        ok: true,
        engine: typeof result.engine === "string" ? result.engine : "",
        path: result.path.map((seg) => seg),
        fallback: result.fallback === true,
    };
}
/** 生成 operation_id(uuid v4 形态,36 位,满足契约 ≤64) */
function uuid() {
    const template = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
    let out = "";
    for (let i = 0; i < template.length; i++) {
        const c = template[i];
        if (c === "x" || c === "y") {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            out += v.toString(16);
        }
        else {
            out += c;
        }
    }
    return out;
}
/** ISO 时间 → 「YYYY-MM-DD HH:mm」;解析失败原样返回,不编造 */
function formatDateTime(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) {
        return iso;
    }
    const d = new Date(t);
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return (d.getFullYear() +
        "-" +
        pad(d.getMonth() + 1) +
        "-" +
        pad(d.getDate()) +
        " " +
        pad(d.getHours()) +
        ":" +
        pad(d.getMinutes()));
}
/** 把任意异常转成可展示的中文文案(失败路径绝不静默) */
function errorMessage(e) {
    if (e instanceof ApiError) {
        return e.message;
    }
    if (e instanceof Error && e.message) {
        return "操作失败:" + e.message;
    }
    return "操作失败,请稍后重试";
}
