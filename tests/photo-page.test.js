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
      if (opts.vlDefer) {
        // C1 测试:识别挂起,由用例在「识别等待窗口」切家庭后再放行
        return new Promise(function (resolve) {
          opts.vlDefer.resolve = resolve;
        });
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
      // PR #67 C3:opts.commitEvidenceFailedIndexes 模拟「物品已建但证据写入失败」
      var evFailedIdx = opts.commitEvidenceFailedIndexes || [];
      return {
        ok: true,
        results: data.items.map(function (it, i) {
          return fails.indexOf(i) !== -1
            ? { index: i, ok: false, error: "OPERATION_CONFLICT", message: "这条已保存过且内容与当前填写不同" }
            : {
                index: i,
                ok: true,
                item_id: "it-" + i,
                duplicated: false,
                evidence_saved: evFailedIdx.indexOf(i) === -1,
                // #65 ③:建档后版本回执(挂树 expected_version 来源);
                // opts.commitVersionless=true 模拟旧云函数窗口(缺省 → 客户端跳过挂树)
                ...(opts.commitVersionless ? {} : { version: 1 }),
              };
        }),
        evidence_failed: evFailedIdx.map(function (i) {
          return "it-" + i;
        }),
      };
    }
    if (name === "locations" && data.action === "ensureAndLink") {
      // #65 ③:拍照位置挂树桩——默认成功;opts.mountError 模拟挂树失败
      // (VERSION_CONFLICT/网络等;失败不回滚不阻断,只轻提示)
      if (opts.mountError) {
        return Promise.reject(new Error(opts.mountError));
      }
      return {
        ok: true,
        already: false,
        item: { item_id: data.item_id, version: data.expected_version + 1, updated_at: "2026-10-16T00:00:00.000Z" },
        path: data.path,
        created: data.path.map(function () { return false; }),
        location_ids: data.path.map(function (_, i) { return "loc-" + i; }),
      };
    }
    if (name === "itemsApi" && data.action === "photoEvidenceRetry") {
      if (opts.retryThrow) {
        return Promise.reject(new Error(opts.retryThrow));
      }
      if (opts.retryError) {
        // PR #67 C3:服务端错误(如 EVIDENCE_WRITE_FAILED / FAMILY_SWITCHED)
        return { ok: false, error: opts.retryError, message: opts.retryMessage || "照片关联失败,请重试" };
      }
      return {
        ok: true,
        results: data.items.map(function (it, i) {
          return { index: i, item_id: it.item_id, ok: true, evidence_saved: true };
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
    retryCalls: [],
    mountCalls: [], // #65 ③:locations.ensureAndLink 挂树调用
    audioCtx: [],
    router: makeRouter(opts),
  };
  var storage = new Map();
  env.storage = storage;
  if (!opts.vlAuthReset) {
    // B4 默认模拟「老用户已授权识别临时传输」:既有用例不受授权弹窗影响;
    // opts.vlAuthReset=true 走首次授权路径(PP-AUTH-*)
    storage.set("home-memory:photo-vl-auth", "granted");
  }
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
        } else if (data.action === "photoEvidenceRetry") {
          env.retryCalls.push(data);
        } else if (data.action === "ensureAndLink") {
          env.mountCalls.push(data);
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

test("PP-FB-2:invalid_photo(照片过大,服务端大小门)→ toast 重拍、留在入口态", async function () {
  var ctx = await boot({ vlError: { ok: false, error: "INVALID_INPUT", message: "照片参数不合法" } });
  var page = ctx.page;
  assert.equal(page.data.entryReady, false, "留在入口");
  assert.ok(toastTexts(ctx.env).indexOf("照片过大,请靠近重拍") !== -1, "B5 统一文案");
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
    "按住说位置",
    "全保留", // 快速核实三档(替代原「全选 / 清空」小字,真机反馈 2026-10-17)
    "只留高可信",
    ">清空<",
    "voiceCtaText", // 语音胶囊动态 CTA 绑定(文案随批次位置切换,字面量由 PP-CTA-1 锁)
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

/* ---------------- PP-C1:会话绑定时序竞态(PR #67 C1,识别等待窗口) ---------------- */

var VL_OK_TWO_ITEMS = {
  ok: true,
  engine: "vl-local",
  items: [
    { name: "黄色薯片罐", qty_note: "", confidence: "high", box: { x1: 0.273, y1: 0.389, x2: 0.593, y2: 0.507 } },
    { name: "黑色小盒子", qty_note: "", confidence: "low", box: { x1: 0.868, y1: 0.79, x2: 0.982, y2: 0.873 } },
  ],
  img_w: 1024,
  img_h: 768,
};

/** boot 变体:进入页面前先落在指定家庭(C1:拍照入口作用域必须在 onLoad 前就位,
 *  boot 的 reset 在 onLoad 之前但无捕获点,这里补捕获)。 */
async function bootInHousehold(householdId, opts) {
  opts = opts || {};
  var env = makeEnv(opts);
  install(env);
  photoSession.__resetPhotoSessionForTest();
  photoSession.__setPhotoSessionStorageForTest(opts.sessionStorage || makeFakeStorage());
  householdScope.__resetHouseholdScopeForTest();
  if (householdId) {
    householdScope.captureHouseholdId(householdId, null);
  }
  cache.__resetLocationsCacheForTest();
  photoIntake.__setPhotoIntakeDepsForTest(null);
  var page = makePage();
  page.onLoad(opts.loadOptions === undefined ? {} : opts.loadOptions);
  await settle();
  return { page: page, env: env };
}

test("PP-C1-1:A 家拍照→识别等待期切 B 家→识别返回 → 零会话零候选零上传,终止返回首页", async function () {
  var A = "hh_c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
  var B = "hh_c1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1";
  var holder = {};
  var ctx = await bootInHousehold(A, { vlDefer: holder });
  var page = ctx.page;

  assert.equal(page.data.recognizing, true, "识别在途(挂起桩)");
  assert.equal(page.data.entryReady, false);
  assert.equal(page.entryScope.householdId, A, "照片在手即捕获入口作用域(C1:识别发起前)");
  assert.equal(page.sessionScope, null, "识别未返回不开会话");

  householdScope.captureHouseholdId(B, null); // 识别等待窗口:家庭 A → B
  holder.resolve(VL_OK_TWO_ITEMS);
  await settle();

  assert.equal(page.data.entryReady, false, "候选绝不上屏");
  assert.equal(page.rowsRaw.length, 0, "零候选");
  assert.equal(page.sessionScope, null, "零会话(不建会话)");
  assert.equal(page.batchId, "", "未开批");
  assert.equal(ctx.env.uploads.length, 0, "零上传");
  assert.equal(ctx.env.commitCalls.length, 0, "零 photoCommit");
  assert.ok(toastTexts(ctx.env).indexOf("家庭已切换,本次拍照未保存") !== -1, "C1 终局文案(与 B1 同款语义)");
  assert.ok(ctx.env.backs.length >= 1, "返回首页");
  assert.equal(page.data.recognizing, false);
  // A 家键下无会话残留(回 A 家不再出现恢复横幅);B 家键同样零写入
  householdScope.__resetHouseholdScopeForTest();
  householdScope.captureHouseholdId(A, null);
  assert.equal(photoSession.getUnfinishedPhotoSession(), null, "A 家会话键无残留");
  householdScope.__resetHouseholdScopeForTest();
  householdScope.captureHouseholdId(B, null);
  assert.equal(photoSession.getUnfinishedPhotoSession(), null, "B 家会话键无残留");
});

test("PP-C1-2:同 householdId 作用域代数前进(A→B→A)→ 不算漂移,照常开批", async function () {
  var A = "hh_c1cccccccccccccccccccccccccccccc1";
  var holder = {};
  var ctx = await bootInHousehold(A, { vlDefer: holder });
  var page = ctx.page;
  var entryGen = page.entryScope.generation;

  // 识别等待窗口:切 B 再切回 A——householdId 与入口一致,作用域代数已前进
  householdScope.captureHouseholdId("hh_c1dddddddddddddddddddddddddddddd1", null);
  householdScope.captureHouseholdId(A, null);
  assert.ok(
    householdScope.captureScopeGeneration() > entryGen,
    "同户代数已前进(同户内作用域版本变化)",
  );
  holder.resolve(VL_OK_TWO_ITEMS);
  await settle();

  assert.equal(page.data.entryReady, true, "同户代数前进不算漂移,照常开批");
  assert.equal(page.rowsRaw.length, 2, "候选照常上屏");
  assert.equal(page.sessionScope.householdId, A, "会话绑定拍照入口家庭");
  assert.equal(page.batchId !== "", true, "会话已开");
  assert.equal(toastTexts(ctx.env).indexOf("家庭已切换,本次拍照未保存") === -1, true, "绝不误杀同户批次");
  assert.equal(ctx.env.uploads.length, 0, "开批后确认前仍零上传");
});

test("PP-C1-3:VL 不可用降级弹窗等待期切家 → 手动添加路径同样不开批,零会话终止返回", async function () {
  var A = "hh_c1eeeeeeeeeeeeeeeeeeeeeeeeeeeeee1";
  var B = "hh_c1ffffffffffffffffffffffffffffff1";
  var ctx = await bootInHousehold(A, {
    vlError: { ok: false, error: "AI_UNAVAILABLE", message: "拍照识别暂不可用,可手动添加", manual_fallback: true },
    onModal: function (o) {
      // 降级弹窗「拍照识别暂不可用」开着的时候家庭切到 B(modal 等待窗口)
      householdScope.captureHouseholdId(B, null);
      o.success({ confirm: true, cancel: false, content: "" });
    },
  });
  var page = ctx.page;

  assert.equal(page.data.entryReady, false, "降级路径漂移:不开批");
  assert.equal(page.rowsRaw.length, 0, "零候选");
  assert.equal(page.sessionScope, null, "零会话");
  assert.equal(page.batchId, "", "未开批");
  assert.equal(ctx.env.uploads.length, 0, "零上传");
  assert.equal(ctx.env.commitCalls.length, 0, "零提交");
  assert.ok(toastTexts(ctx.env).indexOf("家庭已切换,本次拍照未保存") !== -1, "C1 终局文案");
  assert.ok(ctx.env.backs.length >= 1, "返回首页");
});

test("PP-C1-4:未授权路径——授权弹窗等待期切家 → 手动/语音建候选路径同样不开批", async function () {
  var A = "hh_c1gggggggggggggggggggggggggggggg1";
  var B = "hh_c1hhhhhhhhhhhhhhhhhhhhhhhhhhhh1";
  var ctx = await bootInHousehold(A, {
    vlAuthReset: true,
    onModal: function (o) {
      // 授权弹窗「云端识别授权」等待窗口切家,然后拒绝
      householdScope.captureHouseholdId(B, null);
      o.success({ confirm: false, cancel: true, content: "" });
    },
  });
  var page = ctx.page;

  assert.equal(page.data.entryReady, false, "未授权降级路径漂移:不开批");
  assert.equal(page.rowsRaw.length, 0, "零候选");
  assert.equal(page.sessionScope, null, "零会话");
  assert.equal(page.data.vlAuthDenied, true, "拒绝态照常记录");
  assert.ok(toastTexts(ctx.env).indexOf("家庭已切换,本次拍照未保存") !== -1, "C1 终局文案");
  assert.ok(ctx.env.backs.length >= 1, "返回首页");
  assert.equal(ctx.env.uploads.length, 0);
});

test("PP-C1-5:识别正常返回且未切换 → 照常开批(回归)", async function () {
  var A = "hh_c1iiiiiiiiiiiiiiiiiiiiiiiiiiiiii1";
  var ctx = await bootInHousehold(A, {});
  var page = ctx.page;

  assert.equal(page.data.entryReady, true, "无漂移不拦");
  assert.equal(page.rowsRaw.length, 2, "候选照常上屏");
  assert.equal(page.sessionScope.householdId, A, "会话绑定入口家庭");
  assert.equal(ctx.env.vlCalls.length, 1);
  assert.equal(ctx.env.uploads.length, 0, "确认前零上传(回归)");
  assert.equal(toastTexts(ctx.env).indexOf("家庭已切换,本次拍照未保存") === -1, true);
});

/* ---------------- PP-C3:证据待关联终态提示 + 幂等重试关联(PR #67 C3) ---------------- */

test("PP-C3-1:部分证据失败 → 终态提示+重试入口 → 重试成功清提示、清会话", async function () {
  var ctx = await boot({ commitEvidenceFailedIndexes: [0] });
  var page = ctx.page;
  await readyToSave(ctx, page); // #1 勾选(high 预选)→ 1 件提交
  await page.onSaveGoTap();
  await settle();

  assert.equal(ctx.env.uploads.length, 1, "确认后本批唯一上云动作");
  assert.equal(page.rowsRaw[0].done, true, "物品已建,行落终态");
  assert.equal(page.batchFinished, true, "建档全部成功,批终局");
  assert.notEqual(page.data.evidencePending, null, "终态提示出现");
  assert.equal(page.data.evidencePending.count, 1);
  assert.equal(page.data.evidencePending.savedCount, 1);
  assert.ok(toastTexts(ctx.env).indexOf("已入库 1 件,其中 1 件照片待关联") !== -1, "C3 终态文案");
  assert.notEqual(photoSession.getUnfinishedPhotoSession(), null, "续联载荷随会话保留(C3)");
  var persisted = photoSession.getUnfinishedPhotoSession();
  assert.notEqual(persisted.pendingEvidence, null, "会话载荷含 pendingEvidence");
  assert.equal(persisted.pendingEvidence.items.length, 1);

  // wxml 契约:重试入口在册
  var fs = require("node:fs");
  var wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/photo/photo.wxml"), "utf8");
  assert.ok(wxml.indexOf("重试关联") !== -1, "终态结果区应有「重试关联」入口");

  // 点重试关联:photoEvidenceRetry(file_id 复用 + 待关联件)
  await page.onEvidenceRetryTap();
  await settle();
  assert.equal(ctx.env.retryCalls.length, 1);
  var ev = ctx.env.retryCalls[0];
  assert.equal(ev.action, "photoEvidenceRetry");
  assert.equal(ev.file_id, "cloud://test-bucket/evidence-1.jpg", "fileId 复用,不再上传");
  assert.equal(ctx.env.uploads.length, 1, "重试绝不重复上传");
  assert.equal(ev.img_w, 1024);
  assert.equal(ev.img_h, 768);
  assert.equal(ev.items.length, 1);
  assert.equal(ev.items[0].item_id, "it-0");
  assert.deepEqual(ev.items[0].box, { x1: 0.273, y1: 0.389, x2: 0.593, y2: 0.507 }, "行框随行");
  assert.equal(ev.items[0].source, "vl");

  assert.equal(page.data.evidencePending, null, "成功清提示");
  assert.equal(page.pendingEvidence, null);
  assert.equal(page.data.evidenceRetryBusy, false);
  assert.ok(toastTexts(ctx.env).indexOf("照片都关联好了") !== -1);
  assert.equal(photoSession.getUnfinishedPhotoSession(), null, "批终局+关联完成 → 会话清除");
});

test("PP-C3-2:重试失败 → 提示保留、入口可再点;再试成功后清提示", async function () {
  var ctx = await boot({ commitEvidenceFailedIndexes: [0], retryError: "EVIDENCE_WRITE_FAILED" });
  var page = ctx.page;
  await readyToSave(ctx, page);
  await page.onSaveGoTap();
  await settle();
  assert.notEqual(page.data.evidencePending, null);

  await page.onEvidenceRetryTap();
  await settle();
  assert.equal(ctx.env.retryCalls.length, 1, "发起过一次重试");
  assert.notEqual(page.data.evidencePending, null, "失败不清提示");
  assert.equal(page.data.evidenceRetryBusy, false, "可再点");
  assert.notEqual(page.pendingEvidence, null, "续联载荷保留");
  assert.ok(toastTexts(ctx.env).indexOf("照片关联失败") !== -1, "如实提示失败");

  // 换成功桩再点:可再点收敛
  ctx.env.router = makeRouter({});
  await page.onEvidenceRetryTap();
  await settle();
  assert.equal(ctx.env.retryCalls.length, 2, "失败后可再点");
  assert.equal(page.data.evidencePending, null, "再试成功清提示");
  assert.ok(toastTexts(ctx.env).indexOf("照片都关联好了") !== -1);
});

test("PP-C3-3:重试部分失败(NOT_FOUND 的件不再等)→ 只留仍待关联件,提示后可再点", async function () {
  var ctx = await boot({ commitEvidenceFailedIndexes: [0] });
  var page = ctx.page;
  // 造两件待关联:第二件也勾选提交,commit 桩按 it-0/it-1 返回
  page.onCheckTap({ currentTarget: { dataset: { index: 1 } } });
  await readyToSave(ctx, page);
  ctx.env.router = makeRouter({ commitEvidenceFailedIndexes: [0, 1] });
  await page.onSaveGoTap();
  await settle();
  assert.equal(page.data.evidencePending.count, 2, "两件待关联");

  // 重试桩:第一件证据写失败(保留可再试),第二件 NOT_FOUND(item 已删,不再等)
  ctx.env.router = function (name, data) {
    if (name === "itemsApi" && data.action === "photoEvidenceRetry") {
      return {
        ok: true,
        results: data.items.map(function (it, i) {
          return i === 0
            ? { index: i, item_id: it.item_id, ok: false, error: "EVIDENCE_WRITE_FAILED", message: "照片关联失败,请重试" }
            : { index: i, item_id: it.item_id, ok: false, error: "NOT_FOUND", message: "没有找到这条记录" };
        }),
      };
    }
    return makeRouter({})(name, data);
  };
  await page.onEvidenceRetryTap();
  await settle();
  assert.equal(page.data.evidencePending.count, 1, "NOT_FOUND 的件不再无意义重试,只剩仍待关联件");
  assert.equal(page.pendingEvidence.items[0].item_id, "it-0", "留下的是证据写失败件");
  assert.ok(toastTexts(ctx.env).indexOf("还有 1 件照片没关联上,可再点重试") !== -1);

  // 再点一次:剩余件成功收敛
  ctx.env.router = makeRouter({});
  await page.onEvidenceRetryTap();
  await settle();
  assert.equal(page.data.evidencePending, null);
  assert.ok(toastTexts(ctx.env).indexOf("照片都关联好了") !== -1);
});

/* ---------------- PP-C3(R1):证据待关联的 onUnload 会话生命周期(PR #67 R1) ---------------- */

test("PP-C3-4(R1):evidence_failed 后离开 → 会话连同 pendingEvidence 保留;恢复可见重试入口;重试成功、再离开才清", async function () {
  var sessionStorage = makeFakeStorage();
  var ctx = await boot({ sessionStorage: sessionStorage, commitEvidenceFailedIndexes: [0, 1] });
  var page = ctx.page;
  page.onCheckTap({ currentTarget: { dataset: { index: 1 } } }); // 两件都勾选提交
  await readyToSave(ctx, page);
  await page.onSaveGoTap();
  await settle();
  assert.equal(page.batchFinished, true, "建档全部成功,批终局");
  assert.equal(page.rowsRaw.every(function (r) { return r.done; }), true, "全部行落终态");
  assert.notEqual(page.pendingEvidence, null, "两件证据待关联");

  // R1 负例:批已终局但待关联非空 → onUnload 绝不删会话与续联载荷
  page.onUnload();
  var kept = photoSession.getUnfinishedPhotoSession();
  assert.notEqual(kept, null, "会话仍在(恢复入口在)");
  assert.notEqual(kept.pendingEvidence, null, "续联载荷随会话保留");
  assert.equal(kept.pendingEvidence.items.length, 2);

  // 跨页恢复(新页面实例 resume):重试入口可见 → 重试成功 → 载荷清空
  var ctx2 = await boot({ sessionStorage: sessionStorage }, { resume: "1" });
  var page2 = ctx2.page;
  assert.notEqual(page2.data.evidencePending, null, "恢复后重试入口可见");
  assert.equal(page2.data.evidencePending.count, 2);
  await page2.onEvidenceRetryTap();
  await settle();
  assert.equal(ctx2.env.retryCalls.length, 1);
  assert.equal(page2.pendingEvidence, null, "重试成功清载荷");
  assert.equal(page2.data.evidencePending, null);

  // 载荷已空 + 全部行终态 → 再离开:会话被清
  page2.onUnload();
  assert.equal(photoSession.getUnfinishedPhotoSession(), null, "重试收敛后再离开,会话被清");
});

test("PP-C3-5(R1 回归):正常全成功(无待关联)→ onUnload 会话被清、不复活", async function () {
  var sessionStorage = makeFakeStorage();
  var ctx = await boot({ sessionStorage: sessionStorage });
  var page = ctx.page;
  await readyToSave(ctx, page);
  await page.onSaveGoTap();
  await settle();
  assert.equal(page.pendingEvidence, null, "无待关联件");
  assert.equal(page.batchFinished, true);
  assert.equal(photoSession.getUnfinishedPhotoSession(), null, "终局当场清会话");
  page.onUnload();
  assert.equal(photoSession.getUnfinishedPhotoSession(), null, "onUnload 不复活已清会话");
});

test("PP-C3-6(R1 回归):恢复后重试入口仍可再次失败、可再点直至成功", async function () {
  var sessionStorage = makeFakeStorage();
  var ctx = await boot({ sessionStorage: sessionStorage, commitEvidenceFailedIndexes: [0, 1] });
  var page = ctx.page;
  page.onCheckTap({ currentTarget: { dataset: { index: 1 } } });
  await readyToSave(ctx, page);
  await page.onSaveGoTap();
  await settle();
  assert.notEqual(page.pendingEvidence, null);
  page.onUnload();

  var ctx2 = await boot(
    { sessionStorage: sessionStorage, retryError: "EVIDENCE_WRITE_FAILED" },
    { resume: "1" },
  );
  var page2 = ctx2.page;
  assert.notEqual(page2.data.evidencePending, null, "恢复后重试入口在");
  await page2.onEvidenceRetryTap();
  await settle();
  assert.equal(ctx2.env.retryCalls.length, 1, "发起过一次重试(失败)");
  assert.notEqual(page2.data.evidencePending, null, "失败不清提示");
  assert.equal(page2.data.evidenceRetryBusy, false, "可再点");
  assert.notEqual(page2.pendingEvidence, null, "续联载荷保留");
  assert.ok(toastTexts(ctx2.env).indexOf("照片关联失败") !== -1, "如实提示失败");

  ctx2.env.router = makeRouter({});
  await page2.onEvidenceRetryTap();
  await settle();
  assert.equal(ctx2.env.retryCalls.length, 2, "失败后可再点");
  assert.equal(page2.pendingEvidence, null, "再试成功收敛");
  assert.ok(toastTexts(ctx2.env).indexOf("照片都关联好了") !== -1);
});

/* ---------------- PP-AUTH:首次识别授权(PR #67 B4) ---------------- */

function authModalSeen(env) {
  return env.modals.filter(function (m) { return m.title === "云端识别授权"; });
}

test("PP-AUTH-1:首次识别弹一次性授权(同意→识别调用发生;storage 记忆;本页再拍不再问)", async function () {
  var modalAnswers = [];
  var ctx = await boot({
    vlAuthReset: true,
    onModal: function (o) {
      modalAnswers.push(o.title);
      if (o.title === "云端识别授权") {
        o.success({ confirm: true, cancel: false, content: "" });
        return;
      }
      o.success({ confirm: false, cancel: true, content: "" });
    },
  });
  var page = ctx.page;
  var env = ctx.env;

  var auths = authModalSeen(env);
  assert.equal(auths.length, 1, "首次识别前恰好弹一次授权");
  assert.equal(
    auths[0].content,
    "识别需要把这张照片临时发送到云端处理(仅传输识别,不会保存);你点确认入库后,照片才会保存。",
    "授权文案如实说明临时传输与保存是两回事",
  );
  assert.equal(auths[0].confirmText, "同意");
  assert.equal(ctx.env.vlCalls.length, 1, "同意 → 识别调用发生");
  assert.equal(page.data.entryReady, true);
  assert.equal(page.rowsRaw.length, 2, "候选照常上屏");
  assert.equal(ctx.env.vlCalls[0].image_base64, "QQ==");
  assert.equal(page.vlAuthGranted, true);
  assert.equal(page.data.vlAuthDenied, false);

  // 同一页面重拍:不再弹授权(storage 记忆 + 实例 granted),识别直接发起
  page.onEntryShotTap();
  await settle();
  assert.equal(authModalSeen(ctx.env).length, 1, "本页访问内只问一次");
  assert.equal(ctx.env.vlCalls.length, 2, "重拍识别照常");
});

test("PP-AUTH-2:拒绝 → 识别绝不调用;手动/语音候选照常;圈选入口灰化提示;拒绝不落记忆(重进会再问)", async function () {
  var ctx = await boot({
    vlAuthReset: true,
    onModal: function (o) {
      o.success({ confirm: false, cancel: true, content: "" }); // 所有 modal 默认拒绝(防御性回调)
    },
  });
  var page = ctx.page;
  assert.equal(ctx.env.vlCalls.length, 0, "拒绝 → 本次绝不调识别(零传输)");
  assert.equal(page.data.entryReady, true, "仍进核对页(照片留本机作证据)");
  assert.equal(page.rowsRaw.length, 0, "无识别候选");
  assert.equal(page.data.vlAuthDenied, true, "识别入口灰化标记");
  assert.ok(page.data.navSubtitle.indexOf("未授权云端识别") !== -1);
  assert.equal(ctx.env.storage.has("home-memory:photo-vl-auth"), false, "拒绝不落记忆键");

  // 手动路径可用:手动添加一行候选
  page.onManualAddTap();
  assert.notEqual(page.data.edit, null, "手动添加面板照常打开");
  page.data.edit.nameInput = "指甲刀";
  page.onEditConfirmTap();
  assert.equal(page.rowsRaw.length, 1, "手动添加候选成功");
  assert.equal(page.rowsRaw[0].name, "指甲刀");

  // 圈选入口被拦:提示重新进入会再询问,不发起识别
  page.onEnterCircle();
  assert.equal(page.data.mode, "confirm", "未进入圈选模式");
  assert.ok(toastTexts(ctx.env).indexOf("未授权云端识别,重新进入时会再询问") !== -1);
  assert.equal(ctx.env.vlCalls.length, 0);

  // 本页访问内重拍:不再问,也不识别(照片仍作证据)
  page.onEntryShotTap();
  await settle();
  assert.equal(authModalSeen(ctx.env).length, 1, "拒绝后本访问不重复问");
  assert.equal(ctx.env.vlCalls.length, 0);

  // 重新进入(全新页面实例、无记忆键):会再询问一次,此时同意 → 识别发生并落记忆
  var reentry = await boot({
    vlAuthReset: true,
    onModal: function (o) {
      if (o.title === "云端识别授权") {
        o.success({ confirm: true, cancel: false, content: "" });
        return;
      }
      o.success({ confirm: false, cancel: true, content: "" });
    },
  });
  assert.equal(authModalSeen(reentry.env).length, 1, "重新进入时会再询问(拒绝未持久化)");
  assert.equal(reentry.env.vlCalls.length, 1, "这次同意 → 识别调用发生");
  assert.equal(reentry.env.storage.get("home-memory:photo-vl-auth"), "granted", "同意落记忆键(此后不再问)");
});

/* ---------------- PP-EPOCH:页面销毁后的在途异步失效(PR #67 R2,captureEpoch) ---------------- */

/** 监听此后 page.setData 的调用次数(页面销毁后绝不应再 setData) */
function setDataCounter(page) {
  var counter = { calls: 0 };
  var orig = page.setData;
  page.setData = function (patch) {
    counter.calls += 1;
    return orig.call(page, patch);
  };
  return counter;
}

test("PP-EPOCH-1:识别在途 onUnload → 迟到回包静默丢弃:零建会话零上屏零 setData", async function () {
  var holder = {};
  var ctx = await boot({ vlDefer: holder });
  var page = ctx.page;
  assert.equal(page.data.recognizing, true, "识别在途(挂起桩)");
  assert.equal(typeof holder.resolve, "function");
  var round1 = holder.resolve;

  page.onUnload();
  var counter = setDataCounter(page);
  round1(VL_OK_TWO_ITEMS); // 页面已销毁,识别才返回
  await settle();

  assert.equal(counter.calls, 0, "页面销毁后零 setData");
  assert.equal(page.data.entryReady, false, "候选绝不上屏");
  assert.equal(page.rowsRaw.length, 0, "零候选");
  assert.equal(page.sessionScope, null, "零建会话");
  assert.equal(page.batchId, "", "未开批");
  assert.equal(photoSession.getUnfinishedPhotoSession(), null, "会话存储为空");
});

test("PP-EPOCH-2:新一轮 beginCapture 接管(epoch+1)→ 第一轮迟到回包丢弃、第二轮照常", async function () {
  var holder = {};
  var ctx = await boot({ vlDefer: holder });
  var page = ctx.page;
  var round1 = holder.resolve;
  assert.equal(page.data.recognizing, true, "第一轮识别在途");
  var epoch1 = page.captureEpoch;

  // 新一轮接管:生产中识别在途 capturing 门拦住重入(CTA 单一入口),此处模拟
  // 上一轮已被放行终止、新一轮 beginCapture 开始——epoch 必须前进
  page.capturing = false;
  page.beginCapture();
  await settle();
  assert.equal(page.captureEpoch, epoch1 + 1, "新一轮拍照流程开始:epoch 递增");
  var round2 = holder.resolve;
  assert.notEqual(round2, round1, "第二轮有自己的在途识别");
  assert.equal(page.data.recognizing, true, "第二轮识别在途");
  assert.equal(page.data.entryReady, false);

  var counter = setDataCounter(page);
  round1(VL_OK_TWO_ITEMS); // 第一轮迟到回包
  await settle();
  assert.equal(counter.calls, 0, "第一轮迟到回包零续行(静默丢弃)");
  assert.equal(page.data.entryReady, false, "第一轮不上屏");
  assert.equal(page.rowsRaw.length, 0);
  assert.equal(page.batchId, "", "第一轮不建会话");

  round2(VL_OK_TWO_ITEMS); // 第二轮照常
  await settle();
  assert.equal(page.data.entryReady, true, "第二轮照常上屏");
  assert.equal(page.rowsRaw.length, 2);
  assert.notEqual(page.sessionScope, null, "第二轮照常建会话");
});

test("PP-EPOCH-3:授权弹窗等待期 onUnload → 迟到同意回包后不建会话、绝不发起识别", async function () {
  var authDefer = {};
  var ctx = await boot({
    vlAuthReset: true,
    onModal: function (o) {
      if (o.title === "云端识别授权") {
        authDefer.success = o.success; // 挂起授权弹窗,由用例手动放行
        return;
      }
      o.success({ confirm: false, cancel: true, content: "" });
    },
  });
  var page = ctx.page;
  assert.equal(ctx.env.vlCalls.length, 0, "授权未决,识别未发起");
  assert.equal(typeof authDefer.success, "function", "停在授权弹窗等待");

  page.onUnload();
  var counter = setDataCounter(page);
  authDefer.success({ confirm: true, cancel: false, content: "" }); // 迟到同意
  await settle();

  assert.equal(counter.calls, 0, "页面销毁后零 setData");
  assert.equal(ctx.env.vlCalls.length, 0, "页面已走绝不发起识别传输");
  assert.equal(page.sessionScope, null, "零建会话");
  assert.equal(page.batchId, "");
  assert.equal(page.data.entryReady, false, "未授权降级路径也不再开批");
});

test("PP-EPOCH-4:正常流程 epoch 全程不变(回归)——识别/上屏/建会话照常", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  assert.equal(page.captureEpoch, 1, "onLoad 首轮拍照恰好递增一次");
  assert.equal(page.data.entryReady, true, "识别照常完成");
  assert.equal(page.rowsRaw.length, 2, "候选照常上屏");
  assert.notEqual(page.sessionScope, null, "会话照常建立");
  assert.equal(ctx.env.vlCalls.length, 1);
  assert.equal(page.captureEpoch, 1, "无卸载无新一轮,epoch 不再变化");
});

test("PP-EPOCH-5:圈选识别在途 onUnload → 迟到结果不上屏零 setData", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  assert.equal(page.data.entryReady, true);
  page.onEnterCircle();
  await settle();
  var holder = {};
  ctx.env.router = function (name, data) {
    if (name === "extractDraft" && data.action === "vlRecognize") {
      return new Promise(function (resolve) {
        holder.resolve = resolve;
      });
    }
    return makeRouter({})(name, data);
  };
  page.onCircleTouchStart({ touches: [{ clientX: 60, clientY: 200 }] });
  page.onCircleTouchMove({ touches: [{ clientX: 150, clientY: 268 }] });
  var endPromise = page.onCircleTouchEnd();
  await settle();
  assert.equal(typeof holder.resolve, "function", "圈选识别在途");
  assert.equal(page.data.circle.recognizing, true);

  page.onUnload();
  var counter = setDataCounter(page);
  holder.resolve(VL_OK_TWO_ITEMS);
  await endPromise;
  await settle();
  assert.equal(counter.calls, 0, "迟到圈选结果零续行");
  assert.equal(page.data.circle.result, null, "结果卡不上屏");
  assert.equal(page.data.circle.recognizing, true, "状态不被迟到回包改写");
});

// 真机反馈(2026-10-17):竖构图照片展开态几乎满屏、且点照片本体无法收起。
// 锁定:①展开样式带限高与居中(竖构图宽度收窄,零裁剪保框对齐)
//      ②点照片本体=开关(展开态再点即收起,角标收起不变)。
test("PP-PHOTO-2:竖构图展开限高居中 + 点图本体切换展开/收起", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  // JS 像素方案(不依赖 aspect-ratio/min/calc/vh):stub 窗口 375×667,
  // 横构图 1024/768 → 宽撑满 375、高 281(< 46%×667=307 不截断);纵向绝不超 307
  assert.ok(page.data.photoExpandStyle.indexOf("width:375px") !== -1, "横构图宽撑满 375px");
  assert.ok(page.data.photoExpandStyle.indexOf("height:281px") !== -1, "高等比 281px");
  assert.ok(page.data.photoExpandStyle.indexOf("margin:0 auto") !== -1, "居中");
  assert.equal(page.data.photoCollapsed, true, "默认折叠");
  page.onPhotoTap();
  assert.equal(page.data.photoCollapsed, false, "点图展开");
  page.onPhotoTap();
  assert.equal(page.data.photoCollapsed, true, "展开态再点图本体=收起(真机反馈)");
  page.onPhotoTap();
  assert.equal(page.data.photoCollapsed, false, "再点又展开(开关语义)");
});

/* ---------------- PP-MOUNT:保存成功后位置挂树(issue #65 V0.4 第③条) ---------------- */

test("PP-MOUNT-1:保存成功 → 批次位置与逐件例外按去重位置挂树,ensureAndLink 参数逐项正确", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  page.onCheckTap({ currentTarget: { dataset: { index: 1 } } }); // 两件都勾选
  page.rowsRaw[0] = { ...page.rowsRaw[0], exc: "厨房" }; // #1 例外;#2 继承批次
  page.rebuildRows();
  await readyToSave(ctx, page); // 批次位置「玄关柜 · 第二层抽屉」
  await page.onSaveGoTap();
  await settle();

  assert.equal(page.rowsRaw.every(function (r) { return r.done || !r.checked; }), true);
  assert.equal(ctx.env.mountCalls.length, 2, "例外一件 + 批次一件,逐件各一次 ensureAndLink");
  var exc = ctx.env.mountCalls[0];
  assert.equal(exc.item_id, "it-0");
  assert.deepEqual(exc.path, ["厨房"], "例外位置分段(单段=单层)");
  assert.equal(exc.expected_version, 1, "photoCommit 回执版本");
  assert.equal(exc.update_id, "photo:" + page.rowsRaw[0].operationId, "行内幂等键派生的挂树幂等键");
  assert.equal(exc.created_from, "manual", "手输位置拆层记 manual(不是原话 parse)");
  var batch = ctx.env.mountCalls[1];
  assert.equal(batch.item_id, "it-1");
  assert.deepEqual(batch.path, ["玄关柜", "第二层抽屉"], "批次位置按「·」拆层");
  assert.equal(batch.update_id, "photo:" + page.rowsRaw[1].operationId);
  assert.ok(toastTexts(ctx.env).indexOf("位置树没挂上") === -1, "全部挂上零打扰");
  assert.ok(toastTexts(ctx.env).indexOf("都记住了 · 2 件已入库") !== -1);
});

test("PP-MOUNT-2:挂树失败 → 终态不受影响(不回滚不阻断)+ 轻提示「主界面可补」", async function () {
  var ctx = await boot({ mountError: "VERSION_CONFLICT" });
  var page = ctx.page;
  await readyToSave(ctx, page); // 默认 #1 勾选 → 1 件
  await page.onSaveGoTap();
  await settle();

  assert.equal(ctx.env.mountCalls.length, 1, "发起过一次挂树(失败)");
  assert.equal(page.rowsRaw[0].done, true, "已确认记住终态绝不回滚");
  assert.equal(page.batchFinished, true);
  assert.equal(page.data.saveSheet, null);
  assert.equal(photoSession.getUnfinishedPhotoSession(), null, "会话照常终局清理");
  assert.ok(toastTexts(ctx.env).indexOf("都记住了 · 1 件已入库") !== -1, "成功终态提示在前");
  assert.ok(toastTexts(ctx.env).indexOf("1 件的位置树没挂上,主界面可补") !== -1, "挂树失败只轻提示");
});

test("PP-MOUNT-3:部分失败重试/会话恢复 → 已 done 件不重挂,只挂本轮新入库件", async function () {
  var sessionStorage = makeFakeStorage();
  var ctx = await boot({ sessionStorage: sessionStorage, commitFailIndexes: [1] });
  var page = ctx.page;
  page.onCheckTap({ currentTarget: { dataset: { index: 1 } } });
  await readyToSave(ctx, page);
  await page.onSaveGoTap();
  await settle();
  assert.equal(page.rowsRaw[0].done, true);
  assert.equal(page.rowsRaw[1].done, false, "第二件失败可重试");
  assert.equal(ctx.env.mountCalls.length, 1, "第一轮只挂成功件 it-0");
  assert.equal(ctx.env.mountCalls[0].item_id, "it-0");
  var opIds = page.rowsRaw.map(function (r) { return r.operationId; });
  page.onUnload(); // 中途离开:会话保留(存在未完成行)

  // 恢复会话(进程回收场景):done 行不再进保存 → 不重挂;失败行重试成功后挂上
  var ctx2 = await boot({ sessionStorage: sessionStorage }, { resume: "1" });
  var page2 = ctx2.page;
  assert.equal(page2.rowsRaw[0].done, true, "已入库行恢复为终态");
  await readyToSave(ctx2, page2);
  await page2.onSaveGoTap();
  await settle();
  assert.equal(ctx2.env.commitCalls[0].items.length, 1, "只提交失败行(done 行绝不重提)");
  assert.equal(page2.rowsRaw[1].done, true);
  assert.equal(ctx2.env.mountCalls.length, 1, "恢复后只挂本轮新入库件(桩 id 按本次提交序号编)");
  assert.equal(
    ctx2.env.mountCalls[0].update_id,
    "photo:" + opIds[1],
    "挂树的是重试行(幂等键随行内 operationId 恢复稳定)",
  );
  assert.notEqual(ctx2.env.mountCalls[0].update_id, ctx.env.mountCalls[0].update_id, "与第一轮的 it-0 不是同一件");
  assert.ok(toastTexts(ctx2.env).indexOf("位置树没挂上") === -1);
});

test("PP-MOUNT-4:旧云函数窗口(回执无 version)→ 零挂树调用,计入轻提示不误报失败", async function () {
  var ctx = await boot({ commitVersionless: true });
  var page = ctx.page;
  await readyToSave(ctx, page);
  await page.onSaveGoTap();
  await settle();

  assert.equal(page.rowsRaw[0].done, true, "入库照常");
  assert.equal(ctx.env.mountCalls.length, 0, "无版本回执绝不发起注定失败的挂树");
  assert.ok(toastTexts(ctx.env).indexOf("1 件的位置树没挂上,主界面可补") !== -1, "如实计入未挂件数");
});

// 快速核实(真机反馈 2026-10-17:逐件勾选繁琐):一键三档批量设定勾选。
test("PP-QUICK-1:快速核实三档——全保留/只留高可信/清空;done 行不动;计数联动", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  var confidences = page.rowsRaw.map(function (r) { return r.confidence; });
  var highCount = page.rowsRaw.filter(function (r) { return r.confidence === "high"; }).length;
  assert.ok(highCount >= 1, "boot 环境至少 1 件高可信(前置)");

  page.onQuickVerifyTap({ currentTarget: { dataset: { mode: "all" } } });
  assert.ok(page.rowsRaw.every(function (r) { return r.checked === true; }), "全保留:未定件全部勾选");
  assert.ok(page.data.saveText.indexOf(String(page.rowsRaw.length)) !== -1, "保存键计数联动");

  page.onQuickVerifyTap({ currentTarget: { dataset: { mode: "high" } } });
  assert.ok(
    page.rowsRaw.every(function (r) { return r.checked === (r.confidence === "high"); }),
    "只留高可信:非 high 一律不勾",
  );
  assert.equal(page.data.qkHigh, highCount, "高可信计数上屏");

  page.onQuickVerifyTap({ currentTarget: { dataset: { mode: "none" } } });
  assert.ok(page.rowsRaw.every(function (r) { return r.checked === false; }), "清空:全部不勾");
  assert.equal(page.data.saveDisabled, true, "零保留时保存禁用");

  page.onQuickVerifyTap({ currentTarget: { dataset: { mode: "bogus" } } });
  assert.ok(page.rowsRaw.every(function (r) { return r.checked === false; }), "非法档位零动作");
});

// 真机反馈(2026-10-17)UI 三连:照片证据条吸顶(wxml 契约见 PP-STATIC-1)、
// 中部冗余文字移除、语音胶囊动态文案(先问位置→已填问修改)。
test("PP-CTA-1:语音胶囊文案随批次位置切换", async function () {
  var ctx = await boot({});
  var page = ctx.page;
  assert.equal(page.data.voiceCtaText, "这些物品位置在哪,请告诉我", "位置未填:引导说位置");
  page.setBatchLocationText("玄关柜 · 第二层抽屉");
  assert.equal(page.data.voiceCtaText, "有什么物品要改的吗?请告诉我", "位置已填:引导改物品");
  page.setBatchLocationText("   ");
  assert.equal(page.data.voiceCtaText, "这些物品位置在哪,请告诉我", "清空位置:回到引导说位置");
});
