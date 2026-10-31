// Run the pinned upstream request handler, not its public UI/proxy server.
// This process never opens a player, resolves streams, or downloads videos.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { connectNipaplay } from '../lib/danmu-nipaplay.mjs';

let credentialInput = '';
for await (const chunk of process.stdin) {
  credentialInput += chunk;
  if (Buffer.byteLength(credentialInput) > 8192) throw new Error('Invalid private startup configuration');
}
let credentials = JSON.parse(credentialInput || '{}'); credentialInput = '';
if (credentials.account && (typeof credentials.account !== 'string' || credentials.account.length > 200 ||
  typeof credentials.password !== 'string' || !credentials.password || credentials.password.length > 1024)) throw new Error('Invalid private startup configuration');
const aggregation = Boolean(credentials.account && credentials.password);

const root = new URL('../../.tools/danmu-api/', import.meta.url);
process.chdir(fileURLToPath(root));
const { handleRequest } = await import(new URL('danmu_api/worker.js', root));
const { getSourceByKey } = await import(new URL('danmu_api/sources/registry.js', root));
// Never use an unrelated hosted fallback. The approved NipaPlay account path
// below replaces upstream's dandan gateway, including its insecure HTTP failover.
const other = getSourceByKey('other');
other.getComments = other.getSegmentComments = async () => [];
const dandan = getSourceByKey('dandan');
if (aggregation) {
  const { parseNipaplayRelatedLinks, resolveNipaplayLink, applyShiftToDanmu } = await import(new URL('danmu_api/utils/nipaplay-util.js', root));
  connectNipaplay({ credentials, getSourceByKey, parseRelatedLinks: parseNipaplayRelatedLinks,
    resolveLink: resolveNipaplayLink, applyShift: applyShiftToDanmu });
} else {
  dandan.search = async () => [];
  dandan.getEpisodeDanmu = async () => [];
}
credentials = undefined;
const token = process.env.BANGUMI_DANMU_TOKEN;
if (!/^[a-f0-9]{48}$/.test(token || '')) throw new Error('Missing private service token');
const env = { TOKEN: token, ADMIN_TOKEN: '', SOURCE_ORDER: process.env.BANGUMI_DANMU_SOURCES || 'bahamut,bilibili,animeko',
  LOG_LEVEL: 'warn', STRICT_TITLE_MATCH: 'true', SEARCH_CACHE_MINUTES: '60', COMMENT_CACHE_MINUTES: '360',
  GROUP_MINUTE: '0', LOCAL_CACHE_ENABLED: 'false', USE_BANGUMI_DATA: 'false', DANMU_OUTPUT_FORMAT: 'json',
  AI_API_KEY: '', DANDANPLAY_ACCOUNT: '', DANDANPLAY_PASSWORD: '' };
let active = 0;
const server = http.createServer(async (req, res) => {
  const send = (status, data) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); } };
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.headers['x-bangumi-danmu'] !== token) return send(401, { error: 'Unauthorized' });
  if (url.pathname === '/health') return send(200, { engine: 'danmu_api', aggregation, sources: env.SOURCE_ORDER.split(','), active });
  if (req.method !== 'GET' || !/^\/api\/v2\/(?:search\/(?:anime|episodes)|bangumi\/[a-zA-Z0-9_-]{1,200}|comment\/[a-zA-Z0-9_-]{1,200})$/.test(url.pathname))
    return send(404, { error: 'Not found' });
  if (active >= 3) return send(429, { error: 'Busy' });
  active++;
  try {
    const target = new URL('/' + token + url.pathname + url.search, 'http://127.0.0.1:' + server.address().port);
    const result = await handleRequest(new Request(target), env, 'node', '127.0.0.1');
    const bytes = Buffer.from(await result.arrayBuffer());
    if (bytes.length > 4 * 1024 * 1024) return send(502, { error: 'Comment response exceeds 4 MB' });
    if (!res.destroyed) { res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(bytes); }
  } catch { send(502, { error: 'Danmu source request failed' }); }
  finally { active--; }
});
server.listen(Number(process.env.BANGUMI_DANMU_PORT || 9321), '127.0.0.1', () => console.log('Local danmu_api ready'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); server.closeAllConnections(); process.exit(0); });
