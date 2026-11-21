/**
 * structure.js —— 用 LLM 做「成分树 + 中文」，并把它对齐回 token 下标。
 *
 * 为什么不让模型直接输出下标：数下标它必错。改成让它输出**原文词串** text，
 * 由代码按顺序消费 token 去对齐——这是后端 papers.py 验证过的做法，
 * 顺带解决了「同句里出现两个 is」时的错位问题。
 *
 * 一切以「能对上多少 token」为准：覆盖不足就判定失败，调用方回退规则树。
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chatText, extractJson } from "./llm.js";

const CACHE_DIR = join(homedir(), ".dsh", "dsh-english-coach");
const CACHE_FILE = join(CACHE_DIR, "structure-cache.json");
const CACHE_MAX = 300;
const MIN_COVERAGE = 0.8;

/** 与后端一致的切词：按空格切，标点跟着词走 */
export function tokenize(sentence) {
  return String(sentence ?? "").trim().split(/\s+/).filter(Boolean);
}

/** 比对用规范形式：去首尾标点 + 小写（模型常吃掉段末标点） */
const cmp = (tok) => String(tok).replace(/^[.,;:!?"'()\[\]—–-]+|[.,;:!?"'()\[\]—–-]+$/g, "").toLowerCase();

const ROLES = new Set([
  "主语", "谓语", "宾语", "表语", "定语", "状语", "补语", "连词", "中心词",
  "主语从句", "宾语从句", "定语从句", "状语从句", "表语从句", "同位语从句", "插入语", "其他"
]);

const SYSTEM_PROMPT = [
  "你是英语句子成分分析器。只输出严格 JSON，不要 markdown 代码块，不要解释。",
  '格式：{"translation":"整句中文","parts":[{"text":"The proposal","role":"主语","zh":"那份提案","children":[]}]}',
  "硬性规则：",
  "1. parts 按原句顺序排列；每段的 text 必须是原句中**逐词照抄的连续词串**，不许改写、不许漏词、不许加词。",
  "2. 所有 text 依次拼接（空格连接）必须等于整句——所以一定要把每个词都分进某一段。",
  "3. role 只能取：主语/谓语/宾语/表语/定语/状语/补语/连词/中心词/主语从句/宾语从句/定语从句/状语从句/表语从句/同位语从句/插入语。",
  "4. zh 只翻译这一段本身，不要复述整句。",
  "5. 从句单独成段（role 用「定语从句」等），它的内部结构放进 children；children 同样用 text+role+zh，其 text 也要能在该段内逐词对上。",
  "",
  '示例：句子 "The man who called me is a doctor."',
  '{"translation":"给我打电话的那个人是医生。","parts":[{"text":"The man","role":"主语","zh":"那个人","children":[{"text":"The","role":"定语","zh":"这个","children":[]},{"text":"man","role":"中心词","zh":"人","children":[]}]},{"text":"who called me","role":"定语从句","zh":"给我打过电话的","children":[{"text":"who","role":"主语","zh":"他","children":[]},{"text":"called me","role":"谓语","zh":"打给我","children":[]}]},{"text":"is","role":"谓语","zh":"是","children":[]},{"text":"a doctor.","role":"表语","zh":"一名医生","children":[]}]}'
].join("\n");

/** 把模型给的 parts 对齐到 token 下标（顺序消费，同词不串位） */
function alignParts(tokens, parts, offset = 0) {
  const norm = tokens.map(cmp);
  const out = [];
  let i = 0;
  for (const part of parts) {
    const want = String(part?.text ?? "").split(/\s+/).filter(Boolean).map(cmp).filter(Boolean);
    if (!want.length) continue;
    let found = -1;
    for (let j = i; j <= tokens.length - want.length; j += 1) {
      let same = true;
      for (let k = 0; k < want.length; k += 1) {
        if (norm[j + k] !== want[k]) { same = false; break; }
      }
      if (same) { found = j; break; }
    }
    if (found < 0) continue; // 对不上就跳过，但游标不回退
    const start = found;
    const end = found + want.length;
    i = end;
    const kids = Array.isArray(part.children) ? part.children : [];
    out.push({
      start: offset + start,
      end: offset + end,
      text: tokens.slice(start, end).join(" "),
      role: ROLES.has(part.role) ? part.role : (part.role || "其他"),
      note: typeof part.note === "string" ? part.note : "",
      zh: typeof part.zh === "string" ? part.zh : "",
      children: kids.length ? alignParts(tokens.slice(start, end), kids, offset + start) : []
    });
  }
  return out;
}

function flatten(spans) {
  const out = [];
  for (const s of spans) {
    out.push(s);
    if (s.children?.length) out.push(...flatten(s.children));
  }
  return out;
}

function coverageOf(spans, tokenCount) {
  const covered = new Set();
  flatten(spans).forEach((s) => {
    for (let i = s.start; i < s.end; i += 1) covered.add(i);
  });
  return { covered: covered.size, total: tokenCount, ratio: tokenCount ? covered.size / tokenCount : 0 };
}

/* ── 缓存 ───────────────────────────────────────────────────────── */
let cacheLoaded = null;

async function loadCache() {
  if (cacheLoaded) return cacheLoaded;
  try {
    cacheLoaded = JSON.parse(await readFile(CACHE_FILE, "utf8"));
    if (!cacheLoaded || typeof cacheLoaded !== "object") cacheLoaded = {};
  } catch {
    cacheLoaded = {};
  }
  return cacheLoaded;
}

async function saveCache(cache) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => (cache[a].ts ?? 0) - (cache[b].ts ?? 0));
      keys.slice(0, keys.length - CACHE_MAX).forEach((k) => delete cache[k]);
    }
    const tmp = `${CACHE_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(cache), "utf8");
    await rename(tmp, CACHE_FILE);
  } catch { /* 缓存写不进去不影响主流程 */ }
}

const keyOf = (sentence) => createHash("sha1").update(sentence).digest("hex").slice(0, 16);

/**
 * 分析一句：返回 { tokens, translation, parts, coverage, source, ms, model, cached }
 * 失败抛 Error（带 code），调用方据此回退。
 */
export async function buildStructure(sentence, { config, force = false } = {}) {
  const src = String(sentence ?? "").trim();
  const tokens = tokenize(src);
  if (!tokens.length) throw Object.assign(new Error("句子为空"), { code: "empty" });

  const key = keyOf(src);
  const cache = await loadCache();
  if (!force && cache[key]) {
    const hit = cache[key];
    return { ...hit, source: "llm", cached: true, ms: 0 };
  }

  const user = `逐词清单（共 ${tokens.length} 个 token）：${JSON.stringify(tokens)}\n\n原句：${src}`;
  const { content, ms, model } = await chatText({ config, system: SYSTEM_PROMPT, user });

  let parsed;
  try {
    parsed = extractJson(content);
  } catch (err) {
    throw Object.assign(new Error(`模型输出不是 JSON：${String(content).slice(0, 120)}`), { code: "bad-json" });
  }

  const rawParts = Array.isArray(parsed?.parts) ? parsed.parts : [];
  if (!rawParts.length) throw Object.assign(new Error("模型没有给出 parts"), { code: "no-parts" });

  const parts = alignParts(tokens, rawParts);
  const cov = coverageOf(parts, tokens.length);
  if (parts.length === 0) throw Object.assign(new Error("成分片段一个都没对上原文"), { code: "align-failed" });
  if (cov.ratio < MIN_COVERAGE) {
    throw Object.assign(
      new Error(`成分覆盖不足：只对上 ${cov.covered}/${cov.total} 个词，换一句或重试`),
      { code: "low-coverage", coverage: cov }
    );
  }

  const record = {
    sentence: src,
    tokens,
    translation: typeof parsed.translation === "string" ? parsed.translation : "",
    parts,
    coverage: cov,
    ms,
    model,
    ts: Date.now()
  };
  cache[key] = record;
  await saveCache(cache);
  return { ...record, source: "llm", cached: false };
}

/** 只查缓存，不打模型：面板切句时用，命中就自动载入 */
export async function peekCache(sentence) {
  const src = String(sentence ?? "").trim();
  if (!src) return null;
  const cache = await loadCache();
  return cache[keyOf(src)] ?? null;
}

/** 批量查缓存：文章列表用它标出「哪些句子已经分析过」 */
export async function peekCacheBatch(sentences) {
  const cache = await loadCache();
  const out = [];
  for (const raw of sentences ?? []) {
    const src = String(raw ?? "").trim();
    if (!src) continue;
    if (cache[keyOf(src)]) out.push(src);
  }
  return out;
}

/** 供面板展示：扁平化 + 每段带 token 文本 */
export function outline(structure) {
  return flatten(structure.parts).map((s) => ({
    start: s.start, end: s.end, text: s.text, role: s.role, note: s.note, zh: s.zh,
    depth: 0
  }));
}