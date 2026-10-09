import {
  ApiError,
  callItemsApi,
  errorMessage,
  formatDateTime,
  uuid,
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

  /**
   * 上一次保存失败的更新(update_id + 内容):同样内容的重试复用同一个 update_id,
   * 服务端据此识别「自己刚写入但响应丢失」的重放,返回 replayed 而非误报版本冲突。
   * 内容一变(新的逻辑修改)即作废,下次保存生成新 update_id。
   */
  pendingRetry: {
    updateId: string;
    changes: { name?: string; location_text?: string; note?: string };
  } | null;
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

  pendingRetry: null as {
    updateId: string;
    changes: { name?: string; location_text?: string; note?: string };
  } | null,

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
    // 同样内容的重试复用同一 update_id:服务端据此把「自己刚写入但响应丢失」的重放
    // 识别为 replayed 成功,而不是误报 VERSION_CONFLICT;内容一变即生成新 update_id。
    const retry = this.pendingRetry;
    const samePayload =
      retry !== null &&
      retry.changes.name === changes.name &&
      retry.changes.location_text === changes.location_text &&
      retry.changes.note === changes.note;
    const updateId = samePayload ? retry.updateId : uuid();
    this.setData({ saving: true });
    try {
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
      });
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (e) {
      // 记录失败的更新供重试复用 update_id(仅同样内容的重试)
      this.pendingRetry = { updateId, changes };
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        // 提示后只对齐版本与元数据,保留用户未保存的编辑(绝不无提示覆盖)
        wx.showToast({
          title: "内容已被修改,已更新版本号,请检查后重试",
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

  /**
   * 拉取最新内容(get 按 id 单查,不受 list 分页截断影响)。
   * 只对齐版本号/更新时间/基准内容,不覆盖表单里用户未保存的编辑。
   */
  async refreshLatest(): Promise<RefreshResult> {
    try {
      const res = await callItemsApi({ action: "get", item_id: this.data.itemId });
      // 字段级三方合并:用户真正编辑过的字段(与刷新前基准不同)保留用户的未提交编辑;
      // 未编辑的字段采纳服务端最新值(可能来自另一设备),避免下次保存把别处的新改动连带覆盖。
      const prev = this.original;
      const mergedName =
        this.data.name.trim() !== prev.name ? this.data.name : res.item.name;
      const mergedLocation =
        this.data.locationText.trim() !== prev.location
          ? this.data.locationText
          : res.item.location_text;
      const mergedNote =
        this.data.note.trim() !== prev.note ? this.data.note : res.item.note;
      this.original = {
        name: res.item.name,
        location: res.item.location_text,
        note: res.item.note,
      };
      this.setData({
        name: mergedName,
        locationText: mergedLocation,
        note: mergedNote,
        version: res.item.version,
        updatedAtText: formatDateTime(res.item.updated_at),
      });
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
