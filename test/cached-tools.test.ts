import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachedTools } from "../src/cached-tools.ts";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "dryrun-tools-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("cachedTools", () => {
  it("auto mode: executes once per args, replays after", async () => {
    const dir = tmpDir();
    let calls = 0;
    const make = () =>
      cachedTools(
        {
          get_weather: async (args: { city: string }) => {
            calls++;
            return { temp: 21, city: args.city };
          },
        },
        { dir },
      );

    const tools1 = make();
    const a1 = await tools1.get_weather({ city: "Paris" });
    const a2 = await tools1.get_weather({ city: "Paris" });
    expect(calls).toBe(1);
    expect(a1).toEqual(a2);

    const tools2 = make();
    const b1 = await tools2.get_weather({ city: "Paris" });
    expect(calls).toBe(1);
    expect(b1).toEqual({ temp: 21, city: "Paris" });

    await tools2.get_weather({ city: "Berlin" });
    expect(calls).toBe(2);
  });

  it("replay mode fails loudly on cache miss", async () => {
    const dir = tmpDir();
    const tools = cachedTools(
      { search: async () => "fresh" },
      { dir, mode: "replay" },
    );
    await expect(tools.search({ q: "x" })).rejects.toThrow(/no recorded result.*--record/s);
  });

  it("does not echo secret arguments in replay-miss errors", async () => {
    const dir = tmpDir();
    const tools = cachedTools(
      { search: async () => "fresh" },
      { dir, mode: "replay" },
    );
    const secret = ["sk", "live", "qrstuvwxyzabcdef"].join("-");
    await expect(tools.search({ apiKey: secret })).rejects.not.toThrow(secret);
    await expect(tools.search({ apiKey: secret })).rejects.toThrow(/argument fingerprint sha256:/);
  });

  it("fails loudly instead of treating a corrupt cache as empty", async () => {
    const dir = tmpDir();
    const toolDir = path.join(dir, "tools");
    await import("node:fs").then((fs) => fs.mkdirSync(toolDir, { recursive: true }));
    await import("node:fs").then((fs) => fs.writeFileSync(path.join(toolDir, "search.json"), "{broken"));
    const tools = cachedTools({ search: async () => "network result" }, { dir });
    await expect(tools.search({ q: "x" })).rejects.toThrow(/cache .* is invalid/);
  });

  it("fails loudly when a cache has the wrong top-level shape", async () => {
    const dir = tmpDir();
    const toolDir = path.join(dir, "tools");
    await import("node:fs").then((fs) => fs.mkdirSync(toolDir, { recursive: true }));
    await import("node:fs").then((fs) =>
      fs.writeFileSync(path.join(toolDir, "search.json"), JSON.stringify([])),
    );
    const tools = cachedTools({ search: async () => "network result" }, { dir });
    await expect(tools.search({ q: "x" })).rejects.toThrow(/expected an object/);
  });

  it("argument order does not matter", async () => {
    const dir = tmpDir();
    let calls = 0;
    const tools = cachedTools(
      { f: async (args: Record<string, number>) => { calls++; return args; } },
      { dir },
    );
    await tools.f({ a: 1, b: 2 });
    await tools.f({ b: 2, a: 1 });
    expect(calls).toBe(1);
  });

  it("persists results under a hashed argument key", async () => {
    const dir = tmpDir();
    const tools = cachedTools({ ping: async () => ({ pong: true }) }, { dir });
    await tools.ping({});
    const file = path.join(dir, "tools", "ping.json");
    expect(existsSync(file)).toBe(true);
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    const [key] = Object.keys(persisted);
    expect(key).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(persisted[key]).toEqual({ pong: true });
  });

  it("does not persist secret tool arguments or secret-shaped results", async () => {
    const dir = tmpDir();
    const providerSecret = ["sk", "live", "abcdefghijklmnop"].join("-");
    const requestSecret = ["sk", "live", "qrstuvwxyzabcdef"].join("-");
    const tools = cachedTools(
      {
        lookup: async () => ({
          ok: true,
          authorization: ["Bearer", "abcdefghijklmnopqrstuvwxyz"].join(" "),
          note: `provider returned ${providerSecret}`,
        }),
      },
      { dir },
    );

    await tools.lookup({ apiKey: requestSecret, query: "order" });
    const raw = readFileSync(path.join(dir, "tools", "lookup.json"), "utf8");
    expect(raw).not.toContain("sk-live-");
    expect(raw).not.toContain("Bearer abc");
    expect(raw).not.toContain("apiKey");
    expect(raw).toContain("[REDACTED]");
  });

  it("migrates legacy raw argument keys without retaining secrets", async () => {
    const dir = tmpDir();
    const toolDir = path.join(dir, "tools");
    await import("node:fs").then((fs) => fs.mkdirSync(toolDir, { recursive: true }));
    const providerSecret = ["sk", "live", "abcdefghijklmnop"].join("-");
    const legacyKey = JSON.stringify({ apiKey: providerSecret, query: "order" });
    await import("node:fs").then((fs) =>
      fs.writeFileSync(
        path.join(toolDir, "lookup.json"),
        JSON.stringify({ [legacyKey]: { authorization: ["Bearer", "abcdefghijklmnopqrstuvwxyz"].join(" ") } }),
      ),
    );

    const tools = cachedTools({ lookup: async () => "should not run" }, { dir });
    await tools.lookup({ apiKey: providerSecret, query: "order" });
    const raw = readFileSync(path.join(toolDir, "lookup.json"), "utf8");
    expect(raw).not.toContain("sk-live-");
    expect(raw).not.toContain("Bearer abc");
    expect(raw).toContain("sha256:");
    expect(raw).toContain("[REDACTED]");
  });
});
