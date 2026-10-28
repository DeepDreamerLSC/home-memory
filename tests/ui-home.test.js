"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const ts = require("typescript");

// Compile in memory so these behavioral tests never mutate committed JS artifacts.
function harness(storage = new Map()) {
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
    "../../utils/location-artwork": require("../miniprogram/utils/location-artwork"),
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
    wx: { getStorageSync: k=>storage.get(k), setStorageSync:(k,v)=>storage.set(k,v), navigateTo: o => navigation.push({method:"navigateTo",...o}), navigateBack: o => navigation.push({method:"navigateBack",...o}), showActionSheet: o => navigation.push({method:"sheet",...o}), showToast: o => navigation.push({method:"toast",...o}) },
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
    h.page.viewStack=[{id:"r",name:"书房"},{id:"c",name:"柜子"}];h.page.currentNodeId="c";
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
  await h.page.loadMapLayer();assert.equal(h.calls.length,1);assert.equal(h.page.data.mapTitle,"家里");
});

test("home exit confirmation is root-only and restored when returning from a child", async () => {
  const h=harness();h.page.refreshFamilyChip=()=>{};h.page.loadMapLayer=async()=>{};h.page.loadRecent=async()=>{};h.page.refreshDueBanner=async()=>{};h.page.currentResumeSession=()=>null;h.page.currentPhotoResume=()=>null;
  h.pages([h.page]);h.page.onShow();assert.deepEqual(h.guardCalls,["on"]);
  h.page.onHide();assert.deepEqual(h.guardCalls,["on","off"]);
  h.pages([{route:"pages/index/index"},h.page]);h.page.onShow();assert.deepEqual(h.guardCalls,["on","off"]);
  h.pages([h.page]);h.page.onShow();assert.deepEqual(h.guardCalls,["on","off","on"]);
  await Promise.resolve();
});


test("home tile long press names the target and offers rename, move and delete without drilling into the tile", () => {
  const h=harness();h.page.renderMap({node:{type:"home",location_id:"root",item_count:0,path:[]},children:[{location_id:"r",name:"书房",path:["书房"],item_count:0,child_count:0}],items:[],unmounted_count:0});
  h.page.data.mapLoading=false;h.page.onRoomLongPress({currentTarget:{dataset:{index:0}}});
  assert.equal(h.page.data.locationMenuVisible,true);
  assert.equal(h.page.data.locationMenuName,"书房");
  h.page.onRoomTap({currentTarget:{dataset:{index:0}}});assert.equal(h.navigation.length,0);
  h.page.onLocationMenuPick({currentTarget:{dataset:{action:"move"}}});assert.match(h.navigation[0].url,/picker=1/);assert.match(decodeURIComponent(h.navigation[0].url),/exclude_path=书房/);
  assert.equal(h.calls.length,0);
});

test("home tile delete only opens the existing preview flow, never directly mutates", () => {
  const h=harness();h.page.renderMap({node:{type:"home",location_id:"root",item_count:0,path:[]},children:[{location_id:"r",name:"书房",path:["书房"],item_count:0,child_count:0}],items:[],unmounted_count:0});
  h.page.data.mapLoading=false;h.page.onRoomLongPress({currentTarget:{dataset:{index:0}}});h.page.onLocationMenuPick({currentTarget:{dataset:{action:"delete"}}});
  const url=new URL("https://local"+h.navigation[0].url);assert.equal(url.searchParams.get("home_action"),"delete");assert.equal(url.searchParams.get("home_target"),"r");assert.equal(h.calls.length,0);
});

test("home plus uses manual entry at root and binds the concrete current location in a child", () => {
  const root=harness();root.page.data.mapLoading=false;root.page.onAddHereTap();assert.match(root.navigation[0].url,/confirm.*manual=true/);
  const h=harness();h.page.viewStack=[{id:"r",name:"书房"}];h.page.currentNodeId="r";h.page.renderedScopeGen=1;h.page.data.isRootView=false;h.page.data.containerName="书房";h.page.data.mapLoading=false;
  h.page.onAddHereTap();const url=new URL("https://local"+h.navigation[0].url);assert.equal(url.searchParams.get("home_action"),"addItem");assert.equal(url.searchParams.get("node_id"),"r");
  h.scope(2);h.page.onAddHereTap();assert.equal(h.navigation.length,1,"old household context cannot open a current-location form");
});

test("moving a child tile refreshes the current grid instead of sending the parent to root", async () => {
  const h=harness();h.page.currentNodeId="parent";h.page.requestSeq=require("../miniprogram/utils/locations-cache").createRequestSeq();
  h.api(async request=>request.action==="move"?{}:{node:{type:"home",location_id:"root",item_count:0,path:[]},children:[],items:[],unmounted_count:0});
  await h.page.doMove({location_id:"child"},"target");assert.equal(h.calls[0].action,"move");assert.ok(h.calls.some(c=>c.action==="list"));assert.equal(h.navigation.some(n=>n.method==="navigateBack"),false);
});


test("location hint appears only once when cards exist, and long press dismisses it", () => {
  const storage=new Map();const h=harness(storage);
  const response={node:{type:"home",location_id:"root",item_count:0,path:[]},children:[],items:[],unmounted_count:0};
  h.page.renderMap(response);assert.equal(h.page.data.showLocationHint,false);assert.equal(storage.size,0);
  response.children=[{location_id:"r",name:"书房",path:["书房"],item_count:0,child_count:0}];
  h.page.renderMap(response);assert.equal(h.page.data.showLocationHint,true);assert.equal(storage.size,1);
  const next=harness(storage);next.page.renderMap(response);assert.equal(next.page.data.showLocationHint,false);
  let renamed;h.page.renameContainer=node=>{renamed=node};h.page.data.mapLoading=false;
  h.page.onRoomLongPress({currentTarget:{dataset:{index:0}}});assert.equal(h.page.data.showLocationHint,false);
  h.page.onLocationMenuPick({currentTarget:{dataset:{action:"rename"}}});assert.equal(renamed.location_id,"r");assert.equal(h.calls.length,0);
});

test("location hint does not appear in search or unclassified mode, and can be dismissed", () => {
  const h=harness();const response={node:{type:"home",location_id:"root",item_count:0,path:[]},children:[{location_id:"r",name:"书房",item_count:0}],items:[],unmounted_count:0};
  h.page.data.queried=true;h.page.renderMap(response);assert.equal(h.page.data.showLocationHint,false);
  h.page.data.queried=false;h.page.data.unmountedView=true;h.page.renderMap(response);assert.equal(h.page.data.showLocationHint,false);
  h.page.data.unmountedView=false;h.page.renderMap(response);assert.equal(h.page.data.showLocationHint,true);
  h.page.onLocationHintDismiss();h.page.renderMap(response);assert.equal(h.page.data.showLocationHint,false);
});

test("location menu closes without writes and rejects stale household targets", () => {
  const h=harness();h.page.data.rooms=[{location_id:"r",name:"书房",path:["书房"]}];h.page.renderedScopeGen=1;h.page.data.mapLoading=false;
  h.page.onRoomLongPress({currentTarget:{dataset:{index:0}}});h.scope(2);
  h.page.onLocationMenuPick({currentTarget:{dataset:{action:"delete"}}});assert.equal(h.navigation.length,0);assert.equal(h.calls.length,0);assert.equal(h.page.data.locationMenuVisible,false);assert.equal(h.page.locationMenuTarget,null);
});

function artworkHarness(artworkId=null){
  const h=harness();h.page.data.mapLoading=false;h.page.renderedScopeGen=1;
  h.page.data.rooms=[{location_id:'r',name:'书房',path:['书房'],artworkId,artwork:'original',artworkDark:'original-dark'}];
  h.page.loadMapLayer=async()=>{};
  h.api(async request=>({node:{artwork_id:request.artwork_id}}));
  h.page.onRoomLongPress({currentTarget:{dataset:{index:0}}});
  h.page.onLocationMenuPick({currentTarget:{dataset:{action:'artwork'}}});
  return h;
}
const chooseArtwork=id=>({currentTarget:{dataset:{id}}});
test('artwork choice stays a draft until explicit save and cancellation leaves original untouched',()=>{
  const h=artworkHarness();assert.equal(h.page.data.artworkOptions.length,24);assert.equal(h.page.data.artworkSelectedId,'');
  h.page.onArtworkCategoryTap({currentTarget:{dataset:{category:'家具'}}});assert.equal(h.page.data.artworkOptions.length,8);
  h.page.onArtworkPick(chooseArtwork('toolbox'));assert.equal(h.page.data.artworkSelectedId,'toolbox');assert.equal(h.calls.length,0);
  h.page.onArtworkPickerClose();assert.equal(h.page.data.artworkPickerVisible,false);assert.equal(h.page.data.rooms[0].artworkId,null);assert.equal(h.calls.length,0);
});
test('artwork save targets the long-pressed node and reset sends null without renaming or moving it',async()=>{
  const h=artworkHarness();h.page.onArtworkPick(chooseArtwork('toolbox'));await h.page.onArtworkSaveTap();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].action,'setArtwork');assert.equal(h.calls[0].node_id,'r');assert.equal(h.calls[0].artwork_id,'toolbox');
  assert.equal(h.page.data.rooms[0].artworkId,'toolbox');assert.equal(h.page.data.artworkPickerVisible,false);
  h.page.openArtworkPicker(h.page.data.rooms[0]);h.page.onArtworkPick(chooseArtwork(''));await h.page.onArtworkSaveTap();assert.equal(h.calls[1].artwork_id,null);
});
test('artwork failed save preserves the draft and busy saves cannot duplicate or close',async()=>{
  const h=artworkHarness(),d=deferred();h.api(()=>d.promise);h.page.onArtworkPick(chooseArtwork('toolbox'));
  const save=h.page.onArtworkSaveTap();await h.page.onArtworkSaveTap();h.page.onArtworkPickerClose();assert.equal(h.calls.length,1);assert.equal(h.page.data.artworkPickerVisible,true);
  d.reject(new Error('network'));await save;assert.equal(h.page.data.artworkPickerVisible,true);assert.equal(h.page.data.artworkSelectedId,'toolbox');assert.match(h.page.data.artworkError,/network/);assert.equal(h.page.data.rooms[0].artworkId,null);
});
test('artwork save fails closed on family drift before submit and while awaiting a response',async()=>{
  const h=artworkHarness();h.page.onArtworkPick(chooseArtwork('toolbox'));h.scope(2);await h.page.onArtworkSaveTap();assert.equal(h.calls.length,0);assert.equal(h.page.data.artworkPickerVisible,false);
  const pending=artworkHarness(),d=deferred();pending.api(()=>d.promise);pending.page.onArtworkPick(chooseArtwork('toolbox'));const save=pending.page.onArtworkSaveTap();pending.scope(2);d.resolve({});await save;
  assert.equal(pending.page.data.rooms[0].artworkId,null);assert.equal(pending.page.data.artworkPickerVisible,false);
});

test('artwork save respects the authoritative response when another member has changed the same node',async()=>{
  const h=artworkHarness();h.api(async()=>({node:{artwork_id:'basket'}}));h.page.onArtworkPick(chooseArtwork('toolbox'));await h.page.onArtworkSaveTap();assert.equal(h.page.data.rooms[0].artworkId,'basket');
});

test('a held long press cannot drill into a location after the short tap-suppression window expires',()=>{
  const h=artworkHarness();h.page.onArtworkPickerClose();h.page.onRoomLongPress({currentTarget:{dataset:{index:0}}});h.page.suppressRoomTapUntil=0;h.page.onRoomTap({currentTarget:{dataset:{index:0}}});assert.equal(h.navigation.length,0);assert.equal(h.page.data.locationMenuVisible,true);
});
