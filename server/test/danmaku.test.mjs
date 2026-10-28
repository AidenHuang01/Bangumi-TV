import test from 'node:test';
import assert from 'node:assert/strict';
import { createDanmaku, parseDanmaku } from '../lib/danmaku.mjs';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createApp } from '../app.mjs';
test('Bilibili XML and Dandan JSON normalize without interpreting comment HTML', () => {
  const xml = '<i><d p="2.5,1,25,16711680">&lt;img src=x&gt;</d><d p="1,5,25,16777215">Hi</d></i>';
  const rows = parseDanmaku(xml);
  assert.equal(rows[0].time, 1); assert.equal(rows[0].mode, 5);
  assert.equal(rows[1].text, '<img src=x>'); assert.equal(rows[1].color, '#ff0000');
  assert.throws(() => parseDanmaku('<!DOCTYPE i><i/>'), /entities/);
  assert.equal(parseDanmaku('{"comments":[{"p":"5,4,16777215,u","m":"hello"}]}')[0].mode, 4);
});

test('official Kazumi download cache wrapper and legacy arrays import without API keys', () => {
  const comments = [{ p: '12.5,5,16711680,[BiliBili]u', m: '<b>芙莉莲</b>' }];
  const wrapper = JSON.stringify({ danDanBangumiID: 123, danmakus: comments });
  assert.deepEqual(parseDanmaku(wrapper), parseDanmaku(JSON.stringify(comments)));
  const d = createDanmaku({ appId: '', appSecret: '' });
  d.import('video', wrapper);
  assert.equal(d.read('video').comments[0].text, '<b>芙莉莲</b>');
  assert.equal(d.read('video').comments[0].color, '#ff0000');
});

test('Kazumi native bridge owns online retrieval; TV receives normalized comments, never credentials', async () => {
  const operations = [];
  const core = {
    danmakuSearch: async anime => { operations.push(['search', anime]); return { animes: [{ animeId: 123, animeTitle: anime }] }; },
    danmakuEpisodes: async id => { operations.push(['episodes', id]); return { bangumi: { episodes: [{ episodeId: 1230001, episodeTitle: '第1话' }] } }; },
    danmakuComments: async id => { operations.push(['comments', id]); return { comments: [{ p: '1,1,16777215,u', m: 'hello' }] }; }
  };
  const d = createDanmaku({ core, coreConfigured: true, appId: 'private-id', appSecret: 'private-secret',
    fetcher: () => { throw new Error('Must not fetch directly from JS'); } });
  assert.equal(d.status().engine, 'kazumi');
  assert.equal(d.status().configured, true);
  assert.equal((await d.search('芙莉莲')).animes.length, 1);
  assert.equal((await d.episodes(123)).bangumi.episodes[0].episodeId, 1230001);
  await d.attach('video', 1230001);
  assert.equal(d.read('video').comments[0].text, 'hello');
  assert.doesNotMatch(JSON.stringify(d.read('video')), /private-id|private-secret/);
  assert.deepEqual(operations, [['search', '芙莉莲'], ['episodes', 123], ['comments', 1230001]]);
  await assert.rejects(d.episodes('../private'), /Invalid anime/);
  await assert.rejects(d.attach('video', '9007199254740992'), /Invalid episode/);
});

test('HTTP phone selection and TV comment delivery share the native Kazumi bridge', async t => {
  const id = 'anime-' + 'a'.repeat(32);
  const danmaku = createDanmaku({ coreConfigured: true, core: {
    danmakuSearch: async () => ({ animes: [{ animeId: 12, animeTitle: '芙莉莲' }] }),
    danmakuEpisodes: async () => ({ bangumi: { episodes: [{ episodeId: 120001, episodeTitle: '第1话' }] } }),
    danmakuComments: async () => ({ comments: [{ p: '1,1,16777215,u', m: 'hello from Kazumi' }] })
  } });
  const discovery = { stream: value => value === id ? {} : null, close: async () => {} };
  const server = createApp({ discovery, danmaku });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const search = await (await fetch(base + '/api/controller/danmaku/search?anime=Frieren')).json();
  assert.equal(search.animes[0].animeId, 12);
  const episodes = await (await fetch(base + '/api/controller/danmaku/episodes?animeId=12')).json();
  assert.equal(episodes.bangumi.episodes[0].episodeId, 120001);
  const attach = await fetch(base + '/api/controller/danmaku', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'attach', streamId: id, episodeId: 120001 }) });
  assert.equal(attach.status, 200);
  const tvData = await (await fetch(base + '/api/danmaku/' + id)).json();
  assert.equal(tvData.engine, 'kazumi');
  assert.equal(tvData.comments[0].text, 'hello from Kazumi');
  assert.equal((await fetch(base + '/api/controller/danmaku/episodes?animeId=12', { headers: { Origin: 'https://other.example' } })).status, 403);
});

test('renderer uses video time, freezes on pause, clears on seek and escapes HTML', async () => {
  const dom = new JSDOM('<div id="layer"></div>', { runScripts: 'outside-only' });
  dom.window.eval(await readFile(new URL('../../tv-app/danmaku.js', import.meta.url), 'utf8'));
  const layer = dom.window.document.getElementById('layer');
  const renderer = new dom.window.BangumiDanmaku(layer);
  renderer.setData([{ time: 1, text: '<img src=x>', mode: 1, color: '#ffffff' }]);
  renderer.tick(1000, false); renderer.tick(1200, false);
  const transform = layer.firstChild.style.transform;
  renderer.tick(1200, true);
  assert.equal(layer.firstChild.style.transform, transform);
  assert.equal(layer.querySelector('img'), null);
  renderer.tick(30000, false); assert.equal(layer.children.length, 0);
  renderer.tick(1000, false); assert.equal(layer.children.length, 1);
  dom.window.close();
});
test('danmaku works without credentials, settings invalidate cache and secrets stay server-side', async () => {
  const d = createDanmaku({ appId: '', appSecret: '' });
  assert.equal(d.status().configured, false);
  await assert.rejects(d.search('Frieren'), /DANDAN_APP_ID/);
  d.import('video', '[{"time":1,"text":"hello"}]');
  const initial = d.read('video'); assert.equal(initial.comments.length, 1);
  assert.equal(d.read('video', initial.version).unchanged, true);
  d.settings({ offset: 2 }); assert.equal(d.read('video', initial.version).offset, 2);
});
