import { ApiError, callItemsApi, errorMessage, uuid } from "../../utils/api";
import { callLocationsApi } from "../../utils/locations-api";
import {
  allCheckedSaved,
  batchSummary,
  draftMountPathPreview,
  firstInvalidMsg,
  mountPathFromPick,
  rowReminderInput,
  rowVagueQuoteInput,
  rowsToSave,
  runBatchSave,
  saveRowWithMount,
  shouldDefaultChecked,
  type BatchRow,
} from "../../utils/batch-save";
import { askNotifyIntent, requestExpirySubscribe } from "../../utils/subscribe";
import {
  clearDraftSession,
  getDraftSession,
  updateDraftSessionRows,
  type DraftSessionRowState,
} from "../../utils/draft-session";
import type { RemindKind } from "../../types";

/** 批量行(BatchRow 的渲染态:附证据与限定语展示) */
interface ConfirmRow extends BatchRow {
  certain: boolean;
  qualifiersText: string;
  sourceQuote: string;
  /** 证据片段含其他物品名(归属需人工核对) */
  anchorShared: boolean;
  /** OPERATION_CONFLICT 时服务端下发的已有版本(引导详情页用) */
  existing?: Record<string, unknown>;
  itemId?: string;
  /** 行内提醒日期(YYYY-MM-DD;""=不带提醒;用户可经日期选择器改/清) */
  remindAt: string;
  /** 提取时的原话锚定日期:行内日期仍是这个值才随行提交 quote(选择器改过的没有锚点) */
  remindOrigin: string;
  /** 提取到的提醒类别(冻结词表);行内无日期时为 "" */
  remindKind: RemindKind | "";
  /** 日期在原话中的逐字子串(remind_at 的锚定) */
  remindQuote: string;
  /** 用户动过提醒行:清除后行仍显示(灰显「不提醒」);未提取到日期且没动过则整行不显示(不催) */
  remindTouched: boolean;
  /**
   * 「要不要微信提醒」意向(0.9.6,#36 用户反馈):用户在提醒行选日期时经
   * askNotifyIntent 询问后写入;undefined/true=保存时询问订阅(AI 预填日期
   * 未经弹窗,保持既有自动询问),false=明确拒绝过跳过
   */
  wantsNotify?: boolean;
  /** C2 行副文下的小角标文案(如「11-20 到期」;无日期为 "" 不渲染) */
  remindBadgeText: string;
  /**
   * 时间没换算的透明标记(0.6.0 真机反馈 Fix 4):服务端在原话里检测到时间
   * 表述但未换算的逐字子串(如「半年后」)。纯提示不参与逻辑——C1 显示灰行
   * 「时间没换算:『…』」,C2 行内小灰标;用户选了明确日期即清空(互斥)。
   * (三件 A 起带数量锚的闭集表述已被服务端换算成候选,这类灰行只在真换算
   * 失败——闭集外——时出现。)
   */
  remindVagueQuote: string;
  /**
   * 相对时间换算候选标记(#36 真机反馈三件 A):true = 行内 remindAt 来自
   * 服务端闭集换算(锚点=提取时刻服务端今天),remindQuote 即换算依据的原话
   * 子串;C1/C2 在日期旁小字标注「(按『…』换算)」,用户改日期即置 false
   * (候选被用户选择替代,标注随之收起)。换算是候选不是定论:可改可清。
   */
  remindConverted: boolean;
  /**
   * 「放进」行的最终路径(issue #45 十七轮,#18 红线语义升级):AI 确定时
   * 来自草稿 mount_path 预览,用户可经「换」(选位置弹层)替换;空数组 =
   * 不显示该行、不挂靠(certain=false 一律空 = 照旧先进「尚未归类」)。
   * 改位置文本即清空(用户否认了原路径,见 onRowLocationInput)。
   * 点「确认记住」才建路径并挂上,绝不静默建路径。
   */
  mountPath: string[];
  /** 「放进」行显示文本(路径 join " / ";wxml 无数组 join,预计算) */
  mountPathText: string;
  /** 行内固定挂靠幂等键(create 成功后 ensureAndLink 用;失败重试沿用) */
  mountUpdateId: string;
}

/** 本地日期 → YYYY-MM-DD( picker mode=date 的 value 形态) */
function todayYmd(now: Date = new Date()): string {
  const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
  return (
    now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate())
  );
}

/**
 * C2 角标文案:今年的日期紧凑显示 MM-DD,跨年带全年(绝不误导是哪一年);
 * 只切字符串,不做任何日期推算。
 */
function remindBadgeText(dateYmd: string, now: Date = new Date()): string {
  const sameYear = dateYmd.slice(0, 4) === String(now.getFullYear());
  return (sameYear ? dateYmd.slice(5) : dateYmd) + " 到期";
}

Page<
  {
    /** true 表示手动录入模式(空白单表单,兼容旧入口) */
    isManual: boolean;
    manualNoteOpen: boolean;
    // ---- 手动单表单(旧) ----
    name: string;
    locationText: string;
    note: string;
    saving: boolean;
    operationId: string;
    // ---- 批量列表(Issue #14) ----
    originalText: string;
    /** 原话超过 5 件被截取:横幅引导分批,绝不静默 */
    truncated: boolean;
    rows: ConfirmRow[];
    batchSaving: boolean;
    /** 当前勾选且未保存件数(按钮文案) */
    checkedCount: number;
    // ---- 呈现态(对齐原型 C1/C1b/C2,不影响保存合同) ----
    /** 标题/副题(单件 vs 多件 vs 位置没听清) */
    headTitle: string;
    headSub: string;
    /** 原话默认折叠;任一行含警示(来源不充分/两件东西)时初始展开,警示行本身常驻不藏 */
    quoteOpen: boolean;
    /** 单件摘要卡「改」的行内编辑态 */
    editingName: boolean;
    editingLocation: boolean;
    /** 今天(YYYY-MM-DD):提醒行日期选择器无值时的起点 */
    today: string;
  },
  {
    onNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onLocationInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onToggleManualNote(): void;
    onNoteInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onSaveTap(): Promise<void>;
    onRowNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onRowLocationInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onRowToggle(e: WechatMiniprogram.CustomEvent): void;
    onRowDetail(e: WechatMiniprogram.CustomEvent): void;
    onToggleQuote(): void;
    /** 单件摘要卡「改」:切换行内编辑(data-field = name | location) */
    onToggleEdit(e: WechatMiniprogram.CustomEvent): void;
    /** 单件提醒行「选日期」:微信 picker mode=date 弹层回填(#36:手动侧唯一日期来源) */
    onRemindDateChange(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    /** 单件提醒行「✕」:连日期一起清除(不存在「存日期但不提醒」) */
    onRemindClear(e: WechatMiniprogram.CustomEvent): void;
    /**
     * 「放进」行「换」(十七轮,#18 红线):进 locations 选位置弹层(picker 模式),
     * 只从家里已有位置里逐层选;选定后路径替换为所选(异常回传不写)。
     * C1/C2 同款;仅带「放进」路径的行可进(certain=false 无该行,照旧先进「尚未归类」)。
     */
    onMountSwapTap(e: WechatMiniprogram.CustomEvent): void;
    onSaveBatchTap(): Promise<void>;
    backToHome(): void;
    /** 行状态序列化回写会话(供恢复) */
    persistRows(): void;
    /** 草稿会话 id(onUnload 清理用) */
    sid: string;
  }
>({
  data: {
    isManual: false,
    manualNoteOpen: false,
    name: "",
    locationText: "",
    note: "",
    saving: false,
    operationId: "",
    originalText: "",
    truncated: false,
    rows: [],
    batchSaving: false,
    checkedCount: 0,
    headTitle: "",
    headSub: "",
    quoteOpen: false,
    editingName: false,
    editingLocation: false,
    today: todayYmd(),
  },

  /** 草稿会话 id(onUnload 清理用) */
  sid: "",

  onLoad(options) {
    if (options.manual === "true") {
      this.setData({ isManual: true, operationId: uuid() });
      return;
    }
    const sid = options.sid;
    if (!sid) {
      this.setData({ isManual: true, operationId: uuid() });
      return;
    }
    const payload = getDraftSession(sid);
    if (payload === null) {
      // 会话过期/进程回收:如实提示并回首页重新提取,绝不编造空草稿
      wx.showToast({ title: "草稿已过期,请重新提取", icon: "none", duration: 2000 });
      setTimeout(() => {
        wx.reLaunch({ url: "/pages/index/index" });
      }, 800);
      return;
    }
    this.sid = sid;
    const rows: ConfirmRow[] = payload.drafts.map((d, i) => {
      // 提醒候选三项(#36):只透传服务端已锚定的原话绝对日期;
      // 没提取到日期 remindAt 为空串,提醒行整行不显示(不催)
      const remindAt = d.remind_at ?? "";
      // 「放进」路径预览(十七轮):仅 certain 且形状合法才透传,否则空数组
      // = 不显示「放进」行(certain=false 照旧先进「尚未归类」,绝不静默建路径)
      const mountPath = draftMountPathPreview(d);
      return {
        key: "row-" + i,
        name: d.name,
        locationText: d.location_text,
        // 默认勾选决策下沉 utils:位置确定且有专属证据、锚定不共享才默认勾;
        // 位置没听清的(certain=false)一律不默认勾(B3),补充位置后由用户明确勾选;
        // 其余(无证据/整句共享)人工核对后手动勾
        checked: shouldDefaultChecked(d.source_quote, d.anchor_shared === true, d.certain === true),
        status: "pending",
        failMsg: "",
        operationId: uuid(),
        certain: d.certain,
        qualifiersText: d.qualifiers.join("、"),
        sourceQuote: d.source_quote,
        anchorShared: d.anchor_shared === true,
        remindAt,
        remindOrigin: remindAt,
        remindKind: d.remind_kind ?? "",
        remindQuote: d.remind_quote ?? "",
        remindTouched: false,
        remindBadgeText: remindAt === "" ? "" : remindBadgeText(remindAt),
        remindVagueQuote: d.remind_vague_quote ?? "",
        remindConverted: d.remind_converted === true,
        mountPath,
        mountPathText: mountPath.join(" / "),
        mountUpdateId: uuid(),
      };
    });
    // 恢复上次未完成的行状态:沿用原 operation_id(幂等恢复,不重复建档),
    // 已保存行保持 saved 不再提交;提醒日期与「放进」路径以会话回写值为准
    // (用户可能改/清/换过),旧版本会话缺省该字段时回落草稿提取值
    if (payload.rows && payload.rows.length === rows.length) {
      payload.rows.forEach((saved, i) => {
        const remindAt =
          typeof saved.remindAt === "string" ? saved.remindAt : rows[i].remindAt;
        // 「放进」路径:回写过就用回写值——含空数组(用户改位置文本清掉的,
        // 绝不回生草稿预览的旧路径);旧版本会话缺省该字段才回落草稿预览
        const mountPath = Array.isArray(saved.mountPath)
          ? saved.mountPath
          : rows[i].mountPath;
        rows[i] = {
          ...rows[i],
          name: saved.name,
          locationText: saved.locationText,
          checked: saved.checked,
          status: saved.status,
          failMsg: saved.failMsg,
          operationId: saved.operationId,
          remindAt,
          remindTouched: saved.remindTouched === true || rows[i].remindTouched,
          remindBadgeText: remindAt === "" ? "" : remindBadgeText(remindAt),
          // 换算候选标记:回写过(用户改过日期置 false)以回写值为准,
          // 缺省(旧版本会话)回落草稿提取值
          remindConverted: typeof saved.remindConverted === "boolean" ? saved.remindConverted : rows[i].remindConverted,
          mountPath,
          mountPathText: mountPath.join(" / "),
        };
      });
    }
    // 原话默认折叠;但任一行含警示(来源不充分/两件东西)时必须初始展开——
    // 折叠只收起原话全文,行级警示文案常驻在行上,绝不藏
    const quoteOpen = rows.some((r) => r.anchorShared || r.sourceQuote === "");
    // 标题文案(用户词汇):单件核对 / 单件补位置 / 多件清点
    const single = rows.length === 1;
    this.setData({
      isManual: false,
      originalText: payload.originalText,
      truncated: payload.truncated,
      rows,
      checkedCount: batchSummary(rows).checked,
      headTitle: "核对记录",
      headSub: single ? "" : "逐件核对，勾选要记住的。",
      quoteOpen,
    });
  },

  /** 行状态序列化回写会话(供进程回收后恢复原幂等键与已保存状态) */
  persistRows() {
    if (this.sid === "") {
      return;
    }
    const rows: DraftSessionRowState[] = this.data.rows.map((r) => ({
      key: r.key,
      name: r.name,
      locationText: r.locationText,
      checked: r.checked,
      status: r.status,
      failMsg: r.failMsg,
      operationId: r.operationId,
      // 行内提醒可能被用户改/清过,一并回写(恢复时覆盖草稿提取值)
      remindAt: r.remindAt,
      remindTouched: r.remindTouched,
      // 换算候选标记:用户改过日期后为 false(候选已被替代),恢复时以回写值为准
      remindConverted: r.remindConverted,
      // 「放进」路径可能被用户「换」过,一并回写(恢复时覆盖草稿预览)
      mountPath: r.mountPath,
    }));
    updateDraftSessionRows(this.sid, rows);
  },

  onUnload() {
    if (this.sid === "") {
      return;
    }
    // 中途退出且仍有结果未知的勾选行:保留会话供首页「继续核对」恢复(原键原状态,
    // 已保存行不再提交);全部完成或已无勾选 = 干净离场,即清。
    const summary = batchSummary(this.data.rows);
    if (summary.checked === summary.saved) {
      clearDraftSession(this.sid);
    }
  },

  // ---------- 手动单表单(旧路径) ----------

  onNameInput(e) {
    this.setData({ name: e.detail && e.detail.value ? e.detail.value : "" });
  },

  onLocationInput(e) {
    this.setData({
      locationText: e.detail && e.detail.value ? e.detail.value : "",
    });
  },

  onToggleManualNote() { this.setData({ manualNoteOpen: !this.data.manualNoteOpen }); },

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
      wx.showToast({ title: "记住了,下次问我。", icon: "success" });
      setTimeout(() => {
        this.backToHome();
      }, 800);
    } catch (e) {
      if (e instanceof ApiError && e.code === "OPERATION_CONFLICT") {
        // 同 operation_id 已保存过且内容与当前填写不同(响应丢失后修改重试的典型场景):
        // 绝不静默;给出可操作引导——跳到已保存版本的详情页再改。
        const existing = e.existing;
        if (existing && existing.item_id) {
          wx.showModal({
            title: "这条已保存过",
            content: "之前已保存过一次,内容与当前填写不同。可到详情页基于已保存的版本修改。",
            confirmText: "去详情页",
            cancelText: "留在本页",
            success: (r) => {
              if (r.confirm) {
                wx.navigateTo({
                  url: "/pages/item/item?data=" + encodeURIComponent(JSON.stringify(existing)),
                });
              }
            },
          });
        } else {
          wx.showModal({
            title: "保存失败",
            content: e.message,
            showCancel: false,
          });
        }
        return;
      }
      wx.showModal({
        title: "保存失败",
        content: errorMessage(e),
        showCancel: false,
      });
    } finally {
      this.setData({ saving: false });
    }
  },

  // ---------- 批量列表(Issue #14) ----------

  onRowNameInput(e) {
    if (this.data.batchSaving) {
      return; // 整批提交中冻结输入:本轮写入的就是本轮开始时看到的
    }
    const index = Number(e.currentTarget.dataset.index);
    this.setData({
      ["rows[" + index + "].name"]: e.detail && e.detail.value ? e.detail.value : "",
    });
  },

  onRowLocationInput(e) {
    if (this.data.batchSaving) {
      return; // 整批提交中冻结输入
    }
    const index = Number(e.currentTarget.dataset.index);
    const value = e.detail && e.detail.value ? e.detail.value : "";
    const row = this.data.rows[index];
    if (!row) {
      return;
    }
    // 单件且「位置没听清」(C1b):补上位置才放行、清空回到禁用——
    // 只联动勾选态,保存仍走同一 onSaveBatchTap 合同(必填校验/幂等键均不变)
    if (this.data.rows.length === 1 && !row.certain && row.status === "pending") {
      const filled = value.trim() !== "";
      if (filled !== row.checked) {
        const rows = this.data.rows.slice();
        rows[index] = { ...row, locationText: value, checked: filled };
        this.setData({
          ["rows[" + index + "].locationText"]: value,
          ["rows[" + index + "].checked"]: filled,
          checkedCount: batchSummary(rows).checked,
        });
        return;
      }
    }
    // 「放进」口径(十七轮评审,#18 红线边角):用户改了位置文本 = 否认原路径
    // (无论原路径是 AI 拆的还是「换」选的),预览随之失效——清空回「先进
    // 尚未归类」口径(与 §2.5 手补自由文本不自动上地图一致),绝不把物品挂进
    // 与刚编辑文本背离的旧路径;要放具体位置,保存后到详情里整理。
    const mountStale = row.mountPath.length > 0 && value !== row.locationText;
    const patch: Record<string, unknown> = {
      ["rows[" + index + "].locationText"]: value,
    };
    if (mountStale) {
      patch["rows[" + index + "].mountPath"] = [];
      patch["rows[" + index + "].mountPathText"] = "";
    }
    this.setData(patch);
    if (mountStale) {
      // 清了路径必须立刻回写会话:进程回收后恢复不得回生草稿预览的旧路径
      this.persistRows();
    }
  },

  onRowToggle(e) {
    const index = Number(e.currentTarget.dataset.index);
    const row = this.data.rows[index];
    // 整批提交中冻结全部勾选状态:本轮开始时的选择即本轮写入的选择
    if (this.data.batchSaving) {
      return;
    }
    if (!row || row.status === "saving" || row.status === "saved") {
      return; // 已保存的行不可取消(事实已入库)
    }
    const rows = this.data.rows.slice();
    rows[index] = { ...row, checked: !row.checked };
    this.setData({ ["rows[" + index + "].checked"]: !row.checked, checkedCount: batchSummary(rows).checked });
  },

  onRowDetail(e) {
    const index = Number(e.currentTarget.dataset.index);
    const row = this.data.rows[index];
    if (!row || !row.itemId) {
      return;
    }
    wx.navigateTo({
      url: "/pages/item/item?data=" + encodeURIComponent(JSON.stringify(row.existing)),
    });
  },

  /** 原话折叠/展开(默认折叠;含警示场景 onLoad 已初始展开) */
  onToggleQuote() {
    this.setData({ quoteOpen: !this.data.quoteOpen });
  },

  /** 单件摘要卡「改」:切换该字段的行内编辑 */
  onToggleEdit(e) {
    const field = e.currentTarget.dataset.field;
    if (field === "name") {
      this.setData({ editingName: !this.data.editingName });
      return;
    }
    if (field === "location") {
      this.setData({ editingLocation: !this.data.editingLocation });
    }
  },

  /**
   * 单件提醒行「选日期」(#36 冻结:手动侧唯一日期来源=微信 picker mode=date 弹层,
   * 绝无自由文本输入)。picker 回填必为合法 YYYY-MM-DD,异常值不写。
   * 只改日期,不参与勾选逻辑(勾选仍由位置/证据决定)。
   */
  onRemindDateChange(e) {
    if (this.data.batchSaving) {
      return; // 整批提交中冻结:本轮写入的就是本轮开始时看到的
    }
    const row = this.data.rows[0];
    if (!row || row.status === "saving" || row.status === "saved") {
      return; // 已保存的行不再改(事实已入库)
    }
    const value = e.detail && typeof e.detail.value === "string" ? e.detail.value : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return;
    }
    this.setData({
      "rows[0].remindAt": value,
      "rows[0].remindTouched": true,
      "rows[0].remindBadgeText": remindBadgeText(value),
      // 用户选了明确日期:时间没换算的提示随之收起(与服务端互斥口径一致);
      // 换算候选标注同样收起——日期已是用户自己的选择,不再是换算候选
      "rows[0].remindVagueQuote": "",
      "rows[0].remindConverted": false,
    });
    this.persistRows();
    // 0.9.6(#36 用户反馈):选完日子问一句「要不要微信提醒」(picker 回调无
    // 手势,但纯提问不受限);答案存行内 wantsNotify。0.9.7:点「提醒我」
    // **立即**尝试授权——骑 modal 确认的激活窗口(现代基础库保留);若被
    // 手势拒绝则落回保存 tap 的二次机会(双兜底),accept 后本行置不再问。
    void askNotifyIntent(value).then((wants) => {
      if (wants) {
        requestExpirySubscribe(() => {
          this.setData({ "rows[0].wantsNotify": false });
          this.persistRows();
        }, value);
      }
      this.setData({ "rows[0].wantsNotify": wants });
      this.persistRows();
    });
  },

  /**
   * 单件提醒行「✕」:连日期一起清除,行灰显「不提醒」——日期的唯一作用就是到期
   * 出现在快到期列表里,不存在也不需要「存日期但不提醒」的模式。
   */
  onRemindClear() {
    if (this.data.batchSaving) {
      return;
    }
    const row = this.data.rows[0];
    if (!row || row.status === "saving" || row.status === "saved" || row.remindAt === "") {
      return;
    }
    this.setData({
      "rows[0].remindAt": "",
      "rows[0].remindTouched": true,
      "rows[0].remindBadgeText": "",
    });
    this.persistRows();
  },

  /**
   * 「放进」行「换」(十七轮):复用 locations 页既有的选位置弹层(picker 模式,
   * EventChannel pickNode 回传;与 D1「放进具体位置」同款)。选定后把该行的
   * 「放进」路径替换为所选(只信严格结构,异常回传不写);退栈统一由发起页
   * 一次退掉本页上方全部选择器层(#29 后续,与 item 页同款)。整批提交中冻结。
   */
  onMountSwapTap(e) {
    if (this.data.batchSaving) {
      return; // 整批提交中冻结:本轮写入的就是本轮开始时看到的
    }
    const index = Number(e.currentTarget.dataset.index);
    const row = this.data.rows[index];
    if (!row || !row.certain || row.status === "saving" || row.status === "saved") {
      return; // 没有该行的件不进选位置(certain=false 照旧先进「尚未归类」)
    }
    wx.navigateTo({
      url:
        "/pages/locations/locations?picker=1&title=" +
        encodeURIComponent("放进哪儿"),
      events: {
        pickNode: (d: { location_id?: string; name?: string; path?: unknown }) => {
          const picked = mountPathFromPick(d);
          if (picked.length === 0) {
            return; // 异常回传:不写,原路径保持
          }
          this.setData({
            ["rows[" + index + "].mountPath"]: picked,
            ["rows[" + index + "].mountPathText"]: picked.join(" / "),
          });
          this.persistRows();
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

  /**
   * 批量保存:提交瞬间对整页行做不可变快照,快照里的名称/位置/幂等键即本轮写入内容
   * (UI 冻结之外的第二道防线);逐行 create 由 runBatchSave 编排,行内固定
   * operation_id,失败行重试沿用原键。「一次确认」不是数据库原子事务——逐行如实反馈。
   *
   * 「放进」挂靠(十七轮,#18 红线语义升级)逐件独立跟在 create 后:行内带
   * 最终路径才调 locations.ensureAndLink(路径已在确认卡明示 = 用户确认过);
   * 挂靠失败绝不回滚已保存物品——行仍是「已记住」,计数后统一如实提示
   * 「已记住,位置还没归位,稍后在详情整理」(该件照旧在「尚未归类」)。
   * itemsApi create 请求结构不变,挂靠编排全在客户端。
   */
  async onSaveBatchTap() {
    if (this.data.batchSaving) {
      return;
    }
    const invalid = firstInvalidMsg(this.data.rows);
    if (invalid !== "") {
      wx.showToast({ title: invalid, icon: "none" });
      return;
    }
    const snapshot = this.data.rows.map((r) => ({ ...r }));
    if (batchSummary(snapshot).checked === 0) {
      wx.showToast({ title: "没有要保存的物品", icon: "none" });
      return;
    }
    // V1.5(#36 到期微信提醒):本次保存会写入到期提醒的行存在时,先在 tap
    // 手势链内同步请求订阅授权(必须先于下方任何 await;拒绝/失败静默降级
    // 应用内提醒,绝不阻塞保存流程)。行口径与下方提交一致:勾选且未 saved、
    // rowReminderInput 会随 create 携带 reminder 的行。
    if (
      rowsToSave(snapshot).some(
        (r) => rowReminderInput(r) !== undefined && r.wantsNotify !== false,
      )
    ) {
      // 回执日期=本批最早到期日(多件带提醒时,首条推送就是它;YMD 字典序即日期序);
      // wantsNotify=false 的行已被条件排除,日期也相应不计入
      const earliest = rowsToSave(snapshot)
        .filter((r) => r.wantsNotify !== false)
        .map((r) => r.remindAt)
        .filter((d) => d !== "")
        .sort()[0];
      requestExpirySubscribe(undefined, earliest);
    }
    this.setData({ batchSaving: true });
    let mountFailed = 0;
    const finalRows = await runBatchSave(
      snapshot,
      (row) => {
        // 行内提醒随 create 提交(可能被用户改/清过),映射下沉 batch-save 纯函数
        // (PR #52 B3 便于测试):行内无日期(含服务端因归属不明置空)不带提醒,
        // 绝不写入错误归属的提醒;quote 只在日期仍是原话提取值时携带。
        // vague(时间没换算标记,Fix 4)同理下沉:无日期且带标记才随行提交,
        // 存到 item 只为详情页展示,不产生任何提醒
        return saveRowWithMount(
          row,
          (r) => {
            const reminder = rowReminderInput(r);
            const vagueQuote = rowVagueQuoteInput(r);
            return callItemsApi({
              action: "create",
              operation_id: r.operationId,
              name: r.name.trim(),
              location_text: r.locationText.trim(),
              ...(reminder ? { reminder } : {}),
              ...(vagueQuote !== undefined ? { remind_vague_quote: vagueQuote } : {}),
            }).then((res) => res.item);
          },
          (args) =>
            // 「放进」落地:建缺失路径 + 挂上一件完成(路径段逐字来自确认卡
            // 明示过的原话拆层,来源记 parse)
            callLocationsApi({
              action: "ensureAndLink",
              item_id: args.item_id,
              path: args.path,
              expected_version: args.expected_version,
              update_id: args.update_id,
              created_from: "parse",
            }).then(() => undefined),
        ).then((outcome) => {
          if (outcome.mountFailed) {
            mountFailed += 1;
          }
        });
      },
      (row, error) => {
        const index = this.data.rows.findIndex((r) => r.key === row.key);
        if (index === -1) {
          return;
        }
        const patch: Record<string, unknown> = {
          ["rows[" + index + "].status"]: row.status,
          ["rows[" + index + "].failMsg"]: row.failMsg,
        };
        if (
          error instanceof ApiError &&
          error.code === "OPERATION_CONFLICT" &&
          error.existing &&
          error.existing.item_id
        ) {
          patch["rows[" + index + "].failMsg"] = "这条已保存过且内容不同,请到详情页修改";
          patch["rows[" + index + "].existing"] = error.existing;
          patch["rows[" + index + "].itemId"] = error.existing.item_id;
        }
        this.setData(patch);
        this.persistRows();
      },
    );
    this.setData({ batchSaving: false });
    const summary = batchSummary(finalRows);
    if (allCheckedSaved(finalRows)) {
      if (mountFailed > 0) {
        // 物品已保存、挂靠没成(网络/冲突/跨家庭):绝不回滚,如实告知去向——
        // 先在「尚未归类」,稍后到详情里放进具体位置;留在本页让用户看到行状态
        wx.showToast({
          title: "已记住,位置还没归位,稍后在详情整理",
          icon: "none",
          duration: 2500,
        });
        return;
      }
      wx.showToast({ title: "记住了,下次问我。", icon: "success" });
      setTimeout(() => {
        this.backToHome();
      }, 800);
      return;
    }
    wx.showToast({
      title: "已保存 " + summary.saved + " 件," + summary.failed + " 件失败可重试",
      icon: "none",
      duration: 2500,
    });
  },

  backToHome() {
    wx.navigateBack({
      fail: () => {
        wx.reLaunch({ url: "/pages/index/index" });
      },
    });
  },
});
