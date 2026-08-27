import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface DryrunConfig {
  include?: string[];
  mode?: "auto" | "record" | "replay" | "passthrough";
  junitPath?: string;
  concurrency?: number;
  retries?: number;
  trials?: number;
  allowSkipped?: boolean;
  filter?: string;
  tags?: string[];
  excludeTags?: string[];
  judge?: {
    provider?: "openai" | "anthropic" | "local";
    model?: string;
  };
}

export const CONFIG_FILE = "dryrun.config.json";

export function loadConfig(cwd = process.cwd()): DryrunConfig {
  const file = path.join(cwd, CONFIG_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as DryrunConfig;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    validateConfig(parsed);
    return parsed;
  } catch (e) {
    throw new Error(
      `${CONFIG_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function validateConfig(config: DryrunConfig): void {
  if (config.include != null && !stringArray(config.include)) throw new Error("include must be an array of paths");
  if (config.mode != null && !["auto", "record", "replay", "passthrough"].includes(config.mode)) throw new Error("mode must be auto, record, replay, or passthrough");
  for (const [key, minimum] of [["concurrency", 1], ["retries", 0], ["trials", 1]] as const) {
    const value = config[key];
    if (value != null && (!Number.isInteger(value) || value < minimum)) throw new Error(`${key} must be an integer >= ${minimum}`);
  }
  if (config.tags != null && !stringArray(config.tags)) throw new Error("tags must be an array of strings");
  if (config.excludeTags != null && !stringArray(config.excludeTags)) throw new Error("excludeTags must be an array of strings");
  if (config.allowSkipped != null && typeof config.allowSkipped !== "boolean") throw new Error("allowSkipped must be boolean");
  if (config.filter != null && typeof config.filter !== "string") throw new Error("filter must be a string");
  if (config.junitPath != null && typeof config.junitPath !== "string") throw new Error("junitPath must be a string");
  if (config.judge != null) {
    if (typeof config.judge !== "object" || (config.judge.provider != null && !["openai", "anthropic", "local"].includes(config.judge.provider)) || (config.judge.model != null && typeof config.judge.model !== "string")) {
      throw new Error("judge must contain an openai/anthropic/local provider and string model");
    }
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}
