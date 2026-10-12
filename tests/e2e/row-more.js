#!/usr/bin/env node
"use strict";

/*
 * 「⋯」操作菜单回归(issue #25:row-more 缺 data-index,处理器读 currentTarget.dataset.index
 * 得 NaN 静默 return,ActionSheet 永不弹出)。
 *
 * 做法:只读定位到一个既有节点(patch wx.showActionSheet 为「只记不弹」,不产生原生 UI、
 * 不触发任何业务写操作),把本层全部「⋯」(位置行 + 物品行)各点一次,断言:
 *   - 每次点击都恰好触发一次 ActionSheet(处理器被调到、data-index 传对);
 *   - 菜单项符合位置行(改名/移动到…/合并到…/删除)或物品行(移动到…/从这里摘除)之一。
 *
 * 前置:微信开发者工具已开自动化端口(cli auto --project <项目根> --auto-port 9420,
 * 可用 AUTO_WS 覆盖)。零写入:只调 locations.list(只读)与页面 UI 导航。
 */

const automator = require("miniprogram-automator");

const WS_ENDPOINT = process.env.AUTO_WS || "ws://127.0.0.1:9420";
const NODE_MENU = ["改名", "移动到…", "合并到…", "删除"];
const ITEM_MENU = ["移动到…", "从这里摘除"];

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      /* 轮询重试 */
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error("超时:" + label);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  const miniProgram = await automator.connect({ wsEndpoint: WS_ENDPOINT });
  try {
    await miniProgram.reLaunch("/pages/index/index");
    await new Promise((r) => setTimeout(r, 3000));

    // 1) 只读找一个节点:自身有物品,或下面还有子位置(两者齐最好,两类「⋯」都能测到)
    const root = await miniProgram.evaluate(
      () =>
        new Promise((resolve) => {
          wx.cloud.callFunction({
            name: "locations",
            data: { action: "list" },
            success: (a) => resolve(a.result),
            fail: (a) => resolve({ ok: false, error: a.errMsg }),
          });
        }),
    );
    assert(root && root.ok, "locations.list 失败:" + JSON.stringify(root).slice(0, 200));
    const children = root.children || [];
    let target =
      children.find((c) => (c.item_count || 0) > 0 && (c.child_count || 0) === 0) ||
      children.find((c) => (c.item_count || 0) > 0) ||
      children.find((c) => (c.child_count || 0) > 0);
    assert(target, "根层没有可回归的节点(需要有位置行或物品行),请先在真实家庭挂载物品");

    // 1b) 若目标自身不带直挂物品但有子位置,下钻一层找直挂物品的节点(item_count 是子树聚合值)
    if ((target.item_count || 0) > 0 && (target.child_count || 0) > 0) {
      const sub = await miniProgram.evaluate(
        (pid) =>
          new Promise((resolve) => {
            wx.cloud.callFunction({
              name: "locations",
              data: { action: "list", parent_id: pid },
              success: (a) => resolve(a.result),
              fail: (a) => resolve({ ok: false }),
            });
          }),
        target.location_id,
      );
      const childWithItems = ((sub && sub.children) || []).find((c) => (c.item_count || 0) > 0);
      if (childWithItems) {
        target = childWithItems;
      }
    }

    // 2) 装记录器(只记不弹:替换 wx.showActionSheet,绝不调原方法)
    await miniProgram.evaluate(() => {
      const g = globalThis;
      g.__moreCalls = [];
      wx.showActionSheet = (opts) => {
        g.__moreCalls.push(opts && opts.itemList);
        if (opts && opts.complete) opts.complete();
      };
      return "patched";
    });

    // 3) 进入该节点浏览模式
    await miniProgram.navigateTo(
      "/pages/locations/locations?node_id=" + encodeURIComponent(target.location_id),
    );
    const page = await waitFor(
      async () => {
        const p = await miniProgram.currentPage();
        if (p && p.path === "pages/locations/locations") {
          const items = await p.data("items");
          const children = await p.data("children");
          if (items.length > 0 || children.length > 0) return p;
        }
        return null;
      },
      20000,
      "进入节点且行渲染",
    );
    const itemNames = (await page.data("items")).map((i) => i.name);
    const nodeNames = (await page.data("children")).map((i) => i.name);
    console.log(
      "✔ 已进入「" +
        target.name +
        "」(位置:" + nodeNames.join("/") + " | 物品:" + itemNames.join("/") + ")",
    );

    // 4) 逐个点本层全部「⋯」,断言每次都触发且菜单项符合两类之一
    const mores = await page.$$(".row-more");
    const expectCount = nodeNames.length + itemNames.length;
    assert(mores.length === expectCount, "「⋯」数量应=位置行+物品行(" + expectCount + "),实际 " + mores.length);
    const calls = [];
    for (const more of mores) {
      await more.tap();
      await new Promise((r) => setTimeout(r, 600));
      const now = await miniProgram.evaluate(() => globalThis.__moreCalls);
      calls.push(now[now.length - 1]);
    }
    const all = await miniProgram.evaluate(() => globalThis.__moreCalls);
    assert(Array.isArray(all) && all.length === mores.length, "每次点击应恰好触发一次 ActionSheet,实际 " + JSON.stringify(all));
    for (let i = 0; i < calls.length; i++) {
      const menu = calls[i] || [];
      const isNode = NODE_MENU.every((m) => menu.indexOf(m) !== -1);
      const isItem = ITEM_MENU.every((m) => menu.indexOf(m) !== -1);
      assert(
        isNode || isItem,
        "第 " + (i + 1) + " 个「⋯」菜单项异常:" + JSON.stringify(menu),
      );
    }
    console.log(
      "✔ " + mores.length + " 个「⋯」全部触发正常(位置菜单 " +
        calls.filter((m) => (m || []).indexOf("改名") !== -1).length +
        " 个 / 物品菜单 " + calls.filter((m) => (m || []).indexOf("从这里摘除") !== -1).length + " 个)",
    );
    console.log("✔ 回归通过:「⋯」事件与 data-index 正常(issue #25 未复发)");
  } finally {
    await miniProgram.disconnect();
  }
}

main().catch((e) => {
  console.error("row-more 回归失败:", e.message);
  process.exit(1);
});
