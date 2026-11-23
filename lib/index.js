/**
 * dsh-english-coach —— 宿主端入口。
 *
 * 回答的问题只有一个：一句英语看不懂时，卡在哪一层，以及怎么把它搞懂。
 * 单句无法判断层级，所以流程固定为：解析 → 分层出题 → 你作答 → 判分归因 → 累计画像。
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseSentence, parseText } from "./parse.js";
import { renderAnalysis, renderExplain } from "./render.js";
import { addNote, appendRecord, buildProfile, loadNotes, loadRecords, renderProfile } from "./store.js";
import { LAYER_LABEL } from "./lexicon-core.js";
import { makeRoutes } from "./api.js";

const name = "english-coach";
const inject = ["tools", "systemPrompt"];

const SKILL_NAME = "english-sentence-doctor";
const SKILL_DESCRIPTION = "英语长难句分层诊断：把一句读不懂的英文拆成主干/从句/非谓语/指代，用五层自测题（词汇·句法·指代·逻辑·表达）判定卡点，累计出「你属于哪一层」的画像，并给该层的针对性练法。当用户说「这句英语看不懂」「查了单词还是译不出来」「帮我拆一下这句」时使用。";
const SKILL_WHEN_TO_USE = "用户给出英语句子表示读不懂、翻不出来、想知道自己卡在哪一层，或要做长难句精读与翻译训练时";
const SKILL_BODY_URL = new URL("../skills/english-sentence-doctor/SKILL.md", import.meta.url);
const SKILL_RESOURCE_BASE = { kind: "directory", path: fileURLToPath(new URL("../skills/english-sentence-doctor/", import.meta.url)) };

function stripFrontmatter(markdown) {
  const text = String(markdown);
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  return end === -1 ? text : text.slice(end + 4).replace(/^\s*\n/, "");
}

const skillProvider = {
  name,
  list: () => Promise.resolve([{
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    invocation: { modelInvocable: true, userInvocable: true },
    source: "custom",
    provider: name,
    rank: 600,
    resourceBase: SKILL_RESOURCE_BASE,
    locator: SKILL_BODY_URL
  }]),
  async get() {
    return {
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      whenToUse: SKILL_WHEN_TO_USE,
      invocation: { modelInvocable: true, userInvocable: true },
      source: "custom",
      provider: name,
      rank: 600,
      resourceBase: SKILL_RESOURCE_BASE,
      content: stripFrontmatter(await readFile(SKILL_BODY_URL, "utf8"))
    };
  }
};

/**
 * 宿主要求每个工具声明 output { schema, render }。
 * 注意契约：render 的返回值是 **content block 数组**（[{type:'text',text}]），
 * 不是裸字符串——返回字符串会在 Host 侧 `result.content.some(...)` 处炸掉。
 */
const TEXT_OUTPUT = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: String(value ?? "") }]
};

/** 把一段文本（可能是多句）里的句子挑出来，最多 max 句 */
function pickSentences(text, max = 5) {
  const parsed = parseText(text);
  return parsed.slice(0, max);
}

function registerSentenceTool(ctx) {
  ctx.tools.register({
    name: "en_sentence",
    description:
      "英语句子分层诊断。action=analyze 拆结构（主干/从句/非谓语/指代/风险提示）；" +
      "action=explain 给中文重组的译法路线；" +
      "action=note 把句中的生词与搭配存进本地生词本；action=list_notes 看生词本。" +
      "（分层诊断不用选择题：请用户在面板「句子诊断」里自己标注成分，批改会给出卡点。）",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["analyze", "explain", "note", "list_notes"],
          description: "analyze=拆结构；explain=译法路线；note=存生词；list_notes=看生词本。分层诊断在面板里用标注批改完成。"
        },
        sentence: { type: "string", description: "要分析的英语句子（可含多句，默认只处理前 5 句）。" }
      },
      required: ["action"],
      additionalProperties: false
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const action = String(args?.action ?? "analyze");
      const sentence = String(args?.sentence ?? "").trim();

      if (action === "list_notes") {
        const notes = await loadNotes();
        if (!notes.length) return "生词本还是空的。用 en_sentence action=note 把句子里的生词与搭配存进来。";
        const lines = [`【生词本 · ${notes.length} 条】`, ""];
        notes.slice().sort((a, b) => (b.count ?? 1) - (a.count ?? 1)).forEach((n) => {
          lines.push(`- [${n.type}] ${n.head}${n.meaning ? " — " + n.meaning : ""}${n.count > 1 ? `（遇到 ${n.count} 次）` : ""}`);
        });
        return lines.join("\n");
      }

      if (!sentence) return "需要提供 sentence（要分析的英语句子）。";

      if (action === "explain") {
        const parsed = pickSentences(sentence, 3);
        return parsed.map((p) => renderExplain(p)).join("\n\n---\n\n");
      }

      if (action === "note") {
        const parsed = pickSentences(sentence, 3);
        let added = 0;
        for (const p of parsed) {
          for (const h of p.hints.hiddenSenses ?? []) { await addNote({ type: "熟词僻义", head: h.word, meaning: h.sense, sentence: p.sentence }); added += 1; }
          for (const h of p.hints.academic ?? []) { await addNote({ type: "学术词", head: h.word, meaning: h.sense, sentence: p.sentence }); added += 1; }
          for (const h of p.hints.fixed ?? []) { await addNote({ type: h.kind || "固定句式", head: h.text, meaning: h.meaning, sentence: p.sentence }); added += 1; }
          for (const h of p.hints.phrases ?? []) { await addNote({ type: "搭配", head: h.phrase, meaning: h.meaning, sentence: p.sentence }); added += 1; }
        }
        return `已存入生词本 ${added} 条。用 action=list_notes 查看。`;
      }

      // analyze（默认）
      const parsed = pickSentences(sentence, 5);
      if (!parsed.length) return "没解析出句子，请检查 sentence。";
      return parsed.map((p) => renderAnalysis(p)).join("\n\n---\n\n");
    }
  });
}

function registerProfileTool(ctx) {
  ctx.tools.register({
    name: "en_profile",
    description: "看「我到底卡在哪一层」：累计各层正确率、最常卡住的层、最近 10 次趋势，并给出该层的练法。数据只存在本机。",
    parameters: {
      type: "object",
      properties: {
        verbose: { type: "boolean", description: "true=附带每条记录明细。" },
        clear: { type: "boolean", description: "true=清空全部记录（需同时传 confirm=true）。" },
        confirm: { type: "boolean", description: "clear 时必传 true。" }
      },
      additionalProperties: false
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      if (args?.clear && args?.confirm) {
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { homedir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = join(homedir(), ".dsh", "dsh-english-coach");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "records.json"), "[]", "utf8");
        return "记录已清空。";
      }
      const records = await loadRecords();
      const profile = buildProfile(records);
      const out = [renderProfile(profile)];
      if (args?.verbose && records.length) {
        out.push("");
        out.push("【明细】");
        records.slice(-20).forEach((r) => {
          const miss = (r.wrongLayers ?? []).map((l) => LAYER_LABEL[l]).join("、") || "全对";
          out.push(`- ${r.ts.slice(0, 10)} ${r.sentence.slice(0, 46)}${r.sentence.length > 46 ? "…" : ""} | 卡点：${miss}`);
        });
      }
      return out.join("\n");
    }
  });
}

const PROMPT_TEXT = `英语长难句诊断（dsh-english-coach）：
当用户贴出一句英文说「看不懂 / 翻译不出来 / 知道单词但读不通」：
1) 调 en_sentence(action=analyze) 拿结构体检（主干、从句归属、非谓语、指代候选、风险提示）；
2) 不要把选择题抛给用户——选项本身就是提示。分层诊断靠他**自己产出**：引导他去面板「句子诊断」→「② 标注」，
   自己框选成分、圈出指代与否定范围、点出不确定的词、写整句译文；批改会给出五层的卡点与练法；
3) 用户做完一批后可调 en_profile，按最弱的那一层给 2-4 条当天可执行的动作；
4) 要给他讲整句怎么译时调 en_sentence(action=explain)。
五层是：V 词汇、S 句法、R 指代、L 逻辑、E 表达。E 层最容易被误诊——标注全对但中文写不出来，那一层练回译，不练单词。
工具输出只给结构零件和候选，最终译文由你写：先主干后修饰，长定语拆句，否定与转折方向最后核一遍。`;

function apply(ctx, config) {
  registerSentenceTool(ctx);
  registerProfileTool(ctx);

  // 面板用 HTTP 接口：包一层已有引擎函数，客户端不重复实现语法逻辑。
  // 必须用 ctx.inject（服务等待）而非 ctx.slots.inject——这是 Host 侧服务，缺席时静默跳过。
  try {
    ctx.inject(["webServer"], (wctx) => {
      const routes = makeRoutes(config ?? {});
      wctx.effect?.(() => {
        const disposers = routes.map((route) => wctx.webServer.register(route));
        return () => disposers.forEach((dispose) => { try { dispose?.(); } catch { /* 已卸载 */ } });
      });
    });
  } catch {
    // 没有 webServer 的宿主（headless / 裁剪版）下，工具照常可用，只是没有面板接口
  }

  ctx.inject(["skills"], (sctx) => {
    if (!sctx?.skills || typeof sctx.skills.registerProvider !== "function") return;
    try {
      sctx.skills.registerProvider(() => skillProvider);
    } catch {
      // 技能列表注册失败不影响工具使用
    }
  });

  ctx.systemPrompt.section({
    name: "english-coach",
    order: 160,
    text: () => PROMPT_TEXT
  });
}

export { apply, inject, name };