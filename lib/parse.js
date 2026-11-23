/**
 * parse.js —— 结构解析层：从句边界、主干、修饰归属、指代候选、风险提示。
 *
 * 输出的是「可核对的零件清单」，不是最终译文：
 *   - 主干给出「主语 / 谓语 / 宾语·表语」三段原文片段
 *   - 每个从句给出「引导词 + 块文本 + 可能的归属中心词」
 *   - 每个代词给出「向后最近的若干名词短语」作为所指候选
 * 判定留给使用者和模型，工具只负责把句子拆到能被检查的粒度。
 */

import { segment, chunkLoad, splitSentences, verbFormsOf } from "./segment.js";
import {
  DETERMINERS, POSSESSIVE, AUXILIARIES, MODALS, CONJ_COORD, RELATIVIZERS,
  NOUN_CLAUSE_MARKERS, ADVERBIAL_SUBORDINATORS, PREPOSITIONS, IRREGULAR_VERBS,
  VERB_FORM_TO_BASE, NEGATORS
} from "./lexicon-core.js";
import {
  HIDDEN_SENSES, PHRASE_BANK, ACADEMIC_SENSES, REWRITE_TEMPLATES,
  LINKING_VERBS, DITRANSITIVE, COMPLEX_TRANSITIVE
} from "./lexicon-tips.js";
import { detectFixed } from "./fixed.js";
import { findSpecialPatterns } from "./special.js";

const VERB_GPOS = new Set(["verb", "v-ed", "v-ing", "noun?"]);

/** 判断一个 token 是否「可能是动词」。noun?/unknown 一律不算——它们最容易造成假谓语 */
function isVerbish(t) {
  if (!t || !t.isWord) return false;
  if (t.gpos === "verb" || t.gpos === "v-ed" || t.gpos === "v-ing") return true;
  if (t.gpos === "phrase" && t.verbish) return true;
  return false;
}

/**
 * 动词形态判定：finite（限定/谓语） vs participle / gerund / infinitive。
 * 判定依据只有三条：① 前面有没有助动词/情态动词；② 前一个词是不是 to；
 * ③ 它在序列里的位置（句子第一个 finite 通常是主句谓语）。
 */
export function markVerbForms(tokens) {
  const tagged = tokens.map((t) => ({ ...t }));
  let auxPending = null;
  let auxAt = -1;
  for (let i = 0; i < tagged.length; i += 1) {
    const t = tagged[i];
    if (!t.isWord) continue;
    if (t.gpos === "modal" || t.gpos === "aux") {
      // do/does/did/have/has/had/be 系：先看后面有没有主动词
      const nxt = nextWordFrom(tagged, i);
      const nextIsVerbLike = nxt && (isVerbish(nxt) || nxt.gpos === "aux" || nxt.gpos === "modal");
      const isBe = /^(be|am|is|are|was|were)$/.test(t.lower);
      if (!nextIsVerbLike) {
        // 「is far less clear」「has a plan」：这个助动词自己就是谓语。
        // 但 "had long been skeptical" 这类中间夹着副词、后面还有 been 的，had 不是谓语——故还要看"到句末有没有别的动词"
        /* do/does/did 后面允许夹主语（倒装：does the author address…），所以看全句；
           have/has/had/be 只看紧邻 4 个词——否则「has the virtue of simplicity … 后面还有一堆动词」
           会把实义 has（有）误判成助动词，导致主句谓语整块丢失 */
        const isDo = /^(do|does|did)$/.test(t.lower);
        let laterVerbish;
        if (isDo) {
          laterVerbish = tagged.slice(i + 1).some((g) => g.isWord && (isVerbish(g) || g.gpos === "aux" || g.gpos === "modal"));
        } else {
          const near = [];
          for (let k = i + 1; k < tagged.length && near.length < 4; k += 1) if (tagged[k].isWord) near.push(tagged[k]);
          laterVerbish = near.some((g) => isVerbish(g) || g.gpos === "aux" || g.gpos === "modal");
        }
        if (isBe || !laterVerbish) {
          t.vg = "finite";
          t.vgWhy = isBe
            ? "系动词 be 后面没有主动词 → 它本身就是谓语（系表结构）"
            : `${t.lower} 后面没有主动词 → 它自己就是谓语`;
          auxPending = null;
          auxAt = -1;
          continue;
        }
        auxPending = t.lower;
        auxAt = i;
        continue;
      }
      auxPending = t.lower;
      auxAt = i;
      continue;
    }
    if (t.gpos === "neg") continue;
    if (!isVerbish(t)) {
      const prevTok = prevWord(tagged, i);
      /* 第三人称单数谓语被当成复数名词：criticises / argues / suggests 会以 -s 结尾被判成 noun?，
         整句主谓就丢了。用位置判：前面已有主语性成分 + 后面紧跟宾语性成分 → 它是谓语。 */
      if (t.gpos === "noun?" && /(?:s|es)$/.test(t.lower) && !/^(this|its|his|status|analysis|basis|crisis|series|species|news|means)$/.test(t.lower)) {
        const nextTok = nextWordFrom(tagged, i);
        const prevSubjectish = prevTok && ["noun", "noun?", "pron", "poss"].includes(prevTok.gpos);
        const nextObjectish = nextTok && (["det", "poss", "noun", "noun?", "pron", "adj"].includes(nextTok.gpos));
        if (prevSubjectish && nextObjectish) {
          t.gpos = "verb";
          t.vg = "finite";
          t.vgWhy = `${prevTok.text}（主语）+ -s 词形 + ${nextTok.text}（宾语）→ 判定为第三人称单数谓语，不是复数名词`;
          continue;
        }
      }
      // to + 原形：不定式（此处把无词形的 assume / require 之类判为动词）
      if (prevTok && prevTok.lower === "to" && !/(ed|ing|s)$/.test(t.lower) && (t.gpos === "noun?" || t.gpos === "unknown" || t.gpos === "noun")) {
        t.gpos = "verb";
        t.vg = "infinitive";
        t.vgWhy = "to + 原形 → 不定式（按动词处理）";
        continue;
      }
      // 情态动词 / do 系助动词后必然接动词原形：中间只有副词/否定词时，把 noun?/unknown 改判为动词
      // （do/does/did 允许中间夹主语——倒装句 "does the author address"；have/be 系不做这个推断）
      const auxVerbForce = auxPending && (MODALS.has(auxPending) || ["do", "does", "did"].includes(auxPending));
      const doInversion = !!auxVerbForce && ["do", "does", "did"].includes(auxPending);
      let gapClean = false;
      if (auxVerbForce) {
        const between = tagged.slice(auxAt + 1, i).filter((g) => g.isWord);
        if (doInversion) gapClean = true;                       // does the author address：允许夹主语（但 noun 不改判，见下）
        else gapClean = between.every((g) => g.gpos === "adv" || g.gpos === "neg");
      }
      const looksBase = !/(ed|ing)$/.test(t.lower);
      // 只改判 noun?/unknown —— 已经确定是 noun 的词（前面有冠词）不当动词用
      if (gapClean && looksBase && (t.gpos === "noun?" || t.gpos === "unknown")) {
        t.gpos = "verb";
        t.vg = "finite";
        t.vgWhy = `情态动词/助动词 ${auxPending} 后 → 判定为动词原形`;
        t.auxHead = auxPending;
        auxPending = null;
        auxAt = -1;
        continue;
      }
      if (t.gpos === "adv" || t.gpos === "det" || t.gpos === "poss" || t.gpos === "adj" || t.gpos === "pron" || /^noun/.test(t.gpos)) {
        // 不在这里清空 auxPending：倒装句与「助动词 + 状语 + 名词」会让中间隔词
        continue;
      }
      auxPending = null;
      auxAt = -1;
      continue;
    }
    const prev = prevWord(tagged, i);
    const isTo = prev && prev.lower === "to";
    if (auxPending) {
      t.vg = "finite";
      t.vgWhy = `前有助动词/情态动词 ${auxPending} → 与它一起构成谓语`;
      t.auxHead = auxPending;
      auxPending = null;
      continue;
    }
    if (isTo) {
      t.vg = "infinitive";
      t.vgWhy = "to + 动词原形 → 不定式（非谓语）";
      continue;
    }
    if (t.gpos === "v-ing") {
      t.vg = "gerund";
      t.vgWhy = "-ing 且前无助动词 → 现在分词/动名词（非谓语）";
      continue;
    }
    if (t.gpos === "v-ed") {
      const forms = t.forms ?? [];
      const prevIsBe = prev && /^(is|are|was|were|be|been|being|am)$/.test(prev.lower);
      if (prevIsBe) {
        t.vg = "finite";
        t.vgWhy = "be + -ed → 被动语态谓语";
        t.auxHead = prev.lower;
      } else {
        t.vg = "past-or-pp";
        t.vgWhy = "-ed 无助动词：可能是过去式谓语，也可能是过去分词后置定语";
      }
      continue;
    }
    t.vg = "finite";
    t.vgWhy = "限定动词形态";
  }
  return tagged;
}

function prevWord(tokens, i) {
  for (let k = i - 1; k >= 0; k -= 1) if (tokens[k].isWord) return tokens[k];
  return null;
}
function nextWordFrom(tokens, i) {
  for (let k = i + 1; k < tokens.length; k += 1) if (tokens[k].isWord) return tokens[k];
  return null;
}

/** 从句块识别：引导词起，到同级标点 / 下一个引导词 / 从句谓语完成后遇到新的助动词为止。
 *  不做「吞并嵌套」——每个引导词各自独立成块（可重叠），父子关系由块内文本自然体现。 */
export function findClauses(tokens) {
  const clauses = [];
  const seen = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const isMarkerGpos = t.gpos === "rel" || t.gpos === "sub" || t.gpos === "adverbialPhrase";
    if (!isMarkerGpos) continue;
    if (seen.has(t.i)) continue;
    const start = i;
    let end = i;
    let finiteSeen = 0;
    for (let k = i + 1; k < tokens.length; k += 1) {
      const x = tokens[k];
      if (x.isPunct) {
        if (",;:—–()".includes(x.text) || x.text === "." || x.text === "!" || x.text === "?") { end = k - 1; break; }
        end = k - 1;
        continue;
      }
      // 下一个引导词 = 子句边界（嵌套从句由它自己那个位置单独成块）
      if (x.gpos === "rel" || x.gpos === "sub" || x.gpos === "adverbialPhrase") { end = k - 1; break; }
      // 从句谓语已出现，又冒出新的助动词/情态动词 ⇒ 主句谓语开始了
      if (finiteSeen >= 1 && (x.gpos === "aux" || x.gpos === "modal")) { end = k - 1; break; }
      if (x.vg === "finite") { finiteSeen += 1; end = k; continue; }
      end = k;
    }
    if (end < start) end = start;
    const blockTokens = tokens.slice(start, end + 1);
    if (blockTokens.length < 2) continue;
    seen.add(t.i);
    clauses.push({
      marker: t.lower,
      markerGpos: t.gpos,
      startIdx: t.i,
      endIdx: blockTokens[blockTokens.length - 1].i,
      text: blockTokens.map((x) => x.text).join(" ").replace(/\s+([,.;:!?])/g, "$1"),
      tokens: blockTokens
    });
  }
  return clauses;
}

/** 名词短语中心词候选：向前回溯，跳过限定词/形容词，取最近的名词性 token */
function npHeadBefore(tokens, fromPos) {
  for (let k = fromPos; k >= 0; k -= 1) {
    const t = tokens[k];
    if (!t.isWord) continue;
    if (t.gpos === "noun" || t.gpos === "noun?" || (t.forms && !isVerbish(t) && t.gpos !== "v-ing")) {
      return { head: t.lower, text: t.text, idx: t.i };
    }
  }
  return null;
}

/** 能作名词短语核心的词：确定名词、疑似名词，以及「-ing 名词化」（findings / savings / meetings） */
function isNounish(t) {
  if (!t || !t.isWord) return false;
  if (t.gpos === "noun" || t.gpos === "noun?" || t.gpos === "nounOrVerb") return true;
  if (t.gpos === "v-ing" && /ings?$/.test(t.lower)) return true;
  return false;
}

/** 收集一个区间内的名词短语（用于指代候选）。
 *  两个修正：① `findings` 这类 -ing 名词化以前被跳过，导致候选只剩形容词碎片（"the earlier"）；
 *           ② 以前只向左带限定词，不向右合并后续名词，同样会把 "the earlier findings" 截断。 */
function nounPhrasesBefore(tokens, fromPos, limit = 4) {
  const out = [];
  for (let k = fromPos; k >= 0 && out.length < limit; k -= 1) {
    const t = tokens[k];
    if (!isNounish(t)) continue;
    // 向左带限定词 / 所有格 / 形容词
    let start = k;
    for (let j = k - 1; j >= 0; j -= 1) {
      const p = tokens[j];
      if (!p.isWord) break;
      if (p.gpos === "det" || p.gpos === "poss" || p.gpos === "adj") { start = j; continue; }
      break;
    }
    // 向右合并同一 NP 的后续名词（不能停在修饰语上）
    let end = k;
    for (let j = k + 1; j < tokens.length; j += 1) {
      const p = tokens[j];
      if (!p.isWord) break;
      if (isNounish(p)) { end = j; continue; }
      break;
    }
    const text = tokens.slice(start, end + 1).map((x) => x.text).join(" ");
    if (text && !out.some((o) => o.text === text)) {
      out.push({ text, head: tokens[end].lower, idx: tokens[start].i, start: tokens[start].i, end: tokens[end].i });
    }
  }
  return out;
}

/** 主干提取：跳过「落在从句块内部」的谓语，才能拿到真正的主句主谓 */
export function extractBackbone(tokens, clauseRanges = []) {
  const words = tokens.filter((t) => t.isWord);
  if (!words.length) return null;
  const inClause = (tokIndex) => clauseRanges.some((r) => tokIndex >= r.startIdx && tokIndex <= r.endIdx);

  // 跳过句首状语块（prep/sub/分词短语后接逗号）
  let startPos = 0;
  const firstPunct = tokens.findIndex((t) => t.isPunct && ",—–".includes(t.text));
  if (firstPunct > 0) {
    const headTokens = tokens.slice(0, firstPunct).filter((t) => t.isWord);
    const headFirst = headTokens[0];
    // 句首分词短语（Having been told... / Faced with... / Being asked...）一定是状语：
    // 不论块内有没有从句，主句都从逗号后开始
    const firstLower = headFirst ? headFirst.lower : "";
    const isParticipialHead = /^(having|being)$/.test(firstLower) || /ing$/.test(firstLower) || /ed$/.test(firstLower);
    const isAdverbialHead = headFirst && ["prep", "sub", "compoundPrep", "adverbialPhrase", "adv"].includes(headFirst.gpos);
    const hasFiniteInHead = headTokens.some((t) => t.vg === "finite");
    if (isParticipialHead) startPos = firstPunct + 1;
    else if (isAdverbialHead && !hasFiniteInHead) startPos = firstPunct + 1;
    else if (startPos === 0 && headFirst && hasFiniteInHead) {
      // 句首状语从句块 + 逗号（But when it comes to … , … / If he comes, … / Whatever he said, …）：
      // 块内自带主谓，主句一定从逗号后开始。不跳过的话，从句里的谓语会被算进主句主语
      // （"when it comes to broader questions … many professionals" 会被当成一个主语）。
      const leadWord = headTokens.find((t) => t.gpos === "sub" || t.gpos === "rel" || t.gpos === "adverbialPhrase");
      if (leadWord && (leadWord === headFirst || ["conj", "adv", "prep"].includes(headFirst.gpos))) startPos = firstPunct + 1;
    }
  }

  // 主句谓语：startPos 之后第一个「不在从句内部」的限定动词
  let predPos = -1;
  for (let i = startPos; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t.isWord) continue;
    if (inClause(t.i)) continue;
    if (t.vg === "finite") { predPos = i; break; }
  }
  if (predPos === -1) {
    for (let i = startPos; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (!t.isWord || inClause(t.i)) continue;
      if (t.vg === "past-or-pp") { predPos = i; break; }
    }
  }
  // 兜底 2：所有限定动词都被判进从句块时，取块内最后一个「系动词型」谓语
  // （"The idea that ... is one" 这种：is 被块吞了，但它就是主句谓语）
  if (predPos === -1) {
    for (let i = tokens.length - 1; i >= startPos; i -= 1) {
      const t = tokens[i];
      if (t.isWord && t.vg === "finite" && /^(is|are|was|were|am|be|becomes?|seems?)$/.test(t.lower)) { predPos = i; break; }
    }
  }
  // 兜底 3：任意位置第一个 gpos=verb
  if (predPos === -1) {
    for (let i = startPos; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (!t.isWord) continue;
      if (t.gpos === "verb") { predPos = i; break; }
    }
  }
  // 兜底 4：任意位置第一个 finite（含从句内）
  if (predPos === -1) {
    for (let i = startPos; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t.isWord && t.vg === "finite") { predPos = i; break; }
    }
  }
  if (predPos === -1) return null;

  // 谓语前的助动词/情态动词/否定词属于谓语，不算主语的一部分
  const auxBefore = [];
  for (let k = predPos - 1; k >= startPos; k -= 1) {
    const t = tokens[k];
    if (t.gpos === "aux" || t.gpos === "modal" || t.gpos === "neg") auxBefore.unshift(t);
    else if (t.isWord) break;
  }
  const subjectEnd = predPos - auxBefore.length;
  const subjectTokens = tokens.slice(startPos, subjectEnd).filter((t) => t.isWord);
  const predicateTokens = [...auxBefore, tokens[predPos]];

  // 主语中心词：从主语开头扫，遇到从句引导词/介词/谓语即停，取已扫部分最后一个名词
  // （这条规则对 "The proposal that..." / "The new policy on tariffs" 都成立）
  let subjHeadToken = null;
  for (const t of subjectTokens) {
    if (t.gpos === "rel" || t.gpos === "sub" || t.gpos === "prep" || t.gpos === "compoundPrep" || t.vg === "finite") break;
    if (/^noun/.test(t.gpos)) subjHeadToken = t;
  }
  if (!subjHeadToken) subjHeadToken = subjectTokens.find((t) => /^noun/.test(t.gpos)) ?? subjectTokens[0] ?? null;

  // 谓语之后：到主句结束（去掉末尾从句块）
  const afterTokens = tokens.slice(predPos + 1);
  const predTok = tokens[predPos];
  const isPassive = predTok.gpos === "v-ed" && predTok.auxHead && /^(is|are|was|were|be|been|being|am|get|got)$/.test(predTok.auxHead);
  const linking = !isPassive && (LINKING_VERBS.has(predTok.lower) || /^(be|am|is|are|was|were|become|became|seem)$/.test(predTok.lower));
  let pattern = "SVO";
  const objectTokens = [];
  const adjunctTokens = [];
  let adjunctStarted = false;
  let nominalClauseObject = null;
  /* 动词+介词补足（met with resistance / rely on data / result in a loss）：
     以前谓语后遇到第一个介词就一律当状语起点，导致 "met with resistance" 被劈成
     「谓语 met + 宾语 with resistance」，宾语带上介词、"resistance" 的 from 定语也挂错。
     判据不用词表：看这个动词在前面**是否已经带了宾语**——
       没带 → 紧跟的介词是动词的补足，介词并入谓语，宾语从介词后的名词算起；
       已带 → 这个介词短语是状语（He met her with a smile）。 */
  const prepAttached = [];
  for (const t of afterTokens) {
    if (t.isPunct && ",;:".includes(t.text)) break;
    if (t.gpos === "rel" || t.gpos === "sub") {
      // 谓语后紧跟名词性从句（what/whether/how/why…）：整块就是宾语/表语，不能丢
      const cl = clauseRanges.find((r) => r.startIdx === t.i);
      if (cl && !objectTokens.length) nominalClauseObject = cl.text;
      break;
    }
    if (!t.isWord) continue;
    if (!adjunctStarted && (t.gpos === "prep" || t.gpos === "compoundPrep")) {
      const verbHasObject = objectTokens.length > 0;
      const tightToVerb = prepAttached.length === 0 && objectTokens.length === 0;
      if (!verbHasObject && tightToVerb && !linking) {
        prepAttached.push(t);   // 并入谓语，后面的名词才是宾语
        continue;
      }
      adjunctStarted = true;
    }
    if (adjunctStarted) adjunctTokens.push(t);
    else objectTokens.push(t);
  }
  if (linking) pattern = "SVP";
  else if (DITRANSITIVE.has(predTok.lower)) pattern = "SVOO";
  else if (COMPLEX_TRANSITIVE.has(predTok.lower)) pattern = "SVOC";

  const spanOf = (arr) => (arr.length ? [arr[0].i, arr[arr.length - 1].i] : null);

  const allPredTokens = [...predicateTokens, ...prepAttached];

  return {
    subject: subjectTokens.map((t) => t.text).join(" "),
    subjectHead: subjHeadToken ? subjHeadToken.text : null,
    predicate: allPredTokens.map((t) => t.text).join(" "),
    predicateWord: predTok.lower,
    predicateWhy: prepAttached.length
      ? `${predTok.vgWhy ?? ""}｜动词后紧跟介词且尚未带宾语 → 介词并入谓语（${predTok.lower} ${prepAttached.map((x) => x.lower).join(" ")}），宾语从介词后的名词算起`.trim()
      : predTok.vgWhy,
    object: nominalClauseObject ?? objectTokens.map((t) => t.text).join(" "),
    objectLabel: nominalClauseObject ? (linking ? "表语（名词性从句）" : "宾语（名词性从句）") : linking ? "表语" : isPassive ? "（被动，无宾语）" : "宾语",
    adjunct: adjunctTokens.map((t) => t.text).join(" ") || null,
    adjunctNote: adjunctTokens.length ? "以介词开头的这一段是状语，不是宾语——翻译时不要当宾语处理" : null,
    passive: !!isPassive,
    pattern,
    skippedLeadingAdverbial: startPos > 0 ? tokens.slice(0, startPos).map((t) => t.text).join(" ") : null,
    /** token.i 区间，供可视化定位用：subject/predicate/object/adjunct/leading */
    ranges: {
      subject: spanOf(subjectTokens),
      predicate: spanOf(predicateTokens),
      object: spanOf(objectTokens),
      adjunct: spanOf(adjunctTokens),
      leading: startPos > 0 ? [tokens[0].i, tokens[startPos - 1].i] : null
    },
    minimal: null
  };
}

/** 修饰归属 + 从句类型判定：从句挂到前面的哪个中心词，以及它是哪一类从句 */
const RELATIVE_WORDS = new Set(["which", "who", "whom", "whose", "whereby", "wherein"]);
const NOUN_CLAUSE_WORDS = new Set(["whether", "if", "what", "whatever", "whoever", "whomever", "whichever", "how", "why"]);

export function attachClauses(tokens, clauses) {
  return clauses.map((c) => {
    const idxInTokens = tokens.findIndex((t) => t.i === c.startIdx);
    const head = npHeadBefore(tokens, idxInTokens - 1);
    const prevTok = idxInTokens > 0 ? tokens[idxInTokens - 1] : null;
    const commaBefore = prevTok?.isPunct && prevTok.text === ",";
    const isRelativeWord = RELATIVE_WORDS.has(c.marker);
    const isNounClauseWord = NOUN_CLAUSE_WORDS.has(c.marker);
    const atSentenceStart = idxInTokens <= 1;

    let type;
    let attachesTo = head ? head.text : null;
    let note;

    if (isRelativeWord) {
      type = commaBefore ? "非限定性定语从句（补充说明，常译为「而……」）" : "定语从句（限定，修饰前面的名词）";
      note = head ? `修饰前面的名词「${head.text}」` : "前面没找到名词中心词：可能修饰整句或前面一个从句";
    } else if (isNounClauseWord) {
      const predicateBefore = prevTok && (prevTok.gpos === "verb" || prevTok.gpos === "v-ed" || /^(is|are|was|were|be|become)$/.test(prevTok.lower));
      if (atSentenceStart) {
        type = "主语从句（整个从句充当主句的主语）";
        note = "位于句首、由引导词开头 → 整块是主语，真正的主句谓语在它后面";
      } else if (predicateBefore && /^(is|are|was|were|be|become|seem)$/.test(prevTok.lower)) {
        type = "表语从句（在系动词后）";
        note = "系动词 be 之后 → 整块是表语";
      } else if (predicateBefore) {
        type = "宾语从句（在动词后）";
        note = "动词之后 → 整块作宾语";
      } else {
        type = "名词性从句";
        note = "充当句子成分（主语/宾语/表语/同位语），不修饰名词";
      }
      attachesTo = null;
    } else if (c.marker === "that") {
      // arguing / saying / noting / believing + that：这是 -ing 分词的宾语从句，
      // 不能因为前面「看起来是个名词形的 -ing 词」就判成定语从句
      const verbIngBefore = !!(prevTok
        && /ing$/.test(prevTok.lower)
        && prevTok.gpos !== "noun" && prevTok.gpos !== "noun?"
        && !/^(nothing|something|anything|everything|thing|building|meeting|meaning|feeling|bearing|during|according|including|concerning|regarding)$/.test(prevTok.lower));
      const nominalContext = !head || verbIngBefore
        || (prevTok && (prevTok.gpos === "verb" || prevTok.gpos === "v-ed" || prevTok.gpos === "adj"));
      if (nominalContext) {
        type = atSentenceStart ? "主语从句（that 引导）" : "名词性从句（that 引导：宾语/表语/同位语）";
        note = "that 从句整体充当句子成分，不是修饰名词";
        attachesTo = null;
      } else {
        type = commaBefore ? "非限定性定语从句" : "定语从句（修饰前面的名词）";
        note = `修饰前面的名词「${head.text}」`;
      }
    } else {
      type = "状语从句";
      note = "修饰主句的谓语或整句，不是修饰名词";
      attachesTo = null;
    }

    return { ...c, type, attachesTo, attachesToNote: note };
  });
}

/** 非谓语块 */
function findNonfinite(tokens) {
  const out = [];
  tokens.forEach((t, i) => {
    if (t.vg !== "gerund" && t.vg !== "infinitive" && t.vg !== "past-or-pp") return;
    const prev = prevWord(tokens, i);
    const next = nextWordFrom(tokens, i);
    let role;
    if (t.vg === "infinitive") role = "不定式：多作目的/结果状语，或作宾语、后置定语";
    else if (t.vg === "past-or-pp") role = "可能是过去分词后置定语（= 被……的）或过去式谓语——靠「前面有没有主语」区分";
    else if (i === 0 || (prev && prev.gpos === "punct")) role = "句首 -ing 短语：作状语（时间/原因/条件/伴随），逻辑主语通常就是主句主语";
    else if (i > 0 && tokens[i - 1]?.isPunct && ",;:".includes(tokens[i - 1].text)) role = "逗号后的 -ing 短语：作状语（伴随/结果/补充说明），逻辑主语是前面那句的主语或整件事——不是修饰前面某个名词";
    else if (prev && (prev.gpos === "noun" || prev.gpos === "noun?")) role = "名词后的 -ing：作后置定语（正在……的）";
    else role = "-ing 短语：作状语或宾语";
    out.push({ text: t.text, idx: t.i, role, why: t.vgWhy });
  });
  return out;
}

/** 指代候选 */
function findReferences(tokens) {
  const PRON = new Set(["it", "this", "that", "these", "those", "they", "them", "their", "its", "one", "ones", "he", "she", "him", "her", "his", "such", "which"]);
  const out = [];
  tokens.forEach((t, i) => {
    if (!t.isWord || !PRON.has(t.lower)) return;
    // that / which 若已作从句引导词或限定词，跳过——它们不是「指代」问题
    if ((t.lower === "that" || t.lower === "which") && (t.gpos === "rel" || t.gpos === "det")) return;
    if (t.lower === "such" && t.gpos !== "pron") return;
    const cands = nounPhrasesBefore(tokens, i - 1, 3);
    out.push({
      word: t.text,
      idx: t.i,
      candidates: cands,
      note: ["it", "this", "that", "such"].includes(t.lower)
        ? "单数指代：可能指前一个名词短语，也可能指前面整句/整件事——必须靠上下文定"
        : "复数指代：找前面最近的复数名词短语"
    });
  });
  return out;
}

/** 风险提示：搭配、熟词僻义、学术词、否定、虚拟、倒装、省略、固定句式 */
function collectHints(tokens, sentence) {
  const lowerSentence = ` ${sentence.toLowerCase()} `;
  const rawPhrases = [];
  for (const [k, v] of Object.entries(PHRASE_BANK)) {
    if (k.includes("...")) continue;
    if (lowerSentence.includes(` ${k} `) || lowerSentence.includes(` ${k},`) || lowerSentence.includes(` ${k}.`)) {
      rawPhrases.push({ phrase: k, meaning: v, level: "L2" });
    }
  }
  const hiddenSenses = [];
  const academic = [];
  const seen = new Set();
  tokens.forEach((t) => {
    if (!t.isWord) return;
    for (const v of lemmaVariants(t.lower)) {
      if (seen.has(v)) continue;
      if (HIDDEN_SENSES[v]) { hiddenSenses.push({ word: t.text, sense: HIDDEN_SENSES[v] }); seen.add(v); break; }
    }
    for (const v of lemmaVariants(t.lower)) {
      if (seen.has("a:" + v)) continue;
      if (ACADEMIC_SENSES[v]) { academic.push({ word: t.text, sense: ACADEMIC_SENSES[v] }); seen.add("a:" + v); break; }
    }
  });
  const negations = tokens.filter((t) => t.gpos === "neg").map((t) => t.text);
  /* 否定范围：只有这几类「容易读反」的结构才需要标；普通 not 直接跳过，
     不占界面的位置。判定全用形态特征，不需要模型。 */
  const negScopeRules = [
    { re: /\bnot\b[^.;!?]{0,45}\bbecause\b/i, label: "not … because：否定可能管到 because 从句（「不是因为…」），也可能只管主句（「没有因为…而…」）——靠上下文定范围" },
    { re: /\b(?:all|every|both|always)\b[^.;!?]{0,40}\bnot\b|\bnot\b[^.;!?]{0,40}\b(?:all|every|both|always)\b/i, label: "部分否定：not + all/every = 「并非所有」，不是「所有都不」" },
    { re: /\b(?:don't|doesn't|didn't|do not|does not|did not)\s+(?:think|believe|suppose|expect|imagine)\b/i, label: "否定前移：I don't think he is right = 「我认为他不对」，否定落在从句" },
    { re: /\bnot\s+until\b/i, label: "not … until：「直到……才……」，中文要把否定翻成肯定" },
    { re: /\bnot\s+only\b[^.;!?]{0,60}\bbut\s+(?:also|as\s+well)\b/i, label: "not only … but also：否定只管前半，意思是「不仅…而且…」" },
    { re: /\b(?:hardly|scarcely|barely|rarely|seldom|few|little|nowhere)\b/i, label: "准否定词：hardly / few / little 等本身带否定，中文别译成肯定" },
    { re: /\bnot\s+(?:necessarily|always|entirely|completely)\b/i, label: "部分否定：not necessarily = 「不一定」，不是「绝不」" }
  ];
  const negationScope = negScopeRules.filter((r) => r.re.test(sentence)).map((r) => r.label);
  /* 特殊句式：语序被打乱 / 结构被替换或省略的那些——一眼看不出来，必须还原再读 */
  const special = findSpecialPatterns(tokens, sentence);
  const subjunctive = [];
  const subMarkers = ["were to", "should have", "would have", "could have", "might have", "had it not been", "would rather", "as if", "as though", "lest", "for fear that"];
  for (const m of subMarkers) if (lowerSentence.includes(` ${m} `)) subjunctive.push(m);
  const inversion = [];
  const firstWords = tokens.filter((t) => t.isWord).slice(0, 3).map((t) => t.lower);
  if (negations.length && firstWords.some((w) => t_isNegStart(w))) inversion.push("否定词置于句首 → 后面主谓可能倒装（还原正常语序再读）");
  if (tokens.some((t, i) => t.lower === "only" && tokens[i + 1]?.lower === "to")) inversion.push("only to do → 表示「结果却……」，是结果状语不是目的");
  const passive = tokens.some((t, i) => {
    const p = prevWord(tokens, i);
    return t.gpos === "v-ed" && p && /^(is|are|was|were|be|been|being|get|got)$/.test(p.lower);
  });

  // 强调句 / 形式主语：It is/was ... that ...
  const cleft = [];
  if (/\bit (is|was)\s+not\s+until\b/i.test(sentence) && /\bthat\b/i.test(sentence)) {
    cleft.push("强调句：It was not until … that … = 「直到……才……」；去掉 It was 与 that，剩下的就是原句");
  } else if (/\bit (is|was)\b[^,.;]{0,60}\bthat\b/i.test(sentence)) {
    cleft.push("可能是强调句 It is/was … that …：删掉 It is/was 和 that 后若句子仍完整，就是强调句；否则是形式主语 it");
  }
  if (/\bthere (is|are|was|were)\b/i.test(sentence)) cleft.push("There be 存在句：中文用「有/存在/出现了」");
  const nominalization = tokens.filter((t) => t.gpos === "noun" && /(tion|sion|ment|ity|ance|ence|ness)$/.test(t.lower)).map((t) => t.text);

  // 固定句式 / 固定短语：逐词拼不出来的块单列一格。
  // 与 PHRASE_BANK 重名时以 fixed 为准（L3 分级更准），避免同一块在两处重复出现。
  const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const fixed = detectFixed(tokens, sentence);
  const fixedKeys = new Set(fixed.map((x) => norm(x.text)));
  const phrases = rawPhrases.filter((p) => !fixedKeys.has(norm(p.phrase)));

  return { phrases, fixed, special, hiddenSenses, academic, negations, negationScope, subjunctive, inversion, passive, cleft, nominalization };
}

function t_isNegStart(w) {
  return ["not", "never", "hardly", "scarcely", "rarely", "seldom", "little", "few", "no", "not until", "nowhere"].includes(w);
}

/** 词形还原候选：查词表时用，避免 assumptions 匹配不到 assumption */
export function lemmaVariants(word) {
  const w = String(word);
  const out = [w];
  if (w.endsWith("ies")) out.push(w.slice(0, -3) + "y");
  if (w.endsWith("es")) out.push(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss")) out.push(w.slice(0, -1));
  if (w.endsWith("ing")) { out.push(w.slice(0, -3)); out.push(w.slice(0, -3) + "e"); }
  if (w.endsWith("ed")) { out.push(w.slice(0, -2)); out.push(w.slice(0, -1)); }
  if (w.endsWith("ly")) out.push(w.slice(0, -2));
  return out;
}

/** 中文重组建议 */
function rewritePlan(backbone, clauses, hints, nonfinite) {
  const plan = [];
  if (clauses.some((c) => c.type.startsWith("定语"))) plan.push(REWRITE_TEMPLATES.relative);
  if (clauses.some((c) => c.type.startsWith("非限定性"))) plan.push(REWRITE_TEMPLATES.relative);
  if (clauses.some((c) => c.type === "状语从句")) plan.push(REWRITE_TEMPLATES.condition);
  if (nonfinite.some((n) => n.role.startsWith("句首"))) plan.push(REWRITE_TEMPLATES.participlePre);
  if (nonfinite.some((n) => n.role.includes("后置定语"))) plan.push(REWRITE_TEMPLATES.participlePost);
  if (hints.passive) plan.push(REWRITE_TEMPLATES.passive);
  if (hints.negations.length) plan.push(REWRITE_TEMPLATES.negationShift);
  if (hints.inversion.length) plan.push(REWRITE_TEMPLATES.inversion);
  if (backbone && backbone.pattern === "SVP") plan.push("系表结构：中文常译成「……是/显得/成为……」，注意表语部分可能有长修饰");
  if (/\b(it is|it was)\b.*\bthat\b/i.test(backbone?.subject ?? "")) plan.push(REWRITE_TEMPLATES.cleftIt);
  if (/\bthere (is|are|was|were)\b/i.test(backbone?.predicate ?? "")) plan.push(REWRITE_TEMPLATES.thereBe);
  if (!plan.length) plan.push("先译主干（主+谓+宾），再把每个修饰块按中文习惯塞回去；长定语拆成独立小句");
  return [...new Set(plan)];
}

/** 表语前置倒装时重算主干：is/was 后面的名词短语才是主语，句首那块是表语。 */
function repairPredicateFronting(tokens, backbone, special) {
  if (!backbone) return backbone;
  if (!(special || []).some((x) => x.kind && x.kind.indexOf("表语前置倒装") >= 0)) return backbone;
  const ws = tokens.filter((t) => t.isWord);
  const copPos = ws.findIndex((t, k) => k >= 1 && k <= 8 && /^(is|are|was|were|am)$/.test(t.lower));
  if (copPos < 1) return backbone;
  const after = [];
  for (let k = copPos + 1; k < ws.length; k += 1) {
    const t = ws[k];
    if (t.gpos === "v-ing" || t.vg === "gerund") break;           // covering … 是后置的状语/定语，不属于主语
    if (["noun", "noun?", "adj", "poss", "det", "verb"].includes(t.gpos)) { after.push(t); continue; }
    if (after.length) break;
  }
  if (!after.length) return backbone;
  const head = after.filter((t) => /^noun/.test(t.gpos) || t.gpos === "noun?").pop() || after[after.length - 1];
  const front = ws.slice(0, copPos).map((t) => t.text).join(" ");
  return {
    ...backbone,
    subject: after.map((t) => t.text).join(" "),
    subjectHead: head.text,
    predicate: ws[copPos].text,
    predicateWord: ws[copPos].lower,
    object: front,
    objectLabel: "表语（前置倒装）",
    subjectFronted: true,
    predicateWhy: `表语前置倒装：句首「${front}」是表语，${ws[copPos].text} 才是谓语，真正的主语是它后面的名词短语`,
    skippedLeadingAdverbial: null
  };
}

/** 完整解析 */
export function parseSentence(sentence) {
  const seg = segment(sentence);
  const tokens = markVerbForms(seg.tokens);
  const rawClauses = findClauses(tokens);
  const clauses = attachClauses(tokens, rawClauses);
  const nonfinite = findNonfinite(tokens);
  const references = findReferences(tokens);
  const hints = collectHints(tokens, sentence);
  /* 主干要在 hints 之后算：检出「表语前置倒装」时，按正常语序读出来的主语一定是错的
     （Also due this year is X → 会把 Also due this year 当成主语），这里直接换成正确切分。 */
  const backbone = repairPredicateFronting(tokens, extractBackbone(tokens, rawClauses), hints.special);
  const load = chunkLoad(tokens);
  const words = tokens.filter((t) => t.isWord);

  const depth = clauses.reduce((max, c) => {
    const inner = c.tokens.filter((t) => t.gpos === "rel" || t.gpos === "sub").length;
    return Math.max(max, inner);
  }, 1);

  return {
    sentence,
    stats: {
      words: words.length,
      clauses: clauses.length,
      depth,
      chunks: load.count,
      overload: load.overload,
      longWords: words.filter((t) => t.lower.length >= 9).length
    },
    chunks: load.chunks.map((c) => c.join(" ")),
    backbone,
    clauses: clauses.map((c) => ({
      marker: c.marker, text: c.text, type: c.type,
      attachesTo: c.attachesTo, note: c.attachesToNote
    })),
    nonfinite,
    references,
    hints,
    rewritePlan: rewritePlan(backbone, clauses, hints, nonfinite),
    tokens: tokens.map((t) => ({
      i: t.i,
      text: t.text,
      isWord: !!t.isWord,
      gpos: t.gpos,
      vg: t.vg ?? null,
      why: t.why ?? t.vgWhy ?? ""
    }))
  };
}

/** 批量：一段文本 -> 每句一份解析 */
export function parseText(text) {
  return splitSentences(text).map((s) => parseSentence(s));
}