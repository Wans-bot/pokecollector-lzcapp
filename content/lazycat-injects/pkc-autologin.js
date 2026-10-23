/**
 * PokéCollector 免密登录 + 默认中文注入（browser 阶段）
 *
 * 为什么需要：
 *   1. 上游用 JWT + localStorage（键名 token / user），装完打开是登录页；
 *   2. 上游的界面语言以后端 /api/settings 为唯一来源（frontend/src/contexts/SettingsContext.jsx
 *      用 GET /api/settings/ 覆盖本地缓存），新实例默认 language=en，中文包本身完整。
 *
 * 契约（见 lzc-manifest.yml 的 pkc-login-autofill）：
 *   params.user / params.password 由部署参数渲染传入，不写死在脚本里。
 *
 * 幂等：localStorage 里已有可用 token 就不再登录；语言已经是 zh 就不再写，
 * 两者都没有产生变化时不会 reload，避免刷新循环。
 */
(() => {
  const params = (typeof ctx !== "undefined" && ctx && ctx.params) || {};
  const username = params.user || params.username;
  const password = params.password;

  if (!username || !password) return;
  if (window.__pkcAutologinRunning) return;
  window.__pkcAutologinRunning = true;

  // 后端存 'zh'，前端把它映射成 'zh-cn'（SettingsContext.jsx:144）
  const LANG = "zh";
  // 登录被拒（429 限流 / 5xx 后端未就绪）时退避 60 秒：否则每次页面加载都重试，
  // 首装那几十秒会被自己的重试打进限流窗口，后续正常登录也被挡在外头。
  const BACKOFF_KEY = "pkc_login_backoff";
  const BACKOFF_MS = 60000;
  const backoffLeft = () => Number(localStorage.getItem(BACKOFF_KEY) || 0) - Date.now();
  const backoff = () => localStorage.setItem(BACKOFF_KEY, String(Date.now() + BACKOFF_MS));
  const clearBackoff = () => localStorage.removeItem(BACKOFF_KEY);

  const me = async (token) => {
    try {
      const res = await fetch("/api/auth/me", { headers: { Authorization: "Bearer " + token } });
      return res.ok;
    } catch (err) {
      return false;
    }
  };

  const run = async () => {
    if (backoffLeft() > 0) {
      window.__pkcAutologinRunning = false;
      return;
    }
    let reload = false;
    let token = localStorage.getItem("token") || "";

    // 1) 已有的 token 失效了就重新登录
    if (token && !(await me(token))) token = "";

    // 2) 登录：上游是 OAuth2 表单编码，返回 {access_token, token_type, user}
    if (!token) {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username, password }),
      });
      if (!res.ok) {
        // 429/5xx 是「后端还没起来 / 被限流」，退避；401 是账号密码不对，重试也没用，同样退避。
        if (res.status === 429 || res.status === 401 || res.status >= 500) backoff();
        window.__pkcAutologinRunning = false;
        return;
      }
      clearBackoff();
      const data = await res.json().catch(() => null);
      token = (data && (data.access_token || data.token)) || "";
      if (!token) {
        window.__pkcAutologinRunning = false;
        return;
      }
      localStorage.setItem("token", token);
      if (data.user) localStorage.setItem("user", JSON.stringify(data.user));
      reload = true;
    }

    // 3) 默认中文。只改 language 一个键：后端 PUT /api/settings/ 是逐个 key 覆盖的。
    try {
      const cur = await fetch("/api/settings/", { headers: { Authorization: "Bearer " + token } });
      if (cur.ok) {
        const settings = await cur.json().catch(() => null);
        const now = settings ? String(settings.language || "") : "";
        if (now !== LANG && now !== "zh-cn") {
          const put = await fetch("/api/settings/", {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
            body: JSON.stringify({ language: LANG }),
          });
          if (put.ok) {
            // 首屏在拿到后端设置前会读这个缓存键，先写一份避免闪一下英文
            localStorage.setItem("app_language", "zh-cn");
            reload = true;
          }
        }
      }
    } catch (err) {
      /* 语言设置失败不影响登录 */
    }

    window.__pkcAutologinRunning = false;
    if (reload) location.reload();
  };

  run().catch(() => {
    window.__pkcAutologinRunning = false;
  });
})();
