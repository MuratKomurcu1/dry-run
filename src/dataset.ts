import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalStringify } from "./cassette.ts";
import { atomicWriteJson, sha256, slug } from "./storage.ts";

export interface ExpectedToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface RetrievalResult {
  id: string;
  text?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export type ConversationRole = "system" | "user" | "assistant" | "tool";
export type MediaKind = "image" | "audio" | "video" | "document";

export interface DatasetMedia {
  id: string;
  kind: MediaKind;
  mimeType: string;
  uri?: string;
  sha256?: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
  transcript?: string;
  ocrText?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationTurn {
  role: ConversationRole;
  content: string;
  name?: string;
  toolCallId?: string;
  media?: DatasetMedia[];
  expectedTools?: ExpectedToolCall[];
  metadata?: Record<string, unknown>;
}

export interface DatasetCase<Input = unknown, Expected = unknown> {
  id?: string;
  name?: string;
  input: Input;
  expected?: Expected;
  context?: string[];
  retrievalContext?: string[];
  retrievalResults?: RetrievalResult[];
  expectedRetrievalIds?: string[];
  expectedCitations?: string[];
  expectedTools?: ExpectedToolCall[];
  turns?: ConversationTurn[];
  expectedTurns?: ConversationTurn[];
  media?: DatasetMedia[];
  expectedFacts?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  comments?: string;
}

export interface DatasetDocument<Input = unknown, Expected = unknown> {
  kind: "dry-run.dataset";
  version: 1;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  cases: DatasetCase<Input, Expected>[];
  checksum: string;
}

export interface DatasetCreateOptions {
  description?: string;
  createdAt?: string;
}

export class Dataset<Input = unknown, Expected = unknown> {
  readonly document: DatasetDocument<Input, Expected>;

  private constructor(document: DatasetDocument<Input, Expected>) {
    this.document = validateDatasetDocument(document);
  }

  static create<Input = unknown, Expected = unknown>(
    name: string,
    cases: DatasetCase<Input, Expected>[],
    opts: DatasetCreateOptions = {},
  ): Dataset<Input, Expected> {
    if (!name.trim()) throw new Error("Dataset name cannot be empty");
    const createdAt = opts.createdAt ?? new Date().toISOString();
    const normalized = normalizeCases(cases);
    return new Dataset(finalizeDataset({
      kind: "dry-run.dataset",
      version: 1,
      name,
      ...(opts.description ? { description: opts.description } : {}),
      createdAt,
      updatedAt: createdAt,
      cases: normalized,
      checksum: "",
    }));
  }

  static parse<Input = unknown, Expected = unknown>(value: unknown): Dataset<Input, Expected> {
    if (Array.isArray(value)) {
      return Dataset.create("dataset", value as DatasetCase<Input, Expected>[]);
    }
    if (!isRecord(value)) throw new Error("Dataset must be a document object or case array");
    return new Dataset(value as unknown as DatasetDocument<Input, Expected>);
  }

  static load<Input = unknown, Expected = unknown>(file: string): Dataset<Input, Expected> {
    const ext = path.extname(file).toLowerCase();
    const source = readFileSync(file, "utf8");
    if (ext === ".jsonl" || ext === ".ndjson") {
      const cases = source.split(/\r?\n/).filter(Boolean).map((line, index) => {
        try { return JSON.parse(line) as DatasetCase<Input, Expected>; }
        catch (error) { throw new Error(`Invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
      });
      return Dataset.create(path.basename(file, ext), cases);
    }
    if (ext === ".csv") {
      return Dataset.create(path.basename(file, ext), parseCsvDataset(source) as DatasetCase<Input, Expected>[]);
    }
    try {
      return Dataset.parse<Input, Expected>(JSON.parse(source));
    } catch (error) {
      throw new Error(`Cannot load dataset ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get name(): string { return this.document.name; }
  get cases(): DatasetCase<Input, Expected>[] { return this.document.cases; }
  get checksum(): string { return this.document.checksum; }

  save(file = path.join(".dryrun", "datasets", `${slug(this.name)}.json`)): void {
    atomicWriteJson(file, finalizeDataset(structuredClone(this.document)));
  }

  filter(predicate: (item: DatasetCase<Input, Expected>, index: number) => boolean, name = this.name): Dataset<Input, Expected> {
    return Dataset.create(name, this.cases.filter(predicate), {
      description: this.document.description,
      createdAt: this.document.createdAt,
    });
  }

  tagged(tags: string[], name = this.name): Dataset<Input, Expected> {
    return this.filter((item) => tags.every((tag) => item.tags?.includes(tag)), name);
  }

  split(ratio = 0.8): { train: Dataset<Input, Expected>; test: Dataset<Input, Expected> } {
    if (!(ratio > 0 && ratio < 1)) throw new Error("Dataset split ratio must be between 0 and 1");
    if (this.cases.length < 2) throw new Error("Dataset split requires at least two cases");
    const ranked = [...this.cases].sort((a, b) => stableRank(a).localeCompare(stableRank(b)));
    const boundary = Math.max(1, Math.min(ranked.length - 1, Math.round(ranked.length * ratio)));
    return {
      train: Dataset.create(`${this.name}-train`, ranked.slice(0, boundary), { description: this.document.description }),
      test: Dataset.create(`${this.name}-test`, ranked.slice(boundary), { description: this.document.description }),
    };
  }
}

export function validateDatasetDocument<Input, Expected>(document: DatasetDocument<Input, Expected>): DatasetDocument<Input, Expected> {
  if (document.kind !== "dry-run.dataset" || document.version !== 1) throw new Error("Unsupported dataset kind/version");
  if (!document.name?.trim() || !Array.isArray(document.cases)) throw new Error("Dataset requires a name and cases array");
  if (!document.createdAt || !document.updatedAt || typeof document.checksum !== "string") throw new Error("Dataset metadata is incomplete");
  document.cases = normalizeCases(document.cases);
  const actual = datasetChecksum(document.cases);
  if (document.checksum && document.checksum !== actual) throw new Error("Dataset checksum mismatch; file is corrupt or was edited without finalization");
  document.checksum = actual;
  return document;
}

export function finalizeDataset<Input, Expected>(document: DatasetDocument<Input, Expected>): DatasetDocument<Input, Expected> {
  document.cases = normalizeCases(document.cases);
  document.updatedAt = new Date().toISOString();
  document.checksum = datasetChecksum(document.cases);
  return document;
}

function normalizeCases<Input, Expected>(cases: DatasetCase<Input, Expected>[]): DatasetCase<Input, Expected>[] {
  if (!Array.isArray(cases)) throw new Error("Dataset cases must be an array");
  const ids = new Set<string>();
  return cases.map((item, index) => {
    if (!isRecord(item) || !("input" in item)) throw new Error(`Dataset case ${index + 1} requires input`);
    if (item.tags != null && (!Array.isArray(item.tags) || !item.tags.every((tag) => typeof tag === "string" && tag.length > 0))) {
      throw new Error(`Dataset case ${index + 1} has invalid tags`);
    }
    if (item.expectedTools != null && (!Array.isArray(item.expectedTools) || !item.expectedTools.every(validExpectedTool))) {
      throw new Error(`Dataset case ${index + 1} has invalid expectedTools`);
    }
    if (item.retrievalResults != null && (!Array.isArray(item.retrievalResults) || !item.retrievalResults.every(validRetrievalResult))) {
      throw new Error(`Dataset case ${index + 1} has invalid retrievalResults`);
    }
    if (item.expectedRetrievalIds != null && !validStringList(item.expectedRetrievalIds)) throw new Error(`Dataset case ${index + 1} has invalid expectedRetrievalIds`);
    if (item.expectedCitations != null && !validStringList(item.expectedCitations)) throw new Error(`Dataset case ${index + 1} has invalid expectedCitations`);
    if (item.expectedFacts != null && !validStringList(item.expectedFacts)) throw new Error(`Dataset case ${index + 1} has invalid expectedFacts`);
    if (item.turns != null && (!Array.isArray(item.turns) || !item.turns.length || !item.turns.every(validConversationTurn))) throw new Error(`Dataset case ${index + 1} has invalid turns`);
    if (item.expectedTurns != null && (!Array.isArray(item.expectedTurns) || !item.expectedTurns.every(validConversationTurn))) throw new Error(`Dataset case ${index + 1} has invalid expectedTurns`);
    if (item.media != null && (!Array.isArray(item.media) || !item.media.every(validDatasetMedia))) throw new Error(`Dataset case ${index + 1} has invalid media`);
    assertJsonSerializable(item, `Dataset case ${index + 1}`);
    const id = item.id?.trim() || `case_${sha256(canonicalStringify([item.input, item.expected, index])).slice(7, 19)}`;
    if (ids.has(id)) throw new Error(`Duplicate dataset case id: ${id}`);
    ids.add(id);
    return { ...item, id };
  });
}

function datasetChecksum(cases: DatasetCase[]): string {
  return sha256(canonicalStringify(cases));
}

function stableRank(item: DatasetCase): string {
  return sha256(canonicalStringify([item.id, item.input, item.expected]));
}

function validExpectedTool(value: unknown): value is ExpectedToolCall {
  return isRecord(value) && typeof value.name === "string" && value.name.length > 0 &&
    (value.arguments == null || isRecord(value.arguments));
}

function validRetrievalResult(value: unknown): value is RetrievalResult {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0 &&
    (value.text == null || typeof value.text === "string") &&
    (value.score == null || typeof value.score === "number" && Number.isFinite(value.score)) &&
    (value.metadata == null || isRecord(value.metadata));
}

function validConversationTurn(value: unknown): value is ConversationTurn {
  return isRecord(value)
    && ["system", "user", "assistant", "tool"].includes(String(value.role))
    && typeof value.content === "string"
    && (value.name == null || typeof value.name === "string" && value.name.length > 0)
    && (value.toolCallId == null || typeof value.toolCallId === "string" && value.toolCallId.length > 0)
    && (value.media == null || Array.isArray(value.media) && value.media.every(validDatasetMedia))
    && (value.expectedTools == null || Array.isArray(value.expectedTools) && value.expectedTools.every(validExpectedTool))
    && (value.metadata == null || isRecord(value.metadata));
}

function validDatasetMedia(value: unknown): value is DatasetMedia {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() || !["image", "audio", "video", "document"].includes(String(value.kind))) return false;
  if (typeof value.mimeType !== "string" || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value.mimeType)) return false;
  if (value.uri != null && (typeof value.uri !== "string" || value.uri.length > 4096)) return false;
  if (value.sha256 != null && (typeof value.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(value.sha256))) return false;
  for (const field of ["bytes", "width", "height", "durationMs"] as const) if (value[field] != null && (!Number.isSafeInteger(value[field]) || value[field] < 0)) return false;
  for (const field of ["altText", "transcript", "ocrText"] as const) if (value[field] != null && (typeof value[field] !== "string" || value[field].length > 1_000_000)) return false;
  return value.metadata == null || isRecord(value.metadata);
}

function validStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function assertJsonSerializable(value: unknown, label: string): void {
  try {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error("serialized to undefined");
  } catch (error) {
    throw new Error(`${label} is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseCsvDataset(source: string): DatasetCase[] {
  const rows = parseCsv(source);
  if (rows.length < 2) throw new Error("CSV dataset requires a header and at least one case");
  const headers = rows[0].map((value) => value.trim());
  if (!headers.includes("input")) throw new Error("CSV dataset requires an input column");
  return rows.slice(1).filter((row) => row.some(Boolean)).map((row) => {
    const values = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
    return {
      ...(values.id ? { id: values.id } : {}),
      ...(values.name ? { name: values.name } : {}),
      input: parseCell(values.input),
      ...(values.expected ? { expected: parseCell(values.expected) } : {}),
      ...(values.tags ? { tags: values.tags.split(/[|,]/).map((tag) => tag.trim()).filter(Boolean) } : {}),
      ...(values.metadata ? { metadata: parseObjectCell(values.metadata, "metadata") } : {}),
      ...(values.context ? { context: parseStringArrayCell(values.context) } : {}),
      ...(values.retrievalContext ? { retrievalContext: parseStringArrayCell(values.retrievalContext) } : {}),
      ...(values.comments ? { comments: values.comments } : {}),
    };
  });
}

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell); cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function parseCell(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(?:\{|\[|true$|false$|null$|-?\d)/.test(trimmed)) {
    try { return JSON.parse(trimmed); } catch { return value; }
  }
  return value;
}

function parseObjectCell(value: string, label: string): Record<string, unknown> {
  const parsed = parseCell(value);
  if (!isRecord(parsed)) throw new Error(`CSV ${label} must contain a JSON object`);
  return parsed;
}

function parseStringArrayCell(value: string): string[] {
  const parsed = parseCell(value);
  if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  return value.split("|").map((item) => item.trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
