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
  /**
   * 空间树挂载目标(locations 集合节点 id)。缺失/null = 未挂载;
   * 唯一写入方是 locations 云函数(linkItem/unlinkItem/merge/applyScan),
   * itemsApi 对该字段一律忽略、投影亦不含它——此处仅作文档类型注释。
   */
  location_node_id?: string | null;
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
  /** 证据片段同时含其他物品名称(如整句原话):归属无法确定性排除交叉配对,须人工核对(默认不勾选) */
  anchor_shared?: boolean;
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

/**
 * 写类 action 的作用域一致性绑定(issue #34 P1-B,F2 客户端半边):
 * 由 API 封装层自动从 household-scope 拼装,页面不手工传;仅是一致性前置
 * 条件,绝不构成授权(服务端独立解析身份与家庭)。
 * - expected_household_id:捕获到的服务端解析家庭 id(个人/共享都带,携带则校验);
 * - expected_scope_revision:共享家庭的修订号(服务端共享硬门必需;个人态无语义)。
 */
export interface ScopeWriteBinding {
  expected_household_id?: string;
  expected_scope_revision?: number;
}

export type ItemsApiEvent =
  | ({
      action: "create";
      /** 创建幂等键,客户端生成(uuid),非空 ≤64 */
      operation_id: string;
      name: string;
      location_text: string;
      note?: string;
    } & ScopeWriteBinding)
  | ({
      action: "update";
      item_id: string;
      expected_version: number;
      /** 同一次逻辑修改的标识(uuid):响应丢失后以相同内容重试时复用,服务端据此识别重放 */
      update_id?: string;
      name?: string;
      location_text?: string;
      note?: string;
    } & ScopeWriteBinding)
  | ({ action: "delete"; item_id: string } & ScopeWriteBinding)
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
  /** 服务端解析的当前家庭 id(issue #34 P0;sha256 派生/共享家庭 id,非 PII;旧云函数窗口可能缺省) */
  household_id?: string;
  /** 共享家庭附带的作用域修订号(issue #34 P1-A):写请求 expected_scope_revision 的捕获来源;个人家庭缺省 */
  scope_revision?: number;
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

/** 协议 v2 响应:一句话(1-5 件)拆分后的草稿数组,单件时长度也为 1;truncated=原话超 5 件被截取(须引导分批,绝不静默) */
export interface ExtractDraftMultiResponse {
  ok: true;
  drafts: DraftWithQuote[];
  original_text: string;
  truncated: boolean;
}

export type ExtractDraftResponse =
  | ExtractDraftOkResponse
  | ExtractDraftNeedsSplitResponse
  | ExtractDraftMultiResponse
  | ExtractDraftErrorResponse;

/* ---------------- locations 空间树(issue #18) ---------------- */

/** 位置节点类型(按深度映射:1=room、2=furniture、≥3=container;home 为根哨兵) */
export type LocationType = "home" | "room" | "furniture" | "container";

/** 节点创建来源 */
export type LocationCreatedFrom = "bootstrap" | "scan" | "parse" | "manual";

/** 节点摘要(list/ensurePath/rename/move/merge 响应共用) */
export interface LocationNodeSummary {
  location_id: string;
  name: string;
  type: LocationType;
  /** 从根(不含 home 根)到本节点(含)的名字数组;home 根为 [] */
  path: string[];
  /** 整棵子树(自身+全部后代)挂载的未删物品数 */
  item_count: number;
  /** 直接子节点数 */
  child_count: number;
  created_from: LocationCreatedFrom;
  updated_at: string;
}

/** parseLocation 的单条层级候选段 */
export interface ParseSegment {
  name: string;
  type: LocationType;
  /** 0-1;低于服务端阈值(0.8)时强制 need_confirm */
  confidence: number;
}

/** 与既有树同名/近义的合并建议(服务端已校验存在性) */
export interface MergeSuggestion {
  segment_index: number;
  existing_location_id: string;
  existing_name: string;
  reason: string;
}

/** parseLocation 响应体 */
export interface ParseResult {
  segments: ParseSegment[];
  /** true = 只是候选,客户端必须让用户核对后才可 ensurePath */
  need_confirm: boolean;
  /** true = 段顺序与原文不符(锚定校验未通过),必须人工核对 */
  order_violation: boolean;
  merge_suggestions: MergeSuggestion[];
}

/** scanHousehold 候选树节点(结构一致性由服务端构造保证) */
export interface CandidateNode {
  name: string;
  type: LocationType;
  confidence: number;
  need_confirm: boolean;
  children: CandidateNode[];
  /** 与既有树同名节点的提示(同名段入库时 ensurePath 会直接复用已有节点) */
  merge_hints?: MergeSuggestion[];
}

/** 归并后近义比对产出的近义组(合并与否永远由用户裁决) */
export interface SynonymGroup {
  /** 层下标(0 起,0=房间层) */
  level: number;
  names: string[];
  reason: string;
}

/** 单件挂载草案(带当前 version,供 applyScan 作 expected_version) */
export interface MountDraft {
  item_id: string;
  name: string;
  location_text: string;
  version: number;
  path: string[];
  confidence: number;
  need_confirm: boolean;
  order_violation: boolean;
}

/** 扫描后无法自动归位的物品(位置为空 / 分段为空),向导里如实单列 */
export interface SkippedDraft {
  item_id: string;
  name: string;
  reason: string;
}

/** scanHousehold 响应体(纯草案,零写库) */
export interface ScanResult {
  scanned: number;
  unmounted_total: number;
  truncated: boolean;
  candidate_tree: CandidateNode[];
  synonym_groups: SynonymGroup[];
  mounts: MountDraft[];
  skipped: SkippedDraft[];
}

/** applyScan 逐件挂载状态(零静默:每个状态都如实呈现) */
export type ApplyScanMountStatus = "mounted" | "already" | "conflict" | "not_found";

export interface ApplyScanBranchResult {
  path: string[];
  created: boolean[];
  location_ids: string[];
}

export interface ApplyScanMountResult {
  item_id: string;
  status: ApplyScanMountStatus;
  /** mounted/already 时的最新版本号 */
  version?: number;
  /** conflict 时的当前版本号(引导用户去详情页重新挂载) */
  current_version?: number;
}

export interface ApplyScanResult {
  branches: ApplyScanBranchResult[];
  mounts: ApplyScanMountResult[];
}

/** locations 协议错误码(契约固定 7 个) */
export type LocationsApiErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "VERSION_CONFLICT"
  | "NODE_NOT_EMPTY"
  | "NODE_CONFLICT"
  | "AI_UNAVAILABLE";

export interface LocationsApiErrorResponse {
  ok: false;
  error: LocationsApiErrorCode;
  /** 中文文案,可直接给用户看 */
  message: string;
  /** 结构化补充(冲突清单、计数等;只出现在响应,绝不进日志) */
  detail?: Record<string, unknown>;
  /** AI_UNAVAILABLE 时为 true,引导手动兜底 */
  manual_fallback?: boolean;
}

/* ---------------- locations 请求(11 个 action 的判别联合) ---------------- */

export type LocationsApiEvent =
  | { action: "list"; parent_id?: string }
  | ({
      action: "ensurePath";
      /** 从根起的完整段序列,1-6 段,每段去空白 1-30 字 */
      path: string[];
      created_from?: "scan" | "parse" | "manual";
    } & ScopeWriteBinding)
  | ({ action: "rename"; node_id: string; name: string } & ScopeWriteBinding)
  | ({
      action: "move";
      node_id: string;
      new_parent_id: string;
    } & ScopeWriteBinding)
  | ({
      action: "merge";
      source_node_id: string;
      target_node_id: string;
    } & ScopeWriteBinding)
  | ({ action: "delete"; node_id: string; force?: boolean } & ScopeWriteBinding)
  | ({
      action: "linkItem";
      item_id: string;
      node_id: string;
      expected_version: number;
      /** 同一次逻辑挂载的标识(uuid):失败重试同内容复用,服务端据此识别重放 */
      update_id: string;
    } & ScopeWriteBinding)
  | ({
      action: "unlinkItem";
      item_id: string;
      expected_version: number;
      update_id: string;
    } & ScopeWriteBinding)
  | { action: "parseLocation"; text: string }
  | { action: "scanHousehold" }
  | ({
      action: "applyScan";
      /** 本次向导提交的幂等键(uuid),失败重试/恢复时原样复用 */
      operation_id: string;
      /** 纯结构确认(可空):建分支但本次无物品挂载 */
      branches: Array<{ path: string[] }>;
      /** 逐件完整确认路径(含容器末段),expected_version 用扫描时的 version */
      mounts: Array<{
        item_id: string;
        expected_version: number;
        path: string[];
      }>;
    } & ScopeWriteBinding);

/* ---------------- locations 响应 ---------------- */

export interface ListLocationsResponse {
  ok: true;
  /** 服务端解析的当前家庭 id(issue #34 P0;sha256 派生/共享家庭 id,非 PII;旧云函数窗口可能缺省) */
  household_id?: string;
  /** 共享家庭附带的作用域修订号(issue #34 P1-A):写请求 expected_scope_revision 的捕获来源;个人家庭缺省 */
  scope_revision?: number;
  node: LocationNodeSummary;
  children: LocationNodeSummary[];
  /** 直接挂载于该节点的未删物品 */
  items: ItemSummary[];
  /** 未删除且未挂载(缺失/null/悬挂)物品数 */
  unmounted_count: number;
  dangling_mounts: number;
}

export interface EnsurePathResponse {
  ok: true;
  nodes: LocationNodeSummary[];
  created: boolean[];
}

export interface RenameLocationResponse {
  ok: true;
  node: LocationNodeSummary;
}

export interface MoveLocationResponse {
  ok: true;
  node: LocationNodeSummary;
}

export interface MergeLocationResponse {
  ok: true;
  node: LocationNodeSummary;
  remounted: number;
  compensated: number;
  compensated_skipped: number;
  detail?: { already_merged?: boolean };
}

export interface DeleteLocationResponse {
  ok: true;
  deleted_nodes: number;
  compensated: number;
  compensated_skipped: number;
}

export interface LinkItemResponse {
  ok: true;
  item: { item_id: string; version: number; updated_at: string };
  /** true = 同 update_id 的重放(上次已写入成功) */
  replayed?: boolean;
}

export interface ParseLocationResponse {
  ok: true;
  parse: ParseResult;
}

export interface ScanHouseholdResponse {
  ok: true;
  scan: ScanResult;
}

export interface ApplyScanResponse {
  ok: true;
  result: ApplyScanResult;
}

export type LocationsApiOkResponse =
  | ListLocationsResponse
  | EnsurePathResponse
  | RenameLocationResponse
  | MoveLocationResponse
  | MergeLocationResponse
  | DeleteLocationResponse
  | LinkItemResponse
  | ParseLocationResponse
  | ScanHouseholdResponse
  | ApplyScanResponse;

export type LocationsApiResponse = LocationsApiOkResponse | LocationsApiErrorResponse;

/* ---------------- households 协议(issue #34 P1-A/P1-B:共享家庭生命周期) ---------------- */

/** 家庭内角色(owner = 创建者,独管邀请/移除/解散) */
export type HouseholdRole = "owner" | "member";

/** memberList 成员行(member_key 为服务端派生摘要句柄,不可逆、不构成 PII) */
export interface HouseholdMember {
  member_key: string;
  role: HouseholdRole;
  joined_at: string;
  invited_by: string | null;
  is_self: boolean;
  /** 展示资料(用户自设;null=未设置) */
  nickname: string | null;
  avatar_file_id: string | null;
}

/** inviteList 邀请元数据行(不含令牌与令牌哈希) */
export interface HouseholdInviteMeta {
  invite_id: string;
  created_at: string;
  expires_at: string;
  revoked: boolean;
  expired: boolean;
}

/** inviteCreate 响应:裸令牌只在本次响应出现一次(服务端只存哈希) */
export interface HouseholdInviteCreated {
  invite_id: string;
  token: string;
  expires_at: string;
}

/** status 响应(资格复核依据):个人态 role/scope_revision/display_name 为 null */
export interface HouseholdStatusResponse {
  ok: true;
  household_id: string;
  shared: boolean;
  role: HouseholdRole | null;
  scope_revision: number | null;
  display_name: string | null;
}

export interface HouseholdCreateResponse {
  ok: true;
  household_id: string;
  display_name: string;
  role: "owner";
  scope_revision: number;
  shared: true;
}

export interface HouseholdJoinResponse {
  ok: true;
  joined: boolean;
  already_member?: boolean;
  household_id: string;
  display_name: string;
  role: HouseholdRole;
  scope_revision: number;
}

export interface HouseholdInviteInfoResponse {
  ok: true;
  display_name: string;
}

export interface HouseholdMemberListResponse {
  ok: true;
  members: HouseholdMember[];
}

/** updateProfile 响应:回显本次落库的资料片段 */
export interface HouseholdUpdateProfileResponse {
  ok: true;
  profile: { nickname?: string; avatar_file_id?: string };
}

export interface HouseholdInviteListResponse {
  ok: true;
  invites: HouseholdInviteMeta[];
}

export type HouseholdsApiEvent =
  | { action: "status" }
  | { action: "updateProfile"; nickname?: string; avatar_file_id?: string }
  | { action: "create"; display_name?: string }
  | { action: "inviteCreate" }
  | { action: "inviteRevoke"; invite_id: string }
  | { action: "inviteList" }
  | { action: "inviteInfo"; token: string }
  | { action: "join"; token: string }
  | { action: "leave" }
  | { action: "removeMember"; member_key: string }
  | { action: "dissolve" }
  | { action: "memberList" };
