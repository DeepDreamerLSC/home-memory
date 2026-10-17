"use strict";

/**
 * 拍照识物确认页(pages/photo,#3,屏①-⑤)离线测试(makePageFrom 模式):
 * 被测对象是 `npm run build:mp` 产出的 miniprogram/pages/photo/photo.js。
 * 零网络、零外部依赖、绝不 require wx-server-sdk;wx/cloud 全 stub,
 * modal 类 stub 防御性回调 success(绝不 no-op 挂死 await)。
 *
 * 覆盖(IMPLEMENTATION.md §8 验收清单 + §5/§7 降级):
 * - PP-LOAD:拍照→压缩→base64 直传 vlRecognize(事件形状:无 file_id)→候选上屏;
 *   确认保存前零上传(uploadFile 绝不被调);
 * - PP-STATE:三态流转(勾选/全选清空不动 done/步进器同步备注)、计数单一来源、
 *   证据条默认折叠/点候选行展开+高亮、框标签前缀同步;
 * - PP-VOICE:语音逐字段(部分勾选/0 勾选禁用/勾选态不变/needs_pick 点选重放/
 *   add/batch_location/intent=none/AI_UNAVAILABLE 降级/原话回听);
 * - PP-SAVE:保存确认派生(例外只含已勾选)→确认后先上传再 photoCommit→done 终态;
 *   上传失败零残留/部分失败可重试/重试不重复上传;
 * - PP-FALLBACK:VL unavailable 仍进页面手动添加/invalid_photo 留在入口;
 * - PP-CIRCLE:圈选画框→region 事件→结果卡→「加进清单」才入列且未勾选;失败零影响;
 * - PP-RESUME:中途退出会话保留,?resume=1 恢复(draftId/幂等键不变)。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");
var photoSession = require("../miniprogram/utils/photo-session.js");
var photoIntake = require("../miniprogram/utils/photo-intake.js");
var householdScope = require("../miniprogram/utils/household-scope.js");
var cache = require("../miniprogram/utils/locations-cache.js");
var intakeDraft = require("../miniprogram/utils/intake-draft.js");

/* ---------------- wx 桩(先装好再 require 页面产物) ---------------- */

function makeRouter(opts) {
  opts = opts || {};
  return function router(name, data) {
    if (name === "extractDraft" && data.action === "vlRecognize") {
      if (opts.vlError) {
        return opts.vlError;
      }
      return (
        opts.vlResponse || {
          ok: true,
          engine: "vl-local",
          items: [
            { name: "黄色薯片罐", qty_note: "", confidence: "high", box: { x1: 0.273, y1: 0.389, x2: 0.593, y2: 0.507 } },
            { name: "黑色小盒子", qty_note: "", confidence: "low", box: { x1: 0.868, y1: 0.79, x2: 0.982, y2: 0.873 } },
          ],
          img_w: 1024,
          img_h: 768,
        }
      );
    }
    if (name === "extractDraft" && data.action === "draftEditParse") {
      if (opts.editError) {
        return { ok: false, error: "AI_UNAVAILABLE", message: "AI 暂时不可用,可手动录入" };
      }
      return opts.editResponse || null; // null = 测试忘了配,按意外失败爆出
    }
    if (name === "itemsApi" && data.action === "photoCommit") {
      if (opts.commitThrow) {
        return Promise.reject(new Error(opts.commitThrow));
      }
      if (opts.commitScopeMismatch) {
        // PR #67 B1:服务端判定会话家庭 ≠ 当前派生家庭
        return { ok: false, error: "SCOPE_MISMATCH", message: "家庭已切换,本批未保存" };
      }
      var fails = opts.commitFailIndexes || [];
      return {
        ok: true,
        results: data.items.map(function (it, i) {
          return fails.indexOf(i) !== -1
            ? { index: i, ok: false, error: "OPERATION_CONFLICT", message: "这条已保存过且内容与当前填写不同" }
            : { index: i, ok: true, item_id: "it-" + i, duplicated: false, evidence_saved: true };
        }),
      };
    }
    return Promise.reject(new Error("意外调用 " + name + ":" + (data && data.action)));
  };
}

function makeEnv(opts) {
  opts = opts || {};
  var env = {
    toasts: [],
    modals: [],
    backs: [],
    uploads: [],
    vlCalls: [],
    editCalls: [],
    commitCalls: [],
    audioCtx: [],
    router: makeRouter(opts),
  };
  var storage = new Map();
  env.wx = {
    getStorageSync: function (k) {
      return storage.has(k) ? storage.get(k) : "";
    },
    setStorageSync: function (k, v) {
      storage.set(k, v);
    },
    removeStorageSync: function (k) {
      storage.delete(k);
    },
    chooseMedia: function (o) {
      if (opts.chooseFail) {
        o.fail({ errMsg: opts.chooseFail });
        return;
      }
      o.success({ tempFiles: [{ tempFilePath: "wxfile://tmp/shot.jpg" }] });
    },
    getImageInfo: function (o) {
      o.success({ width: 1024, height: 768 });
    },
    compressImage: function (o) {
      if (opts.compressFail) {
        o.fail({ errMsg: "compressImage:fail" });
        return;
      }
      o.success({ tempFilePath: "wxfile://tmp/compressed.jpg" });
    },
    getFileSystemManager: function () {
      return {
        readFile: function (o) {
          o.success({ data: "QQ==" });
        },
        access: function (o) {
          if (opts.sessionFileGone) {
            o.fail({ errMsg: "access:fail" });
          } else {
            o.success({});
          }
        },
      };
    },
    showToast: function (o) {
      env.toasts.push(o.title);
    },
    showModal: function (o) {
      env.modals.push(o);
      // 防御性回调:默认按「取消」结算,绝不挂死 await
      if (typeof opts.onModal === "function") {
        opts.onModal(o);
        return;
      }
      o.success({ confirm: false, cancel: true, content: "" });
    },
    navigateBack: function (o) {
      env.backs.push(o);
    },
    navigateTo: function () {},
    createInnerAudioContext: function () {
      var ctx = { src: "", playCalls: 0, play: function () { ctx.playCalls += 1; } };
      env.audioCtx.push(ctx);
      return ctx;
    },
    cloud: {
      callFunction: function (o) {
        var data = JSON.parse(JSON.stringify(o.data));
        if (data.action === "vlRecognize") {
          env.vlCalls.push(data);
        } else if (data.action === "draftEditParse") {
          env.editCalls.push(data);
        } else if (data.action === "photoCommit") {
          env.commitCalls.push(data);
        }
        Promise.resolve()
          .then(function () {
            return env.router(o.name, data);
          })
          .then(
            function (result) {
              if (result === null) {
                o.fail({ errMsg: "router: no editResponse configured" });
                return;
              }
              o.success({ result: result });
            },
            function (err) {
              o.fail({ errMsg: String((err && err.message) || err) });
            },
          );
      },
      uploadFile: function (o) {
        env.uploads.push({ cloudPath: o.cloudPath, filePath: o.filePath });
        if (opts.uploadFail) {
          o.fail({ errMsg: "uploadFile:fail" });
          return;
        }
        o.success({ fileID: "cloud://test-bucket/evidence-1.jpg" });
      },
    },
  };
  return env;
}

/* ---------------- 页面装载(makePageFrom 模式) ---------------- */

var pageOptions = null;
globalThis.Page = function (options) {
  pageOptions = options;
};

function install(env) {
  globalThis.wx = env.wx;
}

var env0 = makeEnv({});
install(env0);
require(path.join(ROOT, "miniprogram/pages/photo/photo.js"));

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
  };
}

function setPath(obj, key, value) {
  var parts = key.replace(/\]/g, "").split(/[.[]/);
  var cur = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/** 页面实例:data 深拷贝 + setData 路径语法 + 非函数实例字段(数值/引用)重建 */
function makePage() {
  var page = {
    data: JSON.parse(JSON.stringify(pageOptions.data)),
    setData: function (patch) {
      Object.keys(patch).forEach(function (k) {
        if (k.indexOf(".") === -1 && k.indexOf("[") === -1) {
          page.data[k] = patch[k];
        } else {
          setPath(page.data, k, patch[k]);
        }
      });
    },
  };
  Object.keys(pageOptions).forEach(function (k) {
    if (k === "data" || typeof pageOptions[k] === "function") {
      return;
    }
    var v = pageOptions[k];
    page[k] = Array.isArray(v) ? [] : v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v));
  });
  Object.keys(pageOptions)
    .filter(function (k) {
      return typeof pageOptions[k] === "function";
    })
    .forEach(function (k) {
      page[k] = pageOptions[k];
    });
  return page;
}

function settle(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms === undefined ? 30 : ms);
  });
}

/** 每用例干净开始:模块单例复位 + 全新 wx 环境;返回已 onLoad 的页面。
 *  opts.sessionStorage:跨 boot 共享的会话存储(恢复场景:第一个页面持久化、
 *  第二个页面 resume 读取,模拟进程回收走持久层)。 */
async function boot(opts, loadOptions) {
  opts = opts || {};
  var env = makeEnv(opts);
  install(env);
  photoSession.__resetPhotoSessionForTest();
  photoSession.__setPhotoSessionStorageForTest(opts.sessionStorage || makeFakeStorage());
  householdScope.__resetHouseholdScopeForTest();
  cache.__resetLocationsCacheForTest();
  photoIntake.__setPhotoIntakeDepsForTest(null);
  var page = makePage();
  page.onLoad(loadOptions === undefined ? {} : loadOptions);
  await settle();
  return { page: page, env: env };
}

function toastTexts(env) {
  return env.toasts.join("|");
}

function findRow(page, name) {
  return page.rowsRaw.filter(function (r) {
    return r.name === name;
  })[0];
}

/* ---------------- PP-LOAD:拍照→识别→上屏(隐私红线) ---------------- */

test("PP-LOAD-1:拍照→压缩→base64 直传 vlRecognize(无 file_id)→候选上屏;确认前零上传", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  var env = ctx.env;

  assert.equal(page.data.entryReady, true, "识别完成进入核对页");
  assert.equal(page.data.recognizing, false);
  assert.equal(page.data.photoCollapsed, true, "照片默认折叠为证据条");
  assert.equal(page.data.photoPath, "wxfile://tmp/compressed.jpg", "页面持有的是压缩产物(上传同一张)");
  assert.equal(page.data.imgW, 1024);
  assert.equal(page.data.imgH, 768);
  assert.equal(page.data.photoAspect, "1024 / 768", "容器等比跟随原图(aspect-ratio)");
  assert.equal(page.data.navSubtitle, "识别到 2 个候选,全部待你核对 · AI 预选了 1 个");

  assert.equal(page.rowsRaw.length, 2);
  assert.equal(page.rowsRaw[0].checked, true, "confidence=high 默认勾选(AI 预选)");
  assert.equal(page.rowsRaw[1].checked, false, "low 默认不勾");

  assert.equal(page.data.headText, "保留 1 / 2(待核对)", "计数单一来源");
  assert.equal(page.data.saveText, "存 1 件");
  assert.equal(page.data.saveDisabled, false);

  assert.equal(env.vlCalls.length, 1, "首次整图识别恰好一次");
  var ev = env.vlCalls[0];
  assert.equal(ev.action, "vlRecognize");
  assert.equal(ev.image_base64, "QQ==", "本地压缩图 base64 直传载荷");
  assert.equal(ev.img_w, 1024);
  assert.equal(ev.img_h, 768);
  assert.equal("file_id" in ev, false, "识别事件绝无 file_id(隐私红线)");

  // 框视图:低可信黄虚线,坐标 0-1 → 百分比
  assert.equal(page.data.boxViews.length, 2);
  assert.equal(page.data.boxViews[0].cls, "", "非 low 框为墨实线(AI 预选)");
  assert.equal(page.data.boxViews[1].cls, "amber", "confidence=low 黄虚线");
  assert.equal(page.data.boxViews[0].left, 27.3);
  assert.equal(page.data.boxViews[0].tag, "保留·黄色薯片罐", "框标签前缀随行状态同步");

  assert.equal(env.uploads.length, 0, "确认保存之前绝不上传(云端零残留)");
  assert.equal(env.commitCalls.length, 0);
});

test("PP-LOAD-2:点候选行=展开照片+该框脉冲高亮;点角标收起回证据条", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  var row = page.rowsRaw[1];

  page.onRowTap({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.data.photoCollapsed, false, "点候选行展开全幅");
  assert.equal(page.data.highlightId, row.draftId, "该候选框脉冲高亮");
  assert.equal(page.data.boxViews[1].isHl, true, "框高亮随展开生效");
  assert.equal(page.data.rows[1].isHl, true, "行高亮");
  assert.equal(page.data.edit !== null, true, "点行同时打开手动编辑面板(屏④)");

  page.onAskChipTap();
  assert.equal(page.data.photoCollapsed, true, "点角标收起回证据条");
  assert.equal(page.data.highlightId, "");
  assert.equal(page.data.boxViews[1].isHl, false, "折叠时框不高亮");

  // 点框反向高亮行
  page.onPhotoTap();
  page.onBoxTap({ currentTarget: { dataset: { id: row.draftId } } });
  assert.equal(page.data.rows[1].isHl, true);
});

/* ---------------- PP-STATE:三态流转 ---------------- */

test("PP-STATE-1:勾选/取消三态流转 + 步进器同步备注(qty+suffix 单一来源)", async function () {
  var ctx = await boot({});
  var page = ctx.page;

  page.onCheckTap({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.rowsRaw[1].checked, true, "候选→保留");
  assert.equal(page.data.headText, "保留 2 / 2(待核对)");
  assert.equal(page.data.saveText, "存 2 件");

  page.onStepTap({ currentTarget: { dataset: { index: 1, d: 1 } } });
  assert.equal(page.rowsRaw[1].qty, 2);
  assert.equal(page.data.rows[1].noteText, "×2 备注", "屏幕数字与草稿同一份数据");
  assert.equal(page.data.rows[1].metaText.indexOf("×2 备注") !== -1, true);

  page.onStepTap({ currentTarget: { dataset: { index: 1, d: -1 } } });
  page.onStepTap({ currentTarget: { dataset: { index: 1, d: -1 } } });
  assert.equal(page.rowsRaw[1].qty, 1, "下限 1(原型 Math.max(1,…))");

  page.onCheckTap({ currentTarget: { dataset: { index: 0 } } });
  page.onCheckTap({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.data.headText, "保留 0 / 2(待核对)");
  assert.equal(page.data.saveText, "存 0 件");
  assert.equal(page.data.saveDisabled, true, "0 勾选禁用保存");
});

test("PP-STATE-2:全选/清空不动 done 行;done 是终态不可再勾", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  // 造一个已入库行(row0 done;row1 未勾)
  page.rowsRaw[0] = intakeDraft.markRowSaved(page.rowsRaw[0]);
  page.rebuildRows();

  page.onToggleAllTap(); // 有未勾行(row1)→ 全选
  assert.equal(page.rowsRaw[1].checked, true);
  assert.equal(page.rowsRaw[0].done, true, "done 行不受全选影响");
  assert.equal(page.rowsRaw[0].checked, true, "done 行勾选态保持");
  page.onToggleAllTap(); // 全勾了 → 清空
  assert.equal(page.rowsRaw[1].checked, false);
  assert.equal(page.rowsRaw[0].done, true, "done 行不受清空影响");
  assert.equal(page.rowsRaw[0].checked, true, "done 行勾选态仍保持(终态)");

  page.rowsRaw[1] = intakeDraft.markRowSaved(page.rowsRaw[1]);
  page.rebuildRows();
  assert.equal(page.data.headText, "已确认记住 2 件 · 本批完成");
  assert.equal(page.data.saveText, "✓ 已入库");
  assert.equal(page.data.saveDisabled, true);
  page.onCheckTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.rowsRaw[0].checked, true, "done 行勾选态锁定(终态)");
  assert.equal(page.data.rows[0].stateLabel, "已记住");
  assert.equal(page.data.boxViews[0].tag, "已记住·黄色薯片罐", "框标签同步终态");
});

/* ---------------- PP-VOICE:语音受限编辑(§5 全链) ---------------- */

function editResponseFor(targetDraftId, edits) {
  return {
    ok: true,
    engine: "local",
    intent: "edit",
    target: { draft_id: targetDraftId, matched_word: "品客的薯片罐" },
    edits: edits,
    needs_pick: false,
    picks: [],
  };
}

async function driveVoice(ctx, page, resp) {
  ctx.env.router = function (name, data) {
    if (name === "extractDraft" && data.action === "draftEditParse") {
      return resp;
    }
    return makeRouter({})(name, data);
  };
  await page.handleRouteExtract("第3个是品客的薯片罐,已经空了,放厨房去", {
    scopeGen: householdScope.captureScopeGeneration(),
    abortEpoch: 0,
  });
  await settle();
}

test("PP-VOICE-1:转写→diff 弹层逐字段勾选——部分勾选只应用勾选的,勾选态不变,src=voice", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  var target = page.rowsRaw[0]; // 黄色薯片罐(勾选态)
  var beforeChecked = target.checked;
  page.lastAudioPath = "/tmp/voice-keep.mp3"; // onTranscript 在真实链路先于 routeExtract 到达

  await driveVoice(ctx, page, editResponseFor(target.draftId, [
    { field: "name", old: "黄色薯片罐", new: "品客薯片罐" },
    { field: "qty_note", old: "×1 备注", new: "×1(空罐)" },
    { field: "location", old: "玄关柜·第二层", new: "厨房" },
  ]));

  var d = page.data.diff;
  assert.notEqual(d, null);
  assert.equal(d.intent, "edit");
  assert.equal(d.lockIndex, 1, "锁定提示按当前清单 #d{n} 展示");
  assert.equal(d.lockName, "黄色薯片罐");
  assert.equal(d.edits.length, 3);
  assert.equal(d.pickedCount, 3);
  assert.equal(d.applyText, "应用勾选的 3 处");
  assert.equal(d.edits[0].label, "名称");
  assert.equal(d.edits[1].label, "数量备注");
  assert.equal(d.edits[2].label, "位置(例外,不继承批次)");
  assert.equal(d.audioAvailable, true, "原话已保留可回听标记");

  // 原话回听:InnerAudioContext.src = 本次录音临时文件
  page.onDiffPlayTap();
  assert.equal(ctx.env.audioCtx.length, 1);
  assert.equal(ctx.env.audioCtx[0].src, "/tmp/voice-keep.mp3");
  assert.equal(ctx.env.audioCtx[0].playCalls, 1);

  // 取消勾选「数量备注」:只应用其余两处
  page.onDiffFieldToggle({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.data.diff.pickedCount, 2);
  assert.equal(page.data.diff.applyText, "应用勾选的 2 处");
  page.onDiffApplyTap();

  var after = findRow(page, "品客薯片罐");
  assert.notEqual(after, null, "名称已应用");
  assert.equal(after.qty, 1, "数量备注未勾选 → qty 不动");
  assert.equal(after.suffix, "备注", "suffix 不动");
  assert.equal(after.exc, "厨房", "位置只改这一件的例外");
  assert.equal(after.checked, beforeChecked, "语音应用绝不改勾选(保留)状态");
  assert.equal(after.src, "voice");
  assert.equal(page.data.diff, null, "应用后关 sheet");
  assert.ok(toastTexts(ctx.env).indexOf("改好了 2 处") !== -1);
  // 行与框标签同步重渲染
  assert.equal(page.data.boxViews[0].tag, "保留·品客薯片罐");
});

test("PP-VOICE-2:0 勾选禁用;「念错了,当我没说」零改动", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  var target = page.rowsRaw[0];
  await driveVoice(ctx, page, editResponseFor(target.draftId, [
    { field: "name", old: "黄色薯片罐", new: "品客薯片罐" },
  ]));

  page.onDiffFieldToggle({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.diff.applyText, "一项都没勾");
  assert.equal(page.data.diff.applyDisabled, true, "N=0 时禁用");
  page.onDiffApplyTap();
  assert.equal(findRow(page, "黄色薯片罐").name, "黄色薯片罐", "0 勾选不执行");
  assert.notEqual(page.data.diff, null, "禁用时不关 sheet");

  page.onDiffCancelTap();
  assert.equal(page.data.diff, null);
  assert.equal(findRow(page, "黄色薯片罐").name, "黄色薯片罐", "当我没说=零改动");
  assert.ok(toastTexts(ctx.env).indexOf("好,当我没说") !== -1);
});

test("PP-VOICE-3:needs_pick 点选=新输入,只带所选候选重放一次;期间不执行修改", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  var first = page.rowsRaw[0];
  var second = page.rowsRaw[1];
  await driveVoice(ctx, page, {
    ok: true,
    engine: "local",
    intent: "edit",
    target: null,
    edits: [],
    needs_pick: true,
    picks: [
      { draft_id: first.draftId, name: first.name },
      { draft_id: second.draftId, name: second.name },
    ],
  });
  var d = page.data.diff;
  assert.equal(d.needsPick, true);
  assert.equal(d.picks.length, 2);
  assert.equal(d.applyDisabled, true, "点选层无应用按钮语义");

  ctx.env.router = function (name, data) {
    if (name === "extractDraft" && data.action === "draftEditParse") {
      ctx.editSeen = data;
      return editResponseFor(second.draftId, [
        { field: "name", old: "黑色小盒子", new: "黑色收纳盒" },
      ]);
    }
    return makeRouter({})(name, data);
  };
  page.onDiffPickTap({ currentTarget: { dataset: { id: second.draftId } } });
  await settle();

  assert.equal(ctx.editSeen.candidates.length, 1, "重放只带所选候选");
  assert.equal(ctx.editSeen.candidates[0].draft_id, second.draftId);
  assert.equal(ctx.editSeen.text, "第3个是品客的薯片罐,已经空了,放厨房去", "同一句转写重放");
  var d2 = page.data.diff;
  assert.equal(d2.needsPick, false);
  assert.equal(d2.lockName, "黑色小盒子");
  assert.equal(findRow(page, "黑色小盒子").name, "黑色小盒子", "点选期间不执行任何修改");
});

test("PP-VOICE-4:intent=add 补一件(未勾选/无框/src=voice);batch_location 改批次不动例外", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  page.setBatchLocationText("玄关柜 · 第二层抽屉");
  page.rowsRaw[0] = { ...page.rowsRaw[0], exc: "书房" };
  page.rebuildRows();

  await driveVoice(ctx, page, {
    ok: true,
    engine: "local",
    intent: "add",
    added: { name: "五号电池", qty_note: "还有几节" },
    needs_pick: false,
    picks: [],
  });
  assert.equal(page.data.diff.intent, "add");
  assert.equal(page.data.diff.addName, "五号电池");
  page.onDiffApplyTap();
  var added = findRow(page, "五号电池");
  assert.notEqual(added, null);
  assert.equal(added.checked, false, "入列默认不勾选");
  assert.equal(added.box, null, "无框(整照关联)");
  assert.equal(added.src, "voice");
  assert.equal(page.data.rows.length, 3);
  assert.equal(page.data.headText, "保留 1 / 3(待核对)", "计数联动");

  await driveVoice(ctx, page, {
    ok: true,
    engine: "local",
    intent: "batch_location",
    new_location: "客厅电视柜",
    needs_pick: false,
    picks: [],
  });
  assert.equal(page.data.diff.intent, "batch_location");
  page.onDiffApplyTap();
  assert.equal(page.data.batchLocation, "客厅电视柜");
  assert.equal(page.rowsRaw[0].exc, "书房", "已设例外的候选不受影响(例外仍是例外)");
});

test("PP-VOICE-5:intent=none 只 toast 不弹 sheet;AI_UNAVAILABLE 同降级", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  await driveVoice(ctx, page, { ok: true, engine: "local", intent: "none", needs_pick: false, picks: [] });
  assert.equal(page.data.diff, null, "none 不弹 sheet");
  assert.ok(toastTexts(ctx.env).indexOf("没听懂这句,换个说法或手动改") !== -1);
  assert.equal(ctx.env.editCalls.length, 1);

  await driveVoice(ctx, page, { ok: false, error: "AI_UNAVAILABLE", message: "AI 暂时不可用" });
  assert.equal(page.data.diff, null);
  assert.ok(toastTexts(ctx.env).indexOf("没听懂,可手动点行编辑") !== -1, "不可用降级不弹 diff");
});

test("PP-VOICE-6:转写在途家庭切换 → 迟到结果不上屏(作用域代数复核)", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  var gen = householdScope.captureScopeGeneration();
  householdScope.captureHouseholdId("hh_switched"); // 代数递增
  await page.handleRouteExtract("第3个是品客的薯片罐", { scopeGen: gen, abortEpoch: 0 });
  await settle();
  assert.equal(page.data.diff, null, "迟到 diff 不上屏");
  assert.equal(page.data.diffLoading, false);
});

/* ---------------- PP-SAVE:保存确认→上传→photoCommit→终态 ---------------- */

async function readyToSave(ctx, page) {
  page.setBatchLocationText("玄关柜 · 第二层抽屉");
  page.onSaveTap();
  await settle();
}

test("PP-SAVE-1:确认弹层例外只含已勾选件;确认→先上传后 photoCommit→done 终态+会话清除", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  // #1 勾选(high 预选);#2 未勾选(low)——例外给两边都设上,只有已勾选件的进确认清单
  page.rowsRaw[1] = { ...page.rowsRaw[1], exc: "阳台" };
  page.rebuildRows();
  await readyToSave(ctx, page);

  var s = page.data.saveSheet;
  assert.notEqual(s, null);
  assert.equal(s.batchLocation, "玄关柜 · 第二层抽屉");
  assert.equal(s.exceptionLines.length, 0, "已勾选件(#1)无例外 → 例外清单为空");
  assert.equal(s.exceptionText, "无例外,全部继承本批位置");
  assert.equal(s.summaryText, "保留 1 件写入 · 未勾选 1 件不保存");

  // 给 #1(已勾选)加例外再开一次:例外只含已勾选件
  page.onSaveBackTap();
  page.rowsRaw[0] = { ...page.rowsRaw[0], exc: "厨房" };
  page.rebuildRows();
  page.onSaveTap();
  assert.equal(page.data.saveSheet.exceptionLines.length, 1);
  assert.equal(page.data.saveSheet.exceptionLines[0], "📍 #d1 黄色薯片罐 → 厨房");
  assert.equal(
    JSON.stringify(page.data.saveSheet.exceptionLines).indexOf("阳台") === -1,
    true,
    "未勾选件的例外绝不进确认清单(V0.4.2 终审)",
  );

  assert.equal(ctx.env.uploads.length, 0, "打开确认弹层仍零上传");
  await page.onSaveGoTap();
  await settle();

  assert.equal(ctx.env.uploads.length, 1, "确认后本批首次且唯一的上云动作");
  assert.equal(ctx.env.uploads[0].filePath, "wxfile://tmp/compressed.jpg", "上传识别用的同一张压缩图");
  assert.match(
    ctx.env.uploads[0].cloudPath,
    /^photo-evidence\/default\/\d+-[\w-]+\.jpg$/,
    "上传路径约定:photo-evidence/{家庭}/{时间戳}-{随机}.jpg(PR #67 B2)",
  );

  assert.equal(ctx.env.commitCalls.length, 1);
  var ev = ctx.env.commitCalls[0];
  assert.equal(ev.action, "photoCommit");
  assert.equal(ev.items.length, 1, "未勾选件不提交");
  assert.equal(ev.items[0].name, "黄色薯片罐");
  assert.equal(ev.items[0].location_text, "厨房", "例外优先(客户端已合成)");
  assert.equal(ev.items[0].note, "×1 备注");
  assert.equal(ev.items[0].photo.file_id, "cloud://test-bucket/evidence-1.jpg");
  assert.equal(ev.items[0].photo.img_w, 1024);
  assert.equal(ev.items[0].photo.img_h, 768);
  assert.deepEqual(ev.items[0].photo.box, { x1: 0.273, y1: 0.389, x2: 0.593, y2: 0.507 });

  assert.equal(page.rowsRaw[0].done, true, "成功行进终态");
  assert.equal(page.rowsRaw[1].done, false, "未勾选行不入库");
  assert.equal(page.data.headText, "已确认记住 1 件 · 本批完成");
  assert.equal(page.data.saveText, "✓ 已入库");
  assert.equal(page.data.saveDisabled, true);
  assert.equal(page.data.saveSheet, null);
  assert.ok(toastTexts(ctx.env).indexOf("都记住了 · 1 件已入库") !== -1);
  assert.equal(photoSession.getUnfinishedPhotoSession(), null, "全部入库清 photo 会话");
  assert.equal(page.data.boxViews[0].tag, "已记住·黄色薯片罐", "框标签同步已记住");
  assert.equal(page.data.boxViews[1].tag, "候选·黑色小盒子", "未勾选行仍是候选");
});

test("PP-SAVE-2:上传失败 → 整批不提交、云端零残留、会话保留可重试", async function () {
  var ctx = await boot({ uploadFail: true });
  var page = ctx.page;
  await readyToSave(ctx, page);
  await page.onSaveGoTap();
  await settle();

  assert.equal(ctx.env.uploads.length, 1, "尝试过一次上传");
  assert.equal(ctx.env.commitCalls.length, 0, "上传失败绝不调 photoCommit");
  assert.equal(page.rowsRaw.every(function (r) { return !r.done; }), true, "无行落终态");
  assert.equal(page.data.saveSheet, null);
  assert.ok(toastTexts(ctx.env).indexOf("照片上传失败") !== -1);
  assert.notEqual(photoSession.getUnfinishedPhotoSession(), null, "会话保留(恢复入口在)");
});

test("PP-SAVE-3:部分失败不拦其余件——失败行标红可重试,重试不重复上传", async function () {
  var ctx = await boot({ commitFailIndexes: [1] });
  var page = ctx.page;
  page.onCheckTap({ currentTarget: { dataset: { index: 1 } } });
  await readyToSave(ctx, page);
  await page.onSaveGoTap();
  await settle();

  assert.equal(page.rowsRaw[0].done, true, "成功行照常终态");
  assert.equal(page.rowsRaw[1].done, false);
  assert.notEqual(page.rowsRaw[1].failMsg, "", "失败行标红文案");
  assert.equal(page.data.headText, "已确认记住 1 件 · 本批完成");
  assert.equal(page.data.saveText, "重试存 1 件", "失败可重试入口保持可用");
  assert.equal(page.data.saveDisabled, false);
  assert.ok(toastTexts(ctx.env).indexOf("1 件没存上") !== -1);

  // 重试:fileId 已取得 → 不重复上传;operation_id 沿用收敛
  var firstOpId = page.rowsRaw[1].operationId;
  ctx.env.router = makeRouter({});
  page.onSaveTap();
  assert.equal(page.data.saveSheet.summaryText, "保留 1 件写入 · 未勾选 0 件不保存");
  await page.onSaveGoTap();
  await settle();
  assert.equal(ctx.env.uploads.length, 1, "重试不重复上传(fileId 随会话保留)");
  assert.equal(ctx.env.commitCalls.length, 2);
  assert.equal(ctx.env.commitCalls[1].items.length, 1, "重试只带失败行");
  assert.equal(ctx.env.commitCalls[1].items[0].operation_id, firstOpId, "幂等键沿用");
  assert.equal(page.rowsRaw[1].done, true, "重试成功落终态");
});

test("PP-SAVE-4:批次位置未填 → 先提示填位置,不弹确认层;0 勾选 → 禁用提示", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  page.onCheckTap({ currentTarget: { dataset: { index: 0 } } });
  page.onCheckTap({ currentTarget: { dataset: { index: 1 } } });
  page.onSaveTap();
  assert.equal(page.data.saveSheet, null, "位置为空不开确认弹层");
  assert.ok(toastTexts(ctx.env).indexOf("先填这批默认放哪儿") !== -1);
  assert.equal(ctx.env.modals.length, 1, "顺势弹位置填写");

  page.rowsRaw = page.rowsRaw.map(function (r) { return { ...r, checked: false }; });
  page.rebuildRows();
  page.setBatchLocationText("书房");
  page.onSaveTap();
  assert.equal(page.data.saveSheet, null, "0 勾选禁用");
  assert.ok(toastTexts(ctx.env).indexOf("先勾选要保留的候选") !== -1);
});

/* ---------------- PP-FALLBACK:VL 不可用/照片超限 ---------------- */

test("PP-FB-1:VL unavailable → modal 确认仍进页面,空候选+手动添加照常入库链路", async function () {
  var ctx = await boot({
    vlError: { ok: false, error: "AI_UNAVAILABLE", message: "拍照识别暂不可用,可手动添加", manual_fallback: true },
    onModal: function (o) {
      o.success({ confirm: true, cancel: false, content: "" });
    },
  });
  var page = ctx.page;
  assert.equal(page.data.entryReady, true, "确认后仍进 photo 页");
  assert.equal(page.rowsRaw.length, 0, "候选清单为空");
  assert.ok(page.data.navSubtitle.indexOf("暂不可用") !== -1);
  assert.equal(ctx.env.uploads.length, 0, "照片仍只是本地临时文件(未上传)");

  // 手动添加一件:编辑面板新行 → 未勾选候选
  page.onManualAddTap();
  assert.equal(page.data.edit.isNew, true);
  page.onEditNameInput({ detail: { value: "备用钥匙" } });
  page.onEditStepTap({ currentTarget: { dataset: { d: 1 } } });
  page.onEditLocInput({ detail: { value: "玄关抽屉" } });
  page.onEditConfirmTap();
  var row = findRow(page, "备用钥匙");
  assert.notEqual(row, null);
  assert.equal(row.checked, false);
  assert.equal(row.src, "manual");
  assert.equal(row.qty, 2);
  // 手动行照常保存(box=null 整照关联)
  page.onCheckTap({ currentTarget: { dataset: { index: 0 } } });
  page.setBatchLocationText("玄关柜");
  page.onSaveTap();
  await page.onSaveGoTap();
  await settle();
  assert.equal(ctx.env.commitCalls.length, 1);
  assert.equal(ctx.env.commitCalls[0].items[0].name, "备用钥匙");
  assert.equal(ctx.env.commitCalls[0].items[0].photo.box, null);
  assert.equal(ctx.env.commitCalls[0].items[0].photo.source, "vl");
  assert.equal(page.rowsRaw[0].done, true);
});

test("PP-FB-2:invalid_photo(照片太大)→ toast 重拍、留在入口态", async function () {
  var ctx = await boot({ vlError: { ok: false, error: "INVALID_INPUT", message: "照片参数不合法" } });
  var page = ctx.page;
  assert.equal(page.data.entryReady, false, "留在入口");
  assert.ok(toastTexts(ctx.env).indexOf("照片太大,请重拍") !== -1);
  assert.equal(ctx.env.uploads.length, 0);
  assert.equal(page.data.entryHint, "");
});

test("PP-FB-3:拍照两次都取消 → 返回上一页", async function () {
  var ctx = await boot({ chooseFail: "chooseMedia:fail cancel" });
  var page = ctx.page;
  assert.equal(page.data.entryReady, false);
  assert.equal(ctx.env.backs.length, 1, "两次都取消返回上一页(§7.3)");
});

/* ---------------- PP-CIRCLE:圈选补识别(屏⑤) ---------------- */

test("PP-CIRCLE-1:画框→region 识别→结果卡;点「加进清单」才入列且未勾选", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  var before = page.rowsRaw.length;

  page.onEnterCircle();
  await settle();
  assert.equal(page.data.mode, "circle");
  assert.equal(page.prepared.ok, true, "圈选复用同一 prepared(不重复读盘)");

  // 容器几何 fallback(无 SelectorQuery):{0,0,375,281};触点即容器 px
  page.onCircleTouchStart({ touches: [{ clientX: 60, clientY: 200 }] });
  page.onCircleTouchMove({ touches: [{ clientX: 150, clientY: 268 }] });
  assert.equal(page.data.circle.drawing, true);
  assert.equal(page.data.circle.rect.width, 90);
  await page.onCircleTouchEnd();
  await settle();

  assert.equal(ctx.env.vlCalls.length, 2, "第二次调用是圈选 region");
  var ev = ctx.env.vlCalls[1];
  assert.equal(ev.mode, "region");
  assert.equal(ev.image_base64, "QQ==", "复用同一 base64");
  assert.ok(Math.abs(ev.region.x1 - 60 / 375) < 0.001, "触点反算 0-1(containPointToNormalized)");
  assert.ok(Math.abs(ev.region.y1 - 200 / 281) < 0.001);
  assert.equal(ev.region.x2 > ev.region.x1, true);
  assert.equal(ev.region.y2 <= 1, true, "信箱边外 clamp 到 [0,1]");

  assert.notEqual(page.data.circle.result, null, "结果卡上屏");
  assert.equal(page.data.circle.result.name, "黄色薯片罐");

  page.onCircleAddTap();
  assert.equal(page.data.mode, "confirm", "入列后回核对模式");
  assert.equal(page.rowsRaw.length, before + 1, "点「加进清单」才入列");
  var added = page.rowsRaw[page.rowsRaw.length - 1];
  assert.equal(added.checked, false, "入列 = 未勾选候选");
  assert.equal(added.src, "circle");
  assert.notEqual(added.box, null, "沿用用户圈选框");
  assert.equal(page.data.headText, "保留 1 / 3(待核对)", "保存计数联动");
  assert.ok(toastTexts(ctx.env).indexOf("已加为候选(未勾选)") !== -1);
});

test("PP-CIRCLE-2:圈选识别失败 → 失败文案+重圈;已有候选零影响;圈太小不发起", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  assert.equal(page.rowsRaw.length, 2, "主识别候选已上屏");
  page.onEnterCircle();
  await settle();
  // 圈选请求改走失败桩(已有候选零影响的关键前提:主清单已定)
  ctx.env.router = makeRouter({
    vlError: { ok: false, error: "AI_UNAVAILABLE", message: "拍照识别暂不可用,可手动添加" },
  });
  page.onCircleTouchStart({ touches: [{ clientX: 60, clientY: 200 }] });
  page.onCircleTouchMove({ touches: [{ clientX: 150, clientY: 268 }] });
  await page.onCircleTouchEnd();
  await settle();
  assert.equal(page.data.circle.errorText, "拍照识别暂不可用,可手动添加");
  assert.equal(page.data.circle.result, null);
  assert.equal(page.rowsRaw.length, 2, "已有候选零影响(原型 resetCircle 语义)");
  assert.equal(page.data.mode, "circle", "留在圈选模式可重圈");
  page.onCircleResetTap();
  assert.equal(page.data.circle.errorText, "");

  // 圈太小:不发起识别
  var calls = ctx.env.vlCalls.length;
  page.onCircleTouchStart({ touches: [{ clientX: 60, clientY: 200 }] });
  page.onCircleTouchMove({ touches: [{ clientX: 66, clientY: 206 }] });
  await page.onCircleTouchEnd();
  await settle();
  assert.equal(ctx.env.vlCalls.length, calls, "误触小框不调云函数");
});

/* ---------------- PP-EDIT:手动编辑面板(屏④) ---------------- */

test("PP-EDIT-1:名称候选点选改类/位置例外/提醒日期;勾选态与幂等键不动", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  var target = page.rowsRaw[0];
  page.setBatchLocationText("玄关柜 · 第二层抽屉");
  var opId = target.operationId;

  page.openEditSheet(target.draftId);
  var ed = page.data.edit;
  assert.equal(ed.title, "改一下 · #d1");
  assert.equal(ed.sourceText, "来源:照片识别 · 置信度高");
  assert.equal(ed.nameChips.length >= 1, true, "名称候选点选区=清单其他候选名+保持");
  assert.equal(ed.locValue, "玄关柜 · 第二层抽屉", "位置默认继承批次");

  // 点候选名改类
  var chip = ed.nameChips[0];
  page.onEditChipTap({ currentTarget: { dataset: { name: chip.name } } });
  assert.equal(page.data.edit.nameInput, chip.name);
  // 位置例外 + 数量 + 提醒
  page.onEditStepTap({ currentTarget: { dataset: { d: 2 } } }); // 非法增量忽略
  assert.equal(page.data.edit.qty, 1);
  page.onEditStepTap({ currentTarget: { dataset: { d: 1 } } });
  page.onEditLocInput({ detail: { value: "厨房" } });
  page.onEditDateChange({ detail: { value: "2026-11-20" } });
  assert.equal(page.data.edit.hasRemind, true);
  page.onEditKindChange({ detail: { value: 0 } });
  page.onEditConfirmTap();

  var after = findRow(page, chip.name);
  assert.notEqual(after, null, "名称已按候选词改类");
  assert.equal(after.qty, 2);
  assert.equal(after.exc, "厨房", "与批次不同才记例外");
  assert.equal(after.checked, target.checked, "手动编辑绝不改勾选态");
  assert.equal(after.operationId, opId, "幂等键沿用");
  assert.equal(after.remind.due_date, "2026-11-20");
  assert.equal(after.remind.kind, "有效期");

  // 位置与批次相同 → 例外清空(继承)
  page.openEditSheet(after.draftId);
  page.onEditLocInput({ detail: { value: "玄关柜 · 第二层抽屉" } });
  page.onEditConfirmTap();
  assert.equal(findRow(page, chip.name).exc, null, "改回批次位置=继承");
});

test("PP-EDIT-2:手动加一件名称必填;「保持:现名」chip 一键回原名", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  page.onManualAddTap();
  page.onEditConfirmTap();
  assert.equal(page.rowsRaw.length, 2, "空名称不加行");
  assert.ok(toastTexts(ctx.env).indexOf("名称不能为空") !== -1);

  page.onEditNameInput({ detail: { value: "胶带" } });
  page.onEditConfirmTap();
  assert.equal(page.rowsRaw.length, 3);
  var row = findRow(page, "胶带");
  assert.equal(row.checked, false);

  var target = page.rowsRaw[0];
  page.openEditSheet(target.draftId);
  page.onEditChipTap({ currentTarget: { dataset: { name: "黑色小盒子" } } });
  page.onEditChipTap({ currentTarget: { dataset: { name: "保持:黑色小盒子" } } });
  assert.equal(page.data.edit.nameInput, "黑色小盒子", "保持 chip 回到现名");
});

test("PP-EDIT-3:done 终态行不得提供看似生效的修改路径(#65 边界三)", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  // 造终态:全批成功后面板路径 + 部分失败会话恢复后同形(rowsRaw[0] 落「已确认记住」)
  page.rowsRaw[0] = intakeDraft.markRowSaved(page.rowsRaw[0]);
  page.rebuildRows();

  // 点终态行:仍展开照片+脉冲高亮(只读查看),但绝不打开编辑面板
  page.onRowTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.photoCollapsed, false, "终态行点开仍展开照片(只读查看)");
  assert.equal(page.data.highlightId, page.rowsRaw[0].draftId, "框脉冲高亮照常");
  assert.equal(page.data.edit, null, "终态行不打开手动编辑面板");

  // 防御门:openEditSheet 直调同样不开
  page.openEditSheet(page.rowsRaw[0].draftId);
  assert.equal(page.data.edit, null);

  // 防御门:非终态行面板开着时落终态 →「就这么改」关面板、行零改动、绝不 toast「改好了」
  page.openEditSheet(page.rowsRaw[1].draftId);
  assert.notEqual(page.data.edit, null, "非终态行照常打开");
  page.onEditNameInput({ detail: { value: "改名试探" } });
  page.rowsRaw[1] = intakeDraft.markRowSaved(page.rowsRaw[1]);
  page.rebuildRows();
  var toastsBefore = ctx.env.toasts.length;
  page.onEditConfirmTap();
  assert.equal(page.data.edit, null, "面板关闭");
  assert.equal(page.rowsRaw[1].name, "黑色小盒子", "终态行零改动(改了也永不进保存)");
  assert.equal(ctx.env.toasts.length, toastsBefore, "绝不 toast「改好了」假回执");

  // 对照:新增非终态行,点行/编辑/确认照常生效(门只拦终态)
  page.onManualAddTap();
  page.onEditNameInput({ detail: { value: "胶带" } });
  page.onEditConfirmTap();
  var tape = page.rowsRaw.length - 1;
  page.onRowTap({ currentTarget: { dataset: { index: tape } } });
  assert.notEqual(page.data.edit, null, "非终态行点行照常打开编辑面板");
  page.onEditConfirmTap();
  assert.equal(page.rowsRaw[tape].name, "胶带");
  assert.ok(toastTexts(ctx.env).indexOf("改好了") !== -1, "非终态行照常回执");
});

/* ---------------- PP-RESUME:会话恢复 ---------------- */

test("PP-RESUME-1:中途退出保留会话;?resume=1 恢复(draftId/幂等键/位置不变)", async function () {
  var sessionStorage = makeFakeStorage();
  var ctx = await boot({ sessionStorage: sessionStorage });
  var page = ctx.page;
  page.setBatchLocationText("玄关柜 · 第二层抽屉");
  page.rowsRaw[1] = { ...page.rowsRaw[1], exc: "厨房" };
  page.onStepTap({ currentTarget: { dataset: { index: 1, d: 1 } } });
  page.persistSession();
  var snapshot = page.rowsRaw.map(function (r) { return { d: r.draftId, o: r.operationId, c: r.checked }; });

  // 新页面实例恢复(进程回收场景:走共享持久层)
  var ctx2 = await boot({ sessionStorage: sessionStorage }, { resume: "1" });
  var page2 = ctx2.page;
  assert.equal(page2.data.entryReady, true);
  assert.equal(page2.data.photoPath, "wxfile://tmp/compressed.jpg");
  assert.equal(page2.data.batchLocation, "玄关柜 · 第二层抽屉");
  assert.equal(page2.rowsRaw.length, 2);
  assert.deepEqual(
    page2.rowsRaw.map(function (r) { return { d: r.draftId, o: r.operationId, c: r.checked }; }),
    snapshot,
    "draftId/幂等键/勾选态逐字段恢复",
  );
  assert.equal(page2.rowsRaw[1].exc, "厨房");
  assert.equal(page2.rowsRaw[1].qty, 2);
  assert.equal(page2.data.headText, "保留 1 / 2(待核对)");
  // 恢复后保存照常走上传+photoCommit
  await readyToSave(ctx2, page2);
  await page2.onSaveGoTap();
  await settle();
  assert.equal(ctx2.env.commitCalls.length, 1);
  assert.equal(page2.rowsRaw[0].done, true);
});

test("PP-RESUME-2:恢复时本地临时文件已被清理 → 如实提示重拍、清会话", async function () {
  var sessionStorage = makeFakeStorage();
  var ctx = await boot({ sessionStorage: sessionStorage });
  var page = ctx.page;
  page.persistSession();

  var ctx2 = await boot(
    {
      sessionStorage: sessionStorage,
      sessionFileGone: true,
      vlResponse: { ok: true, engine: "vl-local", items: [], img_w: 1024, img_h: 768 },
    },
    { resume: "1" },
  );
  await settle(80);
  assert.ok(toastTexts(ctx2.env).indexOf("上次的照片已被系统清理") !== -1, "如实提示重拍,不编造");
  // 清会话后走新拍照链路(chooseMedia 成功 → 重新识别上屏;空候选)
  assert.equal(ctx2.page.data.entryReady, true);
  assert.equal(ctx2.page.rowsRaw.length, 0);
  assert.notEqual(photoSession.getUnfinishedPhotoSession(), null, "新批已重新开会话");
});

/* ---------------- PP-LOC:位置栏 ---------------- */

test("PP-LOC-1:批次位置手输;常用快选隐藏(未验证作用域)", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  assert.equal(page.data.recentLocations.length, 0, "未验证作用域不读缓存");

  var modalContent = "客厅电视柜 · 第一层";
  ctx.env.wx.showModal = function (o) {
    ctx.env.modals.push(o);
    o.success({ confirm: true, cancel: false, content: modalContent });
  };
  page.onBatchLocEditTap();
  assert.equal(page.data.batchLocation, "客厅电视柜 · 第一层", "手输生效");

  modalContent = ""; // 空内容:如实拒绝,不写空位置
  page.onNewLocTap();
  assert.equal(ctx.env.modals.length, 2);
  assert.equal(page.data.batchLocation, "客厅电视柜 · 第一层", "空位置不改");
  assert.ok(toastTexts(ctx.env).indexOf("位置不能为空") !== -1);
});

/* ---------------- PP-STATIC:静态守卫(源码契约) ---------------- */

test("PP-STATIC-1:wxml 渲染结构契约(三态徽标/框语义/CTA 文案在册)", function () {
  var fs = require("node:fs");
  var wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/photo/photo.wxml"), "utf8");
  [
    "点开照片核对", // 证据条 chip
    "证据区 · 框在展开后显示",
    "这批候选默认都在哪?", // 位置栏
    "按住说位置",
    "候选默认继承这个位置,例外在编辑里逐件改;保存前会再让你确认一次",
    "一条记录 = 一件可查找的物品", // 横幅
    "全选 / 清空",
    "按住说话",
    "松开,去核对", // recsheet
    "上滑取消 · 取消就当没说过,什么都不记",
    "念错了,当我没说",
    "已锁定候选", // diff 锁定提示
    "按内容锁定,不按行号",
    "保存前最后确认", // 保存确认
    "再看看",
    "确认,记住了",
    "用手指在照片上画一个框", // 圈选
    "不是,重圈",
    "加进清单(候选)",
    "手动添加物品",
  ].forEach(function (text) {
    assert.ok(wxml.indexOf(text) !== -1, "wxml 应含文案:" + text);
  });
});

test("PP-STATIC-2:页面编译产物绝无 uploadFile 直调(上传唯一入口在 photo-intake)", function () {
  var fs = require("node:fs");
  var src = fs.readFileSync(path.join(ROOT, "miniprogram/pages/photo/photo.js"), "utf8");
  assert.equal(src.indexOf("uploadFile"), -1, "photo 页不直接触上传,只经 commitPhotoBatch");
  assert.notEqual(src.indexOf("commitPhotoBatch"), -1);
});

/* ---------------- PP-SCOPE:家庭切换竞态(PR #67 B1) ---------------- */

test("PP-SCOPE-1:会话期内作用域变化(A 家开批→切 B 家)→ 确认被拦:零上传零提交、终止会话、返回首页", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  // 首个会话在未捕获作用域下开批;现在捕获 A 家,重拍开一个 A 家会话
  householdScope.captureHouseholdId("hh_pageaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", null);
  page.onEntryShotTap();
  await settle();
  assert.equal(page.sessionScope.householdId, "hh_pageaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", "会话归属开批家庭");
  assert.equal(page.rowsRaw.length, 2);

  // 会话期内切到 B 家 → 填位置、点保存:客户端前置拦截
  householdScope.captureHouseholdId("hh_pagebbbbbbbbbbbbbbbbbbbbbbbbbbbb1", null);
  page.setBatchLocationText("B 家的抽屉");
  page.onSaveTap();
  await settle();

  assert.equal(page.data.saveSheet, null, "确认弹层绝不打开");
  assert.equal(ctx.env.uploads.length, 0, "零上传(不发起注定失败的写入)");
  assert.equal(ctx.env.commitCalls.length, 0, "零 photoCommit");
  assert.ok(toastTexts(ctx.env).indexOf("家庭已切换,本批未保存") !== -1, "统一终局文案");
  assert.ok(ctx.env.backs.length >= 1, "返回首页(navigateBack)");
  assert.equal(page.batchFinished, true, "会话终止:onUnload 不再回写复活旧批");
  // 会话在 A 家键下被真正清除(回 A 家不再出现恢复横幅)
  householdScope.__resetHouseholdScopeForTest();
  householdScope.captureHouseholdId("hh_pageaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", null);
  assert.equal(photoSession.getUnfinishedPhotoSession(), null, "开批家庭的会话键已清");

  // 再点确认(迟到手势)也不得进入提交流程
  page.onSaveGoTap();
  await settle();
  assert.equal(ctx.env.commitCalls.length, 0, "终局后绝不重试写另一个家");
});

test("PP-SCOPE-2:服务端 SCOPE_MISMATCH 回执 → 终止会话返回首页,绝不重试写另一家", async function () {
  var ctx = await boot({ commitScopeMismatch: true });
  var page = ctx.page;
  await readyToSave(ctx, page);
  await page.onSaveGoTap();
  await settle();

  assert.equal(ctx.env.commitCalls.length, 1, "发起过一次提交(客户端未拦住的服务端硬拒)");
  assert.equal(ctx.env.commitCalls[0].expected_household_id, undefined, "未捕获作用域不带 marker(单人宽松)");
  assert.ok(toastTexts(ctx.env).indexOf("家庭已切换,本批未保存") !== -1, "终止文案");
  assert.ok(ctx.env.backs.length >= 1, "返回首页");
  assert.equal(page.batchFinished, true);
  assert.equal(page.rowsRaw.every(function (r) { return !r.done; }), true, "无行落终态(零写入)");
  assert.equal(photoSession.getUnfinishedPhotoSession(), null, "会话清除,不保留失败重试入口");
  // 再点保存:确认层已关、会话已终止,不得再发起提交
  page.onSaveTap();
  await settle();
  assert.equal(ctx.env.commitCalls.length, 1, "绝不重试写另一个家");
});

test("PP-SCOPE-3:会话家庭与当前作用域一致(未切换)→ 保存照常,携带 expected_household_id", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  householdScope.captureHouseholdId("hh_pagecccccccccccccccccccccccccccc1", null);
  page.onEntryShotTap();
  await settle();
  page.setBatchLocationText("客厅电视柜");
  page.onSaveTap();
  await settle();
  assert.notEqual(page.data.saveSheet, null, "无漂移不拦,确认层照常打开");
  await page.onSaveGoTap();
  await settle();
  assert.equal(ctx.env.commitCalls.length, 1);
  assert.equal(
    ctx.env.commitCalls[0].expected_household_id,
    "hh_pagecccccccccccccccccccccccccccc1",
    "一致性绑定随事件上送(会话家庭)",
  );
  assert.equal(ctx.env.uploads[0].cloudPath.indexOf("photo-evidence/hh_pagecccccccccccccccccccccccccccc1/"), 0, "上传前缀=会话家庭");
  assert.equal(page.rowsRaw[0].done, true, "照常入库");
});
