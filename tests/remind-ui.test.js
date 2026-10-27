"use strict";

/**
 * remind-ui 纯函数测试(issue #36 三阶段展示侧 + PR #52 Low-3):
 * localTodayYmd / pickerDateProblem——家庭提醒日期按用户本地自然日的合同:
 * item 页改期 picker 的可选范围(start=今天,今天可选)与提交前校验(今天可设)
 * 两端一致;过去的日子与超 10 年的拒绝;判定一律按本地日历日,不靠 UTC。
 * 用例全部用「本地钟面分量」构造 Date(new Date(年, 月, 日, …)),
 * 读取同一套本地分量断言——与测试运行环境的时区无关,结论在任何时区一致。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var ui = require("../miniprogram/utils/remind-ui.js");

test("localTodayYmd:按设备的本地自然日取今天,月/日补零", function () {
  // 设备本地钟面 2026-10-15 04:00(北京凌晨场景):今天就是 10-15,
  // 即便此刻 UTC 日期还是 10-14,也绝不把用户感知的今天折早一天
  assert.equal(ui.localTodayYmd(new Date(2026, 9, 15, 4, 0, 0)), "2026-10-15");
  assert.equal(ui.localTodayYmd(new Date(2026, 9, 15, 0, 5, 0)), "2026-10-15", "本地零点过后即新的一天");
  assert.equal(ui.localTodayYmd(new Date(2027, 0, 5, 23, 59, 0)), "2027-01-05", "月/日补零");
});

test("pickerDateProblem:今天可设(与 picker start=今天 两端一致),昨天拒绝,超十年拒绝", function () {
  var now = new Date(2026, 9, 15, 4, 0, 0); // 本地今天 2026-10-15(凌晨)
  assert.equal(ui.pickerDateProblem("2026-10-15", now), "", "今天可设:picker 可选今天,校验放行今天");
  assert.equal(ui.pickerDateProblem("2026-10-14", now), "选今天或往后的日子", "昨天必须拒绝");
  assert.equal(ui.pickerDateProblem("2026-10-16", now), "", "明天可设");
  // 2026-10-15 + 3650 天(含 2028/2032/2036 三个闰日)= 2036-10-12,恰为护栏上界
  assert.equal(ui.pickerDateProblem("2036-10-12", now), "", "第 3650 天(十年护栏上界)可设");
  assert.equal(ui.pickerDateProblem("2036-10-13", now), "最多记十年内", "超 10 年拒绝(3650 天护栏)");
  assert.equal(ui.pickerDateProblem("2027-01-01", now), "");
});

// ---------- #36 0.6.0 真机反馈 Fix 2:「用完了」去掉固定周期选项 ----------
// (0.7.0 真机反馈 Fix 3:按钮/确认字样统一改「已处理」)

test("askUseUp:只剩一次二次确认——确认 true / 取消 false,不再弹 7/30/90 天选项", async function () {
  var modals = [];
  var sheets = [];
  globalThis.wx = {
    showModal: function (o) {
      modals.push(o);
      o.success({ confirm: true });
    },
    showActionSheet: function (o) {
      sheets.push(o);
      o.success({ tapIndex: 0 });
    },
  };
  var confirmed = await ui.askUseUp("感冒药");
  assert.equal(confirmed, true, "确认后直接放行");
  assert.equal(modals.length, 1, "只弹一次确认框");
  assert.equal(sheets.length, 0, "不再弹固定周期选项(用户裁定:下次提醒自己到详情里选日子)");
  assert.equal(modals[0].title, "处理好了吗", "0.7.0 Fix 3:确认框不再说「用完了吗」");
  assert.equal(modals[0].confirmText, "已处理", "0.7.0 Fix 3:确认按钮字样「已处理」");
  assert.ok(modals[0].content.indexOf("感冒药") !== -1, "文案点名物品");

  modals.length = 0;
  globalThis.wx.showModal = function (o) {
    modals.push(o);
    o.success({ confirm: false });
  };
  var cancelled = await ui.askUseUp("感冒药");
  assert.equal(cancelled, false, "取消不动、不写");
  assert.equal(modals.length, 1);

  // 空名兜底
  modals.length = 0;
  globalThis.wx.showModal = function (o) {
    modals.push(o);
    o.success({ confirm: true });
  };
  await ui.askUseUp("");
  assert.ok(modals[0].content.indexOf("这件东西") !== -1, "空名兜底「这件东西」");
});

/* ---------------- 提醒滚轮起点(2026-10-26 真机反馈:8 点后从明天起) ---------------- */

test("pickerStartYmd:8 点前=今天,8 点起=明天(含月末翻转)", function () {
  assert.equal(ui.pickerStartYmd(new Date(2026, 9, 15, 7, 59)), "2026-10-15", "8 点前今天");
  assert.equal(ui.pickerStartYmd(new Date(2026, 9, 15, 8, 0)), "2026-10-16", "8 点整即明天(扫描 08:00 已触发)");
  assert.equal(ui.pickerStartYmd(new Date(2026, 9, 15, 23, 30)), "2026-10-16", "深夜仍明天");
  assert.equal(ui.pickerStartYmd(new Date(2026, 9, 31, 9, 0)), "2026-11-01", "月末翻转");
  assert.equal(ui.pickerStartYmd(new Date(2026, 11, 31, 9, 0)), "2027-01-01", "年末翻转");
});

test("pickerDateProblem:8 点后设今天拒绝(推送扫描已过),8 点前今天可设;昨天/超限照旧拒", function () {
  assert.equal(ui.pickerDateProblem("2026-10-15", new Date(2026, 9, 15, 7, 59)), "", "8 点前今天可设");
  assert.notEqual(ui.pickerDateProblem("2026-10-15", new Date(2026, 9, 15, 8, 1)), "", "8 点后今天拒绝");
  assert.equal(ui.pickerDateProblem("2026-10-16", new Date(2026, 9, 15, 8, 1)), "", "8 点后明天可设");
  assert.notEqual(ui.pickerDateProblem("2026-10-14", new Date(2026, 9, 15, 8, 1)), "", "昨天拒绝");
});

test("REMIND-ENTRY-UX:提醒设置上移 item 主界面(编辑表单不再含提醒字段);滚轮起点 8 点后=明天(两页同源)", function () {
  const fs = require("node:fs");
  const path = require("node:path");
  const ROOT = path.join(__dirname, "..");
  const itemWxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/item/item.wxml"), "utf8");
  assert.ok(itemWxml.includes('bindtap="onOpenReminderTap"'), "主界面一键进入提醒面板");
  assert.match(itemWxml, /start="{{\s*pickerStart\s*}}"[^>]*bindchange="onReminderDraftChange"/, "日期先暂存，保留选择边界");
  assert.equal(itemWxml.split('bindchange="onReminderDraftChange"').length - 1, 1);
  assert.ok(itemWxml.includes('bindtap="onReminderConfirmTap"'), "日期明确确认后才提交");
  assert.ok(itemWxml.includes('bindtap="onRemindFieldClear"'), "清除仍独立接线");
  assert.match(itemWxml, /<button[^>]*bindtap="onNotifyChipTap"/, "微信通知由显式按钮触发");
  const itemJs = fs.readFileSync(path.join(ROOT, "miniprogram/pages/item/item.js"), "utf8");
  assert.ok(itemJs.indexOf("pickerStartYmd") !== -1, "item 页 data 由 pickerStartYmd 供值");
  const confirmWxml = fs.readFileSync(path.join(ROOT, "miniprogram/pages/confirm/confirm.wxml"), "utf8");
  assert.ok(confirmWxml.indexOf('start="{{ pickerStart }}"') !== -1, "确认页 picker 也有起点边界");
  const confirmJs = fs.readFileSync(path.join(ROOT, "miniprogram/pages/confirm/confirm.js"), "utf8");
  assert.ok(confirmJs.indexOf("pickerDateProblem") !== -1, "确认页提交校验同源(低版本无 start 钳制也拦得住)");
});

test("EXIT-GUARD:首页退出确认接线(enableAlertBeforeUnload 低版本静默降级)", function () {
  const fs = require("node:fs");
  const path = require("node:path");
  const ROOT = path.join(__dirname, "..");
  // 工具:API 存在时调用;缺失时静默
  const calls = [];
  const wx0 = globalThis.wx;
  globalThis.wx = {
    enableAlertBeforeUnload: function (o) { calls.push(["on", o.message]); },
    disableAlertBeforeUnload: function (o) { calls.push(["off"]); },
  };
  const guard = require(path.join(ROOT, "miniprogram/utils/exit-guard.js"));
  guard.enableHomeExitGuard();
  guard.disableHomeExitGuard();
  delete globalThis.wx.enableAlertBeforeUnload;
  delete globalThis.wx.disableAlertBeforeUnload;
  let threw = false;
  try { guard.enableHomeExitGuard(); } catch (e) { threw = true; }
  globalThis.wx = wx0;
  assert.deepEqual(calls, [["on", "确定要退出「我靠东西呢」吗?"], ["off"]], "API 存在时直通");
  assert.equal(threw, false, "低版本无 API 静默降级不抛");
  // 页面接线
  const idx = fs.readFileSync(path.join(ROOT, "miniprogram/pages/index/index.js"), "utf8");
  assert.ok(idx.indexOf("enableHomeExitGuard") !== -1 && idx.indexOf("disableHomeExitGuard") !== -1, "首页 onLoad/onUnload 接线");
});
