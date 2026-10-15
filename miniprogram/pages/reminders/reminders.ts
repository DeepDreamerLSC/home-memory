import { callItemsApi, errorMessage } from "../../utils/api";
import {
  askUseUp,
  duePill,
  localTodayYmd,
  monthDayText,
  type DueGroup,
} from "../../utils/remind-ui";
import {
  captureScopeGeneration,
  isScopeGenerationCurrent,
} from "../../utils/household-scope";
import { ensureScopeVerified } from "../../utils/households-api";
import type { RemindRow } from "../../types";

/** R1 行(首字图标 + 物品名 + 位置 + 日期胶囊;行点击进物品详情) */
interface DisplayRow {
  item_id: string;
  name: string;
  location_text: string;
  due_date: string;
  kind: string;
  /** 提醒轮次号(PR #52 B1):「用完了」请求的 expected_generation 来源;旧服务端缺省 */
  generation?: number;
  initial: string;
  pillText: string;
}

/** 三分组界线(#36 冻结):已过期 / 这几天(7 天内)/ 再往后 */
const GROUP_KEYS: ReadonlyArray<{ key: DueGroup; field: "overdue" | "soon" | "later" }> = [
  { key: "over", field: "overdue" },
  { key: "soon", field: "soon" },
  { key: "later", field: "later" },
];

Page<
  {
    loading: boolean;
    /** X2 失败态:失败的是这次加载,可重试 */
    errorText: string;
    overdue: DisplayRow[];
    soon: DisplayRow[];
    later: DisplayRow[];
    /** 「用完了」执行中(防并发重复提交) */
    completing: boolean;
  },
  {
    load(retryOnStaleGen?: boolean): Promise<void>;
    applyReminders(rows: RemindRow[]): void;
    onRetryTap(): void;
    rowOf(dataset: { group?: unknown; index?: unknown }): DisplayRow | null;
    onRowTap(e: WechatMiniprogram.CustomEvent): void;
    onDoneTap(e: WechatMiniprogram.CustomEvent): Promise<void>;
  }
>({
  data: {
    loading: true,
    errorText: "",
    overdue: [],
    soon: [],
    later: [],
    completing: false,
  },

  onShow() {
    void this.load();
  },

  /**
   * 拉取当前家庭的 active 提醒并按三分组上屏。
   * 展示前先经 households 资格复核(硬门 C:未验证期间不展示,复核本身
   * best-effort;随后 remindList 的服务端响应会再捕获作用域)。
   * 家庭切换(作用域代数变化)后,在途旧家庭的响应与失败提示都不上屏,
   * 不显示旧家庭数据(fail-closed)——响应揭示漂移时按新作用域补拉一次
   * (口径同首页地图 loadMapLayer 的 stale-gen 重试,连续漂移由 retryOnStaleGen 挡住)。
   */
  async load(retryOnStaleGen?: boolean) {
    this.setData({ loading: true, errorText: "" });
    await ensureScopeVerified();
    // 复核可能揭示家庭漂移并递增代数:请求前重新捕获,响应后才校验
    const scopeGen = captureScopeGeneration();
    try {
      const res = await callItemsApi({ action: "remindList" });
      if (!isScopeGenerationCurrent(scopeGen)) {
        // 在途期间家庭已切换(含响应自身揭示的漂移):旧家庭数据不上屏,
        // 按当前作用域补拉一次
        if (retryOnStaleGen !== false) {
          void this.load(false);
        } else {
          this.setData({ loading: false, overdue: [], soon: [], later: [] });
        }
        return;
      }
      this.applyReminders(res.reminders);
    } catch (e) {
      if (!isScopeGenerationCurrent(scopeGen)) {
        return; // 失败提示也不属于当前家庭:静默丢弃
      }
      this.setData({ loading: false, errorText: errorMessage(e) });
    }
  },

  /** 服务端已按 due_date 升序返回;这里只按三组分桶、附首字与胶囊文案 */
  applyReminders(rows: RemindRow[]) {
    const buckets: Record<DueGroup, DisplayRow[]> = {
      over: [],
      soon: [],
      later: [],
    };
    for (const r of rows) {
      const pill = duePill(r.due_date);
      buckets[pill.group].push({
        item_id: r.item_id,
        name: r.name,
        location_text: r.location_text,
        due_date: r.due_date,
        kind: r.kind,
        generation: r.generation,
        initial: r.name.length > 0 ? r.name[0] : "?",
        pillText: pill.text,
      });
    }
    this.setData({
      loading: false,
      errorText: "",
      overdue: buckets.over,
      soon: buckets.soon,
      later: buckets.later,
    });
  },

  /** X2「再试一次」 */
  onRetryTap() {
    void this.load();
  },

  rowOf(dataset: { group?: unknown; index?: unknown }): DisplayRow | null {
    const group = String(dataset.group);
    const field = GROUP_KEYS.find((g) => g.key === group);
    if (!field) {
      return null;
    }
    const index = Number(dataset.index);
    const rows = this.data[field.field];
    return rows[index] || null;
  },

  /** 行点击:进物品详情(保质期行与「用完了」都在那边) */
  onRowTap(e) {
    const row = this.rowOf(e.currentTarget.dataset);
    if (!row) {
      return;
    }
    wx.navigateTo({
      url: "/pages/item/item?item_id=" + encodeURIComponent(row.item_id),
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  /**
   * 「用完了」:先确认,再调 remindComplete;周期物品(下次维护)问下次
   * 周期并再生。完成后刷新列表(收掉的消失、再生的按新日期归组)。
   * 请求携带行上的提醒轮次号(PR #52 B1):服务端只完成用户看到的那一轮,
   * 这轮已被家人处理过 → VERSION_CONFLICT,如实刷新(绝不误伤新一轮)。
   */
  async onDoneTap(e) {
    if (this.data.completing) {
      return;
    }
    const row = this.rowOf(e.currentTarget.dataset);
    if (!row) {
      return;
    }
    const decision = await askUseUp(row.name, row.kind);
    if (decision === null) {
      return; // 用户取消:不动、不写
    }
    this.setData({ completing: true });
    try {
      const res = await callItemsApi({
        action: "remindComplete",
        item_id: row.item_id,
        ...(row.generation !== undefined ? { expected_generation: row.generation } : {}),
        ...(decision.periodDays !== null ? { period_days: decision.periodDays } : {}),
        // 完成日按用户本地自然日随请求携带(PR #52 Low-3):服务端不靠运行时区猜
        complete_date: localTodayYmd(),
      });
      if (decision.periodDays !== null && res.reminder) {
        wx.showToast({
          title: "已用完;下次 " + monthDayText(res.reminder.due_date) + " 到期",
          icon: "none",
          duration: 2500,
        });
      } else {
        wx.showToast({ title: "已用完", icon: "success" });
      }
      await this.load();
    } catch (err) {
      const code =
        err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      if (code === "NOT_FOUND") {
        // 别处刚处理过(重复完成):刷新收敛,不报吓人的错
        wx.showToast({ title: "这条刚处理过,已刷新", icon: "none" });
        await this.load();
        return;
      }
      if (code === "VERSION_CONFLICT") {
        // 这一轮已被家人处理并换了新提醒(PR #52 B1):刷新看最新,绝不误伤
        wx.showToast({ title: "这条刚被家人处理过,已刷新", icon: "none" });
        await this.load();
        return;
      }
      wx.showModal({
        title: "没办成",
        content: errorMessage(err),
        showCancel: false,
      });
    } finally {
      this.setData({ completing: false });
    }
  },
});
