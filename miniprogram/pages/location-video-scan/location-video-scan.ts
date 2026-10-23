/**
 * D1 位置级视频清点页(issue #94,docs/design/video-ai/D1-IMPLEMENTATION.md §6.2/§6.3):
 * - 从某个具体位置进入(browse 模式非根层底部入口卡),位置上下文固定不可全局改;
 * - 复用 B 的可共享层(utils/video-scene 的扫描/草稿原语、utils/video-target 抽帧、
 *   utils/photo-vl 识别、utils/video-attach 选视频),页面状态机序列与 B 同名同义:
 *   idle → scanning → review → uploading → committing → partial/done/failed;
 * - 新物品默认归进入位置,可逐件改到当前子树内更细的位置(选择器只渲染子树节点,
 *   数据面禁出子树;服务端子树校验是第二道硬门);
 * - 已有物品五级匹配只提示不自动选中;点选后挂载在子树外才弹三选移动
 *   (只关联 / 移动到当前位置并关联 / 取消),绝不自动移动、绝不自动合并;
 * - mode=last 回看:视频播放器不自动播放 + 仍存活确认物品清单(可跳物品详情)。
 * 不复用/不改动 pages/video-scan(B 已冻结);R0 起线索卡区域经由共享
 * components/scene-group-card + utils/scene-groups 与 B 同一呈现/状态逻辑
 * (issue #101 契约 §5.3),两页互不引用。
 */
import { callItemsApi, errorMessage, uuid } from "../../utils/api";
import { videoExtOf, type PickedVideoFile } from "../../utils/video-attach";
import {
  createDraftsFromObservations,
  mergeSceneDrafts,
  newSceneDraft,
  scanSceneVideo,
  splitSceneDraft,
  type SceneObservation,
} from "../../utils/video-scene";
import {
  buildSceneGroupViews,
  claimGuard,
  confirmSingleSet,
  groupStats,
  type SceneGroupStats,
  type SceneGroupView,
} from "../../utils/scene-groups";
import { createVideoFrameSession, type VideoFrameSession } from "../../utils/video-target";
import { recognizeWithVl, type PhotoVlPrepared } from "../../utils/photo-vl";
import { ensureScopeVerified } from "../../utils/households-api";
import { householdScopeId } from "../../utils/household-scope";
import { buildItemMatchSuggestions, type ItemMatchSuggestion } from "../../utils/item-match";
import {
  buildLocationScanCommitItems,
  lastScanSummaryText,
  locationScanSessionKey,
  LOCATION_SCAN_SESSION_TTL_MS,
  subtreeOptionViews,
  type LocationScanDraft,
  type SubtreeOptionView,
} from "../../utils/location-scan";
import type {
  LocationScanContextNode,
  LocationScanPoolItem,
  VideoEvidenceHighlightInput,
  VideoSceneCommitItem,
  VideoUploadBeginResponse,
} from "../../types";
import type { Box } from "../../utils/photo-box";

type ScanPhase =
  | "idle"
  | "scanning"
  | "review"
  | "uploading"
  | "committing"
  | "partial"
  | "done"
  | "failed";

interface DraftView {
  draftKey: string;
  name: string;
  locationText: string;
  note: string;
  target: "new" | "existing";
  targetText: string;
  nodeId: string;
  nodeText: string;
  itemId: string;
  moveText: string;
  checked: boolean;
  mergeSelected: boolean;
  observationCount: number;
  highlightCount: number;
  isManual: boolean;
  startSecText: string;
  endSecText: string;
}

interface PendingUpload {
  sceneId: string;
  uploadTicket: string;
  uploadPath: string;
  assetId: string;
  fileId: string;
  receiptDone: boolean;
  expiresAt: string;
  durationMs: number;
  width: number;
  height: number;
  frozenItems: VideoSceneCommitItem[];
  location: { location_id: string; scan_id: string; path_snapshot: string[]; text_snapshot: string };
  candidateCount: number;
}

interface StoredScanSession {
  version: 1;
  createdAt: number;
  scopeId: string;
  nodeId: string;
  phase: ScanPhase;
  scanId: string;
  videoPath: string;
  durationMs: number;
  width: number;
  height: number;
  observations: SceneObservation[];
  drafts: LocationScanDraft[];
  pendingUpload: PendingUpload | null;
  frozenItems: VideoSceneCommitItem[];
}

interface MatchView extends ItemMatchSuggestion {
  levelText: string;
  whereText: string;
}

interface PageData {
  mode: "scan" | "last";
  phase: ScanPhase;
  nodeId: string;
  locationPathText: string;
  contextReady: boolean;
  contextErrorText: string;
  householdTruncated: boolean;
  subtreeOptions: SubtreeOptionView[];
  subtreeHasChildren: boolean;
  nodeSelectorFor: number;
  selectorVisible: boolean;
  matchPanelFor: number;
  matchPanelVisible: boolean;
  matchViews: MatchView[];
  scanId: string;
  videoPath: string;
  videoDurationMs: number;
  videoWidth: number;
  videoHeight: number;
  videoAspect: string;
  progressText: string;
  failureText: string;
  errorText: string;
  resultText: string;
  observations: SceneObservation[];
  drafts: LocationScanDraft[];
  mergeSelectedKeys: string[];
  observationGroups: SceneGroupView[];
  sceneStats: SceneGroupStats;
  draftViews: DraftView[];
  frozenItems: VideoSceneCommitItem[];
  pendingUpload: PendingUpload | null;
  busy: boolean;
  lastVideoUrl: string;
  lastSummaryText: string;
  lastItems: Array<{ item_id: string; name: string; location_text: string }>;
  lastLoaded: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && Array.isArray(v) === false;
}

function storageGet(key: string): unknown {
  try {
    return wx.getStorageSync(key);
  } catch (e) {
    return null;
  }
}

function storageSet(key: string, value: unknown): void {
  try {
    wx.setStorageSync(key, value);
  } catch (e) {
    // 本地保存失败不影响当前页面;base64/帧从 not 进 storage。
  }
}

function storageRemove(key: string): void {
  try {
    wx.removeStorageSync(key);
  } catch (e) {}
}

function normalizeHighlightInput(raw: VideoEvidenceHighlightInput): VideoEvidenceHighlightInput {
  const box: Box | null = raw.box === null ? null : {
    x1: raw.box.x1,
    y1: raw.box.y1,
    x2: raw.box.x2,
    y2: raw.box.y2,
  };
  const out: VideoEvidenceHighlightInput = { start_ms: raw.start_ms, end_ms: raw.end_ms, box };
  if (raw.frame_ms !== undefined) out.frame_ms = raw.frame_ms;
  return out;
}

function matchLevelText(level: 1 | 2 | 3 | 4): string {
  if (level === 1) return "同位置同名";
  if (level === 2) return "同位置相似";
  if (level === 3) return "家里同名";
  return "家里相似";
}

Page({
  data: {
    mode: "scan",
    phase: "idle" as ScanPhase,
    nodeId: "",
    locationPathText: "",
    contextReady: false,
    contextErrorText: "",
    householdTruncated: false,
    subtreeOptions: [] as SubtreeOptionView[],
    subtreeHasChildren: false,
    nodeSelectorFor: -1,
    selectorVisible: false,
    matchPanelFor: -1,
    matchPanelVisible: false,
    matchViews: [] as MatchView[],
    scanId: "",
    videoPath: "",
    videoDurationMs: 0,
    videoWidth: 0,
    videoHeight: 0,
    videoAspect: "16 / 9",
    progressText: "",
    failureText: "",
    errorText: "",
    resultText: "",
    observations: [] as SceneObservation[],
    drafts: [] as LocationScanDraft[],
    mergeSelectedKeys: [] as string[],
    observationGroups: [] as SceneGroupView[],
    sceneStats: groupStats([], []) as SceneGroupStats,
    draftViews: [] as DraftView[],
    frozenItems: [] as VideoSceneCommitItem[],
    pendingUpload: null as PendingUpload | null,
    busy: false,
    lastVideoUrl: "",
    lastSummaryText: "",
    lastItems: [] as Array<{ item_id: string; name: string; location_text: string }>,
    lastLoaded: false,
  },

  // 匹配池与路径表(onLoad 拉一次,内存持有;AI 候选/帧不入 storage)
  poolSubtree: [] as LocationScanContextNode[],
  poolSubtreeItems: [] as LocationScanPoolItem[],
  poolHouseholdItems: [] as LocationScanPoolItem[],
  pathsByNodeId: {} as Record<string, string[]>,
  scanSession: undefined as VideoFrameSession | undefined,
  scanEpoch: 0,

  onLoad(options: Record<string, string | undefined>) {
    const mode = options.mode === "last" ? "last" : "scan";
    let nodeId = "";
    try {
      nodeId = options.node_id ? decodeURIComponent(options.node_id) : "";
    } catch (e) {
      nodeId = options.node_id || "";
    }
    this.setData({ mode, nodeId });
    if (mode === "last") {
      void this.loadLastScan();
      return;
    }
    void this.loadContext();
    this.restoreSession(nodeId);
  },

  onHide() {
    if (this.scanSession !== undefined) {
      void this.scanSession.cancel();
      this.scanSession = undefined;
    }
    if (this.data.phase === "scanning") {
      this.setData({ phase: "review" });
    }
    if (this.data.observations.length > 0 || this.data.drafts.length > 0 || this.data.pendingUpload !== null) {
      this.saveSession();
    }
  },

  onUnload() {
    this.onHide();
  },

  sessionKey(): string {
    return locationScanSessionKey(householdScopeId() || "default", this.data.nodeId);
  },

  saveSession() {
    if (this.data.observations.length === 0 && this.data.drafts.length === 0 && this.data.pendingUpload === null) return;
    const session: StoredScanSession = {
      version: 1,
      createdAt: Date.now(),
      scopeId: householdScopeId(),
      nodeId: this.data.nodeId,
      phase: this.data.phase,
      scanId: this.data.scanId,
      videoPath: this.data.videoPath,
      durationMs: this.data.videoDurationMs,
      width: this.data.videoWidth,
      height: this.data.videoHeight,
      observations: this.data.observations,
      drafts: this.data.drafts,
      pendingUpload: this.data.pendingUpload,
      frozenItems: this.data.frozenItems,
    };
    storageSet(this.sessionKey(), session);
  },

  clearSession() {
    storageRemove(this.sessionKey());
  },

  /** 24h TTL + scope + node_id 三重匹配才恢复;位置不同/过期一律丢弃重拍 */
  restoreSession(nodeId: string) {
    const raw = storageGet(this.sessionKey());
    if (isRecord(raw) === false || raw.version !== 1) return;
    if (typeof raw.createdAt !== "number" || Date.now() - raw.createdAt > LOCATION_SCAN_SESSION_TTL_MS) return;
    if (typeof raw.scopeId !== "string" || raw.scopeId !== householdScopeId()) return;
    if (typeof raw.nodeId !== "string" || raw.nodeId !== nodeId) return;
    if (typeof raw.videoPath !== "string" || typeof raw.durationMs !== "number") return;
    if (Array.isArray(raw.observations) === false || Array.isArray(raw.drafts) === false) return;
    const pending = isRecord(raw.pendingUpload) && typeof raw.pendingUpload.fileId === "string"
      ? raw.pendingUpload as unknown as PendingUpload
      : null;
    const phase: ScanPhase = pending !== null ? "partial" : "review";
    this.setData({
      phase,
      scanId: typeof raw.scanId === "string" ? raw.scanId : "",
      videoPath: raw.videoPath,
      videoDurationMs: raw.durationMs,
      videoWidth: typeof raw.width === "number" ? raw.width : 0,
      videoHeight: typeof raw.height === "number" ? raw.height : 0,
      videoAspect: (typeof raw.width === "number" && raw.width > 0 && typeof raw.height === "number" && raw.height > 0)
        ? raw.width + " / " + raw.height : "16 / 9",
      observations: raw.observations as unknown as SceneObservation[],
      drafts: raw.drafts as unknown as LocationScanDraft[],
      frozenItems: Array.isArray(raw.frozenItems) ? raw.frozenItems as unknown as VideoSceneCommitItem[] : [],
      pendingUpload: pending,
      resultText: phase === "partial" && pending !== null
        ? (pending.fileId !== "" ? "上次视频已上传,可重试完成剩余关联" : "上次视频上传未完成,请放弃待关联票据后重新确认")
        : "",
    }, () => {
      this.renderObservations();
      this.renderDrafts();
    });
  },

  /** 位置上下文:固定头卡 + 子位置选择器 + 五级匹配池(唯一数据源) */
  async loadContext() {
    if (this.data.nodeId === "") {
      this.setData({ contextErrorText: "缺少位置参数,请从位置页重新进入" });
      return;
    }
    this.setData({ contextErrorText: "" });
    try {
      const res = await callItemsApi({ action: "locationScanContext", location_id: this.data.nodeId });
      this.poolSubtree = res.subtree;
      this.poolSubtreeItems = res.subtree_items;
      this.poolHouseholdItems = res.household_items;
      const paths: Record<string, string[]> = {};
      for (const node of res.subtree) paths[node.location_id] = node.path;
      this.pathsByNodeId = paths;
      const self = paths[this.data.nodeId];
      this.setData({
        contextReady: true,
        contextErrorText: "",
        locationPathText: self !== undefined ? self.join(" / ") : "",
        subtreeOptions: subtreeOptionViews(res.subtree, this.data.nodeId),
        subtreeHasChildren: res.subtree.length > 1,
        householdTruncated: res.household_truncated === true,
      });
      wx.setNavigationBarTitle({ title: "清点:" + (self !== undefined && self.length > 0 ? self[self.length - 1] : "位置"), fail: () => {} });
    } catch (e) {
      this.setData({ contextReady: false, contextErrorText: errorMessage(e) });
    }
  },

  /** mode=last 回看:最新 active scan 的临时链接(不自动播放)+ 仍存活确认物品 */
  async loadLastScan() {
    try {
      const res = await callItemsApi({ action: "locationScanLatest", location_id: this.data.nodeId });
      if (res.scan === null) {
        this.setData({ lastLoaded: true, lastSummaryText: "这里还没有清点记录" });
        return;
      }
      this.setData({
        lastLoaded: true,
        lastVideoUrl: res.video_url,
        lastSummaryText: lastScanSummaryText(res.scan.created_at, res.scan.confirmed_count, res.items.length)
          + (res.video_url === "" ? ";视频已随物品证据删除" : ""),
        lastItems: res.items,
      });
    } catch (e) {
      this.setData({ lastLoaded: true, lastSummaryText: "读取清点记录失败:" + errorMessage(e) });
    }
  },

  /** R0(§5.2):组视图与统计全部由 observations+drafts 推导,与 B 页同一 helper */
  renderObservations() {
    this.setData({
      observationGroups: buildSceneGroupViews(this.data.observations, this.data.drafts),
      sceneStats: groupStats(this.data.observations, this.data.drafts),
    });
  },

  renderDrafts() {
    const views = this.data.drafts.map((d) => {
      const highlights = d.observationIds.length + d.manualHighlights.length;
      const first = d.manualHighlights.length > 0 ? d.manualHighlights[0] : null;
      let targetText = "新建物品";
      if (d.target === "existing") {
        targetText = "关联已有物品:" + (d.itemId || "未选择");
      }
      return {
        draftKey: d.draftKey,
        name: d.name,
        locationText: d.locationText,
        note: d.note,
        target: d.target,
        targetText,
        nodeId: d.nodeId !== undefined ? d.nodeId : "",
        nodeText: d.target === "new"
          ? (d.nodeId !== undefined && d.nodeId !== this.data.nodeId && this.pathsByNodeId[d.nodeId] !== undefined
            ? this.pathsByNodeId[d.nodeId].join(" / ")
            : "默认归这里")
          : "",
        itemId: d.itemId,
        moveText: d.moveToNodeId !== undefined ? "将移动到当前位置并关联" : "",
        checked: d.checked,
        mergeSelected: this.data.mergeSelectedKeys.indexOf(d.draftKey) !== -1,
        observationCount: d.observationIds.length,
        highlightCount: highlights,
        isManual: d.observationIds.length === 0 && d.manualHighlights.length > 0,
        startSecText: first === null ? "" : (first.start_ms / 1000).toFixed(1),
        endSecText: first === null ? "" : (first.end_ms / 1000).toFixed(1),
      };
    });
    this.setData({ draftViews: views });
  },

  async onChooseVideoTap() {
    if (this.data.busy || this.data.contextReady === false) return;
    const consent = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "拍一段这个位置的视频",
        content:
          "归入:" + (this.data.locationPathText || "当前位置") + "。原视频在你最终确认前不会上传云存储;识别时会把少量静帧临时发到云端 AI,不保存识别结果。确认后才会保存原视频和每件物品的高亮。视频只作历史证据,不冒充当前位置,也不会自动播放。",
        confirmText: "继续",
        cancelText: "取消",
        success: (r) => resolve(r.confirm === true),
        fail: () => resolve(false),
      });
    });
    if (consent === false) return;
    const file = await new Promise<PickedVideoFile | null>((resolve) => {
      wx.chooseMedia({
        count: 1,
        mediaType: ["video"],
        sourceType: ["camera", "album"],
        maxDuration: 30,
        camera: "back",
        success: (res) => {
          const f = res.tempFiles && res.tempFiles[0];
          if (f === undefined || typeof f.tempFilePath !== "string" || f.tempFilePath === "") {
            resolve(null);
            return;
          }
          resolve({
            path: f.tempFilePath,
            durationMs: Math.max(1, Math.round((f.duration || 0) * 1000)),
            width: Math.max(1, Math.round(f.width || 0)),
            height: Math.max(1, Math.round(f.height || 0)),
            size: f.size || 0,
          });
        },
        fail: () => resolve(null),
      });
    });
    if (file === null) return;
    await this.startScan(file);
  },

  async startScan(file: PickedVideoFile) {
    const scanId = uuid();
    const epoch = this.scanEpoch + 1;
    this.scanEpoch = epoch;
    let session: VideoFrameSession;
    try {
      session = createVideoFrameSession({ path: file.path, durationMs: file.durationMs }, { durationMs: file.durationMs });
    } catch (e) {
      this.setData({ phase: "failed", busy: false, errorText: "当前设备暂不支持视频抽帧,可改用拍照识物或手动添加。" });
      return;
    }
    this.scanSession = session;
    this.setData({
      phase: "scanning",
      scanId,
      videoPath: file.path,
      videoDurationMs: file.durationMs,
      videoWidth: file.width,
      videoHeight: file.height,
      videoAspect: file.width > 0 && file.height > 0 ? file.width + " / " + file.height : "16 / 9",
      observations: [],
      drafts: [],
      mergeSelectedKeys: [],
      frozenItems: [],
      pendingUpload: null,
      errorText: "",
      failureText: "",
      resultText: "",
      progressText: "正在抽取第 1/8 帧…",
      busy: true,
    });
    this.renderObservations();
    this.renderDrafts();

    const outcome = await scanSceneVideo({
      source: { path: file.path, durationMs: file.durationMs },
      durationMs: file.durationMs,
      session,
      callRecognize: async (input) => {
        const prepared: PhotoVlPrepared = {
          ok: true,
          path: "",
          imgW: input.img_w,
          imgH: input.img_h,
          base64: input.image_base64,
          compressed: true,
        };
        const result = await recognizeWithVl(prepared);
        if (result.ok === true) {
          return { ok: true, items: result.items, truncated: result.truncated };
        }
        return { ok: false, error: result.kind, message: result.message };
      },
      onProgress: (done, total, failures) => {
        if (this.scanEpoch !== epoch) return;
        this.setData({
          progressText: "已分析 " + done + "/" + total + " 帧" + (failures > 0 ? "," + failures + " 帧失败" : ""),
        });
      },
    });

    if (this.scanEpoch !== epoch) return;
    if (outcome.ok === false) {
      if (outcome.kind === "cancelled") {
        this.setData({ phase: "idle", busy: false, progressText: "" });
        return;
      }
      this.setData({
        phase: outcome.observations.length > 0 ? "review" : "failed",
        busy: false,
        observations: outcome.observations,
        errorText: outcome.message,
      });
      this.renderObservations();
      this.saveSession();
      return;
    }
    const failureText = outcome.failures.length > 0
      ? "已分析 " + outcome.framesScanned + "/" + outcome.framesTotal + " 帧," + outcome.failures.length + " 帧失败;结果可能漏件,可手动补件。"
      : "";
    this.setData({
      phase: "review",
      busy: false,
      observations: outcome.observations,
      failureText,
      resultText: outcome.observations.length === 0
        ? "AI 暂未给出物品线索,可手动补一件;原视频仍只在最终确认后上传。"
        : "已发现 " + outcome.observations.length + " 条线索;同名线索只是提示,不会被自动合并。",
      progressText: "",
    });
    this.renderObservations();
    this.renderDrafts();
    this.saveSession();
    if (outcome.manualFallback) {
      wx.showToast({ title: "未识别到线索,可手动补件", icon: "none" });
    }
  },

  async cancelScan() {
    this.scanEpoch = this.scanEpoch + 1;
    const session = this.scanSession;
    if (session !== undefined) await session.cancel();
    this.scanSession = undefined;
  },

  async onCancelScanTap() {
    await this.cancelScan();
    this.setData({ phase: "idle", busy: false, observations: [], drafts: [], progressText: "", errorText: "" });
    this.clearSession();
  },

  onContextRetryTap() {
    void this.loadContext();
  },

  /** 行勾选是组卡内交互态(组件持有,§5.2);页面侧只保留接线,无全局跨组选择 */
  onObservationToggle() {},

  /** 点缩略图放大预览(组件事件 e.detail.obsId):current=该观察帧,urls=组内全部 framePath */
  onObsImageTap(e: WechatMiniprogram.CustomEvent) {
    const obsId = String((e.detail && e.detail.obsId) || "");
    if (obsId === "") return;
    const group = this.data.observationGroups.find((g) => g.observations.some((o) => o.obsId === obsId));
    const urls = (group ? group.observations : this.data.observations)
      .map((o) => o.framePath)
      .filter((p) => typeof p === "string" && p !== "");
    const current = this.data.observations.find((o) => o.obsId === obsId);
    if (current && current.framePath) {
      wx.previewImage({ current: current.framePath, urls: urls.length > 0 ? urls : [current.framePath] });
    }
  },

  /* ---------------- R0 三动作(§2):就 1 件 / 有多件或需拆开 / 暂不确定 ---------------- */

  /** 就 1 件:生成聚合草稿的唯一入口;位置=进入位置路径文本并补 nodeId;同帧风险组先过 §2.1 二次确认 */
  async onGroupConfirmSingle(e: WechatMiniprogram.CustomEvent) {
    if (this.data.busy || this.data.phase !== "review") return;
    const detail = e.detail || {};
    const nameKey = String(detail.nameKey || "");
    const group = this.data.observationGroups.find((g) => g.nameKey === nameKey);
    if (group === undefined) return;
    const obsIds = Array.isArray(detail.obsIds) ? detail.obsIds as string[] : null;
    const confirmSet = confirmSingleSet(group, obsIds);
    if (confirmSet.length === 0) return;
    if (group.sameFrameRisk) {
      const sure = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: "可能有多件",
          content:
            "这一组在第 " + group.repFrame.timeText + " 的同一帧里出现了两条同名线索,可能是两件同名物品。确定只有 1 件吗?",
          confirmText: "就1件",
          cancelText: "再看看",
          success: (r) => resolve(r.confirm === true),
          fail: () => resolve(false),
        });
      });
      if (sure === false) return;
    }
    const base = newSceneDraft({
      observationIds: confirmSet,
      name: group.label,
      locationText: this.data.locationPathText,
      checked: true,
    });
    const draft = { ...base, nodeId: this.data.nodeId } as LocationScanDraft;
    this.setData({ drafts: this.data.drafts.concat([draft]) }, () => {
      this.renderObservations();
      this.renderDrafts();
      this.saveSession();
    });
  },

  /** 有多件或需拆开:组卡切逐条模式(组件展开),零数据变更(§2.2) */
  onGroupConfirmMulti() {},

  /** 暂不确定:组卡折叠,零数据变更(§2.3);组保留在待确认列表与统计里 */
  onGroupDefer() {},

  /** 逐条生成(组内作用域,§7):先过 §2.4 归属门,再一条一草稿;新草稿带 nodeId=进入位置 */
  onGenerateDraftsTap(e: WechatMiniprogram.CustomEvent) {
    if (this.data.busy || this.data.phase !== "review") return;
    const detail = e.detail || {};
    const obsIds = Array.isArray(detail.obsIds) ? detail.obsIds as string[] : [];
    if (obsIds.length === 0) {
      wx.showToast({ title: "先勾选至少一条线索", icon: "none" });
      return;
    }
    const conflict = claimGuard(this.data.observations, this.data.drafts, obsIds);
    if (conflict !== null) {
      const index = this.data.observations.findIndex((o) => o.obsId === conflict.obsId);
      wx.showToast({
        title: "第 " + (index + 1) + " 条线索已用于「" + conflict.draftName + "」,先移除该草稿或拆分后再操作",
        icon: "none",
      });
      return;
    }
    const base = createDraftsFromObservations(this.data.observations, obsIds, {
      mergeSameName: false,
      batchLocation: this.data.locationPathText,
    });
    const drafts = base.map((d) => ({ ...d, nodeId: this.data.nodeId }) as LocationScanDraft);
    this.setData({ drafts: this.data.drafts.concat(drafts) }, () => {
      this.renderObservations();
      this.renderDrafts();
      this.saveSession();
    });
  },

  onDraftCheckedTap(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const drafts = this.data.drafts.slice();
    drafts[index] = { ...drafts[index], checked: drafts[index].checked === false };
    this.setData({ drafts }, () => {
      this.renderObservations();
      this.renderDrafts();
    });
  },

  onDraftMergeSelectTap(e: WechatMiniprogram.CustomEvent) {
    const key = String(e.currentTarget.dataset.key || "");
    if (key === "") return;
    const keys = this.data.mergeSelectedKeys.slice();
    const index = keys.indexOf(key);
    if (index === -1) keys.push(key);
    else keys.splice(index, 1);
    this.setData({ mergeSelectedKeys: keys }, () => this.renderDrafts());
  },

  onDraftNameInput(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const value = isRecord(e.detail) && typeof e.detail.value === "string" ? e.detail.value : "";
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const drafts = this.data.drafts.slice();
    drafts[index] = { ...drafts[index], name: value };
    this.setData({ drafts }, () => {
      this.renderObservations();
      this.renderDrafts();
    });
  },

  onDraftNoteInput(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const value = isRecord(e.detail) && typeof e.detail.value === "string" ? e.detail.value : "";
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const drafts = this.data.drafts.slice();
    drafts[index] = { ...drafts[index], note: value };
    this.setData({ drafts }, () => this.renderDrafts());
  },

  onDraftManualTimeInput(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const field = String(e.currentTarget.dataset.field || "");
    const raw = isRecord(e.detail) && typeof e.detail.value === "string" ? Number(e.detail.value) : NaN;
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    if (Number.isFinite(raw) === false || raw < 0) return;
    const draft = this.data.drafts[index];
    if (draft.manualHighlights.length === 0) return;
    const current = normalizeHighlightInput(draft.manualHighlights[0]);
    let start = current.start_ms;
    let end = current.end_ms;
    if (field === "start") start = Math.round(raw * 1000);
    else if (field === "end") end = Math.round(raw * 1000);
    else return;
    const duration = Math.max(1, this.data.videoDurationMs);
    start = Math.max(0, Math.min(duration - 1, start));
    end = Math.max(start + 1, Math.min(duration, end));
    const highlight: VideoEvidenceHighlightInput = {
      start_ms: start,
      end_ms: end,
      box: current.box,
      frame_ms: start,
    };
    const drafts = this.data.drafts.slice();
    drafts[index] = { ...draft, manualHighlights: [highlight] };
    this.setData({ drafts }, () => this.renderDrafts());
  },

  onDraftRemoveTap(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const removed = this.data.drafts[index];
    const drafts = this.data.drafts.filter((_, i) => i !== index);
    const keys = this.data.mergeSelectedKeys.filter((k) => k !== removed.draftKey);
    this.setData({ drafts, mergeSelectedKeys: keys }, () => {
      this.renderObservations();
      this.renderDrafts();
      this.saveSession();
    });
  },

  onDraftSplitTap(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const draft = this.data.drafts[index];
    const split = splitSceneDraft(draft);
    if (split.length <= 1 && split[0] === draft) {
      wx.showToast({ title: "这件只有一条高亮,无需拆分", icon: "none" });
      return;
    }
    const drafts = this.data.drafts.slice();
    drafts.splice(index, 1, ...(split.map((d) => ({ ...d, nodeId: draft.nodeId }) as LocationScanDraft)));
    this.setData({ drafts }, () => {
      this.renderObservations();
      this.renderDrafts();
      this.saveSession();
      wx.showToast({ title: "已拆成 " + split.length + " 件", icon: "none" });
    });
  },

  onMergeDraftsTap() {
    const merged = mergeSceneDrafts(this.data.drafts, this.data.mergeSelectedKeys);
    if (merged === null) {
      wx.showToast({ title: "请选择至少两件新建物品草稿", icon: "none" });
      return;
    }
    const keys = new Set(this.data.mergeSelectedKeys);
    const firstIndex = this.data.drafts.findIndex((d) => keys.has(d.draftKey));
    const drafts = this.data.drafts.filter((d) => keys.has(d.draftKey) === false);
    drafts.splice(Math.max(0, firstIndex), 0, merged as LocationScanDraft);
    this.setData({ drafts, mergeSelectedKeys: [] }, () => {
      this.renderObservations();
      this.renderDrafts();
      this.saveSession();
    });
  },

  onAddManualDraftTap() {
    const duration = Math.max(1, this.data.videoDurationMs);
    const end = Math.min(duration, 1500);
    const draft = newSceneDraft({
      locationText: this.data.locationPathText,
      manualHighlights: [{
        start_ms: 0,
        end_ms: end > 0 ? end : duration,
        box: null,
        frame_ms: 0,
      }],
      checked: true,
    });
    this.setData({ drafts: this.data.drafts.concat([{ ...draft, nodeId: this.data.nodeId } as LocationScanDraft]) }, () => {
      this.renderObservations();
      this.renderDrafts();
      this.saveSession();
    });
  },

  /* ---------------- 逐件子位置选择(§6.3:只渲染子树节点,禁出子树) ---------------- */

  onDraftNodeTap(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    if (this.data.drafts[index].target !== "new") return;
    if (this.data.subtreeHasChildren === false) {
      wx.showToast({ title: "这里没有更细的位置,统一归这一层", icon: "none" });
      return;
    }
    this.setData({ selectorVisible: true, nodeSelectorFor: index });
  },

  onSelectorCloseTap() {
    this.setData({ selectorVisible: false, nodeSelectorFor: -1 });
  },

  onNodeOptionTap(e: WechatMiniprogram.CustomEvent) {
    const index = this.data.nodeSelectorFor;
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const nodeId = String(e.currentTarget.dataset.nodeId || "");
    const path = this.pathsByNodeId[nodeId];
    if (path === undefined) return; // 数据面只含子树节点;防御性兜底
    const drafts = this.data.drafts.slice();
    drafts[index] = { ...drafts[index], nodeId, locationText: path.join(" / ") };
    this.setData({ drafts, selectorVisible: false, nodeSelectorFor: -1 }, () => {
      this.renderDrafts();
      this.saveSession();
    });
  },

  /* ---------------- 五级匹配建议(§3:只提示,点选才切 existing) ---------------- */

  onDraftMatchTap(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const draft = this.data.drafts[index];
    const suggestions = buildItemMatchSuggestions(draft.name, {
      subtree: this.poolSubtree,
      subtree_items: this.poolSubtreeItems,
      household_items: this.poolHouseholdItems,
    });
    if (suggestions.length === 0) {
      wx.showToast({ title: "没有相近的已有物品,将按新建处理", icon: "none" });
      return;
    }
    this.setData({
      matchPanelVisible: true,
      matchPanelFor: index,
      matchViews: suggestions.map((s) => ({
        ...s,
        levelText: matchLevelText(s.level),
        whereText: s.location_fallback ? s.location_display + "(不在当前范围内)" : s.location_display,
      })),
    });
  },

  onMatchPanelCloseTap() {
    this.setData({ matchPanelVisible: false, matchPanelFor: -1, matchViews: [] });
  },

  async onSuggestionTap(e: WechatMiniprogram.CustomEvent) {
    const index = this.data.matchPanelFor;
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const pickIndex = Number(e.currentTarget.dataset.index);
    const suggestion = this.data.matchViews[pickIndex];
    if (suggestion === undefined) return;
    const applyExisting = (moveToNodeId?: string, expectedVersion?: number) => {
      const drafts = this.data.drafts.slice();
      drafts[index] = {
        ...drafts[index],
        target: "existing",
        itemId: suggestion.item_id,
        name: suggestion.name,
        nodeId: undefined,
        moveToNodeId,
        expectedVersion,
      };
      this.setData({ drafts, matchPanelVisible: false, matchPanelFor: -1, matchViews: [] }, () => {
        this.renderObservations();
        this.renderDrafts();
        this.saveSession();
      });
    };
    if (suggestion.mounted_in_subtree) {
      // 挂载已在当前子树内:只关联视频证据,绝不改位置(§4)
      wx.showToast({ title: "已在当前位置范围内,只补视频证据", icon: "none" });
      applyExisting();
      return;
    }
    // 挂载在子树外:三选弹窗,移动必须用户显式选择;取消 = 保持新建
    const choice = await new Promise<number | null>((resolve) => {
      wx.showActionSheet({
        itemList: ["只关联,保留原位置", "移动到当前位置并关联"],
        itemColor: "#1a1a1a",
        success: (r) => resolve(r.tapIndex),
        fail: () => resolve(null),
      });
    });
    if (choice === null || choice === undefined) return;
    if (choice === 0) {
      applyExisting();
      return;
    }
    applyExisting(this.data.nodeId, suggestion.version);
  },

  onDraftTargetResetTap(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const drafts = this.data.drafts.slice();
    drafts[index] = {
      ...drafts[index],
      target: "new",
      itemId: "",
      moveToNodeId: undefined,
      expectedVersion: undefined,
      nodeId: this.data.nodeId,
      locationText: this.data.locationPathText,
    };
    this.setData({ drafts }, () => this.renderDrafts());
  },

  onRestartTap() {
    wx.showModal({
      title: "重新拍摄",
      content: "当前候选和草稿会清空;原视频在确认前未上传。确定重来吗?",
      confirmText: "重来",
      success: (r) => {
        if (r.confirm !== true) return;
        void this.cancelScan();
        this.clearSession();
        this.setData({
          phase: "idle",
          scanId: "",
          videoPath: "",
          videoDurationMs: 0,
          videoWidth: 0,
          videoHeight: 0,
          progressText: "",
          failureText: "",
          errorText: "",
          resultText: "",
          observations: [],
          drafts: [],
          mergeSelectedKeys: [],
          frozenItems: [],
          pendingUpload: null,
          busy: false,
        }, () => {
          this.renderObservations();
          this.renderDrafts();
        });
      },
    });
  },

  async onSaveTap() {
    if (this.data.busy) return;
    const built = buildLocationScanCommitItems(
      this.data.drafts,
      this.data.observations,
      this.data.videoDurationMs,
      { locationId: this.data.nodeId, pathsByNodeId: this.pathsByNodeId },
      this.data.scanId,
    );
    if (built.ok === false) {
      wx.showModal({ title: "还不能保存", content: built.message, showCancel: false });
      return;
    }
    try {
      await ensureScopeVerified();
    } catch (e) {
      wx.showToast({ title: "暂时无法确认当前家庭,请稍后重试", icon: "none" });
      return;
    }
    this.setData({ phase: "uploading", busy: true, errorText: "", resultText: "", frozenItems: built.items }, () => {
      void this.startUpload(built.items, built.location, built.candidateCount);
    });
  },

  async localVideoAvailable(): Promise<boolean> {
    const path = this.data.videoPath;
    if (path === "") return false;
    if (typeof wx.getFileSystemManager !== "function") return true;
    const fs = wx.getFileSystemManager();
    if (typeof fs.access !== "function") return true;
    return new Promise((resolve) => {
      fs.access({
        path,
        success: () => resolve(true),
        fail: () => resolve(false),
      });
    });
  },

  /** 上传/提交序列与 B 的 video-scan.ts 同一次序;增量只多 location/candidate_count */
  async startUpload(
    frozenItems: VideoSceneCommitItem[],
    location: { location_id: string; scan_id: string; path_snapshot: string[]; text_snapshot: string },
    candidateCount: number,
  ) {
    if (this.data.videoPath === "" || this.data.scanId === "") {
      this.setData({ phase: "review", busy: false, errorText: "本地视频已失效,请重拍" });
      return;
    }
    const available = await this.localVideoAvailable();
    if (available === false) {
      this.setData({ phase: "review", busy: false, errorText: "本地视频临时文件已失效,请重拍;本次没有上传任何文件。" });
      return;
    }
    let begin: VideoUploadBeginResponse | null = null;
    try {
      begin = await callItemsApi({
        action: "videoUploadBegin",
        purpose: "scene",
        scene_id: this.data.scanId,
        ext: videoExtOf(this.data.videoPath),
        duration_ms: this.data.videoDurationMs,
        video_w: this.data.videoWidth,
        video_h: this.data.videoHeight,
      });
    } catch (e) {
      this.setData({ phase: "review", busy: false, errorText: errorMessage(e) });
      return;
    }
    if (begin === null || begin.upload_ticket === undefined || typeof begin.upload_path !== "string" || typeof begin.asset_id !== "string") {
      this.setData({ phase: "review", busy: false, errorText: "服务返回异常,请稍后重试" });
      return;
    }
    const basePending: PendingUpload = {
      sceneId: this.data.scanId,
      uploadTicket: begin.upload_ticket,
      uploadPath: begin.upload_path,
      assetId: begin.asset_id,
      fileId: "",
      receiptDone: false,
      expiresAt: begin.expires_at,
      durationMs: this.data.videoDurationMs,
      width: this.data.videoWidth,
      height: this.data.videoHeight,
      frozenItems,
      location,
      candidateCount,
    };
    this.setData({ pendingUpload: basePending }, () => this.saveSession());

    let fileId = "";
    try {
      const uploaded = await new Promise<{ fileID: string }>((resolve, reject) => {
        wx.cloud.uploadFile({
          cloudPath: begin.upload_path,
          filePath: this.data.videoPath,
          success: (res) => resolve({ fileID: res.fileID }),
          fail: (err) => reject(new Error((err && err.errMsg) || "uploadFile:fail")),
        });
      });
      fileId = uploaded.fileID;
    } catch (e) {
      try {
        await callItemsApi({ action: "videoUploadCancel", upload_ticket: begin.upload_ticket });
      } catch (e2) {}
      this.setData({ phase: "review", busy: false, pendingUpload: null, errorText: "视频上传失败,请检查网络后重试" }, () => this.saveSession());
      wx.showModal({ title: "上传失败", content: "原视频没有上传成功,本次未写入任何物品证据。", showCancel: false });
      return;
    }

    const pending: PendingUpload = { ...basePending, fileId };
    this.setData({ pendingUpload: pending, phase: "committing", busy: true }, () => this.saveSession());
    try {
      await callItemsApi({ action: "videoUploadReceipt", upload_ticket: pending.uploadTicket, file_id: fileId });
      const withReceipt: PendingUpload = { ...pending, receiptDone: true };
      this.setData({ pendingUpload: withReceipt }, () => this.saveSession());
      await this.commitFrozenUpload(withReceipt);
    } catch (e) {
      const still = this.data.pendingUpload || pending;
      this.setData({
        phase: "partial",
        busy: false,
        errorText: errorMessage(e),
        resultText: "视频已上传,但还没有完成证据关联。可重试;不会自动重复创建物品。",
        pendingUpload: still,
      }, () => this.saveSession());
    }
  },

  async commitFrozenUpload(pending: PendingUpload) {
    this.setData({ phase: "committing", busy: true, errorText: "" });
    try {
      const res = await callItemsApi({
        action: "videoSceneCommit",
        scene_id: pending.sceneId,
        upload_ticket: pending.uploadTicket,
        asset_id: pending.assetId,
        file_id: pending.fileId,
        duration_ms: pending.durationMs,
        video_w: pending.width,
        video_h: pending.height,
        consent_version: "v1",
        items: pending.frozenItems,
        location: pending.location,
        candidate_count: pending.candidateCount,
      });
      const failed = res.evidence_failed ? res.evidence_failed.length : 0;
      const successCount = res.results.filter((r) => r.ok === true).length;
      if (res.ticket_state === "partial" || failed > 0) {
        this.setData({
          phase: "partial",
          busy: false,
          errorText: "已保存 " + successCount + " 件,仍有 " + failed + " 件未完成。",
          resultText: "可用同一份确认内容重试剩余件;已成功件不会重复创建。",
          pendingUpload: pending,
        }, () => this.saveSession());
        return;
      }
      const notMounted = res.results.filter((r) => r.ok === true && r.mounted === false).length;
      const mountedNote = notMounted > 0 ? ";有 " + notMounted + " 件刚建档还没挂上位置,可稍后在这里手动挂载" : "";
      this.setData({
        phase: "done",
        busy: false,
        errorText: "",
        resultText: "已为 " + successCount + " 件物品保存同一段视频证据,每件高亮彼此独立;本次清点已记录" + mountedNote + "。",
        pendingUpload: null,
        frozenItems: pending.frozenItems,
      }, () => {
        this.clearSession();
        this.renderDrafts();
      });
      if (this.scanSession !== undefined) {
        await this.scanSession.cancel();
        this.scanSession = undefined;
      }
    } catch (e) {
      this.setData({
        phase: "partial",
        busy: false,
        errorText: errorMessage(e),
        resultText: "网络或服务异常;用同一份确认内容重试即可幂等收敛。",
        pendingUpload: pending,
      }, () => this.saveSession());
    }
  },

  async onRetryCommitTap() {
    const pending = this.data.pendingUpload;
    if (pending === null || this.data.busy) return;
    if (pending.fileId === "") {
      wx.showModal({
        title: "不能继续上次上传",
        content: "上次在视频上传完成前中断;请放弃待关联票据后重新确认,避免产生无主文件。",
        showCancel: false,
      });
      return;
    }
    this.setData({ busy: true, errorText: "" });
    try {
      if (pending.receiptDone === false) {
        await callItemsApi({ action: "videoUploadReceipt", upload_ticket: pending.uploadTicket, file_id: pending.fileId });
        const withReceipt: PendingUpload = { ...pending, receiptDone: true };
        this.setData({ pendingUpload: withReceipt }, () => this.saveSession());
        await this.commitFrozenUpload(withReceipt);
      } else {
        await this.commitFrozenUpload(pending);
      }
    } catch (e) {
      this.setData({ phase: "partial", busy: false, errorText: errorMessage(e) }, () => this.saveSession());
    }
  },

  async onDiscardPendingTap() {
    const pending = this.data.pendingUpload;
    if (pending === null || this.data.busy) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "放弃待关联视频",
        content: "服务端会先判断是否已有物品证据或清点记录:已有时不会删除原视频,只显示已保存部分。",
        confirmText: "放弃",
        confirmColor: "#d93025",
        success: (r) => resolve(r.confirm === true),
        fail: () => resolve(false),
      });
    });
    if (confirmed === false) return;
    this.setData({ busy: true });
    try {
      const res = await callItemsApi({ action: "videoUploadCancel", upload_ticket: pending.uploadTicket });
      if (res.state === "bound") {
        this.setData({
          phase: "done",
          busy: false,
          pendingUpload: null,
          resultText: "这段视频已经为部分物品保存为证据,不能整段删除;已关联物品保持不变。",
        }, () => this.clearSession());
      } else {
        this.setData({
          phase: "review",
          busy: false,
          pendingUpload: null,
          frozenItems: [],
          errorText: "",
          resultText: "已删除未关联的视频;仍可修改草稿后重新确认。",
        }, () => this.saveSession());
      }
    } catch (e) {
      this.setData({ busy: false, errorText: errorMessage(e) });
      wx.showModal({ title: "删除失败", content: errorMessage(e), showCancel: false });
    }
  },

  /* ---------------- mode=last 回看(不自动播放) ---------------- */

  onLastItemTap(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const row = this.data.lastItems[index];
    if (row === undefined) return;
    // 按 id 直查详情(get 单查);回看清单没有 version,绝不带编造的 summary
    wx.navigateTo({
      url: "/pages/item/item?item_id=" + encodeURIComponent(row.item_id),
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  onVideoPlayTap() {
    // 用户显式点击才播放;video 组件不设 autoplay
  },

  /** 弹层防冒泡占位(点面板不吃掉遮罩关闭) */
  noop() {},

  onDoneBackTap() {
    wx.navigateBack({
      fail: () => {
        wx.showToast({ title: "返回失败,请手动返回", icon: "none" });
      },
    });
  },
});
