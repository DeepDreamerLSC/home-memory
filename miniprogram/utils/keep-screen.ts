/**
 * L1 防熄屏(真机反馈 2026-10-24):视频清点识别 8 帧要 30-60 秒,期间熄屏即中断。
 * 识别阶段开始调用 setScanKeepScreenOn(true),在 扫描完成/失败/用户取消/onHide/
 * onUnload 全部路径上恢复 false——漏恢复 = 常亮耗电事故,恢复调用幂等,宁可多调
 * 不可漏。两视频页(video-scan / location-video-scan)共用,不复制。
 *
 * setKeepScreenOn 在低版本基础库可能不存在或 fail:一律吞掉,防熄屏只是增强,
 * 绝不影响识别主流程。
 */
export function setScanKeepScreenOn(keepScreenOn: boolean): void {
  try {
    if (typeof wx === "undefined" || typeof wx.setKeepScreenOn !== "function") return;
    wx.setKeepScreenOn({ keepScreenOn, fail: () => {} });
  } catch (e) {
    // 低版本/异常环境:吞掉,不抛给识别链
  }
}
