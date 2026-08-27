import { timingSafeEqual } from "node:crypto";
import { sha256 } from "./storage.ts";
import { TeamWorkspace, type TeamMember, type TeamRole } from "./team.ts";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const DRYRUN_USER_SCHEMA = "urn:ietf:params:scim:schemas:extension:dry-run:2.0:User";

export interface ScimOptions {
  token: string;
  issuer?: string;
  baseUrl?: string;
  defaultRole?: Exclude<TeamRole, "ingest">;
  defaultProjectIds?: string[];
}

export interface ScimListResult {
  schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: Record<string, unknown>[];
}

export class ScimService {
  readonly workspace: TeamWorkspace;
  readonly options: ScimOptions;
  private readonly tokenHash: string;

  constructor(workspace: TeamWorkspace, options: ScimOptions) {
    if (typeof options.token !== "string" || options.token.length < 32 || options.token.length > 1024) throw new Error("SCIM provisioning token must contain 32-1024 characters");
    if (options.defaultRole && !["admin", "editor", "viewer"].includes(options.defaultRole)) throw new Error("SCIM defaultRole is invalid");
    if (options.baseUrl) {
      const url = new URL(options.baseUrl);
      if (url.username || url.password || url.search || url.hash) throw new Error("SCIM baseUrl cannot contain credentials, query, or fragment");
      if (url.protocol !== "https:" && !["127.0.0.1", "::1", "localhost"].includes(url.hostname)) throw new Error("SCIM baseUrl requires HTTPS outside loopback");
      if (!/^https?:$/.test(url.protocol)) throw new Error("SCIM baseUrl must use HTTP(S)");
    }
    this.workspace = workspace;
    this.options = { ...options, issuer: options.issuer ?? "dry-run-scim" };
    this.tokenHash = sha256(options.token);
  }

  authenticate(token: string): boolean {
    const actual = Buffer.from(sha256(typeof token === "string" ? token : ""));
    const expected = Buffer.from(this.tokenHash);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  list(opts: { filter?: string; startIndex?: number; count?: number } = {}): ScimListResult {
    const startIndex = bounded(opts.startIndex ?? 1, 1, Number.MAX_SAFE_INTEGER, "SCIM startIndex");
    const count = bounded(opts.count ?? 100, 0, 500, "SCIM count");
    const predicate = scimFilter(opts.filter);
    const members = this.members().filter(predicate);
    const page = members.slice(startIndex - 1, startIndex - 1 + count);
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: members.length,
      startIndex,
      itemsPerPage: page.length,
      Resources: page.map((member) => this.resource(member)),
    };
  }

  get(id: string): Record<string, unknown> {
    const member = this.member(id);
    return this.resource(member);
  }

  async create(value: unknown): Promise<Record<string, unknown>> {
    const fields = parseScimUser(value, this.options.defaultRole ?? "viewer", this.options.defaultProjectIds);
    if (this.members().some((member) => member.email === fields.email)) throw new ScimError("uniqueness", "A SCIM user with this userName already exists", 409);
    const member = await this.workspace.provisionFederatedMember({ provider: "scim", issuer: this.options.issuer!, subject: fields.externalId ?? fields.email, email: fields.email, name: fields.name, role: fields.role, ...(fields.projectIds ? { projectIds: fields.projectIds } : {}), active: fields.active });
    return this.resource(member);
  }

  async replace(id: string, value: unknown): Promise<Record<string, unknown>> {
    const current = this.member(id);
    const identity = current.identities!.find((candidate) => candidate.provider === "scim" && candidate.issuer === this.options.issuer)!;
    const fields = parseScimUser(value, current.role, current.projectIds);
    const member = await this.workspace.provisionFederatedMember({ provider: "scim", issuer: identity.issuer, subject: identity.subject, email: fields.email, name: fields.name, role: fields.role, ...(fields.projectIds ? { projectIds: fields.projectIds } : {}), active: fields.active });
    return this.resource(member);
  }

  async patch(id: string, value: unknown): Promise<Record<string, unknown>> {
    const current = this.member(id);
    if (!isRecord(value) || !Array.isArray(value.Operations) || value.Operations.length > 100) throw new ScimError("invalidSyntax", "SCIM PATCH requires Operations", 400);
    const document: Record<string, unknown> = {
      userName: current.email,
      displayName: current.name,
      active: current.status === "active",
      roles: [{ value: current.role }],
      [DRYRUN_USER_SCHEMA]: { projectIds: current.projectIds ?? [] },
    };
    for (const operation of value.Operations) applyPatchOperation(document, operation);
    return this.replace(id, document);
  }

  async remove(id: string): Promise<void> {
    const current = this.member(id);
    const identity = current.identities!.find((candidate) => candidate.provider === "scim" && candidate.issuer === this.options.issuer)!;
    await this.workspace.provisionFederatedMember({ provider: "scim", issuer: identity.issuer, subject: identity.subject, email: current.email, name: current.name, role: current.role, ...(current.projectIds ? { projectIds: current.projectIds } : {}), active: false });
  }

  serviceProviderConfig(): Record<string, unknown> {
    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 500 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "Dedicated dry-run SCIM provisioning token", primary: true }],
    };
  }

  resourceTypes(): Record<string, unknown> {
    return { schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [{ schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: USER_SCHEMA, schemaExtensions: [{ schema: DRYRUN_USER_SCHEMA, required: false }] }] };
  }

  schemas(): Record<string, unknown> {
    const resources = [
      {
        id: USER_SCHEMA, name: "User", description: "Dry Run team member",
        attributes: [
          { name: "userName", type: "string", multiValued: false, required: true, caseExact: false, mutability: "readWrite", returned: "default", uniqueness: "server" },
          { name: "displayName", type: "string", multiValued: false, required: false, caseExact: false, mutability: "readWrite", returned: "default", uniqueness: "none" },
          { name: "active", type: "boolean", multiValued: false, required: false, mutability: "readWrite", returned: "default" },
          { name: "roles", type: "complex", multiValued: true, required: false, mutability: "readWrite", returned: "default", subAttributes: [{ name: "value", type: "string", multiValued: false, required: true, caseExact: false, mutability: "readWrite", returned: "default", uniqueness: "none", canonicalValues: ["admin", "editor", "viewer"] }] },
        ],
      },
      {
        id: DRYRUN_USER_SCHEMA, name: "DryRunUser", description: "Dry Run project scope extension",
        attributes: [{ name: "projectIds", type: "string", multiValued: true, required: false, caseExact: true, mutability: "readWrite", returned: "default", uniqueness: "none" }],
      },
    ].map((resource) => ({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"], ...resource }));
    return { schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: resources.length, startIndex: 1, itemsPerPage: resources.length, Resources: resources };
  }

  private members(): TeamMember[] {
    return (this.workspace.config().members ?? []).filter((member) => member.identities?.some((identity) => identity.provider === "scim" && identity.issuer === this.options.issuer));
  }

  private member(id: string): TeamMember {
    const member = this.members().find((candidate) => candidate.id === id);
    if (!member) throw new ScimError(undefined, "SCIM user was not found", 404);
    return member;
  }

  private resource(member: TeamMember): Record<string, unknown> {
    const identity = member.identities?.find((candidate) => candidate.provider === "scim" && candidate.issuer === this.options.issuer);
    return {
      schemas: [USER_SCHEMA, DRYRUN_USER_SCHEMA],
      id: member.id,
      ...(identity ? { externalId: identity.subject } : {}),
      userName: member.email,
      displayName: member.name,
      name: splitName(member.name),
      emails: [{ value: member.email, type: "work", primary: true }],
      active: member.status === "active",
      roles: [{ value: member.role, primary: true }],
      [DRYRUN_USER_SCHEMA]: { projectIds: member.projectIds ?? [] },
      meta: { resourceType: "User", created: member.createdAt, lastModified: member.updatedAt, location: this.options.baseUrl ? `${this.options.baseUrl.replace(/\/$/, "")}/Users/${member.id}` : `/scim/v2/Users/${member.id}` },
    };
  }
}

export class ScimError extends Error {
  readonly status: number;
  readonly scimType?: string;
  constructor(scimType: string | undefined, message: string, status: number) { super(message); this.name = "ScimError"; this.status = status; this.scimType = scimType; }

  body(): Record<string, unknown> { return { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: String(this.status), detail: this.message, ...(this.scimType ? { scimType: this.scimType } : {}) }; }
}

function parseScimUser(value: unknown, defaultRole: Exclude<TeamRole, "ingest">, defaultProjectIds?: string[]): { email: string; name: string; externalId?: string; active: boolean; role: Exclude<TeamRole, "ingest">; projectIds?: string[] } {
  if (!isRecord(value)) throw new ScimError("invalidSyntax", "SCIM user must be an object", 400);
  const primaryEmail = Array.isArray(value.emails) ? value.emails.find((entry: unknown) => isRecord(entry) && entry.primary === true) ?? value.emails[0] : undefined;
  const email = String(value.userName ?? (isRecord(primaryEmail) ? primaryEmail.value : "")).trim().toLowerCase();
  if (!isScimEmail(email)) throw new ScimError("invalidValue", "SCIM userName must be an email address", 400);
  const name = String(value.displayName ?? (isRecord(value.name) ? value.name.formatted : "") ?? email).trim() || email;
  if (name.length > 128) throw new ScimError("invalidValue", "SCIM displayName is too long", 400);
  const roleValue = Array.isArray(value.roles) && isRecord(value.roles[0]) ? value.roles[0].value : defaultRole;
  if (!["admin", "editor", "viewer"].includes(String(roleValue))) throw new ScimError("invalidValue", "SCIM role must be admin, editor, or viewer", 400);
  const extension = isRecord(value[DRYRUN_USER_SCHEMA]) ? value[DRYRUN_USER_SCHEMA] : {};
  const projectIds = extension.projectIds == null ? defaultProjectIds : extension.projectIds;
  if (projectIds != null && (!Array.isArray(projectIds) || projectIds.some((project) => typeof project !== "string" || !project.trim()))) throw new ScimError("invalidValue", "SCIM projectIds must be a string array", 400);
  return { email, name, ...(typeof value.externalId === "string" && value.externalId ? { externalId: value.externalId } : {}), active: value.active !== false, role: roleValue as Exclude<TeamRole, "ingest">, ...(projectIds ? { projectIds: [...new Set(projectIds)] as string[] } : {}) };
}

function applyPatchOperation(document: Record<string, unknown>, operation: unknown): void {
  if (!isRecord(operation) || !["add", "replace", "remove"].includes(String(operation.op).toLowerCase())) throw new ScimError("invalidSyntax", "Unsupported SCIM PATCH operation", 400);
  const op = String(operation.op).toLowerCase();
  const path = typeof operation.path === "string" ? operation.path : undefined;
  if (!path && isRecord(operation.value) && op !== "remove") { Object.assign(document, operation.value); return; }
  if (!path || !["active", "displayName", "userName", "roles", `${DRYRUN_USER_SCHEMA}:projectIds`].includes(path)) throw new ScimError("invalidPath", `Unsupported SCIM PATCH path: ${path ?? "none"}`, 400);
  if (op === "remove") {
    if (path === "active") document.active = false;
    else delete document[path];
    return;
  }
  if (path === `${DRYRUN_USER_SCHEMA}:projectIds`) (document[DRYRUN_USER_SCHEMA] as Record<string, unknown>).projectIds = operation.value;
  else document[path] = operation.value;
}

function isScimEmail(value: string): boolean {
  if (value.length < 3 || value.length > 320) return false;
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@") || at > value.length - 4) return false;
  const dot = value.lastIndexOf(".");
  if (dot <= at + 1 || dot >= value.length - 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) return false;
  }
  return true;
}

function scimFilter(filter?: string): (member: TeamMember) => boolean {
  if (!filter) return () => true;
  const match = /^\s*(userName|externalId)\s+eq\s+"([^"]{1,512})"\s*$/i.exec(filter);
  if (!match) throw new ScimError("invalidFilter", "Only userName eq and externalId eq filters are supported", 400);
  const field = match[1].toLowerCase();
  const expected = match[2].toLowerCase();
  return (member) => field === "username" ? member.email.toLowerCase() === expected : member.identities?.some((identity) => identity.provider === "scim" && identity.subject.toLowerCase() === expected) === true;
}

function splitName(value: string): Record<string, string> {
  const parts = value.trim().split(/\s+/);
  return { formatted: value, ...(parts.length > 1 ? { givenName: parts.slice(0, -1).join(" "), familyName: parts.at(-1)! } : { givenName: value }) };
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new ScimError("invalidValue", `${label} must be between ${minimum} and ${maximum}`, 400);
  return value;
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
