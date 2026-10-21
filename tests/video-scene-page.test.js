"use strict";
// PR B 页面接线与产品边界静态测试：首页双入口、独立视频扫描页、无自动播放、
// 页面关键状态机方法完整注册。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

test("SCENE-PAGE:app.json 注册独立 pages/video-scan；首页保留拍照并新增多件入口", () => {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, "miniprogram/app.json"), "utf8"));
  assert.ok(app.pages.indexOf("pages/video-scan/video-scan") !== -1);
  const wxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/index/index.wxml"), "utf8");
  assert.ok(wxml.indexOf("onPhotoRecordTap") !== -1);
  assert.ok(wxml.indexOf("onVideoScanTap") !== -1);
  assert.ok(wxml.indexOf("拍照") !== -1);
  assert.ok(wxml.indexOf("多件") !== -1);
  const ts = fs.readFileSync(path.join(ROOT, "miniprogram/pages/index/index.ts"), "utf8");
  assert.ok(ts.indexOf("/pages/video-scan/video-scan") !== -1);
});

test("SCENE-PAGE:页面不自动播放；关键方法与失败恢复入口存在", () => {
  const pageWxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/video-scan/video-scan.wxml"), "utf8");
  assert.equal(pageWxml.indexOf("<video"), -1);
  assert.equal(pageWxml.indexOf("autoplay"), -1);
  assert.ok(pageWxml.indexOf("onChooseVideoTap") !== -1);
  assert.ok(pageWxml.indexOf("onSaveTap") !== -1);
  assert.ok(pageWxml.indexOf("onRetryCommitTap") !== -1);
  assert.ok(pageWxml.indexOf("onDiscardPendingTap") !== -1);

  let page = null;
  global.Page = (options) => { page = options; };
  delete require.cache[require.resolve("../miniprogram/pages/video-scan/video-scan.js")];
  require("../miniprogram/pages/video-scan/video-scan.js");
  assert.ok(page);
  for (const name of ["onChooseVideoTap", "startSceneScan", "onGenerateDraftsTap", "onDraftSplitTap", "onMergeDraftsTap", "onAddManualDraftTap", "onSaveTap", "startSceneUpload", "commitFrozenUpload", "onRetryCommitTap", "onDiscardPendingTap"]) {
    assert.equal(typeof page[name], "function", name);
  }
  assert.equal(page.data.phase, "idle");
  assert.deepEqual(page.data.observations, []);
  assert.deepEqual(page.data.drafts, []);
});
