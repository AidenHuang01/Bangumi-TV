import test from 'node:test';
import assert from 'node:assert/strict';
import { createDanmakuFilter } from '../lib/danmaku-filter.mjs';
import { createDanmaku } from '../lib/danmaku.mjs';
import { createAutoDanmaku } from '../lib/auto-danmaku.mjs';
import { createApp } from '../app.mjs';
import { moderationCases } from './fixtures/danmaku-moderation-cases.mjs';

const filter = createDanmakuFilter();
const blocked = {
  sexual: ['发色情网站', '求番号', '口 交', '裸聊', '想操她', '想干她', '我要强奸你', 'ＰＯＲＮ', 'h.e.n.t.a.i', 'blowjob'],
  misogyny: ['这人是个婊子', '她是綠茶婊', '贱 货', '蕩婦', '死肥婆', '她就是个公交车', '女人只配生孩子',
    '女的都是低等生物', 'b1tch', 'b!tch', 'bítch', 's.l.u.t', 'wh0re', 'ＣＵＮＴ'],
  abuse: ['你是傻逼', '傻@逼', '傻\u200b逼', '腦殘', '操你妈', '日你', 'ＳＢ', 'S B', 'n.m.s.l',
    'shabi', 'caonima'],
  personalAttack: ['你真是个废物', '你就是垃圾', '作者是个蠢货', '她长得真恶心', '你应该去死',
    '你全家暴毙', 'you are an idiot', 'kill yourself']
};
for (const [category, examples] of Object.entries(blocked)) {
  test('moderation blocks ' + category + ' content and obfuscations', () => {
    for (const text of examples) assert.equal(filter.classify(text), category, JSON.stringify(text));
  });
}

for (const group of moderationCases) {
  test('balanced regression corpus: ' + group.name, () => {
    for (const text of group.texts) assert.equal(!!filter.classify(text), group.blocked, JSON.stringify(text));
  });
}

test('balanced tolerates casual exclamations; strict is server-only and explicit', () => {
  const strict = createDanmakuFilter({ profile: 'strict' });
  for (const text of ['卧槽, 这么功利', '他媽的太精彩了', '妈的，好感动', 'f.u.c.k', 'f u c k', 'fuuuck',
    'ＦＵＣＫＩＮＧ', 'hello\nfuck', '<b>fuck</b>', 'sh1t']) {
    assert.equal(filter.classify(text), null, text); assert.equal(strict.classify(text), 'abuse', text);
  }
  for (const profile of [false, 'off', 'none', 'ai']) assert.throws(() => createDanmakuFilter({ profile }), /profile/);
  assert.deepEqual(filter.policy, { version: '2', profile: 'balanced' });
});

test('explanations contain stable rule identifiers but no original or matched text', () => {
  assert.deepEqual(filter.inspect('她是个婊子'), { blocked: true, category: 'misogyny', ruleId: 'misogyny.slur', reason: '明确的性别贬损或侮辱词' });
  assert.deepEqual(filter.inspect('剧情好看'), { blocked: false, category: null, ruleId: null, reason: null });
  assert.equal(JSON.stringify(filter.inspect('你是傻逼')).includes('傻逼'), false);
});

test('duplicate rows are counted independently and decisions do not leak between calls', () => {
  const comments = Array.from({ length: 20000 }, (_, i) => ({ time: i, text: i % 2 ? '剧情好看' : '你是傻逼' }));
  const result = filter.apply(comments);
  assert.equal(result.stats.blockedCount, 10000); assert.equal(result.comments.length, 10000);
  for (let i = 0; i < 3; i++) assert.equal(filter.classify('b!tch'), 'misogyny');
  assert.equal(filter.apply([{ time: 1, text: '正常弹幕' }]).stats.blockedCount, 0);
});

test('explicit slurs survive common separator/Unicode obfuscations without rewriting allowed text', () => {
  for (const original of ['傻逼', '婊子', '裸聊', 'nmsl', 'bitch', 'porn']) {
    for (const separator of [' ', '.', ',', '！', '🐶', '\u200b', '\u2060', '\u0301', '<i></i>']) {
      assert.ok(filter.classify([...original].join(separator)), original + ' with ' + separator);
    }
  }
});

test('narrow exceptions still find subsequent abusive spans and strict preserves family dialogue', () => {
  assert.equal(filter.classify('不要叫她婊子婊子'), 'misogyny');
  assert.equal(createDanmakuFilter({ extraBlockedWords: ['卧槽'] }).classify('卧槽好看'), 'custom');
  const strict = createDanmakuFilter({ profile: 'strict' });
  for (const text of ['他妈妈的配音很好', '妈妈的蛋糕', '她不是婊子', '科普阴道', "don't kill yourself"]) {
    assert.equal(strict.classify(text), null, text);
  }
});

test('server policy cannot be relaxed by phone/TV settings or untrusted import fields', () => {
  const d = createDanmaku({ filterOptions: { profile: 'strict' } });
  d.settings({ profile: 'balanced', filterOptions: { profile: 'balanced' }, contentFilter: { enabled: false } });
  d.import('video', JSON.stringify([{ time: 1, text: '卧槽', safe: true, category: 'allowed' }]));
  assert.deepEqual(d.status().contentFilter, { enabled: true, mode: 'local-rules', version: '2', profile: 'strict' });
  assert.equal(d.read('video').count, 0);
});

test('ordinary anime, romance, women, mothers, transport and plot criticism are preserved', () => {
  for (const text of ['葬送的芙莉莲', '死亡笔记', '莉可丽丝', '她妈妈的声音真温柔', '他妈妈的配音很好',
    '妈妈的蛋糕', '女性角色写得很好', '女性应该拥有平等权利', '不要人身攻击', '这段在批评厌女',
    '这集作画真垃圾', '垃圾桶在旁边', '这是废物利用', '主角用纱布包扎伤口', '她是公交车司机',
    '公交车快来了', '他穿了一双破鞋', '她想干她的工作', '这对笨蛋情侣好可爱', '草原上的日常',
    '这个操作很强', '2B这个角色不错', '她就是个公交车司机', '她是公交车乘客', 'USB-C', 'SBS电视台',
    'class assignment', 'Scunthorpe', 'grape juice', 'the title is classic']) {
    assert.equal(filter.classify(text), null, text);
  }
});

test('filter keeps allowed comments byte-for-byte and returns counts, not rejected text', () => {
  const comments = [{ time: 1, text: '你是傻逼', mode: 1 }, { time: 2, text: '剧情好看', mode: 5, color: '#ff0000' },
    { time: 3, text: '她是个婊子', mode: 1 }];
  const result = filter.apply(comments);
  assert.deepEqual(result.comments, [comments[1]]);
  assert.deepEqual(result.stats, { inputCount: 3, blockedCount: 2, outputCount: 1,
    byCategory: { sexual: 0, misogyny: 1, abuse: 1, personalAttack: 0, custom: 0 } });
  assert.equal(comments.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /傻逼|婊子/);
});

test('custom phrases are bounded literals and cannot disable builtin moderation', () => {
  const extra = createDanmakuFilter({ extraBlockedWords: ['活动广告', 'a.*b'] });
  assert.equal(extra.classify('活 动 广 告'), 'custom');
  assert.equal(extra.classify('axxxxxb'), null);
  assert.equal(extra.classify('傻逼'), 'abuse');
  for (const words of ['not-an-array', [''], ['***'], [null], ['x'.repeat(81)], Array(201).fill('a')]) {
    assert.throws(() => createDanmakuFilter({ extraBlockedWords: words }), /extraBlockedWords/);
  }
});

test('all imports share moderation: normalized JSON, Dandan JSON, Kazumi cache and Bilibili XML', () => {
  for (const content of [
    JSON.stringify([{ time: 1, text: '你是傻逼' }, { time: 2, text: '正常弹幕' }]),
    JSON.stringify({ comments: [{ p: '1,1,16777215,u', m: '你是傻逼' }, { p: '2,1,16777215,u', m: '正常弹幕' }] }),
    JSON.stringify({ danmakus: [{ p: '1,1,16777215,u', m: '你是傻逼' }, { p: '2,1,16777215,u', m: '正常弹幕' }] }),
    '<i><d p="1,1,25,16777215">你是傻&#36924;</d><d p="2,1,25,16777215">正常弹幕</d></i>'
  ]) {
    const d = createDanmaku(); const result = d.import('video', content);
    assert.equal(result.count, 1); assert.equal(result.filtering.blockedCount, 1);
    assert.deepEqual(d.read('video').comments.map(item => item.text), ['正常弹幕']);
    assert.equal(d.read('video', d.read('video').version).unchanged, true);
    d.settings({ contentFilter: { enabled: false } });
    assert.equal(d.status().contentFilter.enabled, true);
  }
});

test('provider attachment, native core and direct API results are moderated at the same sink', async () => {
  const data = { comments: [{ p: '1,1,16777215,u', m: '剧情好看' }, { p: '2,1,16777215,u', m: '你是傻逼' }] };
  const configurations = [
    { provider: { comments: async () => ({ content: JSON.stringify(data), source: 'aggregate' }) } },
    { core: { danmakuComments: async () => data }, coreConfigured: true },
    { appId: 'test-id', appSecret: 'test-secret', fetcher: async () => Response.json(data) }
  ];
  for (const configuration of configurations) {
    const d = createDanmaku(configuration); await d.attach('video', 1230001);
    assert.equal(d.read('video').count, 1); assert.equal(d.read('video').filtering.blockedCount, 1);
    assert.equal(d.read('video').comments[0].text, '剧情好看');
  }
});

test('an all-blocked acquisition is completed once, not retried or replaced with unfiltered comments', async t => {
  let calls = 0;
  const d = createDanmaku();
  const auto = createAutoDanmaku({ danmaku: d, delay: 0, cache: { list: async () => ({ items: [] }) },
    acquire: async () => { calls++; return { content: JSON.stringify([{ time: 1, text: '你是傻逼' }]) }; } });
  t.after(() => auto.close());
  const stream = { id: 'video', animeTitle: '莉可丽丝', episodeName: '第1集' };
  auto.observe(stream); await auto.settled(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(auto.status('video').state, 'loaded'); assert.equal(d.read('video').count, 0);
  assert.equal(d.read('video').filtering.blockedCount, 1);
  auto.observe(stream); await auto.settled(); assert.equal(calls, 1);
});

test('TV and phone HTTP endpoints never deliver the blocked text, only aggregate statistics', async t => {
  const id = 'anime-' + 'a'.repeat(32), d = createDanmaku();
  d.import(id, JSON.stringify([{ time: 1, text: '你是傻逼' }, { time: 2, text: '剧情好看' }]));
  const server = createApp({ discovery: { stream: key => key === id ? {} : null, close: async () => {} }, danmaku: d });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const suffix of ['', '?client=phone']) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/danmaku/' + id + suffix);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.count, 1); assert.equal(data.filtering.blockedCount, 1);
    assert.doesNotMatch(JSON.stringify(data), /傻逼/);
  }
});
