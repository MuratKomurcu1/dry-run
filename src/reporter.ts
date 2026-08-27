import type { RunSummary } from "./types.ts";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function report(summary: RunSummary): void {
  console.log("");

  for (const result of summary.results) {
    const icon = result.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const trial = result.trial && result.trial > 1 ? ` ${DIM}[trial ${result.trial}]${RESET}` : "";
    const retry = result.attempts && result.attempts > 1 ? ` ${DIM}[${result.attempts} attempts]${RESET}` : "";
    console.log(` ${icon} ${result.name}${trial}${retry} ${DIM}(${result.durationMs}ms)${RESET}`);

    if (result.error) {
      console.log(`   ${RED}${result.error}${RESET}`);
    }

    for (const a of result.assertions) {
      const sym = a.skipped
        ? `${YELLOW}⊘${RESET}`
        : a.passed
          ? `${GREEN}✓${RESET}`
          : `${RED}✗${RESET}`;
      console.log(`     ${sym} ${DIM}${a.label}${RESET}`);
      if (a.message && !a.passed) {
        console.log(`       ${RED}${a.message}${RESET}`);
      } else if (a.message && a.skipped) {
        console.log(`       ${YELLOW}${a.message}${RESET}`);
      }
    }
    console.log("");
  }

  const verdict =
    summary.failed === 0
      ? `${GREEN}${BOLD}All ${summary.total} scenario(s) passed${RESET}`
      : `${RED}${BOLD}${summary.failed}/${summary.total} scenario(s) failed${RESET}`;

  const tokens = summary.results.reduce((n, r) => n + (r.tokens ?? 0), 0);
  const tokenNote = tokens > 0 ? ` · ${tokens.toLocaleString()} tokens` : "";
  const cost = summary.results.reduce((total, result) => total + (result.costUsd ?? 0), 0);
  const costNote = cost > 0 ? ` · $${cost.toFixed(6)}` : "";

  console.log(` ${verdict} ${DIM}· ${summary.durationMs}ms${tokenNote}${costNote}${RESET}\n`);
}
