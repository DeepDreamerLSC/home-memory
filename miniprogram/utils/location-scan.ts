/**
 * D1 位置级视频清点的客户端纯原语(issue #94,docs/design/video-ai/
 * D1-IMPLEMENTATION.md §6.2/§6.3):提交载荷构建、「上次清点」摘要格式化、
 * 会话 storage key。与 utils/video-scene.ts 的纯函数原语同风格——不触网络,
 * 高亮/草稿骨架全部复用 B 的原语,这里只叠加位置上下文的形状纪律:
 * 新物品 location_text 必须逐字等于目标节点路径文本(服务端权威同一份约定),
 * 任何一件不合规整批不提交(先在客户端拦下,服务端形状门是第二道硬门)。
 */
import type {
  LocationScanCommitLocation,
  VideoSceneCommitItem,
} from "../types";
import {
  buildDraftHighlights,
  SCENE_HIGHLIGHTS_MAX,
  SCENE_ITEMS_MAX,
  type SceneDraftItem,
  type SceneObservation,
} from "./video-scene";

/** 会话 storage key:按 scope + node_id 隔离(§6.2,独立于 B 的 scene 会话) */
export const LOCATION_SCAN_SESSION_PREFIX = "home-memory:location-scan-session:";
/** 会话 TTL:24h,同 B 的 scene 会话纪律 */
export const LOCATION_SCAN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function locationScanSessionKey(scopeId: string, nodeId: string): string {
  return LOCATION_SCAN_SESSION_PREFIX + (scopeId || "default") + ":" + nodeId;
}

/**
 * D1 草稿 = B 草稿 + 位置上下文:
 * - nodeId:仅 target:"new";新物品目标节点(缺省 = 进入位置本层)
 * - moveToNodeId/expectedVersion:仅 target:"existing";用户在三选弹窗点了
 *   「移动到当前位置并关联」才存在——缺省就是「只关联,不改位置」。
 */
export interface LocationScanDraft extends SceneDraftItem {
  nodeId?: string;
  moveToNodeId?: string;
  expectedVersion?: number;
}

export interface LocationScanCommitContext {
  /** 进入清点的位置节点 id(scan 的 location_id;新物品缺省挂这里) */
  locationId: string;
  /** 子树路径表(含自身;node_id → 路径段),来自 locationScanContext.subtree */
  pathsByNodeId: Record<string, string[]>;
}

export type LocationScanBuildResult =
  | { ok: true; items: VideoSceneCommitItem[]; location: LocationScanCommitLocation; candidateCount: number }
  | { ok: false; message: string };

/**
 * 构建 D1 提交载荷(在 B 的 buildSceneCommitItems 骨架上叠加位置纪律):
 * - 新物品:nodeId 缺省 = 进入位置;location_text 必须 === 目标节点路径文本,
 *   不一致 = 页面状态被写坏,客户端先拦(服务端同款门是第二道);
 * - 已有物品:moveToNodeId 存在时 expectedVersion 必填(匹配池读到的版本);
 * - location 块:path_snapshot/text_snapshot 用进入位置自身的路径快照。
 */
export function buildLocationScanCommitItems(
  drafts: LocationScanDraft[],
  observations: SceneObservation[],
  durationMs: number,
  ctx: LocationScanCommitContext,
  sceneId: string,
): LocationScanBuildResult {
  const selfPath = ctx.pathsByNodeId[ctx.locationId];
  if (selfPath === undefined || selfPath.length === 0) {
    return { ok: false, message: "位置信息已变化,请退出后重新进入" };
  }
  const picked = drafts.filter((d) => d.checked);
  if (picked.length < 1) return { ok: false, message: "请至少勾选一件物品" };
  if (picked.length > SCENE_ITEMS_MAX) {
    return { ok: false, message: "一次最多确认 " + SCENE_ITEMS_MAX + " 件,请分批处理" };
  }
  const existingSeen = new Set<string>();
  const items: VideoSceneCommitItem[] = [];
  for (const draft of picked) {
    const name = draft.name.trim();
    const highlights = buildDraftHighlights(draft, observations, durationMs);
    if (highlights.length < 1) {
      return { ok: false, message: name ? "「" + name + "」还没有可确认的高亮" : "有一件物品还没有可确认的高亮" };
    }
    if (highlights.length > SCENE_HIGHLIGHTS_MAX) {
      return { ok: false, message: "单件最多 " + SCENE_HIGHLIGHTS_MAX + " 条高亮,请取消多余线索后再保存" };
    }
    if (draft.target === "existing") {
      if (draft.itemId === "") return { ok: false, message: "请选择要关联的已有物品" };
      if (existingSeen.has(draft.itemId)) {
        return { ok: false, message: "同一件已有物品不能在一次提交中出现两次" };
      }
      existingSeen.add(draft.itemId);
      const item: VideoSceneCommitItem = {
        draft_key: draft.draftKey,
        target: "existing",
        item_id: draft.itemId,
        highlights,
      };
      if (draft.moveToNodeId !== undefined) {
        if (Number.isInteger(draft.expectedVersion) !== true || (draft.expectedVersion as number) < 1) {
          return { ok: false, message: "「" + (name || "关联物品") + "」的移动版本信息缺失,请重新选择" };
        }
        item.move_to_node_id = draft.moveToNodeId;
        item.expected_version = draft.expectedVersion;
      }
      items.push(item);
    } else {
      if (name === "") return { ok: false, message: "请给每件新物品填写名称" };
      const nodeId = draft.nodeId !== undefined && draft.nodeId !== "" ? draft.nodeId : ctx.locationId;
      const targetPath = ctx.pathsByNodeId[nodeId];
      if (targetPath === undefined) {
        return { ok: false, message: "「" + name + "」的目标位置不在当前范围内,请重新选择" };
      }
      const pathText = targetPath.join(" / ");
      if (draft.locationText.trim() !== pathText) {
        return { ok: false, message: "「" + name + "」的位置记录与所选位置不一致,请重选子位置" };
      }
      if (draft.operationId === "") return { ok: false, message: "草稿参数异常,请重试" };
      items.push({
        draft_key: draft.draftKey,
        target: "new",
        operation_id: draft.operationId,
        name,
        location_text: pathText,
        note: draft.note.trim(),
        highlights,
        node_id: nodeId,
      });
    }
  }
  return {
    ok: true,
    items,
    location: {
      location_id: ctx.locationId,
      scan_id: sceneId,
      path_snapshot: selfPath.slice(),
      text_snapshot: selfPath.join(" / "),
    },
    candidateCount: observations.length,
  };
}

/** ISO 时间 → 「M-D」(摘要行用;无效输入返回 "") */
export function scanDateText(iso: string): string {
  if (typeof iso !== "string" || iso.length < 10) return "";
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (Number.isInteger(month) !== true || month < 1 || month > 12) return "";
  if (Number.isInteger(day) !== true || day < 1 || day > 31) return "";
  return month + "-" + day;
}

/**
 * 「上次清点」摘要行(§6.1 示例:「上次清点:10-18 · 确认 4 件(2 件已删)」):
 * confirmedCount 是 scan 的原始确认数,aliveCount 是仍存活清单数,
 * 差额如实标「N 件已删」;0 确认写「确认 0 件」。
 */
export function lastScanSummaryText(
  createdAt: string,
  confirmedCount: number,
  aliveCount: number,
): string {
  const date = scanDateText(createdAt);
  const deleted = confirmedCount - aliveCount;
  const suffix = deleted > 0 ? "(" + deleted + " 件已删)" : "";
  return (
    "上次清点:" + (date !== "" ? date + " · " : "") +
    "确认 " + Math.max(0, confirmedCount) + " 件" + suffix
  );
}

/** 子树节点缩进列表的展示行(depth 以进入位置为 0;选择器只渲染子树节点) */
export interface SubtreeOptionView {
  location_id: string;
  name: string;
  /** 相对进入位置的深度(0=本层),渲染缩进用 */
  depth: number;
  pathText: string;
}

export function subtreeOptionViews(
  subtree: Array<{ location_id: string; name: string; path: string[] }>,
  rootLocationId: string,
): SubtreeOptionView[] {
  let rootDepth = -1;
  for (const node of subtree) {
    if (node.location_id === rootLocationId) {
      rootDepth = node.path.length;
      break;
    }
  }
  return subtree.map((node) => ({
    location_id: node.location_id,
    name: node.name,
    depth: rootDepth >= 0 ? Math.max(0, node.path.length - rootDepth) : 0,
    pathText: node.path.join(" / "),
  }));
}
