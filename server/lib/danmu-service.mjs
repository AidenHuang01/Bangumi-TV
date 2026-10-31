import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, open } from 'node:fs/promises';

export async function startDanmuService({ port = 9321, sources, credentials } = {}) {
  const token = randomBytes(24).toString('hex');
  const dir = new URL('../data/logs/', import.meta.url);
  await mkdir(dir, { recursive: true });
  const log = await open(new URL('danmu-service.log', dir), 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../tools/danmu-service.mjs', import.meta.url))], {
    stdio: ['pipe', log.fd, log.fd], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
      BANGUMI_DANMU_TOKEN: token, BANGUMI_DANMU_PORT: String(port),
      BANGUMI_DANMU_SOURCES: sources || (credentials ? 'dandan,bahamut,bilibili,animeko' : 'bahamut,bilibili,animeko'), NODE_TLS_REJECT_UNAUTHORIZED: '1' }
  });
  child.stdin.on('error', () => {}); // A startup failure must not crash the video gateway.
  child.stdin.end(JSON.stringify(credentials || {})); // Never put passwords in argv, env or logs.
  await log.close();
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', () => { exited = true; });
  const url = 'http://127.0.0.1:' + port;
  const stop = () => { if (!exited) child.kill('SIGTERM'); };
  process.once('exit', stop);
  for (let i = 0; i < 40 && !exited; i++) {
    try {
      const response = await fetch(url + '/health', { headers: { 'X-Bangumi-Danmu': token }, signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (response.ok && health.engine === 'danmu_api') return { url, token, aggregation: health.aggregation,
        close() { stop(); process.removeListener('exit', stop); } };
    } catch { /* Worker is still importing its dependencies. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  stop(); process.removeListener('exit', stop);
  throw new Error('Local danmu_api failed to start; run npm run setup:danmu and inspect server/data/logs/danmu-service.log');
}
