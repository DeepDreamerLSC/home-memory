import { applyPageAppearance } from "../../utils/appearance-page";
import {
  ApiError,
  callItemsApi,
  callVideoTargetRecognize,
  errorMessage,
  formatDateTime,
  uuid,
} from "../../utils/api";
import {
  UNIT_SET,
  isUnit,
  isValidExistingQuantity,
  normalizeQuantityFields,
  parseQuantityText,
  quantityConfirmedText,
} from "../../utils/quantity";
import { ensureScopeVerified } from "../../utils/households-api";
import { itemArtwork } from "../../utils/ui";
import {
  callLocationsApi,
  deletingFrozenMessage,
  isLocationsApiErrorWithCode,
} from "../../utils/locations-api";
import {
  captureScopeGeneration,
  householdScopeId,
  householdScopeSuffix,
  isHouseholdScopeShared,
  isScopeGenerationCurrent,
} from "../../utils/household-scope";
import {
  askKeepAfterDone,
  askUseUp,
  expireMainText,
  localTodayYmd,
  monthDayText,
  pickerDateProblem,
  pickerStartYmd,
} from "../../utils/remind-ui";
import {
  buildUpdateChanges,
  carryUnresolved,
  chosenValue,
  conflictUnresolved,
  mergeLatest,
  resolveRemindChoice,
} from "../../utils/conflict";
import type {
  ConflictChoice,
  ConflictField,
  EditableField,
} from "../../utils/conflict";
import type {
  ItemSummary,
  PhotoEvidenceRow,
  RemindKind,
  RemindRow,
  VideoEvidenceHighlightInput,
  VideoEvidenceRow,
} from "../../types";
import type { Box } from "../../utils/photo-box";
import { mapEvidenceView } from "../../utils/evidence-view";
import type { EvidenceView } from "../../utils/evidence-view";
import {
  defaultVideoHighlightView,
  mapVideoEvidenceView,
  selectVideoPlaybackTarget,
  type VideoEvidenceCollectionView,
  type VideoEvidenceView,
  type VideoHighlightBoxView,
  type VideoPlaybackHint,
  type VideoPlaybackTarget,
} from "../../utils/video-evidence";
import {
  boxPercentStyle,
  createVideoFrameSession,
  findVideoTargetCandidates,
  highlightWindowText,
  isVideoTargetError,
  videoTargetEntryState,
  type VideoFrameSession,
  type VideoTargetCandidate,
} from "../../utils/video-target";
import {
  attachVideoToItem,
  chooseVideoFile,
  discardPendingVideo,
  loadPendingVideo,
  retryPendingVideo,
  type PendingVideoUpload,
} from "../../utils/video-attach";
import { askNotifyIntent, requestExpirySubscribe } from "../../utils/subscribe";
import {
  clearNotifyAccepted,
  isNotifyAccepted,
  markNotifyAccepted,
} from "../../utils/notify-accepted";

interface VideoAiCandidateView {
  key: string;
  frameIndex: number;
  timeMs: number;
  windowStartMs: number;
  windowEndMs: number;
  timeText: string;
  framePath: string;
  box: Box;
  boxStyle: string;
  confidenceText: string;
  selected: boolean;
}

let activeVideoAiSession: VideoFrameSession | null = null;
let activeVideoAiItemId = "";
let activeVideoAiRunToken = 0;

async function cancelActiveVideoAi(itemId?: string): Promise<void> {
  if (itemId !== undefined && activeVideoAiItemId !== itemId) return;
  activeVideoAiRunToken += 1;
  const session = activeVideoAiSession;
  activeVideoAiSession = null;
  activeVideoAiItemId = "";
  if (session !== null) {
    await session.cancel();
  }
}

function videoAiErrorText(error: unknown): string {
  if (isVideoTargetError(error)) {
    if (error.code === "cancelled") return "已取消本次识别";
    if (error.code === "unsupported") return "当前基础库不支持视频抽帧,可正常回放";
    if (error.code === "too_large") return "视频帧过大,无法识别,请尝试更短的视频";
    if (error.code === "recognize_unavailable") return "AI 暂不可用,请稍后再试";
    if (error.code === "extract_failed") return "视频抽帧失败,请换一段视频再试";
  }
  return errorMessage(error);
}

function aiCandidateView(candidate: VideoTargetCandidate): VideoAiCandidateView {
  return {
    key: String(candidate.frameIndex),
    frameIndex: candidate.frameIndex,
    timeMs: candidate.timeMs,
    windowStartMs: candidate.windowStartMs,
    windowEndMs: candidate.windowEndMs,
    timeText: highlightWindowText(candidate.windowStartMs, candidate.windowEndMs),
    framePath: candidate.framePath,
    box: candidate.box as Box,
    boxStyle: boxPercentStyle(candidate.box),
    confidenceText: candidate.confidence === "high" ? "高置信" : candidate.confidence === "mid" ? "中置信" : "低置信",
    selected: false,
  };
}

/** 页面 query 参数不会自动解码;容错解码(已解码或含非法 % 时原样返回) */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 记录更新日期短文案(如 10-08,与首页一致;updated_at 不代表位置确认时间);非法时间如实返回空串 */
function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return "";
  }
  const d = new Date(t);
  const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
  return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/**
 * 解析跳转方带来的空间路径(进入时的容器层 path,JSON 字符串数组)。
 * 只信严格结构:非数组 / 含非字符串 / 超 6 段一律视为没有,不猜。
 */
function parseSpacePath(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const p = JSON.parse(safeDecode(raw)) as unknown;
    if (!Array.isArray(p) || p.length === 0 || p.length > 6) {
      return [];
    }
    if (!p.every((seg) => typeof seg === "string" && seg.trim().length > 0)) {
      return [];
    }
    return p.map((seg) => (seg as string).trim());
  } catch {
    return [];
  }
}

/** 搜索 badge 的只读定位 hint；非法时降级为无 hint，不阻断详情主体。 */
function parseVideoPlaybackHint(options: Record<string, string | undefined>): VideoPlaybackHint | null {
  if (options == null || safeDecode(options.video_entry || "") !== "search_badge") return null;
  const evidenceId = safeDecode(options.video_evidence_id || "").trim();
  if (evidenceId === "" || evidenceId.length > 160) return null;
  const hasStart = typeof options.video_hint_start_ms === "string" && options.video_hint_start_ms.trim() !== "";
  const hasEnd = typeof options.video_hint_end_ms === "string" && options.video_hint_end_ms.trim() !== "";
  if (hasStart === false || hasEnd === false) return { evidenceId, startMs: null, endMs: null };
  const start = Number(options.video_hint_start_ms);
  const end = Number(options.video_hint_end_ms);
  if (Number.isSafeInteger(start) === false || Number.isSafeInteger(end) === false || start < 0 || end <= start) {
    return { evidenceId, startMs: null, endMs: null };
  }
  return { evidenceId, startMs: start, endMs: end };
}

/** 折叠条目标文案：只描述用户确认过的片段，不把 AI 候选写成事实。 */
function videoFoldTextFor(selected: VideoEvidenceView, highlightKey: string): string {
  if (selected.playable === false) return "🎬 视频暂时无法加载 · 点按重试";
  const highlight =
    selected.highlights.find((h) => h.key === highlightKey) ||
    defaultVideoHighlightView(selected.highlights);
  if (highlight !== null) {
    return "🎬 你确认过的片段 " + highlight.rangeText + " · 点开回看";
  }
  return "🎬 点开当时视频 · " + selected.badge;
}

/** 回退/换链说明：失败不伪装成“无视频”，也不静默换行。 */
function videoFallbackNotice(
  target: VideoPlaybackTarget,
  view: VideoEvidenceCollectionView,
  selected: VideoEvidenceView,
): string {
  if (target.fallbackReason === "explicit_url_failed") {
    return target.mode === "unavailable"
      ? "原目标视频暂时无法加载,点按重试。"
      : "原目标视频暂时无法加载,已回退到更早的一条留证。";
  }
  if (
    target.fallbackReason === "explicit_not_found" ||
    target.fallbackReason === "explicit_highlight_missing"
  ) {
    return "原来的视频片段不可用了,已回到这段视频的普通回放。";
  }
  if (target.fallbackReason === "all_urls_failed") {
    return "视频暂时无法加载,点按重试。";
  }
  if (view.latest.urlFail && selected.evidenceId !== view.latest.evidenceId) {
    return "最新一条视频暂时无法加载,当前查看更早的一条留证。";
  }
  return "";
}

/** 刷新最新数据的结果 */
type DetailPanel = "" | "location" | "quantity" | "reminder" | "media" | "info";

type RefreshResult = "refreshed" | "notfound" | "error";

/** 冲突态面板里的单个字段条目:两版值 + 用户显式选择(null 表示尚未选择);
    display* 为并排展示文案(提醒日期换算成用户词汇) */
type ConflictEntry = ConflictField & {
  choice: ConflictChoice | null;
  localDisplay: string;
  remoteDisplay: string;
};

/** 冲突面板里某字段值的展示口径:提醒换算为「X 到期 / 不带提醒」,文本空值为「(空)」 */
function conflictDisplayText(key: EditableField, value: string): string {
  if (key === "remind") {
    return value ? monthDayText(value) + " 到期" : "不带提醒";
  }
  return value || "(空)";
}

Page<
  {
    detailPanel: DetailPanel;
    mediaTab: "photo" | "video";
    mediaScrollTarget: string;
    recordedName: string;
    recordedNote: string;
    recordedRemindAt: string;
    quantityShortText: string;
    quantityIsZero: boolean;
    quantityUnitVerified: boolean;
    quantityUnitChanged: boolean;
    reminderDateDraft: string;
    reminderConfirming: boolean;
    reminderNeedsSave: boolean;
    locationPathDraft: string[];
    locationCommitSaving: boolean;
    panelError: string;
    photoLookupFailed: boolean;
    itemId: string;
    name: string;
    locationText: string;
    recordedLocationText: string;
    artworkLight: string;
    artworkDark: string;
    detailQuoteOpen: boolean;
    note: string;
    version: number;
    updatedAtText: string;
    /** 头部「记录更新于 MM-DD」(updated_at:名称/备注/位置任意修改都会刷新,只说明记录更新,不代表确认过位置;非法时间退化为完整时间,再退化则不显示) */
    lastConfirmedText: string;
    /** 只读大卡的当前空间路径(进入时的容器层;整理位置成功后更新) */
    spacePath: string[];
    /** 编辑表单是否展开(常态折叠,先答案后操作) */
    editPanelOpen: boolean;
    /** 「⋯」次级菜单(底部弹层)是否展开 */
    moreOpen: boolean;
    /** 共享家庭才显示「分享给家人」 */
    familyShared: boolean;
    saving: boolean;
    deleting: boolean;
    /** 「整理位置」解析中(parseLocation) */
    mounting: boolean;
    /** 候选分段面板是否展开 */
    mountPanelOpen: boolean;
    /** parseLocation 的候选分段(可逐段改名) */
    mountSegments: Array<{
      idx: number;
      name: string;
      confidenceText: string;
      needConfirm: boolean;
      hintName: string;
    }>;
    mountNeedConfirm: boolean;
    mountOrderViolation: boolean;
    /** 确认整理执行中(ensurePath + linkItem) */
    mountSaving: boolean;
    /**
     * 保质期行(#36):这件有 active 提醒才显示(mainText=有效期+相对天数,
     * kind=「已处理」时收掉本轮提醒);null=无 active 提醒,整行不渲染;
     * convertedNote(#36 真机反馈三件 A)= 提醒行是服务端相对时间换算候选时
     * 携带的换算源原话(如「半年后」),非空时行内小字标注「按『…』换算」
     */
    expire: {
      mainText: string;
      dueDate: string;
      kind: string;
      convertedNote?: string;
    } | null;
    /** 编辑折叠「提醒」字段的当前日期(YYYY-MM-DD;""=不带提醒) */
    remindAt: string;
    /**
     * 页面所见提醒轮次号(PR #52 B1):-1=未知(未加载/加载失败/旧服务端缺
     * generation)——此时一律不发 reminder 写(F4-B2,绝不退回旧协议无条件写),
     * 先补拉读到 0/真实轮次后才带 expected_generation 提交;0=已确认无提醒
     * (补录语义);≥1=所见轮次
     */
    remindGeneration: number;
    /** 今天(YYYY-MM-DD):编辑提醒的日期选择器下限 */
    /** 提醒日期滚轮起点(8 点后=明天;remind-ui.pickerStartYmd) */
    pickerStart: string;
    /** 提醒操作执行中(已处理/改日期/清除;防并发重复提交) **/
    remindBusy: boolean;
    /**
     * 「到期时微信提醒我 ›」显式订阅入口(#36 真机手势规则):该物品当前有
     * 生效提醒(remindAt 非空)且本地未标记「已成功开启」时显示;本地标记
     * 是展示启发式(键按家庭作用域隔离,换家庭重读)——权威订阅记录在服务端
     * remind_subscriptions,本标记不参与任何发送决策
     */
    notifyAccepted: boolean;
    /**
     * 订阅手势诊断页入口是否显示(#36 鸿蒙真机手势排查):仅 develop 环境为
     * true(onLoad 计算);正式版/体验版恒 false,诊断页不进入用户视野
     */
    diagEntryVisible: boolean;
    /**
     * 设提醒时「要不要微信提醒」的用户意向(0.9.6,#36 用户反馈):onRemindDateChange
     * 里经 askNotifyIntent 询问后更新;保存路径按它决定是否请求订阅授权
     * (true=询问——AI 预填日期等未经弹窗的路径保持既有自动询问;false=明确
     * 拒绝过,本次保存跳过订阅询问)
     */
    wantsNotify: boolean;
    /**
     * 当时提到时间但没换算的原话子串(0.6.0 真机反馈 Fix 4,来自 itemsApi.get
     * 的 remind_vague_quote):录入时「说了时间但没换算成日期」的如实留痕,
     * 只展示、不产生任何提醒;已有 active 提醒(到期行在屏)时不再显示。
     */
    vagueQuote: string;
    /** 版本冲突后待处理的冲突字段(名称/位置/备注/提醒);为空表示无冲突态 */
    conflicts: ConflictEntry[];
    /** 存在未选择的冲突字段时禁止再次保存(按钮禁用 + 双保险门禁) */
    conflictPending: boolean;
    /**
     * 照片证据回放卡(#3 §6):拉取成功且有证据行才为 true(折叠条默认);
     * 拉取失败静默 false(整卡不渲染,证据是增强露出,绝不打扰详情主体)。
     * 照片是历史证据:只说明「拍摄于某日 · 当时记录在哪」,绝不冒充当前位置。
     */
    evidenceReady: boolean;
    /** 拉取成功但无证据行:显示「去补拍」行(原型屏⑥ nocard);失败时不显示 */
    evidenceNoPhoto: boolean;
    /** 证据卡展开态(折叠为常态,点照片条展开回放) */
    evidenceOpen: boolean;
    /** 「更早的照片 N 张」列表展开(同一物品多次拍照,§6.5) */
    evidenceOlderOpen: boolean;
    /** 证据卡渲染视图(mapEvidenceView 派生;evidenceReady 才有意义) */
    evidence: EvidenceView | null;
    /** 视频证据卡:默认折叠、明确点击才播放;有视频才渲染 */
    videoReady: boolean;
    videoOpen: boolean;
    videoEvidence: VideoEvidenceCollectionView | null;
    videoSelected: VideoEvidenceView | null;
    videoSelectedHighlightKey: string;
    videoFoldText: string;
    videoPlaybackNotice: string;
    videoPlaybackError: string;
    videoInitialTime: number;
    videoSeekPending: boolean;
    videoCurrentMs: number;
    videoActiveBox: VideoHighlightBoxView | null;
    videoLookupFailed: boolean;
    videoBusy: boolean;
    /** 上传成功但绑定失败的待关联视频(本地恢复凭据) */
    videoPending: PendingVideoUpload | null;
    videoPendingExpired: boolean;
    videoPendingText: string;
    videoAiBusy: boolean;
    videoAiProgress: string;
    videoAiCandidates: VideoAiCandidateView[];
    videoAiError: string;
    videoAiNoHit: boolean;
    /**
     * 数量区(issue #102 Q1,Q0-CONTRACT §10.1/§10.3):quantityText = 详情头
     * 「上次确认 ×N单位 · MM-DD」或「待核对」(唯一来源 = 投影字段,绝不从 note
     * 推断);quantityConfirmed = 双 null 判定;表单 quantityDraft 未确认行绝不
     * 预填 1(占位「待核对」),单位选择器默认「件」。
     */
    quantityText: string;
    quantityConfirmed: boolean;
    /** 「设为当前总数」面板展开态(常态折叠,先答案后操作) */
    quantityPanelOpen: boolean;
    /** 数量表单当前输入(""=未填,不携带;0 合法=确认目前没有) */
    quantityDraft: string;
    /** 数量表单单位选择器索引(UNIT_SET 序;缺省 0=「件」) */
    quantityUnitIndex: number;
    /** 数量保存执行中(与文本保存互斥复用 saving 门禁外的独立标记) */
    quantitySaving: boolean;
    /** 查看态「原备注」折叠区(Q0-CONTRACT §10.2 主规则:note 原样折叠,不与数量并排) */
    /** 单位选择器选项(UNIT_SET 冻结顺序 = 展示序,Q0-CONTRACT §2.2) */
    unitOptions: string[];
    noteFoldOpen: boolean;
  },
  {
    locationNodeDraft: { nodeId: string; path: string[] } | null;
    locationChoiceScope: number;
    locationLinkRetry: { nodeId: string; version: number; updateId: string } | null;
    openDetailPanel(panel: DetailPanel): void;
    onPanelClose(): void;
    onContinueReviewTap(): void;
    onOpenReminderTap(): void;
    onReminderDraftChange(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onReminderConfirmTap(): Promise<void>;
    onMediaEntryTap(): void;
    onMediaTabTap(e: WechatMiniprogram.CustomEvent): void;
    onPendingMediaTap(): void;
    onQuantityStep(e: WechatMiniprogram.CustomEvent): void;
    onQuantityUnitVerify(e: WechatMiniprogram.CustomEvent<{ value: string[] }>): void;
    onSaveLocationTap(): Promise<void>;
    original: { name: string; location: string; note: string };

    videoEntryHint: VideoPlaybackHint | null;
    videoEntryFocusConsumed: boolean;

    /**
     * 提醒字段与服务器对齐的基准日期(YYYY-MM-DD;""=确认无提醒):
     * 文本字段的三方合并基准是 original,提醒单独一份,口径相同——
     * refreshForConflict 之后 = 服务端最新值,用户显式选择前表单值与它不一致即待落库
     */
    remindOriginal: string;

    /**
     * 最近一次冲突刷新时提醒行是否不可得(拉取失败 / 在途家庭切换):
     * true = 该轮提醒没有与远端比较、基准也没对齐,用户待写的提醒选择仍在
     * 表单里等下次保存补写——提示文案须如实说「没存上」,不能说「已刷新」
     */
    remindRemoteUnknown: boolean;

    /** 刷新冲突时拿到的远端提醒行 kind(选「采用最新记录」后到期行展示用) */
    remoteRemindKind: RemindKind;

  /**
   * 上一次保存失败的更新(update_id + 内容):同样内容的重试复用同一个 update_id,
   * 服务端据此识别「自己刚写入但响应丢失」的重放,返回 replayed 而非误报版本冲突。
   * 内容一变(新的逻辑修改)即作废,下次保存生成新 update_id。
   */
  pendingRetry: {
    updateId: string;
    changes: { name?: string; location_text?: string; note?: string };
  } | null;
    /**
     * 数量保存失败的更新(issue #102 Q1):同数量同单位的重试复用同一 update_id,
     * 服务端据 last_update_id/指纹识别「自己刚写入但响应丢失」的重放;值一变即作废。
     */
    quantityRetry: { updateId: string; quantity: number; unit: string } | null;
    /**
     * 当前已确认数量基准(与 original 同族):null = 未确认(legacy 行);
     * 「设为当前总数」提交前与表单比对,相同即「内容没有变化」不空写。
     */
    quantityOriginal: { quantity: number | null; unit: string | null };
    onQuantityPanelToggle(): void;
    onQuantityInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onQuantityUnitChange(e: WechatMiniprogram.CustomEvent<{ value: number | string }>): void;
    onQuantitySaveTap(): Promise<void>;
    onNoteFoldToggle(): void;
    onNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onLocationInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onNoteInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    /** 展开 / 收起编辑表单(只读大卡为常态) */
    onEditToggle(): void;
    onUpdateLocationTap(): void;
    onFoundTap(): void;
    onQuoteToggle(): void;
    /* ---------------- 冲突面板(issue #6:同字段多设备双值对比 + 显式选边) ---------------- */
    onChooseLocal(e: WechatMiniprogram.BaseEvent): void;
    onChooseRemote(e: WechatMiniprogram.BaseEvent): void;
    applyConflictChoice(key: EditableField, choice: ConflictChoice): void;
    syncConflictFromInput(key: EditableField, value: string): void;
    dismissConflictsIfSettled(): void;
    hasRemindConflict(): boolean;
    setPendingRemind(date: string): void;
    pendingRemindWrite(): { action: "remindSet" | "remindClear"; dueDate: string } | null;
    refreshForConflict(): Promise<RefreshResult>;
    onSaveTap(): Promise<void>;
    /** 「⋯」次级菜单:开 / 关 / 三项动作 */
    onMoreTap(): void;
    onSheetClose(): void;
    onShareTap(): void;
    onTidyTap(): void;
    onDeleteTap(): void;
    confirmDelete(): Promise<void>;
    applySummary(s: ItemSummary): void;
    goBack(): void;
    /** 按 item_id 直接打开(get 单查;生成向导的 skipped 件跳转用) */
    loadById(id: string): Promise<void>;
    onMountTap(): Promise<void>;
    onMountSegmentInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    openLocationPicker(): void;
    doLinkToNode(nodeId: string, path?: string[]): Promise<boolean>;
    confirmMount(): Promise<void>;
    cancelMount(): void;
    /**
     * F4-B3:冲突未裁定时的「整理位置」写入门禁——冲突面板还在(仍有未选边
     * 字段,或选完还没保存/收敛)且表单位置仍不同于已确认基准(original):
     * 此时挂载会把 node 指向按未裁定文本解析的位置,服务端 location_text
     * 仍是对方值,位置事实分裂。返回 true = 禁止发起 ensurePath/linkItem。
     */
    mountBlockedByConflict(): boolean;
    /** 阻止弹层蒙层下的滚动穿透 */
    noop(): void;
    /* ---------------- 提醒(#36 三阶段) ---------------- */
    fetchReminderRow(): Promise<RemindRow | null | undefined>;
    /**
     * F4-B2/F4-B4:轮次未知(-1)时写前补拉一次提醒行,结果三分支:
     * - "unknown":拉取失败/在途切换/旧服务端仍不回轮次——失败关闭,调用方
     *   绝不退回旧协议无条件写(F4-B2);
     * - "known":远端确认无提醒(轮次 0,补录语义)或远端内容与用户已确认
     *   基准(remindOriginal 语义)一致——对齐轮次与基准后按轮次正常提交,
     *   表单里的用户候选原样保留;
     * - "diverged":远端已是与基准不同的内容且用户尚未知悉——不得直接写
     *   (F4-B4,CAS 只保证提交瞬间无新变化,不构成对他人已有修改的知情选择),
     *   调用方保留候选并进入既有冲突双值面板,显式选边后才能写。
     */
    reloadRemindGeneration(): Promise<"known" | "unknown" | "diverged">;
    refreshReminderRow(): Promise<void>;
    applyReminderRow(row: RemindRow | null): void;
    /** 保质期行「已处理」:确认后 remindComplete **/
    onExpireDoneTap(): Promise<void>;
    /**
     * 「到期时微信提醒我 ›」显式订阅入口(#36 真机手势规则):真实 tap 请求
     * 订阅授权;accept 且记录发起后写本地「已开启」标记并收起入口
     */
    onNotifyChipTap(): void;
    /** 打开订阅手势诊断页(#36 排查,仅 develop 显示) */
    onDiagEntryTap(): void;
    /** 编辑折叠「提醒」:picker mode=date 选日子 → remindSet 设提醒(无则补录,有则改期) */
    onRemindDateChange(e: WechatMiniprogram.CustomEvent<{ value: string }>): Promise<void>;
    /** 编辑折叠「提醒」:✕ 连日期一起清除(remindClear;不存在存日期但不提醒) */
    onRemindFieldClear(): Promise<void>;
    /* ---------------- 照片证据回放(#3 §6) ---------------- */
    fetchEvidenceRows(): Promise<PhotoEvidenceRow[] | undefined>;
    refreshEvidence(): Promise<void>;
    /** 折叠条点开 / 展开态点收起;换链失败(urlFail)时点按 = 重新拉取重试 */
    onEvidenceTap(): void;
    /** 「更早的照片 N 张」列表展开 / 收起 */
    onEvidenceOlderToggle(): void;
    /** 「📸 重拍更新 / 去补拍」:进拍照页开新一批(不带恢复参数) */
    onRetakeTap(): void;
    /* ---------------- 单件视频留证与回放 ---------------- */
    fetchVideoEvidenceRows(): Promise<VideoEvidenceRow[] | undefined>;
    refreshVideoEvidence(reopenPaused?: boolean): Promise<void>;
    refreshVideoPending(): void;
    onVideoToggle(): void;
    onVideoRetry(): void;
    onVideoMoreTap(): void;
    onVideoEvidenceSelect(e: WechatMiniprogram.CustomEvent<Record<string, unknown>>): void;
    onVideoHighlightTap(e: WechatMiniprogram.CustomEvent<Record<string, unknown>>): void;
    onVideoLoadedMetadata(): void;
    onVideoTimeUpdate(e: WechatMiniprogram.CustomEvent<{ currentTime: number; duration: number }>): void;
    onVideoPlaybackError(): void;
    scrollVideoCard(): void;
    seekVideoTo(seconds: number): void;
    openVideoPaused(selected?: VideoEvidenceView | null, highlightKey?: string): void;
    onAddVideoTap(): Promise<void>;
    onVideoRetakeTap(): Promise<void>;
    onVideoDeleteTap(): Promise<void>;
    onVideoPendingRetryTap(): Promise<void>;
    onVideoPendingDiscardTap(): Promise<void>;
    onVideoAiTap(): Promise<void>;
    onVideoAiCandidateToggle(e: WechatMiniprogram.CustomEvent<Record<string, unknown>>): void;
    onVideoAiCancel(): Promise<void>;
    onVideoAiSave(): Promise<void>;
  }
>({
  data: {
    detailPanel: "" as DetailPanel,
    mediaTab: "photo" as "photo" | "video",
    mediaScrollTarget: "",
    recordedName: "",
    recordedNote: "",
    recordedRemindAt: "",
    quantityShortText: "待核对",
    quantityIsZero: false,
    quantityUnitVerified: false,
    quantityUnitChanged: false,
    reminderDateDraft: "",
    reminderConfirming: false,
    reminderNeedsSave: false,
    locationPathDraft: [] as string[],
    locationCommitSaving: false,
    panelError: "",
    photoLookupFailed: false,
    itemId: "",
    name: "",
    locationText: "",
    recordedLocationText: "",
    artworkLight: itemArtwork(""),
    artworkDark: itemArtwork("", true),
    detailQuoteOpen: false,
    note: "",
    version: 0,
    updatedAtText: "",
    lastConfirmedText: "",
    spacePath: [],
    editPanelOpen: false,
    moreOpen: false,
    familyShared: false,
    saving: false,
    deleting: false,
    mounting: false,
    mountPanelOpen: false,
    mountSegments: [],
    mountNeedConfirm: false,
    mountOrderViolation: false,
    mountSaving: false,
    expire: null as {
      mainText: string;
      dueDate: string;
      kind: string;
      convertedNote?: string;
    } | null,
    remindAt: "",
    remindGeneration: -1,
    pickerStart: pickerStartYmd(),
    remindBusy: false,
    notifyAccepted: false,
    diagEntryVisible: false,
    wantsNotify: true,
    vagueQuote: "",
    conflicts: [] as ConflictEntry[],
    conflictPending: false,
    evidenceReady: false,
    evidenceNoPhoto: false,
    evidenceOpen: false,
    evidenceOlderOpen: false,
    evidence: null as EvidenceView | null,
    videoReady: false,
    videoOpen: false,
    videoEvidence: null as VideoEvidenceCollectionView | null,
    videoSelected: null as VideoEvidenceView | null,
    videoSelectedHighlightKey: "",
    videoFoldText: "",
    videoPlaybackNotice: "",
    videoPlaybackError: "",
    videoInitialTime: 0,
    videoSeekPending: false,
    videoCurrentMs: 0,
    videoActiveBox: null as VideoHighlightBoxView | null,
    videoLookupFailed: false,
    videoBusy: false,
    videoPending: null as PendingVideoUpload | null,
    videoPendingExpired: false,
    videoPendingText: "",
    videoAiBusy: false,
    videoAiProgress: "",
    videoAiCandidates: [] as VideoAiCandidateView[],
    videoAiError: "",
    videoAiNoHit: false,
    quantityText: "待核对",
    quantityConfirmed: false,
    quantityPanelOpen: false,
    quantityDraft: "",
    quantityUnitIndex: 0,
    quantitySaving: false,
    /** 单位选择器选项(UNIT_SET 冻结顺序 = 展示序,Q0-CONTRACT §2.2) */
    unitOptions: UNIT_SET as string[],
    noteFoldOpen: false,
  },

  /** 最近一次加载到的内容,用于判断是否有修改 */
  locationNodeDraft: null as { nodeId: string; path: string[] } | null,
  locationChoiceScope: captureScopeGeneration(),
  locationLinkRetry: null as { nodeId: string; version: number; updateId: string } | null,
  original: { name: "", location: "", note: "" },

  remindOriginal: "",

  remindRemoteUnknown: false,

  remoteRemindKind: "下次维护" as RemindKind,

  videoEntryHint: null as VideoPlaybackHint | null,
  videoEntryFocusConsumed: false,

  pendingRetry: null as {
    updateId: string;
    changes: { name?: string; location_text?: string; note?: string };
  } | null,

  quantityRetry: null as { updateId: string; quantity: number; unit: string } | null,

  quantityOriginal: { quantity: null, unit: null } as {
    quantity: number | null;
    unit: string | null;
  },

  onLoad(options) {
    // 搜索 badge 的定位 hint 只存在页面实例内存；真正 seek 前还要用
    // videoEvidenceGet 的新鲜行和当前 item/household 重新校验。
    this.videoEntryHint = parseVideoPlaybackHint(options);
    this.videoEntryFocusConsumed = false;
    // 空间路径来自进入时的容器层(首页地图 / 空间页点开的条目);
    // 搜索等入口没有路径就不显示,只用原话,不自造
    this.setData({
      spacePath: parseSpacePath(options.path),
      familyShared: isHouseholdScopeShared(),
    });
    // 诊断入口仅 develop 显示(预览/开发版);getAccountInfoSync 不在任何 tap
    // 手势链上(onLoad 时调用),不影响订阅手势纪律
    try {
      const acc = wx.getAccountInfoSync();
      this.setData({
        diagEntryVisible: !!acc.miniProgram && acc.miniProgram.envVersion === "develop",
      });
    } catch (e) {
      this.setData({ diagEntryVisible: false });
    }
    const rawItemId = options.item_id;
    if (rawItemId) {
      // 按 id 直接打开(生成向导的 skipped 件、结果页跳转):get 单查不受 list 分页影响
      this.setData({ itemId: safeDecode(rawItemId) });
      void this.loadById(safeDecode(rawItemId));
      return;
    }
    const raw = options.data;
    let summary: ItemSummary | null = null;
    if (raw) {
      try {
        const p = JSON.parse(safeDecode(raw)) as Partial<ItemSummary>;
        if (
          typeof p.item_id === "string" &&
          typeof p.name === "string" &&
          typeof p.location_text === "string" &&
          typeof p.note === "string" &&
          typeof p.version === "number" &&
          typeof p.updated_at === "string"
        ) {
          summary = {
            item_id: p.item_id,
            name: p.name,
            location_text: p.location_text,
            note: p.note,
            version: p.version,
            updated_at: p.updated_at,
            // 数量(issue #102 Q1):跳转摘要可能带也可能缺(旧入口/旧服务端),
            // 非法形态一律按未确认;详情页随后 get 会以权威投影刷新
            quantity: isValidExistingQuantity(p.quantity) ? (p.quantity as number) : null,
            unit: isUnit(p.unit) ? (p.unit as string) : null,
            quantity_confirmed_at:
              typeof p.quantity_confirmed_at === "string" ? p.quantity_confirmed_at : null,
          };
        }
      } catch (e) {
        console.error("[item] 详情参数解析失败", e);
      }
    }
    if (!summary) {
      wx.showModal({
        title: "无法打开",
        content: "记录参数缺失或已失效,请返回重试。",
        showCancel: false,
        success: () => {
          this.goBack();
        },
      });
      return;
    }
    this.applySummary(summary);
  },

  onShow() {
    applyPageAppearance(this);
    // 家庭上下文可能切换(创建/加入/退出):「分享给家人」只在共享家庭显示;
    // 订阅入口的本地「已开启」标记按家庭键隔离,回页时一并重读(作用域经
    // 服务端复核后 refreshReminderRow 末尾还会再读一次,双保险)
    this.setData({
      familyShared: isHouseholdScopeShared(),
      notifyAccepted: isNotifyAccepted(),
    });
    // 保质期行(#36):进页/回页时按服务端提醒刷新;加载失败静默不显示(增强露出)。
    // 提醒冲突待选时不刷:面板里「你的修改」是用户正要存的值,回页刷新会把它
    // 悄悄换回服务端值(文字字段没有 onShow 刷新,提醒同口径不搞特殊)。
    // 表单里还有待补写的提醒选择时(冲突刷新那轮提醒远端不可得,选择留在表单
    // 等保存补写)同样不刷:refreshReminderRow 会先清空 remindAt,选择会无痕蒸发
    if (!this.hasRemindConflict() && this.pendingRemindWrite() === null) {
      void this.refreshReminderRow();
    }
    // 照片证据回放卡(#3 §6):进页/回页拉取;applySummary/update 后不自动重拉
    //(onShow 再拉)。失败静默(增强露出,不影响详情主体)
    void this.refreshEvidence();
    // 视频证据:进入详情只拉取并默认折叠;用户点击后才播放(有视频才显示)
    void this.refreshVideoEvidence();
    this.refreshVideoPending();
  },

  onHide() {
    if (this.data.videoAiBusy || this.data.videoAiCandidates.length > 0) {
      void cancelActiveVideoAi(this.data.itemId);
      this.setData({
        videoAiBusy: false,
        videoAiProgress: "",
        videoAiCandidates: [],
        videoAiError: "",
        videoAiNoHit: false,
      });
    }
  },

  onUnload() {
    void cancelActiveVideoAi(this.data.itemId);
  },

  onNameInput(e) {
    const value = e.detail && e.detail.value ? e.detail.value : "";
    this.setData({ name: value });
    this.syncConflictFromInput("name", value);
  },

  onLocationInput(e) {
    const value = e.detail && e.detail.value ? e.detail.value : "";
    this.setData({ locationText: value });
    this.syncConflictFromInput("location", value);
  },

  onNoteInput(e) {
    const value = e.detail && e.detail.value ? e.detail.value : "";
    this.setData({ note: value });
    this.syncConflictFromInput("note", value);
  },

  /* ---------------- 冲突面板(issue #6,移植自 PR #12 并扩展提醒字段) ---------------- */

  /**
   * 冲突态下用户直接编辑了冲突字段:仅把面板上的「你的修改」同步为最新输入,
   * 不视为显式选择——门禁要求点选按钮,避免「不看面板、在输入框敲个空格再删掉」
   * 就绕过冲突确认直接覆盖(issue #6:必须知悉对方修改后明确选择)。
   * 输入会撤回该字段已做的选择(既有选择已不再反映输入框内容);
   * 程序 setData 不触发 input 事件,「采用最新记录」按钮写入的值不会被误判为输入。
   */
  syncConflictFromInput(key: EditableField, value: string): void {
    const idx = this.data.conflicts.findIndex((c) => c.key === key);
    if (idx < 0) {
      return;
    }
    const entry = this.data.conflicts[idx];
    const trimmed = value.trim();
    const patch: Record<string, unknown> = {};
    if (entry.localValue !== trimmed) {
      patch["conflicts[" + idx + "].localValue"] = trimmed;
      patch["conflicts[" + idx + "].localDisplay"] = conflictDisplayText(key, trimmed);
    }
    if (entry.choice !== null) {
      patch["conflicts[" + idx + "].choice"] = null;
      patch.conflictPending = true;
    }
    if (Object.keys(patch).length > 0) {
      this.setData(patch);
    }
  },

  /** 冲突面板:显式选择「保留我的修改」或「采用最新记录」 */
  applyConflictChoice(key: EditableField, choice: ConflictChoice): void {
    const idx = this.data.conflicts.findIndex((c) => c.key === key);
    if (idx < 0) {
      return;
    }
    const entry = this.data.conflicts[idx];
    // 选定值回填表单:文本字段选远端即与最新基准一致(保存时无变化、不自动再写),
    // 选本地则保留用户值,下次保存以最新 expected_version 提交该字段;
    // 提醒字段选远端同样回显即停,选本地的补写口径与 resolveRemindChoice 同源。
    const patch: Record<string, unknown> = {};
    if (key === "remind") {
      const resolution = resolveRemindChoice(entry, choice);
      patch.remindAt = resolution.displayDate;
      patch.expire = resolution.displayDate
        ? {
            mainText: expireMainText(resolution.displayDate),
            dueDate: resolution.displayDate,
            kind: choice === "remote" ? this.remoteRemindKind : "下次维护",
          }
        : null;
    } else {
      patch[key === "location" ? "locationText" : key] = chosenValue(entry, choice);
    }
    this.setData({
      ...patch,
      ["conflicts[" + idx + "].choice"]: choice,
      conflictPending: this.data.conflicts.some((c, i) => i !== idx && !c.choice),
    });
    this.dismissConflictsIfSettled();
  },

  /**
   * 冲突全部选完且表单已与最新基准完全一致(典型:全部采用最新记录且无其他改动)
   * 时收起面板。此时没有任何待提交内容,保留面板只会引导一次
   * 注定「内容没有变化」的保存,让用户找不到出口。
   */
  dismissConflictsIfSettled(): void {
    if (this.data.conflicts.length === 0) {
      return;
    }
    if (conflictUnresolved(this.data.conflicts)) {
      return;
    }
    const changes = buildUpdateChanges(this.original, {
      name: this.data.name.trim(),
      location: this.data.locationText.trim(),
      note: this.data.note.trim(),
    });
    if (Object.keys(changes).length === 0 && this.pendingRemindWrite() === null) {
      this.setData({ conflicts: [], conflictPending: false });
      wx.showToast({ title: "已与最新记录一致", icon: "none" });
    }
  },

  onChooseLocal(e) {
    this.applyConflictChoice(e.currentTarget.dataset.key as EditableField, "local");
  },

  onChooseRemote(e) {
    this.applyConflictChoice(e.currentTarget.dataset.key as EditableField, "remote");
  },

  /** 「提醒」是否正处于冲突待选:在冲突面板里时,改日期/清除只更新「你的修改」,不直接落库 */
  hasRemindConflict(): boolean {
    return this.data.conflicts.some((c) => c.key === "remind");
  },

  /** 冲突流程中把「你正要存的提醒值」留在表单(到期行同步,便于对照两版) */
  setPendingRemind(date: string): void {
    this.setData({
      remindAt: date,
      expire: date
        ? { mainText: expireMainText(date), dueDate: date, kind: "下次维护" }
        : null,
    });
  },

  /**
   * 待补的提醒写操作:表单提醒日期与最新基准不一致即需要落库——
   * 冲突面板选「保留我的修改」(选中值 ≠ 最新记录),或面板被整理位置等
   * 路径重新对齐后遗留的未落库选择。写法复用既有提醒路径:
   * 有日期 remindSet、清空 remindClear,轮次号用刷新后的最新所见轮次。
   */
  pendingRemindWrite(): { action: "remindSet" | "remindClear"; dueDate: string } | null {
    if (this.data.remindAt === this.remindOriginal) {
      return null; // 表单与最新基准一致(选了远端或本无差异):不写
    }
    const entry = this.data.conflicts.find((c) => c.key === "remind");
    if (entry && entry.choice !== null) {
      const resolution = resolveRemindChoice(entry, entry.choice);
      if (resolution.writeAction === null) {
        return null;
      }
      return {
        action: resolution.writeAction === "set" ? "remindSet" : "remindClear",
        dueDate: resolution.writeDate,
      };
    }
    return this.data.remindAt === ""
      ? { action: "remindClear", dueDate: "" }
      : { action: "remindSet", dueDate: this.data.remindAt };
  },

  openDetailPanel(panel: DetailPanel) {
    if (this.data.saving || this.data.quantitySaving || this.data.remindBusy || this.data.reminderConfirming || this.data.deleting || this.data.mountSaving || this.data.locationCommitSaving) return;
    const patch: Record<string, unknown> = { detailPanel: panel, moreOpen: false, panelError: "" };
    if (panel === "location") {
      if (this.data.conflicts.length === 0) this.setData({ locationText: this.original.location });
      this.locationChoiceScope = captureScopeGeneration();
      this.locationNodeDraft = null;
      patch.locationPathDraft = this.data.spacePath.slice();
      patch.editPanelOpen = true;
    } else if (panel === "info") {
      patch.editPanelOpen = true;
    } else if (panel === "quantity") {
      patch.quantityPanelOpen = true;
      patch.quantityUnitVerified = false;
      patch.quantityUnitChanged = this.quantityRetry !== null && this.quantityOriginal.unit !== null && UNIT_SET[this.data.quantityUnitIndex] !== this.quantityOriginal.unit;
      if (!this.quantityRetry) {
        patch.quantityDraft = this.quantityOriginal.quantity === null ? "" : String(this.quantityOriginal.quantity);
        patch.quantityUnitIndex = this.quantityOriginal.unit === null ? 0 : Math.max(0, UNIT_SET.indexOf(this.quantityOriginal.unit));
      }
    } else if (panel === "reminder") {
      patch.reminderDateDraft = this.data.remindAt || this.data.pickerStart;
    } else if (panel === "media") {
      patch.mediaTab = this.data.evidenceReady || !this.data.videoReady ? "photo" : "video";
      patch.evidenceOpen = true;
    }
    this.setData(patch);
  },

  onPanelClose() {
    if (this.data.saving || this.data.quantitySaving || this.data.remindBusy || this.data.reminderConfirming || this.data.deleting || this.data.mountSaving || this.data.locationCommitSaving) return;
    const panel = this.data.detailPanel;
    const patch: Record<string, unknown> = { detailPanel: "", editPanelOpen: false, quantityPanelOpen: false, mountPanelOpen: false, panelError: "" };
    if (this.data.conflicts.length === 0 && (panel === "location" || panel === "info")) {
      patch.name = this.original.name; patch.locationText = this.original.location; patch.note = this.original.note;
    }
    if (panel === "location") { this.locationNodeDraft = null; this.locationLinkRetry = null; }
    if (panel === "media") {
      void cancelActiveVideoAi(this.data.itemId);
      patch.videoOpen = false; patch.videoAiBusy = false; patch.videoAiCandidates = []; patch.evidenceOpen = false;
    }
    patch.reminderNeedsSave = this.pendingRemindWrite() !== null;
    this.setData(patch);
  },

  onEditToggle() { this.openDetailPanel("info"); },
  onUpdateLocationTap() { this.openDetailPanel("location"); },
  onContinueReviewTap() {
    this.openDetailPanel(this.data.reminderNeedsSave && this.data.conflicts.length === 0 ? "reminder" : "info");
  },
  onOpenReminderTap() { this.openDetailPanel("reminder"); },
  onReminderDraftChange(e) { this.setData({ reminderDateDraft: e.detail.value }); },
  async onReminderConfirmTap() {
    const date = this.data.reminderDateDraft;
    if (pickerDateProblem(date) !== "") { wx.showToast({ title: pickerDateProblem(date), icon: "none" }); return; }
    if (this.data.remindBusy || this.data.saving || this.data.quantitySaving || this.data.reminderConfirming) return;
    this.setData({ reminderConfirming: true });
    try {
      if (this.pendingRemindWrite() !== null || this.hasRemindConflict()) {
        this.setPendingRemind(date);
        this.syncConflictFromInput("remind", date);
        await this.onSaveTap();
      } else await this.onRemindDateChange({ detail: { value: date } } as WechatMiniprogram.CustomEvent<{ value: string }>);
      const pending = this.pendingRemindWrite() !== null;
      this.setData({ reminderNeedsSave: pending });
      if (!pending && !this.data.conflictPending && this.remindOriginal === date) this.setData({ detailPanel: "" });
    } finally { this.setData({ reminderConfirming: false }); }
  },
  onMediaEntryTap() { this.openDetailPanel("media"); },
  onPendingMediaTap() { this.openDetailPanel("media"); this.setData({ mediaTab: "video" }); },
  onMediaTabTap(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab !== "photo" && tab !== "video") return;
    if (tab === "photo") { void cancelActiveVideoAi(this.data.itemId); this.setData({ videoOpen: false, videoAiBusy: false, videoAiCandidates: [] }); }
    this.setData({ mediaTab: tab, evidenceOpen: true });
  },
  onQuantityStep(e) {
    if (this.data.quantitySaving) return;
    const value = Number(this.data.quantityDraft || 0) + Number(e.currentTarget.dataset.delta);
    if (Number.isInteger(value)) this.setData({ quantityDraft: String(Math.max(0, Math.min(9999, value))) });
  },
  onQuantityUnitVerify(e) { this.setData({ quantityUnitVerified: e.detail.value.includes("verified") }); },

  async onSaveLocationTap() {
    if (this.data.locationCommitSaving || this.data.saving || this.data.quantitySaving || this.data.remindBusy || this.data.deleting || this.data.mountSaving) return;
    if (!isScopeGenerationCurrent(this.locationChoiceScope)) { this.setData({ panelError: "家庭已切换，请重新打开这件物品后再修改。" }); return; }
    const description = this.data.locationText.trim();
    if (!description) { wx.showToast({ title: "请填写具体放在哪里", icon: "none" }); return; }
    this.setData({ locationCommitSaving: true, panelError: "" });
    try {
      await this.onSaveTap();
      if (!isScopeGenerationCurrent(this.locationChoiceScope)) { this.setData({ panelError: "家庭已切换，请重新打开这件物品后再修改。" }); return; }
      if (this.original.location !== description || this.data.conflictPending || this.data.conflicts.length > 0) return;
      if (this.locationNodeDraft) {
        const choice = this.locationNodeDraft;
        const linked = await this.doLinkToNode(choice.nodeId, choice.path);
        if (!linked) {
          this.setData({ detailPanel: "location", editPanelOpen: true, panelError: "位置描述已保存，归类尚未更新。请核对后重试。" });
          return;
        }
      }
      this.locationNodeDraft = null;
      this.setData({ detailPanel: "", editPanelOpen: false });
    } finally { this.setData({ locationCommitSaving: false }); }
  },

  onFoundTap() {
    // Finding an item is feedback, not a new location fact or reminder completion.
    if (this.data.saving || this.data.deleting || this.data.mountSaving) return;
    this.goBack();
  },

  onQuoteToggle() { this.setData({ detailQuoteOpen: !this.data.detailQuoteOpen }); },

  applySummary(s: ItemSummary) {
    this.original = {
      name: s.name,
      location: s.location_text,
      note: s.note,
    };
    // PR #48 复审 B2:updated_at 在名称/备注/位置任意修改时都会刷新,不能冒充
    // 「位置确认时间」——文案只如实说明记录更新时间
    const short = shortDate(s.updated_at);
    // vagueQuote(Fix 4)只在 get(详情)响应携带;update 等其余投影不带时
    // 保留现值——编辑内容不会动掉「当时提到时间」的留痕
    const vague = typeof (s as { remind_vague_quote?: unknown }).remind_vague_quote === "string"
      ? (s as { remind_vague_quote?: string }).remind_vague_quote || ""
      : this.data.vagueQuote;
    // 数量(issue #102 Q1):投影字段是唯一来源;缺键/异常归一为未确认(双 null),
    // 绝不从 note 的 ×N/500ml 推断;表单不预填(未确认行占位「待核对」,§10.3)
    const q = normalizeQuantityFields(s as unknown as Record<string, unknown>);
    this.quantityOriginal = { quantity: q.quantity, unit: q.unit };
    const unitIndex = q.unit === null ? 0 : Math.max(0, UNIT_SET.indexOf(q.unit));
    this.setData({
      itemId: s.item_id,
      name: s.name,
      recordedName: s.name,
      recordedNote: s.note,
      locationText: s.location_text,
      recordedLocationText: s.location_text,
      artworkLight: itemArtwork(s.name),
      artworkDark: itemArtwork(s.name, true),
      note: s.note,
      version: s.version,
      updatedAtText: formatDateTime(s.updated_at),
      lastConfirmedText: short
        ? "记录更新于 " + short
        : s.updated_at
          ? "记录更新于 " + formatDateTime(s.updated_at)
          : "",
      vagueQuote: vague,
      quantityText: quantityConfirmedText(q.quantity, q.unit, q.quantity_confirmed_at),
      quantityConfirmed: q.quantity !== null,
        quantityShortText: q.quantity === null ? "待核对" : `${q.quantity} ${q.unit}`,
        quantityIsZero: q.quantity === 0,
      quantityPanelOpen: false,
      quantityDraft: "",
      quantityUnitIndex: unitIndex,
      noteFoldOpen: false,
      // 新基准落地:冲突面板随之作废(保存成功/重新进页都会走到这里)
      conflicts: [],
      conflictPending: false,
    });
  },

  /* ---------------- 数量:「设为当前总数」(issue #102 Q1,Q0-CONTRACT §4.2/§10.3) ---------------- */

  onQuantityPanelToggle() {
    if (this.data.detailPanel === "quantity") this.onPanelClose();
    else this.openDetailPanel("quantity");
  },

  onQuantityInput(e) {
    this.setData({
      quantityDraft: e.detail && e.detail.value ? e.detail.value : "",
    });
  },

  onQuantityUnitChange(e) {
    const idx = Number(e && e.detail ? e.detail.value : 0);
    this.setData({ quantityUnitIndex: Number.isInteger(idx) && idx >= 0 && idx < UNIT_SET.length ? idx : 0, quantityUnitVerified: false, quantityUnitChanged: this.quantityOriginal.unit !== null && UNIT_SET[idx] !== this.quantityOriginal.unit });
  },

  onNoteFoldToggle() {
    this.setData({ noteFoldOpen: !this.data.noteFoldOpen });
  },

  /**
   * 「设为当前总数」保存:走 itemsApi.update 携 {quantity, unit}(成组,§4.2)。
   * - 0 合法(= 确认目前没有,保留物品/位置/提醒/证据,L2);0..9999 整数;
   * - 未填不提交(未确认行绝不预填 1——「待核对」就是答案,先核对实物);
   * - 数量与已确认基准相同且单位相同 → 内容没有变化,不空写;
   * - VERSION_CONFLICT:优先用响应 current 直接展示家人已更新的最新值并引导
   *   核对实物总数后再确认(§14.1-4/5),绝不自动重放;旧服务端无 current 时
   *   走既有 get 刷新路径;
   * - 与文本表单独立提交,成功后只对齐版本与数量字段,不清用户未保存的文本草稿。
   */
  async onQuantitySaveTap() {
    if (this.data.quantitySaving || this.data.saving || this.data.deleting || this.data.mountSaving) {
      return;
    }
    const parsed = parseQuantityText(this.data.quantityDraft, 0);
    if (parsed === null) {
      wx.showToast({ title: "请先核对实物数量再填写", icon: "none" });
      return;
    }
    if (parsed === "INVALID") {
      wx.showToast({ title: "数量需为 0-9999 的整数", icon: "none" });
      return;
    }
    const unit = UNIT_SET[this.data.quantityUnitIndex] || "件";
    if (this.data.detailPanel === "quantity" && this.quantityOriginal.unit !== null && unit !== this.quantityOriginal.unit && !this.data.quantityUnitVerified) {
      wx.showToast({ title: "请按新单位重新核对总数并勾选确认", icon: "none" }); return;
    }
    if (
      this.quantityOriginal.quantity === parsed &&
      this.quantityOriginal.unit === unit
    ) {
      wx.showToast({ title: "内容没有变化", icon: "none" });
      return;
    }
    const retry = this.quantityRetry;
    const samePayload = retry !== null && retry.quantity === parsed && retry.unit === unit;
    const updateId = samePayload ? retry.updateId : uuid();
    this.setData({ quantitySaving: true });
    try {
      const res = await callItemsApi({
        action: "update",
        item_id: this.data.itemId,
        expected_version: this.data.version,
        update_id: updateId,
        quantity: parsed,
        unit,
      });
      this.quantityRetry = null;
      // 数量保存不动名称/位置/备注:只对齐版本与数量字段,保留用户未保存的文本草稿
      const q = normalizeQuantityFields(res.item as unknown as Record<string, unknown>);
      this.quantityOriginal = { quantity: q.quantity, unit: q.unit };
      this.setData({
        version: res.item.version,
        updatedAtText: formatDateTime(res.item.updated_at),
        quantityText: quantityConfirmedText(q.quantity, q.unit, q.quantity_confirmed_at),
        quantityConfirmed: q.quantity !== null,
        quantityShortText: q.quantity === null ? "待核对" : `${q.quantity} ${q.unit}`,
        quantityIsZero: q.quantity === 0,
        quantityPanelOpen: false,
        detailPanel: this.data.detailPanel === "quantity" ? "" : this.data.detailPanel,
        quantityDraft: "",
      });
      wx.showToast({ title: "已记为当前总数", icon: "success" });
    } catch (e) {
      this.quantityRetry = { updateId, quantity: parsed, unit };
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        const cur = e.current;
        if (cur && cur.item_id) {
          // 冲突响应带最新投影:一次往返展示「家人已更新为 X」,引导核对实物,
          // 用户显式重核对后再提交(绝不自动套用旧输入)
          const q = normalizeQuantityFields(cur as unknown as Record<string, unknown>);
          this.quantityOriginal = { quantity: q.quantity, unit: q.unit };
          this.setData({
            version: cur.version,
            quantityText: quantityConfirmedText(q.quantity, q.unit, q.quantity_confirmed_at),
            quantityConfirmed: q.quantity !== null,
        quantityShortText: q.quantity === null ? "待核对" : `${q.quantity} ${q.unit}`,
        quantityIsZero: q.quantity === 0,
            quantityDraft: "",
            quantityUnitIndex: q.unit === null ? 0 : Math.max(0, UNIT_SET.indexOf(q.unit)),
          });
          wx.showToast({
            title: "家人刚更新过数量,请核对实物总数后再确认",
            icon: "none",
            duration: 2500,
          });
        } else {
          // 旧服务端无 current:走既有冲突刷新(get + 三方合并,含数量对齐),
          // 再引导核对;草稿与 current 分支同款清空(基准已变,须按最新值重新核对)
          const result = await this.refreshForConflict();
          if (result === "notfound") {
            wx.showModal({
              title: "记录不存在",
              content: "没有找到这条记录,可能已被删除。",
              showCancel: false,
              success: () => {
                this.goBack();
              },
            });
          } else {
            this.setData({ quantityDraft: "" });
            wx.showToast({ title: "内容已被修改,已刷新,请核对后再确认", icon: "none", duration: 2500 });
          }
        }
      } else if (e instanceof ApiError && e.detail && typeof e.detail.reason === "string") {
        // 数量校验失败(detail.reason 冻结枚举):按原因给可操作文案
        const reasonMap: Record<string, string> = {
          QUANTITY_NOT_INTEGER: "数量需为 0-9999 的整数",
          QUANTITY_OUT_OF_RANGE: "数量需为 0-9999 的整数",
          UNIT_UNSUPPORTED: "请从单位列表里选择单位",
          QUANTITY_UNIT_PAIR: "数量与单位需一起提交,请重试",
        };
        wx.showToast({ title: reasonMap[e.detail.reason] || errorMessage(e), icon: "none" });
      } else {
        wx.showModal({
          title: "数量没存上",
          content: errorMessage(e),
          showCancel: false,
        });
      }
    } finally {
      this.setData({ quantitySaving: false });
    }
  },

  /**
   * 保存修改:文本字段走 itemsApi update(expected_version 条件更新);
   * 冲突选「保留我的修改」的提醒(或遗留的未落库提醒)按既有 remindSet /
   * remindClear 路径补写(expected_generation 用刷新后的最新所见轮次)。
   * 冲突字段未全部显式选择前,按钮禁用 + 此处再设一道门禁(双保险)。
   */
  async onSaveTap() {
    if (this.data.saving || this.data.deleting) {
      return;
    }
    if (this.data.conflictPending || conflictUnresolved(this.data.conflicts)) {
      // 冲突字段必须显式选择保留哪一版后才能再次提交(issue #6)
      wx.showToast({ title: "请先为冲突字段选择保留哪一版", icon: "none" });
      return;
    }
    const name = this.data.name.trim();
    const locationText = this.data.locationText.trim();
    const note = this.data.note.trim();
    if (!name) {
      wx.showToast({ title: "请填写物品名称", icon: "none" });
      return;
    }
    if (!locationText) {
      wx.showToast({ title: "位置为必填项,请填写位置", icon: "none" });
      return;
    }
    const changes = buildUpdateChanges(this.original, {
      name,
      location: locationText,
      note,
    });
    let remindWrite = this.pendingRemindWrite();
    if (Object.keys(changes).length === 0 && remindWrite === null) {
      // 冲突态下走到这里 = 冲突字段全部选了「采用最新记录」且无其他改动:
      // 表单已与最新基准一致,收起面板,不给用户留一个只会空跑的面板。
      if (this.data.conflicts.length > 0) {
        this.setData({ conflicts: [], conflictPending: false });
      }
      wx.showToast({ title: "内容没有变化", icon: "none" });
      return;
    }
    // 同样内容的重试复用同一 update_id:服务端据此把「自己刚写入但响应丢失」的重放
    // 识别为 replayed 成功,而不是误报 VERSION_CONFLICT;内容一变即生成新 update_id。
    const hasTextChanges = Object.keys(changes).length > 0;
    const retry = this.pendingRetry;
    const samePayload =
      retry !== null &&
      retry.changes.name === changes.name &&
      retry.changes.location_text === changes.location_text &&
      retry.changes.note === changes.note;
    const updateId = samePayload ? retry.updateId : uuid();
    // V1.5(#36 到期微信提醒):本次保存会写入到期提醒(remindSet,含冲突选边
    // 「保留我的修改」与遗留待补写)时,在 tap 手势链内同步请求订阅授权
    //(必须先于下方任何 await;清除提醒不请求;拒绝/失败静默降级应用内提醒)
    if (remindWrite !== null && remindWrite.action === "remindSet" && this.data.wantsNotify !== false) {
      // 回执日期=本次写入的到期日(remindSet 的 dueDate);wantsNotify=false
      // =用户在选日期时明确答过「不用了」,本次保存跳过订阅询问
      requestExpirySubscribe(undefined, remindWrite.dueDate);
    }
    this.setData({ saving: true });
    try {
      if (hasTextChanges) {
        const res = await callItemsApi({
          action: "update",
          item_id: this.data.itemId,
          expected_version: this.data.version,
          update_id: updateId,
          ...changes,
        });
        this.pendingRetry = null;
        const it = res.item;
        this.applySummary({
          item_id: it.item_id,
          name: it.name,
          location_text: it.location_text,
          note: it.note,
          version: it.version,
          updated_at: it.updated_at,
          quantity: isValidExistingQuantity(it.quantity) ? it.quantity : null,
          unit: isUnit(it.unit) ? it.unit : null,
          quantity_confirmed_at:
            typeof it.quantity_confirmed_at === "string" ? it.quantity_confirmed_at : null,
        });
      }
      if (remindWrite !== null && this.data.remindGeneration < 0) {
        // F4-B2:轮次未知(未加载/加载失败/冲突刷新远端不可得)绝不退回旧协议
        // 无条件写——先补拉一次(候选保留);补拉后与最新一致则无需再写,
        // 仍读不到轮次则如实说没存上,文本部分已存好,提醒候选留在表单等重试
        const outcome = await this.reloadRemindGeneration();
        if (outcome === "diverged") {
          // F4-B4:补拉撞见远端已是不同内容且用户从未看过:不得直接写——
          // 保留候选,进入既有冲突双值面板(远端值 vs 本地候选),显式选边
          // 保存时以刷新后的最新轮次提交
          const result = await this.refreshForConflict();
          if (result === "notfound") {
            wx.showModal({
              title: "记录不存在",
              content: "没有找到这条记录,可能已被删除。",
              showCancel: false,
              success: () => {
                this.goBack();
              },
            });
          } else if (result === "refreshed") {
            wx.showToast({
              title: this.data.conflictPending
                ? "提醒与最新记录冲突,请选择保留哪一版"
                : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                  ? "提醒没存上,你的选择已保留,点保存修改再试"
                  : "这条提醒刚被家人改过,已刷新",
              icon: "none",
              duration: 2500,
            });
          }
          return;
        }
        remindWrite = outcome === "known" ? this.pendingRemindWrite() : remindWrite;
        if (outcome === "unknown") {
          wx.showToast({
            title: "提醒没存上,提醒还没加载好,你的选择已保留,稍后再试",
            icon: "none",
            duration: 2500,
          });
          return;
        }
      }
      if (remindWrite !== null) {
        try {
          if (remindWrite.action === "remindSet") {
            // 选「保留我的修改」的提醒以刷新后的最新轮次号重发(既有 remindSet 路径):
            // 提交瞬间他处又改 → 服务端轮次门禁再次拒绝,重新进入双值对比。
            // 轮次未知已被上方 F4-B2 门禁拦下,这里必带轮次,绝不省略
            const r = await callItemsApi({
              action: "remindSet",
              item_id: this.data.itemId,
              due_date: remindWrite.dueDate,
              expected_generation: this.data.remindGeneration,
            });
            this.applyReminderRow(r.reminder);
          } else {
            await callItemsApi({
              action: "remindClear",
              item_id: this.data.itemId,
              expected_generation: this.data.remindGeneration,
            });
            this.applyReminderRow(null);
          }
        } catch (e2) {
          if (e2 instanceof ApiError && e2.code === "VERSION_CONFLICT") {
            // 提交瞬间提醒又被他处改过:文本部分已存好,提醒重新比较、再次显式选择;
            // 提醒行拉取失败时远端不可得:选择留在表单等下次保存补写,如实说没存上
            const result = await this.refreshForConflict();
            if (result === "refreshed") {
              wx.showToast({
                title: this.data.conflictPending
                  ? "提醒与最新记录冲突,请选择保留哪一版"
                  : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                    ? "提醒没存上,你的选择已保留,点保存修改再试"
                    : "这条提醒刚被家人改过,已刷新",
                icon: "none",
                duration: 2500,
              });
            }
            return;
          }
          // 提醒没存上但文本已保存:如实分开告知,不合并成一句「保存失败」
          wx.showModal({
            title: "提醒没存上",
            content: errorMessage(e2),
            showCancel: false,
          });
          this.setData({ conflicts: [], conflictPending: false });
          return;
        }
      }
      // 全部落库:收回冲突面板与编辑折叠,回到只读答案
      this.setData({ conflicts: [], conflictPending: false, editPanelOpen: false, detailPanel: this.data.locationCommitSaving ? "location" : "", reminderNeedsSave: false });
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (e) {
      // 记录失败的更新供重试复用 update id(仅同样内容且有文本变更的重试)
      if (hasTextChanges) {
        this.pendingRetry = { updateId, changes };
      }
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        // 刷新后:无冲突字段则维持原提示(静默三方合并);有冲突字段则进入冲突态,
        // 编辑折叠内逐字段并排「你的修改 / 最新记录」,选择后才允许再次提交。
        const result = await this.refreshForConflict();
        if (result === "notfound") {
          wx.showModal({
            title: "记录不存在",
            content: "没有找到这条记录,可能已被删除。",
            showCancel: false,
            success: () => {
              this.goBack();
            },
          });
        } else if (result === "refreshed") {
          wx.showToast({
            title: this.data.conflictPending
              ? "部分字段与最新记录冲突,请逐项选择保留哪一版"
              : "内容已被修改,已更新版本号,请检查后重试",
            icon: "none",
            duration: 2500,
          });
        }
      } else {
        wx.showModal({
          title: "保存失败",
          content: errorMessage(e),
          showCancel: false,
        });
      }
    } finally {
      this.setData({ saving: false });
    }
  },

  /**
   * 冲突态入口(issue #6,四字段版):保存(update)、改提醒(remindSet/remindClear)
   * 或整理位置(linkItem)命中 VERSION_CONFLICT 后,拉服务端最新物品 + 最新提醒,
   * 对名称/位置/备注/提醒逐字段三方比较——
   * - 非冲突字段:静默三方合并(用户改过保留用户值,否则采纳服务端值),既有语义;
   * - 冲突字段(双方都改且互不相同):进入冲突态,编辑折叠内并排两版值,
   *   逐项显式选择后才能再次保存,绝不静默覆盖;
   * - 上一轮未选边的冲突字段跨刷新保留(carryUnresolved):基准对齐远端后,
   *   它们会退化成「仅本机修改」被静默合并,面板与门禁不能就此消失。
   * 提醒行拉取失败或家庭在途切换时不猜远端:该字段本轮不参与比较、基准维持
   * 原值,用户待写的提醒选择留在表单等下次保存补写(见函数内注释)。
   * 数量(issue #102 Q1,Q0-CONTRACT §10.1/§14.1-4)不进三方合并:详情头
   * 「上次确认 ×N单位」以服务端投影为唯一来源,家人并发改数量后刷新必须
   * 对齐最新投影,不能停留陈旧值(J5 冲突展示最新值);数量基准
   * quantityOriginal 同步对齐,否则后续「内容没有变化」比对会用旧基准误拦。
   */
  async refreshForConflict(): Promise<RefreshResult> {
    let item;
    try {
      const res = await callItemsApi({ action: "get", item_id: this.data.itemId });
      item = res.item;
    } catch (e) {
      if (e instanceof ApiError && e.code === "NOT_FOUND") {
        // 冲突期间记录已被删除:不弹「刷新失败」,交由调用方提示「记录不存在」并返回
        return "notfound";
      }
      wx.showModal({
        title: "刷新失败",
        content: errorMessage(e),
        showCancel: false,
      });
      return "error";
    }
    // 数量对齐(§10.1 唯一来源):展示文案/确认态/单位选择器与 quantityOriginal
    // 基准一律取最新投影;用户未保存的数量草稿不因他处冲突被清(数量保存自身的
    // 冲突路径在 onQuantitySaveTap 内清草稿,与 current 分支同款)
    const q = normalizeQuantityFields(item as unknown as Record<string, unknown>);
    this.quantityOriginal = { quantity: q.quantity, unit: q.unit };
    const row = await this.fetchReminderRow();
    // 提醒远端不可得(undefined,拉取失败/在途家庭切换)时不猜远端:本轮按「未变」
    // 参与比较(不判冲突、不改表单),但基准绝不向表单现值对齐——对齐会让用户
    // 待写的提醒选择蒸发(表单与基准一致后,既不随保存补写、也进不了冲突面板)。
    // 基准维持原值,选择留在表单,下次保存按原所见轮次号补写;届时他处若又改过,
    // 服务端轮次门禁会再次拦下、重新进流程
    this.remindRemoteUnknown = row === undefined;
    const remoteRemind = row === undefined ? this.remindOriginal : row ? row.due_date : "";
    const localValues = {
      name: this.data.name.trim(),
      location: this.data.locationText.trim(),
      note: this.data.note.trim(),
      remind: this.data.remindAt,
    };
    const remoteValues = {
      // note 兜底为空串:早期写入的旧文档可能缺该字段,原样透传 undefined
      // 会让冲突比较与表单 .trim() 拿到非字符串(服务端投影已兜底,这里双保险)
      name: item.name,
      location: item.location_text,
      note: item.note || "",
      remind: remoteRemind,
    };
    const outcome = mergeLatest(
      { ...this.original, remind: this.remindOriginal },
      localValues,
      remoteValues,
    );
    // 上一轮未选边的冲突字段跨刷新保留:基准已对齐远端,这些字段本轮会退化成
    // 「仅本机修改」被静默合并——面板一收、门禁即失守,对方的修改就被无声覆盖
    const carried = carryUnresolved(
      this.data.conflicts,
      outcome.conflicts,
      localValues,
      remoteValues,
    );
    if (row === undefined) {
      // 提醒远端不可得时无从重判:上一轮未选边的提醒条目原样保留
      // (仅把「你的修改」同步为表单现值),门禁不撤
      const prevRemind = this.data.conflicts.find(
        (c) => c.key === "remind" && c.choice === null
      );
      if (
        prevRemind &&
        !outcome.conflicts.some((c) => c.key === "remind") &&
        !carried.some((c) => c.key === "remind")
      ) {
        carried.push({
          key: "remind",
          label: prevRemind.label,
          localValue: localValues.remind,
          remoteValue: prevRemind.remoteValue,
        });
      }
    }
    const entries = outcome.conflicts.concat(carried);
    this.original = {
      name: item.name,
      location: item.location_text,
      note: item.note || "",
    };
    if (row !== undefined) {
      // 只有远端提醒真拿到了才对齐基准;不可得时维持原基准(见上方注释)
      this.remindOriginal = remoteRemind;
    }
    this.remoteRemindKind = row ? row.kind : "下次维护";
    const hasConflicts = entries.length > 0;
    const shown = outcome.merged.remind;
    const remindPatch: Record<string, unknown> =
      row === undefined
        ? {}
        : {
            remindAt: shown,
            expire: shown
              ? {
                  mainText: expireMainText(shown),
                  dueDate: shown,
                  kind: row && shown === row.due_date ? row.kind : "下次维护",
                }
              : null,
            remindGeneration: row
              ? typeof row.generation === "number"
                ? row.generation
                : -1
              : 0,
          };
    this.setData({
      name: outcome.merged.name,
      locationText: outcome.merged.location,
      recordedLocationText: item.location_text,
      recordedName: item.name,
      recordedNote: item.note || "",
      note: outcome.merged.note,
      version: item.version,
      updatedAtText: formatDateTime(item.updated_at),
      quantityText: quantityConfirmedText(q.quantity, q.unit, q.quantity_confirmed_at),
      quantityConfirmed: q.quantity !== null,
        quantityShortText: q.quantity === null ? "待核对" : `${q.quantity} ${q.unit}`,
        quantityIsZero: q.quantity === 0,
      quantityUnitIndex: q.unit === null ? 0 : Math.max(0, UNIT_SET.indexOf(q.unit)),
      conflicts: entries.map((c) => ({
        ...c,
        choice: null,
        localDisplay: conflictDisplayText(c.key, c.localValue),
        remoteDisplay: conflictDisplayText(c.key, c.remoteValue),
      })),
      conflictPending: hasConflicts,
      // 冲突面板在编辑折叠内:强制展开,保证用户看得见两版值再选
      editPanelOpen: hasConflicts ? true : this.data.editPanelOpen,
      detailPanel: hasConflicts ? (this.data.detailPanel === "location" ? "location" : "info") : this.data.detailPanel,
      recordedRemindAt: row === undefined ? this.data.recordedRemindAt : remoteRemind,
      ...remindPatch,
    });
    return "refreshed";
  },

  /* ---------------- 「⋯」次级菜单(编辑/整理/删除都收进这里) ---------------- */

  onMoreTap() {
    this.setData({ moreOpen: true });
  },

  onSheetClose() {
    this.setData({ moreOpen: false });
  },

  /**
   * 分享给家人(仅共享家庭显示):这里如实说明语义——共享家庭里这条记录
   * 本来就人人可见,没有单独分享这个动作,也不假装写入。
   */
  onShareTap() {
    this.setData({ moreOpen: false });
    wx.showModal({
      title: "分享给家人",
      content:
        "这条记录已经在「我们家」的共享记录里,家里每个人打开就能看到,不用再单独分享。",
      confirmText: "知道了",
      showCancel: false,
    });
  },

  /** 整理位置:收起菜单后走既有 parseLocation → 逐段核对 → ensurePath + linkItem */
  onTidyTap() {
    this.setData({ moreOpen: false });
    void this.onMountTap();
  },

  /** 删除:先收起菜单,再 wx.showModal 二次确认 */
  onDeleteTap() {
    this.setData({ moreOpen: false });
    if (this.data.saving || this.data.deleting) {
      return;
    }
    if (this.data.videoPending !== null) {
      wx.showModal({
        title: "先处理待关联视频",
        content: "这件物品还有一段已上传但未关联成功的视频。请先重试关联或删除待关联视频,再删除物品,避免云端留下无归属的私密视频。",
        showCancel: false,
      });
      return;
    }
    const name = this.data.name.trim() || "这条记录";
    wx.showModal({
      title: "确认删除",
      content: "删除「" + name + "」后无法恢复,确定删除吗?",
      confirmText: "删除",
      confirmColor: "#d93025",
      cancelText: "取消",
      success: (r) => {
        if (!r.confirm) {
          return;
        }
        this.confirmDelete();
      },
    });
  },

  async confirmDelete() {
    this.setData({ deleting: true });
    try {
      await callItemsApi({ action: "delete", item_id: this.data.itemId });
      wx.showToast({ title: "已删除", icon: "success" });
      setTimeout(() => {
        this.goBack();
      }, 800);
    } catch (e) {
      wx.showModal({
        title: "删除失败",
        content: errorMessage(e),
        showCancel: false,
      });
    } finally {
      this.setData({ deleting: false });
    }
  },

  goBack() {
    wx.navigateBack({
      fail: () => {
        wx.reLaunch({ url: "/pages/index/index" });
      },
    });
  },

  async loadById(id) {
    try {
      const res = await callItemsApi({ action: "get", item_id: id });
      this.applySummary(res.item);
    } catch (e) {
      wx.showModal({
        title: "无法打开",
        content: errorMessage(e),
        showCancel: false,
        success: () => {
          this.goBack();
        },
      });
    }
  },

  /**
   * F4-B3:冲突未裁定时「整理位置」的写入门禁。冲突面板还在(仍有未选边
   * 字段,或已选边但还没保存/收敛——面板只有在表单与最新基准一致时才会收起)
   * 且表单位置仍不同于已确认基准时返回 true:此时挂载会把 location_node_id
   * 指向按本地未裁定文本解析的位置,服务端 location_text 仍是对方值,位置
   * 事实分裂。选边并保存(基准重置、面板收起)或位置收敛后自然放行。
   */
  mountBlockedByConflict(): boolean {
    if (this.data.conflicts.length === 0 && !this.data.conflictPending) {
      return false; // 无冲突态:普通编辑照旧可整理(既有行为)
    }
    return this.data.locationText.trim() !== this.original.location;
  },

  /**
   * 整理位置:parseLocation 零写库出候选分段 → 用户逐段核对(可改)→
   * ensurePath + linkItem。AI 不可用时兜底为手动选位置(选择模式)。
   */
  async onMountTap() {
    if (this.data.detailPanel === "location" && this.data.locationText.trim() !== this.original.location) { wx.showToast({ title: "先确认位置描述，再整理归类", icon: "none" }); return; }
    if (this.data.saving || this.data.deleting || this.data.mounting) {
      return;
    }
    if (this.mountBlockedByConflict()) {
      // F4-B3(架构复审阻断):冲突未裁定且待提交位置仍异于已确认基准时,
      // 挂载会按本地未裁定文本建/指节点,而服务端 location_text 仍是对方值
      // ——位置事实分裂。先逐项选边并保存,再整理位置
      wx.showToast({
        title: "位置冲突还没处理,先选保留哪一版并保存,再整理位置",
        icon: "none",
        duration: 2500,
      });
      return;
    }
    const text = this.data.locationText.trim();
    if (!text) {
      wx.showToast({ title: "这条记录还没有位置描述,先在编辑里补一句", icon: "none" });
      return;
    }
    this.setData({ mounting: true });
    try {
      const res = await callLocationsApi({
        action: "parseLocation",
        text,
      });
      const parse = res.parse;
      const hints = new Map<number, string>();
      for (const s of parse.merge_suggestions) {
        if (!hints.has(s.segment_index)) {
          hints.set(s.segment_index, s.existing_name);
        }
      }
      this.setData({
        mountPanelOpen: true,
        mountNeedConfirm: parse.need_confirm,
        mountOrderViolation: parse.order_violation,
        mountSegments: parse.segments.map((seg, i) => ({
          idx: i,
          name: seg.name,
          confidenceText: Math.round(seg.confidence * 100) + "%",
          needConfirm: seg.confidence < 0.8,
          hintName: hints.get(i) || "",
        })),
      });
    } catch (e) {
      if (isLocationsApiErrorWithCode(e, "AI_UNAVAILABLE")) {
        wx.showModal({
          title: "AI 暂时不可用",
          content: "解析不了这句位置,要改为手动选一个已有位置吗?",
          confirmText: "手动选位置",
          cancelText: "取消",
          success: (r) => {
            if (r.confirm) {
              this.openLocationPicker();
            }
          },
        });
        return;
      }
      wx.showModal({
        title: "解析失败",
        content: errorMessage(e),
        showCancel: false,
      });
    } finally {
      this.setData({ mounting: false });
    }
  },

  onMountSegmentInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const value = e.detail && e.detail.value ? e.detail.value : "";
    const rows = this.data.mountSegments.slice();
    if (!rows[index]) {
      return;
    }
    rows[index] = { ...rows[index], name: value };
    this.setData({ mountSegments: rows });
  },

  /** AI 不可用的手动兜底:进 locations 选择模式,选中后直接 linkItem */
  openLocationPicker() {
    wx.navigateTo({
      url:
        "/pages/locations/locations?picker=1&title=" +
        encodeURIComponent("把「" + (this.data.name || "这件物品") + "」放到哪个位置…"),
      events: {
        pickNode: (d: { location_id: string; path?: string[] }) => {
          if (this.data.detailPanel === "location") {
            if (!isScopeGenerationCurrent(this.locationChoiceScope)) return;
            this.locationNodeDraft = { nodeId: d.location_id, path: Array.isArray(d.path) ? d.path : [] };
            this.setData({ locationPathDraft: this.locationNodeDraft.path });
          } else void this.doLinkToNode(d.location_id, d.path);
          // 退栈统一由发起页计算(选择器页自身不再逐层退,#29 后续):
          // 选择器页只叠在本页正上方,一次退掉全部。
          const pages = getCurrentPages();
          const idx = pages.indexOf(this);
          const delta = pages.length - 1 - idx;
          if (idx !== -1 && delta > 0) {
            wx.navigateBack({ delta, fail: () => {} });
          }
        },
      },
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  async doLinkToNode(nodeId, path) {
    if (this.mountBlockedByConflict()) {
      // F4-B3:选择器是异步回传,面板在选位置的这段时间里可能已弹出冲突——
      // 写入前再守一次门,与入口同一口径(先选边保存,再整理位置)
      wx.showToast({
        title: "位置冲突还没处理,先选保留哪一版并保存,再整理位置",
        icon: "none",
        duration: 2500,
      });
      return false;
    }
    const staged = this.data.detailPanel === "location";
    const retry = staged && this.locationLinkRetry?.nodeId === nodeId ? this.locationLinkRetry : { nodeId, version: this.data.version, updateId: uuid() };
    if (staged) this.locationLinkRetry = retry;
    this.setData({ mountSaving: true });
    try {
      const res = await callLocationsApi({
        action: "linkItem",
        item_id: this.data.itemId,
        node_id: nodeId,
        expected_version: retry.version,
        update_id: retry.updateId,
      });
      this.setData({
        version: res.item.version,
        updatedAtText: formatDateTime(res.item.updated_at),
        // 刚亲手选定的位置:大卡如实跟进(选择器回传的展示用路径)
        spacePath: Array.isArray(path) ? path : this.data.spacePath,
      });
      this.locationLinkRetry = null;
      wx.showToast({ title: "已记到这个位置", icon: "success" });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        this.locationLinkRetry = null;
        // 物品被并发修改:与保存冲突同一口径走四字段冲突刷新——双方都改且不同
        // 的字段进冲突面板显式选边(未选完前保存被门禁拦住,上一轮未选边的
        // 条目也保留),绝不静默覆盖;无冲突字段维持三方合并,对齐版本后重试整理
        const result = await this.refreshForConflict();
        if (result === "notfound") {
          wx.showModal({
            title: "记录不存在",
            content: "没有找到这条记录,可能已被删除。",
            showCancel: false,
            success: () => {
              this.goBack();
            },
          });
          return false;
        }
        if (result === "refreshed") {
          wx.showToast({
            title: this.data.conflictPending
              ? "部分字段与最新记录冲突,请逐项选择保留哪一版"
              : "内容已被修改,已更新版本号,请重试",
            icon: "none",
            duration: 2500,
          });
        }
      } else {
        // #116 冻结门:linkItem/ensurePath 挂向 deleting 子树被拒时单独翻译
        wx.showModal({
          title: "整理失败",
          content: deletingFrozenMessage(e) || errorMessage(e),
          showCancel: false,
        });
      }
    } finally {
      this.setData({ mountSaving: false });
    }
    return false;
  },

  /** 确认候选分段:ensurePath(用户确认后的唯一建节点入口)→ linkItem(版本条件更新) */
  async confirmMount() {
    if (this.data.mountSaving) {
      return;
    }
    if (this.mountBlockedByConflict()) {
      // F4-B3:候选面板是冲突前解析好的,确认时状态可能已变(异步写入前守门);
      // 冲突未裁定且位置异于基准时禁止 ensurePath/linkItem,先选边保存
      wx.showToast({
        title: "位置冲突还没处理,先选保留哪一版并保存,再整理位置",
        icon: "none",
        duration: 2500,
      });
      return;
    }
    const names = this.data.mountSegments
      .map((s) => s.name.trim())
      .filter((n) => n.length > 0);
    if (names.length === 0) {
      wx.showToast({ title: "至少填一段位置", icon: "none" });
      return;
    }
    this.setData({ mountSaving: true });
    try {
      const ensured = await callLocationsApi({
        action: "ensurePath",
        path: names,
        created_from: "parse",
      });
      const target = ensured.nodes[ensured.nodes.length - 1];
      if (!target) {
        throw new Error("服务返回异常");
      }
      const res = await callLocationsApi({
        action: "linkItem",
        item_id: this.data.itemId,
        node_id: target.location_id,
        expected_version: this.data.version,
        update_id: uuid(),
      });
      this.setData({
        version: res.item.version,
        updatedAtText: formatDateTime(res.item.updated_at),
        mountPanelOpen: false,
        // 刚确认并记入的位置分段:大卡如实跟进(与 ensurePath 收到的完全一致)
        spacePath: names,
        detailPanel: this.data.detailPanel === "location" ? "" : this.data.detailPanel,
        editPanelOpen: false,
      });
      wx.showToast({ title: "已记到这个位置", icon: "success" });
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        // 物品被并发修改:与保存冲突同一口径走四字段冲突刷新(冲突面板/门禁
        // 语义同 doLinkToNode 分支),无冲突字段三方合并对齐版本后重试整理
        const result = await this.refreshForConflict();
        if (result === "notfound") {
          wx.showModal({
            title: "记录不存在",
            content: "没有找到这条记录,可能已被删除。",
            showCancel: false,
            success: () => {
              this.goBack();
            },
          });
        } else if (result === "refreshed") {
          wx.showToast({
            title: this.data.conflictPending
              ? "部分字段与最新记录冲突,请逐项选择保留哪一版"
              : "内容已被修改,已更新版本号,请重试",
            icon: "none",
            duration: 2500,
          });
        }
      } else {
        // #116 冻结门:linkItem/ensurePath 挂向 deleting 子树被拒时单独翻译
        wx.showModal({
          title: "整理失败",
          content: deletingFrozenMessage(e) || errorMessage(e),
          showCancel: false,
        });
      }
    } finally {
      this.setData({ mountSaving: false });
    }
  },

  cancelMount() {
    this.setData({ mountPanelOpen: false, mountSegments: [] });
  },

  /* ---------------- 提醒的查看与处理(#36 三阶段) ---------------- */

  /**
   * 拉当前家庭这件的 active 提醒行(只取数,不上屏):经 households 资格复核
   * (硬门 C,口径同 R1/首页),在途家庭切换(作用域代数变化)或加载失败时
   * 返回 undefined——调用方据此「不猜远端」,绝不把旧家庭/失败当作「无提醒」。
   */
  async fetchReminderRow(): Promise<RemindRow | null | undefined> {
    await ensureScopeVerified();
    // 复核可能揭示家庭漂移并递增代数:请求前重新捕获,响应后才校验
    const scopeGen = captureScopeGeneration();
    try {
      const res = await callItemsApi({ action: "remindList" });
      if (!isScopeGenerationCurrent(scopeGen)) {
        // 在途期间家庭已切换(含响应揭示的漂移):旧家庭响应不可用
        return undefined;
      }
      return res.reminders.find((r) => r.item_id === this.data.itemId) || null;
    } catch (e) {
      // 静默:提醒不可得,由调用方决定口径(详情主体不受影响)
      return undefined;
    }
  },

  /**
   * F4-B2:轮次未知(-1,未加载/加载失败/冲突刷新远端不可得)时的写前补拉。
   * 表单里的用户候选(remindAt)原样保留——补拉不是刷新展示,是给待发的写
   * 请求取 CAS 条件;拉不到("unknown")就失败关闭,绝不省略
   * expected_generation 退回旧协议无条件写。
   * F4-B4:补拉结果三分支收紧——远端确认无提醒(轮次 0,补录语义)或远端
   * 内容与用户已确认基准(remindOriginal 语义)一致才返回 "known"(对齐轮次
   * 与基准后按轮次正常提交);远端已是不同内容且用户尚未知悉返回 "diverged"
   * 且不做任何对齐:此时直接写会在用户从未看过远端值的情况下覆盖他人修改
   * (CAS 只保证提交瞬间无新变化,不构成知情选择),由调用方保留候选并进入
   * 既有冲突双值面板,显式选边后才能写。diverged 时也不把基准对齐到远端——
   * 对齐会让候选在随后的冲突刷新里退化成「仅本机修改」,绕开双值面板。
   */
  async reloadRemindGeneration(): Promise<"known" | "unknown" | "diverged"> {
    const row = await this.fetchReminderRow();
    if (row === undefined) {
      return "unknown";
    }
    if (row !== null && row.due_date !== this.remindOriginal) {
      return "diverged";
    }
    const candidate = this.data.remindAt;
    this.remindRemoteUnknown = false;
    this.applyReminderRow(row);
    this.setData({ remindAt: candidate });
    return this.data.remindGeneration >= 0 ? "known" : "unknown";
  },

  /**
   * 拉当前家庭 active 提醒,取这件的那一行上屏。展示前先清旧行并经
   * households 资格复核(硬门 C,口径同 R1/首页);家庭切换(作用域代
   * 数变化)后旧家庭响应不上屏。加载失败
   * 静默隐藏保质期行(增强露出,不影响详情主体)。
   */
  async refreshReminderRow(): Promise<void> {
    // 先收起旧保质期行:被移除/切换家庭后冷启动,展示前不得残留旧家庭提醒
    this.setData({ expire: null, remindAt: "", remindGeneration: -1 });
    this.remindOriginal = "";
    const row = await this.fetchReminderRow();
    // 家庭作用域此刻刚经服务端复核:重读「已成功开启订阅」本地标记
    // (#36 真机手势规则:显式入口的显示条件之一;键随家庭隔离)
    this.setData({ notifyAccepted: isNotifyAccepted() });
    if (row === undefined) {
      return; // 失败/在途切换:静默,详情其余照常
    }
    this.applyReminderRow(row);
  },

  applyReminderRow(row: RemindRow | null) {
    this.setData({ recordedRemindAt: row ? row.due_date : "", reminderNeedsSave: false });
    if (row === null) {
      // 已确认这件当前无提醒:轮次号记 0(补录语义的 expected_generation)
      this.remindOriginal = "";
      this.setData({ expire: null, remindAt: "", remindGeneration: 0 });
      return;
    }
    this.remindOriginal = row.due_date;
    // 换算候选标注(三件 A):仅 remind_converted 行携带换算源原话,
    // 详情页保质期行据此小字标注「按『…』换算」;常规行为空串不渲染
    const convertedNote =
      row.remind_converted === true && typeof row.remind_quote === "string"
        ? row.remind_quote
        : "";
    this.setData({
      expire: {
        mainText: expireMainText(row.due_date),
        dueDate: row.due_date,
        kind: row.kind,
        convertedNote,
      },
      remindAt: row.due_date,
      remindGeneration:
        typeof row.generation === "number" ? row.generation : -1,
    });
  },

  /** 保质期行「已处理」:二次确认后 remindComplete(不带 period_days;下次提醒到详情里自己选日子) **/
  async onExpireDoneTap() {
    if (this.data.remindBusy) {
      return;
    }
    const expire = this.data.expire;
    if (!expire) {
      return;
    }
    if (this.hasRemindConflict() || this.pendingRemindWrite() !== null) {
      // F4-B1(架构复审阻断):提醒冲突待选或待补写时,到期行显示的是「你正要
      // 存的候选」预览,不是已确认的当前提醒——此时完成会以刷新对齐的远端新
      // 轮次调 remindComplete,可能替家人收掉他刚设的提醒,绕开选边硬门。
      // 失败关闭:先处理冲突(选边保存 / 补写),到期行照常显示候选供对照。
      wx.showToast({
        title: this.hasRemindConflict()
          ? "提醒冲突还没处理,先选保留哪一版"
          : "提醒还没存上,先保存修改,再点已处理",
        icon: "none",
        duration: 2500,
      });
      return;
    }
    if (this.data.remindGeneration < 0) {
      // F4-B2:轮次未知(未加载/加载失败/冲突刷新远端不可得)时完成同样是
      // reminder 写——先补拉取轮次,拉不到就失败关闭,绝不省略 expected_generation
      const outcome = await this.reloadRemindGeneration();
      if (outcome === "unknown") {
        wx.showToast({
          title: "提醒还没加载好,稍后再点已处理",
          icon: "none",
          duration: 2500,
        });
        return;
      }
      if (outcome === "diverged") {
        // F4-B4:补拉发现提醒已变成用户没看过的内容:停止原完成动作——
        // 先把最新提醒如实上屏,再由用户经「带新日期的确认框」显式确认这一条,
        // 确认后才按最新轮次完成;取消则不写,屏上已如实显示最新提醒
        await this.refreshReminderRow();
        const latest = this.data.expire;
        if (!latest || this.data.remindGeneration < 0) {
          wx.showToast({
            title: "提醒有变化,已刷新,确认后再点已处理",
            icon: "none",
            duration: 2500,
          });
          return;
        }
        const confirmed = await new Promise<boolean>((resolve) => {
          wx.showModal({
            title: "提醒有变化",
            content:
              "这条提醒现在是 " +
              monthDayText(latest.dueDate) +
              " 到期,要按这一条处理吗?",
            confirmText: "按这一条处理",
            cancelText: "先不处理",
            success: (r) => {
              resolve(r.confirm === true);
            },
            fail: () => {
              resolve(false);
            },
          });
        });
        if (!confirmed) {
          return; // 用户不确认最新提醒:不写
        }
        // 已显式确认最新提醒:按 refreshReminderRow 读到的最新轮次继续完成
      } else if (!this.data.expire) {
        return; // 补拉发现远端已无提醒:没有可完成的,到期行已如实收起
      }
    }
    const confirmed = await askUseUp(this.data.name);
    if (!confirmed) {
      return; // 用户取消:不动、不写
    }
    this.setData({ remindBusy: true });
    try {
      await callItemsApi({
        action: "remindComplete",
        item_id: this.data.itemId,
        // 轮次未知已被上方 F4-B2 门禁拦下,这里必带轮次(≥0),绝不省略
        expected_generation: this.data.remindGeneration,
        // 完成日按用户本地自然日随请求携带(PR #52 Low-3):服务端不靠运行时区猜
        complete_date: localTodayYmd(),
      });
      this.setData({ expire: null, remindAt: "", remindGeneration: 0 });
      this.remindOriginal = "";
      // 0.9.6(#36 用户反馈):已处理=微信提醒关掉——该物品提醒已完成、天然
      // 不再进推送(每日扫描只看 active 提醒);清「已开启」标记,让之后的新
      // 提醒能重新询问/开启订阅(无论记录保留还是删除都一样)
      clearNotifyAccepted();
      // #36 真机反馈三件 B(用户功能请求):完成后问「记录还保留吗」——
      // 保留(确认/dismiss)= 现状(已处理 toast);删除物品(取消)= itemsApi
      // delete(与 ⋯ 菜单删除先例同款:级联硬删 active 提醒 + 软删物品,api 层
      // 自动拼装作用域双 marker),成功后返回上一页。dismiss=保留(安全默认,
      // 误触删除不可逆;服务端虽软删但客户端无恢复入口)。删除失败:如实 toast
      // 错误文本,物品保留、已处理不回滚(完成已发生),留在本页稍后再删。
      const keep = await askKeepAfterDone(this.data.name);
      if (keep === "delete") {
        try {
          await callItemsApi({ action: "delete", item_id: this.data.itemId });
          wx.showToast({ title: "已删除", icon: "success" });
          setTimeout(() => {
            this.goBack();
          }, 800);
        } catch (delErr) {
          wx.showToast({
            title: "没删成:" + errorMessage(delErr),
            icon: "none",
            duration: 2500,
          });
        }
        return;
      }
      // 完成后不弹固定周期选项(#36 真机反馈 Fix 2):下次提醒时间由用户到详情里选日子
      wx.showToast({
        title: "已处理。要下次提醒,到详情里选日子",
        icon: "none",
        duration: 2500,
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        if (e.cleared === true) {
          // PR #52 R3-1:完成置 done 后、认领前提醒被家人清除——本轮已完成,
          // 服务端清除栅栏挡住了再生:如实告知,不再生成下一轮
          wx.showToast({ title: "已处理;提醒已被清除,不再生成下次", icon: "none", duration: 2500 });
          await this.refreshReminderRow();
          return;
        }
        if (e.superseded === true) {
          // PR #52 R4-1:完成置 done 后、认领前提醒被家人重新设置——再生认领
          // 绑定原完成轮次被原子拒绝:如实告知本轮不再生成,新提醒原样保留
          wx.showToast({ title: "已处理;提醒刚被重新设置,不再生成下次", icon: "none", duration: 2500 });
          await this.refreshReminderRow();
          return;
        }
        // 这轮已被家人处理并换了新提醒(PR #52 B1):刷新看最新,绝不误伤
        wx.showToast({ title: "这条刚被家人处理过,已刷新", icon: "none" });
        await this.refreshReminderRow();
        return;
      }
      wx.showModal({
        title: "没办成",
        content: errorMessage(e),
        showCancel: false,
      });
    } finally {
      this.setData({ remindBusy: false });
    }
  },

  /**
   * 「到期时微信提醒我 ›」显式订阅入口(#36 真机手势规则,0.9.0 iOS 实测):
   * 微信规定 wx.requestSubscribeMessage 必须在「用户点击手势」的直接回调内
   * 发起,picker 的 bindchange(滚轮选完)回调不算点击手势、必然被拒——
   * 订阅授权入口从 picker 直写路径移到这里,真实按钮点击(官方推荐模式;
   * 入口只在有生效提醒且本地未标记「已开启」时露出,见 wxml 显示条件)。
   * accept 且服务端记录已发起后:写本地标记并收起入口(标记是展示启发式,
   * 权威记录在服务端 remind_subscriptions);reject/fail 静默降级应用内提醒
   * 页,入口保留可再点,绝不阻塞任何流程。
   */
  onNotifyChipTap() {
    if (!this.data.remindAt) {
      return; // 无生效提醒:入口不该在(双保险)
    }
    requestExpirySubscribe(() => {
      markNotifyAccepted();
      this.setData({ notifyAccepted: true });
    }, this.data.remindAt);
  },

  onDiagEntryTap() {
    wx.navigateTo({ url: "/pages/diag-subscribe/diag-subscribe" });
  },

  /**
   * 编辑折叠「提醒」选日子(#36:picker mode=date 弹层,唯一手动日期来源):
   * 没有提醒的物品在这里补录,有提醒的在这里改期——都走 remindSet,把提醒
   * 设为所选的日子(服务端替换该物品的提醒,不堆积)。picker 回填必为合法
   * YYYY-MM-DD,异常值不写;校验与 picker 范围两端一致——今天可设(到期分组
   * 本就有「今天到期」),过去的日子与超 10 年的拒绝(PR #52 Low-3,按用户
   * 本地自然日判定)。请求携带页面所见轮次号(PR #52 B1):这一轮已被家人
   * 换过 → VERSION_CONFLICT,刷新后重选,绝不静默覆盖别人的新提醒
   * (0=页面确认无提醒的补录)。
   */
  async onRemindDateChange(e) {
    if (this.data.remindBusy) {
      return;
    }
    const value = e.detail && typeof e.detail.value === "string" ? e.detail.value : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return; // picker 形状异常:不写
    }
    if (value === this.data.remindAt) {
      return; // 没变
    }
    const problem = pickerDateProblem(value);
    if (problem !== "") {
      wx.showToast({ title: problem, icon: "none" });
      return;
    }
    // 0.9.6(#36 用户反馈):选完日子先问一句「要不要微信提醒」。此处是
    // picker bindchange,无点击手势,但纯提问的 modal 不受手势限制;答案存
    // wantsNotify。0.9.7:点「提醒我」**立即**尝试授权——骑 modal 确认的
    // 激活窗口(现代基础库保留);picker 本身无手势,若此处被手势拒绝,落回
    // 保存 tap 二次机会与 chip 入口(双兜底)。
    const wantsNotify = await askNotifyIntent(value);
    if (wantsNotify) {
      requestExpirySubscribe(() => {
        markNotifyAccepted();
        this.setData({ notifyAccepted: true });
      }, value);
    }
    this.setData({ wantsNotify });
    // #36 真机手势规则(0.9.0 iOS 实测):picker bindchange(滚轮选完)不是
    // 用户点击手势,此处调 wx.requestSubscribeMessage 必然报错
    // 「requestSubscribeMessage:fail can only be invoked by user TAP gesture」
    // (真机 toast 被截断只见「…fail c…」),留着只产生错误 toast 噪音——授权
    // 入口移至保质期行下方的「到期时微信提醒我 ›」显式入口(onNotifyChipTap,
    // 真实 tap);onSaveTap 的真实按钮点击路径照旧请求订阅。
    if (this.hasRemindConflict() || this.pendingRemindWrite() !== null) {
      // 冲突面板已把「提醒」列为待选字段,或冲突刷新后提醒远端不可得、选择还
      // 留在表单等保存补写(F4-B1):改日期只更新「你的修改」/候选并撤回已有
      // 选择,不直接落库——与文本输入框同一门禁口径,必须点按钮显式选边或经
      // 保存修改补写;表单里的是候选,不是已确认的当前提醒
      this.setPendingRemind(value);
      this.syncConflictFromInput("remind", value);
      if (!this.hasRemindConflict()) {
        // 无面板的待补写态:面板不会给出可见反馈,如实告知没存上并引导补写
        wx.showToast({
          title: "提醒没存上,你的选择已保留,点保存修改再试",
          icon: "none",
          duration: 2500,
        });
      }
      return;
    }
    const hadReminder = this.data.remindAt !== "";
    if (this.data.remindGeneration < 0) {
      // F4-B2:轮次未知(未加载/加载失败/冲突刷新远端不可得)不得发 remindSet
      // ——先补拉一次取轮次,拉不到就失败关闭:候选保留在表单,提示稍后重试,
      // 绝不省略 expected_generation 退回旧协议无条件替换
      const outcome = await this.reloadRemindGeneration();
      if (outcome === "unknown") {
        this.setPendingRemind(value);
        wx.showToast({
          title: "提醒还没存好,你的选择已保留,稍后再试",
          icon: "none",
          duration: 2500,
        });
        return;
      }
      if (outcome === "diverged") {
        // F4-B4:补拉撞见远端已是不同内容且用户从未看过:不得直接写——
        // 候选保留,进入既有冲突双值面板(远端值 vs 本地候选),显式选边后
        // 经保存修改按最新轮次提交(与 remindSet 撞 VERSION_CONFLICT 同口径)
        this.setPendingRemind(value);
        const result = await this.refreshForConflict();
        if (result === "notfound") {
          wx.showModal({
            title: "记录不存在",
            content: "没有找到这条记录,可能已被删除。",
            showCancel: false,
            success: () => {
              this.goBack();
            },
          });
          return;
        }
        if (result === "refreshed") {
          wx.showToast({
            title: this.data.conflictPending
              ? "提醒与最新记录冲突,请选择保留哪一版"
              : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                ? "提醒没存上,你的选择已保留,点保存修改再试"
                : hadReminder
                  ? "这条提醒刚被家人改过,已刷新"
                  : "这条刚带上提醒,已刷新",
            icon: "none",
            duration: 2500,
          });
        }
        return;
      }
      if (value === this.remindOriginal) {
        return; // 补拉后远端已是这个日子:无需再写
      }
    }
    this.setData({ remindBusy: true });
    try {
      const res = await callItemsApi({
        action: "remindSet",
        item_id: this.data.itemId,
        due_date: value,
        // 轮次未知已被上方 F4-B2 门禁拦下,这里必带轮次(≥0),绝不省略
        expected_generation: this.data.remindGeneration,
      });
      if (res.reminder) {
        this.applyReminderRow(res.reminder);
        if (wantsNotify && !this.data.notifyAccepted) {
          // 用户想要提醒且「提醒我」的立即授权没有成功(未 accept/被手势拒):
          // 清「已开启」标记让 chip 露出引导点按(一次性订阅额度随每次发送
          // 消耗,新提醒需要新的授权),toast 一并指路。notifyAccepted 已为
          // true = 立即授权已成功,跳过(入口保持收起,不出多余引导)
          clearNotifyAccepted();
          this.setData({ notifyAccepted: false });
          wx.showToast({
            title: "提醒已设好;点「到期时微信提醒我」开微信推送",
            icon: "none",
            duration: 2500,
          });
        } else if (!wantsNotify) {
          wx.showToast({
            title: hadReminder
              ? "提醒已改到 " + monthDayText(res.reminder.due_date)
              : "已带上提醒:" + monthDayText(res.reminder.due_date) + " 到期",
            icon: "none",
          });
        }
      } else {
        // 不应发生(remindSet 必回所设行):回查一次,如实收敛
        await this.refreshReminderRow();
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        // 他处已改这条提醒:你正要存的日子留在表单,进入四字段双值对比,
        // 显式选择保留哪一版;选「保留我的修改」后按最新轮次号重发(见 onSaveTap)
        this.setPendingRemind(value);
        const result = await this.refreshForConflict();
        if (result === "notfound") {
          wx.showModal({
            title: "记录不存在",
            content: "没有找到这条记录,可能已被删除。",
            showCancel: false,
            success: () => {
              this.goBack();
            },
          });
          return;
        }
        if (result === "refreshed") {
          wx.showToast({
            title: this.data.conflictPending
              ? "提醒与最新记录冲突,请选择保留哪一版"
              : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                ? "提醒没存上,你的选择已保留,点保存修改再试"
                : hadReminder
                  ? "这条提醒刚被家人改过,已刷新"
                  : "这条刚带上提醒,已刷新",
            icon: "none",
            duration: 2500,
          });
        }
        return;
      }
      wx.showModal({
        title: hadReminder ? "提醒没改成" : "提醒没带上",
        content: errorMessage(e),
        showCancel: false,
      });
    } finally {
      this.setData({ remindBusy: false });
    }
  },

  /** 编辑折叠「提醒」✕:连日期一起清除(remindClear,带所见轮次号);日期唯一作用就是出现在「快到期」,没有「存日期但不提醒」 */
  async onRemindFieldClear() {
    if (this.data.remindBusy || !this.data.remindAt) {
      return;
    }
    if (this.hasRemindConflict() || this.pendingRemindWrite() !== null) {
      // 冲突面板待选期间,或提醒远端不可得、选择还在表单待补写(F4-B1):
      // 清除只更新面板「你的修改」/候选为「不带提醒」并撤回选择,不直接落库
      // ——必须点按钮显式选边,或经保存修改补写
      this.setPendingRemind("");
      this.syncConflictFromInput("remind", "");
      if (!this.hasRemindConflict()) {
        wx.showToast({
          title: "提醒没存上,你的选择已保留,点保存修改再试",
          icon: "none",
          duration: 2500,
        });
      }
      return;
    }
    if (this.data.remindGeneration < 0) {
      // F4-B2:轮次未知时清除同样是 reminder 写——先补拉取轮次,拉不到就
      // 失败关闭:候选(不带提醒)保留在表单,绝不无条件清除家人的提醒
      const outcome = await this.reloadRemindGeneration();
      if (outcome === "unknown") {
        this.setPendingRemind("");
        wx.showToast({
          title: "还没改成,提醒还没加载好,稍后再试",
          icon: "none",
          duration: 2500,
        });
        return;
      }
      if (outcome === "diverged") {
        // F4-B4:补拉撞见远端已是不同内容且用户从未看过:不得直接清——
        // 候选(不带提醒)保留,进入既有冲突双值面板显式选边
        //(与 remindClear 撞 VERSION_CONFLICT 同口径)
        this.setPendingRemind("");
        const result = await this.refreshForConflict();
        if (result === "notfound") {
          wx.showModal({
            title: "记录不存在",
            content: "没有找到这条记录,可能已被删除。",
            showCancel: false,
            success: () => {
              this.goBack();
            },
          });
          return;
        }
        if (result === "refreshed") {
          wx.showToast({
            title: this.data.conflictPending
              ? "提醒与最新记录冲突,请选择保留哪一版"
              : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                ? "提醒没存上,你的选择已保留,点保存修改再试"
                : "这条提醒刚被家人改过,已刷新",
            icon: "none",
            duration: 2500,
          });
        }
        return;
      }
      if (this.remindOriginal === "") {
        // 补拉确认远端已无提醒:没有可清除的,不发空写,表单对齐远端事实
        this.setData({ remindAt: "" });
        wx.showToast({ title: "已不带提醒", icon: "none" });
        return;
      }
    }
    this.setData({ remindBusy: true });
    try {
      await callItemsApi({
        action: "remindClear",
        item_id: this.data.itemId,
        // 轮次未知已被上方 F4-B2 门禁拦下,这里必带轮次(≥0),绝不省略
        expected_generation: this.data.remindGeneration,
      });
      this.setData({ expire: null, remindAt: "", remindGeneration: 0 });
      this.remindOriginal = "";
      wx.showToast({ title: "已不带提醒", icon: "none" });
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        // 他处已改这条提醒:「不带提醒」的选择留在表单,进入四字段双值对比,
        // 显式选择保留哪一版,绝不静默删掉别人的新提醒
        this.setPendingRemind("");
        const result = await this.refreshForConflict();
        if (result === "notfound") {
          wx.showModal({
            title: "记录不存在",
            content: "没有找到这条记录,可能已被删除。",
            showCancel: false,
            success: () => {
              this.goBack();
            },
          });
          return;
        }
        if (result === "refreshed") {
          wx.showToast({
            title: this.data.conflictPending
              ? "提醒与最新记录冲突,请选择保留哪一版"
              : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                ? "提醒没存上,你的选择已保留,点保存修改再试"
                : "这条提醒刚被家人改过,已刷新",
            icon: "none",
            duration: 2500,
          });
        }
        return;
      }
      wx.showModal({
        title: "没改成",
        content: errorMessage(e),
        showCancel: false,
      });
    } finally {
      this.setData({ remindBusy: false });
    }
  },

  /* ---------------- 照片证据回放(#3 §6) ---------------- */

  /**
   * 拉当前家庭这件的照片证据行(只取数,不上屏):经 households 资格复核后
   * 捕获作用域代数,响应回来复核——在途家庭切换时旧家庭证据不上屏;
   * 复核失败或加载失败返回 undefined,调用方静默(证据是增强露出,
   * fetchReminderRow 同款口径:绝不把旧家庭/失败当作「无证据」)。
   */
  async fetchEvidenceRows(): Promise<PhotoEvidenceRow[] | undefined> {
    if (!this.data.itemId) {
      return undefined;
    }
    try {
      await ensureScopeVerified();
    } catch (e) {
      return undefined; // 复核失败:静默,证据卡不渲染
    }
    const scopeGen = captureScopeGeneration();
    try {
      const res = await callItemsApi({
        action: "photoEvidenceGet",
        item_ids: [this.data.itemId],
      });
      if (!isScopeGenerationCurrent(scopeGen)) {
        return undefined; // 在途期间家庭已切换:旧家庭响应不可用
      }
      return res.evidence;
    } catch (e) {
      return undefined; // 静默:详情主体照常
    }
  },

  /**
   * 刷新证据卡:先收起旧卡(家庭切换/换物品后冷启动,展示前不得残留旧
   * 作用域证据),再拉取。有行 → mapEvidenceView 派生渲染视图(「位置已
   * 变更」按当前表单位置文本判定);无行 → 只显「去补拍」;失败 → 整卡
   * 不渲染。文案纪律:照片是历史证据,只说明拍摄当日记录在哪,绝不冒充
   * 当前位置——位置已变更时以文字位置为准,旧照片仅作证据。
   */
  async refreshEvidence(): Promise<void> {
    this.setData({
      evidenceReady: false,
      photoLookupFailed: false,
      evidenceNoPhoto: false,
      evidenceOpen: false,
      evidenceOlderOpen: false,
      evidence: null,
    });
    const rows = await this.fetchEvidenceRows();
    if (rows === undefined) {
      this.setData({ photoLookupFailed: true });
      return;
    }
    if (rows.length === 0) {
      this.setData({ evidenceNoPhoto: true });
      return;
    }
    this.setData({
      evidenceReady: true,
      evidence: mapEvidenceView(rows, this.data.locationText),
    });
  },

  onEvidenceTap() {
    if (this.data.evidence !== null && this.data.evidence.latest.urlFail) {
      // 换链失败(file_id 仍在):点按 = 重新调 photoEvidenceGet 重试
      void this.refreshEvidence();
      return;
    }
    this.setData({ evidenceOpen: !this.data.evidenceOpen });
  },

  onEvidenceOlderToggle() {
    this.setData({ evidenceOlderOpen: !this.data.evidenceOlderOpen });
  },

  onRetakeTap() {
    // 重拍更新 / 去补拍:进拍照页开新一批(不带恢复参数,§6.4)
    wx.navigateTo({
      url: "/pages/photo/photo",
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  async fetchVideoEvidenceRows(): Promise<VideoEvidenceRow[] | undefined> {
    if (this.data.itemId === "") return undefined;
    try {
      await ensureScopeVerified();
    } catch (e) {
      return undefined;
    }
    const scopeGen = captureScopeGeneration();
    try {
      const res = await callItemsApi({ action: "videoEvidenceGet", item_ids: [this.data.itemId] });
      if (isScopeGenerationCurrent(scopeGen) === false) return undefined;
      return res.evidence;
    } catch (e) {
      return undefined;
    }
  },

  async refreshVideoEvidence(reopenPaused = false): Promise<void> {
    const badgeEntry = this.videoEntryHint !== null && this.videoEntryFocusConsumed === false;
    const itemId = this.data.itemId;
    this.setData({
      videoReady: false,
      videoEvidence: null,
      videoSelected: null,
      videoOpen: false,
      videoSelectedHighlightKey: "",
      videoFoldText: "",
      videoPlaybackNotice: "",
      videoPlaybackError: "",
      videoInitialTime: 0,
      videoSeekPending: false,
      videoCurrentMs: 0,
      videoActiveBox: null,
      videoLookupFailed: false,
    });
    const rows = await this.fetchVideoEvidenceRows();
    const scopedRows = rows === undefined ? [] : rows.filter((r) => r.item_id === itemId);
    if (scopedRows.length === 0) {
      if (this.videoEntryHint !== null) {
        this.videoEntryFocusConsumed = true;
        this.setData({ videoLookupFailed: true });
      }
      return;
    }
    const view = mapVideoEvidenceView(scopedRows, this.data.locationText);
    if (view === null) {
      if (this.videoEntryHint !== null) {
        this.videoEntryFocusConsumed = true;
        this.setData({ videoLookupFailed: true });
      }
      return;
    }
    const target = selectVideoPlaybackTarget(view.all, itemId, this.videoEntryHint);
    const selected = target.evidenceId === null
      ? null
      : view.all.find((v) => v.evidenceId === target.evidenceId) || null;
    if (selected === null) {
      if (this.videoEntryHint !== null) {
        this.videoEntryFocusConsumed = true;
        this.setData({ videoLookupFailed: true });
      }
      return;
    }
    const highlightKey = target.highlightKey || (selected.primaryHighlight === null ? "" : selected.primaryHighlight.key);
    this.setData({
      videoReady: true,
      videoEvidence: view,
      videoSelected: selected,
      videoSelectedHighlightKey: highlightKey,
      videoFoldText: videoFoldTextFor(selected, highlightKey),
      videoPlaybackNotice: videoFallbackNotice(target, view, selected),
      videoPlaybackError: "",
      videoOpen: false,
      videoSeekPending: false,
      videoInitialTime: 0,
      videoCurrentMs: 0,
      videoActiveBox: null,
      videoLookupFailed: false,
    });
    if (badgeEntry) this.videoEntryFocusConsumed = true;
    if (badgeEntry || reopenPaused) this.scrollVideoCard();
    if ((badgeEntry || reopenPaused) && target.mode !== "unavailable" && selected.playable) {
      setTimeout(() => {
        if (this.data.itemId === itemId) this.openVideoPaused(selected, highlightKey);
      }, 0);
    }
  },

  scrollVideoCard(): void {
    this.setData({ detailPanel: "media", mediaTab: "video", mediaScrollTarget: "video-evidence-card" });
    setTimeout(() => {
      if (typeof wx === "undefined" || typeof wx.pageScrollTo !== "function") return;
      try {
        wx.pageScrollTo({ selector: "#video-evidence-card", duration: 250 });
      } catch (e) {}
    }, 0);
  },

  seekVideoTo(seconds: number): void {
    if (typeof wx === "undefined" || typeof wx.createVideoContext !== "function") return;
    try {
      wx.createVideoContext("videoEvidencePlayer").seek(Math.max(0, seconds));
    } catch (e) {}
  },

  openVideoPaused(selectedOverride?: VideoEvidenceView | null, highlightKey?: string): void {
    const selected = selectedOverride === undefined ? this.data.videoSelected : selectedOverride;
    if (selected === null || selected.playable === false) return;
    const preferredKey = highlightKey === undefined ? this.data.videoSelectedHighlightKey : highlightKey;
    const highlight =
      selected.highlights.find((h) => h.key === preferredKey) ||
      defaultVideoHighlightView(selected.highlights);
    const startMs = highlight === null ? 0 : highlight.startMs;
    const initialTime = Math.max(0, (startMs - 300) / 1000);
    const key = highlight === null ? "" : highlight.key;
    this.setData({
      detailPanel: "media",
      mediaTab: "video",
      videoOpen: true,
      videoSelected: selected,
      videoSelectedHighlightKey: key,
      videoFoldText: videoFoldTextFor(selected, key),
      videoInitialTime: initialTime,
      videoSeekPending: true,
      videoCurrentMs: Math.round(initialTime * 1000),
      videoActiveBox: null,
      videoPlaybackError: "",
    });
  },

  onVideoLoadedMetadata(): void {
    if (this.data.videoSeekPending === false) return;
    const initial = this.data.videoInitialTime;
    this.setData({ videoSeekPending: false });
    this.seekVideoTo(initial);
  },

  onVideoTimeUpdate(e: WechatMiniprogram.CustomEvent<{ currentTime: number; duration: number }>): void {
    const selected = this.data.videoSelected;
    if (selected === null) return;
    const currentTime = e && e.detail && typeof e.detail.currentTime === "number" ? e.detail.currentTime : 0;
    const ms = Math.max(0, Math.round(currentTime * 1000));
    let activeBox: VideoHighlightBoxView | null = null;
    for (const highlight of selected.highlights) {
      if (ms >= highlight.startMs && ms < highlight.endMs) {
        activeBox = highlight.box;
        break;
      }
    }
    this.setData({ videoCurrentMs: ms, videoActiveBox: activeBox });
  },

  onVideoPlaybackError(): void {
    this.setData({
      videoPlaybackError: "视频加载失败,点按重试",
      videoActiveBox: null,
      videoSeekPending: false,
    });
  },

  refreshVideoPending(): void {
    const pending = loadPendingVideo(householdScopeId(), this.data.itemId);
    if (pending !== null && pending.itemId === this.data.itemId) {
      const expired = Date.parse(pending.expiresAt) <= Date.now();
      this.setData({
        videoPending: pending,
        videoPendingExpired: expired,
        videoPendingText: expired
          ? "视频上传凭据已过期,不能再关联。请删除待关联视频后重新拍摄。"
          : "视频已上传,但还没有确认关联到这件物品。可重试关联;不再需要时请删除待关联视频。",
      });
      return;
    }
    this.setData({ videoPending: null, videoPendingExpired: false, videoPendingText: "" });
  },

  onVideoToggle() {
    const selected = this.data.videoSelected;
    if (selected === null) return;
    if (selected.playable === false) {
      void this.refreshVideoEvidence(true);
      return;
    }
    if (this.data.videoOpen) {
      void cancelActiveVideoAi(this.data.itemId);
      this.setData({
        videoOpen: false,
        videoAiBusy: false,
        videoAiProgress: "",
        videoAiCandidates: [],
        videoAiError: "",
        videoAiNoHit: false,
        videoSeekPending: false,
        videoActiveBox: null,
        videoPlaybackError: "",
      });
      return;
    }
    this.openVideoPaused(selected, this.data.videoSelectedHighlightKey);
  },

  onVideoRetry() {
    this.setData({ videoPlaybackError: "", videoLookupFailed: false });
    void this.refreshVideoEvidence(true);
  },

  onVideoEvidenceSelect(e: WechatMiniprogram.CustomEvent<Record<string, unknown>>): void {
    if (this.data.videoAiBusy) {
      wx.showToast({ title: "请先结束 AI 识别", icon: "none" });
      return;
    }
    const collection = this.data.videoEvidence;
    if (collection === null) return;
    const evidenceId = e && e.currentTarget && e.currentTarget.dataset
      ? String(e.currentTarget.dataset.evidenceId || "")
      : "";
    const selected = collection.all.find((v) => v.evidenceId === evidenceId);
    if (selected === undefined) return;
    const highlight = defaultVideoHighlightView(selected.highlights);
    const key = highlight === null ? "" : highlight.key;
    const initialTime = highlight === null || selected.playable === false ? 0 : Math.max(0, (highlight.startMs - 300) / 1000);
    this.setData({
      videoSelected: selected,
      videoSelectedHighlightKey: key,
      videoFoldText: videoFoldTextFor(selected, key),
      videoPlaybackNotice: selected.playable ? "" : "这段视频暂时无法加载,点按重试。",
      videoPlaybackError: "",
      videoInitialTime: initialTime,
      videoSeekPending: selected.playable && this.data.videoOpen,
      videoCurrentMs: Math.round(initialTime * 1000),
      videoActiveBox: null,
    });
  },

  onVideoHighlightTap(e: WechatMiniprogram.CustomEvent<Record<string, unknown>>): void {
    const selected = this.data.videoSelected;
    if (selected === null) return;
    const key = e && e.currentTarget && e.currentTarget.dataset
      ? String(e.currentTarget.dataset.highlightKey || "")
      : "";
    const highlight = selected.highlights.find((h) => h.key === key);
    if (highlight === undefined) return;
    const initialTime = Math.max(0, (highlight.startMs - 300) / 1000);
    this.setData({
      videoSelectedHighlightKey: highlight.key,
      videoFoldText: videoFoldTextFor(selected, highlight.key),
      videoInitialTime: initialTime,
      videoSeekPending: false,
      videoCurrentMs: Math.round(initialTime * 1000),
      videoActiveBox: null,
    });
    this.seekVideoTo(initialTime);
  },

  onVideoMoreTap() {
    wx.showModal({
      title: "视频留证说明",
      content:
        "视频只作为这件物品的历史证据,说明拍摄当时东西在哪,不冒充当前位置。普通入口默认折叠;搜索角标进入会展开到暂停画面,但不会自动播放,你点播放器按钮后才开始。你确认过的片段也可能有偏差。",
      showCancel: false,
    });
  },

  async onVideoAiTap(): Promise<void> {
    if (this.data.videoAiBusy || this.data.videoBusy) return;
    const selected = this.data.videoSelected;
    if (selected === null) return;
    if (selected.urlFail || selected.videoUrl === "") {
      wx.showToast({ title: "视频暂时无法加载,请先重试", icon: "none" });
      return;
    }
    const entry = videoTargetEntryState();
    if (entry.available === false) {
      wx.showModal({ title: "AI 查找暂不可用", content: entry.message, showCancel: false });
      return;
    }
    if (selected.durationMs <= 0) {
      wx.showToast({ title: "视频时长未知,暂时无法定位", icon: "none" });
      return;
    }
    const consent = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "AI 找这件物品",
        content:
          "会从这段视频抽取最多 8 帧,在本机云端 AI 服务中判断物品是否出现。抽取帧不保存,识别候选需要你确认后才会保存为高亮;视频不会自动播放。继续吗?",
        confirmText: "开始识别",
        cancelText: "取消",
        success: (r) => resolve(r.confirm === true),
        fail: () => resolve(false),
      });
    });
    if (consent === false) return;

    await cancelActiveVideoAi(this.data.itemId);
    const itemId = this.data.itemId;
    const runToken = activeVideoAiRunToken + 1;
    activeVideoAiRunToken = runToken;
    let session: VideoFrameSession | null = null;
    this.setData({
      videoAiBusy: true,
      videoAiProgress: "正在抽帧…",
      videoAiCandidates: [],
      videoAiError: "",
      videoAiNoHit: false,
    });
    try {
      session = createVideoFrameSession(selected.videoUrl, { durationMs: selected.durationMs });
      activeVideoAiSession = session;
      activeVideoAiItemId = itemId;
      const result = await findVideoTargetCandidates({
        durationMs: selected.durationMs,
        targetName: this.data.name,
        session: session,
        callRecognize: (input) => callVideoTargetRecognize({
          action: "videoTargetRecognize",
          target_name: input.target_name,
          image_base64: input.image_base64,
          img_w: input.img_w,
          img_h: input.img_h,
        }),
        onProgress: (done, total) => {
          if (activeVideoAiRunToken !== runToken) return;
          this.setData({ videoAiProgress: "识别第 " + done + "/" + total + " 帧…" });
        },
      });
      if (activeVideoAiRunToken !== runToken || (this.data.itemId === itemId) === false) {
        await session.cancel();
        return;
      }
      if (result.candidates.length === 0) {
        await session.cancel();
        activeVideoAiSession = null;
        activeVideoAiItemId = "";
        this.setData({
          videoAiBusy: false,
          videoAiProgress: "",
          videoAiCandidates: [],
          videoAiNoHit: true,
        });
        return;
      }
      this.setData({
        videoAiBusy: false,
        videoAiProgress: "",
        videoAiCandidates: result.candidates.map(aiCandidateView),
      });
    } catch (e) {
      if (session !== null) await session.cancel();
      if (activeVideoAiRunToken !== runToken) return;
      activeVideoAiSession = null;
      activeVideoAiItemId = "";
      this.setData({
        videoAiBusy: false,
        videoAiProgress: "",
        videoAiCandidates: [],
        videoAiError: videoAiErrorText(e),
      });
    }
  },

  onVideoAiCandidateToggle(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.key : "";
    const idx = this.data.videoAiCandidates.findIndex((c) => c.key === key);
    if (idx < 0) return;
    const next = this.data.videoAiCandidates[idx].selected === false;
    this.setData({ ["videoAiCandidates[" + idx + "].selected"]: next });
  },

  async onVideoAiCancel(): Promise<void> {
    await cancelActiveVideoAi(this.data.itemId);
    this.setData({
      videoAiBusy: false,
      videoAiProgress: "",
      videoAiCandidates: [],
      videoAiError: "",
      videoAiNoHit: false,
    });
  },

  async onVideoAiSave(): Promise<void> {
    if (this.data.videoAiBusy) return;
    const selected = this.data.videoSelected;
    if (selected === null) return;
    const chosen = this.data.videoAiCandidates.filter((c) => c.selected === true);
    if (chosen.length === 0) {
      wx.showToast({ title: "请先选择要保存的高亮", icon: "none" });
      return;
    }
    const highlights: VideoEvidenceHighlightInput[] = chosen.map((c) => ({
      start_ms: c.windowStartMs,
      end_ms: c.windowEndMs,
      box: c.box,
      frame_ms: c.timeMs,
    }));
    this.setData({ videoAiBusy: true, videoAiError: "" });
    try {
      await ensureScopeVerified();
      await callItemsApi({
        action: "videoEvidenceHighlightSave",
        item_id: this.data.itemId,
        evidence_id: selected.evidenceId,
        expected_highlight_version: selected.highlightVersion,
        highlight_update_id: uuid(),
        highlights: highlights,
      });
      await cancelActiveVideoAi(this.data.itemId);
      this.setData({
        videoAiBusy: false,
        videoAiCandidates: [],
        videoAiProgress: "",
        videoAiNoHit: false,
      });
      await this.refreshVideoEvidence(true);
      wx.showToast({ title: "已保存高亮", icon: "success" });
    } catch (e) {
      this.setData({ videoAiBusy: false, videoAiError: errorMessage(e) });
    }
  },

  async onAddVideoTap() {
    if (this.data.videoBusy) return;
    if (this.data.videoAiBusy || this.data.videoAiCandidates.length > 0) {
      wx.showToast({ title: "请先结束 AI 识别", icon: "none" });
      return;
    }
    if (this.data.videoPending !== null) {
      wx.showModal({
        title: "先处理待关联视频",
        content: "这件物品已有一段上传后还没关联成功的视频。请先重试关联或删除待关联视频,再拍摄新视频。",
        showCancel: false,
      });
      return;
    }
    const itemId = this.data.itemId;
    if (itemId === "") return;
    try {
      await ensureScopeVerified();
    } catch (e) {
      wx.showToast({ title: "暂时无法确认当前家庭,请稍后重试", icon: "none" });
      return;
    }
    const consent = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "保存视频留证",
        content:
          "视频会保存为这件物品的历史证据,仅你和家人可通过云函数换临时链接回放;删除这件物品或手动删除视频时,原视频会一起删除。现在拍摄或选择视频?",
        confirmText: "继续",
        cancelText: "取消",
        success: (r) => resolve(r.confirm === true),
        fail: () => resolve(false),
      });
    });
    if (consent === false) return;
    this.setData({ videoBusy: true });
    const file = await chooseVideoFile();
    if (file === null) {
      this.setData({ videoBusy: false });
      return;
    }
    const scopeId = householdScopeId();
    const outcome = await attachVideoToItem({ itemId: itemId, scopeId: scopeId, file: file });
    if (outcome.ok) {
      this.setData({ videoBusy: false, videoPending: null, videoPendingText: "" });
      await this.refreshVideoEvidence();
      wx.showToast({ title: "视频已留证", icon: "success" });
      return;
    }
    this.setData({ videoBusy: false, videoPendingExpired: outcome.expired === true });
    this.refreshVideoPending();
    wx.showModal({
      title: outcome.expired === true ? "上传凭据已过期" : "视频还没关联成功",
      content: outcome.message,
      showCancel: false,
    });
  },

  async onVideoRetakeTap(): Promise<void> {
    await this.onAddVideoTap();
  },

  async onVideoDeleteTap() {
    if (this.data.videoEvidence === null || this.data.videoBusy) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "删除视频",
        content: "删除后这件物品的全部视频会从云存储一并删除,不能恢复。确定删除吗?",
        confirmText: "删除",
        confirmColor: "#d93025",
        cancelText: "取消",
        success: (r) => resolve(r.confirm === true),
        fail: () => resolve(false),
      });
    });
    if (confirmed === false) return;
    await cancelActiveVideoAi(this.data.itemId);
    this.setData({
      videoAiBusy: false,
      videoAiProgress: "",
      videoAiCandidates: [],
      videoAiError: "",
      videoAiNoHit: false,
      videoBusy: true,
    });
    try {
      await ensureScopeVerified();
      await callItemsApi({ action: "videoEvidenceDelete", item_id: this.data.itemId });
      this.setData({ videoBusy: false });
      await this.refreshVideoEvidence();
      wx.showToast({ title: "已删除视频", icon: "success" });
    } catch (e) {
      this.setData({ videoBusy: false });
      wx.showModal({ title: "删除失败", content: errorMessage(e), showCancel: false });
    }
  },

  async onVideoPendingRetryTap() {
    if (this.data.videoPending === null || this.data.videoBusy) return;
    if (this.data.videoPendingExpired) {
      wx.showModal({
        title: "上传凭据已过期",
        content: "请删除待关联视频后重新拍摄。继续重试不会成功。",
        showCancel: false,
      });
      return;
    }
    try {
      await ensureScopeVerified();
    } catch (e) {
      wx.showToast({ title: "暂时无法确认当前家庭,请稍后重试", icon: "none" });
      return;
    }
    this.setData({ videoBusy: true });
    const outcome = await retryPendingVideo(this.data.videoPending);
    this.setData({ videoBusy: false });
    if (outcome.ok) {
      this.setData({ videoPending: null, videoPendingExpired: false, videoPendingText: "" });
      await this.refreshVideoEvidence();
      wx.showToast({ title: "视频已关联", icon: "success" });
      return;
    }
    this.setData({ videoPendingExpired: outcome.expired === true });
    this.refreshVideoPending();
    wx.showModal({ title: outcome.expired === true ? "上传凭据已过期" : "还没关联成功", content: outcome.message, showCancel: false });
  },

  async onVideoPendingDiscardTap() {
    if (this.data.videoPending === null || this.data.videoBusy) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "删除待关联视频",
        content: "会删除已经上传但还没关联成功的原视频。确定删除吗?",
        confirmText: "删除",
        confirmColor: "#d93025",
        cancelText: "取消",
        success: (r) => resolve(r.confirm === true),
        fail: () => resolve(false),
      });
    });
    if (confirmed === false) return;
    this.setData({ videoBusy: true });
    const outcome = await discardPendingVideo(this.data.videoPending);
    this.setData({ videoBusy: false });
    if (outcome.ok === false) {
      wx.showModal({ title: "删除失败", content: outcome.message, showCancel: false });
      return;
    }
    this.setData({ videoPending: null, videoPendingExpired: false, videoPendingText: "" });
    if (outcome.state === "bound") {
      await this.refreshVideoEvidence();
      wx.showToast({ title: "视频已关联成功,未删除", icon: "none" });
      return;
    }
    wx.showToast({ title: "已删除待关联视频", icon: "success" });
  },

  noop() {},
});
