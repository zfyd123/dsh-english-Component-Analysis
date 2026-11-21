import { makeRoutes } from "../lib/api.js";

const routes = makeRoutes({});
const byPath = Object.fromEntries(routes.map((r) => [r.path, r]));

function makeReq({ method = "GET", url = "/", body = null, remote = "127.0.0.1" }) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  return {
    method,
    url,
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; }
  };
}

function makeRes() {
  const out = { statusCode: 200, headers: {}, text: "" };
  out.setHeader = (k, v) => { out.headers[k] = v; };
  out.end = (s) => { out.text = s ?? ""; };
  return out;
}

async function call(pathAndQuery, opts = {}) {
  const [path] = pathAndQuery.split("?");
  const route = byPath[path];
  if (!route) throw new Error("no route " + path);
  const res = makeRes();
  await route.handler(makeReq({ ...opts, url: pathAndQuery }), res);
  let json = null;
  try { json = JSON.parse(res.text); } catch { /* 非 JSON */ }
  return { status: res.statusCode, json };
}

const SENTENCE = "The proposal that the committee put forward at the meeting held last week was rejected by the board, which had long been skeptical of any plan that would require it to cut costs in areas it considered essential.";

const a = await call("/api/dsh-en-coach/analyze", { method: "POST", body: { sentence: SENTENCE } });
console.log("analyze:", a.status, "| spans:", a.json?.view?.spans?.length, "| clauses:", a.json?.view?.clauses?.length, "| hints:", Object.keys(a.json?.hints ?? {}).length);

const g = await call("/api/dsh-en-coach/annotate", {
  method: "POST",
  body: { sentence: SENTENCE, spans: [{ start: 0, end: 2, role: "主语" }, { start: 10, end: 12, role: "谓语" }] }
});
console.log("annotate:", g.status, "| 总分:", g.json?.overall, "| 层:", JSON.stringify(g.json?.layers));

const p = await call("/api/dsh-en-coach/profile");
console.log("profile:", p.status, "| total:", p.json?.profile?.total, "| text 长度:", p.json?.text?.length);

const papers = await call("/api/dsh-en-coach/papers");
console.log("papers:", papers.status, "|", JSON.stringify(papers.json?.papers));

const firstPaper = (papers.json?.papers || [])[0];
const paper = firstPaper ? await call("/api/dsh-en-coach/paper?name=" + encodeURIComponent(firstPaper.name)) : { json: {} };
console.log("paper:", paper.status, "| 句数:", paper.json?.sentences?.length, "| 首句:", paper.json?.sentences?.[0]?.text?.slice(0, 60));

const bad = await call("/api/dsh-en-coach/analyze", { method: "POST", body: { sentence: "" } });
console.log("empty sentence →", bad.status, bad.json?.error);

const remote = await call("/api/dsh-en-coach/profile", { remote: "10.0.0.5" });
console.log("非回环访问 →", remote.status, remote.json?.error);