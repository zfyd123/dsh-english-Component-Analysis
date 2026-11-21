/**
 * segment.js —— 分词与粗词性标注层。
 *
 * 设计原则：不做统计推断，只做「可解释的规则 + 可查的词表」。
 * 每一步判断都带上 why 字段，方便前端/模型把判定理由讲给用户听
 * ——这才是诊断工具该给的，而不是一个黑箱的 annotation。
 */

import {
  DETERMINERS, PREPOSITIONS, PREP_FIRST, COMPOUND_PREPOSITIONS, CONJ_COORD, RELATIVIZERS,
  NOUN_CLAUSE_MARKERS, ADVERBIAL_SUBORDINATORS, ADVERBIAL_PHRASES, PRONOUN_SUBJ,
  PRONOUN_OBJ, POSSESSIVE, AUXILIARIES, MODALS, NEGATORS, IRREGULAR_VERBS,
  VERB_FORM_TO_BASE, SUFFIX, PARTICIPLE_ADJECTIVES
} from "./lexicon-core.js";
import { PHRASE_BANK } from "./lexicon-tips.js";

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "cf",
  "fig", "no", "vol", "ch", "p", "pp", "inc", "ltd", "co", "corp", "u.s", "u.k", "a.m", "p.m"
]);

/** 按句切分：只在「句末标点 + 后接大写/结束」处断句，避开 Mr. / e.g. / 3.5 */
export function splitSentences(text) {
  const src = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!src) return [];
  const out = [];
  let buf = "";
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    buf += ch;
    if (ch === "." || ch === "!" || ch === "?") {
      const tail = buf.slice(0, -1);
      const lastWord = (tail.match(/([A-Za-z.]+)$/)?.[1] ?? "").toLowerCase().replace(/\.$/, "");
      const isAbbr = ch === "." && ABBREVIATIONS.has(lastWord);
      const isDecimal = ch === "." && /\d$/.test(tail) && /^\d/.test(src.slice(i + 1));
      const next = src.slice(i + 1).match(/^\s*(\S)?/)?.[1] ?? "";
      const nextOk = next === "" || /[A-Z"'(\[]/.test(next) || /\n/.test(src.slice(i + 1, i + 3));
      if (!isAbbr && !isDecimal && (nextOk || i === src.length - 1)) {
        const s = buf.trim();
        if (s) out.push(s);
        buf = "";
      }
    }
  }
  const rest = buf.trim();
  if (rest) out.push(rest);
  return out;
}

/** 原始切词：保留标点、识别缩合词 */
export function rawTokens(sentence) {
  const parts = String(sentence ?? "").match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*|[^\sA-Za-z0-9]/g) ?? [];
  const tokens = [];
  parts.forEach((text, i) => {
    const isWord = /[A-Za-z0-9]/.test(text);
    tokens.push({
      i,
      text,
      lower: text.toLowerCase().replace(/’/g, "'"),
      isWord,
      isPunct: !isWord,
      /** 缩合词拆解：don't -> do + not（negation=true 时否定要靠它判定） */
      ...(isWord ? {} : {})
    });
  });
  return tokens;
}

/** 匹配以 pos 位置开始的最长短语（来自给定候选集，最长 6 词） */
function matchLongest(tokens, pos, candidates) {
  const words = [];
  const idxs = [];
  for (let k = pos; k < tokens.length && words.length < 6; k += 1) {
    const t = tokens[k];
    if (!t.isWord) break;
    words.push(t.lower);
    idxs.push(t.i);
    const phrase = words.join(" ");
    if (candidates.has(phrase)) return { phrase, endPos: k, idxs: idxs.slice() };
  }
  return null;
}

/** 常见状语短语：整体识别为 adv，避免「one day / in fact」把词性判断带偏 */
export const ADVERB_PHRASES = [
  "one day", "some day", "the other day", "last year", "next year", "this year",
  "last week", "next week", "this week", "last month", "next month", "this month",
  "last night", "at night", "in fact", "at first", "at last", "for example",
  "for instance", "in particular", "by contrast", "in contrast", "as a result",
  "in addition", "of course", "at least", "at most", "in general", "in short",
  "so far", "thus far", "once again", "at once", "right now", "until now",
  "up to now", "in the end", "after all", "above all", "once more",
  "more or less", "by and large", "to some extent", "in part", "on average",
  "in effect", "in turn", "in return", "in time", "on time", "at present",
  "for now", "for good", "in advance", "in detail", "on purpose", "by chance",
  "at random", "in vain", "as well", "no longer", "not yet", "even so",
  "long ago", "years ago", "so far as", "as yet", "ever since"
];
const ADVERB_PHRASE_SET = new Set(ADVERB_PHRASES);

const COMPOUND_PREP_SET = new Set(COMPOUND_PREPOSITIONS);
const ADVERBIAL_PHRASE_SET = new Set(ADVERBIAL_PHRASES);
const PHRASE_BANK_SET = new Set(Object.keys(PHRASE_BANK).filter((k) => !k.includes("...")));

/** 词形：判断一个词可能是原形/过去式/过去分词/现在分词/第三人称单数 */
export function verbFormsOf(word) {
  const w = word.toLowerCase();
  const forms = new Set();
  if (VERB_FORM_TO_BASE.has(w)) {
    forms.add(VERB_FORM_TO_BASE.has(w) && Object.keys(IRREGULAR_VERBS).includes(w) ? "base" : "irregular");
    const base = VERB_FORM_TO_BASE.get(w);
    const pair = IRREGULAR_VERBS[base];
    if (base === w) forms.add("base");
    if (pair) {
      if (pair[0] === w) forms.add("past");
      if (pair[1] === w) forms.add("pp");
      if (pair[0] === w && pair[1] === w) forms.add("past=pp");
    }
    if (!forms.size) forms.add("irregular");
    return forms;
  }
  if (/ing$/.test(w) && w.length > 4) forms.add("ing");
  if (/ied$/.test(w)) { forms.add("past"); forms.add("pp"); }
  else if (/ed$/.test(w) && w.length > 3) { forms.add("past"); forms.add("pp"); }
  if (/[^s]s$/.test(w) && w.length > 3) forms.add("3sg");
  if (/^[a-z]+$/.test(w) && forms.size === 0) forms.add("base?");
  return forms;
}

/** 后缀推词性 */
export function posFromSuffix(word) {
  const w = word.toLowerCase();
  for (const s of SUFFIX.adv) if (w.endsWith(s) && w.length > s.length + 2) return { pos: "adv", why: `-${s} 副词后缀` };
  for (const s of SUFFIX.noun) if (w.endsWith(s) && w.length > s.length + 2) return { pos: "noun", why: `-${s} 名词后缀` };
  for (const s of SUFFIX.adj) if (w.endsWith(s) && w.length > s.length + 2) return { pos: "adj", why: `-${s} 形容词后缀` };
  for (const s of SUFFIX.verb) if (w.endsWith(s) && w.length > s.length + 2) return { pos: "verb", why: `-${s} 动词后缀` };
  return null;
}

/**
 * 合并多词短语 + 粗标词性。
 * 返回 token 序列（含合并后的短语 token）与统计信息。
 */
export function segment(sentence) {
  const raw = rawTokens(sentence);
  const merged = [];
  const skipped = new Set();

  for (let p = 0; p < raw.length; p += 1) {
    if (skipped.has(p)) continue;
    const t = raw[p];
    if (!t.isWord) { merged.push({ ...t, gpos: "punct", why: "标点" }); continue; }

    // 1) 复合介词 / 状语引导短语 / 状语短语 / 搭配表 —— 逐级最长匹配
    const hitPrep = matchLongest(raw, p, COMPOUND_PREP_SET);
    const hitAdv = matchLongest(raw, p, ADVERBIAL_PHRASE_SET);
    const hitAdverb = matchLongest(raw, p, ADVERB_PHRASE_SET);
    const hitBank = matchLongest(raw, p, PHRASE_BANK_SET);
    const hits = [hitPrep, hitAdv, hitAdverb, hitBank].filter(Boolean)
      .sort((a, b) => (b.endPos - p) - (a.endPos - p));
    const hit = hits[0];
    if (hit && hit.endPos > p) {
      for (let k = p + 1; k <= hit.endPos; k += 1) skipped.add(k);
      const kind = hit === hitPrep ? "compoundPrep" : hit === hitAdv ? "adverbialPhrase" : hit === hitAdverb ? "adverbPhrase" : "phrase";
      const firstLooksVerb = VERB_FORM_TO_BASE.has(t.lower) || /(ed)$/.test(t.lower) || IRREGULAR_VERBS[t.lower] !== undefined;
      merged.push({
        i: t.i, text: hit.phrase, lower: hit.phrase, isWord: true, isPunct: false,
        gpos: kind === "compoundPrep" ? "prep" : kind === "adverbialPhrase" ? "sub" : kind === "adverbPhrase" ? "adv" : "phrase",
        span: [t.i, raw[hit.endPos].i],
        wordCount: hit.endPos - p + 1,
        verbish: kind === "phrase" && firstLooksVerb,
        why: kind === "compoundPrep" ? "复合介词（整体作介词）" : kind === "adverbialPhrase" ? "状语从句引导短语" : kind === "adverbPhrase" ? "状语短语（整体作副词）" : "固定搭配（整体理解）",
        phraseKind: kind
      });
      p = hit.endPos;
      continue;
    }

    // 2) 单词词性
    merged.push(tagWord(t, raw, p));
  }

  return { tokens: merged, rawCount: raw.filter((t) => t.isWord).length };
}

/** 单词粗词性：按「封闭类优先 → 词形 → 后缀 → 位置」顺序 */
function tagWord(t, raw, pos) {
  const w = t.lower;
  const base = { ...t, gpos: "unknown", why: "" };
  const prev = nearestWord(raw, pos, -1);
  const next = nearestWord(raw, pos, +1);
  const n2 = wordAtOffset(raw, pos, 2);
  const n3 = wordAtOffset(raw, pos, 3);
  const n4 = wordAtOffset(raw, pos, 4);
  const prevW = prev ? prev.lower : "";
  const nextW = next ? next.lower : "";

  if (POSSESSIVE.has(w)) return { ...base, gpos: "poss", why: "所有格限定词" };
  // that 是全场最难的词：限定词 / 关系词 / 连词 三义。先按结构位置判。
  if (w === "that") {
    const prevPunct = raw[pos - 1] && raw[pos - 1].isPunct ? raw[pos - 1].text : "";
    const prevNounish = prev && (/noun/.test(prev.gpos) || VERB_FORM_TO_BASE.has(prevW) === false && !DETERMINERS.has(prevW) && !PREPOSITIONS.has(prevW));
    const prevVerbish = prev && (prev.gpos === "verb" || prev.gpos === "v-ed" || prev.gpos === "adj" || VERB_FORM_TO_BASE.has(prevW));
    const afterIsClauseStart = next && (DETERMINERS.has(nextW) || PRONOUN_SUBJ.has(nextW) || POSSESSIVE.has(nextW));
    if (prevPunct === ",") return { ...base, gpos: "rel", why: "逗号后 that：引导从句（非限定性/同位语）" };
    // 动词/形容词后的 that 几乎必然是连词（said that / clear that / told that）
    if (prevVerbish) return { ...base, gpos: "rel", why: "动词/形容词后接 that：引导名词性从句" };
    if (prevNounish && afterIsClauseStart) return { ...base, gpos: "rel", why: "名词后接 that + 主语：关系词，定语从句修饰前面名词" };
    if (next && (next.gpos === "noun" || next.gpos === "noun?" || DETERMINERS.has(nextW))) return { ...base, gpos: "det", why: "that 后接名词：指示限定词（那个）" };
    return { ...base, gpos: "rel", why: "that 引导从句（需确认是定语从句还是名词性从句）" };
  }
  if (DETERMINERS.has(w)) return { ...base, gpos: "det", why: "限定词/冠词" };
  if (MODALS.has(w)) return { ...base, gpos: "modal", why: "情态动词" };
  if (AUXILIARIES.has(w)) return { ...base, gpos: "aux", why: "助动词" };
  if (NEGATORS.has(w)) return { ...base, gpos: "neg", why: "否定词（注意否定范围）" };
  if (PRONOUN_SUBJ.has(w) || PRONOUN_OBJ.has(w)) return { ...base, gpos: "pron", why: "代词" };

  if (RELATIVIZERS.has(w) || NOUN_CLAUSE_MARKERS.has(w)) {
    return { ...base, gpos: "rel", why: "从句引导词（关系词/连接词，需靠位置判归属）" };
  }
  if (CONJ_COORD.has(w)) return { ...base, gpos: "conj", why: "并列连词" };

  // 介词优先：by / in / to 这类词永远不是从句引导词
  if (PREP_FIRST.has(w) && PREPOSITIONS.has(w)) {
    if (w === "to" && next && !next.isPunct) {
      const bareNext = !/(ed|ing|s)$/.test(nextW) && nextW.length > 1;
      if (looksLikeVerb(next) || (bareNext && (next.gpos === "noun?" || next.gpos === "unknown") && next.text[0] !== next.text[0].toUpperCase())) {
        return { ...base, gpos: "infl", why: "to + 原形：不定式标记（后面跟的是动词）" };
      }
    }
    return { ...base, gpos: "prep", why: "介词" };
  }

  // 兼类词：as / since / for / while / before / after / until / when / where / than
  if (PREPOSITIONS.has(w) && ADVERBIAL_SUBORDINATORS.has(w)) {
    const nextNominal = next && (DETERMINERS.has(nextW) || POSSESSIVE.has(nextW) || /noun/.test(next.gpos) || PRONOUN_SUBJ.has(nextW) || PRONOUN_OBJ.has(nextW) || /^\d/.test(next.text));
    const nominalThenVerb = nextNominal && [n2, n3, n4].some((x) => looksLikeVerb(x));
    const n4IsDoAux = n4 && ["do", "does", "did"].includes(n4.lower);
    // "until the final chapter does ..."：do/does/did 说明后面是倒装主句，until + 名词仍是介词短语
    if (n4IsDoAux) return { ...base, gpos: "prep", why: "兼类词：后接名词短语，且 do/does/did 表明后面是主句倒装（此处作介词）" };
    if (nextNominal && !nominalThenVerb) return { ...base, gpos: "prep", why: "兼类词：后接名词短语且后面没有谓语（此处作介词）" };
    if (nominalThenVerb) return { ...base, gpos: "sub", why: "兼类词：后面出现了主语 + 谓语（此处作从句引导词）" };
    return { ...base, gpos: "prep", why: "兼类词：无从句结构，按介词处理" };
  }

  if (PREPOSITIONS.has(w)) return { ...base, gpos: "prep", why: "介词" };
  if (ADVERBIAL_SUBORDINATORS.has(w)) return { ...base, gpos: "sub", why: "状语从句引导词" };

  if (PARTICIPLE_ADJECTIVES.has(w)) return { ...base, gpos: "adj", why: "-ing/-ed 形式但常作形容词" };

  // -al 结尾：形容词后缀，但在冠词/形容词/名词后多为名词（the proposal / a second trial）；
// 若后面紧跟名词，则它是形容词（the final chapter）
  if (/al$/.test(w) && w.length > 4 && prevW && (DETERMINERS.has(prevW) || POSSESSIVE.has(prevW) || /^noun/.test(prev.gpos) || prev.gpos === "adj")) {
    if (next && (/^noun/.test(next.gpos) || DETERMINERS.has(nextW) === false && next.gpos === "adj")) {
      return { ...base, gpos: "adj", why: "-al 结尾且后接名词：形容词" };
    }
    return { ...base, gpos: "noun", why: "-al 结尾且前有冠词/修饰语：名词（proposal/approval/trial 这一类）" };
  }

  const forms = verbFormsOf(w);
  // 冠词/介词后的 -ing：多是动名词或名词（the meeting / after leaving）
  if (forms.has("ing") && !forms.has("base?") && prevW && (DETERMINERS.has(prevW) || POSSESSIVE.has(prevW) || PREPOSITIONS.has(prevW))) {
    return { ...base, gpos: "noun", forms: [...forms], why: "冠词/介词后的 -ing：动名词或名词" };
  }
  if (forms.has("ing") && !forms.has("base?")) return { ...base, gpos: "v-ing", forms: [...forms], why: "-ing 形式（现在分词/动名词）" };
  if ((forms.has("past") || forms.has("pp")) && !IRREGULAR_VERBS[w]) {
    const adjish = prevW && (DETERMINERS.has(prevW) || POSSESSIVE.has(prevW) || AUXILIARIES.has(prevW) === false && /^(is|are|was|were|be|been|being|very|more|most|quite|highly)$/.test(prevW));
    if (adjish && DETERMINERS.has(prevW)) return { ...base, gpos: "adj", forms: [...forms], why: "-ed 形式在此处更像形容词（前有限定词）" };
    return { ...base, gpos: "v-ed", forms: [...forms], why: "-ed 形式（过去式/过去分词）" };
  }
  if (IRREGULAR_VERBS[w] || VERB_FORM_TO_BASE.has(w)) {
    return { ...base, gpos: "verb", forms: [...forms], why: "不规则动词变位" };
  }
  if (forms.has("3sg")) {
    // 三单动词需要「前面有主语性成分」；否则是复数名词（cut costs / in areas 这类）
    const prevIsSubjish = prev && (PRONOUN_SUBJ.has(prevW) || /noun/.test(prev.gpos) || prev.gpos === "noun?");
    const nextEnds = !next || next.isPunct || PREPOSITIONS.has(nextW) || CONJ_COORD.has(nextW);
    if (prevIsSubjish && nextEnds) {
      return { ...base, gpos: "verb", forms: [...forms], why: "-s 结尾且前有主语性成分：第三人称单数谓语" };
    }
    const suf = posFromSuffix(w.replace(/s$/, ""));
    if (suf && suf.pos === "noun") return { ...base, gpos: "noun", why: "复数名词（-s）" };
    return { ...base, gpos: "noun?", forms: [...forms], why: "-s 结尾：按复数名词处理（若作谓语需另行确认）" };
  }

  const suf = posFromSuffix(w);
  if (suf) return { ...base, gpos: suf.pos, why: suf.why };

  if (/^[a-z]+$/.test(w) && w.length >= 2) {
    const afterDet = prevW && (DETERMINERS.has(prevW) || POSSESSIVE.has(prevW)) || (prev && prev.gpos === "adj");
    if (afterDet) return { ...base, gpos: "noun", why: "前有冠词/限定词，判断为名词" };
    return { ...base, gpos: "noun?", why: "无词形线索，默认按名词处理，需确认" };
  }
  return base;
}

function nearestWord(raw, pos, dir) {
  for (let k = pos + dir; k >= 0 && k < raw.length; k += dir) {
    if (raw[k].isWord) return raw[k];
  }
  return null;
}

/** 从 pos 往后取第 n 个单词（词表外的辅助，用于兼类词判定） */
function wordAtOffset(raw, pos, n) {
  let count = 0;
  for (let k = pos + 1; k < raw.length; k += 1) {
    if (!raw[k].isWord) continue;
    count += 1;
    if (count === n) return raw[k];
  }
  return null;
}

/** 粗判「这个词像不像动词」——只看词形与词表，不做上下文推断
 *  刻意排除 -ing：following / including / during 这类几乎总是形容词或介词 */
function looksLikeVerb(tok) {
  if (!tok || !tok.isWord) return false;
  const w = tok.lower;
  if (MODALS.has(w) || AUXILIARIES.has(w)) return true;
  if (VERB_FORM_TO_BASE.has(w)) return true;
  if (/ed$/.test(w) && w.length > 3 && !PARTICIPLE_ADJECTIVES.has(w)) return true;
  return false;
}

/** 意群（chunk）切分：给工作记忆负荷用。在介词/连词/标点/从句引导词前断开 */
export function chunkLoad(tokens) {
  const cuts = [];
  let current = [];
  const breakBefore = new Set(["prep", "sub", "rel", "conj", "compoundPrep", "adverbialPhrase"]);
  let depth = 0;
  const chunks = [];
  tokens.forEach((t) => {
    if (t.gpos === "punct") {
      if (current.length) { chunks.push(current); current = []; }
      depth = 0;
      return;
    }
    if (breakBefore.has(t.gpos) && current.length >= 2 && depth === 0) {
      chunks.push(current); current = [];
    }
    if (t.gpos === "rel" || t.gpos === "sub") depth = Math.min(depth + 1, 3);
    current.push(t.text);
    cuts.push(t.i);
  });
  if (current.length) chunks.push(current);
  return { chunks, count: chunks.length, overload: chunks.length > 8 };
}