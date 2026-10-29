import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKazumiAcquirer, findKazumiSubject, createKazumiUIDriver } from '../lib/kazumi-acquire.mjs';
import { createVerifiedKazumiCache } from '../lib/verified-kazumi-cache.mjs';

test('subject lookup needs one exact metadata match, not a sequel or ambiguous duplicate', async () => {
  let data = [{ id: 2, name_cn: '命运石之门0' }, { id: 1, name_cn: '命运石之门' }];
  const upstream = async () => ({ status: 200, headers: {}, stream: Readable.from([Buffer.from(JSON.stringify({ data }))]) });
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
  let phase = 'info', expanded = false, chosen = false, queued = false, approved = [];
  const actions = [], row = (label, role = 'AXButton') => ({ label, role, enabled: true });
  const entry = { id: 'a'.repeat(32), bangumiId: '10380', episode: 2, updatedAt: 100 };
  const cache = { list: async () => ({ items: queued ? [entry] : [] }),
    read: async () => ({ content: JSON.stringify({ danmakus: [{ m: 'test', p: '1,1,16777215,u' }] }) }) };
  const ui = async input => {
    if (input.action !== 'snapshot') actions.push(input);
    if (input.action === 'snapshot') {
      return { rows: phase === 'info' ? [row('命运石之门', 'AXStaticText'), row('开始观看')] : phase === 'sources' ?
        [row('7 个来源 · 2 个结果', 'AXStaticText'), row('来源规则：AGE，2 个结果'),
          row('播放 命运石之门0，来源 AGE'), ...(expanded ? [row('播放 命运石之门，来源 AGE')] : [row('展开全部 2 个结果', 'AXStaticText')])] :
        phase === 'sheet' ? [row('下载选集', 'AXGroup'), row('第02集', 'AXStaticText'), ...(chosen ? [row('下载 1 集')] : [])] : [] };
    }
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
    run: async () => ({ stdout: '2.4.2\n' }), wait: async () => {}, onCache: async item => approved.push(item), ...options });
  return { acquire, actions, approved };
}

test('official acquisition expands results, rejects the sequel, selects only one episode and approves its new valid cache', async () => {
  const f = scenario(); await f.acquire({ title: '命运石之门', episode: 2, provider: 'AGE' });
  assert.equal(f.approved.length, 1);
  assert.ok(f.actions.some(input => input.label === '播放 命运石之门，来源 AGE'));
  assert.ok(!f.actions.some(input => input.label?.includes('命运石之门0')));
  assert.deepEqual(f.actions.filter(input => input.label?.startsWith('下载 ')).map(input => input.label), ['下载 1 集']);
});

test('permission errors are actionable without leaking diagnostics, and cancelled queued jobs do not touch UI', async () => {
  const f = scenario({ ui: async () => { throw Object.assign(new Error('private'), { stderr: 'osascript not allowed assistive access -25211' }); } });
  await assert.rejects(f.acquire({ title: '命运石之门', episode: 2 }), error => /辅助功能/.test(error.publicMessage) && !/private/.test(error.message));
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
  assert.equal((await verified.list()).items.length, 0);
  await verified.approve(item); assert.equal((await verified.list()).items.length, 1);
  assert.equal((await createVerifiedKazumiCache(cache, { file }).list()).items.length, 1);
  item = { ...item, updatedAt: 11 }; assert.equal((await verified.list()).items.length, 0);
});
