import { applyPageAppearance } from "../../utils/appearance-page";
/**
 * PR B 场景扫描确认页：
 * - 用户主动录/选一段抽屉柜子视频；
 * - 本地抽帧 → 逐帧 vlRecognize → 多物品 observation；
 * - 用户显式生成/合并/拆分/补件后才产生待存草稿；
 * - 原视频只在最终确认后上传；同一 file_id/asset_id 为多件建 evidence；
 * - 不自动合并同名、不自动入库、不自动播放。
 */
import { callItemsApi, errorMessage, uuid } from "../../utils/api";
import { videoExtOf, type PickedVideoFile } from "../../utils/video-attach";
import {
  buildSceneCommitItems,
  createDraftsFromObservations,
  mergeSceneDrafts,
  newSceneDraft,
  scanSceneVideo,
  setDraftUnit,
  splitSceneDraft,
  stepDraftQty,
  type SceneDraftItem,
  type SceneObservation,
} from "../../utils/video-scene";
import {
  buildSceneGroupViews,
  claimGuard,
  confirmSingleSet,
  groupStats,
  sameFrameRiskModalCopy,
  sceneHighlightWarningText,
  type SceneGroupStats,
  type SceneGroupView,
} from "../../utils/scene-groups";
import { createVideoFrameSession, type VideoFrameSession } from "../../utils/video-target";
import { recognizeWithVl, type PhotoVlPrepared } from "../../utils/photo-vl";
import { ensureScopeVerified } from "../../utils/households-api";
import { householdScopeId } from "../../utils/household-scope";
import { UNIT_SET } from "../../utils/quantity";
import {
  buildVideoConfirmUsagePing,
  bumpUsageCount,
  createUsageSession,
  detectUsagePlatform,
  markUsageAbandoned,
  markUsageSaved,
  markUsageSessionStart,
  resetUsageSession,
  sendUsagePing,
  shouldReportUsageAbandon,
  type UsageSessionState,
} from "../../utils/usage-metrics";
import type {
  VideoEvidenceHighlightInput,
  VideoSceneCommitItem,
  VideoUploadBeginResponse,
} from "../../types";
import type { Box } from "../../utils/photo-box";

const SESSION_PREFIX = "home-memory:video-scene-session:";
const PENDING_PREFIX = "home-memory:video-scene-pending:";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

type ScenePhase =
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
  itemId: string;
  checked: boolean;
  mergeSelected: boolean;
  observationCount: number;
  highlightCount: number;
  highlightWarning: string;
  isManual: boolean;
  startSecText: string;
  endSecText: string;
  /** (Q3)数量步进显示值(未确认=1 起步口径;线索数绝不预填) */
  qty: number;
  /** (Q3)单位显示值(未确认=「件」缺省口径) */
  unit: string;
  /** (Q3)单位选择器索引(wxml 无 indexOf,预计算) */
  unitIndex: number;
  /** (Q3)用户已在行上确认过数量(quantity 在场) */
  quantitySet: boolean;
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
}

interface StoredSceneSession {
  version: 1;
  createdAt: number;
  scopeId: string;
  phase: ScenePhase;
  sceneId: string;
  videoPath: string;
  durationMs: number;
  width: number;
  height: number;
  batchLocation: string;
  observations: SceneObservation[];
  drafts: SceneDraftItem[];
  pendingUpload: PendingUpload | null;
  frozenItems: VideoSceneCommitItem[];
}

interface PageData {
  phase: ScenePhase;
  sceneId: string;
  videoPath: string;
  videoDurationMs: number;
  videoWidth: number;
  videoHeight: number;
  videoAspect: string;
  batchLocation: string;
  progressText: string;
  failureText: string;
  errorText: string;
  resultText: string;
  observations: SceneObservation[];
  drafts: SceneDraftItem[];
  mergeSelectedKeys: string[];
  observationGroups: SceneGroupView[];
  sceneStats: SceneGroupStats;
  draftViews: DraftView[];
  /** (Q3)单位选择器选项(UNIT_SET 冻结顺序 = 展示序,与拍照页同一闭集) */
  unitOptions: string[];
  frozenItems: VideoSceneCommitItem[];
  pendingUpload: PendingUpload | null;
  busy: boolean;
}

function scopeKey(prefix: string): string {
  return prefix + (householdScopeId() || "default");
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
    // 本地恢复失败不影响当前页面；base64 从不进 storage。
  }
}

function storageRemove(key: string): void {
  try {
    wx.removeStorageSync(key);
  } catch (e) {}
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && Array.isArray(v) === false;
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

function makeSession(
  data: PageData,
  pendingUpload: PendingUpload | null,
): StoredSceneSession {
  return {
    version: 1,
    createdAt: Date.now(),
    scopeId: householdScopeId(),
    phase: data.phase,
    sceneId: data.sceneId,
    videoPath: data.videoPath,
    durationMs: data.videoDurationMs,
    width: data.videoWidth,
    height: data.videoHeight,
    batchLocation: data.batchLocation,
    observations: data.observations,
    drafts: data.drafts,
    pendingUpload,
    frozenItems: data.frozenItems,
  };
}

function parseStoredSession(raw: unknown): StoredSceneSession | null {
  if (isRecord(raw) === false || raw.version !== 1) return null;
  if (typeof raw.createdAt !== "number" || Date.now() - raw.createdAt > SESSION_TTL_MS) return null;
  if (typeof raw.scopeId !== "string" || raw.scopeId !== householdScopeId()) return null;
  if (typeof raw.videoPath !== "string" || typeof raw.durationMs !== "number") return null;
  if (Array.isArray(raw.observations) === false || Array.isArray(raw.drafts) === false) return null;
  const pending = isRecord(raw.pendingUpload) && typeof raw.pendingUpload.fileId === "string"
    ? raw.pendingUpload as unknown as PendingUpload
    : null;
  const frozen = Array.isArray(raw.frozenItems) ? raw.frozenItems as unknown as VideoSceneCommitItem[] : [];
  return {
    version: 1,
    createdAt: raw.createdAt,
    scopeId: raw.scopeId,
    phase: typeof raw.phase === "string" ? raw.phase as ScenePhase : "review",
    sceneId: typeof raw.sceneId === "string" ? raw.sceneId : "",
    videoPath: raw.videoPath,
    durationMs: raw.durationMs,
    width: typeof raw.width === "number" ? raw.width : 0,
    height: typeof raw.height === "number" ? raw.height : 0,
    batchLocation: typeof raw.batchLocation === "string" ? raw.batchLocation : "",
    observations: raw.observations as unknown as SceneObservation[],
    drafts: raw.drafts as unknown as SceneDraftItem[],
    pendingUpload: pending,
    frozenItems: frozen,
  };
}

Page({
  onShow() { applyPageAppearance(this); },
  data: {
    phase: "idle" as ScenePhase,
    sceneId: "",
    videoPath: "",
    videoDurationMs: 0,
    videoWidth: 0,
    videoHeight: 0,
    videoAspect: "16 / 9",
    batchLocation: "",
    progressText: "",
    failureText: "",
    errorText: "",
    resultText: "",
    observations: [] as SceneObservation[],
    drafts: [] as SceneDraftItem[],
    mergeSelectedKeys: [] as string[],
    observationGroups: [] as SceneGroupView[],
    sceneStats: groupStats([], []) as SceneGroupStats,
    draftViews: [] as DraftView[],
    /** (Q3)单位选择器选项(UNIT_SET 冻结顺序 = 展示序,与拍照页同一闭集) */
    unitOptions: UNIT_SET as string[],
    frozenItems: [] as VideoSceneCommitItem[],
    pendingUpload: null as PendingUpload | null,
    busy: false,
  },

  /**
   * 零隐私使用埋点会话计数器(#85/#76 降本阶梯第 2 级):纯内存、不入 storage
   * (会话存储字段集保持旧版不变);计数/门/构建逻辑在 utils/usage-metrics,
   * 与 D1 页共用同一实现,页面只调用。
   */
  usage: createUsageSession(),

  onLoad() {
    const stored = parseStoredSession(storageGet(scopeKey(SESSION_PREFIX)));
    if (stored === null) return;
    // 恢复会话:补埋点起点(只补一次,不清计数——计数是本次页面会话的交互量)
    markUsageSessionStart(this.usage, Date.now());
    const phase: ScenePhase = stored.pendingUpload !== null ? "partial" : "review";
    this.setData({
      phase,
      sceneId: stored.sceneId,
      videoPath: stored.videoPath,
      videoDurationMs: stored.durationMs,
      videoWidth: stored.width,
      videoHeight: stored.height,
      videoAspect: stored.width > 0 && stored.height > 0 ? stored.width + " / " + stored.height : "16 / 9",
      batchLocation: stored.batchLocation,
      observations: stored.observations,
      drafts: stored.drafts,
      frozenItems: stored.frozenItems,
      pendingUpload: stored.pendingUpload,
      progressText: phase === "partial" ? "上次视频处理尚未完成" : "",
      resultText: phase === "partial"
        ? (stored.pendingUpload !== null && stored.pendingUpload.fileId !== ""
          ? "上次视频已上传，可重试完成剩余关联"
          : "上次视频上传未完成，请放弃待关联票据后重新确认")
        : "",
    }, () => {
      this.renderObservations();
      this.renderDrafts();
    });
  },

  onHide() {
    // 零隐私使用埋点:有扫描结果但未保存就离开 → abandon ping(best-effort,至多一次;
    // uploading/committing 不报——提交仍在后台收敛,done 已由 save ping 收口)
    if (shouldReportUsageAbandon(this.usage, this.data.phase, this.data.observations.length)) {
      markUsageAbandoned(this.usage);
      sendUsagePing(buildVideoConfirmUsagePing(this.usage, "video_confirm_abandon", detectUsagePlatform(), {
        observations: this.data.observations.length,
        groups: buildSceneGroupViews(this.data.observations, this.data.drafts).length,
        drafts: this.data.drafts.length,
      }, Date.now()));
    }
    const session = (this as unknown as { scanSession?: VideoFrameSession }).scanSession;
    if (session !== undefined) {
      void session.cancel();
      (this as unknown as { scanSession?: VideoFrameSession }).scanSession = undefined;
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

  saveSession() {
    if (this.data.observations.length === 0 && this.data.drafts.length === 0 && this.data.pendingUpload === null) return;
    storageSet(scopeKey(SESSION_PREFIX), makeSession(this.data as unknown as PageData, this.data.pendingUpload));
  },

  clearSession() {
    storageRemove(scopeKey(SESSION_PREFIX));
    storageRemove(scopeKey(PENDING_PREFIX));
  },

  /** R0(§5.2):组视图与统计全部由 observations+drafts 推导,组态/归属随草稿实时刷新 */
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
      // (Q3)数量视图:未确认行显示缺省口径 1/件(quantitySet=false 提示
      // 「不填按 1 件 · 线索数不代表件数」);线索数绝不预填数量
      const unit = d.unit !== undefined && UNIT_SET.indexOf(d.unit) !== -1 ? d.unit : "件";
      return {
        draftKey: d.draftKey,
        name: d.name,
        locationText: d.locationText,
        note: d.note,
        target: d.target,
        targetText: d.target === "existing" ? "关联已有物品：" + (d.itemId || "未选择") : "新建物品",
        itemId: d.itemId,
        checked: d.checked,
        mergeSelected: this.data.mergeSelectedKeys.indexOf(d.draftKey) !== -1,
        observationCount: d.observationIds.length,
        highlightCount: highlights,
        // §2.1:草稿线索数 >8 时草稿卡显式警示(组卡警示随剩余数,确认后归属到草稿上继续可见)
        highlightWarning: sceneHighlightWarningText(d.observationIds.length),
        isManual: d.observationIds.length === 0 && d.manualHighlights.length > 0,
        startSecText: first === null ? "" : (first.start_ms / 1000).toFixed(1),
        endSecText: first === null ? "" : (first.end_ms / 1000).toFixed(1),
        qty: typeof d.quantity === "number" ? d.quantity : 1,
        unit,
        unitIndex: Math.max(0, UNIT_SET.indexOf(unit)),
        quantitySet: typeof d.quantity === "number",
      };
    });
    this.setData({ draftViews: views });
  },

  async onChooseVideoTap() {
    if (this.data.busy) return;
    const consent = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "拍一段抽屉/柜子视频",
        content:
          "原视频在你最终确认前不会上传云存储；识别时会把少量静帧临时发到云端 AI，不保存识别结果。确认后才会保存原视频和每件物品的高亮。视频只作历史证据，不冒充当前位置，也不会自动播放。",
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
    await this.startSceneScan(file);
  },

  async startSceneScan(file: PickedVideoFile) {
    const sceneId = uuid();
    const epoch = ((this as unknown as { scanEpoch?: number }).scanEpoch || 0) + 1;
    (this as unknown as { scanEpoch?: number }).scanEpoch = epoch;
    let session: VideoFrameSession;
    try {
      session = createVideoFrameSession({ path: file.path, durationMs: file.durationMs }, { durationMs: file.durationMs });
    } catch (e) {
      this.setData({ phase: "failed", busy: false, errorText: "当前设备暂不支持视频抽帧，可改用拍照识物或手动添加。" });
      return;
    }
    (this as unknown as { scanSession?: VideoFrameSession }).scanSession = session;
    // 新一次清点 = 新一次计量:归零计数、重置会话起点
    resetUsageSession(this.usage, Date.now());
    this.setData({
      phase: "scanning",
      sceneId,
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
        if (((this as unknown as { scanEpoch?: number }).scanEpoch || 0) !== epoch) return;
        this.setData({
          progressText: "已分析 " + done + "/" + total + " 帧" + (failures > 0 ? "，" + failures + " 帧失败" : ""),
        });
      },
    });

    if (((this as unknown as { scanEpoch?: number }).scanEpoch || 0) !== epoch) return;
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
      ? "已分析 " + outcome.framesScanned + "/" + outcome.framesTotal + " 帧，" + outcome.failures.length + " 帧失败；结果可能漏件，可手动补件。"
      : "";
    const truncatedText = outcome.truncatedFrames.length > 0
      ? "有 " + outcome.truncatedFrames.length + " 帧只保留了前 10 件，可能漏件。"
      : "";
    this.setData({
      phase: "review",
      busy: false,
      observations: outcome.observations,
      failureText: [failureText, truncatedText].filter((s) => s !== "").join(" "),
      resultText: outcome.observations.length === 0
        ? "AI 暂未给出物品线索，可手动补一件；原视频仍只在最终确认后上传。"
        : "已发现 " + outcome.observations.length + " 条线索；同名线索只是提示，不会被自动合并。",
      progressText: "",
    });
    this.renderObservations();
    this.renderDrafts();
    this.saveSession();
    if (outcome.manualFallback) {
      wx.showToast({ title: "未识别到线索，可手动补件", icon: "none" });
    }
  },

  async cancelScan() {
    (this as unknown as { scanEpoch?: number }).scanEpoch = ((this as unknown as { scanEpoch?: number }).scanEpoch || 0) + 1;
    const session = (this as unknown as { scanSession?: VideoFrameSession }).scanSession;
    if (session !== undefined) await session.cancel();
    (this as unknown as { scanSession?: VideoFrameSession }).scanSession = undefined;
  },

  async onCancelScanTap() {
    await this.cancelScan();
    this.setData({ phase: "idle", busy: false, observations: [], drafts: [], progressText: "", errorText: "" });
    this.clearSession();
  },

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

  /** 行勾选是组卡内交互态(组件持有,§5.2);页面侧只保留接线,无全局跨组选择 */
  onObservationToggle() {},

  /* ---------------- R0 三动作(§2):就 1 件 / 有多件或需拆开 / 暂不确定 ---------------- */

  /** 就 1 件:生成聚合草稿的唯一入口;同帧风险组先过 §2.1 二次确认 */
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
      // §2.1 修订(PR #105 review 5626920410):弹窗时间=重复实际发生帧,非代表帧
      const riskModal = sameFrameRiskModalCopy(group.duplicateFrameTimeText);
      const sure = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: riskModal.title,
          content: riskModal.content,
          confirmText: riskModal.confirmText,
          cancelText: riskModal.cancelText,
          success: (r) => resolve(r.confirm === true),
          fail: () => resolve(false),
        });
      });
      if (sure === false) return;
    }
    const draft = newSceneDraft({
      observationIds: confirmSet,
      name: group.label,
      locationText: this.data.batchLocation,
      checked: true,
    });
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

  /** 逐条生成(组内作用域,§7):先过 §2.4 归属门,再按一条一草稿生成 */
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
    const drafts = createDraftsFromObservations(this.data.observations, obsIds, {
      mergeSameName: false,
      batchLocation: this.data.batchLocation,
    });
    this.setData({ drafts: this.data.drafts.concat(drafts) }, () => {
      this.renderObservations();
      this.renderDrafts();
      this.saveSession();
    });
  },

  onBatchLocationInput(e: WechatMiniprogram.CustomEvent) {
    const value = isRecord(e.detail) && typeof e.detail.value === "string" ? e.detail.value : "";
    const drafts = this.data.drafts.map((d) =>
      d.target === "new" && d.locationText.trim() === "" ? { ...d, locationText: value } : d,
    );
    this.setData({ batchLocation: value, drafts }, () => this.renderDrafts());
  },

  onDraftCheckedTap(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const drafts = this.data.drafts.slice();
    drafts[index] = { ...drafts[index], checked: drafts[index].checked === false };
    this.setData({ drafts }, () => this.renderDrafts());
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
    // 改名影响组卡「已用于:{草稿名}」归属标签(claimText 随草稿名推导),与 D1 页同步重算组视图
    this.setData({ drafts }, () => {
      this.renderObservations();
      this.renderDrafts();
    });
  },

  onDraftLocationInput(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const value = isRecord(e.detail) && typeof e.detail.value === "string" ? e.detail.value : "";
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const drafts = this.data.drafts.slice();
    drafts[index] = { ...drafts[index], locationText: value };
    this.setData({ drafts }, () => this.renderDrafts());
  },

  onDraftNoteInput(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const value = isRecord(e.detail) && typeof e.detail.value === "string" ? e.detail.value : "";
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const drafts = this.data.drafts.slice();
    drafts[index] = { ...drafts[index], note: value };
    this.setData({ drafts }, () => this.renderDrafts());
  },

  /* ---------------- 数量输入(issue #102 Q3,Q0-CONTRACT §9.1) ---------------- */

  /**
   * 草稿行数量步进(±1):quantity 只来自用户触碰(1 起步,钳 1..9999,首触补
   * 默认单位「件」成组);existing 行不提供数量输入(关联不碰数量,E7 边界)。
   * 步进值与 observationIds/highlights 条数完全解耦——6 条线索未触碰 = 无数量。
   */
  onDraftQtyStep(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const delta = Number(e.currentTarget.dataset.d);
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const draft = this.data.drafts[index];
    if (draft.target !== "new") {
      wx.showToast({ title: "关联已有物品不改数量,请到物品详情修改", icon: "none" });
      return;
    }
    const drafts = this.data.drafts.slice();
    drafts[index] = stepDraftQty(draft, delta);
    this.setData({ drafts }, () => {
      this.renderDrafts();
      this.saveSession();
    });
  },

  /** 草稿行单位选择(UNIT_SET picker);只选单位也把数量落成 1(成组确认) */
  onDraftUnitChange(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const idx = Number(isRecord(e.detail) ? e.detail.value : -1);
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    if (Number.isInteger(idx) === false || idx < 0 || idx >= UNIT_SET.length) return;
    const draft = this.data.drafts[index];
    if (draft.target !== "new") {
      wx.showToast({ title: "关联已有物品不改数量,请到物品详情修改", icon: "none" });
      return;
    }
    const drafts = this.data.drafts.slice();
    drafts[index] = setDraftUnit(draft, UNIT_SET[idx]);
    this.setData({ drafts }, () => {
      this.renderDrafts();
      this.saveSession();
    });
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
    bumpUsageCount(this.usage, "removes");
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
      wx.showToast({ title: "这件只有一条高亮，无需拆分", icon: "none" });
      return;
    }
    bumpUsageCount(this.usage, "splits");
    const drafts = this.data.drafts.slice();
    drafts.splice(index, 1, ...split);
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
    bumpUsageCount(this.usage, "merges");
    const keys = new Set(this.data.mergeSelectedKeys);
    const firstIndex = this.data.drafts.findIndex((d) => keys.has(d.draftKey));
    const drafts = this.data.drafts.filter((d) => keys.has(d.draftKey) === false);
    drafts.splice(Math.max(0, firstIndex), 0, merged);
    this.setData({ drafts, mergeSelectedKeys: [] }, () => {
      this.renderObservations();
      this.renderDrafts();
      this.saveSession();
    });
  },

  onAddManualDraftTap() {
    const duration = Math.max(1, this.data.videoDurationMs);
    const end = Math.min(duration, 1500);
    bumpUsageCount(this.usage, "manualAdds");
    const draft = newSceneDraft({
      locationText: this.data.batchLocation,
      manualHighlights: [{
        start_ms: 0,
        end_ms: end > 0 ? end : duration,
        box: null,
        frame_ms: 0,
      }],
      checked: true,
    });
    this.setData({ drafts: this.data.drafts.concat([draft]) }, () => {
      this.renderObservations();
      this.renderDrafts();
      this.saveSession();
    });
  },

  async onDraftTargetTap(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isInteger(index) === false || index < 0 || index >= this.data.drafts.length) return;
    const choice = await new Promise<number | null>((resolve) => {
      wx.showActionSheet({
        itemList: ["新建物品", "关联已有物品"],
        success: (r) => resolve(r.tapIndex),
        fail: () => resolve(null),
      });
    });
    if (choice === null) return;
    if (choice === 0) {
      const d = this.data.drafts[index];
      if (d.target === "new") {
        wx.showToast({ title: "这件已是「新建物品」", icon: "none" });
        return;
      }
      const drafts = this.data.drafts.slice();
      drafts[index] = { ...drafts[index], target: "new", itemId: "" };
      this.setData({ drafts }, () => this.renderDrafts());
      return;
    }
    try {
      await ensureScopeVerified();
      const res = await callItemsApi({ action: "list", limit: 50 });
      if (res.items.length === 0) {
        wx.showToast({ title: "还没有可关联的物品", icon: "none" });
        return;
      }
      const options = res.items.slice(0, 6);
      const picked = await new Promise<number | null>((resolve) => {
        wx.showActionSheet({
          itemList: options.map((it) => it.name + " · " + it.location_text),
          success: (r) => resolve(r.tapIndex),
          fail: () => resolve(null),
        });
      });
      if (picked === null || options[picked] === undefined) return;
      const drafts = this.data.drafts.slice();
      drafts[index] = { ...drafts[index], target: "existing", itemId: options[picked].item_id };
      this.setData({ drafts }, () => this.renderDrafts());
    } catch (err) {
      wx.showModal({ title: "读取物品失败", content: errorMessage(err), showCancel: false });
    }
  },

  onRestartTap() {
    wx.showModal({
      title: "重新拍摄",
      content: "当前候选和草稿会清空；原视频在确认前未上传。确定重来吗？",
      confirmText: "重来",
      success: (r) => {
        if (r.confirm !== true) return;
        void this.cancelScan();
        this.clearSession();
        this.setData({
          phase: "idle",
          sceneId: "",
          videoPath: "",
          videoDurationMs: 0,
          videoWidth: 0,
          videoHeight: 0,
          batchLocation: "",
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
    const built = buildSceneCommitItems(this.data.drafts, this.data.observations, this.data.videoDurationMs);
    if (built.ok === false) {
      wx.showModal({ title: "还不能保存", content: built.message, showCancel: false });
      return;
    }
    try {
      await ensureScopeVerified();
    } catch (e) {
      wx.showToast({ title: "暂时无法确认当前家庭，请稍后重试", icon: "none" });
      return;
    }
    this.setData({ phase: "uploading", busy: true, errorText: "", resultText: "", frozenItems: built.items }, () => {
      void this.startSceneUpload(built.items);
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

  async startSceneUpload(frozenItems: VideoSceneCommitItem[]) {
    if (this.data.videoPath === "" || this.data.sceneId === "") {
      this.setData({ phase: "review", busy: false, errorText: "本地视频已失效，请重拍" });
      return;
    }
    const available = await this.localVideoAvailable();
    if (available === false) {
      this.setData({ phase: "review", busy: false, errorText: "本地视频临时文件已失效，请重拍；本次没有上传任何文件。" });
      return;
    }
    let begin: VideoUploadBeginResponse | null = null;
    try {
      begin = await callItemsApi({
        action: "videoUploadBegin",
        purpose: "scene",
        scene_id: this.data.sceneId,
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
      this.setData({ phase: "review", busy: false, errorText: "服务返回异常，请稍后重试" });
      return;
    }
    const basePending: PendingUpload = {
      sceneId: this.data.sceneId,
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
      this.setData({ phase: "review", busy: false, pendingUpload: null, errorText: "视频上传失败，请检查网络后重试" }, () => this.saveSession());
      wx.showModal({ title: "上传失败", content: "原视频没有上传成功，本次未写入任何物品证据。", showCancel: false });
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
        resultText: "视频已上传，但还没有完成证据关联。可重试；不会自动重复创建物品。",
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
      });
      const failed = res.evidence_failed ? res.evidence_failed.length : 0;
      const successCount = res.results.filter((r) => r.ok === true).length;
      if (res.ticket_state === "partial" || failed > 0) {
        this.setData({
          phase: "partial",
          busy: false,
          errorText: "已保存 " + successCount + " 件，仍有 " + failed + " 件未完成。",
          resultText: "可用同一份确认内容重试剩余件；已成功件不会重复创建。",
          pendingUpload: pending,
        }, () => this.saveSession());
        return;
      }
      this.setData({
        phase: "done",
        busy: false,
        errorText: "",
        resultText: "已为 " + successCount + " 件物品保存同一段视频证据，每件高亮彼此独立。",
        pendingUpload: null,
        frozenItems: pending.frozenItems,
      }, () => {
        this.clearSession();
        this.renderDrafts();
      });
      // 零隐私使用埋点(#85/#76):保存成功一次 save ping(fire-and-forget,失败全吞;
      // 先置 savedSent,离开时不再补 abandon)
      markUsageSaved(this.usage);
      sendUsagePing(buildVideoConfirmUsagePing(this.usage, "video_confirm_save", detectUsagePlatform(), {
        observations: this.data.observations.length,
        groups: buildSceneGroupViews(this.data.observations, this.data.drafts).length,
        drafts: successCount,
      }, Date.now()));
      const session = (this as unknown as { scanSession?: VideoFrameSession }).scanSession;
      if (session !== undefined) {
        await session.cancel();
        (this as unknown as { scanSession?: VideoFrameSession }).scanSession = undefined;
      }
    } catch (e) {
      this.setData({
        phase: "partial",
        busy: false,
        errorText: errorMessage(e),
        resultText: "网络或服务异常；用同一份确认内容重试即可幂等收敛。",
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
        content: "上次在视频上传完成前中断；请放弃待关联票据后重新确认，避免产生无主文件。",
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
        content: "服务端会先判断是否已有物品证据：已有证据时不会删除原视频，只显示已保存部分。",
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
          resultText: "这段视频已经为部分物品保存为证据，不能整段删除；已关联物品保持不变。",
        }, () => this.clearSession());
      } else {
        this.setData({
          phase: "review",
          busy: false,
          pendingUpload: null,
          frozenItems: [],
          errorText: "",
          resultText: "已删除未关联的视频；仍可修改草稿后重新确认。",
        }, () => {
          this.saveSession();
        });
      }
    } catch (e) {
      this.setData({ busy: false, errorText: errorMessage(e) });
      wx.showModal({ title: "删除失败", content: errorMessage(e), showCancel: false });
    }
  },

  onDoneBackTap() {
    wx.navigateBack({
      fail: () => {
        wx.showToast({ title: "返回失败，请手动返回", icon: "none" });
      },
    });
  },
});
