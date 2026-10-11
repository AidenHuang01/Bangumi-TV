// Opt-in live audit using Kazumi itself, isolated from the production TV session.
// Saves only catalogue metadata and probe outcomes, never source URLs or cookies.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startKazumiCore, kazumiCommit } from '../lib/kazumi-client.mjs';
import { createDiscovery } from '../lib/discovery.mjs';
import { createApp } from '../app.mjs';
import { auditCases as cases, selectAuditTitle, selectAuditEpisode } from './audit-cases.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const directory = path.resolve(option('--rules-dir', '.tools/KazumiRules-availability'));
const reportFile = path.resolve(option('--report', 'reports/2026-10-10-rule-availability.json'));
const filter = option('--providers', '').split(',').filter(Boolean);
const maxRoads = Number(option('--max-roads', '2'));
if (!Number.isInteger(maxRoads) || maxRoads < 1 || maxRoads > 20) throw new Error('Invalid --max-roads');
const index = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8'));
const rules = await Promise.all(index.filter(item => !filter.length || filter.includes(item.name)).map(async item => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(item.name)) throw new Error('Invalid provider name');
  return { ...JSON.parse(await readFile(path.join(directory, item.name + '.json'), 'utf8')), id: item.name };
}));
if (!rules.length || filter.some(id => !rules.some(rule => rule.id === id))) throw new Error('Unknown providers');
const report = { startedAt: new Date().toISOString(), engine: 'kazumi', kazumiCommit,
  rulesDirectory: path.basename(directory), maxRoads, methodology: 'First episode; real Kazumi search/chapters/native parser, validated stream and isolated Mac gateway byte probe. Not physical-TV decoding or full-episode coverage.',
  providers: rules.map(rule => ({ id: rule.id, name: rule.name, version: rule.version, cases: [] })) };
let saving = Promise.resolve();
const save = () => {
  const snapshot = JSON.stringify(report, null, 2) + '\n';
  return saving = saving.then(() => writeFile(reportFile, snapshot));
};
const core = await startKazumiCore({ rules, port: Number(option('--core-port', '8790')) });
const discovery = createDiscovery({ core, rules });
const server = createApp({ discovery });
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(option('--port', '8788')), '127.0.0.1', resolve); });
} catch (error) { await discovery.close(); throw error; }
let closing;
function close() {
  return closing ||= (async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await discovery.close();
  })();
}
for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => { void close().then(() => process.exit(status)); });
}
const base = 'http://127.0.0.1:' + server.address().port;
const selections = new Map();
async function pool(tasks, concurrency) {
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < tasks.length) await tasks[next++]();
  }));
}
async function probe(item) {
  let target = new URL(item.streamPath, base).href;
  if (item.format === 'hls') {
    let segment = false;
    for (let depth = 0; depth < 5; depth++) {
      const response = await fetch(target, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('Gateway playlist HTTP ' + response.status);
      const text = await response.text();
      if (!text.startsWith('#EXTM3U')) throw new Error('Invalid gateway playlist');
      const entry = text.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'));
      if (!entry) throw new Error('Empty gateway playlist');
      target = new URL(entry, target).href;
      if (!text.includes('#EXT-X-STREAM-INF')) { segment = true; break; }
    }
    if (!segment) throw new Error('Playlist depth exceeded');
  }
  const response = await fetch(target, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20000) });
  const reader = response.body.getReader();
  try {
    if (![200, 206].includes(response.status)) throw new Error('Gateway video HTTP ' + response.status);
    const { value } = await reader.read();
    if (!value?.length) throw new Error('Empty gateway video');
    if (/^(?:\s*<|\s*\{)/.test(Buffer.from(value).toString('utf8', 0, 100))) throw new Error('Gateway returned text instead of video');
    return { status: response.status, bytes: value.length };
  } finally { await reader.cancel().catch(() => {}); }
}
try {
  await pool(rules.flatMap((rule, providerIndex) => cases.map((testCase, caseIndex) => async () => {
    const result = { query: testCase.query, stage: 'search', outcome: 'failed', attempts: [] };
    report.providers[providerIndex].cases[caseIndex] = result;
    try {
      const items = await core.search(rule, testCase.query);
      result.searchTitles = items.map(item => item.title);
      const match = selectAuditTitle(items, testCase);
      if (!match) { result.error = 'No matching series in search results'; return; }
      result.title = match.title; result.stage = 'chapters';
      const roads = await core.chapters(rule, match.source);
      result.episodeCounts = roads.map(road => road.episodes.length);
      if (!roads.some(road => road.episodes.length)) { result.error = 'No episodes in Kazumi chapter result'; return; }
      selections.set(rule.id + ':' + caseIndex, { rule, roads, title: match.title });
      result.outcome = 'catalogue-only'; result.stage = 'catalogue';
    } catch (error) { result.error = error.message; }
    finally { console.log(rule.id, testCase.query, result.outcome, result.error || result.episodeCounts?.join('/')); await save(); }
  })), 4);
  if (!args.includes('--catalog-only')) {
    for (const [providerIndex, rule] of rules.entries()) {
      for (const [caseIndex, result] of report.providers[providerIndex].cases.entries()) {
        const selection = selections.get(rule.id + ':' + caseIndex);
        if (!selection) continue;
        const available = selection.roads.map((road, index) => ({ road, index })).filter(item => item.road.episodes.length);
        const preferred = rule.id === 'AGE' ? [3, 3, 2, 4][caseIndex] : undefined;
        available.sort((a, b) => Number(b.index === preferred) - Number(a.index === preferred));
        result.outcome = 'failed'; result.stage = 'resolve';
        for (const { road, index } of available.slice(0, maxRoads)) {
          const episode = selectAuditEpisode(road.episodes);
          const started = Date.now(), attempt = { road: index + 1, episode: episode?.name, stage: 'resolve' };
          result.attempts.push(attempt);
          try {
            if (!episode) throw new Error('Episode 1 is not listed on this road');
            const { item } = await discovery.resolveSelection({ rule, title: selection.title + ' · ' + episode.name, url: episode.url });
            attempt.stage = 'gateway'; attempt.format = item.format;
            Object.assign(attempt, await probe(item));
            attempt.outcome = 'passed'; result.outcome = 'passed'; result.stage = 'gateway';
          } catch (error) { attempt.outcome = 'failed'; attempt.error = error.message; }
          attempt.elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
          console.log(rule.id, result.query, 'road', attempt.road, attempt.outcome, attempt.error || `${attempt.format} ${attempt.bytes} bytes`);
          await save();
          if (result.outcome === 'passed') break;
        }
      }
    }
  }
  report.completedAt = new Date().toISOString();
  await save();
} finally {
  await close();
}
