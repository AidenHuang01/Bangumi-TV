import test from 'node:test';
import assert from 'node:assert/strict';
import { createDanmaku, parseDanmaku } from '../lib/danmaku.mjs';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
test('Bilibili XML and Dandan JSON normalize without interpreting comment HTML', () => {
  const xml = '<i><d p="2.5,1,25,16711680">&lt;img src=x&gt;</d><d p="1,5,25,16777215">Hi</d></i>';
  const rows = parseDanmaku(xml);
  assert.equal(rows[0].time, 1); assert.equal(rows[0].mode, 5);
  assert.equal(rows[1].text, '<img src=x>'); assert.equal(rows[1].color, '#ff0000');
  assert.throws(() => parseDanmaku('<!DOCTYPE i><i/>'), /entities/);
  assert.equal(parseDanmaku('{"comments":[{"p":"5,4,16777215,u","m":"hello"}]}')[0].mode, 4);
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
