import { createRecentHistory } from '../lib/recent-history.mjs';

const normalize = title => title.normalize('NFKC').toLowerCase().replace(/[\s!！:：.·_-]/g, '');
export const auditCases = [
  { query: '葬送的芙莉莲', aliases: ['葬送的芙莉莲'] },
  { query: '命运石之门', aliases: ['命运石之门', 'STEINS;GATE', 'シュタインズ・ゲート'] },
  { query: '死亡笔记', aliases: ['死亡笔记', 'DEATH NOTE'] },
  { query: 'Ave Mujica', aliases: ['BanG Dream! Ave Mujica', 'BanG Dream! 颂乐人偶', '颂乐人偶', 'Ave Mujica'] }
];
export const dailyAuditCases = auditCases.concat([
  { query: '鬼灭之刃', aliases: ['鬼灭之刃', '鬼灭之刃 第一季'] },
  { query: '进击的巨人', aliases: ['进击的巨人', '进击的巨人 第一季'] },
  { query: '紫罗兰永恒花园', aliases: ['紫罗兰永恒花园'] },
  { query: '孤独摇滚', aliases: ['孤独摇滚', '孤独摇滚！', 'ぼっち・ざ・ろっく！'] },
  { query: '间谍过家家', aliases: ['间谍过家家', '间谍过家家 第一季', 'SPY×FAMILY'] },
  { query: '夏日重现', aliases: ['夏日重现'] }
]);

// History is already ordered newest-first by the same store used by the phone.
// Snapshot once per audit so every provider is checked against identical titles.
export function selectDailyAuditCases(history) {
  const cases = [], seen = new Set();
  function add(item, origin) {
    if (cases.length >= 10 || item.aliases.some(alias => seen.has(normalize(alias)))) return;
    cases.push({ query: item.query, aliases: [...item.aliases], origin });
    for (const alias of item.aliases) seen.add(normalize(alias));
  }
  for (const row of history) {
    const title = typeof row?.title === 'string' ? row.title.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
    if (!title) continue;
    const known = dailyAuditCases.find(item => item.aliases.some(alias => normalize(alias) === normalize(title)));
    add({ query: title, aliases: [...new Set([title, ...(known?.aliases || [])])] }, 'history');
  }
  for (const item of dailyAuditCases) add(item, 'default');
  return cases;
}

export async function loadDailyAuditCases({ history = createRecentHistory() } = {}) {
  let rows = [], warning;
  try { rows = await history.list(); }
  catch { warning = 'Recently played history could not be read; using default audit targets.'; }
  const cases = selectDailyAuditCases(rows);
  return { cases, targetSelection: { strategy: 'recent-history-then-defaults',
    historyCount: cases.filter(item => item.origin === 'history').length,
    defaultCount: cases.filter(item => item.origin === 'default').length,
    ...(warning ? { warning } : {}) } };
}

// Existing AGE preferences belong to titles, not positions in a dynamic list.
export function preferredAuditRoad(provider, testCase) {
  if (provider !== 'AGE') return undefined;
  const index = auditCases.findIndex(item => testCase.aliases.some(alias => item.aliases.some(name => normalize(name) === normalize(alias))));
  return [3, 3, 2, 4][index];
}

export function selectAuditTitle(items, testCase) {
  const aliases = new Set(testCase.aliases.map(normalize));
  return items.find(item => aliases.has(normalize(item.title)));
}

export function selectAuditEpisode(episodes, number = 1) {
  return episodes.find(episode => {
    const match = String(episode.name).replace(/\s/g, '').match(/^(?:第|EP)?0*(\d+)(?:集|话|話)?$/i);
    return match && Number(match[1]) === number;
  });
}
