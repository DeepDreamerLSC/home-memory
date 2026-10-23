"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const profile_api_1 = require("../../utils/profile-api");
const appearance_1 = require("../../utils/appearance");
const appearance_page_1 = require("../../utils/appearance-page");
Page({
    data: { nickname: "", avatarFileId: "", initial: "", paletteName: "奶油", modeName: "跟随系统", error: "" },
    request: 0,
    onShow() {
        (0, appearance_page_1.applyPageAppearance)(this);
        const state = (0, appearance_1.getAppearance)();
        this.setData({ ...(0, profile_api_1.cachedUserProfile)(), initial: Array.from((0, profile_api_1.cachedUserProfile)().nickname)[0] || "", paletteName: state.paletteName, modeName: ({ system: "跟随系统", light: "浅色", dark: "深色" })[state.settings.mode] });
        const request = ++this.request;
        void (0, profile_api_1.getUserProfile)().then(p => { if (request === this.request)
            this.setData({ ...p, initial: Array.from(p.nickname)[0] || "", error: "" }); }).catch(e => { if (request === this.request)
            this.setData({ error: e.message }); });
    },
    onHide() { this.request++; },
    onUnload() { this.request++; },
    onProfileTap() { wx.navigateTo({ url: "/pages/profile/profile" }); },
    onAppearanceTap() { wx.navigateTo({ url: "/pages/appearance/appearance" }); },
    onDisplayTap() { wx.navigateTo({ url: "/pages/home-display/home-display" }); },
    onFamilyTap() { wx.navigateTo({ url: "/pages/family/family" }); }
});
