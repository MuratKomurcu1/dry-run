import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunSummary } from "./types.ts";

export function writeJunit(summary: RunSummary, filePath: string): void {
  const cases = summary.results
    .map((r) => {
      const time = (r.durationMs / 1000).toFixed(3);
      const inner: string[] = [];
      if (r.error) {
        inner.push(`<failure message="${esc(r.error)}"><![CDATA[${esc(r.error)}]]></failure>`);
      } else {
        for (const a of r.assertions) {
          if (!a.passed && !a.skipped) {
            const msg = `${a.label} — ${a.message ?? "failed"}`;
            inner.push(`<failure message="${esc(msg)}"/>`);
          }
        }
      }
      return `    <testcase name="${esc(r.name)}" classname="dry-run" time="${time}">${inner.length ? "\n" + inner.join("\n") + "\n  " : ""}</testcase>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="dry-run" tests="${summary.total}" failures="${summary.failed}" time="${(summary.durationMs / 1000).toFixed(3)}">
  <testsuite name="dry-run" tests="${summary.total}" failures="${summary.failed}">
${cases}
  </testsuite>
</testsuites>
`;

  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  writeFileSync(filePath, xml);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
