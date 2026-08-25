import type {
  Assertion,
  AssertionResult,
  Trajectory,
} from "./types.ts";

export function describeAssertion(a: Assertion): string {
  switch (a.type) {
    case "toolCalled":
      return `calls tool "${a.tool}"`;
    case "notToolCalled":
      return `never calls tool "${a.tool}"`;
    case "outputEquals":
      return `output equals "${a.value}"`;
    case "outputContains":
      return `output contains "${a.value}"`;
    case "outputMatches":
      return `output matches /${a.pattern}/${a.flags ?? ""}`;
    case "maxSteps":
      return `uses at most ${a.count} steps`;
    case "maxTokens":
      return `uses at most ${a.count} tokens`;
    case "noRepeatedToolCalls":
      return `never repeats a tool call more than ${a.limit ?? 2}x in a row`;
    case "semantic":
      return `semantically: ${a.criteria}`;
  }
}

export function evaluateAssertion(a: Assertion, t: Trajectory): AssertionResult {
  const label = describeAssertion(a);

  switch (a.type) {
    case "toolCalled": {
      const calls = t.steps.filter(
        (s) => s.kind === "tool" && s.toolCall?.name === a.tool,
      );
      if (calls.length === 0) {
        return fail(label, `tool "${a.tool}" was never called`);
      }
      if (a.times != null && calls.length !== a.times) {
        return fail(label, `expected ${a.times} calls, got ${calls.length}`);
      }
      if (a.argsContains != null) {
        const match = calls.find((c) =>
          argsSuperset(c.toolCall!.arguments, a.argsContains!),
        );
        if (!match) {
          return fail(
            label,
            `no call had arguments containing ${JSON.stringify(a.argsContains)}; got ${JSON.stringify(calls.map((c) => c.toolCall!.arguments))}`,
          );
        }
      }
      return pass(label);
    }

    case "notToolCalled": {
      const called = t.steps.some(
        (s) => s.kind === "tool" && s.toolCall?.name === a.tool,
      );
      return called ? fail(label, `tool "${a.tool}" was called`) : pass(label);
    }

    case "outputEquals":
      return t.output.trim() === a.value.trim()
        ? pass(label)
        : fail(label, `actual output:\n    ${indent(t.output)}`);

    case "outputContains":
      return t.output.includes(a.value)
        ? pass(label)
        : fail(label, `actual output:\n    ${indent(t.output)}`);

    case "outputMatches": {
      const re = new RegExp(a.pattern, a.flags ?? "");
      return re.test(t.output)
        ? pass(label)
        : fail(label, `actual output:\n    ${indent(t.output)}`);
    }

    case "maxSteps": {
      const count = t.steps.length;
      return count <= a.count
        ? pass(label)
        : fail(label, `took ${count} steps`);
    }

    case "maxTokens": {
      const total = totalTokens(t);
      if (total === null) {
        return { label, passed: true, skipped: true, message: "no token usage recorded (mock provider?)" };
      }
      return total <= a.count
        ? pass(label)
        : fail(label, `used ${total} tokens (budget: ${a.count})`);
    }

    case "noRepeatedToolCalls": {
      const limit = (a.limit ?? 2) + 1;
      let streakTool: string | null = null;
      let streak = 0;
      for (const s of t.steps) {
        if (s.kind !== "tool" || !s.toolCall) continue;
        if (s.toolCall.name === streakTool) {
          streak++;
        } else {
          streakTool = s.toolCall.name;
          streak = 1;
        }
        if (streak > limit) {
          return fail(
            label,
            `tool "${streakTool}" called ${streak} times in a row — likely stuck in a loop`,
          );
        }
      }
      return pass(label);
    }

    case "semantic": {
      return { label, passed: false, skipped: true, message: "handled by runner" };
    }
  }
}

export function totalTokens(t: Trajectory): number | null {
  let total = 0;
  let seen = false;
  for (const s of t.steps) {
    if (s.usage) {
      seen = true;
      total += s.usage.inputTokens + s.usage.outputTokens;
    }
  }
  return seen ? total : null;
}

function argsSuperset(actual: Record<string, unknown>, subset: Record<string, unknown>): boolean {
  return Object.entries(subset).every(([k, v]) =>
    deepEqual(actual[k], v),
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as never)[k], (b as never)[k]));
}

function pass(label: string): AssertionResult {
  return { label, passed: true };
}

function fail(label: string, message: string): AssertionResult {
  return { label, passed: false, message };
}

function indent(s: string): string {
  return s.replace(/\n/g, "\n    ").trimEnd();
}
