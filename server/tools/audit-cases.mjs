const normalize = title => title.toLowerCase().replace(/[\s!！:：.·_-]/g, '');
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
