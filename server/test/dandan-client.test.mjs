import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDandanEnv, loadDandanApplication } from '../lib/dandan-application.mjs';
import { createDandanClient } from '../lib/dandan-client.mjs';
import { connectNipaplay } from '../lib/danmu-nipaplay.mjs';

const appId = 'test-app', appSecret = 'private-app-secret';
const row = { p: '1,1,16777215,u', m: 'native' };

test('private dotenv parser accepts only application credentials, never evaluates code or mutates process.env', () => {
  const original = { ...process.env };
  assert.deepEqual(parseDandanEnv('\uFEFFexport DANDAN_APP_ID = "test-app" # app\nDANDAN_APPLICATION_KEY=\'private#key\'\nHOST=evil\nNODE_TLS_REJECT_UNAUTHORIZED=0\nDANDAN_APP_SECRET=$(no-execution) # comment'),
    { DANDAN_APP_ID: appId, DANDAN_APPLICATION_KEY: 'private#key', DANDAN_APP_SECRET: '$(no-execution)' });
  assert.ok(Object.keys(process.env).length === Object.keys(original).length &&
    Object.entries(original).every(([key, value]) => process.env[key] === value), 'parser must not mutate the environment');
  assert.throws(() => parseDandanEnv('DANDAN_APPLICATION_KEY="private-app-secret'), error => !error.message.includes(appSecret));
});

test('application loader supports .env, deployment env and legacy settings with sanitized missing-key errors', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bangumi-dandan-app-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  assert.equal(await loadDandanApplication({ file, env: {} }), undefined);
  assert.deepEqual(await loadDandanApplication({ file, env: {}, fallback: { appId, appSecret } }), { appId, appSecret });
  await writeFile(file, 'DANDAN_APP_ID=test-app\nDANDAN_APPLICATION_KEY=private-app-secret\n', { mode: 0o600 });
  assert.deepEqual(await loadDandanApplication({ file, env: {} }), { appId, appSecret });
  assert.deepEqual(await loadDandanApplication({ file, env: { DANDAN_APP_ID: 'deployment', DANDAN_APP_SECRET: 'deployment-secret' } }),
    { appId: 'deployment', appSecret: 'deployment-secret' });
  await writeFile(file, 'DANDAN_APPLICATION_KEY=private-app-secret');
  await assert.rejects(loadDandanApplication({ file, env: {} }), error => /DANDAN_APP_ID/.test(error.message) && !error.message.includes(appSecret));
});

test('official requests sign path only and do not use account OAuth or expose secrets to CDN', async () => {
  const calls = [], now = 1735660800000;
  const client = createDandanClient({ appId, appSecret, now: () => now, fetcher: async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (new URL(url).hostname === 'cas2.dandanplay.net') return Response.json({ comments: [row] });
    if (url.includes('/comment/')) return new Response(null, { status: 302, headers: { location: 'https://cas2.dandanplay.net/1?sign=private-cdn-link' } });
    return Response.json(url.includes('/search/') ? { animes: [] } : { bangumi: { episodes: [] } });
  } });
  await client.search('Lycoris Recoil'); await client.details(123);
  assert.deepEqual((await client.comments(1230001)).comments, [row]);
  for (const { url, init } of calls.filter(call => call.url.hostname === 'api.dandanplay.net')) {
    assert.equal(init.redirect, 'manual'); assert.equal(init.headers['X-AppId'], appId);
    assert.equal(init.headers['X-Timestamp'], '1735660800');
    assert.equal(init.headers['X-Signature'], createHash('sha256').update(appId + '1735660800' + url.pathname + appSecret).digest('base64'));
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers['X-AppSecret'], undefined);
    assert.ok(!JSON.stringify(init).includes(appSecret));
  }
  const comment = calls.find(call => call.url.pathname.includes('/comment/'));
  assert.equal(comment.url.searchParams.get('withRelated'), 'true');
  assert.equal(comment.url.searchParams.get('chConvert'), '0');
  const cdn = calls.at(-1);
  assert.equal(cdn.init.redirect, 'error');
  assert.equal(cdn.init.headers['X-AppId'], undefined); assert.equal(cdn.init.headers['X-Signature'], undefined);
  assert.equal(cdn.init.body, undefined);
  assert.ok(calls.every(call => call.url.protocol === 'https:' && !call.url.pathname.includes('/login')));
});

test('official client rejects unsafe redirects, checks business failures and never reflects upstream errors', async () => {
  for (const location of ['http://cas2.dandanplay.net/1', 'https://evil.example/1', 'https://cas2.dandanplay.net.evil.example/1',
    'https://u:p@cas2.dandanplay.net/1', 'https://cas2.dandanplay.net:8443/1']) {
    let calls = 0;
    const client = createDandanClient({ appId, appSecret, fetcher: async () => {
      calls++; return new Response(null, { status: 302, headers: { location } });
    } });
    await assert.rejects(client.comments(123), /HTTPS/); assert.equal(calls, 1);
  }
  for (const fetcher of [async () => { throw new Error(appSecret); },
    async () => Response.json({ success: false, errorMessage: appSecret }),
    async () => new Response(appSecret, { status: 403 }), async () => new Response(appSecret)]) {
    await assert.rejects(createDandanClient({ appId, appSecret, fetcher }).search('title'), error => !error.message.includes(appSecret));
  }
  await assert.rejects(createDandanClient({ appId, appSecret }).comments('https://evil.example'), /编号/);
});

test('failed official CDN download preserves related links without ever forwarding authentication', async () => {
  const client = createDandanClient({ appId, appSecret, fetcher: async url => url.includes('/comment/')
    ? new Response(null, { status: 302, headers: { location: 'https://cas2.dandanplay.net/1?urls=public' } })
    : new Response(null, { status: 503 }) });
  const result = await client.comments(123);
  assert.deepEqual(result.comments, []); assert.ok(result.location);
});

function aggregationFixture({ primaryDown = false, supplementDown = false, bahamutDown = false } = {}) {
  const dandan = {}, calls = [];
  const primary = { search: async () => { if (primaryDown) throw new Error(appSecret); return [{ animeId: 123 }]; },
    details: async () => { if (primaryDown) throw new Error(appSecret); return { episodes: [{ episodeId: 1230001 }] }; },
    comments: async id => { calls.push(['official', id]); if (primaryDown) throw new Error(appSecret);
      return { comments: [row], location: 'https://cas2.dandanplay.net/official' }; } };
  const supplement = { search: async () => [{ animeId: 123 }], details: async () => ({ episodes: [{ episodeId: 1230001 }] }),
    comments: async id => { calls.push(['account', id]); if (supplementDown) throw new Error('account-private');
      return { comments: [row, { ...row, p: '2,1,16777215,u', m: 'supplemental native' }], location: 'https://cas2.dandanplay.net/account' }; } };
  const bahamut = { getEpisodeDanmu: async id => { calls.push(['bahamut', id]); if (bahamutDown) throw new Error('platform down'); return [{ m: 'bahamut' }]; },
    formatComments: data => data.map(item => ({ ...item, p: '3,1,16777215,u' })) };
  connectNipaplay({ client: primary, supplementalClient: supplement, getSourceByKey: key => key === 'dandan' ? dandan : bahamut,
    parseRelatedLinks: location => ({ bahamut: location.endsWith('/account') ? [{ url: 'https://ani.gamer.com.tw/animeVideo.php?sn=30008', shift: 2 }] : [] }),
    resolveLink: () => ({ source: 'bahamut', realId: '30008' }), applyShift: (item, shift) => ({ ...item, offset: shift }) });
  return { dandan, calls };
}

test('official native plus account-specific related enrichment preserves the union, not double-counted native comments', async () => {
  const { dandan, calls } = aggregationFixture();
  const comments = await dandan.getEpisodeDanmu(1230001);
  assert.deepEqual(comments.map(item => item.m), ['native', 'supplemental native', 'bahamut']);
  assert.equal(comments.at(-1).offset, 2); assert.equal(comments.at(-1).realTimeSource, 'bahamut');
  assert.deepEqual(calls, [['official', 1230001], ['account', 1230001], ['bahamut', '30008']]);
  assert.equal((await dandan.search('title'))[0].animeId, 123);
});

test('either channel can fail without losing the other; both failing stays an error, not false success', async () => {
  const fallback = aggregationFixture({ primaryDown: true });
  assert.equal((await fallback.dandan.getEpisodeDanmu(1230001)).length, 3);
  assert.equal((await fallback.dandan.search('title'))[0].animeId, 123);
  assert.equal((await fallback.dandan.getEpisodes(123)).episodes[0].episodeId, 1230001);
  assert.equal((await aggregationFixture({ supplementDown: true }).dandan.getEpisodeDanmu(1230001)).length, 1);
  assert.equal((await aggregationFixture({ bahamutDown: true }).dandan.getEpisodeDanmu(1230001)).length, 2);
  await assert.rejects(aggregationFixture({ primaryDown: true, supplementDown: true }).dandan.getEpisodeDanmu(1230001),
    error => !/private/.test(error.message) && /暂未返回/.test(error.message));
});

test('empty official search uses the account catalogue; shared associated video IDs are only fetched once', async () => {
  const dandan = {}; let fetched = 0;
  const client = { search: async () => [], comments: async () => ({ comments: [row], location: 'https://cas2.dandanplay.net/1' }) };
  const supplement = { search: async () => [{ animeId: 123 }], comments: client.comments };
  const bahamut = { getEpisodeDanmu: async () => { fetched++; return []; }, formatComments: rows => rows };
  connectNipaplay({ client, supplementalClient: supplement, getSourceByKey: key => key === 'dandan' ? dandan : bahamut,
    parseRelatedLinks: () => ({ bahamut: [{ url: 'https://ani.gamer.com.tw/animeVideo.php?sn=30008', shift: 2 }] }),
    resolveLink: () => ({ source: 'bahamut', realId: '30008' }), applyShift: row => row });
  assert.equal((await dandan.search('title'))[0].animeId, 123);
  assert.equal((await dandan.getEpisodeDanmu(1230001)).length, 1);
  assert.equal(fetched, 1);
});
