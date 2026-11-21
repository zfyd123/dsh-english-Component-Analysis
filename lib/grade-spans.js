/**
 * grade-spans.js —— 标注式批改。
 *
 * 判定口径与后端 backend/app/services/papers.py 完全一致，保证两边分数可比：
 *   · 主体重叠 ≥ 50% 且成分名相同 → 算对（边界差一两个词不算错）
 *   · 覆盖率和准确率分别算：覆盖率看「标准成分里你标到多少」，准确率看「你标的里对多少」
 *   · 总分 = 覆盖率 × 70 + 准确率 × 30
 * 在这之上多一层：把错法归类成可练的病症（这才是诊断插件该给的）。
 */

const OVERLAP_OK = 0.5;

export function flatten(spans) {
  const out = [];
  for (const s of spans ?? []) {
    out.push(s);
    if (s.children?.length) out.push(...flatten(s.children));
  }
  return out;
}

const overlapOf = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

export function weightedScore(coveredTop, totalTop, correctSpans, userCount) {
  const coverage = coveredTop / (totalTop || 1);
  const precision = userCount ? correctSpans / userCount : 0;
  return {
    coverage: Math.round(coverage * 100),
    precision: Math.round(precision * 100),
    score: Math.round(coverage * 70 + precision * 30)
  };
}

const GRADE_BANDS = [[90, "优秀"], [75, "良好"], [60, "及格"], [0, "待提高"]];
const gradeLabel = (score) => (GRADE_BANDS.find(([line]) => score >= line) ?? [0, "待提高"])[1];

/** 错法归类：把 (你的标签, 正确标签) 映射成一句可练的话 */
function diagnoseMistake(yourRole, correctRole, correctNote) {
  const pair = `${yourRole}→${correctRole}`;
  const isClause = (r) => /从句/.test(r);
  const target = correctNote ? `${correctRole}（${correctNote}）` : correctRole;

  if (/定语/.test(yourRole) && /状语/.test(correctRole)) {
    return `这一段修饰的是动作或整句，不是名词，所以是${target}。定语回答「哪一个」，状语回答「何时/为何/如何」。`;
  }
  if (/状语/.test(yourRole) && /定语/.test(correctRole)) {
    return `这一段修饰的是紧挨着的名词，所以是${target}，不是状语。`;
  }
  if (isClause(yourRole) && !isClause(correctRole)) {
    return `你把它当成了从句，其实它只是${target}——从句要有自己的「引导词 + 主谓」。`;
  }
  if (!isClause(yourRole) && isClause(correctRole)) {
    return `你标得太小了：整段一起看才是${target}，从句要连引导词带内部结构一起标。`;
  }
  if (/从句/.test(yourRole) && /从句/.test(correctRole)) {
    return `都是从句，但类型不同：这里是${target}。看引导词和它在句中起什么作用。`;
  }
  if (/谓语/.test(correctRole)) {
    return `这段是${target}：它是这句话里能变时态的动词，其它动词要么在从句里、要么是非谓语。`;
  }
  if (/主语/.test(correctRole)) {
    return `这段是${target}：动作的发出者（被动句里是动作的承受者），位置通常在谓语之前。`;
  }
  if (/宾语|表语/.test(correctRole)) {
    return `这段是${target}：它在谓语后面，是动作的对象或主语的说明。`;
  }
  if (`${yourRole}` === "其他" || `${yourRole}` === "") {
    return `这一段的标准成分是${target}。`;
  }
  return `${pair} —— 这一段是${target}。`;
}

/**
 * 批改：用户标注 vs 标准成分树
 * @param {string[]} tokens
 * @param {Array<{start,end,role}>} userSpans  已排序、已去重的用户标注
 * @param {Array} answerParts  LLM 给出的成分树（含 children）
 */
export function gradeSpans(tokens, userSpans, answerParts) {
  const flat = flatten(answerParts).filter((s) => s.end > s.start);
  const top = (answerParts ?? []).filter((s) => s.end > s.start);
  const results = [];
  const matched = [];
  const correctSpans = [];

  for (const us of userSpans) {
    let best = null;
    let bestScore = 0;
    for (const ans of flat) {
      const ov = overlapOf(us, ans);
      if (ov <= 0) continue;
      // 同名优先：范围相近时，成分名对上的那个才是他真正想标的
      const weighted = ans.role === us.role ? ov * 2 : ov;
      if (weighted > bestScore) { best = ans; bestScore = weighted; }
    }

    if (!best) {
      results.push({
        start: us.start, end: us.end,
        text: tokens.slice(us.start, us.end).join(" "),
        yourRole: us.role, correctRole: "", verdict: "wrong-span",
        comment: "这一段没有对应的标准成分，划分位置偏离较大。"
      });
      continue;
    }

    const ov = overlapOf(us, best);
    const ratio = ov / Math.max(us.end - us.start, best.end - best.start);
    const sameRole = us.role === best.role;
    const exact = us.start === best.start && us.end === best.end;

    if (ratio >= OVERLAP_OK && sameRole) {
      results.push({
        start: us.start, end: us.end,
        text: tokens.slice(us.start, us.end).join(" "),
        yourRole: us.role, correctRole: best.role, verdict: "correct",
        comment: exact ? "" : `成分对了，范围可以再准一点：标准划分是「${best.text}」。`
      });
      correctSpans.push(us);
      const key = `${best.start}-${best.end}`;
      if (!matched.includes(key)) matched.push(key);
    } else if (ratio >= OVERLAP_OK) {
      results.push({
        start: us.start, end: us.end,
        text: tokens.slice(us.start, us.end).join(" "),
        yourRole: us.role, correctRole: best.role, verdict: "wrong-role",
        comment: diagnoseMistake(us.role, best.role, best.note)
      });
    } else {
      results.push({
        start: us.start, end: us.end,
        text: tokens.slice(us.start, us.end).join(" "),
        yourRole: us.role, correctRole: best.role, verdict: "wrong-span",
        comment: `范围偏了：标准划分是「${best.text}」（${best.role}）。`
      });
    }
  }

  // 覆盖率按第一层算：某段被标对的片段覆盖过半即算掌握
  let coveredTop = 0;
  const missed = [];
  for (const ans of top) {
    const hit = correctSpans.some((us) => overlapOf(us, ans) / Math.max(1, ans.end - ans.start) >= OVERLAP_OK);
    if (hit) coveredTop += 1;
    else missed.push({ start: ans.start, end: ans.end, text: ans.text, role: ans.role, zh: ans.zh });
  }

  const scored = weightedScore(coveredTop, top.length, correctSpans.length, userSpans.length);
  const coverageOfTokens = (() => {
    const set = new Set();
    userSpans.forEach((s) => { for (let i = s.start; i < s.end; i += 1) set.add(i); });
    return Math.round((set.size / (tokens.length || 1)) * 100);
  })();

  return {
    results,
    missed,
    matched,
    correctSpans: correctSpans.length,
    userCount: userSpans.length,
    answerCount: top.length,
    coveredTop,
    ...scored,
    grade: gradeLabel(scored.score),
    tokenCoverage: coverageOfTokens,
    diagnosis: diagnose(scored, results, missed, tokenCoverageCalc(userSpans, tokens.length))
  };
}

function tokenCoverageCalc(userSpans, total) {
  const set = new Set();
  userSpans.forEach((s) => { for (let i = s.start; i < s.end; i += 1) set.add(i); });
  return total ? set.size / total : 0;
}

/** 归因：从分数结构 + 错误类型里读出「他到底卡在什么毛病上」 */
export function diagnose(scored, results, missed, tokenCoverage) {
  const wrong = results.filter((r) => r.verdict !== "correct");
  const counts = {};
  wrong.forEach((r) => {
    const k = `${r.yourRole || "未标"}→${r.correctRole || "对不上"}`;
    counts[k] = (counts[k] ?? 0) + 1;
  });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([pair, n]) => ({ pair, count: n }));

  const patterns = [];
  const has = (your, correct) => wrong.some((r) =>
    (!your || r.yourRole === your) && (!correct || r.correctRole === correct));

  if (has("定语", "状语") || has("状语", "定语")) {
    patterns.push({
      tag: "修饰关系",
      detail: "定语和状语混了：定语修饰名词（哪一个），状语修饰动作或整句（何时/为何/如何）。",
      drill: "每标一个修饰成分，先问一句「它修饰的是名词，还是动作」，答案决定它是定语还是状语。"
    });
  }
  if (wrong.some((r) => /从句/.test(r.yourRole) !== /从句/.test(r.correctRole))) {
    patterns.push({
      tag: "从句边界",
      detail: "从句和短语混了：从句有「引导词 + 自己的主谓」，短语没有。",
      drill: "标从句时连引导词一起框住，再看框里有没有能变时态的动词——有才是从句。"
    });
  }
  if (missed.length && missed.length >= Math.max(2, Math.round((missed.length + results.filter(r => r.verdict === "correct").length) * 0.4))) {
    patterns.push({
      tag: "拆不出细层",
      detail: `有 ${missed.length} 个标准成分你完全没标，多半是只标了主干、没敢往从句内部拆。`,
      drill: "先把主谓宾标完，再对每个从句单独来一遍「谁做了什么」，不要一次想整句。"
    });
  }
  if (scored.precision < 60 && tokenCoverage > 0.75) {
    patterns.push({
      tag: "覆盖了但标错",
      detail: "整句都铺满了，错在成分判断本身，不是漏标。",
      drill: "放慢：每段先在心里说「它回答什么问题」（谁/做什么/哪一个/何时），再选标签。"
    });
  }
  if (tokenCoverage < 0.6) {
    patterns.push({
      tag: "标得太少",
      detail: `你只覆盖了 ${Math.round(tokenCoverage * 100)}% 的词，没标的段落等于没分析。`,
      drill: "目标是把整句每个词都归进某一段，哪怕没把握也先猜——猜错才有诊断价值。"
    });
  }
  // 句法层全对时不再塞一条「无明显问题」：整句的主卡点可能在别的层，
  // 这里冒出一句“没问题”会让人以为整句都没问题


  return { wrongCount: wrong.length, topConfusions: top, patterns };
}