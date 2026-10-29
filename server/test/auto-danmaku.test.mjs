import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoDanmaku, episodeNumber } from '../lib/auto-danmaku.mjs';
import { createDanmaku } from '../lib/danmaku.mjs';
import { createApp } from '../app.mjs';

const id = 'anime-' + 'a'.repeat(32), other = 'anime-' + 'b'.repeat(32);
const stream = { id, animeTitle: '命运石之门', episodeName: '第02集', provider: 'AGE' };
const content = JSON.stringify({ danmakus: [{ m: 'real comment', p: '1,1,16777215,user' }] });
function fixture(t, options = {}) {
  let time = 10000, items = [], calls = [];
  const danmaku = createDanmaku({ appId: '', appSecret: '' });
  const cache = { list: async () => ({ items }), read: async () => ({ content, source: 'Kazumi 官方缓存' }) };
  const auto = createAutoDanmaku({ cache, danmaku, now: () => time, ...options });
  t.after(() => auto.close());
  return { auto, danmaku, calls, cache, tick: n => time += n, items: value => { items = value; },
    match: { id: 'cache', title: stream.animeTitle, episode: 2, updatedAt: 20 } };
}

test('strict episode parsing rejects specials and ambiguous identifiers', () => {
  for (const text of ['第02话', '第 2 集', '02', 'EP02', 'Episode 2']) assert.equal(episodeNumber(text), 2);
  for (const text of ['SP02', '第2集预告', '2-3', '剧场版', '0', '']) assert.equal(episodeNumber(text), null);
});

test('automatic cache attaches after a delay without API keys and never selects a sequel or wrong episode', async t => {
  const f = fixture(t);
  f.items([{ ...f.match, title: '命运石之门0' }, { ...f.match, episode: 3 }]);
  f.auto.observe(stream); f.tick(1999); f.auto.poll(stream); await f.auto.settled();
  assert.equal(f.danmaku.read(id).count, 0);
  f.tick(1); f.auto.poll(stream); await f.auto.settled();
  assert.equal(f.danmaku.read(id).count, 0);
  f.items([f.match]); f.tick(5000); f.auto.poll(stream); await f.auto.settled();
  assert.equal(f.danmaku.read(id).configured, false);
  assert.equal(f.danmaku.read(id).count, 1);
  assert.equal(f.auto.status(id).state, 'loaded');
});

test('late caches never cross episodes and manual imports win', async t => {
  let finish;
  const f = fixture(t, { delay: 0 }); f.items([f.match]);
  f.cache.read = () => new Promise(resolve => { finish = resolve; });
  f.auto.observe(stream); await Promise.resolve();
  f.auto.observe({ ...stream, id: other, episodeName: '第03集' });
  finish({ content, source: 'late' }); await f.auto.settled(); await Promise.resolve();
  assert.equal(f.danmaku.read(id).count, 0); assert.equal(f.danmaku.read(other).count, 0);
  f.auto.observe(stream); await Promise.resolve();
  f.danmaku.import(id, content, 'manual'); finish({ content, source: 'late' }); await f.auto.settled();
  assert.equal(f.danmaku.read(id).source, 'manual');
});

test('one acquisition is shared; stopping, disabling and expiry cancel desktop work', async t => {
  const requests = [];
  const f = fixture(t, { delay: 0, acquire: input => { requests.push(input); return new Promise(() => {}); } });
  f.auto.observe(stream, 'tv'); await f.auto.settled(); await Promise.resolve();
  f.auto.observe(stream, 'phone'); f.tick(5000); f.auto.poll(stream, 'tv'); await f.auto.settled();
  assert.equal(requests.length, 1);
  f.auto.release('phone', other); assert.equal(requests[0].signal.aborted, false);
  f.auto.release('tv'); assert.equal(requests[0].signal.aborted, false);
  f.auto.release('phone', id); assert.equal(requests[0].signal.aborted, true);
  f.auto.observe(stream); await f.auto.settled(); await Promise.resolve();
  f.danmaku.settings({ enabled: false }); f.auto.cancel();
  assert.equal(requests[1].signal.aborted, true); assert.equal(f.auto.status(id).state, 'disabled');
  f.danmaku.settings({ enabled: true }); f.auto.observe(stream); await f.auto.settled(); await Promise.resolve();
  f.tick(30001); f.auto.observe({ ...stream, id: other });
  assert.equal(requests[2].signal.aborted, true);
});

test('public reads cannot begin acquisition; failures are nonblocking and explicit retry is possible', async t => {
  let acquisitions = 0;
  const f = fixture(t, { delay: 0, acquire: async () => { acquisitions++; throw Object.assign(new Error('private diagnostic'), { publicMessage: '来源暂不可用' }); } });
  f.auto.poll(stream); await f.auto.settled(); assert.equal(acquisitions, 0);
  f.auto.observe(stream); await f.auto.settled(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.auto.status(id).message, '来源暂不可用');
  f.auto.retry(stream, 'tv'); await f.auto.settled(); await Promise.resolve(); assert.equal(acquisitions, 2);
});

test('protected phone playing event activates automation while hostile origin and unknown streams cannot', async t => {
  let acquisitions = 0;
  const server = createApp({ discovery: { stream: key => key === id ? stream : null, close: async () => {} },
    kazumiCache: { list: async () => ({ items: [] }) },
    acquireKazumiDanmaku: async () => { acquisitions++; }, autoDanmakuOptions: { delay: 0 } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (value, origin) => fetch(base + '/api/controller/recent', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ streamId: value }) });
  await fetch(base + '/api/danmaku/' + id); assert.equal(acquisitions, 0);
  assert.equal((await post(id, 'https://hostile.example')).status, 403);
  assert.equal((await post(other)).status, 404); assert.equal(acquisitions, 0);
  assert.equal((await post(id)).status, 200);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(acquisitions, 1);
  const result = await (await fetch(base + '/api/danmaku/' + id + '?client=phone')).json();
  assert.ok(result.automatic.message); assert.doesNotMatch(JSON.stringify(result), /private diagnostic/);
});
