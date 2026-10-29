import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createController } from '../../server/lib/controller.mjs';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const code = await readFile(new URL('../app.js', import.meta.url), 'utf8');
function setup(t, online = true) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8787/remote/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, requests = [], intervals = [];
  window.setInterval = callback => intervals.push(callback);
  const discovery = { selection: id => ({ title: '葬送的芙莉莲 · ' + id }),
    async resolveSelection(episode) { return { item: { title: episode.title, streamPath: '/stream/test' } }; } };
  const controller = createController({ discovery });
  if (online) controller.register({ clientId: 'phone-test-tv', version: '0.3.0' });
  window.AbortController = AbortController;
  window.HTMLMediaElement.prototype.play = async function () { this.dataset.played = 'yes'; };
  window.HTMLMediaElement.prototype.pause = function () { this.dataset.paused = 'yes'; };
  window.HTMLMediaElement.prototype.load = function () {};
  window.fetch = async (path, options = {}) => {
    requests.push({ path, options }); let result, status = 200;
    try {
      result = path === '/api/controller/state' ? controller.state() :
        path === '/api/controller/action' ? controller.mutate(JSON.parse(options.body)) :
        path === '/api/providers' ? { providers: [{ id: 'moonci', name: 'moonci' }] } :
        path === '/api/recent' || path === '/api/controller/recent' ? { items: [{ title: 'Lycoris Recoil', episode: '第01集', provider: 'AGE' }] } :
        path.startsWith('/api/resolve/') ? { item: { id: 'anime-' + 'd'.repeat(32), title: 'Frieren', format: 'mp4', streamPath: '/stream/anime-phone' } } :
        path.startsWith('/api/search?') ? { items: [{ id: 'show1', title: '葬送的芙莉莲', provider: 'moonci' }], providers: [{ provider: 'moonci', count: 1 }] } :
        { roads: [{ name: 'Source 1', episodes: [{ id: 'ep1', name: '第01话' }, { id: 'ep2', name: '第02话' }] }] };
    } catch (error) { result = { error: error.message }; status = error.status || 500; }
    return { ok: status === 200, status, json: async () => result };
  };
  window.eval(code);
  const $ = id => window.document.getElementById(id);
  const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  async function episodes() {
    await settle(); await $('search-form').onsubmit({ preventDefault() {} });
    await $('results').querySelector('button').onclick();
  }
  return { window, $, controller, requests, settle, episodes,
    poll: async () => { for (const callback of intervals) await callback(); await settle(); } };
}

test('phone remote shows automatic TV status outside settings and retry uses the active TV stream', async t => {
  const app = setup(t); await app.settle();
  const original = app.window.fetch, id = 'anime-' + 'e'.repeat(32);
  app.window.fetch = async (url, options = {}) => {
    if (url === '/api/controller/state') return { ok: true, json: async () => ({
      tvOnline: true, revision: 999, phase: 'playing', queue: [], media: { id }, tv: { title: '命运石之门 · 第3集', status: 'playing' },
      danmaku: { state: 'loaded', message: '已自动加载 2000 条弹幕' }
    }) };
    if (url === '/api/controller/danmaku' && options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body), { action: 'auto-retry', streamId: id, client: 'tv' });
      return { ok: true, json: async () => ({ state: 'acquiring', message: '正在重新获取弹幕' }) };
    }
    return original(url, options);
  };
  await app.poll();
  assert.match(app.$('tv-danmaku-state').textContent, /2000/);
  await app.$('danmaku-retry').onclick();
  assert.match(app.$('tv-danmaku-state').textContent, /重新获取/);
  assert.equal(app.$('danmaku-panel').open, false);
});

test('danmaku selects the full episode list rather than trusting truncated search episodes', async t => {
  const app = setup(t); await app.episodes(); app.$('mode-player').click();
  await app.$('episodes').children[0].querySelector('button').onclick();
  const original = app.window.fetch, calls = [];
  app.window.fetch = async (path, options = {}) => {
    if (!path.startsWith('/api/controller/danmaku')) return original(path, options);
    calls.push({ path, options });
    const data = path.includes('/search?') ? { animes: [{ animeId: 123, animeTitle: '<b>芙莉莲</b>', episodes: [{ episodeId: 1 }] }] }
      : path.includes('/episodes?') ? { bangumi: { episodes: [{ episodeId: 1230009, episodeTitle: '第9话' }] } }
        : { count: 42 };
    return { ok: true, json: async () => data };
  };
  app.$('danmaku-query').value = '芙莉莲';
  await app.$('danmaku-search').onclick();
  assert.equal(app.$('danmaku-matches').children.length, 1);
  assert.equal(app.$('danmaku-matches').querySelector('b'), null);
  await app.$('danmaku-matches').querySelector('button').onclick();
  assert.match(app.$('danmaku-matches').textContent, /第9话/);
  await app.$('danmaku-matches').querySelector('button').onclick();
  const attached = JSON.parse(calls.at(-1).options.body);
  assert.equal(attached.action, 'attach');
  assert.equal(attached.episodeId, 1230009);
  assert.equal(attached.streamId, 'anime-' + 'd'.repeat(32));
  assert.match(app.$('notice').textContent, /42 online comments/);
});

test('phone can attach an official Mac Kazumi cache without enabling online search or uploading files', async t => {
  const app = setup(t); await app.episodes(); app.$('mode-player').click();
  await app.$('episodes').children[0].querySelector('button').onclick();
  const original = app.window.fetch, calls = [];
  app.window.fetch = async (path, options = {}) => {
    if (!path.startsWith('/api/controller/danmaku')) return original(path, options);
    calls.push({ path, options });
    return { ok: true, json: async () => path.endsWith('kazumi-cache') ? {
      message: '请选择已缓存的集数', items: [{ id: 'a'.repeat(32), title: '<b>芙莉莲</b>', provider: 'AGE', episode: 1 }]
    } : { count: 2172 } };
  };
  await app.$('kazumi-cache-refresh').onclick();
  assert.equal(app.$('kazumi-cache-list').querySelector('b'), null);
  await app.$('kazumi-cache-list').querySelector('button').onclick();
  assert.equal(JSON.parse(calls.at(-1).options.body).action, 'kazumi-cache');
  assert.match(app.$('notice').textContent, /2172/);
});

test('phone defaults to remote mode without loading video and can search and queue', async t => {
  const app = setup(t); await app.episodes();
  assert.equal(app.$('phone-video').getAttribute('src'), null);
  assert.equal(app.$('phone-player-panel').hidden, true);
  assert.equal(app.window.document.querySelector('#pair-form'), null);
  assert.equal(app.$('connection').textContent, 'TV online');
  assert.equal(app.$('episodes').children.length, 2);
  await app.$('episodes').children[0].querySelectorAll('button')[1].onclick();
  assert.equal(app.controller.state().queue.length, 1); assert.equal(app.$('queue-count').textContent, '1');
  app.$('queue-tab').click(); assert.equal(app.$('queue-panel').hidden, false);
  await app.$('queue').querySelectorAll('button')[2].onclick(); assert.equal(app.controller.state().queue.length, 0);
  assert.ok(!app.requests.some(request => request.options.headers.Authorization));
});

test('recent anime performs a fresh all-source search without playing or queueing anything', async t => {
  const app = setup(t); await app.episodes();
  assert.equal(app.$('search-form').hidden, true);
  assert.equal(app.$('recent-list').children.length, 1);
  await app.$('recent-list').querySelector('button').onclick();
  assert.equal(app.$('query').value, 'Lycoris Recoil'); assert.equal(app.$('provider').value, 'all');
  assert.equal(app.$('search-form').hidden, false); assert.equal(app.$('episodes-panel').hidden, true);
  const searches = app.requests.filter(request => request.path.startsWith('/api/search?'));
  assert.match(searches.at(-1).path, /q=Lycoris%20Recoil&provider=all/);
  assert.ok(!app.requests.some(request => request.path === '/api/controller/action'));
});

test('phone adds recent history after the playing event, once per playback', async t => {
  const app = setup(t); await app.episodes(); app.$('mode-player').click();
  await app.$('episodes').children[0].querySelector('button').onclick();
  assert.equal(app.requests.filter(request => request.path === '/api/controller/recent').length, 0);
  app.$('phone-video').onplaying(); app.$('phone-video').onplaying(); await app.settle();
  assert.equal(app.requests.filter(request => request.path === '/api/controller/recent').length, 1);
});

test('phone player resolves locally without TV commands, and switching to remote pauses phone video', async t => {
  const app = setup(t, false); await app.episodes();
  app.$('mode-player').click();
  await app.$('episodes').children[0].querySelector('button').onclick();
  assert.equal(app.$('phone-player-panel').hidden, false);
  assert.equal(app.$('phone-video').getAttribute('src'), '/stream/anime-phone');
  assert.equal(app.$('phone-video').dataset.played, 'yes');
  assert.ok(!app.requests.some(request => request.path === '/api/controller/action'));
  app.$('mode-remote').click();
  assert.equal(app.$('phone-video').dataset.paused, 'yes');
  assert.equal(app.$('phone-player-panel').hidden, true);
});

test('Play on TV dispatches an episode ID to the Mac; the phone never fetches a stream', async t => {
  const app = setup(t); await app.episodes();
  await app.$('episodes').children[0].querySelector('button').onclick();
  await app.controller.settled();
  assert.match(app.$('now-status').textContent, /Finding/);
  assert.ok(app.requests.some(request => request.options.body && JSON.parse(request.options.body).episodeId === 'ep1'));
  assert.ok(!app.requests.some(request => request.path.startsWith('/stream/')));
});

test('leaving player mode during resolution prevents late phone autoplay', async t => {
  const app = setup(t, false); await app.episodes(); app.$('mode-player').click();
  const original = app.window.fetch; let finish;
  app.window.fetch = (url, options) => url.startsWith('/api/resolve/') ? new Promise(resolve => { finish = resolve; }) : original(url, options);
  const waiting = app.$('episodes').children[0].querySelector('button').onclick();
  app.$('mode-remote').click();
  finish({ ok: true, json: async () => ({ item: { title: 'Late', format: 'mp4', streamPath: '/stream/late' } }) });
  await waiting;
  assert.equal(app.$('phone-video').getAttribute('src'), null);
  assert.equal(app.$('phone-player-panel').hidden, true);
});

test('offline TV allows search/queue but reports a Play error and disables transport controls', async t => {
  const app = setup(t, false); await app.episodes();
  assert.equal(app.$('connection').textContent, 'TV offline'); assert.equal(app.$('toggle-play').disabled, true);
  await app.$('queue-all').onclick(); assert.equal(app.controller.state().queue.length, 2);
  await app.$('episodes').children[0].querySelector('button').onclick(); assert.match(app.$('notice').textContent, /offline/);
});

test('TV preparation status hides an old seek error and locks transport until the new video is ready', async t => {
  const app = setup(t); await app.settle();
  const value = { ...app.controller.state(), revision: 100, phase: 'preparing',
    tv: { status: 'playing', position: 1000, duration: 60000, seek: { state: 'error', error: 'Old seek failure' } } };
  app.window.fetch = async () => ({ ok: true, json: async () => value });
  await app.$('stop').onclick();
  assert.match(app.$('now-status').textContent, /Preparing original-quality/);
  assert.equal(app.$('seek-forward').disabled, true);
  value.revision++; value.phase = 'playing';
  await app.$('stop').onclick();
  assert.equal(app.$('now-status').textContent, 'Old seek failure');
  assert.equal(app.$('seek-forward').disabled, false);
});
