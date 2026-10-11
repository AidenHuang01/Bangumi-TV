// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { validateRemoteURL, isPrivateAddress } from './upstream.mjs';

export const kazumiCommit = '4e821e48282d0e8e3753fd6266bb1d15e4dc0f02';
const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const messages = new Set([
  'Source requires manual verification. Choose another provider.',
  'Kazumi source request failed. The provider may be unavailable or its rule outdated.',
  'Kazumi did not find a stream within 45 seconds. Choose another source.',
  'Kazumi is already resolving a video. Try again shortly.',
  'Kazumi search is busy.'
]);

export function createKazumiClient({ baseURL, token, fetcher = fetch, close = async () => {} }) {
  const endpoint = new URL(baseURL);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('Kazumi core requires a loopback URL and a private session token');
  }
  async function call(operation, input, timeout = 20000) {
    let response;
    try {
      response = await fetcher(new URL(operation, endpoint), { method: input ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: input ? JSON.stringify(input) : undefined, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    } catch { throw failure('Kazumi core is unavailable. Restart the Mac server.'); }
    const reader = response.body.getReader();
    let size = 0; const parts = [];
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw failure('Kazumi response is too large.'); }
        parts.push(Buffer.from(value));
      }
    } catch { throw failure('Kazumi core returned an invalid response.'); }
    let data;
    try { data = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw failure('Kazumi core returned an invalid response.'); }
    if (!response.ok) throw failure(messages.has(data?.error) ? data.error : 'Kazumi core request failed.',
      [429, 504].includes(response.status) ? response.status : 502);
    return data;
  }
  const url = input => {
    const parsed = validateRemoteURL(input), host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && isPrivateAddress(host))) {
      throw failure('Kazumi source tried to access a private network address.');
    }
    return parsed.href;
  };
  const reference = (rule, input) => {
    if (typeof input !== 'string' || !input || input.length > 8192) throw failure('Invalid Kazumi source reference.');
    return rule.chapterMode === 'api' ? input : url(new URL(input, rule.baseURL).href);
  };
  return {
    async health() {
      const info = await call('/health', undefined, 2000);
      if (info.engine !== 'kazumi' || info.upstreamCommit !== kazumiCommit || info.parser !== 'VideoWebviewAppleImpl') {
        throw failure('Kazumi core version does not match this server. Rebuild it.');
      }
      return info;
    },
    async search(rule, query) {
      const data = await call('/search', { provider: rule.id, query });
      if (!Array.isArray(data.items)) throw failure('Invalid Kazumi search result.');
      return data.items.slice(0, 80).map(item => ({ title: String(item.title).slice(0, 500), source: reference(rule, item.source) }));
    },
    async chapters(rule, source) {
      const data = await call('/chapters', { provider: rule.id, source: reference(rule, source) });
      if (!Array.isArray(data.roads)) throw failure('Invalid Kazumi chapter result.');
      return data.roads.slice(0, 20).map(road => ({ name: String(road.name).slice(0, 200),
        episodes: road.episodes.slice(0, 500).map(episode => ({ name: String(episode.name).slice(0, 200), url: url(episode.url) })) }));
    },
    async resolve(episode) {
      const data = await call('/resolve', { provider: episode.rule.id, url: url(episode.url) }, 50000);
      const safeHeader = value => typeof value === 'string' && value.length <= 8192 && !/[\r\n]/.test(value) ? value : undefined;
      return { url: url(data.url), format: data.format === 'hls' ? 'hls' : 'mp4',
        referer: safeHeader(data.referer), userAgent: safeHeader(data.userAgent), cookie: safeHeader(data.cookie) };
    },
    close
  };
}

export async function startKazumiCore({ rules, port = Number(process.env.KAZUMI_CORE_PORT || 8789),
  executable = fileURLToPath(new URL('../../kazumi-core/build/macos/Build/Products/Release/bangumi_kazumi_core.app/Contents/MacOS/bangumi_kazumi_core', import.meta.url)) } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid Kazumi core port');
  try { await access(executable); } catch { throw new Error('Kazumi core is not built. Run npm run setup:kazumi first.'); }
  const token = randomBytes(32).toString('hex');
  const child = spawn(executable, [], { stdio: 'ignore', env: { ...process.env,
    BANGUMI_CORE_TOKEN: token, BANGUMI_CORE_PORT: String(port), BANGUMI_CORE_RULES: JSON.stringify(rules) } });
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', () => { exited = true; });
  let closing;
  const client = createKazumiClient({ baseURL: `http://127.0.0.1:${port}/`, token, close() {
    return closing ||= new Promise(resolve => {
      if (exited) return resolve();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      timer.unref();
    });
  } });
  try {
    for (let i = 0; i < 30 && !exited; i++) {
      try { await client.health(); return client; } catch { /* Wait for our authenticated worker only. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Kazumi core could not start. Check its build and whether the core port is free.');
  } catch (error) { await client.close(); throw error; }
}
