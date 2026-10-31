import { createNipaplayClient } from './nipaplay-client.mjs';

export function connectNipaplay({ credentials, getSourceByKey, parseRelatedLinks, resolveLink, applyShift, client = createNipaplayClient(credentials) }) {
  const dandan = getSourceByKey('dandan'), bahamut = getSourceByKey('bahamut');
  dandan.search = title => client.search(title);
  dandan.getEpisodes = async id => {
    const detail = await client.details(id);
    if (!detail) throw new Error('弹幕番剧详情暂不可用。');
    // Do not infer missing episode IDs or crawl sequels for automatic matching.
    return { episodes: detail.episodes || [], titles: (detail.titles || []).map(item => item.title), relateds: [],
      type: detail.type, typeDescription: detail.typeDescription, imageUrl: detail.imageUrl };
  };
  dandan.getEpisodeDanmu = async id => {
    const result = await client.comments(id);
    const comments = [...result.comments];
    const links = result.location ? parseRelatedLinks(result.location).bahamut || [] : [];
    const seen = new Set();
    for (const { url, shift } of links.slice(0, 4)) {
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
