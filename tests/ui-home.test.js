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
  const navigation = [];
  const guardCalls = [];
  let pages = [];
  const stubs = {
    "../../utils/appearance-page": {applyPageAppearance() {}},
    "../../utils/profile-api": {cachedUserProfile:()=>({nickname:""}),getUserProfile:async()=>({nickname:""})},
    "../../utils/exit-guard": { enableHomeExitGuard() {guardCalls.push("on");}, disableHomeExitGuard() {guardCalls.push("off");} },
    "../../utils/locations-api": { callLocationsApi: x => { calls.push(x); return api(x); } },
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
      createRequestSeq: require("../miniprogram/utils/locations-cache").createRequestSeq,
      readLocationsLayer:()=>null,
      planLocationsLoad:()=>({fetch:true,skeleton:true,useCache:false}),
      writeLocationsLayer() {},
    },
    "../../utils/ui": {
      roomArtwork: (name, dark) => `room:${name}:${!!dark}`,
      itemArtwork: (name, dark) => `item:${name}:${!!dark}`,
    },
    // 数量纯函数(issue #102 Q1):无 wx 依赖,直接用 build 产物(与 intake-draft
    // 测试同源;UNIT_SET/归一/槽文案是纯函数,无需 stub)
    "../../utils/quantity": require("../miniprogram/utils/quantity"),
  };
  const source = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/index/index.ts"), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(js, {
    exports: {}, Page: value => { options = value; },
    require: name => stubs[name] || {},
    getCurrentPages: () => pages,
    wx: { navigateTo: o => navigation.push({method:"navigateTo",...o}), navigateBack: o => navigation.push({method:"navigateBack",...o}), showToast: o => navigation.push({method:"toast",...o}) },
  });
  const page = Object.assign({}, options, {
    data: structuredClone(options.data),
    viewStack: [],
    setData(patch) { Object.assign(this.data, patch); },
  });
  return { page, calls, navigation, guardCalls, pages: value => { pages = value; }, scope: value => { scope = value; }, invalidate: () => { cacheGen++; }, api: fn => { api = fn; }, verify: fn => { verify = fn; } };
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


test("home room drill-down adds a native page without replacing the parent view", () => {
  const h = harness();
  h.page.data.rooms = [{location_id:"room-1",name:"书房"}];
  h.page.data.isRootView = true;
  h.page.onRoomTap({currentTarget:{dataset:{index:0}}});
  assert.equal(h.navigation[0].method,"navigateTo");
  assert.match(h.navigation[0].url,/pages\/index\/index\?/);
  const layers=JSON.parse(new URL("https://local"+h.navigation[0].url).searchParams.get("map_layers"));
  assert.deepEqual(layers,[{id:"room-1",name:"书房"}]);
  assert.equal(h.page.viewStack.length,0);
  assert.equal(h.page.data.isRootView,true);
});

test("home child route restores its location path and unclassified opens another native page", () => {
  const h=harness();h.page.ensureVoiceEntry=()=>{};
  h.page.onLoad({map_layers:encodeURIComponent(JSON.stringify([{id:"r",name:"书房"},{id:"c",name:"柜子"}])),map_scope:"1"});
  assert.equal(h.page.viewStack[1].id,"c");
  assert.equal(h.page.data.containerName,"柜子");
  assert.equal(h.page.data.backLabel,"书房");
  const root=harness();root.page.data.unmountedCount=3;root.page.onUnmountedTap();
  assert.equal(root.navigation[0].method,"navigateTo");assert.match(root.navigation[0].url,/map_unmounted=1/);
  assert.equal(root.page.data.unmountedView,false);
});

test("home native back uses navigateBack and preserves the suspended parent state", () => {
  const h=harness();h.page.viewStack=[{id:"r",name:"书房"},{id:"c",name:"柜子"}];
  h.pages([{route:"pages/index/index",data:{}},{route:"pages/index/index",data:{}},h.page]);
  h.page.onBackTap();
  assert.equal(h.navigation[0].method,"navigateBack");assert.equal(h.navigation[0].delta,1);
  assert.equal(h.page.viewStack.length,2);
});

test("home bad child route is rejected and navigation failure keeps the current view", () => {
  const h=harness();h.page.ensureVoiceEntry=()=>{};h.page.onLoad({map_layers:"%broken"});
  assert.equal(h.page.viewStack.length,0);
  h.page.data.rooms=[{location_id:"r",name:"书房"}];h.page.onRoomTap({currentTarget:{dataset:{index:0}}});
  h.navigation[0].fail();h.navigation[0].complete();
  assert.equal(h.page.viewStack.length,0);assert.equal(h.page.data.isRootView,true);
  assert.equal(h.navigation[1].method,"toast");
});


test("home merging returns one native layer and moving returns to the native map root", async () => {
  for (const action of ["doMerge", "doMove"]) {
    const h=harness();h.api(async()=>({}));
    h.pages([{route:"pages/index/index",data:{}},{route:"pages/index/index",data:{}},h.page]);
    h.page.viewStack=[{id:"r",name:"书房"},{id:"c",name:"柜子"}];
    await h.page[action]({location_id:"c"},"target");
    const back=h.navigation.find(n=>n.method==="navigateBack");
    assert.equal(back.delta,action==="doMerge"?1:2);
    assert.equal(h.page.viewStack.length,2,"native navigation must not mutate the hidden page into a different layer");
  }
});

test("home duplicate taps do not create duplicate native layers", () => {
  const h=harness();h.page.data.rooms=[{location_id:"r",name:"书房"}];
  h.page.onRoomTap({currentTarget:{dataset:{index:0}}});h.page.onRoomTap({currentTarget:{dataset:{index:0}}});
  assert.equal(h.navigation.length,1);
  h.navigation[0].complete();
  h.page.onRoomTap({currentTarget:{dataset:{index:0}}});assert.equal(h.navigation.length,2);
});


test("home native route preserves valid emoji location names", () => {
  const h=harness();h.page.ensureVoiceEntry=()=>{};const name="📦".repeat(30);
  h.page.onLoad({map_layers:encodeURIComponent(JSON.stringify([{id:"emoji",name}]))});
  assert.equal(h.page.viewStack[0].name,name);
});

test("home child route from a previous household is cleared before requesting the new root", async () => {
  const h=harness();h.page.ensureVoiceEntry=()=>{};
  h.page.onLoad({map_layers:encodeURIComponent(JSON.stringify([{id:"old-room",name:"旧家书房"}])),map_scope:"1"});
  h.scope(2);
  h.api(async request=>{
    assert.equal(request.parent_id,undefined);
    assert.equal(h.page.viewStack.length,0);
    assert.equal(h.page.data.containerName,"");
    return {node:{type:"home",location_id:"new-root",item_count:0,path:[]},children:[],items:[],unmounted_count:0};
  });
  await h.page.loadMapLayer();assert.equal(h.calls.length,1);assert.equal(h.page.data.mapTitle,"家里有什么");
});

test("home exit confirmation is root-only and restored when returning from a child", async () => {
  const h=harness();h.page.refreshFamilyChip=()=>{};h.page.loadMapLayer=async()=>{};h.page.loadRecent=async()=>{};h.page.refreshDueBanner=async()=>{};h.page.currentResumeSession=()=>null;h.page.currentPhotoResume=()=>null;
  h.pages([h.page]);h.page.onShow();assert.deepEqual(h.guardCalls,["on"]);
  h.pages([{route:"pages/index/index"},h.page]);h.page.onShow();assert.deepEqual(h.guardCalls,["on"]);
  h.pages([h.page]);h.page.onShow();assert.deepEqual(h.guardCalls,["on","on"]);
  await Promise.resolve();
});
