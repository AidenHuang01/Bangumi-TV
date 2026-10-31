const gateway = 'https://nipaplay.aimes-soft.com/dandanplay';
const userAgent = 'LogVar Danmu API/1.21.7 (Bangumi-TV POC)';
const fail = message => Object.assign(new Error(message), { publicMessage: message });
const unavailable = () => fail('弹幕网关 HTTPS 连接失败或超时，请检查网络安全放行；视频继续播放。');
const validId = id => {
  if (!/^[1-9]\d{0,15}$/.test(String(id)) || !Number.isSafeInteger(Number(id))) throw fail('无效的弹幕编号。');
  return String(id);
};

export async function readDanmuJson(response, limit = 4 * 1024 * 1024) {
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) throw fail('弹幕响应超过 4 MB，已停止加载。');
      parts.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(parts).toString());
  } finally { await reader.cancel().catch(() => {}); }
}

// Our approved danmu_api integration owns user authentication. Never enable
// upstream's plaintext gateway fallback or pass account secrets to its globals.
export function createNipaplayClient({ account, password, fetcher = fetch, now = Date.now } = {}) {
  if (!account || !password) throw fail('弹幕账号尚未配置。');
  let token, expires = 0, login;
  async function request(path, { authenticated = false, method = 'GET', body } = {}) {
    try {
      return await fetcher(gateway + path, { method, redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', 'User-Agent': userAgent, ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(authenticated ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw unavailable(); }
  }
  function save(data) {
    if (typeof data.token !== 'string' || !data.token) throw fail('弹幕账号登录失败，请检查账号或密码。');
    token = data.token; expires = Date.parse(data.tokenExpireTime) || now() + 3600000;
  }
  async function authenticate() {
    if (token && expires > now() + 60000) return;
    if (!login) login = (async () => {
      if (token) {
        const renewed = await request('/api/v2/login/renew', { authenticated: true });
        if (renewed.ok) { const data = await readDanmuJson(renewed); if (data.token) { save(data); return; } }
        else await renewed.body?.cancel();
      }
      const response = await request('/api/v2/login', { method: 'POST', body: { userName: account, password } });
      if (!response.ok) { await response.body?.cancel(); throw fail('弹幕账号登录失败或被限流，请稍后重试。'); }
      try { save(await readDanmuJson(response)); } catch (error) { throw error.publicMessage ? error : unavailable(); }
    })().finally(() => { login = undefined; });
    return login;
  }
  async function api(path, retried = false) {
    await authenticate();
    const response = await request(path, { authenticated: true });
    if (response.status === 401 && !retried) {
      await response.body?.cancel(); token = undefined; expires = 0;
      return api(path, true);
    }
    if (response.status === 302 && path.startsWith('/api/v2/comment/')) {
      const location = response.headers.get('location'); await response.body?.cancel();
      let target; try { target = new URL(location); } catch { throw unavailable(); }
      if (target.protocol !== 'https:' || !/(^|\.)dandanplay\.net$/i.test(target.hostname) || target.username || target.password || target.port) {
        throw fail('弹幕下载地址不符合 HTTPS 安全要求。');
      }
      return { location: target.href };
    }
    if (!response.ok) { await response.body?.cancel(); throw fail('弹幕网关暂时不可用（HTTP ' + response.status + '），视频继续播放。'); }
    try {
      const data = await readDanmuJson(response);
      if (data.success === false) throw fail('弹幕来源请求失败，请稍后重试。');
      return { data };
    } catch (error) { throw error.publicMessage ? error : unavailable(); }
  }
  return {
    async search(title) { return (await api('/api/v2/search/anime?keyword=' + encodeURIComponent(title))).data.animes || []; },
    async details(id) { return (await api('/api/v2/bangumi/' + validId(id))).data.bangumi; },
    async comments(id) {
      const result = await api('/api/v2/comment/' + validId(id) + '?withRelated=true&chConvert=0');
      if (result.data) return { comments: result.data.comments || [], location: null };
      // Signed CDN links are short-lived: fetch immediately; cache comments,
      // never the URL. Account tokens and passwords never leave the gateway.
      try {
        const response = await fetcher(result.location, { headers: { Accept: 'application/json', 'User-Agent': userAgent },
          redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
        return { comments: (await readDanmuJson(response)).comments || [], location: result.location };
      } catch { return { comments: [], location: result.location }; } // Related Bahamut links can still be used.
    }
  };
}
