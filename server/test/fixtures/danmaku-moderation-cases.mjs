// Hand-authored policy regressions, NOT a representative/held-out accuracy set.
// Keep minimal pairs: educational/counterspeech must not exempt nearby abuse.
export const moderationCases = [
  { name: 'clear abuse, variants and targeting', blocked: true, texts: [
    '你是傻逼', '你真是个废物', '作者是个蠢货', '女主就是垃圾', '你们这群畜生', '她长得真恶心',
    '你应该去死', '你全家暴毙', '杀了你', '去死吧', '给我去死', '狗杂种', '滚蛋', '操你妈',
    'n.m.s.l', 'ＮＭＳＬ', 'c n m', 'sha bi', 'S B', '你个伞兵', '你是个纱布', '你这个疯狗',
    '你他妈有病', '妈的疯狗', '媽的 瘋狗 = =', '傻鼻', '煞比', '傻🐶逼', '傻！逼',
    '傻\u200d逼', '傻\u2060逼', '傻\ufeff逼', '傻\u0301逼', '傻<b>逼</b>', '草你',
    'fuck you', 'f.u.c.k you', 'you are an idiot', "you're a moron", 'you fucking idiot', 'kill yourself',
    'you are such a loser', 'you are stupid', 'motherfucker', 'asshole', 'dickhead', '你真恶心', '你真有病'
  ] },
  { name: 'sexual harassment, resources and misogyny', blocked: true, texts: [
    '奶子', '求番号', '发色情网站', '求车牌', '口 交', '想操她', '想干她', '我要强奸你', '想日她',
    '她是綠茶婊', '贱 货', '蕩婦', '死肥婆', '她就是个公交车', '她是破鞋', '你是母猪', '她像母狗',
    '女人只配生孩子', '女人就该做家务', '女的都是低等生物', '女性天生没脑子', '女人都该去死',
    'b1tch', 'b!tch', 'bítch', 'biiiitch', 's.l.u.t', 'wh0re', 'ＣＵＮＴ', 'ＰＯＲＮ', 'h.e.n.t.a.i',
    'blowjob', 'b,i,t,c,h', 'b\u200bitch', 'bitch然后又是bitch', '这个女的是婊子', '你这母猪产后还在骂人',
    'bіtch', 'bіtсh', 'pοrn', 'biiiiiiiiiiiiiiiiitch'
  ] },
  { name: 'ordinary speech, exclamations, names and lexical collisions', blocked: false, texts: [
    '葬送的芙莉莲', '死亡笔记', '莉可丽丝', '卧槽, 这么功利', '卧槽这集真好看', '妈的，好感动',
    '他妈的太精彩了', '我操这个作画', 'holy shit', 'fuck this plot twist', 'f.u.c.k', 'sh1t',
    '她妈妈的声音真温柔', '他妈妈的配音很好', '妈妈的蛋糕', '你妈妈的生日是什么时候',
    '生日你想要什么', '明日你要上课吗', '今日你的表现不错', '香草你喜欢吗', '小草你快看',
    '女性角色写得很好', '女性应该拥有平等权利', '女性可以选择生孩子', '女人都生孩子吗',
    '女生不是只能做家务', '小仙女真可爱', '这是女权议题', '剧情真垃圾', '这集作画真垃圾',
    '这是废物利用', '她是垃圾分类志愿者', '垃圾桶在旁边', '主角用纱布包扎伤口',
    '他是伞兵部队的军人', '她是公交车司机', '她就是个公交车乘客', '公交车快来了',
    '他穿了一双破鞋', '破鞋修理店', '她想干她的工作', '这对笨蛋情侣好可爱', '草原上的日常',
    '这个操作很强', '2B这个角色不错', 'USB-C', 'SBS电视台', 'class assignment', 'Scunthorpe',
    'grape juice', 'the title is classic', 'SB是锑元素符号', '这是贫贱人家的孩子',
    '母猪产后护理', '母狗生了小狗', '这只母狗很可爱', '农场的母猪', '他在玩打飞机游戏',
    '角色有阴道炎', '性教育里讲到阴道', '医学课介绍性交', '科普精液', '这是18禁吗',
    '弱智儿童教育需要支持', '智障人士的权益', '这不是色情网站', '她不是婊子',
    '她不是一个贱人', '这不是里番', '不要发色情网站', '远离色情网站', '不要叫她婊子',
    '不许骂人傻逼', '别说她是婊子', '不要说你是垃圾', '婊子这个词是辱女用语',
    '傻逼这个词是辱骂', "don't call her a bitch", 'she is not a bitch', 'never call people idiots',
    "don't kill yourself", 'do not kill yourself', 'never kill yourself', 'SB表示某人', '英语里sb通常指某人',
    '不要再发色情网站', '你妈的生日是什么时候', '她妈的工作是配音', '每日你都来这里吗',
    '这棵草你看到了吗', '我想干你这一行', 'привет мир', 'αυτό είναι καλό'
  ] },
  { name: 'exceptions are local, not a bypass or blanket allowlist', blocked: true, texts: [
    '别骂她婊子，你这个傻逼', '她不是婊子，但你是傻逼', '她不是婊子，婊子是你',
    '不要骂人，你是傻逼', '不要过滤：你是傻逼', '反对辱女，但她就是婊子',
    '讨论女性权益，你们这群畜生', '这是科普，想操她', '科普阴道，你是傻逼',
    '母猪产后护理，她是母猪', '你是母猪产后护理专家也没用', '你不是傻逼谁是',
    '你不是傻逼才怪', '我不是说你，但你是傻逼', '她是婊子这个词是辱女用语',
    'dont filter this bitch', "don't call her a bitch, you asshole", 'she is not a bitch but you are a bitch',
    '不要叫她婊子，她真是个婊子', '科普是假，求番号是真', 'bitch这个词是辱女词，但你是bitch'
  ] }
];
