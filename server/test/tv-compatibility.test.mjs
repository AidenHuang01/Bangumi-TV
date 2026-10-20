import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../app.mjs';
import { parseRange } from '../lib/media.mjs';
import { createController } from '../lib/controller.mjs';
import { createTVCompatibility } from '../lib/tv-compatibility.mjs';

async function ffmpegBinary() {
  for (const file of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    try { await access(file); return file; } catch { /* Optional integration dependency. */ }
  }
}
function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(errors || 'FFmpeg failed')); });
  });
}

test('real FFmpeg produces complete private HLS VOD and a player can seek through its HTTP segments', async t => {
  const ffmpeg = await ffmpegBinary();
  if (!ffmpeg) return t.skip('FFmpeg is not installed');
  const directory = await mkdtemp(path.join(tmpdir(), 'bangumi-remux-test-'));
  const input = path.join(directory, 'fixture.mp4');
  await run(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-c:v', 'libx264',
    '-g', '10', '-c:a', 'aac', '-movflags', '+faststart', input]);
  const id = 'anime-' + 'a'.repeat(32), episode = 'b'.repeat(32);
  const source = { id, kind: 'remote', format: 'mp4', url: 'https://source.example/video.mp4?secret=private', cookie: 'private-cookie' };
  const item = { id, kind: 'remote', format: 'mp4', title: 'Fixture', streamPath: '/stream/' + id, danmakuPath: '/api/danmaku/' + id };
  const sharedResolution = { item };
  const discovery = { stream: value => value === id ? source : null, resolve: async () => sharedResolution,
    selection: () => ({ title: 'Fixture' }), resolveSelection: async () => ({ item }), close: async () => {} };
  const bytes = (await stat(input)).size;
  const upstream = async (_url, options) => {
    const range = parseRange(options.range, bytes);
    return { status: range ? 206 : 200, url: source.url, stream: createReadStream(input, range || {}), headers: {
      'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(range ? range.end - range.start + 1 : bytes),
      ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${bytes}` } : {})
    } };
  };
  const cacheDir = path.join(directory, 'cache');
  const server = createApp({ discovery, upstream, tvCompatibilityOptions: { cacheDir, ffmpeg } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const original = await (await fetch(base + '/api/resolve/' + episode)).json();
  assert.equal(original.item.format, 'mp4');
  const prepared = await (await fetch(base + '/api/resolve/' + episode + '?target=tv')).json();
  assert.equal(prepared.item.format, 'hls'); assert.equal(prepared.item.playback, 'remux');
  assert.equal(prepared.item.danmakuPath, item.danmakuPath);
  assert.equal((await (await fetch(base + '/api/resolve/' + episode)).json()).item.format, 'mp4');
  const manifestURL = base + prepared.item.streamPath;
  const manifest = await (await fetch(manifestURL)).text();
  assert.match(manifest, /#EXT-X-PLAYLIST-TYPE:VOD/); assert.match(manifest, /#EXT-X-ENDLIST/);
  assert.ok(!/source\.example|private-cookie|secret=|\/tmp\//.test(manifest));
  const segments = manifest.split('\n').filter(line => line && !line.startsWith('#'));
  assert.ok(segments.length >= 3);
  const segmentURL = new URL(segments[1], manifestURL);
  const partial = await fetch(segmentURL, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 1024);
  assert.equal((await fetch(segmentURL, { method: 'HEAD' })).headers.get('content-type'), 'video/mp2t');
  assert.equal((await fetch(manifestURL.replace('index.m3u8', 'not-a-segment.txt'))).status, 404);
  await run(ffmpeg, ['-nostdin', '-v', 'error', '-ss', '8', '-i', manifestURL, '-frames:v', '1', '-an', '-f', 'null', '-']);
  const post = async (route, body) => (await fetch(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const receiver = await post('/api/tv/register', { clientId: 'compat-fixture' });
  await post('/api/controller/action', { action: 'play', episodeId: episode });
  // Cached preparation must produce an HLS command, never the original MP4 URL.
  let state;
  for (let i = 0; i < 20; i++) {
    state = await (await fetch(base + '/api/controller/state')).json();
    if (state.phase === 'loading') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(state.media.playback, 'remux');
  const response = await fetch(base + '/api/tv/poll', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Bangumi-TV': receiver.session
  }, body: JSON.stringify({ applied: 0, status: 'idle' }) });
  assert.match((await response.json()).commands[0].item.streamPath, /\/tv-hls\/index\.m3u8$/);
  const sessions = await readdir(cacheDir);
  assert.equal((await readdir(path.join(cacheDir, sessions[0]))).length, 1);
});

test('Stop during TV preparation discards the result and restores a queued episode', async () => {
  let finish, entered;
  const preparing = new Promise(resolve => { entered = resolve; });
  const discovery = { selection: () => ({ title: 'Episode' }), resolveSelection: async () => ({ item: { format: 'mp4' } }) };
  const controller = createController({ discovery, prepareTVItem: item => {
    entered(); return new Promise(resolve => { finish = () => resolve(item); });
  } });
  const receiver = controller.register({ clientId: 'prepare-fixture' });
  controller.mutate({ action: 'enqueue', episodeIds: ['episode'] }); controller.mutate({ action: 'next' });
  await preparing;
  assert.equal(controller.state().phase, 'preparing');
  controller.mutate({ action: 'stop' }); finish(); await controller.settled();
  assert.equal(controller.state().phase, 'idle'); assert.equal(controller.state().queue.length, 1);
  assert.ok(controller.poll(receiver.session, { applied: 0 }).commands.every(command => command.action !== 'play'));
});

test('missing FFmpeg releases the preparation slot, removes partial cache, and gives an actionable error', async t => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'bangumi-remux-failure-'));
  const id = 'anime-' + 'c'.repeat(32);
  const manager = createTVCompatibility({ cacheDir, ffmpeg: path.join(cacheDir, 'missing-ffmpeg'),
    stream: () => ({ format: 'mp4', url: 'https://source.example/?private=secret' }),
    inputURL: () => 'http://127.0.0.1:9999/stream/' + id });
  t.after(() => manager.close());
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(manager.prepare({ id, kind: 'remote', format: 'mp4' }), /Install FFmpeg/);
    assert.equal(manager.status().preparing, false);
  }
  const session = (await readdir(cacheDir))[0];
  assert.deepEqual(await readdir(path.join(cacheDir, session)), []);
  await assert.rejects(manager.file({ id }, '../../settings.local.json'), /Not found/);
});
