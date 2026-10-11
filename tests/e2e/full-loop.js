#!/usr/bin/env node
"use strict";

/*
 * 完整闭环 E2E(真实云环境 + 真实 DeepSeek):
 *   记一件(真实 AI 提取)→ 确认页草稿核对 → 保存 → 查询命中 →
 *   详情页改位置 → 版本升到 v2 → 再查询验证新位置
 * 同时记录关键耗时(首次调用含云函数冷启动,对应 issue F4 的实测要求)。
 * 删除路径含原生 wx.showModal,自动化无法点击确认,留作手动验收项。
 */

const automator = require("miniprogram-automator");

function assert(cond, msg) {
  if (!cond) throw new Error("断言失败:" + msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) {
      throw new Error("等待超时(" + label + "," + timeoutMs + "ms)");
    }
    await sleep(300);
  }
}

async function currentPagePath(miniProgram) {
  const page = await miniProgram.currentPage();
  return page ? page.path : "";
}

function fmt(ms) {
  return (ms / 1000).toFixed(2) + "s";
}

async function main() {
  const timings = {};
  const consoleLogs = [];
  const miniProgram = await automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" });
  miniProgram.on("console", (msg) => {
    if (msg.type === "error") consoleLogs.push(JSON.stringify(msg.args).slice(0, 300));
  });
  console.log("✔ 已连接自动化端口");

  await miniProgram.reLaunch("/pages/index/index");
  let page = await miniProgram.currentPage();
  assert(page.path === "pages/index/index", "应在首页,实际 " + page.path);
  await page.waitFor(800);

  // 用时间戳后缀保证每次运行互不干扰
  const stamp = String(Date.now()).slice(-6);
  const itemName = "E2E测试药膏" + stamp;
  const sentence = itemName + "放在厨房左边第二个抽屉";
  const newLocation = "客厅电视柜最下层";

  // ---- 1. 记一件:真实 AI 提取(默认语音模式,先切文字模式) ----
  console.log("【1】记一件:", sentence);
  const modeLink = await page.$(".mode-link");
  if (modeLink !== null) {
    await modeLink.tap();
    await page.waitFor(400);
  }
  const textarea = await page.$(".memo-input");
  await textarea.input(sentence);
  const extractBtn = await page.$(".btn.primary.block");
  const t0 = Date.now();
  await extractBtn.tap();
  page = await waitFor(
    async () => {
      const p = await miniProgram.currentPage();
      return p.path === "pages/confirm/confirm" ? p : null;
    },
    45000,
    "AI 提取并进入确认页",
  );
  timings.extractAndNav = Date.now() - t0;
  console.log("✔ 已进入确认页(耗时 " + fmt(timings.extractAndNav) + ",含云函数执行 + DeepSeek 推理)");

  // ---- 2. 确认页:核对 AI 草稿(列表式,Issue #14) ----
  await page.waitFor(600);
  const banner = await page.$(".banner");
  const bannerText = await banner.text();
  assert(bannerText.includes("AI 草稿"), "确认页应显示「AI 草稿,请确认」,实际:" + bannerText);
  const quoteCard = await page.$(".quote-text");
  assert(quoteCard !== null, "确认页应展示原话(证据回看)");
  const nameInput = await page.$(".row-name");
  const locationInput = await page.$(".row-location");
  assert(nameInput !== null && locationInput !== null, "列表行应有名称/位置输入框");
  const draftName = await nameInput.value();
  const draftLocation = await locationInput.value();
  console.log("✔ AI 草稿:名称=" + JSON.stringify(draftName) + " 位置=" + JSON.stringify(draftLocation));
  assert(String(draftName).includes(itemName.slice(0, 6)), "草稿名称应含物品名,实际 " + draftName);
  assert(String(draftLocation).includes("厨房"), "草稿位置应含「厨房」,实际 " + draftLocation);

  // ---- 3. 保存 ----
  const saveBtn = await page.$(".btn.primary.block");
  await saveBtn.tap();
  const tSave = Date.now();
  page = await waitFor(
    async () => {
      const p = await miniProgram.currentPage();
      return p.path === "pages/index/index" ? p : null;
    },
    20000,
    "保存并返回首页",
  );
  timings.save = Date.now() - tSave;
  console.log("✔ 已保存并返回首页(耗时 " + fmt(timings.save) + ")");
  await page.waitFor(800);

  // ---- 4. 找东西:查询命中 ----
  console.log("【2】找东西:查询", itemName);
  const searchInput = await page.$(".search-input");
  await searchInput.input(itemName);
  const searchBtn = await page.$(".search-go");
  const tQ = Date.now();
  await searchBtn.tap();
  // 只认搜索结果区内的行:「最近记住的」卡片同样渲染 .item-row,查询未返回时会抢先命中
  const row = await waitFor(
    async () => {
      const el = await page.$(".search-wrap .item-row");
      return el;
    },
    20000,
    "查询结果出现",
  );
  timings.query = Date.now() - tQ;
  const rowName = await (await row.$(".item-name")).text();
  const rowLocation = await (await row.$(".item-location")).text();
  console.log("✔ 查询命中:名称=" + rowName + " 位置=" + rowLocation + "(耗时 " + fmt(timings.query) + ")");
  assert(rowName.includes(itemName), "查询结果名称应匹配");
  assert(rowLocation.includes("厨房"), "查询结果位置应为原位置");

  // ---- 5. 详情页:修改位置 ----
  console.log("【3】移动物品到:", newLocation);
  await row.tap();
  page = await waitFor(
    async () => {
      const p = await miniProgram.currentPage();
      return p.path === "pages/item/item" ? p : null;
    },
    15000,
    "进入详情页",
  );
  await page.waitFor(600);
  const meta1 = await (await page.$(".meta")).text();
  assert(meta1.includes("v1"), "详情页应显示版本 v1,实际:" + meta1);
  const itemInputs = await page.$$(".input");
  await itemInputs[1].input(newLocation);
  const updateBtn = await page.$(".btn.primary.block");
  const tU = Date.now();
  await updateBtn.tap();
  await waitFor(
    async () => {
      const meta = await page.$(".meta");
      const text = await meta.text();
      return text.includes("v2") ? text : null;
    },
    20000,
    "保存修改并升级版本 v2",
  );
  timings.update = Date.now() - tU;
  console.log("✔ 修改已保存,版本 v1 → v2(耗时 " + fmt(timings.update) + ")");

  // ---- 6. 再查询验证新位置 ----
  await miniProgram.navigateBack();
  await page.waitFor(800);
  page = await miniProgram.currentPage();
  assert(page.path === "pages/index/index", "应回到首页");
  const searchInput2 = await page.$(".search-input");
  await searchInput2.input(itemName);
  await (await page.$(".search-go")).tap();
  // 旧查询结果仍渲染在页面上,需轮询等新位置替换旧位置
  const finalLocation = await waitFor(
    async () => {
      const loc = await page.$(".search-wrap .item-location");
      if (!loc) return null;
      const text = await loc.text();
      return text.includes("客厅") ? text : null;
    },
    15000,
    "查询结果显示新位置",
  );
  console.log("✔ 修改后查询:位置=" + finalLocation);
  assert(finalLocation.includes(newLocation.slice(0, 3)), "查询结果应显示新位置,实际 " + finalLocation);

  // ---- 汇总 ----
  await miniProgram.screenshot({ path: __dirname + "/screenshot-full-loop.png" });
  console.log("");
  console.log("==== 完整闭环 E2E 通过 ====");
  console.log("耗时分解:");
  console.log("  AI 提取+进确认页(含云函数冷启动可能):" + fmt(timings.extractAndNav));
  console.log("  保存(create):" + fmt(timings.save));
  console.log("  查询(query):" + fmt(timings.query));
  console.log("  修改(update):" + fmt(timings.update));
  if (consoleLogs.length > 0) {
    console.log("期间 console 错误(" + consoleLogs.length + " 条):");
    for (const l of consoleLogs.slice(0, 5)) console.log("  " + l);
  } else {
    console.log("期间无 console 错误");
  }
  console.log("截图:tests/e2e/screenshot-full-loop.png");

  await miniProgram.disconnect();
}

main().catch((e) => {
  console.error("完整闭环 E2E 失败:", e.message);
  process.exit(1);
});
