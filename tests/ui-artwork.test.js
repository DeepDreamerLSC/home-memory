"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { roomArtwork, itemArtwork } = require("../miniprogram/utils/ui.js");

test("UI artwork maps Chinese room variants and keeps unknown rooms neutral", () => {
  assert.equal(roomArtwork("儿童房"), "/assets/themes/cream/bedroom.png");
  assert.equal(roomArtwork("餐厨区", true), "/assets/themes/cream/kitchen-dark.png");
  assert.equal(roomArtwork("杂物间"), "/assets/themes/cream/storage.png");
});

test("UI artwork selects item categories and every light/dark output exists", () => {
  assert.equal(itemArtwork("备用钥匙"), "/assets/themes/cream/key.png");
  assert.equal(itemArtwork("相机说明书", true), "/assets/themes/cream/book-dark.png");
  assert.equal(itemArtwork("充电器"), "/assets/themes/cream/generic.png");
  for (const dark of [false, true]) {
    for (const name of ["客厅", "卧室", "厨房", "书房", "杂物间"]) {
      assert.ok(fs.existsSync(path.join(__dirname, "../miniprogram", roomArtwork(name, dark))));
    }
    for (const name of ["钥匙", "维生素", "说明书", "充电器"]) {
      assert.ok(fs.existsSync(path.join(__dirname, "../miniprogram", itemArtwork(name, dark))));
    }
  }
});
