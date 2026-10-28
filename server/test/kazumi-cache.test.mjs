import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createKazumiCache } from '../lib/kazumi-cache.mjs';
import { createDanmaku } from '../lib/danmaku.mjs';
import { createApp } from '../app.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'bangumi-kazumi-cache-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'downloads/10380_AGE/1');
  await mkdir(directory, { recursive: true });
  const content = JSON.stringify({ danDanBangumiID: 123, danmakus: [{ m: '<b>hello</b>', p: '1,1,16777215,u' }] });
  await writeFile(path.join(directory, 'danmaku.json'), content);
  const upstream = async url => {
    assert.equal(url, 'https://api.bgm.tv/v0/subjects/10380');
    return { status: 200, headers: {}, stream: Readable.from([Buffer.from(JSON.stringify({ name_cn: '命运石之门' }))]) };
  };
  return { root, directory, content, cache: createKazumiCache({ root: path.join(root, 'downloads'), upstream }) };
}

test('official cache reads comment files without API keys, private paths or credentials', async t => {
  const { cache, content } = await fixture(t);
  const list = await cache.list();
  assert.equal(list.items[0].title, '命运石之门');
  assert.equal(list.items[0].episode, 1);
  assert.equal(list.items[0].provider, 'AGE');
  assert.doesNotMatch(JSON.stringify(list), /downloads\/|Application Support|danDanBangumiID|danmakus/);
  assert.equal((await cache.read(list.items[0].id)).content, content);
  await assert.rejects(cache.read('../../private'), /Invalid Kazumi/);
});

test('symlink escapes, oversized caches and deleted selections cannot expose local files', async t => {
  const { cache, root, directory } = await fixture(t);
  const id = (await cache.list()).items[0].id;
  await rm(path.join(directory, 'danmaku.json'));
  await writeFile(path.join(root, 'private.json'), 'private fixture data');
  await symlink(path.join(root, 'private.json'), path.join(directory, 'danmaku.json'));
  assert.equal((await cache.list()).items.length, 0);
  await assert.rejects(cache.read(id), /expired/);
  await rm(path.join(directory, 'danmaku.json'));
  await writeFile(path.join(directory, 'danmaku.json'), Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.equal((await cache.list()).items.length, 0);
  const missing = await createKazumiCache({ root: path.join(root, 'missing') }).list();
  assert.equal(missing.available, false);
  assert.deepEqual(missing.items, []);
});

test('public metadata failure does not prevent forwarding the local official cache', async t => {
  const { root, content } = await fixture(t);
  const cache = createKazumiCache({ root: path.join(root, 'downloads'),
    upstream: async () => { throw new Error('Metadata offline'); } });
  const list = await cache.list();
  assert.equal(list.items[0].title, 'Bangumi #10380');
  assert.equal((await cache.read(list.items[0].id)).content, content);
});

test('phone attaches a Mac cache to a known stream and TV gets comments through its existing endpoint', async t => {
  const { cache } = await fixture(t);
  const id = 'anime-' + 'c'.repeat(32);
  const danmaku = createDanmaku({ appId: '', appSecret: '' });
  const discovery = { stream: value => value === id ? {} : null, close: async () => {} };
  const server = createApp({ discovery, danmaku, kazumiCache: cache });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const list = await (await fetch(base + '/api/controller/danmaku/kazumi-cache')).json();
  const post = (streamId, headers = {}) => fetch(base + '/api/controller/danmaku', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ action: 'kazumi-cache', streamId, cacheId: list.items[0].id })
  });
  assert.equal((await post('not-a-stream')).status, 404);
  assert.equal((await post(id, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await post(id)).status, 200);
  const result = await (await fetch(base + '/api/danmaku/' + id)).json();
  assert.equal(result.configured, false); // No online API credentials were necessary.
  assert.equal(result.comments[0].text, '<b>hello</b>');
  assert.match(result.source, /Kazumi 官方缓存/);
});
