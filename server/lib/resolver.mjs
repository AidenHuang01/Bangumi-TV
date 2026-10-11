import { chromium } from 'playwright-core';
import { JSDOM } from 'jsdom';
import { access } from 'node:fs/promises';
import { setMaxListeners } from 'node:events';
import { requestUpstream, validateRemoteURL } from './upstream.mjs';
import { readBody, userAgent } from './discovery.mjs';

const isMedia = url => /\.(?:m3u8|mp4)(?:[?#]|$)/i.test(url);
const failure = message => Object.assign(new Error(message), { status: 502 });

export async function browserSource(request, episode) {
  // headers() omits security-related headers; iframe APIs need the actual Origin
  // and Referer, not the catalog page substituted as a fallback.
  const headers = await request.allHeaders();
  let frameURL;
  try { frameURL = request.frame().url(); } catch { /* An initial navigation has no frame yet. */ }
  const referer = episode.rule.referer || headers.referer ||
    (!request.isNavigationRequest() && /^https?:\/\//.test(frameURL || '') ? frameURL : episode.url);
  return { url: request.url(), cookie: headers.cookie || '', referer,
    userAgent: episode.rule.userAgent || headers['user-agent'] || userAgent, headers };
}

export function sourceFailure(error, url, kind = 'Video source') {
  const host = new URL(error.sourceURL || url).hostname;
  if (error.sourceReason === 'region') return `${kind} at ${host} blocks playback from this Mac's region (HTTP ${error.httpStatus}). Choose another provider.`;
  if (/EPROTO|SSL|TLS|CERT|certificate/i.test(error.code || '') || /SSL|TLS|certificate/i.test(error.message || '')) {
    return `${kind} at ${host} failed its TLS connection. Try another source or provider.`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(error.code || '')) return `${kind} hostname ${host} is unavailable. Try another provider.`;
  if (/HTTP \d{3}/.test(error.message || '')) {
    const reason = error.sourceReason === 'decode' ? ' Its parser could not decode the episode link.' :
      error.sourceReason === 'origin' ? ' Its parser rejected the request origin/referrer.' : '';
    return `${kind} at ${host} returned ${/HTTP \d{3}/.exec(error.message)[0]}.${reason} Try another source or provider.`;
  }
  if (/private network/.test(error.message || '')) return `${kind} tried to access a blocked private address.`;
  if (/aborted|timeout|timed out/i.test(error.message || '')) return `${kind} at ${host} timed out. Try another source or provider.`;
  return `${kind} at ${host} did not return a playable video. Try another source or provider.`;
}

export function responseFailure(status, body, url) {
  const region = /the region has been denied|not available in (?:your|this) (?:country|region)|country is blocked/i.test(body.toString('utf8'));
  return Object.assign(failure('HTTP ' + status), { sourceURL: url, httpStatus: status, sourceReason: region ? 'region' : undefined });
}

export function parserFailure(status, body) {
  // Translate only recognized failure categories; do not echo arbitrary provider
  // JSON, tokens or stack traces into the phone/TV error display.
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch {}
  const message = String(data?.msg || data?.message || data?.error || '');
  const reason = /非法来源|invalid origin|invalid referer/i.test(message) ? 'origin' :
    /url.*解密失败|url.*decrypt.*fail/i.test(message) ? 'decode' : undefined;
  if (status < 400 && !(reason && Number(data?.code) >= 400)) return null;
  return Object.assign(failure('HTTP ' + (status >= 400 ? status : Number(data.code))), { sourceReason: reason });
}

// Read data, never execute JavaScript from a provider in the Node process.
export function pageCandidates(html, base) {
  const dom = new JSDOM(html), doc = dom.window.document;
  const media = [], frames = [];
  const add = (list, value) => {
    if (!value) return;
    try { const url = validateRemoteURL(new URL(value, base).href).href; if (!list.includes(url)) list.push(url); } catch {}
  };
  for (const element of doc.querySelectorAll('video[src], video source[src]')) add(media, element.getAttribute('src'));
  for (const match of html.matchAll(/\bplayer_[\w]+\s*=\s*(\{[^\n]*?\})\s*(?:;|<\/script>)/g)) {
    try {
      const player = JSON.parse(match[1]);
      let url = player.url;
      if (String(player.encrypt) === '1') url = decodeURIComponent(url);
      if (String(player.encrypt) === '2') url = decodeURIComponent(Buffer.from(url, 'base64').toString('utf8'));
      add(isMedia(url) ? media : frames, url);
    } catch { /* Non-JSON player configs need the isolated browser. */ }
  }
  for (const element of doc.querySelectorAll('iframe[src]')) add(frames, element.getAttribute('src'));
  dom.window.close();
  return { media, frames };
}

export function createResolver({ upstream = requestUpstream, chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  browserFactory, timeoutMs = 45000 } = {}) {
  let browserPromise, busy = false, closed = false;
  async function browser() {
    if (closed) throw failure('Resolver is shutting down');
    if (!browserPromise) browserPromise = (async () => {
      if (browserFactory) return browserFactory();
      try { await access(chromePath); }
      catch { throw failure('Install Google Chrome on the Mac, or set CHROME_PATH to its executable.'); }
      // A fresh profile; no access to the user’s logged-in browser.
      return chromium.launch({ executablePath: chromePath, headless: true, chromiumSandbox: true });
    })().catch(error => { browserPromise = null; throw error; });
    return browserPromise;
  }
  async function probe(url, source, signal) {
    const playlist = /\.m3u8(?:\?|$)/i.test(url);
    const result = await upstream(url, { source, range: playlist ? undefined : 'bytes=0-1023', signal });
    if (![200, 206].includes(result.status)) throw await rejectedResponse(result);
    const type = result.headers['content-type'] || '';
    const format = playlist || /mpegurl/i.test(type) ? 'hls' : 'mp4';
    if (format === 'hls') {
      const text = (await readBody(result, 2 * 1024 * 1024)).toString('utf8');
      if (!text.trimStart().startsWith('#EXTM3U')) throw failure('Source did not return an HLS playlist');
      await probeHLS(text, result.url, source, signal);
    } else {
      // Don’t buffer a whole movie when a CDN ignores Range.
      const iterator = result.stream[Symbol.asyncIterator]();
      const first = await iterator.next(); result.stream.destroy();
      const bytes = first.value || Buffer.alloc(0);
      if (!bytes.includes(Buffer.from('ftyp')) && !/^video\//i.test(type)) throw failure('Source did not return a video stream');
    }
    return { ...source, url: result.url, format,
      cookie: source.cookie && new URL(result.url).origin === new URL(source.url).origin ? source.cookie : undefined };
  }
  async function prefix(result) {
    try {
      const first = await result.stream[Symbol.asyncIterator]().next();
      return (first.value || Buffer.alloc(0)).subarray(0, 4096);
    } finally { result.stream.destroy(); }
  }
  async function rejectedResponse(result) {
    let body = Buffer.alloc(0);
    try { body = await prefix(result); } catch { /* Status is still useful if the error body fails. */ }
    return responseFailure(result.status, body, result.url);
  }
  async function probeHLS(text, base, source, signal, depth = 0) {
    if (depth >= 4) throw failure('Too many nested HLS playlists');
    const entry = text.replace(/^\uFEFF/, '').split(/\r?\n/).find(line => line.trim() && !line.trimStart().startsWith('#'));
    if (!entry) throw failure('The HLS playlist has no video segments');
    const url = validateRemoteURL(new URL(entry.trim(), base).href).href;
    const master = text.includes('#EXT-X-STREAM-INF');
    // Use the normal HLS GET, then cancel after a small prefix. Some valid CDNs
    // reject Range on segments, even though normal TV playback works.
    const result = await upstream(url, { source, signal });
    if (![200, 206].includes(result.status)) {
      const error = await rejectedResponse(result); error.hlsSegment = !master; throw error;
    }
    if (master) {
      const child = (await readBody(result, 2 * 1024 * 1024)).toString('utf8');
      if (!child.trimStart().startsWith('#EXTM3U')) throw failure('Source did not return a child HLS playlist');
      return probeHLS(child, result.url, source, signal, depth + 1);
    }
    const bytes = await prefix(result);
    if (!bytes.length || /text\/html|application\/json/i.test(result.headers['content-type'] || '')) {
      throw failure('The HLS segment did not return video data');
    }
  }
  async function staticResolve(episode, signal, note) {
    const visited = new Set();
    async function visit(url, referer, depth) {
      if (depth > 2 || visited.size >= 6 || visited.has(url)) return null;
      visited.add(url);
      const source = { url, referer: episode.rule.referer || referer, userAgent: episode.rule.userAgent || userAgent };
      if (isMedia(url)) return probe(url, source, signal);
      const result = await upstream(url, { source, signal });
      if (result.status !== 200) { result.stream.destroy(); note(failure('HTTP ' + result.status), url, 'Player', 1); return null; }
      const html = (await readBody(result)).toString('utf8');
      if (/cf-chl-|Just a moment\.\.\.|人机验证|验证码验证/.test(html)) throw failure('Source requires manual verification. Try another provider.');
      const candidates = pageCandidates(html, result.url);
      for (const media of candidates.media) {
        try { return await probe(media, { ...source, url: media, referer: episode.rule.referer || result.url }, signal); }
        catch (error) { note(error, media, 'Video source', 3); }
      }
      for (const frame of candidates.frames) {
        try { const media = await visit(frame, result.url, depth + 1); if (media) return media; }
        catch (error) {
          if (/manual verification/.test(error.message)) throw error;
          note(error, frame, 'Player', 1);
        }
      }
      return null;
    }
    return visit(episode.url, episode.rule.baseURL, 0);
  }
  async function browserResolve(episode, signal, note, problem, cancelRequests) {
    const context = await (await browser()).newContext({ userAgent: episode.rule.userAgent || userAgent,
      serviceWorkers: 'block', acceptDownloads: false });
    let settle, requestCount = 0, candidateFound = false;
    const found = new Promise(resolve => { settle = resolve; });
    const page = await context.newPage();
    const abort = () => settle(null);
    const rejectedMedia = (error, url) => {
      note(error, url, 'Video source', 3); candidateFound = false;
      // A playlist isn't playable if its first video segment is explicitly region-blocked.
      if (error.hlsSegment && error.sourceReason === 'region') settle(error);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) settle(null);
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    context.on('page', popup => { if (popup !== page) popup.close().catch(() => {}); });
    // ALL browser requests go through the same DNS-pinned, public-address-only
    // transport as streaming. No direct browser network route to the LAN.
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      const request = route.request(), url = request.url();
      try {
        validateRemoteURL(url);
        if (++requestCount > 160 || signal.aborted || ['image', 'font'].includes(request.resourceType())) return await route.abort();
        if (!['GET', 'HEAD', 'POST', 'OPTIONS'].includes(request.method())) return await route.abort();
        const source = await browserSource(request, episode), headers = source.headers;
        if (isMedia(url) || request.resourceType() === 'media') {
          if (!candidateFound) {
            candidateFound = true;
            try { settle(await probe(url, source, signal)); }
            catch (error) { rejectedMedia(error, url); }
          }
          return await route.abort();
        }
        const body = request.postDataBuffer();
        if (body && body.length > 1024 * 1024) return await route.abort();
        const result = await upstream(url, { source, method: request.method(), body: body || undefined,
          contentType: headers['content-type'], signal });
        if (result.status >= 400 && ['xhr', 'fetch', 'document'].includes(request.resourceType())) {
          note(failure('HTTP ' + result.status), url, request.resourceType() === 'document' ? 'Player' : 'Player API', 2);
        }
        if (/mpegurl|^video\//i.test(result.headers['content-type'] || '')) {
          result.stream.destroy();
          if (!candidateFound) { candidateFound = true; try { settle(await probe(url, source, signal)); }
            catch (error) { rejectedMedia(error, url); } }
          return await route.abort();
        }
        const response = await readBody(result, 5 * 1024 * 1024);
        if (['xhr', 'fetch'].includes(request.resourceType())) {
          const error = parserFailure(result.status, response);
          if (error) note(error, url, 'Player API', 2);
        }
        const responseHeaders = { ...result.headers };
        delete responseHeaders['content-encoding']; delete responseHeaders['transfer-encoding']; delete responseHeaders['content-length'];
        // Playwright requires flat string headers. Its cookie jar handles Set-Cookie.
        for (const key of Object.keys(responseHeaders)) if (Array.isArray(responseHeaders[key])) responseHeaders[key] = responseHeaders[key].join('\n');
        await route.fulfill({ status: result.status, headers: responseHeaders, body: response });
      } catch (error) {
        if (!signal.aborted && ['document', 'xhr', 'fetch', 'media'].includes(request.resourceType())) {
          note(error, url, request.resourceType() === 'media' ? 'Video source' : 'Player', 2);
        }
        try { await route.abort(); } catch {}
      }
    });
    try {
      page.goto(episode.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      // Some ordinary players load only after their own play button is pressed.
      const playTimer = setInterval(() => {
        page.locator('video, .dplayer-play-icon, .art-icon-play, .vjs-big-play-button').first()
          .click({ timeout: 500 }).catch(() => {});
      }, 2500);
      try {
        const media = await found;
        if (media instanceof Error) throw failure(sourceFailure(media, media.sourceURL, 'Video source'));
        if (!media) throw failure(problem() || 'The player did not expose a playable stream within ' + Math.ceil(timeoutMs / 1000) + ' seconds. Try another source or provider.');
        return media;
      } finally { clearInterval(playTimer); }
    } finally {
      signal.removeEventListener('abort', abort);
      cancelRequests(); // Stop pending DNS-pinned transfers before closing their routes.
      await context.close();
    }
  }
  return {
    // Stream validation only; this does not invoke either legacy extractor.
    probe,
    async resolve(episode) {
      if (busy) throw Object.assign(new Error('A video is already being resolved. Try again shortly.'), { status: 429 });
      busy = true;
      const deadline = new AbortController(), signal = deadline.signal;
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      let detail, priority = -1;
      const note = (error, url, kind, level) => {
        if (level >= priority) { detail = sourceFailure(error, url, kind); priority = level; }
      };
      // A browser page can have many concurrent requests sharing this deadline.
      setMaxListeners(200, signal);
      try {
        let media;
        try { media = await staticResolve(episode, AbortSignal.timeout(Math.min(10000, timeoutMs)), note); }
        catch (error) {
          if (/manual verification/.test(error.message)) throw error;
          note(error, episode.url, 'Player', 1);
        }
        return media || await browserResolve(episode, signal, note, () => detail, () => deadline.abort());
      } finally { clearTimeout(timer); deadline.abort(); busy = false; }
    },
    async close() { closed = true; if (browserPromise) await (await browserPromise).close(); }
  };
}
