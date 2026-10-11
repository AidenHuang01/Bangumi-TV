import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { createDanmaku } from './lib/danmaku.mjs';
import { createApp } from './app.mjs';
import { createDiscovery, loadRules } from './lib/discovery.mjs';
import { startKazumiCore } from './lib/kazumi-client.mjs';

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
const app = createApp({ mediaDir: process.env.MEDIA_DIR, sourcesFile: process.env.SOURCES_FILE, discovery,
  danmaku: createDanmaku(settings.dandan) });
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
