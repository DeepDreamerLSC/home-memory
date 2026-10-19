/**
 * 视频识别确认页:
 * 选视频 -> 客户端抽帧 -> 逐帧 vlRecognize -> 同名聚合 -> 用户确认
 * -> 上传原视频一次 -> videoCommit 批量建档 + 视频证据(时间窗/高亮框)。
 * 识别只是候选;用户勾选并保存后才有事实写入。
 */
import { uuid } from "../../utils/api";
import { ensureScopeVerified } from "../../utils/households-api";
import { householdScopeId } from "../../utils/household-scope";
import { recognizeWithVl } from "../../utils/photo-vl";
import {
  aggregateVideoRecognitions,
  extractVideoFrames,
  type VideoRecognizedCandidate,
} from "../../utils/video-frames";
import {
  commitVideoBatch,
  pickVideo,
  retryVideoEvidence,
  type PickedVideo,
  type VideoIntakeRow,
} from "../../utils/video-intake";

interface VideoRowView {
  draftId: string;
  index: number;
  name: string;
  qty: number;
  qtyNote: string;
  checked: boolean;
  confText: string;
  seenText: string;
  isManual: boolean;
}

interface VideoPageData {
  stage: "pick" | "analyzing" | "review" | "saving" | "done";
  analyzeText: string;
  analyzeDetail: string;
  noticeText: string;
  errorText: string;
  rows: VideoRowView[];
  batchLocation: string;
  videoText: string;
  pickDisabled: boolean;
  saveText: string;
}

Page<VideoPageData, {
  video: PickedVideo | null;
  rowsRaw: VideoIntakeRow[];
  batchId: string;
  fileId: string | null;
  scopeId: string;
  saving: boolean;
  renderRows(): void;
  onChooseVideo(): Promise<void>;
  onAddManual(): void;
  onToggle(e: WechatMiniprogram.BaseEvent): void;
  onNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
  onQtyStep(e: WechatMiniprogram.BaseEvent): void;
  onBatchLocationInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
  onSave(): Promise<void>;
  goBack(): void;
}>({
  data: {
    stage: "pick",
    analyzeText: "",
    analyzeDetail: "",
    noticeText: "",
    errorText: "",
    rows: [],
    batchLocation: "",
    videoText: "",
    pickDisabled: false,
    saveText: "确认记住",
  },

  video: null,
  rowsRaw: [],
  batchId: "",
  fileId: null,
  scopeId: "",
  saving: false,

  onLoad() {
    this.batchId = uuid();
  },

  renderRows() {
    const confMap: Record<string, string> = { high: "高", mid: "中", low: "低" };
    this.setData({
      rows: this.rowsRaw.map((r, i) => ({
        draftId: r.draftId,
        index: i,
        name: r.name,
        qty: r.qty,
        qtyNote: r.qtyNote,
        checked: r.checked,
        confText: r.seenCount > 0 ? confMap[r.confidence] + " · 出现 " + r.seenCount + " 帧" : "手动添加",
        seenText: r.seenCount > 0 ? "视频里有 " + r.seenCount + " 个采样帧识别到" : "仅保存视频证据,无自动高亮",
        isManual: r.seenCount === 0,
      })),
    });
  },

  async onChooseVideo() {
    if (this.data.pickDisabled) return;
    this.setData({ pickDisabled: true, errorText: "", noticeText: "" });
    const consent = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "视频识别说明",
        content:
          "识别需要把从视频里抽出的少量画面临时发送到云端处理,不会保存这些帧;原视频只在你确认保存后才会上传保存。",
        confirmText: "开始识别",
        cancelText: "取消",
        success: (r) => resolve(r.confirm === true),
        fail: () => resolve(false),
      });
    });
    if (consent === false) {
      this.setData({ pickDisabled: false });
      return;
    }
    const video = await pickVideo();
    if (video === null) {
      this.setData({ pickDisabled: false });
      return;
    }
    this.video = video;
    this.fileId = null;
    this.setData({
      stage: "analyzing",
      videoText: Math.round(video.duration_ms / 1000) + " 秒 · " + video.width + "×" + video.height,
      analyzeText: "正在抽取关键帧",
      analyzeDetail: "识别在手机本地抽帧后逐帧进行,原视频要等你确认保存后才会上传",
    });
    try {
      await ensureScopeVerified();
      this.scopeId = householdScopeId();
    } catch (e) {
      this.scopeId = "";
    }
    let frames;
    try {
      frames = await extractVideoFrames(video.path, video.duration_ms, 8);
    } catch (e) {
      this.rowsRaw = [];
      this.setData({
        stage: "review",
        pickDisabled: false,
        analyzeText: "",
        analyzeDetail: "",
        noticeText: "自动抽帧暂不可用。视频仍可保存为证据;你可以手动添加物品名称。",
      });
      this.renderRows();
      return;
    }
    const recognitions = [];
    let failedFrames = 0;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      this.setData({
        analyzeText: "正在识别第 " + (i + 1) + "/" + frames.length + " 帧",
        analyzeDetail: "只把抽出的帧临时发给云端识别,原视频尚未上传",
      });
      const out = await recognizeWithVl({
        ok: true,
        path: video.path,
        imgW: frame.width,
        imgH: frame.height,
        base64: frame.base64,
        compressed: false,
      });
      if (out.ok) {
        recognitions.push({ time_ms: frame.time_ms, items: out.items });
      } else {
        failedFrames += 1;
      }
    }
    const candidates = aggregateVideoRecognitions(recognitions, video.duration_ms, 10);
    this.rowsRaw = candidates.map((c: VideoRecognizedCandidate) => ({
      draftId: uuid(),
      name: c.name,
      qty: 1,
      qtyNote: c.qty_note,
      checked: true,
      confidence: c.confidence,
      seenCount: c.seen_count,
      highlights: c.highlights,
    }));
    const notice =
      candidates.length === 0
        ? "没有自动识别出物品。你可以手动添加,视频仍会作为证据保存。"
        : failedFrames > 0
          ? "有 " + failedFrames + "/" + frames.length + " 个采样帧识别失败;下面是成功帧的候选,请逐件核对。"
          : "";
    this.setData({ stage: "review", pickDisabled: false, analyzeText: "", analyzeDetail: "", noticeText: notice });
    this.renderRows();
  },

  onAddManual() {
    this.rowsRaw.push({
      draftId: uuid(),
      name: "",
      qty: 1,
      qtyNote: "",
      checked: true,
      confidence: "low",
      seenCount: 0,
      highlights: [],
    });
    this.renderRows();
  },

  onToggle(e: WechatMiniprogram.BaseEvent) {
    const i = Number(e.currentTarget.dataset.index);
    if (this.rowsRaw[i] === undefined) return;
    this.rowsRaw[i] = { ...this.rowsRaw[i], checked: this.rowsRaw[i].checked === false };
    this.renderRows();
  },

  onNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const i = Number(e.currentTarget.dataset.index);
    if (this.rowsRaw[i] === undefined) return;
    this.rowsRaw[i] = { ...this.rowsRaw[i], name: e.detail.value || "" };
    this.renderRows();
  },

  onQtyStep(e: WechatMiniprogram.BaseEvent) {
    const i = Number(e.currentTarget.dataset.index);
    const dir = Number(e.currentTarget.dataset.dir);
    if (this.rowsRaw[i] === undefined) return;
    const next = Math.max(1, Math.min(99, this.rowsRaw[i].qty + (dir === -1 ? -1 : 1)));
    this.rowsRaw[i] = { ...this.rowsRaw[i], qty: next };
    this.renderRows();
  },

  onBatchLocationInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ batchLocation: e.detail.value || "" });
  },

  async onSave() {
    if (this.saving || this.video === null) return;
    const filled = this.rowsRaw.filter((r) => r.checked && r.name.trim() !== "");
    if (filled.length === 0) {
      this.setData({ errorText: "请至少保留一件物品并填写名称" });
      return;
    }
    if (this.data.batchLocation.trim() === "") {
      this.setData({ errorText: "请填写这批物品的位置" });
      return;
    }
    if (this.scopeId === "") {
      this.setData({ errorText: "暂时无法确认当前家庭,请稍后重试" });
      return;
    }
    this.saving = true;
    this.setData({ stage: "saving", saveText: "正在保存…", errorText: "" });
    const outcome = await commitVideoBatch({
      batchId: this.batchId,
      rows: this.rowsRaw,
      batchLocation: this.data.batchLocation,
      video: this.video,
      scopeId: this.scopeId,
      fileId: this.fileId,
    });
    this.fileId = outcome.fileId || null;
    if (outcome.ok === false) {
      this.saving = false;
      this.setData({ stage: "review", saveText: "确认记住", errorText: outcome.message });
      return;
    }
    const failedRows = outcome.results.filter((r) => r.ok === false).length;
    let evidenceFailed = outcome.evidenceFailed.length;
    if (evidenceFailed > 0) {
      const itemIdByIndex: Record<number, string> = {};
      outcome.results.forEach((r) => {
        if (r.ok && r.item_id) itemIdByIndex[r.index] = r.item_id;
      });
      try {
        const still = await retryVideoEvidence(outcome.video, this.rowsRaw, itemIdByIndex);
        evidenceFailed = still.length;
      } catch (e) {
        evidenceFailed = outcome.evidenceFailed.length;
      }
    }
    this.saving = false;
    this.setData({ stage: "done", saveText: "已保存" });
    const pieces: string[] = [];
    outcome.results.forEach((r) => {
      if (r.ok === false && r.message) pieces.push(r.message);
    });
    let msg = "已记住 " + (outcome.results.length - failedRows) + " 件";
    if (failedRows > 0) msg += ";有 " + failedRows + " 件没存上";
    if (evidenceFailed > 0) msg += ";" + evidenceFailed + " 件视频待关联";
    wx.showToast({ title: msg, icon: "none", duration: 2600 });
    setTimeout(() => this.goBack(), 900);
  },

  goBack() {
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: "/pages/index/index" }),
    });
  },
});
