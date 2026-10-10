import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// Exercise the Samsung branch without assuming an emulator equals real TV hardware.
function setup(receiver = false) {
  const elements = {}, handlers = {}, timeouts = new Map(), intervals = new Map(), calls = [];
  let timerId = 0, state = 'NONE', now = 0, listener, prepared;
  const commands = [], reports = [];
  class Element {
    constructor(id) {
      this.id = id; this.children = []; this.style = {}; this.textContent = ''; this.value = '';
      const classes = new Set();
      this.classList = { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) };
    }
    focus() { document.activeElement = this; }
    blur() { document.activeElement = null; }
    getClientRects() { return this.classList.contains('hidden') ? [] : [{}]; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
    appendChild(child) { this.children.push(child); }
    querySelector() { return this.children[0] || null; }
    querySelectorAll() { return this.children; }
    addEventListener(name, callback) { handlers[this.id + ':' + name] = callback; }
    removeAttribute() {}
    scrollIntoView() {}
    pause() { this.paused = true; }
    load() {}
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements[match[1]] = new Element(match[1]);
  for (const id of ['setup', 'player-screen', 'playback-message']) elements[id].classList.add('hidden');
  const document = {
    body: new Element('body'), activeElement: null, hidden: false,
    getElementById: id => elements[id], createElement: () => new Element(''),
    addEventListener: (name, callback) => { handlers[name] = callback; }
  };
  const avplay = {
    open: url => { calls.push(['open', url]); state = 'IDLE'; },
    close: () => { calls.push(['close']); state = 'NONE'; },
    setDisplayRect: (...args) => calls.push(['rect', ...args]),
    setDisplayMethod: value => calls.push(['display', value]),
    setListener: value => { listener = value; },
    prepareAsync: (success, error) => { prepared = { success, error }; },
    play: () => { calls.push(['play']); state = 'PLAYING'; },
    pause: () => { calls.push(['pause']); state = 'PAUSED'; },
    getState: () => state, getDuration: () => 45000, getCurrentTime: () => now,
    seekTo: (target, success) => { now = target; calls.push(['seek', target]); success(); }
  };
  class XHR {
    open(method, url) { this.url = url; }
    setRequestHeader() {}
    send(body) {
      this.status = 200;
      if (receiver && this.url.endsWith('/api/tv/register')) this.responseText = JSON.stringify({ session: 'session', epoch: 'epoch' });
      else if (receiver && this.url.endsWith('/api/tv/poll')) {
        reports.push(JSON.parse(body)); this.responseText = JSON.stringify({ epoch: 'epoch', commands });
      } else this.responseText = JSON.stringify({ items: [{ title: 'Test episode', kind: 'local', format: 'mp4', description: 'Original file', streamPath: '/stream/test' }] });
      this.onload();
    }
  }
  const tizen = { tvinputdevice: { registerKey: name => calls.push(['key', name]) },
    application: { getCurrentApplication: () => ({ exit: () => calls.push(['exit']) }) } };
  const window = { webapis: { avplay }, tizen, BANGUMI_DEFAULT_SERVER: 'http://192.168.1.20:8787',
    location: { protocol: 'file:' }, addEventListener: () => {} };
  const context = { window, document, localStorage: { getItem: () => null, setItem: () => {} }, XMLHttpRequest: XHR,
    setTimeout: callback => { timeouts.set(++timerId, callback); return timerId; }, clearTimeout: id => timeouts.delete(id),
    setInterval: callback => { intervals.set(++timerId, callback); return timerId; }, clearInterval: id => intervals.delete(id) };
  vm.runInNewContext(source, context);
  function key(code) { handlers.keydown({ keyCode: code, preventDefault() {} }); }
  return { elements, calls, key, timeouts, intervals, commands, reports,
    poll: () => { for (const callback of [...intervals.values()]) callback(); },
    start: () => elements.cards.children[0].onclick(),
    ready: () => prepared.success(), get prepared() { return prepared; }, get listener() { return listener; } };
}

test('Samsung playback uses AVPlay at its documented 1920×1080 coordinate scale', () => {
  const app = setup(); app.start(); app.ready();
  assert.ok(app.calls.some(call => call[0] === 'open' && call[1] === 'http://192.168.1.20:8787/stream/test'));
  assert.ok(app.calls.some(call => call.join(',') === 'rect,0,0,1920,1080'));
  assert.equal(app.calls.filter(call => call[0] === 'play').length, 1);
  assert.equal(app.elements['browser-player'].classList.contains('hidden'), true);
  assert.equal(app.elements['playback-message'].classList.contains('hidden'), true);
});

test('media keys pause/resume/seek and Back closes playback', () => {
  const app = setup(); app.start(); app.ready();
  app.key(19); app.key(415); app.key(417); app.key(10009);
  assert.ok(app.calls.some(call => call[0] === 'pause'));
  assert.ok(app.calls.some(call => call[0] === 'seek' && call[1] === 10000));
  assert.equal(app.elements['player-screen'].classList.contains('hidden'), true);
  assert.equal(app.elements['library-screen'].classList.contains('hidden'), false);
});

test('a pending prepare callback cannot restart a video after Back', () => {
  const app = setup(); app.start(); const prepare = app.prepared;
  app.key(10009); prepare.success();
  assert.equal(app.calls.filter(call => call[0] === 'play').length, 0);
});

test('embedded subtitle text survives progress updates and expires at its duration', () => {
  const app = setup(); app.start(); app.ready();
  app.listener.onsubtitlechange(2000, 'Hello, TV');
  for (const callback of app.intervals.values()) callback();
  assert.equal(app.elements.subtitle.textContent, 'Hello, TV');
  for (const callback of [...app.timeouts.values()]) callback();
  assert.equal(app.elements.subtitle.textContent, '');
});

test('TV preparation errors stay visible and allow returning to the library', () => {
  const app = setup(); app.start(); app.prepared.error(new Error('Unsupported codec'));
  assert.match(app.elements['playback-message'].textContent, /Unsupported codec/);
  assert.equal(app.elements['playback-message'].classList.contains('hidden'), false);
  app.key(10009);
  assert.equal(app.elements['library-screen'].classList.contains('hidden'), false);
});

test('phone Play, Pause and completion reporting use AVPlay and duplicate commands are ignored', () => {
  const app = setup(true);
  assert.match(app.elements['phone-controller'].textContent, /\/remote\//);
  assert.ok(!app.elements['phone-controller'].textContent.includes('Pair'));
  app.commands.push({ seq: 1, action: 'play', playbackId: 'remote-episode', item: { title: 'Frieren 1', streamPath: '/stream/phone/index.m3u8' } });
  app.poll(); app.ready(); app.poll();
  assert.equal(app.calls.filter(call => call[0] === 'open').length, 1);
  assert.equal(app.reports.at(-1).status, 'playing'); assert.equal(app.reports.at(-1).playbackId, 'remote-episode');
  app.commands.push({ seq: 2, action: 'pause' }); app.poll(); app.poll();
  assert.equal(app.reports.at(-1).status, 'paused');
  app.listener.onstreamcompleted(); app.poll();
  assert.equal(app.reports.at(-1).terminal.reason, 'ended'); assert.equal(app.reports.at(-1).terminal.playbackId, 'remote-episode');
  app.poll(); assert.equal(app.reports.at(-1).terminal, null);
});

test('phone Stop prevents a pending prepare from starting later and reports stopped rather than ended', () => {
  const app = setup(true);
  app.commands.push({ seq: 1, action: 'play', playbackId: 'remote-episode', item: { title: 'Frieren 1', streamPath: '/stream/phone' } });
  app.poll(); const pending = app.prepared;
  app.commands.push({ seq: 2, action: 'stop' }); app.poll(); pending.success(); app.poll();
  assert.equal(app.calls.filter(call => call[0] === 'play').length, 0);
  assert.equal(app.reports.at(-1).terminal.reason, 'stopped');
});
