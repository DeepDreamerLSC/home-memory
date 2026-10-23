import { getAppearance, PALETTES, updateAppearance } from "../../utils/appearance";
import { applyPageAppearance } from "../../utils/appearance-page";
Page({
  data: { themeStyle: "", switchColor: "#30372c", recent: true, expiry: true, errorText: "" },
  onShow() {
    applyPageAppearance(this);
    const state = getAppearance();
    const settings = state.settings;
    this.setData({ recent: settings.recent, expiry: settings.expiry, switchColor: PALETTES[settings.palette][state.effectiveMode][6] });
  },
  onToggle(event: WechatMiniprogram.SwitchChange) {
    const key = event.currentTarget.dataset.key;
    if (key !== "recent" && key !== "expiry") return;
    try {
      const state = updateAppearance({ [key]: event.detail.value });
      this.setData({ recent: state.settings.recent, expiry: state.settings.expiry, errorText: "" });
    } catch (error) {
      const settings = getAppearance().settings;
      this.setData({ recent: settings.recent, expiry: settings.expiry, errorText: error instanceof Error ? error.message : "设置未保存，请重试。" });
    }
  },
  onHomeTap() { wx.reLaunch({ url: "/pages/index/index" }); },
});
