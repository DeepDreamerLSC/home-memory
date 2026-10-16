"use strict";

/**
 * 拍照识物坐标换算纯函数的离线测试(零 wx、零外部依赖)。
 * 被测对象是 `npm run build:mp` 产出的 miniprogram/utils/photo-box.js
 * (package.json 的 pretest 已保证先编译)。
 * 覆盖:contain/cover 数学(等比/信箱偏移/满宽裁切)、极端宽高比、
 * 反向换算 clamp(触点越信箱边)、退化尺寸(原图/容器宽高 ≤0、宽或高为 0 的框)。
 * 规格:docs/design/issue3-photo-intake/IMPLEMENTATION.md §3.2。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var pb = require("../miniprogram/utils/photo-box");

/** 浮点断言(换算含除法/乘法链,容差取显示 px 级远小的 1e-9) */
function near(actual, expected) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    "期望 " + expected + ",实际 " + actual,
  );
}

test("contain:横图进方形容器——等比缩放、上下留信箱、框随显示图映射", function () {
  // img 1000×500,disp 300×300 → scale=min(0.3,0.6)=0.3;显示图 300×150,ox=0,oy=75
  var r = pb.containRect({ x1: 0.1, y1: 0.2, x2: 0.6, y2: 0.8 }, 1000, 500, 300, 300);
  near(r.left, 0 + 0.1 * 300);
  near(r.top, 75 + 0.2 * 150);
  near(r.width, 0.5 * 300);
  near(r.height, 0.6 * 150);
});

test("contain:竖图进方形容器——左右留信箱", function () {
  // img 500×1000,disp 300×300 → scale=0.3;显示图 150×300,ox=75,oy=0
  var r = pb.containRect({ x1: 0, y1: 0.5, x2: 1, y2: 1 }, 500, 1000, 300, 300);
  near(r.left, 75);
  near(r.top, 0.5 * 300);
  near(r.width, 150);
  near(r.height, 150);
});

test("contain:容器比例恰与原图一致——零偏移、整幅铺满", function () {
  var r = pb.containRect({ x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 }, 200, 200, 400, 400);
  near(r.left, 100);
  near(r.top, 100);
  near(r.width, 200);
  near(r.height, 200);
});

test("cover:横图进方形容器——满高裁切、水平偏移为负、框可越出显示区(不夹取)", function () {
  // img 1000×500,disp 300×300 → scale=max(0.3,0.6)=0.6;显示图 600×300,ox=-150,oy=0
  var r = pb.coverRect({ x1: 0.5, y1: 0, x2: 1, y2: 1 }, 1000, 500, 300, 300);
  near(r.left, -150 + 0.5 * 600);
  near(r.top, 0);
  near(r.width, 300);
  near(r.height, 300);
  // 框取左半幅时 left 为负(越出显示区),由容器 overflow:hidden 裁掉,本层不夹取
  var r2 = pb.coverRect({ x1: 0, y1: 0, x2: 0.5, y2: 1 }, 1000, 500, 300, 300);
  near(r2.left, -150);
  assert.ok(r2.left < 0, "cover 下框允许越出显示区");
});

test("极端宽高比:超宽横条 contain 后显示高极小仍正确;cover 放大后偏移极大仍线性", function () {
  // img 10000×10,disp 100×100 → contain scale=min(0.01,10)=0.01;显示图 100×0.1,oy=49.95
  var c = pb.containRect({ x1: 0, y1: 0, x2: 1, y2: 1 }, 10000, 10, 100, 100);
  near(c.width, 100);
  near(c.height, 0.1);
  near(c.top, 49.95);
  // cover scale=max(0.01,10)=10;显示图 100000×100,ox=-49950
  var v = pb.coverRect({ x1: 0.5, y1: 0, x2: 0.5, y2: 1 }, 10000, 10, 100, 100);
  near(v.left, -49950 + 0.5 * 100000);
});

test("宽或高为 0 的框(退化框)合法:得到 0 宽/高矩形,渲染不可见", function () {
  var r = pb.containRect({ x1: 0.3, y1: 0.3, x2: 0.3, y2: 0.7 }, 1000, 500, 300, 300);
  near(r.width, 0);
  near(r.height, 0.4 * 150);
  var r2 = pb.coverRect({ x1: 0.3, y1: 0.5, x2: 0.7, y2: 0.5 }, 1000, 500, 300, 300);
  near(r2.width, 0.4 * 600);
  near(r2.height, 0);
});

test("containPointToNormalized:显示区触点 → 原图 0-1(contain 语义,居中映射)", function () {
  // 同 contain 横图例:ox=0,oy=75,dw2=300,dh2=150;容器中心 → 原图中心
  var p = pb.containPointToNormalized(150, 150, 1000, 500, 300, 300);
  near(p.x, 0.5);
  near(p.y, 0.5);
  var q = pb.containPointToNormalized(30, 105, 1000, 500, 300, 300);
  near(q.x, 0.1);
  near(q.y, 0.2);
});

test("containPointToNormalized:触点落在信箱边外 → clamp 到 [0,1](绝不产出越界归一值)", function () {
  // 上下留白区(oy=75 以上)的触点 y 应 clamp 到 0;容器底边外 clamp 到 1
  var top = pb.containPointToNormalized(150, 10, 1000, 500, 300, 300);
  near(top.y, 0);
  near(top.x, 0.5);
  var bottom = pb.containPointToNormalized(150, 299, 1000, 500, 300, 300);
  near(bottom.y, 1);
  // x 无信箱(ox=0)时容器外触点同样夹取
  var left = pb.containPointToNormalized(-20, 150, 1000, 500, 300, 300);
  near(left.x, 0);
  var right = pb.containPointToNormalized(400, 150, 1000, 500, 300, 300);
  near(right.x, 1);
});

test("containPointToNormalized:竖图左右信箱下,x 落在留白区 clamp 到 0/1", function () {
  // img 500×1000,disp 300×300 → ox=75;触点 x=10 在左留白 → 0;x=290 在右留白 → 1
  near(pb.containPointToNormalized(10, 150, 500, 1000, 300, 300).x, 0);
  near(pb.containPointToNormalized(290, 150, 500, 1000, 300, 300).x, 1);
});

test("往返一致:框 → 显示矩形 → 中心触点 → 归一 ≈ 原框中心", function () {
  var box = { x1: 0.273, y1: 0.389, x2: 0.593, y2: 0.507 };
  var r = pb.containRect(box, 1024, 768, 352, 264);
  var back = pb.containPointToNormalized(
    r.left + r.width / 2,
    r.top + r.height / 2,
    1024, 768, 352, 264,
  );
  near(back.x, (box.x1 + box.x2) / 2);
  near(back.y, (box.y1 + box.y2) / 2);
});

test("退化尺寸:原图或容器宽高 ≤0 → 零矩形 / {0,0}(不可信尺寸不渲染、不反算)", function () {
  var zero = { left: 0, top: 0, width: 0, height: 0 };
  assert.deepEqual(pb.containRect({ x1: 0, y1: 0, x2: 1, y2: 1 }, 0, 500, 300, 300), zero);
  assert.deepEqual(pb.containRect({ x1: 0, y1: 0, x2: 1, y2: 1 }, 1000, 500, 0, 300), zero);
  assert.deepEqual(pb.coverRect({ x1: 0, y1: 0, x2: 1, y2: 1 }, 1000, 0, 300, 300), zero);
  assert.deepEqual(pb.containPointToNormalized(10, 10, 1000, 500, 0, 0), { x: 0, y: 0 });
});

test("纯函数:同一入参重复调用结果相等,入参对象不被改动", function () {
  var box = { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 };
  var a = pb.containRect(box, 800, 600, 400, 400);
  var b = pb.containRect(box, 800, 600, 400, 400);
  assert.deepEqual(a, b);
  assert.deepEqual(box, { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 });
  var p1 = pb.containPointToNormalized(5, 5, 800, 600, 400, 400);
  assert.deepEqual(p1, pb.containPointToNormalized(5, 5, 800, 600, 400, 400));
});
