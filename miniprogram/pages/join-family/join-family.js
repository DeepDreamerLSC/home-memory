"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 加入共享家庭确认页(issue #34 P1-B,邀请卡片落地):
 * - 分享卡片 path 直接指向本页(?invite=<token>),冷启动即落地;
 * - 进页调 inviteInfo 展示家庭名 + 隐私明示(冻结合同决策 1/D2):
 *   「加入后,这个家庭的成员都能看到你的共享记录,你也能看到他们的全部物品」
 *   与「你现有的个人物品不会自动出现在共享家庭里」;一步确认,绝不静默加入;
 * - 确认后 join:成功(含幂等 already_member)→ 捕获共享作用域 + 清缓存 →
 *   回到首页重拉;已在别的共享家庭 → ALREADY_IN_FAMILY 如实提示;
 * - 令牌无效/过期/已撤销/家庭已解散:NOT_FOUND 如实文案 + 可关闭;
 * - 体验版前提如实说明:非体验成员打不开卡片(平台拦截发生在进入小程序之前)。
 */
const api_1 = require("../../utils/api");
const households_api_1 = require("../../utils/households-api");
/** 隐私明示(冻结合同 D2/决策 1,原文照抄,勿改语义) */
const PRIVACY_NOTICE = "加入后,这个家庭的成员都能看到你的共享记录,你也能看到他们的全部物品";
const BLANK_NOTICE = "你现有的个人物品不会自动出现在共享家庭里";
Page({
    data: {
        phase: "loading",
        token: "",
        manualToken: "",
        familyName: "",
        errorText: "",
        joining: false,
        privacyNotice: PRIVACY_NOTICE,
        blankNotice: BLANK_NOTICE,
    },
    onLoad(options) {
        // 页面 query 参数不自动解码;容错解码(已解码或含非法 % 时原样返回)
        const raw = options.invite || "";
        let token = "";
        try {
            token = decodeURIComponent(raw);
        }
        catch (e) {
            token = raw;
        }
        token = token.trim();
        if (!token) {
            // 无卡片参数(体验版分享受限的手输兜底入口):进手输阶段而非报错
            this.setData({ phase: "manual" });
            return;
        }
        this.setData({ token });
        void this.verifyToken(token);
    },
    /** 令牌预检:inviteInfo 拿家庭名 → 确认页;失败如实进错误页(可重输) */
    async verifyToken(token) {
        this.setData({ phase: "loading", token });
        try {
            const info = await (0, households_api_1.fetchInviteInfo)(token);
            this.setData({ phase: "confirm", familyName: info.display_name });
        }
        catch (e) {
            // 令牌不存在/已撤销/已过期/家庭已解散:服务端统一 NOT_FOUND,如实展示
            this.setData({ phase: "error", errorText: (0, api_1.errorMessage)(e) });
        }
    },
    onManualTokenInput(e) {
        this.setData({ manualToken: (e.detail.value || "").trim() });
    },
    onManualSubmitTap() {
        const token = this.data.manualToken;
        if (this.data.joining || !token) {
            if (!token) {
                wx.showToast({ title: "请先粘贴邀请码", icon: "none" });
            }
            return;
        }
        void this.verifyToken(token);
    },
    onManualRetryTap() {
        this.setData({ phase: "manual" });
    },
    /** 确认加入:join 幂等(已是成员直接成功);成功后作用域切到共享家庭并回首页 */
    async onJoinTap() {
        if (this.data.joining || !this.data.token) {
            return;
        }
        this.setData({ joining: true });
        try {
            const res = await (0, households_api_1.joinFamily)(this.data.token);
            this.showAlreadyMemberHint(res.already_member === true);
            this.backToHome();
        }
        catch (e) {
            // ALREADY_IN_FAMILY / HOUSEHOLD_UNAVAILABLE 等:服务端文案如实提示,可关闭
            if ((0, api_1.isApiError)(e)) {
                this.setData({ phase: "error", errorText: e.message });
            }
            else {
                this.setData({ phase: "error", errorText: (0, api_1.errorMessage)(e) });
            }
        }
        finally {
            this.setData({ joining: false });
        }
    },
    showAlreadyMemberHint(already) {
        wx.showToast({
            title: already ? "你已在这个家庭里" : "已加入",
            icon: "success",
            duration: 1500,
        });
    },
    /** 加入成功:作用域已捕获(households-api),回首页自然重拉最近记录与空间树 */
    backToHome() {
        setTimeout(() => {
            wx.reLaunch({
                url: "/pages/index/index",
                fail: () => {
                    wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
                },
            });
        }, 600);
    },
    onCloseTap() {
        // 分享卡片冷启动落地时无上级页面,navigateBack 会失败:统一 reLaunch 首页
        wx.reLaunch({
            url: "/pages/index/index",
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
});
