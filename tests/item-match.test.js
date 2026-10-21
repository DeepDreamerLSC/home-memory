"use strict";
// D1 五级匹配纯函数测试(issue #94,D1-IMPLEMENTATION.md §3/§7 第 6 条):
// 归一化用例表(全半角/标点/空白)、包含与编辑距离边界、五级排序、上限 5、
// 同名物品并列出现绝不合并、location_display 的子树内/外口径。
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildItemMatchSuggestions,
  editDistance,
  normalizeForMatch,
} = require("../miniprogram/utils/item-match.js");

function node(id, name, path) {
  return { location_id: id, name, path, parent_id: "" };
}

function poolItem(id, name, nodeId, text, version) {
  return {
    item_id: id,
    name,
    location_node_id: nodeId,
    location_text: text,
    version: version === undefined ? 1 : version,
  };
}

const SUBTREE = [
  node("lc_home", "我的家", []),
  node("lc_study", "书房", ["书房"]),
  node("lc_shelf", "书柜", ["书房", "书柜"]),
  node("lc_layer", "第一层", ["书房", "书柜", "第一层"]),
];

const POOLS = {
  subtree: SUBTREE,
  subtree_items: [
    poolItem("it_screwdriver", "螺丝刀", "lc_layer", "书房 / 书柜 / 第一层", 3),
    poolItem("it_screwdriver2", "螺丝刀", "lc_layer", "书房 / 书柜 / 第一层", 5),
    poolItem("it_wrench", "扳手", "lc_shelf", "书房 / 书柜", 2),
  ],
  household_items: [
    poolItem("it_screwdriver", "螺丝刀", "lc_layer", "书房 / 书柜 / 第一层", 3),
    poolItem("it_screwdriver2", "螺丝刀", "lc_layer", "书房 / 书柜 / 第一层", 5),
    poolItem("it_wrench", "扳手", "lc_shelf", "书房 / 书柜", 2),
    poolItem("it_kitchen_screwdriver", "螺丝刀", "lc_kitchen", "厨房", 7),
    poolItem("it_lamp", "台灯", "", "书房桌上", 1),
  ],
};

test("MATCH-NORMALIZE:全半角/标点/空白/大小写归一化用例表", () => {
  assert.equal(normalizeForMatch("螺丝刀"), "螺丝刀");
  // 全半角数字 NFKC 统一
  assert.equal(normalizeForMatch("电池７号"), normalizeForMatch("电池7号"));
  assert.equal(normalizeForMatch("ＡＢ夹子"), normalizeForMatch("ab夹子"));
  // 空白全删(含全角空格)
  assert.equal(normalizeForMatch("创 可 贴"), normalizeForMatch("创可贴"));
  assert.equal(normalizeForMatch("数据线　黑色"), normalizeForMatch("数据线黑色"));
  // 常见标点全删(全角与半角)
  assert.equal(normalizeForMatch("数据线,黑色"), normalizeForMatch("数据线黑色"));
  assert.equal(normalizeForMatch("数据线、黑色"), normalizeForMatch("数据线黑色"));
  assert.equal(normalizeForMatch("充电器。"), normalizeForMatch("充电器"));
  assert.equal(normalizeForMatch("工具(箱)"), normalizeForMatch("工具箱"));
  assert.equal(normalizeForMatch("工具(箱)"), normalizeForMatch("工具箱"));
  assert.equal(normalizeForMatch("说明书【重要】"), normalizeForMatch("说明书重要"));
  assert.equal(normalizeForMatch("备注:备用"), normalizeForMatch("备注备用"));
  assert.equal(normalizeForMatch("aaa-bbb/ccc_ddd"), normalizeForMatch("aaabbbcccddd"));
  // 大小写统一
  assert.equal(normalizeForMatch("HDMI线"), normalizeForMatch("hdmi线"));
  // 空串/纯空白/纯标点 → 空
  assert.equal(normalizeForMatch(""), "");
  assert.equal(normalizeForMatch("   "), "");
  assert.equal(normalizeForMatch(",,、。"), "");
});

test("MATCH-LEV:编辑距离与容忍边界(≤4 码点容 1,更长容 2)", () => {
  assert.equal(editDistance("", ""), 0);
  assert.equal(editDistance("abc", "abc"), 0);
  assert.equal(editDistance("ab", "abc"), 1);
  // 短查询(len=3)容 1:差 1 的模糊命中,差 2 的不命中
  const short = buildItemMatchSuggestions("螺丝刀", {
    subtree: [],
    subtree_items: [
      poolItem("a1", "螺丝刁", "", ""),
      poolItem("a2", "螺丝刀组套", "", ""),
    ],
    household_items: [],
  });
  // 「螺丝刀组套」包含「螺丝刀」→ 模糊命中;两者都是 level 2
  assert.ok(short.every((s) => s.level === 2));
  assert.equal(short.length, 2);
  // 短查询差 2(替换两字)不命中
  const far = buildItemMatchSuggestions("螺丝刀", {
    subtree: [],
    subtree_items: [poolItem("f1", "钳子批", "", "")],
    household_items: [],
  });
  assert.equal(far.length, 0);
  // 长查询(len=6)容 2:差 2 命中、差 3 不命中
  const longHit = buildItemMatchSuggestions("不锈钢螺丝刀", {
    subtree: [],
    subtree_items: [poolItem("b1", "不锈铁螺丝刁", "", "")],
    household_items: [],
  });
  assert.equal(longHit.length, 1);
  const longMiss = buildItemMatchSuggestions("不锈钢螺丝刀", {
    subtree: [],
    subtree_items: [poolItem("b2", "不锈铁钳子刀", "", "")],
    household_items: [],
  });
  assert.equal(longMiss.length, 0);
});

test("MATCH-LEVELS:五级排序 1>2>3>4,排除已出现,同级名称字典序", () => {
  const out = buildItemMatchSuggestions("螺丝刀", POOLS);
  // level1:子树内两件严格同名(同名并列出现,绝不合并)
  // level2:子树内「螺丝刀组套」不在池里 → 无
  // level3:全家庭「螺丝刀」排除已出现(厨房那件 level3)
  // level4:无模糊新增
  assert.deepEqual(out.map((s) => s.item_id), [
    "it_screwdriver",
    "it_screwdriver2",
    "it_kitchen_screwdriver",
  ]);
  assert.deepEqual(out.map((s) => s.level), [1, 1, 3]);
  // 同级字典序:两件同名,顺序稳定(name 相等 → 0)
  // level 判定字段
  assert.equal(out[0].mounted_in_subtree, true);
  assert.equal(out[0].location_display, "书房 / 书柜 / 第一层");
  assert.equal(out[0].location_fallback, false);
  // 子树外挂载:display 回退 location_text,标 fallback
  assert.equal(out[2].mounted_in_subtree, false);
  assert.equal(out[2].location_display, "厨房");
  assert.equal(out[2].location_fallback, true);
});

test("MATCH-LEVEL2-CONTAINS:子树内包含/被包含优先于全家庭同名", () => {
  const out = buildItemMatchSuggestions("螺丝", {
    subtree: POOLS.subtree,
    subtree_items: [poolItem("it_set", "螺丝刀组套", "lc_shelf", "书房 / 书柜")],
    household_items: [poolItem("it_exact", "螺丝", "lc_kitchen", "厨房")],
  });
  assert.deepEqual(out.map((s) => s.level), [2, 3], "子树内模糊(包含)先于全家庭严格同名");
  assert.equal(out[0].item_id, "it_set");
});

test("MATCH-LEVEL4:全家庭模糊排在最后", () => {
  const out = buildItemMatchSuggestions("扳手", POOLS);
  // 子树内「扳手」level1;其余无模糊…… 台灯?lev(扳手,台灯) 大;螺丝刀?不近 → 只有 level1
  assert.deepEqual(out.map((s) => s.level), [1]);
  // 构造全家庭模糊:厨房「大扳手」包含「扳手」→ level4
  const out2 = buildItemMatchSuggestions("扳手", {
    subtree: POOLS.subtree,
    subtree_items: [],
    household_items: [poolItem("it_big", "大扳手", "lc_kitchen", "厨房")],
  });
  assert.deepEqual(out2.map((s) => s.level), [4]);
});

test("MATCH-MAX5:建议截断 5 条", () => {
  const many = [];
  for (let i = 0; i < 8; i++) {
    many.push(poolItem("dup" + i, "螺丝刀", "lc_layer", "书房 / 书柜 / 第一层"));
  }
  const out = buildItemMatchSuggestions("螺丝刀", {
    subtree: POOLS.subtree,
    subtree_items: many,
    household_items: [],
  });
  assert.equal(out.length, 5, "同名 8 件全部 level1,截断为 5;绝不合并成 1 条");
  assert.ok(out.every((s) => s.level === 1));
});

test("MATCH-UNMOUNTED:未挂载回退 location_text,空文本标「未归位」", () => {
  const out = buildItemMatchSuggestions("台灯", POOLS);
  assert.equal(out.length, 1);
  assert.equal(out[0].item_id, "it_lamp");
  assert.equal(out[0].mounted_in_subtree, false);
  assert.equal(out[0].location_display, "书房桌上");
  assert.equal(out[0].location_fallback, true);
  const out2 = buildItemMatchSuggestions("台灯", {
    subtree: POOLS.subtree,
    subtree_items: [poolItem("it_bare", "台灯", "", "")],
    household_items: [],
  });
  assert.equal(out2[0].location_display, "未归位");
});

test("MATCH-EMPTY:空查询/归一化为空 → 无建议(保持新建)", () => {
  assert.deepEqual(buildItemMatchSuggestions("", POOLS), []);
  assert.deepEqual(buildItemMatchSuggestions("  ,、。", POOLS), []);
});

test("MATCH-NO-AUTO:输出只是列表数据,不含任何选中/合并副作用字段", () => {
  const out = buildItemMatchSuggestions("螺丝刀", POOLS);
  for (const row of out) {
    // 建议行只有展示与匹配数据;是否关联、是否移动由页面在用户点选后决定
    assert.deepEqual(Object.keys(row).sort(), [
      "item_id",
      "level",
      "location_display",
      "location_fallback",
      "mounted_in_subtree",
      "name",
      "version",
    ]);
  }
});
