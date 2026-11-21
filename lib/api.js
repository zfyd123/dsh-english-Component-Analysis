/**
 * api.js —— 诊断台的 Host 侧服务层。
 *
 * 客户端（浏览器里的 React 面板）不重复实现任何语法逻辑：解析、出题、判分
 * 全部走这里，本文件只是把已有引擎函数包成 HTTP 接口 + 会话暂存。
 * 工具 en_sentence 与面板共用同一批函数，两边口径不会分叉。
 */

import { readFile, writeFile, mkdir, rename, appendFile, readFile as readTextFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { parseSentence } from "./parse.js";
import { toViewModel } from "./annotate.js";
import { appendRecord, buildProfile, loadRecords, renderProfile } from "./store.js";
import { listPapers, paperSentences } from "./corpus.js";
import { buildStructure, tokenize, peekCache, peekCacheBatch } from "./structure.js";
import { gradeSpans } from "./grade-spans.js";
import { gradeReference, gradeLogic, gradeVocab, gradeTranslation, summarize } from "./grade-tasks.js";
import { llmStatus } from "./llm.js";

export function analyzeSentence(sentence) {
  const src = String(sentence ?? "").trim();
  if (!src) return null;
  const view = toViewModel(src);
  const p = parseSentence(src);
  return {
    sentence: p.sentence,
    view,
    stats: p.stats,
    chunks: p.chunks,
    hints: p.hints,
    references: p.references,
    nonfinite: p.nonfinite,
    rewritePlan: p.rewritePlan
  };
}

export async function getProfile() {
  const records = await loadRecords();
  const profile = buildProfile(records);
  return { profile, text: renderProfile(profile), records: records.slice(-40) };
}

/* ── HTTP 层 ─────────────────────────────────────────────────────────── */

function writeJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(body);
  } catch (err) {
    try { res.statusCode = 500; res.end("internal error"); } catch { /* 连接已断 */ }
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 256) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/** 只接受本机回环请求：面板与 Host 同源，不需要对外开放 */
function isLoopback(req) {
  const addr = req?.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function query(req) {
  const url = String(req.url || "");
  const i = url.indexOf("?");
  return new URLSearchParams(i >= 0 ? url.slice(i + 1) : "");
}

function guard(req, res, method) {
  if (!isLoopback(req)) { writeJson(res, 403, { ok: false, error: "loopback only" }); return false; }
  const m = req.method ?? "GET";
  if (method && m !== method) { writeJson(res, 405, { ok: false, error: `method not allowed: ${m}` }); return false; }
  return true;
}

/**
 * 注册到 Host webServer 的路由表。
 * 每条 handler 都是薄壳：校验 → 调服务函数 → 写 JSON，业务逻辑全在上半部分。
 */
const TRACE_FILE = join(homedir(), ".dsh", "dsh-english-coach", "trace.log");
const TRACE_MAX_LINES = 400;

/**
 * 把面板里的调试打点写进本地文件——浏览器控制台我读不到，
 * 但落成文件就能读。只保留最近 400 行，避免无限增长。
 */
async function appendTrace(entry) {
  const line = `${new Date().toISOString()} ${JSON.stringify(entry)}`;
  try {
    await mkdir(dirname(TRACE_FILE), { recursive: true });
    await appendFile(TRACE_FILE, line + "\n", "utf8");
    const text = await readTextFile(TRACE_FILE, "utf8").catch(() => "");
    const lines = text.split("\n").filter(Boolean);
    if (lines.length > TRACE_MAX_LINES) {
      await writeFile(TRACE_FILE, lines.slice(-TRACE_MAX_LINES).join("\n") + "\n", "utf8");
    }
  } catch { /* 日志写不进去不影响主流程 */ }
}

/**
 * 本句「有什么可标」：代词、否定词、从句引导词。
 * 面板据此告诉用户「本句有 its，可以标指代」或「本句没有代词，跳过」——
 * 不该让人自己在一句里翻找。
 */
function buildProbes(parsed) {
  const toks = (parsed?.tokens ?? []).map((t) => String(t?.text ?? t ?? "").toLowerCase().replace(/[.,;:!?"'()]/g, ""));

  /**
   * 形式主语 / 形式宾语的 it 不构成「指代」，列出来只会误导：
   *   It is clear that ...      → 形式主语
   *   I find it hard to ...     → 形式宾语
   */
  const isDummyIt = (idx) => {
    if (toks[idx] !== "it") return false;
    const next = toks[idx + 1] ?? "";
    const next2 = toks[idx + 2] ?? "";
    if (["is", "was"].includes(next) && ["that", "clear", "important", "possible", "necessary", "obvious", "likely", "true", "hard", "easy", "difficult", "said", "believed"].includes(next2)) return true;
    const prev = toks[idx - 1] ?? "";
    if (["think", "thought", "find", "found", "make", "made", "consider", "considered", "regard", "regarded"].includes(prev)) return true;
    return false;
  };

  const pronouns = [];
  const seen = new Set();
  for (const r of parsed?.references ?? []) {
    const w = String(r.word ?? "").toLowerCase();
    if (!w || seen.has(w + ":" + r.idx)) continue;
    if (isDummyIt(r.idx)) continue;
    seen.add(w + ":" + r.idx);
    pronouns.push({ word: r.word, idx: r.idx });
  }
  const negators = [...new Set((parsed?.hints?.negations ?? []).map(String))];
  const markers = [...new Set((parsed?.clauses ?? []).map((c) => c.marker).filter(Boolean))];
  return { pronouns, negators, markers };
}

export function makeRoutes(config = {}) {
  const corpusDir = config?.corpusDir ?? null;
  return [
    {
      kind: "exact",
      path: "/api/dsh-en-coach/structure",
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readBody(req);
        if (!body || typeof body !== "object") return writeJson(res, 400, { ok: false, error: "invalid JSON body" });
        try {
          if (body.cacheOnly === true) {
            const hit = await peekCache(body.sentence);
            if (!hit) return writeJson(res, 200, { ok: true, cacheHit: false });
            // 风险提示不进缓存：它是规则引擎现算的（1ms、确定性），
            // 存下来反而会在规则更新后变成陈旧数据
            const quick = parseSentence(hit.sentence ?? body.sentence);
          const probes = buildProbes(quick);
            return writeJson(res, 200, {
              ok: true, cacheHit: true,
              sentence: hit.sentence, tokens: hit.tokens, translation: hit.translation,
              parts: hit.parts, coverage: hit.coverage, cached: true, ms: 0, model: hit.model,
              hints: quick.hints, chunks: quick.chunks, stats: quick.stats, probes
            });
          }
          const data = await buildStructure(body.sentence, { config, force: body.force === true });
          const quick = parseSentence(data.sentence ?? body.sentence);
          const probes = buildProbes(quick);
          return writeJson(res, 200, {
            ok: true,
            sentence: data.sentence,
            tokens: data.tokens,
            translation: data.translation,
            parts: data.parts,
            coverage: data.coverage,
            cached: data.cached,
            ms: data.ms,
            model: data.model,
            hints: quick.hints,
            chunks: quick.chunks,
            stats: quick.stats,
            probes
          });
        } catch (err) {
          return writeJson(res, 200, {
            ok: false,
            code: err?.code ?? "unknown",
            error: String(err?.message ?? err).slice(0, 300)
          });
        }
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-en-coach/structure/cached",
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readBody(req);
        const sentences = Array.isArray(body?.sentences) ? body.sentences : [];
        try {
          const analyzed = await peekCacheBatch(sentences);
          return writeJson(res, 200, { ok: true, analyzed });
        } catch (err) {
          return writeJson(res, 200, { ok: true, analyzed: [], error: String(err).slice(0, 160) });
        }
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-en-coach/annotate",
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readBody(req);
        if (!body || typeof body !== "object") return writeJson(res, 400, { ok: false, error: "invalid JSON body" });
        try {
          const sentence = String(body.sentence ?? "").trim();
          if (!sentence) return writeJson(res, 400, { ok: false, error: "empty sentence" });

          const spans = Array.isArray(body.spans) ? body.spans : [];
          const refs = Array.isArray(body.refs) ? body.refs : [];
          const logic = Array.isArray(body.logic) ? body.logic : [];
          const words = Array.isArray(body.words) ? body.words : [];
          const translation = typeof body.translation === "string" ? body.translation : "";

          if (!spans.length && !refs.length && !logic.length && !words.length && !translation.trim()) {
            return writeJson(res, 400, { ok: false, error: "没有任何作业" });
          }

          // 标准答案与词表：结构走缓存/LLM，提示块走规则引擎（毫秒级）
          const structure = await buildStructure(sentence, { config });
          const tokens = structure.tokens ?? tokenize(sentence);
          const parsed = parseSentence(structure.sentence ?? sentence);

          const clamp = (s) => ({
            start: Math.max(0, Math.min(tokens.length, Number(s?.start) || 0)),
            end: Math.max(0, Math.min(tokens.length, Number(s?.end) || 0))
          });
          const userSpans = spans.map((s) => ({ ...clamp(s), role: String(s.role ?? "") }))
            .filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);

          const S = userSpans.length
            ? gradeSpans(tokens, userSpans, structure.parts)
            : { results: [], missed: [], score: null, coverage: 0, precision: 0, tokenCoverage: 0, diagnosis: null };

          const R = gradeReference(tokens, refs.map((p) => ({
            pron: p?.pron ? clamp(p.pron) : null,
            target: p?.target ? clamp(p.target) : null
          })), structure.parts);

          const L = gradeLogic(tokens, logic.map((p) => ({
            trigger: p?.trigger ? clamp(p.trigger) : null,
            scope: p?.scope ? clamp(p.scope) : null
          })), structure.parts);

          const V = gradeVocab(tokens, words.map((w) => ({ ...clamp(w), guess: String(w?.guess ?? "") })), parsed.hints);
          const E = gradeTranslation(tokens, translation, structure.parts, parsed.hints);

          const summary = summarize({ S, R, L, V, E });
          const scores = [S.score, R.score, L.score, V.score, E.score].filter((x) => typeof x === "number");
          const overall = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

          return writeJson(res, 200, {
            ok: true,
            sentence: structure.sentence,
            tokens,
            translation: structure.translation,
            answer: structure.parts,
            S, R, L, V, E,
            layers: summary.layers,
            primary: summary.primary,
            wrongLayers: summary.wrongLayers,
            overall
          });
        } catch (err) {
          return writeJson(res, 200, {
            ok: false,
            code: err?.code ?? "unknown",
            error: String(err?.message ?? err).slice(0, 300)
          });
        }
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-en-coach/record",
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readBody(req);
        if (!body || typeof body !== "object") return writeJson(res, 400, { ok: false, error: "invalid JSON body" });
        try {
          const sentence = String(body.sentence ?? "").trim();
          if (!sentence) return writeJson(res, 400, { ok: false, error: "empty sentence" });
          // 五层各自的状态由批改结果给出；只有测到的层才进画像
          const layers = body.layers && typeof body.layers === "object" ? body.layers : {};
          const wrongLayers = Array.isArray(body.wrongLayers) ? body.wrongLayers : [];
          const primary = typeof body.primary === "string" ? body.primary : null;
          await appendRecord({
            kind: "annotate",
            sentence,
            layers,
            primary: primary ?? undefined,
            wrongLayers,
            ...(body.scores && typeof body.scores === "object" ? { scores: body.scores } : {})
          });
          const records = await loadRecords();
          return writeJson(res, 200, { ok: true, totalRecords: records.length });
        } catch (err) {
          return writeJson(res, 500, { ok: false, error: String(err).slice(0, 200) });
        }
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-en-coach/trace",
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readBody(req);
        if (!body || typeof body !== "object") return writeJson(res, 400, { ok: false, error: "invalid JSON body" });
        try {
          await appendTrace({
            event: String(body.event ?? ""),
            data: body.data ?? null,
            at: Date.now()
          });
          return writeJson(res, 200, { ok: true });
        } catch (err) {
          return writeJson(res, 500, { ok: false, error: String(err).slice(0, 160) });
        }
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-en-coach/status",
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        try {
          const status = await llmStatus(config);
          return writeJson(res, 200, { ok: true, llm: status });
        } catch (err) {
          return writeJson(res, 200, { ok: true, llm: { ready: false, reason: String(err?.message ?? err) } });
        }
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-en-coach/analyze",
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readBody(req);
        if (!body || typeof body !== "object") return writeJson(res, 400, { ok: false, error: "invalid JSON body" });
        try {
          const data = analyzeSentence(body.sentence);
          if (!data) return writeJson(res, 400, { ok: false, error: "empty sentence" });
          return writeJson(res, 200, { ok: true, ...data });
        } catch (err) {
          return writeJson(res, 500, { ok: false, error: String(err).slice(0, 200) });
        }
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-en-coach/profile",
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        try {
          return writeJson(res, 200, { ok: true, ...(await getProfile()) });
        } catch (err) {
          return writeJson(res, 500, { ok: false, error: String(err).slice(0, 200) });
        }
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-en-coach/papers",
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        try {
          const papers = await listPapers(corpusDir);
          return writeJson(res, 200, { ok: true, papers });
        } catch (err) {
          return writeJson(res, 500, { ok: false, error: String(err).slice(0, 200) });
        }
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-en-coach/paper",
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        try {
          const q = query(req);
          const data = await paperSentences(corpusDir, q.get("name") ?? "");
          if (!data) return writeJson(res, 404, { ok: false, error: "paper not found" });
          return writeJson(res, 200, { ok: true, ...data });
        } catch (err) {
          return writeJson(res, 500, { ok: false, error: String(err).slice(0, 200) });
        }
      }
    }
  ];
}