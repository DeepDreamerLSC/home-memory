"use strict";

/*
 * #36 真机反馈三件 A:相对时间服务端换算器 convertRelativeQuote 纯函数测试
 * (cloudfunctions/extractDraft/lib/relative-date.js)。
 * 产品拍板(#36):带明确数量锚的闭集相对表述由「产品换算、用户只确认」——
 * 换算结果是确认卡上的候选(可改可清),锚点=提取时刻的服务端今天。
 * 闭集纪律(越出闭集一律 null,灰行「时间没换算」保持诚实):
 * - 「N天/周/个月/月 后(之後/以后)」:N=阿拉伯数字或中文数字(一二两三四五六七八九十,
 *   支持组合如十五、二十);「半」仅允许「半个月后」=15天、「半年后」=6个月;
 *   「半天」舍(不用);
 * - 明天/后天/大后天;
 * - 月算术:6个月后=同日+6月,月末 clamp(2026-10-31+6月→2027-04-30);周/天=纯天数加;
 * - 总天数越界(<1 或 >3650)返回 null;模式不匹配返回 null;
 * - 绝不做「下个月」「下周」这类无数量锚的换算。
 * 红绿纪律:本文件在空实现(未实现/恒 null)上必须红,实现后转绿。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var rd = require("../cloudfunctions/extractDraft/lib/relative-date");

/** 测试锚点:服务端今天 2026-10-15(与 extractDraft 测试的 FIXED_TODAY 同一天) */
var TODAY = "2026-10-15";

test("RD-ANCHOR:明天/后天/大后天 = 今天 +1/+2/+3 天(纯天数加)", function () {
  assert.equal(rd.convertRelativeQuote("明天", TODAY), "2026-10-16");
  assert.equal(rd.convertRelativeQuote("后天", TODAY), "2026-10-17");
  assert.equal(rd.convertRelativeQuote("大后天", TODAY), "2026-10-18", "大后天不得被「后天」前缀吞成 +2");
});

test("RD-DAYS:阿拉伯数字 N天/N周(后/之後/以后 变体)", function () {
  assert.equal(rd.convertRelativeQuote("3天后", TODAY), "2026-10-18");
  assert.equal(rd.convertRelativeQuote("3天之後", TODAY), "2026-10-18", "繁体「之後」变体");
  assert.equal(rd.convertRelativeQuote("3天以后", TODAY), "2026-10-18", "「以后」变体");
  assert.equal(rd.convertRelativeQuote("2周后", TODAY), "2026-10-29", "周=7 天纯加");
  assert.equal(rd.convertRelativeQuote("1周以后", TODAY), "2026-10-22");
});

test("RD-CN:中文数字(含组合 十五/二十/两)与单位 个月/月", function () {
  assert.equal(rd.convertRelativeQuote("十五天后", TODAY), "2026-10-30", "十五=15");
  assert.equal(rd.convertRelativeQuote("二十天后", TODAY), "2026-11-04", "二十=20");
  assert.equal(rd.convertRelativeQuote("十天后", TODAY), "2026-10-25", "十=10");
  assert.equal(rd.convertRelativeQuote("两周后", TODAY), "2026-10-29", "两=2");
  assert.equal(rd.convertRelativeQuote("一个月后", TODAY), "2026-11-15", "月算术:同日+1月");
  assert.equal(rd.convertRelativeQuote("6个月后", TODAY), "2027-04-15", "月算术:同日+6月");
  assert.equal(rd.convertRelativeQuote("三个月之後", TODAY), "2027-01-15", "中文数字+繁体后缀");
});

test("RD-HALF:「半个月后」=15天、「半年后」=6个月(月算术);「半天」舍", function () {
  assert.equal(rd.convertRelativeQuote("半个月后", TODAY), "2026-10-30", "半个月=15 天纯加");
  assert.equal(rd.convertRelativeQuote("半年后", TODAY), "2027-04-15", "半年=+6 月(同日)");
  assert.equal(rd.convertRelativeQuote("半年以后", TODAY), "2027-04-15");
  assert.equal(rd.convertRelativeQuote("半天后", TODAY), null, "半天不在闭集:舍,维持灰行");
});

test("RD-CLAMP:月算术月末 clamp(10-31 + 6月 → 次年 04-30,绝不编出 4月31日)", function () {
  assert.equal(rd.convertRelativeQuote("6个月后", "2026-10-31"), "2027-04-30");
  assert.equal(rd.convertRelativeQuote("一个月后", "2026-01-31"), "2026-02-28", "非闰年 2 月 clamp 到 28");
  assert.equal(rd.convertRelativeQuote("一个月后", "2028-01-31"), "2028-02-29", "闰年 2 月 clamp 到 29");
  assert.equal(rd.convertRelativeQuote("三个月后", "2026-11-30"), "2027-02-28");
});

test("RD-EMBED:vague 原文是原话子串,模式在句中也认(取第一个匹配)", function () {
  assert.equal(rd.convertRelativeQuote("半年后提醒我换", TODAY), "2027-04-15");
  assert.equal(rd.convertRelativeQuote("大概三个月后再买", TODAY), "2027-01-15");
});

test("RD-BOUND:总天数越界(<1 或 >3650)返回 null", function () {
  assert.equal(rd.convertRelativeQuote("0天后", TODAY), null, "+0 天=今天,不算未来日子");
  assert.equal(rd.convertRelativeQuote("3650天后", TODAY), "2036-10-12", "恰 3650 天(十年护栏上界,含 2028/2032/2036 三个闰日)可换算");
  assert.equal(rd.convertRelativeQuote("3651天后", TODAY), null, "超 3650 天拒绝");
  assert.equal(rd.convertRelativeQuote("600个月后", TODAY), null, "600 月 ≈ 超 18 年,按总天数越界拒绝");
});

test("RD-NOMATCH:闭集之外一律 null(无数量锚/模糊/月精度/周期),灰行保持诚实", function () {
  var probes = [
    "下个月", // 无数量锚:明确不做
    "下周", // 无数量锚
    "下周三", // 星期几语义:不做
    "快过期了",
    "大概冬天",
    "差不多半年", // 「半年」后没有后缀:不匹配
    "每三个月", // 周期表述:不做
    "到2027年3月", // 月精度:不做
    "10月5号", // 绝对日期不归换算器管
    "开封后一个月内", // 「一个月」后无「后」字锚(「开封后」的「后」属于开封):不匹配
    "生产日期是10月5号保质期六个月", // 需基准日换算:闭集外
    "明天见", // hmm:「明天」可匹配——见下方单独断言(见 RD-EDGE)
  ];
  for (var i = 0; i < probes.length - 1; i++) {
    assert.equal(rd.convertRelativeQuote(probes[i], TODAY), null, "「" + probes[i] + "」不在闭集:必须 null");
  }
  // 「明天见」按闭集应换算(模式在句中)——这是有意行为:子串含「明天」即有数量锚
  assert.equal(rd.convertRelativeQuote("明天见", TODAY), "2026-10-16");
});

test("RD-SHAPE:非字符串/空串/非法今天 → null,绝不抛错", function () {
  assert.equal(rd.convertRelativeQuote(null, TODAY), null);
  assert.equal(rd.convertRelativeQuote(undefined, TODAY), null);
  assert.equal(rd.convertRelativeQuote(42, TODAY), null);
  assert.equal(rd.convertRelativeQuote("", TODAY), null);
  assert.equal(rd.convertRelativeQuote("半年后", "not-a-date"), null, "锚点非法:拒绝换算");
  assert.equal(rd.convertRelativeQuote("半年后", "2026-13-45"), null, "锚点非真实日历日:拒绝");
});

test("RD-SHANGHAI:服务端今天按 Asia/Shanghai(UTC+8 固定偏移)取自然日", function () {
  // UTC 2026-10-15 17:00 = 北京 2026-10-16 01:00 → 北京今天是 10-16
  assert.equal(rd.shanghaiTodayYmd(new Date("2026-10-15T17:00:00Z")), "2026-10-16");
  // UTC 2026-10-15 15:59 = 北京 2026-10-15 23:59 → 北京今天仍是 10-15
  assert.equal(rd.shanghaiTodayYmd(new Date("2026-10-15T15:59:00Z")), "2026-10-15");
  // UTC 2026-10-15 16:00 = 北京 2026-10-16 00:00 整点进位
  assert.equal(rd.shanghaiTodayYmd(new Date("2026-10-15T16:00:00Z")), "2026-10-16");
});
