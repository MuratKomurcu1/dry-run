import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunSummary, ScenarioResult } from "./types.ts";

export function writeJsonReport(file: string, summary: RunSummary): void {
  writePrivate(file, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), ...summary }, null, 2)}\n`);
}

export function writeSarifReport(file: string, summary: RunSummary): void {
  const results = summary.results.filter((result) => !result.passed).map(toSarifResult);
  writePrivate(file, `${JSON.stringify({
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: { driver: { name: "dry-run", informationUri: "https://github.com/MuratKomurcu1/dry-run", rules: [] } },
      results,
    }],
  }, null, 2)}\n`);
}

export function writeGitHubReport(summary: RunSummary, summaryFile = process.env.GITHUB_STEP_SUMMARY): void {
  for (const result of summary.results.filter((item) => !item.passed)) {
    const detail = result.error ?? result.assertions.find((assertion) => !assertion.passed || assertion.skipped)?.message ?? "scenario failed";
    process.stdout.write(`::error title=${escapeCommand(`dry-run: ${result.name}`)}::${escapeCommand(detail)}\n`);
  }
  if (!summaryFile) return;
  const lines = [
    "## dry-run agent regression gate",
    "",
    `**${summary.passed}/${summary.total} passed** in ${summary.durationMs}ms`,
    "",
    "| Scenario | Result | Duration | Tokens |",
    "|---|---:|---:|---:|",
    ...summary.results.map((result) => `| ${escapeMarkdown(result.name)} | ${result.passed ? "✅ pass" : "❌ fail"} | ${result.durationMs}ms | ${result.tokens ?? "—"} |`),
    "",
  ];
  appendFileSync(summaryFile, `${lines.join("\n")}\n`, "utf8");
}

function toSarifResult(result: ScenarioResult) {
  const message = result.error ?? result.assertions.filter((assertion) => !assertion.passed || assertion.skipped).map((assertion) => `${assertion.label}: ${assertion.message ?? "failed"}`).join("; ");
  return {
    ruleId: "dry-run/scenario-failed",
    level: "error",
    message: { text: `${result.name}: ${message || "scenario failed"}` },
    properties: { durationMs: result.durationMs, tokens: result.tokens, trial: result.trial, tags: result.tags },
  };
}

function writePrivate(file: string, value: string): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
}

function escapeCommand(value: string): string { return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A"); }
function escapeMarkdown(value: string): string { return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " "); }
