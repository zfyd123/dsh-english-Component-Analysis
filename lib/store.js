/**
 * store.js —— 本地记录与分层画像。
 *
 * 只写本机，不外发。记录内容：句子、每层对错、主卡点。
 * 画像回答的是用户真正想问的那句话：「我到底是哪一层的人」。
 */

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { LAYER_LABEL } from "./lexicon-core.js";

const ROOT = join(homedir(), ".dsh", "dsh-english-coach");
const RECORDS = join(ROOT, "records.json");
const NOTES = join(ROOT, "notes.json");
const MAX_RECORDS = 800;

async function ensureDir() {
  await mkdir(ROOT, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const text = await readFile(file, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await ensureDir();
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file);
}

export async function loadRecords() {
  const data = await readJson(RECORDS, []);
  return Array.isArray(data) ? data : [];
}

export async function appendRecord(record) {
  const records = await loadRecords();
  const entry = {
    ts: new Date().toISOString(),
    // kind 决定这条记录进不进画像：只认「标注批改」，选择题那套已废弃
    kind: record.kind ?? "annotate",
    sentence: record.sentence,
    layers: record.layers,
    primary: record.primary ?? null,
    wrongLayers: record.wrongLayers ?? [],
    ...(record.scores ? { scores: record.scores } : {})
  };
  /* 明细（标注了什么、批改怎么说的）单独挂在 detail 上：
     只有新记录有，旧记录没有 —— 读取方一律按「可能没有 detail」处理。 */
  if (record.detail && typeof record.detail === "object") entry.detail = record.detail;
  records.push(entry);
  // 带明细后单条体积变大，上限相应收一点，避免文件无限膨胀
  const trimmed = records.slice(-MAX_RECORDS);
  await writeJson(RECORDS, trimmed);
  return { total: trimmed.length, ts: entry.ts };
}

/** 某一句的全部批改记录（含明细），按时间升序 */
export async function loadAttempts(sentence) {
  const s = String(sentence ?? "").trim();
  const records = await loadRecords();
  return records
    .filter((r) => String(r.sentence ?? "").trim() === s)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

export async function loadNotes() {
  const data = await readJson(NOTES, []);
  return Array.isArray(data) ? data : [];
}

export async function addNote(entry) {
  const notes = await loadNotes();
  const key = `${entry.type}|${String(entry.head).toLowerCase()}`;
  const exist = notes.find((n) => `${n.type}|${String(n.head).toLowerCase()}` === key);
  if (exist) {
    exist.count = (exist.count ?? 1) + 1;
    exist.lastSeen = new Date().toISOString();
    exist.meaning = entry.meaning ?? exist.meaning;
  } else {
    notes.push({
      type: entry.type,
      head: entry.head,
      meaning: entry.meaning ?? "",
      sentence: entry.sentence ?? "",
      count: 1,
      lastSeen: new Date().toISOString()
    });
  }
  await writeJson(NOTES, notes.slice(-500));
  return notes.length;
}

/** 分层画像 —— 只统计「标注批改」的记录；早期选择题记录一律不计入 */
export function buildProfile(allRecords) {
  const records = (allRecords ?? []).filter((r) => (r.kind ?? "quiz") === "annotate");
  const total = records.length;
  const stat = {};
  for (const layer of Object.keys(LAYER_LABEL)) {
    stat[layer] = { hit: 0, miss: 0, skip: 0, review: 0 };
  }
  const primaryCount = {};
  for (const r of records) {
    for (const [layer, status] of Object.entries(r.layers ?? {})) {
      if (!stat[layer]) continue;
      if (stat[layer][status] !== undefined) stat[layer][status] += 1;
    }
    if (r.primary) primaryCount[r.primary] = (primaryCount[r.primary] ?? 0) + 1;
  }
  const rows = Object.entries(stat).map(([layer, s]) => {
    const answered = s.hit + s.miss;
    return {
      layer,
      label: LAYER_LABEL[layer],
      hit: s.hit,
      miss: s.miss,
      answered,
      accuracy: answered ? Math.round((s.hit / answered) * 100) : null
    };
  });
  const ranked = rows.filter((r) => r.answered > 0).sort((a, b) => a.accuracy - b.accuracy);
  const dominant = Object.entries(primaryCount).sort((a, b) => b[1] - a[1])[0] ?? null;

  // 趋势：最近 10 次的主卡点分布
  const recent = records.slice(-10).map((r) => r.primary);
  return { total, rows, ranked, dominant, primaryCount, recent };
}

export function renderProfile(profile) {
  if (!profile.total) {
    return "还没有记录。先用 en_sentence 做一次「解析 + 出题 + 判分」，记录会自动累计，做满 5 句就能看出倾向。";
  }
  const lines = [`【已诊断 ${profile.total} 句】`, "", "各层正确率："];
  profile.rows.forEach((r) => {
    if (r.answered === 0) {
      lines.push(`  ${r.label.padEnd(4)} 未测到`);
      return;
    }
    const bar = "█".repeat(Math.round(r.accuracy / 10)) + "░".repeat(10 - Math.round(r.accuracy / 10));
    lines.push(`  ${r.label.padEnd(4)} ${bar} ${String(r.accuracy).padStart(3)}%  (${r.hit}/${r.answered})`);
  });
  lines.push("");
  if (profile.dominant) {
    lines.push(`【你最常卡在】${LAYER_LABEL[profile.dominant[0]]}  ——  占 ${Math.round((profile.dominant[1] / profile.total) * 100)}% 的诊断`);
  }
  if (profile.ranked.length >= 2) {
    const weakest = profile.ranked[0];
    const strongest = profile.ranked[profile.ranked.length - 1];
    lines.push(`【最弱】${weakest.label}（${weakest.accuracy}%）  【最强】${strongest.label}（${strongest.accuracy}%）`);
  }
  lines.push("");
  lines.push(`【最近 10 次】${profile.recent.map((p) => (p ? LAYER_LABEL[p] : "全对")).join(" → ")}`);
  const advice = adviceFor(profile);
  if (advice.length) {
    lines.push("");
    lines.push("【接下来练这个】");
    advice.forEach((a) => lines.push(`  - ${a}`));
  }
  return lines.join("\n");
}

function adviceFor(profile) {
  const weak = profile.ranked.filter((r) => r.accuracy !== null && r.accuracy < 70);
  const out = [];
  for (const r of weak.slice(0, 2)) {
    if (r.layer === "V") out.push("词汇层最弱：标注时把「不确定的词」点出来并写下你猜的意思——猜错才知道是义项选错");
    if (r.layer === "S") out.push("句法层最弱：每句先只标主谓宾，稳住主干再往从句里拆");
    if (r.layer === "R") out.push("指代层最弱：每个 it/this 都圈出它指的那一段，圈不出就是没读懂");
    if (r.layer === "L") out.push("逻辑层最弱：否定从否定词划到分句结束，从句从引导词划到它自己结束");
    if (r.layer === "E") out.push("表达层最弱：译完逐块打勾，别整句凭感觉写");
  }
  if (!out.length) out.push("各层都在 70% 以上：把句子加长（40 词以上）继续测，或开始练限时阅读");
  return out;
}