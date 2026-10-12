#!/usr/bin/env node
"use strict";

/*
 * 选择器逐层下钻回归(issue #27:深层选中事件断链 + 「选这个」隐蔽)。
 *
 * 背景:EventChannel 只连相邻两层,发起页(openPicker)只在第一层注册监听;
 * 修复 = onChildTap 选择模式下钻时逐层转发 pickNode + 非根层顶部「就选这里」。
 *
 * 做法:零写入驱动——拦截 wx.showActionSheet/showModal 自动应答,拦截
 * action=merge 的云调用(记录参数即假成功,不转发)。下钻一层后点「就选这里」,
 * 断言 merge 恰好一次、source=发起合并的根层节点、target=下钻后当前层。
 *
 * 前置:微信开发者工具自动化端口(cli auto --auto-port 9420,可用 AUTO_WS 覆盖);
 * 真实家庭根层至少有一个带子位置的节点(冰箱/书房类)。
 */

const automator = require("miniprogram-automator");

const WS_ENDPOINT = process.env.AUTO_WS || "ws://127.0.0.1:9420";

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

async function main() {
  const mp = await automator.connect({ wsEndpoint: WS_ENDPOINT });
  try {
    await mp.reLaunch("/pages/index/index");
    await new Promise((r) => setTimeout(r, 3000));

    // 1) 只读:source=根层叶子节点(排除逻辑不禁其它行),drill=另一个带子位置的根层节点
    //    (不能下钻 source 自己——排除逻辑会正确禁选;镜像 issue #27 真机场景:
    //    source=根层冰箱,drill=书房,在书房层「就选这里」)
    const probe = await mp.evaluate(
      () =>
        new Promise((resolve) => {
          wx.cloud.callFunction({
            name: "locations",
            data: { action: "list" },
            success: (a) => {
              const r = a.result;
              const kids = (r.children || []).filter((c) => (c.child_count || 0) > 0);
              const leaf = (r.children || []).find((c) => (c.child_count || 0) === 0);
              resolve({ ok: !!(kids.length > 0 && leaf), source: leaf, drill: kids[0] });
            },
            fail: () => resolve({ ok: false }),
          });
        }),
    );
    assert(probe && probe.ok, "前置不满足:根层需要至少一个叶子节点和一个带子位置的节点");

    // 2) 拦截:ActionSheet 选「合并到…」(index 2),Modal 确认,merge 只记不发
    await mp.evaluate(() => {
      const g = globalThis;
      g.__mergeCalls = [];
      wx.showActionSheet = (o) => {
        if (o.success) o.success({ tapIndex: 2 });
      };
      wx.showModal = (o) => {
        if (o.success) o.success({ confirm: true });
      };
      const cf = wx.cloud.callFunction.bind(wx.cloud);
      wx.cloud.callFunction = (o) => {
        if (o && o.data && o.data.action === "merge") {
          g.__mergeCalls.push({ s: o.data.source_node_id, t: o.data.target_node_id });
          if (o.success) setTimeout(() => o.success({ result: { ok: true, remounted: 0 } }), 50);
          return;
        }
        return cf(o);
      };
      return 1;
    });

    // 3) 发起合并:source 行的 ⋯
    await mp.navigateTo("/pages/locations/locations");
    await new Promise((r) => setTimeout(r, 3500));
    let page = await mp.currentPage();
    const rows = await page.$$(".item-row");
    const mores = await page.$$(".row-more");
    let tapped = false;
    for (let i = 0; i < rows.length && i < mores.length; i++) {
      const t = await (await rows[i].$(".item-name")).text();
      if (t.trim().indexOf(probe.source.name) === 0) {
        await mores[i].tap();
        tapped = true;
        break;
      }
    }
    assert(tapped, "未找到 source 行的 ⋯");
    await new Promise((r) => setTimeout(r, 2500));

    // 4) 选择器第一层(B):下钻 drill 节点(source 行被排除逻辑禁选,不碰)
    page = await mp.currentPage();
    assert((await page.data("mode")) === "pick", "未进入选择器");
    let drilled = false;
    for (const row of await page.$$(".item-row")) {
      const t = await (await row.$(".item-name")).text();
      if (t.trim().indexOf(probe.drill.name) === 0) {
        await row.tap();
        drilled = true;
        break;
      }
    }
    assert(drilled, "选择器第一层未找到 drill 行");
    await new Promise((r) => setTimeout(r, 2200));

    // 5) 深层(C = drill 层):点「就选这里」
    page = await mp.currentPage();
    const crumb = await page.data("breadcrumbText");
    assert((await page.data("currentNodeName")) === probe.drill.name, "深层当前层应为 drill 节点,实际 " + crumb);
    const pickCard = await page.$(".pick-current");
    assert(pickCard, "未找到「就选这里」卡片");
    await pickCard.tap();
    await new Promise((r) => setTimeout(r, 2500));

    // 6) 断言:merge 恰好一次;source/target 与探测一致(此处 target=source 自身,
    //    服务端会拒 self-merge,但本回归测的是 UI 事件链,云调用已被拦截不落库)
    const calls = await mp.evaluate(() => globalThis.__mergeCalls);
    assert(Array.isArray(calls) && calls.length === 1, "「就选这里」应恰好触发一次 merge,实际 " + JSON.stringify(calls));
    assert(calls[0].s === probe.source.location_id, "source 应为根层叶子,实际 " + JSON.stringify(calls[0]));
    assert(calls[0].t === probe.drill.location_id, "target 应为 drill 层,实际 " + JSON.stringify(calls[0]));
    console.log("✔ 深层「就选这里」→ 转发链 → merge 调用抵达发起页(source=" + calls[0].s + ")");
    console.log("✔ 回归通过:选择器逐层下钻事件链未断(issue #27 修复未复发)");
  } finally {
    await mp.disconnect();
  }
}

main().catch((e) => {
  console.error("picker-drill 回归失败:", e.message);
  process.exit(1);
});
