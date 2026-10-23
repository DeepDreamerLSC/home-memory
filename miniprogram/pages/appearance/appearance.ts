import { applyNavigation, getAppearance, paletteOptions, previewAppearance, subscribeAppearance, updateAppearance, type AppearanceSettings } from "../../utils/appearance";
import { applyPageAppearance } from "../../utils/appearance-page";
const options = paletteOptions();
Page({
  data: {
    draft: getAppearance().settings,
    previewStyle: "", previewMode: "light", previewName: "奶油", artPrefix: "", artSuffix: "",
    softPalettes: options.filter(option => option.group === "柔和配色"),
    vividPalettes: options.filter(option => option.group === "鲜明配色"),
    modes: [{ id: "system", name: "跟随系统" }, { id: "light", name: "浅色" }, { id: "dark", name: "深色" }],
    homePreview: false, saving: false, errorText: "",
  },
  unsubscribeAppearance: null as (() => void) | null,
  onLoad() {
    this.unsubscribeAppearance = subscribeAppearance(() => { this.refreshPreview(); });
    this.setData({ draft: getAppearance().settings });
    this.refreshPreview();
  },
  onShow() { applyPageAppearance(this); this.refreshPreview(); },
  onUnload() {
    this.unsubscribeAppearance?.();
    applyNavigation();
  },
  refreshPreview() {
    const state = previewAppearance(this.data.draft);
    this.setData({ previewStyle: state.themeStyle, previewMode: state.effectiveMode, previewName: state.paletteName, artPrefix: state.artPrefix, artSuffix: state.effectiveMode === "dark" ? "-dark" : "" });
    applyNavigation(state);
  },
  onPaletteTap(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (!options.some(option => option.id === id)) return;
    this.setData({ "draft.palette": id, errorText: "" });
    this.refreshPreview();
  },
  onModeTap(event: WechatMiniprogram.TouchEvent) {
    const mode = event.currentTarget.dataset.id;
    if (!["system", "light", "dark"].includes(mode)) return;
    this.setData({ "draft.mode": mode as AppearanceSettings["mode"], errorText: "" });
    this.refreshPreview();
  },
  onPreviewTap() { this.setData({ homePreview: true }); wx.pageScrollTo({ scrollTop: 0, duration: 0 }); },
  onAdjustTap() { this.setData({ homePreview: false }); },
  onRestoreTap() {
    this.setData({ "draft.palette": "cream", "draft.mode": "system", errorText: "" });
    this.refreshPreview();
  },
  onApplyTap() {
    if (this.data.saving) return;
    this.setData({ saving: true, errorText: "" });
    try {
      // Preserve independently saved homepage options when applying a theme draft.
      updateAppearance({ palette: this.data.draft.palette, mode: this.data.draft.mode });
      wx.showToast({ title: "主题已应用", icon: "success" });
      wx.navigateBack({ fail: () => { wx.redirectTo({ url: "/pages/me/me" }); } });
    } catch (error) {
      this.setData({ errorText: error instanceof Error ? error.message : "设置未保存，请重试。" });
    } finally { this.setData({ saving: false }); }
  },
});
