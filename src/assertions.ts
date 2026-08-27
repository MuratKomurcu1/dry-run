import { createRequire } from "node:module";
import type { Assertion, AssertionResult, Trajectory, TrajectoryMatchMode } from "./types.ts";

const require = createRequire(import.meta.url);
let ajv: any;

export interface AssertionContext { durationMs?: number }

export function describeAssertion(a: Assertion): string {
  switch (a.type) {
    case "toolCalled": return `calls tool "${a.tool}"`;
    case "notToolCalled": return `never calls tool "${a.tool}"`;
    case "outputEquals": return `output equals "${a.value}"`;
    case "outputContains": return `output contains "${a.value}"`;
    case "outputMatches": return `output matches /${a.pattern}/${a.flags ?? ""}`;
    case "maxSteps": return `uses at most ${a.count} steps`;
    case "maxTokens": return `uses at most ${a.count} tokens`;
    case "maxLLMCalls": return `uses at most ${a.count} LLM calls`;
    case "maxDuration": return `finishes within ${a.ms}ms`;
    case "maxCost": return `costs at most $${a.usd}`;
    case "noRepeatedToolCalls": return `never repeats a tool call more than ${a.limit ?? 2}x in a row`;
    case "noToolErrors": return "has no tool errors";
    case "toolOrder": return `${a.exact ? "exact" : "ordered"} tool path [${a.tools.join(" → ")}]`;
    case "toolArgsSchema": return `${a.every ? "every" : "a"} "${a.tool}" call matches JSON Schema`;
    case "outputJsonSchema": return "output is valid JSON matching JSON Schema";
    case "trajectory": return `${a.mode ?? "strict"} trajectory [${a.tools.join(" → ")}]`;
    case "custom": return `custom: ${a.name}`;
    case "semantic": return `semantically: ${a.criteria}`;
  }
}

export function evaluateAssertion(a: Assertion, t: Trajectory, context: AssertionContext = {}): AssertionResult {
  const label = describeAssertion(a);
  switch (a.type) {
    case "toolCalled": {
      const calls = toolSteps(t).filter((s) => s.toolCall?.name === a.tool);
      if (calls.length === 0) return fail(label, `tool "${a.tool}" was never called`);
      if (a.times != null && calls.length !== a.times) return fail(label, `expected ${a.times} calls, got ${calls.length}`);
      if (a.argsContains != null && !calls.some((c) => argsSuperset(c.toolCall!.arguments, a.argsContains!))) {
        return fail(label, `no call had arguments containing ${safeJson(a.argsContains)}; got ${safeJson(calls.map((c) => c.toolCall!.arguments))}`);
      }
      return pass(label);
    }
    case "notToolCalled":
      return toolNames(t).includes(a.tool) ? fail(label, `tool "${a.tool}" was called`) : pass(label);
    case "outputEquals":
      return t.output.trim() === a.value.trim() ? pass(label) : fail(label, `actual output:\n    ${indent(t.output)}`);
    case "outputContains":
      return t.output.includes(a.value) ? pass(label) : fail(label, `actual output:\n    ${indent(t.output)}`);
    case "outputMatches": {
      const re = new RegExp(a.pattern, a.flags ?? "");
      return re.test(t.output) ? pass(label) : fail(label, `actual output:\n    ${indent(t.output)}`);
    }
    case "maxSteps": return t.steps.length <= a.count ? pass(label) : fail(label, `took ${t.steps.length} steps`);
    case "maxTokens": {
      const total = totalTokens(t);
      if (total === null) return skipped(label, "no token usage recorded");
      return total <= a.count ? pass(label) : fail(label, `used ${total} tokens (budget: ${a.count})`);
    }
    case "maxLLMCalls": {
      const count = t.steps.filter((s) => s.kind === "llm").length;
      return count <= a.count ? pass(label) : fail(label, `made ${count} LLM calls`);
    }
    case "maxDuration": {
      if (context.durationMs == null) return skipped(label, "run duration was not supplied");
      return context.durationMs <= a.ms ? pass(label) : fail(label, `took ${context.durationMs}ms (budget: ${a.ms}ms)`);
    }
    case "maxCost": {
      const cost = totalCost(t);
      if (cost === null) return skipped(label, "no cost data recorded");
      return cost <= a.usd ? pass(label) : fail(label, `cost $${cost.toFixed(6)} (budget: $${a.usd})`);
    }
    case "noRepeatedToolCalls": {
      const limit = a.limit ?? 2;
      let previous: string | undefined;
      let streak = 0;
      for (const name of toolNames(t)) {
        streak = name === previous ? streak + 1 : 1;
        previous = name;
        if (streak > limit) return fail(label, `tool "${name}" called ${streak} times in a row — likely stuck in a loop`);
      }
      return pass(label);
    }
    case "noToolErrors": {
      const errors = toolSteps(t).filter((s) => s.error);
      return errors.length === 0 ? pass(label) : fail(label, errors.map((s) => `${s.toolCall?.name}: ${s.error}`).join("; "));
    }
    case "toolOrder": {
      const actual = toolNames(t);
      const ok = a.exact ? arraysEqual(actual, a.tools) : isSubsequence(a.tools, actual);
      return ok ? pass(label) : fail(label, `actual path [${actual.join(" → ") || "none"}]`);
    }
    case "toolArgsSchema": {
      const calls = toolSteps(t).filter((s) => s.toolCall?.name === a.tool);
      if (calls.length === 0) return fail(label, `tool "${a.tool}" was never called`);
      const validate = compileSchema(a.schema, label);
      if ("passed" in validate) return validate;
      const validity = calls.map((call) => validate(call.toolCall!.arguments));
      const ok = a.every ? validity.every(Boolean) : validity.some(Boolean);
      return ok ? pass(label) : fail(label, getAjv().errorsText(validate.errors, { separator: "; " }) || "arguments did not match schema");
    }
    case "outputJsonSchema": {
      let value: unknown;
      try { value = JSON.parse(t.output); }
      catch (error) { return fail(label, `output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
      const validate = compileSchema(a.schema, label);
      if ("passed" in validate) return validate;
      return validate(value) ? pass(label) : fail(label, getAjv().errorsText(validate.errors, { separator: "; " }) || "output did not match schema");
    }
    case "trajectory": {
      const actual = toolNames(t);
      return matchesTrajectory(actual, a.tools, a.mode ?? "strict") ? pass(label) : fail(label, `actual path [${actual.join(" → ") || "none"}]`);
    }
    case "custom": {
      const value = a.evaluate(t);
      if (value instanceof Promise) return skipped(label, "async custom assertion requires evaluateAssertionAsync()");
      return normalizeCustom(label, value);
    }
    case "semantic": return { label, passed: false, skipped: true, message: "handled by runner" };
  }
}

export async function evaluateAssertionAsync(a: Assertion, t: Trajectory, context: AssertionContext = {}): Promise<AssertionResult> {
  if (a.type !== "custom") return evaluateAssertion(a, t, context);
  try { return normalizeCustom(describeAssertion(a), await a.evaluate(t)); }
  catch (error) { return fail(describeAssertion(a), `custom assertion threw: ${error instanceof Error ? error.message : String(error)}`); }
}

export function totalTokens(t: Trajectory): number | null {
  let total = 0;
  let seen = false;
  for (const step of t.steps) {
    if (step.usage) {
      seen = true;
      total += step.usage.inputTokens + step.usage.outputTokens;
    }
  }
  return seen ? total : null;
}

export function totalCost(t: Trajectory): number | null {
  const values = t.steps.map((s) => s.costUsd).filter((v): v is number => v != null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function compileSchema(schema: Record<string, unknown>, label: string) {
  try { return getAjv().compile(schema); }
  catch (error) { return fail(label, `invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`); }
}

function getAjv(): any {
  if (!ajv) {
    const module = require("ajv") as { Ajv?: new (options: Record<string, unknown>) => unknown; default?: new (options: Record<string, unknown>) => unknown };
    const Constructor = module.Ajv ?? module.default;
    if (!Constructor) throw new Error("Ajv runtime is unavailable");
    ajv = new Constructor({ allErrors: true, strict: false });
    const formatsModule = require("ajv-formats") as { default?: (instance: unknown) => void } | ((instance: unknown) => void);
    const addFormats = typeof formatsModule === "function" ? formatsModule : formatsModule.default;
    addFormats?.(ajv);
  }
  return ajv;
}

function normalizeCustom(label: string, value: boolean | string | AssertionResult): AssertionResult {
  if (typeof value === "boolean") return value ? pass(label) : fail(label, "custom assertion returned false");
  if (typeof value === "string") return fail(label, value);
  return { ...value, label: value.label || label };
}

function matchesTrajectory(actual: string[], expected: string[], mode: TrajectoryMatchMode): boolean {
  if (mode === "strict") return arraysEqual(actual, expected);
  if (mode === "unordered") return arraysEqual([...actual].sort(), [...expected].sort());
  if (mode === "subset") return isSubsequence(expected, actual);
  return isSubsequence(actual, expected);
}

function isSubsequence(needle: string[], haystack: string[]): boolean {
  let index = 0;
  for (const value of haystack) if (value === needle[index]) index++;
  return index === needle.length;
}

function toolSteps(t: Trajectory) { return t.steps.filter((s) => s.kind === "tool" && s.toolCall); }
function toolNames(t: Trajectory): string[] { return toolSteps(t).map((s) => s.toolCall!.name); }

function argsSuperset(actual: Record<string, unknown>, subset: Record<string, unknown>): boolean {
  return Object.entries(subset).every(([key, value]) => key in actual &&
    (isPlainObject(value) && isPlainObject(actual[key])
      ? argsSuperset(actual[key] as Record<string, unknown>, value as Record<string, unknown>)
      : deepEqual(actual[key], value)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return arraysEqual(a, b, deepEqual);
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]));
}

function arraysEqual<T>(a: T[], b: T[], compare: (x: T, y: T) => boolean = Object.is): boolean {
  return a.length === b.length && a.every((value, index) => compare(value, b[index]));
}

function pass(label: string): AssertionResult { return { label, passed: true }; }
function fail(label: string, message: string): AssertionResult { return { label, passed: false, message }; }
function skipped(label: string, message: string): AssertionResult { return { label, passed: true, skipped: true, message }; }
function indent(s: string): string { return s.replace(/\n/g, "\n    ").trimEnd(); }
function safeJson(value: unknown): string { try { return JSON.stringify(value); } catch { return "[unserializable]"; } }
