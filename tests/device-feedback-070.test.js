"use strict";

/**
 * 0.7.0 真机反馈三连修的客户端静态断言(Fix 1 按钮宽度 / Fix 3「已处理」文案)。
 * 被测对象是源码与 `npm run build:mp` 产物(pretest 已保证先编译):
 * - CTA-WIDTH:确认页主 CTA(确认记住 / 先补充位置 / 确认保存 N 件)与
 *   摘要卡/批次卡/折叠条左右对齐同宽——左右各 36rpx 页边距,不再全宽出血,
 *   C2 主 CTA 移出批次卡(原型 .cta 本就在 .batch 卡外);
 * - DONE-WORD:「用完了」统一改「已处理」(R1 行钮 / D1 保质期行钮 /
 *   确认弹层 / 相关 toast),主语一并统一。
 * 断言全部为字符串/结构存在性检查,零外部依赖。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/* ---------------- CTA-WIDTH:主 CTA 与卡片元素左右对齐同宽 ---------------- */

test("CTA-WIDTH:主 CTA 左右各让 36rpx,盖掉 .btn.block 的 width:100%", function () {
  var css = read("miniprogram/pages/confirm/confirm.wxss");
  // 与 .card/.fold/.warnbox 同口径的 36rpx 页边距 + width:auto(此前 width:100%
  // 全宽 0 边距 = 偏宽根因);选择器带 button.btn.block 前缀保证盖过 app.wxss
  assert.ok(
    /button\.btn\.block\.cta-btn,\s*\nbutton\.btn\.block\.batch-btn\s*\{[^}]*margin:\s*32rpx 36rpx 0/s.test(css),
    "主 CTA 左右边距 36rpx(与卡片同口径)",
  );
  assert.ok(
    /button\.btn\.block\.cta-btn,\s*\nbutton\.btn\.block\.batch-btn\s*\{[^}]*width:\s*auto/s.test(css),
    "盖掉 .btn.block 的 width:100%(不再全宽出血)",
  );
  // 卡片元素仍是 36rpx 页边距口径(对齐基准)
  var appCss = read("miniprogram/app.wxss");
  assert.ok(/\.card\s*\{[^}]*margin:\s*24rpx 36rpx/s.test(appCss), ".card 仍 36rpx 页边距");
});

test("CTA-WIDTH:C2「确认保存 N 件」移出批次卡,与 C1 同层级渲染", function () {
  var wxml = read("miniprogram/pages/confirm/confirm.wxml");
  var batchCardIdx = wxml.indexOf('class="card batch-card"');
  var batchBtnIdx = wxml.indexOf('class="btn primary block batch-btn"');
  assert.ok(batchCardIdx !== -1 && batchBtnIdx !== -1, "批次卡与主 CTA 都在册");
  // 移出批次卡:按钮与卡片同级(之间隔着卡片的收尾 </view>),不再嵌在卡内吃 24rpx 内边距
  var between = wxml.slice(batchCardIdx, batchBtnIdx);
  assert.ok(between.indexOf("确认保存 {{ checkedCount }} 件") === -1, "按钮文本不在卡片段内");
  assert.ok(
    /<button\s*\n?\s*wx:if="\{\{ rows\.length > 1 \}\}"\s*\n?\s*class="btn primary block batch-btn"/s.test(wxml),
    "C2 主 CTA 由 rows.length > 1 控制渲染(与卡片段解耦)",
  );
  // C1/C1b 主 CTA 仍在单件分支
  assert.ok(wxml.indexOf('class="btn primary block cta-btn"') !== -1, "C1 主 CTA 在册");
});

/* ---------------- DONE-WORD:「用完了」统一改「已处理」 ---------------- */

test("DONE-WORD:R1 行钮与 D1 保质期行钮字样「已处理」,页面无「用完了」残留", function () {
  var r1 = read("miniprogram/pages/reminders/reminders.wxml");
  var d1 = read("miniprogram/pages/item/item.wxml");
  assert.ok(r1.indexOf("用完了") === -1, "R1 不得再有「用完了」字样");
  assert.ok((r1.match(/<view class="r-done-face">已处理<\/view>/g) || []).length === 3, "R1 三分组行钮均为「已处理」");
  assert.ok(d1.indexOf("用完了") === -1, "D1 不得再有「用完了」字样");
  assert.ok(d1.indexOf('class="r-done {{ remindBusy ? \x27busy\x27 : \x27\x27 }}" bindtap="onExpireDoneTap"><view class="r-done-face">已处理</view></view>') !== -1, "D1 保质期行钮「已处理」");
  // R1 引导句与底部纪律说明同步(处理好了 = 收掉这条提醒)
  assert.ok(r1.indexOf("按时间先后;处理好了就点右边的钮。") !== -1, "R1 引导句同步");
  assert.ok(r1.indexOf("处理好了就收掉这条提醒,要下次提醒,到详情里选日子。") !== -1, "R1 纪律说明同步");
});

test("DONE-WORD:确认弹层与 toast 主语统一「已处理」", function () {
  var remindUi = read("miniprogram/utils/remind-ui.js"); // build:mp 产物与 .ts 配对
  assert.ok(remindUi.indexOf('"处理好了吗"') !== -1, "确认弹层标题「处理好了吗」");
  assert.ok(remindUi.indexOf('"已处理"') !== -1, "确认按钮字样「已处理」");
  ["miniprogram/pages/reminders/reminders.js", "miniprogram/pages/item/item.js"].forEach(function (rel) {
    var js = read(rel);
    assert.ok(js.indexOf('"已处理。要下次提醒,到详情里选日子"') !== -1, rel + " 成功 toast 主语「已处理」");
    assert.ok(js.indexOf("已完成;提醒已被清除") === -1 && js.indexOf("已完成;提醒刚被重新设置") === -1, rel + " 冲突 toast 主语不再「已完成」");
    assert.ok(js.indexOf('"已处理;提醒已被清除,不再生成下次"') !== -1, rel + " 清除冲突 toast「已处理;…」");
    assert.ok(js.indexOf('"已处理;提醒刚被重新设置,不再生成下次"') !== -1, rel + " 重设冲突 toast「已处理;…」");
    // 字面量零残留(tsc 不去注释,历史对照注释里的「用完了」不算用户可见文案)
    assert.ok(js.indexOf('"用完了"') === -1 && js.indexOf("'用完了'") === -1, rel + " 无「用完了」字符串字面量");
  });
});
