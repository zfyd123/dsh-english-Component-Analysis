/**
 * fixed.js —— 固定句式 / 固定短语检出。
 *
 * 解决的问题：学生按「每个词的义项相加」拼句义，遇到逐词拼不出来的块就整句读偏。
 * 所以这里只上报**拼不出来的块**（L3 习语·形式冻结 / L2 粘合搭配·介词绑定），
 * 自由组合（L0）与可自由替换的高频搭配（L1）一律不上报——满屏提示等于没有提示。
 *
 * 每条都带 level / meaning / note：
 *   level   L3 = 逐词相加得不到整体义，或形式不能变；L2 = 其中一词/介词不可替换
 *   note    用来看得懂的用法约束（形式冻结、介词绑定、重心位置、常见误译）
 */

/** L3：字面固定块。value = { meaning, note } */
const L3_LITERALS = [
  ["when it comes to", "谈到、涉及……时", "形式冻结：comes 永远不变（过去时语境也是 comes），it 无实指；后接名词/动名词，不接 that 从句"],
  ["as well as", "以及（重心在前项）", "不是「也」：句末的 as well 才是「也」；作主语时谓语跟第一项一致（A as well as B 用 is）"],
  ["as well", "也（放句末）", "两词、只占句末位置；与连接用的 as well as 区分"],
  ["in terms of", "就……而言", "后接名词；同义 as regards / with respect to"],
  ["at the end of the day", "归根结底", "不是「在一天结束时」，是收束论点的话语标记"],
  ["in the long run", "从长远看", "run 指「一段时间」，不是「跑」"],
  ["rather than", "而不是", "连接的两项结构要对称；与 instead of 相比更常接动词原形"],
  ["other than", "除了……之外", "常用于否定/疑问；与 rather than 意思完全不同"],
  ["let alone", "更不用说", "前面必须已有否定或递进；后接与前面对应的成分"],
  ["not to mention", "更不用说", "后接名词或动名词，不是句子"],
  ["to say the least", "往轻里说", "让步式保守评价，不是「至少说」"],
  ["more often than not", "多半、往往", "不是「比不常更常」的字面比较"],
  ["by no means", "决不", "置句首时主句要倒装（By no means is it…）"],
  ["in no way", "决不", "置句首时倒装，同 by no means"],
  ["on the whole", "总体上", "与 as a whole（作为一个整体）区分"],
  ["on the contrary", "相反", "用于否定前说并给出对立面；与 in contrast（对比两项）不同"],
  ["in contrast", "相比之下", "常用于句首，后接对比对象"],
  ["no wonder", "难怪", "后接 that 从句时常省略 that"],
  ["it goes without saying that", "不言而喻", "形式主语 it，真正的主语是后面的 that 从句"],
  ["needless to say", "不用说", "插入语，位置灵活"],
  ["as a matter of fact", "事实上", "用于补充或轻微反驳"],
  ["in the event of", "如果发生", "后接名词，不接从句（接从句用 in the event that）"],
  ["in the face of", "面对", "后接困难/反对等抽象名词"],
  ["regardless of", "不管、不顾", "后接名词或 wh- 从句"],
  ["due to", "由于", "后接名词；争议点是它修饰名词还是整句，译成「由于」最稳"],
  ["owing to", "由于", "与 due to 同义，位置更常在句首"],
  ["thanks to", "多亏", "可褒可贬，不要一律译成「感谢」"],
  ["apart from", "除了", "兼有「除……之外还有」（=besides）与「除……之外都」（=except）两义，看谓语肯定/否定"],
  ["as opposed to", "与……相对", "强调两者的对立差别，不是「反对」"],
  ["in light of", "鉴于、按照", "后接资讯、情况类名词"],
  ["at the expense of", "以……为代价", "expense 不是「花费」的字面义"],
  ["in accordance with", "依照", "后接规章、协议；与 according to（来源）不同"],
  ["for the sake of", "为了", "后接名词/动名词，sake 不单独译"],
  ["on behalf of", "代表", "后接人或机构，不是「在……的半边」"],
  ["with respect to", "关于", "respect 不是「尊重」"],
  ["in the wake of", "在……之后（随之而来）", "wake 指船尾尾流，不译「醒来」"],
  ["prior to", "在……之前", "书面语，比 before 正式"],
  ["subject to", "受……制约；取决于", "subject 是形容词，读重音在第二音节；后接名词或动名词"],
  ["in response to", "回应", "后接名词"],
  ["as long as", "只要；长达", "两义：条件（只要）与长度（长达），看后面接什么"],
  ["so far as", "就……而言", "常与 I know / I can tell 搭配"],
  ["in any case", "无论如何", "与 in case（万一）不同：后者引导条件从句"],
  ["if anything", "要说有什么的话", "用于修正或加强前面的判断"],
  ["if at all", "即使有", "极简否定式让步，常与 little/hardly 同现"],
  ["anything but", "决不、恰恰不是", "不是「除……之外任何」；与 nothing but 正相反"],
  ["nothing but", "只不过", "强调「仅仅是」，与 anything but 正相反"],
  ["all but", "几乎；除……外全部", "两义：副词「几乎」与限定「除……外都」"]
];

/** L2：形容词/分词 + 固定介词。介词不可按字面逻辑替换 */
const L2_ADJ_PREP = {
  confused: { preps: ["about", "by", "with"], note: "about=对……困惑；by=被……弄糊涂；with=与……混淆" },
  interested: { preps: ["in"], note: "介词固定为 in，不用 on" },
  aware: { preps: ["of"], note: "of 不可换成 about（口语偶见，书面按 of）" },
  capable: { preps: ["of"], note: "后接名词/动名词" },
  responsible: { preps: ["for"], note: "for 不可换 of" },
  similar: { preps: ["to"], note: "用 to，不用 with" },
  different: { preps: ["from", "to"], note: "英式可 to，美式用 from" },
  familiar: { preps: ["with", "to"], note: "人 familiar with 事物；事物 familiar to 人" },
  afraid: { preps: ["of", "to"], note: "of + 名词；to + 动词原形（afraid to do）" },
  accused: { preps: ["of"], note: "of 不可换 for" },
  addicted: { preps: ["to"], note: "to 是介词，后接名词/动名词，不是不定式" },
  accustomed: { preps: ["to"], note: "同上：to 后接名词/动名词" },
  committed: { preps: ["to"], note: "同上" },
  exposed: { preps: ["to"], note: "同上" },
  prone: { preps: ["to"], note: "to 后接名词/动名词" },
  immune: { preps: ["to"], note: "同上" },
  sensitive: { preps: ["to"], note: "to 不可换 for" },
  relevant: { preps: ["to"], note: "to 不可换 for" },
  essential: { preps: ["to", "for"], note: "to 强调对象，for 强调目的" },
  contrary: { preps: ["to"], note: "contrary to 后接名词" },
  comparable: { preps: ["to", "with"], note: "to 表「比得上」，with 表「与……比较」" },
  superior: { preps: ["to"], note: "用 to，不用 than" },
  inferior: { preps: ["to"], note: "用 to，不用 than" },
  curious: { preps: ["about"], note: "about 不可换 of" },
  anxious: { preps: ["about", "for"], note: "about=担心；for=渴望" },
  guilty: { preps: ["of"], note: "of 不可换 for" },
  proud: { preps: ["of"], note: "of 不可换 for" },
  satisfied: { preps: ["with"], note: "用 with，不用 of" },
  disappointed: { preps: ["with", "in", "about"], note: "with/in 指人，about 指事" },
  worried: { preps: ["about"], note: "about 不可换 of" },
  excited: { preps: ["about"], note: "about 不可换 of" },
  tired: { preps: ["of"], note: "of=厌倦；from=疲劳于" },
  ashamed: { preps: ["of"], note: "of 不可换 for" },
  devoted: { preps: ["to"], note: "to 后接名词/动名词" },
  engaged: { preps: ["in"], note: "in 不可换 on" },
  involved: { preps: ["in"], note: "in 不可换 on" }
};

/** 带通配的框架：只能靠正则识别，token 级匹配抓不到中间的部分 */
const FRAME_RULES = [
  { re: /\bnot\s+only\b[^.;!?]{0,90}?\bbut\s+(?:also|as\s+well)\b/i, text: "not only … but also", meaning: "不仅……而且……", note: "also 可省；not only 置于句首时前半句要倒装（Not only did he …）" },
  { re: /\b(?:hardly|scarcely|barely)\b[^.;!?]{0,60}?\bwhen\b/i, text: "hardly / scarcely … when", meaning: "一……就……", note: "搭 when 不搭 than；主句用过去完成时（had done）" },
  { re: /\bno\s+sooner\b[^.;!?]{0,60}?\bthan\b/i, text: "no sooner … than", meaning: "一……就……", note: "搭 than 不搭 when；no sooner 置句首时倒装" },
  { re: /\bthe\s+(?:more|[a-z]{3,}er)\b[^.;!?]{0,60}?\bthe\s+(?:more|[a-z]{3,}er)\b/i, text: "the + 比较级 … the + 比较级", meaning: "越……越……", note: "两个 the 都是关系副词，不是冠词；先确认 the 后面确实是比较级" },
  { re: /\btoo\s+[a-z]+\s+to\s+[a-z]+/i, text: "too … to …", meaning: "太……以致不能……", note: "to do 表否定结果，别译成「太……去做」" },
  { re: /\bsuch\b[^.;!?]{0,40}?\bthat\b/i, text: "such … that", meaning: "如此……以致", note: "that 引导结果状语从句；such 后要接名词" },
  { re: /\bas\s+far\s+as\b[^,.;]{0,40}?\bis\s+concerned\b/i, text: "as far as … is concerned", meaning: "就……而言", note: "concerned 形式固定，不随主语变" }
];

const literalMap = new Map();
for (const [p, meaning, note] of L3_LITERALS) {
  const words = p.split(/\s+/);
  literalMap.set(words.join(" "), { text: p, level: "L3", kind: "固定句式", meaning, note, words });
}
const LITERAL_LENGTHS = [...new Set([...literalMap.values()].map((e) => e.words.length))].sort((a, b) => b - a);

/** 取句子里的「词序列」（跳过标点），带原始位置，便于回指原文。
 *  注意：segment 会把 PHRASE_BANK 里的多词短语合并成一个 token（lower 含空格），
 *  这里要再拆回单词，否则 "let alone" 这种合并 token 匹配不到两词块。 */
function wordSequence(tokens) {
  const seq = [];
  tokens.forEach((t, pos) => {
    if (!t?.isWord) return;
    const lower = String(t.lower ?? t.text ?? "").toLowerCase();
    const text = String(t.text ?? "");
    if (lower.includes(" ") || text.includes(" ")) {
      const lows = lower.split(/\s+/).filter(Boolean);
      const texts = text.split(/\s+/).filter(Boolean);
      lows.forEach((l, k) => seq.push({ lower: l, text: texts[k] ?? l, pos }));
    } else {
      seq.push({ lower, text, pos });
    }
  });
  return seq;
}

/**
 * 检出固定句式 / 固定短语。
 * @param tokens parse.js 的 token 数组（含 isWord / lower / text）
 * @param sentence 原句（框架类正则要在原句上跑）
 * @returns Array<{text, level, kind, meaning, note, start, end}> — start/end 为 token 下标区间
 */
export function detectFixed(tokens, sentence) {
  const out = [];
  const seen = new Set();
  const seq = wordSequence(tokens ?? []);
  const used = new Set();

  // 1) 字面固定块：最长优先，命中即占用，避免 as well 吃掉 as well as
  for (let i = 0; i < seq.length; i += 1) {
    if (used.has(i)) continue;
    for (const len of LITERAL_LENGTHS) {
      // 注意：这里必须是 continue 不是 break —— 长块放不下时，短块仍要试
      if (i + len > seq.length) continue;
      let blocked = false;
      for (let k = 0; k < len; k += 1) if (used.has(i + k)) { blocked = true; break; }
      if (blocked) continue;
      const key = seq.slice(i, i + len).map((w) => w.lower).join(" ");
      const hit = literalMap.get(key);
      if (!hit) continue;
      for (let k = 0; k < len; k += 1) used.add(i + k);
      out.push({
        text: seq.slice(i, i + len).map((w) => w.text).join(" "),
        level: hit.level,
        kind: hit.kind,
        meaning: hit.meaning,
        note: hit.note,
        start: seq[i].pos,
        end: seq[i + len - 1].pos + 1
      });
      seen.add(hit.text);
      i += len - 1;
      break;
    }
  }

  // 2) 形容词 + 固定介词：只报「介词被绑定」的两词块，义项差异写进 note
  for (let i = 0; i + 1 < seq.length; i += 1) {
    if (used.has(i) || used.has(i + 1)) continue;
    const entry = L2_ADJ_PREP[seq[i].lower];
    if (!entry) continue;
    const prep = seq[i + 1].lower;
    if (!entry.preps.includes(prep)) continue;
    for (let k = 0; k < 2; k += 1) used.add(i + k);
    const text = `${seq[i].text} ${seq[i + 1].text}`;
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push({
      text,
      level: "L2",
      kind: "介词绑定",
      meaning: `介词固定为 ${entry.preps.join(" / ")}`,
      note: entry.note,
      start: seq[i].pos,
      end: seq[i + 1].pos + 1
    });
  }

  // 3) 带通配的框架：正则只在原句上跑，token 级匹配抓不到中间部分
  const src = String(sentence ?? "");
  for (const rule of FRAME_RULES) {
    const m = rule.re.exec(src);
    if (!m) continue;
    if (seen.has(rule.text)) continue;
    seen.add(rule.text);
    out.push({
      text: rule.text,
      level: "L3",
      kind: "句式框架",
      meaning: rule.meaning,
      note: rule.note,
      matched: String(m[0]).trim(),
      start: null,
      end: null
    });
  }

  // L3 在前（必须先整块处理），同级按出现位置
  const rank = { L3: 0, L2: 1 };
  out.sort((a, b) => {
    const r = (rank[a.level] ?? 9) - (rank[b.level] ?? 9);
    if (r !== 0) return r;
    const sa = a.start ?? 9999;
    const sb = b.start ?? 9999;
    return sa - sb;
  });
  return out;
}

/** 供面板/工具判断「这一句到底有没有固定块」 */
export function hasFixed(list) {
  return Array.isArray(list) && list.length > 0;
}

export { L2_ADJ_PREP, L3_LITERALS };