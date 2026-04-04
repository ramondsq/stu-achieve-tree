(function bootstrapCloudbaseClient(global) {
  let appInstance = null;
  let authInstance = null;
  let loginPromise = null;

  function shouldUseLocalHttp() {
    const config = global.CLOUDBASE_CONFIG || {};
    if (config.useLocalHttpOnLocalhost === false) {
      return false;
    }

    const hostname = global.location && global.location.hostname
      ? String(global.location.hostname).toLowerCase()
      : '';
    return hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '0.0.0.0'
      || hostname === '::1'
      || hostname === '[::1]';
  }

  function getConfig() {
    const config = global.CLOUDBASE_CONFIG || {};
    if (!config.envId) {
      throw new Error('未配置 CloudBase 环境 ID');
    }
    if (!config.publishableKey) {
      throw new Error('未配置 CloudBase Publishable Key');
    }
    return config;
  }

  async function callLocalApi(path, options = {}) {
    const url = new URL(String(path || '/'), global.location.origin);
    const query = { ...(options.query || {}) };
    url.searchParams.forEach((value, key) => {
      if (!(key in query)) {
        query[key] = value;
      }
    });
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    });

    const method = String(options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    let body = undefined;
    if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      body = JSON.stringify(options.body);
    }

    const response = await global.fetch(url.toString(), {
      method,
      headers,
      credentials: 'same-origin',
      body,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error((payload && payload.message) || `请求失败: HTTP ${response.status}`);
    }
    return payload;
  }

  function getApp() {
    if (appInstance) {
      return appInstance;
    }

    if (!global.cloudbase) {
      throw new Error('CloudBase Web SDK 未加载');
    }

    const config = getConfig();
    appInstance = global.cloudbase.init({
      env: config.envId,
      region: config.region || 'ap-shanghai',
      accessKey: config.publishableKey,
      auth: {
        detectSessionInUrl: true,
      },
    });
    authInstance = appInstance.auth();
    return appInstance;
  }

  async function ensureAnonymousLogin() {
    if (!loginPromise) {
      loginPromise = (async () => {
        const auth = authInstance || getApp().auth();
        try {
          const loginState = await auth.getLoginState();
          if (loginState && loginState.user) {
            return loginState;
          }
        } catch (_error) {
        }
        return auth.signInAnonymously();
      })();
    }
    return loginPromise;
  }

  async function callApi(path, options = {}) {
    if (shouldUseLocalHttp()) {
      return callLocalApi(path, options);
    }

    await ensureAnonymousLogin();
    const app = getApp();
    const url = new URL(String(path || '/'), 'https://cloudbase.local');
    const query = { ...(options.query || {}) };
    url.searchParams.forEach((value, key) => {
      if (!(key in query)) {
        query[key] = value;
      }
    });

    const result = await app.callFunction({
      name: 'api',
      data: {
        invokeMode: 'rpc',
        path: `${url.pathname}${url.search}`,
        method: options.method || 'GET',
        headers: options.headers || {},
        query,
        data: options.body || {},
      },
    });

    const payload = result.result || {};
    if (!payload.ok) {
      throw new Error(payload.message || '请求失败');
    }

    return payload.data;
  }

  global.CloudbaseWebClient = {
    callApi,
    ensureAnonymousLogin,
  };
})(window);
