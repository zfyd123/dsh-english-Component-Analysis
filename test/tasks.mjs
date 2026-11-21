/** 五类作业的批改验证：S 成分 / R 指代 / L 逻辑 / V 词汇 / E 表达 */
import { makeRoutes } from "../lib/api.js";

const routes = makeRoutes({});
const byPath = Object.fromEntries(routes.map((r) => [r.path, r]));
function call(path, payload) {
  return new Promise((resolve) => {
    const chunks = payload ? [Buffer.from(JSON.stringify(payload), "utf8")] : [];
    const req = {
      method: payload ? "POST" : "GET", url: path,
      socket: { remoteAddress: "127.0.0.1" },
      async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; }
    };
    const res = { setHeader() {}, end(s) { resolve(JSON.parse(s)); } };
    byPath[path.split("?")[0]].handler(req, res);
  });
}

const SENTENCE = "Having been told that the results would not be released until the following month, the researchers decided to press ahead with a second trial.";

const st = await call("/api/dsh-en-coach/structure", { sentence: SENTENCE });
if (!st.ok) { console.log("structure 失败:", st.error); process.exit(1); }
console.log(`tokens(${st.tokens.length}):`, st.tokens.map((t, i) => `${i}:${t}`).join(" "));

const idx = (w) => st.tokens.indexOf(w);
const notIdx = idx("not");
const tok = st.tokens;

// S：状语从句整段 + 主语 + 谓语
const S = [
  { start: 0, end: 14, role: "状语" },
  { start: 14, end: 16, role: "主语" },
  { start: 16, end: 17, role: "谓语" }
];
// L：否定词 not 管到分句结束（到 comma 之后）
const L = [{ trigger: { start: notIdx, end: notIdx + 1 }, scope: { start: notIdx, end: 14 } }];
// V：点出 press，猜一个错的意思
const V = [{ start: idx("press"), end: idx("press") + 1, guess: "压力" }];
// E：故意漏掉「被告知」那一块
const E = "研究人员决定继续推进第二项试验。";

const res = await call("/api/dsh-en-coach/annotate", {
  sentence: SENTENCE, spans: S, refs: [], logic: L, words: V, translation: E
});
if (!res.ok) { console.log("annotate 失败:", res.error); process.exit(1); }

console.log("\n总分:", res.overall, "| 层:", JSON.stringify(res.layers), "| 主卡点:", res.primary);
for (const key of ["S", "R", "L", "V", "E"]) {
  const d = res[key];
  const score = d?.score === null || d?.score === undefined ? "—" : d.score;
  console.log(`\n[${key}] 分数 ${score}`);
  (d?.results || []).forEach((r) => {
    const label = r.verdict;
    const detail = key === "S" ? `${r.text || ""} 你标${r.yourRole || "—"}/标准${r.correctRole || "—"}`
      : key === "L" ? `${r.trigger || ""} → ${r.scope || ""}（标准 ${r.expected || ""}）`
        : key === "V" ? `${r.word || ""} 猜「${r.guess || ""}」（实际 ${r.expected || "—"}）`
          : `${r.role || ""}「${(r.zh || "").slice(0, 20)}」`;
    console.log(`   ${label.padEnd(12)} ${detail}`);
    if (r.comment) console.log(`      ${r.comment.slice(0, 90)}`);
  });
  (d?.patterns || []).forEach((p) => console.log(`   归因: ${p.tag}`));
}

/* 指代单独用一句 */
const S2 = "The board rejected the plan, which would require it to cut costs.";
const st2 = await call("/api/dsh-en-coach/structure", { sentence: S2 });
const t2 = st2.tokens;
const itIdx = t2.indexOf("it");
const planIdx = t2.findIndex((x) => x.startsWith("plan"));
console.log("\n第二句 tokens:", t2.map((t, i) => `${i}:${t}`).join(" "));
const r2 = await call("/api/dsh-en-coach/annotate", {
  sentence: S2,
  spans: [],
  refs: [{ pron: { start: itIdx, end: itIdx + 1 }, target: { start: planIdx, end: planIdx + 1 } }]
});
console.log("R 结果:", r2.R?.results?.map((r) => `${r.pron}→${r.target} [${r.verdict}] ${r.comment || ""}`.slice(0, 80)).join("\n        "));
console.log("R 分数:", r2.R?.score);