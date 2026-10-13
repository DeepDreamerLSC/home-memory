"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const locations_cache_1 = require("./utils/locations-cache");
const households_api_1 = require("./utils/households-api");
const household_scope_1 = require("./utils/household-scope");
/**
 * 作用域漂移如实提示(硬门 C:被移除/家庭解散/异地切换——本地记忆与服务端
 * active 不一致)。只在「之前是共享态」时打扰用户:单人用户的作用域恒稳定,
 * 不弹打扰。缓存清空与作用域回写在 verifyHouseholdScope 内收口。
 */
function notifyScopeDrift(drift) {
    if (!drift.fromShared && !drift.toShared) {
        return; // 个人 → 个人:同一个人家庭,无实质变化
    }
    const message = drift.fromShared
        ? "你已不在刚才的共享家庭里(可能已退出、被移除或家庭已解散),已回到你的个人家庭"
        : "家庭状态刚变化,已为你刷新";
    wx.showToast({ title: message, icon: "none", duration: 3000 });
}
App({
    onLaunch() {
        // 清理超过 24 小时的空间树缓存层(issue #23:缓存带绝对过期,启动时收口)。
        // best-effort(P1-2):缓存模块内部已吃掉 storage 异常,这里再加一层保险,
        // 本地缓存问题绝不允许打断应用启动与云环境初始化。
        try {
            (0, locations_cache_1.pruneLocationsCache)();
        }
        catch (e) {
            // 缓存清理失败:静默跳过,不影响启动
        }
        if (!wx.cloud) {
            console.error("当前基础库不支持云开发能力,请升级微信或基础库版本");
            wx.showModal({
                title: "基础库版本过低",
                content: "当前微信版本不支持云开发能力,小程序无法正常工作,请升级微信后重试。",
                showCancel: false,
            });
            return;
        }
        wx.cloud.init({ env: config_1.cloudEnv, traceUser: false });
        if (config_1.isCloudEnvPlaceholder) {
            // 配置缺失时如实提示,不让后续调用失败被静默吞掉
            wx.showModal({
                title: "请先配置云环境",
                content: "miniprogram/config.ts 中的 cloudEnv 仍是占位符 YOUR_ENV_ID,请替换为你的云环境 ID 后再使用。",
                showCancel: false,
            });
            return;
        }
        // 展示前资格复核(issue #34 P1-B,硬门 C1):冷启动先拿服务端可信家庭上下文,
        // 未验证期间页面不得把持久化缓存当作当前可访问内容展示;best-effort,
        // 失败保持未验证态(页面直连服务端如实报错),绝不阻塞启动
        void (0, households_api_1.verifyHouseholdScope)(notifyScopeDrift).catch(() => { });
    },
    onShow() {
        // 前台切回:重置验证状态并重新复核(成员资格可能在后台期间变化——
        // 被移除/家庭解散/异地切换)。首次启动 onShow 紧随 onLaunch,复核幂等
        // (pendingVerify 去重);之前是共享态且漂移时如实提示。
        if (!wx.cloud) {
            return;
        }
        const wasShared = (0, household_scope_1.isHouseholdScopeShared)();
        (0, households_api_1.invalidateScopeVerification)();
        void (0, households_api_1.verifyHouseholdScope)((drift) => {
            notifyScopeDrift({ ...drift, fromShared: wasShared || drift.fromShared });
        }).catch(() => { });
    },
});
