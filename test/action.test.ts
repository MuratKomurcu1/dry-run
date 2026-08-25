import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GitHub composite action", () => {
  it("passes user inputs through environment variables and quoted arrays", () => {
    const source = readFileSync(".github/actions/dry-run/action.yml", "utf8");
    const runScript = source.split("run: |", 2)[1] ?? "";

    expect(runScript).not.toContain("${{ inputs.");
    expect(runScript).toContain("set -euo pipefail");
    expect(runScript).toContain('run "${dryrun_args[@]}"');
    expect(source).toContain("DRYRUN_PATHS: ${{ inputs.paths }}");
  });
});
