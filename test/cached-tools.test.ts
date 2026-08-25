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

  it("persists results as readable JSON", async () => {
    const dir = tmpDir();
    const tools = cachedTools({ ping: async () => ({ pong: true }) }, { dir });
    await tools.ping({});
    const file = path.join(dir, "tools", "ping.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      "{}": { pong: true },
    });
  });
});
