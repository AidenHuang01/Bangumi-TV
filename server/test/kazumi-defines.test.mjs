import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withKazumiDefines } from '../../scripts/lib/kazumi-defines.mjs';

test('Mac build receives no keys by default and temporary define files are private and cleaned on failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bangumi-defines-test-'));
  let file;
  try {
    await withKazumiDefines({ root, env: {} }, async args => assert.deepEqual(args, []));
    await assert.rejects(withKazumiDefines({ root, env: { DANDAN_APP_ID: 'test-id', DANDAN_APP_SECRET: 'test-secret' } }, async args => {
      assert.equal(args.length, 1);
      assert.doesNotMatch(args[0], /test-id|test-secret/);
      file = args[0].slice('--dart-define-from-file='.length);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(file)), { DANDANAPI_APPID: 'test-id', DANDANAPI_KEY: 'test-secret' });
      throw new Error('fixture-build-failure');
    }), /fixture-build-failure/);
    await assert.rejects(stat(file), { code: 'ENOENT' });
    await assert.rejects(withKazumiDefines({ root, env: { DANDAN_APP_ID: 'test-id' } }, () => {}), /both/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
