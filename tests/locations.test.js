"use strict";

/**
 * locations 离线合同测试(docs/design/location-tree.md §9,issue #18)。
 * 覆盖 16 个必测点:TS-ISO/TS-EP/TS-NC1/TS-NC2/TS-MG/TS-DL/TS-LK1/TS-LK2/TS-LK3/
 * TS-AS/TS-SCAN/TS-RN/TS-MV/TS-LST/TS-INV/TS-LOG/TS-SRC,外加 index.js 胶水层加载测试。
 * 与 itemsApi 在同一 memoryDb 上交叉驱动(单一版本链验证);LLM 全部 mock 注入,
 * 零外部依赖、零网络;绝不 require wx-server-sdk(胶水测试用 stub 替身加载)。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var crypto = require("node:crypto");
var Module = require("node:module");

var locHandler = require("../cloudfunctions/locations/lib/handler").handler;
var itemsHandler = require("../cloudfunctions/itemsApi/lib/handler").handler;
var normalizeName = require("../cloudfunctions/itemsApi/lib/normalize").normalizeName;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

var ROOT = path.join(__dirname, "..");
var HOUSEHOLD_A = "hh_11111111111111111111111111111111";
var HOUSEHOLD_B = "hh_22222222222222222222222222222222";

// ---------- 公共工具 ----------

function digest16(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

// genId 用全局计数器:真实环境 _id 全局唯一,若每个 deps 各自从 1 起,
// 同库双家庭的测试会产生相同 _id(生产不可能),断言「独立节点」会假失败
var GLOBAL_SEQ = 0;

function makeDeps(db, householdId, loggerOverride) {
  var clock = 1760000000000;
  return {
    db: db,
    householdId: householdId,
    now: function () {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    genId: function () {
      GLOBAL_SEQ += 1;
      return "n" + GLOBAL_SEQ;
    },
    digest: digest16,
    logger: loggerOverride || { log: function () {} }
  };
}

/** locations 唯一索引 (household_id, parent_id, name_norm)(items 默认索引自动保留) */
function freshDb() {
  return createMemoryDb({
    uniqueIndexes: { locations: [["household_id", "parent_id", "name_norm"]] }
  });
}

function fresh(householdId) {
  var db = freshDb();
  return { db: db, deps: makeDeps(db, householdId || HOUSEHOLD_A) };
}

async function createItem(deps, opId, name, locationText, note) {
  return await itemsHandler(
    { action: "create", operation_id: opId, name: name, location_text: locationText, note: note },
    deps
  );
}

async function ensurePath(deps, segments, createdFrom) {
  return await locHandler(
    { action: "ensurePath", path: segments, created_from: createdFrom },
    deps
  );
}

async function rawDocs(db, name) {
  var res = await db.collection(name).where({}).get();
  return res.data;
}

/** 直接注入 items 文档(模拟旧数据/竞态窗口内的写入,不走 itemsApi) */
async function seedItem(db, householdId, id, name, locationText, updatedAt, extra) {
  var doc = {
    _id: id,
    household_id: householdId,
    name: name,
    name_norm: normalizeName(name),
    location_text: locationText,
    note: "",
    version: 1,
    deleted: false,
    operation_id: "op-seed-" + id,
    created_at: updatedAt,
    updated_at: updatedAt
  };
  if (extra) {
    var keys = Object.keys(extra);
    for (var i = 0; i < keys.length; i++) {
      doc[keys[i]] = extra[keys[i]];
    }
  }
  await db.collection("items").add({ data: doc });
  return doc;
}

function userTextFromPrompt(prompt) {
  var marker = "【用户输入】\n";
  var start = prompt.indexOf(marker);
  assert.notStrictEqual(start, -1, "prompt 应包含【用户输入】标记");
  var rest = prompt.slice(start + marker.length);
  var retryIdx = rest.indexOf("\n\n【上次输出】");
  if (retryIdx !== -1) {
    rest = rest.slice(0, retryIdx);
  }
  return rest;
}

var LIST_MARKER = "【物品清单】";
var LEVELS_MARKER = "【候选树各层名字】";

/** seqMock(照抄 tests/extractDraft.test.js 形态):按调用序返回,Error 则抛出 */
function seqMock(responses) {
  var calls = [];
  return {
    calls: calls,
    callLLM: async function (prompt) {
      calls.push(prompt);
      var item = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (item instanceof Error) {
        throw item;
      }
      return item;
    }
  };
}

function parseRaw(segments, mergeSuggestions, uncertain) {
  return JSON.stringify({
    segments: segments,
    merge_suggestions: mergeSuggestions || [],
    uncertain: uncertain === true
  });
}

/**
 * 扫描 mock:按 prompt 内容路由(并行块调用顺序不定,不能按调用序)。
 * 块 prompt 解析【物品清单】逐行,按「位置文本 → segments」表生成 results;
 * 表值为 Error 的行使整块调用抛错(模拟 deepseek.js reject,而非塞进 JSON 静默变 {});
 * 近义 prompt(【候选树各层名字】)返回 synResponse(Error 则抛出)。
 */
function routingMock(segmentByText, synResponse) {
  var calls = [];
  return {
    calls: calls,
    callLLM: async function (prompt) {
      calls.push(prompt);
      if (prompt.indexOf(LEVELS_MARKER) !== -1) {
        if (synResponse instanceof Error) {
          throw synResponse;
        }
        return synResponse;
      }
      var start = prompt.indexOf(LIST_MARKER);
      if (start === -1) {
        throw new Error("MOCK_UNEXPECTED_PROMPT");
      }
      var body = prompt.slice(start + LIST_MARKER.length + 1);
      var stop = body.indexOf("\n\n【上次输出】");
      if (stop !== -1) {
        body = body.slice(0, stop);
      }
      var lines = body.split("\n");
      var results = [];
      for (var i = 0; i < lines.length; i++) {
        var m = /^(\d+): (.+)$/.exec(lines[i]);
        if (!m) {
          continue;
        }
        var text = m[2];
        assert.ok(text.trim() !== "", "清单不得出现空位置行(空位置件不送 LLM)");
        var segs = segmentByText[text];
        assert.ok(segs, "mock 未覆盖清单中的位置文本:" + text);
        if (segs instanceof Error) {
          throw segs; // 该块 LLM 调用 reject(HTTP 非 200/网络错误/超时)
        }
        results.push({ index: Number(m[1]), segments: segs, uncertain: false });
      }
      return JSON.stringify({ results: results });
    }
  };
}

/**
 * 竞态模拟 db:首次对目标件执行「版本条件挂载更新」(cond.version 存在且改 location_node_id)
 * 时,先执行 sabotage() 再放行原更新 → 原更新 0 命中(模拟「读版本后被并发修改」)。
 */
function sabotageMountDb(db, targetItemId, sabotage) {
  var fired = false;
  return {
    collection: function (name) {
      var col = db.collection(name);
      if (name !== "items") {
        return col;
      }
      return {
        where: function (cond) {
          var inner = col.where(cond);
          function wrap(q) {
            return {
              get: function (o) {
                return q.get(o);
              },
              skip: function (n) {
                return wrap(q.skip(n));
              },
              limit: function (n) {
                return wrap(q.limit(n));
              },
              update: function (options) {
                if (
                  !fired &&
                  cond._id === targetItemId &&
                  cond.version !== undefined &&
                  options &&
                  options.data &&
                  "location_node_id" in options.data
                ) {
                  fired = true;
                  return Promise.resolve()
                    .then(sabotage)
                    .then(function () {
                      return q.update(options);
                    });
                }
                return q.update(options);
              }
            };
          }
          return wrap(inner);
        },
        doc: col.doc.bind(col),
        add: col.add.bind(col)
      };
    }
  };
}

/**
 * 竞态模拟 db:在硬删目标节点的那一刻(doc(nodeId).remove() 前)执行 onBeforeRemove()
 * (模拟「计数时为 0 → 并发 linkItem 写入 → 硬删」交错)。
 */
function removeTrapDb(db, targetNodeId, onBeforeRemove) {
  var fired = false;
  return {
    collection: function (name) {
      var col = db.collection(name);
      if (name !== "locations") {
        return col;
      }
      return {
        doc: function (id) {
          var d = col.doc(id);
          return {
            get: function (o) {
              return d.get(o);
            },
            update: function (o) {
              return d.update(o);
            },
            remove: function () {
              if (!fired && id === targetNodeId) {
                fired = true;
                return Promise.resolve()
                  .then(onBeforeRemove)
                  .then(function () {
                    return d.remove();
                  });
              }
              return d.remove();
            }
          };
        },
        where: function (cond) {
          return col.where(cond);
        },
        add: function (o) {
          return col.add(o);
        }
      };
    }
  };
}

// ---------- TS-SRC:副本同源 ----------

test("TS-SRC:normalize/deepseek 副本剥离声明头后与源文件逐字节一致,声明头含同源与双向同步标记", function () {
  var marker = "---- 副本正文(与源文件逐字节一致)----";
  var cases = [
    ["cloudfunctions/locations/lib/normalize.js", "cloudfunctions/itemsApi/lib/normalize.js"],
    ["cloudfunctions/locations/lib/deepseek.js", "cloudfunctions/extractDraft/lib/deepseek.js"]
  ];
  for (var i = 0; i < cases.length; i++) {
    var copy = fs.readFileSync(path.join(ROOT, cases[i][0]), "utf8");
    var source = fs.readFileSync(path.join(ROOT, cases[i][1]), "utf8");
    var idx = copy.indexOf(marker);
    assert.notStrictEqual(idx, -1, cases[i][0] + " 应含同源声明分界标记");
    var header = copy.slice(0, idx);
    assert.ok(header.indexOf("逐字节") !== -1, cases[i][0] + " 声明头应标明逐字节同源");
    assert.ok(header.indexOf("双向同步") !== -1, cases[i][0] + " 声明头应含双向同步要求");
    var commentEnd = copy.indexOf("*/", idx);
    assert.notStrictEqual(commentEnd, -1, cases[i][0] + " 声明头应闭合");
    var body = copy.slice(copy.indexOf("\n", commentEnd) + 1);
    assert.strictEqual(body, source, cases[i][0] + " 副本正文应与源文件逐字节一致(防漂移)");
  }
});

// ---------- TS-LST:list ----------

test("TS-LST:list 根层惰性建 home 根且幂等;item_count 含后代;unmounted/dangling 统一口径;排序稳定", async function () {
  var t = fresh();
  // 空库首次 list:惰性建 home 根
  var first = await locHandler({ action: "list" }, t.deps);
  assert.equal(first.ok, true);
  assert.equal(first.node.name, "我的家");
  assert.equal(first.node.type, "home");
  assert.deepEqual(first.node.path, []);
  assert.equal(first.node.created_from, "bootstrap");
  assert.equal(first.node.item_count, 0);
  assert.equal(first.node.child_count, 0);
  assert.deepEqual(first.children, []);
  assert.deepEqual(first.items, []);
  assert.equal(first.unmounted_count, 0);
  assert.equal(first.dangling_mounts, 0);
  // 幂等:再 list 不再建根
  await locHandler({ action: "list" }, t.deps);
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(nodes.length, 1, "home 根只建一次");

  // 树:书房/桌子/右边第二个抽屉 + 客厅 + 阳台;物品:1 件挂抽屉、1 件未挂、1 件悬挂
  var tree = await ensurePath(t.deps, ["书房", "桌子", "右边第二个抽屉"]);
  await ensurePath(t.deps, ["客厅"]);
  await ensurePath(t.deps, ["阳台"]);
  assert.equal(tree.ok, true);
  var drawerId = tree.nodes[2].location_id;
  var studyId = tree.nodes[0].location_id;

  var mounted = await createItem(t.deps, "op-lst-1", "充电宝", "书房桌子右边第二个抽屉");
  await createItem(t.deps, "op-lst-2", "护照", "客厅电视柜");
  var linked = await locHandler(
    { action: "linkItem", item_id: mounted.item.item_id, node_id: drawerId, expected_version: 1, update_id: "u-lst-1" },
    t.deps
  );
  assert.equal(linked.ok, true, JSON.stringify(linked));
  await t.db.collection("items").doc(mounted.item.item_id).update({
    data: { location_node_id: "lc_ghost" } // 注入悬挂挂载(绕过 handler,模拟并发残余)
  });
  var rawItemsAfter = await rawDocs(t.db, "items");
  var danglingItem = rawItemsAfter.find(function (d) {
    return d._id === mounted.item.item_id;
  });
  assert.equal(danglingItem.location_node_id, "lc_ghost");

  var rootList = await locHandler({ action: "list" }, t.deps);
  assert.equal(rootList.node.item_count, 0, "悬挂件不计入任何节点的 item_count");
  assert.equal(rootList.unmounted_count, 2, "未挂载护照 + 悬挂充电宝都算未归位");
  assert.equal(rootList.dangling_mounts, 1, "悬挂件如实单独计数");
  // 全部 0 件时 children 按 name 升序:书(U+4E66)< 客(U+5BA2)< 阳(U+9633)
  assert.deepEqual(
    rootList.children.map(function (c) {
      return c.name;
    }),
    ["书房", "客厅", "阳台"]
  );
  assert.equal(rootList.children[0].item_count, 0, "悬挂件不计入书房子树");
  assert.equal(rootList.children[0].child_count, 1);

  // 悬挂摘除后归属恢复:重新挂到抽屉,计数穿透到书房与根
  await locHandler(
    { action: "linkItem", item_id: mounted.item.item_id, node_id: drawerId, expected_version: 2, update_id: "u-lst-2" },
    t.deps
  );
  var studyList = await locHandler({ action: "list", parent_id: studyId }, t.deps);
  assert.equal(studyList.ok, true);
  assert.equal(studyList.node.name, "书房");
  assert.equal(studyList.node.item_count, 1, "子树计数含后代(充电宝在抽屉)");
  assert.equal(studyList.children.length, 1);
  assert.equal(studyList.children[0].name, "桌子");
  assert.equal(studyList.children[0].item_count, 1);
  assert.deepEqual(studyList.items, [], "书房直接挂载为空(充电宝在抽屉)");
  assert.equal(studyList.unmounted_count, 1);
  assert.equal(studyList.dangling_mounts, 0);

  // item_count 降序判别:阳台挂 2 件 > 书房 0 = 客厅 0
  var balcony = await ensurePath(t.deps, ["阳台", "鞋柜", "第一层"]);
  await locHandler(
    { action: "linkItem", item_id: mounted.item.item_id, node_id: balcony.nodes[2].location_id, expected_version: 3, update_id: "u-lst-3" },
    t.deps
  );
  var passportItem = (await rawDocs(t.db, "items")).find(function (d) {
    return d.name === "护照";
  });
  await locHandler(
    { action: "linkItem", item_id: passportItem._id, node_id: balcony.nodes[2].location_id, expected_version: 1, update_id: "u-lst-4" },
    t.deps
  );
  var sorted = await locHandler({ action: "list" }, t.deps);
  assert.deepEqual(
    sorted.children.map(function (c) {
      return c.name;
    }),
    ["阳台", "书房", "客厅"],
    "children 按 item_count 降序(阳台2 > 书房0 = 客厅0,同数 name 升序)"
  );
  assert.equal(sorted.children[0].item_count, 2);
  assert.equal(sorted.node.item_count, 2, "根 item_count 为全家挂载总数");
  assert.equal(sorted.unmounted_count, 0);

  // 跨家庭 parent → NOT_FOUND
  var bDeps = makeDeps(t.db, HOUSEHOLD_B);
  var foreign = await locHandler({ action: "list", parent_id: studyId }, bDeps);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, "NOT_FOUND");
});

// ---------- TS-EP:ensurePath 幂等 ----------

test("TS-EP:同 path 重复调用返回同 id、created 全 false;部分存在只补缺失段;并发 E11000 回查复用不双建", async function () {
  var t = fresh();
  var first = await ensurePath(t.deps, ["书房", "桌子", "右边第二个抽屉"], "scan");
  assert.equal(first.ok, true);
  assert.equal(first.nodes.length, 3);
  assert.deepEqual(first.created, [true, true, true]);
  assert.equal(first.nodes[0].type, "room");
  assert.equal(first.nodes[1].type, "furniture");
  assert.equal(first.nodes[2].type, "container");
  assert.deepEqual(first.nodes[0].path, ["书房"]);
  assert.deepEqual(first.nodes[1].path, ["书房", "桌子"]);
  assert.deepEqual(first.nodes[2].path, ["书房", "桌子", "右边第二个抽屉"]);
  assert.equal(first.nodes[0].created_from, "scan");
  assert.ok(first.nodes[0].location_id.indexOf("lc_") === 0, "location_id 应以 lc_ 开头");

  // 第二次同 path:全部复用
  var second = await ensurePath(t.deps, ["书房", "桌子", "右边第二个抽屉"], "scan");
  assert.equal(second.ok, true);
  assert.deepEqual(second.created, [false, false, false]);
  for (var i = 0; i < 3; i++) {
    assert.equal(second.nodes[i].location_id, first.nodes[i].location_id, "第 " + i + " 段应复用同 id");
  }
  assert.equal(second.nodes[0].created_from, "scan", "复用节点保留原 created_from");

  // 部分存在:书房/桌子 已有,只补「书架」
  var partial = await ensurePath(t.deps, ["书房", "书架"], "manual");
  assert.deepEqual(partial.created, [false, true]);

  // created_from 缺省 manual;非法值拒绝
  var def = await locHandler({ action: "ensurePath", path: ["玄关"] }, t.deps);
  assert.equal(def.nodes[0].created_from, "manual");
  var badFrom = await locHandler({ action: "ensurePath", path: ["玄关"], created_from: "hack" }, t.deps);
  assert.equal(badFrom.error, "INVALID_INPUT");

  // 参数校验:7 段 / 空段名 / 非数组
  var seven = [];
  for (var k = 0; k < 7; k++) {
    seven.push("第" + (k + 1) + "层");
  }
  assert.equal((await locHandler({ action: "ensurePath", path: seven }, t.deps)).error, "INVALID_INPUT");
  assert.equal((await locHandler({ action: "ensurePath", path: ["书房", "  "] }, t.deps)).error, "INVALID_INPUT");
  assert.equal((await locHandler({ action: "ensurePath", path: "书房" }, t.deps)).error, "INVALID_INPUT");

  // 真并发同 path:两个 handler 交错,唯一索引拒绝第二笔,回查复用,绝不双建
  var raced = await Promise.all([
    locHandler({ action: "ensurePath", path: ["主卧", "衣柜"] }, t.deps),
    locHandler({ action: "ensurePath", path: ["主卧", "衣柜"] }, t.deps)
  ]);
  assert.equal(raced[0].ok, true);
  assert.equal(raced[1].ok, true);
  assert.equal(raced[0].nodes[0].location_id, raced[1].nodes[0].location_id, "并发下主卧只建一次");
  assert.equal(raced[0].nodes[1].location_id, raced[1].nodes[1].location_id, "并发下衣柜只建一次");
  var nodes = await rawDocs(t.db, "locations");
  var dupes = nodes.filter(function (n) {
    return n.household_id === HOUSEHOLD_A && n.name === "主卧";
  });
  assert.equal(dupes.length, 1, "库中主卧文档唯一(E11000 回查复用)");

  // 跨家庭同名互不影响
  var bDeps = makeDeps(t.db, HOUSEHOLD_B);
  var bPath = await ensurePath(bDeps, ["书房"], "manual");
  assert.equal(bPath.ok, true);
  assert.notEqual(bPath.nodes[0].location_id, first.nodes[0].location_id, "B 的书房是独立节点");
  var aList = await locHandler({ action: "list" }, t.deps);
  assert.equal(aList.children.length, 3, "A 的根层不受 B 影响(书房/主卧/客厅…)");
});

// ---------- TS-NC1:parseLocation 防火墙 ----------

test("TS-NC1:parseLocation 零写库;低置信/编造段/错序段强制 need_confirm;merge_suggestions 校验与自动补全", async function () {
  var t = fresh();
  var tree = await ensurePath(t.deps, ["书房", "桌子"]);
  var studyId = tree.nodes[0].location_id;

  var before = {
    locations: await rawDocs(t.db, "locations"),
    items: await rawDocs(t.db, "items")
  };

  // 高置信有序:仅低置信末段(0.6 < 0.8)→ need_confirm=true,零写库
  var lowConfRaw = parseRaw([
    { name: "书房", type: "room", confidence: 0.95 },
    { name: "桌子", type: "furniture", confidence: 0.9 },
    { name: "右边第二个抽屉", type: "container", confidence: 0.6 }
  ]);
  var mock1 = seqMock([lowConfRaw]);
  var res1 = await locHandler(
    { action: "parseLocation", text: "书房桌子右边第二个抽屉" },
    Object.assign({}, t.deps, { callLLM: mock1.callLLM })
  );
  assert.equal(res1.ok, true);
  assert.equal(res1.parse.need_confirm, true, "任一段 confidence<0.8 必须 need_confirm");
  assert.equal(res1.parse.order_violation, false);
  assert.equal(res1.parse.segments.length, 3);
  assert.equal(res1.parse.segments[0].type, "room", "type 按深度映射");
  assert.deepEqual(
    await rawDocs(t.db, "locations"),
    before.locations,
    "parseLocation 绝不写 locations"
  );
  assert.deepEqual(await rawDocs(t.db, "items"), before.items, "parseLocation 绝不写 items");

  // 编造段:每段高置信但「银河系角落」不在原文 → 未锚定强制 need_confirm
  var hallucRaw = parseRaw([
    { name: "书房", type: "room", confidence: 0.99 },
    { name: "银河系角落", type: "furniture", confidence: 0.99 }
  ]);
  var mock2 = seqMock([hallucRaw]);
  var res2 = await locHandler(
    { action: "parseLocation", text: "书房桌子右边第二个抽屉" },
    Object.assign({}, t.deps, { callLLM: mock2.callLLM })
  );
  assert.equal(res2.parse.need_confirm, true, "编造段(未锚定且无合并覆盖)必须 need_confirm");
  assert.equal(res2.parse.order_violation, false, "编造不算错序");

  // 错序段:每段都是子串但顺序违规 → order_violation=true 且 need_confirm=true
  var wrongOrderRaw = parseRaw([
    { name: "桌子", type: "room", confidence: 0.99 },
    { name: "书房", type: "furniture", confidence: 0.99 }
  ]);
  var mock3 = seqMock([wrongOrderRaw]);
  var res3 = await locHandler(
    { action: "parseLocation", text: "书房桌子右边第二个抽屉" },
    Object.assign({}, t.deps, { callLLM: mock3.callLLM })
  );
  assert.equal(res3.parse.order_violation, true, "顺序违规必须标 order_violation");
  assert.equal(res3.parse.need_confirm, true, "高置信错序也不许默认勾选入库");
  assert.equal(mock3.calls.length, 1);

  // merge_suggestions:存在的名字映射出 existing_location_id,不存在的名字被丢弃;
  // 下钻命中的同名段由服务端自动补全
  var suggestRaw = parseRaw(
    [{ name: "书房", type: "room", confidence: 0.95 }],
    [
      { segment_index: 0, name: "书房", reason: "同名" },
      { segment_index: 0, name: "不存在的节点", reason: "近义" }
    ]
  );
  var mock4 = seqMock([suggestRaw]);
  var res4 = await locHandler(
    { action: "parseLocation", text: "书房里的蓝色盒子" },
    Object.assign({}, t.deps, { callLLM: mock4.callLLM })
  );
  assert.equal(res4.ok, true);
  assert.equal(res4.parse.merge_suggestions.length, 1, "不存在节点的建议被丢弃,同名建议保留一条");
  assert.equal(res4.parse.merge_suggestions[0].existing_location_id, studyId);
  assert.equal(res4.parse.merge_suggestions[0].existing_name, "书房");
  assert.equal(res4.parse.merge_suggestions[0].reason, "同名");

  // 坏 JSON 重试一次仍失败 → AI_UNAVAILABLE(manual_fallback),零写入
  var mock5 = seqMock(["这不是 JSON", "还是不行 {"]);
  var res5 = await locHandler(
    { action: "parseLocation", text: "书房桌子右边第二个抽屉" },
    Object.assign({}, t.deps, { callLLM: mock5.callLLM })
  );
  assert.equal(res5.ok, false);
  assert.equal(res5.error, "AI_UNAVAILABLE");
  assert.equal(res5.manual_fallback, true);
  assert.equal(mock5.calls.length, 2, "只重试一次");
  assert.deepEqual(await rawDocs(t.db, "locations"), before.locations);
  assert.deepEqual(await rawDocs(t.db, "items"), before.items);

  // text 校验:超 200 字 / 空白 / 非字符串 → INVALID_INPUT 且不调 LLM
  var mock6 = seqMock(["不应被调用"]);
  var badText = await locHandler(
    { action: "parseLocation", text: "位".repeat(201) },
    Object.assign({}, t.deps, { callLLM: mock6.callLLM })
  );
  assert.equal(badText.error, "INVALID_INPUT");
  assert.equal(mock6.calls.length, 0);

  // 坏 JSON 重试成功:重试 prompt 回传上次输出与解析错误
  var goodRaw = parseRaw([{ name: "书房", type: "room", confidence: 0.95 }]);
  var mock7 = seqMock(["哎呀,不明白", goodRaw]);
  var res7 = await locHandler(
    { action: "parseLocation", text: "书房里的盒子" },
    Object.assign({}, t.deps, { callLLM: mock7.callLLM })
  );
  assert.equal(res7.ok, true);
  assert.equal(mock7.calls.length, 2);
  assert.ok(mock7.calls[1].indexOf("【上次输出】") !== -1, "重试 prompt 应回传上次输出");
  assert.ok(mock7.calls[1].indexOf("【解析错误】") !== -1, "重试 prompt 应带解析错误");
});

// ---------- TS-NC2:scanHousehold 零写库与增量池 ----------

test("TS-NC2:scanHousehold 成功后两集合零变化;计数正确;悬挂件回流池;空位置件进池不送 LLM 归入 skipped", async function () {
  var t = fresh();
  var tree = await ensurePath(t.deps, ["书房", "桌子"]);
  var deskId = tree.nodes[1].location_id;

  // 28 件 create(旧)+ 1 件 extra + 注入空位置件 + 注入悬挂件 = 未挂载 31;另 1 件已挂载不进池
  var segmentByText = {};
  for (var i = 1; i <= 28; i++) {
    var text = "书房桌子第" + String(i).padStart(2, "0") + "格";
    await createItem(t.deps, "op-f" + i, "杂物" + String(i).padStart(2, "0"), text);
    segmentByText[text] = [
      { name: "书房", type: "room", confidence: 0.9 },
      { name: "桌子", type: "furniture", confidence: 0.85 },
      { name: "第" + String(i).padStart(2, "0") + "格", type: "container", confidence: 0.8 }
    ];
  }
  await createItem(t.deps, "op-extra", "备用钥匙", "储物间顶层");
  segmentByText["储物间顶层"] = [
    { name: "储物间", type: "room", confidence: 0.9 },
    { name: "顶层", type: "furniture", confidence: 0.85 }
  ];
  var late = "2999-01-01T00:00:00.000Z";
  await seedItem(t.db, HOUSEHOLD_A, "it_empty", "护照", "", late);
  await seedItem(t.db, HOUSEHOLD_A, "it_dangle", "充电宝", "客厅电视柜第一格", late, {
    location_node_id: "lc_ghost"
  });
  segmentByText["客厅电视柜第一格"] = [
    { name: "客厅", type: "room", confidence: 0.9 },
    { name: "电视柜", type: "furniture", confidence: 0.85 },
    { name: "第一格", type: "container", confidence: 0.8 }
  ];
  var mountedItem = await createItem(t.deps, "op-mounted", "户口本", "书房桌子第一格");
  await locHandler(
    { action: "linkItem", item_id: mountedItem.item.item_id, node_id: deskId, expected_version: 1, update_id: "u-nc2" },
    t.deps
  );

  var before = {
    locations: await rawDocs(t.db, "locations"),
    items: await rawDocs(t.db, "items")
  };

  var synRaw = JSON.stringify({ groups: [{ level: 0, names: ["书房", "储物间"] }] });
  var mock = routingMock(segmentByText, synRaw);
  var res = await locHandler({ action: "scanHousehold" }, Object.assign({}, t.deps, { callLLM: mock.callLLM }));
  assert.equal(res.ok, true, JSON.stringify(res));
  var scan = res.scan;
  assert.equal(scan.scanned, 30, "本次进池 30 件");
  assert.equal(scan.unmounted_total, 31, "未归位共 31 件");
  assert.equal(scan.truncated, true, "超上限如实标记 truncated");
  assert.equal(scan.mounts.length, 29, "30 件中 1 件空位置,其余进 mounts");
  var dangleMount = scan.mounts.find(function (m) {
    return m.item_id === "it_dangle";
  });
  assert.ok(dangleMount, "悬挂挂载件回流扫描池(自愈通道)");
  assert.deepEqual(dangleMount.path, ["客厅", "电视柜", "第一格"]);
  assert.equal(scan.skipped.length, 1, "空位置件单独归类");
  assert.equal(scan.skipped[0].item_id, "it_empty");
  assert.equal(scan.skipped[0].reason, "位置为空");
  assert.equal(
    scan.mounts.some(function (m) {
      return m.item_id === mountedItem.item.item_id;
    }),
    false,
    "已挂载件不进池(增量)"
  );
  assert.equal(
    mock.calls.filter(function (p) {
      return p.indexOf(LIST_MARKER) !== -1;
    }).length,
    3,
    "30 件非空位置件分 3 块并行"
  );
  assert.deepEqual(await rawDocs(t.db, "locations"), before.locations, "scanHousehold 绝不写 locations");
  assert.deepEqual(await rawDocs(t.db, "items"), before.items, "scanHousehold 绝不写 items");

  // 任一块 LLM 调用 reject(真抛错,非坏 JSON)→ 整体 AI_UNAVAILABLE 且零写入;
  // 近义响应给合法 {groups:[]}:证明 AI_UNAVAILABLE 确实来自块失败,而非近义校验拒绝
  var t2 = fresh();
  var deps2 = makeDeps(t2.db, HOUSEHOLD_A);
  await createItem(deps2, "op-boom-1", "甲物", "厨房第一个抽屉");
  await createItem(deps2, "op-boom-2", "乙物", "阳台收纳箱");
  var boomSegs = {
    厨房第一个抽屉: [
      { name: "厨房", type: "room", confidence: 0.9 },
      { name: "第一个抽屉", type: "furniture", confidence: 0.85 }
    ]
  };
  boomSegs["阳台收纳箱"] = new Error("HTTP_500");
  var boomMock = routingMock(boomSegs, JSON.stringify({ groups: [] }));
  var before2 = {
    locations: await rawDocs(t2.db, "locations"),
    items: await rawDocs(t2.db, "items")
  };
  var res2 = await locHandler({ action: "scanHousehold" }, Object.assign({}, deps2, { callLLM: boomMock.callLLM }));
  assert.equal(res2.ok, false);
  assert.equal(res2.error, "AI_UNAVAILABLE");
  assert.equal(res2.manual_fallback, true);
  assert.deepEqual(await rawDocs(t2.db, "locations"), before2.locations);
  assert.deepEqual(await rawDocs(t2.db, "items"), before2.items);

  // 近义调用失败 → 整体 AI_UNAVAILABLE(不做无提示半成品)
  var t3 = fresh();
  var deps3 = makeDeps(t3.db, HOUSEHOLD_A);
  await createItem(deps3, "op-syn-1", "甲物", "厨房第一个抽屉");
  var synFail = routingMock(
    {
      厨房第一个抽屉: [
        { name: "厨房", type: "room", confidence: 0.9 },
        { name: "第一个抽屉", type: "furniture", confidence: 0.85 }
      ]
    },
    new Error("TIMEOUT")
  );
  var res3 = await locHandler(
    { action: "scanHousehold" },
    Object.assign({}, deps3, { callLLM: synFail.callLLM })
  );
  assert.equal(res3.ok, false);
  assert.equal(res3.error, "AI_UNAVAILABLE");
});

// ---------- TS-SCAN:扫描编排 ----------

test("TS-SCAN:3 块并行归并正确;candidate_tree 同层去重;块间近义经第 4 次调用归组;非法近义组丢弃;块间原文隔离", async function () {
  var t = fresh();
  await ensurePath(t.deps, ["书房"]);
  var items = [
    await createItem(t.deps, "op-s1", "充电宝", "书房桌子右边第二个抽屉"),
    await createItem(t.deps, "op-s2", "U盘", "书房桌子左边抽屉"),
    await createItem(t.deps, "op-s3", "枕头", "主卧衣柜第一格"),
    await createItem(t.deps, "op-s4", "被子", "主人房床头柜")
  ];
  var segmentByText = {
    书房桌子右边第二个抽屉: [
      { name: "书房", type: "room", confidence: 0.95 },
      { name: "桌子", type: "furniture", confidence: 0.9 },
      { name: "右边第二个抽屉", type: "container", confidence: 0.85 }
    ],
    书房桌子左边抽屉: [
      { name: "书房", type: "room", confidence: 0.9 },
      { name: "桌子", type: "furniture", confidence: 0.85 },
      { name: "左边抽屉", type: "container", confidence: 0.9 }
    ],
    主卧衣柜第一格: [
      { name: "主卧", type: "room", confidence: 0.9 },
      { name: "衣柜", type: "furniture", confidence: 0.85 },
      { name: "第一格", type: "container", confidence: 0.8 }
    ],
    主人房床头柜: [
      { name: "主人房", type: "room", confidence: 0.85 },
      { name: "床头柜", type: "furniture", confidence: 0.9 }
    ]
  };
  // 近义输出:一组合法(主卧/主人房);一组含不在输入列表的名字(过滤后 <2 丢组);一组 level 越界
  var synRaw = JSON.stringify({
    groups: [
      { level: 0, names: ["主卧", "主人房"] },
      { level: 0, names: ["书房", "不存在的房间"] },
      { level: 5, names: ["书房", "主卧"] }
    ]
  });
  var mock = routingMock(segmentByText, synRaw);
  var res = await locHandler({ action: "scanHousehold" }, Object.assign({}, t.deps, { callLLM: mock.callLLM }));
  assert.equal(res.ok, true);
  var scan = res.scan;
  assert.equal(scan.scanned, 4);
  assert.equal(scan.unmounted_total, 4);
  assert.equal(scan.truncated, false);
  assert.equal(mock.calls.length, 4, "3 个块调用 + 1 次近义比对");

  // mounts:逐件 path 与整件最低置信
  var byId = {};
  scan.mounts.forEach(function (m) {
    byId[m.item_id] = m;
  });
  assert.equal(scan.mounts.length, 4);
  assert.deepEqual(byId[items[0].item.item_id].path, ["书房", "桌子", "右边第二个抽屉"]);
  assert.equal(byId[items[0].item.item_id].confidence, 0.85, "整件置信度取最低段");
  assert.equal(byId[items[0].item.item_id].need_confirm, false, "全段高置信+有序锚定 → 默认可信(仍需用户确认才入库)");
  assert.deepEqual(byId[items[3].item.item_id].path, ["主人房", "床头柜"]);

  // candidate_tree:同层 name_norm 去重(两件共享 书房/桌子),置信度取段最大
  var study = scan.candidate_tree.find(function (n) {
    return n.name === "书房";
  });
  assert.ok(study, "候选树应有书房");
  assert.equal(study.confidence, 0.95);
  assert.deepEqual(
    study.children.map(function (c) {
      return c.name;
    }),
    ["桌子"],
    "第二层只有桌子(同层去重)"
  );
  var desk = study.children[0];
  var deskChildren = desk.children.map(function (c) {
    return c.name;
  }).sort();
  assert.deepEqual(deskChildren, ["右边第二个抽屉", "左边抽屉"], "两件的容器段都归到桌子下(右 U+53F3 < 左 U+5DE6)");
  var studyCount = scan.candidate_tree.filter(function (n) {
    return n.name === "书房";
  }).length;
  assert.equal(studyCount, 1, "候选树同层去重");
  // merge_hints:候选「书房」与既有树同名 → 内嵌提示
  assert.equal(study.merge_hints.length, 1);
  assert.equal(study.merge_hints[0].reason, "同名");
  assert.equal(study.merge_hints[0].existing_name, "书房");
  var pillow = scan.candidate_tree.find(function (n) {
    return n.name === "主卧";
  });
  assert.ok(pillow);
  assert.equal(pillow.merge_hints, undefined, "无同名既有节点不带 merge_hints");

  // synonym_groups:仅保留合法组
  assert.equal(scan.synonym_groups.length, 1);
  assert.equal(scan.synonym_groups[0].level, 0);
  assert.deepEqual(scan.synonym_groups[0].names, ["主卧", "主人房"]);
  assert.equal(scan.synonym_groups[0].reason, "近义");

  // 块间隔离:每个位置文本只出现在一个块 prompt 里;块 prompt 不含其他块的原文
  var chunkPrompts = mock.calls.filter(function (p) {
    return p.indexOf(LIST_MARKER) !== -1;
  });
  assert.equal(chunkPrompts.length, 3);
  var texts = ["书房桌子右边第二个抽屉", "书房桌子左边抽屉", "主卧衣柜第一格", "主人房床头柜"];
  for (var i = 0; i < texts.length; i++) {
    var hit = chunkPrompts.filter(function (p) {
      return p.indexOf(texts[i]) !== -1;
    });
    assert.equal(hit.length, 1, "每个位置文本只进入一个块 prompt");
  }
  // 既有空间树上下文进入每个块 prompt(模型可见既有树)
  for (var c = 0; c < chunkPrompts.length; c++) {
    assert.ok(chunkPrompts[c].indexOf("【既有空间树】") !== -1, "块 prompt 应含既有树上下文");
    assert.ok(chunkPrompts[c].indexOf("书房") !== -1, "既有树含书房");
  }
});

// ---------- TS-AS:applyScan 收敛幂等 ----------

test("TS-AS:applyScan 首调建树挂载;mount 深于 branch 正路径;重放 already 不回拨;conflict/not_found/非法参数/派生标识/跨家庭", async function () {
  var t = fresh();
  var item1 = await createItem(t.deps, "op-as-1", "充电宝", "书房桌子右边第二个抽屉");
  var item2 = await createItem(t.deps, "op-as-2", "遥控器", "客厅电视柜");
  var item3 = await createItem(t.deps, "op-as-3", "户口本", "书房抽屉");
  // item3 预置版本推进(扫描后、提交前被并发修改)
  var bumped = await itemsHandler(
    { action: "update", item_id: item3.item.item_id, expected_version: 1, update_id: "bump-1", note: "刚改过" },
    t.deps
  );
  assert.equal(bumped.ok, true);

  var opId = "op-scan-uuid-1";
  var evt = {
    action: "applyScan",
    operation_id: opId,
    branches: [{ path: ["书房", "桌子"] }],
    mounts: [
      { item_id: item1.item.item_id, expected_version: 1, path: ["书房", "桌子", "右边第二个抽屉"] },
      { item_id: item2.item.item_id, expected_version: 1, path: ["客厅", "电视柜"] },
      { item_id: item3.item.item_id, expected_version: 1, path: ["书房", "抽屉"] },
      { item_id: "it_ghost", expected_version: 1, path: ["阳台", "收纳箱"] }
    ]
  };
  var first = await locHandler(evt, t.deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.result.branches[0].created, [true, true]);
  assert.equal(first.result.branches[0].location_ids.length, 2);
  assert.deepEqual(first.result.branches[0].path, ["书房", "桌子"]);
  var statusById = {};
  first.result.mounts.forEach(function (m) {
    statusById[m.item_id] = m;
  });
  assert.equal(statusById[item1.item.item_id].status, "mounted");
  assert.equal(statusById[item1.item.item_id].version, 2);
  assert.equal(statusById[item2.item.item_id].status, "mounted");
  assert.equal(statusById[item3.item.item_id].status, "conflict", "预置版本推进 → conflict");
  assert.equal(statusById[item3.item.item_id].current_version, 2);
  assert.equal(statusById["it_ghost"].status, "not_found");

  // mount 深于 branch:末段节点被建到容器层,item1 挂到末段
  var nodes = await rawDocs(t.db, "locations");
  var drawer = nodes.find(function (n) {
    return n.name === "右边第二个抽屉" && n.household_id === HOUSEHOLD_A;
  });
  assert.ok(drawer, "mount 完整 path 建到末段");
  assert.equal(drawer.type, "container");
  assert.deepEqual(drawer.path, ["书房", "桌子", "右边第二个抽屉"]);
  var rawItems = await rawDocs(t.db, "items");
  var raw1 = rawItems.find(function (d) {
    return d._id === item1.item.item_id;
  });
  assert.equal(raw1.location_node_id, drawer._id);
  assert.equal(raw1.version, 2);
  // 派生标识:恒 ≤64 且确定性
  assert.equal(raw1.last_update_id, "scan:" + digest16(opId + ":" + item1.item.item_id));
  assert.ok(raw1.last_update_id.length <= 64);
  var raw3 = rawItems.find(function (d) {
    return d._id === item3.item.item_id;
  });
  assert.equal(raw3.location_node_id, undefined, "conflict 件挂载不变");
  assert.equal(raw3.version, 2, "conflict 件版本不回拨");

  // 同 operation_id 重放:已完成件 already、conflict 件按当前状态收敛(仍 conflict,因无人再改)
  var replay = await locHandler(evt, t.deps);
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.result.branches[0].created, [false, false], "重放时路径全部复用");
  assert.equal(replay.result.branches[0].location_ids[0], first.result.branches[0].location_ids[0]);
  var replayById = {};
  replay.result.mounts.forEach(function (m) {
    replayById[m.item_id] = m;
  });
  assert.equal(replayById[item1.item.item_id].status, "already");
  assert.equal(replayById[item1.item.item_id].version, 2, "already 件版本不回拨");
  var rawAfterReplay = await rawDocs(t.db, "items");
  var raw1After = rawAfterReplay.find(function (d) {
    return d._id === item1.item.item_id;
  });
  assert.equal(raw1After.version, 2, "重放不重复 +1");
  assert.equal(raw1After.last_update_id, raw1.last_update_id, "派生标识重放相等");
  assert.equal(replayById[item3.item.item_id].status, "conflict");
  assert.equal(replayById["it_ghost"].status, "not_found");

  // conflict 件随后重挂成功:同 opId 重放收敛到 mounted(收敛式幂等)
  var fix = await itemsHandler(
    { action: "update", item_id: item3.item.item_id, expected_version: 2, update_id: "bump-2", note: "再改" },
    t.deps
  );
  assert.equal(fix.ok, true);
  var replay2 = await locHandler(evt, t.deps);
  var replay2ById = {};
  replay2.result.mounts.forEach(function (m) {
    replay2ById[m.item_id] = m;
  });
  assert.equal(replay2ById[item3.item.item_id].status, "conflict", "版本又推进,仍按当前版本如实 conflict");

  // 参数结构非法:path 7 段 / 空段名 / 超量 / 全空 → INVALID_INPUT 且零写入
  var before = await rawDocs(t.db, "locations");
  var beforeItems = await rawDocs(t.db, "items");
  var seven = [];
  for (var k = 0; k < 7; k++) {
    seven.push("第" + (k + 1) + "层");
  }
  var badEvents = [
    { action: "applyScan", operation_id: "op-bad", branches: [{ path: seven }], mounts: [{ item_id: "it_1", expected_version: 1, path: ["客厅"] }] },
    { action: "applyScan", operation_id: "op-bad", branches: [], mounts: [{ item_id: "it_1", expected_version: 1, path: ["客厅", "  "] }] },
    {
      action: "applyScan",
      operation_id: "op-bad",
      branches: [],
      mounts: Array.from({ length: 31 }, function () {
        return { item_id: "it_1", expected_version: 1, path: ["客厅"] };
      })
    },
    {
      action: "applyScan",
      operation_id: "op-bad",
      branches: Array.from({ length: 31 }, function () {
        return { path: ["房间" ] };
      }),
      mounts: []
    },
    { action: "applyScan", operation_id: "op-bad", branches: [], mounts: [] },
    { action: "applyScan", operation_id: "", branches: [], mounts: [{ item_id: "it_1", expected_version: 1, path: ["客厅"] }] }
  ];
  for (var b = 0; b < badEvents.length; b++) {
    var bad = await locHandler(badEvents[b], t.deps);
    assert.equal(bad.ok, false, "非法参数 #" + b);
    assert.equal(bad.error, "INVALID_INPUT", "非法参数 #" + b);
  }
  assert.deepEqual(await rawDocs(t.db, "locations"), before, "参数校验失败零写入");
  assert.deepEqual(await rawDocs(t.db, "items"), beforeItems, "参数校验失败零写入");

  // 跨家庭:B 用 A 的 item 提交 → 逐件 not_found;B 只建自己的树
  var bDeps = makeDeps(t.db, HOUSEHOLD_B);
  var cross = await locHandler(
    {
      action: "applyScan",
      operation_id: "op-cross",
      branches: [{ path: ["厨房"] }],
      mounts: [{ item_id: item1.item.item_id, expected_version: 2, path: ["厨房", "碗柜"] }]
    },
    bDeps
  );
  assert.equal(cross.ok, true);
  assert.equal(cross.result.mounts[0].status, "not_found", "跨家庭物品逐件 not_found");
  var aItemAfter = (await rawDocs(t.db, "items")).find(function (d) {
    return d._id === item1.item.item_id;
  });
  assert.equal(aItemAfter.version, 2, "A 的物品不被 B 触碰");
});

// ---------- TS-LK1:linkItem 不破坏版本链 ----------

test("TS-LK1:linkItem 与 itemsApi.update 共用同一版本链;交叉写入互不覆盖,过期即冲突", async function () {
  var t = fresh();
  var created = await createItem(t.deps, "op-lk1", "充电宝", "书房桌子右边第二个抽屉");
  var tree = await ensurePath(t.deps, ["书房", "桌子"]);
  var deskId = tree.nodes[1].location_id;
  var homeList = await locHandler({ action: "list" }, t.deps);
  var homeId = homeList.node.location_id;

  // itemsApi.create 建 v1 → linkItem(v1)→ v2
  var link = await locHandler(
    { action: "linkItem", item_id: created.item.item_id, node_id: deskId, expected_version: 1, update_id: "u-lk1-1" },
    t.deps
  );
  assert.equal(link.ok, true, JSON.stringify(link));
  assert.equal(link.item.version, 2);
  var raw = (await rawDocs(t.db, "items"))[0];
  assert.equal(raw.location_node_id, deskId);
  assert.equal(raw.last_update_id, "u-lk1-1");

  // itemsApi.update(v2)改 note → v3 且 location_node_id 保留
  var upd = await itemsHandler(
    { action: "update", item_id: created.item.item_id, expected_version: 2, update_id: "iu-1", note: "新备注" },
    t.deps
  );
  assert.equal(upd.ok, true);
  assert.equal(upd.item.version, 3);
  var raw3 = (await rawDocs(t.db, "items"))[0];
  assert.equal(raw3.location_node_id, deskId, "itemsApi.update 不清挂载");

  // 反向:itemsApi.update 用旧版本 → VERSION_CONFLICT;linkItem 用旧版本同样冲突
  var staleUpdate = await itemsHandler(
    { action: "update", item_id: created.item.item_id, expected_version: 1, update_id: "iu-2", note: "x" },
    t.deps
  );
  assert.equal(staleUpdate.error, "VERSION_CONFLICT");
  var tree2 = await ensurePath(t.deps, ["书房", "柜子"]);
  var staleLink = await locHandler(
    { action: "linkItem", item_id: created.item.item_id, node_id: tree2.nodes[1].location_id, expected_version: 1, update_id: "u-lk1-2" },
    t.deps
  );
  assert.equal(staleLink.error, "VERSION_CONFLICT");

  // home 根不可挂载;node 不存在/跨家庭 NOT_FOUND;item 不存在 NOT_FOUND
  var toHome = await locHandler(
    { action: "linkItem", item_id: created.item.item_id, node_id: homeId, expected_version: 3, update_id: "u-lk1-3" },
    t.deps
  );
  assert.equal(toHome.ok, false);
  assert.equal(toHome.error, "INVALID_INPUT");
  var ghostNode = await locHandler(
    { action: "linkItem", item_id: created.item.item_id, node_id: "lc_404", expected_version: 3, update_id: "u-lk1-4" },
    t.deps
  );
  assert.equal(ghostNode.error, "NOT_FOUND");
  var ghostItem = await locHandler(
    { action: "linkItem", item_id: "it_404", node_id: deskId, expected_version: 1, update_id: "u-lk1-5" },
    t.deps
  );
  assert.equal(ghostItem.error, "NOT_FOUND");
  var badVersion = await locHandler(
    { action: "linkItem", item_id: created.item.item_id, node_id: deskId, expected_version: "3", update_id: "u-lk1-6" },
    t.deps
  );
  assert.equal(badVersion.error, "INVALID_INPUT");
});

// ---------- TS-LK2:linkItem 重放识别 ----------

test("TS-LK2:响应丢失重试(同 update_id 同内容)→ replayed;同 update_id 不同 node → VERSION_CONFLICT 不吞新意图", async function () {
  var t = fresh();
  var created = await createItem(t.deps, "op-lk2", "护照", "书房抽屉");
  var treeA = await ensurePath(t.deps, ["书房", "桌子"]);
  var treeB = await ensurePath(t.deps, ["书房", "柜子"]);
  var deskId = treeA.nodes[1].location_id;
  var cabId = treeB.nodes[1].location_id;

  var lost = await locHandler(
    { action: "linkItem", item_id: created.item.item_id, node_id: deskId, expected_version: 1, update_id: "retry-1" },
    t.deps
  );
  assert.equal(lost.ok, true);
  assert.equal(lost.item.version, 2);

  var replay = await locHandler(
    { action: "linkItem", item_id: created.item.item_id, node_id: deskId, expected_version: 1, update_id: "retry-1" },
    t.deps
  );
  assert.equal(replay.ok, true, "同 update_id 同内容重试应识别为重放");
  assert.equal(replay.replayed, true);
  assert.equal(replay.item.version, 2);

  var hijack = await locHandler(
    { action: "linkItem", item_id: created.item.item_id, node_id: cabId, expected_version: 1, update_id: "retry-1" },
    t.deps
  );
  assert.equal(hijack.ok, false, "同 update_id 不同 node 不能当重放吞掉");
  assert.equal(hijack.error, "VERSION_CONFLICT");
  var raw = (await rawDocs(t.db, "items"))[0];
  assert.equal(raw.location_node_id, deskId, "原挂载无损");
  assert.equal(raw.version, 2);
});

// ---------- TS-LK3:unlinkItem ----------

test("TS-LK3:unlinkItem 置 null;未挂载物品照常 +1;越权/已删 NOT_FOUND", async function () {
  var t = fresh();
  var item1 = await createItem(t.deps, "op-lk3-1", "充电宝", "书房桌子右边第二个抽屉");
  var item2 = await createItem(t.deps, "op-lk3-2", "护照", "客厅抽屉");
  var tree = await ensurePath(t.deps, ["书房", "桌子"]);
  var deskId = tree.nodes[1].location_id;

  await locHandler(
    { action: "linkItem", item_id: item1.item.item_id, node_id: deskId, expected_version: 1, update_id: "u-lk3-1" },
    t.deps
  );
  var unlink = await locHandler(
    { action: "unlinkItem", item_id: item1.item.item_id, expected_version: 2, update_id: "u-lk3-2" },
    t.deps
  );
  assert.equal(unlink.ok, true, JSON.stringify(unlink));
  var raw1 = (await rawDocs(t.db, "items")).find(function (d) {
    return d._id === item1.item.item_id;
  });
  assert.equal(raw1.location_node_id, null);
  assert.equal(raw1.version, 3);

  // 未挂载物品 unlink:照常版本 +1(不做无变化短路,与 itemsApi.update 语义一致)
  var unlink2 = await locHandler(
    { action: "unlinkItem", item_id: item2.item.item_id, expected_version: 1, update_id: "u-lk3-3" },
    t.deps
  );
  assert.equal(unlink2.ok, true);
  var raw2 = (await rawDocs(t.db, "items")).find(function (d) {
    return d._id === item2.item.item_id;
  });
  assert.equal(raw2.version, 2);
  assert.equal(raw2.location_node_id, null);

  // 越权:B 摘 A 的物品 → NOT_FOUND
  var bDeps = makeDeps(t.db, HOUSEHOLD_B);
  var foreign = await locHandler(
    { action: "unlinkItem", item_id: item1.item.item_id, expected_version: 3, update_id: "u-lk3-b" },
    bDeps
  );
  assert.equal(foreign.error, "NOT_FOUND");

  // 已删物品 → NOT_FOUND
  await itemsHandler({ action: "delete", item_id: item2.item.item_id }, t.deps);
  var unlinkDeleted = await locHandler(
    { action: "unlinkItem", item_id: item2.item.item_id, expected_version: 2, update_id: "u-lk3-4" },
    t.deps
  );
  assert.equal(unlinkDeleted.error, "NOT_FOUND");
});

// ---------- TS-MG:merge 级联 ----------

test("TS-MG:merge 全部条件重挂载 + path 级联;source 后代 id 不变物品不动;重试收敛;同名子节点/自并/异类/后代目标拒绝", async function () {
  var t = fresh();
  // 主卧(子:衣柜)/主人房;甲挂主卧,乙挂衣柜
  var tree = await ensurePath(t.deps, ["主卧", "衣柜"]);
  var masterId = tree.nodes[0].location_id;
  var cabId = tree.nodes[1].location_id;
  var tree2 = await ensurePath(t.deps, ["主人房"]);
  var master2Id = tree2.nodes[0].location_id;
  var itemA = await createItem(t.deps, "op-mg-a", "枕头", "主卧衣柜");
  var itemB = await createItem(t.deps, "op-mg-b", "被子", "主卧衣柜第一层");
  await locHandler(
    { action: "linkItem", item_id: itemA.item.item_id, node_id: masterId, expected_version: 1, update_id: "u-mg-a" },
    t.deps
  );
  await locHandler(
    { action: "linkItem", item_id: itemB.item.item_id, node_id: cabId, expected_version: 1, update_id: "u-mg-b" },
    t.deps
  );

  var merged = await locHandler(
    { action: "merge", source_node_id: masterId, target_node_id: master2Id },
    t.deps
  );
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(merged.remounted, 1, "仅直接挂 source 的甲重挂");
  assert.equal(merged.compensated, 0);
  assert.equal(merged.node.name, "主人房");
  var items = await rawDocs(t.db, "items");
  var rawA = items.find(function (d) {
    return d._id === itemA.item.item_id;
  });
  var rawB = items.find(function (d) {
    return d._id === itemB.item.item_id;
  });
  assert.equal(rawA.location_node_id, master2Id, "甲重挂到 target");
  assert.equal(rawA.version, 3, "linkItem v1→2 后,merge 条件重挂 v2→3");
  assert.equal(rawA.last_update_id, "merge:" + digest16(masterId + "→" + master2Id + ":" + itemA.item.item_id));
  assert.equal(rawA.location_text, "主卧衣柜", "merge 不改写历史话语");
  assert.equal(rawA.name, "枕头");
  // source 后代:衣柜 id 不变、挂靠 target、path 前缀重写;其上物品零改动
  var nodes = await rawDocs(t.db, "locations");
  var cab = nodes.find(function (d) {
    return d._id === cabId;
  });
  assert.ok(cab, "source 后代节点 id 不变");
  assert.equal(cab.parent_id, master2Id);
  assert.deepEqual(cab.path, ["主人房", "衣柜"]);
  assert.equal(rawB.location_node_id, cabId, "挂在后代上的物品无需改动");
  assert.equal(rawB.version, 2, "后代物品版本保持 linkItem 后的 2,merge 不推进它");
  assert.equal(
    nodes.some(function (d) {
      return d._id === masterId;
    }),
    false,
    "source 硬删除"
  );

  // 重试同一 merge:source 已删,派生标识证据识别 already_merged
  var retry = await locHandler(
    { action: "merge", source_node_id: masterId, target_node_id: master2Id },
    t.deps
  );
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.detail.already_merged, true);

  // 并发冲突中止:source 直挂两件,第二件在条件更新前被并发修改
  var t2 = fresh();
  var srcTree = await ensurePath(t2.deps, ["厨房"]);
  var tgtTree = await ensurePath(t2.deps, ["餐厅"]);
  var srcId = srcTree.nodes[0].location_id;
  var tgtId = tgtTree.nodes[0].location_id;
  var m1 = await createItem(t2.deps, "op-mg2-1", "酱油", "厨房");
  var m2 = await createItem(t2.deps, "op-mg2-2", "醋", "厨房");
  await locHandler(
    { action: "linkItem", item_id: m1.item.item_id, node_id: srcId, expected_version: 1, update_id: "u-mg2-1" },
    t2.deps
  );
  await locHandler(
    { action: "linkItem", item_id: m2.item.item_id, node_id: srcId, expected_version: 1, update_id: "u-mg2-2" },
    t2.deps
  );
  var trapDb = sabotageMountDb(t2.db, m2.item.item_id, function () {
    return t2.db.collection("items").doc(m2.item.item_id).update({
      data: { version: 3, note: "并发改动" } // 模拟 itemsApi.update 在 merge 读版本(v2)之后推进到 v3
    });
  });
  var trapDeps = Object.assign({}, t2.deps, { db: trapDb });
  var aborted = await locHandler(
    { action: "merge", source_node_id: srcId, target_node_id: tgtId },
    trapDeps
  );
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error, "VERSION_CONFLICT");
  assert.equal(aborted.message, "部分物品刚被修改,请重试");
  assert.equal(aborted.detail.conflicted[0].item_id, m2.item.item_id);
  assert.equal(aborted.detail.conflicted[0].current_version, 3);
  var items2 = await rawDocs(t2.db, "items");
  var m1After = items2.find(function (d) {
    return d._id === m1.item.item_id;
  });
  assert.equal(m1After.location_node_id, tgtId, "中止前已重挂的件保持已挂 target");
  assert.equal(m1After.version, 3, "已重挂件版本正确 +1(linkItem v2 → merge v3)");
  var nodes2 = await rawDocs(t2.db, "locations");
  assert.equal(
    nodes2.some(function (d) {
      return d._id === srcId;
    }),
    true,
    "中止时 source 未动"
  );
  // 重试(无竞态):收敛到完成
  var converge = await locHandler(
    { action: "merge", source_node_id: srcId, target_node_id: tgtId },
    t2.deps
  );
  assert.equal(converge.ok, true, JSON.stringify(converge));
  assert.equal(converge.remounted, 1, "只剩醋需要重挂(酱油已完成)");
  var items2After = await rawDocs(t2.db, "items");
  var m2After = items2After.find(function (d) {
    return d._id === m2.item.item_id;
  });
  assert.equal(m2After.location_node_id, tgtId);
  assert.equal(m2After.version, 4, "重试以并发后的 v3 条件重挂到 v4");

  // 同名子节点 → NODE_CONFLICT + clashing_names,零变化
  var t3 = fresh();
  var s3 = await ensurePath(t3.deps, ["储物间", "架子"]);
  var g3 = await ensurePath(t3.deps, ["杂物间", "架子"]);
  var before3 = await rawDocs(t3.db, "locations");
  var clash = await locHandler(
    { action: "merge", source_node_id: s3.nodes[0].location_id, target_node_id: g3.nodes[0].location_id },
    t3.deps
  );
  assert.equal(clash.ok, false);
  assert.equal(clash.error, "NODE_CONFLICT");
  assert.deepEqual(clash.detail.clashing_names, ["架子"]);
  assert.deepEqual(await rawDocs(t3.db, "locations"), before3, "冲突时数据零变化");

  // source=target / 跨 type / target 为 source 后代(同 type 才能到后代检查)
  var self = await locHandler(
    { action: "merge", source_node_id: g3.nodes[0].location_id, target_node_id: g3.nodes[0].location_id },
    t3.deps
  );
  assert.equal(self.error, "NODE_CONFLICT");
  var crossType = await locHandler(
    { action: "merge", source_node_id: g3.nodes[1].location_id, target_node_id: g3.nodes[0].location_id },
    t3.deps
  );
  assert.equal(crossType.error, "INVALID_INPUT");
  assert.equal(crossType.message, "只能合并同类型的位置");
  var nested = await ensurePath(t3.deps, ["书房", "桌子", "抽屉", "蓝色盒子"]);
  var toDescendant = await locHandler(
    { action: "merge", source_node_id: nested.nodes[2].location_id, target_node_id: nested.nodes[3].location_id },
    t3.deps
  );
  assert.equal(toDescendant.error, "NODE_CONFLICT", "target 为 source 后代(container→container)");
});

// ---------- TS-DL:delete 保护 ----------

test("TS-DL:delete 空节点保护;force 拦截有物品子树;空分支整支删;删后重建;home 根拒绝;补偿摘除", async function () {
  var t = fresh();
  var tree = await ensurePath(t.deps, ["书房", "桌子", "抽屉"]);
  var studyId = tree.nodes[0].location_id;
  var deskId = tree.nodes[1].location_id;
  var drawerId = tree.nodes[2].location_id;
  var item = await createItem(t.deps, "op-dl-1", "充电宝", "书房桌子抽屉");
  await locHandler(
    { action: "linkItem", item_id: item.item.item_id, node_id: drawerId, expected_version: 1, update_id: "u-dl-1" },
    t.deps
  );

  // 有物品 → NODE_NOT_EMPTY(带计数)
  var blocked = await locHandler({ action: "delete", node_id: studyId }, t.deps);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "NODE_NOT_EMPTY");
  assert.equal(blocked.detail.item_count, 1);
  assert.equal(blocked.detail.descendant_count, 2);

  // force 且子树仍有物品 → 依旧 NODE_NOT_EMPTY
  var forced = await locHandler({ action: "delete", node_id: studyId, force: true }, t.deps);
  assert.equal(forced.ok, false);
  assert.equal(forced.error, "NODE_NOT_EMPTY");

  // 摘除物品后:非 force 仍拦(有后代),force 删整支
  await locHandler(
    { action: "unlinkItem", item_id: item.item.item_id, expected_version: 2, update_id: "u-dl-2" },
    t.deps
  );
  var still = await locHandler({ action: "delete", node_id: studyId }, t.deps);
  assert.equal(still.error, "NODE_NOT_EMPTY");
  assert.equal(still.detail.item_count, 0);
  var gone = await locHandler({ action: "delete", node_id: studyId, force: true }, t.deps);
  assert.equal(gone.ok, true);
  assert.equal(gone.deleted_nodes, 3, "整支硬删除(自身+桌子+抽屉)");
  var nodes = await rawDocs(t.db, "locations");
  assert.equal(
    nodes.filter(function (n) {
      return n.household_id === HOUSEHOLD_A;
    }).length,
    1,
    "只剩 home 根"
  );
  // 硬删除语义:删掉书房后可重建同名
  var rebuild = await ensurePath(t.deps, ["书房", "桌子", "抽屉"]);
  assert.deepEqual(rebuild.created, [true, true, true], "删后重建同名可行(不占唯一索引槽)");
  var rebuiltDrawerId = rebuild.nodes[2].location_id;
  assert.notEqual(rebuiltDrawerId, drawerId, "重建节点是新文档(硬删除语义)");

  // home 根删除 → INVALID_INPUT
  var homeList = await locHandler({ action: "list" }, t.deps);
  var delHome = await locHandler({ action: "delete", node_id: homeList.node.location_id }, t.deps);
  assert.equal(delHome.error, "INVALID_INPUT");

  // 补偿:删除瞬间并发 linkItem 落进待删节点 → 删后条件摘除(version+1)且如实计数
  var victim = await createItem(t.deps, "op-dl-2", "钥匙", "书房桌子抽屉");
  var trapDb = removeTrapDb(t.db, rebuiltDrawerId, function () {
    return t.db.collection("items").doc(victim.item.item_id).update({
      data: { location_node_id: rebuiltDrawerId } // 计数时为 0,硬删前一刻被并发挂上
    });
  });
  var trapDeps = Object.assign({}, t.deps, { db: trapDb });
  var compensated = await locHandler({ action: "delete", node_id: rebuiltDrawerId, force: true }, trapDeps);
  assert.equal(compensated.ok, true, JSON.stringify(compensated));
  assert.equal(compensated.deleted_nodes, 1);
  assert.equal(compensated.compensated, 1, "刚挂上来的物品被条件摘除");
  var rawVictim = (await rawDocs(t.db, "items")).find(function (d) {
    return d._id === victim.item.item_id;
  });
  assert.equal(rawVictim.location_node_id, null);
  assert.equal(rawVictim.version, 2, "补偿走版本条件更新");
  assert.equal(rawVictim.last_update_id, "compensate:" + digest16(rebuiltDrawerId + ":" + victim.item.item_id));
});

// ---------- TS-RN:rename 级联 ----------

test("TS-RN:rename 中层名级联重写 path;items 原文不动;同级重名 NODE_CONFLICT;home 根 INVALID_INPUT;跨家庭 NOT_FOUND", async function () {
  var t = fresh();
  var tree = await ensurePath(t.deps, ["书房", "桌子", "抽屉"]);
  var deskId = tree.nodes[1].location_id;
  var drawerId = tree.nodes[2].location_id;
  await ensurePath(t.deps, ["书房", "书架"]);
  var item = await createItem(t.deps, "op-rn", "充电宝", "书房桌子抽屉");
  await locHandler(
    { action: "linkItem", item_id: item.item.item_id, node_id: drawerId, expected_version: 1, update_id: "u-rn-1" },
    t.deps
  );

  var renamed = await locHandler({ action: "rename", node_id: deskId, name: "书桌" }, t.deps);
  assert.equal(renamed.ok, true);
  assert.equal(renamed.node.name, "书桌");
  var nodes = await rawDocs(t.db, "locations");
  var desk = nodes.find(function (d) {
    return d._id === deskId;
  });
  var drawer = nodes.find(function (d) {
    return d._id === drawerId;
  });
  var study = nodes.find(function (d) {
    return d.name === "书房" && d.household_id === HOUSEHOLD_A;
  });
  assert.deepEqual(desk.path, ["书房", "书桌"]);
  assert.deepEqual(drawer.path, ["书房", "书桌", "抽屉"], "后代 path 级联重写");
  assert.deepEqual(study.path, ["书房"], "父节点不受影响");
  var rawItem = (await rawDocs(t.db, "items"))[0];
  assert.equal(rawItem.location_text, "书房桌子抽屉", "rename 绝不改写历史话语");
  assert.equal(rawItem.location_node_id, drawerId, "挂载引用节点 id,改名不影响");

  // 同级重名:书房下已有「书架」
  var clash = await locHandler({ action: "rename", node_id: deskId, name: "书架" }, t.deps);
  assert.equal(clash.error, "NODE_CONFLICT");
  // 大小写/全角归一后同名也算冲突(与查询同款 normalizeName)
  var clashNorm = await locHandler({ action: "rename", node_id: deskId, name: "书 架" }, t.deps);
  assert.equal(clashNorm.error, "NODE_CONFLICT");

  // home 根 / 非法名 / 跨家庭
  var homeList = await locHandler({ action: "list" }, t.deps);
  var homeRename = await locHandler(
    { action: "rename", node_id: homeList.node.location_id, name: "新家" },
    t.deps
  );
  assert.equal(homeRename.error, "INVALID_INPUT");
  var badName = await locHandler({ action: "rename", node_id: deskId, name: "  " }, t.deps);
  assert.equal(badName.error, "INVALID_INPUT");
  var longName = await locHandler({ action: "rename", node_id: deskId, name: "名".repeat(31) }, t.deps);
  assert.equal(longName.error, "INVALID_INPUT");
  var bDeps = makeDeps(t.db, HOUSEHOLD_B);
  var foreign = await locHandler({ action: "rename", node_id: deskId, name: "别人家的" }, bDeps);
  assert.equal(foreign.error, "NOT_FOUND");
});

// ---------- TS-MV:move 防环与级联 ----------

test("TS-MV:move 到自身/后代 NODE_CONFLICT;超深 INVALID_INPUT;成功后 path 前缀整体替换;home 根不可作为父", async function () {
  var t = fresh();
  var living = await ensurePath(t.deps, ["客厅", "电视柜"]);
  var study = await ensurePath(t.deps, ["书房", "桌子", "抽屉"]);
  var studyId = study.nodes[0].location_id;
  var deskId = study.nodes[1].location_id;
  var drawerId = study.nodes[2].location_id;
  var tvId = living.nodes[1].location_id;
  var item = await createItem(t.deps, "op-mv", "遥控器", "书房桌子抽屉");
  await locHandler(
    { action: "linkItem", item_id: item.item.item_id, node_id: drawerId, expected_version: 1, update_id: "u-mv-1" },
    t.deps
  );

  // move 到自身 / 后代 → NODE_CONFLICT
  var toSelf = await locHandler({ action: "move", node_id: deskId, new_parent_id: deskId }, t.deps);
  assert.equal(toSelf.error, "NODE_CONFLICT");
  assert.equal(toSelf.message, "不能移动到自己下面");
  var toDescendant = await locHandler({ action: "move", node_id: deskId, new_parent_id: drawerId }, t.deps);
  assert.equal(toDescendant.error, "NODE_CONFLICT");

  // 成功:桌子(带抽屉)移到电视柜下,path 前缀整体替换
  var moved = await locHandler({ action: "move", node_id: deskId, new_parent_id: tvId }, t.deps);
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.deepEqual(moved.node.path, ["客厅", "电视柜", "桌子"]);
  var nodes = await rawDocs(t.db, "locations");
  var desk = nodes.find(function (d) {
    return d._id === deskId;
  });
  var drawer = nodes.find(function (d) {
    return d._id === drawerId;
  });
  assert.equal(desk.parent_id, tvId);
  assert.deepEqual(drawer.path, ["客厅", "电视柜", "桌子", "抽屉"]);
  var rawItem = (await rawDocs(t.db, "items"))[0];
  assert.equal(rawItem.location_node_id, drawerId, "move 不碰挂载");
  // 新家同级重名:电视柜下已有「桌子」,把阳台的另一张桌子挪过去 → NODE_CONFLICT
  var balconyDesk = await ensurePath(t.deps, ["阳台", "桌子"]);
  var dup = await locHandler({ action: "move", node_id: balconyDesk.nodes[1].location_id, new_parent_id: tvId }, t.deps);
  assert.equal(dup.error, "NODE_CONFLICT", "新家同级重名拒绝");
  var lostStudy = nodes.find(function (d) {
    return d._id === studyId;
  });
  assert.deepEqual(lostStudy.path, ["书房"]);

  // 深度:构造 6 层链走廊/第2..6层柜
  var chain = ["走廊"];
  for (var i = 2; i <= 6; i++) {
    chain.push("第" + i + "层柜");
  }
  await ensurePath(t.deps, chain);
  var chainNodes = await rawDocs(t.db, "locations");
  var top = chainNodes.find(function (d) {
    return d.name === "第4层柜";
  });
  var deepParent = chainNodes.find(function (d) {
    return d.name === "第5层柜";
  });
  // 把「抽屉」(无后代,path 4)移到 第5层柜(深 5)下 → 新深度恰 6,合法
  var okDeep = await locHandler({ action: "move", node_id: drawerId, new_parent_id: deepParent._id }, t.deps);
  assert.equal(okDeep.ok, true, "深度恰 6 层允许");
  // 把「客厅」(子树含 电视柜→桌子,最大相对深度 2)移到 第4层柜(深 4)→ 4+1+2=7 > 6 → 拒绝
  var tooDeep = await locHandler({ action: "move", node_id: living.nodes[0].location_id, new_parent_id: top._id }, t.deps);
  assert.equal(tooDeep.error, "INVALID_INPUT");
  assert.equal(tooDeep.message, "层级太深了");

  // home 根不可作为新父;home 根自身不可移动
  var homeList = await locHandler({ action: "list" }, t.deps);
  var toHome = await locHandler(
    { action: "move", node_id: deskId, new_parent_id: homeList.node.location_id },
    t.deps
  );
  assert.equal(toHome.error, "INVALID_INPUT");
  var moveHome = await locHandler(
    { action: "move", node_id: homeList.node.location_id, new_parent_id: tvId },
    t.deps
  );
  assert.equal(moveHome.error, "INVALID_INPUT");
});

// ---------- TS-ISO:跨家庭隔离 ----------

test("TS-ISO:B 对 A 的树与物品一切写操作 NOT_FOUND;B 的解析上下文不含 A 节点名;A 数据原样", async function () {
  var db = freshDb();
  var depsA = makeDeps(db, HOUSEHOLD_A);
  var depsB = makeDeps(db, HOUSEHOLD_B);

  var tree = await ensurePath(depsA, ["书房", "桌子"]);
  var studyId = tree.nodes[0].location_id;
  var deskId = tree.nodes[1].location_id;
  var itemA = await createItem(depsA, "op-iso-a", "存折", "书房桌子抽屉");
  await locHandler(
    { action: "linkItem", item_id: itemA.item.item_id, node_id: deskId, expected_version: 1, update_id: "u-iso-1" },
    depsA
  );

  var snapLocations = await rawDocs(db, "locations");
  var snapItems = await rawDocs(db, "items");

  // B 的 list 为空(B 只看到自己的 home 根)
  var listB = await locHandler({ action: "list" }, depsB);
  assert.equal(listB.ok, true);
  assert.deepEqual(listB.children, []);
  assert.equal(listB.node.name, "我的家");
  assert.equal(listB.node.location_id !== studyId, true);

  // B 对 A 的节点 rename/move/merge/delete/linkItem → NOT_FOUND
  assert.equal((await locHandler({ action: "rename", node_id: studyId, name: "黑客" }, depsB)).error, "NOT_FOUND");
  assert.equal((await locHandler({ action: "move", node_id: studyId, new_parent_id: deskId }, depsB)).error, "NOT_FOUND");
  assert.equal(
    (await locHandler({ action: "merge", source_node_id: studyId, target_node_id: deskId }, depsB)).error,
    "NOT_FOUND"
  );
  assert.equal((await locHandler({ action: "delete", node_id: studyId, force: true }, depsB)).error, "NOT_FOUND");
  assert.equal(
    (await locHandler(
      { action: "linkItem", item_id: itemA.item.item_id, node_id: deskId, expected_version: 2, update_id: "u-iso-b" },
      depsB
    )).error,
    "NOT_FOUND"
  );
  assert.equal(
    (await locHandler({ action: "unlinkItem", item_id: itemA.item.item_id, expected_version: 2, update_id: "u-iso-b2" }, depsB)).error,
    "NOT_FOUND"
  );
  // B 用 A 的物品 applyScan → 逐件 not_found
  var crossScan = await locHandler(
    {
      action: "applyScan",
      operation_id: "op-iso-scan",
      branches: [],
      mounts: [{ item_id: itemA.item.item_id, expected_version: 2, path: ["B家", "柜子"] }]
    },
    depsB
  );
  assert.equal(crossScan.ok, true);
  assert.equal(crossScan.result.mounts[0].status, "not_found");

  // A 数据原样(B 的操作只可能在 B 名下建根,绝不落 A)
  var afterLocations = await rawDocs(db, "locations");
  var afterItems = await rawDocs(db, "items");
  var aLocations = afterLocations.filter(function (d) {
    return d.household_id === HOUSEHOLD_A;
  });
  var aLocationsSnap = snapLocations.filter(function (d) {
    return d.household_id === HOUSEHOLD_A;
  });
  assert.deepEqual(aLocations, aLocationsSnap, "A 的位置数据原样");
  assert.deepEqual(
    afterItems.filter(function (d) {
      return d.household_id === HOUSEHOLD_A;
    }),
    snapItems.filter(function (d) {
      return d.household_id === HOUSEHOLD_A;
    }),
    "A 的物品数据原样"
  );

  // B 的 parseLocation prompt 不含 A 的节点名
  var mock = seqMock([
    parseRaw([{ name: "厨房", type: "room", confidence: 0.9 }])
  ]);
  var parseB = await locHandler(
    { action: "parseLocation", text: "厨房柜子" },
    Object.assign({}, depsB, { callLLM: mock.callLLM })
  );
  assert.equal(parseB.ok, true);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].indexOf("书房"), -1, "B 的 prompt 不含 A 的节点名");
  assert.equal(mock.calls[0].indexOf("桌子"), -1, "B 的 prompt 不含 A 的节点名");
});

// ---------- TS-INV:挂载不变量(单线程)与读侧容忍 ----------

test("TS-INV:全部操作后每个未删物品的挂载都指向存在节点;悬挂注入后 list 如实计数且向导带回自愈", async function () {
  var t = fresh();
  // 操作序列:建树 → 挂载 → rename → move → merge → 空节点删除
  var tree = await ensurePath(t.deps, ["书房", "桌子", "抽屉"]);
  await ensurePath(t.deps, ["主卧", "衣柜"]);
  var i1 = await createItem(t.deps, "op-inv-1", "充电宝", "书房桌子抽屉");
  var i2 = await createItem(t.deps, "op-inv-2", "枕头", "主卧衣柜");
  var drawerId = tree.nodes[2].location_id;
  await locHandler(
    { action: "linkItem", item_id: i1.item.item_id, node_id: drawerId, expected_version: 1, update_id: "u-inv-1" },
    t.deps
  );
  await locHandler(
    { action: "linkItem", item_id: i2.item.item_id, node_id: tree.nodes[0].location_id ? (await ensurePath(t.deps, ["主卧", "衣柜"])).nodes[1].location_id : "", expected_version: 1, update_id: "u-inv-2" },
    t.deps
  );
  await locHandler({ action: "rename", node_id: tree.nodes[1].location_id, name: "书桌" }, t.deps);
  var cab = (await rawDocs(t.db, "locations")).find(function (d) {
    return d.name === "衣柜";
  });
  await locHandler(
    { action: "move", node_id: (await rawDocs(t.db, "locations")).find(function (d) { return d.name === "抽屉"; })._id, new_parent_id: cab._id },
    t.deps
  );
  // merge 主卧 → 书房?不同名同为 room:建「书房2」再 merge 主卧进去
  var extra = await ensurePath(t.deps, ["客房"]);
  var master = (await rawDocs(t.db, "locations")).find(function (d) {
    return d.name === "主卧";
  });
  await locHandler(
    { action: "merge", source_node_id: master._id, target_node_id: extra.nodes[0].location_id },
    t.deps
  );
  // 删除一个空叶子
  var emptyLeaf = await ensurePath(t.deps, ["客房", "空盒子"]);
  await locHandler({ action: "delete", node_id: emptyLeaf.nodes[1].location_id, force: true }, t.deps);

  // 单线程不变量:每个未删物品的 location_node_id 为 null 或指向存在节点
  var nodes = await rawDocs(t.db, "locations");
  var nodeIds = {};
  nodes.forEach(function (n) {
    nodeIds[n._id] = true;
  });
  var items = await rawDocs(t.db, "items");
  assert.ok(items.length >= 2);
  items.forEach(function (it) {
    if (it.deleted) {
      return;
    }
    var at = it.location_node_id;
    if (at === undefined || at === null || at === "") {
      return;
    }
    assert.ok(nodeIds[at], "物品 " + it._id + " 的挂载必须指向存在节点(单线程不变量)");
  });

  // 注入悬挂 → list 统一口径如实计数、不报错不丢件
  var ghostItem = items[0];
  await t.db.collection("items").doc(ghostItem._id).update({ data: { location_node_id: "lc_ghost" } });
  var rootList = await locHandler({ action: "list" }, t.deps);
  assert.equal(rootList.ok, true, "悬挂挂载不使 list 报错");
  assert.equal(rootList.dangling_mounts, 1);
  assert.ok(rootList.unmounted_count >= 1);

  // scanHousehold 把悬挂件带回 mounts 草案(自愈通道)
  var segs = {};
  segs[ghostItem.location_text] = [
    { name: "客厅", type: "room", confidence: 0.9 },
    { name: "鞋柜", type: "furniture", confidence: 0.85 }
  ];
  segs[items[1].location_text] = [
    { name: "客厅", type: "room", confidence: 0.9 },
    { name: "鞋柜", type: "furniture", confidence: 0.85 }
  ];
  var mock = routingMock(segs, JSON.stringify({ groups: [] }));
  var scan = await locHandler({ action: "scanHousehold" }, Object.assign({}, t.deps, { callLLM: mock.callLLM }));
  assert.equal(scan.ok, true);
  assert.ok(
    scan.scan.mounts.some(function (m) {
      return m.item_id === ghostItem._id;
    }),
    "悬挂件回流 mounts 草案,经向导重挂自愈"
  );
});

// ---------- TS-LOG:日志脱敏 ----------

test("TS-LOG:日志字段仅白名单(action/error/ms/count 与 LLM 计量字段),不含节点名/物品名/原文/身份", async function () {
  var t = fresh();
  var entries = [];
  var deps = makeDeps(t.db, HOUSEHOLD_A, {
    log: function (e) {
      entries.push(e);
    }
  });
  await ensurePath(deps, ["书房", "桌子"]);
  var created = await createItem(deps, "op-log", "隐私物品名", "隐私位置原文");
  var tree = await locHandler({ action: "list" }, deps);
  await locHandler(
    {
      action: "linkItem",
      item_id: created.item.item_id,
      node_id: tree.children[0].location_id,
      expected_version: 1,
      update_id: "u-log"
    },
    deps
  );
  var parseMock = seqMock([parseRaw([{ name: "书房", type: "room", confidence: 0.95 }])]);
  await locHandler(
    { action: "parseLocation", text: "书房里的蓝色盒子" },
    Object.assign({}, deps, { callLLM: parseMock.callLLM })
  );
  // scan 的池取未挂载件:补一件未挂载的
  await createItem(deps, "op-log-2", "未归位件", "阳台鞋柜");
  var scanMock = routingMock(
    { 阳台鞋柜: [{ name: "阳台", type: "room", confidence: 0.9 }] },
    JSON.stringify({ groups: [] })
  );
  await locHandler({ action: "scanHousehold" }, Object.assign({}, deps, { callLLM: scanMock.callLLM }));
  await locHandler({ action: "applyScan", operation_id: "op-log-scan", branches: [], mounts: [] }, deps);
  var bad = await locHandler({ action: "nope" }, deps);
  assert.equal(bad.error, "INVALID_INPUT");

  assert.ok(entries.length >= 8, "应有多条日志,实际 " + entries.length);
  var allowed = ["action", "error", "ms", "count", "text_length", "items_scanned", "chunks", "elapsed_ms"];
  var dump = JSON.stringify(entries);
  for (var i = 0; i < entries.length; i++) {
    var keys = Object.keys(entries[i]);
    for (var k = 0; k < keys.length; k++) {
      assert.ok(
        allowed.indexOf(keys[k]) !== -1,
        "日志出现越界字段:" + keys[k]
      );
    }
  }
  assert.equal(dump.indexOf("书房"), -1, "日志不得出现节点名");
  assert.equal(dump.indexOf("隐私物品名"), -1, "日志不得出现物品名");
  assert.equal(dump.indexOf("隐私位置原文"), -1, "日志不得出现位置原文");
  assert.equal(dump.indexOf("书房里的蓝色盒子"), -1, "日志不得出现解析原文");
  assert.equal(dump.indexOf(HOUSEHOLD_A), -1, "日志不得出现身份");
  assert.equal(dump.indexOf("op-log-scan"), -1, "日志不得出现 operation_id 原文");
  // LLM 类计量字段如实存在
  var parseEntry = entries.find(function (e) {
    return e.action === "parseLocation" && e.text_length !== undefined;
  });
  assert.ok(parseEntry, "parseLocation 应记 text_length");
  var scanEntry = entries.find(function (e) {
    return e.action === "scanHousehold" && e.items_scanned !== undefined;
  });
  assert.ok(scanEntry, "scanHousehold 应记 items_scanned 与 chunks");
  assert.equal(scanEntry.chunks, 1);
});

// ---------- 胶水层:index.js 真实加载 ----------

/** 临时把 wx-server-sdk 替换为 stub 并(重新)加载云函数入口(照 tests/glue.test.js 手法) */
function loadCloudFunction(entryPath, stubSdk) {
  var origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "wx-server-sdk") {
      return stubSdk;
    }
    return origLoad.apply(this, arguments);
  };
  for (var key of Object.keys(require.cache)) {
    if (key.indexOf(path.join(ROOT, "cloudfunctions")) === 0) {
      delete require.cache[key];
    }
  }
  try {
    return require(entryPath);
  } finally {
    Module._load = origLoad;
  }
}

test("glue:locations/index.js 可加载;OPENID 缺失 UNAUTHORIZED;身份派生与 itemsApi 同款;建集合幂等;无 key 时 LLM action 回退", async function () {
  var createdCollections = [];
  function makeStub(openid) {
    var db = freshDb();
    return {
      db: db,
      sdk: {
        DYNAMIC_CURRENT_ENV: "env-dynamic",
        init: function () {},
        getWXContext: function () {
          return openid ? { OPENID: openid } : {};
        },
        database: function () {
          return {
            collection: db.collection.bind(db),
            createCollection: async function (name) {
              createdCollections.push(name);
            }
          };
        }
      }
    };
  }

  // OPENID 缺失 → UNAUTHORIZED
  var anonStub = makeStub(null);
  var anonEntry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "locations", "index.js"), anonStub.sdk);
  assert.equal(typeof anonEntry.main, "function", "exports.main 应为函数(require 链断裂会变 undefined)");
  var anon = await anonEntry.main({ action: "list" });
  assert.equal(anon.ok, false);
  assert.equal(anon.error, "UNAUTHORIZED");
  assert.equal(anon.message, "请先登录");

  // 正常身份:list 建根;household_id 派生与 itemsApi 同款;入口幂等尝试建集合
  var stub = makeStub("o-1");
  var entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "locations", "index.js"), stub.sdk);
  var res = await entry.main({ action: "list" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.node.name, "我的家");
  assert.ok(createdCollections.indexOf("locations") !== -1, "入口应幂等尝试创建 locations 集合");
  var expected = "hh_" + crypto.createHash("sha256").update("o-1", "utf8").digest("hex").slice(0, 32);
  var nodes = await rawDocs(stub.db, "locations");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].household_id, expected, "household_id 与 itemsApi 同款派生");
  // 再调一次:list 幂等,根唯一
  var again = await entry.main({ action: "list" });
  assert.equal(again.ok, true);
  assert.equal((await rawDocs(stub.db, "locations")).length, 1);

  // LLM action 且环境变量缺 key → AI_UNAVAILABLE + manual_fallback(零网络,不打印 key)
  var savedKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    var noKey = await entry.main({ action: "parseLocation", text: "书房桌子" });
    assert.equal(noKey.ok, false);
    assert.equal(noKey.error, "AI_UNAVAILABLE");
    assert.equal(noKey.manual_fallback, true);
    assert.equal(noKey.message, "AI 暂时不可用,可稍后重试或手动选择位置");
    var noKeyScan = await entry.main({ action: "scanHousehold" });
    assert.equal(noKeyScan.error, "AI_UNAVAILABLE");
    assert.equal(noKeyScan.manual_fallback, true);
  } finally {
    if (savedKey !== undefined) {
      process.env.DEEPSEEK_API_KEY = savedKey;
    }
  }

  // 未知 action → INVALID_INPUT(路由层)
  var unknown = await entry.main({ action: "dropTable" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "INVALID_INPUT");
});

// ---------- TS-CHUNK / TS-HIST:架构初审修订(splitChunks 契约 + 位置变更历史 §5.11) ----------

test("TS-CHUNK:splitChunks 均分保序,size 上限真实生效(不再依赖 30÷3 巧合)", async function () {
  var splitChunks = require("../cloudfunctions/locations/lib/parse").splitChunks;

  // 30 件 / target 3 / size 10:与旧行为逐位一致(每块 10,round-robin 保序)
  var thirty = [];
  for (var i = 0; i < 30; i++) {
    thirty.push(i);
  }
  var chunks = splitChunks(thirty, 3, 10);
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map(function (c) { return c.length; }),
    [10, 10, 10]
  );
  assert.deepEqual(chunks[0], [0, 3, 6, 9, 12, 15, 18, 21, 24, 27], "块内保持原顺序");

  // 40 件 / target 3 / size 10:均分会使单块达 14 → 自动增块到 4,每块 ≤ 10
  var forty = [];
  for (var f = 0; f < 40; f++) {
    forty.push(f);
  }
  var big = splitChunks(forty, 3, 10);
  assert.equal(big.length, 4);
  for (var b = 0; b < big.length; b++) {
    assert.ok(big[b].length <= 10, "第 " + b + " 块 " + big[b].length + " 件,超过上限");
  }

  // 小数组行为不变:4 件 3 块 [2,1,1];空数组 0 块
  var four = splitChunks([1, 2, 3, 4], 3, 10);
  assert.equal(four.length, 3);
  assert.deepEqual(
    four.map(function (c) { return c.length; }),
    [2, 1, 1]
  );
  assert.deepEqual(splitChunks([], 3, 10), []);
});

test("TS-HIST1:link/unlink/merge/apply_scan 真实变更写入 item_location_history;重放与空变更不写", async function () {
  var t = fresh();
  var created = await createItem(t.deps, "op-hist1", "充电宝", "书房桌子右边第二个抽屉");
  var itemId = created.item.item_id;

  // link:null → 桌子,历史 1 条(source=link)
  var tree = await ensurePath(t.deps, ["书房", "桌子"]);
  var deskId = tree.nodes[1].location_id;
  var link1 = await locHandler(
    { action: "linkItem", item_id: itemId, node_id: deskId, expected_version: 1, update_id: "u-hist-1" },
    t.deps
  );
  assert.equal(link1.ok, true, JSON.stringify(link1));
  var hist = await rawDocs(t.db, "item_location_history");
  assert.equal(hist.length, 1, "首挂写入一条历史");
  assert.equal(hist[0].item_id, itemId);
  assert.equal(hist[0].from_node_id, null);
  assert.equal(hist[0].to_node_id, deskId);
  assert.equal(hist[0].source, "link");
  assert.equal(hist[0].household_id, HOUSEHOLD_A);
  assert.ok(typeof hist[0].changed_at === "string" && hist[0].changed_at.length > 0, "changed_at 必填");

  // 同 update_id 重放:replayed=true,历史不重复
  var link1Replay = await locHandler(
    { action: "linkItem", item_id: itemId, node_id: deskId, expected_version: 1, update_id: "u-hist-1" },
    t.deps
  );
  assert.equal(link1Replay.ok, true);
  assert.equal(link1Replay.replayed, true);
  assert.equal((await rawDocs(t.db, "item_location_history")).length, 1, "重放不产生历史");

  // unlink:桌子 → null(source=unlink),历史 2 条
  var unlink1 = await locHandler(
    { action: "unlinkItem", item_id: itemId, expected_version: 2, update_id: "u-hist-2" },
    t.deps
  );
  assert.equal(unlink1.ok, true, JSON.stringify(unlink1));
  hist = await rawDocs(t.db, "item_location_history");
  assert.equal(hist.length, 2);
  assert.equal(hist[1].from_node_id, deskId);
  assert.equal(hist[1].to_node_id, null);
  assert.equal(hist[1].source, "unlink");

  // 已摘除物品再 unlink(设计语义:版本照 +1):null → null 空变更,历史不增
  var unlink2 = await locHandler(
    { action: "unlinkItem", item_id: itemId, expected_version: 3, update_id: "u-hist-3" },
    t.deps
  );
  assert.equal(unlink2.ok, true);
  assert.equal((await rawDocs(t.db, "item_location_history")).length, 2, "空变更不写历史");

  // merge:重挂载写入 from → to(source=merge)
  var treeB = await ensurePath(t.deps, ["书房", "书桌"]);
  var deskBId = treeB.nodes[1].location_id;
  await locHandler(
    { action: "linkItem", item_id: itemId, node_id: deskId, expected_version: 4, update_id: "u-hist-4" },
    t.deps
  );
  var merged = await locHandler(
    { action: "merge", source_node_id: deskId, target_node_id: deskBId },
    t.deps
  );
  assert.equal(merged.ok, true, JSON.stringify(merged));
  hist = await rawDocs(t.db, "item_location_history");
  assert.equal(hist.length, 4, "重挂一条 link? 不:merge 直写,历史第 3 条为 link、第 4 条为 merge");
  assert.equal(hist[2].source, "link");
  assert.equal(hist[3].source, "merge");
  assert.equal(hist[3].from_node_id, deskId);
  assert.equal(hist[3].to_node_id, deskBId);

  // applyScan:未挂载物品经向导挂载(source=apply_scan,from=null)
  var created2 = await createItem(t.deps, "op-hist2", "备用钥匙", "客厅电视柜第二层");
  var applied = await locHandler(
    {
      action: "applyScan",
      operation_id: "op-apply-hist",
      branches: [],
      mounts: [{ item_id: created2.item.item_id, expected_version: 1, path: ["客厅", "电视柜"] }]
    },
    t.deps
  );
  assert.equal(applied.ok, true, JSON.stringify(applied));
  hist = await rawDocs(t.db, "item_location_history");
  assert.equal(hist.length, 5);
  assert.equal(hist[4].source, "apply_scan");
  assert.equal(hist[4].from_node_id, null);
  assert.equal(hist[4].item_id, created2.item.item_id);

  // 家庭隔离:history 行只属于本家庭(household_id 逐行断言)
  for (var h = 0; h < hist.length; h++) {
    assert.equal(hist[h].household_id, HOUSEHOLD_A);
  }
});

test("TS-HIST2:另一家庭的历史行不串扰(household_id 随写入隔离)", async function () {
  var db = freshDb();
  var depsA = makeDeps(db, HOUSEHOLD_A);
  var depsB = makeDeps(db, HOUSEHOLD_B);
  var itemA = await itemsHandler(
    { action: "create", operation_id: "op-ha", name: "充电宝A", location_text: "书房桌子" },
    depsA
  );
  var itemB = await itemsHandler(
    { action: "create", operation_id: "op-hb", name: "充电宝B", location_text: "客厅柜子" },
    depsB
  );
  var treeA = await locHandler({ action: "ensurePath", path: ["书房", "桌子"] }, depsA);
  var treeB = await locHandler({ action: "ensurePath", path: ["客厅", "柜子"] }, depsB);
  await locHandler(
    { action: "linkItem", item_id: itemA.item.item_id, node_id: treeA.nodes[1].location_id, expected_version: 1, update_id: "u-ha-1" },
    depsA
  );
  await locHandler(
    { action: "linkItem", item_id: itemB.item.item_id, node_id: treeB.nodes[1].location_id, expected_version: 1, update_id: "u-hb-1" },
    depsB
  );
  var hist = await rawDocs(db, "item_location_history");
  assert.equal(hist.length, 2);
  var byHousehold = {};
  for (var i = 0; i < hist.length; i++) {
    byHousehold[hist[i].household_id] = hist[i];
  }
  assert.ok(byHousehold[HOUSEHOLD_A] && byHousehold[HOUSEHOLD_B], "两家庭各有一条且 household_id 正确");
  assert.equal(byHousehold[HOUSEHOLD_A].item_id, itemA.item.item_id);
  assert.equal(byHousehold[HOUSEHOLD_B].item_id, itemB.item.item_id);
});

// ---------- TS-LOC:方位词规则(issue #21,真机验收反馈) ----------

function locSeg(name, confidence) {
  return { name: name, type: "container", confidence: confidence };
}

test("TS-LOC1:纯方位段并入前一实体段——「书房的桌子上」不再产出「上」子节点", async function () {
  var t = fresh();
  var mock = seqMock([
    parseRaw([
      { name: "书房", type: "room", confidence: 0.95 },
      { name: "桌子", type: "furniture", confidence: 0.9 },
      locSeg("上", 0.9)
    ])
  ]);
  var res = await locHandler(
    { action: "parseLocation", text: "平板电脑在书房的桌子上" },
    Object.assign({}, t.deps, { callLLM: mock.callLLM })
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.parse.segments.length, 2, "「上」被并入桌子段,不单独成节点");
  assert.equal(res.parse.segments[0].name, "书房");
  assert.equal(res.parse.segments[1].name, "桌子");
  assert.equal(res.parse.need_confirm, false, "全锚定高置信且无方位根:无需确认");
});

test("TS-LOC2:首段即纯方位词保留但强制 need_confirm;指向被并入段的模型建议被丢弃", async function () {
  var t = fresh();
  await ensurePath(t.deps, ["书房", "桌子"]);

  // 模型建议(下标 2)指向被并入的「上」段:应整体丢弃,不越界不复活
  var mock = seqMock([
    parseRaw(
      [
        { name: "书房", type: "room", confidence: 0.95 },
        { name: "桌子", type: "furniture", confidence: 0.9 },
        locSeg("上", 0.9)
      ],
      [{ segment_index: 2, name: "桌子", reason: "近义" }]
    )
  ]);
  var res = await locHandler(
    { action: "parseLocation", text: "台灯在书房桌子上" },
    Object.assign({}, t.deps, { callLLM: mock.callLLM })
  );
  assert.equal(res.ok, true);
  assert.equal(res.parse.segments.length, 2);
  for (var i = 0; i < res.parse.merge_suggestions.length; i++) {
    assert.ok(
      res.parse.merge_suggestions[i].segment_index < res.parse.segments.length,
      "建议下标不得指向已并入的段"
    );
  }

  // 首段纯方位:方位词不能单独成为位置根,强制人工确认
  var mock2 = seqMock([parseRaw([{ name: "上", type: "room", confidence: 0.95 }])]);
  var res2 = await locHandler(
    { action: "parseLocation", text: "充电宝在上" },
    Object.assign({}, t.deps, { callLLM: mock2.callLLM })
  );
  assert.equal(res2.ok, true);
  assert.equal(res2.parse.segments.length, 1);
  assert.equal(res2.parse.need_confirm, true, "方位词作为位置根必须人工确认");
});

test("TS-LOC3:可比名近义建议——既有「桌子」时候选「桌上」/「冰箱里」提示合并(用户裁决)", async function () {
  var t = fresh();
  await ensurePath(t.deps, ["书房", "桌子"]);
  await ensurePath(t.deps, ["厨房", "冰箱"]);

  var mock = seqMock([
    parseRaw([
      { name: "书房", type: "room", confidence: 0.95 },
      { name: "桌上", type: "furniture", confidence: 0.9 }
    ])
  ]);
  var res = await locHandler(
    { action: "parseLocation", text: "电脑在书房桌上" },
    Object.assign({}, t.deps, { callLLM: mock.callLLM })
  );
  assert.equal(res.ok, true);
  assert.equal(res.parse.segments.length, 2, "「桌上」非纯方位词,保留为段;近义靠建议解决");
  var near = res.parse.merge_suggestions.filter(function (s) {
    return s.reason === "近义" && s.segment_index === 1;
  })[0];
  assert.ok(near, "桌上 应触发对既有 桌子 的近义建议");
  assert.equal(near.existing_name, "桌子");

  var mock2 = seqMock([
    parseRaw([{ name: "冰箱里", type: "room", confidence: 0.9 }])
  ]);
  var res2 = await locHandler(
    { action: "parseLocation", text: "面条在冰箱里" },
    Object.assign({}, t.deps, { callLLM: mock2.callLLM })
  );
  assert.equal(res2.ok, true);
  var near2 = res2.parse.merge_suggestions.filter(function (s) {
    return s.reason === "近义" && s.segment_index === 0;
  })[0];
  assert.ok(near2, "冰箱里 应触发对既有 冰箱 的近义建议");
  assert.equal(near2.existing_name, "冰箱");
});

test("TS-LOC4:scanHousehold 同款规则——床上→[卧室,床],桌上/桌子 进同义组交用户裁决", async function () {
  var t = fresh();
  var a = await createItem(t.deps, "op-loc4a", "电脑", "书房桌上");
  var b = await createItem(t.deps, "op-loc4b", "台灯", "书房桌子");
  var c = await createItem(t.deps, "op-loc4c", "毯子", "卧室床上");
  var mock = routingMock(
    {
      "书房桌上": [
        { name: "书房", type: "room", confidence: 0.95 },
        { name: "桌上", type: "furniture", confidence: 0.9 }
      ],
      "书房桌子": [
        { name: "书房", type: "room", confidence: 0.95 },
        { name: "桌子", type: "furniture", confidence: 0.9 }
      ],
      "卧室床上": [
        { name: "卧室", type: "room", confidence: 0.95 },
        { name: "床", type: "furniture", confidence: 0.9 },
        locSeg("上", 0.9)
      ]
    },
    '{"groups":[]}'
  );
  var res = await locHandler(
    { action: "scanHousehold" },
    Object.assign({}, t.deps, { callLLM: mock.callLLM })
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.scan.scanned, 3);

  var blanket = res.scan.mounts.filter(function (m) {
    return m.item_id === c.item.item_id;
  })[0];
  assert.deepEqual(blanket.path, ["卧室", "床"], "「上」并入床段,不产生床→上");

  var group = res.scan.synonym_groups.filter(function (g) {
    return g.names.indexOf("桌上") !== -1;
  })[0];
  assert.ok(group, "桌上/桌子 应进入同义组(可比名同为「桌」)");
  assert.equal(group.level, 1);
  assert.ok(group.names.indexOf("桌子") !== -1, "组内应同时含 桌上 与 桌子:" + JSON.stringify(group.names));
  // 未用变量 linter 安抚
  void a; void b;
});
