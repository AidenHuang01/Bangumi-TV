import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { browserSource, createResolver, sourceFailure, parserFailure, responseFailure } from '../lib/resolver.mjs';
import { upstreamHeaders } from '../lib/upstream.mjs';

const episode = { url: 'https://catalog.example/play/1', rule: { baseURL: 'https://catalog.example/' } };
const player = 'https://player.example/embed?session=private';
const api = 'https://player.example/api/parse';
const video = 'https://cdn.example/episode.m3u8?token=private';
const response = (url, body, status = 200, type = 'text/html') => ({ url, status,
  headers: { 'content-type': type }, stream: Readable.from([Buffer.from(body)]) });
function request(url, type = 'fetch', headers = {}, frame = player) {
  return { url: () => url, resourceType: () => type, frame: () => ({ url: () => frame }),
    isNavigationRequest: () => type === 'document', method: () => type === 'fetch' ? 'POST' : 'GET',
    postDataBuffer: () => type === 'fetch' ? Buffer.from('{"episode":1}') : null,
    headers() { throw new Error('Do not use the incomplete browser headers API'); },
    async allHeaders() { return headers; } };
}

test('iframe requests preserve full Origin/Referer and scoped browser cookies', async () => {
  const source = await browserSource(request(api, 'fetch', { origin: 'https://player.example',
    referer: player, cookie: 'player_session=private', 'user-agent': 'fixture-browser' }), episode);
  assert.equal(source.referer, player);
  assert.equal(source.headers.origin, 'https://player.example');
  assert.equal(source.cookie, 'player_session=private');
  assert.equal(source.userAgent, 'fixture-browser');
  const fallback = await browserSource(request(api), episode);
  assert.equal(fallback.referer, player); // Never replace an iframe API referrer with the catalog.
  const overridden = await browserSource(request(api, 'fetch', { referer: player }),
    { ...episode, rule: { ...episode.rule, referer: 'https://configured.example/' } });
  assert.equal(overridden.referer, 'https://configured.example/');
});

test('transport forwards allowlisted browser semantics, not arbitrary sensitive/hop-by-hop headers', () => {
  const options = { source: { url: api, cookie: 'session=private', referer: player, userAgent: 'fixture-browser',
    headers: { origin: 'https://player.example', accept: 'application/json', 'accept-language': 'en-US',
      'x-requested-with': 'XMLHttpRequest', host: '127.0.0.1', authorization: 'private',
      cookie: 'unscoped=private', connection: 'keep-alive', 'accept-encoding': 'gzip' } },
    body: Buffer.from('{"episode":1}'), contentType: 'application/json' };
  const headers = upstreamHeaders(new URL(api), options);
  assert.equal(headers.origin, 'https://player.example');
  assert.equal(headers.Referer, player); assert.equal(headers.Cookie, 'session=private');
  assert.equal(headers['Content-Type'], 'application/json'); assert.equal(headers['Content-Length'], 13);
  assert.equal(headers['Accept-Encoding'], 'identity');
  for (const name of ['host', 'authorization', 'cookie', 'connection']) assert.equal(headers[name], undefined);
  assert.equal(upstreamHeaders(new URL('https://other.example/redirect'), options).Cookie, undefined);
  assert.equal(upstreamHeaders(new URL(api), { source: { headers: { origin: 'bad\r\nInjected: yes' } } }).origin, undefined);
});

test('recognized parser failures become useful errors without echoing provider secrets', () => {
  const rejected = parserFailure(403, Buffer.from('{"msg":"非法来源 private-token"}'));
  assert.match(sourceFailure(rejected, api, 'Player API'), /rejected the request origin\/referrer/);
  const decode = parserFailure(400, Buffer.from('{"msg":"url 解密失败","key":"private-token"}'));
  const text = sourceFailure(decode, api, 'Player API');
  assert.match(text, /could not decode the episode link/); assert.ok(!text.includes('private-token'));
  assert.equal(parserFailure(200, Buffer.from('{"code":200,"url":"private-url"}')), null);
  assert.equal(parserFailure(200, Buffer.from('encrypted non-JSON response')), null);
  assert.equal(parserFailure(200, Buffer.from('{"code":403,"msg":"非法来源"}')).sourceReason, 'origin');
});

// Exercise the resolver's actual route handler without a live CDN or browser installation.
function fixtureBrowser(steps) {
  let handler, didClose = false;
  const page = { on() {}, locator: () => ({ first: () => ({ async click() {} }) }),
    async goto() {
      for (const step of steps) await handler({ request: () => step,
        async fulfill() {}, async abort() {} });
    } };
  const context = { on() {}, async routeWebSocket() {}, async route(_pattern, callback) { handler = callback; },
    async newPage() { return page; }, async close() { didClose = true; } };
  return { browserFactory: async () => ({ async newContext() { return context; }, async close() {} }),
    didClose: () => didClose };
}

test('iframe parser JSON POST reaches upstream with its own origin/referrer and returns playable HLS', async () => {
  const fixture = fixtureBrowser([request(api, 'fetch', { origin: 'https://player.example', referer: player,
    'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' }),
  request(video, 'media', { origin: 'https://player.example', referer: player })]);
  let parserCalled = false;
  const resolver = createResolver({ ...fixture, timeoutMs: 200, upstream: async (url, options) => {
    if (url === episode.url) return response(url, '<p>Player needs JavaScript</p>');
    if (url === api) {
      parserCalled = true;
      const headers = upstreamHeaders(new URL(url), options);
      assert.equal(headers.origin, 'https://player.example'); assert.equal(headers.Referer, player);
      assert.equal(options.method, 'POST'); assert.equal(headers['Content-Type'], 'application/json');
      assert.equal(options.body.toString(), '{"episode":1}');
      return response(url, '{}', 200, 'application/json');
    }
    if (url === 'https://cdn.example/episode.ts') return response(url, 'original video bytes', 206, 'video/mp2t');
    assert.equal(url, video);
    return response(url, '#EXTM3U\n#EXTINF:5,\nepisode.ts\n', 200, 'application/vnd.apple.mpegurl');
  } });
  try {
    const result = await resolver.resolve(episode);
    assert.ok(parserCalled); assert.equal(result.format, 'hls'); assert.equal(result.url, video);
    assert.equal(result.referer, player); assert.equal(result.headers.origin, 'https://player.example');
    assert.ok(fixture.didClose());
  } finally { await resolver.close(); }
});

test('parser rejection reports its host and HTTP status, never its session/query or response secrets', async () => {
  const fixture = fixtureBrowser([request(api)]);
  const resolver = createResolver({ ...fixture, timeoutMs: 80, upstream: async url =>
    url === episode.url ? response(url, '<p>Player</p>') : response(url, '{"msg":"private secret"}', 403, 'application/json') });
  try {
    await assert.rejects(resolver.resolve(episode), error => {
      assert.match(error.message, /Player API at player\.example returned HTTP 403/);
      assert.ok(!/private|secret|45 seconds/.test(error.message)); return true;
    });
    assert.ok(fixture.didClose());
  } finally { await resolver.close(); }
});

test('media TLS failures take precedence over unrelated parser errors and static errors do not mask success', async () => {
  const fixture = fixtureBrowser([request(api), request(video, 'media')]);
  const resolver = createResolver({ ...fixture, timeoutMs: 80, upstream: async url => {
    if (url === episode.url) return response(url, '<p>Player</p>');
    if (url === api) return response(url, '{}', 403);
    throw Object.assign(new Error('TLS error with private-token'), { code: 'EPROTO' });
  } });
  try {
    await assert.rejects(resolver.resolve(episode), /Video source at cdn\.example failed its TLS connection/);
  } finally { await resolver.close(); }
  assert.ok(!sourceFailure(new Error('HTTP 403 private-token'), video).includes('private'));
});

test('successful resolution aborts outstanding resolver transfers before closing the browser context', async () => {
  const fixture = fixtureBrowser([request(video, 'media')]);
  let mediaSignal;
  const resolver = createResolver({ ...fixture, timeoutMs: 200, upstream: async (url, options) => {
    if (url === episode.url) return response(url, '<p>Player</p>');
    mediaSignal = options.signal;
    if (url.endsWith('.ts')) return response(url, 'original video bytes', 206, 'video/mp2t');
    return response(url, '#EXTM3U\n#EXTINF:5,\nepisode.ts\n', 200, 'application/vnd.apple.mpegurl');
  } });
  try {
    await resolver.resolve(episode);
    assert.equal(mediaSignal.aborted, true); assert.ok(fixture.didClose());
  } finally { await resolver.close(); }
});

test('HLS resolution checks a child playlist and first segment rather than accepting an unplayable root', async () => {
  const fixture = fixtureBrowser([request(video, 'media')]);
  const urls = [];
  const resolver = createResolver({ ...fixture, timeoutMs: 200, upstream: async (url, options) => {
    if (url === episode.url) return response(url, '<p>Player</p>');
    urls.push(url);
    if (url === video) return response(url, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nchild.m3u8\n');
    if (url.endsWith('/child.m3u8')) return response(url, '#EXTM3U\n#EXTINF:5,\nfirst.ts\n');
    assert.equal(options.range, undefined);
    return response(url, 'original video bytes', 206, 'video/mp2t');
  } });
  try {
    const result = await resolver.resolve(episode); assert.equal(result.format, 'hls');
    assert.deepEqual(urls, [video, 'https://cdn.example/child.m3u8', 'https://cdn.example/first.ts']);
  } finally { await resolver.close(); }
});

test('a region-blocked HLS segment fails promptly with its CDN host, never a false playable stream', async () => {
  const fixture = fixtureBrowser([request(video, 'media')]);
  const resolver = createResolver({ ...fixture, timeoutMs: 5000, upstream: async url => {
    if (url === episode.url) return response(url, '<p>Player</p>');
    if (url === video) return response(url, '#EXTM3U\n#EXTINF:5,\nhttps://blocked.example/first.ts?token=private\n');
    return response(url, '403 Forbidden: The region has been denied. private-IP-and-token', 403);
  } });
  try {
    await assert.rejects(resolver.resolve(episode), error => {
      assert.match(error.message, /blocked\.example blocks playback from this Mac's region/);
      assert.ok(!error.message.includes('private')); return true;
    });
    assert.ok(fixture.didClose());
  } finally { await resolver.close(); }
  assert.match(sourceFailure(responseFailure(403, Buffer.from('The region has been denied.'), video), video), /region/);
});
