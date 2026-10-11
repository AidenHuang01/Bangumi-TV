import test from 'node:test';
import assert from 'node:assert/strict';
import { createCovers, matchCover } from '../lib/covers.mjs';
test('cover matching does not substitute a sequel and network errors have a local fallback', async () => {
  const rows = [{ name_cn: '葬送的芙莉莲 第二季' }, { name_cn: '葬送的芙莉莲' }];
  assert.equal(matchCover(rows, '葬送的芙莉莲'), rows[1]);
  assert.equal(matchCover(rows.slice(0, 1), '葬送的芙莉莲'), undefined);
  const cover = await createCovers({ upstream: async () => { throw new Error('offline'); } }).get('Frieren');
  assert.equal(cover.type, 'image/svg+xml'); assert.ok(cover.bytes.length > 0);
});
