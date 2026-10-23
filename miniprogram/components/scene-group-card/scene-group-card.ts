/**
 * R0 候选组卡(issue #101 契约 §5.2):pages/video-scan 与
 * pages/location-video-scan 两视频入口唯一的组级呈现——两页零复制。
 *
 * - 折叠(默认):label / 线索数 / 代表帧与时间 / 组态与风险文案 / 三动作
 *   (就 1 件 · 有多件或需拆开 · 暂不确定),首屏条目=组数;
 * - 展开:全部原始观察行(原图缩略+候选框+时间+置信文案),行级勾选与预览,
 *   「勾选线索各成一件」逐条生成按钮;已归属行显示「已用于:{草稿名}」不可勾;
 * - 组件只发事件不弹窗:同帧风险二次确认在页面层(契约 §2.1);
 * - 展开态与组内勾选态是交互态,不持久化(契约 §6;来源默认不勾选,
 *   整组确认可一次操作,不强迫逐帧点六次——PR #103 第 8 条)。
 */
import type { SceneGroupView } from "../../utils/scene-groups";

interface SceneGroupCardData {
  /** 组卡默认折叠(规则 1);「有多件或需拆开」「暂不确定」也切它 */
  expanded: boolean;
  /** 组内勾选 obsId(扫描序);不跨组携带 */
  checkedIds: string[];
  /** obsId → true 的渲染索引(wxml 数据绑定不支持方法调用) */
  checkedMap: Record<string, boolean>;
  /** 当前渲染组的 nameKey;wx:for 复用实例换组时清勾选 */
  currentKey: string;
}

/** properties 声明形状(typings 经 PropertyOptionToData 映射到 data):group=Object、busy=Boolean;
 * 用 type 别名而非 interface——PropertyOption 是 Record 约束,需要隐式索引签名 */
type SceneGroupCardProps = {
  group: ObjectConstructor;
  busy: BooleanConstructor;
};

type SceneGroupCardMethods = {
  onExpandToggle(): void;
  onRepFrameTap(): void;
  onObsToggle(e: WechatMiniprogram.CustomEvent): void;
  onObsImageTap(e: WechatMiniprogram.CustomEvent): void;
  onConfirmSingleTap(): void;
  onConfirmMultiTap(): void;
  onDeferTap(): void;
  onGeneratePerObsTap(): void;
};

/** 组属性运行时守卫:Object 属性缺省为 null,非对象一律视为无组 */
function groupOf(data: { group?: unknown }): SceneGroupView | null {
  const g = data.group;
  if (g === null || g === undefined || typeof g !== "object") return null;
  return g as SceneGroupView;
}

function datasetObsId(e: WechatMiniprogram.CustomEvent): string {
  const ds = e.currentTarget && e.currentTarget.dataset;
  return String((ds && ds.obsId) || "");
}

Component<SceneGroupCardData, SceneGroupCardProps, SceneGroupCardMethods, Record<string, never>>({
  properties: {
    group: Object,
    busy: Boolean,
  },

  data: {
    expanded: false,
    checkedIds: [],
    checkedMap: {},
    currentKey: "",
  },

  observers: {
    group(next: unknown) {
      // wx:for 复用组件实例换组时:清组内勾选(勾选是交互态,不跨组携带)
      const view = groupOf({ group: next });
      const key = view !== null && typeof view.nameKey === "string" ? view.nameKey : "";
      if (key !== this.data.currentKey) {
        this.setData({ currentKey: key, checkedIds: [], checkedMap: {} });
      }
    },
  },

  methods: {
    /** 点组卡头:切换展开;展开可浏览全部观察原图、框、时间点(规则 1) */
    onExpandToggle() {
      const group = groupOf(this.data);
      if (group === null) return;
      this.setData({ expanded: !this.data.expanded });
      this.triggerEvent("expand", { nameKey: group.nameKey });
    },

    /** 折叠卡代表帧缩略图:预览 current=代表帧,urls=组内全部帧(§3.2) */
    onRepFrameTap() {
      const group = groupOf(this.data);
      if (group === null) return;
      this.triggerEvent("obsPreview", { obsId: group.repFrame.obsId });
    },

    /** 行级勾选:已归属行不可勾(§2.4);选中上报 obsId,取消只改组内态不上报 */
    onObsToggle(e: WechatMiniprogram.CustomEvent) {
      const obsId = datasetObsId(e);
      if (obsId === "") return;
      const group = groupOf(this.data);
      if (group !== null) {
        for (const row of group.observations) {
          if (row.obsId === obsId && row.claimed) return;
        }
      }
      const ids = (this.data.checkedIds || []).slice();
      const at = ids.indexOf(obsId);
      if (at === -1) ids.push(obsId);
      else ids.splice(at, 1);
      const map: Record<string, boolean> = {};
      for (const id of ids) map[id] = true;
      this.setData({ checkedIds: ids, checkedMap: map });
      if (at === -1) this.triggerEvent("obsToggle", { obsId });
    },

    /** 行缩略图:catchtap 只预览,不触发行勾选 */
    onObsImageTap(e: WechatMiniprogram.CustomEvent) {
      const obsId = datasetObsId(e);
      if (obsId === "") return;
      this.triggerEvent("obsPreview", { obsId });
    },

    /** 就 1 件:obsIds=当前勾选(空=整组未归属,由页面 confirmSingleSet 解释);
     * 全组已归属时确认集为空,按钮无效(§2.1) */
    onConfirmSingleTap() {
      if (this.data.busy) return;
      const group = groupOf(this.data);
      if (group === null || group.remainingCount === 0) return;
      this.triggerEvent("confirmSingle", { nameKey: group.nameKey, obsIds: (this.data.checkedIds || []).slice() });
    },

    /** 有多件或需拆开:进入逐条模式(展开+行级勾选),不产生任何草稿(§2.2) */
    onConfirmMultiTap() {
      if (this.data.busy) return;
      const group = groupOf(this.data);
      if (group === null) return;
      this.setData({ expanded: true });
      this.triggerEvent("confirmMulti", { nameKey: group.nameKey });
    },

    /** 暂不确定:折叠该组卡,零数据变更(§2.3) */
    onDeferTap() {
      if (this.data.busy) return;
      const group = groupOf(this.data);
      if (group === null) return;
      this.setData({ expanded: false });
      this.triggerEvent("defer", { nameKey: group.nameKey });
    },

    /** 逐条模式生成:勾选线索各成一件(mergeSameName:false 语义在页面) */
    onGeneratePerObsTap() {
      if (this.data.busy) return;
      const group = groupOf(this.data);
      if (group === null) return;
      this.triggerEvent("generatePerObs", { nameKey: group.nameKey, obsIds: (this.data.checkedIds || []).slice() });
    },
  },
});
