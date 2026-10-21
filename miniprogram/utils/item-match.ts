/**
 * D1 位置级视频清点的已有物品五级匹配(issue #94,docs/design/video-ai/
 * D1-IMPLEMENTATION.md §3):纯函数,输入匹配池 + 名字 → 建议,不触网络/storage。
 *
 * 产品红线:任何级别都只是「建议」——同名绝不自动合并、点选绝不自动关联,
 * 用户点选才切 target:"existing"(挂载在子树外还必须再过一次三选移动弹窗)。
 * 归一化与 locations/lib/normalize.js 的精神一致,但客户端独立实现,不改云函数。
 */
import type {
  LocationScanContextNode,
  LocationScanPoolItem,
} from "../types";

/** 建议列表上限(§3:截断 5 条) */
export const ITEM_MATCH_SUGGESTIONS_MAX = 5;

/** 编辑距离容忍:查询归一化后 ≤4 码点容 1,更长容 2(§3 第 2 级原文) */
const LEV_SHORT_MAX_LEN = 4;

/** 归一化后删除的常见标点(§3 原文集:半角与全角形式都列,NFKC 不可用时同样删) */
const PUNCTUATION = [
  ",",
  ",",
  "、",
  "。",
  "·",
  "・",
  ".",
  "-",
  "-",
  "_",
  "/",
  "(",
  ")",
  "(",
  ")",
  "[",
  "]",
  "【",
  "】",
  ":",
  ":",
];

/**
 * 匹配用归一化:trim → Unicode NFKC(全半角统一)→ 转小写 → 删全部空白
 * (\s,与 B 的 nameKeyOf 同款)→ 删常见标点。
 */
export function normalizeForMatch(s: string): string {
  let out = (s || "").trim();
  if (out === "") return "";
  try {
    out = out.normalize("NFKC");
  } catch (e) {
    // 极老运行时无 normalize:退化为只做后续步骤,同名判断仍成立
  }
  out = out.toLowerCase().replace(/\s+/g, "");
  let cleaned = "";
  for (const ch of out) {
    if (PUNCTUATION.indexOf(ch) === -1) cleaned += ch;
  }
  return cleaned;
}

/** 编辑距离(Levenshtein);两串任一为空返回另一串长度 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length];
}

/** 第 2/4 级模糊判定:双向包含或编辑距离在容忍内(查询长度 ≤4 容 1,否则容 2) */
function isFuzzyMatch(nq: string, nName: string): boolean {
  if (nq === "" || nName === "") return false;
  if (nName.indexOf(nq) !== -1 || nq.indexOf(nName) !== -1) return true;
  const tolerance = nq.length <= LEV_SHORT_MAX_LEN ? 1 : 2;
  return editDistance(nq, nName) <= tolerance;
}

export interface ItemMatchSuggestion {
  item_id: string;
  name: string;
  /** 「名称+当前位置」的当前位置:子树内挂载=节点完整路径;否则回退 location_text */
  location_display: string;
  /** true = location_display 是回退文本(未挂载/悬挂/子树外),页面标「未归位/在别处」 */
  location_fallback: boolean;
  mounted_in_subtree: boolean;
  level: 1 | 2 | 3 | 4;
  /** 匹配池读到的物品版本;移动三选的 expected_version 用它,绝不页面自造 */
  version: number;
}

export interface ItemMatchPools {
  subtree: LocationScanContextNode[];
  subtree_items: LocationScanPoolItem[];
  household_items: LocationScanPoolItem[];
}

interface WorkingRow extends ItemMatchSuggestion {
  normName: string;
}

/**
 * 五级顺序匹配(§3):
 * 1 子树内严格同名 → 2 子树内模糊 → 3 全家庭严格同名(排除已出现)→
 * 4 全家庭模糊(排除已出现)→ 5 无建议(返回空数组,页面保持「新建物品」)。
 * 输出按级别升序、同级按名称字典序,截断 5 条;同池同名物品可并列出现,
 * 绝不合并——哪一件是「这一件」只能由用户点选认定。
 */
export function buildItemMatchSuggestions(
  query: string,
  pools: ItemMatchPools,
): ItemMatchSuggestion[] {
  const nq = normalizeForMatch(query);
  if (nq === "") return [];

  const pathByNodeId = new Map<string, string>();
  const subtreeIds = new Set<string>();
  for (const node of pools.subtree) {
    subtreeIds.add(node.location_id);
    pathByNodeId.set(node.location_id, node.path.join(" / "));
  }

  const seen = new Set<string>();
  const rows: WorkingRow[] = [];

  const push = (item: LocationScanPoolItem, level: 1 | 2 | 3 | 4): void => {
    if (seen.has(item.item_id)) return;
    seen.add(item.item_id);
    const mounted = item.location_node_id !== "" && subtreeIds.has(item.location_node_id);
    const display = mounted
      ? pathByNodeId.get(item.location_node_id) || item.location_text
      : item.location_text || "未归位";
    rows.push({
      item_id: item.item_id,
      name: item.name,
      location_display: display,
      location_fallback: !mounted,
      mounted_in_subtree: mounted,
      level,
      version: item.version,
      normName: normalizeForMatch(item.name),
    });
  };

  for (const item of pools.subtree_items) {
    if (normalizeForMatch(item.name) === nq) push(item, 1);
  }
  for (const item of pools.subtree_items) {
    if (seen.has(item.item_id) === false && isFuzzyMatch(nq, normalizeForMatch(item.name))) {
      push(item, 2);
    }
  }
  for (const item of pools.household_items) {
    if (seen.has(item.item_id) === false && normalizeForMatch(item.name) === nq) {
      push(item, 3);
    }
  }
  for (const item of pools.household_items) {
    if (seen.has(item.item_id) === false && isFuzzyMatch(nq, normalizeForMatch(item.name))) {
      push(item, 4);
    }
  }

  rows.sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return rows.slice(0, ITEM_MATCH_SUGGESTIONS_MAX).map((row) => ({
    item_id: row.item_id,
    name: row.name,
    location_display: row.location_display,
    location_fallback: row.location_fallback,
    mounted_in_subtree: row.mounted_in_subtree,
    level: row.level,
    version: row.version,
  }));
}
