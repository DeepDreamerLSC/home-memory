"use strict";

// Real WeChat rendering with in-memory fixtures only; never submits or mutates cloud records.
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const automator = require("miniprogram-automator");
const { roomArtwork, itemArtwork } = require("../../miniprogram/utils/ui.js");
const output = path.resolve(__dirname, "../../.omx/artifacts/ui-polish-v1");
const sample = { item_id: "ui-preview-key", name: "备用钥匙", location_text: "玄关柜右侧第二个抽屉", note: "", version: 1, updated_at: "2026-10-22T01:00:00.000Z" };

async function main() {
  await fs.mkdir(output, { recursive: true });
  const mp = await automator.connect({ wsEndpoint: process.env.WECHAT_AUTO_ENDPOINT || "ws://127.0.0.1:9420" });
  const exceptions = [];
  mp.on("exception", error => exceptions.push(error));
  try {
    const system = await mp.systemInfo();
    console.log(JSON.stringify({ windowWidth: system.windowWidth, windowHeight: system.windowHeight, platform: system.platform }));
    await mp.reLaunch("/pages/index/index");
    let page = await mp.currentPage();
    await page.waitFor(1500);
    await page.callMethod("onHide");
    await page.setData({
      firstUse: false, queried: false, unmountedView: false, isRootView: true,
      backLabel: "", mapTitle: "家里有什么", mapLoading: false, mapError: "", mapStale: false,
      mapRefreshing: false, rememberedCount: 48, unmountedCount: 0,
      resumeSession: null, photoResume: null, familyShared: false, directItems: [],
      rooms: [
        { name: "客厅", location_id: "preview-living", countText: "12 件" },
        { name: "卧室", location_id: "preview-bedroom", countText: "16 件" },
        { name: "书房", location_id: "preview-study", countText: "11 件" },
        { name: "厨房", location_id: "preview-kitchen", countText: "9 件" },
      ].map(room => ({ ...room, artwork: roomArtwork(room.name), artworkDark: roomArtwork(room.name, true) })),
      dueBanner: { text: "2 件物品即将到期" },
      recentItems: [{ ...sample, artwork: itemArtwork(sample.name), artworkDark: itemArtwork(sample.name, true), updated_at_short: "今天" }],
      recentError: false,
    });
    await page.waitFor(400);
    assert.equal((await page.$$(".roomtile")).length, 4);
    assert.equal(await (await page.$(".mtitle")).text(), "家里有什么");
    await mp.screenshot({ path: path.join(output, "home.png") });
    const bar = await page.$("#global-voice-bar");
    assert.ok(bar, "home has the shared recording entry");
    await bar.callMethod("onAddTap");
    await page.waitFor(300);
    assert.equal(await bar.data("showActions"), true);
    await mp.screenshot({ path: path.join(output, "add-sheet.png") });
    await (await bar.$(".txtbtn")).tap();
    await page.waitFor(700);
    page = await mp.currentPage();
    assert.equal(page.path, "pages/confirm/confirm");
    assert.equal(await page.$("textarea"), null);
    await page.callMethod("onToggleManualNote");
    assert.ok(await page.$("textarea"), "optional notes remain reachable");
    await page.callMethod("onToggleManualNote");
    await page.setData({ name: "备用钥匙", locationText: "玄关柜右侧第二个抽屉" });
    await mp.screenshot({ path: path.join(output, "manual.png") });
    await page.setData({
      isManual: false, headTitle: "核对记录", headSub: "", checkedCount: 1, quoteOpen: false,
      originalText: "备用钥匙放在玄关柜右侧第二个抽屉里了。", truncated: false,
      rows: [{ key: "preview", name: sample.name, locationText: sample.location_text, certain: true, status: "pending", checked: true, mountPathText: "客厅 / 玄关柜", sourceQuote: "备用钥匙放在玄关柜右侧第二个抽屉里了。" }],
    });
    await page.waitFor(300);
    await mp.screenshot({ path: path.join(output, "confirm.png") });
    await mp.navigateTo("/pages/item/item?data=" + encodeURIComponent(JSON.stringify(sample)) + "&path=" + encodeURIComponent(JSON.stringify(["我的家", "客厅", "玄关柜"])));
    page = await mp.currentPage();
    await page.waitFor(1000);
    assert.ok(await page.$(".detail-dock"));
    assert.equal(await page.$("#global-voice-bar"), null);
    await mp.screenshot({ path: path.join(output, "detail.png") });
    await page.callMethod("onQuoteToggle");
    assert.equal(await page.data("detailQuoteOpen"), true);
    await mp.reLaunch("/pages/index/index");
    page = await mp.currentPage();
    await page.waitFor(800);
    await page.callMethod("onHide");
    await page.setData({ firstUse: true, queried: false, mapLoading: false, mapError: "", resumeSession: null, photoResume: null, mapStale: false });
    await page.waitFor(300);
    assert.equal(await page.$("#global-voice-bar"), null);
    await mp.screenshot({ path: path.join(output, "first-use.png") });
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    await fs.writeFile(path.join(output, "checks.json"), JSON.stringify({ platform: system.platform, width: system.windowWidth, height: system.windowHeight, cloudWrites: false, exceptions, checks: ["home-four-room-cards", "recording-methods-sheet", "text-entry-navigation", "confirm-fields", "detail-task-dock", "quote-toggle", "first-use"] }, null, 2));
    console.log("PASS: native rendering, optional notes and seven UI flows; no cloud writes.");
  } finally {
    await mp.reLaunch("/pages/index/index").catch(() => {});
    await mp.disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
