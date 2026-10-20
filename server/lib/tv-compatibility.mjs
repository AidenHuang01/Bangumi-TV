import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const defaultCache = fileURLToPath(new URL('../data/tv-hls/', import.meta.url));
const assetName = /^(?:index\.m3u8|segment-\d{5,}\.ts)$/;
const fingerprint = source => createHash('sha256').update(JSON.stringify([
  source.url, source.referer, source.cookie, source.userAgent, source.headers
])).digest('hex');
const compatibleItem = (item, job) => ({ ...item, format: 'hls', originalFormat: 'mp4', playback: 'remux', seekToleranceMs: job.seekToleranceMs,
  description: 'Original quality · TV-compatible stream prepared on Mac',
  streamPath: '/stream/' + item.id + '/tv-hls/index.m3u8' });

// AVPlay on older Samsung TVs can play an MP4 yet reject every runtime seek.
// Copy its encoded packets into a complete MPEG-TS HLS VOD before handing it
// to the TV. FFmpeg reads only our validated loopback proxy, never raw rule URLs.
export function createTVCompatibility({
  stream, inputURL, cacheDir = defaultCache, ffmpeg,
  maxBytes = 2 * 1024 ** 3, maxEntries = 2, ttlMs = 6 * 3600_000,
  timeoutMs = 120_000, now = Date.now
} = {}) {
  let rootPromise, closed = false, running = null;
  const jobs = new Map();

  async function root() {
    if (!rootPromise) rootPromise = (async () => {
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      // Only this module's expired generated session directories are removable.
      for (const entry of await readdir(cacheDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^session-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
        const file = path.join(cacheDir, entry.name);
        if (now() - (await stat(file)).mtimeMs > ttlMs) await rm(file, { recursive: true, force: true });
      }
      return mkdtemp(path.join(cacheDir, 'session-'));
    })();
    return rootPromise;
  }

  async function binary() {
    if (ffmpeg) return ffmpeg;
    if (process.env.FFMPEG) return process.env.FFMPEG;
    for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
      try { await access(candidate); return candidate; } catch { /* Try next installation. */ }
    }
    return 'ffmpeg';
  }

  async function size(directory) {
    const entries = await readdir(directory);
    const sizes = await Promise.all(entries.map(async name => (await stat(path.join(directory, name))).size));
    return sizes.reduce((total, value) => total + value, 0);
  }

  async function evict(except) {
    const completed = [...jobs.values()].filter(job => job.ready && job !== except).sort((a, b) => a.used - b.used);
    let bytes = [...jobs.values()].reduce((sum, job) => sum + (job.bytes || 0), 0);
    for (const job of completed) {
      if (jobs.size <= maxEntries && bytes <= maxBytes && now() - job.used <= ttlMs) continue;
      jobs.delete(job.key); bytes -= job.bytes;
      await rm(job.directory, { recursive: true, force: true });
    }
  }

  async function generate(job, item) {
    if (closed) throw fail('TV preparation stopped.', 503);
    job.directory = await mkdtemp(path.join(await root(), 'job-'));
    if (closed) throw fail('TV preparation stopped.', 503);
    const executable = await binary();
    if (closed) throw fail('TV preparation stopped.', 503);
    const input = new URL(inputURL(item.id));
    if (input.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(input.hostname)) throw fail('Invalid TV preparation input.');
    await new Promise((resolve, reject) => {
      let failure, checking = false;
      const child = spawn(executable, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-rw_timeout', '15000000',
        '-protocol_whitelist', 'http,tcp', '-i', input.href,
        '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-sn', '-dn',
        '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
        '-hls_flags', 'independent_segments+temp_file',
        '-hls_segment_filename', path.join(job.directory, 'segment-%05d.ts'),
        path.join(job.directory, 'index.m3u8')
      ], { stdio: ['ignore', 'ignore', 'ignore'] });
      job.child = child;
      const stop = message => { failure ||= fail(message); child.kill('SIGKILL'); };
      const timeout = setTimeout(() => stop('TV preparation timed out. Try another source.'), timeoutMs);
      const budget = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          const reserved = [...jobs.values()].reduce((sum, other) => sum + (other.bytes || 0), 0);
          if (await size(job.directory) + reserved > maxBytes) stop('TV video cache limit reached. Try another source.');
        } catch { /* Process completion handles incomplete output. */ }
        checking = false;
      }, 1000);
      child.once('error', error => { failure = fail(error.code === 'ENOENT' ? 'Install FFmpeg on the Mac to prepare TV video.' : 'Could not start TV video preparation.'); });
      child.once('close', code => {
        clearTimeout(timeout); clearInterval(budget); job.child = null;
        if (failure) reject(failure);
        else if (code !== 0 || closed) reject(fail('Mac could not repackage this video for TV. Try another source.'));
        else resolve();
      });
    });
    const manifest = await readFile(path.join(job.directory, 'index.m3u8'), 'utf8');
    const segments = manifest.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
    if (!manifest.startsWith('#EXTM3U') || !manifest.includes('#EXT-X-ENDLIST') || !segments.length ||
        segments.some(name => !/^segment-\d{5,}\.ts$/.test(name))) throw fail('TV video preparation returned an incomplete playlist.');
    const durations = [...manifest.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1]));
    job.seekToleranceMs = Math.ceil(Math.max(...durations) * 1000) + 1000;
    job.bytes = await size(job.directory);
    if (job.bytes > maxBytes) throw fail('TV video cache limit reached. Try another source.');
    job.ready = true; job.used = now();
    await evict(job);
    return job;
  }

  async function ensure(item) {
    if (closed) throw fail('TV preparation stopped.', 503);
    if (!/^anime-[a-f0-9]{32}$/.test(item.id || '')) throw fail('Video not found.', 404);
    const source = stream(item.id);
    if (!source || source.format !== 'mp4') throw fail('MP4 video expired. Select an episode again.', 404);
    const key = fingerprint(source);
    const cached = jobs.get(key);
    if (cached) { cached.used = now(); return cached.promise; }
    if (running) throw fail('Another TV video is being prepared. Retry shortly.', 503);
    const job = { key, used: now(), ready: false, bytes: 0 };
    jobs.set(key, job); running = job;
    job.promise = evict(job).then(() => generate(job, item)).catch(async error => {
      jobs.delete(key);
      if (job.directory) await rm(job.directory, { recursive: true, force: true });
      throw error;
    }).finally(() => { if (running === job) running = null; });
    return job.promise;
  }

  return {
    async prepare(item) {
      if (item.format !== 'mp4' || item.kind !== 'remote') return item;
      return compatibleItem(item, await ensure(item));
    },
    present(item) {
      const source = stream(item.id);
      const job = source?.format === 'mp4' && jobs.get(fingerprint(source));
      return job?.ready ? compatibleItem(item, job) : item;
    },
    async file(item, name) {
      if (!assetName.test(name)) throw fail('Not found.', 404);
      const job = await ensure(item);
      job.used = now();
      return path.join(job.directory, name);
    },
    status() { return { mode: 'lossless-hls', preparing: !!running, cachedVideos: [...jobs.values()].filter(job => job.ready).length }; },
    async close() {
      closed = true;
      for (const job of jobs.values()) job.child?.kill('SIGKILL');
      await Promise.allSettled([...jobs.values()].map(job => job.promise));
      if (rootPromise) await rm(await rootPromise, { recursive: true, force: true });
      jobs.clear();
    }
  };
}
