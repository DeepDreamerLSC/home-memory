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

import {
  attachVoiceEntry,
  type VoiceEntryActions,
  type VoiceEntryHandle,
  type VoiceEntryState,
} from "../../utils/voice-entry";

interface VoiceBarData extends VoiceEntryState {
  /** 手指按住胶囊(按压反馈) */
  pressed: boolean;
  /** 键盘弹起(条自动避让隐藏) */
  kbOpen: boolean;
}

interface VoiceBarCustom {
  /** 语音入口共享句柄(attached 时挂,detached 时解除) */
  entry: VoiceEntryHandle | null;
  /** 键盘高度监听(detached 时移除) */
  kbListener: ((res: { height: number }) => void) | null;
}

type VoiceBarMethods = {
  onHoldTouchStart(e: WechatMiniprogram.TouchEvent): void;
  onHoldTouchMove(e: WechatMiniprogram.TouchEvent): void;
  onHoldTouchEnd(): void;
  onHoldTouchCancel(): void;
  onTextTap(): void;
};

Component<VoiceBarData, Record<string, never>, VoiceBarMethods, VoiceBarCustom>({
  data: {
    voiceState: "idle",
    transcribing: false,
    extracting: false,
    recordSeconds: 0,
    partialText: "",
    pressed: false,
    kbOpen: false,
  },

  lifetimes: {
    created() {
      // 自定义实例属性初始化(句柄与监听在 attached 建立)
      this.entry = null;
      this.kbListener = null;
    },

    attached() {
      this.entry = attachVoiceEntry({
        onStateChange: (s) => {
          this.setData({
            voiceState: s.voiceState,
            transcribing: s.transcribing,
            extracting: s.extracting,
            recordSeconds: s.recordSeconds,
            partialText: s.partialText,
          });
        },
        fallbackToText: (e: VoiceEntryActions) => {
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
          this.setData({ kbOpen: open });
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
      if (this.entry !== null && this.entry.isBusy()) {
        return;
      }
      wx.navigateTo({
        url: "/pages/confirm/confirm?manual=true",
        fail: () => {
          wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
        },
      });
    },
  },
});
