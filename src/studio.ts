import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { compareExperiments, ExperimentStore } from "./experiment.ts";
import { TraceStore } from "./tracing.ts";
import { PromptRegistry } from "./prompts.ts";

export interface StudioOptions {
  port?: number;
  host?: "127.0.0.1" | "::1";
  token?: string;
  experimentStore?: ExperimentStore;
  traceStore?: TraceStore;
  promptRegistry?: PromptRegistry;
}

export interface StudioHandle {
  server: Server;
  host: string;
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
}

export async function startStudio(opts: StudioOptions = {}): Promise<StudioHandle> {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("Studio host must be a loopback address");
  const port = opts.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Studio port must be between 0 and 65535");
  const token = opts.token ?? randomBytes(32).toString("base64url");
  if (token.length < 24) throw new Error("Studio token must be at least 24 characters");
  const experiments = opts.experimentStore ?? new ExperimentStore();
  const traces = opts.traceStore ?? new TraceStore();
  const prompts = opts.promptRegistry ?? new PromptRegistry();

  const server = createServer((request, response) => {
    route(request, response, { token, experiments, traces, prompts }).catch((error) => {
      if (response.headersSent) return response.end();
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  const displayHost = host === "::1" ? "[::1]" : host;
  return {
    server,
    host,
    port: address.port,
    token,
    url: `http://${displayHost}:${address.port}/#${token}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  state: { token: string; experiments: ExperimentStore; traces: TraceStore; prompts: PromptRegistry },
): Promise<void> {
  securityHeaders(response);
  const host = requestHost(request.headers.host);
  if (host && !["127.0.0.1", "localhost", "::1"].includes(host)) return json(response, 403, { error: "invalid Host header" });
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/" && request.method === "GET") return html(response, STUDIO_HTML);
  if (url.pathname === "/favicon.ico") return empty(response, 204);
  if (!url.pathname.startsWith("/api/")) return json(response, 404, { error: "not found" });
  if (!authorized(request, state.token)) return json(response, 401, { error: "unauthorized" });
  if (request.method !== "GET") {
    const origin = request.headers.origin;
    if (origin && !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin)) return json(response, 403, { error: "invalid Origin header" });
  }

  if (url.pathname === "/api/health" && request.method === "GET") return json(response, 200, { ok: true, version: 1 });
  if (url.pathname === "/api/experiments" && request.method === "GET") {
    return json(response, 200, state.experiments.list().map((experiment) => ({
      id: experiment.id,
      name: experiment.name,
      status: experiment.status,
      passed: experiment.passed,
      createdAt: experiment.createdAt,
      dataset: experiment.dataset,
      summary: experiment.summary,
      aggregates: experiment.aggregates,
      tags: experiment.tags,
    })));
  }
  if (url.pathname === "/api/compare" && request.method === "GET") {
    const baseline = required(url.searchParams.get("baseline"), "baseline");
    const candidate = required(url.searchParams.get("candidate"), "candidate");
    return json(response, 200, compareExperiments(state.experiments.load(baseline), state.experiments.load(candidate)));
  }
  const experimentMatch = /^\/api\/experiments\/([a-zA-Z0-9_.-]+)$/.exec(url.pathname);
  if (experimentMatch && request.method === "GET") return json(response, 200, state.experiments.load(experimentMatch[1]));
  const experimentFeedback = /^\/api\/experiments\/([a-zA-Z0-9_.-]+)\/feedback$/.exec(url.pathname);
  if (experimentFeedback && request.method === "POST") {
    const body = await readBody(request);
    return json(response, 201, await state.experiments.addFeedback(experimentFeedback[1], parseExperimentFeedback(body)));
  }

  if (url.pathname === "/api/traces" && request.method === "GET") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const results = state.traces.list({
      ...(status === "ok" || status === "error" ? { status } : {}),
      ...(type ? { type: type as any } : {}),
      ...(url.searchParams.get("q") ? { query: url.searchParams.get("q")! } : {}),
      ...(url.searchParams.get("tag") ? { tag: url.searchParams.get("tag")! } : {}),
    });
    return json(response, 200, results.map((trace) => ({
      id: trace.id,
      name: trace.name,
      status: trace.status,
      startedAt: trace.startedAt,
      durationMs: trace.durationMs,
      spans: trace.spans.length,
      tags: trace.tags,
      feedback: trace.feedback.length,
    })));
  }
  const traceMatch = /^\/api\/traces\/([a-zA-Z0-9_.-]+)$/.exec(url.pathname);
  if (traceMatch && request.method === "GET") return json(response, 200, state.traces.load(traceMatch[1]));
  const traceFeedback = /^\/api\/traces\/([a-zA-Z0-9_.-]+)\/feedback$/.exec(url.pathname);
  if (traceFeedback && request.method === "POST") {
    const body = await readBody(request);
    return json(response, 201, await state.traces.addFeedback(traceFeedback[1], parseTraceFeedback(body)));
  }
  if (url.pathname === "/api/prompts" && request.method === "GET") {
    return json(response, 200, state.prompts.list().map((prompt) => ({
      name: prompt.name,
      versions: prompt.versions.length,
      latest: prompt.labels.latest,
      labels: prompt.labels,
      updatedAt: prompt.updatedAt,
      tags: prompt.versions.at(-1)?.tags,
    })));
  }
  if (url.pathname === "/api/prompt" && request.method === "GET") {
    const name = required(url.searchParams.get("name"), "name");
    return json(response, 200, state.prompts.load(name));
  }
  return json(response, 404, { error: "not found" });
}

function requestHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("[")) return /^\[([^\]]+)\](?::\d+)?$/.exec(value)?.[1];
  return value.split(":", 1)[0];
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request body exceeds 64 KiB");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text || "{}"); }
  catch { throw new Error("request body must be JSON"); }
}

function parseExperimentFeedback(value: unknown) {
  if (!isRecord(value) || typeof value.caseKey !== "string") throw new Error("feedback requires caseKey");
  return {
    caseKey: value.caseKey,
    source: parseSource(value.source),
    ...(typeof value.score === "number" ? { score: value.score } : {}),
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.comment === "string" ? { comment: value.comment } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

function parseTraceFeedback(value: unknown) {
  if (!isRecord(value)) throw new Error("feedback body must be an object");
  return {
    source: parseSource(value.source),
    ...(typeof value.spanId === "string" ? { spanId: value.spanId } : {}),
    ...(typeof value.score === "number" ? { score: value.score } : {}),
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.comment === "string" ? { comment: value.comment } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

function parseSource(value: unknown): "human" | "code" | "external" {
  return value === "code" || value === "external" ? value : "human";
}
function required(value: string | null, name: string): string { if (!value) throw new Error(`${name} is required`); return value; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function securityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
}
function json(response: ServerResponse, status: number, value: unknown): void { response.statusCode = status; response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(`${JSON.stringify(value)}\n`); }
function html(response: ServerResponse, value: string): void { response.statusCode = 200; response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(value); }
function empty(response: ServerResponse, status: number): void { response.statusCode = status; response.end(); }

const STUDIO_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dry-run studio</title><style>
:root{color-scheme:dark;--bg:#090b10;--panel:#121620;--panel2:#171c28;--line:#262d3b;--text:#eef2ff;--muted:#8e9aae;--blue:#6ea8fe;--green:#42d392;--red:#ff6b7a;--amber:#f8c55c}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% -10%,#1b2c50 0,transparent 35%),var(--bg);color:var(--text);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:1280px;margin:auto;padding:28px}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}.brand{display:flex;gap:12px;align-items:center}.mark{width:38px;height:38px;border-radius:11px;background:linear-gradient(145deg,#81b4ff,#7259ff);box-shadow:0 10px 35px #527fff44;display:grid;place-items:center;font-weight:800}.brand h1{font-size:17px;margin:0}.brand p{margin:3px 0 0;color:var(--muted);font-size:12px}.live{color:var(--green);font-size:12px}.tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin-bottom:20px}.tab{border:0;background:none;color:var(--muted);padding:10px 14px;cursor:pointer;border-bottom:2px solid transparent}.tab.active{color:var(--text);border-color:var(--blue)}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}.stat,.panel{background:linear-gradient(180deg,#151a25ee,#10141dee);border:1px solid var(--line);border-radius:14px;box-shadow:0 16px 50px #0005}.stat{padding:16px}.stat b{display:block;font-size:24px;margin-top:8px}.label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}.panel{overflow:hidden}.panel-head{display:flex;align-items:center;justify-content:space-between;padding:15px 17px;border-bottom:1px solid var(--line)}.panel-head h2{font-size:13px;margin:0}.search{background:#0c1018;border:1px solid var(--line);border-radius:8px;color:var(--text);padding:7px 10px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px 17px;border-bottom:1px solid #202634;font-size:12px}th{color:var(--muted);font-weight:500}.badge{display:inline-flex;padding:3px 8px;border-radius:999px;font-size:11px}.pass{background:#163a2d;color:#70e3ae}.fail{background:#422028;color:#ff95a0}.running{background:#3b321b;color:#ffd47b}.muted{color:var(--muted)}.score{font-variant-numeric:tabular-nums}.empty{padding:42px;text-align:center;color:var(--muted)}.detail{white-space:pre-wrap;background:#090c12;padding:14px;border-radius:9px;overflow:auto;max-height:420px}.hidden{display:none}@media(max-width:760px){.shell{padding:16px}.stats{grid-template-columns:1fr 1fr}th:nth-child(3),td:nth-child(3){display:none}}
</style></head><body><main class="shell"><header class="top"><div class="brand"><div class="mark">dr</div><div><h1>dry-run studio</h1><p>local agent quality control plane</p></div></div><span class="live">● local only</span></header><nav class="tabs"><button class="tab active" data-view="experiments">Experiments</button><button class="tab" data-view="traces">Traces</button><button class="tab" data-view="prompts">Prompts</button></nav><section class="stats"><div class="stat"><span class="label">Experiments</span><b id="experimentCount">—</b></div><div class="stat"><span class="label">Pass rate</span><b id="passRate">—</b></div><div class="stat"><span class="label">Traces</span><b id="traceCount">—</b></div><div class="stat"><span class="label">Prompts</span><b id="promptCount">—</b></div></section><section class="panel" id="experiments"><div class="panel-head"><h2>Experiment history</h2><input class="search" id="experimentSearch" placeholder="Filter experiments"></div><div id="experimentTable"></div></section><section class="panel hidden" id="traces"><div class="panel-head"><h2>Trace explorer</h2><input class="search" id="traceSearch" placeholder="Filter traces"></div><div id="traceTable"></div></section><section class="panel hidden" id="prompts"><div class="panel-head"><h2>Prompt registry</h2><input class="search" id="promptSearch" placeholder="Filter prompts"></div><div id="promptTable"></div></section><section class="panel hidden" id="detail" style="margin-top:18px"><div class="panel-head"><h2 id="detailTitle">Details</h2><button class="tab" id="closeDetail">Close</button></div><pre class="detail" id="detailBody"></pre></section></main><script>
const token=location.hash.slice(1);
history.replaceState(null,"",location.pathname);
const api=async function(p){const r=await fetch(p,{headers:{Authorization:"Bearer "+token}});if(!r.ok)throw new Error((await r.json()).error||r.statusText);return r.json()};
const esc=function(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})};
let experiments=[],traces=[],prompts=[];
function renderExperiments(q){
  q=q||"";const rows=experiments.filter(function(x){return x.name.toLowerCase().includes(q.toLowerCase())});
  let body=rows.map(function(x){const status=x.status==="running"?"running":x.passed?"pass":"fail";return '<tr data-exp="'+esc(x.id)+'"><td><b>'+esc(x.name)+'</b><br><span class="muted">'+esc(x.id)+'</span></td><td><span class="badge '+status+'">'+esc(x.status)+'</span></td><td>'+esc(x.dataset.name)+'</td><td>'+x.summary.passed+'/'+x.summary.total+'</td><td class="muted">'+new Date(x.createdAt).toLocaleString()+'</td></tr>'}).join("");
  document.querySelector("#experimentTable").innerHTML=rows.length?'<table><thead><tr><th>Name</th><th>Status</th><th>Dataset</th><th>Cases</th><th>Created</th></tr></thead><tbody>'+body+'</tbody></table>':'<div class="empty">No experiments recorded yet.</div>';
  document.querySelectorAll("[data-exp]").forEach(function(el){el.onclick=function(){show("experiment",el.dataset.exp)}});
}
function renderTraces(q){
  q=q||"";const rows=traces.filter(function(x){return x.name.toLowerCase().includes(q.toLowerCase())});
  let body=rows.map(function(x){return '<tr data-trace="'+esc(x.id)+'"><td><b>'+esc(x.name)+'</b><br><span class="muted">'+esc(x.id)+'</span></td><td><span class="badge '+(x.status==="ok"?"pass":"fail")+'">'+esc(x.status)+'</span></td><td>'+x.spans+'</td><td class="score">'+Math.round(x.durationMs)+'ms</td><td class="muted">'+new Date(x.startedAt).toLocaleString()+'</td></tr>'}).join("");
  document.querySelector("#traceTable").innerHTML=rows.length?'<table><thead><tr><th>Name</th><th>Status</th><th>Spans</th><th>Duration</th><th>Started</th></tr></thead><tbody>'+body+'</tbody></table>':'<div class="empty">No traces recorded yet.</div>';
  document.querySelectorAll("[data-trace]").forEach(function(el){el.onclick=function(){show("trace",el.dataset.trace)}});
}
function renderPrompts(q){
  q=q||"";const rows=prompts.filter(function(x){return x.name.toLowerCase().includes(q.toLowerCase())});
  let body=rows.map(function(x){const labels=Object.entries(x.labels||{}).map(function(pair){return pair[0]+"@"+pair[1]}).join(", ");return '<tr data-prompt="'+esc(encodeURIComponent(x.name))+'"><td><b>'+esc(x.name)+'</b></td><td>'+x.versions+'</td><td>'+esc(x.latest||"—")+'</td><td class="muted">'+esc(labels)+'</td><td class="muted">'+new Date(x.updatedAt).toLocaleString()+'</td></tr>'}).join("");
  document.querySelector("#promptTable").innerHTML=rows.length?'<table><thead><tr><th>Name</th><th>Versions</th><th>Latest</th><th>Labels</th><th>Updated</th></tr></thead><tbody>'+body+'</tbody></table>':'<div class="empty">No prompts published yet.</div>';
  document.querySelectorAll("[data-prompt]").forEach(function(el){el.onclick=function(){show("prompt",decodeURIComponent(el.dataset.prompt))}});
}
async function show(kind,id){const endpoint=kind==="trace"?"/api/traces/"+id:kind==="prompt"?"/api/prompt?name="+encodeURIComponent(id):"/api/experiments/"+id;const data=await api(endpoint);document.querySelector("#detailTitle").textContent=data.name;document.querySelector("#detailBody").textContent=JSON.stringify(data,null,2);document.querySelector("#detail").classList.remove("hidden")}
async function load(){if(!token){document.body.innerHTML='<div class="empty">Missing Studio access token. Start with <code>dry-run studio</code>.</div>';return}try{const all=await Promise.all([api("/api/experiments"),api("/api/traces"),api("/api/prompts")]);experiments=all[0];traces=all[1];prompts=all[2];document.querySelector("#experimentCount").textContent=experiments.length;document.querySelector("#passRate").textContent=experiments.length?Math.round(100*experiments.filter(function(x){return x.passed}).length/experiments.length)+"%":"—";document.querySelector("#traceCount").textContent=traces.length;document.querySelector("#promptCount").textContent=prompts.length;renderExperiments();renderTraces();renderPrompts()}catch(e){document.body.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}
document.querySelectorAll(".tab[data-view]").forEach(function(b){b.onclick=function(){document.querySelectorAll(".tab[data-view]").forEach(function(x){x.classList.toggle("active",x===b)});["experiments","traces","prompts"].forEach(function(id){document.querySelector("#"+id).classList.toggle("hidden",id!==b.dataset.view)})}});
document.querySelector("#experimentSearch").oninput=function(e){renderExperiments(e.target.value)};document.querySelector("#traceSearch").oninput=function(e){renderTraces(e.target.value)};document.querySelector("#promptSearch").oninput=function(e){renderPrompts(e.target.value)};document.querySelector("#closeDetail").onclick=function(){document.querySelector("#detail").classList.add("hidden")};load();
</script></body></html>`;
