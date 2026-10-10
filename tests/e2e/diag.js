#!/usr/bin/env node
"use strict";

/* 一次性诊断:连接自动化端口,监听小程序 console,触发一次查询,输出真实错误信息 */

const automator = require("miniprogram-automator");

async function main() {
  const miniProgram = await automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" });
  console.log("✔ 已连接");

  const logs = [];
  miniProgram.on("console", (msg) => {
    logs.push("[" + msg.type + "] " + JSON.stringify(msg.args).slice(0, 500));
  });
  miniProgram.on("exception", (err) => {
    logs.push("[exception] " + (err && err.message));
  });

  const page = await miniProgram.currentPage();
  console.log("✔ 当前页面:", page.path);

  const searchInput = await page.$(".search-input");
  await searchInput.input("测试物品");
  const searchBtn = await page.$(".search-btn");
  await searchBtn.tap();
  console.log("已触发查询,等待 6 秒收集 console…");
  await new Promise((r) => setTimeout(r, 6000));

  console.log("---- console 输出 ----");
  if (logs.length === 0) console.log("(无 console 输出)");
  for (const l of logs) console.log(l);

  const page2 = await miniProgram.currentPage();
  const errs = await page2.$$(".error-text");
  for (const el of errs) console.log("页面错误文案:", await el.text());

  await miniProgram.disconnect();
}

main().catch((e) => {
  console.error("诊断失败:", e.message);
  process.exit(1);
});
