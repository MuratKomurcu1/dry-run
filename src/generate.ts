import type { CassetteInput, Interaction } from "./cassette.ts";
import { parseCassette } from "./cassette.ts";
import type { MockTurn } from "./providers/mock.ts";
import type { ToolDef } from "./types.ts";

export interface GenerateOptions {
  scenarioName: string;
  importFrom?: string;
}

export function generateScenario(
  cassette: CassetteInput,
  opts: GenerateOptions,
): string {
  const interactions = Array.isArray(cassette) ? cassette : parseCassette(cassette).interactions;
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
  const toolResults = collectToolResults(interactions);
  const toolNames = [...new Set(turns.filter((t): t is Extract<MockTurn, { call: string }> => "call" in t).map((t) => t.call))];
  const output = interactions[interactions.length - 1]?.response.text ?? "";
  const totalSteps = interactions.length + turns.filter((t) => "call" in t).length;
  const model = [...interactions].reverse().find((i) => i.request.model)?.request.model ?? "";

  const lines: string[] = [];
  lines.push(`import { defineAgent, MockProvider, autoCassette, scenario } from ${javascriptLiteral(imp)};`);
  lines.push("");
  lines.push(`const provider = autoCassette(${javascriptLiteral(opts.scenarioName)}, () => new MockProvider(${javascriptLiteral(turns, 2)}));`);
  lines.push("");
  if (toolDefs.length) {
    lines.push(`const recordedToolResults = ${javascriptLiteral(toolResults, 2)};`);
    lines.push("");
  }
  lines.push("const agent = defineAgent({");
  lines.push("  provider,");
  if (model) lines.push(`  model: ${javascriptLiteral(model)},`);
  if (system) lines.push(`  system: ${javascriptLiteral(system)},`);
  if (toolDefs.length) {
    lines.push("  tools: [");
    for (const t of toolDefs) {
      lines.push(`    ${javascriptLiteral(t)},`);
    }
    lines.push("  ],");
    lines.push("  execute: async () => {");
    lines.push("    const next = recordedToolResults.shift();");
    lines.push("    if (!next) throw new Error(\"generated fixture exhausted its recorded tool results\");");
    lines.push("    if (next.error) throw new Error(next.error);");
    lines.push("    return next.result;");
    lines.push("  },");
  }
  lines.push("});");
  lines.push("");
  lines.push("export default [");
  lines.push("  scenario({");
  lines.push(`    name: ${javascriptLiteral(opts.scenarioName + " · generated from cassette")},`);
  lines.push("    agent,");
  lines.push(`    input: ${javascriptLiteral(input)},`);
  lines.push("    expect: [");
  for (const name of toolNames) {
    const count = turns.filter((t) => "call" in t && t.call === name).length;
    lines.push(`      { type: "toolCalled", tool: ${javascriptLiteral(name)}, times: ${count} },`);
  }
  if (output) {
    const fragment = pickFragment(output);
    lines.push(`      { type: "outputContains", value: ${javascriptLiteral(fragment)} },`);
  }
  lines.push(`      { type: "maxSteps", count: ${totalSteps} },`);
  lines.push("    ],");
  lines.push("  }),");
  lines.push("];");
  lines.push("");

  return lines.join("\n");
}

const JAVASCRIPT_UNSAFE_CHARACTERS: Record<string, string> = {
  "<": "\\u003C",
  ">": "\\u003E",
  "&": "\\u0026",
  "/": "\\u002F",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

function javascriptLiteral(value: unknown, space?: number): string {
  const encoded = JSON.stringify(value, null, space);
  if (encoded == null) throw new Error("Generated scenario contains a value that cannot be serialized");
  return encoded.replace(/[<>&\/\u2028\u2029]/g, (character) => JAVASCRIPT_UNSAFE_CHARACTERS[character]);
}

function collectToolResults(interactions: Interaction[]): Array<{ result?: unknown; error?: string }> {
  const seen = new Set<string>();
  const results: Array<{ result?: unknown; error?: string }> = [];
  for (const interaction of interactions) {
    for (const message of interaction.request.messages) {
      if (message.role !== "tool" || !message.toolCallId || seen.has(message.toolCallId)) continue;
      seen.add(message.toolCallId);
      try {
        const parsed = JSON.parse(message.content ?? "null") as { result?: unknown; error?: string };
        results.push({ result: parsed?.result, ...(parsed?.error ? { error: parsed.error } : {}) });
      } catch {
        results.push({ result: message.content });
      }
    }
  }
  return results;
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
