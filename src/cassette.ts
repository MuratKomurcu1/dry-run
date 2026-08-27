import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ChatRequest, ChatResponse, LLMProvider } from "./types.ts";
import { DRY_RUN_VERSION } from "./version.ts";

export const CASSETTE_VERSION = 2 as const;
export type MatchMode = "exact" | "canonical" | "shape";

export interface Interaction {
  id?: string;
  recordedAt?: string;
  request: ChatRequest;
  response: ChatResponse;
  fingerprints?: Record<MatchMode, string>;
}

export interface CassetteMetadata {
  name: string;
  createdAt: string;
  updatedAt: string;
  producer: { name: "@muratkomurcu/dry-run"; version: string };
  runtime: { name: "node"; version: string; platform: string; arch: string };
  gitSha?: string;
  matching: MatchMode;
  redaction: { enabled: boolean; policy: "dry-run-secrets-v1" | "dry-run-secrets-v2" };
  source?: Record<string, unknown>;
}

export interface CassetteDocument {
  $schema?: "https://raw.githubusercontent.com/MuratKomurcu1/dry-run/main/schemas/cassette-v2.schema.json";
  kind: "dry-run.cassette";
  version: typeof CASSETTE_VERSION;
  metadata: CassetteMetadata;
  interactions: Interaction[];
  checksum: string;
}

export type CassetteInput = Interaction[] | CassetteDocument;
export interface MatchResult { matched: boolean; message?: string }
export type CustomMatcher = (recorded: ChatRequest, current: ChatRequest) => boolean | MatchResult;

export interface CassetteStoreOptions {
  matching?: MatchMode;
  source?: Record<string, unknown>;
}

export class CassetteStore {
  #dir: string;
  #options: CassetteStoreOptions;

  constructor(dir = ".dryrun/cassettes", options: CassetteStoreOptions = {}) {
    this.#dir = dir;
    this.#options = options;
  }

  #file(name: string): string { return path.join(this.#dir, cassetteFilename(name)); }
  #legacyFile(name: string): string { return path.join(this.#dir, `${slug(name)}.json`); }

  #readFile(name: string): string {
    const file = this.#file(name);
    if (existsSync(file)) return file;
    const legacy = this.#legacyFile(name);
    return existsSync(legacy) ? legacy : file;
  }

  exists(name: string): boolean { return existsSync(this.#file(name)) || existsSync(this.#legacyFile(name)); }
  get matching(): MatchMode | undefined { return this.#options.matching; }
  get source(): Record<string, unknown> | undefined { return this.#options.source; }

  loadDocumentSync(name: string): CassetteDocument {
    const file = this.#readFile(name);
    if (!existsSync(file)) return createDocument(name, [], this.#options);
    try {
      return parseCassette(JSON.parse(readFileSync(file, "utf8")), name, { verifyChecksum: true });
    } catch (error) {
      throw new Error(`Cassette "${file}" is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  loadSync(name: string): Interaction[] { return this.loadDocumentSync(name).interactions; }
  async load(name: string): Promise<Interaction[]> { return this.loadSync(name); }

  saveDocumentSync(name: string, document: CassetteDocument): void {
    const file = this.#file(name);
    ensurePrivateDirectory(this.#dir);
    withFileLock(file, () => atomicWritePrivate(file, serializeDocument(document)));
  }

  saveSync(name: string, interactions: Interaction[]): void {
    const existing = this.exists(name) ? this.loadDocumentSync(name) : undefined;
    const document = createDocument(name, interactions, {
      ...this.#options,
      matching: existing?.metadata.matching ?? this.#options.matching,
      source: existing?.metadata.source ?? this.#options.source,
    }, existing?.metadata.createdAt);
    this.saveDocumentSync(name, document);
  }

  async save(name: string, interactions: Interaction[]): Promise<void> { this.saveSync(name, interactions); }
  fileFor(name: string): string { return this.exists(name) ? this.#readFile(name) : this.#file(name); }
}

export type CassetteMode = "auto" | "record" | "replay" | "passthrough";

export function currentCassetteMode(): CassetteMode {
  const raw = (process.env.DRYRUN_MODE ?? "").toLowerCase();
  if (!raw) return "auto";
  if (["record", "replay", "passthrough", "auto"].includes(raw)) return raw as CassetteMode;
  throw new Error(`Invalid DRYRUN_MODE "${raw}". Expected auto, record, replay, or passthrough.`);
}

export function describeRequest(req: ChatRequest): string {
  const roles = req.messages.map((message) => message.role).join(",");
  const calls = req.messages.flatMap((message) => message.toolCalls?.map((call) => call.name) ?? []);
  const tools = req.tools?.map((tool) => tool.name) ?? [];
  return `model=${req.model || "(provider default)"} messages=[${roles}]` +
    (calls.length ? ` toolCalls=[${calls.join(",")}]` : "") +
    (tools.length ? ` tools=[${tools.join(",")}]` : "");
}

export function requestSignature(req: ChatRequest, mode: MatchMode = "canonical"): string {
  return requestFingerprint(req, mode);
}

export function currentMatchMode(fallback: MatchMode = "canonical"): MatchMode {
  const value = process.env.DRYRUN_MATCH;
  if (!value) return fallback;
  if (["exact", "canonical", "shape"].includes(value)) return value as MatchMode;
  throw new Error(`Invalid DRYRUN_MATCH "${value}". Expected exact, canonical, or shape.`);
}

export function requestFingerprint(req: ChatRequest, mode: MatchMode): string {
  return `sha256:${createHash("sha256").update(fingerprintSource(req, mode)).digest("hex")}`;
}

export function matchRequests(recorded: ChatRequest, current: ChatRequest, mode: MatchMode): MatchResult {
  const recordedFingerprint = requestFingerprint(recorded, mode);
  const currentFingerprint = requestFingerprint(current, mode);
  if (recordedFingerprint === currentFingerprint) return { matched: true };
  const differences = diffValues(normalizeRequest(recorded, mode), normalizeRequest(current, mode));
  return { matched: false, message: differences.slice(0, 8).join("\n") };
}

const SECRET_KEY = /(authorization|api[-_]?key|apikey|secret|token|password|passwd|cookie|session)/i;
const SAFE_TOKEN_METRICS = new Set([
  "inputtokens", "outputtokens", "cachedinputtokens", "reasoningtokens",
  "totaltokens", "prompttokens", "completiontokens", "claimtokens",
  "evidencetokens", "maxtokens", "tokencount", "tokenusage", "tokenbudget",
  "tokenlimit", "tokentotal", "tokens",
]);
const SECRET_PATTERNS: RegExp[] = [
  /\bdr[ki]_[A-Za-z0-9_-]{8,64}_[A-Za-z0-9_-]{32,128}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{30,}\b/g,
  /\bgh[oius]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._~-]{10,}(?:\.[A-Za-z0-9._~-]{10,})?\b/g,
];

export function redactText(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
}

export function redactDeep<T>(value: T, enabled = true): T {
  return (enabled ? walk(value) : value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSecretKey(key, child) && typeof child !== "object" ? "[REDACTED]" : walk(child);
    }
    return output;
  }
  return value;
}

function isSecretKey(key: string, value: unknown): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return SECRET_KEY.test(key) && !(typeof value === "number" && SAFE_TOKEN_METRICS.has(normalized));
}

export interface RecorderOptions {
  redact?: boolean;
  matching?: MatchMode;
  source?: Record<string, unknown>;
}

export function recorder(provider: LLMProvider, store: CassetteStore, cassetteName: string, opts: RecorderOptions = {}): LLMProvider {
  const redact = opts.redact ?? process.env.DRYRUN_NO_REDACT !== "1";
  const interactions: Interaction[] = [];
  const createdAt = new Date().toISOString();
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const response = await provider.chat(req);
      const safeRequest = redactDeep(serializableRequest(req), redact);
      const safeResponse = redactDeep(structuredClone(response), redact);
      interactions.push(enrichInteraction({ request: safeRequest, response: safeResponse }));
      const document = createDocument(cassetteName, interactions, {
        matching: opts.matching ?? store.matching ?? currentMatchMode(),
        source: opts.source ?? store.source,
      }, createdAt);
      document.metadata.redaction.enabled = redact;
      store.saveDocumentSync(cassetteName, finalizeDocument(document));
      return response;
    },
  };
}

export interface ReplayerOptions {
  matching?: MatchMode;
  matcher?: CustomMatcher;
  redact?: boolean;
}

export function replayer(store: CassetteStore, cassetteName: string, opts: ReplayerOptions = {}): LLMProvider {
  const document = store.loadDocumentSync(cassetteName);
  const interactions = document.interactions;
  const mode = opts.matching ?? currentMatchMode(document.metadata.matching ?? "canonical");
  const redact = opts.redact ?? document.metadata.redaction.enabled;
  let index = 0;
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      req.signal?.throwIfAborted();
      const next = interactions[index];
      if (!next) {
        throw new Error(`Cassette "${cassetteName}" exhausted (${interactions.length} interaction(s) replayed). The agent made an unexpected additional LLM call. Re-record with --record to capture it.`);
      }
      index++;
      const current = redactDeep(serializableRequest(req), redact);
      const custom = opts.matcher?.(next.request, current);
      const result = custom == null
        ? matchRequests(next.request, current, mode)
        : typeof custom === "boolean" ? { matched: custom } : custom;
      if (!result.matched) {
        throw new Error(
          `Cassette "${cassetteName}" no longer matches at interaction ${index} (${opts.matcher ? "custom" : mode} mode).\n` +
          `  Recorded: ${describeRequest(next.request)}\n  Now:      ${describeRequest(current)}\n` +
          (result.message ? `  Diff:\n${indentLines(result.message, "    ")}\n` : "") +
          "Re-record with --record if this change was intentional, or choose an explicit matching policy.",
        );
      }
      return structuredClone(next.response);
    },
  };
}

export interface AutoCassetteOptions extends RecorderOptions, ReplayerOptions { dir?: string }

export function autoCassette(cassetteName: string, makeProvider: () => LLMProvider, opts: AutoCassetteOptions = {}): LLMProvider {
  const store = new CassetteStore(opts.dir ?? process.env.DRYRUN_CASSETTE_DIR ?? undefined, {
    matching: opts.matching ?? currentMatchMode(),
    source: opts.source,
  });
  const mode = currentCassetteMode();
  let resolved: LLMProvider | undefined;
  const resolve = () => {
    if (!resolved) {
      if (mode === "passthrough") resolved = makeProvider();
      else if (mode === "record" || (mode === "auto" && !store.exists(cassetteName))) {
        resolved = recorder(makeProvider(), store, cassetteName, opts);
      } else resolved = replayer(store, cassetteName, opts);
    }
    return resolved;
  };
  return { chat: (request) => resolve().chat(request) };
}

export function parseCassette(value: unknown, name = "cassette", opts: { verifyChecksum?: boolean } = {}): CassetteDocument {
  if (Array.isArray(value)) {
    validateInteractions(value);
    return createDocument(name, value as Interaction[], { matching: "shape", source: { migratedFrom: 1 } });
  }
  if (!isRecord(value)) throw new Error("expected a v2 cassette object or legacy interaction array");
  if (value.kind !== "dry-run.cassette" || value.version !== CASSETTE_VERSION) {
    throw new Error(`unsupported cassette kind/version (${String(value.kind)} v${String(value.version)})`);
  }
  if (!isRecord(value.metadata) || !Array.isArray(value.interactions) || typeof value.checksum !== "string") {
    throw new Error("v2 cassette is missing metadata, interactions, or checksum");
  }
  validateMetadata(value.metadata);
  validateInteractions(value.interactions);
  const document = value as unknown as CassetteDocument;
  if (!["exact", "canonical", "shape"].includes(document.metadata.matching)) throw new Error("invalid metadata.matching mode");
  if (opts.verifyChecksum && checksum(document.interactions) !== document.checksum) {
    throw new Error("checksum mismatch; cassette is corrupt or was edited without migration");
  }
  for (const [index, interaction] of document.interactions.entries()) {
    if (!interaction.fingerprints) continue;
    for (const mode of ["exact", "canonical", "shape"] as const) {
      if (interaction.fingerprints[mode] !== requestFingerprint(interaction.request, mode)) {
        throw new Error(`interaction ${index + 1} has an invalid ${mode} request fingerprint`);
      }
    }
  }
  return document;
}

export function createDocument(
  name: string,
  interactions: Interaction[],
  opts: CassetteStoreOptions = {},
  createdAt = new Date().toISOString(),
): CassetteDocument {
  const now = new Date().toISOString();
  const commit = gitSha();
  return finalizeDocument({
    $schema: "https://raw.githubusercontent.com/MuratKomurcu1/dry-run/main/schemas/cassette-v2.schema.json",
    kind: "dry-run.cassette",
    version: CASSETTE_VERSION,
    metadata: {
      name,
      createdAt,
      updatedAt: now,
      producer: { name: "@muratkomurcu/dry-run", version: DRY_RUN_VERSION },
      runtime: { name: "node", version: process.version, platform: process.platform, arch: process.arch },
      ...(commit ? { gitSha: commit } : {}),
      matching: opts.matching ?? "canonical",
      redaction: { enabled: true, policy: "dry-run-secrets-v2" },
      ...(opts.source ? { source: opts.source } : {}),
    },
    interactions: interactions.map(enrichInteraction),
    checksum: "",
  });
}

export function finalizeDocument(document: CassetteDocument): CassetteDocument {
  document.metadata.updatedAt = new Date().toISOString();
  document.checksum = checksum(document.interactions);
  return document;
}

function enrichInteraction(interaction: Interaction): Interaction {
  const request = serializableRequest(interaction.request);
  return {
    ...interaction,
    id: interaction.id ?? randomUUID(),
    recordedAt: interaction.recordedAt ?? new Date().toISOString(),
    request,
    fingerprints: {
      exact: requestFingerprint(request, "exact"),
      canonical: requestFingerprint(request, "canonical"),
      shape: requestFingerprint(request, "shape"),
    },
  };
}

function serializableRequest(request: ChatRequest): ChatRequest {
  const { signal: _signal, ...serializable } = request;
  return structuredClone(serializable);
}

function fingerprintSource(request: ChatRequest, mode: MatchMode): string {
  const normalized = normalizeRequest(request, mode);
  return mode === "exact" ? JSON.stringify(normalized) : canonicalStringify(normalized);
}

function normalizeRequest(request: ChatRequest, mode: MatchMode): unknown {
  const clean = serializableRequest(request);
  if (mode === "exact") return clean;
  if (mode === "canonical") return normalizeStrings(clean);
  return {
    model: clean.model || null,
    messages: clean.messages.map((message) => ({
      role: message.role,
      contentType: message.content === null ? "null" : typeof message.content,
      toolCalls: message.toolCalls?.map((call) => ({ name: call.name, argumentKeys: shapeKeys(call.arguments) })) ?? [],
      toolCallId: message.toolCallId ? "present" : "absent",
    })),
    tools: clean.tools?.map((tool) => ({
      name: tool.name,
      parameters: tool.parameters ?? null,
    })) ?? [],
    responseFormat: clean.responseFormat ?? null,
  };
}

function normalizeStrings(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\r\n/g, "\n").trimEnd();
  if (Array.isArray(value)) return value.map(normalizeStrings);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, normalizeStrings(child)]));
  return value;
}

function shapeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeKeys);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeKeys(value[key])]));
  return typeof value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value)) ?? '{"$type":"undefined"}';
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortDeep(child)]));
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  return value;
}

function checksum(interactions: Interaction[]): string {
  return `sha256:${createHash("sha256").update(canonicalStringify(interactions)).digest("hex")}`;
}

function serializeDocument(document: CassetteDocument): string {
  return `${JSON.stringify(finalizeDocument(document), null, 2)}\n`;
}

function validateInteractions(value: unknown[]): void {
  value.forEach((interaction, index) => {
    if (!isRecord(interaction) || !isRecord(interaction.request) || !isRecord(interaction.response)) {
      throw new Error(`interaction ${index + 1} must contain request and response objects`);
    }
    if (!Array.isArray(interaction.request.messages) || typeof interaction.request.model !== "string") {
      throw new Error(`interaction ${index + 1} has an invalid request`);
    }
    if (!Array.isArray(interaction.response.toolCalls) || !(typeof interaction.response.text === "string" || interaction.response.text === null)) {
      throw new Error(`interaction ${index + 1} has an invalid response`);
    }
    for (const [messageIndex, message] of interaction.request.messages.entries()) {
      if (!isRecord(message) || !["system", "user", "assistant", "tool"].includes(message.role) || !(typeof message.content === "string" || message.content === null)) {
        throw new Error(`interaction ${index + 1} message ${messageIndex + 1} is invalid`);
      }
    }
    for (const [callIndex, call] of interaction.response.toolCalls.entries()) {
      if (!isRecord(call) || typeof call.id !== "string" || typeof call.name !== "string" || !isRecord(call.arguments)) {
        throw new Error(`interaction ${index + 1} tool call ${callIndex + 1} is invalid`);
      }
    }
  });
}

function validateMetadata(metadata: Record<string, any>): void {
  if (typeof metadata.name !== "string" || !metadata.name) throw new Error("metadata.name must be a non-empty string");
  if (!validDate(metadata.createdAt) || !validDate(metadata.updatedAt)) throw new Error("metadata timestamps must be ISO-8601 dates");
  if (!isRecord(metadata.producer) || typeof metadata.producer.name !== "string" || typeof metadata.producer.version !== "string") throw new Error("metadata.producer is invalid");
  if (!isRecord(metadata.runtime) || typeof metadata.runtime.name !== "string" || typeof metadata.runtime.version !== "string") throw new Error("metadata.runtime is invalid");
  if (!isRecord(metadata.redaction) || typeof metadata.redaction.enabled !== "boolean" || typeof metadata.redaction.policy !== "string") throw new Error("metadata.redaction is invalid");
}

function validDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function diffValues(recorded: unknown, current: unknown, pointer = "$", output: string[] = []): string[] {
  if (output.length >= 12 || Object.is(recorded, current)) return output;
  if (Array.isArray(recorded) && Array.isArray(current)) {
    if (recorded.length !== current.length) output.push(`${pointer}.length: ${recorded.length} → ${current.length}`);
    for (let index = 0; index < Math.min(recorded.length, current.length); index++) diffValues(recorded[index], current[index], `${pointer}[${index}]`, output);
    return output;
  }
  if (isRecord(recorded) && isRecord(current)) {
    for (const key of new Set([...Object.keys(recorded), ...Object.keys(current)])) diffValues(recorded[key], current[key], `${pointer}.${key}`, output);
    return output;
  }
  output.push(`${pointer}: ${preview(recorded)} → ${preview(current)}`);
  return output;
}

function preview(value: unknown): string {
  const text = redactText(canonicalStringify(value));
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function cassetteFilename(name: string): string {
  const safe = slug(name);
  const normalized = name.toLowerCase();
  return normalized === safe ? `${safe}.json` : `${safe || "cassette"}--${createHash("sha256").update(name).digest("hex").slice(0, 10)}.json`;
}

function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictMode(dir, 0o700);
}

function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const started = Date.now();
  while (true) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true }); }
      catch { /* another writer released it */ }
      if (Date.now() - started > 5_000) throw new Error(`Timed out waiting for cassette lock ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      void error;
    }
  }
  try { return fn(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

function atomicWritePrivate(file: string, value: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, value, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
    restrictMode(file, 0o600);
  } finally { rmSync(temp, { force: true }); }
}

function restrictMode(target: string, mode: number): void { if (process.platform !== "win32") chmodSync(target, mode); }

function gitSha(): string | undefined {
  const envSha = process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA;
  if (envSha) return envSha.slice(0, 40);
  try {
    const gitDir = path.resolve(".git");
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head.slice(0, 40);
    return readFileSync(path.join(gitDir, head.slice(5)), "utf8").trim().slice(0, 40);
  } catch { return undefined; }
}

function indentLines(value: string, prefix: string): string { return value.split("\n").map((line) => `${prefix}${line}`).join("\n"); }
