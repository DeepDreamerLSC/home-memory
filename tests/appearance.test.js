"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const modulePath = require.resolve("../miniprogram/utils/appearance.js");
function setup(cached, theme = "light") {
  let storage = cached, handler, writes = 0, failWrite = false;
  const nav = [];
  global.wx = {
    getStorageSync: () => storage,
    setStorageSync: (_key, data) => { if (failWrite) throw new Error("quota"); storage = data; writes++; },
    getSystemInfoSync: () => ({ theme }),
    onThemeChange: fn => { handler = fn; },
    setNavigationBarColor: options => nav.push(options),
    setBackgroundColor: () => {}, setBackgroundTextStyle: () => {},
  };
  delete require.cache[modulePath];
  const api = require(modulePath);
  return { api, nav, writes: () => writes, stored: () => storage, theme: value => handler({ theme: value }), fail: () => { failWrite = true; } };
}
test("appearance defaults and corrupted storage retain safe complete settings", () => {
  const { api } = setup({ palette: "__proto__", mode: "hacked", recent: "yes", expiry: false });
  assert.deepEqual(api.getAppearance().settings, { palette: "cream", mode: "system", recent: true, expiry: false });
  assert.equal(api.getAppearance().effectiveMode, "light");
});
test("appearance persists independent preferences and rejects illegal patch data", () => {
  const { api, stored } = setup();
  api.updateAppearance({ palette: "cobalt", mode: "dark", recent: false });
  assert.deepEqual(stored(), { palette: "cobalt", mode: "dark", recent: false, expiry: true });
  const state = api.updateAppearance({ palette: "missing", mode: "broken", expiry: "bad" });
  assert.equal(state.settings.palette, "cream");
  assert.equal(state.settings.mode, "system");
  assert.equal(state.settings.expiry, true);
  assert.equal(state.settings.recent, false);
});
test("theme preview changes neither saved preferences nor subscriptions", () => {
  const { api, writes } = setup();
  let events = 0;
  api.subscribeAppearance(() => events++);
  const preview = api.previewAppearance({ palette: "berry", mode: "dark", recent: false, expiry: false });
  assert.equal(preview.paletteName, "莓红");
  assert.equal(preview.effectiveMode, "dark");
  assert.equal(api.getAppearance().settings.palette, "cream");
  assert.equal(writes(), 0);
  assert.equal(events, 0);
});
test("system changes follow selected mode and unsubscribe isolates updates", () => {
  const { api, theme, nav } = setup(undefined, "dark");
  assert.equal(api.getAppearance().effectiveMode, "dark");
  api.initAppearance(); api.initAppearance();
  const received = [];
  const unsubscribe = api.subscribeAppearance(state => received.push(state));
  theme("light");
  assert.equal(received.length, 1);
  assert.equal(received[0].effectiveMode, "light");
  api.updateAppearance({ mode: "dark" });
  theme("light");
  assert.equal(received.length, 3);
  assert.equal(api.getAppearance().effectiveMode, "dark");
  assert.equal(nav.at(-1).frontColor, "#ffffff");
  unsubscribe();
  api.updateAppearance({ palette: "sage" });
  assert.equal(received.length, 3);
});
test("failed persistence leaves runtime settings and subscribers untouched", () => {
  const { api, fail } = setup();
  let updates = 0;
  api.subscribeAppearance(() => updates++);
  fail();
  assert.throws(() => api.updateAppearance({ palette: "berry" }), /未保存/);
  assert.equal(api.getAppearance().settings.palette, "cream");
  assert.equal(updates, 0);
});
test("every palette exposes all semantic tokens, mode display and matching local artwork", () => {
  const { api } = setup();
  assert.equal(api.paletteOptions().length, 8);
  for (const palette of api.paletteOptions()) {
    for (const mode of ["light", "dark"]) {
      const state = api.previewAppearance({ ...api.defaultSettings(), palette: palette.id, mode });
      for (const token of ["bg", "card", "text", "go-bg", "go-fg", "banner-bg", "danger", "vb-hold-bg", "theme-light-display", "theme-dark-display"]) assert.ok(state.themeStyle.includes(`--${token}:`));
      for (const name of ["living", "bedroom", "study", "kitchen", "storage", "key", "medicine", "book", "generic"]) {
        assert.ok(fs.existsSync(path.join(__dirname, "../miniprogram", `${state.artPrefix}${name}${mode === "dark" ? "-dark" : ""}.png`)));
      }
    }
  }
});
function loadPage(relative, harness) {
  let definition;
  global.Page = config => { definition = config; };
  global.wx.pageScrollTo = () => {};
  global.wx.showToast = () => {};
  global.wx.navigateBack = () => {};
  global.wx.reLaunch = () => {};
  const file = require.resolve(`../miniprogram/pages/${relative}.js`);
  delete require.cache[require.resolve("../miniprogram/utils/appearance-page.js")];
  delete require.cache[file];
  require(file);
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split(".");
      let target = this.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)] = value;
    }
  } };
  page.onLoad?.();
  return page;
}
test("native appearance draft is local until apply and cannot overwrite separately saved home choices", () => {
  const harness = setup();
  const page = loadPage("appearance/appearance", harness);
  page.onPaletteTap({ currentTarget: { dataset: { id: "berry" } } });
  page.onModeTap({ currentTarget: { dataset: { id: "dark" } } });
  assert.equal(page.data.draft.palette, "berry");
  assert.equal(page.data.previewMode, "dark");
  assert.equal(harness.writes(), 0);
  page.onPreviewTap();
  page.onAdjustTap();
  assert.equal(page.data.draft.palette, "berry");
  harness.api.updateAppearance({ recent: false, expiry: false });
  page.onApplyTap();
  assert.deepEqual(harness.api.getAppearance().settings, { palette: "berry", mode: "dark", recent: false, expiry: false });
  page.onUnload();
});
test("native appearance failed save preserves draft and reports error", () => {
  const harness = setup();
  const page = loadPage("appearance/appearance", harness);
  page.onPaletteTap({ currentTarget: { dataset: { id: "cobalt" } } });
  harness.fail();
  page.onApplyTap();
  assert.equal(page.data.draft.palette, "cobalt");
  assert.match(page.data.errorText, /未保存/);
  assert.equal(page.data.saving, false);
  assert.equal(harness.api.getAppearance().settings.palette, "cream");
  page.onUnload();
});
test("native home display toggles preserve theme and report failed persistence", () => {
  const harness = setup({ palette: "emerald", mode: "dark", recent: true, expiry: true });
  const page = loadPage("home-display/home-display", harness);
  page.onShow();
  page.onToggle({ currentTarget: { dataset: { key: "expiry" } }, detail: { value: false } });
  assert.equal(harness.api.getAppearance().settings.expiry, false);
  assert.equal(harness.api.getAppearance().settings.palette, "emerald");
  harness.fail();
  page.onToggle({ currentTarget: { dataset: { key: "recent" } }, detail: { value: false } });
  assert.equal(page.data.recent, true);
  assert.match(page.data.errorText, /未保存/);
});

test("system changes refresh a system-following draft while the saved mode stays forced", () => {
  const harness = setup({palette:"cream",mode:"light",recent:true,expiry:true},"light");
  harness.api.initAppearance();
  const page = loadPage("appearance/appearance",harness);
  page.onPaletteTap({currentTarget:{dataset:{id:"cobalt"}}});
  page.onModeTap({currentTarget:{dataset:{id:"system"}}});
  harness.theme("dark");
  assert.equal(page.data.previewMode,"dark");
  assert.equal(harness.api.getAppearance().effectiveMode,"light");
  assert.equal(harness.nav.at(-1).backgroundColor,harness.api.PALETTES.cobalt.dark[0]);
  page.onUnload();
});
