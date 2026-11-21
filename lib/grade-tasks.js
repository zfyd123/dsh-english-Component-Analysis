/**
 * grade-tasks.js —— 指代 / 逻辑 / 词汇 / 表达 四类产出式批改。
 *
 * 与成分标注共用同一套「区间 + 标签」形状，但比对依据不同：
 *   R 指代：你圈出的所指，是否落在引擎的候选里
 *   L 逻辑：你圈出的管辖范围，是否覆盖引擎判定的作用域
 *   V 词汇：你点出的生词，是否命中僻义/搭配表；猜的意思是否接近
 *   E 表达：你的译文，是否把每个成分块都译出来了
 *
 * 判定原则与 papers.py 一致：重叠 ≥ 50% 即算命中，不要求逐字对齐。
 */

const OVERLAP_OK = 0.5;
const overlapOf = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const spanLen = (s) => Math.max(1, s.end - s.start);
const hitRatio = (a, b) => overlapOf(a, b) / Math.max(spanLen(a), spanLen(b));

/* ── 通用：把 tokens 里的一段拼回文本 ─────────────────────────── */
const textOf = (tokens, s) => tokens.slice(s.start, s.end).join(" ");

/* ── 通用：成分树可能传数组，也可能传 { parts } ─────────────── */
const partsOf = (x) => (Array.isArray(x) ? x : (x && Array.isArray(x.parts) ? x.parts : []));

/* ── 名词短语：向前找「限定词 + 形容词* + 名词」的区间 ───────────── */
const DET = new Set(["the", "a", "an", "this", "that", "these", "those", "my", "your", "his", "her", "its", "our", "their", "any", "some", "all", "both", "each", "every", "no"]);
const isWord = (t) => /[A-Za-z]/.test(String(t ?? ""));
const cmp = (t) => String(t ?? "").replace(/^[.,;:!?"'()\[\]—–-]+|[.,;:!?"'()\[\]—–-]+$/g, "").toLowerCase();

/** 代词之前的名词短语候选（区间） */
function nounPhrasesBefore(tokens, before) {
  const out = [];
  let i = before - 1;
  while (i >= 0 && out.length < 4) {
    if (!isWord(tokens[i])) { i -= 1; continue; }
    let end = i + 1;
    let start = i;
    // 往前吃掉形容词与限定词
    let j = i - 1;
    while (j >= 0 && isWord(tokens[j]) && (DET.has(cmp(tokens[j])) || /(ous|ive|ful|less|able|ible|al|ic|ary|ent|ant|ed|ing)$/.test(cmp(tokens[j])))) {
      start = j;
      if (DET.has(cmp(tokens[j]))) break;
      j -= 1;
    }
    out.push({ start, end, text: textOf(tokens, { start, end }) });
    i = start - 1;
  }
  return out;
}

/**
 * 代词前面那一段（it/its/this 常指「前面整件事」而不是某个名词）。
 * 从代词往前找到上一个句读，两者之间就是候选；没有句读就取到句首。
 */
function previousClause(tokens, pronIndex) {
  let start = 0;
  for (let i = pronIndex - 1; i >= 0; i -= 1) {
    if (/[.!?;,]/.test(String(tokens[i] ?? ""))) { start = i + 1; break; }
  }
  const end = pronIndex;
  if (end <= start) return null;
  return { start, end, text: textOf(tokens, { start, end }) };
}

/**
 * R：指代
 * pairs: [{ pron:{start,end}, target:{start,end} }]
 */
export function gradeReference(tokens, pairs, structure) {
  const results = [];
  // 物主代词（its/their/his/her/our）同样是指代题的合法对象，之前漏了它们
  const pronWords = new Set([
    "it", "its", "itself", "this", "that", "these", "those",
    "they", "them", "their", "theirs", "themselves",
    "one", "ones", "such",
    "he", "him", "his", "himself", "she", "her", "hers", "herself",
    "we", "us", "our", "ours", "you", "your", "yours",
    "which", "who", "whom", "whose"
  ]);

  for (const pair of pairs) {
    const pronSpan = pair?.pron;
    const targetSpan = pair?.target;
    const pronText = pronSpan ? textOf(tokens, pronSpan) : "";
    if (!pronSpan || !targetSpan || targetSpan.end <= targetSpan.start) {
      results.push({ verdict: "incomplete", pron: pronText, comment: "这条指代没选完整（要选代词和所指两段）。" });
      continue;
    }
    const pronLower = cmp(tokens[pronSpan.start] ?? "");
    if (!pronWords.has(pronLower)) {
      results.push({
        verdict: "wrong-pron", pron: pronText, target: textOf(tokens, targetSpan),
        comment: `这一段开头是「${pronText}」，不像代词。指代题要框一个代词：it / its / this / they / their / one…`
      });
      continue;
    }

    const candidates = nounPhrasesBefore(tokens, pronSpan.start);
    const prev = previousClause(tokens, pronSpan.start);
    const pool = prev ? [...candidates, prev] : candidates;

    let best = null;
    let bestRatio = 0;
    for (const c of pool) {
      const r = hitRatio(targetSpan, c);
      if (r > bestRatio) { best = c; bestRatio = r; }
    }

    if (best && bestRatio >= OVERLAP_OK) {
      const whole = best === prev;
      results.push({
        verdict: "correct",
        pron: pronText,
        target: textOf(tokens, targetSpan),
        expected: best.text,
        comment: whole
          ? "指前面整件事——这类 it/this 不指单个名词，中文常用「这一点 / 这种做法」接。"
          : (bestRatio >= 0.999 ? "" : `范围可以再收一点：标准所指是「${best.text}」。`)
      });
    } else if (best) {
      results.push({
        verdict: "wrong-target",
        pron: pronText,
        target: textOf(tokens, targetSpan),
        expected: best.text,
        comment: `所指偏了：最贴近的是「${best.text}」。判断时先看代词前最近的名词短语，站不住再考虑「指前面整句」。`
      });
    } else {
      results.push({
        verdict: "unknown",
        pron: pronText,
        target: textOf(tokens, targetSpan),
        comment: "代词前面没有可用的名词短语，可能是形式主语或指代前文。"
      });
    }
  }

  const judged = results.filter((r) => r.verdict === "correct" || r.verdict === "wrong-target" || r.verdict === "wrong-pron");
  const correct = judged.filter((r) => r.verdict === "correct").length;
  return {
    results,
    total: judged.length,
    correct,
    score: judged.length ? Math.round((correct / judged.length) * 100) : null,
    patterns: buildPatterns(results, "指代")
  };
}

/* ── L：逻辑（否定范围 / 从句管辖）──────────────────────────────── */
const NEG = new Set(["not", "never", "no", "none", "nobody", "nothing", "neither", "nor", "hardly", "scarcely", "barely", "rarely", "seldom", "without", "cannot", "unless"]);
const CONJ = new Set(["because", "although", "though", "while", "whereas", "since", "if", "unless", "when", "once", "after", "before", "until", "as", "so", "that", "which", "who", "whether"]);

/**
 * L：逻辑
 * pairs: [{ trigger:{start,end}, scope:{start,end} }]
 * 引擎的作用域：否定词 → 它所在分句到句末；连词 → 该从句整段（用 LLM 树里的从句段）
 */
export function gradeLogic(tokens, pairs, structure) {
  const clauseParts = [];
  const walk = (arr) => partsOf(arr).forEach((p) => {
    if (/从句/.test(String(p.role ?? ""))) clauseParts.push(p);
    if (p.children?.length) walk(p.children);
  });
  walk(structure);

  const results = [];
  for (const pair of pairs) {
    const trig = pair?.trigger;
    const scope = pair?.scope;
    const trigText = trig ? textOf(tokens, trig) : "";
    if (!trig || !scope) {
      results.push({ verdict: "incomplete", trigger: trigText, comment: "这条没选完整（要选触发词和它管辖的范围）。" });
      continue;
    }
    const word = cmp(tokens[trig.start] ?? "");
    const isNeg = NEG.has(word);
    const isConj = CONJ.has(word);
    if (!isNeg && !isConj) {
      results.push({
        verdict: "wrong-trigger", trigger: trigText, scope: textOf(tokens, scope),
        comment: `「${trigText}」既不是否定词也不是从句引导词。先选 not/never/hardly 这类否定词，或 because/although/when 这类引导词。`
      });
      continue;
    }

    // 引擎的作用域
    let expected = null;
    if (isConj) {
      const cl = clauseParts.find((p) => Math.abs(p.start - trig.start) <= 1);
      if (cl) expected = { start: cl.start, end: cl.end, text: cl.text, label: `${cl.role}` };
    }
    if (!expected) {
      // 先看触发词落在哪个从句段里：那就是它的天然作用域
      const host = clauseParts.find((p) => trig.start >= p.start && trig.end <= p.end);
      if (host) {
        expected = { start: host.start, end: host.end, text: host.text, label: host.role };
      } else {
        // 否则到本分句结束（逗号也算分句边界，不能一路吃到句号）
        let end = trig.end;
        while (end < tokens.length && !/[.!?;,]/.test(String(tokens[end] ?? ""))) end += 1;
        expected = { start: trig.start, end, text: textOf(tokens, { start: trig.start, end }), label: isNeg ? "否定的谓语范围" : "从句" };
      }
    }

    const ratio = hitRatio(scope, expected);
    if (ratio >= OVERLAP_OK) {
      results.push({
        verdict: "correct", trigger: trigText, scope: textOf(tokens, scope), expected: expected.text,
        comment: ratio >= 0.999 ? "" : `方向对了，边界可以再准一点：标准范围是「${expected.text}」。`
      });
    } else {
      results.push({
        verdict: "wrong-scope", trigger: trigText, scope: textOf(tokens, scope), expected: expected.text,
        comment: `${isNeg ? "否定" : "从句"}的作用域不对。标准范围是「${expected.text}」（${expected.label}）——${isNeg ? "英语否定通常管到分句结束，不是只否定紧跟的那个词。" : "从句要从引导词一直圈到它自己的结束。"}`
      });
    }
  }

  const judged = results.filter((r) => ["correct", "wrong-scope", "wrong-trigger"].includes(r.verdict));
  const correct = judged.filter((r) => r.verdict === "correct").length;
  return {
    results,
    total: judged.length,
    correct,
    score: judged.length ? Math.round((correct / judged.length) * 100) : null,
    patterns: buildPatterns(results, "逻辑")
  };
}

/* ── V：词汇自评 ────────────────────────────────────────────────── */
/** 义项字符串里的关键词（去掉括号注解与标点） */
function senseKeywords(sense) {
  const plain = String(sense).replace(/（[^）]*）/g, " ").replace(/\([^)]*\)/g, " ");
  return plain.split(/[、；;，,。/\s+]+/).map((x) => x.trim()).filter((x) => x.length >= 2).slice(0, 4);
}

/**
 * V：词汇
 * items: [{ start, end, guess }]
 * dict: { hiddenSenses:[{word,sense}], academic:[{word,sense}], phrases:[{phrase,meaning}] }
 */
export function gradeVocab(tokens, items, dict) {
  const lookup = new Map();
  (dict?.hiddenSenses || []).forEach((x) => lookup.set(String(x.word).toLowerCase(), { sense: x.sense, kind: "熟词僻义" }));
  (dict?.academic || []).forEach((x) => { if (!lookup.has(String(x.word).toLowerCase())) lookup.set(String(x.word).toLowerCase(), { sense: x.sense, kind: "学术词义项" }); });

  const results = [];
  for (const item of items) {
    const span = { start: Number(item?.start) || 0, end: Number(item?.end) || 0 };
    if (span.end <= span.start) { results.push({ verdict: "incomplete", comment: "这条生词没选到词。" }); continue; }
    const word = textOf(tokens, span);
    const guess = String(item?.guess ?? "").trim();
    const entry = lookup.get(cmp(word));

    if (!entry) {
      results.push({
        verdict: "neutral", word, guess,
        comment: `「${word}」不在僻义表里——这句里它多半就是常见义。真不认识就直接查，查完记住搭配。`
      });
      continue;
    }

    const keywords = senseKeywords(entry.sense);
    const hit = keywords.some((k) => guess.includes(k));
    if (!guess) {
      results.push({
        verdict: "blank", word, guess, expected: entry.sense,
        comment: `这个词有「${entry.kind}」：${entry.sense}`
      });
    } else if (hit) {
      results.push({ verdict: "correct", word, guess, expected: entry.sense, comment: `对上了：${entry.sense}` });
    } else {
      results.push({
        verdict: "wrong-meaning", word, guess, expected: entry.sense,
        comment: `这里是「${entry.kind}」：${entry.sense}。你写的是「${guess}」——差在义项选错，不是词不认识。`
      });
    }
  }

  const judged = results.filter((r) => ["correct", "wrong-meaning", "blank"].includes(r.verdict));
  const correct = judged.filter((r) => r.verdict === "correct").length;
  return {
    results,
    total: judged.length,
    correct,
    score: judged.length ? Math.round((correct / judged.length) * 100) : null,
    patterns: buildPatterns(results, "词汇")
  };
}

/* ── E：表达（译文覆盖）─────────────────────────────────────────── */
/**
 * E：译文
 * 用成分树每段的 zh 当「该译出来的意思」，检查用户译文里有没有对应词。
 * 命中判为「译到了」，未命中只标「疑似漏译」——规则匹配有噪声，不能当铁证。
 */
export function gradeTranslation(tokens, translation, structure, dict) {
  const text = String(translation ?? "").trim();
  if (!text) return { results: [], total: 0, correct: 0, score: null, patterns: [], empty: true };

  const parts = partsOf(structure).filter((p) => p && typeof p.zh === "string" && p.zh.trim());
  /**
   * 中文匹配放宽到「核心词」：LLM 给的 zh 常带「们/的/在…之后」这类壳，
   * 用户译文不会照抄。命中前 3 字或后 3 字即算译到——E 层本来就只标「疑似漏译」。
   */
  const matches = (k) => {
    if (text.includes(k)) return true;
    const core = String(k).replace(/[们的地得了着过和与及、]/g, "");
    if (core.length < 2) return false;
    if (core.length <= 3) return text.includes(core);
    return text.includes(core.slice(0, 3)) || text.includes(core.slice(-3));
  };
  const results = [];
  for (const p of parts) {
    const keys = senseKeywords(p.zh);
    if (!keys.length) continue;
    const hit = keys.some(matches);
    results.push({
      start: p.start, end: p.end, role: p.role, zh: p.zh,
      verdict: hit ? "covered" : "maybe-missing",
      comment: hit ? "" : `「${p.zh}」这一段的意思在译文里没找到对应。`
    });
  }

  const total = results.length;
  const covered = results.filter((r) => r.verdict === "covered").length;
  return {
    results,
    total,
    correct: covered,
    score: total ? Math.round((covered / total) * 100) : null,
    patterns: total && covered < total
      ? [{
        tag: "译文漏块",
        detail: `有 ${total - covered} 个成分块的意思在译文里没出现。`,
        drill: "译之前先把每个成分块的中文抄下来，译完逐块打勾，别整句凭感觉写。"
      }]
      : [],
    empty: false
  };
}

/* ── 错法归类 ───────────────────────────────────────────────────── */
function buildPatterns(results, kind) {
  const bad = results.filter((r) => !["correct", "covered", "neutral"].includes(r.verdict));
  if (!bad.length) return [];
  const tags = new Set(bad.map((r) => r.verdict));
  const out = [];
  if (tags.has("wrong-target")) {
    out.push({
      tag: `${kind}：所指偏了`,
      detail: "代词指的是名词短语，你圈的范围对不上。",
      drill: "先只圈代词前最近的那个名词（一个词），站得住再往前扩。"
    });
  }
  if (tags.has("wrong-scope")) {
    out.push({
      tag: "逻辑：作用域划小了/大了",
      detail: "否定或从句的管辖范围与标准不一致。",
      drill: "否定从否定词划到分句结束；从句从引导词划到它自己结束，两头都要包住。"
    });
  }
  if (tags.has("wrong-meaning")) {
    out.push({
      tag: "词汇：义项选错",
      detail: "词认识，但在这句里选了别的义项。",
      drill: "查词先定词性、再看该词性下第 3–4 个义项，别停在第一条。"
    });
  }
  if (tags.has("incomplete") || tags.has("wrong-pron") || tags.has("wrong-trigger")) {
    out.push({
      tag: `${kind}：没选到要点`,
      detail: "圈的不是代词/否定词/引导词本身。",
      drill: "先只圈那一个触发词，再圈范围——分两步比一次圈准得多。"
    });
  }
  return out;
}

/* ── 汇总五层 ───────────────────────────────────────────────────── */
export function summarize(layerScores) {
  const layers = {};
  let primary = null;
  const order = ["S", "R", "L", "V", "E"];
  let lowest = null;
  for (const key of order) {
    const s = layerScores[key];
    if (!s || s.score === null || s.score === undefined) { layers[key] = "skip"; continue; }
    const pass = s.score >= 75;
    layers[key] = pass ? "hit" : "miss";
    if (!pass && (lowest === null || s.score < lowest.score)) {
      lowest = { key, score: s.score };
    }
  }
  if (lowest) primary = lowest.key;
  return { layers, primary, wrongLayers: order.filter((k) => layers[k] === "miss") };
}