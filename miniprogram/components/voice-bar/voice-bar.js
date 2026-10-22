"use strict";
/**
 * 常驻语音条组件(issue #45:语音入口全局可达)。
 *
 * 职责(纯接线,状态机在 utils/voice-entry 单例):
 * - 整颗胶囊 = 按住热区:触摸四事件转共享入口 pressStart/pressMove/pressEnd/pressCancel;
 * - 「文字」按钮 → 文字确认入口(手动录入确认页);在途(录音/识别/提取)置灰防打断;
 * - 键盘弹起自动避让(wx.onKeyboardHeightChange,条隐藏);
 * - 组件所在页 hide / 组件卸载:作废在途会话并解除绑定。
 *
 * 挂载范围(十一轮决策 1):locations / family / item;confirm 系列与 join-family 不挂。
 */
Object.defineProperty(exports, "__esModule", { value: true });
const voice_entry_1 = require("../../utils/voice-entry");
function openEntryPage(state, entry, url) {
    if (state.voiceState !== "idle" || state.transcribing || state.extracting || (entry !== null && entry.isBusy())) {
        return false;
    }
    wx.navigateTo({
        url,
        fail: () => wx.showToast({ title: "页面打开失败,请重试", icon: "none" }),
    });
    return true;
}
Component({
    options: { multipleSlots: true },
    data: {
        voiceState: "idle",
        transcribing: false,
        extracting: false,
        recordSeconds: 0,
        partialText: "",
        pressed: false,
        kbOpen: false,
        showActions: false,
    },
    lifetimes: {
        created() {
            // 自定义实例属性初始化(句柄与监听在 attached 建立)
            this.entry = null;
            this.kbListener = null;
        },
        attached() {
            this.entry = (0, voice_entry_1.attachVoiceEntry)({
                onStateChange: (s) => {
                    this.setData({
                        voiceState: s.voiceState,
                        transcribing: s.transcribing,
                        extracting: s.extracting,
                        recordSeconds: s.recordSeconds,
                        partialText: s.partialText,
                        showActions: false,
                    });
                },
                fallbackToText: (e) => {
                    // 本页无页内文字模式:作废本次按压后直接进文字确认页(手动录入)
                    e.invalidate();
                    wx.navigateTo({
                        url: "/pages/confirm/confirm?manual=true",
                        fail: () => {
                            wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
                        },
                    });
                },
            });
            // 键盘弹起自动避让:高度 > 0 视为弹起,条隐藏(设计 T7)
            this.kbListener = (res) => {
                const open = typeof res.height === "number" && res.height > 0;
                if (open !== this.data.kbOpen) {
                    this.setData({ kbOpen: open, showActions: false });
                }
            };
            wx.onKeyboardHeightChange(this.kbListener);
        },
        detached() {
            if (this.entry !== null) {
                this.entry.invalidate();
                this.entry.detach();
                this.entry = null;
            }
            if (this.kbListener !== null) {
                wx.offKeyboardHeightChange(this.kbListener);
                this.kbListener = null;
            }
        },
    },
    pageLifetimes: {
        hide() {
            // 宿主页被覆盖/退后台:作废在途按压(与首页 onHide 同语义)
            if (this.entry !== null) {
                this.entry.invalidate();
            }
            this.setData({ showActions: false, pressed: false });
        },
    },
    methods: {
        onHoldTouchStart(e) {
            if (this.entry === null) {
                return;
            }
            this.setData({ pressed: true });
            const touch = e.touches && e.touches[0];
            this.entry.pressStart(touch ? touch.clientY : 0);
        },
        onHoldTouchMove(e) {
            if (this.entry === null) {
                return;
            }
            const touch = e.touches && e.touches[0];
            if (!touch) {
                return;
            }
            this.entry.pressMove(touch.clientY);
        },
        onHoldTouchEnd() {
            this.setData({ pressed: false });
            if (this.entry !== null) {
                this.entry.pressEnd();
            }
        },
        onHoldTouchCancel() {
            this.setData({ pressed: false });
            if (this.entry !== null) {
                this.entry.pressCancel();
            }
        },
        /** 文字确认入口:在途(录音/识别/提取)置灰防打断,空闲才可进 */
        onTextTap() {
            if (openEntryPage(this.data, this.entry, "/pages/confirm/confirm?manual=true")) {
                this.setData({ showActions: false });
            }
        },
        onAddTap() {
            if (this.data.voiceState !== "idle" || this.data.transcribing || this.data.extracting || (this.entry !== null && this.entry.isBusy()))
                return;
            this.setData({ showActions: true });
        },
        onActionsClose() { this.setData({ showActions: false }); },
        onPhotoTap() {
            if (openEntryPage(this.data, this.entry, "/pages/photo/photo"))
                this.setData({ showActions: false });
        },
        onVideoTap() {
            if (openEntryPage(this.data, this.entry, "/pages/video-scan/video-scan"))
                this.setData({ showActions: false });
        },
        noop() { },
    },
});
