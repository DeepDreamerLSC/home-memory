import { applyPageAppearance } from "../../utils/appearance-page";
import {
  callLocationsApi,
  deletingFrozenMessage,
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
import { callItemsApi, isApiError } from "../../utils/api";
import { lastScanSummaryText } from "../../utils/location-scan";
import { householdScopeName, isHouseholdScopeShared, isScopeVerified } from "../../utils/household-scope";
import { HIGHLIGHT_QUERY_KEY } from "../../utils/nav-highlight";
import { consumePendingLocationHighlight, navToLocationLayer } from "../../utils/location-nav";
import { locationIconArtwork } from "../../utils/location-icon-view";
import { UNIT_SET, QUANTITY_MAX } from "../../utils/quantity";
import type {
  ItemSummary,
  ListLocationsResponse,
  LocationNodeSummary,
  PendingUnmountSummary,
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
  /** ⑥ 语义图标双主题路径对(批次乙);双空串 = 无资产 → 回退首字徽章 */
  icon: string;
  iconDark: string;
};

/** 用于渲染的物品条目(附格式化后的更新时间) */
type DisplayItem = ItemSummary & { updated_at_text: string };

/** D1(#94)+#116 四选删除弹层:影响面文案来自 deletePreview(只读计数) */
interface DeleteLayerState {
  visible: boolean;
  nodeId: string;
  name: string;
  countsText: string;
  scanCount: number;
  migrateAvailable: boolean;
  busy: boolean;
  /** issue #116(D0 §3.1 发现点一):上次「转为未归类」未完成的续跑摘要;null=无 */
  pendingUnmount: PendingUnmountSummary | null;
}

/** D2(#96)历史列表行视图:时间 / 候选 N · 确认 M / 回看 / 删,含逐行视频降级态 */
interface ScanHistoryRowView {
  scanId: string;
  timeText: string;
  countsText: string;
  /** "" = 视频可回看;降级态文案按契约:已回收 / 已随物品证据删除 */
  stateText: string;
  canReview: boolean;
  videoUrl: string;
}

/** D2(#96)清点历史半屏弹层(列表态 / 回看态共用一个面板) */
interface ScanHistoryState {
  visible: boolean;
  loading: boolean;
  errorText: string;
  rows: ScanHistoryRowView[];
  hasMore: boolean;
  /** 非空 = 回看态(行内 video_url 的播放器,不自动播放);空 = 列表态 */
  replayUrl: string;
  replayTitle: string;
  /** 回看播放器高度(px,JS 计算,契约 §8 实现纪律) */
  replayHeight: number;
  /** 列表 scroll-view 高度(px,JS 计算) */
  scrollHeight: number;
}

/** D2(#96)删除单次清点确认弹层(影响面预告文案冻结自契约 §4) */
interface ScanDeleteLayerState {
  visible: boolean;
  scanId: string;
  timeText: string;
  busy: boolean;
}

/** ②「+」面板(#121 批次乙):预设 chips(根层=常用房间 / 子层=家具)+ 自定义输入 */
interface AddPanelState {
  visible: boolean;
  presets: string[];
  customName: string;
}

/** ③ 位置内直接添加物品(#121 批次乙):名称 + 数量步进器 + 单位选择器 */
interface ItemPanelState {
  visible: boolean;
  /** 建档幂等键(评审 5663031433):同面板会话固定,重试返回已有物品不重复建档 */
  createOperationId: string;
  frozenName: string;
  frozenQuantity: number;
  frozenUnitIndex: number;
  frozenLocationText: string;
  name: string;
  quantity: number;
  unitIndex: number;
  busy: boolean;
}

/** ② 根层「常用房间」预设(一键创建;v2 横幅 #121 冻结清单) */
const ROOT_ROOM_PRESETS: readonly string[] = [
  "书房", "卧室", "厨房", "客厅", "卫生间", "玄关", "阳台", "餐厅", "储物间",
];

/** ② 子层「家具级」预设(一键创建;v2 横幅 #121 冻结清单) */
const SUB_FURNITURE_PRESETS: readonly string[] = [
  "抽屉", "柜子", "架子", "桌子", "床", "冰箱",
];

/** ④ 短高亮时长(批次甲 nav-highlight 协议:800ms) */
const HIGHLIGHT_MS = 800;

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
    /** D2(#96):清点历史半屏弹层(列表 / 行内回看) */
    scanHistory: ScanHistoryState;
    /** D2(#96):删除单次清点确认弹层(影响面预告) */
    scanDeleteLayer: ScanDeleteLayerState;
    /** D1(#94)删除位置三按钮弹层(影响面文案 + migrate 可用性) */
    deleteLayer: DeleteLayerState;
    /** ④ 短高亮中的行 id(物品 id / 子节点 id / 本层 currentNodeId);空串 = 无 */
    highlightId: string;
    /** ⑥ 位置页头部当前节点图标(双主题路径对;双空串 = 无资产不渲染) */
    headIcon: string;
    headIconDark: string;
    /** ③ 单位选择器选项(UNIT_SET 冻结闭集,与确认页同源) */
    unitOptions: string[];
    /** ②「+」面板:预设 chips + 自定义输入 */
    addPanel: AddPanelState;
    /** ③ 位置内直接添加物品表单 */
    itemPanel: ItemPanelState;
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
    /** ④ 待投递的短高亮 id(onLoad 的 hl 参数或 onShow 消费的 pending) */
    pendingHl: string;
    /** ④ 短高亮消除计时器句柄(0 = 无) */
    hlTimer: ReturnType<typeof setTimeout> | 0;
    /** ① 长按后的吞 tap 截止时间戳(0 = 无):老基础库长按后仍可能派发 tap,防御位 */
    suppressTapUntil: number;
    onLoad(options: Record<string, string | undefined>): void;
    onShow(): void;
    onUnload(): void;
    /** ④ 把 pendingHl 投到当前层数据(命中行/本层头部才高亮;800ms 后消除) */
    applyPendingHighlight(): void;
    onPullDownRefresh(): void;
    loadNode(force?: boolean, retryOnStaleGen?: boolean): Promise<void>;
    renderList(res: ListLocationsResponse): void;
    onRetryTap(): void;
    decorate(children: LocationNodeSummary[]): DisplayNode[];
    onChildTap(e: WechatMiniprogram.CustomEvent): void;
    onPickTap(e: WechatMiniprogram.CustomEvent): void;
    onChildMore(e: WechatMiniprogram.CustomEvent): void;
    /** ① 长按子节点行 = 与 ⋯ 同款 ActionSheet(长按不触发行点击跳转) */
    onChildLongPress(e: WechatMiniprogram.CustomEvent): void;
    /** ① 长按物品行 = 与 ⋯ 同款 ActionSheet */
    onItemLongPress(e: WechatMiniprogram.CustomEvent): void;
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
    /** ②「+」面板:打开(根层=房间预设 / 子层=家具预设) */
    onAddTap(): void;
    onAddPanelClose(): void;
    onAddPanelInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onAddPresetTap(e: WechatMiniprogram.CustomEvent): void;
    onAddCustomTap(): void;
    doAdd(name: string): Promise<void>;
    /** ③ 位置内直接添加物品(非根层):表单开合与提交 */
    onAddItemTap(): void;
    onItemPanelClose(): void;
    onItemNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onItemQtyStep(e: WechatMiniprogram.CustomEvent): void;
    onItemUnitChange(e: WechatMiniprogram.CustomEvent<{ value: number | string }>): void;
    onItemSaveTap(): Promise<void>;
    onScanTap(): void;
    /** 弹层防冒泡占位 */
    noop(): void;
    /** D1(#94)位置级视频清点:底部入口卡 / 上次清点摘要 / 回看 */
    loadScanSummary(nodeId: string): Promise<void>;
    scanLoadSeq: number;
    onScanEntryTap(): void;
    onScanReviewTap(): void;
    /** D2(#96)清点历史:半屏弹层列表 + 行内回看 + 删除确认 */
    scanHistorySeq: number;
    onScanHistoryTap(): void;
    scanHistoryGeometry(): { replayHeight: number; scrollHeight: number };
    loadScanHistory(): Promise<void>;
    onScanHistoryRetryTap(): void;
    onScanHistoryClose(): void;
    scanHistoryRowAt(index: number): ScanHistoryRowView | undefined;
    onScanHistoryReviewTap(e: WechatMiniprogram.CustomEvent): void;
    onScanHistoryBackTap(): void;
    onScanHistoryDeleteTap(e: WechatMiniprogram.CustomEvent): void;
    onScanDeleteLayerCancel(): void;
    onScanDeleteConfirmTap(): Promise<void>;
    refreshAfterScanDelete(): void;
    /** D1(#94)删除位置三按钮 + #116 四选:preview 影响面 → 弹层(取消/迁移/转未归类/全部删除) */
    deleteNodeWithPreview(node: DisplayNode): Promise<void>;
    onDeleteLayerCancel(): void;
    onMigrateTap(): void;
    /** issue #116:「转为未归类」→ deleteLocation(mode:unmount);对带检查点根重入即续跑 */
    onUnmountTap(): void;
    doUnmountDelete(): Promise<void>;
    onPurgeTap(): void;
    doMigrateDelete(): Promise<void>;
    doPurgeDelete(): Promise<void>;
    deleteLayerBusy(busy: boolean): void;
    onItemTap(e: WechatMiniprogram.CustomEvent): void;
    onItemMore(e: WechatMiniprogram.CustomEvent): void;
    /** 物品行菜单(⋯ 与长按共用) */
    showItemActions(item: DisplayItem): void;
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
    scanHistory: {
      visible: false,
      loading: false,
      errorText: "",
      rows: [] as ScanHistoryRowView[],
      hasMore: false,
      replayUrl: "",
      replayTitle: "",
      replayHeight: 0,
      scrollHeight: 0,
    },
    scanDeleteLayer: {
      visible: false,
      scanId: "",
      timeText: "",
      busy: false,
    },
    deleteLayer: {
      visible: false,
      nodeId: "",
      name: "",
      countsText: "",
      scanCount: 0,
      migrateAvailable: false,
      busy: false,
      pendingUnmount: null,
    },
    highlightId: "",
    headIcon: "",
    headIconDark: "",
    unitOptions: UNIT_SET as string[],
    addPanel: {
      visible: false,
      presets: [] as string[],
      customName: "",
    },
    itemPanel: {
      visible: false,
      createOperationId: "",
      frozenName: "",
      frozenQuantity: 0,
      frozenUnitIndex: 0,
      frozenLocationText: "",
      name: "",
      quantity: 1,
      unitIndex: 0,
      busy: false,
    },
  },

  nodeId: "",
  nodePath: [] as string[],
  pickExcludePath: "",
  pendingPick: null as ((picked: PickedLocation) => void) | null,
  requestSeq: createRequestSeq(),
  renderedOnce: false,
  pendingHl: "",
  hlTimer: 0 as ReturnType<typeof setTimeout> | 0,
  suppressTapUntil: 0,
  scanLoadSeq: 0,
  scanHistorySeq: 0,

  onLoad(options) {
    // 按页面实例创建请求序号(Page options 会被浅拷贝共享,不能在 options 里建闭包)
    this.requestSeq = createRequestSeq();
    this.renderedOnce = false;
    this.scanLoadSeq = 0;
    this.scanHistorySeq = 0;
    const isPicker = options.picker === "1";
    this.nodeId = safeDecode(options.node_id);
    this.pickExcludePath = isPicker ? safeDecode(options.exclude_path) : "";
    // ④ navigateTo/redirectTo 场景:url 的 hl 参数(onLoad 只跑一次)
    this.pendingHl = safeDecode(options[HIGHLIGHT_QUERY_KEY]);
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
    applyPageAppearance(this);
    // ④ navigateBack 回退场景:消费模块级 pending 高亮(不依赖 onLoad)
    const pendingHl = consumePendingLocationHighlight(this.nodeId);
    if (pendingHl) {
      this.pendingHl = pendingHl;
    }
    void this.loadNode();
  },

  onUnload() {
    if (this.hlTimer !== 0) {
      clearTimeout(this.hlTimer);
      this.hlTimer = 0;
    }
    this.pendingHl = "";
  },

  /**
   * ④ 短高亮投递:pendingHl 命中当前层任意行(子节点 location_id / 物品
   * item_id)或本层自身(currentNodeId,合并落层高亮头部)才高亮,800ms 后
   * 消除;未命中保留待后续渲染(缓存先行→服务端刷新两段渲染都会再试)。
   */
  applyPendingHighlight() {
    const hl = this.pendingHl;
    if (!hl || this.data.highlightId === hl) {
      return;
    }
    const hitChild = this.data.children.some((c) => c.location_id === hl);
    const hitItem = this.data.items.some((i) => i.item_id === hl);
    const hitSelf = hl === this.data.currentNodeId && !this.data.isRoot;
    if (!hitChild && !hitItem && !hitSelf) {
      return;
    }
    this.pendingHl = "";
    this.setData({ highlightId: hl });
    if (this.hlTimer !== 0) {
      clearTimeout(this.hlTimer);
    }
    this.hlTimer = setTimeout(() => {
      this.hlTimer = 0;
      this.setData({ highlightId: "" });
    }, HIGHLIGHT_MS);
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
    // ⑥ 位置页头部:当前节点语义图标(资产未产出 → 双空串,头部零渲染不漂移)
    const headArt = locationIconArtwork(res.node.name);
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
      headIcon: headArt.icon,
      headIconDark: headArt.iconDark,
    });
    // ④ 渲染后投递短高亮(hl 参数 / pending,命中行才闪)
    this.applyPendingHighlight();
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

  /* ------------------------------------------------------------------
   * D2(#96)清点历史:入口卡摘要行的「历史」→ 半屏弹层列本位置 active
   * 清点(时间/候选/确认/回看/删);行内回看直接播行内 video_url(不自动
   * 播放);删除走确认弹层(影响面预告文案冻结自契约 §4)。迟到守卫复用
   * loadScanSummary 同款(序号 + currentNodeId 双重校验)。
   * ------------------------------------------------------------------ */

  /** 点「历史」开弹层并加载(browse 且非根层、有 scan 摘要时入口才可见) */
  onScanHistoryTap() {
    if (this.data.mode !== "browse" || !this.data.hasScanEntry || this.data.scanSummaryText === "") {
      return;
    }
    const geo = this.scanHistoryGeometry();
    this.setData({
      scanHistory: {
        visible: true,
        loading: true,
        errorText: "",
        rows: [],
        hasMore: false,
        replayUrl: "",
        replayTitle: "",
        replayHeight: geo.replayHeight,
        scrollHeight: geo.scrollHeight,
      },
      scanDeleteLayer: { visible: false, scanId: "", timeText: "", busy: false },
    });
    void this.loadScanHistory();
  },

  /** 弹层几何(回看播放器高 / 列表滚动高):JS 算 px 喂 inline,不用 rpx/vh/calc */
  scanHistoryGeometry(): { replayHeight: number; scrollHeight: number } {
    try {
      const si = wx.getSystemInfoSync();
      const winW = (si && si.windowWidth) || 375;
      const winH = (si && si.windowHeight) || 667;
      return {
        // 与清点页回看播放器同款高(380rpx 折 px:winW × 380/750),下限保护
        replayHeight: Math.max(160, Math.round((winW * 380) / 750)),
        scrollHeight: Math.max(200, Math.round(winH * 0.45)),
      };
    } catch (e) {
      return { replayHeight: 190, scrollHeight: 300 };
    }
  },

  /** 拉本位置清点历史;逐行视频降级(已回收/换链失败)不废列表 */
  async loadScanHistory(): Promise<void> {
    const nodeId = this.data.currentNodeId;
    const seq = this.scanHistorySeq + 1;
    this.scanHistorySeq = seq;
    try {
      const res = await callItemsApi({ action: "locationScanHistory", location_id: nodeId });
      if (this.scanHistorySeq !== seq || this.data.currentNodeId !== nodeId || !this.data.scanHistory.visible) {
        return; // 迟到响应:用户已进其他层/已关弹层
      }
      this.setData({
        scanHistory: {
          ...this.data.scanHistory,
          loading: false,
          errorText: "",
          rows: res.scans.map((row) => ({
            scanId: row.scan_id,
            timeText: formatDateTime(row.created_at),
            countsText: "候选 " + row.candidate_count + " · 确认 " + row.confirmed_count,
            stateText: row.video_reclaimed
              ? "视频已过期回收"
              : row.video_url === ""
                ? "视频已随物品证据删除"
                : "",
            canReview: row.video_url !== "",
            videoUrl: row.video_url,
          })),
          hasMore: res.has_more === true,
        },
      });
    } catch (e) {
      if (this.scanHistorySeq === seq && this.data.scanHistory.visible) {
        this.setData({
          scanHistory: { ...this.data.scanHistory, loading: false, errorText: errorMessage(e) },
        });
      }
    }
  },

  /** 读取失败重试(弹层保留,原位重拉) */
  onScanHistoryRetryTap() {
    if (!this.data.scanHistory.visible) {
      return;
    }
    this.setData({ scanHistory: { ...this.data.scanHistory, loading: true, errorText: "" } });
    void this.loadScanHistory();
  },

  /** 关弹层(连带回看态与删除确认弹层一并收起;作废在途响应) */
  onScanHistoryClose() {
    this.scanHistorySeq = this.scanHistorySeq + 1;
    this.setData({
      scanHistory: {
        ...this.data.scanHistory,
        visible: false,
        loading: false,
        errorText: "",
        rows: [],
        replayUrl: "",
        replayTitle: "",
      },
      scanDeleteLayer: { visible: false, scanId: "", timeText: "", busy: false },
    });
  },

  scanHistoryRowAt(index) {
    const row = this.data.scanHistory.rows[index];
    return row ? row : undefined;
  },

  /** 行内「回看」:弹层内播该行 video_url(不自动播放,复用回看交互) */
  onScanHistoryReviewTap(e) {
    if (!this.data.scanHistory.visible) {
      return;
    }
    const row = this.scanHistoryRowAt(Number(e.currentTarget.dataset.index));
    if (!row || !row.canReview) {
      return; // 降级行无回看入口(按钮本就不渲染,防御位)
    }
    this.setData({
      scanHistory: { ...this.data.scanHistory, replayUrl: row.videoUrl, replayTitle: "回看:" + row.timeText },
    });
  },

  /** 回看态返回列表 */
  onScanHistoryBackTap() {
    this.setData({ scanHistory: { ...this.data.scanHistory, replayUrl: "", replayTitle: "" } });
  },

  /** 行内「删」:开确认弹层(文案冻结自契约 §4 影响面预告) */
  onScanHistoryDeleteTap(e) {
    if (!this.data.scanHistory.visible || this.data.scanDeleteLayer.busy) {
      return;
    }
    const row = this.scanHistoryRowAt(Number(e.currentTarget.dataset.index));
    if (!row) {
      return;
    }
    this.setData({
      scanDeleteLayer: { visible: true, scanId: row.scanId, timeText: row.timeText, busy: false },
    });
  },

  /** 取消删除确认(不调任何接口) */
  onScanDeleteLayerCancel() {
    this.setData({ scanDeleteLayer: { visible: false, scanId: "", timeText: "", busy: false } });
  },

  /**
   * 确认删除:scanDelete(服务端状态门+末引用复核,绝不动物品/evidence)。
   * 失败分型:VIDEO_DELETE_FAILED 云删失败可重试(行保留);VIDEO_ITEM_BUSY
   * 操作冲突稍后再试;NOT_FOUND 他端已删/位置流程已终结 → 刷新列表收敛不报错。
   */
  async onScanDeleteConfirmTap(): Promise<void> {
    const layer = this.data.scanDeleteLayer;
    if (!layer.visible || layer.busy || layer.scanId === "") {
      return;
    }
    this.setData({ scanDeleteLayer: { ...layer, busy: true } });
    const scanId = layer.scanId;
    try {
      await callItemsApi({ action: "scanDelete", scan_id: scanId });
      if (this.data.scanDeleteLayer.scanId === scanId) {
        this.setData({ scanDeleteLayer: { visible: false, scanId: "", timeText: "", busy: false } });
      }
      wx.showToast({ title: "已删除", icon: "success" });
      this.refreshAfterScanDelete();
    } catch (e) {
      if (isApiError(e)) {
        if (e.code === "NOT_FOUND") {
          // 他端已删/位置流程已终结:静默收敛(关确认层 + 刷新列表与摘要)
          if (this.data.scanDeleteLayer.scanId === scanId) {
            this.setData({ scanDeleteLayer: { visible: false, scanId: "", timeText: "", busy: false } });
          }
          this.refreshAfterScanDelete();
          return;
        }
        if (e.code === "VIDEO_DELETE_FAILED") {
          if (this.data.scanDeleteLayer.scanId === scanId) {
            this.setData({ scanDeleteLayer: { ...this.data.scanDeleteLayer, busy: false } });
          }
          wx.showToast({ title: "删除失败,请重试", icon: "none" });
          return; // 行保留,可再删(确认层留着直接重试)
        }
        if (e.code === "VIDEO_ITEM_BUSY") {
          if (this.data.scanDeleteLayer.scanId === scanId) {
            this.setData({ scanDeleteLayer: { ...this.data.scanDeleteLayer, busy: false } });
          }
          wx.showToast({ title: "操作冲突,请稍后再试", icon: "none" });
          return;
        }
      }
      if (this.data.scanDeleteLayer.scanId === scanId) {
        this.setData({ scanDeleteLayer: { ...this.data.scanDeleteLayer, busy: false } });
      }
      wx.showModal({ title: "删除失败", content: errorMessage(e), showCancel: false });
    }
  },

  /** 删除收敛后:刷新历史列表(可能剩空态)与「上次清点」摘要(可能隐藏入口) */
  refreshAfterScanDelete() {
    void this.loadScanHistory();
    void this.loadScanSummary(this.data.currentNodeId);
  },

  /** 子节点渲染装饰:计数文案;选择模式下计算禁用与原因;deleting 置灰标注(#116) */
  decorate(children) {
    const pickMode = this.data.mode === "pick";
    return children.map((c) => {
      let disabled = false;
      let disabledReason = "";
      const deleting = c.deleting === true;
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
        if (deleting) {
          // #116 冻结门客户端半边:deleting 并入 disabled——「选这个」不再渲染,
          // 点行提示原因;服务端仍以 INVALID_INPUT{reason:"deleting"} 硬门兜底
          disabled = true;
          disabledReason = "该位置正在清理中,稍后再选";
        }
      }
      const parts: string[] = [];
      // issue #116(D0 §3.1 发现点二):deleting 节点置灰并标注续跑入口
      if (deleting) {
        parts.push("清理中·转为未归类未完成");
      }
      if (c.item_count > 0) {
        parts.push(c.item_count + " 件");
      }
      if (c.child_count > 0) {
        parts.push(c.child_count + " 个子位置");
      }
      // ⑥ 树行语义图标(批次乙接线):无资产双空串 → wxml 回退首字徽章(现状)
      const art = locationIconArtwork(c.name);
      return {
        ...c,
        deleting,
        countText: parts.length > 0 ? parts.join(" · ") : "空",
        disabled,
        disabledReason,
        icon: art.icon,
        iconDark: art.iconDark,
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
    if (Date.now() < this.suppressTapUntil) {
      return; // ① 长按弹菜单后紧跟的 tap 不再触发下钻(不依赖基础库互斥的防御位)
    }
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

  /**
   * ① 长按子节点行(#121 批次乙):与 ⋯ 同款 ActionSheet、同一处理,根层与
   * 各级统一;长按触发后微信不派发 tap,行点击跳转天然不发生,本处理自身
   * 也绝不导航(与 onChildMore 同门:browse 且非 acting 才弹)。
   */
  onChildLongPress(e) {
    if (this.data.mode !== "browse" || this.data.acting) {
      return;
    }
    const index = Number(e.currentTarget.dataset.index);
    const node = this.childAt(index);
    if (!node) {
      return;
    }
    this.suppressTapUntil = Date.now() + 350;
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
      if (targetId === this.nodeId) {
        // ④ 并入本层自身:原地刷新后短高亮本层头部
        this.pendingHl = targetId;
        this.applyPendingHighlight();
        return;
      }
      // ④ 合并完成同理高亮相关节点:按方案进目标层,hl=目标节点 id
      // (落层后高亮本层头部,并入的内容就在正下方)
      navToLocationLayer(targetId, targetId);
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

  /** 「⋯ → 删除」流程:先拉影响面计数,再开四选弹层(纯读) */
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
          // issue #116(D0 §3.1 发现点一):上次「转为未归类」未完成 ⇒ 附续跑摘要,
          // 只提示不自动发起(恢复=用户显式触发)
          pendingUnmount: preview.pending_unmount || null,
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
      // 迁移冲突/作用域变化是可重试的收敛语义:如实提示,弹层保留供重试;
      // deleting 冻结门(含后代向交叉域)单独翻译——通用「输入不合法」不知所云
      this.deleteLayerBusy(false);
      wx.showModal({ title: "删除失败", content: deletingFrozenMessage(e) || errorMessage(e), showCancel: false });
    }
  },

  onPurgeTap() {
    const layer = this.data.deleteLayer;
    if (!layer.visible || layer.busy || this.data.acting) {
      return;
    }
    void this.doPurgeDelete();
  },

  /* ------------------------------------------------------------------
   * issue #116「转为未归类」(D0 v4 §3 四选弹层):deleteLocation(mode:
   * "unmount")——子树物品逐件解挂进「尚未归类」(location_text 保留原记录),
   * 节点随 B1 检查点六步终结。对带 deleting 检查点的根重入即续跑(恢复路径,
   * 用户显式触发);UNMOUNT_CONFLICT=已解挂 N 件、M 件需先核对(弹层保留,
   * 核对后重新预览);UNMOUNT_INCOMPLETE=未完成如实提示可继续,绝不假报成功。
   * ------------------------------------------------------------------ */

  onUnmountTap() {
    const layer = this.data.deleteLayer;
    if (!layer.visible || layer.busy || this.data.acting) {
      return;
    }
    void this.doUnmountDelete();
  },

  async doUnmountDelete() {
    const layer = this.data.deleteLayer;
    if (!layer.visible || layer.busy) {
      return;
    }
    this.deleteLayerBusy(true);
    try {
      const res = await callLocationsApi({
        action: "deleteLocation",
        node_id: layer.nodeId,
        mode: "unmount",
      });
      // 完成提示展示转未归类总数(合同 §3「N 件已转未归类」):阶段一 unmounted
      // 与阶段二补偿 compensated(窗口期悬挂件)都进了「尚未归类」,总数取二者之和
      const total =
        (Number(res.unmounted) || 0) + (Number(res.compensated) || 0);
      this.setData({
        deleteLayer: { ...this.data.deleteLayer, visible: false, busy: false, pendingUnmount: null },
      });
      wx.showToast({
        title: total > 0 ? "已删除;" + total + " 件物品已转未归类" : "已删除",
        icon: total > 0 ? "none" : "success",
        duration: total > 0 ? 3000 : 1500,
      });
      await this.loadNode();
    } catch (e) {
      this.deleteLayerBusy(false);
      if (isLocationsApiErrorWithCode(e, "UNMOUNT_CONFLICT")) {
        const d = (e.detail || {}) as { unmounted?: unknown; conflicts?: unknown };
        const done = Number(d.unmounted) || 0;
        const pending = Array.isArray(d.conflicts) ? d.conflicts.length : 0;
        // 冲突熔断(P0-A):旧预览计数已过期,弹层随冲突关闭——核对后重新预览→
        // 重新确认发起下一轮(新预览自然只含剩余物品),不得带着旧计数直接再点
        this.setData({
          deleteLayer: { ...this.data.deleteLayer, visible: false, busy: false, pendingUnmount: null },
        });
        wx.showModal({
          title: "有物品需要先核对",
          content:
            "已解挂 " + done + " 件、" + pending + " 件因他处修改需先核对。请到这些物品的详情页确认最新位置后,重新打开清理并预览,再确认下一轮。",
          showCancel: false,
        });
        return;
      }
      if (isLocationsApiErrorWithCode(e, "UNMOUNT_INCOMPLETE")) {
        // 删根后复扫分支(评审 5660650680 文案修正):终检后的轻量复扫发现残留孤儿
        // (或复扫失败无法证实零残留)时,原根已硬删、检查点已随之清除——绝不提示
        // 「再点一次即可继续清理」(已删位置无从续跑),只建议人工核对
        const d = (e.detail || {}) as { post_root_orphans?: unknown; rescan_failed?: unknown };
        if (Array.isArray(d.post_root_orphans) || d.rescan_failed === true) {
          this.setData({
            deleteLayer: { ...this.data.deleteLayer, visible: false, busy: false, pendingUnmount: null },
          });
          wx.showModal({
            title: "删除后需人工核对",
            content:
              "位置已删除,但检测到删除期间的新增写入产生了残留的孤立位置;清理记录已随位置一并删除、无法自动恢复,请人工核对后再行处理。",
            showCancel: false,
          });
          return;
        }
        wx.showModal({
          title: "清理未完成",
          content: "上次的「转为未归类」还没完成,物品都在;再点一次「转为未归类」即可继续清理。",
          showCancel: false,
        });
        return;
      }
      if (isLocationsApiErrorWithCode(e, "UNMOUNT_CHECKPOINT_CORRUPT")) {
        wx.showModal({ title: "清理记录异常", content: errorMessage(e), showCancel: false });
        return;
      }
      // deleting 冻结门(含后代向交叉域:子位置有未完成的清理)单独翻译
      wx.showModal({ title: "删除失败", content: deletingFrozenMessage(e) || errorMessage(e), showCancel: false });
    }
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
      // deleting 冻结门(含后代向交叉域:子位置有未完成的清理)单独翻译
      wx.showModal({ title: "删除失败", content: deletingFrozenMessage(e) || errorMessage(e), showCancel: false });
    }
  },

  /** 弹层防冒泡占位(点面板不吃掉遮罩关闭) */
  noop() {},

  /* ------------------------------------------------------------------
   * ②「+」面板(#121 批次乙):与 ⋯ 同视觉等级的加号按钮 → 半屏面板
   * (根层=常用房间预设 chips / 子层=家具级预设 + 自定义输入);建节点
   * 走既有 ensurePath(created_from:"manual"),重名走既有 NODE_CONFLICT
   * 语义(添加失败如实提示,面板保留可改选)。
   * ------------------------------------------------------------------ */

  /** 打开「+」面板:根层给房间预设,子层给家具预设 */
  onAddTap() {
    if (this.data.mode !== "browse" || this.data.acting) {
      return;
    }
    this.setData({
      addPanel: {
        visible: true,
        presets: (this.data.isRoot ? ROOT_ROOM_PRESETS : SUB_FURNITURE_PRESETS) as string[],
        customName: "",
      },
    });
  },

  onAddPanelClose() {
    this.setData({ addPanel: { ...this.data.addPanel, visible: false } });
  },

  onAddPanelInput(e) {
    this.setData({ addPanel: { ...this.data.addPanel, customName: e.detail.value } });
  },

  /** 预设 chip:一键创建(与自定义同一 doAdd,冲突同语义) */
  onAddPresetTap(e) {
    if (this.data.acting) {
      return;
    }
    const name = String(e.currentTarget.dataset.name || "");
    if (!name) {
      return;
    }
    void this.doAdd(name);
  },

  onAddCustomTap() {
    if (this.data.acting) {
      return;
    }
    const name = this.data.addPanel.customName.trim();
    if (!name) {
      wx.showToast({ title: "名称不能为空", icon: "none" });
      return;
    }
    void this.doAdd(name);
  },

  /** 手动添加子位置(根层=添加房间):ensurePath created_from:"manual" */
  async doAdd(name) {
    this.setData({ acting: true });
    try {
      await callLocationsApi({
        action: "ensurePath",
        path: this.nodePath.concat([name]),
        created_from: "manual",
      });
      this.setData({ addPanel: { ...this.data.addPanel, visible: false } });
      wx.showToast({ title: "已添加", icon: "success" });
      await this.loadNode();
    } catch (e) {
      // 重名(NODE_CONFLICT)等如实提示;面板保留,可改选或换自定义名
      wx.showModal({ title: "添加失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /* ------------------------------------------------------------------
   * ③ 位置内直接添加物品(#121 批次乙,方案 Z):非根层「+ 添加物品」
   * 简单表单(名称+数量步进器+单位选择器,复用确认页既有组件模式)→
   * itemsApi.create(纯文本 location=当前节点路径 join " / ")→
   * locations.linkItem 挂到本节点(不引入 createItem 节点字段)。
   * 建档或挂载失败=如实提示;挂载失败绝不回滚已建档物品(弱网中断时
   * 稍后从首页「尚未归类」找回,挂载可手动补)。
   * ------------------------------------------------------------------ */

  /** 打开添加物品表单(仅非根层:物品不允许挂 home 根) */
  onAddItemTap() {
    if (this.data.mode !== "browse" || this.data.acting || this.data.isRoot) {
      return;
    }
    this.setData({
      addPanel: { ...this.data.addPanel, visible: false },
      itemPanel: { visible: true, createOperationId: "", frozenName: "", frozenQuantity: 0, frozenUnitIndex: 0, frozenLocationText: "", name: "", quantity: 1, unitIndex: 0, busy: false },
    });
  },

  onItemPanelClose() {
    if (this.data.itemPanel.busy) {
      return; // 提交进行中不允许关闭(防半途丢上下文)
    }
    this.setData({ itemPanel: { ...this.data.itemPanel, visible: false } });
  },

  onItemNameInput(e) {
    this.setData({ itemPanel: { ...this.data.itemPanel, name: e.detail.value } });
  },

  /** 数量步进器:[1, 9999](QUANTITY_MAX 冻结上限,新建下限 1) */
  onItemQtyStep(e) {
    const d = Number(e.currentTarget.dataset.d) || 0;
    const next = this.data.itemPanel.quantity + d;
    const clamped = Math.min(QUANTITY_MAX, Math.max(1, next));
    this.setData({ itemPanel: { ...this.data.itemPanel, quantity: clamped } });
  },

  onItemUnitChange(e) {
    const index = Number(e.detail.value);
    if (!(index >= 0) || index >= UNIT_SET.length) {
      return;
    }
    this.setData({ itemPanel: { ...this.data.itemPanel, unitIndex: index } });
  },

  /** 两步落库:create(建档,纯文本位置=本层路径)→ linkItem(挂本节点) */
  async onItemSaveTap() {
    const panel = this.data.itemPanel;
    if (!panel.visible || panel.busy || this.data.acting) {
      return;
    }
    const name = panel.name.trim();
    if (!name) {
      wx.showToast({ title: "名称不能为空", icon: "none" });
      return;
    }
    const nodeId = this.data.currentNodeId;
    if (!nodeId || this.data.isRoot) {
      return; // 根层无此入口的防御位(物品不允许挂 home 根)
    }
    // 服务端权威路径文本 = path.join(" / ")(与 D1/B 页挂载同约定)
    const locationText = this.nodePath.join(" / ");
    // 建档幂等(评审 5663031433 P1):同一次面板会话固定 operation_id,
    // 服务端已建档但客户端超时 → 重试返回已有物品(duplicated),绝不重复建档
    // 建档请求冻结(评审 5664505818 终案):首笔生成 operation_id 时快照全部字段;
    // 未知结果(超时)下重试强制用冻结值——用户改了表单也用原始内容重试(幂等返回已有物品),
    // 不自动生成新 key(旧请求可能已成功,新 key=第二件物品);表单修改仅在结果确定后生效
    if (!panel.createOperationId) {
      panel.createOperationId = uuid();
      panel.frozenName = name;
      panel.frozenQuantity = panel.quantity;
      panel.frozenUnitIndex = panel.unitIndex;
      panel.frozenLocationText = locationText;
      this.setData({ itemPanel: { ...panel } });
    }
    // 未知结果下重试:用冻结值(不是表单当前值)
    const submitName = panel.frozenName || name;
    const submitQuantity = panel.frozenQuantity || panel.quantity;
    const submitUnit = UNIT_SET[panel.frozenUnitIndex ?? panel.unitIndex];
    this.setData({ itemPanel: { ...this.data.itemPanel, busy: true }, acting: true });
    let created: { item_id: string; version: number } | null = null;
    try {
      const res = await callItemsApi({
        action: "create",
        operation_id: panel.createOperationId,
        name: submitName,
        location_text: panel.frozenLocationText || locationText,
        quantity: submitQuantity,
        unit: submitUnit,
      });
      created = { item_id: res.item.item_id, version: res.item.version };
      await callLocationsApi({
        action: "linkItem",
        item_id: created.item_id,
        node_id: nodeId,
        expected_version: created.version,
        update_id: uuid(),
      });
      this.setData({ itemPanel: { ...this.data.itemPanel, visible: false, busy: false } });
      wx.showToast({ title: "已添加", icon: "success" });
      await this.loadNode();
      // ④ 原地短高亮新物品(本层即可见)
      this.pendingHl = created.item_id;
      this.applyPendingHighlight();
    } catch (e) {
      this.setData({ itemPanel: { ...this.data.itemPanel, busy: false } });
      // 建档超时(响应未到):物品可能已保存(operation_id 幂等,重试不重复)
      // ——如实描述,不直接断言失败;提示重试(服务端幂等返回已有物品)
      if (created === null && isApiError(e) && (e.code === "NETWORK_ERROR" || e.code === "TIMEOUT" || errorMessage(e).indexOf("超时") !== -1 || errorMessage(e).indexOf("timeout") !== -1)) {
        wx.showModal({
          title: "可能已保存",
          content: "网络不稳,物品可能已记住。点「重试」确认(不会重复添加);或稍后在首页查看。",
          confirmText: "重试",
          cancelText: "稍后查看",
          success: (r) => { if (r.confirm) { void this.onItemSaveTap(); } },
        });
        return;
      }
      if (created !== null) {
        // 挂载超时/失败分流(评审 5664505818):超时=「待核对」口径(可能已挂上);
        // 明确服务端拒绝=「没挂上」口径(确定失败)
        const mountTimeout = isApiError(e) && (e.code === "NETWORK_ERROR" || e.code === "TIMEOUT" || errorMessage(e).indexOf("超时") !== -1 || errorMessage(e).indexOf("timeout") !== -1);
        wx.showModal({
          title: mountTimeout ? "物品已保存，位置挂载状态待核对" : "已记住，但没挂上",
          content:
            "「" + name + "」已保存。" +
            (mountTimeout
              ? "位置挂载状态待核对——可能已挂到「" + this.data.currentNodeName + "」,也可能没挂上。"
              : "没能挂到「" + this.data.currentNodeName + "」。") +
            "稍后可从首页「尚未归类」或本位置查找;如未挂上,从物品详情手动挂载。" +
            "(" + errorMessage(e) + ")",
          showCancel: false,
          success: () => {
            void this.loadNode();
          },
        });
        this.setData({ itemPanel: { ...this.data.itemPanel, visible: false } });
      } else {
        // 建档失败:如实提示,表单保留可重试(零写入)
        wx.showModal({ title: "添加失败", content: errorMessage(e), showCancel: false });
      }
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
    if (Date.now() < this.suppressTapUntil) {
      return; // ① 长按弹菜单后紧跟的 tap 不再打开详情
    }
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
    this.showItemActions(item);
  },

  /** ① 长按物品行:与 ⋯ 同款 ActionSheet(移动到…/从这里摘除),不触发打开详情 */
  onItemLongPress(e) {
    if (this.data.acting) {
      return;
    }
    const index = Number(e.currentTarget.dataset.index);
    const item = this.itemAt(index);
    if (!item) {
      return;
    }
    this.suppressTapUntil = Date.now() + 350;
    this.showItemActions(item);
  },

  showItemActions(item: DisplayItem) {
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
      if (nodeId === this.nodeId) {
        // ④ 目标即本层(plan=none):原地刷新后直接短高亮该物品行
        this.pendingHl = item.item_id;
        this.applyPendingHighlight();
        return;
      }
      // ④ 其余按方案跳目标层:栈内已有 → 回退不加层(pending 高亮由目标页
      // onShow 消费);否则前进带 hl(目标页 onLoad 读取);栈近满 redirect 兜底
      navToLocationLayer(nodeId, item.item_id);
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
    // locations.list 的物品投影不带数量(Q0-CONTRACT §2.4:零变化)——跳详情的
    // 初始摘要按未确认(null);详情页 onLoad 后 get 单查会以权威投影刷新
    const summary: ItemSummary = {
      item_id: item.item_id,
      name: item.name,
      location_text: item.location_text,
      note: item.note,
      version: item.version,
      updated_at: item.updated_at,
      quantity: null,
      unit: null,
      quantity_confirmed_at: null,
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
