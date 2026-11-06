import { readFile } from 'node:fs/promises';
import { assertDanmakuNetworkAllowed } from './danmaku-network-policy.mjs';

const names = ['DANDAN_APP_ID', 'DANDAN_APP_SECRET', 'DANDAN_APPLICATION_KEY'];
const defaultFile = new URL('../../.env', import.meta.url);
// Read only our credentials. Do not source shell code, expand $variables, mutate
// process.env, or inherit arbitrary .env settings into players/child processes.
export function parseDandanEnv(content) {
  const result = {};
  for (const line of content.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match || !names.includes(match[1])) continue;
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0], end = value.indexOf(quote, 1);
      if (end < 0 || !/^\s*(?:#.*)?$/u.test(value.slice(end + 1))) throw new Error('Invalid quoted DandanPlay application setting.');
      value = value.slice(1, end);
    } else value = value.replace(/\s+#.*$/u, '').trim();
    result[match[1]] = value;
  }
  return result;
}

export async function loadDandanApplication({ file = defaultFile, env = process.env, fallback = {} } = {}) {
  if (file === defaultFile || env === process.env) assertDanmakuNetworkAllowed();
  let values = {};
  try { values = parseDandanEnv(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read DandanPlay application settings; check the private .env file.'); }
  const appId = env.DANDAN_APP_ID || values.DANDAN_APP_ID || fallback.appId;
  const appSecret = env.DANDAN_APP_SECRET || env.DANDAN_APPLICATION_KEY || values.DANDAN_APP_SECRET || values.DANDAN_APPLICATION_KEY || fallback.appSecret;
  if (!appId && !appSecret) return undefined;
  if (typeof appId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(appId) ||
      typeof appSecret !== 'string' || !appSecret || appSecret.length > 1024 || /[\r\n\0]/u.test(appSecret)) {
    throw new Error('Configure both DANDAN_APP_ID and DANDAN_APPLICATION_KEY (or DANDAN_APP_SECRET).');
  }
  return { appId, appSecret };
}
