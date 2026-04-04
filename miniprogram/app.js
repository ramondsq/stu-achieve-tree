const { pickRandomTip } = require('./utils/loading-tips.js');

const CLOUD_ENV_ID = 'cloud1-7gu74gqqd2913ea4';
const STATIC_HOST_BASE_URL = 'https://cloud1-7gu74gqqd2913ea4-1408652187.tcloudbaseapp.com';

App({
  onLaunch() {
    wx.cloud.init({
      env: CLOUD_ENV_ID,
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
    pdfViewerBaseUrl: `${STATIC_HOST_BASE_URL}/pdf-viewer.html`,
    currentStartupTip: null,
    startupOverlayPending: false,
    rewardCenterDirty: false,
  },
});
