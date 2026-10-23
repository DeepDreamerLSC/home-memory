"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const appearance_1 = require("../../utils/appearance");
const appearance_page_1 = require("../../utils/appearance-page");
Page({
    data: { themeStyle: "", switchColor: "#30372c", recent: true, expiry: true, errorText: "" },
    onShow() {
        (0, appearance_page_1.applyPageAppearance)(this);
        const state = (0, appearance_1.getAppearance)();
        const settings = state.settings;
        this.setData({ recent: settings.recent, expiry: settings.expiry, switchColor: appearance_1.PALETTES[settings.palette][state.effectiveMode][6] });
    },
    onToggle(event) {
        const key = event.currentTarget.dataset.key;
        if (key !== "recent" && key !== "expiry")
            return;
        try {
            const state = (0, appearance_1.updateAppearance)({ [key]: event.detail.value });
            this.setData({ recent: state.settings.recent, expiry: state.settings.expiry, errorText: "" });
        }
        catch (error) {
            const settings = (0, appearance_1.getAppearance)().settings;
            this.setData({ recent: settings.recent, expiry: settings.expiry, errorText: error instanceof Error ? error.message : "设置未保存，请重试。" });
        }
    },
    onHomeTap() { wx.reLaunch({ url: "/pages/index/index" }); },
});
