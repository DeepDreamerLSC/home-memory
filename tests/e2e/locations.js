#!/usr/bin/env node
"use strict";

/*
 * 位置树端到端闭环(issue #18,真实云环境 + 真实 DeepSeek):
 *   录入带层级位置的物品(书房桌子右边第二个抽屉)→ 确认保存 →
 *   进「我的家」→ 生成/同步向导(scanHousehold 草案 → AI 拿不准的逐项勾选 →
 *   applyScan 一次入库)→ 空间下钻:书房 → 桌子 → 右边第二个抽屉 → 断言物品在。
 * 前置:微信开发者工具已开自动化端口(cli auto --project <项目根> --auto-port 9420);
 * extractDraft / itemsApi / locations 云函数已部署(云环境 mine-d2gk3n3fq609fb244)。
 * 需要用户确认的步骤(AI 草案默认不勾选的行)在流程里逐项点勾,模拟用户核对。
 */

const automator = require("miniprogram-automator");

const WS_ENDPOINT = "ws://127.0.0.1:9420";
/** 向导中断恢复的 storage 键(与 pages/locationScan/locationScan.ts 保持一致) */
const SCAN_PENDING_KEY = "location_scan_pending";
const SHOT_PATH = __dirname + "/screenshot-locations.png";

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
    await sleep(500);
  }
}

function fmt(ms) {
  return (ms / 1000).toFixed(2) + "s";
}

/** 在候选行列表里按子选择器文本找行(返回第一个命中的行) */
async function rowByText(rows, selector, needle) {
  for (const row of rows) {
    const el = await row.$(selector);
    if (el === null) continue;
    const text = await el.text();
    if (text && text.includes(needle)) return row;
  }
  return null;
}

/** 调试辅助:当前页各行 .item-name 文本 */
async function dumpRowNames(page, rowSelector) {
  const rows = await page.$$(rowSelector);
  const names = [];
  for (const row of rows) {
    const el = await row.$(".item-name");
    names.push(el === null ? "?" : await el.text());
  }
  return names;
}

async function main() {
  const timings = {};
  let miniProgram = null;
  try {
    miniProgram = await automator.connect({ wsEndpoint: WS_ENDPOINT });
    await run(miniProgram, timings);
  } finally {
    if (miniProgram !== null) {
      try {
        await miniProgram.screenshot({ path: SHOT_PATH });
        console.log("截图:" + SHOT_PATH);
      } catch (e) {
        console.log("(截图失败,不影响结论:" + e.message + ")");
      }
      await miniProgram.disconnect();
    }
  }
  console.log("");
  console.log("==== 位置树端到端闭环通过 ====");
  console.log("耗时分解:");
  console.log("  AI 提取+进确认页(含冷启动可能):" + fmt(timings.extract || 0));
  console.log("  保存(create):" + fmt(timings.save || 0));
  console.log("  向导扫描(scanHousehold,真实 LLM):" + fmt(timings.scan || 0));
  console.log("  确认入库(applyScan):" + fmt(timings.apply || 0));
}

async function run(miniProgram, timings) {
  console.log("✔ 已连接自动化端口", WS_ENDPOINT);
  // 清掉向导中断恢复记录:残留会触发原生 wx.showModal,自动化点不了原生弹窗
  try {
    await miniProgram.callWxMethod("removeStorageSync", SCAN_PENDING_KEY);
  } catch (e) {
    console.log("(清理向导待提交记录失败,继续:" + e.message + ")");
  }

  await miniProgram.reLaunch("/pages/index/index");
  let page = await miniProgram.currentPage();
  assert(page.path === "pages/index/index", "应在首页,实际 " + page.path);
  await page.waitFor(800);

  // 用时间戳后缀保证每次运行互不干扰
  const stamp = String(Date.now()).slice(-6);
  const itemName = "E2E位置树充电宝" + stamp;
  const sentence = itemName + "放在书房桌子右边第二个抽屉";

  // ---- 1. 记一件:真实 AI 提取(默认语音模式,先切文字模式) ----
  console.log("【1】记一件:", sentence);
  const modeLink = await page.$(".mode-link");
  if (modeLink !== null) {
    await modeLink.tap();
    await page.waitFor(400);
  }
  const textarea = await page.$(".memo-input");
  await textarea.input(sentence);
  const t0 = Date.now();
  await (await page.$(".btn.primary.block")).tap();
  page = await waitFor(
    async () => {
      const p = await miniProgram.currentPage();
      return p.path === "pages/confirm/confirm" ? p : null;
    },
    45000,
    "AI 提取并进入确认页",
  );
  timings.extract = Date.now() - t0;
  await page.waitFor(600);
  const inputs = await page.$$(".input");
  assert(inputs.length >= 2, "确认页应有名称/位置两个输入框");
  const draftName = String(await inputs[0].value());
  const draftLocation = String(await inputs[1].value());
  console.log("✔ AI 草稿:名称=" + JSON.stringify(draftName) + " 位置=" + JSON.stringify(draftLocation));
  assert(draftName.includes("充电宝"), "草稿名称应含「充电宝」,实际 " + draftName);
  assert(draftLocation.includes("书房"), "草稿位置应含「书房」,实际 " + draftLocation);
  // 后续行匹配优先用时间戳(唯一);AI 若丢了时间戳则退回草稿名全文
  const needle = draftName.includes(stamp) ? stamp : draftName;

  // ---- 2. 确认保存 ----
  await (await page.$(".btn.primary.block")).tap();
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

  // ---- 3. 进「我的家」 ----
  console.log("【2】进「我的家」");
  const homeRow = await rowByText(await page.$$(".item-row"), ".item-name", "按空间浏览");
  assert(homeRow !== null, "首页应有「按空间浏览」入口行");
  await homeRow.tap();
  page = await waitFor(
    async () => {
      const p = await miniProgram.currentPage();
      return p.path === "pages/locations/locations" ? p : null;
    },
    15000,
    "进入「我的家」",
  );
  await page.waitFor(500);
  const loadError = await page.$(".error-text");
  assert(loadError === null, "「我的家」不应有加载错误,实际 " + (loadError ? await loadError.text() : ""));

  // 根层常驻入口:刚录入了未挂载物品,应显示「N 件未归位」
  const scanEntry = await waitFor(
    async () => (await page.$(".scan-entry")),
    15000,
    "根层出现「生成/更新空间树」常驻入口",
  );
  const entryText = (await scanEntry.text()).replace(/\s+/g, " ");
  console.log("✔ 生成入口:" + entryText);
  assert(entryText.includes("未归位"), "生成入口应显示未归位计数,实际 " + entryText);

  // ---- 4. 向导:scanHousehold 草案(真实 LLM,客户端超时 70s,放宽等待) ----
  console.log("【3】生成向导:扫描已录入物品位置…(真实 LLM,最长约 1 分钟)");
  await scanEntry.tap();
  page = await waitFor(
    async () => {
      const p = await miniProgram.currentPage();
      return p.path === "pages/locationScan/locationScan" ? p : null;
    },
    15000,
    "进入生成向导",
  );
  const tScan = Date.now();
  page = await waitFor(
    async () => {
      const p = await miniProgram.currentPage();
      if (p.path !== "pages/locationScan/locationScan") return null;
      const err = await p.$(".error-text");
      if (err !== null) {
        throw new Error("向导扫描失败(错误如实上屏):" + (await err.text()));
      }
      const titles = await p.$$(".card-title");
      for (const t of titles) {
        const text = await t.text();
        if (text.includes("物品归位") || text.includes("候选空间")) return p;
      }
      const empty = await p.$(".empty-text");
      if (empty !== null) {
        const text = await empty.text();
        if (text.includes("全部已归位")) {
          throw new Error("向导显示「全部已归位」,但刚录入的物品应未挂载");
        }
      }
      return null;
    },
    110000,
    "扫描完成进入草案确认页",
  );
  timings.scan = Date.now() - tScan;
  console.log("✔ 扫描完成,进入草案确认页(耗时 " + fmt(timings.scan) + ")");

  // ---- 5. 用户确认:AI 拿不准的行默认不勾,流程里逐项点勾 ----
  // 5a. 物品归位行(need_confirm 的默认 ☐,点行勾选 = 用户核对确认)
  let mountRow = await rowByText(await page.$$(".tree-row"), ".item-name", needle);
  assert(
    mountRow !== null,
    "向导应列出刚录入的物品(" + needle + "),归位草案:" +
      JSON.stringify(await dumpRowNames(page, ".tree-row")),
  );
  let check = await mountRow.$(".tree-check");
  if ((await check.text()).includes("☐")) {
    console.log("  物品归位行默认未勾选(AI 拿不准),点击勾选(用户确认)…");
    await mountRow.tap();
    await page.waitFor(400);
    mountRow = await rowByText(await page.$$(".tree-row"), ".item-name", needle);
    check = await mountRow.$(".tree-check");
  }
  const mountCheckText = await check.text();
  assert(mountCheckText.includes("☑"), "物品归位行应已勾选,实际 " + mountCheckText);
  const mountPathEl = await mountRow.$(".item-location");
  console.log("✔ 归位草案:" + (await mountPathEl.text()));
  assert(
    (await mountPathEl.text()).includes("书房"),
    "归位草案路径应含「书房」,实际 " + (await mountPathEl.text()),
  );

  // 5b. 候选树分支(书房/桌子/右边第二个抽屉):未勾选的逐个勾上(级联勾整支)
  for (const seg of ["书房", "桌子", "右边第二个抽屉"]) {
    const segRow = await rowByText(await page.$$(".tree-row"), ".item-name", seg);
    if (segRow === null) {
      console.log("  (树草案没有「" + seg + "」独立行;挂载完整路径由入库自动建全)");
      continue;
    }
    const segCheck = await segRow.$(".tree-check");
    if ((await segCheck.text()).includes("☐")) {
      await segRow.tap();
      await page.waitFor(400);
      console.log("✔ 已勾选树分支:「" + seg + "」(默认不勾,由用户确认)");
    }
  }

  // ---- 6. 确认入库(单次 applyScan;客户端超时 70s,放宽等待) ----
  const submitBtn = await page.$(".btn.primary.block");
  assert(submitBtn !== null, "确认页应有「确认入库」主按钮");
  const submitText = await submitBtn.text();
  assert(submitText.includes("确认入库"), "主按钮应为「确认入库」,实际 " + submitText);
  console.log("【4】确认入库(applyScan 一次提交)…");
  const tApply = Date.now();
  await submitBtn.tap();
  page = await waitFor(
    async () => {
      const p = await miniProgram.currentPage();
      if (p.path !== "pages/locationScan/locationScan") return null;
      const titles = await p.$$(".card-title");
      for (const t of titles) {
        if ((await t.text()).includes("入库结果")) return p;
      }
      const err = await p.$(".error-text");
      if (err !== null) {
        throw new Error("入库失败(错误如实上屏):" + (await err.text()));
      }
      return null;
    },
    100000,
    "applyScan 入库并渲染结果页",
  );
  timings.apply = Date.now() - tApply;
  console.log("✔ 入库完成(耗时 " + fmt(timings.apply) + ")");

  // ---- 7. 结果页:该物品应「已挂载」 ----
  const resultRow = await rowByText(await page.$$(".item-row"), ".item-name", needle);
  assert(
    resultRow !== null,
    "结果页应列出该物品(" + needle + "):" + JSON.stringify(await dumpRowNames(page, ".item-row")),
  );
  const statusText = await (await resultRow.$(".item-location")).text();
  console.log("✔ 入库结果:" + statusText);
  assert(statusText.includes("已挂载"), "该物品应「已挂载」,实际 " + statusText);

  await (await page.$(".btn.primary.block")).tap();
  page = await waitFor(
    async () => {
      const p = await miniProgram.currentPage();
      return p.path === "pages/locations/locations" ? p : null;
    },
    15000,
    "完成后返回「我的家」",
  );
  await page.waitFor(500);

  // ---- 8. 空间浏览下钻:书房 → 桌子 → 右边第二个抽屉(面包屑逐层核对) ----
  console.log("【5】空间浏览下钻");
  async function drill(seg, crumbTail) {
    const row = await waitFor(
      async () => rowByText(await (await miniProgram.currentPage()).$$(".item-row"), ".item-name", seg),
      20000,
      "当前层出现「" + seg + "」",
    );
    await row.tap();
    const crumb = await waitFor(
      async () => {
        const p = await miniProgram.currentPage();
        const el = await p.$(".crumb");
        if (el === null) return null;
        const text = (await el.text()).replace(/\s+/g, " ");
        return text.endsWith(crumbTail) ? text : null;
      },
      20000,
      "面包屑更新为「" + crumbTail + "」",
    );
    console.log("✔ 已下钻:" + crumb);
  }

  await drill("书房", "书房");
  await drill("桌子", "书房 / 桌子");
  await drill("右边第二个抽屉", "书房 / 桌子 / 右边第二个抽屉");

  // ---- 9. 抽屉层断言物品在 ----
  page = await miniProgram.currentPage();
  const finalRow = await waitFor(
    async () => rowByText(await (await miniProgram.currentPage()).$$(".item-row"), ".item-name", needle),
    20000,
    "抽屉层出现物品(" + needle + ")",
  );
  const finalLoc = await (await finalRow.$(".item-location")).text();
  console.log("✔ 物品已在「右边第二个抽屉」:" + finalLoc);
  assert(finalLoc.includes("原始记录"), "物品行应显示原始位置记录,实际 " + finalLoc);
  assert(finalLoc.includes("书房"), "原始记录应含「书房」,实际 " + finalLoc);
}

main().catch((e) => {
  console.error("位置树 E2E 失败:", e.message);
  process.exit(1);
});
