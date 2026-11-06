import { createNipaplayClient } from './nipaplay-client.mjs';

export function connectNipaplay({ credentials, getSourceByKey, parseRelatedLinks, resolveLink, applyShift,
  client = createNipaplayClient(credentials), supplementalClient }) {
  const dandan = getSourceByKey('dandan'), bahamut = getSourceByKey('bahamut');
  async function catalogue(method, value) {
    let result;
    try {
      result = await client[method](value);
      if (result && (method !== 'search' || result.length)) return result;
    } catch { /* The account gateway remains a catalogue failure fallback. */ }
    if (supplementalClient) return supplementalClient[method](value);
    if (method === 'search' && Array.isArray(result)) return result;
    throw new Error('弹弹play番剧资料暂不可用。');
  }
  dandan.search = title => catalogue('search', title);
  dandan.getEpisodes = async id => {
    const detail = await catalogue('details', id);
    if (!detail) throw new Error('弹幕番剧详情暂不可用。');
    // Do not infer missing episode IDs or crawl sequels for automatic matching.
    return { episodes: detail.episodes || [], titles: (detail.titles || []).map(item => item.title), relateds: [],
      type: detail.type, typeDescription: detail.typeDescription, imageUrl: detail.imageUrl };
  };
  dandan.getEpisodeDanmu = async id => {
    // Same exact episode ID on both channels. The official application's related
    // links can differ from an account's links; keep enrichment instead of silently
    // replacing a rich episode with a smaller successful native-only response.
    const requests = [client, supplementalClient].filter(Boolean);
    const settled = await Promise.allSettled(requests.map(item => item.comments(id)));
    const results = settled.filter(item => item.status === 'fulfilled').map(item => item.value);
    const comments = [], nativeSeen = new Set(), links = [];
    for (const result of results) {
      for (const row of result.comments || []) {
        const key = JSON.stringify([row.p, row.m]);
        if (nativeSeen.has(key)) continue;
        nativeSeen.add(key); comments.push(row);
      }
      if (result.location) links.push(...(parseRelatedLinks(result.location).bahamut || []).slice(0, 4));
    }
    const seen = new Set();
    for (const { url, shift } of links.slice(0, 8)) {
      const resolved = resolveLink(url);
      if (resolved.source !== 'bahamut' || !/^\d{1,12}$/.test(String(resolved.realId)) || seen.has(resolved.realId)) continue;
      seen.add(resolved.realId);
      try {
        const raw = await bahamut.getEpisodeDanmu(resolved.realId);
        comments.push(...bahamut.formatComments(raw || []).map(item => applyShift({ ...item, realTimeSource: 'bahamut' }, shift)));
      } catch { /* Native comments remain usable if the related platform fails. */ }
    }
    if (!comments.length) throw new Error('弹弹play及巴哈姆特暂未返回可用弹幕。');
    return comments;
  };
}
