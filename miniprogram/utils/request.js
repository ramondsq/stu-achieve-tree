const { getToken } = require('./auth');

function resolveUrl(path) {
  if (!path) {
    return '';
  }
  if (/^https?:\/\//.test(path)) {
    return path;
  }
  const app = getApp();
  const baseUrl = (app && app.globalData && app.globalData.apiBaseUrl) || '';
  if (!baseUrl) {
    throw new Error('请先在 app.js 中配置 globalData.apiBaseUrl');
  }
  return `${baseUrl}${path}`;
}

function request(path, options = {}) {
  const {
    method = 'GET',
    data,
    needAuth = true,
    headers = {},
  } = options;

  return new Promise((resolve, reject) => {
    const header = { ...headers };
    if (needAuth) {
      const token = getToken();
      if (token) {
        header.Authorization = `Bearer ${token}`;
      }
    }

    wx.request({
      url: resolveUrl(path),
      method,
      data,
      header,
      success: (resp) => {
        const payload = resp.data || {};
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          resolve(payload);
          return;
        }
        reject(new Error(payload.message || `请求失败 (${resp.statusCode})`));
      },
      fail: (err) => {
        reject(new Error(err.errMsg || '网络请求失败'));
      },
    });
  });
}

module.exports = {
  request,
};
