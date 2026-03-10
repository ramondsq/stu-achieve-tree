const { getToken } = require('./auth');

const FUNCTION_NAME = 'api';

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

    wx.cloud.callFunction({
      name: FUNCTION_NAME,
      data: {
        invokeMode: 'rpc',
        path,
        method,
        headers: header,
        data,
      },
      success: (resp) => {
        const payload = resp.result || {};
        if (payload.ok) {
          resolve(payload.data);
          return;
        }
        reject(new Error(payload.message || '请求失败'));
      },
      fail: (err) => {
        reject(new Error(err.errMsg || '云函数调用失败'));
      },
    });
  });
}

module.exports = {
  request,
};
