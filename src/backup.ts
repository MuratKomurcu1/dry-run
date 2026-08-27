import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BackupFile {
  path: string;
  bytes: number;
  sha256: string;
  mode: number;
}

export interface TeamBackupManifest {
  kind: "dry-run.team-backup";
  version: 1;
  createdAt: string;
  files: BackupFile[];
  totals: { files: number; bytes: number };
}

const MANIFEST = "dryrun-backup.json";
const PAYLOAD = "workspace";

export async function createTeamBackup(sourceDir: string, destinationDir: string): Promise<TeamBackupManifest> {
  const source = path.resolve(sourceDir);
  const destination = path.resolve(destinationDir);
  if (destination === source || destination.startsWith(`${source}${path.sep}`)) throw new Error("Backup destination must be outside the workspace");
  const sourceInfo = await stat(source).catch(() => undefined);
  if (!sourceInfo?.isDirectory()) throw new Error("Team workspace does not exist");
  if (await stat(destination).catch(() => undefined)) throw new Error("Backup destination already exists");
  await mkdir(path.join(destination, PAYLOAD), { recursive: true, mode: 0o700 });
  try {
    const relativeFiles = await walkFiles(source);
    const files: BackupFile[] = [];
    for (const relative of relativeFiles) {
      const input = path.join(source, ...relative.split("/"));
      const output = path.join(destination, PAYLOAD, ...relative.split("/"));
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      const before = await stat(input);
      await copyFile(input, output);
      const after = await stat(input);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`Workspace changed while backing up ${relative}; retry or pause writes`);
      await chmod(output, before.mode & 0o777);
      const digest = await sha256File(output);
      files.push({ path: relative, bytes: before.size, sha256: digest, mode: before.mode & 0o777 });
    }
    const manifest: TeamBackupManifest = {
      kind: "dry-run.team-backup", version: 1, createdAt: new Date().toISOString(), files,
      totals: { files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) },
    };
    await writeExclusive(path.join(destination, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    return manifest;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyTeamBackup(backupDir: string): Promise<TeamBackupManifest> {
  const root = path.resolve(backupDir);
  const manifest = parseManifest(JSON.parse(await readFile(path.join(root, MANIFEST), "utf8")));
  const actual = await walkFiles(path.join(root, PAYLOAD));
  const expected = manifest.files.map((file) => file.path).sort();
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) throw new Error("Backup payload does not match its manifest");
  for (const file of manifest.files) {
    const target = path.join(root, PAYLOAD, ...file.path.split("/"));
    const info = await stat(target);
    if (!info.isFile() || info.size !== file.bytes || await sha256File(target) !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.path}`);
  }
  return manifest;
}

export async function restoreTeamBackup(backupDir: string, destinationDir: string, opts: { replace?: boolean } = {}): Promise<{ manifest: TeamBackupManifest; previous?: string }> {
  const backup = path.resolve(backupDir);
  const destination = path.resolve(destinationDir);
  if (destination === backup || destination.startsWith(`${backup}${path.sep}`)) throw new Error("Restore destination must be outside the backup");
  const manifest = await verifyTeamBackup(backup);
  const existing = await stat(destination).catch(() => undefined);
  if (existing && !opts.replace) throw new Error("Restore destination already exists; use an explicit replace operation");
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(parent, `.dryrun-restore-${randomBytes(8).toString("hex")}`);
  await mkdir(staging, { mode: 0o700 });
  let previous: string | undefined;
  try {
    for (const file of manifest.files) {
      const input = path.join(backup, PAYLOAD, ...file.path.split("/"));
      const output = path.join(staging, ...file.path.split("/"));
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      await copyFile(input, output);
      await chmod(output, file.mode);
    }
    if (existing) {
      previous = `${destination}.before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await rename(destination, previous);
    }
    await rename(staging, destination);
    return { manifest, ...(previous ? { previous } : {}) };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (previous && !await stat(destination).catch(() => undefined)) await rename(previous, destination).catch(() => undefined);
    throw error;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.endsWith(".lock") || entry.name.includes(".tmp-")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Backup refuses symbolic link: ${relative}`);
      if (entry.isDirectory()) await walk(full, relative);
      else if (entry.isFile()) result.push(relative);
      else throw new Error(`Backup refuses special file: ${relative}`);
    }
  }
  await walk(root, "");
  return result.sort();
}

async function sha256File(file: string): Promise<string> { return createHash("sha256").update(await readFile(file)).digest("hex"); }
async function writeExclusive(file: string, value: string, mode: number): Promise<void> { const handle = await open(file, "wx", mode); try { await handle.writeFile(value, "utf8"); await handle.sync(); } finally { await handle.close(); } }
function parseManifest(value: unknown): TeamBackupManifest {
  if (!isRecord(value) || value.kind !== "dry-run.team-backup" || value.version !== 1 || !Array.isArray(value.files) || !isRecord(value.totals)) throw new Error("Backup manifest is invalid");
  const files = value.files.map((candidate): BackupFile => {
    if (!isRecord(candidate) || typeof candidate.path !== "string" || !safeRelative(candidate.path) || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0 || typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256) || !Number.isInteger(candidate.mode)) throw new Error("Backup manifest contains an invalid file");
    return { path: candidate.path, bytes: candidate.bytes, sha256: candidate.sha256, mode: candidate.mode & 0o777 };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Backup manifest contains duplicate files");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("Backup manifest timestamp is invalid");
  return { kind: value.kind, version: 1, createdAt: new Date(value.createdAt).toISOString(), files: files.sort((a, b) => a.path.localeCompare(b.path)), totals: { files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) } };
}
function safeRelative(value: string): boolean { return value.length > 0 && value.length <= 2048 && !value.includes("\\") && !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== ".."); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
