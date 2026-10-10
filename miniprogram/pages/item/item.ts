import {
  ApiError,
  callItemsApi,
  errorMessage,
  formatDateTime,
  uuid,
} from "../../utils/api";
import {
  buildUpdateChanges,
  chosenValue,
  mergeLatest,
} from "../../utils/conflict";
import type { ConflictChoice, ConflictField, EditableField } from "../../utils/conflict";
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

/** 冲突态面板里的单个字段条目:两版值 + 用户显式选择(null 表示尚未选择) */
type ConflictEntry = ConflictField & { choice: ConflictChoice | null };

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
    /** 版本冲突后待处理的冲突字段;为空表示无冲突态 */
    conflicts: ConflictEntry[];
    /** 存在未选择的冲突字段时禁止再次保存(按钮禁用 + 双保险门禁) */
    conflictPending: boolean;
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
    onChooseLocal(e: WechatMiniprogram.BaseEvent): void;
    onChooseRemote(e: WechatMiniprogram.BaseEvent): void;
    applyConflictChoice(key: EditableField, choice: ConflictChoice): void;
    syncConflictFromInput(key: EditableField, value: string): void;
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
    conflicts: [] as ConflictEntry[],
    conflictPending: false,
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

  /**
   * 冲突态下用户直接编辑了冲突字段:视为对「你的修改」的最新表达,
   * 同步面板上的本地值并按「保留我的修改」计;程序 setData 不触发 input 事件,
   * 不会干扰「采用最新记录」按钮写入的值。
   */
  syncConflictFromInput(key: EditableField, value: string): void {
    const idx = this.data.conflicts.findIndex((c) => c.key === key);
    if (idx < 0) {
      return;
    }
    const entry = this.data.conflicts[idx];
    const patch: Record<string, unknown> = {};
    if (entry.localValue !== value.trim()) {
      patch["conflicts[" + idx + "].localValue"] = value.trim();
    }
    if (entry.choice !== "local") {
      patch["conflicts[" + idx + "].choice"] = "local";
      patch.conflictPending = this.data.conflicts.some(
        (c, i) => i !== idx && !c.choice
      );
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
    this.setData({
      // 选定值回填表单:选远端即与最新基准一致(保存时无变化、不自动再写);
      // 选本地则保留用户值,下次保存以最新 expected_version 提交该字段。
      [key === "location" ? "locationText" : key]: chosenValue(entry, choice),
      ["conflicts[" + idx + "].choice"]: choice,
      conflictPending: this.data.conflicts.some(
        (c, i) => i !== idx && !c.choice
      ),
    });
  },

  onChooseLocal(e) {
    const key = e.currentTarget.dataset.key as EditableField;
    this.applyConflictChoice(key, "local");
  },

  onChooseRemote(e) {
    const key = e.currentTarget.dataset.key as EditableField;
    this.applyConflictChoice(key, "remote");
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
      conflicts: [],
      conflictPending: false,
    });
  },

  /** 保存修改:itemsApi update,带 expected_version */
  async onSaveTap() {
    if (this.data.saving || this.data.deleting) {
      return;
    }
    if (this.data.conflictPending) {
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
        // 刷新后:无冲突字段则维持原提示(静默三方合并);有冲突字段则进入冲突态,
        // 面板逐字段并排展示「你的修改」与「最新记录」,选择后才允许再次提交。
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
   * 拉取最新内容(get 按 id 单查,不受 list 分页截断影响)。
   * 只对齐版本号/更新时间/基准内容,不覆盖表单里用户未保存的编辑:
   * - 非冲突字段:三方合并(用户改过保留用户值,否则采纳服务端值),与既有语义一致;
   * - 冲突字段(双方都改且互不相同):进入冲突态,由用户显式选择,不做静默合并。
   */
  async refreshLatest(): Promise<RefreshResult> {
    try {
      const res = await callItemsApi({ action: "get", item_id: this.data.itemId });
      const outcome = mergeLatest(
        this.original,
        {
          name: this.data.name.trim(),
          location: this.data.locationText.trim(),
          note: this.data.note.trim(),
        },
        {
          name: res.item.name,
          location: res.item.location_text,
          note: res.item.note,
        }
      );
      this.original = {
        name: res.item.name,
        location: res.item.location_text,
        note: res.item.note,
      };
      this.setData({
        name: outcome.merged.name,
        locationText: outcome.merged.location,
        note: outcome.merged.note,
        version: res.item.version,
        updatedAtText: formatDateTime(res.item.updated_at),
        conflicts: outcome.conflicts.map((c) => ({ ...c, choice: null })),
        conflictPending: outcome.conflicts.length > 0,
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
