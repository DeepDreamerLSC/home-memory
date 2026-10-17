"use strict";

/**
 * 拍照批会话(utils/photo-session,#3)离线测试:
 * 被测对象是 `npm run build:mp` 产出的 miniprogram/utils/photo-session.js
 * (pretest 已保证先编译)。零网络、零外部依赖、绝不 require wx-server-sdk。
 *
 * 覆盖(纪律仿 tests/ 下 draft-session 相关用例):
 * - 持久与恢复:开批 → 逐次回写 → 读回(行状态/批次位置/fileId 逐字段);
 * - TTL 24h:过期如实视为不存在并清除,绝不编造;
 * - 只留最新一批:新批顶掉旧批;clear 后 update 不复活(CAS 守卫);
 * - 家庭作用域隔离(F3):捕获 household_id 后键带后缀,旧家庭批不可达、
 *   回切即恢复;
 * - fileId 默认 null(确认前云端零残留);载荷绝无 base64 字段;
 * - 形状门:损坏/旧版本残留条目视同不存在。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var ps = require("../miniprogram/utils/photo-session.js");
var householdScope = require("../miniprogram/utils/household-scope.js");
var intakeDraft = require("../miniprogram/utils/intake-draft.js");

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
    dump: function () {
      return store;
    },
  };
}

function makeRow(name, checked) {
  return intakeDraft.makeAiRow(
    { name: name, qty_note: "", confidence: checked ? "high" : "low", box: null },
    function () {
      return "id-" + name;
    },
  );
}

function setup() {
  var storage = makeFakeStorage();
  ps.__resetPhotoSessionForTest();
  ps.__setPhotoSessionStorageForTest(storage);
  householdScope.__resetHouseholdScopeForTest();
  return storage;
}

test("PS-1:开批持久 + 未完成读回(行状态/位置/fileId 逐字段)", function () {
  var storage = setup();
  var rows = [makeRow("黄色薯片罐", true), makeRow("黑色耳机", false)];
  var payload = ps.startPhotoSession(
    { localPath: "wxfile://tmp/a.jpg", imgW: 1024, imgH: 768, fileId: null },
    rows,
    "玄关柜 · 第二层抽屉",
  );
  assert.equal(payload.file.fileId, null, "fileId 确认上传前恒 null(云端零残留)");
  assert.match(payload.batchId, /^-?[0-9a-f-]+$/, "batchId 为 uuid 形态");
  assert.ok(payload.batchId.length >= 8 && payload.batchId.length <= 64, "batch_id 契约 8-64");

  var restored = ps.getUnfinishedPhotoSession();
  assert.notEqual(restored, null, "中途退出后可恢复");
  assert.equal(restored.batchId, payload.batchId, "batchId 全程稳定");
  assert.equal(restored.file.localPath, "wxfile://tmp/a.jpg");
  assert.equal(restored.file.imgW, 1024);
  assert.equal(restored.file.imgH, 768);
  assert.equal(restored.file.fileId, null);
  assert.equal(restored.batchLocation, "玄关柜 · 第二层抽屉");
  assert.equal(restored.rows.length, 2);
  assert.equal(restored.rows[0].draftId, "id-黄色薯片罐", "行 draftId 随批恢复(锁定依据不漂移");
  assert.equal(restored.rows[0].operationId, "id-黄色薯片罐", "幂等键随批恢复");
});

test("PS-2:载荷绝无 base64 字段(隐私红线:识别载荷只在页面内存)", function () {
  var storage = setup();
  ps.startPhotoSession(
    { localPath: "wxfile://tmp/a.jpg", imgW: 10, imgH: 10, fileId: null },
    [],
    "",
  );
  var raw = JSON.stringify(storage.dump());
  assert.equal(raw.indexOf("base64"), -1, "会话载荷不含 base64 字样");
  assert.equal(raw.indexOf("/9j/"), -1, "会话载荷不含图片数据");
});

test("PS-3:逐次回写(保存成功行 done/fileId 取得后随会话保留)", function () {
  setup();
  var payload = ps.startPhotoSession(
    { localPath: "wxfile://tmp/a.jpg", imgW: 100, imgH: 80, fileId: null },
    [makeRow("电池", true)],
    "客厅电视柜",
  );
  payload.rows[0] = intakeDraft.markRowSaved(payload.rows[0]);
  payload.file.fileId = "cloud://test-file-id";
  payload.batchLocation = "厨房";
  ps.updatePhotoSession(payload);
  var restored = ps.getUnfinishedPhotoSession();
  assert.equal(restored.rows[0].done, true, "已保存行终态随会话保留");
  assert.equal(restored.file.fileId, "cloud://test-file-id", "fileId 取得后随会话保留,重试不重复上传");
  assert.equal(restored.batchLocation, "厨房");
});

test("PS-4:TTL 24 小时:过期如实不存在并清除;未过期可恢复", function () {
  setup();
  var payload = ps.startPhotoSession(
    { localPath: "wxfile://tmp/a.jpg", imgW: 1, imgH: 1, fileId: null },
    [],
    "",
  );
  var justBefore = payload.createdAt + 24 * 60 * 60 * 1000 - 1;
  assert.notEqual(ps.getUnfinishedPhotoSession(justBefore), null, "24h 内可恢复");
  var justAfter = payload.createdAt + 24 * 60 * 60 * 1000 + 1;
  assert.equal(ps.getUnfinishedPhotoSession(justAfter), null, "过期如实视为不存在");
  assert.equal(ps.getUnfinishedPhotoSession(), null, "过期条目已被清除(不复活)");
});

test("PS-5:只留最新一批;clear 后迟到回写不复活旧批(CAS 守卫)", function () {
  setup();
  var first = ps.startPhotoSession(
    { localPath: "wxfile://tmp/1.jpg", imgW: 1, imgH: 1, fileId: null },
    [makeRow("旧批", false)],
    "旧位置",
  );
  var second = ps.startPhotoSession(
    { localPath: "wxfile://tmp/2.jpg", imgW: 2, imgH: 2, fileId: null },
    [makeRow("新批", true)],
    "新位置",
  );
  var current = ps.getUnfinishedPhotoSession();
  assert.equal(current.batchId, second.batchId, "新批顶掉旧批(只留最新一个)");
  // 旧批页面的迟到回写不得顶掉新批
  first.batchLocation = "迟到写入";
  ps.updatePhotoSession(first);
  assert.equal(ps.getUnfinishedPhotoSession().batchLocation, "新位置", "迟到回写被 CAS 守卫拦下");

  ps.clearPhotoSession();
  assert.equal(ps.getUnfinishedPhotoSession(), null, "全部入库/放弃后清除");
  ps.updatePhotoSession(second);
  assert.equal(ps.getUnfinishedPhotoSession(), null, "清除后的回写不复活旧批");
  ps.clearPhotoSession(); // 幂等
  assert.equal(ps.getUnfinishedPhotoSession(), null);
});

test("PS-6:家庭作用域隔离(F3)——换家庭旧批不可达,回切即恢复", function () {
  var storage = setup();
  ps.startPhotoSession(
    { localPath: "wxfile://tmp/a.jpg", imgW: 1, imgH: 1, fileId: null },
    [makeRow("个人家的批", true)],
    "书房抽屉",
  );
  // 捕获共享家庭作用域(键带 :hh- 后缀,与个人键互不可达)
  householdScope.captureHouseholdId("hh_shared01", 3);
  assert.equal(ps.getUnfinishedPhotoSession(), null, "换家庭后旧家庭的拍照批不可达");
  ps.startPhotoSession(
    { localPath: "wxfile://tmp/b.jpg", imgW: 2, imgH: 2, fileId: null },
    [makeRow("共享家的批", true)],
    "客厅柜",
  );
  assert.equal(ps.getUnfinishedPhotoSession().rows[0].name, "共享家的批");
  // 回切个人家庭(重置捕获):旧批原样恢复,draftId/幂等键不变
  householdScope.__resetHouseholdScopeForTest();
  var restored = ps.getUnfinishedPhotoSession();
  assert.equal(restored.rows[0].name, "个人家的批", "回切即恢复(绝不自动迁移)");
  assert.equal(restored.rows[0].draftId, "id-个人家的批");
});

test("PS-7:形状门——损坏/旧版本残留条目视同不存在,不进渲染路径", function () {
  var storage = setup();
  storage.setStorageSync("home-memory:photo-session", { batchId: "b7e2broken" });
  assert.equal(ps.getUnfinishedPhotoSession(), null, "缺字段的残留条目按无会话处理");
  storage.setStorageSync("home-memory:photo-session", "这不是对象");
  assert.equal(ps.getUnfinishedPhotoSession(), null, "非对象载荷按无会话处理");
  storage.setStorageSync("home-memory:photo-session", null);
  assert.equal(ps.getUnfinishedPhotoSession(), null, "null 载荷按无会话处理");
});

/* ---------------- PS-8:会话作用域捕获(PR #67 B1) ---------------- */

test("PS-8:开批时捕获家庭作用域——切家庭后旧批载荷里的 scope 不变(会话归属启动家庭)", function () {
  var storage = setup();
  // 开批前捕获家庭 A(generation=1)
  householdScope.captureHouseholdId("hh_aaa111111111111111111111111111111", null);
  var payload = ps.startPhotoSession(
    { localPath: "wxfile://tmp/a.jpg", imgW: 1024, imgH: 768, fileId: null },
    [makeRow("A 家的批", true)],
    "书房抽屉",
  );
  assert.deepEqual(payload.scope, {
    householdId: "hh_aaa111111111111111111111111111111",
    generation: 1,
  }, "开批时捕获 household_id 与作用域代数");
  assert.equal(ps.capturePhotoSessionScope().householdId, "hh_aaa111111111111111111111111111111");

  // 会话期内切到 B 家:旧批(键隔离不可达)载荷里的 scope 仍是 A;A 家新读回归属不变
  householdScope.captureHouseholdId("hh_bbb222222222222222222222222222222", null);
  householdScope.__resetHouseholdScopeForTest();
  householdScope.captureHouseholdId("hh_aaa111111111111111111111111111111", null);
  var restored = ps.getUnfinishedPhotoSession();
  assert.equal(restored.scope.householdId, "hh_aaa111111111111111111111111111111", "会话归属不随当前作用域漂移");
  assert.equal(restored.scope.generation, 1);
});

test("PS-8b:未捕获作用域开批 → scope.householdId=null;旧版残留(无 scope 字段)按未捕获回退;scope 损坏整条视同不存在", function () {
  var storage = setup();
  var payload = ps.startPhotoSession(
    { localPath: "wxfile://tmp/c.jpg", imgW: 1, imgH: 1, fileId: null },
    [makeRow("未捕获批", false)],
    "玄关",
  );
  assert.deepEqual(payload.scope, { householdId: null, generation: 0 }, "单人回退:householdId=null");

  // 旧版本残留(无 scope 字段):合法载荷,scope 按未捕获回退
  var legacy = {
    batchId: "legacy-batch-0001",
    file: { localPath: "wxfile://tmp/l.jpg", imgW: 1, imgH: 1, fileId: null },
    batchLocation: "书房",
    rows: [makeRow("旧版批", true)],
    createdAt: Date.now(),
  };
  storage.setStorageSync("home-memory:photo-session", legacy);
  var restored = ps.getUnfinishedPhotoSession();
  assert.notEqual(restored, null, "旧版载荷仍可恢复(向后兼容)");
  assert.deepEqual(restored.scope, { householdId: null, generation: 0 }, "缺 scope 按未捕获回退");

  // scope 存在但损坏:整条视同不存在(不进渲染/保存路径)
  legacy.scope = { householdId: 123, generation: 0 };
  storage.setStorageSync("home-memory:photo-session", legacy);
  assert.equal(ps.getUnfinishedPhotoSession(), null, "损坏 scope → 整条载荷视同不存在");
  legacy.scope = { householdId: "hh_x", generation: -2 };
  storage.setStorageSync("home-memory:photo-session", legacy);
  assert.equal(ps.getUnfinishedPhotoSession(), null, "非法 generation → 整条载荷视同不存在");
});
