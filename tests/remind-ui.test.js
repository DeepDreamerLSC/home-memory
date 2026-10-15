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
