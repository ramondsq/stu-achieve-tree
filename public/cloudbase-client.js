(function bootstrapCloudbaseClient(global) {
  let appInstance = null;
  let authInstance = null;
  let loginPromise = null;

  function getConfig() {
    const config = global.CLOUDBASE_CONFIG || {};
    if (!config.envId) {
      throw new Error('未配置 CloudBase 环境 ID');
    }
    if (!config.region) {
      throw new Error('未配置 CloudBase 区域');
    }
    if (!config.publishableKey) {
      throw new Error('未配置 CloudBase Publishable Key');
    }
    return config;
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
      region: config.region,
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
