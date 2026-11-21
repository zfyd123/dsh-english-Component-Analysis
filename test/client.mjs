/**
 * client.mjs —— 不启动浏览器验证面板：
 *   1) 能被 __ModuleLoader__ 加载，注册 sidebar.panellist + main 且 id/key 一致
 *   2) 用真实数据渲染四种步骤状态不抛错
 *   3) 关键交互文案在位（成分树 / 标注 / 批改 / 归因）
 */

import { makeRoutes } from "../lib/api.js";
import { buildStructure } from "../lib/structure.js";

/* ── 极简 React 替身 ───────────────────────────────────────────── */
function makeReact(stateSeed) {
  let cursor = 0;
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
    },
    useState(init) {
      const seeded = stateSeed ? stateSeed[cursor] : undefined;
      cursor += 1;
      return [seeded !== undefined ? seeded : init, () => {}];
    },
    useEffect() {},
    useCallback(fn) { return fn; },
    useRef(v) { return { current: v }; },
    useRef(v) { return { current: v }; },
    Component: class { constructor(props) { this.props = props || {}; this.state = {}; } setState(s) { Object.assign(this.state, s); } },
    __reset() { cursor = 0; }
  };
}

let captured = null;
const win = { __ModuleLoader__: { load({ id, factory }) { captured = { id, factory }; } }, addEventListener() {}, removeEventListener() {} };
const source = await (await import("node:fs/promises")).readFile(new URL("../client.js", import.meta.url), "utf8");
new Function("window", source)(win);

console.log("moduleId:", captured.id, "| 与包名一致:", captured.id === "dsh-english-coach");
const mod = captured.factory((n) => { if (n === "react") return makeReact(null); throw new Error("unexpected require: " + n); });
console.log("exports:", Object.keys(mod).join(", "), "| inject:", JSON.stringify(mod.inject));

const registered = [];
mod.apply({
  get: () => undefined,
  slots: { inject: (k, cb) => { cb(); return () => {}; }, register: (o, c) => { registered.push({ o, c }); return () => {}; } }
});
console.log("slots:", registered.map((r) => `${r.o.name}(${r.o.id || r.o.key})`).join(" + "));
const icon = registered.find((r) => r.o.name === "sidebar.panellist");
const page = registered.find((r) => r.o.name === "main");
console.log("label:", icon.o.label(), "| id === key:", icon.o.id === page.o.key);

function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return out; }
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (typeof node.type === "function") {
    const isClass = node.type.prototype && typeof node.type.prototype.render === "function";
    if (isClass) {
      const props = { ...node.props, ...(node.children.length === 1 ? { children: node.children[0] } : node.children.length ? { children: node.children } : {}) };
      const inst = new node.type(props);
      inst.props = props;
      if (typeof node.type.getDerivedStateFromError === "function") inst.state = { error: null };
      flatten(inst.render(), out);
      return out;
    }
    flatten(node.type({ ...node.props, ...(node.children.length ? { children: node.children } : {}) }), out);
    return out;
  }
  node.children.forEach((c) => flatten(c, out));
  return out;
}

/* ── 真实数据 ─────────────────────────────────────────────────── */
const routes = makeRoutes({});
const byPath = Object.fromEntries(routes.map((r) => [r.path, r]));
function callApi(path, payload) {
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

const SENTENCE = "The proposal that the committee put forward at the meeting was rejected by the board.";
let structure;
try {
  const st = await buildStructure(SENTENCE, {});
  structure = { ok: true, sentence: st.sentence, tokens: st.tokens, translation: st.translation, parts: st.parts, coverage: st.coverage, cached: st.cached, ms: st.ms, model: st.model };
  console.log(`\nstructure: 覆盖 ${st.coverage.covered}/${st.coverage.total}，parts=${st.parts.length}，cached=${st.cached}`);
} catch (err) {
  console.log("\nstructure 生成失败（可能需要联网/额度）:", err.message);
}

const userSpans = [
  { id: 1, start: 0, end: 2, role: "主语" },
  { id: 2, start: 10, end: 12, role: "谓语" },
  { id: 3, start: 12, end: 15, role: null }
];
const graded = structure ? await callApi("/api/dsh-en-coach/annotate", { sentence: SENTENCE, spans: userSpans }) : null;
if (graded) console.log(`annotate: 总分 ${graded.overall}，层 ${JSON.stringify(graded.layers)}`);

const profile = await callApi("/api/dsh-en-coach/profile");
const papers = await callApi("/api/dsh-en-coach/papers");
const paper = papers.papers?.length ? await callApi("/api/dsh-en-coach/paper?name=" + encodeURIComponent(papers.papers[0].name)) : { sentences: [] };

/* ── 渲染 ─────────────────────────────────────────────────────── */
function renderPage(seed, label) {
  const R = makeReact(seed);
  let cap = null;
  const w = { __ModuleLoader__: { load(o) { cap = o; } }, addEventListener() {}, removeEventListener() {} };
  new Function("window", source)(w);
  const m = cap.factory((n) => (n === "react" ? R : null));
  const list = [];
  m.apply({ get: () => undefined, slots: { inject: (k, cb) => cb(), register: (o, c) => { list.push({ o, c }); return () => {}; } } });
  const comp = list.find((x) => x.o.name === "main").c;
  R.__reset();
  try {
    const tree = comp({});
    // 交互句柄是否真的挂到了容器上
    const findContainer = (node, acc = []) => {
      if (!node || typeof node !== "object") return acc;
      if (Array.isArray(node)) { node.forEach((x) => findContainer(x, acc)); return acc; }
      if (typeof node.type === "function") {
        // 函数组件要先展开才能看到它返回的 DOM 节点
        try {
          return findContainer(node.type({ ...node.props, ...(node.children.length === 1 ? { children: node.children[0] } : node.children.length ? { children: node.children } : {}) }), acc);
        } catch { return acc; }
      }
      if (node.props && (node.props.onMouseUp || node.props.onMouseMove)) acc.push(node.props);
      (node.children || []).forEach((x) => findContainer(x, acc));
      return acc;
    };
    const handles = findContainer(tree);
    if (label.includes("标注")) {
      console.log("    交互容器:", handles.length, "个；带 onMouseUp:", handles.filter((h) => h.onMouseUp).length,
        "；带 onMouseMove:", handles.filter((h) => h.onMouseMove).length);
    }
    const flat = flatten(tree).join(" ");
    console.log(`  [${label}] ✓ ${flat.length} 字`);
    return flat;
  } catch (err) {
    console.log(`  [${label}] ✗ ${err.message}`);
    return "";
  }
}

// useState 顺序：sentence, structure, structureError, loading, ruleHints, picked, spans,
//   selection, graded, grading, showAnswer, step, profile, source, papers, paperName,
//   paperSentences, paperIndex, llmReady, error
const empty = renderPage(null, "空状态");
const structFlat = renderPage(
  [SENTENCE, structure, "", false, null, null, null, [], [], null, [], null, [], "", "", null, null, false, false, "structure", null, "manual", [], "", [], [], 0, { ready: true }, ""],
  "结构页"
);
const annotateFlat = renderPage(
  [SENTENCE, structure, "", false, null, null, null, userSpans, [{ pron: { start: 0, end: 1 }, target: { start: 1, end: 2 } }], null, [], null, [{ start: 2, end: 3, guess: "x" }], "", "the proposal", null, null, false, false, "annotate", null, "manual", [], "", [], [], 0, { ready: true }, ""],
  "标注页"
);
const verdictFlat = renderPage(
  [SENTENCE, structure, "", false, null, null, null, userSpans, [], null, [], null, [], "", "", null, graded, false, true, "verdict", null, "manual", [], "", [], [], 0, { ready: true }, ""],
  "结果页"
);
const paperFlat = renderPage(
  ["", null, "", false, null, null, null, [], [], null, [], null, [], "", "", null, null, false, false, "structure", null, "paper", papers.papers || [], papers.papers?.[0]?.name ?? "", paper.sentences || [], [], 0, { ready: true }, ""],
  "文章列表"
);

const checks = [
  ["结构页渲染成分树", structFlat.includes("成分树") && structFlat.includes("主语")],
  ["结构页显示整句译文", !structure || structFlat.includes("整句译文")],
  ["标注页出现成分标签", annotateFlat.includes("定语从句") && annotateFlat.includes("补语")],
  ["标注页出现五个分区", annotateFlat.includes("成分") && annotateFlat.includes("指代") && annotateFlat.includes("生词") && annotateFlat.includes("翻译")],
  ["结果页显示总分与五层", verdictFlat.includes("总分") || !graded],
  ["结果页列出五层状态", !graded || (verdictFlat.includes("句法层") && verdictFlat.includes("表达层"))],
  ["结构页有层级编号", /#1\b/.test(structFlat)],
  ["结构页标出从句边界括号", structFlat.includes("[") && structFlat.includes("]")],
  ["结构页标出修饰关系", structFlat.includes("修饰")],
  ["文章列表可点句", paperFlat.includes("点任意一句直接分析") || !paper.sentences.length],
  ["空状态有引导", empty.includes("分析结构")]
];
console.log("\n断言：");
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);