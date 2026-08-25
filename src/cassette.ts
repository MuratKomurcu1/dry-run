import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ChatRequest, ChatResponse, LLMProvider } from "./types.ts";

export interface Interaction {
  request: ChatRequest;
  response: ChatResponse;
}

export class CassetteStore {
  #dir: string;

  constructor(dir = ".dryrun/cassettes") {
    this.#dir = dir;
  }

  #file(name: string): string {
    return path.join(this.#dir, `${slug(name)}.json`);
  }

  exists(name: string): boolean {
    return existsSync(this.#file(name));
  }

  loadSync(name: string): Interaction[] {
    const file = this.#file(name);
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("expected an array of recorded interactions");
      }
      return parsed as Interaction[];
    } catch (error) {
      throw new Error(
        `Cassette "${file}" is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async load(name: string): Promise<Interaction[]> {
    return this.loadSync(name);
  }

  saveSync(name: string, interactions: Interaction[]): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    restrictMode(this.#dir, 0o700);
    atomicWritePrivate(this.#file(name), JSON.stringify(interactions, null, 2));
  }

  async save(name: string, interactions: Interaction[]): Promise<void> {
    this.saveSync(name, interactions);
  }

  fileFor(name: string): string {
    return this.#file(name);
  }
}

export type CassetteMode = "auto" | "record" | "replay" | "passthrough";

export function currentCassetteMode(): CassetteMode {
  const raw = (process.env.DRYRUN_MODE ?? "").toLowerCase();
  if (!raw) return "auto";
  if (raw === "record" || raw === "replay" || raw === "passthrough" || raw === "auto") {
    return raw;
  }
  throw new Error(
    `Invalid DRYRUN_MODE "${raw}". Expected auto, record, replay, or passthrough.`,
  );
}

export function describeRequest(req: ChatRequest): string {
  const roles = req.messages.map((m) => m.role).join(",");
  const calls = req.messages.flatMap((m) => m.toolCalls?.map((c) => c.name) ?? []);
  const tools = req.tools?.map((t) => t.name) ?? [];
  return `model=${req.model || "(provider default)"} messages=[${roles}]` +
    (calls.length ? ` toolCalls=[${calls.join(",")}]` : "") +
    (tools.length ? ` tools=[${tools.join(",")}]` : "");
}

export function requestSignature(req: ChatRequest): string {
  return JSON.stringify({
    model: req.model || null,
    roles: req.messages.map((m) => m.role),
    toolCalls: req.messages.flatMap((m) => m.toolCalls?.map((c) => c.name) ?? []),
    tools: req.tools?.map((t) => t.name) ?? [],
  });
}

const SECRET_KEY = /(authorization|api[-_]?key|apikey|secret|token|password|passwd|cookie|session)/i;

const SECRET_PATTERNS: RegExp[] = [
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

function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export function redactText(value: string): string {
  return redactString(value);
}

export function redactDeep<T>(value: T, enabled = true): T {
  if (!enabled) return value;
  return walk(value) as T;
}

function walk(v: unknown): unknown {
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && typeof val !== "object" ? "[REDACTED]" : walk(val);
    }
    return out;
  }
  return v;
}

export interface RecorderOptions {
  redact?: boolean;
}

export function recorder(
  provider: LLMProvider,
  store: CassetteStore,
  cassetteName: string,
  opts: RecorderOptions = {},
): LLMProvider {
  const redact = opts.redact ?? process.env.DRYRUN_NO_REDACT !== "1";
  const interactions: Interaction[] = [];
  return {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await provider.chat(req);
    interactions.push({
      request: redactDeep(structuredClone(req), redact),
      response: redactDeep(structuredClone(res), redact),
    });
    store.saveSync(cassetteName, interactions);
    return res;
  },
  };
}

export function replayer(store: CassetteStore, cassetteName: string): LLMProvider {
  const interactions = store.loadSync(cassetteName);
  let i = 0;
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const next = interactions[i];
      if (!next) {
        throw new Error(
          `Cassette "${cassetteName}" exhausted (${interactions.length} interaction(s) replayed). ` +
            `The agent made an unexpected additional LLM call. Re-record with --record to capture it.`,
        );
      }
      i++;
      if (requestSignature(next.request) !== requestSignature(req)) {
        throw new Error(
          `Cassette "${cassetteName}" no longer matches at interaction ${i}. ` +
            `Recorded: ${describeRequest(next.request)}\n` +
            `  Now:     ${describeRequest(req)}\n` +
            `Prompt wording drift is tolerated, but the conversation shape changed. ` +
            `Re-record with --record if this change was intentional.`,
        );
      }
      return next.response;
    },
  };
}

export function autoCassette(
  cassetteName: string,
  makeProvider: () => LLMProvider,
  opts: { dir?: string; redact?: boolean } = {},
): LLMProvider {
  const store = new CassetteStore(opts.dir ?? process.env.DRYRUN_CASSETTE_DIR ?? undefined);
  const mode = currentCassetteMode();

  let resolved: LLMProvider | null = null;
  const resolve = (): LLMProvider => {
    if (!resolved) {
      if (mode === "passthrough") {
        resolved = makeProvider();
      } else if (mode === "record" || (mode === "auto" && !store.exists(cassetteName))) {
        resolved = recorder(makeProvider(), store, cassetteName, { redact: opts.redact });
      } else {
        resolved = replayer(store, cassetteName);
      }
    }
    return resolved;
  };

  return {
    chat(req) {
      return resolve().chat(req);
    },
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function atomicWritePrivate(file: string, value: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, value, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
    restrictMode(file, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}

function restrictMode(target: string, mode: number): void {
  if (process.platform === "win32") return;
  chmodSync(target, mode);
}
