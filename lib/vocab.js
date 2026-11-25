/**
 * vocab.js —— 生词模式：按熟练度分级的词表。
 *
 * 词表本体（词 / 词频 / 释义）直接读 paper/resources/六级真题生词表.xlsx（只读，改了自动生效），
 * 读不出来时退回同目录的 .json 快照；
 * 进度（每个词当前在第几级）单独存在 ~/.dsh/dsh-english-coach/vocab.json，
 * 只存「词 → 等级」，没出现的词就是 0 级（生词）。不回写 xlsx / json。
 *
 * 规则：
 *   know   记住了 → 等级 +1（到 MAX_LEVEL 封顶）
 *   forget 没记住 → 直接回到 0 级重新记
 */

import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveCorpusDir } from "./corpus.js";
import { readXlsxRows } from "./xlsx-lite.js";

export const MAX_LEVEL = 3;

const ROOT = join(homedir(), ".dsh", "dsh-english-coach");
const PROGRESS = join(ROOT, "vocab.json");
const XLSX_NAME = "六级真题生词表.xlsx";
const JSON_NAME = "六级真题生词表.json";

/* 以 xlsx 为准：按修改时间缓存，文件一改下次读取就重新解析，不用重启。
   xlsx 读不出来（被锁、损坏、不在）时退回随包的 json 快照。 */
let seedCache = null; // { key, rows }

function fromRows(rows) {
  // 按表头找列：兼容你以后调整列顺序 / 增删备注列
  const header = rows[0] ?? [];
  const find = (...names) => header.findIndex((c) => names.includes(String(c).trim()));
  const iWord = find("词", "单词", "word");
  const iCount = find("次数", "词频", "count");
  const iMeaning = find("释义", "意思", "meaning");
  if (iWord < 0) throw new Error("生词表第一行里找不到「词」这一列");
  const seen = new Set();
  const out = [];
  for (const r of rows.slice(1)) {
    const word = String(r[iWord] ?? "").trim();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push({
      word,
      count: Number(r[iCount]) || 0,
      meaning: String(iMeaning >= 0 ? r[iMeaning] ?? "" : "").trim()
    });
  }
  return out;
}

async function loadSeed(corpusDir) {
  const dir = resolveCorpusDir(corpusDir);
  if (!dir) throw new Error("找不到 paper/ 目录，无法读取生词表");
  const xlsx = join(dir, "resources", XLSX_NAME);
  let key = "none";
  try { key = `x${(await stat(xlsx)).mtimeMs}`; } catch { /* xlsx 不存在，走 json */ }
  if (seedCache && seedCache.key === key) return seedCache.rows;

  let rows = null;
  if (key !== "none") {
    try { rows = fromRows(await readXlsxRows(xlsx)); } catch (err) { if (seedCache) return seedCache.rows; rows = null; }
  }
  if (!rows) {
    const list = JSON.parse(await readFile(join(dir, "resources", JSON_NAME), "utf8"));
    if (!Array.isArray(list)) throw new Error("生词表格式不对");
    rows = list.filter((r) => r && r.word)
      .map((r) => ({ word: String(r.word), count: Number(r.count) || 0, meaning: String(r.meaning ?? "") }));
    key = "json";
  }
  seedCache = { key, rows };
  return rows;
}

/** 本机日期 YYYY-MM-DD：「当天隐藏」按这个算，过了本机零点就自动重新出现 */
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** levels: 词→等级；misses: 词→没记住的次数；snoozed: 词→点「下次再记」的那天 */
async function loadProgress() {
  try {
    const data = JSON.parse(await readFile(PROGRESS, "utf8"));
    return { levels: obj(data.levels), misses: obj(data.misses), snoozed: obj(data.snoozed) };
  } catch {
    return { levels: {}, misses: {}, snoozed: {} };
  }
}

async function saveProgress(state) {
  await mkdir(ROOT, { recursive: true });
  const t = today();
  // 过了当天的推迟记录没用了，落盘时顺手清掉
  const snoozed = Object.fromEntries(Object.entries(state.snoozed).filter(([, d]) => d === t));
  const tmp = `${PROGRESS}.tmp`;
  await writeFile(tmp, JSON.stringify({
    levels: state.levels, misses: state.misses, snoozed, updated: new Date().toISOString()
  }), "utf8");
  await rename(tmp, PROGRESS);
}

export async function getVocab(corpusDir) {
  const [seed, st] = await Promise.all([loadSeed(corpusDir), loadProgress()]);
  const t = today();
  const words = seed.map((w) => ({
    ...w,
    level: Math.min(MAX_LEVEL, Math.max(0, Number(st.levels[w.word]) || 0)),
    misses: Math.max(0, Number(st.misses[w.word]) || 0),
    snoozed: st.snoozed[w.word] === t
  }));
  return { maxLevel: MAX_LEVEL, words };
}

/**
 * action:
 *   know   记住了：升一级（封顶），没记住的次数清零
 *   forget 没记住：退回 0 级重记，没记住的次数 +1
 *   later  拿不准：等级不变，今天不再出现，没记住的次数 +1
 * 返回该词的新状态；词不在表里返回 null。
 */
export async function moveWord(corpusDir, word, action) {
  const seed = await loadSeed(corpusDir);
  if (!seed.some((w) => w.word === word)) return null;
  const st = await loadProgress();
  const cur = Math.min(MAX_LEVEL, Math.max(0, Number(st.levels[word]) || 0));
  if (action === "know") {
    st.levels[word] = Math.min(MAX_LEVEL, cur + 1);
    delete st.misses[word];
    delete st.snoozed[word];
  } else if (action === "forget") {
    delete st.levels[word];
    st.misses[word] = (Number(st.misses[word]) || 0) + 1;
    delete st.snoozed[word];
  } else if (action === "later") {
    st.misses[word] = (Number(st.misses[word]) || 0) + 1;
    st.snoozed[word] = today();
  } else {
    return null;
  }
  await saveProgress(st);
  return {
    level: Number(st.levels[word]) || 0,
    misses: Number(st.misses[word]) || 0,
    snoozed: st.snoozed[word] === today()
  };
}
