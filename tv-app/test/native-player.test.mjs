import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// Exercise the Samsung branch without assuming an emulator equals real TV hardware.
function setup(receiver = false, comments = false) {
  const elements = {}, handlers = {}, timeouts = new Map(), intervals = new Map(), calls = [];
  let timerId = 0, clock = 0, state = 'NONE', now = 0, listener, prepared;
  const deadlines = new Map();
  const commands = [], reports = [];
  const danmakuCalls = [];
  let danmakuResponse = { count: 0, comments: [], enabled: true, version: '1', automatic: { message: '正在获取官方弹幕，视频继续播放…' } };
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
      } else if (this.url.includes('/api/danmaku/')) this.responseText = JSON.stringify(danmakuResponse);
      else this.responseText = JSON.stringify({ items: [{ title: 'Test episode', kind: 'local', format: 'mp4', description: 'Original file', streamPath: '/stream/test',
        ...(comments ? { id: 'anime-' + 'a'.repeat(32), danmakuPath: '/api/danmaku/anime-' + 'a'.repeat(32) } : {}) }] });
      this.onload();
    }
  }
  const tizen = { tvinputdevice: { registerKey: name => calls.push(['key', name]) },
    application: { getCurrentApplication: () => ({ exit: () => calls.push(['exit']) }) } };
  const window = { webapis: { avplay }, tizen, BANGUMI_DEFAULT_SERVER: 'http://192.168.1.20:8787',
    location: { protocol: 'file:' }, addEventListener: () => {} };
  if (comments) window.BangumiDanmaku = function () {
    this.configure = settings => danmakuCalls.push(['configure', settings]);
    this.setData = value => danmakuCalls.push(['data', value]);
    this.clear = () => danmakuCalls.push(['clear']); this.tick = (...args) => danmakuCalls.push(['tick', ...args]);
  };
  const context = { window, document, localStorage: { getItem: () => null, setItem: () => {} }, XMLHttpRequest: XHR,
    setTimeout: (callback, delay = 0) => { timeouts.set(++timerId, callback); deadlines.set(timerId, clock + delay); return timerId; },
    clearTimeout: id => { timeouts.delete(id); deadlines.delete(id); },
    setInterval: callback => { intervals.set(++timerId, callback); return timerId; }, clearInterval: id => intervals.delete(id) };
  vm.runInNewContext(source, context);
  function key(code) { handlers.keydown({ keyCode: code, preventDefault() {} }); }
  function advance(milliseconds) {
    const end = clock + milliseconds;
    while (true) {
      const next = [...deadlines].filter(([id, due]) => timeouts.has(id) && due <= end).sort((a, b) => a[1] - b[1])[0];
      if (!next) break;
      const [id, due] = next, callback = timeouts.get(id);
      clock = due; deadlines.delete(id); timeouts.delete(id); callback();
    }
    clock = end;
  }
  return { elements, calls, key, advance, timeouts, intervals, commands, reports, avplay, danmakuCalls,
    get focused() { return document.activeElement; },
    comments: value => { danmakuResponse = value; },
    poll: () => { for (const callback of [...intervals.values()]) callback(); },
    start: () => elements.cards.children[0].onclick(),
    ready: () => prepared.success(), get prepared() { return prepared; }, get listener() { return listener; } };
}

test('TV loads late danmaku without reopening AVPlay and supports its own visibility control', () => {
  const app = setup(true, true); app.start(); app.ready();
  assert.match(app.elements['danmaku-status'].textContent, /正在获取/);
  const opens = app.calls.filter(call => call[0] === 'open').length;
  app.comments({ enabled: true, count: 2000, comments: [{ time: 1, text: 'test' }], version: '2' }); app.poll();
  assert.match(app.elements['danmaku-status'].textContent, /2000/);
  assert.equal(app.calls.filter(call => call[0] === 'open').length, opens);
  app.elements['toggle-danmaku'].onclick();
  assert.match(app.elements['toggle-danmaku'].textContent, /隐藏/);
  assert.equal(app.danmakuCalls.filter(call => call[0] === 'configure').at(-1)[1].enabled, false);
  app.elements['toggle-danmaku'].onclick();
  assert.equal(app.danmakuCalls.filter(call => call[0] === 'configure').at(-1)[1].enabled, true);
});

test('native buffering and pause freeze the independent danmaku clock immediately', () => {
  const app = setup(true, true); app.start(); app.ready();
  assert.equal(app.danmakuCalls.filter(call => call[0] === 'tick').at(-1)[2], false);
  app.listener.onbufferingstart();
  assert.equal(app.danmakuCalls.filter(call => call[0] === 'tick').at(-1)[2], true);
  app.poll(); assert.equal(app.danmakuCalls.filter(call => call[0] === 'tick').at(-1)[2], true);
  app.listener.onbufferingcomplete();
  assert.equal(app.danmakuCalls.filter(call => call[0] === 'tick').at(-1)[2], false);
  app.key(19); assert.equal(app.danmakuCalls.filter(call => call[0] === 'tick').at(-1)[2], true);
  app.key(415); assert.equal(app.danmakuCalls.filter(call => call[0] === 'tick').at(-1)[2], false);
  app.key(10009); assert.equal(app.danmakuCalls.at(-1)[0], 'clear');
});

test('native seek freezes glyphs before the operation and explicitly resynchronizes on completion', () => {
  const app = setup(true, true); app.start(); app.ready();
  app.key(417);
  assert.ok(app.danmakuCalls.some(call => call[0] === 'tick' && call[1] === 0 && call[2] === true));
  for (const callback of [...app.timeouts.values()]) callback();
  assert.ok(app.danmakuCalls.some(call => call[0] === 'tick' && call[1] === 10000 && call[3] === true));
});

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

test('missing seek callbacks unlock retries and report a nonfatal error to the phone', () => {
  const app = setup(true); app.start(); app.ready();
  let attempts = 0;
  app.avplay.seekTo = () => { attempts++; };
  app.key(417);
  for (const callback of [...app.timeouts.values()]) callback();
  for (const callback of [...app.timeouts.values()]) callback();
  for (const callback of [...app.timeouts.values()]) callback();
  app.poll();
  assert.equal(app.reports.at(-1).seek.state, 'error');
  assert.equal(app.reports.at(-1).status, 'playing');
  app.key(417); assert.equal(attempts, 2);
});

test('seek rejection clears its notice and auto-hides the playing HUD without losing the phone error', () => {
  const app = setup(true); app.start(); app.ready();
  let attempts = 0;
  app.avplay.seekTo = (_target, _success, error) => { attempts++; error({ name: 'PLAYER_ERROR_INVALID_STATE' }); };
  app.key(417);
  assert.match(app.elements['playback-message'].textContent, /Seek failed.*PLAYER_ERROR_INVALID_STATE/);
  app.advance(2999);
  assert.equal(app.elements['playback-message'].classList.contains('hidden'), false);
  app.advance(1);
  assert.equal(app.elements['playback-message'].classList.contains('hidden'), true);
  app.advance(1500);
  assert.equal(app.elements.hud.classList.contains('dimmed'), true);
  assert.equal(app.elements['player-screen'].classList.contains('controls-visible'), false);
  assert.equal(app.focused, null);
  app.poll();
  assert.equal(app.reports.at(-1).status, 'playing');
  assert.equal(app.reports.at(-1).seek.state, 'error');
  assert.match(app.reports.at(-1).seek.error, /PLAYER_ERROR_INVALID_STATE/);
  app.key(38);
  assert.equal(app.elements.hud.classList.contains('dimmed'), false);
  app.key(417); assert.equal(attempts, 2);
  assert.equal(app.calls.filter(call => call[0] === 'open').length, 1);
});

test('timed-out seeks and unsupported streams also release the HUD', () => {
  for (const unsupported of [false, true]) {
    const app = setup(); app.start(); app.ready();
    if (unsupported) app.avplay.getDuration = () => 0;
    else app.avplay.seekTo = () => {};
    app.key(417);
    if (!unsupported) app.advance(6000);
    assert.match(app.elements['playback-message'].textContent, unsupported ? /does not offer seeking/ : /Seek timed out/);
    app.advance(4500);
    assert.equal(app.elements['playback-message'].classList.contains('hidden'), true);
    assert.equal(app.elements.hud.classList.contains('dimmed'), true);
  }
});

test('a paused seek error expires but keeps pause controls until playback resumes', () => {
  const app = setup(); app.start(); app.ready(); app.key(19);
  app.avplay.seekTo = (_target, _success, error) => error(new Error('Unsupported seek'));
  app.key(417); app.advance(4500);
  assert.equal(app.elements['playback-message'].classList.contains('hidden'), true);
  assert.equal(app.elements.hud.classList.contains('dimmed'), false);
  assert.equal(app.avplay.getState(), 'PAUSED');
  app.key(415); app.advance(4500);
  assert.equal(app.elements.hud.classList.contains('dimmed'), true);
});

test('expired seek notices cannot dismiss newer buffering or fatal playback errors', () => {
  for (const fatal of [false, true]) {
    const app = setup(); app.start(); app.ready();
    app.avplay.seekTo = (_target, _success, error) => error(new Error('Unsupported seek'));
    app.key(417); app.advance(1000);
    if (fatal) app.listener.onerror('Unsupported codec');
    else app.listener.onbufferingstart();
    app.advance(9000);
    assert.match(app.elements['playback-message'].textContent, fatal ? /Unsupported codec.*Press Back/ : /Buffering/);
    assert.equal(app.elements['playback-message'].classList.contains('hidden'), false);
    assert.equal(app.elements.hud.classList.contains('dimmed'), false);
    if (!fatal) {
      app.listener.onbufferingcomplete(); app.advance(4500);
      assert.equal(app.elements.hud.classList.contains('dimmed'), true);
    }
    app.key(10009);
    assert.equal(app.elements['library-screen'].classList.contains('hidden'), false);
  }
});

test('old seek-notice timers cannot clear the next episode loading message', () => {
  const app = setup(); app.start(); app.ready();
  app.avplay.seekTo = (_target, _success, error) => error(new Error('Unsupported seek'));
  app.key(417);
  const staleCallbacks = [...app.timeouts.values()];
  app.key(10009); app.start();
  staleCallbacks.forEach(callback => callback());
  app.advance(10000);
  assert.equal(app.elements['playback-message'].textContent, 'Loading video…');
  assert.equal(app.elements['playback-message'].classList.contains('hidden'), false);
  assert.equal(app.elements.hud.classList.contains('dimmed'), false);
  app.ready(); app.advance(4500);
  assert.equal(app.elements.hud.classList.contains('dimmed'), true);
});

test('relative seek falls back to absolute and late callbacks cannot affect a replacement video', () => {
  const app = setup(); app.start(); app.ready();
  app.avplay.jumpForward = (delta, success, error) => error({ name: 'NotSupportedError' });
  app.avplay.jumpBackward = () => {};
  app.key(417);
  for (const callback of [...app.timeouts.values()]) callback();
  assert.ok(app.calls.some(call => call[0] === 'seek' && call[1] === 10000));
  const callbacks = [...app.timeouts.values()];
  app.key(10009); app.start(); app.ready();
  callbacks.forEach(callback => callback());
  assert.equal(app.elements['playback-message'].classList.contains('hidden'), true);
});

test('TV does not read or control AVPlay during an asynchronous seek', () => {
  const app = setup(true); app.start(); app.ready();
  let pending, waiting = false, reads = 0;
  for (const name of ['getCurrentTime', 'getDuration', 'getState']) {
    const original = app.avplay[name];
    app.avplay[name] = () => { if (waiting) reads++; return original(); };
  }
  app.avplay.jumpForward = (_delta, _success, error) => { waiting = true; pending = error; };
  app.avplay.jumpBackward = () => {};
  app.key(417);
  app.poll();
  app.key(19);
  assert.equal(reads, 0);
  assert.equal(app.calls.filter(call => call[0] === 'pause').length, 0);
  waiting = false; pending({ name: 'InvalidStateError' });
  assert.equal(app.calls.filter(call => call[0] === 'seek').length, 0);
  for (const callback of [...app.timeouts.values()]) callback();
  assert.ok(app.calls.some(call => call[0] === 'seek' && call[1] === 10000));
});

test('copied HLS accepts a keyframe landing beyond five seconds but rejects an unchanged position', () => {
  for (const moved of [true, false]) {
    const app = setup(true);
    app.commands.push({ seq: 1, action: 'play', playbackId: 'remux-episode', item: {
      title: 'Remux episode', streamPath: '/stream/test/tv-hls/index.m3u8', playback: 'remux', seekToleranceMs: 11302
    } });
    app.poll(); app.ready();
    let time = 0;
    app.avplay.getCurrentTime = () => time;
    app.avplay.jumpForward = (_delta, success) => { if (moved) time = 16000; success(); };
    app.avplay.jumpBackward = () => {};
    app.avplay.seekTo = (_target, success) => success();
    app.key(417);
    for (let round = 0; round < 4; round++) for (const callback of [...app.timeouts.values()]) callback();
    app.poll();
    assert.equal(app.reports.at(-1).seek.state, moved ? 'done' : 'error');
    if (moved) assert.equal(app.reports.at(-1).seek.actual, 16000);
    else assert.match(app.reports.at(-1).seek.error, /did not jump/);
  }
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

test('installed receiver accepts large slider-derived forward/back deltas without reopening video or changing pause state', () => {
  for (const paused of [false, true]) {
    const app = setup(true); app.start(); app.ready();
    app.avplay.getDuration = () => 600000;
    app.avplay.seekTo(12000, () => {});
    if (paused) app.avplay.pause();
    app.commands.push({ seq: 1, action: 'seek', seconds: 78 }); app.poll();
    assert.ok(app.calls.some(call => call[0] === 'seek' && call[1] === 90000));
    for (const callback of [...app.timeouts.values()]) callback();
    app.commands.push({ seq: 2, action: 'seek', seconds: -60 }); app.poll();
    assert.ok(app.calls.some(call => call[0] === 'seek' && call[1] === 30000));
    for (const callback of [...app.timeouts.values()]) callback(); app.poll();
    assert.equal(app.reports.at(-1).seek.state, 'done');
    assert.equal(app.reports.at(-1).status, paused ? 'paused' : 'playing');
    assert.equal(app.calls.filter(call => call[0] === 'open').length, 1);
  }
});
