import {
  callLocationsApi,
  isLocationsApiErrorWithCode,
} from "../../utils/locations-api";
import {
  createRequestSeq,
  isLocationsCacheFresh,
  planLocationsLoad,
  readLocationsLayer,
  writeLocationsLayer,
} from "../../utils/locations-cache";
import type { LocationsRequestSeq } from "../../utils/locations-cache";
import { errorMessage, formatDateTime, uuid } from "../../utils/api";
import type {
  ItemSummary,
  ListLocationsResponse,
  LocationNodeSummary,
  LocationType,
} from "../../types";

/** 选择模式回传给发起页的节点 */
interface PickedLocation {
  location_id: string;
  name: string;
  type: LocationType;
  path: string[];
}

/** 用于渲染的子节点(附展示文案与选择模式的禁用原因) */
type DisplayNode = LocationNodeSummary & {
  typeText: string;
  countText: string;
  disabled: boolean;
  disabledReason: string;
};

/** 用于渲染的物品条目(附格式化后的更新时间) */
type DisplayItem = ItemSummary & { updated_at_text: string };

const TYPE_TEXT: Record<LocationType, string> = {
  home: "",
  room: "房间",
  furniture: "家具",
  container: "容器",
};

/** 页面 query 参数不会自动解码;容错解码(已解码或含非法 % 时原样返回) */
function safeDecode(s: string | undefined): string {
  if (!s) {
    return "";
  }
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

Page<
  {
    /** browse = 空间浏览;pick = 选择模式(移动/合并/物品移动的目标选择) */
    mode: "browse" | "pick";
    pickTitle: string;
    /** 无缓存首载:整页骨架屏(约束 1:不再是干巴巴一行「加载中」) */
    loading: boolean;
    /** 屏上已有旧树、后台刷新中:轻量指示,不整页 loading */
    refreshing: boolean;
    /** 后台刷新失败:保留旧树,如实提示「当前为上次记录」+ 可重试 */
    stale: boolean;
    loadError: string;
    breadcrumbText: string;
    isRoot: boolean;
    children: DisplayNode[];
    items: DisplayItem[];
    unmountedCount: number;
    danglingMounts: number;
    hasRooms: boolean;
    canScan: boolean;
    /** 结构操作进行中(rename/move/merge/delete/add),防止并发重复提交 */
    acting: boolean;
  },
  {
    nodeId: string;
    /** 当前节点的完整 path(根层为空数组);手动添加子位置时作前缀 */
    nodePath: string[];
    /** 选择模式的类型过滤(空串 = 不限;merge 只列同 type) */
    pickType: string;
    /** 选择模式排除的子树(exclude 节点 path + 自身名 join "/"),空串 = 无排除 */
    pickExcludePath: string;
    /** 发起页注册的选择回调(picker 选中回传后执行 move/merge/linkItem) */
    pendingPick: ((picked: PickedLocation) => void) | null;
    /** 请求序号(约束 4):迟到响应不上屏、不写缓存 */
    requestSeq: LocationsRequestSeq;
    /** 本页实例是否已上屏过任意 list 内容(缓存或服务端),决定骨架还是轻量刷新 */
    renderedOnce: boolean;
    onLoad(options: Record<string, string | undefined>): void;
    onShow(): void;
    onPullDownRefresh(): void;
    loadNode(force?: boolean): Promise<void>;
    renderList(res: ListLocationsResponse): void;
    onRetryTap(): void;
    decorate(children: LocationNodeSummary[]): DisplayNode[];
    onChildTap(e: WechatMiniprogram.CustomEvent): void;
    onPickTap(e: WechatMiniprogram.CustomEvent): void;
    onChildMore(e: WechatMiniprogram.CustomEvent): void;
    showNodeActions(node: DisplayNode): void;
    renameNode(node: DisplayNode): void;
    doRename(node: DisplayNode, name: string): Promise<void>;
    moveNode(node: DisplayNode): void;
    doMove(node: DisplayNode, newParentId: string): Promise<void>;
    mergeNode(node: DisplayNode): void;
    doMerge(node: DisplayNode, targetId: string): Promise<void>;
    deleteNode(node: DisplayNode): void;
    doDelete(node: DisplayNode, force: boolean): Promise<void>;
    handleNotEmpty(node: DisplayNode, detail: Record<string, unknown> | undefined): void;
    onAddTap(): void;
    doAdd(name: string): Promise<void>;
    onScanTap(): void;
    onItemTap(e: WechatMiniprogram.CustomEvent): void;
    onItemMore(e: WechatMiniprogram.CustomEvent): void;
    moveItem(item: DisplayItem): void;
    doMoveItem(item: DisplayItem, nodeId: string): Promise<void>;
    unlinkItem(item: DisplayItem): void;
    doUnlink(item: DisplayItem): Promise<void>;
    openItem(item: DisplayItem): void;
    openPicker(
      title: string,
      opts: { type?: string; excludePath?: string },
      onPick: (picked: PickedLocation) => void,
    ): void;
    finishPick(node: DisplayNode): void;
    childAt(index: number): DisplayNode | undefined;
    itemAt(index: number): DisplayItem | undefined;
    goScan(): void;
  }
>({
  data: {
    mode: "browse",
    pickTitle: "选择位置",
    loading: false,
    refreshing: false,
    stale: false,
    loadError: "",
    breadcrumbText: "我的家",
    isRoot: true,
    children: [],
    items: [],
    unmountedCount: 0,
    danglingMounts: 0,
    hasRooms: false,
    canScan: false,
    acting: false,
  },

  nodeId: "",
  nodePath: [] as string[],
  pickType: "",
  pickExcludePath: "",
  pendingPick: null as ((picked: PickedLocation) => void) | null,
  requestSeq: createRequestSeq(),
  renderedOnce: false,

  onLoad(options) {
    // 按页面实例创建请求序号(Page options 会被浅拷贝共享,不能在 options 里建闭包)
    this.requestSeq = createRequestSeq();
    this.renderedOnce = false;
    const isPicker = options.picker === "1";
    this.nodeId = safeDecode(options.node_id);
    this.pickType = isPicker ? safeDecode(options.type) : "";
    this.pickExcludePath = isPicker ? safeDecode(options.exclude_path) : "";
    this.setData({
      mode: isPicker ? "pick" : "browse",
      pickTitle: isPicker ? safeDecode(options.title) || "选择位置" : "选择位置",
    });
    if (isPicker) {
      wx.setNavigationBarTitle({
        title: safeDecode(options.title) || "选择位置",
        fail: () => {},
      });
    }
  },

  onShow() {
    void this.loadNode();
  },

  /** 下拉刷新:强制绕过 TTL 直连服务端,完成后收起原生转圈(约束 1/3) */
  async onPullDownRefresh() {
    try {
      await this.loadNode(true);
    } finally {
      wx.stopPullDownRefresh({ fail: () => {} });
    }
  },

  /** 失败态重试按钮 / 「上次记录」提示条:点按强制刷新 */
  onRetryTap() {
    void this.loadNode(true);
  },

  /**
   * 拉取当前层:缓存先行 + 条件刷新(issue #23,感知层优化——冷启动客观时长不变)。
   * force=true(下拉/重试)绕过 TTL 直连服务端;选择模式(picker)一律直连,
   * 它是影响真实数据操作前的重新校验。迟到响应(序号不匹配)不上屏、不写缓存。
   */
  async loadNode(force?: boolean): Promise<void> {
    const seq = this.requestSeq.next();
    const pickMode = this.data.mode === "pick";
    const cached = pickMode ? null : readLocationsLayer(this.nodeId);
    const plan = planLocationsLoad({
      cached,
      fresh: cached !== null && isLocationsCacheFresh(cached),
      force: force === true,
      pickMode,
      rendered: this.renderedOnce,
    });
    if (plan.useCache && cached !== null) {
      // 缓存先行上屏:有旧树绝不整页 loading
      this.renderList(cached.response);
    }
    this.setData({
      loading: plan.skeleton,
      refreshing: plan.fetch && !plan.skeleton,
      stale: false,
      loadError: "",
    });
    if (!plan.fetch) {
      // TTL 内直接用缓存、不触发云函数:降低冷启动触发频率的主路径
      return;
    }
    try {
      const res = await callLocationsApi(
        this.nodeId
          ? { action: "list", parent_id: this.nodeId }
          : { action: "list" },
      );
      if (!this.requestSeq.isCurrent(seq)) {
        return; // 迟到响应:既不 setData 也不写缓存(约束 4)
      }
      writeLocationsLayer(this.nodeId, res);
      this.renderList(res); // 刷新成功:原位 setData 更新,不闪屏
      this.setData({ loading: false, refreshing: false, stale: false, loadError: "" });
    } catch (e) {
      if (!this.requestSeq.isCurrent(seq)) {
        return;
      }
      if (this.renderedOnce) {
        // 刷新失败:保留旧树 + 如实提示可重试;不更新缓存的任何时间戳(约束 1/3)
        this.setData({ loading: false, refreshing: false, stale: true });
      } else {
        this.setData({ loading: false, refreshing: false, loadError: errorMessage(e) });
      }
    }
  },

  /** list 响应(缓存或服务端)→ 上屏数据;原位 setData */
  renderList(res: ListLocationsResponse) {
    const isRoot = res.node.type === "home";
    this.nodePath = res.node.path || [];
    const items: DisplayItem[] = res.items.map((it) => ({
      ...it,
      updated_at_text: formatDateTime(it.updated_at),
    }));
    this.renderedOnce = true;
    this.setData({
      breadcrumbText: isRoot
        ? "我的家"
        : "我的家 / " + res.node.path.join(" / "),
      isRoot,
      children: this.decorate(res.children),
      items,
      unmountedCount: res.unmounted_count,
      danglingMounts: res.dangling_mounts,
      hasRooms: res.children.length > 0,
      canScan: res.unmounted_count > 0,
    });
  },

  /** 子节点渲染装饰:类型/计数文案;选择模式下计算禁用与原因 */
  decorate(children) {
    const pickMode = this.data.mode === "pick";
    return children.map((c) => {
      let disabled = false;
      let disabledReason = "";
      if (pickMode) {
        if (this.pickExcludePath) {
          const p = c.path.join("/");
          if (
            p === this.pickExcludePath ||
            p.indexOf(this.pickExcludePath + "/") === 0
          ) {
            disabled = true;
            disabledReason = "不能选它自己";
          }
        }
        if (!disabled && this.pickType && c.type !== this.pickType) {
          disabled = true;
          disabledReason = "类型不同,不能合并到这里";
        }
      }
      const parts: string[] = [];
      if (c.item_count > 0) {
        parts.push(c.item_count + " 件");
      }
      if (c.child_count > 0) {
        parts.push(c.child_count + " 个子位置");
      }
      return {
        ...c,
        typeText: TYPE_TEXT[c.type] || "",
        countText: parts.length > 0 ? parts.join(" · ") : "空",
        disabled,
        disabledReason,
      };
    });
  },

  childAt(index) {
    const node = this.data.children[index];
    return node ? node : undefined;
  },

  itemAt(index) {
    const item = this.data.items[index];
    return item ? item : undefined;
  },

  /** 点子节点:下钻一层(选择模式也保留逐层下钻,过滤参数随行) */
  onChildTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    const node = this.childAt(index);
    if (!node) {
      return;
    }
    if (this.data.mode === "pick") {
      if (node.disabled) {
        wx.showToast({ title: node.disabledReason, icon: "none" });
        return;
      }
      if (node.child_count === 0) {
        // 叶子位置:点行主体即选中;有子位置的行点主体往下找,点「选这个」直接选
        this.finishPick(node);
        return;
      }
    }
    const params = ["node_id=" + encodeURIComponent(node.location_id)];
    if (this.data.mode === "pick") {
      params.push("picker=1");
      params.push("title=" + encodeURIComponent(this.data.pickTitle));
      if (this.pickType) {
        params.push("type=" + encodeURIComponent(this.pickType));
      }
      if (this.pickExcludePath) {
        params.push("exclude_path=" + encodeURIComponent(this.pickExcludePath));
      }
    }
    const url = "/pages/locations/locations?" + params.join("&");
    wx.navigateTo({
      url,
      fail: () => {
        // 页面栈满时退化为替换当前页(仍可逐层返回)
        wx.redirectTo({
          url,
          fail: () => {
            wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
          },
        });
      },
    });
  },

  /** 选择模式点「选这个」:选中回传给发起页(禁用项在行上如实标注原因,不出此按钮) */
  onPickTap(e) {
    if (this.data.mode !== "pick") {
      return;
    }
    const index = Number(e.currentTarget.dataset.index);
    const node = this.childAt(index);
    if (!node) {
      return;
    }
    if (node.disabled) {
      wx.showToast({ title: node.disabledReason, icon: "none" });
      return;
    }
    this.finishPick(node);
  },

  /** 子节点「⋯」:改名 / 移动 / 合并 / 删除(home 根不在列表,天然无此入口) */
  onChildMore(e) {
    if (this.data.mode !== "browse" || this.data.acting) {
      return;
    }
    const index = Number(e.currentTarget.dataset.index);
    const node = this.childAt(index);
    if (!node) {
      return;
    }
    this.showNodeActions(node);
  },

  showNodeActions(node) {
    wx.showActionSheet({
      itemList: ["改名", "移动到…", "合并到…", "删除"],
      success: (r) => {
        if (r.tapIndex === 0) {
          this.renameNode(node);
        } else if (r.tapIndex === 1) {
          this.moveNode(node);
        } else if (r.tapIndex === 2) {
          this.mergeNode(node);
        } else if (r.tapIndex === 3) {
          this.deleteNode(node);
        }
      },
      fail: () => {},
    });
  },

  renameNode(node) {
    wx.showModal({
      title: "改名",
      editable: true,
      placeholderText: node.name,
      success: (r) => {
        if (!r.confirm) {
          return;
        }
        const name = (r.content || "").trim();
        if (!name) {
          wx.showToast({ title: "名称不能为空", icon: "none" });
          return;
        }
        if (name === node.name) {
          return;
        }
        void this.doRename(node, name);
      },
    });
  },

  async doRename(node, name) {
    this.setData({ acting: true });
    try {
      await callLocationsApi({
        action: "rename",
        node_id: node.location_id,
        name,
      });
      wx.showToast({ title: "已改名", icon: "success" });
      await this.loadNode();
    } catch (e) {
      wx.showModal({ title: "改名失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 移动节点:进选择模式选「新父位置」(home 根不可作目标,服务端同理拒绝) */
  moveNode(node) {
    this.openPicker(
      "把「" + node.name + "」移到…",
      { excludePath: node.path.join("/") },
      (picked) => {
        void this.doMove(node, picked.location_id);
      },
    );
  },

  async doMove(node, newParentId) {
    if (this.data.acting) {
      return;
    }
    this.setData({ acting: true });
    try {
      await callLocationsApi({
        action: "move",
        node_id: node.location_id,
        new_parent_id: newParentId,
      });
      wx.showToast({ title: "已移动", icon: "success" });
      await this.loadNode();
    } catch (e) {
      wx.showModal({ title: "移动失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 合并重复节点:只列同类型位置;source 自己与其子树不可选 */
  mergeNode(node) {
    wx.showModal({
      title: "合并重复位置",
      content:
        "把「" + node.name + "」并进另一个同类型位置:物品会一起挪过去,这个位置会消失。继续?",
      confirmText: "选目标",
      cancelText: "取消",
      success: (r) => {
        if (!r.confirm) {
          return;
        }
        this.openPicker(
          "把「" + node.name + "」并进…",
          {
            type: node.type,
            excludePath: node.path.join("/"),
          },
          (picked) => {
            void this.doMerge(node, picked.location_id);
          },
        );
      },
    });
  },

  async doMerge(node, targetId) {
    if (this.data.acting) {
      return;
    }
    this.setData({ acting: true });
    try {
      const res = await callLocationsApi({
        action: "merge",
        source_node_id: node.location_id,
        target_node_id: targetId,
      });
      const comp = res.compensated || 0;
      wx.showToast({
        title:
          comp > 0
            ? "已合并;" + comp + " 件刚挂上来的物品已自动摘除"
            : "已合并",
        icon: comp > 0 ? "none" : "success",
        duration: comp > 0 ? 3000 : 1500,
      });
      await this.loadNode();
    } catch (e) {
      // merge 冲突中止是「可重试」的收敛语义:如实提示后由用户重走一次合并
      wx.showModal({ title: "合并失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 删除:先普通试探;NODE_NOT_EMPTY 按 detail 分流(有物品=引导移走,空分支=force 二次确认) */
  deleteNode(node) {
    wx.showModal({
      title: "删除位置",
      content: "删除「" + node.name + "」?",
      confirmText: "删除",
      confirmColor: "#d93025",
      cancelText: "取消",
      success: (r) => {
        if (r.confirm) {
          void this.doDelete(node, false);
        }
      },
    });
  },

  async doDelete(node, force) {
    if (this.data.acting) {
      return;
    }
    this.setData({ acting: true });
    try {
      const res = await callLocationsApi({
        action: "delete",
        node_id: node.location_id,
        force,
      });
      const comp = res.compensated || 0;
      wx.showToast({
        title:
          comp > 0
            ? "已删除;" + comp + " 件刚挂上来的物品已自动摘除"
            : "已删除",
        icon: comp > 0 ? "none" : "success",
        duration: comp > 0 ? 3000 : 1500,
      });
      await this.loadNode();
    } catch (e) {
      if (isLocationsApiErrorWithCode(e, "NODE_NOT_EMPTY")) {
        this.handleNotEmpty(node, e.detail);
        return;
      }
      wx.showModal({ title: "删除失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  handleNotEmpty(node, detail) {
    const itemCount = Number(detail && detail.item_count) || 0;
    const descendantCount = Number(detail && detail.descendant_count) || 0;
    if (itemCount > 0) {
      wx.showModal({
        title: "这里还有东西",
        content:
          "「" + node.name + "」里还有 " + itemCount + " 件物品" +
          (descendantCount > 0 ? "、" + descendantCount + " 个子位置" : "") +
          "。物品不能随位置一起删除,先把它们移走。",
        confirmText: "进去看看",
        cancelText: "取消",
        success: (r) => {
          if (r.confirm) {
            wx.navigateTo({
              url: "/pages/locations/locations?node_id=" + encodeURIComponent(node.location_id),
              fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
              },
            });
          }
        },
      });
      return;
    }
    wx.showModal({
      title: "整支删除",
      content:
        "「" + node.name + "」下还有 " + descendantCount +
        " 个空子位置,连同整支一起删除?",
      confirmText: "整支删除",
      confirmColor: "#d93025",
      cancelText: "取消",
      success: (r) => {
        if (r.confirm) {
          void this.doDelete(node, true);
        }
      },
    });
  },

  /** 手动添加子位置(根层=添加房间):ensurePath created_from:"manual" */
  onAddTap() {
    if (this.data.acting) {
      return;
    }
    const isRoot = this.data.isRoot;
    wx.showModal({
      title: isRoot ? "添加房间" : "添加位置",
      editable: true,
      placeholderText: isRoot ? "如:书房" : "如:第二个抽屉",
      success: (r) => {
        if (!r.confirm) {
          return;
        }
        const name = (r.content || "").trim();
        if (!name) {
          wx.showToast({ title: "名称不能为空", icon: "none" });
          return;
        }
        void this.doAdd(name);
      },
    });
  },

  async doAdd(name) {
    this.setData({ acting: true });
    try {
      await callLocationsApi({
        action: "ensurePath",
        path: this.nodePath.concat([name]),
        created_from: "manual",
      });
      wx.showToast({ title: "已添加", icon: "success" });
      await this.loadNode();
    } catch (e) {
      wx.showModal({ title: "添加失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 常驻入口:从已录入物品生成 / 更新空间树(向导可重复进入,增量扫描) */
  onScanTap() {
    if (this.data.mode !== "browse") {
      return;
    }
    this.goScan();
  },

  goScan() {
    wx.navigateTo({
      url: "/pages/locationScan/locationScan",
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  onItemTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.itemAt(index);
    if (item) {
      this.openItem(item);
    }
  },

  /** 物品「⋯」:移动到其他位置 / 从这里摘除 */
  onItemMore(e) {
    if (this.data.acting) {
      return;
    }
    const index = Number(e.currentTarget.dataset.index);
    const item = this.itemAt(index);
    if (!item) {
      return;
    }
    wx.showActionSheet({
      itemList: ["移动到…", "从这里摘除"],
      success: (r) => {
        if (r.tapIndex === 0) {
          this.moveItem(item);
        } else if (r.tapIndex === 1) {
          this.unlinkItem(item);
        }
      },
      fail: () => {},
    });
  },

  moveItem(item) {
    this.openPicker("把「" + item.name + "」挂到…", {}, (picked) => {
      void this.doMoveItem(item, picked.location_id);
    });
  },

  async doMoveItem(item, nodeId) {
    if (this.data.acting) {
      return;
    }
    this.setData({ acting: true });
    try {
      await callLocationsApi({
        action: "linkItem",
        item_id: item.item_id,
        node_id: nodeId,
        expected_version: item.version,
        update_id: uuid(),
      });
      wx.showToast({ title: "已挂到新位置", icon: "success" });
      await this.loadNode();
    } catch (e) {
      // 版本冲突:刷新本层拿到新版本,由用户重试;绝不静默覆盖
      wx.showModal({
        title: "移动失败",
        content: errorMessage(e),
        showCancel: false,
      });
      await this.loadNode();
    } finally {
      this.setData({ acting: false });
    }
  },

  unlinkItem(item) {
    const nodeName = this.nodePath.length > 0
      ? this.nodePath[this.nodePath.length - 1]
      : "当前位置";
    wx.showModal({
      title: "摘除挂载",
      content:
        "把「" + item.name + "」从「" + nodeName +
        "」摘除?它原始的位置记录会保留,只是回到未归位。",
      confirmText: "摘除",
      cancelText: "取消",
      success: (r) => {
        if (r.confirm) {
          void this.doUnlink(item);
        }
      },
    });
  },

  async doUnlink(item) {
    if (this.data.acting) {
      return;
    }
    this.setData({ acting: true });
    try {
      await callLocationsApi({
        action: "unlinkItem",
        item_id: item.item_id,
        expected_version: item.version,
        update_id: uuid(),
      });
      wx.showToast({ title: "已摘除", icon: "success" });
      await this.loadNode();
    } catch (e) {
      wx.showModal({ title: "摘除失败", content: errorMessage(e), showCancel: false });
      await this.loadNode();
    } finally {
      this.setData({ acting: false });
    }
  },

  openItem(item) {
    const summary: ItemSummary = {
      item_id: item.item_id,
      name: item.name,
      location_text: item.location_text,
      note: item.note,
      version: item.version,
      updated_at: item.updated_at,
    };
    wx.navigateTo({
      url: "/pages/item/item?data=" + encodeURIComponent(JSON.stringify(summary)),
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  /** 以选择模式重入自身,选中后经 EventChannel 回传给发起页 */
  openPicker(title, opts, onPick) {
    this.pendingPick = onPick;
    const params = ["picker=1", "title=" + encodeURIComponent(title)];
    if (opts.type) {
      params.push("type=" + encodeURIComponent(opts.type));
    }
    if (opts.excludePath) {
      params.push("exclude_path=" + encodeURIComponent(opts.excludePath));
    }
    wx.navigateTo({
      url: "/pages/locations/locations?" + params.join("&"),
      events: {
        pickNode: (d: PickedLocation) => {
          const cb = this.pendingPick;
          this.pendingPick = null;
          if (cb) {
            cb(d);
          }
        },
      },
      fail: () => {
        this.pendingPick = null;
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  finishPick(node) {
    const channel = this.getOpenerEventChannel();
    if (channel && typeof channel.emit === "function") {
      channel.emit("pickNode", {
        location_id: node.location_id,
        name: node.name,
        type: node.type,
        path: node.path,
      });
    }
    wx.navigateBack({ fail: () => {} });
  },
});
