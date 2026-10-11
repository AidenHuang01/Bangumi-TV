const normalize = title => title.toLowerCase().replace(/[\s!！:：.·_-]/g, '');
export const auditCases = [
  { query: '葬送的芙莉莲', aliases: ['葬送的芙莉莲'] },
  { query: '命运石之门', aliases: ['命运石之门', 'STEINS;GATE', 'シュタインズ・ゲート'] },
  { query: '死亡笔记', aliases: ['死亡笔记', 'DEATH NOTE'] },
  { query: 'Ave Mujica', aliases: ['BanG Dream! Ave Mujica', 'BanG Dream! 颂乐人偶', '颂乐人偶', 'Ave Mujica'] }
];
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
