// Default: offline, synthetic regressions. --live: read-only Lycoris episode 1
// acquisition in a separate worker. Never changes TV state or prints comments.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createDanmakuFilter } from '../server/lib/danmaku-filter.mjs';
import { moderationCases } from '../server/test/fixtures/danmaku-moderation-cases.mjs';
import { parseDanmaku } from '../server/lib/danmaku.mjs';
import { loadDanmuCredentials } from '../server/lib/danmu-credentials.mjs';
import { startDanmuService } from '../server/lib/danmu-service.mjs';
import { createDanmuProvider } from '../server/lib/danmu-provider.mjs';

const args = process.argv.slice(2), baselineIndex = args.indexOf('--baseline');
const baselineRef = baselineIndex < 0 ? null : args[baselineIndex + 1];
if (baselineIndex >= 0 && !/^[a-f0-9]{7,40}$/u.test(baselineRef || '')) throw new Error('--baseline requires a local commit SHA');
let baseline;
if (baselineRef) {
  // Repository-owned code, explicit local commit only; no shell interpolation.
  const code = execFileSync('git', ['show', baselineRef + ':server/lib/danmaku-filter.mjs'], {
    cwd: new URL('../', import.meta.url), maxBuffer: 1024 * 1024
  });
  baseline = (await import('data:text/javascript;base64,' + code.toString('base64'))).createDanmakuFilter;
}
function evaluate(makeFilter) {
  const filter = makeFilter();
  const result = { allowedCases: 0, blockedCases: 0, falsePositives: 0, falseNegatives: 0 };
  for (const group of moderationCases) for (const text of group.texts) {
    if (group.blocked) { result.blockedCases++; if (!filter.classify(text)) result.falseNegatives++; }
    else { result.allowedCases++; if (filter.classify(text)) result.falsePositives++; }
  }
  return result;
}
function measure(makeFilter, comments, options) {
  const filter = makeFilter(options), start = performance.now(), result = filter.apply(comments);
  const firstPassSeconds = (performance.now() - start) / 1000, timings = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now(); filter.apply(comments); timings.push((performance.now() - t) / 1000);
  }
  timings.sort((a, b) => a - b);
  return { ...result.stats, firstPassSeconds, warmRuns: 20, warmMedianSeconds: (timings[9] + timings[10]) / 2 };
}
let worker;
try {
  if (args.includes('--live')) {
    const settings = JSON.parse(await readFile(new URL('../server/settings.local.json', import.meta.url), 'utf8'));
    const credentials = await loadDanmuCredentials({ account: settings.danmu?.account, store: settings.danmu?.credentialStore });
    worker = await startDanmuService({ port: 9322, sources: settings.danmu?.sources, credentials });
    const provider = createDanmuProvider(worker), start = performance.now();
    const raw = await provider.acquire({ title: 'Lycoris Recoil', episode: 1, signal: AbortSignal.timeout(90000) });
    const acquired = performance.now(), comments = parseDanmaku(raw.content), parsed = performance.now();
    console.log(JSON.stringify({ mode: 'live-read-only', source: raw.source,
      upstreamRows: JSON.parse(raw.content).comments.length, acquireSeconds: (acquired - start) / 1000,
      parseSeconds: (parsed - acquired) / 1000, current: measure(createDanmakuFilter, comments, settings.danmakuFilter),
      ...(baseline ? { baseline: measure(baseline, comments) } : {}) }, null, 2));
  } else {
    console.log(JSON.stringify({ mode: 'hand-authored-regressions-not-real-world-accuracy', current: evaluate(createDanmakuFilter),
      ...(baseline ? { baseline: evaluate(baseline) } : {}) }, null, 2));
  }
} catch (error) {
  console.error(error.publicMessage || 'Benchmark failed; check local worker/setup or the baseline commit.');
  process.exitCode = 1;
} finally { worker?.close(); }
