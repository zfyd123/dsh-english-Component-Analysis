/**
 * annotate.js —— 把解析结果转成「可直接渲染」的 span 模型。
 *
 * parse.js 的输出是给人读的文字报告；可视化需要的是**字符级定位**：
 * 哪一段是主语、哪一段在从句里、从句挂在哪、为什么这么判。
 * 这一层只做映射，不做新的语法推断——所有判定仍然来自 parse.js。
 */

import { segment } from "./segment.js";
import { markVerbForms, findClauses, extractBackbone, attachClauses } from "./parse.js";

/** 成分角色（前端按这些 key 取色） */
export const ROLE = {
  SUBJECT: "subject",
  PREDICATE: "predicate",
  OBJECT: "object",
  ADJUNCT: "adjunct",
  LEADING: "leading",
  CLAUSE_MARKER: "clauseMarker",
  CLAUSE_BODY: "clauseBody",
  NONFINITE: "nonfinite",
  OTHER: "other"
};

const ROLE_LABEL = {
  subject: "主语",
  predicate: "谓语",
  object: "宾语 / 表语",
  adjunct: "状语",
  leading: "句首状语",
  clauseMarker: "从句引导词",
  clauseBody: "从句内部",
  nonfinite: "非谓语",
  other: "其他"
};

/** 为每个 token 找字符区间；找不到时退化到游标位置，保证渲染不丢字 */
function locate(sentence, tokens) {
  const out = [];
  let cursor = 0;
  for (const t of tokens) {
    const text = t.text;
    let start = sentence.indexOf(text, cursor);
    if (start < 0) start = sentence.indexOf(text);
    if (start < 0) {
      out.push({ token: t, start: cursor, end: cursor + text.length, text });
      cursor += text.length;
      continue;
    }
    out.push({ token: t, start, end: start + text.length, text: sentence.slice(start, start + text.length) });
    cursor = start + text.length;
  }
  // 补齐 token 之间被跳过的原始字符（空格、引号、破折号），保证整句可原样渲染
  const filled = [];
  let at = 0;
  for (const s of out) {
    if (s.start > at) filled.push({ start: at, end: s.start, text: sentence.slice(at, s.start), gap: true });
    filled.push(s);
    at = s.end;
  }
  if (at < sentence.length) filled.push({ start: at, end: sentence.length, text: sentence.slice(at), gap: true });
  return filled;
}

/**
 * 核心：把一句话压成前端能直接渲染的视图模型。
 * 返回 null 表示这句话没解析出任何内容。
 */
export function toViewModel(sentence) {
  const src = String(sentence ?? "").trim();
  if (!src) return null;

  const tokens = markVerbForms(segment(src).tokens);
  const rawClauses = findClauses(tokens);
  const clauses = attachClauses(tokens, rawClauses);
  const backbone = extractBackbone(tokens, rawClauses);

  const inRange = (i, range) => !!range && i >= range[0] && i <= range[1];

  const clauseRanges = clauses.map((c, idx) => ({
    id: `c${idx + 1}`,
    startIdx: c.startIdx,
    endIdx: c.endIdx,
    marker: c.marker,
    type: c.type,
    attachesTo: c.attachesTo,
    note: c.attachesToNote ?? c.note ?? "",
    text: c.text
  }));
  // 嵌套深度：被多少个别的从句包住
  const depths = new Map();
  for (const r of clauseRanges) {
    depths.set(r.id, clauseRanges.filter((o) => o.id !== r.id && o.startIdx <= r.startIdx && o.endIdx >= r.endIdx).length + 1);
  }

  const spans = locate(src, tokens).map((s) => {
    const t = s.token;
    if (!t) {
      return { start: s.start, end: s.end, text: s.text, role: ROLE.OTHER, roleLabel: ROLE_LABEL[ROLE.OTHER], gap: true, clauseId: null, clauseDepth: 0, why: "" };
    }
    const i = t.i;
    // 从句优先：块内的 token 一律算从句内容，引导词单独标出
    let host = null;
    for (const r of clauseRanges) {
      if (inRange(i, [r.startIdx, r.endIdx])) {
        if (!host || depths.get(r.id) > depths.get(host.id)) host = r;
      }
    }
    let role = ROLE.OTHER;
    if (!t.isWord) {
      role = ROLE.OTHER; // 标点不参与成分着色
    } else if (host) {
      // 从句整体落在主语位 / 宾语位时，按「主语从句」「宾语从句」着色，
      // 但保留 clauseId，前端可以再套一层从句描边
      const wholeInSubject = backbone && inRange(host.startIdx, backbone.ranges.subject) && inRange(host.endIdx, backbone.ranges.subject);
      const wholeInObject = backbone && inRange(host.startIdx, backbone.ranges.object) && inRange(host.endIdx, backbone.ranges.object);
      if (wholeInSubject && i !== host.startIdx) role = ROLE.SUBJECT;
      else if (wholeInObject && i !== host.startIdx) role = ROLE.OBJECT;
      else role = i === host.startIdx ? ROLE.CLAUSE_MARKER : ROLE.CLAUSE_BODY;
    } else if (backbone && inRange(i, backbone.ranges.predicate)) {
      role = ROLE.PREDICATE;
    } else if (backbone && inRange(i, backbone.ranges.subject)) {
      role = ROLE.SUBJECT;
    } else if (backbone && inRange(i, backbone.ranges.object)) {
      role = ROLE.OBJECT;
    } else if (backbone && inRange(i, backbone.ranges.adjunct)) {
      role = ROLE.ADJUNCT;
    } else if (backbone && inRange(i, backbone.ranges.leading)) {
      role = ROLE.LEADING;
    } else if (t.vg === "gerund" || t.vg === "infinitive" || t.vg === "past-or-pp") {
      role = ROLE.NONFINITE;
    }
    return {
      start: s.start,
      end: s.end,
      text: s.text,
      role,
      roleLabel: ROLE_LABEL[role],
      gap: false,
      inClause: !!host,
      clauseId: host ? host.id : null,
      clauseDepth: host ? depths.get(host.id) : 0,
      why: t.why || t.vgWhy || ""
    };
  });

  const findText = (needle) => {
    if (!needle) return null;
    const start = src.indexOf(needle);
    return start < 0 ? null : { start, end: start + needle.length };
  };

  return {
    sentence: src,
    words: tokens.filter((t) => t.isWord).length,
    clauseCount: clauseRanges.length,
    spans,
    clauses: clauseRanges.map((r) => {
      const loc = findText(r.text);
      return {
        id: r.id,
        marker: r.marker,
        type: r.type,
        attachesTo: r.attachesTo,
        note: r.note,
        text: r.text,
        depth: depths.get(r.id),
        start: loc?.start ?? null,
        end: loc?.end ?? null
      };
    }),
    backbone: backbone
      ? {
        subject: { text: backbone.subject, loc: findText(backbone.subject) },
        predicate: { text: backbone.predicate, loc: findText(backbone.predicate) },
        object: { text: backbone.object, loc: findText(backbone.object) },
        objectLabel: backbone.objectLabel,
        pattern: backbone.pattern,
        passive: backbone.passive,
        predicateWhy: backbone.predicateWhy,
        subjectHead: backbone.subjectHead,
        adjunct: backbone.adjunct,
        leading: backbone.skippedLeadingAdverbial
      }
      : null
  };
}