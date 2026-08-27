import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createDocument, parseCassette, type CassetteDocument, type Interaction } from "./cassette.ts";
import { Dataset, type DatasetCase, type DatasetDocument, type ExpectedToolCall } from "./dataset.ts";
import { generateScenario } from "./generate.ts";
import { atomicWriteJson, atomicWritePrivate, ensurePrivateDirectory, newId, readJsonFile, sha256, slug, withFileLock } from "./storage.ts";
import { traceToTrajectory, type SpanRecord, type TraceDocument } from "./tracing.ts";
import type { ChatMessage, ChatRequest, ChatResponse, ToolCall, ToolDef } from "./types.ts";

export interface RegressionManifest {
  kind: "dry-run.regression";
  version: 1;
  id: string;
  name: string;
  traceId: string;
  createdAt: string;
  dataset: { file: "dataset.json"; checksum: string; cases: number };
  cassette?: { file: "cassette.json"; checksum: string; interactions: number };
  scenario?: { file: "regression.agentest.ts"; checksum: string };
  warnings: string[];
  provenance: { source: "production-trace"; onlineResultId?: string; annotationItemId?: string };
}

export interface RegressionBundle {
  manifest: RegressionManifest;
  dataset: DatasetDocument;
  cassette?: CassetteDocument;
  scenario?: string;
}

export interface PromoteTraceOptions {
  name?: string;
  onlineResultId?: string;
  annotationItemId?: string;
  importFrom?: string;
}

export class RegressionStore {
  readonly dir: string;
  constructor(dir = path.resolve(".dryrun/regressions")) { this.dir = path.resolve(dir); ensurePrivateDirectory(this.dir); }

  async promote(trace: TraceDocument, opts: PromoteTraceOptions = {}): Promise<RegressionBundle> {
    validateTrace(trace);
    const name = opts.name?.trim() || `${trace.name} regression`;
    if (name.length > 128) throw new Error("Regression name must contain at most 128 characters");
    const id = newId(`regression_${slug(name).slice(0, 48)}`);
    const root = this.bundleDir(id);
    const lock = path.join(this.dir, `.promote-${sha256(trace.id).slice(7, 23)}`);
    return withFileLock(lock, () => {
      if (existsSync(root)) throw new Error(`Regression bundle already exists: ${id}`);
      ensurePrivateDirectory(root);
      const warnings: string[] = [];
      const dataset = datasetFromTrace(trace, name, opts);
      const datasetFile = path.join(root, "dataset.json");
      dataset.save(datasetFile);
      let cassette: CassetteDocument | undefined;
      let scenario: string | undefined;
      try {
        cassette = cassetteFromTrace(trace, name);
        atomicWriteJson(path.join(root, "cassette.json"), cassette);
        scenario = generateScenario(cassette, { scenarioName: slug(name), ...(opts.importFrom ? { importFrom: opts.importFrom } : {}) });
        atomicWritePrivate(path.join(root, "regression.agentest.ts"), scenario);
      } catch (error) {
        warnings.push(`Cassette/test was not generated: ${error instanceof Error ? error.message : String(error)}`);
      }
      const manifest: RegressionManifest = {
        kind: "dry-run.regression",
        version: 1,
        id,
        name,
        traceId: trace.id,
        createdAt: new Date().toISOString(),
        dataset: { file: "dataset.json", checksum: dataset.checksum, cases: dataset.cases.length },
        ...(cassette ? { cassette: { file: "cassette.json", checksum: cassette.checksum, interactions: cassette.interactions.length } } : {}),
        ...(scenario ? { scenario: { file: "regression.agentest.ts", checksum: `sha256:${sha256(scenario)}` } } : {}),
        warnings,
        provenance: { source: "production-trace", ...(opts.onlineResultId ? { onlineResultId: opts.onlineResultId } : {}), ...(opts.annotationItemId ? { annotationItemId: opts.annotationItemId } : {}) },
      };
      atomicWriteJson(path.join(root, "manifest.json"), manifest);
      return { manifest, dataset: dataset.document, ...(cassette ? { cassette } : {}), ...(scenario ? { scenario } : {}) };
    });
  }

  list(): RegressionManifest[] {
    if (!existsSync(this.dir)) return [];
    const values: RegressionManifest[] = [];
    for (const name of readdirSync(this.dir)) {
      try { values.push(validateManifest(readJsonFile(path.join(this.dir, name, "manifest.json")))); } catch { /* ignore incomplete bundles */ }
    }
    return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  load(id: string): RegressionBundle {
    const root = this.bundleDir(id);
    const manifest = validateManifest(readJsonFile(path.join(root, "manifest.json")));
    const dataset = Dataset.parse(readJsonFile(path.join(root, manifest.dataset.file))).document;
    if (dataset.checksum !== manifest.dataset.checksum) throw new Error("Regression dataset manifest checksum mismatch");
    const cassette = manifest.cassette ? parseCassette(readJsonFile(path.join(root, manifest.cassette.file)), manifest.id, { verifyChecksum: true }) : undefined;
    if (cassette && cassette.checksum !== manifest.cassette!.checksum) throw new Error("Regression cassette manifest checksum mismatch");
    const scenario = manifest.scenario ? readText(path.join(root, manifest.scenario.file)) : undefined;
    if (scenario && manifest.scenario!.checksum !== `sha256:${sha256(scenario)}`) throw new Error("Regression scenario checksum mismatch");
    return { manifest, dataset, ...(cassette ? { cassette } : {}), ...(scenario ? { scenario } : {}) };
  }

  private bundleDir(id: string): string { validateId(id); return path.join(this.dir, id); }
}

export function datasetFromTrace(trace: TraceDocument, name = `${trace.name} regression`, opts: PromoteTraceOptions = {}): Dataset {
  const root = trace.spans.find((span) => span.id === trace.rootSpanId);
  const trajectory = traceToTrajectory(trace);
  const input = unwrapInput(root?.input);
  const expectedTools: ExpectedToolCall[] = trajectory.steps.flatMap((step) => step.kind === "tool" && step.toolCall ? [{ name: step.toolCall.name, arguments: step.toolCall.arguments }] : []);
  const item: DatasetCase = {
    id: `trace-${sha256(trace.id).slice(7, 23)}`,
    name: trace.name,
    input,
    expected: trajectory.output,
    ...(expectedTools.length ? { expectedTools } : {}),
    tags: [...new Set(["production-regression", ...(trace.tags ?? [])])],
    metadata: {
      source: "production-trace",
      traceId: trace.id,
      traceStatus: trace.status,
      traceStartedAt: trace.startedAt,
      traceDurationMs: trace.durationMs,
      ...(trace.metadata ?? {}),
      ...(opts.onlineResultId ? { onlineResultId: opts.onlineResultId } : {}),
      ...(opts.annotationItemId ? { annotationItemId: opts.annotationItemId } : {}),
    },
  };
  return Dataset.create(name, [item], { description: `Regression fixture promoted from production trace ${trace.id}.` });
}

export function cassetteFromTrace(trace: TraceDocument, name = `${trace.name} regression`): CassetteDocument {
  const interactions: Interaction[] = [];
  for (const span of trace.spans.filter((candidate) => candidate.type === "llm")) {
    const request = chatRequest(span);
    const response = chatResponse(span);
    if (request && response) interactions.push({ request, response, recordedAt: span.endedAt ?? span.startedAt });
  }
  if (!interactions.length) throw new Error("trace has no LLM spans containing both request messages and response data");
  return createDocument(slug(name), interactions, { matching: "canonical", source: { type: "dry-run-trace", traceId: trace.id } }, trace.startedAt);
}

function chatRequest(span: SpanRecord): ChatRequest | undefined {
  const source = unwrapRecord(span.input, "request", "input");
  if (!source || !Array.isArray(source.messages)) return undefined;
  const messages = source.messages.map(normalizeMessage).filter((value): value is ChatMessage => Boolean(value));
  if (!messages.length) return undefined;
  const tools = Array.isArray(source.tools) ? source.tools.map(normalizeTool).filter((value): value is ToolDef => Boolean(value)) : undefined;
  return {
    model: typeof source.model === "string" ? source.model : stringAttribute(span, "gen_ai.request.model", "model") ?? "",
    messages,
    ...(tools?.length ? { tools } : {}),
    ...(typeof source.temperature === "number" ? { temperature: source.temperature } : {}),
    ...(typeof source.topP === "number" ? { topP: source.topP } : {}),
    ...(typeof source.maxTokens === "number" ? { maxTokens: source.maxTokens } : {}),
    ...(isRecord(source.responseFormat) ? { responseFormat: source.responseFormat } : {}),
  };
}

function chatResponse(span: SpanRecord): ChatResponse | undefined {
  const source = unwrapRecord(span.output, "response", "output");
  if (!source && typeof span.output !== "string") return undefined;
  const value = source ?? { text: span.output };
  const text = typeof value.text === "string" || value.text === null ? value.text : typeof value.content === "string" ? value.content : typeof span.output === "string" ? span.output : null;
  const calls = Array.isArray(value.toolCalls) ? value.toolCalls : Array.isArray(value.tool_calls) ? value.tool_calls : [];
  return {
    text,
    toolCalls: calls.map(normalizeToolCall).filter((item): item is ToolCall => Boolean(item)),
    ...(isRecord(value.usage) && typeof value.usage.inputTokens === "number" && typeof value.usage.outputTokens === "number" ? { usage: value.usage as unknown as ChatResponse["usage"] } : {}),
    ...(typeof value.costUsd === "number" ? { costUsd: value.costUsd } : {}),
    ...(typeof value.finishReason === "string" ? { finishReason: value.finishReason } : {}),
  };
}

function normalizeMessage(value: unknown): ChatMessage | undefined {
  if (!isRecord(value) || !["system", "user", "assistant", "tool"].includes(value.role)) return undefined;
  const calls = Array.isArray(value.toolCalls) ? value.toolCalls.map(normalizeToolCall).filter((item): item is ToolCall => Boolean(item)) : undefined;
  return {
    role: value.role as ChatMessage["role"],
    content: typeof value.content === "string" || value.content === null ? value.content : stringify(value.content),
    ...(calls?.length ? { toolCalls: calls } : {}),
    ...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
  };
}

function normalizeTool(value: unknown): ToolDef | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) return undefined;
  return { name: value.name, ...(typeof value.description === "string" ? { description: value.description } : {}), ...(isRecord(value.parameters) ? { parameters: value.parameters } : {}) };
}

function normalizeToolCall(value: unknown): ToolCall | undefined {
  if (!isRecord(value)) return undefined;
  const fn = isRecord(value.function) ? value.function : undefined;
  const name = typeof value.name === "string" ? value.name : typeof fn?.name === "string" ? fn.name : undefined;
  if (!name) return undefined;
  const raw = value.arguments ?? fn?.arguments;
  let args: unknown = raw;
  if (typeof raw === "string") { try { args = JSON.parse(raw); } catch { args = {}; } }
  return { id: typeof value.id === "string" ? value.id : `call-${sha256(stringify(value)).slice(7, 19)}`, name, arguments: isRecord(args) ? args : {} };
}

function unwrapRecord(value: unknown, ...keys: string[]): Record<string, any> | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) if (isRecord(value[key])) return value[key];
  return value;
}
function unwrapInput(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1) return value[0];
  if (isRecord(value) && "input" in value && Object.keys(value).length <= 3) return value.input;
  return value ?? "";
}
function stringAttribute(span: SpanRecord, ...keys: string[]): string | undefined { for (const key of keys) if (typeof span.attributes[key] === "string") return span.attributes[key] as string; return undefined; }
function validateTrace(value: TraceDocument): void { if (value.kind !== "dry-run.trace" || value.version !== 1 || !value.id || !Array.isArray(value.spans)) throw new Error("Unsupported trace document"); }
function validateManifest(value: unknown): RegressionManifest {
  if (!isRecord(value) || value.kind !== "dry-run.regression" || value.version !== 1 || typeof value.id !== "string" || typeof value.traceId !== "string" || !isRecord(value.dataset) || typeof value.dataset.checksum !== "string" || !Array.isArray(value.warnings)) throw new Error("Unsupported regression manifest");
  if (value.cassette != null && (!isRecord(value.cassette) || typeof value.cassette.checksum !== "string")) throw new Error("Regression cassette manifest is invalid");
  if (value.scenario != null && (!isRecord(value.scenario) || typeof value.scenario.checksum !== "string")) throw new Error("Regression scenario manifest is invalid");
  return value as unknown as RegressionManifest;
}
function validateId(value: string): void { if (!/^[a-zA-Z0-9_.-]{1,192}$/.test(value)) throw new Error("Invalid regression id"); }
function stringify(value: unknown): string { if (value == null) return ""; if (typeof value === "string") return value; try { return JSON.stringify(value); } catch { return String(value); } }
function readText(file: string): string { return readFileSync(file, "utf8"); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
