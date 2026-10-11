import { requestUpstream } from './upstream.mjs';
import { readBody } from './discovery.mjs';

const placeholder = { type: 'image/svg+xml', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="250" viewBox="0 0 180 250"><rect width="180" height="250" fill="#22362f"/><path d="M55 105h70v50H55zM70 88l20 17 20-17" stroke="#7de4c4" fill="none" stroke-width="4"/><text x="90" y="200" text-anchor="middle" fill="#afc6be" font-family="sans-serif" font-size="14">bangumi</text></svg>') };
export const coverTitle = title => title.toLowerCase().replace(/[\s!！:：·.\-_]/g, '');
export function matchCover(items, title) {
  return items.find(item => [item.name, item.name_cn].some(name => name && coverTitle(name) === coverTitle(title)));
}
export function createCovers({ upstream = requestUpstream } = {}) {
  const cache = new Map(), pending = new Map();
  return {
    async get(title) {
      const key = coverTitle(title), cached = cache.get(key);
      if (cached && cached.expires > Date.now()) return cached.value;
      if (pending.has(key)) return pending.get(key);
      if (pending.size >= 4) return placeholder;
      const job = (async () => {
        let value = placeholder;
        try {
          const signal = AbortSignal.timeout(10000);
          const result = await upstream('https://api.bgm.tv/v0/search/subjects?limit=8', { method: 'POST', contentType: 'application/json',
            body: JSON.stringify({ keyword: title, filter: { type: [2], nsfw: false } }), signal,
            source: { userAgent: 'Forge-TV/0.5 (https://github.com/forgetech-dev/Forge-TV)' } });
          if (result.status !== 200) { result.stream.destroy(); throw new Error('Metadata unavailable'); }
          const item = matchCover(JSON.parse((await readBody(result, 1024 * 1024)).toString()).data || [], title);
          const url = new URL(item?.images?.common || item?.images?.medium || 'https://invalid.local/');
          if (url.protocol !== 'https:' || url.hostname !== 'lain.bgm.tv') throw new Error('No matching cover');
          const image = await upstream(url.href, { signal });
          if (image.status !== 200) { image.stream.destroy(); throw new Error('Image unavailable'); }
          const bytes = await readBody(image, 1024 * 1024);
          const type = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' :
            bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' :
            bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
          if (type) value = { type, bytes };
        } catch { /* Missing images must not block search or video playback. */ }
        cache.set(key, { value, expires: Date.now() + (value === placeholder ? 300000 : 86400000) });
        while (cache.size > 60) cache.delete(cache.keys().next().value);
        return value;
      })();
      pending.set(key, job);
      try { return await job; } finally { pending.delete(key); }
    }
  };
}
