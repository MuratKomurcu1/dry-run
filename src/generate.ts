import type { Interaction } from "./cassette.ts";
import type { MockTurn } from "./providers/mock.ts";
import type { ToolDef } from "./types.ts";

export interface GenerateOptions {
  scenarioName: string;
  importFrom?: string;
}

export function generateScenario(
  interactions: Interaction[],
  opts: GenerateOptions,
): string {
  const imp = opts.importFrom ?? "@muratkomurcu/dry-run";
  const system = interactions[0]?.request.messages.find((m) => m.role === "system")?.content ?? "";
  const input =
    interactions[0]?.request.messages.find((m) => m.role === "user")?.content ?? "";

  const turns: MockTurn[] = [];
  for (const i of interactions) {
    for (const call of i.response.toolCalls) {
      turns.push({ call: call.name, args: call.arguments });
    }
    if (i.response.text && i.response.toolCalls.length === 0) {
      turns.push({ say: i.response.text });
    }
  }

  const toolDefs = collectToolDefs(interactions);
  const toolNames = [...new Set(turns.filter((t): t is Extract<MockTurn, { call: string }> => "call" in t).map((t) => t.call))];
  const output = interactions[interactions.length - 1]?.response.text ?? "";
  const totalSteps = interactions.length + turns.filter((t) => "call" in t).length;
  const model = [...interactions].reverse().find((i) => i.request.model)?.request.model ?? "";

  const lines: string[] = [];
  lines.push(`import { defineAgent, MockProvider, autoCassette, scenario } from ${JSON.stringify(imp)};`);
  lines.push("");
  lines.push(`const provider = autoCassette(${JSON.stringify(opts.scenarioName)}, () => new MockProvider(${JSON.stringify(turns, null, 2).replace(/\n/g, "\n")}));`);
  lines.push("");
  lines.push("const agent = defineAgent({");
  lines.push("  provider,");
  if (model) lines.push(`  model: ${JSON.stringify(model)},`);
  if (system) lines.push(`  system: ${JSON.stringify(system)},`);
  if (toolDefs.length) {
    lines.push("  tools: [");
    for (const t of toolDefs) {
      lines.push(`    ${JSON.stringify(t)},`);
    }
    lines.push("  ],");
    lines.push("  execute: async () => ({ ok: true }),");
  }
  lines.push("});");
  lines.push("");
  lines.push("export default [");
  lines.push("  scenario({");
  lines.push(`    name: ${JSON.stringify(opts.scenarioName + " · generated from cassette")},`);
  lines.push("    agent,");
  lines.push(`    input: ${JSON.stringify(input)},`);
  lines.push("    expect: [");
  for (const name of toolNames) {
    const count = turns.filter((t) => "call" in t && t.call === name).length;
    lines.push(`      { type: "toolCalled", tool: ${JSON.stringify(name)}, times: ${count} },`);
  }
  if (output) {
    const fragment = pickFragment(output);
    lines.push(`      { type: "outputContains", value: ${JSON.stringify(fragment)} },`);
  }
  lines.push(`      { type: "maxSteps", count: ${totalSteps} },`);
  lines.push("    ],");
  lines.push("  }),");
  lines.push("];");
  lines.push("");

  return lines.join("\n");
}

function collectToolDefs(interactions: Interaction[]): ToolDef[] {
  const byName = new Map<string, ToolDef>();
  for (const i of interactions) {
    for (const def of i.request.tools ?? []) {
      if (!byName.has(def.name)) byName.set(def.name, def);
    }
  }
  return [...byName.values()];
}

function pickFragment(output: string): string {
  const words = output.trim().split(/\s+/);
  return words.slice(0, Math.min(8, words.length)).join(" ");
}
