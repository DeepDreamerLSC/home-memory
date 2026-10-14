import { callItemsApi, errorMessage } from "../../utils/api";
import { attachVoiceEntry, type VoiceEntryHandle } from "../../utils/voice-entry";
import type {
  ItemSummary,
  ListLocationsResponse,
  LocationNodeSummary,
} from "../../types";
import { getUnfinishedDraftSession } from "../../utils/draft-session";
import {
  captureScopeGeneration,
  isHouseholdScopeShared,
  isScopeGenerationCurrent,
  isScopeVerified,
} from "../../utils/household-scope";
import { ensureScopeVerified } from "../../utils/households-api";
import { callLocationsApi } from "../../utils/locations-api";
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

/** 地图格子用的子位置(附首字与计数文案) */
type DisplayRoom = {
  location_id: string;
  name: string;
  initial: string;
  countText: string;
};

/** 用于渲染的物品条目(附记录更新日期短文案,H1b 结果与容器条目共用) */
type DisplayItem = ItemSummary & { updated_at_short: string };

/** 容器视图栈的一层(点格子逐层压入;返回胶囊逐层弹出) */
interface ViewLayer {
  id: string;
  name: string;
}

function toDisplayItems(items: ItemSummary[]): DisplayItem[] {
  return items.map((item) => ({ ...item, updated_at_short: shortDate(item.updated_at) }));
}

/** 记录更新日期短文案(如 10-08;updated_at 不代表位置确认时间);非法时间如实返回空串 */
function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return "";
  }
  const d = new Date(t);
  const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
  return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** 格子计数文案:件数优先;没东西但有子位置时如实说明 */
function roomCountText(node: LocationNodeSummary): string {
  if (node.item_count > 0) {
    return node.item_count + " 件东西";
  }
  if (node.child_count > 0) {
    return node.child_count + " 个更细的位置";
  }
  return "还没记东西";
}

Page<
  {
    queryText: string;
    querying: boolean;
    queried: boolean;
    queryKeyword: string;
    queryResults: DisplayItem[];
    queryError: string;
    /** 未完成草稿会话恢复入口(非空时显示横幅) */
    resumeSession: { sid: string; count: number } | null;
    /** 家庭上下文头:共享家庭=「我们家」(带圆点),个人=「我的家」 */
    familyShared: boolean;
    /** 首用态(H0):根层既无房间也无未归位物品 */
    firstUse: boolean;
    /** 当前视图层首载中(X1 骨架屏;屏上无内容) */
    mapLoading: boolean;
    /** 屏上已有内容,后台刷新中(轻量指示,不整页 loading) */
    mapRefreshing: boolean;
    /** 后台刷新失败:保留旧树,如实提示「当前为上次记录」+ 可重试 */
    mapStale: boolean;
    /** 首载失败(X2):失败的是这次加载,不是记录没了 */
    mapError: string;
    /** 抬头:「家里有什么」/「X里有什么」 */
    mapTitle: string;
    /** 返回胶囊文案(上一层名;根层为空不显示) */
    backLabel: string;
    /** 是否根层视图(根层无「⋯」整理入口;「尚未归类」通栏格只在根层) */
    isRootView: boolean;
    /** 当前容器名(非根层「直接记录在 X」标题用) */
    containerName: string;
    rooms: DisplayRoom[];
    directItems: DisplayItem[];
    /** 未归位物品数(仅根层通栏格;>0 才显示,只显计数) */
    unmountedCount: number;
    /** 结构操作进行中(改名/移动/合并),防止并发重复提交 */
    acting: boolean;
    /** H0 大语音 CTA 的语音状态(状态机在 utils/voice-entry 单例) */
    voiceState: "idle" | "recording" | "cancelPending";
    transcribing: boolean;
    extracting: boolean;
    recordSeconds: number;
    partialText: string;
    /** 手指按住 H0 大 CTA(按压反馈) */
    ctaPressed: boolean;
  },
  {
    onLoad(options: Record<string, string | undefined>): void;
    onShow(): void;
    onHide(): void;
    onUnload(): void;
    refreshFamilyChip(): void;
    /** 语音录入入口共享句柄(H0 大 CTA 的宿主;voice-bar 组件另有自己的宿主) */
    voiceEntry: VoiceEntryHandle | null;
    ensureVoiceEntry(): void;
    onTalkTouchStart(e: WechatMiniprogram.TouchEvent): void;
    onTalkTouchMove(e: WechatMiniprogram.TouchEvent): void;
    onTalkTouchEnd(): void;
    onTalkTouchCancel(): void;
    voiceFallbackToText(): void;
    /** 「用文字记」/ 搜索空态「记一件」:进文字核对页 */
    onTextRecordTap(): void;
    onQueryInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onQueryTap(): Promise<void>;
    onResultTap(e: WechatMiniprogram.CustomEvent): void;
    /** 收起搜索结果,回家里地图 */
    onCollapseResultsTap(): void;
    onResumeTap(): void;
    currentResumeSession(): { sid: string; count: number } | null;
    /** 地图当前层加载(X1/X2 与分层缓存、防旧覆盖守卫全在这里) */
    requestSeq: LocationsRequestSeq;
    /** 当前视图层是否已有内容上屏(决定骨架还是轻量刷新) */
    renderedCurrentView: boolean;
    /** 上次上屏时的家庭作用域代数(切换后旧家庭内容先清空再加载) */
    renderedScopeGen: number | null;
    /** 上次上屏的搜索结果所属家庭作用域代数(H1b 与地图同一防旧覆盖硬约束) */
    queriedScopeGen: number | null;
    /** 上次上屏是否首用态(检测「首件已记住」的转折,自动收起旧空搜索) */
    lastFirstUse: boolean;
    /** 容器视图栈(本页状态内维护;离开再返回仍停在原层) */
    viewStack: ViewLayer[];
    /** 当前层节点标识与完整 path(容器「⋯」整理动作的目标) */
    currentNodeId: string;
    currentNodePath: string[];
    loadMapLayer(force?: boolean, retryOnStaleGen?: boolean): Promise<void>;
    renderMap(res: ListLocationsResponse): void;
    onRetryTap(): void;
    onRoomTap(e: WechatMiniprogram.CustomEvent): void;
    onBackTap(): void;
    onDirectItemTap(e: WechatMiniprogram.CustomEvent): void;
    openItem(item: DisplayItem, spacePath?: string[]): void;
    /** 容器抬头「⋯」整理位置:改名/移动/合并(复用 locations 页动作与确认交互) */
    onContainerMore(): void;
    currentContainer(): { location_id: string; name: string; path: string[] } | null;
    renameContainer(node: { location_id: string; name: string }): void;
    doRename(
      node: { location_id: string; name: string },
      name: string,
    ): Promise<void>;
    moveContainer(node: { location_id: string; name: string; path: string[] }): void;
    doMove(node: { location_id: string }, newParentId: string): Promise<void>;
    mergeContainer(node: { location_id: string; name: string; path: string[] }): void;
    doMerge(
      node: { location_id: string; name: string },
      targetId: string,
    ): Promise<void>;
    openPicker(
      title: string,
      excludePath: string,
      onPick: (nodeId: string) => void,
    ): void;
    /** 「我们家/我的家」入口:进家庭管理页 */
    onFamilyTap(): void;
  }
>({
  data: {
    queryText: "",
    querying: false,
    queried: false,
    queryKeyword: "",
    queryResults: [],
    queryError: "",
    resumeSession: null as { sid: string; count: number } | null,
    familyShared: false,
    firstUse: false,
    mapLoading: true,
    mapRefreshing: false,
    mapStale: false,
    mapError: "",
    mapTitle: "家里有什么",
    backLabel: "",
    isRootView: true,
    containerName: "",
    rooms: [],
    directItems: [],
    unmountedCount: 0,
    acting: false,
    voiceState: "idle",
    transcribing: false,
    extracting: false,
    recordSeconds: 0,
    partialText: "",
    ctaPressed: false,
  },

  voiceEntry: null,
  requestSeq: createRequestSeq(),
  renderedCurrentView: false,
  renderedScopeGen: null as number | null,
  queriedScopeGen: null as number | null,
  lastFirstUse: true,
  viewStack: [] as ViewLayer[],
  currentNodeId: "",
  currentNodePath: [] as string[],

  onLoad(options) {
    // Page options 会被浅拷贝共享,实例字段按本页实例重建(locations 页同款防护)
    this.requestSeq = createRequestSeq();
    this.renderedCurrentView = false;
    this.renderedScopeGen = null;
    this.queriedScopeGen = null;
    this.lastFirstUse = true;
    this.viewStack = [];
    this.currentNodeId = "";
    this.currentNodePath = [];
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

  onShow() {
    this.refreshFamilyChip();
    void this.loadMapLayer();
    // 未完成草稿会话恢复入口(中途退出/进程回收;原幂等键续存,不重复建档)。
    // 展示前资格复核(硬门 C):先等服务端家庭上下文验证,未验证期间不把
    // 旧家庭的未完成批次当作当前可访问内容展示;验证失败时保持无横幅
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

  /** 家庭上下文头刷新(来自 household-scope 记忆;app 前台复核后已最新) */
  refreshFamilyChip() {
    this.setData({ familyShared: isHouseholdScopeShared() });
  },

  /**
   * 语音录入入口(utils/voice-entry 单例共享模块):状态机全在模块内,
   * 本页只挂宿主(H0 大 CTA 的渲染与文字回退);底部常驻条是 voice-bar 组件,
   * 自带宿主,按压方(presser)路由保证回退与提示只回发起方。
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
      fallbackToText: () => {
        this.voiceFallbackToText();
      },
    });
  },

  onTalkTouchStart(e) {
    if (this.voiceEntry === null) {
      return;
    }
    this.setData({ ctaPressed: true });
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
    this.setData({ ctaPressed: false });
    if (this.voiceEntry !== null) {
      this.voiceEntry.pressEnd();
    }
  },

  onTalkTouchCancel() {
    this.setData({ ctaPressed: false });
    if (this.voiceEntry !== null) {
      this.voiceEntry.pressCancel();
    }
  },

  /** 录音授权被拒选「用文字」:进文字核对页(与 voice-bar 的回退一致) */
  voiceFallbackToText() {
    if (this.voiceEntry !== null) {
      this.voiceEntry.invalidate();
    }
    this.setData({ voiceState: "idle", transcribing: false, extracting: false, partialText: "" });
    wx.navigateTo({
      url: "/pages/confirm/confirm?manual=true",
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  onTextRecordTap() {
    wx.navigateTo({
      url: "/pages/confirm/confirm?manual=true",
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  /* ---------------- 找东西(H1b:命中按物品分组,就地展示) ---------------- */

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
    // 家庭切换(创建/加入/退出/被移除)会递增作用域代数:查询在途回来时
    // 家庭已变,旧家庭的结果与失败提示都不上屏(T5:无旧家庭缓存穿透)
    const scopeGen = captureScopeGeneration();
    this.setData({ querying: true, queryError: "" });
    try {
      const res = await callItemsApi({ action: "query", q });
      if (!isScopeGenerationCurrent(scopeGen)) {
        return; // 查询在途期间家庭已切换:旧家庭结果不上屏
      }
      this.queriedScopeGen = scopeGen;
      this.setData({
        queried: true,
        queryKeyword: q,
        queryResults: toDisplayItems(res.items),
      });
    } catch (e) {
      if (!isScopeGenerationCurrent(scopeGen)) {
        return; // 同上:旧家庭的失败提示也不上屏
      }
      this.queriedScopeGen = scopeGen;
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

  onCollapseResultsTap() {
    this.queriedScopeGen = null;
    this.setData({ queried: false, queryKeyword: "", queryResults: [], queryError: "" });
  },

  onResumeTap() {
    const resume = this.data.resumeSession;
    if (resume === null) {
      return;
    }
    this.setData({ resumeSession: null });
    wx.navigateTo({
      url: "/pages/confirm/confirm?sid=" + resume.sid,
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  /** 未完成批次数据按当前家庭作用域读取(键隔离,P0;验证后才读,硬门 C) */
  currentResumeSession() {
    const unfinished = getUnfinishedDraftSession();
    if (unfinished === null) {
      return null;
    }
    return { sid: unfinished.sid, count: unfinished.payload.drafts.length };
  },

  /* ---------------- 家庭地图(H1:容器视图整页切换,X1/X2 全守卫) ---------------- */

  /**
   * 拉取当前视图层:缓存先行 + 条件刷新(issue #23 分层缓存),迟到响应不上屏
   * (issue #24 请求序号),在途写失效作废补拉(缓存失效代数),家庭切换
   * (作用域代数)时旧家庭响应不上屏、视图回根层按新家庭重载——加载中绝不
   * 拿上个家庭的旧数据冒充当前内容。作用域未经服务端验证时不读持久化缓存。
   */
  async loadMapLayer(force?: boolean, retryOnStaleGen?: boolean): Promise<void> {
    const scopeGen = captureScopeGeneration();
    if (
      (this.renderedScopeGen !== null &&
        !isScopeGenerationCurrent(this.renderedScopeGen)) ||
      (this.queriedScopeGen !== null &&
        !isScopeGenerationCurrent(this.queriedScopeGen))
    ) {
      // 家庭已切换(创建/加入/退出/被移除):屏上旧家庭内容立即清空——含
      // H1b 搜索结果(旧家庭的搜索会整页压住新家庭地图)、视图回根层,再按
      // 当前家庭加载(X1 硬约束:不先显示旧家庭再等纠正)
      this.viewStack = [];
      this.currentNodeId = "";
      this.currentNodePath = [];
      this.renderedCurrentView = false;
      this.renderedScopeGen = null;
      this.queriedScopeGen = null;
      this.lastFirstUse = true;
      this.setData({
        rooms: [],
        directItems: [],
        unmountedCount: 0,
        mapTitle: "家里有什么",
        backLabel: "",
        isRootView: true,
        containerName: "",
        firstUse: false,
        mapError: "",
        mapStale: false,
        mapRefreshing: false,
        mapLoading: true,
        queried: false,
        queryKeyword: "",
        queryResults: [],
        queryError: "",
      });
    }
    const nodeId = this.viewStack.length > 0
      ? this.viewStack[this.viewStack.length - 1].id
      : "";
    const seq = this.requestSeq.next();
    const cacheGen = captureCacheGeneration();
    const cached =
      !isScopeVerified() ? null : readLocationsLayer(nodeId);
    const plan = planLocationsLoad({
      cached,
      fresh: cached !== null && isLocationsCacheFresh(cached),
      force: force === true,
      pickMode: false,
      rendered: this.renderedCurrentView,
    });
    if (plan.useCache && cached !== null) {
      this.renderMap(cached.response); // 缓存先行上屏:有旧内容绝不整页骨架
    }
    this.setData({
      mapLoading: plan.skeleton,
      mapRefreshing: plan.fetch && !plan.skeleton,
      mapStale: false,
      mapError: "",
    });
    if (!plan.fetch) {
      return; // TTL 内直接用缓存、不触发云函数
    }
    try {
      const res = await callLocationsApi(
        nodeId ? { action: "list", parent_id: nodeId } : { action: "list" },
      );
      if (!this.requestSeq.isCurrent(seq)) {
        return; // 迟到响应:既不 setData 也不写缓存
      }
      if (!isCacheGenerationCurrent(cacheGen)) {
        // 在途期间发生过写失效(其他页面改名/移动/挂载…):旧树不上屏不写
        // 缓存,补拉一次;连续写场景由 retryOnStaleGen 挡住不无限循环
        if (retryOnStaleGen !== false) {
          void this.loadMapLayer(force, false);
        } else {
          this.setData({ mapLoading: false, mapRefreshing: false, mapStale: true });
        }
        return;
      }
      if (!isScopeGenerationCurrent(scopeGen)) {
        // 在途期间家庭切换:旧家庭响应不上屏不写缓存;回根层按新家庭重载
        //(搜索结果同样按 queriedScopeGen 在入口守卫里一并收起)
        this.viewStack = [];
        this.currentNodeId = "";
        this.currentNodePath = [];
        this.renderedCurrentView = false;
        this.renderedScopeGen = null;
        this.queriedScopeGen = null;
        this.lastFirstUse = true;
        this.setData({
          rooms: [],
          directItems: [],
          unmountedCount: 0,
          mapTitle: "家里有什么",
          backLabel: "",
          isRootView: true,
          containerName: "",
          firstUse: false,
          mapError: "",
          mapStale: false,
          mapRefreshing: false,
          mapLoading: true,
          queried: false,
          queryKeyword: "",
          queryResults: [],
          queryError: "",
        });
        void this.loadMapLayer(false, false);
        return;
      }
      writeLocationsLayer(nodeId, res, Date.now(), cacheGen);
      this.renderMap(res); // 刷新成功:原位 setData 更新,不闪屏
      this.setData({ mapLoading: false, mapRefreshing: false, mapStale: false, mapError: "" });
    } catch (e) {
      if (!this.requestSeq.isCurrent(seq)) {
        return;
      }
      if (this.renderedCurrentView) {
        // 刷新失败:保留旧树 + 如实提示可重试;不更新缓存时间戳
        this.setData({ mapLoading: false, mapRefreshing: false, mapStale: true });
      } else {
        this.setData({ mapLoading: false, mapRefreshing: false, mapError: errorMessage(e) });
      }
    }
  },

  /** list 响应(缓存或服务端)→ 上屏数据;容器视图栈与响应保持一致 */
  renderMap(res: ListLocationsResponse) {
    const isRoot = res.node.type === "home";
    if (isRoot) {
      this.viewStack = [];
    } else if (
      this.viewStack.length === 0 ||
      this.viewStack[this.viewStack.length - 1].id !== res.node.location_id
    ) {
      // 防御:视图栈与响应不一致(不应发生的异常路径)——退回根层重载,
      // 不用 path 名字自造层级(祖先 id 客户端拿不到)
      this.viewStack = [];
      this.renderedCurrentView = false;
      void this.loadMapLayer(false, false);
      return;
    } else {
      this.viewStack[this.viewStack.length - 1].name = res.node.name;
    }
    this.currentNodeId = res.node.location_id;
    this.currentNodePath = res.node.path || [];
    const rooms: DisplayRoom[] = res.children.map((c) => ({
      location_id: c.location_id,
      name: c.name,
      initial: c.name.length > 0 ? c.name[0] : "?",
      countText: roomCountText(c),
    }));
    this.renderedCurrentView = true;
    this.renderedScopeGen = captureScopeGeneration();
    const firstUse =
      isRoot && rooms.length === 0 && res.items.length === 0 && res.unmounted_count === 0;
    // 首件已记住(H0 → H1):旧的空搜索结果不再挡着地图,自动收起
    if (this.lastFirstUse && !firstUse && this.data.queried) {
      this.queriedScopeGen = null;
      this.setData({ queried: false, queryKeyword: "", queryResults: [], queryError: "" });
    }
    this.lastFirstUse = firstUse;
    this.setData({
      firstUse,
      mapTitle: isRoot ? "家里有什么" : res.node.name + "里有什么",
      backLabel: isRoot
        ? ""
        : res.node.path.length >= 2
          ? res.node.path[res.node.path.length - 2]
          : "家里",
      isRootView: isRoot,
      containerName: isRoot ? "" : res.node.name,
      rooms,
      directItems: toDisplayItems(res.items),
      unmountedCount: res.unmounted_count,
    });
  },

  /** X2 失败态「再试一次」/「当前为上次记录」提示条:点按强制刷新 */
  onRetryTap() {
    void this.loadMapLayer(true);
  },

  /** 点格子:整页切入该容器(中间区域整体替换,抬头随之变化) */
  onRoomTap(e) {
    if (this.data.acting) {
      return;
    }
    const index = Number(e.currentTarget.dataset.index);
    const room = this.data.rooms[index];
    if (!room) {
      return;
    }
    const fromRoot = this.data.isRootView;
    this.viewStack.push({ id: room.location_id, name: room.name });
    this.renderedCurrentView = false;
    this.setData({
      isRootView: false,
      backLabel: fromRoot ? "家里" : this.data.containerName,
      containerName: room.name,
      mapTitle: room.name + "里有什么",
      rooms: [],
      directItems: [],
      unmountedCount: 0,
    });
    void this.loadMapLayer();
  },

  /** 返回胶囊:逐层退回(栈内上一层 id 是钻入时记下的,不靠推测) */
  onBackTap() {
    if (this.data.acting) {
      return;
    }
    this.viewStack.pop();
    this.renderedCurrentView = false;
    const parent =
      this.viewStack.length > 0 ? this.viewStack[this.viewStack.length - 1] : null;
    this.setData({
      isRootView: parent === null,
      containerName: parent ? parent.name : "",
      mapTitle: parent ? parent.name + "里有什么" : "家里有什么",
      backLabel: parent
        ? this.viewStack.length >= 2
          ? this.viewStack[this.viewStack.length - 2].name
          : "家里"
        : "",
      rooms: [],
      directItems: [],
    });
    void this.loadMapLayer();
  },

  onDirectItemTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.directItems[index];
    if (item) {
      // 容器条目直接记在当前层:把这条路径带给详情页(只读大卡「上次记在」);
      // 搜索结果不知道路径,不传(详情页只用原话,不猜)
      this.openItem(item, !this.data.isRootView ? this.currentNodePath : []);
    }
  },

  openItem(item: DisplayItem, spacePath: string[] = []) {
    const summary: ItemSummary = {
      item_id: item.item_id,
      name: item.name,
      location_text: item.location_text,
      note: item.note,
      version: item.version,
      updated_at: item.updated_at,
    };
    const params = ["data=" + encodeURIComponent(JSON.stringify(summary))];
    if (spacePath.length > 0) {
      params.push("path=" + encodeURIComponent(JSON.stringify(spacePath)));
    }
    wx.navigateTo({
      url: "/pages/item/item?" + params.join("&"),
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  /* ---------------- 容器「⋯」整理位置(复用 locations 页动作与确认交互) ---------------- */

  onContainerMore() {
    if (this.data.acting) {
      return;
    }
    const current = this.currentContainer();
    if (current === null) {
      return;
    }
    wx.showActionSheet({
      itemList: ["改名", "移动到…", "合并到…"],
      success: (r) => {
        if (r.tapIndex === 0) {
          this.renameContainer(current);
        } else if (r.tapIndex === 1) {
          this.moveContainer(current);
        } else if (r.tapIndex === 2) {
          this.mergeContainer(current);
        }
      },
      fail: () => {},
    });
  },

  currentContainer() {
    const top =
      this.viewStack.length > 0 ? this.viewStack[this.viewStack.length - 1] : null;
    // 当前层数据未就绪(加载中/失败,currentNodeId 还是上一层的)或已在根层:无目标
    if (top === null || top.id !== this.currentNodeId) {
      return null;
    }
    return {
      location_id: this.currentNodeId,
      name: this.data.containerName,
      path: this.currentNodePath,
    };
  },

  renameContainer(node) {
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
      await this.loadMapLayer(true);
    } catch (e) {
      wx.showModal({ title: "改名失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 移动当前容器:进选择模式选「新父位置」(home 根不可作目标,服务端同理拒绝) */
  moveContainer(node) {
    this.openPicker(
      "把「" + node.name + "」移到…",
      node.path.join("/"),
      (picked) => {
        void this.doMove(node, picked);
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
      // 容器搬了家:视图栈里的祖先层已过时(客户端拿不到新祖先 id),
      // 如实回根层重新看整张地图,不猜层级
      this.viewStack = [];
      this.currentNodeId = "";
      this.currentNodePath = [];
      this.renderedCurrentView = false;
      this.setData({
        isRootView: true,
        containerName: "",
        mapTitle: "家里有什么",
        backLabel: "",
        rooms: [],
        directItems: [],
      });
      await this.loadMapLayer(true);
    } catch (e) {
      wx.showModal({ title: "移动失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 合并重复位置:人工确认后进选择模式选目标(不自动合并) */
  mergeContainer(node) {
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
        this.openPicker(
          "把「" + node.name + "」并进…",
          node.path.join("/"),
          (picked) => {
            void this.doMerge(node, picked);
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
      // 这个位置已消失:退回上一层(父层 id 是钻入时记下的,仍有效)
      this.viewStack.pop();
      this.currentNodeId = "";
      this.currentNodePath = [];
      this.renderedCurrentView = false;
      const parent =
        this.viewStack.length > 0 ? this.viewStack[this.viewStack.length - 1] : null;
      this.setData({
        isRootView: parent === null,
        containerName: parent ? parent.name : "",
        mapTitle: parent ? parent.name + "里有什么" : "家里有什么",
        backLabel: parent
          ? this.viewStack.length >= 2
            ? this.viewStack[this.viewStack.length - 2].name
            : "家里"
          : "",
        rooms: [],
        directItems: [],
      });
      await this.loadMapLayer(true);
    } catch (e) {
      // merge 冲突中止是「可重试」的收敛语义:如实提示后由用户重走一次合并
      wx.showModal({ title: "合并失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 以选择模式进 locations 页,选中后经 EventChannel 回传(退栈由本页统一计算) */
  openPicker(title, excludePath, onPick) {
    const params = ["picker=1", "title=" + encodeURIComponent(title)];
    if (excludePath) {
      params.push("exclude_path=" + encodeURIComponent(excludePath));
    }
    wx.navigateTo({
      url: "/pages/locations/locations?" + params.join("&"),
      events: {
        pickNode: (d: { location_id: string }) => {
          onPick(d.location_id);
          // 选择器页只叠在本页正上方,一次退掉全部(#29 后续真机反馈:
          // 多页各自 navigateBack 在导航风暴中会被吞掉)
          const pages = getCurrentPages();
          const idx = pages.indexOf(this);
          const delta = pages.length - 1 - idx;
          if (idx !== -1 && delta > 0) {
            wx.navigateBack({ delta, fail: () => {} });
          }
        },
      },
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  /** 家庭管理页入口(创建/邀请/成员/退出/解散;issue #34 P1-B) */
  onFamilyTap() {
    wx.navigateTo({
      url: "/pages/family/family",
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },
});
