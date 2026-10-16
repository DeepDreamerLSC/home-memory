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

test("PI-6:photoCloudPath——photo-evidence/{scopeId}/{yyyyMM}/{uuid}.jpg", function () {
  householdScope.__resetHouseholdScopeForTest();
  assert.equal(
    pi.photoCloudPath("default", new Date("2026-10-17T08:00:00.000Z"), "u1"),
    "photo-evidence/default/202610/u1.jpg",
    "未捕获作用域用 default(§10.4)",
  );
  assert.equal(
    pi.photoCloudPath("hh_x9", new Date("2026-01-02T00:00:00.000Z"), "u2"),
    "photo-evidence/hh_x9/202601/u2.jpg",
    "月份两位补零",
  );
  householdScope.captureHouseholdId("hh_abc", null);
  // commitPhotoBatch 内部用 householdScopeId();此处只验证取值口径
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
