import { animeKey } from './auto-danmaku.mjs';

export function createHeadlessAcquirer({ provider, cache }) {
  return async request => {
    try { return await provider.acquire(request); }
    catch (error) {
      request.signal?.throwIfAborted();
      // A verified local file is a fallback, never a reason to skip richer
      // online aggregation. No desktop acquisition is triggered on failure.
      try {
        const listing = await cache.list();
        const matches = (listing.items || []).filter(item => item.episode === request.episode &&
          [item.title, ...(item.aliases || [])].some(name => animeKey(name) === animeKey(request.title)));
        const item = matches.sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (item) {
          const data = await cache.read(item.id); request.signal?.throwIfAborted();
          return { ...data, source: data.source + ' · 在线获取失败，使用已验证缓存' };
        }
      } catch { request.signal?.throwIfAborted(); }
      throw error;
    }
  };
}
