// Local, deterministic moderation. Original comments never leave the Mac for
// classification, and blocked text is neither returned nor written to logs.
const traditional = { 愛: '爱', 罵: '骂', 賤: '贱', 蕩: '荡', 姦: '奸', 強: '强', 幹: '干', 媽: '妈',
  雞: '鸡', 陰: '阴', 莖: '茎', 滾: '滚', 廢: '废', 腦: '脑', 殘: '残', 殺: '杀', 豬: '猪',
  兒: '儿', 們: '们', 麼: '么', 糞: '粪', 機: '机', 國: '国', 醫: '医', 療: '疗', 這: '这', 個: '个',
  綠: '绿', 龜: '龟', 黃: '黄', 約: '约', 號: '号', 顏: '颜', 內: '内', 騷: '骚', 蓮: '莲',
  來: '来', 閉: '闭', 準: '准', 備: '备', 輪: '轮', 頭: '头', 飛: '飞', 槍: '枪', 婦: '妇', 貨: '货' };

const categories = ['sexual', 'misogyny', 'abuse', 'personalAttack', 'custom'];
const phrases = {
  sexual: ['色情', '黄片', '黄站', '黄网', '里番', '肉番', '裸聊', '裸照', '约炮', '援交',
    '口交', '肛交', '性交', '做爱', '打炮', '打飞机', '射精', '精液', '阴茎', '阴道', '阴蒂',
    '乳交', '颜射', '内射', '足交', '手淫', '自慰', '鸡巴', '鸡吧', '龟头', '奶子', '撸管',
    '想操', '想艹', '想日她', '欠操', '欠艹', '求车牌', '求番号', '18禁'],
  misogyny: ['婊子', '婊砸', '绿茶婊', '心机婊', '白莲婊', '贱货', '贱人', '贱女人', '贱女',
    '骚货', '骚妇', '骚女人', '荡妇', '淫妇', '母狗', '母猪', '臭婊', '死肥婆', '丑八婆',
    '臭三八', '女拳狗', '女拳婊', '女拳癌', '女表子'],
  abuse: ['傻逼', '傻比', '傻b', '傻屄', '傻叉', '傻x', '傻屌', '煞笔', '傻批', '沙比', '沙雕玩意', '脑残', '弱智', '智障',
    '他妈的', '她妈的', '你妈的', '你妈死', '你娘死', '操你', '艹你', '草你', '日你',
    '干你娘', '干他娘', '去你妈', '去他妈', '他娘的', '我操', '卧槽', '窝操', '狗日的', '狗娘养',
    '狗东西', '狗杂种', '狗崽子', '王八蛋', '臭傻', '去死吧', '给我去死', '滚你', '滚蛋'],
  personalAttack: []
};

const english = {
  sexual: ['porn', 'porno', 'pornography', 'hentai', 'blowjob', 'handjob', 'cumshot', 'cumshots', 'jerkoff'],
  misogyny: ['bitch', 'bitches', 'slut', 'sluts', 'whore', 'whores', 'cunt', 'cunts', 'femoid', 'femoids'],
  abuse: ['fuck', 'fucks', 'fucked', 'fucker', 'fuckers', 'fucking', 'motherfucker', 'motherfucking',
    'fck', 'fuk', 'shit', 'shitty', 'bullshit', 'asshole', 'assholes', 'bastard', 'dickhead',
    'sb', 'nmsl', 'cnm', 'wdnmd', 'shabi', 'caonima', 'nimasile'],
  personalAttack: []
};

function normalize(text) {
  return text.normalize('NFKC').normalize('NFKD').toLowerCase().replace(/[\p{M}\p{Cf}]/gu, '').replace(/\p{Cc}/gu, ' ')
    .replace(/<[^>]{0,200}>/gu, ' ').replace(/./gu, char => traditional[char] || char);
}
const compact = text => text.replace(/[\p{P}\p{S}\p{Z}\s]/gu, '');
const leet = { a: '[a@4]', e: '[e3]', i: '[i1!]', l: '[l1]', o: '[o0]', s: '[s$5]', t: '[t7]', u: '[uü]' };
const separated = String.raw`[\p{P}\p{S}\p{Z}\s]*`;
const latinPattern = word => new RegExp('(?<![a-z0-9])' + [...word].map(char =>
  '(?:' + (leet[char] || char) + '){1,8}').join(separated) + '(?![a-z0-9])', 'u');
const latinRules = Object.fromEntries(Object.entries(english).map(([category, words]) => [category, words.map(latinPattern)]));

// Ambiguous ordinary words (garbage, shoes, buses, etc.) require a clear target
// or degrading claim. Do not block normal plot criticism or women's-rights talk.
const targeted = [
  { category: 'sexual', pattern: /(?:想干她$|(?:想|要|去|准备|一起|轮流)强奸(?:她|你))/u },
  { category: 'abuse', pattern: /(?<!妈)妈的/u },
  { category: 'misogyny', pattern: /(?:女人|女性|女的|女生|女孩子)(?:都|全|就是|是|天生|本来|只|只配|就该|就应该){1,4}(?:低等|下贱|没脑|不配|欠操|欠艹|生孩子|做家务|闭嘴|去死)/u },
  { category: 'misogyny', pattern: /(?:你|她|这个女的|这女人|女主)(?:就是|真是|是个|是一个|是|这个|个|一个){1,3}(?:公交车(?!司机|驾驶|站|票|公司|售票|乘客|迷)|破鞋(?!修理|回收))/u },
  { category: 'personalAttack', pattern: /(?:你们|他们|她们|你|您|他|她|楼上|楼主|作者|演员|主播|up主|男主|女主)(?:就是|真是|是个|是|这群|这个|这种|这|都|全是|纯纯|个|一群|简直|只会){1,4}(?:废物|垃圾(?!桶|分类|处理|回收)|蠢货|畜生|低能|纱布|丑逼|死胖子)/u },
  { category: 'personalAttack', pattern: /(?:你|他|她|演员|主播)(?:长得|丑得|胖得)(?:真|太|很|这么|那么|好){0,2}(?:恶心|丑|像猪)/u },
  { category: 'personalAttack', pattern: /(?:你|他|她|你们|他们|她们)(?:赶紧|给我|都|全家|去|就该|应该){1,3}(?:去死|死光|自杀|滚出去)/u },
  { category: 'personalAttack', pattern: /(?:你全家|你一家|你妈)(?:都|给我|赶紧|去|该){0,3}(?:死|暴毙)/u },
  { category: 'personalAttack', pattern: /(?:you(?:re|are|r)?(?:a|an|sucha)?(?:idiot|moron|loser)|killyourself)/u }
];

export function createDanmakuFilter({ extraBlockedWords = [] } = {}) {
  if (!Array.isArray(extraBlockedWords) || extraBlockedWords.length > 200 || extraBlockedWords.some(word =>
    typeof word !== 'string' || !word.trim() || word.length > 80 || !compact(normalize(word)))) {
    throw new Error('danmakuFilter.extraBlockedWords must contain at most 200 nonempty literal phrases (80 characters each).');
  }
  const custom = extraBlockedWords.map(word => compact(normalize(word)));
  function classify(text) {
    const normalized = normalize(text), joined = compact(normalized);
    const hasLatin = /[a-z]/u.test(normalized);
    for (const category of categories) {
      if ((phrases[category] || []).some(phrase => joined.includes(phrase)) ||
          (hasLatin && (latinRules[category] || []).some(pattern => pattern.test(normalized)))) return category;
    }
    for (const { category, pattern } of targeted) if (pattern.test(joined)) return category;
    return custom.some(word => joined.includes(word)) ? 'custom' : null;
  }
  return {
    classify,
    apply(comments) {
      const stats = { inputCount: comments.length, blockedCount: 0, outputCount: 0,
        byCategory: Object.fromEntries(categories.map(category => [category, 0])) };
      const allowed = comments.filter(comment => {
        const category = classify(comment.text);
        if (!category) return true;
        stats.blockedCount++; stats.byCategory[category]++; return false;
      });
      stats.outputCount = allowed.length;
      return { comments: allowed, stats };
    }
  };
}
