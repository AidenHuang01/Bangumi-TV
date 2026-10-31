import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { requestUpstream } from './upstream.mjs';
import { readBody } from './discovery.mjs';
import { createDanmakuFilter } from './danmaku-filter.mjs';

const fail = message => Object.assign(new Error(message), { status: 400 });
export function parseDanmaku(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 4 * 1024 * 1024) throw fail('Danmaku file limit: 4 MB');
  let values;
  if (content.trimStart().startsWith('<')) {
    if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw fail('XML entities are not supported');
    let dom;
    try {
      dom = new JSDOM(content, { contentType: 'text/xml' });
      values = [...dom.window.document.querySelectorAll('d')].map(node => {
        const p = (node.getAttribute('p') || '').split(',');
        return { time: Number(p[0]), mode: Number(p[1]), color: Number(p[3]), text: node.textContent };
      });
    } catch { throw fail('Invalid Bilibili XML danmaku'); }
    finally { dom?.window.close(); }
  } else {
    let data;
    try { data = JSON.parse(content); } catch { throw fail('Use Bilibili XML or danmaku JSON'); }
    values = Array.isArray(data) ? data : data?.comments ?? data?.danmakus;
    if (!Array.isArray(values)) throw fail('JSON must contain a comments or Kazumi danmakus array');
    values = values.map(row => {
      if (!row || typeof row !== 'object') return {};
      if (typeof row.p !== 'string') return row;
      const p = row.p.split(',');
      return { time: Number(p[0]), mode: Number(p[1]), color: Number(p[2]), text: row.m };
    });
  }
  return values.filter(row => Number.isFinite(row.time) && row.time >= 0 && row.time < 86400 && typeof row.text === 'string' && row.text.trim())
    .slice(0, 20000).map(row => ({ time: row.time, text: row.text.slice(0, 200),
      mode: [4, 5].includes(Number(row.mode)) ? Number(row.mode) : 1,
      color: /^#[a-f0-9]{6}$/i.test(row.color) ? row.color : '#' + Math.floor(Math.max(0, Math.min(0xffffff, Number.isFinite(Number(row.color)) ? Number(row.color) : 0xffffff))).toString(16).padStart(6, '0')
    })).sort((a, b) => a.time - b.time);
}

export function createDanmaku({ appId = process.env.DANDAN_APP_ID || '', appSecret = process.env.DANDAN_APP_SECRET || '', fetcher = fetch,
  core, coreConfigured = false, provider, automatic, filterOptions } = {}) {
  const files = new Map();
  const moderation = createDanmakuFilter(filterOptions);
  let revision = 0, settings = { enabled: true, offset: 0, opacity: 0.8 };
  const useCore = !!core && (coreConfigured || !(appId && appSecret));
  const configured = !!provider || (useCore ? coreConfigured : !!(appId && appSecret));
  async function api(path, params = {}) {
    if (!configured) throw fail('Add DANDAN_APP_ID and DANDAN_APP_SECRET on the Mac to enable online danmaku.');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHash('sha256').update(appId + timestamp + path + appSecret).digest('base64');
    const response = await fetcher('https://api.dandanplay.net' + path + '?' + new URLSearchParams(params), {
      headers: { 'X-AppId': appId, 'X-Timestamp': timestamp, 'X-Signature': signature, 'User-Agent': 'Forge-TV/0.5 (https://github.com/forgetech-dev/Forge-TV)' },
      redirect: 'manual', signal: AbortSignal.timeout(15000)
    });
    // Never forward authentication headers to a redirected CDN.
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
      const target = new URL(response.headers.get('location'), 'https://api.dandanplay.net');
      await response.body?.cancel();
      if (target.protocol !== 'https:') throw fail('Danmaku redirect must use HTTPS');
      const result = await requestUpstream(target.href, { signal: AbortSignal.timeout(15000) });
      if (result.status !== 200) { result.stream.destroy(); throw fail('Danmaku CDN returned HTTP ' + result.status); }
      return JSON.parse((await readBody(result, 4 * 1024 * 1024)).toString('utf8'));
    }
    if (!response.ok) { await response.body?.cancel(); throw fail('DanDanPlay returned HTTP ' + response.status); }
    const reader = response.body.getReader(), parts = []; let size = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > 4 * 1024 * 1024) throw fail('Danmaku response exceeds 4 MB'); parts.push(Buffer.from(value)); } }
    finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(parts).toString());
  }
  function put(streamId, comments, source) {
    if (!comments.length) throw fail('No usable comments in this file');
    const filtered = moderation.apply(comments);
    files.set(streamId, { comments: filtered.comments, filtering: filtered.stats, source, revision: ++revision });
    while (files.size > 30) files.delete(files.keys().next().value);
    return { count: filtered.comments.length, source, filtering: filtered.stats };
  }
  return {
    status() { return { configured: configured || automatic?.configured === true, manualConfigured: configured,
      engine: automatic?.engine || provider?.engine || (useCore ? 'kazumi' : 'dandanplay'), ...settings,
      contentFilter: { enabled: true, mode: 'local-rules', ...moderation.policy },
      message: automatic?.message || (provider ? 'danmu_api 已连接：选集后后台获取弹幕，Mac 不播放视频。' : configured ? (useCore ? 'Kazumi danmaku connected. Choose a show and episode.' : 'DanDanPlay configured. Choose an episode match.')
        : useCore ? '源码构建未配置在线 API。下方“官方 Kazumi 弹幕转发”可免密钥读取 Mac 上的官方客户端缓存。'
          : 'Online danmaku awaits API keys. XML / JSON import is available.') }; },
    settings(input) {
      if (typeof input.enabled === 'boolean') settings.enabled = input.enabled;
      if (input.offset !== undefined) { if (!Number.isFinite(input.offset) || Math.abs(input.offset) > 600) throw fail('Offset must be within ±600 seconds'); settings.offset = input.offset; }
      if (input.opacity !== undefined) { if (!Number.isFinite(input.opacity) || input.opacity < 0.1 || input.opacity > 1) throw fail('Opacity must be 0.1–1'); settings.opacity = input.opacity; }
      revision++; return this.status();
    },
    read(streamId, version) {
      const entry = files.get(streamId);
      const current = String(revision) + ':' + (entry?.revision || 0);
      return { ...this.status(), version: current, source: entry?.source || null, count: entry?.comments.length || 0,
        filtering: entry?.filtering || null,
        ...(version === current ? { unchanged: true } : { comments: entry?.comments || [] }) };
    },
    import(streamId, content, source = 'Imported file') { return put(streamId, parseDanmaku(content), source); },
    clear(streamId) { files.delete(streamId); revision++; },
    async search(anime, episode) {
      if (!anime?.trim() || anime.length > 100) throw fail('Enter an anime title');
      if (provider) return provider.search(anime);
      if (useCore) return core.danmakuSearch(anime);
      return api('/api/v2/search/episodes', { anime, episode: String(episode || '').slice(0, 100) });
    },
    async episodes(animeId) {
      if (provider) return provider.episodes(animeId);
      if (!/^[1-9]\d{0,14}$/.test(String(animeId)) || !Number.isSafeInteger(Number(animeId))) throw fail('Invalid anime ID');
      if (useCore) return core.danmakuEpisodes(animeId);
      return api('/api/v2/bangumi/' + animeId);
    },
    async attach(streamId, episodeId) {
      if (provider) {
        const data = await provider.comments(episodeId);
        return put(streamId, parseDanmaku(data.content), data.source);
      }
      if (!/^[1-9]\d{0,15}$/.test(String(episodeId)) || !Number.isSafeInteger(Number(episodeId))) throw fail('Invalid episode ID');
      const data = useCore ? await core.danmakuComments(episodeId)
        : await api('/api/v2/comment/' + episodeId, { withRelated: 'true' });
      return put(streamId, parseDanmaku(JSON.stringify(data)), (useCore ? 'Kazumi · ' : 'DanDanPlay · ') + episodeId);
    }
  };
}
