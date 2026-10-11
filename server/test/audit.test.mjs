import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCases, selectAuditTitle, selectAuditEpisode } from '../tools/audit-cases.mjs';

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
