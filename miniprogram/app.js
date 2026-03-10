App({
  onLaunch() {
    wx.cloud.init({
      env: 'cloud1-7gu74gqqd2913ea4',
      traceUser: true,
    });
  },

  globalData: {
    envId: 'cloud1-7gu74gqqd2913ea4',
  },
});
