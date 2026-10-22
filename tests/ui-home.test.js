"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const ts = require("typescript");

// Compile in memory so these behavioral tests never mutate committed JS artifacts.
function harness() {
  let options;
  let scope = 1;
  let cacheGen = 1;
  let api = async () => ({ items: [] });
  let verify = async () => ({ ok: true });
  const calls = [];
  const stubs = {
    "../../utils/api": { callItemsApi: x => { calls.push(x); return api(x); }, errorMessage: e => String(e) },
    "../../utils/household-scope": {
      captureScopeGeneration: () => scope,
      isScopeGenerationCurrent: n => n === scope,
      isScopeVerified: () => true,
      isHouseholdScopeShared: () => false,
    },
    "../../utils/households-api": { ensureScopeVerified: () => verify() },
    "../../utils/locations-cache": {
      captureCacheGeneration: () => cacheGen,
      isCacheGenerationCurrent: n => n === cacheGen,
      createRequestSeq: () => ({}),
    },
    "../../utils/ui": {
      roomArtwork: (name, dark) => `room:${name}:${!!dark}`,
      itemArtwork: (name, dark) => `item:${name}:${!!dark}`,
    },
  };
  const source = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/index/index.ts"), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(js, {
    exports: {}, Page: value => { options = value; },
    require: name => stubs[name] || {}, wx: {},
  });
  const page = Object.assign({}, options, {
    data: structuredClone(options.data),
    viewStack: [],
    setData(patch) { Object.assign(this.data, patch); },
  });
  return { page, calls, scope: value => { scope = value; }, invalidate: () => { cacheGen++; }, api: fn => { api = fn; }, verify: fn => { verify = fn; } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const item = (id, name) => ({ item_id: id, name, location_text: "客厅柜子", updated_at: "2026-10-22T01:00:00Z", version: 1 });

test("home counts mounted subtree and unclassified records exactly once", () => {
  const h = harness();
  h.page.renderMap({ node: { type: "home", location_id: "root", item_count: 7, path: [] }, children: [{ location_id: "r", name: "客厅", item_count: 4, child_count: 2 }], items: [item("a", "钥匙")], unmounted_count: 3 });
  assert.equal(h.page.data.rememberedCount, 10);
  assert.equal(h.page.data.rooms[0].countText, "4 件");
  assert.equal(h.page.data.rooms[0].artworkDark, "room:客厅:true");
  assert.equal(h.page.data.directItems[0].artwork, "item:钥匙:false");
});

test("recent records come from real API and open the selected detail", async () => {
  const h = harness();
  h.api(async () => ({ items: [item("key-1", "钥匙")] }));
  await h.page.loadRecent();
  assert.equal(h.calls[0].action, "list");
  assert.equal(h.calls[0].limit, 20);
  assert.equal(h.page.data.recentItems[0].item_id, "key-1");
  let opened;
  h.page.openItem = x => { opened = x.item_id; };
  h.page.onRecentTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(opened, "key-1");
  h.scope(2);
  opened = undefined;
  h.page.onRecentTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(opened, undefined, "old household record cannot open after switch");
});

test("recent records wait for household verification before capturing scope", async () => {
  const h = harness();
  h.verify(async () => { h.scope(2); return { ok: true }; });
  h.api(async () => ({ items: [item("verified", "护照")] }));
  await h.page.loadRecent();
  assert.equal(h.page.data.recentItems[0].item_id, "verified");
  assert.equal(h.page.recentScopeGen, 2);
});

test("late recent response from a previous household cannot appear", async () => {
  const h = harness();
  const d = deferred();
  h.api(() => d.promise);
  const promise = h.page.loadRecent();
  await new Promise(resolve => setImmediate(resolve));
  h.scope(2);
  d.resolve({ items: [item("old", "旧家的钥匙")] });
  await promise;
  assert.equal(h.page.data.recentItems.length, 0);
});

test("newer recent refresh wins and writes invalidate in-flight records", async () => {
  const h = harness();
  const first = deferred();
  h.api(() => first.promise);
  const old = h.page.loadRecent();
  await new Promise(resolve => setImmediate(resolve));
  h.api(async () => ({ items: [item("new", "新记录")] }));
  await h.page.loadRecent();
  first.resolve({ items: [item("old", "旧记录")] });
  await old;
  assert.equal(h.page.data.recentItems[0].item_id, "new");
  const late = deferred();
  h.api(() => late.promise);
  const pending = h.page.loadRecent();
  await new Promise(resolve => setImmediate(resolve));
  h.invalidate();
  late.resolve({ items: [item("invalid", "删除前的记录")] });
  await pending;
  assert.equal(h.page.data.recentItems[0].item_id, "new");
});

test("recent API failure is honest and clears the prior list", async () => {
  const h = harness();
  h.page.data.recentItems = [item("old", "旧记录")];
  h.page.recentScopeGen = 1;
  h.api(async () => { throw new Error("offline"); });
  await h.page.loadRecent();
  assert.equal(h.page.data.recentItems.length, 0);
  assert.equal(h.page.data.recentError, true);
});
