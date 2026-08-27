import { OpenAIProvider } from "./providers/openai.ts";
import type { LLMProvider } from "./types.ts";

export interface LocalJudgeProfile {
  kind: "ollama" | "openai-compatible";
  endpoint: string;
  model: string;
  availableModels: string[];
  detectedAt: string;
}

export interface DiscoverLocalJudgeOptions {
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export async function discoverLocalJudge(opts: DiscoverLocalJudgeOptions = {}): Promise<LocalJudgeProfile | undefined> {
  const timeoutMs = boundedInteger(opts.timeoutMs ?? 700, 100, 10_000, "Local judge timeout");
  const request = opts.fetch ?? fetch;
  const explicit = opts.endpoint ?? process.env.DRYRUN_LOCAL_JUDGE_URL;
  const candidates = explicit
    ? [candidateFromEndpoint(explicit)]
    : [
        { kind: "ollama" as const, endpoint: "http://127.0.0.1:11434/v1", probe: "http://127.0.0.1:11434/api/tags" },
        { kind: "openai-compatible" as const, endpoint: "http://127.0.0.1:8000/v1", probe: "http://127.0.0.1:8000/v1/models" },
        { kind: "openai-compatible" as const, endpoint: "http://127.0.0.1:1234/v1", probe: "http://127.0.0.1:1234/v1/models" },
      ];
  const preferred = opts.model ?? process.env.DRYRUN_LOCAL_JUDGE_MODEL;
  const attempts = await Promise.all(candidates.map(async (candidate) => {
    try {
      const response = await request(candidate.probe, { signal: AbortSignal.timeout(timeoutMs), redirect: "error", headers: { Accept: "application/json" } });
      if (!response.ok) return undefined;
      const body = await response.json() as unknown;
      const models = modelIds(body, candidate.kind);
      if (!models.length && !preferred) return undefined;
      return {
        kind: candidate.kind,
        endpoint: candidate.endpoint,
        model: preferred ?? pickJudgeModel(models),
        availableModels: models,
        detectedAt: new Date().toISOString(),
      } satisfies LocalJudgeProfile;
    } catch { return undefined; }
  }));
  return attempts.find(Boolean);
}

export function createLocalJudge(profile: LocalJudgeProfile): LLMProvider {
  validateLocalEndpoint(profile.endpoint);
  if (!profile.model.trim()) throw new Error("Local judge model cannot be empty");
  return new OpenAIProvider({ baseURL: profile.endpoint, apiKey: "dry-run-local", model: profile.model });
}

export async function testLocalJudge(profile: LocalJudgeProfile, opts: { timeoutMs?: number } = {}): Promise<{ ok: true; model: string; endpoint: string; response: string; durationMs: number }> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("local judge test timed out")), boundedInteger(opts.timeoutMs ?? 15_000, 100, 120_000, "Local judge test timeout"));
  timer.unref?.();
  try {
    const response = await createLocalJudge(profile).chat({
      model: profile.model,
      messages: [{ role: "user", content: "Return exactly DRYRUN_LOCAL_JUDGE_OK" }],
      temperature: 0,
      maxTokens: 32,
      signal: controller.signal,
    });
    if (!(response.text ?? "").includes("DRYRUN_LOCAL_JUDGE_OK")) throw new Error(`unexpected local judge response: ${(response.text ?? "").slice(0, 120)}`);
    return { ok: true, model: profile.model, endpoint: profile.endpoint, response: response.text!, durationMs: Math.round(performance.now() - started) };
  } finally { clearTimeout(timer); }
}

export function validateLocalEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Local judge endpoint must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("Local judge endpoint cannot contain credentials, query, or fragment");
  const host = url.hostname.toLowerCase();
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Local judge auto-configuration only permits loopback endpoints");
  return url;
}

function candidateFromEndpoint(value: string): { kind: "ollama" | "openai-compatible"; endpoint: string; probe: string } {
  const url = validateLocalEndpoint(value);
  const normalized = url.toString().replace(/\/+$/, "");
  const looksOllama = url.port === "11434" || /ollama/i.test(normalized);
  if (looksOllama) {
    const origin = url.origin;
    return { kind: "ollama", endpoint: normalized.endsWith("/v1") ? normalized : `${origin}/v1`, probe: `${origin}/api/tags` };
  }
  const endpoint = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
  return { kind: "openai-compatible", endpoint, probe: `${endpoint}/models` };
}

function modelIds(value: unknown, kind: LocalJudgeProfile["kind"]): string[] {
  if (!isRecord(value)) return [];
  const raw = kind === "ollama" ? value.models : value.data;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.flatMap((item) => isRecord(item) && typeof (item.name ?? item.model ?? item.id) === "string" ? [String(item.name ?? item.model ?? item.id)] : []))];
}

function pickJudgeModel(models: string[]): string {
  const priorities = [/qwen3/i, /qwen2\.5/i, /llama3\.3/i, /llama3\.2/i, /gemma3/i, /mistral/i, /phi4/i];
  for (const pattern of priorities) {
    const match = models.find((model) => pattern.test(model) && !/embed/i.test(model));
    if (match) return match;
  }
  return models.find((model) => !/embed/i.test(model)) ?? models[0];
}

function boundedInteger(value: number, min: number, max: number, label: string): number { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`); return value; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
