#!/usr/bin/env node
"use strict";

/*
 * P0-2 安全证据采集:验证「小程序客户端直连 items 集合」被数据库权限规则拒绝。
 * 前提:云开发控制台 → 数据库 → items → 权限设置已设为「所有用户不可读不可写」
 * (所有业务访问都走云函数,云函数以管理端身份绕过权限规则,客户端无需任何直连权限)。
 * 运行:node tests/e2e/security-probe.js
 */

const automator = require("miniprogram-automator");

/** 只有「明确的权限拒绝」才算通过:空集合、唯一键冲突(E11000)等都不是权限拒绝 */
function isPermissionDenied(res) {
  if (res.kind !== "read-deny" && res.kind !== "add-deny") {
    return false;
  }
  const msg = String(res.errMsg || "");
  return /permission/i.test(msg) || /DATABASE_PERMISSION_DENIED/.test(msg);
}

function judge(readRes, addRes) {
  console.log("");
  if (isPermissionDenied(readRes) && isPermissionDenied(addRes)) {
    console.log("== 通过:客户端直连读与写均被权限规则明确拒绝 ==");
    return;
  }
  console.log("== 未通过:存在客户端直连通道或拒绝原因不是权限 ==");
  if (!isPermissionDenied(readRes)) {
    console.log("   读取未通过:" + (readRes.kind === "read-ok" ? "读取成功(含空结果)不代表被拒绝" : "拒绝原因非权限:" + readRes.errMsg));
  }
  if (!isPermissionDenied(addRes)) {
    console.log("   写入未通过:" + (addRes.kind === "add-ok" ? "写入成功" : "拒绝原因非权限(如唯一键冲突):" + addRes.errMsg));
  }
  process.exitCode = 1;
}

async function main() {
  const mp = await automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" });
  console.log("✔ 已连接,以小程序客户端身份直连 items 集合……");

  const readRes = await mp.evaluate(() =>
    new Promise((resolve) => {
      const db = wx.cloud.database();
      db.collection("items")
        .get()
        .then((r) => resolve({ kind: "read-ok", count: (r.data || []).length }))
        .catch((e) => resolve({ kind: "read-deny", errMsg: String(e.errMsg || e).slice(0, 200) }));
    }),
  );
  console.log("直连读取:", JSON.stringify(readRes));

  const addRes = await mp.evaluate(() =>
    new Promise((resolve) => {
      const db = wx.cloud.database();
      db.collection("items")
        .add({ data: { probe: "permission-check-可删除的探测文档" } })
        .then((r) => resolve({ kind: "add-ok", id: r._id }))
        .catch((e) => resolve({ kind: "add-deny", errMsg: String(e.errMsg || e).slice(0, 200) }));
    }),
  );
  console.log("直连写入:", JSON.stringify(addRes));

  await mp.disconnect();
  judge(readRes, addRes);
}

main().catch((e) => {
  console.error("探测失败:", e.message);
  process.exit(1);
});
