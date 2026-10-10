import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { requestUpstream } from './upstream.mjs';
import { createResolver } from './resolver.mjs';

export const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ruleNames = ['AGE', 'MXdm', 'DM84', 'moonci', 'sorani', '7sefun'];
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export async function readBody(result, max = 3 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of result.stream) {
    size += chunk.length;
    if (size > max) { result.stream.destroy(); throw fail('Source response is too large', 502); }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks), options = { maxOutputLength: max };
  switch (result.headers['content-encoding']) {
    case 'gzip': return gunzipSync(body, options);
    case 'deflate': return inflateSync(body, options);
    case 'br': return brotliDecompressSync(body, options);
    default: return body;
  }
}

export function xpath(document, expression, node = document) {
  if (!expression || expression === '//') return [node];
  if (node !== document && expression.startsWith('//')) expression = '.' + expression;
  const result = document.evaluate(expression, node, null, 7, null);
  return Array.from({ length: result.snapshotLength }, (_, i) => result.snapshotItem(i));
}

// Intentionally restricted: no eval, script expressions, recursive descent or filters.
export function jsonPath(value, expression) {
  if (!expression || expression === '$') return [value];
  if (!/^\$(?:\.[A-Za-z_][\w-]*|\[\d+\]|\[\*\])+$/.test(expression)) throw fail('Unsupported API rule JSON path', 502);
  let values = [value];
  for (const token of expression.slice(1).match(/\.[A-Za-z_][\w-]*|\[\d+\]|\[\*\]/g)) {
    values = values.flatMap(item => token === '[*]' ? (Array.isArray(item) ? item : []) :
      item == null ? [] : [item[token.startsWith('.') ? token.slice(1) : Number(token.slice(1, -1))]])
      .filter(item => item !== undefined && item !== null);
  }
  return values;
}

export function templateRequest(config, variables) {
  const replace = (input, encoded) => String(input).replace(/@(keyword|source|episodeUrl)/g,
    (_, key) => encoded ? encodeURIComponent(variables[key] ?? '') : String(variables[key] ?? ''));
  const url = new URL(replace(config.url, true));
  for (const [key, value] of Object.entries(config.query || {})) url.searchParams.set(key, replace(value, false));
  return { url: url.href, method: config.method || 'GET' };
}

export function createDiscovery({ upstream = requestUpstream, rules, resolver: customResolver } = {}) {
  const loaded = rules ? Promise.resolve(rules) : Promise.all(ruleNames.map(async name =>
    ({ ...JSON.parse(await readFile(new URL('../rules/' + name + '.json', import.meta.url))), id: name })));
  const records = new Map(), streams = new Map(), pending = new Map();
  const resolver = customResolver || createResolver({ upstream });
  let searching = 0;
  function remember(value, map = records) {
    const id = randomBytes(16).toString('hex');
    map.set(id, { ...value, expires: Date.now() + 6 * 60 * 60 * 1000 });
    for (const [key, item] of map) if (item.expires < Date.now()) map.delete(key);
    while (map.size > 3000) map.delete(map.keys().next().value);
    return id;
  }
  function lookup(id, type) {
    const item = records.get(id);
    if (!item || item.expires < Date.now() || item.type !== type) throw fail('Selection expired. Search again.', 404);
    return item;
  }
  async function fetchRule(rule, request) {
    const url = new URL(request.url);
    let body;
    if (request.method === 'POST') { body = url.searchParams.toString(); url.search = ''; }
    const result = await upstream(url.href, { source: { url: url.href, userAgent: rule.userAgent || userAgent,
      referer: rule.referer || rule.baseURL }, method: request.method || 'GET', body, signal: AbortSignal.timeout(15000) });
    if (result.status !== 200) { result.stream.destroy(); throw fail('Source returned HTTP ' + result.status, 502); }
    const text = (await readBody(result)).toString('utf8');
    if (/cf-chl-|Just a moment\.\.\.|验证后继续|人机验证|验证码验证/.test(text)) throw fail('Source requires manual verification; this POC cannot use it.', 502);
    return text;
  }
  async function searchProvider(rule, query) {
    let matches;
    if (rule.searchMode === 'api') {
      const config = rule.searchApiConfig;
      const data = JSON.parse(await fetchRule(rule, templateRequest(config.request, { keyword: query })));
      matches = jsonPath(data, config.listPath).map(node => ({ title: String(jsonPath(node, config.namePath)[0] || ''),
        source: String(jsonPath(node, config.sourcePath)[0] ?? '') }));
    } else {
      const html = await fetchRule(rule, { url: rule.searchURL.replace(/@keyword/g, encodeURIComponent(query)), method: rule.usePost ? 'POST' : 'GET' });
      const dom = new JSDOM(html), doc = dom.window.document;
      try {
        matches = xpath(doc, rule.searchList).slice(0, 80).map(node => ({
          title: xpath(doc, rule.searchName, node)[0]?.textContent.trim() || '',
          source: xpath(doc, rule.searchResult, node)[0]?.getAttribute('href') || ''
        })).filter(item => item.source).map(item => ({ ...item, source: new URL(item.source, rule.baseURL).href }));
      } finally { dom.window.close(); }
    }
    return matches.filter(item => item.title && item.source).slice(0, 80).map(item => ({
      id: remember({ type: 'show', rule, ...item }), title: item.title, provider: rule.id
    }));
  }
  async function resolveSelection(episode) {
    const media = await resolver.resolve(episode);
    const streamId = 'anime-' + remember({ ...media, kind: 'remote', title: episode.title }, streams);
    return { item: { id: streamId, title: episode.title, kind: 'remote', format: media.format,
      description: 'Kazumi-compatible rule · original stream via Mac',
      streamPath: '/stream/' + streamId + (media.format === 'hls' ? '/index.m3u8' : ''), subtitlePath: null } };
  }
  return {
    // Private server-only snapshot: a queued episode need not depend on a search ID's six-hour TTL.
    selection(id) { return { ...lookup(id, 'episode') }; },
    resolveSelection,
    async providers() { return (await loaded).map(({ id, name }) => ({ id, name })); },
    async search(query, provider = 'all') {
      query = String(query || '').trim();
      if (!query || query.length > 100) throw fail('Enter an anime title (up to 100 characters).');
      const selected = (await loaded).filter(rule => provider === 'all' || rule.id === provider);
      if (!selected.length) throw fail('Unknown provider');
      if (searching >= 2) throw fail('Search is busy. Try again shortly.', 429);
      searching++;
      try {
        const results = await Promise.all(selected.map(async rule => {
          try { return { provider: rule.id, items: await searchProvider(rule, query) }; }
          catch (error) {
            const message = /EPROTO|SSL|TLS/.test(error.message) ? 'Source TLS connection failed.' :
              /ENOTFOUND|EAI_AGAIN/.test(error.message) ? 'Source hostname is unavailable.' :
              /aborted|timeout|timed out/i.test(error.message) ? 'Source timed out.' : error.message;
            return { provider: rule.id, items: [], error: message };
          }
        }));
        return { query, items: results.flatMap(result => result.items),
          providers: results.map(({ provider, items, error }) => ({ provider, count: items.length, error })) };
      } finally { searching--; }
    },
    async show(id) {
      const record = lookup(id, 'show');
      if (record.details) return record.details;
      const { rule, source, title } = record;
      let roads;
      if (rule.chapterMode === 'api') {
        const config = rule.chapterApiConfig;
        if (config.format !== 'nested') throw fail('This API chapter format is not supported yet.', 502);
        const data = JSON.parse(await fetchRule(rule, templateRequest(config.request, { source })));
        roads = jsonPath(data, config.roadsPath).map((node, index) => ({
          name: config.roadNamePath ? String(jsonPath(node, config.roadNamePath)[0] || 'Source ' + (index + 1)) : 'Source ' + (index + 1),
          episodes: jsonPath(node, config.episodesPath).map(episode => ({
            name: String(jsonPath(episode, config.episodeNamePath)[0] || ''),
            url: templateRequest(config.episodePage, { source, episodeUrl: jsonPath(episode, config.episodeUrlPath)[0] }).url
          }))
        }));
      } else {
        const dom = new JSDOM(await fetchRule(rule, { url: source })), doc = dom.window.document;
        try {
          roads = xpath(doc, rule.chapterRoads).slice(0, 20).map((node, index) => ({ name: 'Source ' + (index + 1),
            episodes: xpath(doc, rule.chapterResult, node).slice(0, 500).map(link => ({
              name: link.textContent.replace(/\s+/g, ''), url: link.getAttribute('href')
            })).filter(item => item.url && item.name).map(item => ({ ...item, url: new URL(item.url, rule.baseURL).href })) }));
        } finally { dom.window.close(); }
      }
      const details = { id, title, provider: rule.id, roads: roads.filter(road => road.episodes.length).map(road => ({
        name: road.name, episodes: road.episodes.map(episode => ({ id: remember({ type: 'episode', rule, title: title + ' · ' + episode.name,
          url: episode.url }), name: episode.name }))
      })) };
      if (!details.roads.length) throw fail('No episodes found. The source rule may be outdated.', 502);
      record.details = details;
      return details;
    },
    async resolve(id) {
      const episode = lookup(id, 'episode');
      if (pending.has(id)) return pending.get(id);
      const task = resolveSelection(episode);
      pending.set(id, task);
      try { return await task; } finally { pending.delete(id); }
    },
    stream(id) {
      const item = streams.get(id.replace(/^anime-/, ''));
      return item && item.expires > Date.now() ? { ...item, id } : null;
    },
    close() { return resolver.close(); }
  };
}
