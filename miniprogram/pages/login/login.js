const { request } = require('../../utils/request');
const { setSession, clearSession } = require('../../utils/auth');
const { pickRandomTip } = require('../../utils/loading-tips.js');

Page({
  data: {
    username: '',
    password: '',
    loading: false,
    errorText: '',
    successText: '',
    startupTip: pickRandomTip(),
    showStartupOverlay: false,
    startupOverlayTip: null,
  },

  onShow() {
    clearSession();
    this.refreshStartupTip();
    this.tryShowStartupOverlay();
  },

  tryShowStartupOverlay() {
    const app = getApp();
    if (!app || typeof app.consumeStartupOverlayTip !== 'function') {
      return;
    }
    const tip = app.consumeStartupOverlayTip();
    if (!tip) {
      return;
    }
    this.setData({
      showStartupOverlay: true,
      startupOverlayTip: tip,
      startupTip: tip,
    });
  },

  refreshStartupTip() {
    const app = getApp();
    const previousKey = this.data.startupTip ? this.data.startupTip.key : '';
    const nextTip = app && typeof app.nextStartupTip === 'function'
      ? app.nextStartupTip(previousKey)
      : pickRandomTip(previousKey);
    this.setData({ startupTip: nextTip });
  },

  handleChangeStartupOverlayTip() {
    const app = getApp();
    const previousKey = this.data.startupOverlayTip ? this.data.startupOverlayTip.key : '';
    const nextTip = app && typeof app.nextStartupTip === 'function'
      ? app.nextStartupTip(previousKey)
      : pickRandomTip(previousKey);
    this.setData({
      startupOverlayTip: nextTip,
      startupTip: nextTip,
    });
  },

  handleCloseStartupOverlay() {
    this.setData({ showStartupOverlay: false });
  },

  onUsernameInput(e) {
    this.setData({ username: (e.detail.value || '').trim() });
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value || '' });
  },

  setMessage({ errorText = '', successText = '' }) {
    this.setData({ errorText, successText });
  },

  gotoTrees() {
    setTimeout(() => {
      wx.redirectTo({
        url: '/pages/trees/trees',
      });
    }, 280);
  },

  async handlePasswordLogin() {
    const { username, password, loading } = this.data;
    if (loading) return;

    if (!username || !password) {
      this.setMessage({ errorText: '请输入用户名和密码' });
      return;
    }

    this.setData({ loading: true });
    this.setMessage({});

    try {
      const payload = await request('/api/student/login', {
        method: 'POST',
        needAuth: false,
        data: { username, password },
      });

      setSession(payload);
      this.setMessage({ successText: '登录成功，正在进入学习树...' });
      wx.showToast({ title: '登录成功', icon: 'success' });
      this.gotoTrees();
    } catch (err) {
      this.setMessage({ errorText: err.message || '登录失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async handleWechatLogin() {
    const { loading } = this.data;
    if (loading) return;

    this.setData({ loading: true });
    this.setMessage({});

    try {
      const payload = await request('/api/student/wechat-login', {
        method: 'POST',
        needAuth: false,
        data: {},
      });

      setSession(payload);
      this.setMessage({ successText: '微信登录成功，正在进入学习树...' });
      wx.showToast({ title: '微信登录成功', icon: 'success' });
      this.gotoTrees();
    } catch (err) {
      this.setMessage({ errorText: err.message || '微信登录失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async handleWechatBind() {
    const { username, password, loading } = this.data;
    if (loading) return;

    if (!username || !password) {
      this.setMessage({ errorText: '微信绑定需要先输入用户名和密码' });
      return;
    }

    this.setData({ loading: true });
    this.setMessage({});

    try {
      const payload = await request('/api/student/wechat-bind', {
        method: 'POST',
        needAuth: false,
        data: {
          username,
          password,
        },
      });

      setSession(payload);
      this.setMessage({ successText: '绑定成功，正在进入学习树...' });
      wx.showToast({ title: '绑定成功', icon: 'success' });
      this.gotoTrees();
    } catch (err) {
      this.setMessage({ errorText: err.message || '微信绑定失败' });
    } finally {
      this.setData({ loading: false });
    }
  },
});
