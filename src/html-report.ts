export interface HtmlAssertion {
  label: string;
  passed: boolean;
  skipped?: boolean;
  message?: string;
}

export interface HtmlStep {
  kind: "llm" | "tool";
  name?: string;
  args?: unknown;
  text?: string;
  result?: string;
  error?: string;
}

export interface HtmlScenario {
  name: string;
  passed: boolean;
  durationMs: number;
  tokens?: number;
  error?: string;
  assertions: HtmlAssertion[];
  trajectory?: HtmlStep[];
  output?: string;
  goldenDiff?: { status: string; changes: string[] };
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderHtml(scenarios: HtmlScenario[], title = "dry-run report"): string {
  const total = scenarios.length;
  const failed = scenarios.filter((s) => !s.passed).length;

  const body = scenarios
    .map((s) => {
      const icon = s.passed ? "✓" : "✗";
      const cls = s.passed ? "pass" : "fail";
      const steps = (s.trajectory ?? [])
        .map((st) => {
          if (st.kind === "tool") {
            return `<div class="step tool"><span class="badge tool">TOOL</span> <b>${esc(st.name)}</b> <code>${esc(JSON.stringify(st.args ?? {}))}</code>${st.error ? ` <span class="err">${esc(st.error)}</span>` : ""}</div>`;
          }
          return `<div class="step llm"><span class="badge llm">LLM</span> ${st.text ? `<em>${esc(truncate(st.text, 140))}</em>` : "<em>(tool call requested)</em>"}</div>`;
        })
        .join("\n");

      const assertions = s.assertions
        .map((a) => {
          const sym = a.skipped ? "⊘" : a.passed ? "✓" : "✗";
          const ac = a.skipped ? "skip" : a.passed ? "pass" : "fail";
          return `<li class="${ac}"><span class="sym">${sym}</span> ${esc(a.label)}${a.message && !a.skipped ? `<pre>${esc(a.message)}</pre>` : ""}</li>`;
        })
        .join("\n");

      const golden = s.goldenDiff
        ? `<div class="golden ${s.goldenDiff.status}">golden: <b>${esc(s.goldenDiff.status)}</b>${s.goldenDiff.changes.map((c) => `<pre>${esc(c)}</pre>`).join("")}</div>`
        : "";

      return `<details class="scenario ${cls}" ${s.passed ? "" : "open"}>
  <summary><span class="icon">${icon}</span> ${esc(s.name)} <span class="meta">${s.durationMs}ms${s.tokens ? ` · ${s.tokens} tokens` : ""}</span></summary>
  <div class="body">
    ${s.error ? `<div class="err big">${esc(s.error)}</div>` : ""}
    ${golden}
    <h4>trajectory</h4>
    ${steps || '<div class="meta">no trajectory captured (use --html with a run)</div>'}
    ${s.output ? `<h4>final output</h4><blockquote>${esc(s.output)}</blockquote>` : ""}
    <h4>assertions</h4>
    <ul>${assertions}</ul>
  </div>
</details>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background:#0d1117; color:#c9d1d9; margin:2rem auto; max-width:860px; padding:0 1rem; }
  h1 { font-size:1.3rem; } h4 { margin:.9rem 0 .3rem; color:#8b949e; text-transform:uppercase; font-size:.7rem; letter-spacing:.08em; }
  .sum { color:#8b949e; margin-bottom:1.5rem; }
  details.scenario { border:1px solid #21262d; border-radius:8px; margin-bottom:.6rem; background:#161b22; }
  summary { cursor:pointer; padding:.7rem 1rem; font-weight:600; }
  .pass .icon, .pass > summary b { color:#3fb950; } .fail .icon { color:#f85149; }
  .icon { display:inline-block; width:1.2rem; }
  .meta { color:#8b949e; font-weight:400; font-size:.8rem; margin-left:.5rem; }
  .body { padding:.3rem 1rem 1rem; }
  .step { padding:.35rem 0 .35rem .5rem; border-left:2px solid #30363d; margin:.25rem 0; }
  .step.tool { border-color:#d29922; } .step.llm { border-color:#58a6ff; }
  .badge { font-size:.65rem; padding:.1rem .4rem; border-radius:4px; margin-right:.3rem; }
  .badge.tool { background:#d29922; color:#000; } .badge.llm { background:#58a6ff; color:#000; }
  code { background:#0d1117; padding:.1rem .35rem; border-radius:4px; font-size:.78rem; }
  em { color:#8ddba1; font-style:normal; }
  blockquote { margin:.2rem 0; padding:.5rem .8rem; border-left:3px solid #30363d; color:#c9d1d9; }
  ul { list-style:none; padding:0; } li { padding:.15rem 0; }
  li .sym { display:inline-block; width:1.2rem; }
  li.fail { color:#f85149; } li.pass { color:#3fb950; } li.skip { color:#d29922; }
  pre { background:#0d1117; padding:.4rem .6rem; border-radius:6px; overflow-x:auto; white-space:pre-wrap; }
  .err { color:#f85149; } .err.big { padding:.5rem .8rem; background:#0d1117; border-radius:6px; margin-bottom:.5rem; }
  .golden { border-radius:6px; padding:.5rem .8rem; margin:.4rem 0; background:#0d1117; }
  .golden.drift { color:#f85149; } .golden.pass { color:#3fb950; } .golden.new, .golden.missing { color:#d29922; }
</style>
</head>
<body>
<h1>dry-run</h1>
<div class="sum">${total} scenario(s) · ${failed === 0 ? "all passed" : `${failed} failed`} · generated ${new Date().toISOString()}</div>
${body}
</body>
</html>
`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
