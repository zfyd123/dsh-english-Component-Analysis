/**
 * special.js —— 特殊句式检出。
 *
 * 只收「无法一眼看出来」的那些：语序被打乱（倒装）、结构被替换或被省略。
 * 全部用形态特征判定，不调模型（毫秒级、确定性），每条都带：
 *   kind 句式名 / text 命中的原文 / why 判据 / fix 怎么还原再读
 *
 * 与 fixed.js 的分工：fixed 负责「逐词拼不出意思的块」（when it comes to、too…to），
 * 这里负责「句子结构被改过、必须还原语序才能读」的形态。两者不重复上报。
 */

const AUX = /^(is|are|was|were|am|be|been|being|have|has|had|do|does|did|can|could|will|would|shall|should|may|might|must)$/;
const COPULA = /^(is|are|was|were|am)$/;
const NEG_LEAD = /^(never|hardly|scarcely|rarely|seldom|little|nowhere|nor|neither|not)$/;
const MODAL_LEAD = /^(were|had|should|could|might)$/;
const SUB_OMIT = /^(when|while|if|though|although|unless|once|until|before|after|as|whether|where|whenever|if)$/;

const w = (t) => t && t.isWord;
const lc = (t) => String(t?.lower ?? t?.text ?? "").toLowerCase();
const txt = (arr) => arr.map((t) => t?.text ?? "").join(" ").replace(/\s+([,.;:!?])/g, "$1").trim();

/** 取句子里的词序列（跳过标点） */
function words(tokens) {
  return (tokens || []).filter(w);
}

/** 从 pos 开始找下一个限定动词的位置（-1 表示没有） */
function nextFinite(ws, pos) {
  for (let k = pos; k < ws.length; k += 1) if (ws[k].vg === "finite") return k;
  return -1;
}

/**
 * 检出特殊句式。
 * @param tokens parse.js 的 token 数组
 * @param sentence 原句（用于问号判断等）
 * @returns Array<{kind, text, why, fix, at}>  at = 命中位置（词序），用于排序
 */
export function findSpecialPatterns(tokens, sentence) {
  const ws = words(tokens);
  const src = String(sentence ?? "");
  const isQuestion = /\?\s*$/.test(src);
  const out = [];
  const push = (at, kind, span, why, fix) => {
    out.push({ at, kind, text: txt(span), why, fix });
  };
  if (ws.length < 3) return out;

  const first = ws[0];
  const f0 = lc(first);
  const f1 = lc(ws[1]);
  const f2 = lc(ws[2]);

  /* ── 1. 虚拟条件倒装：Were/Had/Should + 主语（= If … were/had/should） ── */
  if (MODAL_LEAD.test(f0) && !isQuestion && ws[1] && ["noun", "noun?", "pron", "poss", "det"].includes(ws[1].gpos)) {
    push(0, "虚拟条件倒装",
      ws.slice(0, 6),
      `句首 ${first.text} + 主语 → 这是省掉 if 的条件句（${f0 === "were" ? "Were I you = If I were you" : f0 === "had" ? "Had I known = If I had known" : "Should you need = If you should need"}）`,
      `还原成 If 从句再读：${f0} + 主语 + … → If + 主语 + ${f0 === "were" ? "were" : f0 === "had" ? "had" : "should"} + …；主句常带 would/could/might`);
  }

  /* ── 2. so / such 前置：So great was the impact that … ── */
  if (/^(so|such)$/.test(f0)) {
    const cop = ws.findIndex((t, k) => k > 0 && k <= 6 && COPULA.test(lc(t)));
    const hasThat = ws.some((t, k) => k > cop && /^that$/.test(lc(t)));
    if (cop > 0 && hasThat) {
      push(0, "so/such 前置倒装",
        ws.slice(0, Math.min(ws.length, cop + 4)),
        `句首 ${first.text} + 表语前置 + ${ws[cop].text} 在主语之前 → 主谓倒装，后面跟 that 引导的结果状语从句`,
        `还原：主语 + ${ws[cop].text} + so/such + 形容词 + that …；中文读作「如此……以致……」`);
    }
  }

  /* ── 3. 否定/半否定前置：Never have I … / Not until … did he … ── */
  if (NEG_LEAD.test(f0) || (f0 === "not" && f1 === "until")) {
    const auxAt = ws.findIndex((t, k) => k > 0 && k <= 4 && (AUX.test(lc(t)) || t.gpos === "aux" || t.gpos === "modal"));
    if (auxAt > 0) {
      push(0, "否定词前置倒装",
        ws.slice(0, Math.min(ws.length, auxAt + 3)),
        `否定词 ${first.text} 在句首，助动词 ${ws[auxAt].text} 紧跟其后 → 主谓倒装（正常语序里助动词在主语之后）`,
        `还原：主语 + ${ws[auxAt].text} + 动词 + …；中文仍按否定译，只是语序被提前了`);
    }
  }

  /* ── 4. only 前置：Only then did I realize … ── */
  if (f0 === "only") {
    const auxAt = ws.findIndex((t, k) => k > 0 && k <= 6 && (AUX.test(lc(t)) || t.gpos === "aux" || t.gpos === "modal"));
    if (auxAt > 0) {
      push(0, "only 前置倒装",
        ws.slice(0, Math.min(ws.length, auxAt + 3)),
        `Only + 状语置于句首，助动词 ${ws[auxAt].text} 被提到主语前 → 部分倒装`,
        `还原：主语 + ${ws[auxAt].text} + …；中文读作「只有……才……」`);
    }
  }

  /* ── 5. 让步倒装：Tired as he was / Difficult though it is ── */
  if (ws[1] && /^(as|though)$/.test(f1) && ["adj", "adv"].includes(first.gpos)) {
    push(0, "让步倒装（as/though）",
      ws.slice(0, 5),
      `形容词/副词 ${first.text} 提到 ${ws[1].text} 前面 → 让步结构，等于 Although he was ${first.text}`,
      `还原：Although + 主语 + be + ${first.text}, …；中文「虽然……但……」`);
  }

  /* ── 6. there / here + 动词 + 主语：Here comes the bus / There goes the bell ── */
  if (/^(here|there)$/.test(f0) && /^(comes?|goes?|stands?|lies?|sits?|is|are|was|were)$/.test(f1)) {
    push(0, "there/here 倒装",
      ws.slice(0, 4),
      `Here/There + 动词 + 主语 → 主语被放到动词之后（正常语序：The bus comes here.）`,
      `中文按「……来了 / 有……」处理，不要读成「这里来」`);
  }

  /* ── 7. 比较从句倒装：… than did his rivals ── */
  for (let k = 0; k < ws.length - 2; k += 1) {
    if (lc(ws[k]) !== "than") continue;
    if (!AUX.test(lc(ws[k + 1])) && ws[k + 1].gpos !== "aux") continue;
    if (!["noun", "noun?", "pron", "poss", "det"].includes(ws[k + 2].gpos)) continue;
    push(k, "比较从句倒装",
      ws.slice(k, Math.min(ws.length, k + 5)),
      `than 之后助动词 ${ws[k + 1].text} 出现在主语前 → 比较从句里的主谓倒装`,
      `还原：than + 主语 + 助动词 + 动词；中文照常译「比……」`);
    break;
  }

  /* ── 8. 表语前置倒装：Also due this year is X / Gone are the days … ── */
  (() => {
    if (/^(so|such)$/.test(f0)) return;              // 已由 so/such 规则处理
    if (ws[1] && /^(as|though)$/.test(f1)) return;   // 已由让步倒装处理
    /* 否定状语前置（By no means / In no way …）也是倒装，但句首那块是否定状语，
       不是表语——单独报一条，别混进「表语前置」。 */
    if (/^(by\s+no\s+means|in\s+no\s+way|in\s+no\s+case|under\s+no\s+circumstances|at\s+no\s+time|on\s+no\s+account)/i.test(src.trim())) {
      const copAt = ws.findIndex((t, k) => k > 0 && k <= 6 && COPULA.test(lc(t)));
      if (copAt > 0) {
        push(0, "否定状语前置倒装",
          ws.slice(0, Math.min(ws.length, copAt + 3)),
          `否定状语「${txt(ws.slice(0, copAt))}」置于句首，${ws[copAt].text} 被提到主语之前 → 主谓倒装`,
          `还原：主语 + ${ws[copAt].text} + …；中文「决不……」`);
      }
      return;
    }
    /* 词形不可靠：Also / due 这类词被分词层标成 noun? 是常事，
       所以先按「副词性词形白名单」放行，再排除真正的主语性首词。 */
    const advLike = /^(also|so|such|gone|chief|among|here|there|only|never|hardly|little|now|then|thus|still|yet|even)$/.test(f0);
    const leadOk = advLike || ["adj", "adv", "prep", "compoundPrep"].includes(first.gpos);
    if (!leadOk) return;
    if (!advLike && ["det", "pron", "noun", "noun?", "poss"].includes(first.gpos)) return;
    const cop = ws.findIndex((t, k) => k >= 1 && k <= 8 && COPULA.test(lc(t)));
    if (cop < 1) return;
    // 系动词后面必须是名词性主语（≥2 词），且再往后没有「紧邻的」第二个限定动词（否则更像从句）
    const after = ws.slice(cop + 1);
    if (!after.length) return;
    if (!["noun", "noun?", "pron", "poss", "det"].includes(after[0].gpos)) return;
    const secondFinite = after.findIndex((t, k) => k > 0 && t.vg === "finite");
    if (secondFinite > 0 && secondFinite <= 2) return;
    push(0, "表语前置倒装",
      ws.slice(0, Math.min(ws.length, cop + 5)),
      `句首是${first.gpos === "prep" ? "介词短语" : "表语成分"}，系动词 ${ws[cop].text} 出现在真正的主语之前 → 全倒装（主语在句末）`,
      `还原成正常语序：${txt(after.slice(0, 6))}… + ${ws[cop].text} + ${txt(ws.slice(1, cop))}；先找 is/was 后面的名词短语当主语，再看句首那块是表语还是状语`);
  })();

  /* ── 9. 强调句 / 形式主语：It is … that … ── */
  if (/^it$/.test(f0) && COPULA.test(f1)) {
    const third = ws[2];
    const thirdLower = lc(third);
    const ADJ_AFTER_IT = /^(clear|important|possible|necessary|obvious|likely|true|hard|easy|difficult|natural|surprising|said|believed|reported|thought|essential|vital|worth|unlikely|impossible)$/;
    const isFormalSubject = !!third && (third.gpos === "adj" || ADJ_AFTER_IT.test(thirdLower));
    const thatAt = ws.findIndex((t, k) => k > 2 && /^that$/.test(lc(t)));
    if (isFormalSubject) {
      push(0, "形式主语 it",
        ws.slice(0, Math.min(ws.length, 5)),
        `It + ${ws[1].text} + ${third.text}（形容词）→ it 只是占位，真正的内容在后面${thatAt > 0 ? "的 that 从句" : "（to do / that 从句）"}`,
        `中文把后面那块提到前面：「……（这件事）是${third.text === "important" ? "重要的" : "……的"}」；it 本身不译`);
    } else if (thatAt > 2) {
      /* 强调句：It is/was + 被强调成分（名词/代词/介词短语）+ that + 其余部分
         分词层会把 broke 标成 adj、把 Denham's 标成 finite，所以判定放宽到「后面有动词性成分」 */
      const rest = ws.slice(thatAt + 1);
      const hasVerbish = rest.some((t) => t.vg === "finite" || t.gpos === "verb" || t.vg === "past-or-pp"
        || ["v-ed", "adj"].includes(t.gpos));
      if (hasVerbish) {
        push(0, "强调句（It is … that …）",
          ws.slice(0, Math.min(ws.length, thatAt + 4)),
          `It ${ws[1].text} + ${txt(ws.slice(2, thatAt))} + that … → 被强调的就是中间那一块；删掉 It ${ws[1].text} 与 that 后剩下「${txt(rest.slice(0, 5))}」仍是完整句子`,
          `去掉 It ${ws[1].text} 和 that，把被强调的部分放回原位再读；中文用「正是……」或直接按原句译`);
      }
    }
  }

  /* ── 10. what 分裂句：What I need is time ── */
  if (/^(what|whatever)$/.test(f0) && !isQuestion) {
    const cop = ws.findIndex((t, k) => k > 1 && k <= 8 && COPULA.test(lc(t)));
    if (cop > 1) {
      push(0, "what 分裂句（从句作主语）",
        ws.slice(0, Math.min(ws.length, cop + 3)),
        `What 引导的从句一直延伸到 ${ws[cop].text} 之前，整块作主语 → 主句谓语是 ${ws[cop].text}`,
        `中文：「……的（东西/事情）是……」；不要把 What 当成疑问词`);
    }
  }

  /* ── 11. 状语从句省略：when asked / though tired / if any ── */
  for (let k = 0; k < ws.length - 1; k += 1) {
    const cur = ws[k];
    const nxt = ws[k + 1];
    if (!(cur.gpos === "sub" || cur.gpos === "adverbialPhrase" || SUB_OMIT.test(lc(cur)))) continue;
    const omitLike = ["v-ing", "v-ed", "adj"].includes(nxt.gpos)
      || nxt.vg === "gerund" || nxt.vg === "past-or-pp";
    if (!omitLike) continue;
    push(k, "状语从句省略",
      ws.slice(k, Math.min(ws.length, k + 4)),
      `${cur.text} 后面直接跟 ${nxt.text}，既没有主语也没有 be → 省略了「主语 + be」`,
      `补回来再读：${cur.text} (it/he was) ${nxt.text} …；中文照常译成「当……时 / 如果……」`);
    break;
  }

  /* ── 12. 独立主格：The work done, we left / Weather permitting, … ── */
  for (let k = 1; k < ws.length - 2; k += 1) {
    const noun = ws[k - 1];
    const part = ws[k];
    if (!["noun", "noun?", "pron", "poss"].includes(noun.gpos)) continue;
    /* done 会被分词层标成 aux、finished 有时标成 adj —— 词性不可靠，
       所以只要形如 -ed/-en/-ing 就当作分词候选。 */
    const partLike = ["v-ing", "v-ed", "adj", "aux"].includes(part.gpos)
      || part.vg === "gerund" || part.vg === "past-or-pp"
      || /(?:ed|en|ing)$/.test(lc(part));
    if (!partLike) continue;
    // 后面必须紧跟逗号，再往后得有主句的限定动词
    const nextTok = tokens.find((t) => t.i > part.i);
    if (!nextTok || !nextTok.isPunct || ![",", ";"].includes(nextTok.text)) continue;
    const tail = ws.slice(k + 1);
    if (!tail.some((t) => t.vg === "finite")) continue;
    push(k - 1, "独立主格",
      ws.slice(k - 1, Math.min(ws.length, k + 3)),
      `${noun.text} + ${part.text} 独占一块，自带逻辑主语 → 独立主格（不是修饰前面某个名词的定语）`,
      `中文拆成两个小句：「${noun.text}（被）${part.text}之后，……」；它的主语和主句主语不是同一个`);
    break;
  }

  /* ── 13. not so much A as B ── */
  if (/\bnot\s+so\s+much\b[^.;!?]{0,60}?\bas\b/i.test(src)) {
    push(0, "not so much A as B",
      [],
      "not so much … as … → 否定前面的、肯定后面的，强调后者",
      `中文：「与其说是 A，不如说是 B」；A 是被弱化的那个`);
  }

  /* ── 14. 双重否定：not uncommon / never without / not fail ── */
  if (/\bnot\s+\w*(?:un|less|in|im|ir|il)\w+\b/i.test(src) || /\bnever\b[^.;!?]{0,40}\bwithout\b/i.test(src) || /\bnot\b[^.;!?]{0,20}\bfail\b/i.test(src)) {
    const m = src.match(/\bnot\s+\w+/i) || src.match(/\bnever\s+\w+/i) || [];
    push(0, "双重否定",
      [],
      `否定词与否定性词形叠加（${m[0] || "not/never + 否定词"}）→ 实际是肯定`,
      `中文译成肯定：「并非不……= 是……」「never without = 总有」`);
  }

  // 去重：同 kind 同 text 只留一条；按出现位置排序
  const seen = new Set();
  return out
    .filter((x) => {
      const k = `${x.kind}|${x.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.at - b.at);
}

export const SPECIAL_LEVEL = "特殊句式";