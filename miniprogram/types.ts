/**
 * 领域类型定义,与 docs/API_CONTRACT.md 保持一致。
 *
 * 注意:客户端不信任、不读取、不上传任何身份字段
 * (household_id / openid 全部由云函数服务端自行派生)。
 */

import type { Box } from "./utils/photo-box";

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
  /**
   * 提醒候选三项(issue #36,三项同现同缺,无提醒时均为 null):
   * - remind_at:原话里明确说了的绝对日期,服务端规范化为 YYYY-MM-DD(AI 只提取,
   *   绝不解析「下个月/快过期了/下周三」这类模糊或相对表述——一律不带);
   * - remind_kind:冻结词表(有效期/开封后/下次维护);
   * - remind_quote:该日期在原话中的逐字子串(锚定失败服务端已整体置 null)。
   * 客户端只透传与展示,不做任何日期推算;「存日期但不提醒」的模式不存在。
   */
  remind_at?: string | null;
  remind_kind?: RemindKind | null;
  remind_quote?: string | null;
  /**
   * 时间没换算的透明标记(0.6.0 真机反馈 Fix 4):原话中检测到时间表述但
   * 未换算的逐字子串(如「半年后」「下个月」),仅在 remind_at=null 且确有
   * 时间词时由服务端给出(子串校验失败置 null)。客户端只透传与展示。
   */
  remind_vague_quote?: string | null;
  /**
   * 相对时间换算标记(#36 真机反馈三件 A,产品拍板:产品换算,用户只确认):
   * true = 该件的 remind_at 来自服务端闭集换算器(extractDraft 组包处,锚点=
   * 提取时刻服务端今天 Asia/Shanghai)对 vague 原文的换算,remind_quote 即
   * 换算所依据的原话子串(如「半年后」)、remind_vague_quote 已置空。换算
   * 结果在确认卡是**候选**(用户可改可清),「不猜日期」的确认纪律不变;
   * 未换算的件不携带该字段。客户端只透传与展示。
   */
  remind_converted?: boolean | null;
  /**
   * 「放进」路径预览(issue #45 十七轮,#18 红线语义升级):仅 certain=true
   * 且位置能明确分层时服务端才给出(如「主卧的柜子上」→ ["主卧","柜子上"],
   * 每段逐字取自原话)。**这是预览不是写入**——用户在确认卡看过完整路径、
   * 点「确认记住」后才由 locations.ensureAndLink 建路径并挂上,绝不静默建
   * 路径;certain=false 一律 null(照旧先进「尚未归类」)。客户端只透传与
   * 展示,不拆层、不猜。
   */
  mount_path?: string[] | null;
}

/** 提醒类别(issue #36 冻结词表,与 extractDraft v2 的 remind_kind 同源) */
export type RemindKind = "有效期" | "开封后" | "下次维护";

/** create 的可选提醒参数(issue #36):到期只在小程序内露出,无任何推送/通知承诺 */
export interface ReminderInput {
  /** YYYY-MM-DD(真实日历日);唯一来源=原话提取值、服务端换算候选或用户在日期选择器里选的值 */
  due_date: string;
  kind: RemindKind;
  /** 日期仍为原话提取值(或换算候选)时携带的逐字锚定子串;日期选择器改过的提醒没有 quote */
  quote?: string;
  /**
   * 相对时间换算候选标记(#36 真机反馈三件 A):true = due_date 来自服务端
   * 对 vague 原文(quote)的闭集换算,用户在确认卡确认后随行提交;存入
   * reminder 文档,读侧投影据此标注「按『…』换算」。可选布尔,非布尔服务端拒绝。
   */
  remind_converted?: boolean;
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
export type ExtractDraftErrorCode = "AI_UNAVAILABLE" | "INVALID_INPUT";

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
      /** 可选提醒(issue #36):随物品同建;不带 = 无提醒 */
      reminder?: ReminderInput;
      /**
       * 可选「说了时间但没换算」的原话子串(0.6.0 真机反馈 Fix 4):存到
       * item 仅供详情页展示,不产生任何提醒;与 reminder 互斥(带 reminder 时
       * 服务端忽略)。服务端校验宽松(非空短文本即可)。
       */
      remind_vague_quote?: string;
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
  | { action: "list"; limit?: number }
  | (
      {
        /** 到期已处理(issue #36):把该 item 的到期提醒收掉;period_days>0 时按周期再生下次 */
        action: "remindComplete";
        item_id: string;
        /**
         * 提醒轮次号(PR #52 B1):remindList 行返回的 generation,服务端只完成
         * 用户实际看到的那一轮(条件更新);缺省=旧协议宽口径
         */
        expected_generation?: number;
        /** 周期天数(0-3650 整数;缺省/0=不再生);下次日期=完成基准日 + period_days */
        period_days?: number;
        /**
         * 用户本地自然日完成日(YYYY-MM-DD 真实日历日,PR #52 Low-3):家庭提醒
         * 日期按用户本地自然日的合同输入,服务端不靠运行时区猜;缺省走旧协议
         */
        complete_date?: string;
      } & ScopeWriteBinding
    )
  | ({ action: "remindClear"; item_id: string; expected_generation?: number } & ScopeWriteBinding)
  | (
      {
        /**
         * 拍照识物批量建档(#3,IMPLEMENTATION.md §1.3):逐件复用 create 语义
         * (operation_id 幂等/提醒 slot);进 WRITE_ACTIONS,api 层自动拼双 marker。
         */
        action: "photoCommit";
        /** 客户端 uuid(8-64),仅日志聚合口径 */
        batch_id: string;
        /** 1-10 件;任一件参数非法服务端整批零写入 */
        items: PhotoCommitItem[];
      } & ScopeWriteBinding
    )
  | { action: "photoEvidenceGet"; item_ids: string[] }
  | (
      {
        /**
         * 证据幂等重试关联(#3,PR #67 C3,IMPLEMENTATION.md §1.5):photoCommit
         * 响应 evidence_failed 非空后的收敛出口;进 WRITE_ACTIONS,api 层自动拼
         * 双 marker。服务端重验 file_id 归属(B2 同款)与逐件作用域内存活后补插
         * photo_evidence,唯一索引冲突=已存在=成功。
         */
        action: "photoEvidenceRetry";
        /** photoCommit 已取得的云存储 fileID(证据待关联的照片) */
        file_id: string;
        img_w: number;
        img_h: number;
        /** 1-10 件;每件 { item_id, box?(null=整照关联), source?("vl"|"circle") } */
        items: PhotoEvidenceRetryItem[];
      } & ScopeWriteBinding
    )
  | (
      {
        /** 单件物品视频留证:先申请服务端上传票据,再直传云存储 */
        action: "videoUploadBegin";
        purpose?: "item";
        item_id: string;
        ext?: "mp4" | "mov" | "m4v";
      } & ScopeWriteBinding
    )
  | (
      {
        /** PR B 场景扫描:一张票据在最终确认后为多件物品复用 */
        action: "videoUploadBegin";
        purpose: "scene";
        scene_id: string;
        ext?: "mp4" | "mov" | "m4v";
        duration_ms: number;
        video_w: number;
        video_h: number;
      } & ScopeWriteBinding
    )
  | (
      {
        /** 上传成功后立即回执 file_id,服务端据此清理未绑定孤儿视频 */
        action: "videoUploadReceipt";
        upload_ticket: string;
        file_id: string;
      } & ScopeWriteBinding
    )
  | (
      {
        /** 上传成功后凭票据绑定证据;服务端校验票据路径与文件可用性 */
        action: "videoEvidenceAttach";
        upload_ticket: string;
        file_id: string;
        duration_ms: number;
        video_w: number;
        video_h: number;
        consent_version: "v1";
      } & ScopeWriteBinding
    )
  | (
      {
        /** 上传失败/用户取消时作废票据(云文件由客户端删除后调用) */
        action: "videoUploadCancel";
        upload_ticket: string;
      } & ScopeWriteBinding
    )
  | { action: "videoEvidenceGet"; item_ids: string[] }
  | (
      {
        /**
         * 单件视频「AI 找这件物品」的用户确认高亮保存。
         * 只接受用户勾选后的时间窗与框；AI 原始候选/目标名/confidence 永不落库。
         * 整体替换该 evidence 的 highlights；版本 CAS + item 锁防并发/删除竞态；
         * 同 highlight_update_id 重放幂等。
         */
        action: "videoEvidenceHighlightSave";
        item_id: string;
        evidence_id: string;
        /** 页面读到的 highlight_version；初始 0 */
        expected_highlight_version: number;
        /** 用户确认保存的幂等键(uuid 8-64) */
        highlight_update_id: string;
        /** 1..8 条；服务端固定写入 source:"user_confirmed" 并升序规范化 */
        highlights: VideoEvidenceHighlightInput[];
      } & ScopeWriteBinding
    )
  | (VideoSceneCommitEvent & ScopeWriteBinding)
  | (
      {
        /** 删除某件物品的一条或全部视频证据(服务端先删云文件再删行) */
        action: "videoEvidenceDelete";
        item_id: string;
        evidence_id?: string;
      } & ScopeWriteBinding
    )
  | (
      {
        /** 给已有物品把提醒设为所选日子(issue #36):无则补录、有则改期(替换该 item 的提醒) */
        action: "remindSet";
        item_id: string;
        /** 用户在日期选择器选的日子(YYYY-MM-DD,真实日历日) */
        due_date: string;
        /** 提醒类别(缺省「下次维护」;携带须在冻结词表 有效期/开封后/下次维护 内) */
        kind?: RemindKind;
        /**
         * 提醒轮次号(PR #52 B1):页面所见轮次(0=页面确认无提醒,补录);
         * 与服务端不符 → VERSION_CONFLICT,绝不静默覆盖他人后来更新的提醒
         */
        expected_generation?: number;
      } & ScopeWriteBinding
    )
  | { action: "remindList" };

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

/** remindList 的行投影(issue #36):不含内部字段;quote 仅换算行以 remind_quote 携带(见下) */
export interface RemindRow {
  item_id: string;
  name: string;
  location_text: string;
  /** YYYY-MM-DD(真实日历日) */
  due_date: string;
  kind: RemindKind;
  /**
   * 提醒轮次号(PR #52 B1,同一物品内单调递增):写操作 expected_generation
   * 的前置条件来源;旧云函数窗口可能缺省(此时客户端不携带轮次号,走旧协议)
   */
  generation?: number;
  /**
   * 相对时间换算标记(#36 真机反馈三件 A):true = due_date 来自服务端闭集
   * 换算的候选(仅换算行携带);详情页保质期行据此标注「按『…』换算」。
   * 常规行(原话绝对日期/选择器日期)不带该字段。
   */
  remind_converted?: boolean;
  /** 换算所依据的原话子串(如「半年后」);仅 remind_converted=true 的行携带 */
  remind_quote?: string;
}

export interface RemindListResponse {
  ok: true;
  /** 作用域字段口径同 list(issue #34 P0/P1-A):remindComplete/remindClear 写请求双 marker 的捕获来源 */
  household_id?: string;
  scope_revision?: number;
  /** due_date 升序(同日按 created_at、再按 _id) */
  reminders: RemindRow[];
}

export interface RemindCompleteResponse {
  ok: true;
  /** period_days>0 时再生的下次提醒行(同 remindList 行投影);不带周期时缺省 */
  reminder?: RemindRow;
}

export interface RemindClearResponse {
  ok: true;
  /** 硬删除的 active 提醒条数(幂等,无可清时 0 也是成功) */
  cleared: number;
}

export interface RemindSetResponse {
  ok: true;
  /** 设好后的提醒行(同 remindList 行投影) */
  reminder: RemindRow;
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
  | ListItemsResponse
  | RemindListResponse
  | RemindCompleteResponse
  | RemindClearResponse
  | RemindSetResponse
  | PhotoCommitResponse
  | PhotoEvidenceGetResponse
  | PhotoEvidenceRetryResponse
  | VideoUploadBeginResponse
  | VideoUploadReceiptResponse
  | VideoEvidenceAttachResponse
  | VideoUploadCancelResponse
  | VideoEvidenceGetResponse
  | VideoEvidenceHighlightSaveResponse
  | VideoSceneCommitResponse
  | VideoEvidenceDeleteResponse;

export type ItemsApiResponse = ItemsApiOkResponse | ItemsApiErrorResponse;

/* ---------------- extractDraft 请求与响应 ---------------- */

export interface ExtractDraftEvent {
  text: string;
}

/**
 * 单帧目标识别(extractDraft.videoTargetRecognize)：只走现有 VL，无状态、不落库。
 * 时间不由服务端接收；客户端候选 time_ms 来自抽帧计划的 seek 目标。
 */
export interface ExtractDraftVideoTargetEvent {
  action: "videoTargetRecognize";
  /** 目标物品名，trim 后 1..40 code points；只用于当次 prompt，不落日志 */
  target_name: string;
  /** 裸 base64(无 data: 前缀/空白)，≤4,000,000 字符 */
  image_base64: string;
  img_w: number;
  img_h: number;
}

/** 单帧受控识别结果：hit 且 box 非空才是可确认候选 */
export interface ExtractDraftVideoTargetResponse {
  ok: true;
  hit: boolean;
  box: Box | null;
  confidence: "high" | "mid" | "low";
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
  | {
      action: "parseLocation"; text: string;
    }
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
    } & ScopeWriteBinding)
  | ({
      /**
       * 确认卡「放进」的一次性落地(issue #45 十七轮,#18 红线语义升级):
       * 建缺失路径 + 挂上一件完成。路径已在确认卡明示、用户点确认 = 已确认,
       * 服务端不再拦;绝不静默建路径。
       */
      action: "ensureAndLink";
      item_id: string;
      /** 确认卡明示过的最终路径(1-6 段,每段 1-30 字,首段=房间/大区域) */
      path: string[];
      /** create 返回的物品版本(挂靠按 linkItem 同款版本条件更新) */
      expected_version: number;
      /** 同一次逻辑挂载的标识(uuid):失败重试同内容复用,服务端据此识别重放 */
      update_id: string;
      /** 缺省 manual;确认卡路径来自原话拆层时用 parse */
      created_from?: "scan" | "parse" | "manual";
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
  /**
   * 未挂载物品明细投影(#36 0.6.0 真机反馈 Fix 3,仅根层响应携带):
   * item_id/name/location_text 三字段,上限 50 条按 updated_at 倒序——
   * 首页「尚未归类」点进去看得见录了什么;缓存口径跟随 list 响应整体失效规则。
   */
  unmounted_items?: Array<{
    item_id: string;
    name: string;
    location_text: string;
  }>;
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

/** ensureAndLink 响应(issue #45 十七轮):路径就位(或本来已挂同一路径),物品挂上 */
export interface EnsureAndLinkResponse {
  ok: true;
  /** true = 已挂同一路径(重复确认/响应丢失重试的幂等收敛点),version 未再 +1 */
  already: boolean;
  /** true = 同 update_id 的重放收敛 */
  replayed?: boolean;
  item: { item_id: string; version: number; updated_at: string };
  path: string[];
  created: boolean[];
  location_ids: string[];
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
  | ApplyScanResponse
  | EnsureAndLinkResponse;

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
  /** 本人展示资料(status 携带,主页头像入口渲染) */
  self_nickname: string | null;
  self_avatar_file_id: string | null;
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

/**
 * switch 响应(issue #45 十七轮切换家庭):新家庭 status 摘要(与 status 同口径)。
 * already=true 表示本就在目标家庭(幂等);display_name 个人家庭为 null。
 */
export interface HouseholdSwitchResponse {
  ok: true;
  target: "personal" | "shared";
  already: boolean;
  household_id: string;
  shared: boolean;
  role: HouseholdRole | null;
  scope_revision: number | null;
  display_name: string | null;
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
  | { action: "memberList" }
  | { action: "switch"; target: "personal" | "shared" };

/* ---------------- 拍照识物(#3,docs/design/issue3-photo-intake/IMPLEMENTATION.md) ---------------- */

/** VL 识别置信度(vlRecognize 响应词表,词表外服务端已按 "low" 收敛) */
export type VlConfidence = "high" | "mid" | "low";

/** vlRecognize 响应的单件候选行(服务端已校验清洗;box 已归一 0-1,null=无框整照关联) */
export interface VlCandidate {
  /** 中文物品名,1-50 码点 */
  name: string;
  /** 数量线索原样(如「约2根」;可空串,≤40 码点) */
  qty_note: string;
  confidence: VlConfidence;
  /** 0-1 相对原图左上角;null = 该件无框 */
  box: Box | null;
}

/**
 * 拍照识物确认页的候选行(与 photo-session 会话载荷同形状,IMPLEMENTATION.md §4.1;
 * 供页面与 utils 共用)。三态:未勾选=「候选」、checked=「保留(待存)」、
 * 保存成功=「已确认记住」(done 态由 intake-draft 的行状态承载,不进本形状)。
 */
export interface PhotoCandidate {
  /** 入列即生成的稳定标识(uuid):锁定/语音编辑/计数一律以此为准,绝不按行号 */
  draftId: string;
  name: string;
  /** 数量拆 qty+suffix(V0.4.2 单一来源;qty 域 1-99,数量只是备注不做库存) */
  qty: number;
  /** 数量备注后缀(空串按「备注」展示;与 qty 共同拼成 note 文本) */
  suffix: string;
  /** 位置例外(null=继承批次默认位置;非空=该件单独位置,保存确认只汇总已勾选件的例外) */
  exc: string | null;
  /**
   * 行来源:照片识别 / 语音补录 / 圈选补识别 / 手动补录。
   * "manual" = VL 不可用降级或用户点「＋手动添加物品」补的行(§7.1:box=null
   * 整照关联,保存时才首次上传,photoCommit 照常);无 VL 依据,置信度恒 "low"。
   */
  src: "ai" | "voice" | "circle" | "manual";
  /** VL 置信度(voice 行无 VL 依据,恒 "low" 且无框,不参与框样式) */
  confidence: VlConfidence;
  /** 0-1 相对原图;null = 无框(手动/语音行,整照关联) */
  box: Box | null;
  /** 勾选=「保留」;未勾=「候选」(AI 预选规则:confidence="high" 默认勾选) */
  checked: boolean;
  /** 入列即生成的 photoCommit 幂等键(uuid):内容改后仍沿用,服务端同键同内容幂等 */
  operationId: string;
  /**
   * 提醒日期(可选,屏④手动编辑面板的 picker;YYYY-MM-DD)。null/缺省=不设提醒;
   * 保存时映射为 photoCommit 的 reminder {due_date, kind}(kind 冻结词表,缺省「下次维护」)。
   */
  remind?: { due_date: string; kind: RemindKind } | null;
}

/* ---------------- 拍照识物:photoCommit / photoEvidenceGet(§1.3/§1.4) ---------------- */

/** photoCommit 单件的 photo 证据绑定(该行绑了照片证据才携带) */
export interface PhotoCommitPhoto {
  /** 用户点「确认,记住了」后 wx.cloud.uploadFile 得到的云存储 fileID(确认前不存在) */
  file_id: string;
  /** 压缩图实测宽高(与 vlRecognize 上送值一致,坐标反算基准) */
  img_w: number;
  img_h: number;
  /** 0-1 相对原图;null = 无框(整照关联的手动/语音行) */
  box: Box | null;
  /** "vl" = AI 识别框 | "circle" = 用户圈选 */
  source: "vl" | "circle";
}

/** photoCommit 单件(与 create 同形状的建档参数 + 可选 photo) */
export interface PhotoCommitItem {
  /** 行内固定幂等键(重试沿用;内容改后仍沿用,服务端同键同内容幂等/异内容冲突) */
  operation_id: string;
  name: string;
  /** 批次位置或该件例外(客户端已合成) */
  location_text: string;
  /** 数量备注,客户端拼 "×{qty} {suffix}" */
  note?: string;
  /** 可选提醒,与 create 完全同形状 */
  reminder?: ReminderInput;
  photo?: PhotoCommitPhoto;
}

export interface PhotoCommitResultRow {
  /** items 内 0-based 下标回执 */
  index: number;
  ok: boolean;
  item_id?: string;
  duplicated?: boolean;
  evidence_saved?: boolean;
  /**
   * ok:true 时携带:该件建档后的版本(issue #65 V0.4 第③条,拍照位置挂树):
   * 客户端随后 locations.ensureAndLink 挂树的 expected_version 取它;duplicated
   * 重放时为既有文档当前版本。旧云函数窗口缺省 → 客户端跳过挂树不误报
   */
  version?: number;
  /** ok:false 时携带 */
  error?: string;
  message?: string;
}

export interface PhotoCommitResponse {
  ok: true;
  results: PhotoCommitResultRow[];
  /**
   * 证据写入失败的 item_id 列表(PR #67 C3,部分成功语义):这些件物品已建、
   * 照片待关联——客户端走 photoEvidenceRetry 幂等重试;缺省/空 = 全部关联成功
   */
  evidence_failed?: string[];
}

/** photoEvidenceRetry 单件(C3):item_id + 该行的框与来源(照片宽高在事件顶层) */
export interface PhotoEvidenceRetryItem {
  item_id: string;
  /** 0-1 相对原图;null/缺省 = 无框(整照关联) */
  box?: Box | null;
  /** "vl" = AI 识别框 | "circle" = 用户圈选;缺省 "vl" */
  source?: "vl" | "circle";
}

/** photoEvidenceRetry 逐件回执(C3) */
export interface PhotoEvidenceRetryResultRow {
  /** items 内 0-based 下标回执 */
  index: number;
  item_id: string;
  ok: boolean;
  /** ok:true 时:true=本次新写入,false=已存在(唯一索引幂等) */
  evidence_saved?: boolean;
  /** ok:false 时携带(NOT_FOUND / EVIDENCE_WRITE_FAILED) */
  error?: string;
  message?: string;
}

export interface PhotoEvidenceRetryResponse {
  ok: true;
  results: PhotoEvidenceRetryResultRow[];
}

/** photoEvidenceGet 的证据行投影(§1.4) */
export interface PhotoEvidenceRow {
  item_id: string;
  file_id: string;
  /** getTempFileURL 临时链接;换链失败为 ""(file_id 仍在,客户端可重试) */
  photo_url: string;
  box: Box | null;
  img_w: number;
  img_h: number;
  captured_location_text: string;
  source: "vl" | "circle";
  created_at: string;
}

export interface PhotoEvidenceGetResponse {
  ok: true;
  household_id?: string;
  scope_revision?: number;
  evidence: PhotoEvidenceRow[];
}

/* ---------------- 单件视频留证:videoUploadBegin / videoEvidenceAttach / videoEvidenceGet ---------------- */

/** 用户确认后的视频高亮；只持久化时间窗+框+固定来源，不存 AI 原始输出 */
export interface VideoEvidenceHighlight {
  /** 视频内起始毫秒(含) */
  start_ms: number;
  /** 视频内结束毫秒(不含)，<= duration_ms */
  end_ms: number;
  /** 0-1，相对完整视频帧左上原点；null = 仅时间窗、无框（不为旧行伪造） */
  box: Box | null;
  /**
   * 框对应的视频内观察帧毫秒（可选，[start_ms,end_ms)）。
   * 缺省时读取方按 start_ms 处理；保存时客户端可带抽帧时间，避免框与窗口起点错位。
   */
  frame_ms?: number;
  source: "user_confirmed";
}

/** 保存请求里的候选高亮：来源由服务端固定，客户端不得自报 */
export interface VideoEvidenceHighlightInput {
  start_ms: number;
  end_ms: number;
  /** 必填但可为 null；null = 仅时间窗、无框 */
  box: Box | null;
  /** 可选：框对应观察帧毫秒，携带时须在 [start_ms,end_ms) 内 */
  frame_ms?: number;
}

export interface VideoEvidenceRow {
  evidence_id: string;
  item_id: string;
  file_id: string;
  /** 同一物理原视频的逻辑组;旧 #89 行可能缺省 */
  asset_id?: string;
  /** manual=单件留证,scene=场景扫描批量确认 */
  source?: "manual" | "scene";
  /** getTempFileURL 临时播放链接;"" = 换链失败,可重试 */
  video_url: string;
  duration_ms: number;
  video_w: number;
  video_h: number;
  captured_location_text: string;
  /** 服务端认可的用户授权版本;"" = 旧/异常行,客户端不展示 */
  consent_version: string;
  /** 用户确认过的高亮；旧行/异常行为 []。AI 候选不会出现在这里 */
  highlights: VideoEvidenceHighlight[];
  /** 高亮版本 CAS 基准；旧行/异常行为 0 */
  highlight_version: number;
  created_at: string;
}

export interface VideoUploadBeginResponse {
  ok: true;
  upload_ticket: string;
  upload_path: string;
  expires_at: string;
  /** 服务端生成的物理文件逻辑组；scene 模式必须随 commit 回传校验 */
  asset_id?: string;
}

export interface VideoUploadReceiptResponse {
  ok: true;
}

export interface VideoEvidenceAttachResponse {
  ok: true;
  evidence: VideoEvidenceRow;
  duplicated: boolean;
}

export interface VideoUploadCancelResponse {
  ok: true;
  /** cancelled=确实清理;bound=服务端发现证据已绑定,文件不可删 */
  state: "cancelled" | "bound";
  /** state=bound 时返回正式证据,客户端应恢复为回放态 */
  evidence?: VideoEvidenceRow;
  /** scene ticket 已绑定多个 item 时列出全部关联 item_id */
  linked_item_ids?: string[];
  evidence_count?: number;
}

export interface VideoEvidenceGetResponse {
  ok: true;
  household_id?: string;
  scope_revision?: number;
  evidence: VideoEvidenceRow[];
}

export interface VideoEvidenceHighlightSaveResponse {
  ok: true;
  evidence_id: string;
  highlights: VideoEvidenceHighlight[];
  highlight_version: number;
  /** true = 同 highlight_update_id 幂等重放，版本未再次递增 */
  duplicated: boolean;
}

export interface VideoSceneCommitNewItem {
  draft_key: string;
  target: "new";
  operation_id: string;
  name: string;
  location_text: string;
  note?: string;
  highlights: VideoEvidenceHighlightInput[];
}

export interface VideoSceneCommitExistingItem {
  draft_key: string;
  target: "existing";
  item_id: string;
  highlights: VideoEvidenceHighlightInput[];
}

export type VideoSceneCommitItem = VideoSceneCommitNewItem | VideoSceneCommitExistingItem;

export interface VideoSceneCommitEvent {
  action: "videoSceneCommit";
  scene_id: string;
  upload_ticket: string;
  /** videoUploadBegin(purpose:"scene") 返回值；必须与票面 asset_id 一致 */
  asset_id: string;
  file_id: string;
  duration_ms: number;
  video_w: number;
  video_h: number;
  consent_version: "v1";
  items: VideoSceneCommitItem[];
}

export interface VideoSceneCommitResultRow {
  draft_key: string;
  ok: boolean;
  item_id?: string;
  created?: boolean;
  duplicated?: boolean;
  evidence_saved?: boolean;
  evidence_duplicated?: boolean;
  error?: string;
  message?: string;
}

export interface VideoSceneCommitResponse {
  ok: true;
  scene_id: string;
  asset_id: string;
  ticket_state: "bound" | "partial";
  results: VideoSceneCommitResultRow[];
  /** 未完成/证据写入失败的 draft_key；客户端用同一冻结载荷重试 */
  evidence_failed?: string[];
}

export interface VideoEvidenceDeleteResponse {
  ok: true;
  deleted: number;
}

/* ---------------- 拍照识物:draftEditParse(§1.2,语音受限编辑) ---------------- */

export interface DraftEditParseEvent {
  action: "draftEditParse";
  /** 用户原话(去空白后 1-200 码点) */
  text: string;
  /** 当前批次默认位置(给模型看) */
  batch_location: string;
  /** 当前候选清单(1-12 项;draft_id 页面侧为 IntakeRow.draftId) */
  candidates: { draft_id: string; name: string }[];
}

export type DraftEditIntent = "edit" | "add" | "batch_location" | "none";

export interface DraftEditRow {
  /** 服务端白名单 {"name","qty_note","location"} */
  field: "name" | "qty_note" | "location";
  /** 仅展示用 */
  old?: string;
  new: string;
}

export interface DraftEditPick {
  draft_id: string;
  name: string;
}

/**
 * 五分支响应(intent 是判别字段;needs_pick=true 时 edits 必空、target 必 null,
 * 服务端硬门已保证,客户端不做二次判断)。
 */
export type DraftEditParseResponse =
  | {
      ok: true;
      engine: string;
      intent: "edit";
      target: { draft_id: string; matched_word?: string } | null;
      edits: DraftEditRow[];
      needs_pick: boolean;
      picks: DraftEditPick[];
    }
  | {
      ok: true;
      engine: string;
      intent: "add";
      added: { name: string; qty_note?: string };
      needs_pick: false;
      picks: DraftEditPick[];
    }
  | {
      ok: true;
      engine: string;
      intent: "batch_location";
      new_location: string;
      needs_pick: false;
      picks: DraftEditPick[];
    }
  | { ok: true; engine: string; intent: "none"; needs_pick: false; picks: DraftEditPick[] };

/* ---------------- 拍照识物:locationSplit(§1.6,位置层级拆分) ---------------- */

export interface LocationSplitEvent {
  action: "locationSplit";
  /** 位置原文(去空白后 1-200 码点) */
  text: string;
}

export interface LocationSplitResponse {
  ok: true;
  engine: string;
  /** 层级路径(1-6 段、每段 1-30 码点、逐字取自原文且按序) */
  path: string[];
  /** true = 模型输出未过硬校验,整串单段兜底(客户端不优先采用,回落分隔符规则) */
  fallback: boolean;
}
