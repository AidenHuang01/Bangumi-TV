// Explicit user-triggered two-episode comparison, not a scheduled crawler.
// No TV commands, no raw comments/credentials/signed URLs in the output.
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { loadDandanApplication } from '../server/lib/dandan-application.mjs';
import { loadDanmuCredentials } from '../server/lib/danmu-credentials.mjs';
import { startDanmuService } from '../server/lib/danmu-service.mjs';
import { createDanmuProvider } from '../server/lib/danmu-provider.mjs';
import { parseDanmaku } from '../server/lib/danmaku.mjs';
import { createDanmakuFilter } from '../server/lib/danmaku-filter.mjs';

const services = [];
try {
  const settings = JSON.parse(await readFile(new URL('../server/settings.local.json', import.meta.url), 'utf8'));
  const application = await loadDandanApplication({ fallback: settings.dandan });
  const credentials = await loadDanmuCredentials({ account: settings.danmu?.account, store: settings.danmu?.credentialStore });
  if (!application || !credentials) throw new Error();
  const legacy = await startDanmuService({ port: 9322, sources: settings.danmu?.sources, credentials }); services.push(legacy);
  const official = await startDanmuService({ port: 9323, sources: settings.danmu?.sources, credentials, application }); services.push(official);
  const providers = [createDanmuProvider(legacy), createDanmuProvider(official)], filter = createDanmakuFilter(settings.danmakuFilter);
  const fingerprint = row => JSON.stringify([row.time, row.mode, row.color, row.text]);
  for (const title of ['Lycoris Recoil', 'FX战士久留美']) {
    const results = await Promise.all(providers.map(async provider => {
      const start = performance.now();
      const raw = await provider.acquire({ title, episode: 1, signal: AbortSignal.timeout(90000) });
      const acquired = performance.now(), comments = parseDanmaku(raw.content), filtered = filter.apply(comments);
      return { comments, count: comments.length, upstreamRows: JSON.parse(raw.content).comments.length,
        kept: filtered.stats.outputCount, blocked: filtered.stats.blockedCount, source: raw.source,
        acquisitionSeconds: (acquired - start) / 1000 };
    }));
    const sets = results.map(item => new Set(item.comments.map(fingerprint)));
    const summary = ({ comments, ...counts }) => counts;
    console.log(JSON.stringify({ title, episode: 1, officialConfigured: official.official,
      legacy: summary(results[0]), officialPlusRelated: summary(results[1]),
      uniqueOld: sets[0].size, uniqueNew: sets[1].size,
      missingFromNew: [...sets[0]].filter(item => !sets[1].has(item)).length,
      addedByNew: [...sets[1]].filter(item => !sets[0].has(item)).length }));
  }
} catch (error) {
  console.error(error.publicMessage || 'Source comparison failed; check private application/account configuration and loopback ports 9322/9323.');
  process.exitCode = 1;
} finally { for (const service of services) service.close(); }
