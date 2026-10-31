// Local moderation, not a semantic classifier. Never log comments or send them
// to a moderation API. Exceptions apply to individual spans, NOT whole rows.
export const danmakuFilterVersion = '2';
const traditional = { 愛: '爱', 罵: '骂', 賤: '贱', 蕩: '荡', 姦: '奸', 強: '强', 幹: '干', 媽: '妈',
  雞: '鸡', 陰: '阴', 莖: '茎', 滾: '滚', 廢: '废', 腦: '脑', 殘: '残', 殺: '杀', 豬: '猪',
  兒: '儿', 們: '们', 麼: '么', 糞: '粪', 機: '机', 國: '国', 醫: '医', 療: '疗', 這: '这', 個: '个',
  綠: '绿', 龜: '龟', 黃: '黄', 約: '约', 號: '号', 顏: '颜', 內: '内', 騷: '骚', 蓮: '莲',
  來: '来', 閉: '闭', 準: '准', 備: '备', 輪: '轮', 頭: '头', 飛: '飞', 槍: '枪', 婦: '妇', 貨: '货',
  對: '对', 說: '说', 詞: '词', 稱: '称', 為: '为', 當: '当', 該: '该', 錯: '错', 惡: '恶',
  醜: '丑', 瘋: '疯', 馬: '马', 課: '课', 學: '学', 術: '术', 檢: '检', 發: '发', 育: '育',
  產: '产', 後: '后', 養: '养', 寵: '宠', 動: '动', 實: '实', 兩: '两', 還: '还', 業: '业',
  駕: '驾', 駛: '驶', 乘: '乘', 務: '务', 權: '权', 離: '离', 遠: '远', 給: '给' };
const categories = ['sexual', 'misogyny', 'abuse', 'personalAttack', 'custom'];
const ignored = /[\p{P}\p{S}\p{Z}\s]/u;
const compact = text => text.replace(/[\p{P}\p{S}\p{Z}\s]/gu, '');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = list => '(?:' + list.sort((a, b) => b.length - a.length).map(escape).join('|') + ')';
const confusables = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's',
  ο: 'o', ι: 'i', α: 'a' };
function normalize(text) {
  return text.normalize('NFKC').normalize('NFKD').toLowerCase()
    .replace(/[\p{M}\p{Cf}]/gu, '').replace(/\p{Cc}/gu, char => /[\r\n]/u.test(char) ? '\n' : ' ')
    .replace(/<\/?[a-z][^>]{0,199}>/gu, '').replace(/./gu, char => traditional[char] || char)
    // Only mixed Latin tokens: never transliterate entire foreign-language text.
    .replace(/[a-z\u0370-\u03ff\u0400-\u04ff]+/gu, token => /[a-z]/u.test(token)
      ? [...token].map(char => confusables[char] || char).join('') : token)
    .replace(/([a-z])\1{2,}/gu, '$1$1');
}
function viewOf(source) {
  let text = ''; const starts = [], ends = [];
  for (let i = 0; i < source.length;) {
    const char = String.fromCodePoint(source.codePointAt(i)), end = i + char.length;
    if (!ignored.test(char)) {
      text += char;
      for (let j = 0; j < char.length; j++) { starts.push(i); ends.push(end); }
    }
    i = end;
  }
  return { text, starts, ends };
}
const leet = { a: '[a@4]', e: '[e3]', i: '[i1!]', l: '[l1]', o: '[o0]', s: '[s$5]', t: '[t7]', u: '[uü]' };
// Bounds keep adversarial punctuation/repetitions from causing expensive scans.
const gap = String.raw`[\p{P}\p{S}\p{Z}\s]{0,4}`;
const latinWord = word => [...word].map(char => '(?:' + (leet[char] || escape(char)) + '){1,3}').join(gap);
const latinWords = list => '(?<![a-z0-9])(?:' + list.map(latinWord).join('|') + ')(?![a-z0-9])';
const rule = (id, category, reason, expression, options = {}) => ({ id, category, reason,
  pattern: new RegExp(expression, 'gu'), ...options });
const target = '(?:你们|他们|她们|你|您|他|她|楼上|楼主|作者|演员|主播|up主|男主|女主|这群人)';
const bridge = '(?:就是|真是|是个|是一个|是|这群|这个|这种|这|都|全是|纯纯|个|一群|简直|只会){0,4}';
const profanity = ['我操', '卧槽', '窝操', '我艹', '我草', '他妈的', '她妈的', '他娘的', '妈的'];
const casualEnglish = ['fuck', 'fucks', 'fucked', 'fucking', 'fck', 'fuk', 'shit', 'shitty', 'bullshit'];
const rules = [
  rule('sexual.explicit', 'sexual', '露骨色情或色情资源招揽', words(['色情网站', '色情视频', '黄片', '黄站', '黄网',
    '里番', '肉番', '裸聊', '裸照', '约炮', '援交', '乳交', '颜射', '内射', '足交', '撸管', '鸡巴', '鸡吧',
    '奶子', '求车牌', '求番号', '求黄网', '无码资源', '18禁资源']), { contextual: true }),
  rule('sexual.adult-term', 'sexual', '性行为或露骨生理词汇', words(['口交', '肛交', '性交', '做爱', '射精', '精液',
    '阴茎', '阴道', '阴蒂', '龟头', '手淫', '自慰']), { contextual: true, medical: true }),
  rule('sexual.harassment', 'sexual', '针对个人的性骚扰或性暴力表达',
    '(?:(?:想|要|真想|好想|让我|我要|一起|轮流)(?:操|艹|肏|日|干)(?:你|她|他)(?!的工作|活|事|这(?:一)?行)|(?:想|要|去|准备|一起|轮流)强奸(?:她|你|他)|欠操|欠艹)', { contextual: true }),
  rule('sexual.activity', 'sexual', '明确的性活动表达', '(?:打飞机(?!场|游戏|模拟|大战)|打炮(?!弹|兵|游戏))', { contextual: true }),
  rule('misogyny.slur', 'misogyny', '明确的性别贬损或侮辱词', words(['婊子', '婊砸', '绿茶婊', '心机婊', '白莲婊',
    '贱货', '贱女人', '贱女', '骚货', '骚妇', '骚女人', '荡妇', '淫妇', '臭婊', '死肥婆', '丑八婆',
    '臭三八', '女拳狗', '女拳婊', '女拳癌', '女表子', '集美癌']), { contextual: true }),
  rule('misogyny.degrading', 'misogyny', '贬损人格或以动物称呼女性', '(?:(?<!贫)贱人(?!家)|母狗|母猪)', { contextual: true, animal: true }),
  rule('misogyny.group', 'misogyny', '贬低女性群体或强制性别角色',
    '(?:女人|女性|女的|女生|女孩子)(?:(?:都|全|就是|是|天生|本来|只|只配|就该|就应该|该){1,4}(?:低等|下贱|没脑|不配|欠操|欠艹|去死)|(?:都|全|天生|本来){0,2}(?:只配|就该|就应该|应该只)(?:生孩子|做家务|闭嘴))', { contextual: true }),
  rule('misogyny.metaphor', 'misogyny', '针对个人的性羞辱隐喻',
    '(?:你|她|这个女的|这女人|女主)' + bridge + '(?:公交车(?!司机|驾驶|站|票|公司|售票|乘客|迷)|破鞋(?!修理|回收))', { contextual: true }),
  rule('abuse.slur', 'abuse', '明确辱骂或常见谐音辱骂',
    '(?:傻[逼比b屄叉x屌批鼻]|煞[笔比逼]|沙比(?!赛)|脑残|弱智(?!学校|教育|儿童)|智障(?!人士|儿童|康复)|沙雕玩意|狗日的|狗娘养|狗东西|狗杂种|狗崽子|王八蛋|臭傻)', { contextual: true }),
  rule('abuse.family', 'abuse', '针对个人或家属的辱骂',
    '(?:你妈的$|你妈死(?!里逃生)|你娘死|[操艹肏]你|草你(?:妈|娘|全家|大爷)|^草你$|日你(?:妈|娘|全家|大爷)|^日你$|干你娘|干他娘|去你妈|去他妈)', { contextual: true }),
  rule('abuse.imperative', 'abuse', '辱骂性驱逐或死亡诅咒', '(?:去死吧|给我去死|滚你|滚蛋|杀了你)', { contextual: true }),
  rule('attack.degrading', 'personalAttack', '针对个人的人格贬损', target + bridge +
    '(?:废物(?!利用|回收)|垃圾(?!桶|分类|处理|回收)|蠢货|畜生|低能(?!耗|量)|纱布(?!包扎|绷带)|伞兵(?!部队|训练|旅|团|营)|丑逼|死胖子|疯狗)', { contextual: true }),
  rule('attack.appearance', 'personalAttack', '针对个人外貌的恶意攻击', target +
    '(?:长得|丑得|胖得)(?:真|太|很|这么|那么|好){0,2}(?:恶心|丑|像猪)', { contextual: true }),
  rule('attack.contempt', 'personalAttack', '针对个人的恶意贬低', target +
    '(?:真是|真|太|就是|这个|有够)(?:恶心(?!得|到|地)|有病|不要脸)', { contextual: true }),
  rule('attack.threat', 'personalAttack', '针对个人的死亡诅咒或驱逐', target +
    '(?:赶紧|给我|都|全家|去|就该|应该|最好){1,3}(?:去死|死光|自杀|滚出去)', { contextual: true }),
  rule('attack.family', 'personalAttack', '针对家属的死亡诅咒', '(?:你全家|你一家|你妈)(?:都|给我|赶紧|去|该){0,3}(?:死|暴毙)', { contextual: true }),
  rule('attack.casual-target', 'personalAttack', '粗口用于直接辱骂或贬低他人',
    '(?:' + words(profanity) + '(?:你|她|他)' + bridge + '(?:有病|疯狗|恶心|不要脸)|(?:你|她|他)(?:他妈|他娘|妈的)(?:的)?(?:有病|疯了|恶心|不要脸)|(?<![她他你])妈的疯狗)', { contextual: true }),
  rule('sexual.english', 'sexual', '英文露骨色情词', latinWords(['porn', 'porno', 'pornography', 'hentai', 'blowjob', 'handjob', 'cumshot', 'cumshots', 'jerkoff']), { latin: true, contextual: true }),
  rule('misogyny.english', 'misogyny', '英文性别侮辱词', latinWords(['bitch', 'bitches', 'slut', 'sluts', 'whore', 'whores', 'cunt', 'cunts', 'femoid', 'femoids']), { latin: true, contextual: true }),
  rule('abuse.english', 'abuse', '英文辱骂或拼音缩写', latinWords(['fucker', 'fuckers', 'motherfucker', 'motherfucking',
    'asshole', 'assholes', 'bastard', 'dickhead', 'sb', 'nmsl', 'cnm', 'wdnmd', 'shabi', 'caonima', 'nimasile']), { latin: true, contextual: true }),
  rule('attack.english', 'personalAttack', '英文直接人身攻击',
    String.raw`\byou(?:\s+are|['’]re|\s+r)?\s+(?:(?:a|an|such\s+a|fucking)\s+){0,2}(?:idiot|moron|loser|stupid)\b|\bkill\s+yourself\b|` + latinWords(['fuck']) + String.raw`\s+you\b`, { latin: true, contextual: true }),
  rule('abuse.casual-cn', 'abuse', '严格模式下的普通粗口', words(profanity.filter(word => word !== '妈的')) + '|(?<!妈)妈的', { strict: true, contextual: true }),
  rule('abuse.casual-en', 'abuse', '严格模式下的普通英文粗口', latinWords(casualEnglish), { strict: true, latin: true, contextual: true })
];

function isContextualException(rule, source, start, end) {
  const beforeRaw = source.slice(0, start).split(/[，,。！？!?；;\n]/u).at(-1);
  const afterRaw = source.slice(end).split(/[，,。！？!?；;\n]/u)[0];
  const before = compact(beforeRaw), after = compact(afterRaw), hit = compact(source.slice(start, end));
  const rhetorical = /^(?:谁是|是什么|才怪|就怪了|才有鬼)/u.test(after);
  if (!rhetorical && /(?:不是|并非|绝非)(?:个|一个)?$/u.test(before)) return true;
  if (/(?:别|不要|不许|不能|禁止|不该|不应该)(?:再|随便|这样)?(?:叫|骂|喊|称|说)(?:别人|人家|女性|女孩子|人|她|他|你)?(?:是|为|作|成)?$/u.test(before)) return true;
  if (/^(?:讨论|解释|所谓|关于)?$/u.test(before) && /^(?:这个词|一词|这种称呼|这种说法)(?:是|属于|带有|有|不应该|不该|不能|很)?(?:脏话|辱骂|人身攻击|侮辱|歧视|贬义|冒犯|辱女)/u.test(after)) return true;
  if (/^(?:不要|别|禁止|远离|拒绝|抵制)(?:再)?(?:传播|转发|发布|发|看|观看)?$/u.test(before) && rule.category === 'sexual') return true;
  if (rule.medical && (/(?:医学|生理|健康|生物|课本|医生|科普|性教育|妇科)(?:课|上|里|讲|讲到|介绍|讨论|中的|知识|有关|关于){0,4}$/u.test(before) ||
      /^(?:炎|癌|疾病|疼痛|感染|发育|结构|手术|检查|损伤|健康|切除)/u.test(after))) return true;
  if (rule.animal && /^(?:母猪|母狗)$/u.test(hit) &&
      !/(?:你|她|女主|女人|女性)(?:是|像|就是|真是|这只|这|个|一只){0,3}$/u.test(before) &&
      (/(?:这只|那只|一只|两只|养殖场的|农场的|宠物|饲养的)$/u.test(before) || /^(?:产后|产仔|生了|生小|喂养|养殖|饲养|护理|配种|哺乳)/u.test(after))) return true;
  if (rule.latin) {
    if (/(?:\b(?:dont|don't|do not|never|stop)\s+(?:call|calling)\s+(?:her|him|them|people|me)\s+(?:a\s+)?|\b(?:isnt|isn't|is not|not)\s+(?:a\s+)?)$/u.test(beforeRaw)) return true;
    if (/^sb$/u.test(hit) && /^(?:是|表示|代表)?(?:锑|元素符号)/u.test(after)) return true;
    if (/^sb$/u.test(hit) && (/(?:英语里|英语中|语法中)$/u.test(before) || /^(?:表示|代表|是)(?:某人|someone)/u.test(after))) return true;
    if (rule.id === 'attack.english' && /^killyourself$/u.test(hit) && /\b(?:don't|do not|never)\s+$/u.test(beforeRaw)) return true;
  }
  return false;
}

export function createDanmakuFilter({ extraBlockedWords = [], profile = 'balanced' } = {}) {
  if (!['balanced', 'strict'].includes(profile)) throw new Error('danmakuFilter.profile must be balanced or strict.');
  if (!Array.isArray(extraBlockedWords) || extraBlockedWords.length > 200 || extraBlockedWords.some(word =>
    typeof word !== 'string' || !word.trim() || word.length > 80 || !compact(normalize(word)))) {
    throw new Error('danmakuFilter.extraBlockedWords must contain at most 200 nonempty literal phrases (80 characters each).');
  }
  const custom = extraBlockedWords.map(word => compact(normalize(word)));
  const active = rules.filter(rule => !rule.strict || profile === 'strict');
  function inspect(text) {
    const source = normalize(text), view = viewOf(source), hasLatin = /[a-z]/u.test(source);
    if (custom.some(word => view.text.includes(word))) return { blocked: true, category: 'custom', ruleId: 'custom.literal', reason: '服务器自定义屏蔽词' };
    for (const rule of active) {
      if (rule.latin && !hasLatin) continue;
      for (const match of (rule.latin ? source : view.text).matchAll(rule.pattern)) {
        const start = rule.latin ? match.index : view.starts[match.index];
        const end = rule.latin ? match.index + match[0].length : view.ends[match.index + match[0].length - 1];
        if (rule.contextual && isContextualException(rule, source, start, end)) continue;
        return { blocked: true, category: rule.category, ruleId: rule.id, reason: rule.reason };
      }
    }
    return { blocked: false, category: null, ruleId: null, reason: null };
  }
  return {
    policy: Object.freeze({ version: danmakuFilterVersion, profile }),
    inspect,
    classify: text => inspect(text).category,
    apply(comments) {
      const stats = { inputCount: comments.length, blockedCount: 0, outputCount: 0,
        byCategory: Object.fromEntries(categories.map(category => [category, 0])) };
      // Episode-local only: repeated rows cost one decision, no persistent store
      // of rejected text. Each occurrence still contributes to the counts.
      const decisions = new Map();
      const allowed = comments.filter(comment => {
        if (!decisions.has(comment.text)) decisions.set(comment.text, inspect(comment.text).category);
        const category = decisions.get(comment.text);
        if (!category) return true;
        stats.blockedCount++; stats.byCategory[category]++; return false;
      });
      stats.outputCount = allowed.length;
      return { comments: allowed, stats };
    }
  };
}
