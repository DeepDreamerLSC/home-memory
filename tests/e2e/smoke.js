#!/usr/bin/env node
"use strict";

/*
 * 小程序端到端冒烟测试(需先开启自动化端口):
 *   cli auto --project <项目根> --auto-port 9420
 *   node tests/e2e/smoke.js
 * 云环境未配置时同样可跑:重点验证编译产物可运行、页面渲染、
 * 输入交互、以及失败路径如实呈现(不静默)。
 */

const path = require("node:path");
const automator = require("miniprogram-automator");

const WS_ENDPOINT = "ws://127.0.0.1:9420";
const SHOT_PATH = path.join(__dirname, "screenshot-index.png");

function assert(cond, msg) {
  if (!cond) throw new Error("断言失败:" + msg);
}

async function main() {
  console.log("连接自动化端口", WS_ENDPOINT, "…");
  const miniProgram = await automator.connect({ wsEndpoint: WS_ENDPOINT });
  console.log("✔ 已连接");

  // 自动化会话刚建立时首条命令可能超时,轻量探测 + 重试
  let ready = false;
  let lastErr = null;
  for (let i = 1; i <= 5 && !ready; i++) {
    try {
      const info = await miniProgram.systemInfo();
      console.log("✔ 自动化就绪(第 " + i + " 次探测,SDKVersion " + info.SDKVersion + ")");
      ready = true;
    } catch (e) {
      lastErr = e;
      console.log("  探测 " + i + "/5 失败:" + e.message + ",2 秒后重试…");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!ready) {
    throw new Error("自动化会话未就绪:" + (lastErr ? lastErr.message : "未知"));
  }

  // 确保停回首页(重试兼容首跳超时)
  let page = null;
  for (let i = 1; i <= 3 && page === null; i++) {
    try {
      page = await miniProgram.currentPage();
    } catch (e) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (page === null) {
    await miniProgram.reLaunch("/pages/index/index");
    await page.waitFor(1500);
    page = await miniProgram.currentPage();
  }
  console.log("✔ 当前页面:", page.path);
  assert(page.path === "pages/index/index", "启动后应停在首页 pages/index/index");

  await page.waitFor(1000);

  // 1. 三张卡片渲染
  const titles = await page.$$(".card-title");
  const texts = [];
  for (const t of titles) texts.push(await t.text());
  console.log("✔ 卡片标题:", texts.join(" / "));
  assert(texts.length === 3, "首页应有「记一件/找东西/最近记录」三张卡片,实际 " + texts.length + " 张");
  assert(
    texts[0] === "记一件" && texts[1] === "找东西" && texts[2] === "最近记录",
    "卡片标题与预期不符:" + JSON.stringify(texts),
  );

  // 2. 默认应为语音模式(语音极速录入是核心场景)
  const tabs0 = await page.$$(".mode-tab");
  assert(tabs0.length === 2, "应有 文字/语音 两个模式切换标签");
  const talkDefault = await page.$(".talk-btn");
  assert(talkDefault !== null, "默认应展示语音输入界面(按住说话)");

  // 2.5 语音模式 UI:切文字再切回语音(文字回退路径)
  const tabs = await page.$$(".mode-tab");
  await tabs[0].tap();
  await page.waitFor(400);
  const textareaBack = await page.$(".memo-input");
  assert(textareaBack !== null, "切回文字模式应显示输入框(文字回退可用)");
  console.log("✔ 文字模式正常(文字回退可用)");
  const tabsBack = await page.$$(".mode-tab");
  await tabsBack[1].tap();
  await page.waitFor(400);
  const talkBtn = await page.$(".talk-btn");
  assert(talkBtn !== null, "语音模式下应显示「按住说话」按钮");
  console.log("✔ 语音模式 UI 正常(按住说话按钮可见)");

  // 2.6 文字输入交互(切到文字模式)
  const tabsText = await page.$$(".mode-tab");
  await tabsText[0].tap();
  await page.waitFor(400);
  const textarea = await page.$(".memo-input");
  assert(textarea !== null, "应找到「记一件」输入框");
  await textarea.input("钥匙放在玄关第二个抽屉");
  await page.waitFor(300);
  const countEl = await page.$(".char-count");
  const countText = countEl === null ? "" : await countEl.text();
  console.log("✔ 输入后字数统计:", countText);
  assert(countText.includes("/500"), "字数统计应随输入更新");

  // 3. 找东西:查询结果如实呈现(云可用时空结果是正常结果;不可用时错误如实上屏)
  const searchInput = await page.$(".search-input");
  assert(searchInput !== null, "应找到「找东西」输入框");
  await searchInput.input("钥匙");
  const searchBtn = await page.$(".search-btn");
  assert(searchBtn !== null, "应找到「查一下」按钮");
  await searchBtn.tap();
  console.log("已点击「查一下」,等待查询结果…");
  await page.waitFor(4000);
  const errEls = await page.$$(".error-text");
  const emptyEl = await page.$(".empty-text");
  const rowEl = await page.$(".item-row");
  const errTexts = [];
  for (const el of errEls) errTexts.push(await el.text());
  if (errTexts.length > 0) {
    console.log("✔ 页面内错误提示(失败如实呈现):", JSON.stringify(errTexts));
    for (const t of errTexts) assert(t.trim().length > 0, "错误提示不应为空字符串");
  } else if (emptyEl !== null || rowEl !== null) {
    console.log("✔ 查询结果如实呈现(空结果/命中,云可用时为正常路径)");
  } else {
    assert.fail("查询后应出现错误提示、空结果或命中之一,均无则为静默失败");
  }

  // 4. 截图留档
  try {
    await miniProgram.screenshot({ path: SHOT_PATH });
    console.log("✔ 截图已保存:", SHOT_PATH);
  } catch (e) {
    console.log("(截图失败,不影响冒烟结论:" + e.message + ")");
  }

  await miniProgram.disconnect();
  console.log("");
  console.log("冒烟通过:页面渲染、输入交互、失败如实呈现均正常。");
}

main()
  .catch((e) => {
    console.error("冒烟失败:", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode || 0);
  });
