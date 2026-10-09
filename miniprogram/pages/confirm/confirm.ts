import { callItemsApi, errorMessage, uuid } from "../../utils/api";
import type { Draft } from "../../types";

/** 页面 query 参数不会自动解码;容错解码(已解码或含非法 % 时原样返回) */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

Page<
  {
    /** true 表示手动录入模式(空白表单) */
    isManual: boolean;
    /** AI 是否确定位置(仅 AI 草稿模式有意义) */
    certain: boolean;
    qualifiersText: string;
    name: string;
    locationText: string;
    note: string;
    saving: boolean;
    /** 创建幂等键:同一确认页实例内重试复用同一个,由服务端去重 */
    operationId: string;
  },
  {
    onNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onLocationInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onNoteInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onSaveTap(): Promise<void>;
    backToHome(): void;
  }
>({
  data: {
    isManual: false,
    certain: true,
    qualifiersText: "",
    name: "",
    locationText: "",
    note: "",
    saving: false,
    operationId: "",
  },

  onLoad(options) {
    const operationId = uuid();
    if (options.manual === "true") {
      this.setData({ operationId, isManual: true });
      return;
    }
    const raw = options.draft;
    if (raw) {
      try {
        const parsed = JSON.parse(safeDecode(raw)) as Partial<Draft>;
        const name = typeof parsed.name === "string" ? parsed.name : "";
        const locationText =
          typeof parsed.location_text === "string" ? parsed.location_text : "";
        const certain = parsed.certain === true;
        const qualifiers = Array.isArray(parsed.qualifiers)
          ? parsed.qualifiers
              .filter((q): q is string => typeof q === "string")
              .slice(0, 5)
          : [];
        this.setData({
          operationId,
          isManual: false,
          certain,
          qualifiersText: qualifiers.join("、"),
          name,
          locationText,
          note: "",
        });
        return;
      } catch (e) {
        console.error("[confirm] 草稿解析失败", e);
        wx.showToast({
          title: "草稿加载失败,请手动填写",
          icon: "none",
          duration: 2500,
        });
      }
    }
    this.setData({ operationId, isManual: true });
  },

  onNameInput(e) {
    this.setData({ name: e.detail && e.detail.value ? e.detail.value : "" });
  },

  onLocationInput(e) {
    this.setData({
      locationText: e.detail && e.detail.value ? e.detail.value : "",
    });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail && e.detail.value ? e.detail.value : "" });
  },

  /** 保存:itemsApi create,成功 toast「已记住」返回首页 */
  async onSaveTap() {
    if (this.data.saving) {
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
    this.setData({ saving: true });
    try {
      await callItemsApi({
        action: "create",
        operation_id: this.data.operationId,
        name,
        location_text: locationText,
        note,
      });
      wx.showToast({ title: "已记住", icon: "success" });
      setTimeout(() => {
        this.backToHome();
      }, 800);
    } catch (e) {
      wx.showModal({
        title: "保存失败",
        content: errorMessage(e),
        showCancel: false,
      });
    } finally {
      this.setData({ saving: false });
    }
  },

  backToHome() {
    wx.navigateBack({
      fail: () => {
        wx.reLaunch({ url: "/pages/index/index" });
      },
    });
  },
});
