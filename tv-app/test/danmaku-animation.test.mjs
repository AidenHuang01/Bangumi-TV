import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../danmaku.js', import.meta.url), 'utf8');
const comment = (time, text = '测试滚动弹幕', mode = 1) => ({ time, text, mode, color: '#ffffff' });

function fixture(t, data = [comment(0)]) {
  const dom = new JSDOM('<div id="layer"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  let wall = 0, sequence = 0, widthReads = 0, glyphReads = 0, hidden = false;
  const frames = new Map(), { window } = dom;
  Object.defineProperty(window.performance, 'now', { value: () => wall });
  Object.defineProperty(window.document, 'hidden', { get: () => hidden });
  window.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
  window.cancelAnimationFrame = id => frames.delete(id);
  const layer = window.document.getElementById('layer');
  Object.defineProperty(layer, 'clientWidth', { get: () => { widthReads++; return 1920; } });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get() { glyphReads++; return this.textContent.length * 30; } });
  window.eval(source);
  const renderer = new window.BangumiDanmaku(layer); renderer.setData(data);
  function advance(to) {
    wall = to; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(to));
  }
  return { renderer, layer, window, frames, advance,
    clock: to => { wall = to; }, reads: () => ({ widthReads, glyphReads }),
    hide: value => { hidden = value; window.document.dispatchEvent(new window.Event('visibilitychange')); },
    x: () => Number(/translate3d\(([-\d.]+)px/.exec(layer.firstChild?.style.transform)?.[1]) };
}

test('250ms video samples produce 60 distinct smooth frame positions, not four large jumps', t => {
  const f = fixture(t); f.renderer.tick(0, false); const steps = [], reads = f.reads(); let x = f.x();
  for (let frame = 1; frame <= 60; frame++) {
    const stamp = frame * 1000 / 60;
    f.advance(stamp);
    if (frame % 15 === 0) f.renderer.tick(stamp, false);
    steps.push(x - f.x()); x = f.x();
  }
  assert.equal(steps.filter(step => step > 0).length, 60);
  assert.ok(Math.max(...steps) < 5, 'each frame should move ~4px, not ~65px');
  assert.deepEqual(f.reads(), reads, 'steady animation must not remeasure layout/text');
  assert.equal(f.frames.size, 1, 'only one animation loop');
});

test('duplicate and jittery native clock samples never snap scrolling backwards', t => {
  const f = fixture(t); f.renderer.tick(0, false); let x = f.x();
  for (let frame = 1; frame <= 60; frame++) {
    const stamp = frame * 1000 / 60; f.advance(stamp);
    if (frame % 15 === 0) f.renderer.tick(frame === 15 ? 0 : stamp - 50, false);
    assert.ok(f.x() <= x, 'monotonic transforms despite quantized source time'); x = f.x();
  }
});

test('pause/buffering stop frames immediately, resume restarts one loop, seek discards old glyphs', t => {
  const f = fixture(t, [comment(0), comment(10, 'after seek')]);
  f.renderer.tick(0, false); f.advance(250); f.renderer.tick(250, true);
  const paused = f.x(); assert.equal(f.frames.size, 0);
  f.advance(3000); assert.equal(f.x(), paused);
  f.renderer.tick(250, false); assert.equal(f.frames.size, 1); f.advance(3016);
  assert.ok(f.x() < paused);
  f.renderer.tick(10000, false, true);
  assert.equal(f.layer.children.length, 1); assert.equal(f.layer.textContent, 'after seek');
  assert.equal(f.frames.size, 1);
});

test('disabled/hidden/stopped players cannot leave a stale frame loop behind', t => {
  const f = fixture(t); f.renderer.tick(0, false); const stale = [...f.frames.values()][0];
  f.renderer.clear(); f.renderer.setData([comment(0, 'new episode')]); f.renderer.tick(0, false);
  stale(); assert.equal(f.frames.size, 1, 'cancelled old callback must not fork a new loop');
  f.renderer.configure({ enabled: false }); assert.equal(f.frames.size, 0); assert.equal(f.layer.children.length, 0);
  f.renderer.configure({ enabled: true }); assert.equal(f.frames.size, 1);
  f.hide(true); assert.equal(f.frames.size, 0); f.advance(20000);
  f.hide(false); assert.equal(f.frames.size, 0, 'foreground requires a fresh video sample');
  f.renderer.tick(0, false); assert.equal(f.frames.size, 1);
  f.renderer.clear(); assert.equal(f.frames.size, 0);
});

test('missing progress samples bound extrapolation and stop consuming animation frames', t => {
  const f = fixture(t); f.renderer.tick(0, false);
  f.advance(1000); const x = f.x(); f.advance(2000);
  assert.equal(f.x(), x); assert.equal(f.frames.size, 0);
  f.renderer.tick(2000, false); assert.equal(f.frames.size, 1);
});

test('thousands of comments keep a bounded active DOM and late data uses the current clock', t => {
  const rows = Array.from({ length: 3000 }, (_, i) => comment(10 + i / 100, 'row ' + i));
  const f = fixture(t, []); f.renderer.tick(10000, false); assert.equal(f.frames.size, 0);
  f.renderer.setData(rows); assert.ok(f.layer.children.length > 0); assert.equal(f.frames.size, 1);
  for (let i = 1; i <= 60; i++) { f.advance(i * 1000 / 60); if (i % 15 === 0) f.renderer.tick(10000 + i * 1000 / 60, false); }
  assert.ok(f.layer.children.length <= 8);
  assert.equal(f.layer.querySelector('script'), null);
});
