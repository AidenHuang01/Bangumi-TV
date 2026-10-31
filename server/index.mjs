import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { createDanmaku } from './lib/danmaku.mjs';
import { createRecentHistory } from './lib/recent-history.mjs';
import { createKazumiCache } from './lib/kazumi-cache.mjs';
import { createVerifiedKazumiCache } from './lib/verified-kazumi-cache.mjs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
import { createDiscovery, loadRules } from './lib/discovery.mjs';
import { startKazumiCore } from './lib/kazumi-client.mjs';
import { startDanmuService } from './lib/danmu-service.mjs';
import { createDanmuProvider } from './lib/danmu-provider.mjs';
import { createKazumiAcquirer } from './lib/kazumi-acquire.mjs';
import { loadDanmuCredentials } from './lib/danmu-credentials.mjs';
import { createHeadlessAcquirer } from './lib/headless-danmaku.mjs';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const engine = process.env.ANIME_ENGINE || 'kazumi';
if (!['kazumi', 'legacy'].includes(engine)) throw new Error('ANIME_ENGINE must be kazumi or legacy');
const rules = await loadRules();
const core = engine === 'kazumi' ? await startKazumiCore({ rules }) : undefined;
const discovery = createDiscovery({ rules, core });
let settings = {};
try { settings = JSON.parse(await readFile(new URL('./settings.local.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') { await discovery.close(); throw new Error('Invalid server/settings.local.json'); } }
const kazumiCache = createKazumiCache();
const automaticCache = createVerifiedKazumiCache(kazumiCache, {
  file: fileURLToPath(new URL('./data/kazumi-auto-cache.json', import.meta.url))
});
let danmuService, danmuProvider;
if (settings.danmu?.enabled !== false) {
  try {
    const credentials = await loadDanmuCredentials({ account: settings.danmu?.account, store: settings.danmu?.credentialStore });
    danmuService = await startDanmuService({ port: settings.danmu?.port || 9321, sources: settings.danmu?.sources, credentials });
    danmuProvider = createDanmuProvider(danmuService);
  } catch (error) { console.error(error.message); } // Video service still starts if comments are unavailable.
}
const officialEnabled = process.platform === 'darwin' && settings.kazumiDanmaku?.enabled === true;
const acquireOfficial = officialEnabled ? createKazumiAcquirer({ cache: kazumiCache, verifiedCache: automaticCache,
  onCache: item => automaticCache.approve(item),
  onEvent: event => console.log('[official-danmaku] ' + JSON.stringify({ time: new Date().toISOString(), ...event }))
}) : undefined;
const danmaku = createDanmaku({ ...settings.dandan, core, provider: danmuProvider,
  automatic: officialEnabled ? { engine: 'official-kazumi', configured: true,
    message: '官方 Kazumi 自动弹幕：播放后获取对应集，文件就绪后转发至电视／手机并退出 Mac 客户端。获取期间客户端可能短暂显示播放画面。' }
    : danmuService?.aggregation ? { engine: 'danmu_api', configured: true,
      message: '弹弹play＋巴哈姆特关联弹幕：选集后后台合并、去重并同步电视／手机，Mac 不打开播放器或下载视频。' } : undefined,
  coreConfigured: core ? (await core.health()).danmaku?.configured === true : false });
const app = createApp({ mediaDir: process.env.MEDIA_DIR, sourcesFile: process.env.SOURCES_FILE, discovery, kazumiCache,
  automaticCache: officialEnabled || !danmuProvider ? automaticCache : { list: async () => ({ items: [] }) },
  acquireDanmaku: officialEnabled ? acquireOfficial : danmuProvider ? createHeadlessAcquirer({ provider: danmuProvider, cache: automaticCache }) : undefined,
  prefetchDanmaku: selection => !officialEnabled && danmaku.status().enabled ? danmuProvider?.prefetch(selection) : undefined,
  danmaku,
  recentHistory: createRecentHistory() });
app.on('close', () => danmuService?.close());
app.on('error', error => { console.error(error.message); process.exitCode = 1; discovery.close(); });
app.listen(port, host, () => {
  console.log(`Bangumi TV POC: http://localhost:${port}/`);
  console.log(`Anime engine: ${engine === 'kazumi' ? 'Kazumi 2.3.8 (original Dart + native macOS parser)' : 'legacy independent adapter'}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`TV server address: http://${address.address}:${port}`);
      if (address.family === 'IPv4' && !address.internal) console.log(`Phone controller: http://${address.address}:${port}/remote/`);
    }
  }
  console.log('Keep this Mac awake. Ctrl+C stops the server.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  app.close();
  app.closeAllConnections();
});
