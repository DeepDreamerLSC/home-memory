import {
  callItemsApi,
  errorMessage,
  formatDateTime,
} from "../../utils/api";
import { attachVoiceEntry, type VoiceEntryHandle } from "../../utils/voice-entry";
import type { ItemSummary } from "../../types";
import { getUnfinishedDraftSession } from "../../utils/draft-session";
import {
  householdSelfProfile,
  householdScopeName,
  isHouseholdScopeShared,
} from "../../utils/household-scope";
import { updateHouseholdProfile } from "../../utils/households-api";
import { ensureScopeVerified } from "../../utils/households-api";
import { captureScopeGeneration, isScopeGenerationCurrent } from "../../utils/household-scope";

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
    /** 记一件的输入方式:text 文字 / voice 按住说话(默认语音:语音极速录入是核心场景) */
    inputMode: "text" | "voice";
    /** 语音状态:idle 空闲 / recording 录音中 / cancelPending 已上滑待松手 */
    voiceState: "idle" | "recording" | "cancelPending";
    /** 录音停止后云端识别中 */
    transcribing: boolean;
    /** 本次录音秒数(展示用) */
    recordSeconds: number;
    /** 录音中/识别中的提示文本 */
    partialText: string;
    /** 未完成草稿会话恢复入口(非空时显示横幅) */
    resumeSession: { sid: string; count: number } | null;
    /** 主页头像栏:共享家庭标识/本人资料/昵称弹窗 */
    familyShared: boolean;
    selfNick: string;
    selfAvatar: string;
    nickModalOpen: boolean;
    nickDraft: string;
    pendingAvatarTemp: string;
    profileSaving: boolean;
  },
  {
    onMemoInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    refreshProfileBar(): void;
  onHomeAvatarChosen(e: WechatMiniprogram.CustomEvent): void;
  onHomeAvatarPersonalTap(): void;
  onNickDraftInput(e: WechatMiniprogram.CustomEvent): void;
  onNickModalCancel(): void;
  onNickModalSave(): Promise<void>;
  onLoad(options: Record<string, string | undefined>): void;
    onModeText(): void;
    onModeVoice(): void;
    ensureVoiceEntry(): void;
    /** 语音录入入口共享句柄(单例模块;页面加载即挂,卸载时解除) */
    voiceEntry: VoiceEntryHandle | null;
    onExtractTap(): void;
    onQueryInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onQueryTap(): Promise<void>;
    onResultTap(e: WechatMiniprogram.CustomEvent): void;
    onRecentTap(e: WechatMiniprogram.CustomEvent): void;
    onResumeTap(): void;
    /** 未完成草稿恢复入口数据(作用域键隔离;null = 当前家庭无未完成批次) */
    currentResumeSession(): { sid: string; count: number } | null;
    loadRecent(): Promise<void>;
    openItem(item: DisplayItem): void;
    goToConfirm(url: string): void;
    /** 「我的家」次级入口:进空间树浏览页(不抢语音主入口) */
    onHomeTreeTap(): void;
    /** 「家庭」次级入口:进家庭管理页(创建/邀请/退出,issue #34 P1-B) */
    onFamilyTap(): void;
    onTalkTouchStart(e: WechatMiniprogram.TouchEvent): void;
    onTalkTouchMove(e: WechatMiniprogram.TouchEvent): void;
    onTalkTouchEnd(): void;
    onTalkTouchCancel(): void;
    voiceFallbackToText(): void;
  }
>({
  data: {
    familyShared: false,
    selfNick: "",
    selfAvatar: "",
    nickModalOpen: false,
    nickDraft: "",
    pendingAvatarTemp: "",
    profileSaving: false,
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
    inputMode: "voice",
    /** 未完成草稿会话恢复入口(非空时显示横幅) */
    resumeSession: null as { sid: string; count: number } | null,
    voiceState: "idle",
    transcribing: false,
    recordSeconds: 0,
    partialText: "",
  },

  voiceEntry: null,

  onLoad(options) {
    this.ensureVoiceEntry();
    // 邀请卡片落地兜底(issue #34 P1-B):分享卡片 path 指向加入确认页,
    // 冷启动直达;若有其他入口把 invite 带到首页,转送加入确认页(一步确认)
    const invite = options && options.invite ? String(options.invite).trim() : "";
    if (invite) {
      wx.navigateTo({
        url: "/pages/join-family/join-family?invite=" + encodeURIComponent(invite),
        fail: () => {
          wx.showToast({ title: "邀请打开失败,请重试", icon: "none" });
        },
      });
    }
  },

  /** 头像栏状态刷新(来自 household-scope 记忆;app 前台复核后已最新) */
  refreshProfileBar() {
    const prof = householdSelfProfile();
    this.setData({
      familyShared: isHouseholdScopeShared(),
      selfNick: prof.nickname || "",
      selfAvatar: prof.avatarFileId || "",
    });
    void this.setData({ familyNameTip: householdScopeName() || "" });
  },

  /** 选完头像:弹昵称弹窗(一起保存;取消丢弃) */
  onHomeAvatarChosen(e) {
    const url = e.detail && e.detail.avatarUrl;
    if (typeof url !== "string" || url.length === 0) {
      return;
    }
    this.setData({ pendingAvatarTemp: url, nickModalOpen: true, nickDraft: this.data.selfNick });
  },

  /** 个人家庭:如实提示(资料是家庭成员间的展示,非账号体系) */
  onHomeAvatarPersonalTap() {
    wx.showModal({
      title: "头像与昵称",
      content: "头像昵称是给共享家庭的家人看的。创建或加入共享家庭后,在这里点一下即可设置。",
      showCancel: false,
      confirmText: "知道了",
    });
  },

  onNickDraftInput(e) {
    this.setData({ nickDraft: (e.detail.value || "").trim() });
  },

  onNickModalCancel() {
    this.setData({ nickModalOpen: false, pendingAvatarTemp: "", nickDraft: "" });
  },

  /** 保存:头像传云存储 → updateProfile → 本地记忆/头像栏更新 */
  async onNickModalSave() {
    if (this.data.profileSaving) {
      return;
    }
    const patch: { nickname?: string; avatar_file_id?: string } = {};
    const nick = this.data.nickDraft.trim();
    if (nick !== "") {
      patch.nickname = nick;
    }
    this.setData({ profileSaving: true });
    try {
      if (this.data.pendingAvatarTemp) {
        const up = await wx.cloud.uploadFile({
          cloudPath:
            "household-avatars/" +
            Date.now() +
            "-" +
            Math.floor(Math.random() * 1000000) +
            ".jpg",
          filePath: this.data.pendingAvatarTemp,
        });
        if (up.fileID) {
          patch.avatar_file_id = up.fileID;
        }
      }
      if (Object.keys(patch).length === 0) {
        wx.showToast({ title: "填个昵称或选个头像再保存", icon: "none" });
        return;
      }
      await updateHouseholdProfile(patch);
      wx.showToast({ title: "已保存", icon: "success" });
      this.setData({ nickModalOpen: false, pendingAvatarTemp: "", nickDraft: "" });
      this.refreshProfileBar();
    } catch (e) {
      wx.showModal({ title: "保存失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ profileSaving: false });
    }
  },

  onShow() {
    this.refreshProfileBar();
    void this.loadRecent();
    // 未完成草稿会话恢复入口(中途退出/进程回收;原幂等键续存,不重复建档)。
    // 展示前资格复核(硬门 C):先等服务端家庭上下文验证,未验证期间不把
    // 旧家庭的未完成批次当作当前可访问内容展示;验证失败时保持无横幅
    // (loadRecent 的 list 响应也会捕获作用域并标记已验证)
    void ensureScopeVerified().then(() => {
      this.setData({ resumeSession: this.currentResumeSession() });
    });
  },

  onHide() {
    if (this.voiceEntry !== null) {
      this.voiceEntry.invalidate();
    }
  },

  onUnload() {
    if (this.voiceEntry !== null) {
      this.voiceEntry.invalidate();
      this.voiceEntry.detach();
      this.voiceEntry = null;
    }
  },

  onMemoInput(e) {
    this.setData({ memoText: e.detail && e.detail.value ? e.detail.value : "" });
  },

  onModeText() {
    if (this.voiceEntry !== null) {
      this.voiceEntry.invalidate();
    }
    this.setData({ inputMode: "text", voiceState: "idle", transcribing: false, partialText: "" });
  },

  onModeVoice() {
    this.setData({ inputMode: "voice", voiceState: "idle", transcribing: false, partialText: "", recordSeconds: 0 });
    this.ensureVoiceEntry();
  },

  /**
   * 语音录入入口(utils/voice-entry 单例共享模块):
   * 会话守卫/忙碌门禁/录音转写提取/跳确认全在模块内,本页只挂宿主(渲染+文字回退)。
   */
  ensureVoiceEntry() {
    if (this.voiceEntry !== null) {
      return;
    }
    this.voiceEntry = attachVoiceEntry({
      onStateChange: (s) => {
        this.setData({
          voiceState: s.voiceState,
          transcribing: s.transcribing,
          extracting: s.extracting,
          recordSeconds: s.recordSeconds,
          partialText: s.partialText,
        });
      },
      onTranscript: (text) => {
        // 转写文本同步 memoText:切「改用文字」时输入仍在(不丢用户文本)
        this.setData({ memoText: text });
      },
      fallbackToText: () => {
        this.voiceFallbackToText();
      },
    });
  },

  onTalkTouchStart(e) {
    if (this.voiceEntry === null) {
      return;
    }
    const touch = e.touches && e.touches[0];
    this.voiceEntry.pressStart(touch ? touch.clientY : 0);
  },

  onTalkTouchMove(e) {
    if (this.voiceEntry === null) {
      return;
    }
    const touch = e.touches && e.touches[0];
    if (!touch) {
      return;
    }
    this.voiceEntry.pressMove(touch.clientY);
  },

  onTalkTouchEnd() {
    if (this.voiceEntry !== null) {
      this.voiceEntry.pressEnd();
    }
  },

  onTalkTouchCancel() {
    if (this.voiceEntry !== null) {
      this.voiceEntry.pressCancel();
    }
  },

  voiceFallbackToText() {
    if (this.voiceEntry !== null) {
      this.voiceEntry.invalidate();
    }
    this.setData({ inputMode: "text", voiceState: "idle", transcribing: false, partialText: "" });
  },

  /** 记一件(文字模式):textarea 内容走共享提取链路(三选门→提取→跳确认) */
  onExtractTap() {
    if (this.voiceEntry === null) {
      return;
    }
    void this.voiceEntry.extract(this.data.memoText);
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

  onResumeTap() {
    const resume = this.data.resumeSession;
    if (resume === null) {
      return;
    }
    this.setData({ resumeSession: null });
    this.goToConfirm("/pages/confirm/confirm?sid=" + resume.sid);
  },

  /** 未完成批次数据按当前家庭作用域读取(键隔离,P0;验证后才读,硬门 C) */
  currentResumeSession() {
    const unfinished = getUnfinishedDraftSession();
    if (unfinished === null) {
      return null;
    }
    return { sid: unfinished.sid, count: unfinished.payload.drafts.length };
  },

  onRecentTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.recentItems[index];
    if (item) {
      this.openItem(item);
    }
  },

  /** 最近记录:itemsApi list;家庭切换(作用域代数变化)后的迟到响应不上屏 */
  async loadRecent() {
    const scopeGen = captureScopeGeneration();
    this.setData({ recentLoading: true, recentError: "" });
    try {
      const res = await callItemsApi({ action: "list" });
      if (!isScopeGenerationCurrent(scopeGen)) {
        return; // 家庭刚切换(创建/加入/退出/被移除):旧家庭响应不上屏
      }
      this.setData({ recentItems: toDisplayItems(res.items) });
    } catch (e) {
      if (!isScopeGenerationCurrent(scopeGen)) {
        return;
      }
      this.setData({ recentError: errorMessage(e) });
    } finally {
      if (isScopeGenerationCurrent(scopeGen)) {
        this.setData({ recentLoading: false });
      }
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

  onHomeTreeTap() {
    wx.navigateTo({
      url: "/pages/locations/locations",
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  /** 家庭管理页入口(issue #34 P1-B:创建/邀请/成员/退出/解散) */
  onFamilyTap() {
    wx.navigateTo({
      url: "/pages/family/family",
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },
});
