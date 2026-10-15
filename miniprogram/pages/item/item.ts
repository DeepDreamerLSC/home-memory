import {
  ApiError,
  callItemsApi,
  errorMessage,
  formatDateTime,
  uuid,
} from "../../utils/api";
import { ensureScopeVerified } from "../../utils/households-api";
import {
  callLocationsApi,
  isLocationsApiErrorWithCode,
} from "../../utils/locations-api";
import {
  captureScopeGeneration,
  isHouseholdScopeShared,
  isScopeGenerationCurrent,
} from "../../utils/household-scope";
import {
  askUseUp,
  expireMainText,
  localTodayYmd,
  monthDayText,
  pickerDateProblem,
} from "../../utils/remind-ui";
import {
  buildUpdateChanges,
  carryUnresolved,
  chosenValue,
  conflictUnresolved,
  mergeLatest,
  resolveRemindChoice,
} from "../../utils/conflict";
import type {
  ConflictChoice,
  ConflictField,
  EditableField,
} from "../../utils/conflict";
import type { ItemSummary, RemindKind, RemindRow } from "../../types";

/** 页面 query 参数不会自动解码;容错解码(已解码或含非法 % 时原样返回) */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 记录更新日期短文案(如 10-08,与首页一致;updated_at 不代表位置确认时间);非法时间如实返回空串 */
function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return "";
  }
  const d = new Date(t);
  const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
  return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/**
 * 解析跳转方带来的空间路径(进入时的容器层 path,JSON 字符串数组)。
 * 只信严格结构:非数组 / 含非字符串 / 超过 6 段一律视为没有,不猜。
 */
function parseSpacePath(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const p = JSON.parse(safeDecode(raw)) as unknown;
    if (!Array.isArray(p) || p.length === 0 || p.length > 6) {
      return [];
    }
    if (!p.every((seg) => typeof seg === "string" && seg.trim().length > 0)) {
      return [];
    }
    return p.map((seg) => (seg as string).trim());
  } catch {
    return [];
  }
}

/** 刷新最新数据的结果 */
type RefreshResult = "refreshed" | "notfound" | "error";

/** 冲突态面板里的单个字段条目:两版值 + 用户显式选择(null 表示尚未选择);
    display* 为并排展示文案(提醒日期换算成用户词汇) */
type ConflictEntry = ConflictField & {
  choice: ConflictChoice | null;
  localDisplay: string;
  remoteDisplay: string;
};

/** 冲突面板里某字段值的展示口径:提醒换算为「X 到期 / 不带提醒」,文本空值为「(空)」 */
function conflictDisplayText(key: EditableField, value: string): string {
  if (key === "remind") {
    return value ? monthDayText(value) + " 到期" : "不带提醒";
  }
  return value || "(空)";
}

Page<
  {
    itemId: string;
    name: string;
    locationText: string;
    note: string;
    version: number;
    updatedAtText: string;
    /** 头部「记录更新于 MM-DD」(updated_at:名称/备注/位置任意修改都会刷新,只说明记录更新,不代表确认过位置;非法时间退化为完整时间,再退化则不显示) */
    lastConfirmedText: string;
    /** 只读大卡的当前空间路径(进入时的容器层;整理位置成功后更新) */
    spacePath: string[];
    /** 编辑表单是否展开(常态折叠,先答案后操作) */
    editPanelOpen: boolean;
    /** 「⋯」次级菜单(底部弹层)是否展开 */
    moreOpen: boolean;
    /** 共享家庭才显示「分享给家人」 */
    familyShared: boolean;
    saving: boolean;
    deleting: boolean;
    /** 「整理位置」解析中(parseLocation) */
    mounting: boolean;
    /** 候选分段面板是否展开 */
    mountPanelOpen: boolean;
    /** parseLocation 的候选分段(可逐段改名) */
    mountSegments: Array<{
      idx: number;
      name: string;
      confidenceText: string;
      needConfirm: boolean;
      hintName: string;
    }>;
    mountNeedConfirm: boolean;
    mountOrderViolation: boolean;
    /** 确认整理执行中(ensurePath + linkItem) */
    mountSaving: boolean;
    /**
     * 保质期行(#36):这件有 active 提醒才显示(mainText=有效期+相对天数,
     * kind=「已处理」时收掉本轮提醒);null=无 active 提醒,整行不渲染
     */
    expire: { mainText: string; dueDate: string; kind: string } | null;
    /** 编辑折叠「提醒」字段的当前日期(YYYY-MM-DD;""=不带提醒) */
    remindAt: string;
    /**
     * 页面所见提醒轮次号(PR #52 B1):-1=未知(未加载/加载失败/旧服务端缺
     * generation)——此时一律不发 reminder 写(F4-B2,绝不退回旧协议无条件写),
     * 先补拉读到 0/真实轮次后才带 expected_generation 提交;0=已确认无提醒
     * (补录语义);≥1=所见轮次
     */
    remindGeneration: number;
    /** 今天(YYYY-MM-DD):编辑提醒的日期选择器下限 */
    today: string;
    /** 提醒操作执行中(已处理/改日期/清除;防并发重复提交) **/
    remindBusy: boolean;
    /**
     * 当时提到时间但没换算的原话子串(0.6.0 真机反馈 Fix 4,来自 itemsApi.get
     * 的 remind_vague_quote):录入时「说了时间但没换算成日期」的如实留痕,
     * 只展示、不产生任何提醒;已有 active 提醒(到期行在屏)时不再显示。
     */
    vagueQuote: string;
    /** 版本冲突后待处理的冲突字段(名称/位置/备注/提醒);为空表示无冲突态 */
    conflicts: ConflictEntry[];
    /** 存在未选择的冲突字段时禁止再次保存(按钮禁用 + 双保险门禁) */
    conflictPending: boolean;
  },
  {
    original: { name: string; location: string; note: string };

    /**
     * 提醒字段与服务器对齐的基准日期(YYYY-MM-DD;""=确认无提醒):
     * 文本字段的三方合并基准是 original,提醒单独一份,口径相同——
     * refreshForConflict 之后 = 服务端最新值,用户显式选择前表单值与它不一致即待落库
     */
    remindOriginal: string;

    /**
     * 最近一次冲突刷新时提醒行是否不可得(拉取失败 / 在途家庭切换):
     * true = 该轮提醒没有与远端比较、基准也没对齐,用户待写的提醒选择仍在
     * 表单里等下次保存补写——提示文案须如实说「没存上」,不能说「已刷新」
     */
    remindRemoteUnknown: boolean;

    /** 刷新冲突时拿到的远端提醒行 kind(选「采用最新记录」后到期行展示用) */
    remoteRemindKind: RemindKind;

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
    /** 展开 / 收起编辑表单(只读大卡为常态) */
    onEditToggle(): void;
    /* ---------------- 冲突面板(issue #6:同字段多设备双值对比 + 显式选边) ---------------- */
    onChooseLocal(e: WechatMiniprogram.BaseEvent): void;
    onChooseRemote(e: WechatMiniprogram.BaseEvent): void;
    applyConflictChoice(key: EditableField, choice: ConflictChoice): void;
    syncConflictFromInput(key: EditableField, value: string): void;
    dismissConflictsIfSettled(): void;
    hasRemindConflict(): boolean;
    setPendingRemind(date: string): void;
    pendingRemindWrite(): { action: "remindSet" | "remindClear"; dueDate: string } | null;
    refreshForConflict(): Promise<RefreshResult>;
    onSaveTap(): Promise<void>;
    /** 「⋯」次级菜单:开 / 关 / 三项动作 */
    onMoreTap(): void;
    onSheetClose(): void;
    onShareTap(): void;
    onTidyTap(): void;
    onDeleteTap(): void;
    confirmDelete(): Promise<void>;
    applySummary(s: ItemSummary): void;
    goBack(): void;
    /** 按 item_id 直接打开(get 单查;生成向导的 skipped 件跳转用) */
    loadById(id: string): Promise<void>;
    onMountTap(): Promise<void>;
    onMountSegmentInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    openLocationPicker(): void;
    doLinkToNode(nodeId: string, path?: string[]): Promise<void>;
    confirmMount(): Promise<void>;
    cancelMount(): void;
    /**
     * F4-B3:冲突未裁定时的「整理位置」写入门禁——冲突面板还在(仍有未选边
     * 字段,或选完还没保存/收敛)且表单位置仍不同于已确认基准(original):
     * 此时挂载会把 node 指向按未裁定文本解析的位置,服务端 location_text
     * 仍是对方值,位置事实分裂。返回 true = 禁止发起 ensurePath/linkItem。
     */
    mountBlockedByConflict(): boolean;
    /** 阻止弹层蒙层下的滚动穿透 */
    noop(): void;
    /* ---------------- 提醒(#36 三阶段) ---------------- */
    fetchReminderRow(): Promise<RemindRow | null | undefined>;
    /**
     * F4-B2/F4-B4:轮次未知(-1)时写前补拉一次提醒行,结果三分支:
     * - "unknown":拉取失败/在途切换/旧服务端仍不回轮次——失败关闭,调用方
     *   绝不退回旧协议无条件写(F4-B2);
     * - "known":远端确认无提醒(轮次 0,补录语义)或远端内容与用户已确认
     *   基准(remindOriginal 语义)一致——对齐轮次与基准后按轮次正常提交,
     *   表单里的用户候选原样保留;
     * - "diverged":远端已是与基准不同的内容且用户尚未知悉——不得直接写
     *   (F4-B4,CAS 只保证提交瞬间无新变化,不构成对他人已有修改的知情选择),
     *   调用方保留候选并进入既有冲突双值面板,显式选边后才能写。
     */
    reloadRemindGeneration(): Promise<"known" | "unknown" | "diverged">;
    refreshReminderRow(): Promise<void>;
    applyReminderRow(row: RemindRow | null): void;
    /** 保质期行「已处理」:确认后 remindComplete **/
    onExpireDoneTap(): Promise<void>;
    /** 编辑折叠「提醒」:picker mode=date 选日子 → remindSet 设提醒(无则补录,有则改期) */
    onRemindDateChange(e: WechatMiniprogram.CustomEvent<{ value: string }>): Promise<void>;
    /** 编辑折叠「提醒」:✕ 连日期一起清除(remindClear;不存在存日期但不提醒) */
    onRemindFieldClear(): Promise<void>;
  }
>({
  data: {
    itemId: "",
    name: "",
    locationText: "",
    note: "",
    version: 0,
    updatedAtText: "",
    lastConfirmedText: "",
    spacePath: [],
    editPanelOpen: false,
    moreOpen: false,
    familyShared: false,
    saving: false,
    deleting: false,
    mounting: false,
    mountPanelOpen: false,
    mountSegments: [],
    mountNeedConfirm: false,
    mountOrderViolation: false,
    mountSaving: false,
    expire: null as { mainText: string; dueDate: string; kind: string } | null,
    remindAt: "",
    remindGeneration: -1,
    today: localTodayYmd(),
    remindBusy: false,
    vagueQuote: "",
    conflicts: [] as ConflictEntry[],
    conflictPending: false,
  },

  /** 最近一次加载到的内容,用于判断是否有修改 */
  original: { name: "", location: "", note: "" },

  remindOriginal: "",

  remindRemoteUnknown: false,

  remoteRemindKind: "下次维护" as RemindKind,

  pendingRetry: null as {
    updateId: string;
    changes: { name?: string; location_text?: string; note?: string };
  } | null,

  onLoad(options) {
    // 空间路径来自进入时的容器层(首页地图 / 空间页点开的条目);
    // 搜索等入口没有路径就不显示,只用原话,不自造
    this.setData({
      spacePath: parseSpacePath(options.path),
      familyShared: isHouseholdScopeShared(),
    });
    const rawItemId = options.item_id;
    if (rawItemId) {
      // 按 id 直接打开(生成向导的 skipped 件、结果页跳转):get 单查不受 list 分页影响
      this.setData({ itemId: safeDecode(rawItemId) });
      void this.loadById(safeDecode(rawItemId));
      return;
    }
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

  onShow() {
    // 家庭上下文可能切换(创建/加入/退出):「分享给家人」只在共享家庭显示
    this.setData({ familyShared: isHouseholdScopeShared() });
    // 保质期行(#36):进页/回页时按服务端提醒刷新;加载失败静默不显示(增强露出)。
    // 提醒冲突待选时不刷:面板里「你的修改」是用户正要存的值,回页刷新会把它
    // 悄悄换回服务端值(文字字段没有 onShow 刷新,提醒同口径不搞特殊)。
    // 表单里还有待补写的提醒选择时(冲突刷新那轮提醒远端不可得,选择留在表单
    // 等保存补写)同样不刷:refreshReminderRow 会先清空 remindAt,选择会无痕蒸发
    if (!this.hasRemindConflict() && this.pendingRemindWrite() === null) {
      void this.refreshReminderRow();
    }
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

  /* ---------------- 冲突面板(issue #6,移植自 PR #12 并扩展提醒字段) ---------------- */

  /**
   * 冲突态下用户直接编辑了冲突字段:仅把面板上的「你的修改」同步为最新输入,
   * 不视为显式选择——门禁要求点选按钮,避免「不看面板、在输入框敲个空格再删掉」
   * 就绕过冲突确认直接覆盖(issue #6:必须知悉对方修改后明确选择)。
   * 输入会撤回该字段已做的选择(既有选择已不再反映输入框内容);
   * 程序 setData 不触发 input 事件,「采用最新记录」按钮写入的值不会被误判为输入。
   */
  syncConflictFromInput(key: EditableField, value: string): void {
    const idx = this.data.conflicts.findIndex((c) => c.key === key);
    if (idx < 0) {
      return;
    }
    const entry = this.data.conflicts[idx];
    const trimmed = value.trim();
    const patch: Record<string, unknown> = {};
    if (entry.localValue !== trimmed) {
      patch["conflicts[" + idx + "].localValue"] = trimmed;
      patch["conflicts[" + idx + "].localDisplay"] = conflictDisplayText(key, trimmed);
    }
    if (entry.choice !== null) {
      patch["conflicts[" + idx + "].choice"] = null;
      patch.conflictPending = true;
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
    // 选定值回填表单:文本字段选远端即与最新基准一致(保存时无变化、不自动再写),
    // 选本地则保留用户值,下次保存以最新 expected_version 提交该字段;
    // 提醒字段选远端同样回显即停,选本地的补写口径与 resolveRemindChoice 同源。
    const patch: Record<string, unknown> = {};
    if (key === "remind") {
      const resolution = resolveRemindChoice(entry, choice);
      patch.remindAt = resolution.displayDate;
      patch.expire = resolution.displayDate
        ? {
            mainText: expireMainText(resolution.displayDate),
            dueDate: resolution.displayDate,
            kind: choice === "remote" ? this.remoteRemindKind : "下次维护",
          }
        : null;
    } else {
      patch[key === "location" ? "locationText" : key] = chosenValue(entry, choice);
    }
    this.setData({
      ...patch,
      ["conflicts[" + idx + "].choice"]: choice,
      conflictPending: this.data.conflicts.some((c, i) => i !== idx && !c.choice),
    });
    this.dismissConflictsIfSettled();
  },

  /**
   * 冲突全部选完且表单已与最新基准完全一致(典型:全部采用最新记录且无其他改动)
   * 时收起面板。此时没有任何待提交内容,保留面板只会引导一次
   * 注定「内容没有变化」的保存,让用户找不到出口。
   */
  dismissConflictsIfSettled(): void {
    if (this.data.conflicts.length === 0) {
      return;
    }
    if (conflictUnresolved(this.data.conflicts)) {
      return;
    }
    const changes = buildUpdateChanges(this.original, {
      name: this.data.name.trim(),
      location: this.data.locationText.trim(),
      note: this.data.note.trim(),
    });
    if (Object.keys(changes).length === 0 && this.pendingRemindWrite() === null) {
      this.setData({ conflicts: [], conflictPending: false });
      wx.showToast({ title: "已与最新记录一致", icon: "none" });
    }
  },

  onChooseLocal(e) {
    this.applyConflictChoice(e.currentTarget.dataset.key as EditableField, "local");
  },

  onChooseRemote(e) {
    this.applyConflictChoice(e.currentTarget.dataset.key as EditableField, "remote");
  },

  /** 「提醒」是否正处于冲突待选:在冲突面板里时,改日期/清除只更新「你的修改」,不直接落库 */
  hasRemindConflict(): boolean {
    return this.data.conflicts.some((c) => c.key === "remind");
  },

  /** 冲突流程中把「你正要存的提醒值」留在表单(到期行同步,便于对照两版) */
  setPendingRemind(date: string): void {
    this.setData({
      remindAt: date,
      expire: date
        ? { mainText: expireMainText(date), dueDate: date, kind: "下次维护" }
        : null,
    });
  },

  /**
   * 待补的提醒写操作:表单提醒日期与最新基准不一致即需要落库——
   * 冲突面板选「保留我的修改」(选中值 ≠ 最新记录),或面板被整理位置等
   * 路径重新对齐后遗留的未落库选择。写法复用既有提醒路径:
   * 有日期 remindSet、清空 remindClear,轮次号用刷新后的最新所见轮次。
   */
  pendingRemindWrite(): { action: "remindSet" | "remindClear"; dueDate: string } | null {
    if (this.data.remindAt === this.remindOriginal) {
      return null; // 表单与最新基准一致(选了远端或本无差异):不写
    }
    const entry = this.data.conflicts.find((c) => c.key === "remind");
    if (entry && entry.choice !== null) {
      const resolution = resolveRemindChoice(entry, entry.choice);
      if (resolution.writeAction === null) {
        return null;
      }
      return {
        action: resolution.writeAction === "set" ? "remindSet" : "remindClear",
        dueDate: resolution.writeDate,
      };
    }
    return this.data.remindAt === ""
      ? { action: "remindClear", dueDate: "" }
      : { action: "remindSet", dueDate: this.data.remindAt };
  },

  /** 编辑折叠:常态只读,点开才出现表单;保存成功后自动收回 */
  onEditToggle() {
    this.setData({ editPanelOpen: !this.data.editPanelOpen });
  },

  applySummary(s: ItemSummary) {
    this.original = {
      name: s.name,
      location: s.location_text,
      note: s.note,
    };
    // PR #48 复审 B2:updated_at 在名称/备注/位置任意修改时都会刷新,不能冒充
    // 「位置确认时间」——文案只如实说明记录更新时间
    const short = shortDate(s.updated_at);
    // vagueQuote(Fix 4)只在 get(详情)响应携带;update 等其余投影不带时
    // 保留现值——编辑内容不会动掉「当时提到时间」的留痕
    const vague = typeof (s as { remind_vague_quote?: unknown }).remind_vague_quote === "string"
      ? (s as { remind_vague_quote?: string }).remind_vague_quote || ""
      : this.data.vagueQuote;
    this.setData({
      itemId: s.item_id,
      name: s.name,
      locationText: s.location_text,
      note: s.note,
      version: s.version,
      updatedAtText: formatDateTime(s.updated_at),
      lastConfirmedText: short
        ? "记录更新于 " + short
        : s.updated_at
          ? "记录更新于 " + formatDateTime(s.updated_at)
          : "",
      vagueQuote: vague,
      // 新基准落地:冲突面板随之作废(保存成功/重新进页都会走到这里)
      conflicts: [],
      conflictPending: false,
    });
  },

  /**
   * 保存修改:文本字段走 itemsApi update(expected_version 条件更新);
   * 冲突选「保留我的修改」的提醒(或遗留的未落库提醒)按既有 remindSet /
   * remindClear 路径补写(expected_generation 用刷新后的最新所见轮次)。
   * 冲突字段未全部显式选择前,按钮禁用 + 此处再设一道门禁(双保险)。
   */
  async onSaveTap() {
    if (this.data.saving || this.data.deleting) {
      return;
    }
    if (this.data.conflictPending || conflictUnresolved(this.data.conflicts)) {
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
    let remindWrite = this.pendingRemindWrite();
    if (Object.keys(changes).length === 0 && remindWrite === null) {
      // 冲突态下走到这里 = 冲突字段全部选了「采用最新记录」且无其他改动:
      // 表单已与最新基准一致,收起面板,不给用户留一个只会空跑的面板。
      if (this.data.conflicts.length > 0) {
        this.setData({ conflicts: [], conflictPending: false });
      }
      wx.showToast({ title: "内容没有变化", icon: "none" });
      return;
    }
    // 同样内容的重试复用同一 update_id:服务端据此把「自己刚写入但响应丢失」的重放
    // 识别为 replayed 成功,而不是误报 VERSION_CONFLICT;内容一变即生成新 update_id。
    const hasTextChanges = Object.keys(changes).length > 0;
    const retry = this.pendingRetry;
    const samePayload =
      retry !== null &&
      retry.changes.name === changes.name &&
      retry.changes.location_text === changes.location_text &&
      retry.changes.note === changes.note;
    const updateId = samePayload ? retry.updateId : uuid();
    this.setData({ saving: true });
    try {
      if (hasTextChanges) {
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
      }
      if (remindWrite !== null && this.data.remindGeneration < 0) {
        // F4-B2:轮次未知(未加载/加载失败/冲突刷新远端不可得)绝不退回旧协议
        // 无条件写——先补拉一次(候选保留);补拉后与最新一致则无需再写,
        // 仍读不到轮次则如实说没存上,文本部分已存好,提醒候选留在表单等重试
        const outcome = await this.reloadRemindGeneration();
        if (outcome === "diverged") {
          // F4-B4:补拉撞见远端已是不同内容且用户从未看过:不得直接写——
          // 保留候选,进入既有冲突双值面板(远端值 vs 本地候选),显式选边
          // 保存时以刷新后的最新轮次提交
          const result = await this.refreshForConflict();
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
                ? "提醒与最新记录冲突,请选择保留哪一版"
                : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                  ? "提醒没存上,你的选择已保留,点保存修改再试"
                  : "这条提醒刚被家人改过,已刷新",
              icon: "none",
              duration: 2500,
            });
          }
          return;
        }
        remindWrite = outcome === "known" ? this.pendingRemindWrite() : remindWrite;
        if (outcome === "unknown") {
          wx.showToast({
            title: "提醒没存上,提醒还没加载好,你的选择已保留,稍后再试",
            icon: "none",
            duration: 2500,
          });
          return;
        }
      }
      if (remindWrite !== null) {
        try {
          if (remindWrite.action === "remindSet") {
            // 选「保留我的修改」的提醒以刷新后的最新轮次号重发(既有 remindSet 路径):
            // 提交瞬间他处又改 → 服务端轮次门禁再次拒绝,重新进入双值对比。
            // 轮次未知已被上方 F4-B2 门禁拦下,这里必带轮次,绝不省略
            const r = await callItemsApi({
              action: "remindSet",
              item_id: this.data.itemId,
              due_date: remindWrite.dueDate,
              expected_generation: this.data.remindGeneration,
            });
            this.applyReminderRow(r.reminder);
          } else {
            await callItemsApi({
              action: "remindClear",
              item_id: this.data.itemId,
              expected_generation: this.data.remindGeneration,
            });
            this.applyReminderRow(null);
          }
        } catch (e2) {
          if (e2 instanceof ApiError && e2.code === "VERSION_CONFLICT") {
            // 提交瞬间提醒又被他处改过:文本部分已存好,提醒重新比较、再次显式选择;
            // 提醒行拉取失败时远端不可得:选择留在表单等下次保存补写,如实说没存上
            const result = await this.refreshForConflict();
            if (result === "refreshed") {
              wx.showToast({
                title: this.data.conflictPending
                  ? "提醒与最新记录冲突,请选择保留哪一版"
                  : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                    ? "提醒没存上,你的选择已保留,点保存修改再试"
                    : "这条提醒刚被家人改过,已刷新",
                icon: "none",
                duration: 2500,
              });
            }
            return;
          }
          // 提醒没存上但文本已保存:如实分开告知,不合并成一句「保存失败」
          wx.showModal({
            title: "提醒没存上",
            content: errorMessage(e2),
            showCancel: false,
          });
          this.setData({ conflicts: [], conflictPending: false });
          return;
        }
      }
      // 全部落库:收回冲突面板与编辑折叠,回到只读答案
      this.setData({ conflicts: [], conflictPending: false, editPanelOpen: false });
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (e) {
      // 记录失败的更新供重试复用 update id(仅同样内容且有文本变更的重试)
      if (hasTextChanges) {
        this.pendingRetry = { updateId, changes };
      }
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        // 刷新后:无冲突字段则维持原提示(静默三方合并);有冲突字段则进入冲突态,
        // 编辑折叠内逐字段并排「你的修改 / 最新记录」,选择后才允许再次提交。
        const result = await this.refreshForConflict();
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
   * 冲突态入口(issue #6,四字段版):保存(update)、改提醒(remindSet/remindClear)
   * 或整理位置(linkItem)命中 VERSION_CONFLICT 后,拉服务端最新物品 + 最新提醒,
   * 对名称/位置/备注/提醒逐字段三方比较——
   * - 非冲突字段:静默三方合并(用户改过保留用户值,否则采纳服务端值),既有语义;
   * - 冲突字段(双方都改且互不相同):进入冲突态,编辑折叠内并排两版值,
   *   逐项显式选择后才能再次保存,绝不静默覆盖;
   * - 上一轮未选边的冲突字段跨刷新保留(carryUnresolved):基准对齐远端后,
   *   它们会退化成「仅本机修改」被静默合并,面板与门禁不能就此消失。
   * 提醒行拉取失败或家庭在途切换时不猜远端:该字段本轮不参与比较、基准维持
   * 原值,用户待写的提醒选择留在表单等下次保存补写(见函数内注释)。
   */
  async refreshForConflict(): Promise<RefreshResult> {
    let item;
    try {
      const res = await callItemsApi({ action: "get", item_id: this.data.itemId });
      item = res.item;
    } catch (e) {
      if (e instanceof ApiError && e.code === "NOT_FOUND") {
        // 冲突期间记录已被删除:不弹「刷新失败」,交由调用方提示「记录不存在」并返回
        return "notfound";
      }
      wx.showModal({
        title: "刷新失败",
        content: errorMessage(e),
        showCancel: false,
      });
      return "error";
    }
    const row = await this.fetchReminderRow();
    // 提醒远端不可得(undefined,拉取失败/在途家庭切换)时不猜远端:本轮按「未变」
    // 参与比较(不判冲突、不改表单),但基准绝不向表单现值对齐——对齐会让用户
    // 待写的提醒选择蒸发(表单与基准一致后,既不随保存补写、也进不了冲突面板)。
    // 基准维持原值,选择留在表单,下次保存按原所见轮次号补写;届时他处若又改过,
    // 服务端轮次门禁会再次拦下、重新进流程
    this.remindRemoteUnknown = row === undefined;
    const remoteRemind = row === undefined ? this.remindOriginal : row ? row.due_date : "";
    const localValues = {
      name: this.data.name.trim(),
      location: this.data.locationText.trim(),
      note: this.data.note.trim(),
      remind: this.data.remindAt,
    };
    const remoteValues = {
      // note 兜底为空串:早期写入的旧文档可能缺该字段,原样透传 undefined
      // 会让冲突比较与表单 .trim() 拿到非字符串(服务端投影已兜底,这里双保险)
      name: item.name,
      location: item.location_text,
      note: item.note || "",
      remind: remoteRemind,
    };
    const outcome = mergeLatest(
      { ...this.original, remind: this.remindOriginal },
      localValues,
      remoteValues,
    );
    // 上一轮未选边的冲突字段跨刷新保留:基准已对齐远端,这些字段本轮会退化成
    // 「仅本机修改」被静默合并——面板一收、门禁即失守,对方的修改就被无声覆盖
    const carried = carryUnresolved(
      this.data.conflicts,
      outcome.conflicts,
      localValues,
      remoteValues,
    );
    if (row === undefined) {
      // 提醒远端不可得时无从重判:上一轮未选边的提醒条目原样保留
      // (仅把「你的修改」同步为表单现值),门禁不撤
      const prevRemind = this.data.conflicts.find(
        (c) => c.key === "remind" && c.choice === null
      );
      if (
        prevRemind &&
        !outcome.conflicts.some((c) => c.key === "remind") &&
        !carried.some((c) => c.key === "remind")
      ) {
        carried.push({
          key: "remind",
          label: prevRemind.label,
          localValue: localValues.remind,
          remoteValue: prevRemind.remoteValue,
        });
      }
    }
    const entries = outcome.conflicts.concat(carried);
    this.original = {
      name: item.name,
      location: item.location_text,
      note: item.note || "",
    };
    if (row !== undefined) {
      // 只有远端提醒真拿到了才对齐基准;不可得时维持原基准(见上方注释)
      this.remindOriginal = remoteRemind;
    }
    this.remoteRemindKind = row ? row.kind : "下次维护";
    const hasConflicts = entries.length > 0;
    const shown = outcome.merged.remind;
    const remindPatch: Record<string, unknown> =
      row === undefined
        ? {}
        : {
            remindAt: shown,
            expire: shown
              ? {
                  mainText: expireMainText(shown),
                  dueDate: shown,
                  kind: row && shown === row.due_date ? row.kind : "下次维护",
                }
              : null,
            remindGeneration: row
              ? typeof row.generation === "number"
                ? row.generation
                : -1
              : 0,
          };
    this.setData({
      name: outcome.merged.name,
      locationText: outcome.merged.location,
      note: outcome.merged.note,
      version: item.version,
      updatedAtText: formatDateTime(item.updated_at),
      conflicts: entries.map((c) => ({
        ...c,
        choice: null,
        localDisplay: conflictDisplayText(c.key, c.localValue),
        remoteDisplay: conflictDisplayText(c.key, c.remoteValue),
      })),
      conflictPending: hasConflicts,
      // 冲突面板在编辑折叠内:强制展开,保证用户看得见两版值再选
      editPanelOpen: hasConflicts ? true : this.data.editPanelOpen,
      ...remindPatch,
    });
    return "refreshed";
  },

  /* ---------------- 「⋯」次级菜单(编辑/整理/删除都收进这里) ---------------- */

  onMoreTap() {
    this.setData({ moreOpen: true });
  },

  onSheetClose() {
    this.setData({ moreOpen: false });
  },

  /**
   * 分享给家人(仅共享家庭显示):这里如实说明语义——共享家庭里这条记录
   * 本来就人人可见,没有单独分享这个动作,也不假装写入。
   */
  onShareTap() {
    this.setData({ moreOpen: false });
    wx.showModal({
      title: "分享给家人",
      content:
        "这条记录已经在「我们家」的共享记录里,家里每个人打开就能看到,不用再单独分享。",
      confirmText: "知道了",
      showCancel: false,
    });
  },

  /** 整理位置:收起菜单后走既有 parseLocation → 逐段核对 → ensurePath + linkItem */
  onTidyTap() {
    this.setData({ moreOpen: false });
    void this.onMountTap();
  },

  /** 删除:先收起菜单,再 wx.showModal 二次确认 */
  onDeleteTap() {
    this.setData({ moreOpen: false });
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

  async loadById(id) {
    try {
      const res = await callItemsApi({ action: "get", item_id: id });
      this.applySummary(res.item);
    } catch (e) {
      wx.showModal({
        title: "无法打开",
        content: errorMessage(e),
        showCancel: false,
        success: () => {
          this.goBack();
        },
      });
    }
  },

  /**
   * F4-B3:冲突未裁定时「整理位置」的写入门禁。冲突面板还在(仍有未选边
   * 字段,或已选边但还没保存/收敛——面板只有在表单与最新基准一致时才会收起)
   * 且表单位置仍不同于已确认基准时返回 true:此时挂载会把 location_node_id
   * 指向按本地未裁定文本解析的位置,服务端 location_text 仍是对方值,位置
   * 事实分裂。选边并保存(基准重置、面板收起)或位置收敛后自然放行。
   */
  mountBlockedByConflict(): boolean {
    if (this.data.conflicts.length === 0 && !this.data.conflictPending) {
      return false; // 无冲突态:普通编辑照旧可整理(既有行为)
    }
    return this.data.locationText.trim() !== this.original.location;
  },

  /**
   * 整理位置:parseLocation 零写库出候选分段 → 用户逐段核对(可改)→
   * ensurePath + linkItem。AI 不可用时兜底为手动选位置(选择模式)。
   */
  async onMountTap() {
    if (this.data.saving || this.data.deleting || this.data.mounting) {
      return;
    }
    if (this.mountBlockedByConflict()) {
      // F4-B3(架构复审阻断):冲突未裁定且待提交位置仍异于已确认基准时,
      // 挂载会按本地未裁定文本建/指节点,而服务端 location_text 仍是对方值
      // ——位置事实分裂。先逐项选边并保存,再整理位置
      wx.showToast({
        title: "位置冲突还没处理,先选保留哪一版并保存,再整理位置",
        icon: "none",
        duration: 2500,
      });
      return;
    }
    const text = this.data.locationText.trim();
    if (!text) {
      wx.showToast({ title: "这条记录还没有位置描述,先在编辑里补一句", icon: "none" });
      return;
    }
    this.setData({ mounting: true });
    try {
      const res = await callLocationsApi({
        action: "parseLocation",
        text,
      });
      const parse = res.parse;
      const hints = new Map<number, string>();
      for (const s of parse.merge_suggestions) {
        if (!hints.has(s.segment_index)) {
          hints.set(s.segment_index, s.existing_name);
        }
      }
      this.setData({
        mountPanelOpen: true,
        mountNeedConfirm: parse.need_confirm,
        mountOrderViolation: parse.order_violation,
        mountSegments: parse.segments.map((seg, i) => ({
          idx: i,
          name: seg.name,
          confidenceText: Math.round(seg.confidence * 100) + "%",
          needConfirm: seg.confidence < 0.8,
          hintName: hints.get(i) || "",
        })),
      });
    } catch (e) {
      if (isLocationsApiErrorWithCode(e, "AI_UNAVAILABLE")) {
        wx.showModal({
          title: "AI 暂时不可用",
          content: "解析不了这句位置,要改为手动选一个已有位置吗?",
          confirmText: "手动选位置",
          cancelText: "取消",
          success: (r) => {
            if (r.confirm) {
              this.openLocationPicker();
            }
          },
        });
        return;
      }
      wx.showModal({
        title: "解析失败",
        content: errorMessage(e),
        showCancel: false,
      });
    } finally {
      this.setData({ mounting: false });
    }
  },

  onMountSegmentInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const value = e.detail && e.detail.value ? e.detail.value : "";
    const rows = this.data.mountSegments.slice();
    if (!rows[index]) {
      return;
    }
    rows[index] = { ...rows[index], name: value };
    this.setData({ mountSegments: rows });
  },

  /** AI 不可用的手动兜底:进 locations 选择模式,选中后直接 linkItem */
  openLocationPicker() {
    wx.navigateTo({
      url:
        "/pages/locations/locations?picker=1&title=" +
        encodeURIComponent("把「" + (this.data.name || "这件物品") + "」放到哪个位置…"),
      events: {
        pickNode: (d: { location_id: string; path?: string[] }) => {
          void this.doLinkToNode(d.location_id, d.path);
          // 退栈统一由发起页计算(选择器页自身不再逐层退,#29 后续):
          // 选择器页只叠在本页正上方,一次退掉全部。
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

  async doLinkToNode(nodeId, path) {
    if (this.mountBlockedByConflict()) {
      // F4-B3:选择器是异步回传,面板在选位置的这段时间里可能已弹出冲突——
      // 写入前再守一次门,与入口同一口径(先选边保存,再整理位置)
      wx.showToast({
        title: "位置冲突还没处理,先选保留哪一版并保存,再整理位置",
        icon: "none",
        duration: 2500,
      });
      return;
    }
    this.setData({ mountSaving: true });
    try {
      const res = await callLocationsApi({
        action: "linkItem",
        item_id: this.data.itemId,
        node_id: nodeId,
        expected_version: this.data.version,
        update_id: uuid(),
      });
      this.setData({
        version: res.item.version,
        updatedAtText: formatDateTime(res.item.updated_at),
        // 刚亲手选定的位置:大卡如实跟进(选择器回传的展示用路径)
        spacePath: Array.isArray(path) ? path : this.data.spacePath,
      });
      wx.showToast({ title: "已记到这个位置", icon: "success" });
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        // 物品被并发修改:与保存冲突同一口径走四字段冲突刷新——双方都改且不同
        // 的字段进冲突面板显式选边(未选完前保存被门禁拦住,上一轮未选边的
        // 条目也保留),绝不静默覆盖;无冲突字段维持三方合并,对齐版本后重试整理
        const result = await this.refreshForConflict();
        if (result === "notfound") {
          wx.showModal({
            title: "记录不存在",
            content: "没有找到这条记录,可能已被删除。",
            showCancel: false,
            success: () => {
              this.goBack();
            },
          });
          return;
        }
        if (result === "refreshed") {
          wx.showToast({
            title: this.data.conflictPending
              ? "部分字段与最新记录冲突,请逐项选择保留哪一版"
              : "内容已被修改,已更新版本号,请重试",
            icon: "none",
            duration: 2500,
          });
        }
      } else {
        wx.showModal({
          title: "整理失败",
          content: errorMessage(e),
          showCancel: false,
        });
      }
    } finally {
      this.setData({ mountSaving: false });
    }
  },

  /** 确认候选分段:ensurePath(用户确认后的唯一建节点入口)→ linkItem(版本条件更新) */
  async confirmMount() {
    if (this.data.mountSaving) {
      return;
    }
    if (this.mountBlockedByConflict()) {
      // F4-B3:候选面板是冲突前解析好的,确认时状态可能已变(异步写入前守门);
      // 冲突未裁定且位置异于基准时禁止 ensurePath/linkItem,先选边保存
      wx.showToast({
        title: "位置冲突还没处理,先选保留哪一版并保存,再整理位置",
        icon: "none",
        duration: 2500,
      });
      return;
    }
    const names = this.data.mountSegments
      .map((s) => s.name.trim())
      .filter((n) => n.length > 0);
    if (names.length === 0) {
      wx.showToast({ title: "至少填一段位置", icon: "none" });
      return;
    }
    this.setData({ mountSaving: true });
    try {
      const ensured = await callLocationsApi({
        action: "ensurePath",
        path: names,
        created_from: "parse",
      });
      const target = ensured.nodes[ensured.nodes.length - 1];
      if (!target) {
        throw new Error("服务返回异常");
      }
      const res = await callLocationsApi({
        action: "linkItem",
        item_id: this.data.itemId,
        node_id: target.location_id,
        expected_version: this.data.version,
        update_id: uuid(),
      });
      this.setData({
        version: res.item.version,
        updatedAtText: formatDateTime(res.item.updated_at),
        mountPanelOpen: false,
        // 刚确认并记入的位置分段:大卡如实跟进(与 ensurePath 收到的完全一致)
        spacePath: names,
      });
      wx.showToast({ title: "已记到这个位置", icon: "success" });
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        // 物品被并发修改:与保存冲突同一口径走四字段冲突刷新(冲突面板/门禁
        // 语义同 doLinkToNode 分支),无冲突字段三方合并对齐版本后重试整理
        const result = await this.refreshForConflict();
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
              : "内容已被修改,已更新版本号,请重试",
            icon: "none",
            duration: 2500,
          });
        }
      } else {
        wx.showModal({
          title: "整理失败",
          content: errorMessage(e),
          showCancel: false,
        });
      }
    } finally {
      this.setData({ mountSaving: false });
    }
  },

  cancelMount() {
    this.setData({ mountPanelOpen: false, mountSegments: [] });
  },

  /* ---------------- 提醒的查看与处理(#36 三阶段) ---------------- */

  /**
   * 拉当前家庭这件的 active 提醒行(只取数,不上屏):经 households 资格复核
   * (硬门 C,口径同 R1/首页),在途家庭切换(作用域代数变化)或加载失败时
   * 返回 undefined——调用方据此「不猜远端」,绝不把旧家庭/失败当作「无提醒」。
   */
  async fetchReminderRow(): Promise<RemindRow | null | undefined> {
    await ensureScopeVerified();
    // 复核可能揭示家庭漂移并递增代数:请求前重新捕获,响应后才校验
    const scopeGen = captureScopeGeneration();
    try {
      const res = await callItemsApi({ action: "remindList" });
      if (!isScopeGenerationCurrent(scopeGen)) {
        // 在途期间家庭已切换(含响应揭示的漂移):旧家庭响应不可用
        return undefined;
      }
      return res.reminders.find((r) => r.item_id === this.data.itemId) || null;
    } catch (e) {
      // 静默:提醒不可得,由调用方决定口径(详情主体不受影响)
      return undefined;
    }
  },

  /**
   * F4-B2:轮次未知(-1,未加载/加载失败/冲突刷新远端不可得)时的写前补拉。
   * 表单里的用户候选(remindAt)原样保留——补拉不是刷新展示,是给待发的写
   * 请求取 CAS 条件;拉不到("unknown")就失败关闭,绝不省略
   * expected_generation 退回旧协议无条件写。
   * F4-B4:补拉结果三分支收紧——远端确认无提醒(轮次 0,补录语义)或远端
   * 内容与用户已确认基准(remindOriginal 语义)一致才返回 "known"(对齐轮次
   * 与基准后按轮次正常提交);远端已是不同内容且用户尚未知悉返回 "diverged"
   * 且不做任何对齐:此时直接写会在用户从未看过远端值的情况下覆盖他人修改
   * (CAS 只保证提交瞬间无新变化,不构成知情选择),由调用方保留候选并进入
   * 既有冲突双值面板,显式选边后才能写。diverged 时也不把基准对齐到远端——
   * 对齐会让候选在随后的冲突刷新里退化成「仅本机修改」,绕开双值面板。
   */
  async reloadRemindGeneration(): Promise<"known" | "unknown" | "diverged"> {
    const row = await this.fetchReminderRow();
    if (row === undefined) {
      return "unknown";
    }
    if (row !== null && row.due_date !== this.remindOriginal) {
      return "diverged";
    }
    const candidate = this.data.remindAt;
    this.remindRemoteUnknown = false;
    this.applyReminderRow(row);
    this.setData({ remindAt: candidate });
    return this.data.remindGeneration >= 0 ? "known" : "unknown";
  },

  /**
   * 拉当前家庭 active 提醒,取这件的那一行上屏。展示前先清旧行并经
   * households 资格复核(硬门 C,口径同 R1/首页);家庭切换(作用域代
   * 数变化)后旧家庭响应不上屏。加载失败
   * 静默隐藏保质期行(增强露出,不影响详情主体)。
   */
  async refreshReminderRow(): Promise<void> {
    // 先收起旧保质期行:被移除/切换家庭后冷启动,展示前不得残留旧家庭提醒
    this.setData({ expire: null, remindAt: "", remindGeneration: -1 });
    this.remindOriginal = "";
    const row = await this.fetchReminderRow();
    if (row === undefined) {
      return; // 失败/在途切换:静默,详情其余照常
    }
    this.applyReminderRow(row);
  },

  applyReminderRow(row: RemindRow | null) {
    if (row === null) {
      // 已确认这件当前无提醒:轮次号记 0(补录语义的 expected_generation)
      this.remindOriginal = "";
      this.setData({ expire: null, remindAt: "", remindGeneration: 0 });
      return;
    }
    this.remindOriginal = row.due_date;
    this.setData({
      expire: {
        mainText: expireMainText(row.due_date),
        dueDate: row.due_date,
        kind: row.kind,
      },
      remindAt: row.due_date,
      remindGeneration:
        typeof row.generation === "number" ? row.generation : -1,
    });
  },

  /** 保质期行「已处理」:二次确认后 remindComplete(不带 period_days;下次提醒到详情里自己选日子) **/
  async onExpireDoneTap() {
    if (this.data.remindBusy) {
      return;
    }
    const expire = this.data.expire;
    if (!expire) {
      return;
    }
    if (this.hasRemindConflict() || this.pendingRemindWrite() !== null) {
      // F4-B1(架构复审阻断):提醒冲突待选或待补写时,到期行显示的是「你正要
      // 存的候选」预览,不是已确认的当前提醒——此时完成会以刷新对齐的远端新
      // 轮次调 remindComplete,可能替家人收掉他刚设的提醒,绕开选边硬门。
      // 失败关闭:先处理冲突(选边保存 / 补写),到期行照常显示候选供对照。
      wx.showToast({
        title: this.hasRemindConflict()
          ? "提醒冲突还没处理,先选保留哪一版"
          : "提醒还没存上,先保存修改,再点用完了",
        icon: "none",
        duration: 2500,
      });
      return;
    }
    if (this.data.remindGeneration < 0) {
      // F4-B2:轮次未知(未加载/加载失败/冲突刷新远端不可得)时完成同样是
      // reminder 写——先补拉取轮次,拉不到就失败关闭,绝不省略 expected_generation
      const outcome = await this.reloadRemindGeneration();
      if (outcome === "unknown") {
        wx.showToast({
          title: "提醒还没加载好,稍后再点用完了",
          icon: "none",
          duration: 2500,
        });
        return;
      }
      if (outcome === "diverged") {
        // F4-B4:补拉发现提醒已变成用户没看过的内容:停止原完成动作——
        // 先把最新提醒如实上屏,再由用户经「带新日期的确认框」显式确认这一条,
        // 确认后才按最新轮次完成;取消则不写,屏上已如实显示最新提醒
        await this.refreshReminderRow();
        const latest = this.data.expire;
        if (!latest || this.data.remindGeneration < 0) {
          wx.showToast({
            title: "提醒有变化,已刷新,确认后再点用完了",
            icon: "none",
            duration: 2500,
          });
          return;
        }
        const confirmed = await new Promise<boolean>((resolve) => {
          wx.showModal({
            title: "提醒有变化",
            content:
              "这条提醒现在是 " +
              monthDayText(latest.dueDate) +
              " 到期,要按这一条完成吗?",
            confirmText: "按这一条完成",
            cancelText: "先不完成",
            success: (r) => {
              resolve(r.confirm === true);
            },
            fail: () => {
              resolve(false);
            },
          });
        });
        if (!confirmed) {
          return; // 用户不确认最新提醒:不写
        }
        // 已显式确认最新提醒:按 refreshReminderRow 读到的最新轮次继续完成
      } else if (!this.data.expire) {
        return; // 补拉发现远端已无提醒:没有可完成的,到期行已如实收起
      }
    }
    const confirmed = await askUseUp(this.data.name);
    if (!confirmed) {
      return; // 用户取消:不动、不写
    }
    this.setData({ remindBusy: true });
    try {
      await callItemsApi({
        action: "remindComplete",
        item_id: this.data.itemId,
        // 轮次未知已被上方 F4-B2 门禁拦下,这里必带轮次(≥0),绝不省略
        expected_generation: this.data.remindGeneration,
        // 完成日按用户本地自然日随请求携带(PR #52 Low-3):服务端不靠运行时区猜
        complete_date: localTodayYmd(),
      });
      this.setData({ expire: null, remindAt: "", remindGeneration: 0 });
      this.remindOriginal = "";
      // 完成后不弹固定周期选项(#36 真机反馈 Fix 2):下次提醒时间由用户到详情里选日子
      wx.showToast({
        title: "已处理。要下次提醒,到详情里选日子",
        icon: "none",
        duration: 2500,
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        if (e.cleared === true) {
          // PR #52 R3-1:完成置 done 后、认领前提醒被家人清除——本轮已完成,
          // 服务端清除栅栏挡住了再生:如实告知,不再生成下一轮
          wx.showToast({ title: "已处理;提醒已被清除,不再生成下次", icon: "none", duration: 2500 });
          await this.refreshReminderRow();
          return;
        }
        if (e.superseded === true) {
          // PR #52 R4-1:完成置 done 后、认领前提醒被家人重新设置——再生认领
          // 绑定原完成轮次被原子拒绝:如实告知本轮不再生成,新提醒原样保留
          wx.showToast({ title: "已处理;提醒刚被重新设置,不再生成下次", icon: "none", duration: 2500 });
          await this.refreshReminderRow();
          return;
        }
        // 这轮已被家人处理并换了新提醒(PR #52 B1):刷新看最新,绝不误伤
        wx.showToast({ title: "这条刚被家人处理过,已刷新", icon: "none" });
        await this.refreshReminderRow();
        return;
      }
      wx.showModal({
        title: "没办成",
        content: errorMessage(e),
        showCancel: false,
      });
    } finally {
      this.setData({ remindBusy: false });
    }
  },

  /**
   * 编辑折叠「提醒」选日子(#36:picker mode=date 弹层,唯一手动日期来源):
   * 没有提醒的物品在这里补录,有提醒的在这里改期——都走 remindSet,把提醒
   * 设为所选的日子(服务端替换该物品的提醒,不堆积)。picker 回填必为合法
   * YYYY-MM-DD,异常值不写;校验与 picker 范围两端一致——今天可设(到期分组
   * 本就有「今天到期」),过去的日子与超 10 年的拒绝(PR #52 Low-3,按用户
   * 本地自然日判定)。请求携带页面所见轮次号(PR #52 B1):这一轮已被家人
   * 换过 → VERSION_CONFLICT,刷新后重选,绝不静默覆盖别人的新提醒
   * (0=页面确认无提醒的补录)。
   */
  async onRemindDateChange(e) {
    if (this.data.remindBusy) {
      return;
    }
    const value = e.detail && typeof e.detail.value === "string" ? e.detail.value : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return; // picker 形状异常:不写
    }
    if (value === this.data.remindAt) {
      return; // 没变
    }
    const problem = pickerDateProblem(value);
    if (problem !== "") {
      wx.showToast({ title: problem, icon: "none" });
      return;
    }
    if (this.hasRemindConflict() || this.pendingRemindWrite() !== null) {
      // 冲突面板已把「提醒」列为待选字段,或冲突刷新后提醒远端不可得、选择还
      // 留在表单等保存补写(F4-B1):改日期只更新「你的修改」/候选并撤回已有
      // 选择,不直接落库——与文本输入框同一门禁口径,必须点按钮显式选边或经
      // 保存修改补写;表单里的是候选,不是已确认的当前提醒
      this.setPendingRemind(value);
      this.syncConflictFromInput("remind", value);
      if (!this.hasRemindConflict()) {
        // 无面板的待补写态:面板不会给出可见反馈,如实告知没存上并引导补写
        wx.showToast({
          title: "提醒没存上,你的选择已保留,点保存修改再试",
          icon: "none",
          duration: 2500,
        });
      }
      return;
    }
    const hadReminder = this.data.remindAt !== "";
    if (this.data.remindGeneration < 0) {
      // F4-B2:轮次未知(未加载/加载失败/冲突刷新远端不可得)不得发 remindSet
      // ——先补拉一次取轮次,拉不到就失败关闭:候选保留在表单,提示稍后重试,
      // 绝不省略 expected_generation 退回旧协议无条件替换
      const outcome = await this.reloadRemindGeneration();
      if (outcome === "unknown") {
        this.setPendingRemind(value);
        wx.showToast({
          title: "提醒还没存好,你的选择已保留,稍后再试",
          icon: "none",
          duration: 2500,
        });
        return;
      }
      if (outcome === "diverged") {
        // F4-B4:补拉撞见远端已是不同内容且用户从未看过:不得直接写——
        // 候选保留,进入既有冲突双值面板(远端值 vs 本地候选),显式选边后
        // 经保存修改按最新轮次提交(与 remindSet 撞 VERSION_CONFLICT 同口径)
        this.setPendingRemind(value);
        const result = await this.refreshForConflict();
        if (result === "notfound") {
          wx.showModal({
            title: "记录不存在",
            content: "没有找到这条记录,可能已被删除。",
            showCancel: false,
            success: () => {
              this.goBack();
            },
          });
          return;
        }
        if (result === "refreshed") {
          wx.showToast({
            title: this.data.conflictPending
              ? "提醒与最新记录冲突,请选择保留哪一版"
              : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                ? "提醒没存上,你的选择已保留,点保存修改再试"
                : hadReminder
                  ? "这条提醒刚被家人改过,已刷新"
                  : "这条刚带上提醒,已刷新",
            icon: "none",
            duration: 2500,
          });
        }
        return;
      }
      if (value === this.remindOriginal) {
        return; // 补拉后远端已是这个日子:无需再写
      }
    }
    this.setData({ remindBusy: true });
    try {
      const res = await callItemsApi({
        action: "remindSet",
        item_id: this.data.itemId,
        due_date: value,
        // 轮次未知已被上方 F4-B2 门禁拦下,这里必带轮次(≥0),绝不省略
        expected_generation: this.data.remindGeneration,
      });
      if (res.reminder) {
        this.applyReminderRow(res.reminder);
        wx.showToast({
          title: hadReminder
            ? "提醒已改到 " + monthDayText(res.reminder.due_date)
            : "已带上提醒:" + monthDayText(res.reminder.due_date) + " 到期",
          icon: "none",
        });
      } else {
        // 不应发生(remindSet 必回所设行):回查一次,如实收敛
        await this.refreshReminderRow();
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        // 他处已改这条提醒:你正要存的日子留在表单,进入四字段双值对比,
        // 显式选择保留哪一版;选「保留我的修改」后按最新轮次号重发(见 onSaveTap)
        this.setPendingRemind(value);
        const result = await this.refreshForConflict();
        if (result === "notfound") {
          wx.showModal({
            title: "记录不存在",
            content: "没有找到这条记录,可能已被删除。",
            showCancel: false,
            success: () => {
              this.goBack();
            },
          });
          return;
        }
        if (result === "refreshed") {
          wx.showToast({
            title: this.data.conflictPending
              ? "提醒与最新记录冲突,请选择保留哪一版"
              : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                ? "提醒没存上,你的选择已保留,点保存修改再试"
                : hadReminder
                  ? "这条提醒刚被家人改过,已刷新"
                  : "这条刚带上提醒,已刷新",
            icon: "none",
            duration: 2500,
          });
        }
        return;
      }
      wx.showModal({
        title: hadReminder ? "提醒没改成" : "提醒没带上",
        content: errorMessage(e),
        showCancel: false,
      });
    } finally {
      this.setData({ remindBusy: false });
    }
  },

  /** 编辑折叠「提醒」✕:连日期一起清除(remindClear,带所见轮次号);日期唯一作用就是出现在「快到期」,没有「存日期但不提醒」 */
  async onRemindFieldClear() {
    if (this.data.remindBusy || !this.data.remindAt) {
      return;
    }
    if (this.hasRemindConflict() || this.pendingRemindWrite() !== null) {
      // 冲突面板待选期间,或提醒远端不可得、选择还在表单待补写(F4-B1):
      // 清除只更新面板「你的修改」/候选为「不带提醒」并撤回选择,不直接落库
      // ——必须点按钮显式选边,或经保存修改补写
      this.setPendingRemind("");
      this.syncConflictFromInput("remind", "");
      if (!this.hasRemindConflict()) {
        wx.showToast({
          title: "提醒没存上,你的选择已保留,点保存修改再试",
          icon: "none",
          duration: 2500,
        });
      }
      return;
    }
    if (this.data.remindGeneration < 0) {
      // F4-B2:轮次未知时清除同样是 reminder 写——先补拉取轮次,拉不到就
      // 失败关闭:候选(不带提醒)保留在表单,绝不无条件清除家人的提醒
      const outcome = await this.reloadRemindGeneration();
      if (outcome === "unknown") {
        this.setPendingRemind("");
        wx.showToast({
          title: "还没改成,提醒还没加载好,稍后再试",
          icon: "none",
          duration: 2500,
        });
        return;
      }
      if (outcome === "diverged") {
        // F4-B4:补拉撞见远端已是不同内容且用户从未看过:不得直接清——
        // 候选(不带提醒)保留,进入既有冲突双值面板显式选边
        //(与 remindClear 撞 VERSION_CONFLICT 同口径)
        this.setPendingRemind("");
        const result = await this.refreshForConflict();
        if (result === "notfound") {
          wx.showModal({
            title: "记录不存在",
            content: "没有找到这条记录,可能已被删除。",
            showCancel: false,
            success: () => {
              this.goBack();
            },
          });
          return;
        }
        if (result === "refreshed") {
          wx.showToast({
            title: this.data.conflictPending
              ? "提醒与最新记录冲突,请选择保留哪一版"
              : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                ? "提醒没存上,你的选择已保留,点保存修改再试"
                : "这条提醒刚被家人改过,已刷新",
            icon: "none",
            duration: 2500,
          });
        }
        return;
      }
      if (this.remindOriginal === "") {
        // 补拉确认远端已无提醒:没有可清除的,不发空写,表单对齐远端事实
        this.setData({ remindAt: "" });
        wx.showToast({ title: "已不带提醒", icon: "none" });
        return;
      }
    }
    this.setData({ remindBusy: true });
    try {
      await callItemsApi({
        action: "remindClear",
        item_id: this.data.itemId,
        // 轮次未知已被上方 F4-B2 门禁拦下,这里必带轮次(≥0),绝不省略
        expected_generation: this.data.remindGeneration,
      });
      this.setData({ expire: null, remindAt: "", remindGeneration: 0 });
      this.remindOriginal = "";
      wx.showToast({ title: "已不带提醒", icon: "none" });
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        // 他处已改这条提醒:「不带提醒」的选择留在表单,进入四字段双值对比,
        // 显式选择保留哪一版,绝不静默删掉别人的新提醒
        this.setPendingRemind("");
        const result = await this.refreshForConflict();
        if (result === "notfound") {
          wx.showModal({
            title: "记录不存在",
            content: "没有找到这条记录,可能已被删除。",
            showCancel: false,
            success: () => {
              this.goBack();
            },
          });
          return;
        }
        if (result === "refreshed") {
          wx.showToast({
            title: this.data.conflictPending
              ? "提醒与最新记录冲突,请选择保留哪一版"
              : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                ? "提醒没存上,你的选择已保留,点保存修改再试"
                : "这条提醒刚被家人改过,已刷新",
            icon: "none",
            duration: 2500,
          });
        }
        return;
      }
      wx.showModal({
        title: "没改成",
        content: errorMessage(e),
        showCancel: false,
      });
    } finally {
      this.setData({ remindBusy: false });
    }
  },

  noop() {},
});
