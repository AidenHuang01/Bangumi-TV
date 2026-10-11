import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createKazumiClient, kazumiCommit } from '../lib/kazumi-client.mjs';
import { createDiscovery } from '../lib/discovery.mjs';

const token = 'ab'.repeat(32);
const health = { engine: 'kazumi', upstreamCommit: kazumiCommit, parser: 'VideoWebviewAppleImpl', upstreamVersion: '2.3.8' };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('Kazumi bridge rejects non-loopback endpoints and missing session tokens', () => {
  for (const baseURL of ['http://10.0.0.30:8789/', 'https://127.0.0.1:8789/', 'http://127.0.0.1:8789/?token=x']) {
    assert.throws(() => createKazumiClient({ baseURL, token }));
  }
  assert.throws(() => createKazumiClient({ baseURL: 'http://127.0.0.1:8789/', token: '' }));
});

test('actual core adapter owns search, chapters and extraction; gateway keeps opaque IDs and validates video bytes', async () => {
  const operations = []; let closed = false;
  const core = createKazumiClient({ baseURL: 'http://127.0.0.1:8789/', token, close: async () => { closed = true; },
    fetcher: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer ' + token);
      assert.equal(options.redirect, 'error');
      const input = options.body && JSON.parse(options.body); operations.push(url.pathname);
      if (url.pathname === '/health') return response(health);
      assert.equal(input.provider, 'fixture');
      if (url.pathname === '/search') return response({ items: [{ title: 'Frieren', source: 'https://source.example/show' }] });
      if (url.pathname === '/chapters') return response({ roads: [{ name: 'Kazumi source 1', episodes: [{ name: '01', url: 'https://source.example/episode' }] }] });
      return response({ url: 'https://video.example/episode.mp4?private=secret', userAgent: 'WKWebView',
        referer: 'https://source.example/episode', cookie: 'private=cookie', format: 'mp4' });
    } });
  // No XPath/JSON selectors: independently parsing this fixture cannot succeed.
  const discovery = createDiscovery({ rules: [{ id: 'fixture', name: 'fixture' }], core,
    upstream: async (url, options) => {
      assert.equal(options.source.cookie, 'private=cookie');
      assert.equal(options.range, 'bytes=0-1023');
      return { url, status: 206, headers: { 'content-type': 'video/mp4' }, stream: Readable.from([Buffer.from('....ftypisom')]) };
    } });
  try {
    assert.deepEqual(await discovery.engineInfo(), health);
    const search = await discovery.search('葬送的芙莉莲');
    const show = await discovery.show(search.items[0].id);
    const resolved = await discovery.resolve(show.roads[0].episodes[0].id);
    const publicJSON = JSON.stringify({ search, show, resolved });
    assert.doesNotMatch(publicJSON, /source\.example|video\.example|private=cookie|private=secret|abababab/);
    assert.match(resolved.item.description, /^Kazumi core/);
    assert.equal(discovery.stream(resolved.item.id).cookie, 'private=cookie');
    assert.deepEqual(operations, ['/health', '/search', '/chapters', '/resolve']);
  } finally { await discovery.close(); }
  assert.equal(closed, true);
});

test('core errors cannot leak provider URLs, cookies or arbitrary worker exceptions', async () => {
  const core = createKazumiClient({ baseURL: 'http://127.0.0.1:8789/', token,
    fetcher: async () => response({ error: 'https://secret.example/?cookie=private stack trace' }, 502) });
  await assert.rejects(core.search({ id: 'fixture' }, 'test'), { message: 'Kazumi core request failed.' });
});

test('API source IDs stay opaque through search and chapter request templates', async () => {
  const rule = { id: 'sorani', chapterMode: 'api', baseURL: 'https://source.example/' };
  const core = createKazumiClient({ baseURL: 'http://127.0.0.1:8789/', token,
    fetcher: async (url, options) => {
      if (url.pathname === '/search') return response({ items: [{ title: 'Frieren', source: '12345' }] });
      assert.equal(JSON.parse(options.body).source, '12345');
      return response({ roads: [] });
    } });
  const items = await core.search(rule, 'Frieren');
  assert.equal(items[0].source, '12345');
  assert.deepEqual(await core.chapters(rule, items[0].source), []);
});

test('health must prove the pinned original native parser; extraction rejects header injection', async () => {
  const core = createKazumiClient({ baseURL: 'http://127.0.0.1:8789/', token,
    fetcher: async url => response(url.pathname === '/health' ? { ...health, upstreamCommit: 'wrong' } :
      { url: 'https://video.example/a.mp4', cookie: 'cookie\r\nHost: bad', userAgent: 'WKWebView' }) });
  await assert.rejects(core.health(), /version does not match/);
  const source = await core.resolve({ rule: { id: 'fixture' }, url: 'https://source.example/ep' });
  assert.equal(source.cookie, undefined);
  assert.equal(source.userAgent, 'WKWebView');
});

test('a Kazumi extraction failure never falls back to the legacy parser', async () => {
  let calls = 0;
  const core = { search: async () => [{ title: 'Frieren', source: 'https://source.example/show' }],
    chapters: async () => [{ name: '1', episodes: [{ name: '01', url: 'https://source.example/ep' }] }],
    resolve: async () => { throw new Error('Kazumi failed'); }, close: async () => {} };
  const discovery = createDiscovery({ core, rules: [{ id: 'fixture' }], upstream: async () => { calls++; throw new Error('Legacy request'); } });
  try {
    const found = await discovery.search('Frieren');
    const show = await discovery.show(found.items[0].id);
    await assert.rejects(discovery.resolve(show.roads[0].episodes[0].id), /Kazumi failed/);
    assert.equal(calls, 0);
  } finally { await discovery.close(); }
});
