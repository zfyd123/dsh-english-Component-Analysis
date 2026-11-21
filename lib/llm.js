/**
 * llm.js —— Host 侧的 LLM 调用层。
 *
 * 复用用户已经在 DSH 里配好的模型，不再让用户填一次 key：
 *   key 从 ~/.dsh/.credentials.yaml 的 refs 段读（DSH 凭据服务就存在那儿）
 *   端点/模型走默认值，可由插件 config 覆盖
 *
 * 只做一件事：发一次 OpenAI 兼容的 chat/completions，拿回文本。
 * JSON 解析、校验、重试策略都在调用方（structure.js），这里保持薄。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 默认路由。任何 OpenAI 兼容接口都能用——换模型只需在 cordis.patch.yml 里覆盖：
 *
 *   config:
 *     llm:
 *       baseURL: https://your-endpoint/v1
 *       model: your-model
 *       apiKeyRef: YOUR_KEY_NAME     # 对应 ~/.dsh/.credentials.yaml 里的键名
 *       apiKey: sk-xxx               # 或者直接写 key（不推荐，会进配置）
 *
 * 成分树的质量高度依赖模型：实测 deepseek-v4.1-flash 约 8–20 秒、结构稳定；
 * 太小的模型会给不出树或覆盖不全（覆盖不足会直接报错，不会假装成功）。
 */
const DEFAULTS = {
  baseURL: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKeyRef: "OPENAI_API_KEY",
  timeoutMs: 60000,
  temperature: 0
};

let cachedKey = null;
let cachedKeyRef = null;

/** 从 DSH 凭据文件里取一个 secret（只读，不外传、不打印） */
async function readCredential(refName) {
  if (cachedKey && cachedKeyRef === refName) return cachedKey;
  try {
    const text = await readFile(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
    const re = new RegExp(`^\\s*${refName}\\s*:\\s*(.+)$`, "m");
    const hit = text.match(re);
    if (!hit) return null;
    const value = hit[1].trim().replace(/^["']|["']$/g, "");
    if (!value) return null;
    cachedKey = value;
    cachedKeyRef = refName;
    return value;
  } catch {
    return null;
  }
}

/** 解析出本次要用的路由（config 覆盖默认） */
export async function resolveRoute(config) {
  const cfg = config?.llm ?? {};
  const route = {
    baseURL: String(cfg.baseURL ?? DEFAULTS.baseURL).replace(/\/+$/, ""),
    model: String(cfg.model ?? DEFAULTS.model),
    apiKeyRef: String(cfg.apiKeyRef ?? DEFAULTS.apiKeyRef),
    timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : DEFAULTS.timeoutMs,
    temperature: Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : DEFAULTS.temperature
  };
  route.apiKey = cfg.apiKey ? String(cfg.apiKey) : await readCredential(route.apiKeyRef);
  return route;
}

/** 路由是否就绪（没 key 就不要发起请求，直接把错误交回去） */
export async function llmStatus(config) {
  const route = await resolveRoute(config);
  return {
    ready: !!route.apiKey,
    model: route.model,
    baseURL: route.baseURL,
    apiKeyRef: route.apiKeyRef,
    reason: route.apiKey ? null : `凭据文件里没有 ${route.apiKeyRef}，且 config.llm.apiKey 为空`
  };
}

/**
 * 发一次对话请求，返回纯文本内容。
 * 失败抛 Error，message 里带可读原因（调用方据此决定回退）。
 */
export async function chatText({ config, system, user, timeoutMs }) {
  const route = await resolveRoute(config);
  if (!route.apiKey) {
    throw Object.assign(new Error(`LLM 未配置：${route.apiKeyRef} 缺失`), { code: "no-key" });
  }

  const ctrl = new AbortController();
  const limit = timeoutMs ?? route.timeoutMs;
  const timer = setTimeout(() => ctrl.abort(), limit);
  const started = Date.now();
  try {
    const res = await fetch(`${route.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${route.apiKey}` },
      body: JSON.stringify({
        model: route.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: route.temperature
      }),
      signal: ctrl.signal
    });

    const text = await res.text();
    if (!res.ok) {
      const err = Object.assign(
        new Error(`LLM ${res.status}: ${text.slice(0, 200)}`),
        { code: res.status === 429 ? "rate-limit" : "http", status: res.status }
      );
      throw err;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("LLM 返回不是 JSON"), { code: "bad-response" });
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw Object.assign(new Error("LLM 返回空内容"), { code: "empty" });
    }
    return { content, ms: Date.now() - started, model: route.model };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw Object.assign(new Error(`LLM 超时（${Math.round(limit / 1000)}s）`), { code: "timeout" });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型输出里抠出 JSON：容忍 ```json 围栏与前后杂字 */
export function extractJson(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(body);
  } catch { /* 继续尝试首尾大括号 */ }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch { /* 交回去由调用方报错 */ }
  }
  throw Object.assign(new Error("模型输出无法解析成 JSON"), { code: "bad-json" });
}