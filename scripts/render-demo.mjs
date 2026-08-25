#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const target = path.resolve("docs/assets/dry-run-terminal.gif");
const run = spawnSync(process.execPath, ["dist/cli.js", "run", "examples/replay", "--replay"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, NO_COLOR: "1" },
});
if (run.status !== 0) throw new Error(run.stderr || run.stdout);

const ansi = /\x1b\[[0-9;]*m/g;
const outputLines = run.stdout
  .replace(ansi, "")
  .split(/\r?\n/)
  .map((line) => line.trimEnd())
  .filter(Boolean);
const lines = ["$ npx @muratkomurcu/dry-run run examples/replay --replay", "", ...outputLines];
const checkpoints = [1, 3, 5, Math.max(7, lines.length - 2), lines.length];
const temp = mkdtempSync(path.join(tmpdir(), "dryrun-demo-"));

try {
  checkpoints.forEach((count, index) => {
    const visible = lines.slice(0, Math.min(count, lines.length));
    const svg = renderSvg(visible, index === checkpoints.length - 1);
    writeFileSync(path.join(temp, `frame-${String(index).padStart(2, "0")}.svg`), svg);
  });

  for (let index = 0; index < checkpoints.length; index++) {
    const id = String(index).padStart(2, "0");
    const converted = spawnSync(
      "sips",
      ["-s", "format", "png", path.join(temp, `frame-${id}.svg`), "--out", path.join(temp, `frame-${id}.png`)],
      { encoding: "utf8" },
    );
    if (converted.status !== 0) throw new Error(converted.stderr || converted.stdout);
  }

  mkdirSync(path.dirname(target), { recursive: true });
  const gif = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel", "error",
      "-framerate", "1.35",
      "-i", path.join(temp, "frame-%02d.png"),
      "-vf", "fps=12,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3",
      "-loop", "0",
      target,
    ],
    { encoding: "utf8" },
  );
  if (gif.status !== 0) throw new Error(gif.stderr || gif.stdout);
  process.stdout.write(`${target}\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function renderSvg(visibleLines, complete) {
  const escaped = visibleLines.map(escapeXml);
  const rows = escaped
    .map((line, index) => {
      const color = line.startsWith("$")
        ? "#b8adff"
        : line.includes("✓") || line.includes("passed")
          ? "#78e0aa"
          : line.includes("All")
            ? "#f4f7fc"
            : "#aeb8c8";
      return `<text x="62" y="${145 + index * 38}" fill="${color}" font-size="20">${line || " "}</text>`;
    })
    .join("\n");
  const cursorY = 145 + escaped.length * 38;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="640" viewBox="0 0 1200 640">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0b0e16"/><stop offset="1" stop-color="#111a27"/></linearGradient><filter id="shadow"><feDropShadow dx="0" dy="22" stdDeviation="28" flood-opacity=".45"/></filter></defs>
  <rect width="1200" height="640" fill="#080b12"/>
  <circle cx="1050" cy="70" r="330" fill="#6958f5" opacity=".10"/>
  <rect x="30" y="32" width="1140" height="576" rx="26" fill="url(#bg)" stroke="#354158" filter="url(#shadow)"/>
  <rect x="31" y="33" width="1138" height="63" rx="25" fill="#1a2130"/>
  <circle cx="66" cy="65" r="7" fill="#ff5f57"/><circle cx="90" cy="65" r="7" fill="#febc2e"/><circle cx="114" cy="65" r="7" fill="#28c840"/>
  <text x="600" y="72" text-anchor="middle" fill="#8f9caf" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="15" font-weight="650">dry-run · deterministic agent tests</text>
  <g font-family="'SFMono-Regular',Consolas,'Liberation Mono',monospace">${rows}
  ${complete ? "" : `<rect x="62" y="${cursorY - 19}" width="11" height="24" rx="2" fill="#8c7dff"/>`}
  </g>
  <text x="1130" y="574" text-anchor="end" fill="#66758a" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="13">offline · zero provider calls</text>
</svg>`;
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
