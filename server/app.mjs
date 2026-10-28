import http from 'node:http';
import { isIP } from 'node:net';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { mimeTypes, serveFile } from './lib/media.mjs';
import { createReferences, rewriteManifest } from './lib/hls.mjs';
import { requestUpstream, validateRemoteURL, isPrivateAddress } from './lib/upstream.mjs';
import { createDiscovery, readBody } from './lib/discovery.mjs';
import { createController } from './lib/controller.mjs';
import { createDanmaku } from './lib/danmaku.mjs';
import { createKazumiCache } from './lib/kazumi-cache.mjs';
import { createCovers } from './lib/covers.mjs';
import { listReports, readReport } from './lib/reports.mjs';
import { createTVCompatibility } from './lib/tv-compatibility.mjs';
import { createRecentHistory } from './lib/recent-history.mjs';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const allowedFiles = new Set(['index.html', 'style.css', 'app.js', 'danmaku.js', 'defaults.js', 'icon.svg']);
const videoExtensions = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv']);

async function inside(root, filename) {
  const resolved = await realpath(path.join(root, filename));
  const relative = path.relative(await realpath(root), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error('File not found'), { status: 404 });
  return resolved;
}

export function createApp({
  mediaDir = path.join(serverDir, 'media'),
  sourcesFile = path.join(serverDir, 'sources.json'),
  tvDir = path.join(serverDir, '..', 'tv-app'),
  controllerDir = path.join(serverDir, '..', 'phone-app'),
  receiverAddress = process.env.TV_IP,
  upstream = requestUpstream,
  discovery = createDiscovery({ upstream }),
  danmaku = createDanmaku(),
  kazumiCache = createKazumiCache(),
  recentHistory = createRecentHistory({ file: null }),
  tvCompatibilityOptions = {}
} = {}) {
  const references = createReferences(randomBytes(32));
  const metrics = { activeTransfers: 0, requests: 0, bytesSent: 0 };
  const tvCompatibility = createTVCompatibility({
    ...tvCompatibilityOptions,
    stream: id => discovery.stream(id),
    inputURL: id => 'http://127.0.0.1:' + server.address().port + '/stream/' + id
  });
  const controller = createController({ discovery, prepareTVItem: item => tvCompatibility.prepare(item),
    presentTVItem: item => tvCompatibility.present(item), onPlayback: stream => recentHistory.record(stream) });
  const covers = createCovers();

  async function body(req, limit = 32768) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Use application/json'), { status: 415 });
    req.setTimeout(5000, () => req.destroy());
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('Request is too large'), { status: 413 });
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
    if (!value || Array.isArray(value) || typeof value !== 'object') throw Object.assign(new Error('Expected a JSON object'), { status: 400 });
    return value;
  }

  async function library() {
    const items = [];
    for (const entry of await readdir(mediaDir, { withFileTypes: true })) {
      if (!entry.isFile() || !videoExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const file = await inside(mediaDir, entry.name);
      const info = await stat(file);
      const base = entry.name.slice(0, -path.extname(entry.name).length);
      let subtitle;
      try { subtitle = await inside(mediaDir, base + '.vtt'); } catch { /* Optional sidecar. */ }
      items.push({
        id: 'local-' + createHash('sha256').update(entry.name).digest('hex').slice(0, 16),
        title: base.replace(/[_-]/g, ' '), kind: 'local', file, subtitle,
        format: path.extname(entry.name).slice(1), size: info.size,
        description: 'Original file · no video conversion'
      });
    }
    let config;
    try { config = JSON.parse(await readFile(sourcesFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid sources.json: ' + error.message); }
    if (config && !Array.isArray(config.sources)) throw new Error('sources.json must contain a sources array');
    for (const source of config?.sources || []) {
      if (source.enabled === false) continue;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(source.id) || !source.title) throw new Error('Each source needs a unique id and title');
      validateRemoteURL(source.url);
      const id = 'remote-' + source.id;
      if (items.some(item => item.id === id)) throw new Error('Duplicate source id');
      items.push({ ...source, id, kind: 'remote', format: source.format || (/\.m3u8(?:\?|$)/i.test(source.url) ? 'hls' : 'mp4'),
        description: 'Original stream via Mac · no video conversion' });
    }
    return items.sort((a, b) => a.title.localeCompare(b.title));
  }

  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  async function proxy(req, res, item, remoteURL) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on('close', abort);
    try {
      const isPlaylistURL = /\.m3u8(?:\?|$)/i.test(remoteURL) || (remoteURL === item.url && item.format === 'hls');
      const result = await upstream(remoteURL, {
        source: item, method: 'GET',
        range: isPlaylistURL ? undefined : req.headers.range, signal: controller.signal
      });
      const type = result.headers['content-type'] || '';
      const isManifest = isPlaylistURL || /mpegurl/i.test(type);
      if (![200, 206, 416].includes(result.status)) {
        result.stream.destroy();
        throw Object.assign(new Error(`Video source returned HTTP ${result.status}`), { status: 502 });
      }
      if (isManifest && result.status !== 416) {
        const body = await readBody(result, 2 * 1024 * 1024);
        const text = rewriteManifest(body.toString('utf8'), result.url, url =>
          `/stream/${item.id}/ref/${references.encode(item.id, url)}` + (/\.m3u8(?:\?|$)/i.test(url) ? '.m3u8' : ''));
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : text);
        return;
      }
      const headers = { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' };
      for (const key of ['content-length', 'content-range', 'accept-ranges']) {
        if (result.headers[key]) headers[key] = result.headers[key];
      }
      res.writeHead(result.status, headers);
      if (req.method === 'HEAD') { result.stream.destroy(); res.end(); }
      else {
        result.stream.on('data', chunk => { metrics.bytesSent += chunk.length; });
        await pipeline(result.stream, res);
      }
    } finally { res.off('close', abort); }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, X-Bangumi-TV');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    metrics.requests++;
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/api/controller/') || pathname.startsWith('/api/tv/')) {
        const hostname = new URL('http://' + req.headers.host).hostname.replace(/^\[|\]$/g, '');
        if (!(hostname === 'localhost' || (isIP(hostname) && isPrivateAddress(hostname)))) {
          return json(res, 403, { error: 'Use the Mac’s local IP address for the controller.' });
        }
        const tv = pathname.startsWith('/api/tv/');
        const remoteAddress = req.socket.remoteAddress.replace(/^::ffff:/, '');
        if (tv && receiverAddress && remoteAddress !== receiverAddress) {
          return json(res, 403, { error: 'TV receiver address is not allowed. Check TV_IP on the Mac.' });
        }
        // The installed widget is NOT hosted by the Mac and Samsung can send a
        // non-null widget Origin. Trust that transport only when its actual socket
        // address is pinned to the configured TV. Phone routes stay same-origin;
        // forwarded headers cannot impersonate the TV. Polling still needs its session.
        const pinnedTV = tv && !!receiverAddress && remoteAddress === receiverAddress;
        const origin = req.headers.origin;
        if (origin && !pinnedTV && !(tv && origin === 'null') && origin !== 'http://' + req.headers.host && origin !== 'https://' + req.headers.host) {
          return json(res, 403, { error: 'Controller requests must come from this Mac server.' });
        }
        if (pathname === '/api/controller/danmaku' && req.method === 'GET') return json(res, 200, danmaku.status());
        if (pathname === '/api/controller/danmaku/kazumi-cache' && req.method === 'GET') {
          return json(res, 200, await kazumiCache.list());
        }
        if (pathname === '/api/controller/danmaku/search' && req.method === 'GET') {
          return json(res, 200, await danmaku.search(url.searchParams.get('anime'), url.searchParams.get('episode')));
        }
        if (pathname === '/api/controller/danmaku/episodes' && req.method === 'GET') {
          return json(res, 200, await danmaku.episodes(url.searchParams.get('animeId')));
        }
        if (pathname === '/api/controller/danmaku' && req.method === 'POST') {
          const input = await body(req, 5 * 1024 * 1024);
          if (input.action === 'settings') return json(res, 200, danmaku.settings(input));
          if (!discovery.stream(input.streamId || '')) return json(res, 404, { error: 'Choose a playing video first.' });
          if (input.action === 'import') return json(res, 200, danmaku.import(input.streamId, input.content));
          if (input.action === 'kazumi-cache') {
            const cached = await kazumiCache.read(input.cacheId);
            return json(res, 200, danmaku.import(input.streamId, cached.content, cached.source));
          }
          if (input.action === 'attach') return json(res, 200, await danmaku.attach(input.streamId, input.episodeId));
          return json(res, 400, { error: 'Unknown danmaku action' });
        }
        if (pathname === '/api/controller/info' && req.method === 'GET') return json(res, 200, controller.info());
        if (pathname === '/api/controller/recent' && req.method === 'POST') {
          const input = await body(req);
          const played = /^anime-[a-f0-9]{32}$/.test(input.streamId || '') && discovery.stream(input.streamId);
          if (!played) return json(res, 404, { error: 'Video expired. Select an episode again.' });
          return json(res, 200, { items: await recentHistory.record(played) });
        }
        if (tv && req.method === 'POST') {
          const input = await body(req);
          if (pathname === '/api/tv/register') return json(res, 200, controller.register(input));
          if (pathname === '/api/tv/poll') return json(res, 200, controller.poll(req.headers['x-bangumi-tv'], input));
          return json(res, 404, { error: 'Not found' });
        }
        if (pathname === '/api/controller/state' && req.method === 'GET') return json(res, 200, controller.state());
        if (pathname === '/api/controller/action' && req.method === 'POST') return json(res, 200, controller.mutate(await body(req)));
        return json(res, 405, { error: 'Unsupported controller method' });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'GET and HEAD only outside controller endpoints' });
      if (/^\/api\/danmaku\/anime-[a-f0-9]{32}$/.test(pathname)) {
        const id = pathname.split('/')[3];
        if (!discovery.stream(id)) return json(res, 404, { error: 'Video expired. Select an episode again.' });
        return json(res, 200, danmaku.read(id, url.searchParams.get('version')));
      }
      if (pathname === '/shared/danmaku.js') return serveFile(req, res, await inside(tvDir, 'danmaku.js'), mimeTypes['.js']);
      if (pathname === '/vendor/hls.min.js') return serveFile(req, res, path.join(serverDir, '../node_modules/hls.js/dist/hls.min.js'), mimeTypes['.js']);
      if (pathname === '/api/health') return json(res, 200, {
        name: 'Bangumi TV POC', version: '0.4.0', playback: 'original', kazumiSearch: true, phoneController: true,
        animeBackend: discovery.engineInfo ? await discovery.engineInfo() : { engine: 'custom' },
        tvCompatibility: tvCompatibility.status(), uptimeSeconds: Math.round(process.uptime()), ...metrics
      });
      if (pathname === '/api/providers') return json(res, 200, { providers: await discovery.providers() });
      if (pathname === '/api/recent') return json(res, 200, { items: await recentHistory.list() });
      if (pathname === '/api/reports') return json(res, 200, { reports: await listReports(), schedule: '05:00 America/Los_Angeles' });
      if (pathname.startsWith('/api/reports/')) return json(res, 200, await readReport(pathname.slice('/api/reports/'.length)));
      if (/^\/api\/covers\/[a-f0-9]{32}$/.test(pathname)) {
        const image = await covers.get(discovery.showTitle(pathname.split('/')[3]));
        res.writeHead(200, { 'Content-Type': image.type, 'Content-Length': image.bytes.length, 'Cache-Control': 'private, max-age=300' });
        return res.end(req.method === 'HEAD' ? undefined : image.bytes);
      }
      if (pathname === '/api/search') return json(res, 200, await discovery.search(url.searchParams.get('q'), url.searchParams.get('provider') || 'all'));
      if (/^\/api\/shows\/[a-f0-9]{32}$/.test(pathname)) return json(res, 200, await discovery.show(pathname.split('/')[3]));
      if (/^\/api\/resolve\/[a-f0-9]{32}$/.test(pathname)) {
        if (req.method !== 'GET') return json(res, 405, { error: 'Resolve requires GET' });
        const result = await discovery.resolve(pathname.split('/')[3]);
        const item = url.searchParams.get('target') === 'tv' ? await tvCompatibility.prepare(result.item) : result.item;
        return json(res, 200, { ...result, item });
      }
      if (pathname === '/remote' || pathname.startsWith('/remote/')) {
        const asset = pathname === '/remote' || pathname === '/remote/' ? 'index.html' : pathname.slice('/remote/'.length);
        if (!['index.html', 'style.css', 'app.js'].includes(asset)) return json(res, 404, { error: 'Not found' });
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        return await serveFile(req, res, await inside(controllerDir, asset), mimeTypes[path.extname(asset)]);
      }
      if (pathname === '/api/library') {
        const items = await library();
        return json(res, 200, { items: items.map(({ id, title, kind, format, size, description, subtitle }) => ({
          id, title, kind, format, size, description, streamPath: `/stream/${id}` + (format === 'hls' ? '/index.m3u8' : ''),
          subtitlePath: subtitle ? `/subtitles/${id}.vtt` : null
        })) });
      }
      if (pathname.startsWith('/stream/') || pathname.startsWith('/subtitles/')) {
        const parts = pathname.split('/');
        const id = parts[2].replace(/\.vtt$/, '');
        const item = discovery.stream(id) || (await library()).find(value => value.id === id);
        if (!item) return json(res, 404, { error: 'Video not found. Refresh the library.' });
        metrics.activeTransfers++;
        try {
          if (parts[1] === 'subtitles') {
            if (!item.subtitle) return json(res, 404, { error: 'Subtitle not found' });
            return await serveFile(req, res, item.subtitle, mimeTypes['.vtt']);
          }
          if (parts.length === 5 && parts[3] === 'tv-hls') {
            const file = await tvCompatibility.file(item, parts[4]);
            res.setHeader('Cache-Control', parts[4] === 'index.m3u8' ? 'no-store' : 'private, max-age=3600');
            return await serveFile(req, res, file, mimeTypes[path.extname(file)]);
          }
          if (item.kind === 'local') {
            if (parts.length !== 3) return json(res, 404, { error: 'Not found' });
            return await serveFile(req, res, item.file, mimeTypes[path.extname(item.file).toLowerCase()]);
          }
          if (!(parts.length === 3 || (parts.length === 4 && parts[3] === 'index.m3u8' && item.format === 'hls') ||
            (parts.length === 5 && parts[3] === 'ref'))) return json(res, 404, { error: 'Not found' });
          const target = parts[3] === 'ref' ? references.decode(item.id, parts[4].replace(/\.m3u8$/, '')) : item.url;
          return await proxy(req, res, item, target);
        } finally { metrics.activeTransfers--; }
      }
      const asset = pathname === '/' || pathname === '/tv/' ? 'index.html' : pathname.replace(/^\/(?:tv\/)?/, '');
      if (!allowedFiles.has(asset)) return json(res, 404, { error: 'Not found' });
      res.setHeader('Cache-Control', 'no-cache');
      await serveFile(req, res, await inside(tvDir, asset), mimeTypes[path.extname(asset)]);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = error.status || (error.code === 'ENOENT' ? 404 : error instanceof URIError ? 400 : 500);
      console.error(`[${status}] ${error.message}`);
      json(res, status, { error: error.message });
    }
  });
  server.requestTimeout = 0; // Long videos are expected; upstream inactivity has its own timeout.
  server.on('close', () => {
    controller.close();
    tvCompatibility.close().catch(error => console.error('TV cache shutdown: ' + error.message));
    discovery.close().catch(error => console.error('Resolver shutdown: ' + error.message));
  });
  return server;
}
