App({
  globalData: {
    // 替换成你的后端地址，例如 https://api.example.com
    // 小程序不能请求 localhost，需要公网 HTTPS 域名（开发阶段可用调试放开）。
    apiBaseUrl: 'http://127.0.0.1:3000',
  },
});
