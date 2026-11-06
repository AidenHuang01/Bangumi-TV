// Offline only: synthetic regressions or an explicitly supplied local file.
// Never loads credentials, starts workers, or fetches comments.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createDanmakuFilter } from '../server/lib/danmaku-filter.mjs';
import { moderationCases } from '../server/test/fixtures/danmaku-moderation-cases.mjs';
import { parseDanmaku } from '../server/lib/danmaku.mjs';

const args = process.argv.slice(2), baselineIndex = args.indexOf('--baseline');
if (args.some(arg => arg === '--live' || arg.startsWith('--live='))) {
  console.error('Live danmaku tests are disabled to protect the daily API quota. Use offline fixtures or --file <local XML/JSON>.');
  process.exit(2);
}
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
try {
  if (args.includes('--file')) {
    const file = args[args.indexOf('--file') + 1];
    if (!file || file.startsWith('--') || /^[a-z][a-z0-9+.-]*:\/\//iu.test(file)) throw new Error();
    const comments = parseDanmaku(await readFile(file, 'utf8'));
    console.log(JSON.stringify({ mode: 'offline-local-file', current: measure(createDanmakuFilter, comments),
      ...(baseline ? { baseline: measure(baseline, comments) } : {}) }, null, 2));
  } else {
    console.log(JSON.stringify({ mode: 'hand-authored-regressions-not-real-world-accuracy', current: evaluate(createDanmakuFilter),
      ...(baseline ? { baseline: evaluate(baseline) } : {}) }, null, 2));
  }
} catch (error) {
  console.error('Offline benchmark failed; check the local comment file or baseline commit.');
  process.exitCode = 1;
}
