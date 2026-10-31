import test from 'node:test';
import assert from 'node:assert/strict';
import { createNipaplayClient, readDanmuJson } from '../lib/nipaplay-client.mjs';
import { connectNipaplay } from '../lib/danmu-nipaplay.mjs';
import { loadDanmuCredentials, danmuKeychainService } from '../lib/danmu-credentials.mjs';
import { createHeadlessAcquirer } from '../lib/headless-danmaku.mjs';

const row = { p: '1,1,16777215,u', m: 'native' };
function fixture(handle, options = {}) {
  const calls = [];
  const client = createNipaplayClient({ account: 'test-account', password: 'test-password', fetcher: async (url, init) => {
    const parsed = new URL(url); calls.push({ url: parsed, init });
    if (parsed.pathname.endsWith('/login')) return Response.json({ token: 'test-private-token', tokenExpireTime: '2099-01-01' });
    return handle(parsed, init);
  }, ...options });
  return { client, calls };
}

test('Keychain access is scoped to our service/account and errors never expose passwords', async () => {
  assert.equal(await loadDanmuCredentials(), undefined);
  let args;
  const credentials = await loadDanmuCredentials({ account: 'test-account', platform: 'darwin', run: async (...input) => {
    args = input; return { stdout: 'test-password\n' };
  } });
  assert.equal(credentials.password, 'test-password');
  assert.deepEqual(args[1], ['find-generic-password', '-s', danmuKeychainService, '-a', 'test-account', '-w']);
  await assert.rejects(loadDanmuCredentials({ account: 'test-account', platform: 'darwin', run: async () => { throw new Error('test-password'); } }), error => !error.message.includes('test-password'));
});

test('private credential files require the configured account and errors are sanitized', async () => {
  const credentials = await loadDanmuCredentials({ account: 'a', store: 'file', readPrivate: async () => ({ account: 'a', password: 'private-password' }) });
  assert.equal(credentials.password, 'private-password');
  await assert.rejects(loadDanmuCredentials({ account: 'a', store: 'file', readPrivate: async () => ({ account: 'wrong', password: 'private-password' }) }), /私有凭证/);
  await assert.rejects(loadDanmuCredentials({ account: 'a', store: 'file', readPrivate: async () => { throw new Error('private-password'); } }), error => !error.message.includes('private-password'));
});

test('parallel gateway operations share one login; signed CDN receives no account credentials', async () => {
  const { client, calls } = fixture(url => url.pathname.includes('/comment/')
    ? new Response(null, { status: 302, headers: { location: 'https://cas2.dandanplay.net/123?urls=public&sign=private-link' } })
    : Response.json(url.hostname === 'cas2.dandanplay.net' ? { comments: [row] } : { animes: [], bangumi: { episodes: [] } }));
  const [, , data] = await Promise.all([client.search('莉可丽丝'), client.details(123), client.comments(1230001)]);
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/login')).length, 1);
  assert.equal(data.comments.length, 1);
  assert.ok(calls.every(call => call.url.protocol === 'https:'));
  const cdn = calls.find(call => call.url.hostname === 'cas2.dandanplay.net');
  assert.equal(cdn.init.headers.Authorization, undefined);
  assert.equal(cdn.init.body, undefined);
  assert.equal(cdn.init.redirect, 'error');
  assert.ok(calls.filter(call => call.url.pathname.startsWith('/dandanplay/api/')).every(call => call.init.redirect === 'manual'));
});

test('gateway refuses plaintext, arbitrary hosts, userinfo and alternate ports in CDN redirects', async () => {
  for (const location of ['http://cas2.dandanplay.net/1', 'https://evil.example/1', 'https://cas2.dandanplay.net.evil.example/1',
    'https://u:p@cas2.dandanplay.net/1', 'https://cas2.dandanplay.net:8443/1']) {
    const { client, calls } = fixture(() => new Response(null, { status: 302, headers: { location } }));
    await assert.rejects(client.comments(123), /HTTPS/);
    assert.equal(calls.length, 2);
  }
});

test('expired tokens are reauthenticated once, not sent to another host', async () => {
  let queries = 0;
  const { client, calls } = fixture(() => ++queries === 1 ? new Response(null, { status: 401 }) : Response.json({ animes: [] }));
  await client.search('test');
  assert.equal(queries, 2);
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/login')).length, 2);
  assert.ok(calls.every(call => call.url.hostname === 'nipaplay.aimes-soft.com'));
});

test('renewal uses existing bearer token; network errors are safe and no HTTP fallback is attempted', async () => {
  let time = 0, logins = 0, renewals = 0;
  const client = createNipaplayClient({ account: 'a', password: 'private-password', now: () => time, fetcher: async (url, init) => {
    assert.ok(url.startsWith('https://nipaplay.aimes-soft.com/'));
    if (url.endsWith('/login')) { logins++; return Response.json({ token: 'old', tokenExpireTime: new Date(120000).toISOString() }); }
    if (url.endsWith('/renew')) { renewals++; assert.equal(init.headers.Authorization, 'Bearer old'); return Response.json({ token: 'new', tokenExpireTime: new Date(300000).toISOString() }); }
    return Response.json({ animes: [] });
  } });
  await client.search('a'); time = 90000; await client.search('b');
  assert.equal(logins, 1); assert.equal(renewals, 1);
  const broken = createNipaplayClient({ account: 'a', password: 'private-password', fetcher: async () => { throw new Error('private-password Bearer secret'); } });
  await assert.rejects(broken.search('a'), error => /HTTPS/.test(error.message) && !/private-password|Bearer/.test(error.message));
});

test('CDN errors still preserve related links; response size and episode IDs are bounded', async () => {
  const { client } = fixture(url => url.hostname === 'cas2.dandanplay.net' ? new Response(null, { status: 503 })
    : new Response(null, { status: 302, headers: { location: 'https://cas2.dandanplay.net/1?urls=public' } }));
  const result = await client.comments(123); assert.deepEqual(result.comments, []); assert.ok(result.location);
  await assert.rejects(client.comments('https://evil.example'), /编号/);
  await assert.rejects(readDanmuJson(new Response('x'.repeat(101)), 100), /4 MB/);
});

function bridge({ native = [row], related = [{ url: 'https://ani.gamer.com.tw/animeVideo.php?sn=30008', shift: 2 }], broken = false } = {}) {
  const dandan = {}, calls = [];
  const bahamut = {
    async getEpisodeDanmu(id) { calls.push(id); if (broken) throw new Error('platform down'); return [{ m: 'bahamut' }]; },
    formatComments: raw => raw.map(item => ({ ...item, p: '3,1,16777215,u', isRealTimePulled: true }))
  };
  connectNipaplay({ getSourceByKey: source => source === 'dandan' ? dandan : bahamut,
    client: { search: async () => [], details: async () => ({ episodes: [{ episodeId: 1230001 }], titles: [{ title: 'alias' }] }),
      comments: async () => ({ comments: native, location: 'https://cas2.dandanplay.net/1' }) },
    parseRelatedLinks: () => ({ bahamut: related }), resolveLink: () => ({ source: 'bahamut', realId: '30008' }),
    applyShift: (item, shift) => ({ ...item, offset: shift }) });
  return { dandan, calls };
}

test('aggregation includes native and Bahamut comments, preserves offset, and does not fetch a duplicate link', async () => {
  const link = { url: 'https://ani.gamer.com.tw/animeVideo.php?sn=30008', shift: 2 };
  const { dandan, calls } = bridge({ related: [link, link] });
  const comments = await dandan.getEpisodeDanmu(1230001);
  assert.deepEqual(calls, ['30008']); assert.equal(comments.length, 2);
  assert.equal(comments[0].m, 'native'); assert.equal(comments[1].realTimeSource, 'bahamut'); assert.equal(comments[1].offset, 2);
  assert.deepEqual((await dandan.getEpisodes(123)).titles, ['alias']);
});

test('related source failure preserves native comments; related-only data also works', async () => {
  assert.equal((await bridge({ broken: true }).dandan.getEpisodeDanmu(1230001)).length, 1);
  assert.equal((await bridge({ native: [] }).dandan.getEpisodeDanmu(1230001)).length, 1);
  await assert.rejects(bridge({ native: [], broken: true }).dandan.getEpisodeDanmu(1230001), /暂未返回/);
});

test('headless acquisition prefers rich online results; verified cache is only an exact-match failure fallback', async () => {
  let fail = false, reads = 0;
  const cache = { list: async () => ({ items: [{ id: 'wrong', title: '莉可丽丝 新作', episode: 1 },
    { id: 'old', title: '莉可丽丝', episode: 1, updatedAt: 1 }] }), read: async id => { reads++; assert.equal(id, 'old'); return { content: 'cache', source: 'verified' }; } };
  const acquire = createHeadlessAcquirer({ provider: { acquire: async () => { if (fail) throw new Error('offline'); return { content: 'richer', source: 'online' }; } }, cache });
  const request = { title: '莉可丽丝', episode: 1 };
  assert.equal((await acquire(request)).content, 'richer'); assert.equal(reads, 0);
  fail = true; assert.equal((await acquire(request)).content, 'cache'); assert.equal(reads, 1);
  await assert.rejects(acquire({ ...request, episode: 2 }), /offline/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(acquire({ ...request, signal: abort.signal })); assert.equal(reads, 1);
});
