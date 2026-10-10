import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../app.mjs';
import { parseRange } from '../lib/media.mjs';
import { createReferences, rewriteManifest } from '../lib/hls.mjs';
import { isPrivateAddress, validateRemoteURL, requestUpstream } from '../lib/upstream.mjs';

test('byte ranges preserve exact bytes and reject unsatisfiable/multipart ranges', () => {
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=0-999', 10), { start: 0, end: 9 });
  for (const value of ['bytes=10-', 'bytes=9-2', 'bytes=0-1,4-5', 'bytes=-0', 'bytes=-']) assert.equal(parseRange(value, 10), false);
});

test('HLS rewriting covers child playlists, keys, init maps, renditions and segments', () => {
  const input = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="../subs/list.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nchild/list.m3u8\n#EXTINF:6,\n//cdn.example/segment.ts\n';
  const rewritten = rewriteManifest(input, 'https://source.example/show/master.m3u8', url => 'PROXY:' + url);
  assert.match(rewritten, /URI="PROXY:https:\/\/source.example\/show\/key.bin"/);
  assert.match(rewritten, /URI="PROXY:https:\/\/source.example\/show\/init.mp4"/);
  assert.match(rewritten, /URI="PROXY:https:\/\/source.example\/subs\/list.m3u8"/);
  assert.match(rewritten, /PROXY:https:\/\/source.example\/show\/child\/list.m3u8/);
  assert.match(rewritten, /PROXY:https:\/\/cdn.example\/segment.ts/);
  assert.throws(() => rewriteManifest('not a playlist', 'https://example.com/', String));
});

test('HLS references cannot be changed or used for a different library source', () => {
  const refs = createReferences('test-secret');
  const token = refs.encode('episode', 'https://example.com/segment.ts?token=secret');
  assert.equal(refs.decode('episode', token), 'https://example.com/segment.ts?token=secret');
  assert.throws(() => refs.decode('other-episode', token));
  assert.throws(() => refs.decode('episode', token + 'x'));
});

test('remote URL validation prevents local network proxying', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.20', '172.16.0.1', '169.254.169.254', '::1', '::ffff:7f00:1', 'fd00::1']) assert.equal(isPrivateAddress(address), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.throws(() => validateRemoteURL('file:///etc/passwd'));
  assert.throws(() => validateRemoteURL('https://user:password@example.com/video'));
  await assert.rejects(requestUpstream('http://127.0.0.1/video', { source: { url: 'http://127.0.0.1/video' } }), /private network/);
});

async function fixture(t, upstream) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bangumi-tv-test-'));
  const mediaDir = path.join(directory, 'media'); await mkdir(mediaDir);
  await writeFile(path.join(mediaDir, 'Episode.mp4'), '0123456789');
  await writeFile(path.join(mediaDir, 'Episode.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n');
  const sourcesFile = path.join(directory, 'sources.json');
  await writeFile(sourcesFile, JSON.stringify({ sources: [
    { id: 'hls', title: 'HLS source', url: 'https://source.example/master.m3u8', referer: 'https://source.example/', cookie: 'secret=private', format: 'hls' },
    { id: 'mp4', title: 'MP4 source', url: 'https://source.example/video.mp4' }
  ] }));
  const server = createApp({ mediaDir, sourcesFile, upstream });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // Keep small temporary fixtures available for diagnosing a failed test.
  });
  return { base: 'http://127.0.0.1:' + server.address().port, directory, mediaDir };
}

test('library, subtitles, GET/HEAD and seek ranges work without exposing source secrets', async t => {
  const { base } = await fixture(t);
  const library = await (await fetch(base + '/api/library')).json();
  assert.equal(library.items.length, 3);
  assert.ok(!JSON.stringify(library).includes('secret=private'));
  assert.ok(!JSON.stringify(library).includes('source.example'));
  const local = library.items.find(item => item.kind === 'local');
  const partial = await fetch(base + local.streamPath, { headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await partial.text(), '2345');
  const head = await fetch(base + local.streamPath, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  assert.equal((await fetch(base + local.streamPath, { headers: { Range: 'bytes=99-' } })).status, 416);
  assert.match(await (await fetch(base + local.subtitlePath)).text(), /Hello/);
  assert.equal((await fetch(base + '/api/library', { method: 'POST' })).status, 405);
});

test('only TV public assets are served; traversal, source config and symlinks stay private', async t => {
  const { base, directory, mediaDir } = await fixture(t);
  await writeFile(path.join(directory, 'secret.mp4'), 'private');
  await symlink(path.join(directory, 'secret.mp4'), path.join(mediaDir, 'escape.mp4'));
  assert.equal((await fetch(base + '/sources.json')).status, 404);
  assert.equal((await fetch(base + '/server/sources.json')).status, 404);
  assert.equal((await fetch(base + '/tv/%2e%2e%2fserver%2fsources.json')).status, 404);
  assert.equal((await fetch(base + '/tv/app.js')).status, 200);
  const library = await (await fetch(base + '/api/library')).json();
  assert.equal(library.items.filter(item => item.title === 'escape').length, 0);
});

test('HLS playlist, signed segment and key requests are served through the Mac', async t => {
  const requests = [];
  const upstream = async (url, options) => {
    requests.push({ url, ...options });
    const manifest = url.endsWith('master.m3u8');
    const data = manifest ? '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n' : 'exact-original-bytes';
    return { stream: Readable.from([Buffer.from(data)]), url, status: 200,
      headers: { 'content-type': manifest ? 'application/vnd.apple.mpegurl' : 'video/mp2t', 'content-length': String(Buffer.byteLength(data)) } };
  };
  const { base } = await fixture(t, upstream);
  const response = await fetch(base + '/stream/remote-hls');
  const playlist = await response.text();
  const segmentPath = playlist.split('\n').find(line => line.startsWith('/stream/'));
  const keyPath = /URI="([^"]+)"/.exec(playlist)[1];
  assert.equal(await (await fetch(base + segmentPath)).text(), 'exact-original-bytes');
  assert.equal(await (await fetch(base + keyPath)).text(), 'exact-original-bytes');
  assert.equal(requests[1].url, 'https://source.example/segment.ts');
  assert.equal(requests[2].url, 'https://source.example/key.bin');
  assert.equal(requests[1].source.referer, 'https://source.example/');
  const head = await fetch(base + '/stream/remote-hls', { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(playlist)));
  assert.equal(await head.text(), '');
  assert.equal((await fetch(base + segmentPath + 'tampered')).status, 403);
});

test('remote MP4 forwards upstream range metadata and exact content', async t => {
  const upstream = async (url, options) => {
    assert.equal(options.range, 'bytes=2-5');
    return { stream: Readable.from([Buffer.from('2345')]), url, status: 206,
      headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 2-5/10', 'content-length': '4', 'accept-ranges': 'bytes' } };
  };
  const { base } = await fixture(t, upstream);
  const response = await fetch(base + '/stream/remote-mp4', { headers: { Range: 'bytes=2-5' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await response.text(), '2345');
});

test('HLS root and child playlists retain the extension needed by Samsung adaptive playback', async t => {
  const upstream = async url => ({ url, status: 200,
    headers: { 'content-type': 'application/vnd.apple.mpegurl' },
    stream: Readable.from([Buffer.from(url.includes('master.m3u8') ?
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nchild.m3u8\n' : '#EXTM3U\n#EXTINF:6,\nsegment.ts\n')]) });
  const { base } = await fixture(t, upstream);
  const library = await (await fetch(base + '/api/library')).json();
  const item = library.items.find(item => item.id === 'remote-hls');
  assert.ok(item.streamPath.endsWith('/index.m3u8'));
  const root = await (await fetch(base + item.streamPath)).text();
  const child = root.split('\n').find(line => line.startsWith('/stream/'));
  assert.ok(child.endsWith('.m3u8'));
  assert.match(await (await fetch(base + child)).text(), /#EXTINF/);
});

test('source errors become actionable API errors without pretending playback succeeded', async t => {
  const { base } = await fixture(t, async url => ({ url, status: 403, headers: {}, stream: Readable.from([]) }));
  const response = await fetch(base + '/stream/remote-hls');
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /403/);
});
