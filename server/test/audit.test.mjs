import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRecentHistory } from '../lib/recent-history.mjs';
import { auditCases, dailyAuditCases, selectDailyAuditCases, loadDailyAuditCases, preferredAuditRoad,
  selectAuditTitle, selectAuditEpisode } from '../tools/audit-cases.mjs';

async function historyFile(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bangumi-audit-targets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'recent.json');
}

test('live audit selects the requested series, not a sequel, film or special', () => {
  const titles = [
    ['葬送的芙莉莲 第二季', '葬送的芙莉莲'],
    ['命运石之门0', '命运石之门 聪明睿智的认知计算', '命运石之门'],
    ['死亡笔记特别篇 L的继承者', 'DEATH NOTE'],
    ['颂乐人偶 剧场版', 'BanG Dream! Ave Mujica']
  ];
  for (const [i, candidates] of titles.entries()) {
    const items = candidates.map(title => ({ title }));
    assert.equal(selectAuditTitle(items, auditCases[i]), items.at(-1));
    assert.equal(selectAuditTitle(items.slice(0, -1), auditCases[i]), undefined);
  }
  assert.equal(selectAuditTitle([{ title: 'bang dream！ave mujica' }], auditCases[3]).title, 'bang dream！ave mujica');
});

test('live probes select episode 1 even when a provider returns descending episodes', () => {
  const episodes = ['38', '02', '1'].map(name => ({ name }));
  assert.equal(selectAuditEpisode(episodes), episodes[2]);
  for (const name of ['第01集', '第 01 话', 'EP01', '第1話']) {
    assert.equal(selectAuditEpisode([{ name }]).name, name);
  }
  assert.equal(selectAuditEpisode([{ name: '第1.5集' }, { name: '第11集' }, { name: '01预告' }]), undefined);
});

test('no history uses ten defaults in their original order without mutating them', () => {
  const before = JSON.stringify(dailyAuditCases), cases = selectDailyAuditCases([]);
  assert.equal(cases.length, 10);
  assert.deepEqual(cases.map(item => item.query), dailyAuditCases.map(item => item.query));
  assert.ok(cases.every(item => item.origin === 'default'));
  cases[0].aliases.push('test mutation');
  assert.equal(JSON.stringify(dailyAuditCases), before);
});

test('short history stays newest-first and defaults fill ten slots without alias duplicates', () => {
  const cases = selectDailyAuditCases([{ title: ' Lycoris   Recoil ' }, { title: 'STEINS;GATE' }, { title: 'FX战士久留美' }]);
  assert.equal(cases.length, 10);
  assert.deepEqual(cases.slice(0, 3).map(item => item.query), ['Lycoris Recoil', 'STEINS;GATE', 'FX战士久留美']);
  assert.deepEqual(cases.slice(0, 3).map(item => item.origin), ['history', 'history', 'history']);
  assert.deepEqual(cases.slice(3).map(item => item.query), ['葬送的芙莉莲', '死亡笔记', 'Ave Mujica', '鬼灭之刃',
    '进击的巨人', '紫罗兰永恒花园', '孤独摇滚']);
  assert.ok(selectAuditTitle([{ title: '命运石之门' }], cases[1]));
  assert.equal(selectAuditTitle([{ title: '命运石之门0' }], cases[1]), undefined);
});

test('ten or more history titles exclude defaults and invalid/duplicate rows do not consume slots', () => {
  const rows = [{ title: 'ＡＮＩＭＥ 0' }, null, {}, { title: '  ' }, { title: 'anime 0' },
    ...Array.from({ length: 12 }, (_, i) => ({ title: 'Anime ' + (i + 1) }))];
  const cases = selectDailyAuditCases(rows);
  assert.equal(cases.length, 10);
  assert.deepEqual(cases.map(item => item.query), ['ＡＮＩＭＥ 0', ...Array.from({ length: 9 }, (_, i) => 'Anime ' + (i + 1))]);
  assert.ok(cases.every(item => item.origin === 'history'));
});

test('known alias replays are deduplicated and previously built snapshots stay unchanged', () => {
  const history = [{ title: 'Ave Mujica' }, { title: 'BanG Dream! Ave Mujica' }, { title: '新番' }];
  const cases = selectDailyAuditCases(history);
  assert.deepEqual(cases.slice(0, 2).map(item => item.query), ['Ave Mujica', '新番']);
  assert.equal(cases.filter(item => item.origin === 'history').length, 2);
  history.unshift({ title: '另一部' });
  assert.equal(cases[0].query, 'Ave Mujica');
  assert.equal(selectDailyAuditCases(history)[0].query, '另一部');
});

test('daily selection reads the actual persisted playback history, not watched episodes or provider URLs', async t => {
  const file = await historyFile(t);
  let now = 100;
  const history = createRecentHistory({ file, now: () => now++ });
  for (let i = 0; i < 12; i++) await history.record({ animeTitle: 'Anime ' + i, episodeName: '第9集', provider: 'AGE', url: 'https://private.example' });
  const result = await loadDailyAuditCases({ history: createRecentHistory({ file }) });
  assert.deepEqual(result.cases.map(item => item.query), Array.from({ length: 10 }, (_, i) => 'Anime ' + (11 - i)));
  assert.deepEqual(result.targetSelection, { strategy: 'recent-history-then-defaults', historyCount: 10, defaultCount: 0 });
  assert.doesNotMatch(JSON.stringify(result), /第9集|private\.example|AGE|playedAt/);
  await history.record({ animeTitle: 'Anime 3' });
  const next = await loadDailyAuditCases({ history: createRecentHistory({ file }) });
  assert.equal(next.cases[0].query, 'Anime 3');
  assert.equal(result.cases[0].query, 'Anime 11');
});

test('missing or corrupt history falls back safely without rewriting history', async t => {
  const file = await historyFile(t);
  const missing = await loadDailyAuditCases({ history: createRecentHistory({ file }) });
  assert.equal(missing.cases.length, 10); assert.equal(missing.targetSelection.defaultCount, 10);
  assert.equal(missing.targetSelection.warning, undefined);
  for (const content of ['{broken', '{}']) {
    await writeFile(file, content);
    const bad = await loadDailyAuditCases({ history: createRecentHistory({ file }) });
    assert.equal(bad.cases.length, 10); assert.equal(bad.targetSelection.historyCount, 0);
    assert.match(bad.targetSelection.warning, /using default/);
    assert.equal(await readFile(file, 'utf8'), content);
  }
});

test('AGE road preferences follow known titles even after history reorder', () => {
  const cases = selectDailyAuditCases([{ title: '新番' }, { title: 'Ave Mujica' }, { title: 'STEINS;GATE' }]);
  assert.equal(preferredAuditRoad('AGE', cases[0]), undefined);
  assert.equal(preferredAuditRoad('AGE', cases[1]), 4);
  assert.equal(preferredAuditRoad('AGE', cases[2]), 3);
  assert.equal(preferredAuditRoad('DM84', cases[1]), undefined);
  for (const [i, expected] of [3, 3, 2, 4].entries()) assert.equal(preferredAuditRoad('AGE', auditCases[i]), expected);
});

test('daily CLI previews persisted history plus defaults; non-daily smoke tests stay fixed', async t => {
  const file = await historyFile(t);
  await createRecentHistory({ file }).record({ animeTitle: '最近看的番', episodeName: '第12集' });
  const script = new URL('../tools/audit-rules.mjs', import.meta.url).pathname;
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [script, '--daily', '--list-targets', '--history-file', file]);
  const daily = JSON.parse(stdout);
  assert.equal(daily.expectedPerProvider, 10);
  assert.equal(daily.targets[0].query, '最近看的番');
  assert.equal(daily.targetSelection.historyCount, 1); assert.equal(daily.targetSelection.defaultCount, 9);
  const smoke = JSON.parse((await run(process.execPath, [script, '--list-targets', '--history-file', file])).stdout);
  assert.equal(smoke.expectedPerProvider, 4);
  assert.deepEqual(smoke.targets, auditCases);
});
