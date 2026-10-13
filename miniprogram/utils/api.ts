/**
 * 云函数调用封装(类型化):
 * - 统一 wx.cloud.callFunction 调用与超时控制;
 * - 服务端错误码映射为可直接展示的中文文案(服务端 message 缺失时兜底);
 * - operation_id 的 uuid 生成(创建幂等键);
 * - ISO 时间格式化等小工具。
 *
 * 本模块不读取、不传输任何身份字段;household_id/openid 一律由服务端派生。
 */
import type {
  CreateItemResponse,
  DeleteItemResponse,
  ExtractDraftEvent,
  ExtractDraftNeedsSplitResponse,
  ExtractDraftMultiEvent,
  ExtractDraftMultiResponse,
  ExtractDraftOkResponse,
  GetItemResponse,
  ItemsApiEvent,
  ItemsApiOkResponse,
  ItemSummary,
  ListItemsResponse,
  QueryItemsResponse,
  UpdateItemResponse,
} from "../types";
import { clearLocationsCache } from "./locations-cache";
import { captureHouseholdId } from "./household-scope";

const ITEMS_API_FUNCTION = "itemsApi";
const EXTRACT_DRAFT_FUNCTION = "extractDraft";

/** itemsApi 为薄适配层,正常应在数秒内返回 */
const ITEMS_API_TIMEOUT_MS = 15000;
/** extractDraft 服务端 LLM 超时 20 秒,客户端放宽到 30 秒,优先让服务端错误回来 */
const EXTRACT_DRAFT_TIMEOUT_MS = 30000;

/** 客户端侧错误码(与服务端契约错误码区分) */
export const CLIENT_TIMEOUT = "CLIENT_TIMEOUT";
export const CLIENT_NETWORK = "CLIENT_NETWORK";
export const CLIENT_BAD_RESPONSE = "CLIENT_BAD_RESPONSE";

/** 携带错误码的异常,message 为可直接展示的中文文案 */
export class ApiError extends Error {
  readonly code: string;
  /** OPERATION_CONFLICT 时服务端附带的已有记录,供可操作引导(如跳详情页修改) */
  readonly existing?: ItemSummary;

  constructor(code: string, message: string, existing?: ItemSummary) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.existing = existing;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** 服务端错误码 → 默认中文文案(服务端 message 缺失时兜底) */
const ITEMS_API_MESSAGES: Record<string, string> = {
  INVALID_INPUT: "输入内容有误,请检查后重试",
  NOT_FOUND: "没有找到这条记录",
  VERSION_CONFLICT: "内容已被修改,已为你刷新,请重试",
  UNAUTHORIZED: "登录状态异常,请退出小程序后重试",
  OPERATION_CONFLICT: "这条已保存过且内容与当前填写不同,请到详情页修改",
  FAMILY_SWITCHED: "家庭已切换,本次操作未保存,请确认当前家庭后重试",
  HOUSEHOLD_UNAVAILABLE: "暂时无法确认当前家庭,请稍后重试",
};

const EXTRACT_DRAFT_MESSAGES: Record<string, string> = {
  AI_UNAVAILABLE: "AI 暂时不可用,可手动录入",
};

const BAD_RESPONSE_MESSAGE = "服务返回异常,请稍后重试";
const DEFAULT_ERROR_MESSAGE = "服务暂时不可用,请稍后重试";
const NEEDS_SPLIT_DEFAULT_MESSAGE = "一次只记一件物品,请分开说";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 把服务端 ok:false 体转换为 ApiError;优先使用服务端中文 message,保留 existing 附加数据 */
function toServerError(
  code: unknown,
  message: unknown,
  fallbacks: Record<string, string>,
  existing?: unknown,
): ApiError {
  const codeText =
    typeof code === "string" && code.length > 0 ? code : CLIENT_BAD_RESPONSE;
  const fallback = fallbacks[codeText];
  const serverMessage =
    typeof message === "string" && message.trim().length > 0 ? message : "";
  const existingSummary = isRecord(existing)
    ? (existing as unknown as ItemSummary)
    : undefined;
  return new ApiError(
    codeText,
    serverMessage || fallback || DEFAULT_ERROR_MESSAGE,
    existingSummary,
  );
}

/** 调用云函数,带客户端超时;不静默吞错,失败一律 reject ApiError */
function callCloudFunction(
  name: string,
  data: unknown,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!wx.cloud) {
      reject(
        new ApiError(
          CLIENT_NETWORK,
          "当前微信版本过低,无法使用云能力,请升级微信后重试",
        ),
      );
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      reject(new ApiError(CLIENT_TIMEOUT, "请求超时,请检查网络后重试"));
    }, timeoutMs);
    wx.cloud.callFunction({
      name,
      data: data as WechatMiniprogram.IAnyObject,
      success: (res) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve((res as { result?: unknown }).result);
      },
      fail: (err) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        console.error("[api] 云函数调用失败:", name, err && err.errMsg);
        reject(new ApiError(CLIENT_NETWORK, "网络异常,请稍后重试"));
      },
    });
  });
}

/** 对 ok:true 响应做最小结构校验,结构不符按异常响应处理(如实提示) */
function validateItemsOkResponse(
  action: string,
  r: Record<string, unknown>,
): void {
  const bad = () => new ApiError(CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
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
    default:
      break;
  }
}

export function callItemsApi(
  event: Extract<ItemsApiEvent, { action: "create" }>,
): Promise<CreateItemResponse>;
export function callItemsApi(
  event: Extract<ItemsApiEvent, { action: "update" }>,
): Promise<UpdateItemResponse>;
export function callItemsApi(
  event: Extract<ItemsApiEvent, { action: "delete" }>,
): Promise<DeleteItemResponse>;
export function callItemsApi(
  event: Extract<ItemsApiEvent, { action: "get" }>,
): Promise<GetItemResponse>;
export function callItemsApi(
  event: Extract<ItemsApiEvent, { action: "query" }>,
): Promise<QueryItemsResponse>;
export function callItemsApi(
  event: Extract<ItemsApiEvent, { action: "list" }>,
): Promise<ListItemsResponse>;
export async function callItemsApi(
  event: ItemsApiEvent,
): Promise<ItemsApiOkResponse> {
  const result = await callCloudFunction(
    ITEMS_API_FUNCTION,
    event,
    ITEMS_API_TIMEOUT_MS,
  );
  if (!isRecord(result)) {
    throw new ApiError(CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
  }
  if (result.ok === false) {
    throw toServerError(result.error, result.message, ITEMS_API_MESSAGES, result.existing);
  }
  if (result.ok !== true) {
    throw new ApiError(CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
  }
  validateItemsOkResponse(event.action, result);
  if (event.action === "list") {
    // issue #34 P0:从 list 响应捕获服务端解析的家庭 id(非法/缺省静默忽略,
    // 保持回退值;旧云函数窗口与单人阶段行为不变)
    captureHouseholdId((result as { household_id?: unknown }).household_id);
  }
  if (
    event.action === "create" ||
    event.action === "update" ||
    event.action === "delete"
  ) {
    // 物品写入会影响空间树各层数据(create 影响「未归位」计数,update/delete
    // 影响层级物品摘要):整树缓存失效,失效收口在 API 层(issue #23)
    clearLocationsCache();
  }
  return result as unknown as ItemsApiOkResponse;
}

/**
 * 调用 extractDraft。ok:false(含 AI_UNAVAILABLE)一律抛 ApiError。
 * 传 { protocol: 2 } 走多件拆分协议:正常返回 drafts[](单件时长度 1);
 * v1 形态(草稿/needs_split)仅作防御性兜底(旧服务端未升级窗口)。
 */
export async function callExtractDraft(
  text: string,
  opts?: { protocol?: 2 },
): Promise<
  ExtractDraftMultiResponse | ExtractDraftOkResponse | ExtractDraftNeedsSplitResponse
> {
  const event: ExtractDraftEvent | ExtractDraftMultiEvent =
    opts && opts.protocol === 2 ? { text, protocol: 2 } : { text };
  const result = await callCloudFunction(
    EXTRACT_DRAFT_FUNCTION,
    event,
    EXTRACT_DRAFT_TIMEOUT_MS,
  );
  if (!isRecord(result)) {
    throw new ApiError(CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
  }
  if (result.ok === false) {
    throw toServerError(result.error, result.message, EXTRACT_DRAFT_MESSAGES);
  }
  if (result.ok !== true) {
    throw new ApiError(CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
  }
  if (Array.isArray(result.drafts)) {
    // 严格校验:任一件形状非法整次抛错,绝不静默丢弃异常件(部分消费会让用户以为全记了)
    if (
      result.drafts.length < 1 ||
      !result.drafts.every(isRecord) ||
      typeof result.original_text !== "string" ||
      !result.drafts.every(
        (d) =>
          typeof d.name === "string" &&
          typeof d.location_text === "string" &&
          typeof d.certain === "boolean" &&
          Array.isArray(d.qualifiers) &&
          typeof (d as { source_quote?: unknown }).source_quote === "string" &&
          (typeof (d as { anchor_shared?: unknown }).anchor_shared === "boolean" ||
            typeof (d as { anchor_shared?: unknown }).anchor_shared === "undefined"),
      )
    ) {
      throw new ApiError(CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
    }
    return {
      ok: true,
      drafts: result.drafts.map((d) => ({
        name: d.name as string,
        location_text: d.location_text as string,
        certain: d.certain as boolean,
        qualifiers: (d.qualifiers as unknown[]).filter(
          (q): q is string => typeof q === "string",
        ),
        source_quote: (d as { source_quote: string }).source_quote,
        anchor_shared: (d as { anchor_shared?: boolean }).anchor_shared === true,
      })),
      original_text: result.original_text,
      truncated: result.truncated === true,
    };
  }
  if (result.needs_split === true) {
    const message =
      typeof result.message === "string" && result.message.length > 0
        ? result.message
        : NEEDS_SPLIT_DEFAULT_MESSAGE;
    return { ok: true, needs_split: true, message };
  }
  const draft = result.draft;
  if (
    !isRecord(draft) ||
    typeof draft.name !== "string" ||
    typeof draft.location_text !== "string" ||
    typeof draft.certain !== "boolean" ||
    !Array.isArray(draft.qualifiers)
  ) {
    throw new ApiError(CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
  }
  return {
    ok: true,
    draft: {
      name: draft.name,
      location_text: draft.location_text,
      certain: draft.certain,
      qualifiers: draft.qualifiers.filter(
        (q): q is string => typeof q === "string",
      ),
    },
  };
}

/** 生成 operation_id(uuid v4 形态,36 位,满足契约 ≤64) */
export function uuid(): string {
  const template = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === "x" || c === "y") {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      out += v.toString(16);
    } else {
      out += c;
    }
  }
  return out;
}

/** ISO 时间 → 「YYYY-MM-DD HH:mm」;解析失败原样返回,不编造 */
export function formatDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return iso;
  }
  const d = new Date(t);
  const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

/** 把任意异常转成可展示的中文文案(失败路径绝不静默) */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    return e.message;
  }
  if (e instanceof Error && e.message) {
    return "操作失败:" + e.message;
  }
  return "操作失败,请稍后重试";
}
