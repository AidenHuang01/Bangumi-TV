import './network-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import net from 'node:net';
import https from 'node:https';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDandanClient } from '../lib/dandan-client.mjs';
import { createNipaplayClient } from '../lib/nipaplay-client.mjs';
import { createDanmaku } from '../lib/danmaku.mjs';
import { loadDandanApplication } from '../lib/dandan-application.mjs';
import { loadDanmuCredentials } from '../lib/danmu-credentials.mjs';
import { startDanmuService } from '../lib/danmu-service.mjs';

test('real danmaku clients, credentials and worker startup fail before any fetch in tests', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must never run'); };
  try {
    const official = createDandanClient({ appId: 'test-app', appSecret: 'fake' });
    for (const request of [() => official.search('anime'), () => official.details(123), () => official.comments(1230001),
      () => createNipaplayClient({ account: 'fake', password: 'fake' }).comments(1230001),
      () => createDanmaku({ appId: 'fake', appSecret: 'fake' }).search('anime'),
      () => loadDandanApplication(), () => startDanmuService(),
      () => loadDanmuCredentials({ account: 'fake', platform: 'darwin' })]) {
      await assert.rejects(request(), { code: 'ERR_DANMAKU_TEST_NETWORK' });
    }
    await assert.rejects(loadDanmuCredentials({ account: 'fake', store: 'file' }), /私有凭证/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('test network guard blocks fetch, direct TLS and socket paths without an outgoing connection', async () => {
  await assert.rejects(fetch('https://api.dandanplay.net/api/v2/search/anime?keyword=test'), { code: 'ERR_TEST_EXTERNAL_NETWORK' });
  await assert.rejects(fetch('http://127.0.0.1:8787/api/controller/danmaku/search?anime=test'), { code: 'ERR_TEST_EXTERNAL_NETWORK' });
  await assert.rejects(fetch('http://127.0.0.1:9321/api/v2/comment/123'), { code: 'ERR_TEST_EXTERNAL_NETWORK' });
  const socket = new net.Socket();
  assert.throws(() => socket.connect(443, 'api.dandanplay.net'), { code: 'ERR_TEST_EXTERNAL_NETWORK' });
  socket.destroy();
  assert.throws(() => https.get('https://api.dandanplay.net/api/v2/comment/123'), { code: 'ERR_TEST_EXTERNAL_NETWORK' });
});

test('legacy live benchmark commands are disabled before credentials or workers can be accessed', async () => {
  const run = promisify(execFile);
  for (const [name, args] of [['benchmark-danmaku-filter.mjs', ['--live']],
    ['benchmark-danmaku-filter.mjs', ['--live=true']], ['benchmark-danmaku-sources.mjs', []]]) {
    await assert.rejects(run(process.execPath, [new URL('../../scripts/' + name, import.meta.url).pathname, ...args]), error =>
      error.code === 2 && /disabled.*quota/u.test(error.stderr));
  }
});

test('filter timing benchmark still supports local comments without loading credentials or requesting a source', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bangumi-offline-danmaku-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'comments.json');
  await writeFile(file, JSON.stringify([{ time: 1, text: '正常弹幕' }, { time: 2, text: '你是傻逼' }]));
  const { stdout } = await promisify(execFile)(process.execPath,
    [new URL('../../scripts/benchmark-danmaku-filter.mjs', import.meta.url).pathname, '--file', file]);
  const result = JSON.parse(stdout);
  assert.equal(result.mode, 'offline-local-file');
  assert.equal(result.current.inputCount, 2); assert.equal(result.current.blockedCount, 1);
});

test('normal playback policy remains enabled outside a test context without any live verification', async () => {
  const module = new URL('../lib/danmaku-network-policy.mjs', import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    'import {assertDanmakuNetworkAllowed} from ' + JSON.stringify(module) + '; assertDanmakuNetworkAllowed(); console.log("allowed");'],
  { env: { PATH: process.env.PATH } });
  assert.equal(stdout.trim(), 'allowed');
});
