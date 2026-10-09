import {
  ApiError,
  callItemsApi,
  errorMessage,
  formatDateTime,
} from "../../utils/api";
import type { ItemSummary } from "../../types";

/** 页面 query 参数不会自动解码;容错解码(已解码或含非法 % 时原样返回) */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 刷新最新数据的结果 */
type RefreshResult = "refreshed" | "notfound" | "error";

Page<
  {
    itemId: string;
    name: string;
    locationText: string;
    note: string;
    version: number;
    updatedAtText: string;
    saving: boolean;
    deleting: boolean;
  },
  {
    original: { name: string; location: string; note: string };
    onNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onLocationInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onNoteInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onSaveTap(): Promise<void>;
    onDeleteTap(): void;
    confirmDelete(): Promise<void>;
    refreshLatest(): Promise<RefreshResult>;
    applySummary(s: ItemSummary): void;
    goBack(): void;
  }
>({
  data: {
    itemId: "",
    name: "",
    locationText: "",
    note: "",
    version: 0,
    updatedAtText: "",
    saving: false,
    deleting: false,
  },

  /** 最近一次加载到的内容,用于判断是否有修改 */
  original: { name: "", location: "", note: "" },

  onLoad(options) {
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

  applySummary(s: ItemSummary) {
    this.original = {
      name: s.name,
      location: s.location_text,
      note: s.note,
    };
    this.setData({
      itemId: s.item_id,
      name: s.name,
      locationText: s.location_text,
      note: s.note,
      version: s.version,
      updatedAtText: formatDateTime(s.updated_at),
    });
  },

  /** 保存修改:itemsApi update,带 expected_version */
  async onSaveTap() {
    if (this.data.saving || this.data.deleting) {
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
    const changes: { name?: string; location_text?: string; note?: string } = {};
    if (name !== this.original.name) {
      changes.name = name;
    }
    if (locationText !== this.original.location) {
      changes.location_text = locationText;
    }
    if (note !== this.original.note) {
      changes.note = note;
    }
    if (Object.keys(changes).length === 0) {
      wx.showToast({ title: "内容没有变化", icon: "none" });
      return;
    }
    this.setData({ saving: true });
    try {
      const res = await callItemsApi({
        action: "update",
        item_id: this.data.itemId,
        expected_version: this.data.version,
        ...changes,
      });
      const it = res.item;
      this.applySummary({
        item_id: it._id,
        name: it.name,
        location_text: it.location_text,
        note: it.note,
        version: it.version,
        updated_at: it.updated_at,
      });
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        // 契约要求:提示后拉取最新内容,让用户基于最新版本重试
        wx.showToast({
          title: "内容已被修改,已为你刷新,请重试",
          icon: "none",
          duration: 2500,
        });
        const result = await this.refreshLatest();
        if (result === "notfound") {
          wx.showModal({
            title: "记录不存在",
            content: "没有找到这条记录,可能已被删除。",
            showCancel: false,
            success: () => {
              this.goBack();
            },
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

  /** 拉取最新内容:契约没有按 id 单查的 action,用 list 后按 item_id 查找 */
  async refreshLatest(): Promise<RefreshResult> {
    try {
      const res = await callItemsApi({ action: "list" });
      const found = res.items.find((s) => s.item_id === this.data.itemId);
      if (!found) {
        return "notfound";
      }
      this.applySummary(found);
      return "refreshed";
    } catch (e) {
      wx.showModal({
        title: "刷新失败",
        content: errorMessage(e),
        showCancel: false,
      });
      return "error";
    }
  },

  /** 删除:先 wx.showModal 确认 */
  onDeleteTap() {
    if (this.data.saving || this.data.deleting) {
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
});
