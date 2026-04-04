const { pickRandomTip } = require('./utils/loading-tips.js');

App({
  onLaunch() {
    wx.cloud.init({
      env: 'cloud1-7gu74gqqd2913ea4',
      traceUser: true,
    });
    this.globalData.currentStartupTip = pickRandomTip();
    this.globalData.startupOverlayPending = true;
  },

  consumeStartupOverlayTip() {
    if (!this.globalData.startupOverlayPending) {
      return null;
    }
    this.globalData.startupOverlayPending = false;
    if (!this.globalData.currentStartupTip) {
      this.globalData.currentStartupTip = pickRandomTip();
    }
    return this.globalData.currentStartupTip;
  },

  nextStartupTip(previousKey = '') {
    const tip = pickRandomTip(previousKey || (this.globalData.currentStartupTip && this.globalData.currentStartupTip.key));
    this.globalData.currentStartupTip = tip;
    return tip;
  },

  globalData: {
    envId: 'cloud1-7gu74gqqd2913ea4',
    pdfViewerBaseUrl: 'https://cloud1-7gu74gqqd2913ea4-1408652187.tcloudbaseapp.com/pdf-viewer.html',
    currentStartupTip: null,
    startupOverlayPending: false,
    rewardCenterDirty: false,
  },
});
