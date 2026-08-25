import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface DryrunConfig {
  include?: string[];
  mode?: "auto" | "record" | "replay" | "passthrough";
  junitPath?: string;
  judge?: {
    provider?: "openai" | "anthropic";
    model?: string;
  };
}

export const CONFIG_FILE = "dryrun.config.json";

export function loadConfig(cwd = process.cwd()): DryrunConfig {
  const file = path.join(cwd, CONFIG_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as DryrunConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (e) {
    throw new Error(
      `${CONFIG_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
