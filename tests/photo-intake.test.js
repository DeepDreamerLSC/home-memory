"use strict";

/**
 * 拍照识物页面侧编排(utils/photo-intake,#3)离线测试:
 * 被测对象是 `npm run build:mp` 产出的 miniprogram/utils/photo-intake.js。
 * 零网络、零外部依赖、绝不 require wx-server-sdk;wx API 全注入。
 *
 * 覆盖(IMPLEMENTATION.md §4.1 ①③④ / §7.3 / §7.6 / §10.4):
 * - takePhoto:成功路径(tempFiles[0])、用户直接取消、授权被拒分类
 *   (去设置 / 从相册选兜底 / 相册再取消=放弃);
 * - buildPhotoCommitItems:例外优先/批次位置兜底、note=×{qty} {suffix}、
 *   photo 绑定与 source(circle=用户圈选,其余=vl)、提醒映射、无提醒不带;
 * - photoCloudPath:photo-evidence/{scopeId}/{yyyyMM}/{uuid}.jpg;
 * - commitPhotoBatch:fileId 为 null 先上传再提交(顺序);上传失败整批不提交、
 *   云端零残留;fileId 已取得则复用不重复上传;photoCommit 抛错如实回带 fileId;
 * - 隐私红线:确认保存之前绝不上传(commitPhotoBatch 之外无任何 uploadFile 路径)。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var pi = require("../miniprogram/utils/photo-intake.js");
var intakeDraft = require("../miniprogram/utils/intake-draft.js");
var householdScope = require("../miniprogram/utils/household-scope.js");

var seq = 0;
function genId() {
  seq += 1;
  return "id-" + String(seq).padStart(3, "0");
}

function makeRow(overrides) {
  return intakeDraft.makeAiRow(
    Object.assign(
      { name: "黄色薯片罐", qty_note: "", confidence: "high", box: { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.5 } },
      overrides || {},
    ),
    genId,
  );
}

/** 注入面收集器:chooseMedia/showModal/openSetting/uploadFile/recognize/commit */
function makeEnv(opts) {
  opts = opts || {};
  var env = {
    chooseCalls: [],
    modalCalls: [],
    openSettingCalls: [],
    uploads: [],
    commits: [],
    recognizeCalls: [],
    chooseBehavior: opts.chooseBehavior || "ok", // ok | user-cancel | auth-deny | album-cancel
  };
  var deps = {
    chooseMedia: function (o) {
      env.chooseCalls.push(o);
      var b = env.chooseBehavior;
      if (b === "ok") {
        o.success({ tempFiles: [{ tempFilePath: "wxfile://tmp/photo.jpg" }] });
        return;
      }
      if (b === "user-cancel") {
        o.fail({ errMsg: "chooseMedia:fail cancel" });
        return;
      }
      if (b === "auth-deny") {
        // 第一次(带 camera)报权限;相册重试(album-only)按 album 结果
        if (o.sourceType && o.sourceType.indexOf("album") !== -1 && o.sourceType.indexOf("camera") === -1) {
          if (opts.albumResult === "ok") {
            o.success({ tempFiles: [{ tempFilePath: "wxfile://tmp/from-album.jpg" }] });
          } else {
            o.fail({ errMsg: "chooseMedia:fail cancel" });
          }
          return;
        }
        o.fail({ errMsg: "chooseMedia:fail auth deny" });
        return;
      }
      if (b === "album-cancel") {
        o.fail({ errMsg: "chooseMedia:fail cancel" });
      }
    },
    showModal: function (o) {
      env.modalCalls.push(o);
      o.success({ confirm: opts.modalConfirm === true, cancel: opts.modalConfirm !== true });
    },
    openSetting: function (o) {
      env.openSettingCalls.push(o);
      if (o.success) {
        o.success();
      }
    },
    getSetting: function (o) {
      o.success({ authSetting: { "scope.camera": opts.cameraAuth } });
    },
    uploadFile: function (o) {
      env.uploads.push({ cloudPath: o.cloudPath, filePath: o.filePath });
      if (opts.uploadFail === true) {
        o.fail({ errMsg: "uploadFile:fail" });
        return;
      }
      o.success({ fileID: opts.uploadFileId || "cloud://bucket/photo-1.jpg" });
    },
    recognize: function (tempPath) {
      env.recognizeCalls.push(tempPath);
      return Promise.resolve(
        opts.recognizeResult || {
          ok: true,
          prepared: { ok: true, path: tempPath, imgW: 1024, imgH: 768, base64: "QQ==", compressed: true },
          items: [{ name: "电池", qty_note: "", confidence: "high", box: null }],
          truncated: false,
        },
      );
    },
    commit: function (event) {
      env.commits.push(JSON.parse(JSON.stringify(event)));
      if (opts.commitThrows) {
        return Promise.reject(opts.commitThrows);
      }
      if (opts.commitError) {
        return Promise.reject(new Error(opts.commitError));
      }
      return Promise.resolve(
        opts.commitResult || {
          ok: true,
          results: event.items.map(function (it, i) {
            return { index: i, ok: true, item_id: "it-" + i, duplicated: false, evidence_saved: true };
          }),
        },
      );
    },
    uuid: function () {
      env.uuidSeq = (env.uuidSeq || 0) + 1;
      return "uuid-" + env.uuidSeq;
    },
    now: function () {
      return opts.now || new Date("2026-10-17T08:00:00.000Z");
    },
  };
  env.deps = deps;
  pi.__setPhotoIntakeDepsForTest(deps);
  return env;
}

test.afterEach(function () {
  pi.__setPhotoIntakeDepsForTest(null);
});

/* ---------------- takePhoto(§7.3 授权失败分类) ---------------- */

test("PI-1:takePhoto 成功——camera+album/compressed/image,首张临时路径如实返回", async function () {
  var env = makeEnv();
  var r = await pi.takePhoto();
  assert.deepEqual(r, { ok: true, tempFilePath: "wxfile://tmp/photo.jpg" });
  assert.equal(env.chooseCalls.length, 1);
  var call = env.chooseCalls[0];
  assert.equal(call.count, 1);
  assert.deepEqual(call.mediaType, ["image"]);
  assert.deepEqual(call.sizeType, ["compressed"]);
  assert.deepEqual(call.sourceType, ["camera", "album"]);
});

test("PI-2:用户直接取消(非权限)→ kind=cancel,不弹任何授权 modal", async function () {
  var env = makeEnv({ chooseBehavior: "user-cancel" });
  var r = await pi.takePhoto();
  assert.deepEqual(r, { ok: false, kind: "cancel" });
  assert.equal(env.modalCalls.length, 0, "普通取消不进权限分类");
});

test("PI-3:权限被拒 → modal「需要相机权限」;选「从相册选」兜底成功(相册无需授权)", async function () {
  var env = makeEnv({ chooseBehavior: "auth-deny", modalConfirm: false, albumResult: "ok" });
  var r = await pi.takePhoto();
  assert.deepEqual(r, { ok: true, tempFilePath: "wxfile://tmp/from-album.jpg" });
  assert.equal(env.modalCalls.length, 1);
  assert.equal(env.modalCalls[0].title, "需要相机权限");
  assert.equal(env.modalCalls[0].confirmText, "去设置");
  assert.equal(env.modalCalls[0].cancelText, "从相册选");
  assert.equal(env.chooseCalls.length, 2, "第二次只带 album");
  assert.deepEqual(env.chooseCalls[1].sourceType, ["album"]);
  assert.equal(env.openSettingCalls.length, 0);
});

test("PI-3b:权限被拒 → 选「去设置」→ openSetting,kind=auth(页面留在入口)", async function () {
  var env = makeEnv({ chooseBehavior: "auth-deny", modalConfirm: true });
  var r = await pi.takePhoto();
  assert.deepEqual(r, { ok: false, kind: "auth" });
  assert.equal(env.openSettingCalls.length, 1);
});

test("PI-3c:权限被拒 → 从相册选又取消(两次都取消)→ kind=cancel", async function () {
  var env = makeEnv({ chooseBehavior: "auth-deny", modalConfirm: false, albumResult: "cancel" });
  var r = await pi.takePhoto();
  assert.deepEqual(r, { ok: false, kind: "cancel" });
});

test("PI-4:ensurePhotoAuth——scope.camera 三态如实返回", async function () {
  assert.equal(await pi.ensurePhotoAuth(makeEnv({ cameraAuth: true }).deps), "authorized");
  assert.equal(await pi.ensurePhotoAuth(makeEnv({ cameraAuth: false }).deps), "denied");
  assert.equal(await pi.ensurePhotoAuth(makeEnv({ cameraAuth: undefined }).deps), "prompt");
});

/* ---------------- buildPhotoCommitItems(纯函数) ---------------- */

test("PI-5:buildPhotoCommitItems——例外优先/批次兜底/note 拼接/photo 绑定与 source", function () {
  var rows = [
    makeRow({ name: "品客薯片罐" }), // 无例外 → 批次位置
    Object.assign(makeRow({ name: "黑色耳机" }), { exc: "厨房" }), // 例外
    Object.assign(makeRow({ name: "圈选物", confidence: "low" }), { src: "circle", box: { x1: 0.06, y1: 0.69, x2: 0.29, y2: 0.93 }, checked: false }),
    Object.assign(makeRow({ name: "带提醒的" }), { remind: { due_date: "2026-11-20", kind: "有效期" } }),
    Object.assign(makeRow({ name: "数量件", qty_note: "约2根" }, ), { qty: 2, suffix: "根" }),
  ];
  var items = pi.buildPhotoCommitItems(rows, "玄关柜 · 第二层抽屉", {
    file_id: "cloud://f1",
    img_w: 1024,
    img_h: 768,
  });
  assert.equal(items.length, 5);
  assert.equal(items[0].location_text, "玄关柜 · 第二层抽屉", "无例外继承批次位置");
  assert.equal(items[1].location_text, "厨房", "例外优先(客户端已合成)");
  assert.equal(items[0].note, "×1 备注", "note=×{qty} {suffix},空后缀按「备注」");
  assert.equal(items[4].note, "×2 根", "qty+suffix 单一来源拼接");
  assert.equal(items[0].photo.file_id, "cloud://f1");
  assert.equal(items[0].photo.img_w, 1024);
  assert.equal(items[0].photo.img_h, 768);
  assert.deepEqual(items[0].photo.box, { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.5 });
  assert.equal(items[0].photo.source, "vl", "AI 行 source=vl");
  assert.equal(items[2].photo.source, "circle", "圈选行 source=circle");
  assert.equal(items[3].reminder.due_date, "2026-11-20");
  assert.equal(items[3].reminder.kind, "有效期");
  assert.equal(items[3].reminder.remind_converted, false, "选择器日期非换算候选");
  assert.equal(items[0].reminder, undefined, "无提醒不带 reminder 字段");
  // 幂等键逐行透传(内容改后仍沿用)
  assert.equal(items[0].operation_id, rows[0].operationId);
  // 入参不被改动(纯函数)
  assert.equal(rows[1].exc, "厨房");
});

test("PI-6:photoCloudPath——photo-evidence/{scopeId}/{时间戳}-{随机}.jpg(PR #67 B2 上传路径约定)", function () {
  householdScope.__resetHouseholdScopeForTest();
  var t1 = new Date("2026-10-17T08:00:00.000Z");
  assert.equal(
    pi.photoCloudPath("default", t1, "u1"),
    "photo-evidence/default/" + t1.getTime() + "-u1.jpg",
    "未捕获作用域用 default;文件名=毫秒时间戳-随机id",
  );
  var t2 = new Date("2026-01-02T00:00:00.000Z");
  assert.equal(
    pi.photoCloudPath("hh_x9", t2, "u2"),
    "photo-evidence/hh_x9/" + t2.getTime() + "-u2.jpg",
    "scopeId 段=归属验证依据(会话开批家庭)",
  );
  householdScope.captureHouseholdId("hh_abc", null);
  // commitPhotoBatch 内部用会话家庭(PI-12);此处只验证取值口径
  assert.equal(householdScope.householdScopeId(), "hh_abc");
  householdScope.__resetHouseholdScopeForTest();
});

/* ---------------- commitPhotoBatch(§7.6 顺序与红线) ---------------- */

function commitInput(overrides) {
  return Object.assign(
    {
      batchId: "batch-0001",
      rows: [makeRow({ name: "电池" })],
      batchLocation: "玄关柜 · 第二层抽屉",
      localPath: "wxfile://tmp/compressed.jpg",
      imgW: 1024,
      imgH: 768,
      fileId: null,
    },
    overrides || {},
  );
}

test("PI-7:fileId=null → 先 uploadFile 再 photoCommit(顺序红线);成功回带 fileId", async function () {
  var env = makeEnv();
  var r = await pi.commitPhotoBatch(commitInput());
  assert.equal(r.ok, true);
  assert.equal(r.fileId, "cloud://bucket/photo-1.jpg");
  assert.equal(env.uploads.length, 1, "本批首次且唯一的上云动作");
  assert.equal(env.uploads[0].filePath, "wxfile://tmp/compressed.jpg", "上传识别用的同一张压缩图");
  assert.equal(env.commits.length, 1);
  assert.equal(env.commits[0].action, "photoCommit");
  assert.equal(env.commits[0].batch_id, "batch-0001");
  assert.equal(env.commits[0].items[0].photo.file_id, "cloud://bucket/photo-1.jpg");
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].ok, true);
});

test("PI-8:上传失败 → 整批不提交(云端零残留)、如实提示可重试", async function () {
  var env = makeEnv({ uploadFail: true });
  var r = await pi.commitPhotoBatch(commitInput());
  assert.equal(r.ok, false);
  assert.equal(r.stage, "upload");
  assert.equal(r.message, "照片上传失败,请重试");
  assert.equal(env.commits.length, 0, "上传失败绝不调 photoCommit");
});

test("PI-9:fileId 已取得 → 复用,绝不重复上传", async function () {
  var env = makeEnv();
  var r = await pi.commitPhotoBatch(commitInput({ fileId: "cloud://kept.jpg" }));
  assert.equal(r.ok, true);
  assert.equal(r.fileId, "cloud://kept.jpg");
  assert.equal(env.uploads.length, 0, "重试不重复上传(§7.6)");
  assert.equal(env.commits[0].items[0].photo.file_id, "cloud://kept.jpg");
});

test("PI-10:photoCommit 抛错 → stage=commit,已得 fileId 如实回带供重试收敛", async function () {
  var env = makeEnv({ commitError: "网络异常" });
  var r = await pi.commitPhotoBatch(commitInput());
  assert.equal(r.ok, false);
  assert.equal(r.stage, "commit");
  assert.equal(r.message, "网络异常");
  assert.equal(r.fileId, "cloud://bucket/photo-1.jpg", "fileId 不因 commit 失败丢弃");
  assert.equal(env.uploads.length, 1);
});

test("PI-11:0 行且无 fileId → 不上传不提交,如实拒绝(调用方 bug 防御)", async function () {
  var env = makeEnv();
  var r = await pi.commitPhotoBatch(commitInput({ rows: [] }));
  assert.equal(r.ok, false);
  assert.equal(r.stage, "commit");
  assert.equal(env.uploads.length, 0);
  assert.equal(env.commits.length, 0);
});

/* ---------------- 会话作用域一致性绑定(PR #67 B1) ---------------- */

test("PI-12:scopeHouseholdId 随事件上送(expected_household_id=开批家庭);null 不带;上传路径前缀用开批家庭而非当前作用域", async function () {
  householdScope.__resetHouseholdScopeForTest();
  householdScope.captureHouseholdId("hh_current00000000000000000000000000", null);
  var env = makeEnv();

  // 会话家庭 A(≠当前捕获的 hh_current):marker= A,cloudPath 前缀= A
  var r = await pi.commitPhotoBatch(
    commitInput({ scopeHouseholdId: "hh_sessionAAAAAAAAAAAAAAAAAAAAAAAAA" }),
  );
  assert.equal(r.ok, true);
  assert.equal(env.uploads[0].cloudPath.indexOf("photo-evidence/hh_sessionAAAAAAAAAAAAAAAAAAAAAAAAA/"), 0, "上传路径前缀=会话开批家庭");
  assert.equal(
    env.commits[0].expected_household_id,
    "hh_sessionAAAAAAAAAAAAAAAAAAAAAAAAA",
    "一致性绑定取会话家庭,不被当前作用域覆盖",
  );

  // scopeHouseholdId=null(开批时未捕获):不带 marker,路径前缀回退当前作用域
  var env2 = makeEnv();
  var r2 = await pi.commitPhotoBatch(commitInput({ scopeHouseholdId: null }));
  assert.equal(r2.ok, true);
  assert.equal("expected_household_id" in env2.commits[0], false, "未捕获不带 marker(不编造)");
  assert.equal(
    env2.uploads[0].cloudPath.indexOf("photo-evidence/hh_current00000000000000000000000000/") !== -1,
    true,
    "未捕获回退当前作用域前缀",
  );
  householdScope.__resetHouseholdScopeForTest();
});

test("PI-13:photoCommit 抛 ApiError(带 code,如 SCOPE_MISMATCH)→ outcome.error 如实回带,页面据此终局", async function () {
  var apiMod = require("../miniprogram/utils/api.js");
  var env = makeEnv({
    commitThrows: new apiMod.ApiError("SCOPE_MISMATCH", "家庭已切换,本批未保存"),
  });
  var r = await pi.commitPhotoBatch(commitInput({ scopeHouseholdId: "hh_sessionAAAAAAAAAAAAAAAAAAAAAAAAA" }));
  assert.equal(r.ok, false);
  assert.equal(r.stage, "commit");
  assert.equal(r.error, "SCOPE_MISMATCH", "服务端错误码透传(供页面终止会话)");
  assert.equal(r.message, "家庭已切换,本批未保存");
  assert.equal(r.fileId, "cloud://bucket/photo-1.jpg", "fileId 照常回带");

  // 普通错误(无 code)→ error 为 undefined,不影响既有重试语义
  var env2 = makeEnv({ commitError: "网络异常" });
  var r2 = await pi.commitPhotoBatch(commitInput());
  assert.equal(r2.error, undefined);
});

/* ---------------- PI-MOUNT:位置挂树(issue #65 V0.4 第③条) ---------------- */

test("PI-14:splitLocationSegments——分隔符「·」「/」「-」「的」与空白切分;空段丢弃;单段=单层", function () {
  assert.deepEqual(pi.splitLocationSegments("玄关柜 · 第二层抽屉"), ["玄关柜", "第二层抽屉"]);
  assert.deepEqual(pi.splitLocationSegments("客厅/电视柜/第一层"), ["客厅", "电视柜", "第一层"]);
  assert.deepEqual(pi.splitLocationSegments("厨房-吊柜"), ["厨房", "吊柜"]);
  assert.deepEqual(pi.splitLocationSegments("主卧的床头柜"), ["主卧", "床头柜"]);
  assert.deepEqual(pi.splitLocationSegments("客厅 电视柜"), ["客厅", "电视柜"], "空白也是分隔符");
  assert.deepEqual(pi.splitLocationSegments("  ·  玄关柜  ·  "), ["玄关柜"], "首尾/中间空段全部丢弃");
  assert.deepEqual(pi.splitLocationSegments("玄关柜"), ["玄关柜"], "单段=单层(直接挂根下房间)");
  assert.deepEqual(pi.splitLocationSegments("玄关柜·第二层·抽屉·深处·左边·里侧"), [
    "玄关柜", "第二层", "抽屉", "深处", "左边", "里侧",
  ], "恰好 6 段合法(与服务端路径上限一致)");
});

test("PI-15:splitLocationSegments——超 6 段 / 超 30 码点段 / 空文本一律空数组(不挂,绝不猜)", function () {
  assert.deepEqual(pi.splitLocationSegments(""), []);
  assert.deepEqual(pi.splitLocationSegments("   ·  ·  "), []);
  assert.deepEqual(
    pi.splitLocationSegments("a/b/c/d/e/f/g"),
    [],
    "7 段超路径上限 → 不挂(绝不静默丢段造错路径)",
  );
  var long31 = new Array(31 + 1).join("字"); // 31 码点
  assert.deepEqual(pi.splitLocationSegments(long31), [], "单段 31 码点超节点名上限 → 不挂(绝不截断改名)");
  var long30 = new Array(30 + 1).join("字"); // 恰 30 码点
  assert.deepEqual(pi.splitLocationSegments(long30), [long30], "恰 30 码点合法");
});

test("PI-16:planPhotoMounts——批次位置+例外去重分组;例外优先;update_id=photo:{operationId} 稳定;失败件/缺版本件不进", function () {
  var rows = [makeRow(), makeRow(), makeRow(), makeRow()];
  rows[1] = { ...rows[1], exc: "厨房" };
  rows[2] = { ...rows[2], exc: "客厅/电视柜" };
  var results = [
    { index: 0, ok: true, item_id: "it-0", version: 1 },
    { index: 1, ok: true, item_id: "it-1", version: 1 },
    { index: 2, ok: true, item_id: "it-2", version: 1 },
    { index: 3, ok: false, error: "OPERATION_CONFLICT" },
  ];
  var plan = pi.planPhotoMounts(rows, results, "玄关柜 · 第二层抽屉");
  assert.equal(plan.skipped, 0);
  assert.equal(plan.entries.length, 3, "批次位置 + 两个例外,按文本去重");
  var byLoc = {};
  plan.entries.forEach(function (e) { byLoc[e.locationText] = e; });
  assert.deepEqual(byLoc["玄关柜 · 第二层抽屉"].path, ["玄关柜", "第二层抽屉"]);
  assert.deepEqual(byLoc["厨房"].path, ["厨房"], "单段例外=单层");
  assert.deepEqual(byLoc["客厅/电视柜"].path, ["客厅", "电视柜"]);
  assert.equal(byLoc["玄关柜 · 第二层抽屉"].items.length, 1, "失败件(index 3)绝不进挂树计划");
  assert.equal(byLoc["玄关柜 · 第二层抽屉"].items[0].item_id, "it-0");
  assert.equal(byLoc["玄关柜 · 第二层抽屉"].items[0].expected_version, 1);
  assert.equal(byLoc["玄关柜 · 第二层抽屉"].items[0].update_id, "photo:" + rows[0].operationId);

  // 幂等键确定性:同一批行再计划一次,update_id 逐字节一致(重试/会话恢复同键收敛)
  var plan2 = pi.planPhotoMounts(rows, results, "玄关柜 · 第二层抽屉");
  assert.deepEqual(
    plan2.entries.map(function (e) { return e.items.map(function (it) { return it.update_id; }); }),
    plan.entries.map(function (e) { return e.items.map(function (it) { return it.update_id; }); }),
  );

  // 回执缺 version(旧云函数窗口)→ 不进 entries、计入 skipped;分段形状不合法同样计入
  var plan3 = pi.planPhotoMounts(
    [makeRow(), makeRow()],
    [
      { index: 0, ok: true, item_id: "it-x" }, // 无 version
      { index: 1, ok: true, item_id: "it-y", version: 1 },
    ],
    "a/b/c/d/e/f/g", // 7 段:形状不合法
  );
  assert.equal(plan3.entries.length, 0);
  assert.equal(plan3.skipped, 2, "无版本件 + 形状不合法位置下的件都如实计入 skipped");

  // exc 空串按批次位置兜底(与 buildPhotoCommitItems 合成口径一致)
  var plan4 = pi.planPhotoMounts(
    [{ ...makeRow(), exc: "  " }],
    [{ index: 0, ok: true, item_id: "it-z", version: 1 }],
    "玄关柜",
  );
  assert.equal(plan4.entries.length, 1);
  assert.equal(plan4.entries[0].locationText, "玄关柜");
});

test("PI-17:mountPhotoItems——逐位置逐件 ensureAndLink(created_from=manual);失败不回滚不抛,如实计数", async function () {
  var calls = [];
  var plan = {
    skipped: 0,
    entries: [
      {
        locationText: "玄关柜 · 第二层抽屉",
        path: ["玄关柜", "第二层抽屉"],
        items: [
          { item_id: "it-0", expected_version: 1, update_id: "photo:op-0" },
          { item_id: "it-1", expected_version: 1, update_id: "photo:op-1" },
        ],
      },
      { locationText: "厨房", path: ["厨房"], items: [{ item_id: "it-2", expected_version: 2, update_id: "photo:op-2" }] },
    ],
  };
  var outcome = await pi.mountPhotoItems(plan, {
    ensureAndLink: function (event) {
      calls.push(JSON.parse(JSON.stringify(event)));
      if (event.item_id === "it-1") {
        return Promise.reject(new Error("VERSION_CONFLICT"));
      }
      return Promise.resolve({ ok: true, already: false, item: { item_id: event.item_id, version: event.expected_version + 1, updated_at: "t" }, path: event.path, created: [], location_ids: [] });
    },
  });
  assert.equal(calls.length, 3, "逐件各一次(位置去重不减少调用次数)");
  assert.equal(outcome.attempted, 3);
  assert.equal(outcome.failed, 1, "一件失败如实计数,绝不抛错阻断其余件");
  assert.deepEqual(
    { action: calls[0].action, item_id: calls[0].item_id, path: calls[0].path, expected_version: calls[0].expected_version, update_id: calls[0].update_id, created_from: calls[0].created_from },
    { action: "ensureAndLink", item_id: "it-0", path: ["玄关柜", "第二层抽屉"], expected_version: 1, update_id: "photo:op-0", created_from: "manual" },
    "与语音确认流程同一 API 形状;手输位置拆层记 manual",
  );

  // 空计划零调用零失败
  var empty = await pi.mountPhotoItems({ entries: [], skipped: 0 }, { ensureAndLink: function () { throw new Error("绝不该调"); } });
  assert.deepEqual(empty, { attempted: 0, failed: 0 });
});

/* ---------------- PI-LOCPATH:planPhotoMounts 可选 cache(LLM 层级拆分优先) ---------------- */

test("PI-18:planPhotoMounts 可选 cache——缓存路径优先(无分隔符中文三段);无缓存走规则兜底;非法形状缓存回落规则", function () {
  var rows = [makeRow(), makeRow()];
  var results = [
    { index: 0, ok: true, item_id: "it-0", version: 1 },
    { index: 1, ok: true, item_id: "it-1", version: 1 },
  ];

  // 缓存命中:无分隔符中文「书房桌子右边抽屉」用 LLM 拆出的三段层级
  var cache = { "书房桌子右边抽屉": ["书房", "桌子", "右边抽屉"] };
  var plan = pi.planPhotoMounts(rows, results, "书房桌子右边抽屉", cache);
  assert.equal(plan.skipped, 0);
  assert.equal(plan.entries.length, 1);
  assert.deepEqual(plan.entries[0].path, ["书房", "桌子", "右边抽屉"], "LLM 拆分路径优先");

  // 无缓存:现行为不变(分隔符规则兜底 → 无分隔符中文整串单段平节点)
  var plan2 = pi.planPhotoMounts(rows, results, "书房桌子右边抽屉");
  assert.deepEqual(plan2.entries[0].path, ["书房桌子右边抽屉"], "无缓存走 splitLocationSegments 兜底");

  // 缓存形状非法(超 6 段/段超 30 码点)→ 回落规则(绝不挂越限路径)
  var long31 = new Array(31 + 1).join("字");
  var plan3 = pi.planPhotoMounts(
    [makeRow()],
    [{ index: 0, ok: true, item_id: "it-x", version: 1 }],
    "书房桌子右边抽屉",
    { "书房桌子右边抽屉": ["一", "二", "三", "四", "五", "六", "七"] },
  );
  assert.deepEqual(plan3.entries[0].path, ["书房桌子右边抽屉"], "7 段缓存越限 → 回落规则");
  var plan4 = pi.planPhotoMounts(
    [makeRow()],
    [{ index: 0, ok: true, item_id: "it-y", version: 1 }],
    long31,
    { "": [] }, // 键不命中(long31 无缓存)
  );
  assert.equal(plan4.entries.length, 0, "超长无分隔符文本规则兜底也拆不出 → 不挂(绝不截断改名)");
  var plan5 = pi.planPhotoMounts(
    [makeRow()],
    [{ index: 0, ok: true, item_id: "it-z", version: 1 }],
    long31,
    { [long31]: [long31] }, // 命中但段 31 码点越限
  );
  assert.equal(plan5.entries.length, 0, "越限段缓存绝不采用");

  // 例外位置同样吃缓存(文本级缓存,批次/例外同源)
  var rowsExc = [{ ...makeRow(), exc: "书房桌子右边抽屉" }, makeRow()];
  var plan6 = pi.planPhotoMounts(rowsExc, results, "玄关柜 · 第二层抽屉", cache);
  assert.equal(plan6.entries.length, 2);
  var byLoc = {};
  plan6.entries.forEach(function (e) { byLoc[e.locationText] = e; });
  assert.deepEqual(byLoc["书房桌子右边抽屉"].path, ["书房", "桌子", "右边抽屉"], "例外位置缓存命中");
  assert.deepEqual(byLoc["玄关柜 · 第二层抽屉"].path, ["玄关柜", "第二层抽屉"], "未命中文本走规则");

  // 空缓存对象/不传:行为与三参调用逐字节一致
  var plan7 = pi.planPhotoMounts(rows, results, "书房桌子右边抽屉", {});
  assert.deepEqual(plan7.entries[0].path, ["书房桌子右边抽屉"]);
});

