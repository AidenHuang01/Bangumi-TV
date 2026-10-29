import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKazumiAcquirer, findKazumiSubject, createKazumiUIDriver, createKazumiLifecycle, officialAppPath } from '../lib/kazumi-acquire.mjs';
import { createVerifiedKazumiCache } from '../lib/verified-kazumi-cache.mjs';
import { createApp } from '../app.mjs';
import { createDanmaku } from '../lib/danmaku.mjs';

test('subject lookup needs one exact metadata match, not a sequel or ambiguous duplicate', async () => {
  let data = [{ id: 2, name_cn: '命运石之门0' }, { id: 1, name_cn: '命运石之门' }];
  const upstream = async url => ({ status: 200, headers: {}, stream: Readable.from([Buffer.from(JSON.stringify(
    url.includes('/search/') ? { data } : data.find(item => item.id === Number(url.split('/').at(-1)))
  ))]) });
  assert.equal((await findKazumiSubject('命运石之门', { upstream })).id, 1);
  data.push({ id: 3, name_cn: '命运石之门' });
  await assert.rejects(findKazumiSubject('命运石之门', { upstream }), /唯一/);
});

test('UI arguments are data passed to a fixed script without shell interpolation', async () => {
  let command;
  const driver = createKazumiUIDriver({ run: async (...args) => { command = args; return { stdout: '{"ok":true}' }; } });
  const label = '$(touch nope); "quoted"';
  await driver({ action: 'press', label });
  assert.equal(command[0], '/usr/bin/osascript');
  assert.equal(JSON.parse(command[1].at(-1)).label, label);
  assert.equal(command[2].shell, undefined);
});

function scenario(options = {}) {
  let phase = 'home', expanded = false, chosen = false, queued = false, approved = [], stops = 0;
  const actions = [], row = (label, role = 'AXButton') => ({ label, role, enabled: true });
  const entry = { id: 'a'.repeat(32), bangumiId: '10380', episode: 2, updatedAt: 100 };
  const cache = { list: async () => ({ items: queued ? [entry] : [] }),
    read: async () => ({ content: JSON.stringify({ danmakus: [{ m: 'test', p: '1,1,16777215,u' }] }) }) };
  const ui = async input => {
    if (input.action !== 'snapshot') actions.push(input);
    if (options.beforeUI) { const value = await options.beforeUI(input); if (value !== undefined) return value; }
    if (input.action === 'readiness') return { ready: true, windows: 1 };
    if (input.action === 'prepare') return { originalSize: [1280, 860] };
    if (input.action === 'player-state') return { ready: phase === 'player' };
    if (input.action === 'snapshot') {
      return { rows: phase === 'home' ? [row('推荐\n第 1 个标签，共 4 个')] : phase === 'search' ? [row('', 'AXTextField')] :
        phase === 'results' ? [row('命运石之门\n8.5\n2011', 'AXImage')] :
        phase === 'info' ? [row('命运石之门', 'AXStaticText'), row('开始观看')] : phase === 'sources' ?
        [row('7 个来源 · 2 个结果', 'AXStaticText'), row('来源规则：AGE，2 个结果'),
          row('播放 命运石之门0，来源 AGE'), ...(expanded ? [row('播放 命运石之门，来源 AGE')] : [row('展开全部 2 个结果', 'AXStaticText')])] :
        phase === 'sheet' ? [row('下载选集', 'AXGroup'), row('第02集', 'AXStaticText'), ...(chosen ? [row('下载 1 集')] : [])] : [] };
    }
    if (input.action === 'home-search') phase = 'search';
    if (input.action === 'search-text') phase = 'results';
    if (input.label === '命运石之门\n8.5\n2011') phase = 'info';
    if (input.label === '开始观看') phase = 'sources';
    if (input.label === '展开全部 2 个结果') expanded = true;
    if (input.label === '播放 命运石之门，来源 AGE') phase = 'player';
    if (input.action === 'download-sheet') phase = 'sheet';
    if (input.label === '第02集') chosen = true;
    if (input.label === '下载 1 集') queued = true;
    return { ok: true };
  };
  const acquire = createKazumiAcquirer({ platform: 'darwin', cache, ui,
    subject: async () => ({ id: 10380, aliases: ['命运石之门'] }),
    lifecycle: { start: async () => {}, stop: async () => { stops++; } },
    wait: async () => {}, onCache: async item => approved.push(item), ...options });
  return { acquire, actions, approved, cache, stops: () => stops };
}

test('official acquisition expands results, rejects the sequel, selects only one episode and approves its new valid cache', async () => {
  const f = scenario(); const data = await f.acquire({ title: '命运石之门', episode: 2, provider: 'AGE' });
  assert.match(data.content, /test/); assert.equal(f.stops(), 1);
  assert.equal(f.approved.length, 1);
  assert.ok(f.actions.some(input => input.label === '播放 命运石之门，来源 AGE'));
  assert.ok(!f.actions.some(input => input.label?.includes('命运石之门0')));
  assert.deepEqual(f.actions.filter(input => input.label?.startsWith('下载 ')).map(input => input.label), ['下载 1 集']);
});

test('permission errors are actionable without leaking diagnostics, and cancelled queued jobs do not touch UI', async () => {
  const f = scenario({ ui: async () => { throw Object.assign(new Error('private'), { stderr: 'osascript not allowed assistive access -25211' }); } });
  await assert.rejects(f.acquire({ title: '命运石之门', episode: 2 }), error => /辅助功能/.test(error.publicMessage) && !/private/.test(error.message));
  assert.equal(f.stops(), 1);
  const abort = new AbortController(); abort.abort();
  const g = scenario(); await g.acquire({ title: '命运石之门', episode: 2, signal: abort.signal });
  assert.equal(g.actions.length, 0);
});

test('old or changed caches are never automatically trusted; approved provenance survives restart', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bangumi-provenance-test-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  let item = { id: 'b'.repeat(32), updatedAt: 10 };
  const cache = { list: async () => ({ items: [item] }), read: async () => ({ content: '{}' }) };
  const file = path.join(dir, 'approved.json'), verified = createVerifiedKazumiCache(cache, { file });
  await writeFile(file, JSON.stringify({ [item.id]: item.updatedAt }));
  assert.equal((await verified.list()).items.length, 0);
  await verified.approve(item); assert.equal((await verified.list()).items.length, 1);
  assert.equal((await createVerifiedKazumiCache(cache, { file }).list()).items.length, 1);
  item = { ...item, updatedAt: 11 }; assert.equal((await verified.list()).items.length, 0);
});

test('live provenance registry sees a separately approved export without a gateway restart', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bangumi-live-provenance-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = { id: 'a'.repeat(32), updatedAt: 100 }, second = { id: 'b'.repeat(32), updatedAt: 200 };
  const cache = { list: async () => ({ items: [first, second] }), read: async () => ({ content: '{}' }) };
  const file = path.join(dir, 'approved.json'), live = createVerifiedKazumiCache(cache, { file });
  assert.equal((await live.list()).items.length, 0);
  await live.approve(first);
  await createVerifiedKazumiCache(cache, { file }).approve(second);
  assert.deepEqual((await live.list()).items, [first, second]);
  await writeFile(file, '{invalid'); assert.equal((await live.list()).items.length, 0);
});

test('cold launch polls window readiness and retries only a transient prepare race', async () => {
  let checks = 0, prepares = 0;
  const f = scenario({ beforeUI: input => {
    if (input.action === 'readiness') return { ready: ++checks > 3, windows: checks > 3 ? 1 : 0 };
    if (input.action === 'prepare' && ++prepares === 1) throw Object.assign(new Error('race'), { uiCode: 'UI_WINDOW_NOT_READY' });
  } });
  await f.acquire({ title: '命运石之门', episode: 2 });
  assert.equal(checks, 5); assert.equal(prepares, 2); assert.equal(f.approved.length, 1); assert.equal(f.stops(), 1);
  assert.equal(f.actions.filter(input => input.label === '下载 1 集').length, 1);
});

test('startup timeout and permission failure stop the owned app and log only safe stage/action codes', async () => {
  const events = [];
  const f = scenario({ startupAttempts: 3, onEvent: event => events.push(event),
    beforeUI: input => input.action === 'readiness' ? { ready: false, windows: 0 } : undefined });
  await assert.rejects(f.acquire({ title: '命运石之门', episode: 2 }), /启动窗口未就绪/);
  assert.equal(f.actions.length, 3); assert.equal(f.stops(), 1);
  assert.ok(events.some(event => event.stage === 'failed' && event.action === 'readiness'));
  const g = scenario({ onEvent: event => events.push(event), beforeUI: () => {
    throw Object.assign(new Error('private clipboard/diagnostics'), { uiCode: 'UI_PERMISSION' });
  } });
  await assert.rejects(g.acquire({ title: '命运石之门', episode: 2 }), /辅助功能/);
  assert.equal(g.actions.length, 1); assert.equal(g.stops(), 1);
  assert.ok(events.some(event => event.code === 'UI_PERMISSION'));
  assert.doesNotMatch(JSON.stringify(events), /private|clipboard|diagnostics/);
});

test('driver classifies window races without exposing arbitrary stderr in safe error fields', async () => {
  const driver = createKazumiUIDriver({ run: async () => { throw Object.assign(new Error('private'), { stderr: 'private: Invalid index. (-1719)' }); } });
  await assert.rejects(driver({ action: 'prepare' }), error => error.uiCode === 'UI_WINDOW_NOT_READY' && error.uiAction === 'prepare');
});

test('an already approved exact subject/episode bypasses UI even when raw cache contains other seasons', async () => {
  const row = { id: 'a'.repeat(32), bangumiId: '10380', episode: 2 };
  const f = scenario({ verifiedCache: { list: async () => ({ items: [{ ...row, bangumiId: '999' }, row] }),
    read: async () => ({ content: '[{"time":1,"text":"verified"}]', source: 'official verified cache' }) } });
  const result = await f.acquire({ title: '命运石之门', episode: 2 });
  assert.match(result.content, /verified/); assert.equal(f.actions.length, 0); assert.equal(f.stops(), 0);
});

test('English alias resolves the main series, not its short sequel', async () => {
  const main = { id: 364450, name_cn: '莉可丽丝', name: 'リコリス・リコイル', date: '2022-07-02', eps: 13,
    infobox: [{ key: '别名', value: [{ v: 'Lycoris Recoil' }] }] };
  const short = { id: 999, name_cn: '莉可丽丝：友谊是时间的窃贼' };
  const upstream = async url => ({ status: 200, headers: {}, stream: Readable.from([Buffer.from(JSON.stringify(url.includes('/search/') ?
    { data: [short, main] } : url.endsWith('/364450') ? main : short))]) });
  const result = await findKazumiSubject('Lycoris Recoil', { upstream });
  assert.equal(result.id, 364450); assert.equal(result.totalEpisodes, 13);
});

test('partial JSON is retried and desktop stops after cancellation while waiting', async () => {
  const abort = new AbortController(); let reads = 0;
  const f = scenario({ wait: async () => { if (reads > 0) abort.abort(); } });
  f.cache.read = async () => { reads++; return { content: '{"danmakus":[' }; };
  await f.acquire({ title: '命运石之门', episode: 2, signal: abort.signal });
  assert.equal(reads, 1); assert.equal(f.approved.length, 0); assert.equal(f.stops(), 1);
});

test('serialized cancellation never launches the next stale episode', async () => {
  let release, starts = 0, stops = 0;
  const lifecycle = { start: async () => { starts++; await new Promise(resolve => { release = resolve; }); }, stop: async () => { stops++; } };
  const f = scenario({ lifecycle }), abort = new AbortController();
  const first = f.acquire({ title: '命运石之门', episode: 2 });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const second = f.acquire({ title: '命运石之门', episode: 3, signal: abort.signal });
  abort.abort(); release(); await first; await second;
  assert.equal(starts, 1); assert.equal(stops, 1);
});

test('lifecycle refuses a user-owned app, verifies quit and only terminates its exact official binary', async () => {
  const calls = [], exact = officialAppPath + '/Contents/MacOS/Kazumi';
  let running = true;
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === '/bin/ps') return { stdout: '11 /different/bangumi_kazumi_core\n' + (running ? '22 ' + exact + '\n' : '') };
    if (cmd === '/usr/libexec/PlistBuddy') return { stdout: '2.4.2\n' };
    if (cmd === '/bin/kill') running = false;
    return { stdout: '' };
  };
  const lifecycle = createKazumiLifecycle({ run, ui: async () => {}, wait: async () => {} });
  await assert.rejects(lifecycle.start(), /正在使用/);
  assert.ok(!calls.some(([cmd]) => cmd === '/usr/bin/open'));
  running = false; await lifecycle.start(); running = true; await lifecycle.stop([1280, 860]);
  assert.deepEqual(calls.filter(([cmd]) => cmd === '/bin/kill').map(([, args]) => args), [['-TERM', '22']]);
  assert.ok(calls.some(([cmd, args]) => cmd === '/usr/bin/open' && args.length === 2));
});

test('authenticated TV session automatically obtains official contents and sees them without a play restart', async t => {
  const f = scenario(), id = 'anime-' + 'd'.repeat(32);
  const stream = { id, animeTitle: '命运石之门', episodeName: '第02集', provider: 'AGE' };
  const server = createApp({ receiverAddress: '127.0.0.1',
    discovery: { stream: value => value === id ? stream : null, close: async () => {} },
    danmaku: createDanmaku({ appId: '', appSecret: '', automatic: { engine: 'official-kazumi', configured: true } }),
    automaticCache: { list: async () => ({ items: [] }) }, acquireDanmaku: f.acquire, autoDanmakuOptions: { delay: 0 } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (route, body, session) => (await fetch(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'file://', ...(session ? { 'X-Bangumi-TV': session } : {}) },
    body: JSON.stringify(body) })).json();
  await fetch(base + '/api/danmaku/' + id); assert.equal(f.actions.length, 0);
  const receiver = await post('/api/tv/register', { clientId: 'official-tv-test', version: '0.6.1' });
  await post('/api/tv/poll', { status: 'playing', mediaId: id }, receiver.session);
  let result;
  for (let i = 0; i < 100; i++) {
    result = await (await fetch(base + '/api/danmaku/' + id)).json();
    if (result.count) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(result.engine, 'official-kazumi'); assert.equal(result.count, 1);
  assert.equal(result.comments[0].text, 'test'); assert.equal(f.stops(), 1);
  assert.equal(result.automatic.state, 'loaded');
});
