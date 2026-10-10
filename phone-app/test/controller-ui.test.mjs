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
  const { window } = dom, requests = [];
  const discovery = { selection: id => ({ title: '葬送的芙莉莲 · ' + id }),
    async resolveSelection(episode) { return { item: { title: episode.title, streamPath: '/stream/test' } }; } };
  const controller = createController({ discovery });
  if (online) controller.register({ clientId: 'phone-test-tv', version: '0.3.0' });
  window.AbortController = AbortController;
  window.fetch = async (path, options = {}) => {
    requests.push({ path, options }); let result, status = 200;
    try {
      result = path === '/api/controller/state' ? controller.state() :
        path === '/api/controller/action' ? controller.mutate(JSON.parse(options.body)) :
        path === '/api/providers' ? { providers: [{ id: 'moonci', name: 'moonci' }] } :
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
  return { window, $, controller, requests, settle, episodes };
}

test('phone connects without pairing, searches and queues episodes without any video element', async t => {
  const app = setup(t); await app.episodes();
  assert.equal(app.window.document.querySelector('video, object'), null);
  assert.equal(app.window.document.querySelector('#pair-form'), null);
  assert.equal(app.$('connection').textContent, 'TV online');
  assert.equal(app.$('episodes').children.length, 2);
  await app.$('episodes').children[0].querySelectorAll('button')[1].onclick();
  assert.equal(app.controller.state().queue.length, 1); assert.equal(app.$('queue-count').textContent, '1');
  app.$('queue-tab').click(); assert.equal(app.$('queue-panel').hidden, false);
  await app.$('queue').querySelectorAll('button')[2].onclick(); assert.equal(app.controller.state().queue.length, 0);
  assert.ok(!app.requests.some(request => request.options.headers.Authorization));
});

test('Play on TV dispatches an episode ID to the Mac; the phone never fetches a stream', async t => {
  const app = setup(t); await app.episodes();
  await app.$('episodes').children[0].querySelector('button').onclick();
  await app.controller.settled();
  assert.match(app.$('now-status').textContent, /Finding/);
  assert.ok(app.requests.some(request => request.options.body && JSON.parse(request.options.body).episodeId === 'ep1'));
  assert.ok(!app.requests.some(request => request.path.startsWith('/stream/')));
});

test('offline TV allows search/queue but reports a Play error and disables transport controls', async t => {
  const app = setup(t, false); await app.episodes();
  assert.equal(app.$('connection').textContent, 'TV offline'); assert.equal(app.$('toggle-play').disabled, true);
  await app.$('queue-all').onclick(); assert.equal(app.controller.state().queue.length, 2);
  await app.$('episodes').children[0].querySelector('button').onclick(); assert.match(app.$('notice').textContent, /offline/);
});
