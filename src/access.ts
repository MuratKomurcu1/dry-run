import { existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { atomicWriteJson, ensurePrivateDirectory, readJsonFile, sha256, withFileLock } from "./storage.ts";

export type ObjectResourceType = "trace" | "experiment" | "prompt" | "annotation-queue" | "online-rule" | "playground-run" | "regression" | "quality-monitor";
export type ObjectGrantCapability = "read" | "annotate" | "manage-prompts";

export interface ObjectAccessGrant {
  subject: { type: "member" | "key" | "group"; id: string };
  capabilities: ObjectGrantCapability[];
}

export interface ObjectAccessPolicy {
  kind: "dry-run.object-access-policy";
  version: 1;
  id: string;
  revision: number;
  resource: { type: ObjectResourceType; id: string };
  grants: ObjectAccessGrant[];
  createdAt: string;
  updatedAt: string;
}

export interface AccessPrincipal {
  keyId: string;
  role: "admin" | "editor" | "viewer" | "ingest";
  memberId?: string;
  groupIds?: string[];
}

export class ObjectAccessStore {
  readonly dir: string;
  constructor(dir: string) { this.dir = path.resolve(dir); ensurePrivateDirectory(this.dir); }

  load(type: ObjectResourceType, id: string): ObjectAccessPolicy | undefined {
    const file = this.file(type, id);
    return existsSync(file) ? validatePolicy(readJsonFile(file)) : undefined;
  }

  list(opts: { type?: ObjectResourceType } = {}): ObjectAccessPolicy[] {
    return readdirSync(this.dir).filter((name) => name.endsWith(".json")).flatMap((name) => {
      try { return [validatePolicy(readJsonFile(path.join(this.dir, name)))]; } catch { return []; }
    }).filter((policy) => !opts.type || policy.resource.type === opts.type)
      .sort((left, right) => left.resource.type.localeCompare(right.resource.type) || left.resource.id.localeCompare(right.resource.id));
  }

  async set(type: ObjectResourceType, id: string, grants: ObjectAccessGrant[], expectedRevision?: number): Promise<ObjectAccessPolicy> {
    validateResource(type, id);
    const file = this.file(type, id);
    return withFileLock(file, () => {
      const current = existsSync(file) ? validatePolicy(readJsonFile(file)) : undefined;
      if (expectedRevision != null && current?.revision !== expectedRevision) throw new ObjectAccessConflictError(current?.revision ?? 0);
      const now = new Date().toISOString();
      const policy = validatePolicy({
        kind: "dry-run.object-access-policy", version: 1, id: policyId(type, id), revision: (current?.revision ?? 0) + 1,
        resource: { type, id }, grants: structuredClone(grants), createdAt: current?.createdAt ?? now, updatedAt: now,
      });
      atomicWriteJson(file, policy);
      return structuredClone(policy);
    });
  }

  async remove(type: ObjectResourceType, id: string, expectedRevision?: number): Promise<void> {
    const file = this.file(type, id);
    await withFileLock(file, () => {
      if (!existsSync(file)) return;
      const policy = validatePolicy(readJsonFile(file));
      if (expectedRevision != null && policy.revision !== expectedRevision) throw new ObjectAccessConflictError(policy.revision);
      unlinkSync(file);
    });
  }

  allows(principal: AccessPrincipal, capability: ObjectGrantCapability, type: ObjectResourceType, id: string): boolean {
    const policy = this.load(type, id) ?? this.load(type, "*");
    if (!policy || principal.role === "admin") return true;
    return policy.grants.some((grant) => {
      const subjectMatches = grant.subject.type === "key" ? grant.subject.id === principal.keyId
        : grant.subject.type === "group" ? Boolean(principal.groupIds?.includes(grant.subject.id))
          : Boolean(principal.memberId && grant.subject.id === principal.memberId);
      return subjectMatches && grant.capabilities.includes(capability);
    });
  }

  private file(type: ObjectResourceType, id: string): string { validateResource(type, id); return path.join(this.dir, `${policyId(type, id)}.json`); }
}

export class ObjectAccessConflictError extends Error {
  readonly status = 409;
  readonly currentRevision: number;
  constructor(currentRevision: number) { super(`Object access policy revision conflict; current revision is ${currentRevision}`); this.name = "ObjectAccessConflictError"; this.currentRevision = currentRevision; }
}

function validatePolicy(value: unknown): ObjectAccessPolicy {
  if (!record(value) || value.kind !== "dry-run.object-access-policy" || value.version !== 1 || typeof value.id !== "string" || !record(value.resource) || !Array.isArray(value.grants)) throw new Error("Invalid object access policy");
  validateResource(value.resource.type, value.resource.id);
  if (value.id !== policyId(value.resource.type, value.resource.id)) throw new Error("Object access policy id does not match its resource");
  integer(value.revision, 1, Number.MAX_SAFE_INTEGER, "Object access policy revision");
  if (value.grants.length < 1 || value.grants.length > 100) throw new Error("Object access policy requires 1-100 grants");
  const unique = new Set<string>();
  for (const grant of value.grants) {
    if (!record(grant) || !record(grant.subject) || !["member", "key", "group"].includes(String(grant.subject.type)) || typeof grant.subject.id !== "string" || !grant.subject.id.trim() || !Array.isArray(grant.capabilities) || !grant.capabilities.length || grant.capabilities.some((item: unknown) => !["read", "annotate", "manage-prompts"].includes(String(item)))) throw new Error("Invalid object access grant");
    const capabilities = [...new Set(grant.capabilities)].sort();
    grant.capabilities = capabilities;
    const key = `${grant.subject.type}:${grant.subject.id}:${capabilities.join(",")}`;
    if (unique.has(key)) throw new Error("Object access policy contains a duplicate grant");
    unique.add(key);
  }
  timestamp(value.createdAt, "Object access policy createdAt"); timestamp(value.updatedAt, "Object access policy updatedAt");
  return value as unknown as ObjectAccessPolicy;
}
function policyId(type: ObjectResourceType, id: string): string { return `access_${sha256(`${type}\0${id}`).slice(7, 39)}`; }
function validateResource(type: unknown, id: unknown): asserts type is ObjectResourceType { if (!["trace", "experiment", "prompt", "annotation-queue", "online-rule", "playground-run", "regression", "quality-monitor"].includes(String(type)) || typeof id !== "string" || !id.trim() || id.length > 512 || /[\u0000-\u001f]/.test(id)) throw new Error("Invalid object access resource"); }
function timestamp(value: unknown, name: string): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`); return value; }
function integer(value: unknown, minimum: number, maximum: number, name: string): number { if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return Number(value); }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
