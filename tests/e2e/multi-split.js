#!/usr/bin/env node
/*
 * Issue #14 E2E:一句话两件物品 → 自动拆分 → 列表确认 → 逐件入库 → 分别可查。
 * 真实云环境 + 真实 DeepSeek(v2 拆分协议)。
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

async function main() {
  const stamp = String(Date.now()).slice(-6);
  const itemA = "E2E拆分甲" + stamp;
  const itemB = "E2E拆分乙" + stamp;
  const sentence = itemA + "放在书房左边抽屉," + itemB + "放在阳台置物架";

  const mp = await automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" });
  console.log("✔ 已连接自动化端口");
  await mp.reLaunch("/pages/index/index");
  let page = await mp.currentPage();
  assert(page.path === "pages/index/index", "应在首页");
  await page.waitFor(800);

  // 1. 文字模式输入两件一句话
  console.log("【1】一句话两件:", sentence);
  const modeLink = await page.$(".mode-link");
  await modeLink.tap();
  await page.waitFor(400);
  const textarea = await page.$(".memo-input");
  await textarea.input(sentence);
  await (await page.$(".btn.primary.block")).tap();

  page = await waitFor(
    async () => {
      const p = await mp.currentPage();
      return p.path === "pages/confirm/confirm" ? p : null;
    },
    45000,
    "AI 拆分并进入确认页",
  );
  console.log("✔ 已进入确认页");

  // 2. 列表应有 2 行,各含对应名称与位置
  await page.waitFor(600);
  const names = await page.$$(".row-name");
  const locations = await page.$$(".row-location");
  const quotes = await page.$$(".row-meta.quote");
  assert(names.length === 2, "应拆出 2 行,实际 " + names.length);
  assert(locations.length === 2, "位置输入框应有 2 个");
  const v0 = String(await names[0].value());
  const v1 = String(await names[1].value());
  const l0 = String(await locations[0].value());
  const l1 = String(await locations[1].value());
  console.log("✔ 拆分结果:" + v0 + "@" + l0 + " / " + v1 + "@" + l1);
  const firstIsA = v0.includes(itemA);
  assert(
    (firstIsA && v1.includes(itemB)) || (!firstIsA && v0.includes(itemB)),
    "两行应分别是甲/乙,实际 " + v0 + " / " + v1,
  );
  assert((firstIsA ? l0 : l1).includes("书房"), "甲应配书房");
  assert((firstIsA ? l1 : l0).includes("阳台"), "乙应配阳台(位置不得串配)");
  const quoteText = quotes.length > 0 ? await quotes[0].text() : "";
  console.log("✔ 原话证据示例:" + quoteText);

  // 3. 一次确认保存两件
  await (await page.$(".btn.primary.block")).tap();
  page = await waitFor(
    async () => {
      const p = await mp.currentPage();
      return p.path === "pages/index/index" ? p : null;
    },
    30000,
    "批量保存并返回首页",
  );
  console.log("✔ 两件已保存并返回首页");

  // 4. 分别搜索命中各自位置(等待条件须匹配本轮物品名:上一轮结果残留在搜索区会抢先命中)
  for (const [item, expectLoc] of [
    [itemA, "书房"],
    [itemB, "阳台"],
  ]) {
    const searchInput = await page.$(".search-input");
    await searchInput.input(item);
    await (await page.$(".search-go")).tap();
    const row = await waitFor(
      async () => {
        const el = await page.$(".search-wrap .item-row");
        if (!el) return null;
        const nameText = await (await el.$(".item-name")).text();
        return nameText.includes(item) ? el : null;
      },
      20000,
      "查询 " + item + " 出结果",
    );
    const locText = await (await row.$(".item-location")).text();
    assert(locText.includes(expectLoc), item + " 位置应为" + expectLoc + ",实际 " + locText);
    console.log("✔ " + item + " → " + locText);
  }

  await mp.screenshot({ path: __dirname + "/screenshot-multi-split.png" });
  console.log("");
  console.log("==== 多件拆分 E2E 通过(Issue #14 主路径)====");
  await mp.disconnect();
}

main().catch((e) => {
  console.error("多件拆分 E2E 失败:", e.message);
  process.exit(1);
});
