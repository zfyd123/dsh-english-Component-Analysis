/**
 * render.js —— 把解析结果渲染成给人看的体检报告。
 * 原则：每一行都要能对应回原文里的具体片段，不做笼统评价。
 */

export function renderAnalysis(p) {
  const L = [];
  L.push("## 句子体检");
  L.push("");
  L.push(`原文：${p.sentence}`);
  L.push("");
  L.push(`规模：${p.stats.words} 词 · ${p.stats.chunks} 个意群 · ${p.stats.clauses} 个从句块 · 长词 ${p.stats.longWords} 个`);
  if (p.stats.overload) L.push("⚠ 意群超过 8 个：工作记忆会超载，先切块再读，不要一口气读完。");
  L.push("");

  if (p.backbone) {
    const b = p.backbone;
    L.push("### 主干（先只看这三段）");
    L.push("");
    L.push(`- **主语**：${b.subject || "（未识别）"}`);
    L.push(`- **谓语**：${b.predicate || "（未识别）"}`);
    L.push(`- **${b.objectLabel}**：${b.object || "（无）"}`);
    if (b.adjunct) L.push(`- 状语（非宾语，别当宾语译）：${b.adjunct}`);
    L.push(`- 句型：${b.pattern}`);
    if (b.subjectHead && b.subjectHead !== b.subject) L.push(`- 主语中心词：**${b.subjectHead}**（其余都是它的修饰）`);
    if (b.predicateWhy) L.push(`- 判定依据：${b.predicateWhy}`);
    if (b.skippedLeadingAdverbial) L.push(`- 句首状语（已排除在主干之外）：${b.skippedLeadingAdverbial}`);
    L.push("");
  } else {
    L.push("### 主干");
    L.push("");
    L.push("未能自动判定主干。多半是倒装、强调句或省略结构——先按下面「风险提示」还原语序，再找第一个不在从句里的限定动词。");
    L.push("");
  }

  if (p.clauses.length) {
    L.push("### 从句 / 从句块清单");
    L.push("");
    p.clauses.forEach((c, i) => {
      L.push(`${i + 1}. \`${c.marker}\` — **${c.type}**`);
      L.push(`   - 块文本：${c.text}`);
      L.push(`   - 归属：${c.note}`);
    });
    L.push("");
  }

  if (p.nonfinite.length) {
    L.push("### 非谓语 / 疑似非谓语");
    L.push("");
    p.nonfinite.forEach((n) => L.push(`- \`${n.text}\`：${n.role}`));
    L.push("");
  }

  if (p.references.length) {
    L.push("### 指代候选（向后最近的名词短语）");
    L.push("");
    p.references.forEach((r) => {
      const cands = r.candidates.map((c) => c.text).join(" / ") || "（前面没有可用的名词短语）";
      L.push(`- \`${r.word}\` → ${cands}`);
      L.push(`  ${r.note}`);
    });
    L.push("");
  }

  const h = p.hints;
  const hasHint = h.phrases.length || h.hiddenSenses.length || h.academic.length ||
    h.negations.length || h.subjunctive.length || h.inversion.length || h.passive ||
    (h.cleft && h.cleft.length) || (h.nominalization && h.nominalization.length);
  if (hasHint) {
    L.push("### 风险提示（查了词还是译不出的常见原因）");
    L.push("");
    if (h.phrases.length) h.phrases.forEach((x) => L.push(`- **搭配整体义** \`${x.phrase}\` = ${x.meaning} —— 逐词查必错`));
    if (h.hiddenSenses.length) h.hiddenSenses.forEach((x) => L.push(`- **熟词僻义** \`${x.word}\`：${x.sense}`));
    if (h.academic.length) h.academic.forEach((x) => L.push(`- **学术词义项** \`${x.word}\`：${x.sense}`));
    if (h.negations.length) L.push(`- **否定**：${h.negations.join("、")} —— 先确定否定范围（管到哪），再译`);
    if (h.subjunctive.length) L.push(`- **虚拟/非事实**：${h.subjunctive.join("、")} —— 中文要加「本来/要是……的话/差点」`);
    if (h.inversion && h.inversion.length) h.inversion.forEach((x) => L.push(`- **倒装**：${x}`));
    if (h.passive) L.push("- **被动**：中文可改主动，或加「被/受到/得到/得以」");
    if (h.cleft && h.cleft.length) h.cleft.forEach((x) => L.push(`- **特殊句式**：${x}`));
    if (h.nominalization && h.nominalization.length) L.push(`- **抽象名词化**：${h.nominalization.join("、")} —— 中文改成动词小句更顺`);
    L.push("");
  }

  if (p.chunks.length) {
    L.push("### 意群切分（按这个节奏读，别逐词念）");
    L.push("");
    L.push(p.chunks.map((c) => `\`${c}\``).join(" ／ "));
    L.push("");
  }

  L.push("### 中文重组建议");
  L.push("");
  p.rewritePlan.forEach((x) => L.push(`- ${x}`));
  return L.join("\n");
}

/** 讲解：把结构 → 译法串起来 */
export function renderExplain(p) {
  const L = [];
  L.push("## 怎么把它译成中文");
  L.push("");
  if (p.backbone) {
    L.push(`1. **先译骨架**（只译这三段，别的都不要管）：`);
    L.push(`   主语「${p.backbone.subject}」+ 谓语「${p.backbone.predicate}」${p.backbone.object ? ` + ${p.backbone.objectLabel}「${p.backbone.object}」` : ""}`);
    L.push("");
    L.push("2. **再把每个修饰块挂回去**：");
    if (p.backbone.skippedLeadingAdverbial) L.push(`   - 句首状语「${p.backbone.skippedLeadingAdverbial}」→ 中文放句首：「……之后/时/因为……」`);
    p.clauses.forEach((c) => {
      L.push(`   - \`${c.marker}\` 块 → ${c.type}；${c.note}`);
    });
    if (p.backbone.adjunct) L.push(`   - 状语「${p.backbone.adjunct}」→ 中文放谓语前或句末`);
    L.push("");
  }
  L.push("3. **按中文习惯重排**：");
  p.rewritePlan.forEach((x) => L.push(`   - ${x}`));
  L.push("");
  if (p.references.length) {
    L.push("4. **代词全部换成实指**（不换就会译成「它/这」读不通）：");
    p.references.forEach((r) => L.push(`   - ${r.word} → ${r.candidates.map((c) => c.text).join(" / ") || "需结合上下文"}`));
    L.push("");
  }
  L.push("5. **最后检查三件事**：主干是否译出来了？每个从句是否都落到了中文里？否定和转折的方向有没有反？");
  return L.join("\n");
}