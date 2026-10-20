import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
function setup(t) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8787/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, requests = [], opened = [];
  const id = 'a'.repeat(32), episodeId = 'b'.repeat(32);
  window.HTMLElement.prototype.getClientRects = function () { return this.closest('.hidden') ? [] : [{}]; };
  window.HTMLMediaElement.prototype.pause = function () {};
  window.HTMLMediaElement.prototype.load = function () {};
  window.webapis = { avplay: { close() {}, open(url) { opened.push(url); }, setDisplayRect() {}, setDisplayMethod() {}, setListener() {}, prepareAsync() {} } };
  class XHR {
    open(method, url) { this.url = url; }
    setRequestHeader() {}
    abort() { this.aborted = true; }
    send() {
      requests.push(this);
      if (this.url.includes('/api/resolve/')) return;
      this.respond(this.url.includes('/api/search?') ? { items: [{ id, title: '葬送的芙莉莲', provider: 'moonci' }], providers: [{ provider: 'moonci', count: 1 }] } :
        this.url.includes('/api/shows/') ? { roads: [{ name: 'Source 1', episodes: [{ id: episodeId, name: '第01话' }] }] } :
        this.url.includes('/api/providers') ? { providers: [{ id: 'moonci', name: 'moonci' }] } : { items: [] });
    }
    respond(data, status = 200) { this.status = status; this.responseText = JSON.stringify(data); this.onload(); }
  }
  window.XMLHttpRequest = XHR;
  window.eval(source);
  const $ = id => window.document.getElementById(id);
  function resolve() {
    $('search-anime').click(); $('search-results').querySelector('button').click();
    $('episode-roads').querySelector('button').click();
    return requests.find(request => request.url.includes('/api/resolve/'));
  }
  const key = code => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { keyCode: code }));
  return { window, $, requests, resolve, opened, key };
}
const stream = { item: { title: '葬送的芙莉莲 · 第01话', streamPath: '/stream/anime-test', format: 'hls' } };

test('TV search → result → episode → resolve opens only the Mac proxy URL', t => {
  const app = setup(t), pending = app.resolve();
  assert.equal(pending.timeout, 180000);
  assert.ok(pending.url.endsWith('?target=tv'));
  pending.respond(stream);
  assert.deepEqual(app.opened, ['http://127.0.0.1:8787/stream/anime-test']);
  assert.equal(app.$('playing-title').textContent, stream.item.title);
  app.key(10009);
  assert.equal(app.$('episodes-view').classList.contains('hidden'), false);
});

test('Back cancels waiting and a late resolve response cannot start playback', t => {
  const app = setup(t), pending = app.resolve();
  app.key(10009); assert.equal(pending.aborted, true);
  pending.respond(stream);
  assert.equal(app.opened.length, 0);
  app.key(10009); assert.equal(app.$('anime-view').classList.contains('hidden'), false);
});

test('resolver errors stay on the episode screen and never pretend to play', t => {
  const app = setup(t), pending = app.resolve();
  pending.respond({ error: 'Source requires manual verification' }, 502);
  assert.match(app.$('episodes-status').textContent, /manual verification/);
  assert.equal(app.opened.length, 0);
  assert.equal(app.$('player-screen').classList.contains('hidden'), true);
});
