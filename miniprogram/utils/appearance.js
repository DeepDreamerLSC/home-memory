"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PALETTES = void 0;
exports.defaultSettings = defaultSettings;
exports.getAppearance = getAppearance;
exports.previewAppearance = previewAppearance;
exports.updateAppearance = updateAppearance;
exports.subscribeAppearance = subscribeAppearance;
exports.initAppearance = initAppearance;
exports.applyNavigation = applyNavigation;
exports.paletteOptions = paletteOptions;
exports.PALETTES = {
    "cream": {
        "light": [
            "#f8f7f2",
            "#fffefa",
            "#292d25",
            "#666d5e",
            "#e7e8de",
            "#eeeee5",
            "#30372c",
            "#fcfaf1",
            "#efd36e",
            "#efeee4",
            "#7b8069",
            "#d3d5bf",
            "#f8f6e9",
            "#a9ae91",
            "#ddc486"
        ],
        "dark": [
            "#20241f",
            "#2b3028",
            "#efeee4",
            "#b5baa8",
            "#3d4436",
            "#32392e",
            "#e8ce78",
            "#262c22",
            "#e8ce78",
            "#30362d",
            "#abb598",
            "#626f52",
            "#909a75",
            "#3f4c37",
            "#b29b65"
        ],
        "name": "奶油",
        "group": "柔和配色"
    },
    "sage": {
        "light": [
            "#f2f5ef",
            "#fcfdf9",
            "#24362d",
            "#58695d",
            "#dde5d9",
            "#e4ebe0",
            "#3e5b46",
            "#fffef9",
            "#d8dfab",
            "#e8eddf",
            "#75876b",
            "#ccd8be",
            "#f5f7e9",
            "#9aaa85",
            "#bbc88f"
        ],
        "dark": [
            "#1d2721",
            "#29362c",
            "#ebf1e6",
            "#b2c3ae",
            "#3c4d3e",
            "#324435",
            "#c5d7b2",
            "#263723",
            "#d8dfab",
            "#2d3c2e",
            "#a3b995",
            "#627e58",
            "#93a989",
            "#465d40",
            "#a3b881"
        ],
        "name": "苔绿",
        "group": "柔和配色"
    },
    "mist": {
        "light": [
            "#f1f5f7",
            "#fbfdfe",
            "#253945",
            "#586c78",
            "#dce5e9",
            "#e3edf1",
            "#3d6176",
            "#ffffff",
            "#c9dce5",
            "#e5edf0",
            "#738895",
            "#ccd9dd",
            "#f4f8f9",
            "#a0b2ba",
            "#b4cbd7"
        ],
        "dark": [
            "#1d252c",
            "#28343d",
            "#e8eff3",
            "#afc0cc",
            "#3a4b57",
            "#30414d",
            "#b8d4e4",
            "#213544",
            "#c9dce5",
            "#2b3c47",
            "#9db7c7",
            "#59758a",
            "#8ca8b8",
            "#3e596a",
            "#9cbdcf"
        ],
        "name": "雾蓝",
        "group": "柔和配色"
    },
    "clay": {
        "light": [
            "#f9f3ef",
            "#fffaf6",
            "#423028",
            "#796052",
            "#eadfd6",
            "#f0e5dc",
            "#85513e",
            "#ffffff",
            "#e7c69e",
            "#f1e5da",
            "#96806e",
            "#dfcdbb",
            "#fcf4e9",
            "#b9a18d",
            "#d1ae85"
        ],
        "dark": [
            "#2b211e",
            "#392c26",
            "#f5eae0",
            "#cbb7a8",
            "#514036",
            "#46352c",
            "#dfb697",
            "#39271d",
            "#e7c69e",
            "#3c2d24",
            "#c1a88e",
            "#92735a",
            "#bfa78e",
            "#654c38",
            "#c4a17e"
        ],
        "name": "陶土",
        "group": "柔和配色"
    },
    "inkGold": {
        "light": [
            "#fffdf5",
            "#ffffff",
            "#151713",
            "#454536",
            "#c7bb83",
            "#f0e8ca",
            "#171915",
            "#ffe06b",
            "#ffe06b",
            "#f3edda",
            "#655b32",
            "#d8cfaa",
            "#fffef4",
            "#a59658",
            "#dfb526"
        ],
        "dark": [
            "#0c0e0a",
            "#191c13",
            "#fffef4",
            "#d4d4b9",
            "#64643f",
            "#272c1a",
            "#ffe06b",
            "#171915",
            "#ffe06b",
            "#232719",
            "#d3ce9f",
            "#8f9561",
            "#e3dfbc",
            "#636a3d",
            "#edcb4b"
        ],
        "name": "墨金",
        "group": "鲜明配色"
    },
    "cobalt": {
        "light": [
            "#f5f8ff",
            "#ffffff",
            "#101b35",
            "#344565",
            "#a5b8e3",
            "#dbe6ff",
            "#123c9c",
            "#ffffff",
            "#ffd85f",
            "#e5edff",
            "#284783",
            "#b0c6f1",
            "#f8fbff",
            "#6988c0",
            "#edc245"
        ],
        "dark": [
            "#080f22",
            "#131f38",
            "#f5f8ff",
            "#bfcee9",
            "#526a9e",
            "#1d3052",
            "#9cbdff",
            "#0c2049",
            "#ffd85f",
            "#182a4a",
            "#b4c9f5",
            "#597eba",
            "#d3e0ff",
            "#34578d",
            "#edc245"
        ],
        "name": "钴蓝",
        "group": "鲜明配色"
    },
    "emerald": {
        "light": [
            "#f2fcf6",
            "#ffffff",
            "#09281e",
            "#284f3e",
            "#8dbda4",
            "#d1eadb",
            "#00523b",
            "#ffffff",
            "#e3d55d",
            "#def2e5",
            "#255f45",
            "#acd2b9",
            "#f6fff8",
            "#5b9975",
            "#d4bd3f"
        ],
        "dark": [
            "#07150e",
            "#10291c",
            "#f0fff4",
            "#badcc7",
            "#457f5b",
            "#1b3b28",
            "#83e5af",
            "#082e1a",
            "#e3d55d",
            "#173722",
            "#a5d9b6",
            "#4b8e65",
            "#d0f1d9",
            "#2c603f",
            "#c9b74d"
        ],
        "name": "翠绿",
        "group": "鲜明配色"
    },
    "berry": {
        "light": [
            "#fff5f8",
            "#ffffff",
            "#32101f",
            "#62374a",
            "#d2a2b5",
            "#f5dce6",
            "#8b1741",
            "#ffffff",
            "#f2cc7d",
            "#fae4ed",
            "#863c58",
            "#e7b8c9",
            "#fff8fb",
            "#ba708d",
            "#d8b051"
        ],
        "dark": [
            "#1b0912",
            "#32131f",
            "#fff3f8",
            "#e8c0d0",
            "#9b536e",
            "#4b2032",
            "#ffafcd",
            "#3f1024",
            "#f2cc7d",
            "#412030",
            "#e5adc4",
            "#a55c7a",
            "#f6d5e3",
            "#773c55",
            "#d8b051"
        ],
        "name": "莓红",
        "group": "鲜明配色"
    }
};
const STORAGE_KEY = "home-memory:appearance:v1";
let saved;
let systemMode = "light";
let listening = false;
const listeners = new Set();
function defaultSettings() {
    return { palette: "cream", mode: "system", recent: true, expiry: true };
}
function validPalette(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(exports.PALETTES, value);
}
function sanitize(value) {
    const result = defaultSettings();
    if (!value || typeof value !== "object")
        return result;
    const data = value;
    if (validPalette(data.palette))
        result.palette = data.palette;
    if (data.mode === "light" || data.mode === "dark" || data.mode === "system")
        result.mode = data.mode;
    if (typeof data.recent === "boolean")
        result.recent = data.recent;
    if (typeof data.expiry === "boolean")
        result.expiry = data.expiry;
    return result;
}
function load() {
    if (!saved) {
        try {
            saved = sanitize(wx.getStorageSync(STORAGE_KEY));
        }
        catch (_) {
            saved = defaultSettings();
        }
        try {
            systemMode = wx.getSystemInfoSync().theme === "dark" ? "dark" : "light";
        }
        catch (_) { /* default light */ }
    }
    return saved;
}
function stateFor(settings) {
    const effectiveMode = settings.mode === "system" ? systemMode : settings.mode;
    const dark = effectiveMode === "dark";
    const palette = exports.PALETTES[settings.palette];
    const [bg, card, text, muted, line, wash, action, onAction, accent, roomBg, roomLine, roomMid, roomLight, roomDark, roomAccent] = palette[effectiveMode];
    const colors = {
        bg, card, "card-inset": wash, "room-bg": roomBg, text, "text-2": muted, "text-3": muted,
        line, placeholder: muted, accent, "accent-shadow": roomAccent, "accent-dim": wash,
        "go-bg": action, "go-fg": onAction, danger: dark ? "#ffb4a9" : "#a62f28",
        "danger-bg": dark ? "#462622" : "#fff0ed", "danger-shadow": dark ? "#754239" : "#e8cbc5",
        "banner-bg": wash, "banner-line": line, "banner-manual-bg": wash, "banner-manual-fg": muted,
        "vb-bg": bg, "vb-fg": text, "vb-line": line, "vb-hold-bg": action, "vb-hold-fg": onAction,
        "vb-mic-bg": accent, "vb-mic-fg": palette.light[6], "vb-btn-bg": card, "vb-btn-fg": text,
        "vb-btn-line": line, "vb-cta-shadow": "transparent", "room-line": roomLine,
        "room-mid": roomMid, "room-light": roomLight, "room-dark": roomDark, "room-accent": roomAccent,
        "theme-light-display": dark ? "none" : "block", "theme-dark-display": dark ? "block" : "none",
    };
    return {
        settings: { ...settings }, effectiveMode, paletteName: palette.name,
        artPrefix: `/assets/themes/${settings.palette}/`,
        themeStyle: Object.entries(colors).map(([key, value]) => `--${key}:${value}`).join(";") + `;background:${bg};color:${text};`,
    };
}
function getAppearance() { return stateFor(load()); }
function previewAppearance(settings) {
    load();
    return stateFor(sanitize(settings));
}
function updateAppearance(patch) {
    const current = load();
    const next = sanitize({ ...current, ...patch });
    // Storage failure must leave the previously applied appearance untouched.
    try {
        wx.setStorageSync(STORAGE_KEY, next);
    }
    catch (_) {
        throw new Error("设置未保存，请重试。");
    }
    saved = next;
    const state = stateFor(next);
    publish(state);
    applyNavigation(state);
    return state;
}
function publish(state) {
    listeners.forEach(listener => { try {
        listener({ ...state, settings: { ...state.settings } });
    }
    catch (_) { /* isolate subscribers */ } });
}
function subscribeAppearance(fn) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}
function initAppearance() {
    load();
    if (listening)
        return;
    if (typeof wx.onThemeChange === "function") {
        wx.onThemeChange(({ theme }) => {
            systemMode = theme === "dark" ? "dark" : "light";
            // A local preview may follow the system even when the saved mode is forced.
            // Apply saved navigation first so the preview subscriber retains its own chrome.
            const state = getAppearance();
            applyNavigation(state);
            publish(state);
        });
        listening = true;
    }
}
function applyNavigation(state = getAppearance()) {
    const colors = exports.PALETTES[state.settings.palette][state.effectiveMode];
    const fail = () => { };
    try {
        wx.setNavigationBarColor({ frontColor: state.effectiveMode === "dark" ? "#ffffff" : "#000000", backgroundColor: colors[0], fail });
    }
    catch (_) { /* old base library */ }
    try {
        wx.setBackgroundColor({ backgroundColor: colors[0], backgroundColorTop: colors[0], backgroundColorBottom: colors[0], fail });
    }
    catch (_) { /* old base library */ }
    try {
        wx.setBackgroundTextStyle({ textStyle: state.effectiveMode === "dark" ? "light" : "dark", fail });
    }
    catch (_) { /* old base library */ }
}
function paletteOptions() {
    return Object.entries(exports.PALETTES).map(([id, palette]) => ({ id, name: palette.name, group: palette.group, swatches: [palette.light[0], palette.light[5], palette.light[6], palette.light[8]] }));
}
