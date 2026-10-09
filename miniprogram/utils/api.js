"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiError = exports.CLIENT_BAD_RESPONSE = exports.CLIENT_NETWORK = exports.CLIENT_TIMEOUT = void 0;
exports.isApiError = isApiError;
exports.callItemsApi = callItemsApi;
exports.callExtractDraft = callExtractDraft;
exports.uuid = uuid;
exports.formatDateTime = formatDateTime;
exports.errorMessage = errorMessage;
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
    constructor(code, message) {
        super(message);
        this.name = "ApiError";
        this.code = code;
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
};
const EXTRACT_DRAFT_MESSAGES = {
    AI_UNAVAILABLE: "AI 暂时不可用,可手动录入",
};
const BAD_RESPONSE_MESSAGE = "服务返回异常,请稍后重试";
const DEFAULT_ERROR_MESSAGE = "服务暂时不可用,请稍后重试";
const NEEDS_SPLIT_DEFAULT_MESSAGE = "一次只记一件物品,请分开说";
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** 把服务端 ok:false 体转换为 ApiError;优先使用服务端中文 message */
function toServerError(code, message, fallbacks) {
    const codeText = typeof code === "string" && code.length > 0 ? code : exports.CLIENT_BAD_RESPONSE;
    const fallback = fallbacks[codeText];
    const serverMessage = typeof message === "string" && message.trim().length > 0 ? message : "";
    return new ApiError(codeText, serverMessage || fallback || DEFAULT_ERROR_MESSAGE);
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
        default:
            break;
    }
}
async function callItemsApi(event) {
    const result = await callCloudFunction(ITEMS_API_FUNCTION, event, ITEMS_API_TIMEOUT_MS);
    if (!isRecord(result)) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    if (result.ok === false) {
        throw toServerError(result.error, result.message, ITEMS_API_MESSAGES);
    }
    if (result.ok !== true) {
        throw new ApiError(exports.CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    validateItemsOkResponse(event.action, result);
    return result;
}
/**
 * 调用 extractDraft。ok:false(含 AI_UNAVAILABLE)一律抛 ApiError,
 * 正常返回只可能是草稿或 needs_split 两种形态。
 */
async function callExtractDraft(text) {
    const event = { text };
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
