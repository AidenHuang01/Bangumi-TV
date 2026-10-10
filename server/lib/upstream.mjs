import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function isPrivateAddress(address) {
  const ip = address.toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(ip) === 6) {
    // Reject mapped IPv4 and transition addresses as well as private IPv6.
    return ip === '::' || ip === '::1' || ip.startsWith('::ffff:') ||
      ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip) ||
      ip.startsWith('ff') || ip.startsWith('2002:') || ip.startsWith('2001:0:');
  }
  return true;
}

export function validateRemoteURL(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error('Remote sources must use HTTP(S) without URL credentials'), { status: 400 });
  }
  return url;
}

// Preserve browser request semantics, but never forward Host, connection headers,
// Authorization, or a browser's cookies wholesale. Cookie scope is checked below.
const browserHeaderNames = ['accept', 'accept-language', 'origin', 'x-requested-with',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
  'access-control-request-method', 'access-control-request-headers'];
export function upstreamHeaders(url, { source = {}, range, body, contentType } = {}) {
  const headers = { 'User-Agent': source.userAgent || 'BangumiTV-POC/0.1', 'Accept-Encoding': 'identity' };
  for (const name of browserHeaderNames) {
    const value = source.headers?.[name];
    if (typeof value === 'string' && value.length <= 8192 && !/[\r\n]/.test(value)) headers[name] = value;
  }
  if (source.referer) headers.Referer = source.referer;
  if (source.cookie && url.origin === new URL(source.url).origin) headers.Cookie = source.cookie;
  if (range) headers.Range = range;
  if (contentType || body !== undefined) headers['Content-Type'] = contentType || 'application/x-www-form-urlencoded';
  if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
  return headers;
}

// Pin the checked address so DNS cannot change between validation and connection.
export async function requestUpstream(input, { source = {}, method = 'GET', range, signal, body, contentType }, redirects = 0) {
  signal?.throwIfAborted();
  const url = validateRemoteURL(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw Object.assign(new Error('Remote sources may not access private network addresses'), { status: 400 });
  }
  const address = addresses[0];
  signal?.throwIfAborted();
  const headers = upstreamHeaders(url, { source, range, body, contentType });
  const upstream = await new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method, headers, signal,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family)
    }, resolve);
    request.setTimeout(30000, () => request.destroy(new Error('Source timed out')));
    request.on('error', reject);
    request.end(body);
  });
  if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
    upstream.destroy();
    if (redirects >= 5) throw new Error('Too many source redirects');
    const asGet = upstream.statusCode === 303 || ([301, 302].includes(upstream.statusCode) && method === 'POST');
    return requestUpstream(new URL(upstream.headers.location, url).href,
      { source, method: asGet ? 'GET' : method, range, signal,
        body: asGet ? undefined : body, contentType }, redirects + 1);
  }
  return { stream: upstream, url: url.href, status: upstream.statusCode, headers: upstream.headers };
}
