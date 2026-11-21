/**
 * lexicon-core.js —— 纯数据层：功能词、不规则动词、构词后缀、否定与虚拟标记。
 * 无任何依赖，可被 segment.js / parse.js 直接查询。全部用 Set 便于 O(1) 命中。
 */

/** 限定词 / 冠词 */
export const DETERMINERS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "my", "your", "his", "her", "its",
  "our", "their", "whose", "each", "every", "either", "neither", "no", "some", "any",
  "all", "both", "half", "such", "another", "other", "certain", "several", "many", "much",
  "few", "little", "more", "most", "less", "least", "enough", "whatever", "whichever",
  "any", "no", "whole", "same", "own", "former", "latter", "last", "next"
]);

/** 介词（含常见复合介词的首词） */
export const PREPOSITIONS = new Set([
  "of", "in", "on", "at", "to", "for", "from", "with", "by", "about", "against", "between",
  "among", "through", "during", "before", "after", "above", "below", "under", "over", "into",
  "onto", "upon", "within", "without", "toward", "towards", "across", "along", "around",
  "behind", "beyond", "beside", "besides", "despite", "except", "inside", "outside", "per",
  "via", "versus", "unlike", "including", "concerning", "regarding", "throughout", "toward",
  "amid", "amongst", "atop", "beneath", "beyond", "past", "since", "till", "until", "up",
  "down", "off", "out", "than", "as", "like", "near", "opposite", "pending", "notwithstanding",
  "given", "barring", "following", "excluding", "assuming", "considering"
]);

/** 复合介词（必须整体识别，逐词拆会误判） */
export const COMPOUND_PREPOSITIONS = [
  "in spite of", "on behalf of", "in terms of", "by means of", "in front of", "in case of",
  "in charge of", "in favor of", "in favour of", "on account of", "by virtue of",
  "at the expense of", "in the wake of", "in the light of", "in the face of",
  "for the sake of", "with respect to", "with regard to", "in contrast to",
  "in addition to", "in accordance with", "in line with", "as opposed to",
  "prior to", "due to", "owing to", "thanks to", "according to", "contrary to",
  "regardless of", "irrespective of", "instead of", "apart from", "as for", "as to",
  "because of", "in return for", "on top of", "out of", "up to", "so as to",
  "as a result of", "at the cost of", "at the mercy of", "in exchange for",
  "to the extent that", "on the grounds that", "for fear that", "in order that",
  "insofar as", "in that", "save for", "but for", "except for"
];

/** 协调连词 */
export const CONJ_COORD = new Set(["and", "or", "but", "nor", "yet", "so", "for"]);

/** 关联连词（成对出现，标记并列结构跨度） */
export const CONJ_CORRELATIVE = [
  "not only", "but also", "either", "neither", "both", "whether", "as well as",
  "rather than", "not...but", "no sooner", "hardly", "scarcely"
];

/** 关系词 / 从句引导词——按功能分类，这是判定「修饰谁」的关键 */
export const RELATIVIZERS = new Set([
  "who", "whom", "whose", "which", "that", "where", "when", "why", "whereby", "wherein"
]);

/** 名词性从句引导词 */
export const NOUN_CLAUSE_MARKERS = new Set([
  "that", "whether", "if", "what", "whatever", "who", "whoever", "whom", "whomever",
  "which", "whichever", "why", "how", "when", "where", "wherever"
]);

/** 状语从句引导词（只收「单词形态确实能引导状语从句」的词；复合引导词见 ADVERBIAL_PHRASES） */
export const ADVERBIAL_SUBORDINATORS = new Set([
  "because", "since", "as", "for", "whereas", "although", "though", "if", "unless",
  "provided", "providing", "supposing", "assuming", "given", "once", "when", "whenever",
  "while", "whilst", "before", "after", "until", "till", "where", "wherever", "whether",
  "lest", "now", "immediately", "directly", "instantly", "however", "whatever",
  "whichever", "whoever"
]);

/** 形似连词、实为介词的词：必须先按介词处理，否则会把介词短语误判成从句 */
export const PREP_FIRST = new Set([
  "by", "in", "on", "at", "of", "to", "with", "from", "about", "against", "through",
  "during", "above", "below", "under", "over", "into", "within", "without", "despite",
  "except", "beyond", "beside", "besides", "via", "per", "than", "like", "unlike",
  "notwithstanding", "pending", "barring", "following", "excluding", "considering"
]);

/** 常见状语从句引导短语（整体匹配） */
export const ADVERBIAL_PHRASES = [
  "even if", "even though", "only if", "if only", "as if", "as though",
  "so that", "such that", "in order that", "now that", "in case", "as long as",
  "so long as", "as far as", "as soon as", "no matter how", "no matter what",
  "no matter where", "no sooner than", "hardly when", "scarcely when",
  "the moment", "the instant", "the minute", "by the time", "each time",
  "every time", "rather than", "insofar as", "to the extent that",
  "on condition that", "provided that", "supposing that", "given that",
  "for all that", "much as", "however much", "just as"
];

/** 主语代词 */
export const PRONOUN_SUBJ = new Set(["i", "you", "he", "she", "it", "we", "they", "one"]);
/** 宾语/其他代词 */
export const PRONOUN_OBJ = new Set([
  "me", "him", "her", "us", "them", "it", "you", "ones", "one", "themselves", "himself",
  "herself", "itself", "myself", "yourself", "ourselves", "yourselves", "each other",
  "one another"
]);
/** 所有格限定词 */
export const POSSESSIVE = new Set(["my", "your", "his", "her", "its", "our", "their", "whose"]);

/** 助动词 */
export const AUXILIARIES = new Set([
  "be", "am", "is", "are", "was", "were", "been", "being",
  "have", "has", "had", "having",
  "do", "does", "did", "done", "doing"
]);

/** 情态动词 */
export const MODALS = new Set([
  "can", "could", "may", "might", "must", "shall", "should", "will", "would", "ought",
  "need", "dare", "used"
]);

/** 否定词（含半否定，用于「否定范围」诊断） */
export const NEGATORS = new Set([
  "not", "no", "never", "none", "nobody", "nothing", "nowhere", "neither", "nor",
  "hardly", "scarcely", "barely", "rarely", "seldom", "little", "few", "without",
  "cannot", "can't", "don't", "doesn't", "didn't", "won't", "wouldn't", "shouldn't",
  "couldn't", "mustn't", "isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't",
  "hadn't", "ain't", "least", "unless", "rather", "far", "nowhere near"
]);

/** 部分否定的典型搭配（整句层面才成立，仅作提示） */
export const PARTIAL_NEGATION_HINTS = [
  "not all", "not both", "not every", "not always", "not necessarily", "not entirely",
  "not completely", "not quite", "not everyone", "not everything", "all that glitters",
  "not ... because", "don't think", "don't believe", "don't suppose", "don't seem"
];

/** 虚拟语气标记 */
export const SUBJUNCTIVE_MARKERS = [
  "were to", "should have", "would have", "could have", "might have", "had it not been",
  "if i were", "if he were", "if she were", "if it were", "as if", "as though",
  "would rather", "it is essential that", "it is necessary that", "it is important that",
  "suggest that", "demand that", "insist that", "require that", "propose that",
  "recommend that", "lest", "for fear that", "in case"
];

/** 不规则动词表：base -> [past, pastParticiple] */
export const IRREGULAR_VERBS = {
  arise: ["arose", "arisen"], be: ["was", "been"], bear: ["bore", "borne"], beat: ["beat", "beaten"],
  become: ["became", "become"], begin: ["began", "begun"], bend: ["bent", "bent"],
  bet: ["bet", "bet"], bind: ["bound", "bound"], bite: ["bit", "bitten"], bleed: ["bled", "bled"],
  blow: ["blew", "blown"], break: ["broke", "broken"], breed: ["bred", "bred"],
  bring: ["brought", "brought"], build: ["built", "built"], burn: ["burnt", "burnt"],
  burst: ["burst", "burst"], buy: ["bought", "bought"], cast: ["cast", "cast"],
  catch: ["caught", "caught"], choose: ["chose", "chosen"], cling: ["clung", "clung"],
  come: ["came", "come"], cost: ["cost", "cost"], creep: ["crept", "crept"],
  cut: ["cut", "cut"], deal: ["dealt", "dealt"], dig: ["dug", "dug"], do: ["did", "done"],
  draw: ["drew", "drawn"], drink: ["drank", "drunk"], drive: ["drove", "driven"],
  dwell: ["dwelt", "dwelt"], eat: ["ate", "eaten"], fall: ["fell", "fallen"],
  feed: ["fed", "fed"], feel: ["felt", "felt"], fight: ["fought", "fought"],
  find: ["found", "found"], flee: ["fled", "fled"], fling: ["flung", "flung"],
  fly: ["flew", "flown"], forbid: ["forbade", "forbidden"], forget: ["forgot", "forgotten"],
  forgive: ["forgave", "forgiven"], freeze: ["froze", "frozen"], get: ["got", "gotten"],
  give: ["gave", "given"], go: ["went", "gone"], grind: ["ground", "ground"],
  grow: ["grew", "grown"], hang: ["hung", "hung"], have: ["had", "had"],
  hear: ["heard", "heard"], hide: ["hid", "hidden"], hit: ["hit", "hit"],
  hold: ["held", "held"], hurt: ["hurt", "hurt"], keep: ["kept", "kept"],
  kneel: ["knelt", "knelt"], know: ["knew", "known"], lay: ["laid", "laid"],
  lead: ["led", "led"], lean: ["leant", "leant"], leap: ["leapt", "leapt"],
  learn: ["learnt", "learnt"], leave: ["left", "left"], lend: ["lent", "lent"],
  let: ["let", "let"], lie: ["lay", "lain"], light: ["lit", "lit"], lose: ["lost", "lost"],
  make: ["made", "made"], mean: ["meant", "meant"], meet: ["met", "met"],
  overcome: ["overcame", "overcome"], pay: ["paid", "paid"], put: ["put", "put"],
  quit: ["quit", "quit"], read: ["read", "read"], ride: ["rode", "ridden"],
  ring: ["rang", "rung"], rise: ["rose", "risen"], run: ["ran", "run"],
  say: ["said", "said"], see: ["saw", "seen"], seek: ["sought", "sought"],
  sell: ["sold", "sold"], send: ["sent", "sent"], set: ["set", "set"],
  sew: ["sewed", "sewn"], shake: ["shook", "shaken"], shed: ["shed", "shed"],
  shine: ["shone", "shone"], shoot: ["shot", "shot"], show: ["showed", "shown"],
  shrink: ["shrank", "shrunk"], shut: ["shut", "shut"], sing: ["sang", "sung"],
  sink: ["sank", "sunk"], sit: ["sat", "sat"], slay: ["slew", "slain"],
  sleep: ["slept", "slept"], slide: ["slid", "slid"], speak: ["spoke", "spoken"],
  speed: ["sped", "sped"], spend: ["spent", "spent"], spin: ["spun", "spun"],
  spit: ["spat", "spat"], split: ["split", "split"], spread: ["spread", "spread"],
  spring: ["sprang", "sprung"], stand: ["stood", "stood"], steal: ["stole", "stolen"],
  stick: ["stuck", "stuck"], sting: ["stung", "stung"], stink: ["stank", "stunk"],
  stride: ["strode", "stridden"], strike: ["struck", "struck"], strive: ["strove", "striven"],
  swear: ["swore", "sworn"], sweep: ["swept", "swept"], swell: ["swelled", "swollen"],
  swim: ["swam", "swum"], swing: ["swung", "swung"], take: ["took", "taken"],
  teach: ["taught", "taught"], tear: ["tore", "torn"], tell: ["told", "told"],
  think: ["thought", "thought"], throw: ["threw", "thrown"], thrust: ["thrust", "thrust"],
  tread: ["trod", "trodden"], undergo: ["underwent", "undergone"],
  understand: ["understood", "understood"], undertake: ["undertook", "undertaken"],
  upset: ["upset", "upset"], wake: ["woke", "woken"], wear: ["wore", "worn"],
  weave: ["wove", "woven"], weep: ["wept", "wept"], win: ["won", "won"],
  wind: ["wound", "wound"], withdraw: ["withdrew", "withdrawn"], write: ["wrote", "written"]
};

/** 反向索引：任何变位形式 -> 原形（用于判断「这到底是谓语还是分词」） */
export const VERB_FORM_TO_BASE = (() => {
  const map = new Map();
  for (const [base, forms] of Object.entries(IRREGULAR_VERBS)) {
    map.set(base, base);
    for (const f of forms) if (!map.has(f)) map.set(f, base);
  }
  return map;
})();

/** 构词后缀：用于粗判词性与「可能是学术生词」 */
export const SUFFIX = {
  noun: ["tion", "sion", "ment", "ness", "ity", "ance", "ence", "ship", "hood", "ism", "ist", "ology", "ure", "age", "dom", "cy"],
  verb: ["ize", "ise", "ify", "ate", "en"],
  adj: ["ous", "ive", "ful", "less", "able", "ible", "al", "ic", "ary", "ent", "ant", "ish", "like"],
  adv: ["ly", "ward", "wards", "wise"]
};

/** 永远不可能是主语的词（功能词封闭类，用于快速排除） */
export const NEVER_SUBJECT = new Set([
  ...DETERMINERS, ...PREPOSITIONS, ...CONJ_COORD, ...AUXILIARIES, ...MODALS,
  "there", "here", "yes", "however", "therefore", "thus", "moreover", "furthermore",
  "nevertheless", "nonetheless", "otherwise", "indeed", "perhaps", "maybe", "also",
  "just", "even", "still", "yet", "already", "always", "often", "sometimes", "usually",
  "soon", "later", "now", "then", "too", "very", "quite", "rather", "almost", "nearly"
]);

/** 高频「非谓语提示」：-ing / -ed 结尾但常作形容词，不当作动词 */
export const PARTICIPLE_ADJECTIVES = new Set([
  "interesting", "interested", "exciting", "excited", "surprising", "surprised",
  "tiring", "tired", "boring", "bored", "confusing", "confused", "amazing", "amazed",
  "worrying", "worried", "satisfying", "satisfied", "concerning", "regarding",
  "including", "excluding", "according", "considering", "assuming", "provided",
  "given", "pending", "following", "remaining", "leading", "growing", "increasing",
  "existing", "underlying", "ongoing", "willing", "widespread", "advanced", "detailed",
  "involved", "related", "based", "limited", "unexpected", "unprecedented", "distinguished",
  "well-known", "so-called", "make-shift", "long-standing", "highly", "supposed", "used"
]);

/** 分析维度中文名（全插件统一文案） */
export const LAYER_LABEL = {
  V: "词汇层",
  S: "句法层",
  R: "指代层",
  L: "逻辑层",
  E: "表达层"
};

export const LAYER_DESC = {
  V: "生词、义项选错、词性判错、搭配整体义",
  S: "主干识别、从句边界、修饰归属、非谓语",
  R: "it/this/that/they/one 的所指",
  L: "否定范围、转折让步、情态与虚拟",
  E: "理解对了但中文组装不出来"
};