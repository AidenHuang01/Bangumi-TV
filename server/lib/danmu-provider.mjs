import { createHash } from 'node:crypto';
import { animeKey, episodeNumber } from './auto-danmaku.mjs';

const fail = message => Object.assign(new Error(message), { status: 502, publicMessage: message });
const opaque = value => 'mu-' + createHash('sha256').update(value).digest('hex').slice(0, 32);
export const cleanDanmuTitle = value => String(value || '').replace(/\((?:\d{4}|N\/A)\)【[^】]*】from [a-z0-9_-]+$/i, '').trim();
export function matchDanmuAnime(item, title) {
  return [cleanDanmuTitle(item.animeTitle), ...(item.aliases || [])].some(name => animeKey(name) === animeKey(title));
}
export function matchDanmuEpisode(episodes, number) {
  const matches = episodes.filter(row => {
    const label = String(row.episodeTitle || '').trim().replace(/^【[^】]*】\s*/, '');
    if (/SP|OVA|OAD|预告|特典|特别|特別|总集|總集/i.test(label)) return false;
    const explicit = episodeNumber(label) || Number(/^(?:第\s*)?(\d{1,4})(?:[集话話]|[ .:：-])/.exec(label)?.[1]);
    return (explicit || episodeNumber(row.episodeNumber)) === number;
  });
  return matches.length === 1 ? matches[0] : null;
}

export function createDanmuProvider({ url, token, fetcher = fetch, now = Date.now, ttl = 6 * 3600000 } = {}) {
  const base = new URL(url);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('danmu_api must be a loopback service');
  const shows = new Map(), episodes = new Map(), comments = new Map(), pending = new Map();
  async function api(path, params = {}, signal) {
    const timeout = AbortSignal.timeout(45000), abort = new AbortController();
    const cancel = () => abort.abort();
    if (signal?.aborted) throw signal.reason;
    signal?.addEventListener('abort', cancel, { once: true }); timeout.addEventListener('abort', cancel, { once: true });
    try {
      const response = await fetcher(new URL(path + '?' + new URLSearchParams(params), base), {
        headers: { 'X-Bangumi-Danmu': token }, redirect: 'error', signal: abort.signal
      });
      if (!response.ok) { await response.body?.cancel(); throw fail('弹幕服务暂时不可用（HTTP ' + response.status + '），视频继续播放。'); }
      const reader = response.body.getReader(), parts = []; let size = 0;
      try { for (;;) { const { value, done } = await reader.read(); if (done) break;
        size += value.length; if (size > 4 * 1024 * 1024) throw fail('弹幕数据过大，已停止加载。'); parts.push(Buffer.from(value)); }
      } finally { await reader.cancel().catch(() => {}); }
      const data = JSON.parse(Buffer.concat(parts).toString());
      if (data.success === false) throw fail('弹幕来源请求失败，视频继续播放。');
      return data;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error.publicMessage) throw error;
      throw fail('弹幕来源连接失败或超时，视频继续播放；可稍后重试。');
    } finally { signal?.removeEventListener('abort', cancel); timeout.removeEventListener('abort', cancel); }
  }
  function limit(map, max) { while (map.size > max) map.delete(map.keys().next().value); }
  async function search(title, signal) {
    if (!title?.trim() || title.length > 100) throw fail('请输入有效番剧名称。');
    const data = await api('/api/v2/search/anime', { keyword: title }, signal);
    const result = [];
    for (const item of (data.animes || []).slice(0, 60)) {
      if (!Number.isSafeInteger(Number(item.animeId)) || Number(item.animeId) <= 0) continue;
      const id = opaque([item.source, item.animeId, item.animeTitle].join('|'));
      shows.set(id, { ...item, rawId: String(item.animeId) });
      result.push({ animeId: id, animeTitle: item.animeTitle, typeDescription: item.typeDescription, source: item.source, aliases: item.aliases || [] });
    }
    limit(shows, 150);
    return { animes: result };
  }
  async function details(id, signal) {
    const show = shows.get(id);
    if (!show) throw fail('弹幕候选已过期，请重新搜索。');
    const data = await api('/api/v2/bangumi/' + show.rawId, {}, signal);
    const rows = (data.bangumi?.episodes || []).slice(0, 2000).map(row => {
      const key = opaque(id + '|' + row.episodeId + '|' + row.episodeTitle);
      episodes.set(key, { rawId: String(row.episodeId), source: show.source, title: cleanDanmuTitle(show.animeTitle), episodeTitle: row.episodeTitle });
      return { episodeId: key, episodeTitle: row.episodeTitle, episodeNumber: row.episodeNumber };
    });
    limit(episodes, 5000);
    return { bangumi: { animeId: id, episodes: rows } };
  }
  async function getComments(id, signal) {
    const entry = episodes.get(id);
    if (!entry || !/^[0-9]{1,20}$/.test(entry.rawId)) throw fail('弹幕分集已过期，请重新选择。');
    const data = await api('/api/v2/comment/' + entry.rawId, { format: 'json' }, signal);
    if (!Array.isArray(data.comments) || !data.comments.length) throw fail('这个弹幕来源暂时没有评论，请换一个弹幕来源。');
    return { content: JSON.stringify({ comments: data.comments }), source: 'danmu_api · ' + entry.source + ' · ' + entry.title + ' · ' + entry.episodeTitle };
  }
  async function acquireOnce({ title, episode, signal }) {
      const key = animeKey(title) + '|' + episode, saved = comments.get(key);
      if (saved && saved.expires > now()) return saved.value;
      const result = await search(title, signal);
      const candidates = result.animes.filter(item => matchDanmuAnime(item, title) &&
        !/剧场|劇場|电影|電影|真人|OVA|OAD|总集|總集|movie/i.test(item.typeDescription || ''))
        .sort((a, b) => Number(b.source === 'dandan') - Number(a.source === 'dandan'));
      if (!candidates.length) throw fail('没有找到完全匹配的番剧弹幕；可在手机“弹幕设置”搜索并手动确认。');
      const years = new Set(candidates.map(item => /\((\d{4})\)【/.exec(item.animeTitle)?.[1]).filter(Boolean));
      if (years.size > 1) throw fail('发现不同年份的同名作品，请在手机手动确认弹幕版本。');
      let last;
      for (const candidate of candidates.slice(0, 5)) {
        signal?.throwIfAborted();
        try {
          const rows = (await details(candidate.animeId, signal)).bangumi.episodes;
          const selected = matchDanmuEpisode(rows, episode);
          if (!selected) { last = fail('无法唯一匹配这一集，请在手机手动选择，避免加载错集。'); continue; }
          const value = await getComments(selected.episodeId, signal);
          comments.set(key, { value, expires: now() + ttl }); limit(comments, 30);
          return value;
        } catch (error) { if (signal?.aborted) throw signal.reason; last = error; }
      }
      throw last || fail('未找到当前集可用的弹幕。');
  }
  function acquire(request) {
    const key = animeKey(request.title) + '|' + request.episode;
    if (request.signal?.aborted) return Promise.reject(request.signal.reason);
    let job = pending.get(key);
    if (!job || job.abort.signal.aborted) {
      job = { abort: new AbortController(), users: 0 };
      job.promise = acquireOnce({ ...request, signal: job.abort.signal }).finally(() => {
        if (pending.get(key) === job) pending.delete(key);
      });
      pending.set(key, job);
    }
    const current = job;
    return new Promise((resolve, reject) => {
      current.users++; let done = false;
      const finish = (fn, value) => {
        if (done) return; done = true;
        request.signal?.removeEventListener('abort', cancel);
        if (--current.users === 0) current.abort.abort();
        fn(value);
      };
      const cancel = () => finish(reject, request.signal.reason);
      request.signal?.addEventListener('abort', cancel, { once: true });
      current.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  return {
    engine: 'danmu_api', search, episodes: details, comments: getComments, acquire,
    prefetch(selection) {
      const title = selection.animeTitle, episode = episodeNumber(selection.episodeName);
      if (!title || !episode) return;
      const abort = new AbortController();
      acquire({ title, episode, signal: abort.signal }).catch(() => {});
      return () => abort.abort();
    }
  };
}
