import {
  ApiError,
  callExtractDraft,
  callItemsApi,
  errorMessage,
  formatDateTime,
} from "../../utils/api";
import {
  ensureRecordAuth,
  createVoiceController,
  createDefaultVoiceDeps,
  isSlideUpCancel,
  markVoiceCancelled,
  resetVoiceCancelled,
  type VoiceController,
} from "../../utils/voice";
import type { Draft, ItemSummary } from "../../types";

/** 用于渲染的条目(附带格式化后的更新时间) */
type DisplayItem = ItemSummary & { updated_at_text: string };

function toDisplayItems(items: ItemSummary[]): DisplayItem[] {
  return items.map((item) => ({
    ...item,
    updated_at_text: formatDateTime(item.updated_at),
  }));
}

Page<
  {
    memoText: string;
    extracting: boolean;
    queryText: string;
    querying: boolean;
    queried: boolean;
    queryKeyword: string;
    queryResults: DisplayItem[];
    queryError: string;
    recentItems: DisplayItem[];
    recentLoading: boolean;
    recentError: string;
    /** 记一件的输入方式:text 文字 / voice 按住说话 */
    inputMode: "text" | "voice";
    /** 语音状态:idle 空闲 / recording 录音中 / cancelPending 已上滑待松手 */
    voiceState: "idle" | "recording" | "cancelPending";
    /** 录音停止后云端识别中 */
    transcribing: boolean;
    /** 本次录音秒数(展示用) */
    recordSeconds: number;
    /** 录音中/识别中的提示文本 */
    partialText: string;
  },
  {
    onMemoInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onModeText(): void;
    onModeVoice(): void;
    /** 语音控制器(进入语音模式时惰性创建) */
    voiceCtrl: VoiceController | null;
    /** 本次按住的起点 Y(上滑取消判定) */
    touchStartY: number;
    /** 录音秒数计时器句柄 */
    recordTimer: number;
    clearRecordTimer(): void;
    onExtractTap(): Promise<void>;
    onQueryInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onQueryTap(): Promise<void>;
    onResultTap(e: WechatMiniprogram.CustomEvent): void;
    onRecentTap(e: WechatMiniprogram.CustomEvent): void;
    loadRecent(): Promise<void>;
    openItem(item: DisplayItem): void;
    goToConfirm(url: string): void;
    onTalkTouchStart(e: WechatMiniprogram.TouchEvent): void;
    onTalkTouchMove(e: WechatMiniprogram.TouchEvent): void;
    onTalkTouchEnd(): void;
    onTalkTouchCancel(): void;
    startRecording(): Promise<void>;
    finishRecording(): void;
    voiceFallbackToText(): void;
  }
>({
  data: {
    memoText: "",
    extracting: false,
    queryText: "",
    querying: false,
    queried: false,
    queryKeyword: "",
    queryResults: [],
    queryError: "",
    recentItems: [],
    recentLoading: false,
    recentError: "",
    inputMode: "text",
    voiceState: "idle",
    transcribing: false,
    recordSeconds: 0,
    partialText: "",
  },

  voiceCtrl: null,
  touchStartY: 0,
  recordTimer: 0,

  onShow() {
    this.loadRecent();
  },

  onHide() {
    this.clearRecordTimer();
  },

  onUnload() {
    this.clearRecordTimer();
  },

  clearRecordTimer() {
    if (this.recordTimer) {
      clearInterval(this.recordTimer);
      this.recordTimer = 0;
    }
  },

  onMemoInput(e) {
    this.setData({ memoText: e.detail && e.detail.value ? e.detail.value : "" });
  },

  onModeText() {
    markVoiceCancelledIfRecording(this);
    this.clearRecordTimer();
    this.setData({ inputMode: "text", voiceState: "idle", transcribing: false, partialText: "" });
  },

  onModeVoice() {
    this.setData({ inputMode: "voice", voiceState: "idle", transcribing: false, partialText: "", recordSeconds: 0 });
    if (this.voiceCtrl === null) {
      this.voiceCtrl = createVoiceController(
        {
          onStart: () => {
            this.clearRecordTimer();
            this.setData({ voiceState: "recording", partialText: "", recordSeconds: 0 });
            this.recordTimer = setInterval(() => {
              this.setData({ recordSeconds: this.data.recordSeconds + 1 });
            }, 1000);
          },
          onTranscribing: () => {
            this.clearRecordTimer();
            this.setData({ transcribing: true, partialText: "识别中…" });
          },
          onStop: (text) => {
            this.clearRecordTimer();
            this.setData({ voiceState: "idle", transcribing: false, partialText: text });
            if (!text) {
              wx.showToast({ title: "没听清,请重试或改用文字", icon: "none", duration: 2500 });
              return;
            }
            // 转写完成 → 自动进入既有提取链路(录音→转写→AI提取→确认)
            this.setData({ memoText: text, inputMode: "text" });
            this.onExtractTap();
          },
          onError: (code, message) => {
            this.clearRecordTimer();
            this.setData({ voiceState: "idle", transcribing: false });
            wx.showToast({ title: message, icon: "none", duration: 2500 });
          },
        },
        createDefaultVoiceDeps(),
      );
    }
  },

  onTalkTouchStart(e) {
    if (this.data.voiceState !== "idle") {
      return;
    }
    const touch = e.touches && e.touches[0];
    this.touchStartY = touch ? touch.clientY : 0;
    resetVoiceCancelled();
    // 授权异步,授权通过后手指可能仍按着;直接尝试启动
    void this.startRecording();
  },

  onTalkTouchMove(e) {
    if (this.data.voiceState === "idle") {
      return;
    }
    const touch = e.touches && e.touches[0];
    if (!touch) {
      return;
    }
    if (isSlideUpCancel(this.touchStartY, touch.clientY)) {
      if (this.data.voiceState !== "cancelPending") {
        markVoiceCancelled();
        this.setData({ voiceState: "cancelPending" });
      }
    } else if (this.data.voiceState === "cancelPending") {
      // 滑回按钮范围,恢复录音
      resetVoiceCancelled();
      this.setData({ voiceState: "recording" });
    }
  },

  onTalkTouchEnd() {
    this.finishRecording();
  },

  onTalkTouchCancel() {
    markVoiceCancelled();
    this.finishRecording();
  },

  async startRecording() {
    const auth = await ensureRecordAuth();
    if (auth === "denied") {
      wx.showModal({
        title: "需要录音权限",
        content: "语音记一件需要使用麦克风。可以到设置中开启,或改用文字输入。",
        confirmText: "去设置",
        cancelText: "用文字",
        success: (r) => {
          if (r.confirm) {
            wx.openSetting({});
          } else {
            this.voiceFallbackToText();
          }
        },
      });
      return;
    }
    if (this.voiceCtrl === null) {
      // 授权通过后控制器缺失(不应发生):回退文字
      this.voiceFallbackToText();
      return;
    }
    this.voiceCtrl.start();
  },

  finishRecording() {
    if (this.data.voiceState === "idle") {
      return;
    }
    if (this.voiceCtrl !== null) {
      this.voiceCtrl.stop();
    }
    // 状态在 onStop/onError 回调里复位;取消场景这里立即复位视觉
    if (this.data.voiceState === "cancelPending") {
      this.clearRecordTimer();
      this.setData({ voiceState: "idle", partialText: "" });
    }
  },

  voiceFallbackToText() {
    markVoiceCancelledIfRecording(this);
    this.clearRecordTimer();
    this.setData({ inputMode: "text", voiceState: "idle", transcribing: false, partialText: "" });
  },

  /** 记一件:textarea → extractDraft,按契约分流 */
  async onExtractTap() {
    const text = this.data.memoText.trim();
    if (!text) {
      wx.showToast({ title: "请先输入一句话", icon: "none" });
      return;
    }
    if (this.data.extracting) {
      return;
    }
    this.setData({ extracting: true });
    try {
      const res = await callExtractDraft(text);
      if ("needs_split" in res) {
        wx.showToast({
          title: res.message || "一次只记一件物品,请分开说",
          icon: "none",
          duration: 2500,
        });
        return;
      }
      const draft: Draft = res.draft;
      this.goToConfirm(
        "/pages/confirm/confirm?draft=" + encodeURIComponent(JSON.stringify(draft)),
      );
    } catch (e) {
      if (e instanceof ApiError && e.code === "AI_UNAVAILABLE") {
        // 契约流程:AI 不可用时征得确认后进入手动录入
        wx.showModal({
          title: "AI 暂时不可用",
          content: e.message,
          confirmText: "手动录入",
          cancelText: "取消",
          success: (r) => {
            if (r.confirm) {
              this.goToConfirm("/pages/confirm/confirm?manual=true");
            }
          },
        });
      } else {
        wx.showModal({
          title: "提取失败",
          content: errorMessage(e),
          showCancel: false,
        });
      }
    } finally {
      this.setData({ extracting: false });
    }
  },

  /** 找东西:输入名称 → itemsApi query */
  onQueryInput(e) {
    this.setData({ queryText: e.detail && e.detail.value ? e.detail.value : "" });
  },

  async onQueryTap() {
    const q = this.data.queryText.trim();
    if (!q) {
      wx.showToast({ title: "请输入物品名称", icon: "none" });
      return;
    }
    if (this.data.querying) {
      return;
    }
    this.setData({ querying: true, queryError: "" });
    try {
      const res = await callItemsApi({ action: "query", q });
      this.setData({
        queried: true,
        queryKeyword: q,
        queryResults: toDisplayItems(res.items),
      });
    } catch (e) {
      this.setData({
        queried: true,
        queryKeyword: q,
        queryResults: [],
        queryError: errorMessage(e),
      });
    } finally {
      this.setData({ querying: false });
    }
  },

  onResultTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.queryResults[index];
    if (item) {
      this.openItem(item);
    }
  },

  onRecentTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.recentItems[index];
    if (item) {
      this.openItem(item);
    }
  },

  /** 最近记录:itemsApi list */
  async loadRecent() {
    this.setData({ recentLoading: true, recentError: "" });
    try {
      const res = await callItemsApi({ action: "list" });
      this.setData({ recentItems: toDisplayItems(res.items) });
    } catch (e) {
      this.setData({ recentError: errorMessage(e) });
    } finally {
      this.setData({ recentLoading: false });
    }
  },

  openItem(item: DisplayItem) {
    wx.navigateTo({
      url: "/pages/item/item?data=" + encodeURIComponent(JSON.stringify(item)),
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  goToConfirm(url: string) {
    wx.navigateTo({
      url,
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },
});

/** 切换/离开时若仍在录音,标记取消并停止(不产生识别结果) */
function markVoiceCancelledIfRecording(page: {
  voiceCtrl: VoiceController | null;
  data: { voiceState: "idle" | "recording" | "cancelPending" };
}): void {
  if (page.data.voiceState !== "idle") {
    markVoiceCancelled();
    if (page.voiceCtrl !== null) {
      page.voiceCtrl.stop();
    }
  }
}
