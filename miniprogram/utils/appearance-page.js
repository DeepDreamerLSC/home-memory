"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyPageAppearance = applyPageAppearance;
exports.refreshVisibleAppearance = refreshVisibleAppearance;
const appearance_1 = require("./appearance");
function artwork(value, prefix) {
    if (typeof value === "string") {
        if (value.startsWith("/assets/location-artwork/"))
            return value.replace(/^\/assets\/location-artwork\/[^/]+\//, `/assets/location-artwork/${(0, appearance_1.getAppearance)().settings.palette}/`);
        return value.replace(/^\/assets\/(?:rooms|items|themes\/[^/]+)\/(living|bedroom|study|kitchen|storage|key|medicine|book|generic)(-dark)?\.png$/, (_, name, dark) => prefix + name + (dark || "") + ".png");
    }
    if (Array.isArray(value))
        return value.map(v => artwork(v, prefix));
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, artwork(v, prefix)]));
    return value;
}
function applyPageAppearance(page) {
    const state = (0, appearance_1.getAppearance)();
    const patch = { themeStyle: state.themeStyle, effectiveMode: state.effectiveMode, artPrefix: state.artPrefix, appearanceRecent: state.settings.recent, appearanceExpiry: state.settings.expiry };
    const data = page.data;
    for (const key of ["rooms", "directItems", "queryResults", "recentItems", "artworkLight", "artworkDark", "artworkOptions", "artworkAutoLight", "artworkAutoDark"])
        if (data?.[key] !== undefined)
            patch[key] = artwork(data[key], state.artPrefix);
    page.setData(patch);
    (0, appearance_1.applyNavigation)(state);
}
function refreshVisibleAppearance() {
    if (typeof getCurrentPages !== "function")
        return;
    const pages = getCurrentPages();
    for (const page of pages)
        applyPageAppearance(page);
    const top = pages[pages.length - 1];
    if (top?.route === "pages/appearance/appearance")
        top.refreshPreview?.();
}
