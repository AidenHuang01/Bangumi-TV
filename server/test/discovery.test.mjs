import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { JSDOM } from 'jsdom';
import { createDiscovery, xpath, jsonPath, templateRequest } from '../lib/discovery.mjs';
import { pageCandidates } from '../lib/resolver.mjs';
import { createApp } from '../app.mjs';

const rule = { id: 'fixture', name: 'Fixture', baseURL: 'https://catalog.example/',
  searchURL: 'https://catalog.example/search?q=@keyword', searchList: '//article',
  searchName: '//a', searchResult: '//a', chapterRoads: '//ul', chapterResult: '//li/a' };
const textResponse = (url, text) => ({ url, status: 200, headers: {}, stream: Readable.from([Buffer.from(text)]) });

test('default providers load the verified 7sefun rule without enabling failed akianime', async () => {
  const discovery = createDiscovery();
  try {
    const providers = await discovery.providers();
    assert.ok(providers.some(provider => provider.id === '7sefun' && provider.name === '7sefun'));
    assert.ok(!providers.some(provider => provider.id === 'akianime'));
    assert.equal(new Set(providers.map(provider => provider.id)).size, providers.length);
  } finally { await discovery.close(); }
});

function fixture() {
  const calls = []; let resolutions = 0;
  const upstream = async (url, options) => {
    calls.push({ url, options });
    return textResponse(url, url.includes('/search?') ? '<article><a href="/show/1">葬送的芙莉莲</a></article>' :
      '<ul><li><a href="/play/1">第 01 话</a></li><li><a href="/play/2">第02话</a></li></ul>');
  };
  const discovery = createDiscovery({ rules: [rule], upstream, resolver: {
    async resolve(episode) {
      resolutions++; assert.equal(episode.url, 'https://catalog.example/play/1');
      await new Promise(resolve => setTimeout(resolve, 5));
      return { url: 'https://cdn.example/video.m3u8?secret=token', format: 'hls', cookie: 'private=1' };
    }, async close() {}
  } });
  return { discovery, calls, resolutions: () => resolutions };
}

test('XPath inside a search item is relative, not the first title in the whole document', () => {
  const dom = new JSDOM('<article><a>A</a></article><article><a>B</a></article>');
  const doc = dom.window.document;
  assert.deepEqual(xpath(doc, '//article').map(node => xpath(doc, '//a', node)[0].textContent), ['A', 'B']);
  dom.window.close();
});

test('API rule paths and templates support sorani without executing expressions', () => {
  assert.deepEqual(jsonPath({ data: { records: [{ id: 1 }, { id: 2 }] } }, '$.data.records[*]').map(x => x.id), [1, 2]);
  assert.throws(() => jsonPath({}, '$.data[?(process.exit())]'), /Unsupported/);
  const request = templateRequest({ url: 'https://api.example/@source', query: { keyword: '@keyword' } }, { source: 'a/b', keyword: '葬送的芙莉莲' });
  assert.match(request.url, /a%2Fb/);
  assert.equal(new URL(request.url).searchParams.get('keyword'), '葬送的芙莉莲');
});

test('discovery searches, lists episodes, deduplicates resolve jobs and hides URLs/cookies', async () => {
  const { discovery, calls, resolutions } = fixture();
  const result = await discovery.search('葬送的芙莉莲');
  assert.equal(new URL(calls[0].url).searchParams.get('q'), '葬送的芙莉莲');
  assert.equal(result.items[0].title, '葬送的芙莉莲');
  assert.ok(!JSON.stringify(result).includes('catalog.example'));
  const show = await discovery.show(result.items[0].id);
  assert.equal(show.roads[0].episodes[0].name, '第01话');
  assert.equal(show.roads[0].episodes.length, 2);
  const id = show.roads[0].episodes[0].id;
  const [a, b] = await Promise.all([discovery.resolve(id), discovery.resolve(id)]);
  assert.equal(resolutions(), 1); assert.deepEqual(a, b);
  assert.ok(!JSON.stringify(a).includes('secret')); assert.ok(!JSON.stringify(a).includes('private'));
  assert.equal(discovery.stream(a.item.id).cookie, 'private=1');
  assert.equal(discovery.stream('invented-id'), null);
  await assert.rejects(discovery.show(id), /expired/);
  await assert.rejects(discovery.resolve('https://127.0.0.1/'), /expired/);
});

test('provider errors are reported separately from empty search results', async () => {
  const d = createDiscovery({ rules: [rule], upstream: async () => { throw new Error('Source returned HTTP 403'); } });
  const result = await d.search('Frieren');
  assert.equal(result.items.length, 0); assert.match(result.providers[0].error, /403/);
  await assert.rejects(d.search(''), /Enter/);
  await assert.rejects(d.search('Frieren', 'unknown'), /Unknown/);
  await d.close();
});

test('static resolver parses video, iframe and encoded JSON data without executing scripts', () => {
  const encoded = Buffer.from(encodeURIComponent('https://cdn.example/ep.m3u8')).toString('base64');
  const result = pageCandidates('<script>var player_aaaa=' + JSON.stringify({ url: encoded, encrypt: 2 }) +
    ';</script><iframe src="/embed"></iframe><video src="/ep.mp4"></video><script>throw new Error("never run")</script>', 'https://catalog.example/');
  assert.ok(result.media.includes('https://cdn.example/ep.m3u8'));
  assert.ok(result.media.includes('https://catalog.example/ep.mp4'));
  assert.deepEqual(result.frames, ['https://catalog.example/embed']);
});

test('resolved anime streams use the existing range/HLS proxy and reject arbitrary URL input', async t => {
  const { discovery } = fixture();
  const search = await discovery.search('Frieren'), show = await discovery.show(search.items[0].id);
  const resolved = await discovery.resolve(show.roads[0].episodes[0].id);
  assert.ok(resolved.item.streamPath.endsWith('/index.m3u8'));
  const server = createApp({ discovery, upstream: async url => ({ ...textResponse(url, '#EXTM3U\n#EXTINF:6,\nepisode.ts\n#EXT-X-ENDLIST\n'),
    headers: { 'content-type': 'application/vnd.apple.mpegurl' } }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(base + resolved.item.streamPath);
  assert.equal(response.status, 200);
  const manifest = await response.text();
  assert.match(manifest, /\/stream\/anime-[a-f0-9]+\/ref\//);
  assert.ok(!manifest.includes('cdn.example'));
  assert.equal((await fetch(base + '/api/resolve/' + '0'.repeat(32))).status, 404);
  assert.equal((await fetch(base + '/api/resolve/http%3A%2F%2F127.0.0.1')).status, 404);
});
