"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
let definition;
let scroll;
globalThis.wx = {
  getStorageSync: () => "", setStorageSync() {}, removeStorageSync() {},
  pageScrollTo: options => { scroll = options.selector; },
};
globalThis.Page = options => { definition = options; };
require("../miniprogram/pages/item/item.js");

function page() {
  const value = { ...definition, data: structuredClone(definition.data) };
  value.setData = (patch, callback) => { Object.assign(value.data, patch); if (callback) callback(); };
  value.original = { name: "", location: "", note: "" };
  return value;
}

test("detail keeps the recorded position separate from unsaved edits", () => {
  const value = page();
  value.applySummary({ item_id: "key", name: "备用钥匙", location_text: "玄关抽屉", note: "", version: 1, updated_at: "2026-10-22T01:00:00Z" });
  value.onLocationInput({ detail: { value: "厨房抽屉" } });
  assert.equal(value.data.locationText, "厨房抽屉");
  assert.equal(value.data.recordedLocationText, "玄关抽屉");
  assert.equal(value.data.artworkLight, "/assets/themes/cream/key.png");
  assert.match(value.data.lastConfirmedText, /^记录更新于 /);
});

test("found is navigation only and remains gated during a write", () => {
  const value = page();
  let backs = 0;
  value.goBack = () => { backs++; };
  value.data.saving = true;
  value.onFoundTap();
  assert.equal(backs, 0);
  value.data.saving = false;
  value.onFoundTap();
  assert.equal(backs, 1);
  assert.equal(value.data.version, 0);
});

test("update position opens a focused panel without page scrolling", () => {
  const value = page();
  scroll = "";
  value.onUpdateLocationTap();
  assert.equal(value.data.detailPanel, "location");
  assert.equal(value.data.editPanelOpen, true);
  assert.equal(scroll, "");
  value.onPanelClose();
  assert.equal(value.data.detailPanel, "");
});
