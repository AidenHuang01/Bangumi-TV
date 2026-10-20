import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRecentHistory } from '../lib/recent-history.mjs';
import { createController } from '../lib/controller.mjs';
import { createApp } from '../app.mjs';

test('recent history persists the latest ten distinct anime and moves a rewatched title to the front', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bangumi-recent-test-'));
  const file = path.join(directory, 'recent.json');
  let time = 1000;
  const history = createRecentHistory({ file, now: () => time++ });
  await Promise.all(Array.from({ length: 12 }, (_, i) => history.record({ animeTitle: 'Anime ' + i,
    episodeName: '第01集', provider: 'AGE', url: 'https://private.example/', cookie: 'secret' })));
  assert.equal((await history.list()).length, 10);
  assert.deepEqual((await history.list()).map(row => row.title), Array.from({ length: 10 }, (_, i) => 'Anime ' + (11 - i)));
  await history.record({ animeTitle: 'anime 5', episodeName: '第08集', provider: 'another' });
  const rows = await createRecentHistory({ file }).list();
  assert.equal(rows.length, 10); assert.equal(rows[0].title, 'anime 5'); assert.equal(rows[0].episode, '第08集');
  assert.equal(rows[0].provider, 'another'); assert.equal(rows.filter(row => /anime 5/i.test(row.title)).length, 1);
  assert.ok(!(await readFile(file, 'utf8')).includes('private.example'));
  assert.ok(!(await readFile(file, 'utf8')).includes('secret'));
  assert.deepEqual(await readdir(directory), ['recent.json']);
});

test('TV history records confirmed playback once, not loading or failed preparations', async () => {
  const history = createRecentHistory({ file: null });
  const mediaId = 'anime-' + 'a'.repeat(32);
  let recorded = 0;
  const controller = createController({ discovery: { stream: id => id === mediaId ? {
    animeTitle: 'A title · with separator', episodeName: '第08集', title: 'A title · with separator · 第08集'
  } : null }, onPlayback: async item => { recorded++; await history.record(item); } });
  const { session } = controller.register({ clientId: 'history-tv' });
  controller.poll(session, { status: 'loading', mediaId });
  controller.poll(session, { status: 'error', mediaId });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await history.list(), []);
  controller.poll(session, { status: 'playing', mediaId });
  controller.poll(session, { status: 'paused', mediaId });
  controller.poll(session, { status: 'playing', mediaId });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recorded, 1);
  assert.equal((await history.list())[0].title, 'A title · with separator');
  assert.equal((await history.list())[0].episode, '第08集');
});

test('phone playback history accepts only server-known streams and protects the write origin', async t => {
  const id = 'anime-' + 'b'.repeat(32);
  const history = createRecentHistory({ file: null });
  const server = createApp({ recentHistory: history, discovery: { close: async () => {},
    stream: value => value === id ? { title: 'Lycoris Recoil · 第01集', provider: 'AGE' } : null } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (body, headers = {}) => fetch(base + '/api/controller/recent', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ streamId: 'not-a-stream', title: 'Forged title' })).status, 404);
  assert.equal((await post({ streamId: id }, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await post({ streamId: id, title: 'Forged title' })).status, 200);
  const rows = (await (await fetch(base + '/api/recent')).json()).items;
  assert.equal(rows.length, 1); assert.equal(rows[0].title, 'Lycoris Recoil'); assert.equal(rows[0].episode, '第01集');
});
