/**
 * R0 候选组收拢纯函数(issue #101,契约 docs/design/video-ai/
 * R0-OBSERVATION-GROUPS.md §5.1):组视图推导 / 三数统计 / 「就 1 件」确认集 /
 * 归属唯一阻塞门 / 代表帧。零 wx.* 依赖,node 可直接 require 测试。
 *
 * 产品红线(契约 §1/§3):
 * - 组只是线索容器,不是物品;组内观察永不因分组被修改、删除或预归属;
 * - 组态不存储,全部由 observations + drafts 推导,零新增 storage 字段;
 * - 默认绝不因同名、近邻、置信度高而静默合并;风险只来自同帧同名两条
 *   (模型同帧画了两个框),box 重叠度 / 模型自报 confidence / 自报数量
 *   提示(qtyNote)一律不参与件数或实体身份判定。
 */
import {
  groupSceneObservations,
  sceneConfidenceText,
  SCENE_HIGHLIGHTS_MAX,
  type SceneDraftItem,
  type SceneObservation,
  type SceneObservationGroup,
} from "./video-scene";
import { boxPercentStyle, videoTimeText } from "./video-target";

/** 组确认态(契约 §1.2 最少态集:三态,sameFrameRisk 是正交布尔另行携带) */
export type SceneGroupState = "pending" | "single" | "multi";

/** 组内一条观察的视图行;claimText=「已用于:{草稿名}」或 "" */
export interface SceneObsView {
  obsId: string;
  name: string;
  timeText: string;
  confidenceText: string;
  framePath: string;
  boxStyle: string;
  checked: boolean;
  claimed: boolean;
  claimText: string;
}

/** 代表帧视图(仅默认展示;obsId 供缩略图预览,不参与高亮构建) */
export interface SceneRepFrameView {
  obsId: string;
  framePath: string;
  boxStyle: string;
  timeText: string;
}

export interface SceneGroupView {
  nameKey: string;
  label: string;
  countText: string;
  state: SceneGroupState;
  stateText: string;
  remainingCount: number;
  sameFrameRisk: boolean;
  /** §2.1 修订(PR #105 review 5626920410):重复实际发生帧的时间文本;无同帧重复为 "" */
  duplicateFrameTimeText: string;
  highlightWarning: string;
  repFrame: SceneRepFrameView;
  observations: SceneObsView[];
}

/** §4 三数分立:N 线索数 / M 待确认组数 / N_d 草稿总数 / X checked 草稿数 */
export interface SceneGroupStats {
  observationCount: number;
  pendingGroupCount: number;
  draftCount: number;
  checkedDraftCount: number;
  topLineText: string;
}

/** §2.4 归属唯一不变式的阻塞判定结果:首个冲突(按观察数组扫描序) */
export interface SceneClaimConflict {
  obsId: string;
  draftName: string;
}

function claimTextOf(draftName: string): string {
  return "已用于:" + draftName;
}

/**
 * §2.1 冻结警示串(单一来源,两页共用):线索数 > 单件高亮上限时显式警示,
 * 绝不静默截断(保存被既有 8 条门拦截)。组卡按剩余未归属数、草稿卡按草稿
 * 线索数(observationIds.length)取用;≤8 返回 ""。
 */
export function sceneHighlightWarningText(clueCount: number): string {
  return clueCount > SCENE_HIGHLIGHTS_MAX
    ? "线索 " + clueCount + " 条,单件最多 " + SCENE_HIGHLIGHTS_MAX + " 条高亮,保存前需减到 ≤" + SCENE_HIGHLIGHTS_MAX
    : "";
}

/**
 * §2.1 修订(架构复审 PR #105 review 5626920410):同帧风险弹窗显示
 * 「重复实际发生的帧」的时间,而非代表帧时间。找到组内出现 ≥2 条观察的
 * frameIndex(取扫描序最先命中者),返回该 frameIndex 下扫描序第一条观察的
 * 时间文本;组无同帧重复时返回空串(调用方仅在有 sameFrameRisk 时使用)。
 * 两页经组视图携带的本字段共用此单一来源,不得各自计算。
 */
export function duplicateFrameTimeText(group: SceneObservationGroup): string {
  const counts = new Map<number, number>();
  for (const obs of group.observations) {
    counts.set(obs.frameIndex, (counts.get(obs.frameIndex) || 0) + 1);
  }
  for (const obs of group.observations) {
    if ((counts.get(obs.frameIndex) || 0) >= 2) return videoTimeText(obs.timeMs);
  }
  return "";
}

/**
 * §2.1 同帧风险二次确认 modal 的冻结文案(单一来源,两页共用,防单边漂移):
 * 标题「可能有多件」/ 内容(含 {重复所在帧时间},§2.1 修订 PR #105 review
 * 5626920410——重复实际发生的帧,而非代表帧)/ 确认「就1件」/ 取消「再看看」。
 */
export interface SameFrameRiskModalCopy {
  title: string;
  content: string;
  confirmText: string;
  cancelText: string;
}

export function sameFrameRiskModalCopy(duplicateFrameTimeText: string): SameFrameRiskModalCopy {
  return {
    title: "可能有多件",
    content: "这一组在第 " + duplicateFrameTimeText + " 的同一帧里出现了两条同名线索,可能是两件同名物品。确定只有 1 件吗?",
    confirmText: "就1件",
    cancelText: "再看看",
  };
}

/** obsId → 首个归属草稿(扫描序;不变式下至多一个,防御性取首个) */
function buildClaimIndex(drafts: SceneDraftItem[]): Map<string, SceneDraftItem> {
  const byObs = new Map<string, SceneDraftItem>();
  for (const d of drafts) {
    for (const id of d.observationIds) {
      if (byObs.has(id) === false) byObs.set(id, d);
    }
  }
  return byObs;
}

/** §3.1 同帧同名检测:组内存在某 frameIndex 上 ≥2 条观察(唯一确定性多件信号) */
function sameFrameDuplicate(observations: SceneObservation[]): boolean {
  const seen = new Set<number>();
  for (const obs of observations) {
    if (seen.has(obs.frameIndex)) return true;
    seen.add(obs.frameIndex);
  }
  return false;
}

/**
 * §3.2 代表观察:timeMs 最大者;并列(同帧多条)取 box 非 null 者;
 * 仍并列取 obsId 字典序最小者。三键均可从 SceneObservation 推导,输出确定。
 */
export function representativeObservation(group: SceneObservationGroup): SceneObservation {
  const list = group.observations;
  if (list.length === 0) {
    throw new Error("representativeObservation: 组内没有观察(分组原语保证组非空)");
  }
  let best = list[0];
  for (let i = 1; i < list.length; i++) {
    const obs = list[i];
    if (obs.timeMs > best.timeMs) {
      best = obs;
      continue;
    }
    if (obs.timeMs < best.timeMs) continue;
    const obsHasBox = obs.box !== null;
    const bestHasBox = best.box !== null;
    if (obsHasBox && !bestHasBox) {
      best = obs;
      continue;
    }
    if (obsHasBox !== bestHasBox) continue;
    if (obs.obsId < best.obsId) best = obs;
  }
  return best;
}

/**
 * 组视图(契约 §5.1):内部调 groupSceneObservations(normalizeForMatch 单一
 * 分组口径),组序=首现序、组内=扫描序,同输入产出逐字节确定的输出。
 * checkedObsIds 仅是展示位(来源默认不勾选),归属/组态/统计均与它无关。
 */
export function buildSceneGroupViews(
  observations: SceneObservation[],
  drafts: SceneDraftItem[],
  checkedObsIds?: string[],
): SceneGroupView[] {
  const checked = new Set(checkedObsIds || []);
  const claimByObs = buildClaimIndex(drafts);
  return groupSceneObservations(observations).map((group) => {
    const rows: SceneObsView[] = group.observations.map((obs) => {
      const claim = claimByObs.get(obs.obsId);
      return {
        obsId: obs.obsId,
        name: obs.name,
        timeText: videoTimeText(obs.timeMs),
        confidenceText: sceneConfidenceText(obs.confidence),
        framePath: obs.framePath,
        boxStyle: boxPercentStyle(obs.box),
        checked: checked.has(obs.obsId),
        claimed: claim !== undefined,
        claimText: claim === undefined ? "" : claimTextOf(claim.name),
      };
    });

    // 归属草稿集合(组内首现序)与剩余未归属数 → 三态推导(§1.2)
    const claiming: SceneDraftItem[] = [];
    const seenKeys = new Set<string>();
    let claimedCount = 0;
    for (const obs of group.observations) {
      const d = claimByObs.get(obs.obsId);
      if (d === undefined) continue;
      claimedCount += 1;
      if (seenKeys.has(d.draftKey) === false) {
        seenKeys.add(d.draftKey);
        claiming.push(d);
      }
    }
    const remainingCount = group.observations.length - claimedCount;
    let state: SceneGroupState;
    let stateText: string;
    if (remainingCount > 0) {
      state = "pending";
      stateText = claiming.length === 0
        ? "待确认有几件"
        : "待确认有几件(已确认 " + claiming.length + " 件,剩 " + remainingCount + " 条线索)";
    } else if (claiming.length <= 1) {
      state = "single";
      stateText = "已按 1 件确认 → " + (claiming.length === 1 ? claiming[0].name : "");
    } else {
      state = "multi";
      stateText = "已按 " + claiming.length + " 件确认";
    }

    const rep = representativeObservation(group);
    return {
      nameKey: group.nameKey,
      label: group.label,
      countText: group.observations.length + " 条线索",
      state,
      stateText,
      remainingCount,
      sameFrameRisk: sameFrameDuplicate(group.observations),
      // §2.1 修订(PR #105 review 5626920410):风险弹窗时间=重复实际发生帧,单一来源见 duplicateFrameTimeText
      duplicateFrameTimeText: duplicateFrameTimeText(group),
      // §2.1:确认集>单件高亮上限时显式警示(组卡按剩余未归属数;确认后警示随草稿走,见草稿卡),绝不静默截断
      highlightWarning: sceneHighlightWarningText(remainingCount),
      repFrame: {
        obsId: rep.obsId,
        framePath: rep.framePath,
        boxStyle: boxPercentStyle(rep.box),
        timeText: videoTimeText(rep.timeMs),
      },
      observations: rows,
    };
  });
}

/** §4 统计:M=组内存在未归属观察的组数(已完全确认组不计入) */
export function groupStats(observations: SceneObservation[], drafts: SceneDraftItem[]): SceneGroupStats {
  const views = buildSceneGroupViews(observations, drafts);
  let pendingGroupCount = 0;
  for (const v of views) {
    if (v.state === "pending") pendingGroupCount += 1;
  }
  const draftCount = drafts.length;
  let checkedDraftCount = 0;
  for (const d of drafts) {
    if (d.checked) checkedDraftCount += 1;
  }
  const topLineText = pendingGroupCount > 0
    ? "AI 线索 " + observations.length + " 条 → " + pendingGroupCount + " 组待确认,已确认 " + draftCount + " 件"
    : "AI 线索 " + observations.length + " 条,已全部确认 " + draftCount + " 件";
  return {
    observationCount: observations.length,
    pendingGroupCount,
    draftCount,
    checkedDraftCount,
    topLineText,
  };
}

/**
 * §2.1 「就 1 件」确认集:组内未归属观察中用户勾选的子集;
 * checkedIds 为 null/undefined/空数组 = 整组未归属观察(折叠态直接点击)。
 * 输出按组内扫描序、无重复,天然排除已归属观察(§2.4)。
 */
export function confirmSingleSet(
  groupView: SceneGroupView,
  checkedIds: string[] | null | undefined,
): string[] {
  const wanted = checkedIds !== null && checkedIds !== undefined && checkedIds.length > 0
    ? new Set(checkedIds)
    : null;
  const out: string[] = [];
  for (const row of groupView.observations) {
    if (row.claimed) continue;
    if (wanted !== null && wanted.has(row.obsId) === false) continue;
    if (out.indexOf(row.obsId) === -1) out.push(row.obsId);
  }
  return out;
}

/**
 * §2.4 归属唯一阻塞门:勾选中含已归属观察 → 返回首个冲突(按观察数组扫描序,
 * 页面据此回查「第 {序号} 条」),无冲突返回 null。
 */
export function claimGuard(
  observations: SceneObservation[],
  drafts: SceneDraftItem[],
  selectedIds: string[],
): SceneClaimConflict | null {
  const wanted = new Set(selectedIds);
  if (wanted.size === 0) return null;
  for (const obs of observations) {
    if (wanted.has(obs.obsId) === false) continue;
    for (const d of drafts) {
      if (d.observationIds.indexOf(obs.obsId) !== -1) {
        return { obsId: obs.obsId, draftName: d.name };
      }
    }
  }
  return null;
}
