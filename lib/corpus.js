/**
 * corpus.js —— 从 paper/ 目录的文章里抽句，给诊断台当句源。
 *
 * 口径与后端 backend/app/services/papers.py 保持一致：
 * 去掉 Markdown 标记 → 按句末标点断句 → 过滤 6~45 词的句子。
 * 不追求完全等价，只要求「同一篇文章里抽出来的句子看起来一致」。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 文章目录候选：插件通常放在 <repo>/plugins/<pkg>/lib，文章在同级 paper/ */
const CANDIDATES = [
  resolve(HERE, "../paper"),          // 插件自带的文章目录（推荐：跟着插件走，好管理）
  resolve(HERE, "../../../paper"),    // 与 plugins/ 同级的 paper/
  resolve(HERE, "../../paper"),
  resolve(process.cwd(), "paper")     // 兜底：当前工作目录下的 paper/
];

export function resolveCorpusDir(configured) {
  if (configured && existsSync(configured)) return configured;
  for (const dir of CANDIDATES) {
    try {
      if (existsSync(dir)) return dir;
    } catch { /* 忽略权限错误，继续找 */ }
  }
  return null;
}

const MD_STRIP = [
  [/```[\s\S]*?```/g, " "],
  [/`[^`]*`/g, " "],
  [/!\[[^\]]*\]\([^)]*\)/g, " "],
  [/\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/^\s{0,3}#{1,6}\s+.*$/gm, " "],
  [/^\s{0,3}>\s?/gm, ""],
  [/^\s{0,3}[-*+]\s+/gm, ""],
  [/\*\*|__|\*|_|~~/g, ""]
];

const ABBREV = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "vs", "etc", "eg", "ie",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "inc", "ltd", "co", "no", "vol", "fig", "approx", "dept", "est"
]);

export const MIN_WORDS = 6;
export const MAX_WORDS = 45;

function stripMarkdown(text) {
  let out = text;
  for (const [re, rep] of MD_STRIP) out = out.replace(re, rep);
  return out;
}

/** 断句：句末标点 + 后接空白大写/结束，遇缩写与小数不断 */
export function splitSentence(text) {
  const src = text.replace(/\s+/g, " ").trim();
  const out = [];
  let buf = "";
  for (let i = 0; i < src.length; i += 1) {
    buf += src[i];
    const ch = src[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const tail = buf.slice(0, -1);
    const lastWord = (tail.match(/([A-Za-z.]+)$/)?.[1] ?? "").toLowerCase().replace(/\.$/, "");
    if (ch === "." && ABBREV.has(lastWord)) continue;
    if (ch === "." && /\d$/.test(tail) && /^\d/.test(src.slice(i + 1))) continue;
    const next = src.slice(i + 1).match(/^\s*(\S)?/)?.[1] ?? "";
    if (next && !/[A-Z"'(\[]/.test(next)) continue;
    const sentence = buf.trim();
    if (sentence) out.push(sentence);
    buf = "";
  }
  const rest = buf.trim();
  if (rest) out.push(rest);
  return out;
}

const countWords = (s) => s.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;

/** 文章列表：文件名 + 句子数 */
export async function listPapers(dir) {
  const root = resolveCorpusDir(dir);
  if (!root) return [];
  const names = (await readdir(root)).filter((n) => n.toLowerCase().endsWith(".md")).sort();
  const out = [];
  for (const name of names) {
    try {
      const full = join(root, name);
      if (!(await stat(full)).isFile()) continue;
      const text = await readFile(full, "utf8");
      const sentences = extractSentences(text);
      out.push({ name, title: name.replace(/\.md$/i, ""), sentences: sentences.length });
    } catch { /* 单篇读不了就不列 */ }
  }
  return out;
}

/** 抽句：过滤长度，返回带序号的句子 */
export function extractSentences(markdown) {
  const plain = stripMarkdown(markdown);
  const list = [];
  for (const s of splitSentence(plain)) {
    const words = countWords(s);
    if (words < MIN_WORDS || words > MAX_WORDS) continue;
    list.push({ index: list.length, text: s, words });
  }
  return list;
}

/** 读某篇文章的句子 */
export async function paperSentences(dir, name) {
  const root = resolveCorpusDir(dir);
  if (!root) return null;
  const safe = String(name ?? "").replace(/[\\/]/g, "");
  if (!safe.toLowerCase().endsWith(".md")) return null;
  const full = join(root, safe);
  if (!existsSync(full)) return null;
  const text = await readFile(full, "utf8");
  return { name: safe, sentences: extractSentences(text) };
}