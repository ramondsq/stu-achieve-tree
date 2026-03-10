const { request } = require('../../utils/request');
const { setSession, clearSession } = require('../../utils/auth');

Page({
  data: {
    username: '',
    password: '',
    loading: false,
    errorText: '',
    successText: '',
  },

  onShow() {
    clearSession();
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
    wx.redirectTo({
      url: '/pages/trees/trees',
    });
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
      this.gotoTrees();
    } catch (err) {
      this.setMessage({ errorText: err.message || '微信绑定失败' });
    } finally {
      this.setData({ loading: false });
    }
  },
});
