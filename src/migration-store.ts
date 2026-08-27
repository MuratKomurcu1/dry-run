import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MigrationBundle } from "./integrations/migrations.ts";
import { atomicWriteJson, ensurePrivateDirectory, newId, readJsonFile, withFileLock } from "./storage.ts";

export interface StoredMigration {
  kind: "dry-run.stored-migration";
  version: 1;
  id: string;
  importedAt: string;
  bundle: MigrationBundle;
}

export class MigrationStore {
  readonly dir: string;
  constructor(dir: string) { this.dir = path.resolve(dir); ensurePrivateDirectory(this.dir); }
  async save(bundle: MigrationBundle): Promise<StoredMigration> {
    validateBundle(bundle);
    const stored: StoredMigration = { kind: "dry-run.stored-migration", version: 1, id: newId("migration"), importedAt: new Date().toISOString(), bundle: structuredClone(bundle) };
    const file = this.file(stored.id);
    await withFileLock(file, () => atomicWriteJson(file, stored));
    return stored;
  }
  load(id: string): StoredMigration { return validateStored(readJsonFile(this.file(id))); }
  list(): StoredMigration[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((name) => name.endsWith(".json")).flatMap((name) => {
      try { return [validateStored(readJsonFile(path.join(this.dir, name)))]; } catch { return []; }
    }).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  }
  private file(id: string): string { if (!/^[A-Za-z0-9_.-]{1,256}$/.test(id)) throw new Error("Migration id is invalid"); return path.join(this.dir, `${id}.json`); }
}

function validateStored(value: unknown): StoredMigration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored migration is invalid");
  const record = value as StoredMigration;
  if (record.kind !== "dry-run.stored-migration" || record.version !== 1 || !/^[A-Za-z0-9_.-]{1,256}$/.test(record.id) || !Number.isFinite(Date.parse(record.importedAt))) throw new Error("Stored migration is invalid");
  validateBundle(record.bundle);
  return record;
}
function validateBundle(bundle: MigrationBundle): void { if (!bundle || bundle.kind !== "dry-run.migration" || bundle.version !== 1 || !["deepeval", "langfuse", "braintrust"].includes(bundle.source) || !Array.isArray(bundle.datasets) || !Array.isArray(bundle.traces)) throw new Error("Migration bundle is invalid"); }
