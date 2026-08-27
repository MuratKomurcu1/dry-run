import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { TEAM_STUDIO_HTML } from "../src/team-ui.ts";

describe("team control-plane UI", () => {
  it("ships parseable inline JavaScript for governance, intelligence, judges, and review programs", () => {
    const start = TEAM_STUDIO_HTML.indexOf("<script>");
    const end = TEAM_STUDIO_HTML.lastIndexOf("</script>");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const script = TEAM_STUDIO_HTML.slice(start + "<script>".length, end);
    expect(() => new Script(script, { filename: "dry-run-team-ui.js" })).not.toThrow();
    expect(TEAM_STUDIO_HTML).toContain("Quality monitors");
    expect(TEAM_STUDIO_HTML).toContain("Krippendorff");
    expect(TEAM_STUDIO_HTML).toContain("Production intelligence");
    expect(TEAM_STUDIO_HTML).toContain("Judge reliability");
    expect(TEAM_STUDIO_HTML).toContain("Organization governance");
    expect(TEAM_STUDIO_HTML).toContain("Create blinded assignments");
    expect(TEAM_STUDIO_HTML).toContain("Setup & import");
    expect(TEAM_STUDIO_HTML).toContain("Create demo workspace");
    expect(TEAM_STUDIO_HTML).toContain("Preview import");
  });
});
