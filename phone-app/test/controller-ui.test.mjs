import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createController } from '../../server/lib/controller.mjs';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const code = await readFile(new URL('../app.js', import.meta.url), 'utf8');
function setup(t, online = true, animate = false) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8787/remote/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, requests = [], intervals = [], danmakuCalls = [];
  window.setInterval = callback => intervals.push(callback);
  const discovery = { selection: id => ({ title: '葬送的芙莉莲 · ' + id }),
    async resolveSelection(episode) { return { item: { title: episode.title, streamPath: '/stream/test' } }; } };
  const controller = createController({ discovery });
  if (online) controller.register({ clientId: 'phone-test-tv', version: '0.3.0' });
  window.AbortController = AbortController;
  window.HTMLMediaElement.prototype.play = async function () { this.dataset.played = 'yes'; };
  window.HTMLMediaElement.prototype.pause = function () { this.dataset.paused = 'yes'; };
  window.HTMLMediaElement.prototype.load = function () {};
  if (animate) window.BangumiDanmaku = function () {
    this.tick = (...args) => danmakuCalls.push(['tick', ...args]);
    this.clear = () => danmakuCalls.push(['clear']); this.configure = () => {}; this.setData = () => {};
  };
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
  return { window, $, controller, requests, danmakuCalls, settle, episodes,
    poll: async () => { for (const callback of intervals) await callback(); await settle(); } };
}

async function playingTV(app, patch = {}) {
  const { session } = app.controller.register({ clientId: 'phone-test-tv', version: '0.6.2' });
  const sample = { status: 'playing', title: 'Test episode', position: 10000, duration: 600000, ...patch };
  const report = (value = {}) => app.controller.poll(session, { ...sample, ...value });
  report(); await app.poll();
  return report;
}

test('phone slider previews during dragging without requests or polling snapback, then seeks exactly once on release', async t => {
  const app = setup(t); await app.settle(); const report = await playingTV(app);
  const slider = app.$('seek-position');
  assert.equal(slider.disabled, false); assert.equal(slider.value, '10000');
  slider.onpointerdown(); slider.value = '90000'; slider.oninput();
  assert.match(app.$('playback-time').textContent, /1:30 \/ 10:00/);
  assert.match(app.$('seek-hint').textContent, /松手/);
  const seekRequests = () => app.requests.filter(request => request.path === '/api/controller/action' && JSON.parse(request.options.body).action === 'seek');
  assert.equal(seekRequests().length, 0);
  report({ position: 12000 }); await app.poll(); assert.equal(slider.value, '90000');
  await slider.onchange(); assert.equal(seekRequests().length, 1);
  const input = JSON.parse(seekRequests()[0].options.body);
  assert.equal(input.positionMs, 90000); assert.ok(input.seekContext); assert.equal(input.seconds, undefined);
  assert.equal(slider.disabled, true); assert.equal(slider.value, '90000');
  await slider.onchange(); assert.equal(seekRequests().length, 1);
  const command = report({ position: 13000 }).commands[0];
  assert.equal(command.action, 'seek'); assert.equal(command.seconds, 77);
  report({ applied: command.seq, position: 89500, seek: { state: 'done', from: 13000, target: 90000, actual: 89500 } });
  await app.poll(); assert.equal(slider.disabled, false); assert.equal(slider.value, '89500');
});

test('slider can seek backwards while paused and cancel gestures without sending commands', async t => {
  const app = setup(t); await app.settle(); await playingTV(app, { status: 'paused', position: 100000 });
  const slider = app.$('seek-position');
  slider.value = '30000'; slider.oninput(); slider.onpointercancel(); await slider.onchange();
  assert.equal(slider.value, '100000');
  slider.onpointerdown(); slider.onpointerup();
  slider.value = '40000'; slider.oninput();
  slider.onkeydown({ key: 'Escape', preventDefault() {} }); await slider.onchange();
  assert.equal(app.requests.filter(request => request.path === '/api/controller/action').length, 0);
  slider.value = '20000'; slider.oninput(); await slider.onchange();
  const request = app.requests.find(request => request.path === '/api/controller/action');
  assert.equal(JSON.parse(request.options.body).positionMs, 20000);
  assert.equal(app.controller.state().tv.status, 'paused');
});

test('offline, unavailable durations, and loading or in-progress seeks disable the slider', async t => {
  const app = setup(t, false); await app.settle(); assert.equal(app.$('seek-position').disabled, true);
  const report = await playingTV(app);
  for (const patch of [{ duration: 0 }, { status: 'loading' }, { seek: { state: 'seeking' } }]) {
    report(patch); await app.poll(); assert.equal(app.$('seek-position').disabled, true);
  }
  report(); await app.poll(); assert.equal(app.$('seek-position').disabled, false);
  app.window.fetch = async () => { throw new Error('Mac disconnected'); };
  await app.poll(); assert.equal(app.$('seek-position').disabled, true);
});

test('changing episodes during a gesture cancels the old target and cannot seek the new episode', async t => {
  const app = setup(t); await app.settle(); const report = await playingTV(app);
  const slider = app.$('seek-position'); slider.value = '90000'; slider.oninput();
  report({ title: 'Next episode', position: 0 }); await app.poll(); await slider.onchange();
  assert.equal(app.requests.filter(request => request.path === '/api/controller/action').length, 0);
  assert.equal(slider.value, '0');
});

test('slider reports server and TV seek failures, releases pending state and allows retry', async t => {
  const app = setup(t); await app.settle(); const report = await playingTV(app);
  const slider = app.$('seek-position'), original = app.window.fetch;
  app.window.fetch = async (url, options) => url === '/api/controller/action' ?
    { ok: false, json: async () => ({ error: 'Seek request rejected' }) } : original(url, options);
  slider.value = '90000'; slider.oninput(); await slider.onchange();
  assert.match(app.$('notice').textContent, /Seek request rejected/); assert.equal(slider.disabled, false);
  assert.equal(slider.value, '10000');
  app.window.fetch = original;
  slider.value = '90000'; slider.oninput(); await slider.onchange();
  const command = report().commands[0];
  report({ applied: command.seq, seek: { state: 'error', target: 90000, from: 10000, actual: 10000, error: 'TV seek failed' } });
  await app.poll(); assert.equal(slider.disabled, false); assert.match(app.$('notice').textContent, /TV seek failed/);
});

test('late seek responses cannot restore a previous episode and long durations have accessible hour labels', async t => {
  const app = setup(t); await app.settle(); const report = await playingTV(app, { duration: 7200000, position: 3600000 });
  const slider = app.$('seek-position'), original = app.window.fetch; let finish;
  assert.equal(slider.getAttribute('aria-valuetext'), '1:00:00 / 2:00:00');
  app.window.fetch = (url, options) => url === '/api/controller/action' ? new Promise(resolve => { finish = resolve; }) : original(url, options);
  slider.value = '5000000'; slider.oninput(); const waiting = slider.onchange();
  const old = app.controller.state();
  report({ title: 'Next episode', position: 0 }); await app.poll();
  finish({ ok: true, json: async () => old }); await waiting;
  assert.equal(app.$('now-title').textContent, 'Next episode'); assert.equal(slider.value, '0');
});

test('an unconfirmed slider seek times out visibly and unlocks retry without reissuing a request', async t => {
  const app = setup(t); await app.settle(); await playingTV(app);
  const slider = app.$('seek-position'); slider.value = '90000'; slider.oninput(); await slider.onchange();
  assert.equal(slider.disabled, true);
  const now = app.window.Date.now(); app.window.Date.now = () => now + 21000;
  await app.poll();
  assert.equal(slider.disabled, false); assert.match(app.$('notice').textContent, /尚未确认跳转/);
  assert.equal(slider.value, '10000');
  assert.equal(app.requests.filter(request => request.path === '/api/controller/action').length, 1);
});

test('phone animation clock freezes on waiting, resynchronizes seek and stops in remote mode', async t => {
  const app = setup(t, true, true); await app.episodes(); app.$('mode-player').click();
  await app.$('episodes').children[0].querySelector('button').onclick();
  const video = app.$('phone-video');
  Object.defineProperty(app.window.document, 'hidden', { get: () => false });
  Object.defineProperty(video, 'paused', { get: () => false });
  Object.defineProperty(video, 'readyState', { get: () => 4 });
  video.onplaying();
  assert.equal(app.danmakuCalls.at(-1)[2], false);
  video.dispatchEvent(new app.window.Event('waiting')); assert.equal(app.danmakuCalls.at(-1)[2], true);
  video.onplaying(); assert.equal(app.danmakuCalls.at(-1)[2], false);
  video.dispatchEvent(new app.window.Event('seeking'));
  assert.equal(app.danmakuCalls.at(-1)[2], true); assert.equal(app.danmakuCalls.at(-1)[3], true);
  video.dispatchEvent(new app.window.Event('seeked'));
  assert.equal(app.danmakuCalls.at(-1)[2], false); assert.equal(app.danmakuCalls.at(-1)[3], true);
  app.$('mode-remote').click(); assert.equal(app.danmakuCalls.at(-1)[2], true);
  app.$('phone-stop').click(); assert.equal(app.danmakuCalls.at(-1)[0], 'clear');
});

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
