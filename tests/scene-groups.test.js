"use strict";
/**
 * issue #101 R0 候选组收拢——纯函数 scene-groups 反例测试(先于实现;
 * 契约 docs/design/video-ai/R0-OBSERVATION-GROUPS.md §8 矩阵 A,实现 PR 以此为验收面)。
 *
 * 被测对象:npm run build:mp 产出的 miniprogram/utils/scene-groups.js(契约 §5.1,
 * 新文件;实现落地前本文件允许失败,但每一条失败必须是断言未满足——模块缺失同样
 * 以断言失败呈现,绝不以 require 崩溃呈现)。
 *
 * 契约 §5.1 只冻结了函数清单与组视图字段名;返回形状中未逐字写死的部分,由本文件
 * 冻结为实现验收面(实现 PR 照此对齐):
 * - buildSceneGroupViews(observations, drafts) → GroupView[]:
 *   { nameKey, label, countText,
 *     state: "pending" | "single" | "multi", stateText(§1.2 冻结文案),
 *     remainingCount(未归属观察数),
 *     sameFrameRisk(§3.1 同帧同名布尔),
 *     duplicateFrameTimeText(§2.1 修订 PR #105 review 5626920410:重复实际
 *       发生帧的时间文本——组内出现 ≥2 条观察的 frameIndex 取扫描序最先
 *       命中者,时间取该帧下扫描序第一条观察的 timeText;无同帧重复为 ""),
 *     highlightWarning(默认确认集=整组未归属 ≤8 条时为 "";>8 时为 §2.1 冻结警示),
 *     repFrame: { framePath, boxStyle, timeText },
 *     observations: ObsView[](obsId/name/timeText/confidenceText/framePath/
 *       boxStyle/checked/claimed/claimText;claimText=「已用于:{草稿名}」或 "") }
 * - groupStats(observations, drafts) →
 *   { observationCount(N), pendingGroupCount(M), draftCount(N_d),
 *     checkedDraftCount(X), topLineText(§4 冻结串) }
 * - confirmSingleSet(groupView, checkedIds | null) → string[](扫描序、无重复、
 *   排除已归属;checkedIds 为 null/undefined/空数组 = 整组未归属观察)
 * - claimGuard(observations, drafts, selectedIds) → null | { obsId, draftName }
 *   (首个冲突按观察数组扫描序取;§2.4 toast 的「第 {序号} 条」由页面按 obsId 回查)
 * - representativeObservation(group) → SceneObservation(输入为分组原语的组对象)
 * - sceneHighlightWarningText(count) → §2.1 冻结警示串(>8 时非空;组卡按剩余数、
 *   草稿卡按草稿线索数取用同一来源,两页零复制)
 * - sameFrameRiskModalCopy(duplicateFrameTimeText) → §2.1 同帧风险二次确认
 *   modal 冻结文案(title/content/confirmText/cancelText,两页共用单一来源,
 *   单边漂移即本文件红)。时间参数=重复所在帧时间文本(§2.1 修订,PR #105
 *   review 5626920410:此前误用代表帧时间,重复不在最新帧时弹窗指错帧),
 *   由 duplicateFrameTimeText(group) 单一来源产出,页面不得各自计算。
 * - duplicateFrameTimeText(group) → 重复实际发生帧的时间文本;组无同帧
 *   重复返回 ""(调用方仅在有 sameFrameRisk 时使用)。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const scene = require(path.join(ROOT, "miniprogram/utils/video-scene.js"));
const videoTarget = require(path.join(ROOT, "miniprogram/utils/video-target.js"));

/* ---------------- 被测模块加载(缺失 → 断言失败,不崩文件) ---------------- */

let sceneGroups = null;
let loadError = "";
try {
  sceneGroups = require(path.join(ROOT, "miniprogram/utils/scene-groups.js"));
} catch (e) {
  loadError = e && e.message ? e.message : String(e);
}

function mustFn(name) {
  assert.ok(sceneGroups !== null, "miniprogram/utils/scene-groups.js 未实现或不可加载(契约 §5.1):" + loadError);
  assert.equal(typeof sceneGroups[name], "function", "scene-groups 应导出纯函数 " + name + "(契约 §5.1)");
  return sceneGroups[name];
}

/* ---------------- 观察与草稿工厂 ---------------- */

let obsSeq = 0;
function obs(name, o) {
  o = o || {};
  const frameIndex = o.frameIndex === undefined ? 0 : o.frameIndex;
  const timeMs = o.timeMs === undefined ? frameIndex * 1500 : o.timeMs;
  obsSeq += 1;
  return {
    obsId: o.obsId || "obs-" + obsSeq,
    frameIndex,
    timeMs,
    windowStartMs: Math.max(0, timeMs - 750),
    windowEndMs: timeMs + 750,
    framePath: o.framePath || "/tmp/frame-" + frameIndex + ".jpg",
    frameWidth: 640,
    frameHeight: 480,
    name,
    qtyNote: o.qtyNote === undefined ? "" : o.qtyNote,
    confidence: o.confidence === undefined ? "mid" : o.confidence,
    box: "box" in o ? o.box : null,
  };
}

function draft(claims, o) {
  o = o || {};
  return scene.newSceneDraft({
    observationIds: claims.slice(),
    name: o.name === undefined ? "草稿" : o.name,
    locationText: o.locationText === undefined ? "书房 · 右侧抽屉" : o.locationText,
    target: o.target,
    itemId: o.itemId,
    checked: o.checked,
  });
}

/** 跨 frameIndex 0..n-1 的同名观察(一帧一条,绝无同帧重复) */
function crossFrameObs(name, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(obs(name, { obsId: "obs-" + name + "-f" + i, frameIndex: i, timeMs: i * 1500 }));
  }
  return out;
}

/** 会话级归属唯一不变式(§2.4):每个 obsId 至多归属一个草稿、且无丢失 */
function assertClaimUnique(drafts, observations, note) {
  const seen = new Map();
  for (const d of drafts) {
    for (const id of d.observationIds) {
      assert.equal(seen.has(id), false, note + ":obsId " + id + " 不得归属两个草稿");
      seen.set(id, d.draftKey);
    }
  }
  const claimed = new Set();
  for (const o of observations) {
    if (seen.has(o.obsId)) claimed.add(o.obsId);
  }
  assert.deepEqual([...claimed].sort(), [...seen.keys()].sort(), note + ":归属集合与草稿引用一致,无丢失无重复");
}

/* ---------------- A. 分组键:normalizeForMatch 单一口径 ---------------- */

test("SG-GROUP-NFKC:全角/标点变体归同组;原观察逐条原样保留(§1.1)", () => {
  const observations = [
    obs("Ｍａｇ", { obsId: "o-full", frameIndex: 0, timeMs: 0, box: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } }),
    obs("Mag", { obsId: "o-half", frameIndex: 1, timeMs: 1500 }),
    obs("充电器、", { obsId: "o-c1", frameIndex: 2, timeMs: 3000 }),
    obs("充电器", { obsId: "o-c2", frameIndex: 3, timeMs: 4500 }),
  ];
  const groups = scene.groupSceneObservations(observations);
  assert.equal(groups.length, 2, "全半角与常见标点差异必须归同组(§1.1),当前按 " + groups.length + " 组分开");
  assert.equal(groups[0].nameKey, "mag");
  assert.equal(groups[1].nameKey, "充电器");
  // 组 label = 组内首条观察的原始 name;组内每行展示各自原始 name,规范化永不改写数据
  assert.equal(groups[0].label, "Ｍａｇ");
  assert.equal(groups[1].label, "充电器、");
  // 原观察逐条保留:name/obsId/frameIndex/box 原样(名称稍变不丢观察)
  assert.deepEqual(groups[0].observations, [observations[0], observations[1]]);
  assert.deepEqual(groups[1].observations, [observations[2], observations[3]]);
  assert.equal(groups[0].observations.length + groups[1].observations.length, 4, "计数=输入数");

  const views = mustFn("buildSceneGroupViews")(observations, []);
  assert.equal(views.length, 2);
  assert.deepEqual(views[0].observations.map((r) => r.obsId), ["o-full", "o-half"]);
  assert.deepEqual(views[0].observations.map((r) => r.name), ["Ｍａｇ", "Mag"], "视图行保留原始 name");
  assert.ok(views[0].observations[0].boxStyle !== "display:none", "box 保留并可渲染");
  assert.equal(views[0].observations[1].boxStyle, "display:none");
});

test("SG-GROUP-PUNCT-EMPTY:仅标点差异归同组;规范化后为空的名称各成单条组(key=obsId)(§1.1)", () => {
  const observations = [
    obs("胶带。", { obsId: "o-p1" }),
    obs("胶带", { obsId: "o-p2" }),
    obs("。。", { obsId: "o-e1" }),
    obs("、、", { obsId: "o-e2" }),
    obs("  ", { obsId: "o-e3" }),
  ];
  const views = mustFn("buildSceneGroupViews")(observations, []);
  assert.equal(views.length, 4, "标点归一组 + 三个空键单条组");
  assert.deepEqual(views[0].observations.map((r) => r.obsId), ["o-p1", "o-p2"]);
  assert.equal(views[1].nameKey, "o-e1");
  assert.equal(views[2].nameKey, "o-e2");
  assert.equal(views[3].nameKey, "o-e3");
  for (const v of views.slice(1)) {
    assert.equal(v.observations.length, 1, "空键观察各成单条组,绝不互相归并");
    assert.equal(v.label.length > 0, true, "label 用原始 name,不改写");
  }
});

test("SG-GROUP-ORDER:组序=首现序、组内=扫描序;同输入两次调用逐字节相等(§1.1)", () => {
  const observations = [
    obs("电池", { obsId: "o-b1", frameIndex: 0, timeMs: 0 }),
    obs("充电器", { obsId: "o-c1", frameIndex: 1, timeMs: 1500 }),
    obs("电池", { obsId: "o-b2", frameIndex: 2, timeMs: 3000 }),
    obs("胶带", { obsId: "o-t1", frameIndex: 3, timeMs: 4500 }),
    obs("电池", { obsId: "o-b3", frameIndex: 4, timeMs: 6000 }),
    obs("充电器", { obsId: "o-c2", frameIndex: 5, timeMs: 7500 }),
  ];
  const buildSceneGroupViews = mustFn("buildSceneGroupViews");
  const views1 = buildSceneGroupViews(observations, []);
  const views2 = buildSceneGroupViews(observations, []);
  assert.equal(JSON.stringify(views1), JSON.stringify(views2), "同一输入产出逐字节确定的分组");
  assert.deepEqual(views1.map((g) => g.label), ["电池", "充电器", "胶带"], "组序=首现序");
  assert.deepEqual(views1[0].observations.map((r) => r.obsId), ["o-b1", "o-b2", "o-b3"], "组内=扫描序,不重排");
  assert.deepEqual(views1[1].observations.map((r) => r.obsId), ["o-c1", "o-c2"]);

  // 带草稿推导同样确定(归属参与组态,§1.2)
  const drafts = [draft(["o-b1"])];
  assert.equal(
    JSON.stringify(buildSceneGroupViews(observations, drafts)),
    JSON.stringify(buildSceneGroupViews(observations, drafts)),
    "含草稿推导亦逐字节确定",
  );
});

/* ---------------- B. 组确认态(三态 + 正交风险) ---------------- */

test("SG-STATE-PENDING:无草稿 → 全组待确认,文案「待确认有几件」(§1.2)", () => {
  const views = mustFn("buildSceneGroupViews")(crossFrameObs("充电器", 3), []);
  assert.equal(views.length, 1);
  assert.equal(views[0].state, "pending");
  assert.equal(views[0].stateText, "待确认有几件");
  assert.equal(views[0].remainingCount, 3);
});

test("SG-STATE-SINGLE:全部 obsId 落同一草稿(含改名/切 existing/未勾选)→ 就 1 件,显示草稿名(§1.2)", () => {
  const observations = crossFrameObs("充电器", 3);
  const d = draft(observations.map((o) => o.obsId), {
    name: "我改过名的充电器",
    target: "existing",
    itemId: "it_old",
    checked: false,
  });
  const views = mustFn("buildSceneGroupViews")(observations, [d]);
  assert.equal(views[0].state, "single", "归属与 checked/target/名称无关");
  assert.equal(views[0].stateText, "已按 1 件确认 → 我改过名的充电器");
  assert.equal(views[0].remainingCount, 0);
  assert.equal(views[0].observations.every((r) => r.claimed === true), true);
  assert.equal(views[0].observations[0].claimText, "已用于:我改过名的充电器");
});

test("SG-STATE-MULTI:obsId 分属 ≥2 草稿 → 多件,N=草稿数(§1.2)", () => {
  const observations = crossFrameObs("充电器", 3);
  const drafts = [draft([observations[0].obsId, observations[1].obsId]), draft([observations[2].obsId])];
  const views = mustFn("buildSceneGroupViews")(observations, drafts);
  assert.equal(views[0].state, "multi");
  assert.equal(views[0].stateText, "已按 2 件确认");
  assert.equal(views[0].remainingCount, 0);
});

test("SG-STATE-PARTIAL-UNDO:部分归属=待确认+剩余数;移除回 pending;拆分转 multi 且 obsId 集合守恒(§1.2/§2.4)", () => {
  const buildSceneGroupViews = mustFn("buildSceneGroupViews");
  const observations = crossFrameObs("充电器", 4);
  const ids = observations.map((o) => o.obsId);

  // 部分归属(1 ≤ 归属数 < 全组且草稿数=1):归入「待确认」+ 剩余数注记,不设第四态
  const d = draft([ids[0], ids[1]], { name: "已确认的那件" });
  let views = buildSceneGroupViews(observations, [d]);
  assert.equal(views[0].state, "pending", "部分归属不设第四态,留在待确认流");
  assert.equal(views[0].remainingCount, 2);
  assert.ok(views[0].stateText.indexOf("待确认有几件") !== -1, "主提示仍是待确认");
  assert.ok(views[0].stateText.indexOf("已确认 1 件") !== -1, "加注已确认件数");
  assert.ok(views[0].stateText.indexOf("剩 2 条线索") !== -1, "加注剩余线索数");

  // 撤销路径=移除草稿:观察回到未归属,组回到 pending(观察可找回)
  views = buildSceneGroupViews(observations, []);
  assert.equal(views[0].state, "pending");
  assert.equal(views[0].stateText, "待确认有几件", "全部未归属时无部分归属注记");
  assert.equal(views[0].remainingCount, 4);

  // 拆分草稿:转 multi,obsId 集合与拆前相等(无丢失无重复)
  const one = draft(ids, { name: "先按一件" });
  assertClaimUnique([one], observations, "拆分前");
  const split = scene.splitSceneDraft(one);
  assert.equal(split.length, 4);
  assertClaimUnique(split, observations, "拆分后");
  views = buildSceneGroupViews(observations, split);
  assert.equal(views[0].state, "multi");
  assert.equal(views[0].stateText, "已按 4 件确认");
  const merged = scene.mergeSceneDrafts(split, [split[0].draftKey, split[1].draftKey]);
  assert.ok(merged !== null);
  assertClaimUnique([merged, split[2], split[3]], observations, "合并后");
  assert.equal(merged.observationIds.length, 2, "mergeSceneDrafts 组内去重");
});

test("SG-NO-BURST:同名跨 6 帧、零用户动作 → 零草稿、组 pending、risk=false(§1.2/§3.1)", () => {
  const buildSceneGroupViews = mustFn("buildSceneGroupViews");
  const groupStats = mustFn("groupStats");
  const observations = crossFrameObs("电池", 6);
  const views = buildSceneGroupViews(observations, []);
  assert.equal(views.length, 1, "同名 6 帧收拢为 1 个组容器");
  assert.equal(views[0].observations.length, 6, "6 条线索逐条保留在组内");
  assert.equal(views[0].state, "pending", "零用户动作绝不默认生 6 个草稿,组待确认");
  assert.equal(views[0].remainingCount, 6);
  assert.equal(views[0].sameFrameRisk, false, "跨帧同名不预判件数:既不暗示多件");
  const stats = groupStats(observations, []);
  assert.equal(stats.draftCount, 0, "默认零草稿");
  assert.equal(stats.pendingGroupCount, 1);
  assert.equal(stats.observationCount, 6);
  assert.equal(stats.topLineText, "AI 线索 6 条 → 1 组待确认,已确认 0 件");
});

/* ---------------- C. 同帧同名风险(确定性,禁用证据清单) ---------------- */

test("SG-RISK-SAME-FRAME:同 frameIndex 两条 → risk=true;跨帧 false;9 条组必 risk;risk 不改组态(§3.1)", () => {
  const buildSceneGroupViews = mustFn("buildSceneGroupViews");
  const groupStats = mustFn("groupStats");

  // 同帧同名两条:一帧识别画了两个框——唯一确定性多件信号
  const sameFrame = [
    obs("充电器", { obsId: "o-s1", frameIndex: 2, timeMs: 3000, box: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } }),
    obs("充电器", { obsId: "o-s2", frameIndex: 2, timeMs: 3000, box: { x1: 0.5, y1: 0.5, x2: 0.6, y2: 0.6 } }),
    obs("充电器", { obsId: "o-s3", frameIndex: 5, timeMs: 7500 }),
  ];
  let views = buildSceneGroupViews(sameFrame, []);
  assert.equal(views[0].sameFrameRisk, true, "组内存在同 frameIndex 两条 → risk");
  assert.equal(views[0].state, "pending", "risk 不改变组态、不合并、不生成草稿");
  assert.equal(views[0].remainingCount, 3);
  assert.equal(groupStats(sameFrame, []).draftCount, 0, "风险信号本身绝不触发草稿");

  // 风险与任一态可叠加:显式确认后 single + risk 并存
  views = buildSceneGroupViews(sameFrame, [draft(sameFrame.map((o) => o.obsId), { name: "就一件" })]);
  assert.equal(views[0].state, "single");
  assert.equal(views[0].sameFrameRisk, true, "风险标志与组态正交,确认后仍保留标注");

  // 跨帧同名:不预判件数,风险为假
  assert.equal(buildSceneGroupViews(crossFrameObs("电池", 6), [])[0].sameFrameRisk, false);

  // 8 帧上限推导:单组 9 条观察必存在同帧同名重复 → 必 risk
  const nine = [];
  for (let i = 0; i < 9; i++) {
    nine.push(obs("胶带", { obsId: "o-n" + i, frameIndex: i % 8, timeMs: (i % 8) * 1500 }));
  }
  assert.equal(buildSceneGroupViews(nine, [])[0].sameFrameRisk, true, "单组 >8 条 ⟹ 组内必有同帧同名重复");
});

test("SG-RISK-EVIDENCE-BAN:box 重叠/confidence/qtyNote 变化不改组态与 risk;源码无 IoU 计算(§3.1)", () => {
  const buildSceneGroupViews = mustFn("buildSceneGroupViews");
  const groupStats = mustFn("groupStats");
  const boxA = { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.4 };
  const boxB = { x1: 0.6, y1: 0.6, x2: 0.8, y2: 0.9 };
  // 同一「同帧同名两条」组,只变禁用证据维度:框重叠度、confidence、qtyNote
  const variants = {
    disjointHigh: [
      obs("充电器", { obsId: "o-v1", frameIndex: 2, timeMs: 3000, box: boxA, confidence: "high", qtyNote: "×2" }),
      obs("充电器", { obsId: "o-v2", frameIndex: 2, timeMs: 3000, box: boxB, confidence: "low", qtyNote: "" }),
    ],
    identicalLow: [
      obs("充电器", { obsId: "o-v1", frameIndex: 2, timeMs: 3000, box: boxA, confidence: "low", qtyNote: "" }),
      obs("充电器", { obsId: "o-v2", frameIndex: 2, timeMs: 3000, box: boxA, confidence: "high", qtyNote: "可能有 3 个" }),
    ],
    noBoxNoNote: [
      obs("充电器", { obsId: "o-v1", frameIndex: 2, timeMs: 3000, box: null, confidence: "mid", qtyNote: "" }),
      obs("充电器", { obsId: "o-v2", frameIndex: 2, timeMs: 3000, box: null, confidence: "mid", qtyNote: "×5" }),
    ],
  };
  const decisions = {};
  for (const key of Object.keys(variants)) {
    const v = variants[key];
    const views = buildSceneGroupViews(v, []);
    decisions[key] = {
      groups: views.map((g) => g.nameKey),
      state: views[0].state,
      remaining: views[0].remainingCount,
      risk: views[0].sameFrameRisk,
      topLine: groupStats(v, []).topLineText,
    };
  }
  assert.deepEqual(decisions.identicalLow, decisions.disjointHigh, "box 重叠度/confidence/qtyNote 不得改变组态与风险");
  assert.deepEqual(decisions.noBoxNoNote, decisions.disjointHigh, "无框/自报数量提示同样不参与判定");
  // confidence 只透传既有展示文案
  const viewsHigh = buildSceneGroupViews(variants.disjointHigh, []);
  assert.equal(viewsHigh[0].observations[0].confidenceText, "较有把握");
  assert.equal(viewsHigh[0].observations[1].confidenceText, "不确定");

  // 静态红线:helper 源码不得出现 IoU/重叠度计算
  const srcPath = path.join(ROOT, "miniprogram/utils/scene-groups.js");
  assert.equal(fs.existsSync(srcPath), true, "scene-groups.js 应随实现产出编译产物");
  if (fs.existsSync(srcPath)) {
    const src = fs.readFileSync(srcPath, "utf8").toLowerCase();
    for (const token of ["iou", "overlap", "intersect"]) {
      assert.equal(src.indexOf(token), -1, "scene-groups 源码不得含 " + token + " 计算(§3.1 禁用证据清单)");
    }
  }
});

/* ---------------- D. 代表帧(仅默认展示,不丢来源高亮) ---------------- */

test("SG-REP-FRAME:timeMs 最大 → 并列取有 box → 仍并列 obsId 字典序最小;代表帧不进高亮构建(§3.2)", () => {
  const buildSceneGroupViews = mustFn("buildSceneGroupViews");
  const representativeObservation = mustFn("representativeObservation");

  // 规则一:timeMs 最大者
  const g1 = scene.groupSceneObservations([
    obs("电池", { obsId: "obs-a", frameIndex: 0, timeMs: 1000 }),
    obs("电池", { obsId: "obs-b", frameIndex: 3, timeMs: 4500 }),
    obs("电池", { obsId: "obs-c", frameIndex: 1, timeMs: 1500 }),
  ])[0];
  assert.equal(representativeObservation(g1).obsId, "obs-b");

  // 规则二:并列(同帧多条)取 box 非 null 者
  const g2 = scene.groupSceneObservations([
    obs("电池", { obsId: "obs-a", frameIndex: 2, timeMs: 3000, box: null }),
    obs("电池", { obsId: "obs-b", frameIndex: 2, timeMs: 3000, box: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } }),
  ])[0];
  assert.equal(representativeObservation(g2).obsId, "obs-b");

  // 规则三:仍并列取 obsId 字典序最小(与输入顺序无关)
  const g3 = scene.groupSceneObservations([
    obs("电池", { obsId: "obs-z", frameIndex: 4, timeMs: 6000, box: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } }),
    obs("电池", { obsId: "obs-a", frameIndex: 4, timeMs: 6000, box: { x1: 0.5, y1: 0.5, x2: 0.6, y2: 0.6 } }),
  ])[0];
  assert.equal(representativeObservation(g3).obsId, "obs-a");

  // 视图 repFrame 与代表观察一致(framePath/时间/框样式)
  const box = { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.4 };
  const single = [obs("电池", { obsId: "obs-r", frameIndex: 5, timeMs: 7500, framePath: "/tmp/frame-5.jpg", box })];
  const views = buildSceneGroupViews(single, []);
  assert.ok(views[0].repFrame, "组视图应带代表帧(§5.1)");
  assert.equal(views[0].repFrame.framePath, "/tmp/frame-5.jpg");
  assert.equal(views[0].repFrame.timeText, videoTarget.videoTimeText(7500));
  assert.equal(views[0].repFrame.boxStyle, videoTarget.boxPercentStyle(box));

  // 高亮与代表帧解耦:保存时高亮永远来自全部 observationIds
  const multi = [
    obs("电池", { obsId: "obs-h1", frameIndex: 0, timeMs: 0 }),
    obs("电池", { obsId: "obs-h2", frameIndex: 2, timeMs: 3000 }),
    obs("电池", { obsId: "obs-h3", frameIndex: 2, timeMs: 3000, box: box }),
  ];
  const d = draft(multi.map((o) => o.obsId));
  const highlights = scene.buildDraftHighlights(d, multi, 9000);
  assert.equal(highlights.length, 3, "全部来源逐条成高亮,代表帧不遮蔽任何来源");
  assert.deepEqual(highlights.map((h) => h.start_ms), [0, 3000, 3000]);
  assert.equal(highlights[1].box, null);
  assert.deepEqual(highlights[2].box, box);
});

/* ---------------- E. 归属唯一与确认集(§2.1/§2.4) ---------------- */

test("SG-CLAIM-UNIQUE:confirmSingleSet 排除已归属;claimGuard 命中首个冲突;merge/split 保持一 obsId 一草稿(§2.4)", () => {
  const buildSceneGroupViews = mustFn("buildSceneGroupViews");
  const confirmSingleSet = mustFn("confirmSingleSet");
  const claimGuard = mustFn("claimGuard");

  const observations = crossFrameObs("充电器", 3);
  const ids = observations.map((o) => o.obsId);
  const d1 = draft([ids[0]], { name: "第一件" });
  const views = buildSceneGroupViews(observations, [d1]);
  assert.equal(views[0].observations[0].claimed, true);
  assert.equal(views[0].observations[0].claimText, "已用于:第一件");
  assert.equal(views[0].observations[1].claimed, false);
  assert.equal(views[0].observations[1].claimText, "");

  // 确认集:勾选含已归属观察 → 天然排除;空/缺省 → 整组未归属;乱序输入 → 扫描序输出
  assert.deepEqual(confirmSingleSet(views[0], [ids[0], ids[1], ids[2]]), [ids[1], ids[2]], "已归属的 " + ids[0] + " 被排除");
  assert.deepEqual(confirmSingleSet(views[0], null), [ids[1], ids[2]], "折叠态直接点击=整组未归属");
  assert.deepEqual(confirmSingleSet(views[0], []), [ids[1], ids[2]], "展开态勾选为空=整组未归属");
  assert.deepEqual(confirmSingleSet(views[0], [ids[2], ids[1]]), [ids[1], ids[2]], "输出按扫描序,无重复");

  // 阻塞判定:命中冲突返回观察+草稿名(按扫描序首个);无冲突返回 null
  assert.deepEqual(claimGuard(observations, [d1], [ids[1], ids[0]]), { obsId: ids[0], draftName: "第一件" });
  assert.equal(claimGuard(observations, [d1], [ids[1], ids[2]]), null);

  // merge/split 是对已归属集合的并/划分,天然保持不变式
  const all = draft(ids, { name: "先一件" });
  const split = scene.splitSceneDraft(all);
  assertClaimUnique(split, observations, "拆分");
  const merged = scene.mergeSceneDrafts(split, [split[0].draftKey, split[2].draftKey]);
  assertClaimUnique([merged, split[1]], observations, "合并");
  assert.deepEqual(merged.observationIds, [ids[0], ids[2]], "合并保留首个 draftKey/operationId 的语义外,obsId 按扫描序去重");
});

test("SG-SINGLE-DRAFT-SHAPE:就 1 件草稿=确认集扫描序无重复/独立 key/name=组 label/checked=true;保存链通过且高亮逐条对应(§2.1)", () => {
  const buildSceneGroupViews = mustFn("buildSceneGroupViews");
  const confirmSingleSet = mustFn("confirmSingleSet");
  const observations = [
    obs("充电器", { obsId: "o-d1", frameIndex: 0, timeMs: 0 }),
    obs("充电器", { obsId: "o-d2", frameIndex: 1, timeMs: 1500 }),
    obs("充电器", { obsId: "o-d3", frameIndex: 2, timeMs: 3000, box: { x1: 0.2, y1: 0.2, x2: 0.5, y2: 0.6 } }),
  ];
  const views = buildSceneGroupViews(observations, []);
  const set = confirmSingleSet(views[0], null);
  const d = scene.newSceneDraft({
    observationIds: set,
    name: views[0].label,
    locationText: "书房 · 右侧抽屉",
    checked: true,
  });
  assert.deepEqual(d.observationIds, ["o-d1", "o-d2", "o-d3"], "observationIds=确认集,扫描序无重复");
  assert.equal(d.name, "充电器", "name=组 label");
  assert.equal(d.checked, true);
  assert.ok(d.draftKey.length > 0 && d.operationId.length > 0, "draftKey/operationId 由 newSceneDraft 独立生成");
  // 全场唯一:与另一组、既有草稿绝不共享
  const other = scene.newSceneDraft({ observationIds: ["o-x"], name: "别组", locationText: "书房", checked: true });
  assert.notEqual(d.draftKey, other.draftKey);
  assert.notEqual(d.operationId, other.operationId);

  const built = scene.buildSceneCommitItems([d], observations, 9000);
  assert.equal(built.ok, true, built.ok === false ? built.message : "");
  assert.equal(built.items[0].highlights.length, 3, "高亮从全部 observationIds 逐条构建");
  assert.deepEqual(built.items[0].highlights.map((h) => h.start_ms), [0, 1500, 3000]);
  assert.deepEqual(built.items[0].highlights[2].box, { x1: 0.2, y1: 0.2, x2: 0.5, y2: 0.6 });
});

test("SG-HIGHLIGHT-CAP:确认集 9 条 → 草稿可生成、buildDraftHighlights 不截断、保存被 8 条门拒绝、组卡显式警示(§2.1)", () => {
  const buildSceneGroupViews = mustFn("buildSceneGroupViews");
  const confirmSingleSet = mustFn("confirmSingleSet");
  // 9 条同组(8 帧上限 ⟹ 末两条必同帧);同帧两条框不同,高亮逐条可分
  const observations = [];
  for (let i = 0; i < 8; i++) {
    observations.push(obs("胶带", { obsId: "o-cap" + i, frameIndex: i, timeMs: i * 1500, box: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } }));
  }
  observations.push(obs("胶带", { obsId: "o-cap8", frameIndex: 7, timeMs: 10500, box: { x1: 0.5, y1: 0.5, x2: 0.6, y2: 0.6 } }));
  const views = buildSceneGroupViews(observations, []);
  assert.equal(views[0].remainingCount, 9);
  assert.equal(
    views[0].highlightWarning,
    "线索 9 条,单件最多 8 条高亮,保存前需减到 ≤8",
    "组卡警示为 §2.1 冻结文案,显式说明实际上限",
  );

  const set = confirmSingleSet(views[0], null);
  assert.equal(set.length, 9);
  const d = scene.newSceneDraft({ observationIds: set, name: views[0].label, locationText: "书房", checked: true });
  assert.equal(scene.buildDraftHighlights(d, observations, 15000).length, 9, "确认时不截断任何高亮来源");
  const rejected = scene.buildSceneCommitItems([d], observations, 15000);
  assert.equal(rejected.ok, false, "保存被既有 8 条硬门拦截");
  assert.ok(rejected.message.indexOf("8") !== -1, rejected.message);

  // 减到 ≤8 后同一组可保存;警示随剩余数消失
  const eight = confirmSingleSet(views[0], observations.slice(0, 8).map((o) => o.obsId));
  assert.equal(eight.length, 8);
  const d8 = scene.newSceneDraft({ observationIds: eight, name: views[0].label, locationText: "书房", checked: true });
  assert.equal(scene.buildSceneCommitItems([d8], observations, 15000).ok, true, "≤8 条通过既有门");
  const afterClaim = buildSceneGroupViews(observations, [d8]);
  assert.equal(afterClaim[0].highlightWarning, "", "剩余确认集 ≤8 后不再警示");
});

test("SG-HIGHLIGHT-WARN-SHARED:警示串单一来源;9 条草稿(整组确认后)由草稿侧继续警示(§2.1)", () => {
  const warnText = mustFn("sceneHighlightWarningText");
  // §2.1 冻结串逐字;≤8 恒空
  assert.equal(warnText(0), "");
  assert.equal(warnText(8), "");
  assert.equal(warnText(9), "线索 9 条,单件最多 8 条高亮,保存前需减到 ≤8");
  assert.equal(warnText(12), "线索 12 条,单件最多 8 条高亮,保存前需减到 ≤8");

  // 复审发现 1 回归:9 条「就 1 件」确认后组卡警示随剩余数消失,警示必须由草稿侧
  // (draft.observationIds.length)继续承担——同一来源、同一冻结串,保存前始终可见
  const buildSceneGroupViews = mustFn("buildSceneGroupViews");
  const observations = [];
  for (let i = 0; i < 8; i++) {
    observations.push(obs("胶带", { obsId: "o-warn" + i, frameIndex: i, timeMs: i * 1500 }));
  }
  observations.push(obs("胶带", { obsId: "o-warn8", frameIndex: 7, timeMs: 10500 }));
  const before = buildSceneGroupViews(observations, []);
  assert.equal(before[0].highlightWarning, "线索 9 条,单件最多 8 条高亮,保存前需减到 ≤8", "确认前组卡警示");
  const d = scene.newSceneDraft({ observationIds: before[0].observations.map((r) => r.obsId), name: "胶带", locationText: "书房", checked: true });
  const after = buildSceneGroupViews(observations, [d]);
  assert.equal(after[0].highlightWarning, "", "整组归属后组卡警示消失(剩余 0)");
  assert.equal(warnText(d.observationIds.length), "线索 9 条,单件最多 8 条高亮,保存前需减到 ≤8", "草稿卡以草稿线索数取同一警示串,保存前预警不中断");
  // 手动补件(零线索)永不警示
  const manual = scene.newSceneDraft({ name: "手补", locationText: "书房", manualHighlights: [{ start_ms: 0, end_ms: 900, box: null, frame_ms: 0 }], checked: true });
  assert.equal(warnText(manual.observationIds.length), "");
});

test("SG-RISK-MODAL-COPY:同帧风险 modal 冻结文案单一来源;时间=重复所在帧时间而非代表帧时间(§2.1 修订,PR #105 review 5626920410)", () => {
  const modalCopy = mustFn("sameFrameRiskModalCopy");
  const dupTime = mustFn("duplicateFrameTimeText");

  // 参数语义=重复帧时间文本:重复发生在 frameIndex 2(0:03),另有更新的一帧(代表帧 0:09)
  const observations = [
    obs("充电器", { obsId: "o-mc-a", frameIndex: 2, timeMs: 3000 }),
    obs("充电器", { obsId: "o-mc-b", frameIndex: 2, timeMs: 3000 }),
    obs("充电器", { obsId: "o-mc-c", frameIndex: 6, timeMs: 9000 }),
  ];
  const group = scene.groupSceneObservations(observations)[0];
  assert.equal(
    dupTime(group),
    videoTarget.videoTimeText(3000),
    "重复帧时间=扫描序最先命中的重复 frameIndex 下第一条观察的时间",
  );
  assert.equal(
    dupTime(scene.groupSceneObservations(crossFrameObs("电池", 3))[0]),
    "",
    "无同帧重复返回空串(调用方仅在有 sameFrameRisk 时使用)",
  );

  const copy = modalCopy(dupTime(group));
  assert.equal(copy.title, "可能有多件");
  assert.equal(copy.content, "这一组在第 0:03 的同一帧里出现了两条同名线索,可能是两件同名物品。确定只有 1 件吗?");
  assert.equal(copy.confirmText, "就1件");
  assert.equal(copy.cancelText, "再看看");
});

test("SG-RISK-DUP-OLD-FRAME:重复发生在旧帧、代表帧为新帧时,弹窗时间指向旧帧(重复帧)而非新帧(§2.1 修订,PR #105 review 5626920410)", () => {
  const buildSceneGroupViews = mustFn("buildSceneGroupViews");
  const dupTime = mustFn("duplicateFrameTimeText");
  const modalCopy = mustFn("sameFrameRiskModalCopy");

  // 反例:两条同名观察重复出现在旧帧 frameIndex 1(0:01);代表帧=组内 timeMs
  // 最大者=0:07(新帧)——弹窗必须指向重复实际发生的旧帧
  const observations = [
    obs("充电器", { obsId: "o-old-a", frameIndex: 1, timeMs: 1500 }),
    obs("充电器", { obsId: "o-old-b", frameIndex: 1, timeMs: 1500 }),
    obs("充电器", { obsId: "o-new-c", frameIndex: 5, timeMs: 7500 }),
  ];
  const views = buildSceneGroupViews(observations, []);
  assert.equal(views[0].sameFrameRisk, true);
  assert.equal(views[0].repFrame.timeText, videoTarget.videoTimeText(7500), "代表帧仍是 timeMs 最大者(新帧,§3.2 规则不变)");
  assert.equal(views[0].duplicateFrameTimeText, videoTarget.videoTimeText(1500), "组视图携带重复帧时间(旧帧)");
  assert.equal(dupTime(scene.groupSceneObservations(observations)[0]), videoTarget.videoTimeText(1500));

  const copy = modalCopy(views[0].duplicateFrameTimeText);
  assert.equal(
    copy.content,
    "这一组在第 0:01 的同一帧里出现了两条同名线索,可能是两件同名物品。确定只有 1 件吗?",
    "弹窗文案指向重复实际发生的帧(旧帧)时间",
  );
  assert.equal(copy.content.indexOf(videoTarget.videoTimeText(7500)), -1, "弹窗绝不指向代表帧(新帧)时间");
});

/* ---------------- F. 统计口径(三数分立,冻结文案) ---------------- */

test("SG-STATS:N/M/N_d/X 逐项;顶部行冻结串;M 不含已确认组;手动补件计入 N_d(§4)", () => {
  const groupStats = mustFn("groupStats");
  // 场景一:6 线索 1 组,零草稿
  const six = crossFrameObs("电池", 6);
  let stats = groupStats(six, []);
  assert.equal(stats.observationCount, 6);
  assert.equal(stats.pendingGroupCount, 1);
  assert.equal(stats.draftCount, 0);
  assert.equal(stats.checkedDraftCount, 0);
  assert.equal(stats.topLineText, "AI 线索 6 条 → 1 组待确认,已确认 0 件");

  // 场景二:全部归属同一草稿 → M=0,「已全部确认」形态
  stats = groupStats(six, [draft(six.map((o) => o.obsId), { name: "就一件", checked: true })]);
  assert.equal(stats.pendingGroupCount, 0);
  assert.equal(stats.draftCount, 1);
  assert.equal(stats.checkedDraftCount, 1);
  assert.equal(stats.topLineText, "AI 线索 6 条,已全部确认 1 件");

  // 场景三:两组(A 4 条/B 2 条);A 部分归属、B 未动;另有未勾选手动补件
  const observations = crossFrameObs("A电池", 4).concat(crossFrameObs("B胶带", 2));
  const aIds = observations.slice(0, 4).map((o) => o.obsId);
  const manual = scene.newSceneDraft({ name: "手动补的", locationText: "书房", manualHighlights: [{ start_ms: 0, end_ms: 900, box: null, frame_ms: 0 }], checked: false });
  stats = groupStats(observations, [draft(aIds.slice(0, 2), { name: "A 的一件", checked: true }), manual]);
  assert.equal(stats.observationCount, 6);
  assert.equal(stats.pendingGroupCount, 2, "部分归属组仍待确认;未动组待确认");
  assert.equal(stats.draftCount, 2, "N_d=草稿总数,未勾选手动补件也计入");
  assert.equal(stats.checkedDraftCount, 1, "X=checked 草稿数(保存按钮计数)");
  assert.equal(stats.topLineText, "AI 线索 6 条 → 2 组待确认,已确认 2 件");

  // 场景四:B 组全部归属 → M 不含已确认组,只剩 A 待确认
  const bIds = observations.slice(4).map((o) => o.obsId);
  stats = groupStats(observations, [
    draft(aIds.slice(0, 2), { name: "A 的一件", checked: true }),
    manual,
    draft(bIds, { name: "B 的一件", checked: true }),
  ]);
  assert.equal(stats.pendingGroupCount, 1, "已完全确认的组不计入 M");
  assert.equal(stats.draftCount, 3);
  assert.equal(stats.topLineText, "AI 线索 6 条 → 1 组待确认,已确认 3 件");
});
