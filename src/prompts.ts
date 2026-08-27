import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { canonicalStringify } from "./cassette.ts";
import { atomicWriteJson, ensurePrivateDirectory, readJsonFile, sha256, slug, withFileLock } from "./storage.ts";

export interface PromptVersion {
  version: number;
  template: string;
  variables: string[];
  checksum: string;
  createdAt: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface PromptDocument {
  kind: "dry-run.prompt";
  version: 1;
  name: string;
  createdAt: string;
  updatedAt: string;
  versions: PromptVersion[];
  labels: Record<string, number>;
}

export interface PublishPromptOptions {
  variables?: string[];
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  label?: string;
}

export interface RenderedPrompt {
  name: string;
  version: number;
  checksum: string;
  text: string;
}

export interface PromptPage {
  items: PromptDocument[];
  limit: number;
  scanned: number;
  hasMore: boolean;
  nextCursor?: string;
}

export class PromptRegistry {
  readonly dir: string;

  constructor(dir = path.resolve(".dryrun/prompts")) {
    this.dir = dir;
    ensurePrivateDirectory(dir);
  }

  file(name: string): string {
    validateName(name);
    return path.join(this.dir, `${slug(name)}-${sha256(name).slice(7, 15)}.json`);
  }

  async publish(name: string, template: string, opts: PublishPromptOptions = {}): Promise<PromptVersion> {
    validateName(name);
    if (!template.trim()) throw new Error("Prompt template cannot be empty");
    const discovered = templateVariables(template);
    const variables = opts.variables ? uniqueVariables(opts.variables) : discovered;
    const undeclared = discovered.filter((variable) => !variables.includes(variable));
    if (undeclared.length) throw new Error(`Prompt template uses undeclared variables: ${undeclared.join(", ")}`);
    validateJson(opts.metadata, "Prompt metadata");
    const checksum = promptChecksum(template, variables);
    const file = this.file(name);
    return withFileLock(file, () => {
      const now = new Date().toISOString();
      const document = existsSync(file)
        ? validatePrompt(readJsonFile(file))
        : { kind: "dry-run.prompt" as const, version: 1 as const, name, createdAt: now, updatedAt: now, versions: [], labels: {} };
      if (document.name !== name) throw new Error("Prompt registry filename collision");
      const existing = document.versions.find((version) => version.checksum === checksum);
      if (existing) {
        if (opts.label) setLabel(document, opts.label, existing.version);
        document.updatedAt = now;
        atomicWriteJson(file, document);
        return existing;
      }
      const record: PromptVersion = {
        version: (document.versions.at(-1)?.version ?? 0) + 1,
        template,
        variables,
        checksum,
        createdAt: now,
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.tags ? { tags: uniqueStrings(opts.tags, "prompt tags") } : {}),
        ...(opts.metadata ? { metadata: structuredClone(opts.metadata) } : {}),
      };
      document.versions.push(record);
      document.labels.latest = record.version;
      if (opts.label) setLabel(document, opts.label, record.version);
      document.updatedAt = now;
      atomicWriteJson(file, document);
      return record;
    });
  }

  load(name: string): PromptDocument {
    const document = validatePrompt(readJsonFile(this.file(name)));
    if (document.name !== name) throw new Error(`Prompt name mismatch: expected ${name}, found ${document.name}`);
    return document;
  }

  get(name: string, versionOrLabel: number | string = "latest"): PromptVersion {
    const document = this.load(name);
    const version = typeof versionOrLabel === "number" ? versionOrLabel : document.labels[versionOrLabel];
    if (!Number.isInteger(version)) throw new Error(`Unknown prompt label: ${versionOrLabel}`);
    const record = document.versions.find((candidate) => candidate.version === version);
    if (!record) throw new Error(`Unknown prompt version: ${name}@${version}`);
    return structuredClone(record);
  }

  async label(name: string, version: number, label: string): Promise<void> {
    const file = this.file(name);
    await withFileLock(file, () => {
      const document = validatePrompt(readJsonFile(file));
      if (!document.versions.some((candidate) => candidate.version === version)) throw new Error(`Unknown prompt version: ${name}@${version}`);
      setLabel(document, label, version);
      document.updatedAt = new Date().toISOString();
      atomicWriteJson(file, document);
    });
  }

  render(name: string, values: Record<string, unknown>, versionOrLabel: number | string = "latest"): RenderedPrompt {
    const prompt = this.get(name, versionOrLabel);
    const missing = prompt.variables.filter((variable) => !(variable in values));
    if (missing.length) throw new Error(`Missing prompt variables: ${missing.join(", ")}`);
    const text = prompt.template.replace(/{{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*}}/g, (_match, variable: string) => renderValue(values[variable]));
    return { name, version: prompt.version, checksum: prompt.checksum, text };
  }

  list(): PromptDocument[] {
    if (!existsSync(this.dir)) return [];
    const documents: PromptDocument[] = [];
    for (const file of readdirSync(this.dir).filter((candidate) => candidate.endsWith(".json"))) {
      try { documents.push(validatePrompt(readJsonFile(path.join(this.dir, file)))); }
      catch { /* Ignore unrelated or incomplete files. */ }
    }
    return documents.sort((left, right) => left.name.localeCompare(right.name));
  }

  page(opts: { limit?: number; cursor?: string } = {}): PromptPage {
    const limit = pageLimit(opts.limit ?? 100);
    const names = existsSync(this.dir) ? readdirSync(this.dir).filter((candidate) => candidate.endsWith(".json")).sort() : [];
    const after = pageCursor(opts.cursor);
    let index = after ? names.findIndex((name) => name > after) : 0;
    if (index < 0) index = names.length;
    const items: PromptDocument[] = [];
    let scanned = 0;
    let lastScanned: string | undefined;
    while (index < names.length && scanned < limit && items.length < limit) {
      const name = names[index++];
      lastScanned = name;
      scanned += 1;
      try { items.push(validatePrompt(readJsonFile(path.join(this.dir, name)))); }
      catch { /* Invalid files still advance the cursor. */ }
    }
    return { items, limit, scanned, hasMore: index < names.length, ...(lastScanned && index < names.length ? { nextCursor: Buffer.from(lastScanned).toString("base64url") } : {}) };
  }
}

function pageLimit(value: number): number { if (!Number.isInteger(value) || value < 1 || value > 500) throw new Error("Prompt page limit must be between 1 and 500"); return value; }
function pageCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  if (cursor.length > 512) throw new Error("Prompt cursor is invalid");
  const value = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^[a-zA-Z0-9_.-]+\.json$/.test(value)) throw new Error("Prompt cursor is invalid");
  return value;
}

function validatePrompt(value: unknown): PromptDocument {
  if (!isRecord(value) || value.kind !== "dry-run.prompt" || value.version !== 1 || typeof value.name !== "string" || !Array.isArray(value.versions) || !isRecord(value.labels)) {
    throw new Error("Unsupported prompt document");
  }
  let previous = 0;
  for (const record of value.versions) {
    if (!isRecord(record) || !Number.isInteger(record.version) || record.version <= previous || typeof record.template !== "string" || !Array.isArray(record.variables)) {
      throw new Error("Prompt contains an invalid or non-monotonic version");
    }
    if (record.checksum !== promptChecksum(record.template, record.variables)) throw new Error(`Prompt checksum mismatch at version ${record.version}`);
    previous = record.version;
  }
  for (const [label, version] of Object.entries(value.labels)) {
    validateLabel(label);
    if (!Number.isInteger(version) || !value.versions.some((record: any) => record.version === version)) throw new Error(`Prompt label ${label} points to an unknown version`);
  }
  return value as unknown as PromptDocument;
}

function promptChecksum(template: string, variables: string[]): string {
  return sha256(canonicalStringify({ template, variables: [...variables].sort() }));
}

function templateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(/{{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*}}/g)].map((match) => match[1]))].sort();
}

function uniqueVariables(values: string[]): string[] {
  return uniqueStrings(values, "prompt variables").map((value) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(value)) throw new Error(`Invalid prompt variable: ${value}`);
    return value;
  }).sort();
}

function uniqueStrings(values: string[], label: string): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) throw new Error(`${label} must contain non-empty strings`);
  return [...new Set(values)];
}

function setLabel(document: PromptDocument, label: string, version: number): void {
  validateLabel(label);
  document.labels[label] = version;
}

function validateLabel(label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(label)) throw new Error(`Invalid prompt label: ${label}`);
}

function validateName(name: string): void {
  if (!name.trim() || name.length > 128) throw new Error("Prompt name must contain 1-128 characters");
}

function validateJson(value: unknown, label: string): void {
  if (value == null) return;
  try { JSON.stringify(value); }
  catch (error) { throw new Error(`${label} must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`); }
}

function renderValue(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
