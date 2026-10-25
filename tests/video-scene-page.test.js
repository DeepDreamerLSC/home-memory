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
  const wxml = fs.readFileSync(path.join(ROOT, "miniprogram/components/voice-bar/voice-bar.wxml"), "utf8");
  assert.ok(wxml.indexOf("onPhotoTap") !== -1);
  assert.ok(wxml.indexOf("onVideoTap") !== -1);
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

// ---------------------------------------------------------------------------
// #116 PR A:B 页「归到」显式挂载接线(逐层选择器、失败如实展示)
// ---------------------------------------------------------------------------

test("SCENE-PAGE-NODE:「归到」行与逐层选择器存在;选择器/清除方法注册;家根不可挂提示", () => {
  const pageWxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/video-scan/video-scan.wxml"), "utf8");
  assert.ok(pageWxml.indexOf("归到：") !== -1, "草稿行有「归到」行");
  assert.ok(pageWxml.indexOf("nodeSelectorVisible") !== -1, "选择器弹层存在");
  assert.ok(pageWxml.indexOf("onNodeOptionTap") !== -1, "选项点击接线");
  assert.ok(pageWxml.indexOf("onNodeDrillTap") !== -1, "逐层下钻接线");
  assert.ok(pageWxml.indexOf("nodeSelectorCanPick") !== -1, "家根不可选的门(仅具体层可选)");

  let page = null;
  global.Page = (options) => { page = options; };
  delete require.cache[require.resolve("../miniprogram/pages/video-scan/video-scan.js")];
  require("../miniprogram/pages/video-scan/video-scan.js");
  assert.ok(page);
  for (const name of ["onDraftNodeTap", "onNodeSelectorCloseTap", "onNodePickCurrentTap", "onNodeOptionTap", "onNodeDrillTap", "onNodeSelectorBackTap", "onNodeSelectorClearTap", "noop"]) {
    assert.equal(typeof page[name], "function", name);
  }
  assert.equal(page.data.nodeSelectorVisible, false);
  assert.equal(page.data.nodeSelectorFor, -1);
  assert.deepEqual(page.data.nodeSelectorStack, []);
});

test("SCENE-PAGE-NODE-DONE:窗口二降级文案走 sceneDoneText(不显完整成功)", () => {
  const pageJs = fs.readFileSync(path.join(ROOT, "miniprogram/pages/video-scan/video-scan.js"), "utf8");
  assert.ok(pageJs.indexOf("sceneDoneText") !== -1, "完成文案由纯函数单一来源");
  const sceneJs = fs.readFileSync(path.join(ROOT, "miniprogram/utils/video-scene.js"), "utf8");
  assert.ok(sceneJs.indexOf("已保存、未挂载") !== -1, "降级文案明确「已保存、未挂载」");
});
