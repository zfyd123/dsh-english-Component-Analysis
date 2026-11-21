import { apply } from "../lib/index.js";
import { parseSentence } from "../lib/parse.js";

const tools = {};
let promptText = null;
apply({
  tools: { register: (def) => { tools[def.name] = def; } },
  inject: () => {},
  systemPrompt: { section: (s) => { promptText = s.text(); } }
});

console.log("tools:", Object.keys(tools).join(", "));
console.log("prompt injected:", promptText ? "yes (" + promptText.length + " chars)" : "no");

const SENTENCE = "The very fact that so many of the assumptions on which the argument rests have never been tested is what makes the conclusion, however elegantly it is presented, so hard to accept.";

const analyze = await tools.en_sentence.execute({ action: "analyze", sentence: SENTENCE });
console.log("\n===== ANALYZE =====\n" + analyze);

const quiz = await tools.en_sentence.execute({ action: "quiz", sentence: SENTENCE });
console.log("\n===== QUIZ =====\n" + quiz);
const quizId = quiz.match(/quizId:\s*(\S+)/)?.[1];
console.log("\nquizId =", quizId);


// 模拟典型错法：句法对、词汇对、指代错、逻辑对 + 交了译文
const partial = qs.filter((q) => q.answer).map((q) => {
  if (q.layer === "R") {
    const bad = q.options.find((o) => !o.correct).key;
    return `${q.id}=${bad}`;
  }
  return `${q.id}=${q.answer}`;
}).join(" ");

const g = await tools.en_sentence.execute({ action: "grade", quizId, answers: partial, translation: "这个事实……（略）", save: true });
console.log("\n===== GRADE（指代答错）=====\n" + g);

const prof = await tools.en_profile.execute({ verbose: false });
console.log("\n===== PROFILE =====\n" + prof);

const explain = await tools.en_sentence.execute({ action: "explain", sentence: SENTENCE });
console.log("\n===== EXPLAIN =====\n" + explain);