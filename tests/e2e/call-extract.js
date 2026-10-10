#!/usr/bin/env node
"use strict";

/* 直接调用 extractDraft 云函数,输出原始返回与耗时(不经 UI) */

const automator = require("miniprogram-automator");

async function main() {
  const mp = await automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" });
  const t0 = Date.now();
  const raw = await mp.evaluate(() =>
    new Promise((resolve) => {
      wx.cloud.callFunction({
        name: "extractDraft",
        data: { text: "诊断调用:指甲刀放在书房左边第二个抽屉" },
        success: (r) => resolve({ kind: "success", result: r.result }),
        fail: (e) => resolve({ kind: "fail", errMsg: e.errMsg }),
      });
    }),
  );
  console.log("云函数原始返回(耗时 " + (Date.now() - t0) + "ms):");
  console.log(JSON.stringify(raw, null, 2));
  await mp.disconnect();
}

main().catch((e) => {
  console.error("诊断失败:", e.message);
  process.exit(1);
});
