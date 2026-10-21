import {
  callLocationsApi,
  isLocationsApiErrorWithCode,
} from "../../utils/locations-api";
import {
  captureCacheGeneration,
  createRequestSeq,
  isCacheGenerationCurrent,
  isLocationsCacheFresh,
  planLocationsLoad,
  readLocationsLayer,
  writeLocationsLayer,
} from "../../utils/locations-cache";
import type { LocationsRequestSeq } from "../../utils/locations-cache";
import { errorMessage, formatDateTime, uuid } from "../../utils/api";
import { callItemsApi } from "../../utils/api";
import { lastScanSummaryText } from "../../utils/location-scan";
import { householdScopeName, isHouseholdScopeShared, isScopeVerified } from "../../utils/household-scope";
import type {
  ItemSummary,
  ListLocationsResponse,
  LocationNodeSummary,
} from "../../types";

/** 选择模式回传给发起页的节点(仓库内全部监听方只消费 location_id) */
interface PickedLocation {
  location_id: string;
  name: string;
  path: string[];
}

/** 用于渲染的子节点(附展示文案与选择模式的禁用原因) */
type DisplayNode = LocationNodeSummary & {
  countText: string;
  disabled: boolean;
  disabledReason: string;
};

/** 用于渲染的物品条目(附格式化后的更新时间) */
type DisplayItem = ItemSummary & { updated_at_text: string };

/** D1(#94)删除位置三按钮弹层:影响面文案来自 deletePreview(只读计数) */
interface DeleteLayerState {
  visible: boolean;
  nodeId: string;
  name: string;
  countsText: string;
  scanCount: number;
  migrateAvailable: boolean;
  busy: boolean;
}

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

/**
 * 选择完成后统一退栈:选择器页只叠在发起页正上方,按发起页在栈中的位置
 * 一次性退掉其上全部页面。多页各自 navigateBack 在导航风暴中会被吞掉,
 * 曾导致选择器残留在栈顶(#29 后续真机反馈)。
 */
function unwindPickerAbove(origin: ReturnType<typeof getCurrentPages>[number]): void {
  const pages = getCurrentPages();
  const idx = pages.indexOf(origin);
  const delta = pages.length - 1 - idx;
  if (idx !== -1 && delta > 0) {
    wx.navigateBack({ delta, fail: () => {} });
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
    /** 当前层自身节点(「就选这里」用;根层为空) */
    currentNodeId: string;
    currentNodeName: string;
    children: DisplayNode[];
    items: DisplayItem[];
    unmountedCount: number;
    danglingMounts: number;
    /** 共享家庭标识(真机反馈:加入后我的家应表明当前身处哪个家庭) */
    familyShared: boolean;
    familyName: string;
    hasRooms: boolean;
    canScan: boolean;
    /** 结构操作进行中(rename/move/merge/delete/add),防止并发重复提交 */
    acting: boolean;
    /** D1(#94):browse 且非根层显示「拍视频清点这里」入口卡(根层不显示) */
    hasScanEntry: boolean;
    /** D1(#94):「上次清点」摘要行;空串 = 无记录或读取失败(静默隐藏) */
    scanSummaryText: string;
    /** D1(#94)删除位置三按钮弹层(影响面文案 + migrate 可用性) */
    deleteLayer: DeleteLayerState;
  },
  {
    nodeId: string;
    /** 当前节点的完整 path(根层为空数组);手动添加子位置时作前缀 */
    nodePath: string[];
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
    loadNode(force?: boolean, retryOnStaleGen?: boolean): Promise<void>;
    renderList(res: ListLocationsResponse): void;
    onRetryTap(): void;
    decorate(children: LocationNodeSummary[]): DisplayNode[];
    onChildTap(e: WechatMiniprogram.CustomEvent): void;
    onPickTap(e: WechatMiniprogram.CustomEvent): void;
    onChildMore(e: WechatMiniprogram.CustomEvent): void;
    onPickCurrentTap(): void;
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
    /** 弹层防冒泡占位 */
    noop(): void;
    /** D1(#94)位置级视频清点:底部入口卡 / 上次清点摘要 / 回看 */
    loadScanSummary(nodeId: string): Promise<void>;
    scanLoadSeq: number;
    onScanEntryTap(): void;
    onScanReviewTap(): void;
    /** D1(#94)删除位置三按钮:preview 影响面 → 弹层三选(取消/迁移/全部删除) */
    deleteNodeWithPreview(node: DisplayNode): Promise<void>;
    onDeleteLayerCancel(): void;
    onMigrateTap(): void;
    onPurgeTap(): void;
    doMigrateDelete(): Promise<void>;
    doPurgeDelete(): Promise<void>;
    deleteLayerBusy(busy: boolean): void;
    onItemTap(e: WechatMiniprogram.CustomEvent): void;
    onItemMore(e: WechatMiniprogram.CustomEvent): void;
    moveItem(item: DisplayItem): void;
    doMoveItem(item: DisplayItem, nodeId: string): Promise<void>;
    unlinkItem(item: DisplayItem): void;
    doUnlink(item: DisplayItem): Promise<void>;
    openItem(item: DisplayItem): void;
    openPicker(
      title: string,
      opts: { excludePath?: string },
      onPick: (picked: PickedLocation) => void,
    ): void;
    finishPick(node: { location_id: string; name: string; path: string[] }): void;
    showTargetLayer(nodeId: string): void;
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
    currentNodeId: "",
    currentNodeName: "",
    children: [],
    items: [],
    unmountedCount: 0,
    danglingMounts: 0,
    familyShared: false,
    familyName: "",
    hasRooms: false,
    canScan: false,
    acting: false,
    hasScanEntry: false,
    scanSummaryText: "",
    deleteLayer: {
      visible: false,
      nodeId: "",
      name: "",
      countsText: "",
      scanCount: 0,
      migrateAvailable: false,
      busy: false,
    },
  },

  nodeId: "",
  nodePath: [] as string[],
  pickExcludePath: "",
  pendingPick: null as ((picked: PickedLocation) => void) | null,
  requestSeq: createRequestSeq(),
  renderedOnce: false,
  scanLoadSeq: 0,

  onLoad(options) {
    // 按页面实例创建请求序号(Page options 会被浅拷贝共享,不能在 options 里建闭包)
    this.requestSeq = createRequestSeq();
    this.renderedOnce = false;
    this.scanLoadSeq = 0;
    const isPicker = options.picker === "1";
    this.nodeId = safeDecode(options.node_id);
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
   * 它是影响真实数据操作前的重新校验。迟到响应(序号不匹配)不上屏、不写缓存;
   * 失效代数变化(P1-1,在途期间其他页面写过数据)同样作废本次响应并补拉一次。
   * 展示前资格复核(issue #34 P1-B,硬门 C1):作用域未经服务端验证(冷启动/
   * 前台切回)时不读持久化缓存,直连服务端——旧家庭的缓存不得当作当前可访问
   * 内容展示;list 响应捕获作用域后即恢复缓存可用。
   */
  async loadNode(force?: boolean, retryOnStaleGen?: boolean): Promise<void> {
    const seq = this.requestSeq.next();
    const gen = captureCacheGeneration();
    const pickMode = this.data.mode === "pick";
    const cached =
      pickMode || !isScopeVerified() ? null : readLocationsLayer(this.nodeId);
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
      if (!isCacheGenerationCurrent(gen)) {
        // P1-1:在途期间发生过写失效(其他页面移动/挂载/改名…),这是旧树——
        // 不上屏不写缓存,补拉一次;连续写场景由 retryOnStaleGen 挡住不无限循环
        if (retryOnStaleGen !== false) {
          void this.loadNode(force, false);
        } else {
          this.setData({ loading: false, refreshing: false, stale: true });
        }
        return;
      }
      writeLocationsLayer(this.nodeId, res, Date.now(), gen);
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
    // D1(#94):browse 且非根层显示底部「拍视频清点这里」入口卡;根层不显示
    // (物品不允许挂 home 根,「清点我的家整体」没有可归档目标)。fire-and-forget
    // 拉「上次清点」摘要,失败静默隐藏第二行(不影响主列表)。
    const scanEntry = this.data.mode === "browse" && !isRoot && res.node.location_id !== "";
    this.setData({
      breadcrumbText: isRoot
        ? "我的家"
        : "我的家 / " + res.node.path.join(" / "),
      isRoot,
      currentNodeId: res.node.location_id,
      currentNodeName: res.node.name,
      children: this.decorate(res.children),
      items,
      unmountedCount: res.unmounted_count,
      danglingMounts: res.dangling_mounts,
      familyShared: isHouseholdScopeShared(),
      familyName: householdScopeName() || "",
      hasRooms: res.children.length > 0,
      canScan: res.unmounted_count > 0,
      hasScanEntry: scanEntry,
    });
    if (scanEntry) {
      void this.loadScanSummary(res.node.location_id);
    } else if (this.data.scanSummaryText !== "") {
      this.setData({ scanSummaryText: "" });
    }
  },

  /**
   * D1(#94)「上次清点」:读最新 active location_scan 的摘要行(§2.3 一次调用)。
   * 迟到守卫:序号 + nodeId 双重校验(下钻后旧层响应不上屏);失败静默——
   * 摘要是增强信息,绝不打断空间浏览主流程。首页不做任何改动(#94「首页不展示」)。
   */
  async loadScanSummary(nodeId: string): Promise<void> {
    const seq = this.scanLoadSeq + 1;
    this.scanLoadSeq = seq;
    try {
      const res = await callItemsApi({ action: "locationScanLatest", location_id: nodeId });
      if (this.scanLoadSeq !== seq || this.data.currentNodeId !== nodeId) {
        return; // 迟到响应:用户已进入其他层
      }
      if (res.scan === null) {
        this.setData({ scanSummaryText: "" });
        return;
      }
      this.setData({
        scanSummaryText: lastScanSummaryText(
          res.scan.created_at,
          res.scan.confirmed_count,
          res.items.length,
        ),
      });
    } catch (e) {
      if (this.scanLoadSeq === seq && this.data.currentNodeId === nodeId) {
        this.setData({ scanSummaryText: "" });
      }
    }
  },

  /** 点整卡进入拍摄清点(把当前层 node_id 带给清点页固定位置上下文) */
  onScanEntryTap() {
    if (this.data.mode !== "browse" || !this.data.hasScanEntry || this.data.acting) {
      return;
    }
    wx.navigateTo({
      url: "/pages/location-video-scan/location-video-scan?node_id=" +
        encodeURIComponent(this.data.currentNodeId),
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  /** 点「回看」进上次清点的回放(不自动播放)+ 确认物品清单 */
  onScanReviewTap() {
    if (this.data.mode !== "browse" || !this.data.hasScanEntry) {
      return;
    }
    wx.navigateTo({
      url: "/pages/location-video-scan/location-video-scan?mode=last&node_id=" +
        encodeURIComponent(this.data.currentNodeId),
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  /** 子节点渲染装饰:计数文案;选择模式下计算禁用与原因 */
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
        // 不再按 type 过滤(issue #30 PR A):跨层级选择交给服务端结构规则裁决
        // (叶子跨层允许、带子树跨深度拒绝),选择器不做类型预筛。
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

  /** 点子节点:下钻一层(选择模式也保留逐层下钻,排除参数随行) */
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
      if (this.pickExcludePath) {
        params.push("exclude_path=" + encodeURIComponent(this.pickExcludePath));
      }
    }
    const url = "/pages/locations/locations?" + params.join("&");
    const navFail = () => {
      // 页面栈满时退化为替换当前页(仍可逐层返回)
      wx.redirectTo({
        url,
        fail: () => {
          wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
        },
      });
    };
    // 选择模式下钻时把 pickNode 逐层转发回发起页:EventChannel 只连相邻两层,
    // 而发起页(openPicker/物品详情)只在第一层注册了监听——不转发则深层选中
    // 事件会静默丢失(issue #27 真机「点击不生效」的断点)。退栈一律由发起页
    // 统一计算(unwindPickerAbove),本层不单独 navigateBack。
    if (this.data.mode === "pick") {
      wx.navigateTo({
        url,
        events: {
          pickNode: (d: PickedLocation) => {
            const channel = this.getOpenerEventChannel();
            if (channel && typeof channel.emit === "function") {
              channel.emit("pickNode", d);
            }
          },
        },
        fail: navFail,
      });
      return;
    }
    wx.navigateTo({ url, fail: navFail });
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

  /** 选择模式「就选这里」:直接选中当前层(下钻过深时不必退回找「选这个」) */
  onPickCurrentTap() {
    if (this.data.mode !== "pick" || this.data.isRoot) {
      return;
    }
    const path = this.nodePath;
    if (this.pickExcludePath) {
      const p = path.join("/");
      if (p === this.pickExcludePath || p.indexOf(this.pickExcludePath + "/") === 0) {
        wx.showToast({ title: "不能选它自己", icon: "none" });
        return;
      }
    }
    // 不再按 type 校验(issue #30 PR A):跨层级选择交给服务端结构规则裁决。
    this.finishPick({
      location_id: this.data.currentNodeId,
      name: this.data.currentNodeName,
      path,
    });
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
          // D1(#94):「删除」改走 preview + 三按钮弹层;旧 delete/force 交互保留
          // 为服务端兜底(其他调用方零回归),页面不再触达
          void this.deleteNodeWithPreview(node);
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
      this.showTargetLayer(newParentId);
    } catch (e) {
      wx.showModal({ title: "移动失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 合并重复节点:不做类型过滤;source 自己与其子树不可选 */
  mergeNode(node) {
    wx.showModal({
      title: "合并重复位置",
      content:
        "把「" + node.name + "」并进另一个位置:物品会一起挪过去,这个位置会消失。继续?",
      confirmText: "选目标",
      cancelText: "取消",
      success: (r) => {
        if (!r.confirm) {
          return;
        }
        // 选择器不再按 type 预筛(issue #30 PR A):叶子跨层级合并允许(issue #27),
        // 带子树的跨深度合并由服务端结构规则拒绝并引导先移动。
        this.openPicker(
          "把「" + node.name + "」并进…",
          { excludePath: node.path.join("/") },
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
      this.showTargetLayer(targetId);
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

  /* ------------------------------------------------------------------
   * D1(#94)删除位置三按钮:preview 影响面 → 自定义半屏弹层三选
   * (取消 / 删位置并迁移物品 / 全部删除)。取消不调任何接口;
   * 迁移物品条件重挂上一级(冲突中止零删除,可重试);全部删除先逐件
   * itemsApi.delete(B 已验收级联)再 deleteLocation(purge),二次确认,
   * NODE_NOT_EMPTY 收敛清单兜住删除期间的并发挂载。根位置无「⋯」入口,
   * 服务端 deletePreview/deleteLocation 再拦一层(双重防删)。
   * ------------------------------------------------------------------ */

  /** 「⋯ → 删除」新流程:先拉影响面计数,再开三按钮弹层(纯读) */
  async deleteNodeWithPreview(node) {
    if (this.data.acting) {
      return;
    }
    this.setData({ acting: true });
    try {
      const preview = await callLocationsApi({
        action: "deletePreview",
        node_id: node.location_id,
      });
      this.setData({
        deleteLayer: {
          visible: true,
          nodeId: node.location_id,
          name: node.name,
          countsText:
            "当前及子位置共 " + preview.node_count + " 个,物品 " +
            preview.item_count + " 件,关联视频 " + preview.video_count + " 条",
          scanCount: preview.scan_count,
          migrateAvailable: preview.migrate_available,
          busy: false,
        },
      });
    } catch (e) {
      wx.showModal({ title: "读取影响面失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 取消:关弹层,不调任何接口(#94 三按钮语义) */
  onDeleteLayerCancel() {
    this.setData({ deleteLayer: { ...this.data.deleteLayer, visible: false, busy: false } });
  },

  deleteLayerBusy(busy) {
    this.setData({ deleteLayer: { ...this.data.deleteLayer, busy } });
  },

  onMigrateTap() {
    const layer = this.data.deleteLayer;
    if (!layer.visible || layer.busy || this.data.acting) {
      return;
    }
    if (!layer.migrateAvailable) {
      wx.showToast({ title: "物品不能直接挂「我的家」,请改用全部删除", icon: "none" });
      return;
    }
    void this.doMigrateDelete();
  },

  /** 删位置并迁移物品:物品条件重挂上一级 → 删子树;scan 标 location_deleted */
  async doMigrateDelete() {
    const layer = this.data.deleteLayer;
    if (!layer.visible || layer.busy) {
      return;
    }
    this.deleteLayerBusy(true);
    try {
      const res = await callLocationsApi({
        action: "deleteLocation",
        node_id: layer.nodeId,
        mode: "migrate",
      });
      this.setData({ deleteLayer: { ...this.data.deleteLayer, visible: false, busy: false } });
      wx.showToast({
        title: res.remounted > 0
          ? "已删除;" + res.remounted + " 件物品已挂到上一级"
          : "已删除",
        icon: res.remounted > 0 ? "none" : "success",
        duration: res.remounted > 0 ? 3000 : 1500,
      });
      await this.loadNode();
    } catch (e) {
      // 迁移冲突/作用域变化是可重试的收敛语义:如实提示,弹层保留供重试
      this.deleteLayerBusy(false);
      wx.showModal({ title: "删除失败", content: errorMessage(e), showCancel: false });
    }
  },

  onPurgeTap() {
    const layer = this.data.deleteLayer;
    if (!layer.visible || layer.busy || this.data.acting) {
      return;
    }
    void this.doPurgeDelete();
  },

  /**
   * 全部删除(#94 必须二次确认):先逐件 itemsApi.delete(软删级联——证据行、
   * 末引用才删云文件、提醒清理全部是 B 已验收资产,顺序执行),再
   * deleteLocation(purge);期间有并发挂载 → NODE_NOT_EMPTY 附 remaining_items
   * 清单,补删后重试(收敛循环,上限 3 轮)。每步幂等:软删后重删返回
   * NOT_FOUND 视为完成。
   */
  async doPurgeDelete() {
    const layer = this.data.deleteLayer;
    if (!layer.visible || layer.busy) {
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "全部删除(不可恢复)",
        content:
          "「" + layer.name + "」" + layer.countsText + "。将删除这些物品及其全部视频/照片证据,连带子位置与清点记录一起删除。确定?",
        confirmText: "全部删除",
        confirmColor: "#d93025",
        cancelText: "取消",
        success: (r) => resolve(r.confirm === true),
        fail: () => resolve(false),
      });
    });
    if (confirmed === false) {
      return;
    }
    this.deleteLayerBusy(true);
    try {
      let remaining: Array<{ item_id: string }> = [];
      for (let round = 0; round < 3; round++) {
        if (remaining.length > 0) {
          wx.showLoading({ title: "正在删除物品…", mask: true });
          const failedNames: string[] = [];
          for (const row of remaining) {
            try {
              await callItemsApi({ action: "delete", item_id: row.item_id });
            } catch (e) {
              // NOT_FOUND = 已被别处删除,视为完成;其余如实收集后中止
              const msg = errorMessage(e);
              if (msg.indexOf("没有找到") === -1 && msg.indexOf("NOT_FOUND") === -1) {
                failedNames.push(msg);
                break;
              }
            }
          }
          wx.hideLoading();
          if (failedNames.length > 0) {
            wx.showModal({
              title: "部分物品删除失败",
              content: failedNames[0] + " 已删的物品不会恢复,可重试继续删除剩余部分。",
              showCancel: false,
            });
            return;
          }
        }
        try {
          const res = await callLocationsApi({
            action: "deleteLocation",
            node_id: layer.nodeId,
            mode: "purge",
          });
          this.setData({ deleteLayer: { ...this.data.deleteLayer, visible: false, busy: false } });
          wx.showToast({ title: "已全部删除", icon: "success" });
          await this.loadNode();
          return;
        } catch (e) {
          if (isLocationsApiErrorWithCode(e, "NODE_NOT_EMPTY")) {
            const detail = e.detail as { remaining_items?: unknown } | undefined;
            const rows = detail && Array.isArray(detail.remaining_items)
              ? detail.remaining_items as Array<{ item_id: string }>
              : [];
            if (rows.length > 0) {
              remaining = rows; // 删除期间有并发挂载:补删后重试(收敛)
              continue;
            }
          }
          throw e;
        }
      }
      // 3 轮仍有物品持续被挂进来:如实报告,用户可重试
      this.deleteLayerBusy(false);
      wx.showModal({
        title: "暂未能全部删除",
        content: "有物品刚被移入这个范围,列表已更新;请再试一次完成删除。",
        showCancel: false,
      });
    } catch (e) {
      this.deleteLayerBusy(false);
      wx.showModal({ title: "删除失败", content: errorMessage(e), showCancel: false });
    }
  },

  /** 弹层防冒泡占位(点面板不吃掉遮罩关闭) */
  noop() {},

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
      this.showTargetLayer(nodeId);
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
    const params = ["data=" + encodeURIComponent(JSON.stringify(summary))];
    // 条目直接记在当前层:带上这条路径给详情页(只读大卡「上次记在」);根层无路径
    if (!this.data.isRoot && this.nodePath.length > 0) {
      params.push("path=" + encodeURIComponent(JSON.stringify(this.nodePath)));
    }
    wx.navigateTo({
      url: "/pages/item/item?" + params.join("&"),
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  /** 以选择模式重入自身,选中后经 EventChannel 回传给发起页 */
  openPicker(title, opts, onPick) {
    this.pendingPick = onPick;
    const params = ["picker=1", "title=" + encodeURIComponent(title)];
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
          unwindPickerAbove(this);
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
      // 载荷只回传标识与展示必需字段(issue #30 PR B:type 不再随载荷下发,
      // 仓库内监听方——本页 openPicker 回调与 item 页手动兜底——均只读 location_id)
      channel.emit("pickNode", {
        location_id: node.location_id,
        name: node.name,
        path: node.path,
      });
    }
    // 退栈由发起页统一计算(见 unwindPickerAbove):多页各自 navigateBack
    // 在导航风暴中会被吞掉,曾导致选择器残留在栈顶(#29 后续真机反馈)。
  },

  /**
   * 选目标的操作(物品挂载/位置移动/合并)成功后,进入目标层展示结果——
   * 用户能立刻看到"东西确实在里面"(真机反馈:挂完退回原层,东西已不在,
   * 还得再点两层确认)。目标即当前层(如把物品挂回本层)时只刷新不跳转。
   */
  showTargetLayer(nodeId) {
    if (!nodeId || nodeId === this.nodeId) {
      return;
    }
    wx.navigateTo({
      url: "/pages/locations/locations?node_id=" + encodeURIComponent(nodeId),
      fail: () => {},
    });
  },
});
