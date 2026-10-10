/**
 * 领域类型定义,与 docs/API_CONTRACT.md 保持一致。
 *
 * 注意:客户端不信任、不读取、不上传任何身份字段
 * (household_id / openid 全部由云函数服务端自行派生)。
 */

/** items 集合完整文档(create / update 成功后返回) */
export interface ItemRecord {
  _id: string;
  /** 服务端派生,客户端不使用 */
  household_id?: string;
  name: string;
  name_norm: string;
  location_text: string;
  note: string;
  version: number;
  deleted: boolean;
  operation_id: string;
  created_at: string;
  updated_at: string;
}

/** query / list 返回的精简条目 */
export interface ItemSummary {
  item_id: string;
  name: string;
  location_text: string;
  note: string;
  version: number;
  updated_at: string;
}

/** extractDraft 提取出的待确认草稿 */
export interface Draft {
  name: string;
  location_text: string;
  certain: boolean;
  qualifiers: string[];
}

/** 协议 v2 草稿:附带原话证据片段(非子串时服务端置空,确认页标「来源不充分」) */
export interface DraftWithQuote extends Draft {
  source_quote: string;
}

/** query 的匹配层级 */
export type MatchType = "exact" | "prefix" | "contains" | "none";

/** itemsApi 错误码(契约固定) */
export type ItemsApiErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "UNAUTHORIZED"
  | "OPERATION_CONFLICT";

/** extractDraft 错误码 */
export type ExtractDraftErrorCode = "AI_UNAVAILABLE";

/* ---------------- itemsApi 请求 ---------------- */

export type ItemsApiEvent =
  | {
      action: "create";
      /** 创建幂等键,客户端生成(uuid),非空 ≤64 */
      operation_id: string;
      name: string;
      location_text: string;
      note?: string;
    }
  | {
      action: "update";
      item_id: string;
      expected_version: number;
      /** 同一次逻辑修改的标识(uuid):响应丢失后以相同内容重试时复用,服务端据此识别重放 */
      update_id?: string;
      name?: string;
      location_text?: string;
      note?: string;
    }
  | { action: "delete"; item_id: string }
  | { action: "get"; item_id: string }
  | { action: "query"; q: string }
  | { action: "list"; limit?: number };

/* ---------------- itemsApi 响应 ---------------- */

export interface CreateItemResponse {
  ok: true;
  item: ItemSummary;
  duplicated: boolean;
}

export interface UpdateItemResponse {
  ok: true;
  item: ItemSummary;
  /** true 表示这是同 update_id 的重放(上次写入成功但响应丢失),内容已是最新 */
  replayed?: boolean;
}

export interface GetItemResponse {
  ok: true;
  item: ItemSummary;
}

export interface DeleteItemResponse {
  ok: true;
}

export interface QueryItemsResponse {
  ok: true;
  items: ItemSummary[];
  match_type: MatchType;
}

export interface ListItemsResponse {
  ok: true;
  items: ItemSummary[];
}

export interface ItemsApiErrorResponse {
  ok: false;
  error: ItemsApiErrorCode;
  /** 中文文案,可直接给用户看 */
  message: string;
  /** OPERATION_CONFLICT 时附带的已有记录(同 operation_id 但内容不同),供可操作引导 */
  existing?: ItemSummary;
}

export type ItemsApiOkResponse =
  | CreateItemResponse
  | UpdateItemResponse
  | DeleteItemResponse
  | GetItemResponse
  | QueryItemsResponse
  | ListItemsResponse;

export type ItemsApiResponse = ItemsApiOkResponse | ItemsApiErrorResponse;

/* ---------------- extractDraft 请求与响应 ---------------- */

export interface ExtractDraftEvent {
  text: string;
}

export interface ExtractDraftOkResponse {
  ok: true;
  draft: Draft;
}

export interface ExtractDraftNeedsSplitResponse {
  ok: true;
  needs_split: true;
  message: string;
}

export interface ExtractDraftErrorResponse {
  ok: false;
  error: ExtractDraftErrorCode;
  message: string;
  manual_fallback: true;
}

/** 协议 v2 请求:显式 protocol:2(旧客户端不带,服务端维持 v1 行为) */
export interface ExtractDraftMultiEvent extends ExtractDraftEvent {
  protocol: 2;
}

/** 协议 v2 响应:一句话(1-5 件)拆分后的草稿数组,单件时长度也为 1 */
export interface ExtractDraftMultiResponse {
  ok: true;
  drafts: DraftWithQuote[];
  original_text: string;
}

export type ExtractDraftResponse =
  | ExtractDraftOkResponse
  | ExtractDraftNeedsSplitResponse
  | ExtractDraftMultiResponse
  | ExtractDraftErrorResponse;
