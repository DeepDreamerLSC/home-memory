"use strict";
// issue #121 第二波批次甲 ⑥:语义图标映射纯函数(离线合同测试)。
// v2 横幅(6418877302)裁定 GO:映射与回退先行验证,资产管线由 codex 设计线
// 随后产出;本期 hasLocationIconAsset 恒 false → 调用方回退现状首字徽章,
// graceful degradation 是硬门。归一化复用 item-match 的 normalizeForMatch 口径。
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LOCATION_ICON_NAMES,
  locationIconName,
  locationIconSrc,
  hasLocationIconAsset,
} = require("../miniprogram/utils/location-icons.js");

test("撞车根源钉死:冰箱 ≠ 柜子 ≠ 抽屉(逐对断言)", () => {
  const fridge = locationIconName("冰箱");
  const cabinet = locationIconName("柜子");
  const drawer = locationIconName("抽屉");
  assert.equal(fridge, "fridge");
  assert.equal(cabinet, "wardrobe");
  assert.equal(drawer, "drawer");
  assert.notEqual(fridge, cabinet);
  assert.notEqual(fridge, drawer);
  assert.notEqual(cabinet, drawer);
});

test("包含词撞车:精确词/高优先词必须先于泛「柜」——冰箱、抽屉、鞋柜、电视柜、书柜", () => {
  assert.equal(locationIconName("双开门冰箱"), "fridge");
  assert.equal(locationIconName("冰箱收纳柜"), "fridge"); // 含「冰箱」+「柜」→ fridge
  assert.equal(locationIconName("抽屉柜"), "drawer"); // 抽屉先于柜
  assert.equal(locationIconName("三层抽屉"), "drawer");
  assert.equal(locationIconName("玄关鞋柜"), "shoe_cabinet"); // 鞋柜先于柜
  assert.equal(locationIconName("客厅电视柜"), "tv_stand"); // 电视柜先于柜
  assert.equal(locationIconName("书柜"), "shelf"); // 书柜精确 → 书架系,不是衣柜
  assert.equal(locationIconName("书柜第二层"), "shelf"); // 书柜包含词也先于泛柜
  assert.equal(locationIconName("大衣柜"), "wardrobe");
  assert.equal(locationIconName("床头柜"), "wardrobe"); // 泛柜先于「床」:床头柜归柜系
});

test("房间级样例:九类房间", () => {
  assert.equal(locationIconName("书房"), "room_study");
  assert.equal(locationIconName("书房的角落"), "room_study");
  assert.equal(locationIconName("主卧"), "room_bed");
  assert.equal(locationIconName("次卧"), "room_bed");
  assert.equal(locationIconName("卧室"), "room_bed");
  assert.equal(locationIconName("厨房"), "room_kitchen");
  assert.equal(locationIconName("卫生间"), "room_bath");
  assert.equal(locationIconName("浴室"), "room_bath");
  assert.equal(locationIconName("客厅"), "room_living");
  assert.equal(locationIconName("起居室"), "room_living");
  assert.equal(locationIconName("阳台"), "room_balcony");
  assert.equal(locationIconName("玄关"), "room_entry");
  assert.equal(locationIconName("餐厅"), "room_dining");
  assert.equal(locationIconName("储物间"), "room_storage");
});

test("家具级样例:冰箱/衣柜/书桌/抽屉/架子/床/洗衣机/鞋柜/电视柜", () => {
  assert.equal(locationIconName("冰箱"), "fridge");
  assert.equal(locationIconName("冰柜"), "fridge");
  assert.equal(locationIconName("衣柜"), "wardrobe");
  assert.equal(locationIconName("衣橱"), "wardrobe");
  assert.equal(locationIconName("书桌"), "desk");
  assert.equal(locationIconName("办公桌"), "desk");
  assert.equal(locationIconName("桌子"), "desk");
  assert.equal(locationIconName("抽屉"), "drawer");
  assert.equal(locationIconName("书架"), "shelf");
  assert.equal(locationIconName("置物架"), "shelf");
  assert.equal(locationIconName("收纳架"), "shelf");
  assert.equal(locationIconName("床"), "bed");
  assert.equal(locationIconName("单人床"), "bed");
  assert.equal(locationIconName("洗衣机"), "washing_machine");
  assert.equal(locationIconName("鞋柜"), "shoe_cabinet");
  assert.equal(locationIconName("电视柜"), "tv_stand");
});

test("容器/物品级样例:箱/袋/瓶/罐/书/毛巾/工具/药(多字符词先于单字符泛词)", () => {
  assert.equal(locationIconName("纸箱"), "box");
  assert.equal(locationIconName("收纳盒"), "box");
  assert.equal(locationIconName("购物袋"), "bag");
  assert.equal(locationIconName("背包"), "bag");
  assert.equal(locationIconName("药箱"), "medicine"); // 药先于箱
  assert.equal(locationIconName("工具箱"), "tool"); // 工具先于箱
  assert.equal(locationIconName("书包"), "book"); // 书先于包
  assert.equal(locationIconName("书房"), "room_study"); // 房间先于泛「书」
  assert.equal(locationIconName("书桌"), "desk"); // 书桌先于泛「书」
  assert.equal(locationIconName("矿泉水箱"), "box");
  assert.equal(locationIconName("易拉罐收纳"), "can");
  assert.equal(locationIconName("酒瓶"), "bottle");
  assert.equal(locationIconName("毛巾"), "towel");
  assert.equal(locationIconName("工具"), "tool");
  assert.equal(locationIconName("药品"), "medicine");
});

test("房间词与家具词同现:具体家具先于房间(「厨房抽屉」是抽屉,不是厨房)", () => {
  assert.equal(locationIconName("厨房抽屉"), "drawer");
  assert.equal(locationIconName("阳台置物架"), "shelf");
  assert.equal(locationIconName("玄关的鞋柜"), "shoe_cabinet");
});

test("无匹配 → other;空串/纯符号 → other", () => {
  assert.equal(locationIconName("神秘空间"), "other");
  assert.equal(locationIconName("xyz"), "other");
  assert.equal(locationIconName(""), "other");
  assert.equal(locationIconName("  "), "other");
  assert.equal(locationIconName("、"), "other");
});

test("归一化口径复用 normalizeForMatch:trim/NFKC 全半角/空白/常见标点不干扰", () => {
  assert.equal(locationIconName("  冰箱  "), "fridge");
  assert.equal(locationIconName("冰 箱"), "fridge");
  assert.equal(locationIconName("书桌。"), "desk");
  assert.equal(locationIconName("【衣柜】"), "wardrobe");
  assert.equal(locationIconName("洗手间(客用)"), "room_bath");
});

test("资产路径约定:light 无后缀,dark 带 -dark;空名归一为 other", () => {
  assert.equal(locationIconSrc("fridge", "light"), "/assets/location-icons/fridge.png");
  assert.equal(locationIconSrc("fridge", "dark"), "/assets/location-icons/fridge-dark.png");
  assert.equal(locationIconSrc("room_study", "dark"), "/assets/location-icons/room_study-dark.png");
  assert.equal(locationIconSrc("other", "light"), "/assets/location-icons/other.png");
  assert.equal(locationIconSrc("", "dark"), "/assets/location-icons/other-dark.png");
});

test("硬门:资产未产出,占位判定恒 false(调用方回退首字徽章)", () => {
  for (const name of ["fridge", "wardrobe", "room_study", "other", "", "nonexistent"]) {
    assert.equal(hasLocationIconAsset(name), false, name + " 必须为 false");
  }
});

test("清单规模与封闭性:25-30 个图标名,含 other,规则全部落在清单内", () => {
  assert.ok(LOCATION_ICON_NAMES.length >= 25 && LOCATION_ICON_NAMES.length <= 30);
  assert.ok(LOCATION_ICON_NAMES.indexOf("other") !== -1);
  const seen = new Set();
  for (const name of [
    "fridge", "wardrobe", "desk", "drawer", "shelf", "bed", "washing_machine",
    "shoe_cabinet", "tv_stand", "room_study", "room_bed", "room_kitchen",
    "room_bath", "room_living", "room_balcony", "room_entry", "room_dining",
    "room_storage", "box", "bag", "bottle", "can", "book", "towel", "tool",
    "medicine",
  ]) {
    assert.ok(LOCATION_ICON_NAMES.indexOf(name) !== -1, name + " 必须在清单内");
    seen.add(name);
  }
  // other 只出现一次
  assert.equal(LOCATION_ICON_NAMES.filter((n) => n === "other").length, 1);
});
