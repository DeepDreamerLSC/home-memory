"use strict";

/**
 * 拍照识物客户端识别封装的离线测试(utils/photo-vl.ts,wx API 全注入,零 wx 全局)。
 * 被测对象是 `npm run build:mp` 产出的 miniprogram/utils/photo-vl.js。
 * 规格:docs/design/issue3-photo-intake/IMPLEMENTATION.md(§4.1/§7.1/§7.4,base64
 * 直传口径)+ 主会话对 #65 V0.4 隐私红线的拍板:照片在用户最终确认保存之前
 * 绝不上传云端——识别=本地压缩→base64→callFunction,云存储零触碰。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var pv = require("../miniprogram/utils/photo-vl");

var ORIG_PATH = "wxfile://tmp_orig.jpg";
var COMP_PATH = "wxfile://tmp_comp.jpg";
var B64 = "ZmFrZS1qcGVnLWJ5dGVzLW9ubHktZm9yLXRlc3Q=";

/** 完整可控依赖:记录调用与参数,行为逐项可编程 */
function makeDeps(opts) {
  opts = opts || {};
  var calls = { infos: [], compress: [], reads: [], vl: [] };
  var deps = {
    getImageInfo: function (src) {
      calls.infos.push(src);
      if (opts.infoFailOn === src) {
        return Promise.reject(new Error("getImageInfo:fail " + src));
      }
      var size = src === ORIG_PATH
        ? { width: opts.origW !== undefined ? opts.origW : 4000, height: opts.origH !== undefined ? opts.origH : 3000 }
        : { width: opts.compW !== undefined ? opts.compW : 1280, height: opts.compH !== undefined ? opts.compH : 960 };
      return Promise.resolve(size);
    },
    compressImage: function (src, quality, w, h) {
      calls.compress.push({ src: src, quality: quality, w: w, h: h });
      if (opts.compressFail) {
        return Promise.reject(new Error("compressImage:fail"));
      }
      return Promise.resolve(COMP_PATH);
    },
    readFileBase64: function (filePath) {
      calls.reads.push(filePath);
      if (opts.readFail) {
        return Promise.reject(new Error("readFile:fail"));
      }
      return Promise.resolve(B64);
    },
    callVl: function (event) {
      calls.vl.push(event);
      if (opts.vlError) {
        return Promise.reject(new Error(opts.vlError));
      }
      return Promise.resolve(opts.vlResult);
    },
  };
  return { deps: deps, calls: calls };
}

var GOOD_RESULT = {
  ok: true,
  engine: "vl-local",
  items: [
    { name: "黑色耳机", qty_note: "", confidence: "high", box: { x1: 0.281, y1: 0.163, x2: 0.394, y2: 0.309 } },
    { name: "黄色薯片罐", qty_note: "约2罐", confidence: "mid", box: null },
  ],
  img_w: 1280,
  img_h: 960,
};

// ---------- prepare:压缩 → 实测宽高 → base64(全部本地) ----------

test("prepare:大图压到长边 1280(quality 70),宽高取压缩后实测,base64 读的是压缩产物", async function () {
  var t = makeDeps();
  var p = await pv.preparePhotoForVl(ORIG_PATH, t.deps);
  assert.equal(p.ok, true);
  assert.equal(p.compressed, true);
  assert.equal(p.path, COMP_PATH);
  assert.equal(p.imgW, 1280);
  assert.equal(p.imgH, 960);
  assert.equal(p.base64, B64);
  assert.deepEqual(t.calls.compress[0], { src: ORIG_PATH, quality: 70, w: 1280, h: 960 });
  assert.deepEqual(t.calls.infos, [ORIG_PATH, COMP_PATH], "先量原图算目标,再实测压缩产物");
  assert.deepEqual(t.calls.reads, [COMP_PATH], "base64 必须读压缩后那张(识别与上传同图)");
});

test("prepare:小图不放大小图目标按原尺寸(scale=1);压缩器未精确命中时以实测为准", async function () {
  var t = makeDeps({ origW: 800, origH: 600, compW: 798, compH: 598 });
  var p = await pv.preparePhotoForVl(ORIG_PATH, t.deps);
  assert.equal(p.ok, true);
  assert.deepEqual(t.calls.compress[0], { src: ORIG_PATH, quality: 70, w: 800, h: 600 });
  assert.equal(p.imgW, 798, "img_w 用压缩后实测值,不是目标值");
  assert.equal(p.imgH, 598);
});

test("prepare:极端宽高比(10000×10)目标高夹到 ≥1,不产出 0 尺寸", async function () {
  var t = makeDeps({ origW: 10000, origH: 10, compW: 1280, compH: 1 });
  var p = await pv.preparePhotoForVl(ORIG_PATH, t.deps);
  assert.equal(p.ok, true);
  assert.deepEqual(t.calls.compress[0], { src: ORIG_PATH, quality: 70, w: 1280, h: 1 });
});

test("prepare:压缩失败 → 原文件原样(如实),宽高与 base64 都取原图", async function () {
  var t = makeDeps({ compressFail: true });
  var p = await pv.preparePhotoForVl(ORIG_PATH, t.deps);
  assert.equal(p.ok, true);
  assert.equal(p.compressed, false);
  assert.equal(p.path, ORIG_PATH);
  assert.equal(p.imgW, 4000);
  assert.equal(p.imgH, 3000);
  assert.deepEqual(t.calls.reads, [ORIG_PATH]);
});

test("prepare:取不到原图宽高 → image_info_failed,不压缩不读文件(没有宽高就没有坐标契约)", async function () {
  var t = makeDeps({ infoFailOn: ORIG_PATH });
  var p = await pv.preparePhotoForVl(ORIG_PATH, t.deps);
  assert.equal(p.ok, false);
  assert.equal(p.kind, "image_info_failed");
  assert.equal(t.calls.compress.length, 0);
  assert.equal(t.calls.reads.length, 0);
  assert.equal(t.calls.vl.length, 0);
});

test("prepare:压缩产物取宽高失败 → image_info_failed;读 base64 失败 → read_failed", async function () {
  var t1 = makeDeps({ infoFailOn: COMP_PATH });
  var p1 = await pv.preparePhotoForVl(ORIG_PATH, t1.deps);
  assert.equal(p1.ok, false);
  assert.equal(p1.kind, "image_info_failed");
  assert.equal(t1.calls.reads.length, 0);

  var t2 = makeDeps({ readFail: true });
  var p2 = await pv.preparePhotoForVl(ORIG_PATH, t2.deps);
  assert.equal(p2.ok, false);
  assert.equal(p2.kind, "read_failed");
  assert.equal(p2.manualFallback, false);
});

// ---------- recognize:事件形状与隐私红线 ----------

test("recognize:event 只带 image_base64/img_w/img_h(无 file_id、无 mode),识别零上云存储", async function () {
  var t = makeDeps({ vlResult: GOOD_RESULT });
  var prepared = await pv.preparePhotoForVl(ORIG_PATH, t.deps);
  var out = await pv.recognizeWithVl(prepared, undefined, t.deps);
  assert.equal(out.ok, true);
  assert.equal(t.calls.vl.length, 1);
  var e = t.calls.vl[0];
  assert.equal(e.action, "vlRecognize");
  assert.equal(e.image_base64, B64);
  assert.equal(e.img_w, 1280);
  assert.equal(e.img_h, 960);
  assert.ok(!("file_id" in e), "确认前不存在 file_id(照片未上云)");
  assert.ok(!("mode" in e) && !("region" in e), "默认整图识别不带 mode/region");
});

test("隐私红线(静态守卫):photo-vl 编译产物不调用任何云存储上传/下载 API", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "miniprogram", "utils", "photo-vl.js"), "utf8");
  assert.ok(src.indexOf("uploadFile(") === -1, "客户端识别封装不得上传云存储(确认后才由保存流程上传)");
  assert.ok(src.indexOf("downloadFile(") === -1, "客户端识别封装不得读云存储");
});

// ---------- recognize:region 模式(屏⑤圈选) ----------

test("recognize:mode=region 透传用户圈选框;复用同一 prepared(base64 不重复读盘)", async function () {
  var t = makeDeps({ vlResult: GOOD_RESULT });
  var prepared = await pv.preparePhotoForVl(ORIG_PATH, t.deps);
  var region = { x1: 0.06, y1: 0.69, x2: 0.29, y2: 0.93 };
  await pv.recognizeWithVl(prepared, { mode: "region", region: region }, t.deps);
  await pv.recognizeWithVl(prepared, { mode: "region", region: region }, t.deps);
  assert.equal(t.calls.reads.length, 1, "圈选重试复用同一 base64,不重复读文件");
  assert.equal(t.calls.vl.length, 2);
  assert.equal(t.calls.vl[0].mode, "region");
  assert.deepEqual(t.calls.vl[0].region, region);
});

test("recognize:圈选区域非法(缺 region/越界/退化)→ invalid_region,不调云函数", async function () {
  var t = makeDeps({ vlResult: GOOD_RESULT });
  var prepared = await pv.preparePhotoForVl(ORIG_PATH, t.deps);
  var bad = [
    { mode: "region" },
    { mode: "region", region: { x1: 0, y1: 0, x2: 1.2, y2: 0.9 } },
    { mode: "region", region: { x1: 0.29, y1: 0.69, x2: 0.06, y2: 0.93 } },
    { mode: "region", region: { x1: 0.06, y1: NaN, x2: 0.29, y2: 0.93 } },
  ];
  for (var i = 0; i < bad.length; i++) {
    var out = await pv.recognizeWithVl(prepared, bad[i], t.deps);
    assert.equal(out.ok, false);
    assert.equal(out.kind, "invalid_region", JSON.stringify(bad[i]));
    assert.equal(out.manualFallback, false);
  }
  assert.equal(t.calls.vl.length, 0);
});

// ---------- recognize:响应映射与最小结构校验 ----------

test("recognize:ok 响应逐件映射;confidence 词表外 low、qty_note 非字符串容错空串、truncated 透传", async function () {
  var t = makeDeps({
    vlResult: {
      ok: true,
      engine: "vl-local",
      truncated: true,
      items: [
        { name: "黑色耳机", qty_note: "", confidence: "high", box: { x1: 0.281, y1: 0.163, x2: 0.394, y2: 0.309 } },
        { name: "黑色小盒子", qty_note: null, confidence: "sorta", box: null },
      ],
      img_w: 1280,
      img_h: 960,
    },
  });
  var out = await pv.recognizeWithVl(await pv.preparePhotoForVl(ORIG_PATH, t.deps), undefined, t.deps);
  assert.equal(out.ok, true);
  assert.equal(out.truncated, true, "截断如实透传,页面如实提示");
  assert.equal(out.imgW, 1280);
  assert.equal(out.imgH, 960);
  assert.deepEqual(out.items[0], { name: "黑色耳机", qty_note: "", confidence: "high", box: { x1: 0.281, y1: 0.163, x2: 0.394, y2: 0.309 } });
  assert.equal(out.items[1].confidence, "low", "词表外按 low");
  assert.equal(out.items[1].qty_note, "");
  assert.equal(out.items[1].box, null);
});

test("recognize:硬形状非法整体 bad_response(绝不半带异常件)", async function () {
  var bads = [
    null,
    "ok",
    { ok: true },
    { ok: true, items: "no" },
    { ok: true, items: [{ name: "  ", qty_note: "", confidence: "high", box: null }] },
    { ok: true, items: [{ name: "A", qty_note: "", confidence: "high", box: { x1: 0.5, y1: 0.1, x2: 0.4, y2: 0.9 } }] },
    { ok: true, items: [{ name: "A", qty_note: "", confidence: "high", box: { x1: -0.1, y1: 0.1, x2: 0.4, y2: 0.9 } }] },
    { ok: true, items: Array.from({ length: 11 }, function () {
      return { name: "A", qty_note: "", confidence: "low", box: null };
    }) },
    { ok: false, error: "WEIRD", message: "未知错误" },
  ];
  for (var i = 0; i < bads.length; i++) {
    var t = makeDeps({ vlResult: bads[i] });
    var out = await pv.recognizeWithVl(await pv.preparePhotoForVl(ORIG_PATH, t.deps), undefined, t.deps);
    assert.equal(out.ok, false, JSON.stringify(bads[i]));
    assert.equal(out.kind, "bad_response", JSON.stringify(bads[i]));
    assert.equal(out.manualFallback, false);
  }
});

// ---------- recognize:unavailable 降级路径(§7.1/§7.4) ----------

test("recognize:AI_UNAVAILABLE+manual_fallback → unavailable(可手动添加,仍进 photo 页)", async function () {
  var t = makeDeps({
    vlResult: {
      ok: false, error: "AI_UNAVAILABLE", message: "拍照识别暂不可用,可手动添加",
      manual_fallback: true, engine: "vl-local", reason: "vl_not_configured",
    },
  });
  var out = await pv.recognizeWithVl(await pv.preparePhotoForVl(ORIG_PATH, t.deps), undefined, t.deps);
  assert.equal(out.ok, false);
  assert.equal(out.kind, "unavailable");
  assert.equal(out.manualFallback, true);
  assert.equal(out.message, "拍照识别暂不可用,可手动添加");
});

test("recognize:网络错/超时(callVl reject)→ unavailable,同 AI_UNAVAILABLE 降级 UX", async function () {
  var t = makeDeps({ vlError: "CLIENT_TIMEOUT" });
  var out = await pv.recognizeWithVl(await pv.preparePhotoForVl(ORIG_PATH, t.deps), undefined, t.deps);
  assert.equal(out.ok, false);
  assert.equal(out.kind, "unavailable");
  assert.equal(out.manualFallback, true);
});

test("recognize:INVALID_INPUT(10MB 门)→ invalid_photo「照片太大,请重拍」,留在入口", async function () {
  var t = makeDeps({ vlResult: { ok: false, error: "INVALID_INPUT", message: "照片参数不合法" } });
  var out = await pv.recognizeWithVl(await pv.preparePhotoForVl(ORIG_PATH, t.deps), undefined, t.deps);
  assert.equal(out.ok, false);
  assert.equal(out.kind, "invalid_photo");
  assert.equal(out.manualFallback, false);
  assert.equal(out.message, "照片太大,请重拍", "§7.4 固定文案(服务端文案对用户无重拍指引)");
});

// ---------- 一步式:recognizePhotoFile ----------

test("一步式:成功带回 prepared(items + 截断);prepare 失败与识别失败各自透传", async function () {
  var ok = makeDeps({ vlResult: GOOD_RESULT });
  var r = await pv.recognizePhotoFile(ORIG_PATH, ok.deps);
  assert.equal(r.ok, true);
  assert.equal(r.prepared.path, COMP_PATH);
  assert.equal(r.prepared.base64, B64);
  assert.equal(r.items.length, 2);
  assert.equal(r.truncated, false);

  var prepFail = makeDeps({ infoFailOn: ORIG_PATH });
  var r2 = await pv.recognizePhotoFile(ORIG_PATH, prepFail.deps);
  assert.equal(r2.ok, false);
  assert.equal(r2.kind, "image_info_failed");
  assert.equal(prepFail.calls.vl.length, 0);

  var vlFail = makeDeps({ vlResult: { ok: false, error: "AI_UNAVAILABLE", message: "拍照识别暂不可用,可手动添加", manual_fallback: true } });
  var r3 = await pv.recognizePhotoFile(ORIG_PATH, vlFail.deps);
  assert.equal(r3.ok, false);
  assert.equal(r3.kind, "unavailable");
  assert.equal(r3.manualFallback, true);
});
