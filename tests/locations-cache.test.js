"use strict";

/**
 * 「我的家」空间树缓存(issue #23)的离线测试。
 * 被测对象是 `npm run build:mp` 产出的编译产物(pretest 已保证先编译),零外部依赖。
 *
 * 覆盖四条硬约束的可离线部分:
 * 1. TTL 性能策略:2 分钟内命中缓存直接用(不发请求),过期后需重拉;
 * 2. 写操作全量失效:locations 变更类 action 成功 / itemsApi create·delete 成功
 *    都清空整棵树缓存(收口在 API 层),只读 action 与失败路径不清;
 * 3. 刷新失败不更新缓存的任何时间戳(不把旧数据静默标成最新);
 *    另覆盖 24 小时绝对过期与启动清理;
 * 4. 请求序号:旧序号的迟到响应不上屏、不写缓存(PR #17 DG-2 同类防护)。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var cache = require("../miniprogram/utils/locations-cache.js");
var locationsApi = require("../miniprogram/utils/locations-api.js");
var itemsApi = require("../miniprogram/utils/api.js");

var TTL_MS = 2 * 60 * 1000;
var MAX_AGE_MS = 24 * 60 * 60 * 1000;

var T0 = Date.now(); // 基准时钟取当次运行的真实当前(页面式模拟用默认时钟读缓存,TTL 断言全部注入相对时间)

/** 与页面渲染层级同构的 list 响应(节点结构 + 物品摘要,不含任何语音原文) */
function makeListResponse(opts) {
  opts = opts || {};
  return {
    ok: true,
    node: {
      location_id: opts.nodeId || "home-root",
      name: opts.nodeName || "家",
      type: opts.nodeType || "home",
      path: opts.path || [],
      item_count: opts.itemCount || 0,
      child_count: opts.childCount || 0,
      created_from: "bootstrap",
      updated_at: "2026-10-09T00:00:00.000Z",
    },
    children: opts.children || [],
    items: opts.items || [],
    unmounted_count: opts.unmounted || 0,
    dangling_mounts: 0,
  };
}

function makeFakeStorage() {
  var store = {};
  return {
    getStorageSync: function (k) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : "";
    },
    setStorageSync: function (k, v) {
      store[k] = v;
    },
    removeStorageSync: function (k) {
      delete store[k];
    },
    __dump: function () {
      return store;
    },
  };
}

/** 安装 wx.cloud.callFunction stub(与 utils/api.ts 的 success/fail 用法一致) */
function installCloudStub(resultFor) {
  var calls = [];
  globalThis.wx = {
    cloud: {
      callFunction: function (opts) {
        calls.push(opts);
        var r = typeof resultFor === "function" ? resultFor(opts) : resultFor;
        opts.success({ result: r });
      },
    },
  };
  return calls;
}

function dropWxStub() {
  delete globalThis.wx;
}

/**
 * 页面 loadNode 的同款决策序列(用被测模块的纯函数与序号守卫驱动),
 * 把「迟到响应不上屏不写缓存 / 失败不写缓存」的页面契约锁在这里。
 */
function makePageLike() {
  var state = { nodeId: "", rendered: null, renderedOnce: false, stale: false, loadError: "" };
  var seq = cache.createRequestSeq();
  function loadNode(force, fetch) {
    var mySeq = seq.next();
    var myGen = cache.captureCacheGeneration(); // P1-1:跨页面失效代数
    var cached = cache.readLocationsLayer(state.nodeId);
    var plan = cache.planLocationsLoad({
      cached: cached,
      fresh: cached !== null && cache.isLocationsCacheFresh(cached),
      force: force === true,
      pickMode: false,
      rendered: state.renderedOnce,
    });
    if (plan.useCache && cached !== null) {
      state.rendered = cached.response;
      state.renderedOnce = true;
    }
    if (!plan.fetch) {
      return Promise.resolve();
    }
    return fetch().then(
      function (res) {
        if (!seq.isCurrent(mySeq)) {
          return; // 约束 4:迟到响应既不上屏也不写缓存
        }
        if (!cache.isCacheGenerationCurrent(myGen)) {
          state.stale = true; // P1-1:在途期间发生过写失效 → 旧树作废,不缓存不上屏
          return;
        }
        cache.writeLocationsLayer(state.nodeId, res, Date.now(), myGen);
        state.rendered = res;
        state.renderedOnce = true;
        state.stale = false;
        state.loadError = "";
      },
      function (err) {
        if (!seq.isCurrent(mySeq)) {
          return;
        }
        if (state.renderedOnce) {
          state.stale = true; // 约束 1/3:保留旧树,不写缓存、不碰任何时间戳
        } else {
          state.loadError = String(err);
        }
      },
    );
  }
  return { state: state, loadNode: loadNode };
}

function defer() {
  var resolve, reject;
  var promise = new Promise(function (res, rej) {
    resolve = res;
    reject = rej;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

test.beforeEach(function () {
  cache.__setLocationsCacheStorageForTest(makeFakeStorage());
});

test.afterEach(function () {
  cache.__resetLocationsCacheForTest();
  dropWxStub();
});

/* ---------------- 1. TTL:性能策略,不是正确性保证 ---------------- */

test("TTL 内命中缓存可直接用(不发请求);超过 2 分钟该重拉但旧数据仍可先上屏", function () {
  var rootResp = makeListResponse({ unmounted: 3, childCount: 2 });
  cache.writeLocationsLayer("", rootResp, T0);

  var hit = cache.readLocationsLayer("", T0 + 60 * 1000);
  assert.ok(hit, "TTL 内应命中缓存");
  assert.equal(hit.savedAt, T0, "命中条目保留原写入时间(不被读取刷新)");
  assert.deepEqual(hit.response, rootResp, "命中内容与写入的 list 响应一致");
  assert.equal(
    cache.isLocationsCacheFresh(hit, T0 + TTL_MS),
    true,
    "恰好 2 分钟(边界)仍算新鲜,可直接用而不发请求",
  );
  assert.equal(
    cache.isLocationsCacheFresh(hit, T0 + TTL_MS + 1),
    false,
    "超过 2 分钟不再新鲜:需要重拉(可先上屏旧树再后台刷新)",
  );
  // 层与层互不干扰:根层与子层各存各的
  var childResp = makeListResponse({ nodeId: "node-1", nodeName: "书房", nodeType: "room", path: ["书房"] });
  cache.writeLocationsLayer("node-1", childResp, T0);
  var child = cache.readLocationsLayer("node-1", T0 + 1000);
  assert.ok(child, "子层缓存独立命中");
  assert.equal(child.response.node.name, "书房", "子层内容不被根层覆盖");
});

test("加载决策:TTL 内不发请求;过期先上屏旧树再刷新;无缓存首载才用骨架;下拉与选择模式绕过缓存", function () {
  var entry = { savedAt: T0, response: makeListResponse() };
  assert.deepEqual(
    cache.planLocationsLoad({ cached: entry, fresh: true, force: false, pickMode: false, rendered: true }),
    { useCache: true, skeleton: false, fetch: false },
    "TTL 内且非强制:直接用缓存,不触发云函数(降低冷启动频率的主路径)",
  );
  assert.deepEqual(
    cache.planLocationsLoad({ cached: entry, fresh: true, force: true, pickMode: false, rendered: true }),
    { useCache: true, skeleton: false, fetch: true },
    "下拉刷新(force):缓存只用来先上屏,必须直连服务端",
  );
  assert.deepEqual(
    cache.planLocationsLoad({ cached: entry, fresh: false, force: false, pickMode: false, rendered: false }),
    { useCache: true, skeleton: false, fetch: true },
    "缓存过 TTL:先上屏旧树 + 后台静默刷新,不整页骨架",
  );
  assert.deepEqual(
    cache.planLocationsLoad({ cached: null, fresh: false, force: false, pickMode: false, rendered: false }),
    { useCache: false, skeleton: true, fetch: true },
    "无缓存首载:骨架屏 + 请求服务端",
  );
  assert.deepEqual(
    cache.planLocationsLoad({ cached: null, fresh: false, force: false, pickMode: false, rendered: true }),
    { useCache: false, skeleton: false, fetch: true },
    "无缓存但屏上已有内容(写操作刚失效):只轻量刷新指示,不整页骨架",
  );
  assert.deepEqual(
    cache.planLocationsLoad({ cached: entry, fresh: true, force: false, pickMode: true, rendered: false }),
    { useCache: false, skeleton: true, fetch: true },
    "选择位置模式(picker):影响真实数据操作前的校验,一律绕过缓存直连服务端",
  );
});

test("存储注入生效:写入落在注入的 storage,整树失效即从 storage 移除", function () {
  var fake = makeFakeStorage();
  cache.__setLocationsCacheStorageForTest(fake);
  cache.writeLocationsLayer("", makeListResponse(), T0);
  assert.ok(fake.__dump()["home-memory:locations-cache"], "写入应落在注入的 storage 条目上");
  assert.ok(cache.readLocationsLayer(""), "经注入 storage 也能读回");
  cache.clearLocationsCache();
  assert.equal(
    fake.__dump()["home-memory:locations-cache"],
    undefined,
    "整树失效把 storage 条目整个移除,不残留空壳",
  );
});

/* ---------------- 2. 写操作全量失效(收口在 API 层) ---------------- */

test("locations 变更类 action 成功 → 整棵树缓存失效(所有层一起清)", async function () {
  cache.writeLocationsLayer("", makeListResponse(), T0);
  cache.writeLocationsLayer("node-1", makeListResponse({ nodeId: "node-1" }), T0);
  var calls = installCloudStub({
    ok: true,
    node: {
      location_id: "node-1",
      name: "书房改",
      type: "room",
      path: ["书房改"],
      item_count: 0,
      child_count: 0,
      created_from: "manual",
      updated_at: "2026-10-09T00:00:00.000Z",
    },
  });

  await locationsApi.callLocationsApi({ action: "rename", node_id: "node-1", name: "书房改" });

  assert.equal(calls.length, 1);
  assert.equal(
    cache.readLocationsLayer(""),
    null,
    "rename 成功后根层缓存必须失效(改名影响所有含该路径的层)",
  );
  assert.equal(
    cache.readLocationsLayer("node-1"),
    null,
    "rename 成功后变更层自身缓存也失效(第一版全量失效,不做节点级精细化)",
  );
});

test("itemsApi create / delete 成功 → 整棵树缓存失效(新物品影响未归位计数,改删影响层级物品)", async function () {
  var item = {
    item_id: "it_1",
    name: "钥匙",
    location_text: "玄关抽屉",
    note: "",
    version: 1,
    updated_at: "2026-10-09T00:00:00.000Z",
  };

  cache.writeLocationsLayer("", makeListResponse({ unmounted: 5 }), T0);
  installCloudStub(function (opts) {
    if (opts.data.action === "create") {
      return { ok: true, item: item, duplicated: false };
    }
    return { ok: true };
  });
  await itemsApi.callItemsApi({ action: "create", draft: {}, operation_id: "op-1" });
  assert.equal(cache.readLocationsLayer(""), null, "itemsApi create 成功后根层缓存失效(未归位计数会变)");

  cache.writeLocationsLayer("", makeListResponse({ unmounted: 6 }), T0);
  await itemsApi.callItemsApi({ action: "delete", item_id: "it_1", operation_id: "op-2" });
  assert.equal(cache.readLocationsLayer(""), null, "itemsApi delete 成功后缓存同样失效");
});

test("只读 action 与失败路径不清缓存(失效只挂在「成功的写操作」上)", async function () {
  var rootResp = makeListResponse({ unmounted: 2 });
  cache.writeLocationsLayer("", rootResp, T0);
  installCloudStub(function (opts) {
    if (opts.data.action === "list") {
      return makeListResponse({ unmounted: 2 });
    }
    return { ok: false, error: "NOT_FOUND", message: "没有找到这个位置" };
  });

  await locationsApi.callLocationsApi({ action: "list" });
  assert.ok(cache.readLocationsLayer(""), "list 只读:缓存保留");
  assert.equal(
    cache.readLocationsLayer("").savedAt,
    T0,
    "list 走 API 层不触碰缓存时间戳(写缓存是页面成功路径的事)",
  );

  await assert.rejects(
    function () {
      return locationsApi.callLocationsApi({ action: "rename", node_id: "node-x", name: "改名" });
    },
    /没有找到这个位置/,
    "rename 失败应原样抛错",
  );
  assert.ok(cache.readLocationsLayer(""), "写操作失败不清缓存(没写成就没有失效义务)");
});

/* ---------------- 3. 刷新失败不更新缓存时间戳 ---------------- */

test("后台刷新失败:保留旧树、不写缓存、savedAt 原样(不得把旧数据静默标成最新)", async function () {
  var oldResp = makeListResponse({ unmounted: 4 });
  // 写成「已过性能 TTL」的旧缓存(页面式模拟用默认时钟判断新鲜度),先上屏旧树后刷新
  var staleAt = Date.now() - TTL_MS - 5000;
  cache.writeLocationsLayer("", oldResp, staleAt);
  installCloudStub({ ok: false, error: "UNAUTHORIZED", message: "登录状态异常" });

  var page = makePageLike();
  // 模拟「过期后进入 → 先上屏旧树 → 后台刷新失败」的完整页面序列
  await page.loadNode(false, function () {
    return locationsApi.callLocationsApi({ action: "list" });
  });

  assert.equal(page.state.stale, true, "刷新失败置 stale(页面显示「当前为上次记录」并可重试)");
  assert.deepEqual(page.state.rendered, oldResp, "屏上仍是旧树,不清空不闪屏");

  var entry = cache.readLocationsLayer("");
  assert.ok(entry, "失败后缓存条目仍在(旧数据可继续先上屏)");
  assert.equal(entry.savedAt, staleAt, "失败路径绝不更新 savedAt——旧数据不能被标成新鲜");
  assert.equal(
    cache.isLocationsCacheFresh(entry),
    false,
    "下次进入仍会触发刷新(失败不会被 TTL 掩盖)",
  );
});

/* ---------------- 4. 24 小时绝对过期与启动清理 ---------------- */

test("超过 24 小时的层在读取时如实视为不存在", function () {
  cache.writeLocationsLayer("", makeListResponse(), T0);

  assert.ok(cache.readLocationsLayer("", T0 + MAX_AGE_MS), "恰好 24 小时(边界)仍可读");
  assert.equal(
    cache.readLocationsLayer("", T0 + MAX_AGE_MS + 1),
    null,
    "超过 24 小时绝对过期:如实视为不存在(读取顺手清掉该层)",
  );
  assert.equal(
    cache.readLocationsLayer("", T0 + MAX_AGE_MS + 2),
    null,
    "再次读取仍为 null(清理持久生效)",
  );
});

test("启动清理只删绝对过期的层,未过期的层保留", function () {
  cache.writeLocationsLayer("", makeListResponse(), T0);
  cache.writeLocationsLayer("node-1", makeListResponse({ nodeId: "node-1" }), T0 + 10 * 60 * 1000);

  var now = T0 + MAX_AGE_MS + 1; // 根层已过 24h,子层距写入仅 24h−10min+1ms
  var remaining = cache.pruneLocationsCache(now);
  assert.equal(remaining, 1, "启动清理只删绝对过期的根层,10 分钟后写入的子层保留");
  assert.equal(cache.readLocationsLayer("", now), null, "根层已被清理");
  assert.ok(cache.readLocationsLayer("node-1", now), "子层完好");
});

test("全部层过期时启动清理把缓存条目整个移除(不残留空壳)", function () {
  var fake = makeFakeStorage();
  cache.__setLocationsCacheStorageForTest(fake);
  cache.writeLocationsLayer("", makeListResponse(), T0);
  assert.ok(fake.__dump()["home-memory:locations-cache"], "前置:缓存条目已落 storage");

  var remaining = cache.pruneLocationsCache(T0 + MAX_AGE_MS + 1);
  assert.equal(remaining, 0, "唯一的层过期后剩余 0");
  assert.equal(
    fake.__dump()["home-memory:locations-cache"],
    undefined,
    "storage 里的缓存条目被整体移除,不残留空壳",
  );
});

/* ---------------- 5. 请求序号:旧响应不得覆盖新数据(约束 4) ---------------- */

test("请求序号守卫:next 递增,只有最新请求的响应 isCurrent", function () {
  var seq = cache.createRequestSeq();
  var s1 = seq.next();
  var s2 = seq.next();
  assert.equal(s1, 1, "第一个序号为 1");
  assert.equal(s2, 2, "序号递增");
  assert.equal(seq.isCurrent(s1), false, "发起第二次请求后,第一次的响应已过期");
  assert.equal(seq.isCurrent(s2), true, "最新请求的响应有效");
  assert.equal(seq.current(), 2);
});

test("迟到响应不覆盖新数据:旧请求的响应回来既不上屏也不写缓存", async function () {
  var respA = makeListResponse({ unmounted: 1 });
  var respB = makeListResponse({ unmounted: 7 });
  var page = makePageLike();
  var d1 = defer();
  var d2 = defer();

  var p1 = page.loadNode(false, function () {
    return d1.promise;
  });
  var p2 = page.loadNode(false, function () {
    return d2.promise;
  });

  d2.resolve(respB); // 新请求的响应先回:上屏 + 写缓存
  await p2;
  d1.resolve(respA); // 旧请求的响应迟到:必须整个丢弃
  await p1;

  assert.deepEqual(page.state.rendered, respB, "屏上是新响应 B,旧响应 A 未覆盖");
  assert.deepEqual(
    cache.readLocationsLayer("").response,
    respB,
    "缓存里也是 B:A 的迟到写缓存被序号守卫挡下",
  );
});

test("失败也一样:旧请求的迟到失败不把新数据标记为 stale", async function () {
  var respB = makeListResponse({ unmounted: 9 });
  var page = makePageLike();
  var d1 = defer();
  var d2 = defer();

  var p1 = page.loadNode(false, function () {
    return d1.promise;
  });
  var p2 = page.loadNode(false, function () {
    return d2.promise;
  });
  d2.resolve(respB);
  await p2;
  d1.reject(new Error("旧请求超时"));
  await p1;

  assert.equal(page.state.stale, false, "旧请求的迟到失败不得污染当前状态(新数据已成功上屏)");
  assert.deepEqual(page.state.rendered, respB);
});

/* ---------------- 5. P1-1:跨页面失效代数(在途旧响应不得复活缓存) ---------------- */

test("GEN-1:list 在途时其他页面写成功并失效 → 迟到旧响应作废:不缓存、不冒充新树", async function () {
  // 预置「已过性能 TTL」的旧树:保证 loadNode 会真的发请求(在途),而不是直用缓存
  cache.writeLocationsLayer("", makeListResponse({ itemCount: 3 }), T0 - TTL_MS - 60000);
  var page = makePageLike();
  var d = defer();
  var inflight = page.loadNode(false, function () {
    return d.promise; // 页面 A 的 list(服务器读的还是旧树)
  });
  // 页面 B:物品移动/改名成功 → API 层全量失效(clearLocationsCache 收口同款)
  cache.clearLocationsCache();
  d.resolve(makeListResponse({ itemCount: 2 }));
  await inflight;
  assert.equal(cache.readLocationsLayer(""), null, "迟到旧树不得按新 savedAt 写回缓存");
  assert.equal(page.state.stale, true, "页面呈现待同步状态而非冒充成功");

  // 后续正常路径:失效后的新请求(新代数)照常落缓存
  var page2 = makePageLike();
  await page2.loadNode(false, function () {
    return Promise.resolve(makeListResponse({ itemCount: 2 }));
  });
  var entry = cache.readLocationsLayer("");
  assert.ok(entry, "新代数请求正常落缓存");
  assert.equal(entry.response.node.item_count, 2);
});

test("GEN-2:失效代数单调递增;旧代数直接调 writeLocationsLayer 同样被拒", function () {
  var g0 = cache.captureCacheGeneration();
  cache.clearLocationsCache();
  assert.equal(cache.isCacheGenerationCurrent(g0), false, "失效后旧代数必失效");
  var g1 = cache.captureCacheGeneration();
  assert.equal(cache.isCacheGenerationCurrent(g1), true);
  assert.notEqual(g0, g1, "代数递增");

  cache.writeLocationsLayer("x", makeListResponse({ nodeId: "x" }), T0, g0);
  assert.equal(cache.readLocationsLayer("x"), null, "旧代数写入被拒");
  cache.writeLocationsLayer("x", makeListResponse({ nodeId: "x" }), T0, g1);
  assert.ok(cache.readLocationsLayer("x"), "当前代数写入正常");
});

/* ---------------- 6. P1-2:storage 故障 best-effort(不冒充业务/网络错误) ---------------- */

test("STO-1:getStorageSync 抛异常 → 读缓存视为 miss,服务端结果照常渲染,不产生错误态", async function () {
  var broken = makeFakeStorage();
  broken.getStorageSync = function () {
    throw new Error("storage boom");
  };
  cache.__setLocationsCacheStorageForTest(broken);
  var page = makePageLike();
  await page.loadNode(false, function () {
    return Promise.resolve(makeListResponse({ itemCount: 5 }));
  });
  assert.equal(page.state.rendered.node.item_count, 5, "服务端结果照常上屏");
  assert.equal(page.state.loadError, "", "storage 异常不得冒充业务/网络错误");
  assert.equal(page.state.stale, false);
});

test("STO-2:setStorageSync 抛异常 → 写缓存静默失败;渲染不受影响,后续读降级为 miss", async function () {
  var broken = makeFakeStorage();
  broken.setStorageSync = function () {
    throw new Error("disk full");
  };
  cache.__setLocationsCacheStorageForTest(broken);
  var page = makePageLike();
  await page.loadNode(false, function () {
    return Promise.resolve(makeListResponse({ itemCount: 1 }));
  });
  assert.ok(page.state.rendered, "渲染不因写缓存失败而失败");
  assert.equal(page.state.loadError, "");
  assert.equal(cache.readLocationsLayer(""), null, "写失败不留半成品,读降级为 miss");
});

test("STO-3:removeStorageSync 抛异常 → API 写操作仍按服务端结果成败,失效不抛不改语义", async function () {
  var broken = makeFakeStorage();
  broken.removeStorageSync = function () {
    throw new Error("rm boom");
  };
  cache.__setLocationsCacheStorageForTest(broken);
  cache.writeLocationsLayer("", makeListResponse({ unmounted: 5 }), T0);
  installCloudStub(function (opts) {
    if (opts.data.action === "create") {
      return {
        ok: true,
        item: { item_id: "it_9", name: "钥匙", location_text: "玄关抽屉", note: "", version: 1, updated_at: "2026-10-09T00:00:00.000Z" },
        duplicated: false,
      };
    }
    return { ok: true };
  });
  var res = await itemsApi.callItemsApi({ action: "create", draft: {}, operation_id: "op-sto3" });
  assert.equal(res.ok, true, "服务端写成功就是成功:缓存清理异常不得改写 API 语义");
});

test("STO-4:app 启动清理遇 storage 异常不抛(prune best-effort);malformed 条目降级为 miss", function () {
  var broken = makeFakeStorage();
  broken.getStorageSync = function () {
    throw new Error("boot boom");
  };
  cache.__setLocationsCacheStorageForTest(broken);
  assert.doesNotThrow(function () {
    cache.pruneLocationsCache(T0);
  }, "启动清理不得打断应用启动");

  cache.__resetLocationsCacheForTest();
  var fake = makeFakeStorage();
  cache.__setLocationsCacheStorageForTest(fake);
  cache.writeLocationsLayer("", makeListResponse(), T0);
  var dump = fake.__dump();
  var key = Object.keys(dump)[0];
  fake.setStorageSync(key, "不是一个合法的缓存对象"); // 模拟持久层损坏
  assert.equal(cache.readLocationsLayer(""), null, "malformed 条目降级为 miss,不让页面拿到坏数据");
});

test("STO-5:嵌套层条目内部损坏(response:null 等)→ 降级为 miss,不进渲染路径,照常请求云端", async function () {
  var fake = makeFakeStorage();
  cache.__setLocationsCacheStorageForTest(fake);
  // 先种一个合法条目拿到真实 storage key,再换成「形状合法但内层损坏」的持久层
  cache.writeLocationsLayer("", makeListResponse({ itemCount: 9 }), Date.now());
  var key = Object.keys(fake.__dump())[0];
  fake.setStorageSync(key, {
    layers: { root: { savedAt: Date.now(), response: null } },
  });
  assert.equal(cache.readLocationsLayer(""), null, "response:null 的条目必须降级为 miss");

  // 页面同款决策序列:miss → 发请求 → 服务端结果照常渲染,无异常无错误态
  var page = makePageLike();
  await page.loadNode(false, function () {
    return Promise.resolve(makeListResponse({ itemCount: 4 }));
  });
  assert.equal(page.state.rendered.node.item_count, 4, "云端结果照常上屏");
  assert.equal(page.state.loadError, "", "坏条目不得冒充错误,也不得炸渲染");

  // 其他同源畸形:savedAt 非数字 / node 缺 type / children 非数组
  fake.setStorageSync(key, { layers: { root: { savedAt: "not-a-number", response: makeListResponse() } } });
  assert.equal(cache.readLocationsLayer(""), null, "savedAt 非有限数字 → miss");
  var brokenNode = makeListResponse();
  brokenNode.node = { no_type: true };
  fake.setStorageSync(key, { layers: { root: { savedAt: Date.now(), response: brokenNode } } });
  assert.equal(cache.readLocationsLayer(""), null, "node 缺 type → miss");
  var brokenChildren = makeListResponse();
  brokenChildren.children = "not-an-array";
  fake.setStorageSync(key, { layers: { root: { savedAt: Date.now(), response: brokenChildren } } });
  assert.equal(cache.readLocationsLayer(""), null, "children 非数组 → miss");
  // 坏条目被顺手清掉:同 key 再读仍是 miss,且持久层不再含 root
  var dumpAfter = fake.__dump()[key];
  assert.ok(!dumpAfter || !dumpAfter.layers || !dumpAfter.layers.root, "损坏条目已被 best-effort 清除");
});
