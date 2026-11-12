import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createController } from '../lib/controller.mjs';
import { createApp } from '../app.mjs';

function setup(options = {}) {
  let time = 100000;
  const discovery = { selection(id) { if (!['ep1', 'ep2', 'ep3'].includes(id)) throw Object.assign(new Error('Selection expired'), { status: 404 });
    return { title: '葬送的芙莉莲 · ' + id, url: 'https://private-source.example/' + id, rule: { id: 'fixture' } }; },
    async resolveSelection(selection) { return { item: { title: selection.title, streamPath: '/stream/anime-fixture/index.m3u8', format: 'hls' } }; },
    async close() {}, stream() { return null; }, ...options };
  const controller = createController({ discovery, now: () => time });
  const receiver = controller.register({ clientId: 'tv-fixture', version: '0.3.0' });
  const poll = (value = {}) => controller.poll(receiver.session, { status: 'idle', applied: 0, ...value });
  return { controller, discovery, receiver, poll, tick: amount => { time += amount; } };
}

test('phone slider uses the fresh receiver position and stays compatible with existing relative-seek widgets', () => {
  const { controller: c, poll } = setup();
  const sample = { status: 'playing', title: 'Episode 1', position: 10000, duration: 600000 };
  poll(sample); const context = c.state().seekContext;
  assert.equal(c.state().seekAvailable, true);
  c.mutate({ action: 'seek', positionMs: 90000, seekContext: context });
  const forward = poll({ ...sample, position: 12000 }).commands[0];
  assert.equal(forward.action, 'seek'); assert.equal(forward.seconds, 78);
  assert.equal(forward.positionMs, undefined); assert.equal(forward.seekContext, undefined);
  poll({ ...sample, applied: forward.seq, position: 90000 });
  c.mutate({ action: 'seek', positionMs: 30000, seekContext: context });
  const backward = poll({ ...sample, applied: forward.seq, position: 92000 }).commands[0];
  assert.equal(backward.seconds, -62);
  assert.equal(c.state().tv.status, 'playing');
});

test('absolute seeks are clamped away from the end and no-op seeks do not issue a command', () => {
  const { controller: c, poll } = setup();
  const sample = { status: 'paused', title: 'Episode 1', position: 10000, duration: 60000 };
  poll(sample); const context = c.state().seekContext;
  c.mutate({ action: 'seek', positionMs: 10000, seekContext: context });
  assert.equal(poll(sample).commands.length, 0);
  c.mutate({ action: 'seek', positionMs: 86400000, seekContext: context });
  const end = poll(sample).commands[0]; assert.equal(end.seconds, 49);
  poll({ ...sample, applied: end.seq, position: 59000 });
  c.mutate({ action: 'seek', positionMs: 0, seekContext: context });
  assert.equal(poll({ ...sample, applied: end.seq, position: 59000 }).commands[0].seconds, -59);
  assert.equal(c.state().tv.status, 'paused');
});

test('a target already reached before receiver polling is not sent as an invalid zero-distance seek', () => {
  const { controller: c, poll } = setup();
  const sample = { status: 'playing', title: 'Episode 1', position: 10000, duration: 600000 };
  poll(sample);
  c.mutate({ action: 'seek', positionMs: 20000, seekContext: c.state().seekContext });
  assert.equal(poll({ ...sample, position: 20000 }).commands.length, 0);
});

test('stale sliders cannot seek another episode, including a switch after queuing the command', () => {
  const { controller: c, poll } = setup();
  const sample = { status: 'playing', title: 'Episode 1', position: 10000, duration: 600000 };
  poll(sample); const context = c.state().seekContext;
  c.mutate({ action: 'seek', positionMs: 90000, seekContext: context });
  assert.equal(poll({ ...sample, title: 'Episode 2' }).commands.length, 0);
  assert.notEqual(c.state().seekContext, context);
  assert.throws(() => c.mutate({ action: 'seek', positionMs: 90000, seekContext: context }), error => error.status === 409);
  const nextContext = c.state().seekContext;
  c.register({ clientId: 'tv-fixture', bootId: 'new-boot' });
  assert.notEqual(c.state().seekContext, nextContext);
});

test('slider rejects malformed targets, mixed relative/absolute commands, offline and unready playback', () => {
  const { controller: c, poll, tick } = setup();
  const sample = { status: 'playing', title: 'Episode 1', position: 10000, duration: 600000 };
  poll(sample); const context = c.state().seekContext;
  for (const positionMs of [-1, NaN, Infinity, 1.5, 86400001, '1000', null]) {
    assert.throws(() => c.mutate({ action: 'seek', positionMs, seekContext: context }), /millisecond/);
  }
  assert.throws(() => c.mutate({ action: 'seek', positionMs: 20000, seconds: 10, seekContext: context }), /millisecond/);
  assert.throws(() => c.mutate({ action: 'seek', positionMs: 20000 }), error => error.status === 409);
  for (const patch of [{ duration: 0 }, { status: 'loading' }, { status: 'idle' }]) {
    poll({ ...sample, ...patch });
    assert.equal(c.state().seekAvailable, false);
    assert.throws(() => c.mutate({ action: 'seek', positionMs: 20000, seekContext: context }), /尚不能跳转/);
  }
  poll(sample); tick(10001);
  assert.throws(() => c.mutate({ action: 'seek', positionMs: 20000, seekContext: context }), /offline/);
});

test('a pending seek or Stop prevents overlapping slider requests', () => {
  const { controller: c, poll } = setup();
  const sample = { status: 'playing', title: 'Episode 1', position: 10000, duration: 600000 };
  poll(sample); const context = c.state().seekContext;
  c.mutate({ action: 'seek', positionMs: 20000, seekContext: context });
  assert.throws(() => c.mutate({ action: 'seek', positionMs: 40000, seekContext: context }), /正在跳转/);
  const command = poll(sample).commands[0];
  poll({ ...sample, applied: command.seq, seek: { state: 'seeking' } });
  assert.throws(() => c.mutate({ action: 'seek', positionMs: 40000, seekContext: context }), /正在跳转/);
  c.mutate({ action: 'stop' }); assert.equal(c.state().seekAvailable, false);
  assert.throws(() => c.mutate({ action: 'seek', positionMs: 40000, seekContext: c.state().seekContext }), /尚不能跳转/);
});

test('slider HTTP action validates origin/context and delivers a legacy command over authenticated receiver polling', async t => {
  const { discovery } = setup();
  const server = createApp({ discovery, receiverAddress: '127.0.0.1' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (route, value, headers = {}) => fetch(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  const { session } = await (await post('/api/tv/register', { clientId: 'slider-http-tv', version: '0.6.2' })).json();
  const sample = { title: 'Test episode', status: 'paused', position: 20000, duration: 300000 };
  await post('/api/tv/poll', sample, { 'X-Bangumi-TV': session });
  const state = await (await fetch(base + '/api/controller/state')).json();
  const input = { action: 'seek', positionMs: 150000, seekContext: state.seekContext };
  assert.equal((await post('/api/controller/action', input, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await post('/api/controller/action', { ...input, seekContext: 'old-context' })).status, 409);
  assert.equal((await post('/api/controller/action', input)).status, 200);
  const { commands } = await (await post('/api/tv/poll', { ...sample, position: 21000 }, { 'X-Bangumi-TV': session })).json();
  assert.equal(commands.length, 1); assert.equal(commands[0].action, 'seek'); assert.equal(commands[0].seconds, 129);
  assert.equal(commands[0].seekContext, undefined);
});

test('single-TV status is directly available with no phone pairing or credentials', () => {
  const { controller: c, receiver, tick } = setup();
  assert.equal(c.state().tvOnline, true); assert.equal(receiver.pairCode, undefined);
  assert.equal(c.pair, undefined); assert.equal(c.authorize, undefined);
  tick(10001); assert.equal(c.info().tvOnline, false);
});

test('enqueue validates atomically, permits offline queueing and hides private source URLs', () => {
  const { controller: c, tick } = setup();
  assert.throws(() => c.mutate({ action: 'enqueue', episodeIds: ['ep1', 'invalid'] }), /expired/);
  assert.equal(c.state().queue.length, 0);
  tick(10001); c.mutate({ action: 'enqueue', episodeIds: ['ep1', 'ep2'] });
  assert.equal(c.state().queue.length, 2);
  assert.ok(!JSON.stringify(c.state()).includes('private-source'));
  assert.throws(() => c.mutate({ action: 'play', episodeId: 'ep1' }), /offline/);
  assert.throws(() => c.mutate({ action: 'enqueue', episodeIds: Array(100).fill('ep1') }), /100/);
});

test('queue reorder/remove and completion advance exactly once; stopped playback does not advance', async () => {
  const { controller: c, poll } = setup();
  c.mutate({ action: 'enqueue', episodeIds: ['ep1', 'ep2', 'ep3'] });
  const initial = c.state().queue;
  c.mutate({ action: 'move', id: initial[2].id, direction: -1 });
  assert.match(c.state().queue[1].title, /ep3/);
  c.mutate({ action: 'remove', id: initial[2].id });
  c.mutate({ action: 'next' }); await c.settled();
  const first = poll().commands[0]; assert.equal(first.action, 'play');
  poll({ applied: first.seq, playbackId: first.playbackId, status: 'playing' });
  assert.equal(poll({ applied: first.seq }).commands.length, 0);
  poll({ applied: first.seq, terminal: { playbackId: first.playbackId, reason: 'ended' } });
  await c.settled();
  const second = poll({ applied: first.seq }).commands[0]; assert.match(second.item.title, /ep2/);
  poll({ applied: first.seq, terminal: { playbackId: first.playbackId, reason: 'ended' } });
  assert.equal(c.state().queue.length, 0); assert.equal(c.state().active.title, second.item.title);
  c.mutate({ action: 'enqueue', episodeIds: ['ep3'] });
  poll({ applied: second.seq, terminal: { playbackId: second.playbackId, reason: 'stopped' } });
  assert.equal(c.state().queue.length, 1); assert.equal(c.state().active, null);
});

test('Stop invalidates a pending resolution; late completion cannot issue Play', async () => {
  let finish;
  const { controller: c, poll } = setup({ resolveSelection: () => new Promise(resolve => { finish = resolve; }) });
  c.mutate({ action: 'enqueue', episodeIds: ['ep1'] }); c.mutate({ action: 'next' });
  await Promise.resolve();
  c.mutate({ action: 'stop' }); finish({ item: { streamPath: '/stream/late' } }); await c.settled();
  assert.deepEqual(poll().commands.map(command => command.action), ['stop']);
  assert.equal(c.state().queue.length, 1); assert.equal(c.state().active, null);
});

test('resolution failures retain the queued episode and report the actual error', async () => {
  const { controller: c } = setup({ resolveSelection: async () => { throw new Error('Source needs manual verification'); } });
  c.mutate({ action: 'enqueue', episodeIds: ['ep1'] }); c.mutate({ action: 'next' }); await c.settled();
  assert.equal(c.state().queue.length, 1); assert.equal(c.state().phase, 'error'); assert.match(c.state().error, /verification/);
});

test('receiver auth, offline expiry, and queue controls reject stale/invalid input', async () => {
  const { controller: c, receiver, poll, tick } = setup();
  assert.throws(() => c.poll('invalid', {}), /registration/);
  assert.throws(() => c.register({ clientId: 'different-tv' }), /already/);
  assert.equal(c.register({ clientId: 'tv-fixture' }).session, receiver.session);
  assert.throws(() => c.mutate({ action: 'seek', seconds: 999 }), /Seek/);
  c.mutate({ action: 'play', episodeId: 'ep1' }); await c.settled(); tick(16000);
  assert.equal(poll().commands.length, 0); assert.equal(c.state().phase, 'error');
});

test('a TV app reboot invalidates stale playback state but preserves upcoming queue entries', async () => {
  const { controller: c, poll } = setup();
  c.mutate({ action: 'enqueue', episodeIds: ['ep1', 'ep2'] }); c.mutate({ action: 'next' }); await c.settled();
  const command = poll().commands[0]; poll({ applied: command.seq, playbackId: command.playbackId, status: 'playing' });
  c.register({ clientId: 'tv-fixture', bootId: 'new-boot', version: '0.3.0' });
  assert.equal(c.state().active, null); assert.equal(c.state().phase, 'idle'); assert.equal(c.state().queue.length, 1);
});

test('HTTP controller exposes phone assets, protects writes and requires the configured TV IP', async t => {
  const { discovery } = setup();
  const server = createApp({ discovery, receiverAddress: '127.0.0.1' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const receiver = await (await post('/api/tv/register', { clientId: 'http-fixture', version: '0.3.0' })).json();
  assert.ok(receiver.session); assert.equal(receiver.pairCode, undefined);
  assert.equal((await fetch(base + '/api/controller/state')).status, 200);
  assert.equal((await post('/api/controller/action', { action: 'clear' }, { Origin: 'https://unrelated.example' })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/controller/state', { headers: { Host: 'unrelated.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await post('/api/controller/action', { action: 'enqueue', episodeIds: ['ep1'] })).status, 200);
  const state = await (await fetch(base + '/api/controller/state')).json(); assert.equal(state.queue.length, 1);
  assert.equal((await fetch(base + '/remote/')).status, 200);
  assert.equal((await fetch(base + '/remote/app.js')).status, 200);
  assert.equal((await fetch(base + '/remote/server/sources.json')).status, 404);
  assert.equal((await post('/api/tv/poll', {}, { 'X-Bangumi-TV': 'not-authorized' })).status, 401);
  assert.equal((await fetch(base + '/api/controller/action', { method: 'POST', body: 'not-json' })).status, 415);
});

test('pinned Samsung widget origins can register and poll without relaxing phone-origin protection', async t => {
  const { discovery } = setup();
  const server = createApp({ discovery, receiverAddress: '127.0.0.1' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'file://', ...headers }, body: JSON.stringify(body) });
  const response = await post('/api/tv/register', { clientId: 'samsung-widget', bootId: 'boot-1', version: '0.3.0' });
  assert.equal(response.status, 200);
  const { session } = await response.json();
  assert.ok(session);
  assert.equal((await post('/api/tv/poll', { status: 'idle' }, { 'X-Bangumi-TV': session })).status, 200);
  assert.equal((await (await fetch(base + '/api/controller/state')).json()).tvOnline, true);
  assert.equal((await post('/api/controller/action', { action: 'clear' })).status, 403);
  assert.equal((await post('/api/controller/action', { action: 'clear' }, { Origin: 'null' })).status, 403);
  assert.equal((await post('/api/tv/poll', {}, { 'X-Bangumi-TV': 'invalid' })).status, 401);
});

test('non-null TV origins need an actual pinned socket address, not a forwarded header', async t => {
  for (const receiverAddress of ['', '10.0.0.53']) {
    const { discovery } = setup();
    const server = createApp({ discovery, receiverAddress });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/tv/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'file://', 'X-Forwarded-For': '10.0.0.53' },
      body: JSON.stringify({ clientId: 'fake-widget' })
    });
    assert.equal(response.status, 403);
  }
});
