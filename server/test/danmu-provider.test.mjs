import test from 'node:test';
import assert from 'node:assert/strict';
import { createDanmuProvider, matchDanmuAnime, matchDanmuEpisode } from '../lib/danmu-provider.mjs';
import { createAutoDanmaku } from '../lib/auto-danmaku.mjs';
import { createDanmaku } from '../lib/danmaku.mjs';
import { createController } from '../lib/controller.mjs';
import { createApp } from '../app.mjs';

const data = { comments: [{ m: 'hello', p: '1,1,16777215,u' }] };
const anime = { animeId: 123, animeTitle: '葬送的芙莉莲(2023)【动漫】from bahamut', source: 'bahamut' };
const ids = ['anime-' + 'a'.repeat(32), 'anime-' + 'b'.repeat(32)];
function fixture(options = {}) {
  const calls = [];
  const { fetcher: _fetcher, ...providerOptions } = options;
  const provider = createDanmuProvider({ url: 'http://127.0.0.1:9321', token: 'private-token',
    fetcher: async (url, init) => {
      const value = new URL(url); calls.push({ url: value, init });
      if (options.fetcher) return options.fetcher(value, init);
      return Response.json(value.pathname.includes('/search/') ? { animes: [{ ...anime, animeId: 124, animeTitle: '葬送的芙莉莲 第二季(2026)【动漫】from bahamut' }, anime] } :
        value.pathname.includes('/bangumi/') ? { bangumi: { episodes: [{ episodeId: 8, episodeTitle: '【bahamut】 第8集', episodeNumber: '8' }] } } : data);
    }, ...providerOptions });
  return { provider, calls };
}

test('exact title matching removes only known metadata suffixes and never substitutes a sequel', () => {
  assert.equal(matchDanmuAnime(anime, '葬送的芙莉莲'), true);
  assert.equal(matchDanmuAnime({ ...anime, animeTitle: '葬送的芙莉莲 第二季(2026)【动漫】from bahamut' }, '葬送的芙莉莲'), false);
  assert.equal(matchDanmuEpisode([{ episodeId: 1, episodeTitle: 'SP 第8集', episodeNumber: '8' }], 8), null);
  assert.equal(matchDanmuEpisode([{ episodeId: 1, episodeTitle: '第9集', episodeNumber: '8' }], 8), null);
  assert.equal(matchDanmuEpisode([{ episodeId: 1, episodeTitle: '【bahamut】 第9集', episodeNumber: '8' }], 8), null);
  assert.equal(matchDanmuEpisode([{ episodeId: 1, episodeTitle: '勇者的故事', episodeNumber: '8' }], 8).episodeId, 1);
});

test('headless acquisition fetches search, full episodes and comments; same episode reuses cache across streams', async () => {
  const { provider, calls } = fixture();
  const first = await provider.acquire({ title: '葬送的芙莉莲', episode: 8 });
  assert.equal(JSON.parse(first.content).comments.length, 1);
  assert.match(first.source, /danmu_api · bahamut/);
  assert.ok(calls.some(call => call.url.pathname.endsWith('/bangumi/123')));
  assert.ok(!calls.some(call => call.url.pathname.endsWith('/bangumi/124')));
  assert.ok(calls.every(call => call.url.hostname === '127.0.0.1' && call.init.headers['X-Bangumi-Danmu'] === 'private-token'));
  assert.deepEqual(await provider.acquire({ title: '葬送的芙莉莲', episode: 8 }), first);
  assert.equal(calls.length, 3);
});

test('automatic acquisition prefers aggregated dandan even if sparse sources arrive first', async () => {
  const { provider, calls } = fixture({ fetcher: async url => {
    if (url.pathname.includes('/search/')) return Response.json({ animes: [anime, { ...anime, animeId: 456, source: 'dandan' }] });
    if (url.pathname.includes('/bangumi/')) return Response.json({ bangumi: { episodes: [{ episodeId: 8, episodeTitle: '第8集' }] } });
    return Response.json(data);
  } });
  const result = await provider.acquire({ title: '葬送的芙莉莲', episode: 8 });
  assert.match(result.source, /dandan/);
  assert.ok(calls.some(call => call.url.pathname.endsWith('/bangumi/456')));
  assert.ok(!calls.some(call => call.url.pathname.endsWith('/bangumi/123')));
});

test('phone searches use opaque server-owned selections and cannot choose arbitrary URLs or unknown IDs', async () => {
  const { provider } = fixture();
  const results = await provider.search('葬送的芙莉莲');
  const selected = results.animes[1];
  assert.match(selected.animeId, /^mu-[a-f0-9]{32}$/);
  const detail = await provider.episodes(selected.animeId);
  assert.match(detail.bangumi.episodes[0].episodeId, /^mu-/);
  await assert.rejects(provider.comments('https://evil.example'), /过期/);
  const d = createDanmaku({ provider });
  assert.equal(d.status().engine, 'danmu_api'); assert.equal(d.status().configured, true);
  await d.attach(ids[0], detail.bangumi.episodes[0].episodeId);
  assert.equal(d.read(ids[0]).count, 1);
  assert.doesNotMatch(JSON.stringify(d.read(ids[0])), /private-token/);
});

test('automatic direct results reach the TV endpoint data store, no official cache or player required', async t => {
  const { provider } = fixture(), d = createDanmaku({ provider });
  const automatic = createAutoDanmaku({ danmaku: d, cache: { list: async () => ({ items: [] }) }, acquire: provider.acquire, delay: 0 });
  t.after(() => automatic.close());
  automatic.observe({ id: ids[0], animeTitle: '葬送的芙莉莲', episodeName: '第8集' });
  await automatic.settled(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(d.read(ids[0]).count, 1); assert.equal(automatic.status(ids[0]).state, 'loaded');
});

test('late upstream results are discarded after changing episodes', async t => {
  let finish;
  const d = createDanmaku(), automatic = createAutoDanmaku({ danmaku: d,
    cache: { list: async () => ({ items: [] }) }, delay: 0, acquire: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => automatic.close());
  automatic.observe({ id: ids[0], animeTitle: '葬送的芙莉莲', episodeName: '第8集' }); await automatic.settled();
  const old = finish;
  automatic.observe({ id: ids[1], animeTitle: '葬送的芙莉莲', episodeName: '第9集' }); await automatic.settled();
  old({ content: JSON.stringify(data), source: 'old' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(d.read(ids[0]).count, 0); assert.equal(d.read(ids[1]).count, 0);
});

test('errors and oversized responses cannot break video or leak private diagnostics', async () => {
  const { provider } = fixture({ fetcher: async () => new Response('private diagnostic', { status: 403 }) });
  await assert.rejects(provider.acquire({ title: '葬送的芙莉莲', episode: 8 }), error => error.publicMessage.includes('403') && !error.message.includes('private'));
  assert.throws(() => createDanmuProvider({ url: 'https://outside.example' }), /loopback/);
  const large = fixture({ fetcher: async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)) }).provider;
  await assert.rejects(large.acquire({ title: '葬送的芙莉莲', episode: 8 }), /数据过大/);
});

test('authenticated TV playback receives headless comments over the existing HTTP protocol', async t => {
  const { provider, calls } = fixture();
  const stream = { id: ids[0], animeTitle: '葬送的芙莉莲', episodeName: '第8集' };
  const server = createApp({ receiverAddress: '127.0.0.1',
    discovery: { stream: id => id === stream.id ? stream : null, close: async () => {} },
    danmaku: createDanmaku({ provider }), automaticCache: { list: async () => ({ items: [] }) },
    acquireDanmaku: provider.acquire, autoDanmakuOptions: { delay: 0 } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.deepEqual((await (await fetch(base + '/api/health')).json()).danmaku, { engine: 'danmu_api', configured: true });
  const post = (path, body, session) => fetch(base + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'file://', ...(session ? { 'X-Bangumi-TV': session } : {}) },
    body: JSON.stringify(body) });
  await fetch(base + '/api/danmaku/' + stream.id); assert.equal(calls.length, 0);
  assert.equal((await post('/api/tv/poll', { status: 'playing', mediaId: stream.id }, 'invalid')).status, 401);
  assert.equal(calls.length, 0);
  const receiver = await (await post('/api/tv/register', { clientId: 'danmu-http-test', version: '0.5.3' })).json();
  assert.equal((await post('/api/tv/poll', { status: 'playing', mediaId: stream.id }, receiver.session)).status, 200);
  let result;
  for (let n = 0; n < 50; n++) {
    result = await (await fetch(base + '/api/danmaku/' + stream.id)).json();
    if (result.count) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(result.count, 1); assert.equal(result.automatic.state, 'loaded');
  assert.equal(result.comments[0].text, 'hello');
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
});

test('TV selection prefetches comments before video resolution finishes; Stop cancels the selection', async () => {
  const { provider, calls } = fixture();
  let finish, cancelled = false;
  const controller = createController({ discovery: {
    selection: () => ({ title: '葬送的芙莉莲 · 第8集', animeTitle: '葬送的芙莉莲', episodeName: '第8集' }),
    resolveSelection: () => new Promise(resolve => { finish = resolve; })
  }, onSelection: selection => { const stop = provider.prefetch(selection); return () => { cancelled = true; stop?.(); }; } });
  controller.register({ clientId: 'prefetch-tv-test' });
  controller.mutate({ action: 'play', episodeId: 'ep8' });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls.length, 3); assert.equal(controller.state().phase, 'resolving');
  controller.mutate({ action: 'stop' }); assert.equal(cancelled, true);
  finish({ item: { id: ids[0], format: 'hls', streamPath: '/stream/' + ids[0] } });
  await controller.settled(); assert.equal(controller.state().active, null); controller.close();
});

test('prefetch and playback share a request; one cancelled subscriber does not cancel another', async () => {
  let finish;
  const { provider } = fixture({ fetcher: async (url, init) => {
    if (url.pathname.includes('/search/')) return Response.json({ animes: [anime] });
    if (url.pathname.includes('/bangumi/')) return Response.json({ bangumi: { episodes: [{ episodeId: 8, episodeTitle: '第8集', episodeNumber: '8' }] } });
    return new Promise(resolve => { finish = () => resolve(Response.json(data)); });
  } });
  const a = new AbortController(), b = new AbortController();
  const first = provider.acquire({ title: '葬送的芙莉莲', episode: 8, signal: a.signal });
  const second = provider.acquire({ title: '葬送的芙莉莲', episode: 8, signal: b.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  a.abort(); await assert.rejects(first); finish();
  assert.equal(JSON.parse((await second).content).comments.length, 1);
});
