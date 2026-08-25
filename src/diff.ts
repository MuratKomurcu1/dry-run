import type { Interaction } from "./cassette.ts";

export interface CassetteSummary {
  model: string;
  roles: string[];
  toolCalls: { name: string; args: unknown }[];
  output: string;
  interactions: number;
}

export type DriftType =
  | "CALL_COUNT"
  | "MODEL"
  | "TOOL_SEQUENCE"
  | "TOOL_ARGS"
  | "OUTPUT";

export interface Drift {
  type: DriftType;
  detail: string;
}

export function summarize(interactions: Interaction[]): CassetteSummary {
  const last = interactions[interactions.length - 1];
  const toolCalls = interactions.flatMap((i) =>
    i.response.toolCalls.map((c) => ({ name: c.name, args: c.arguments })),
  );
  return {
    model: last?.request.model ?? "",
    roles: interactions.map((i) => i.request.messages.map((m) => m.role).join(">")),
    toolCalls,
    output: last?.response.text ?? "",
    interactions: interactions.length,
  };
}

export function diffCassette(a: Interaction[], b: Interaction[]): Drift[] {
  const drifts: Drift[] = [];
  const sa = summarize(a);
  const sb = summarize(b);

  if (sa.interactions !== sb.interactions) {
    drifts.push({
      type: "CALL_COUNT",
      detail: `${sa.interactions} LLM call(s) → ${sb.interactions}`,
    });
  }

  if (sa.model !== sb.model) {
    drifts.push({ type: "MODEL", detail: `"${sa.model || "(default)"}" → "${sb.model || "(default)"}"` });
  }

  const namesA = sa.toolCalls.map((t) => t.name).join(",");
  const namesB = sb.toolCalls.map((t) => t.name).join(",");
  if (namesA !== namesB) {
    drifts.push({
      type: "TOOL_SEQUENCE",
      detail: `[${namesA || "none"}] → [${namesB || "none"}]`,
    });
  } else {
    for (let i = 0; i < sa.toolCalls.length; i++) {
      if (JSON.stringify(sa.toolCalls[i].args) !== JSON.stringify(sb.toolCalls[i].args)) {
        drifts.push({
          type: "TOOL_ARGS",
          detail: `${sa.toolCalls[i].name}: ${JSON.stringify(sa.toolCalls[i].args)} → ${JSON.stringify(sb.toolCalls[i].args)}`,
        });
      }
    }
  }

  if (sa.output !== sb.output) {
    drifts.push({
      type: "OUTPUT",
      detail: truncate(sa.output, 80) + "\n      → " + truncate(sb.output, 80),
    });
  }

  return drifts;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? `"${flat}"` : `"${flat.slice(0, n)}…"`;
}
