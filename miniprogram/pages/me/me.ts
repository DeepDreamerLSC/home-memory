import { cachedUserProfile, getUserProfile } from "../../utils/profile-api";
import { getAppearance } from "../../utils/appearance";
import { applyPageAppearance } from "../../utils/appearance-page";
Page({
  data: { nickname:"", avatarFileId:"", initial:"", paletteName:"奶油", modeName:"跟随系统", error:"" },
  request: 0,
  onShow() {
    applyPageAppearance(this);
    const state = getAppearance();
    this.setData({ ...cachedUserProfile(), initial:Array.from(cachedUserProfile().nickname)[0] || "", paletteName:state.paletteName, modeName:({system:"跟随系统",light:"浅色",dark:"深色"})[state.settings.mode] });
    const request = ++this.request;
    void getUserProfile().then(p => { if (request === this.request) this.setData({...p, initial:Array.from(p.nickname)[0] || "", error:""}); }).catch(e => { if (request === this.request) this.setData({error:e.message}); });
  },
  onHide() { this.request++; },
  onUnload() { this.request++; },
  onProfileTap() { wx.navigateTo({url:"/pages/profile/profile"}); },
  onAppearanceTap() { wx.navigateTo({url:"/pages/appearance/appearance"}); },
  onDisplayTap() { wx.navigateTo({url:"/pages/home-display/home-display"}); },
  onFamilyTap() { wx.navigateTo({url:"/pages/family/family"}); }
});
