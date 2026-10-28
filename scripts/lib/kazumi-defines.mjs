import { mkdtemp, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Flutter's command line contains only a temporary path, never API secrets.
// The compiled Mac binary still contains these credentials; do not distribute it.
export async function withKazumiDefines({ root, env = process.env }, build) {
  let settings = {};
  try { settings = JSON.parse(await readFile(path.join(root, 'server/settings.local.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid server/settings.local.json'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid server/settings.local.json');
  const id = env.DANDANAPI_APPID || env.DANDAN_APP_ID || settings.dandan?.appId || '';
  const secret = env.DANDANAPI_KEY || env.DANDAN_APP_SECRET || settings.dandan?.appSecret || '';
  if (typeof id !== 'string' || typeof secret !== 'string' || !!id !== !!secret) {
    throw new Error('Kazumi danmaku requires both appId and appSecret, or neither');
  }
  if (!id) return build([]);
  const directory = await mkdtemp(path.join(tmpdir(), 'bangumi-kazumi-defines-'));
  const file = path.join(directory, 'defines.json');
  try {
    await writeFile(file, JSON.stringify({ DANDANAPI_APPID: id, DANDANAPI_KEY: secret }), { mode: 0o600 });
    return await build(['--dart-define-from-file=' + file]);
  } finally {
    await rm(file, { force: true });
    await rmdir(directory);
  }
}
