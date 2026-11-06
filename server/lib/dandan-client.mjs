import { createHash } from 'node:crypto';
import { readDanmuJson } from './nipaplay-client.mjs';
import { assertDanmakuNetworkAllowed } from './danmaku-network-policy.mjs';

const base = 'https://api.dandanplay.net';
const userAgent = 'Bangumi-TV POC/0.4 (https://github.com/AidenHuang01/Bangumi-TV)';
const fail = message => Object.assign(new Error(message), { publicMessage: message });
const validId = id => {
  if (!/^[1-9]\d{0,15}$/u.test(String(id)) || !Number.isSafeInteger(Number(id))) throw fail('无效的弹幕编号。');
  return String(id);
};

// App credentials/signatures only go to the fixed official HTTPS host, never to
// NipaPlay, Bahamut, signed CDN redirects, frontends, argv, or logs.
export function createDandanClient({ appId, appSecret, fetcher = fetch, now = Date.now } = {}) {
  if (!appId || !appSecret) throw fail('官方弹弹play应用凭证尚未配置。');
  async function api(path, params = {}) {
    if (fetcher === globalThis.fetch) assertDanmakuNetworkAllowed();
    const timestamp = String(Math.floor(now() / 1000));
    let response;
    try {
      response = await fetcher(base + path + '?' + new URLSearchParams(params), {
        redirect: 'manual', signal: AbortSignal.timeout(15000), headers: {
          Accept: 'application/json', 'User-Agent': userAgent, 'X-AppId': appId, 'X-Timestamp': timestamp,
          'X-Signature': createHash('sha256').update(appId + timestamp + path + appSecret).digest('base64')
        }
      });
    } catch { throw fail('官方弹弹play HTTPS 连接失败或超时。'); }
    if (response.status === 302 && path.startsWith('/api/v2/comment/')) {
      const location = response.headers.get('location'); await response.body?.cancel();
      let target; try { target = new URL(location); } catch { throw fail('官方弹幕下载地址无效。'); }
      if (target.protocol !== 'https:' || !/(^|\.)dandanplay\.net$/iu.test(target.hostname) || target.username || target.password || target.port) {
        throw fail('官方弹幕下载地址不符合 HTTPS 安全要求。');
      }
      return { location: target.href };
    }
    if (!response.ok) { await response.body?.cancel(); throw fail('官方弹弹play请求失败（HTTP ' + response.status + '），检查应用权限或配额。'); }
    try {
      const data = await readDanmuJson(response);
      if (data.success === false) throw new Error();
      return { data };
    } catch { throw fail('官方弹弹play未返回有效数据，请稍后重试。'); }
  }
  return {
    async search(title) {
      if (typeof title !== 'string' || !title.trim() || title.length > 100) throw fail('请输入有效番剧名称。');
      return (await api('/api/v2/search/anime', { keyword: title })).data.animes || [];
    },
    async details(id) { return (await api('/api/v2/bangumi/' + validId(id))).data.bangumi; },
    async comments(id) {
      const result = await api('/api/v2/comment/' + validId(id), { withRelated: 'true', chConvert: '0' });
      if (result.data) return { comments: result.data.comments || [], location: null };
      try {
        const response = await fetcher(result.location, { headers: { Accept: 'application/json', 'User-Agent': userAgent },
          redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) { await response.body?.cancel(); throw new Error(); }
        return { comments: (await readDanmuJson(response)).comments || [], location: result.location };
      } catch { return { comments: [], location: result.location }; } // Associated platforms can still work.
    }
  };
}
