import { cloudEnv, isCloudEnvPlaceholder } from "./config";
import { pruneLocationsCache } from "./utils/locations-cache";

App({
  onLaunch() {
    // 清理超过 24 小时的空间树缓存层(issue #23:缓存带绝对过期,启动时收口)
    pruneLocationsCache();
    if (!wx.cloud) {
      console.error("当前基础库不支持云开发能力,请升级微信或基础库版本");
      wx.showModal({
        title: "基础库版本过低",
        content: "当前微信版本不支持云开发能力,小程序无法正常工作,请升级微信后重试。",
        showCancel: false,
      });
      return;
    }
    wx.cloud.init({ env: cloudEnv, traceUser: false });
    if (isCloudEnvPlaceholder) {
      // 配置缺失时如实提示,不让后续调用失败被静默吞掉
      wx.showModal({
        title: "请先配置云环境",
        content:
          "miniprogram/config.ts 中的 cloudEnv 仍是占位符 YOUR_ENV_ID,请替换为你的云环境 ID 后再使用。",
        showCancel: false,
      });
    }
  },
});
