import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictMode(dir, 0o700);
}

export function atomicWritePrivate(file: string, value: string): void {
  ensurePrivateDirectory(path.dirname(path.resolve(file)));
  const temp = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, value, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
    restrictMode(file, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function atomicWriteJson(file: string, value: unknown): void {
  atomicWritePrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export async function withFileLock<T>(
  file: string,
  fn: () => T | Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const lock = `${file}.lock`;
  ensurePrivateDirectory(path.dirname(path.resolve(file)));
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > timeoutMs) {
          rmSync(lock, { recursive: true, force: true });
        }
      } catch {
        // The owner released the lock between stat and removal.
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for storage lock ${lock}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return result || "unnamed";
}

export function currentGitSha(cwd = process.cwd()): string | undefined {
  const envSha = process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA;
  if (envSha) return envSha.slice(0, 40);
  try {
    const gitPath = path.resolve(cwd, ".git");
    const head = readFileSync(path.join(gitPath, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head.slice(0, 40);
    return readFileSync(path.join(gitPath, head.slice(5)), "utf8").trim().slice(0, 40);
  } catch {
    return undefined;
  }
}

function restrictMode(target: string, mode: number): void {
  if (process.platform !== "win32") chmodSync(target, mode);
}
