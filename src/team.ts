import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { ObjectAccessStore, type ObjectAccessGrant, type ObjectAccessPolicy, type ObjectGrantCapability, type ObjectResourceType } from "./access.ts";
import { ExperimentStore, type ExperimentDocument } from "./experiment.ts";
import { nominalAgreement, type NominalAgreementReport } from "./evaluation-governance.ts";
import { OnlineEvaluationStore } from "./online-evaluation.ts";
import { QualityMonitorStore, validateQualityMonitorResult } from "./monitoring.ts";
import { IntelligenceStore } from "./intelligence.ts";
import { JudgeReliabilityStore } from "./judge-reliability.ts";
import { MigrationStore } from "./migration-store.ts";
import { PlaygroundStore } from "./playground.ts";
import { PromptRegistry } from "./prompts.ts";
import { RegressionStore } from "./promotion.ts";
import { TraceStore, type TraceDocument } from "./tracing.ts";
import {
  atomicWriteJson,
  ensurePrivateDirectory,
  newId,
  readJsonFile,
  sha256,
  slug,
  withFileLock,
} from "./storage.ts";

export type TeamRole = "admin" | "editor" | "viewer" | "ingest";
export type TeamCapability =
  | "read"
  | "ingest"
  | "annotate"
  | "manage-prompts"
  | "manage-keys"
  | "manage-members"
  | "manage-projects"
  | "manage-retention"
  | "manage-access"
  | "manage-groups"
  | "manage-roles"
  | "manage-organization"
  | "read-audit";

export interface TeamApiKey {
  id: string;
  name: string;
  role: TeamRole;
  tokenHash: string;
  projectIds?: string[];
  memberId?: string;
  customRoleId?: string;
  serviceAccount?: boolean;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  rotatedAt?: string;
  rotatedToKeyId?: string;
  rotationOfKeyId?: string;
}

export interface TeamOrganization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamCustomRole {
  id: string;
  name: string;
  description?: string;
  baseRole: TeamRole;
  capabilities: TeamCapability[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface TeamGroup {
  id: string;
  name: string;
  description?: string;
  memberIds: string[];
  projectIds?: string[];
  customRoleId?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface TeamProject {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  retention?: { enabled: boolean; days: number };
}

export type TeamMemberStatus = "active" | "suspended";

export interface TeamExternalIdentity {
  provider: "oidc" | "scim";
  issuer: string;
  subject: string;
}

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: Exclude<TeamRole, "ingest">;
  customRoleId?: string;
  projectIds?: string[];
  status: TeamMemberStatus;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  identities?: TeamExternalIdentity[];
}

export interface TeamInvitation {
  id: string;
  email: string;
  role: Exclude<TeamRole, "ingest">;
  projectIds?: string[];
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  revokedAt?: string;
  invitedByKeyId: string;
}

export interface IssuedTeamInvitation {
  invitation: Omit<TeamInvitation, "tokenHash">;
  token: string;
}

export interface TeamConfig {
  kind: "dry-run.team";
  version: 1;
  id: string;
  name: string;
  organization?: TeamOrganization;
  createdAt: string;
  updatedAt: string;
  keys: TeamApiKey[];
  projects: TeamProject[];
  members?: TeamMember[];
  invitations?: TeamInvitation[];
  groups?: TeamGroup[];
  customRoles?: TeamCustomRole[];
  retention: { enabled: boolean; days: number };
}

export interface TeamPrincipal {
  keyId: string;
  keyName: string;
  role: TeamRole;
  organizationId?: string;
  capabilities?: TeamCapability[];
  groupIds?: string[];
  projectIds?: string[];
  memberId?: string;
  memberName?: string;
  memberEmail?: string;
}

export interface IssuedTeamKey {
  key: Omit<TeamApiKey, "tokenHash">;
  token: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: { keyId: string; role: TeamRole; memberId?: string } | { system: true };
  action: string;
  projectId?: string;
  target?: string;
  details?: Record<string, unknown>;
}

export interface AnnotationQueue {
  kind: "dry-run.annotation-queue";
  version: 1;
  id: string;
  name: string;
  description?: string;
  mode?: "single" | "double-blind" | "adjudicated";
  reviewersPerTarget?: number;
  assignment?: "manual" | "round-robin" | "deterministic-random";
  reviewerIds?: string[];
  adjudicationQueueId?: string;
  slaHours?: number;
  createdAt: string;
  updatedAt: string;
}

export type AnnotationTargetType = "trace" | "span" | "experiment-case";
export type AnnotationStatus = "pending" | "claimed" | "completed" | "skipped";

export interface AnnotationItem {
  kind: "dry-run.annotation-item";
  version: 1;
  id: string;
  queueId: string;
  target: { type: AnnotationTargetType; id: string; subId?: string };
  status: AnnotationStatus;
  priority: number;
  labels: string[];
  assignedTo?: string;
  score?: number;
  label?: string;
  comment?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  revision: number;
}

export interface AnnotationPage<T> {
  items: T[];
  limit: number;
  scanned: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface AnnotationAgreementReport extends NominalAgreementReport {
  queueId: string;
  completedItems: number;
  unratedItems: number;
}

export interface RetentionPlan {
  projectId: string;
  olderThanDays: number;
  cutoff: string;
  traces: string[];
  experiments: string[];
  completedAnnotations: string[];
  qualityMonitorResults: string[];
  total: number;
}

export interface TeamProjectStores {
  project: TeamProject;
  root: string;
  traces: TraceStore;
  experiments: ExperimentStore;
  prompts: PromptRegistry;
  annotations: AnnotationStore;
  online: OnlineEvaluationStore;
  playground: PlaygroundStore;
  regressions: RegressionStore;
  monitors: QualityMonitorStore;
  intelligence: IntelligenceStore;
  judges: JudgeReliabilityStore;
  access: ObjectAccessStore;
  migrations: MigrationStore;
}

export interface TeamProjectUsage {
  files: number;
  bytes: number;
  resources?: {
    traces: number;
    experiments: number;
    prompts: number;
    annotationQueues: number;
    annotationItems: number;
    onlineRules: number;
    onlineResults: number;
    onlineJobs: number;
    playgroundRuns: number;
    regressionBundles: number;
    qualityMonitors: number;
    qualityMonitorResults: number;
    intelligenceReports: number;
    judgeReliabilityReports: number;
    accessPolicies: number;
  };
}

export interface TeamProjectQuota {
  maxFiles: number;
  maxBytes: number;
}

export interface TeamProjectWrite {
  file: string;
  bytes: number;
}

const ROLE_CAPABILITIES: Record<TeamRole, ReadonlySet<TeamCapability>> = {
  admin: new Set(["read", "ingest", "annotate", "manage-prompts", "manage-keys", "manage-members", "manage-projects", "manage-retention", "manage-access", "manage-groups", "manage-roles", "manage-organization", "read-audit"]),
  editor: new Set(["read", "ingest", "annotate", "manage-prompts"]),
  viewer: new Set(["read"]),
  ingest: new Set(["ingest"]),
};

const WORKSPACE_CAPABILITIES = new Set<TeamCapability>(["manage-keys", "manage-members", "manage-projects", "manage-retention", "manage-groups", "manage-roles", "manage-organization", "read-audit"]);

export class TeamWorkspace {
  readonly dir: string;
  readonly configFile: string;
  readonly auditFile: string;

  constructor(dir = path.resolve(".dryrun/team")) {
    this.dir = path.resolve(dir);
    this.configFile = path.join(this.dir, "workspace.json");
    this.auditFile = path.join(this.dir, "audit.jsonl");
    ensurePrivateDirectory(this.dir);
    if (!existsSync(this.configFile)) throw new Error(`Team workspace is not initialized: ${this.dir}`);
    validateTeamConfig(readJsonFile(this.configFile));
  }

  static async initialize(dir: string, name: string, opts: { retentionDays?: number } = {}): Promise<{ workspace: TeamWorkspace; admin: IssuedTeamKey }> {
    if (!name.trim() || name.length > 128) throw new Error("Workspace name must contain 1-128 characters");
    const root = path.resolve(dir);
    ensurePrivateDirectory(root);
    const configFile = path.join(root, "workspace.json");
    const issued = issueKey("owner", "admin");
    const now = new Date().toISOString();
    await withFileLock(configFile, () => {
      if (existsSync(configFile)) throw new Error(`Team workspace already exists: ${root}`);
      const defaultProject: TeamProject = { id: newId("project"), name: "default", slug: "default", createdAt: now };
      const config: TeamConfig = {
        kind: "dry-run.team",
        version: 1,
        id: newId("workspace"),
        name,
        organization: { id: newId("org"), name, slug: slug(name), createdAt: now, updatedAt: now },
        createdAt: now,
        updatedAt: now,
        keys: [issued.stored],
        projects: [defaultProject],
        members: [],
        invitations: [],
        groups: [],
        customRoles: [],
        retention: { enabled: false, days: positiveDays(opts.retentionDays ?? 90) },
      };
      atomicWriteJson(configFile, config);
    });
    const workspace = new TeamWorkspace(root);
    workspace.project(workspace.config().projects[0].id);
    await workspace.audit({ system: true }, "workspace.initialize", { target: workspace.config().id });
    return { workspace, admin: { key: publicKey(issued.stored), token: issued.token } };
  }

  config(): TeamConfig {
    return structuredClone(validateTeamConfig(readJsonFile(this.configFile)));
  }

  authenticate(token: string): TeamPrincipal | undefined {
    if (typeof token !== "string" || token.length < 20 || token.length > 512) return undefined;
    if (!token.startsWith("drk_")) return undefined;
    const config = this.config();
    const key = config.keys.find((candidate) => token.startsWith(`drk_${candidate.id}_`) && !candidate.revokedAt);
    const expected = key?.tokenHash ?? sha256("dry-run-invalid-token");
    const actual = sha256(token);
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(actual);
    const valid = expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
    if (!valid || !key) return undefined;
    const member = key.memberId ? config.members?.find((candidate) => candidate.id === key.memberId && candidate.status === "active") : undefined;
    if (key.memberId && !member) return undefined;
    if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) return undefined;
    const groups = member ? (config.groups ?? []).filter((group) => group.memberIds.includes(member.id)) : [];
    const memberScopes = member ? effectiveMemberScopes(member, groups) : undefined;
    const projectIds = member ? intersectScopes(key.projectIds, memberScopes) : key.projectIds;
    const role = member?.role ?? key.role;
    const capabilities = resolveCapabilities(config, role, key.customRoleId ?? member?.customRoleId, groups);
    return {
      keyId: key.id,
      keyName: key.name,
      role,
      organizationId: organizationOf(config).id,
      capabilities,
      ...(groups.length ? { groupIds: groups.map((group) => group.id) } : {}),
      ...(projectIds ? { projectIds } : {}),
      ...(member ? { memberId: member.id, memberName: member.name, memberEmail: member.email } : {}),
    };
  }

  authorize(token: string, capability: TeamCapability, projectId?: string): TeamPrincipal {
    const principal = this.authenticate(token);
    if (!principal) throw new TeamAuthError("Invalid or revoked API key", 401);
    if (!principalCapabilities(principal).has(capability)) throw new TeamAuthError(`Role ${principal.role} cannot ${capability}`, 403);
    if (projectId && principal.projectIds && !principal.projectIds.includes(projectId)) {
      throw new TeamAuthError("API key is not scoped to this project", 403);
    }
    if (!projectId && principal.projectIds && WORKSPACE_CAPABILITIES.has(capability)) {
      throw new TeamAuthError("Project-scoped API keys cannot perform workspace-wide administration", 403);
    }
    return principal;
  }

  authorizeObject(token: string, capability: ObjectGrantCapability, projectId: string, type: ObjectResourceType, id: string): TeamPrincipal {
    const stores = this.project(projectId);
    const principal = this.authorize(token, capability, stores.project.id);
    if (!stores.access.allows(principal, capability, type, id)) throw new TeamAuthError("Principal is not granted access to this restricted object", 403);
    return principal;
  }

  canAccessObject(principal: TeamPrincipal, capability: ObjectGrantCapability, projectId: string, type: ObjectResourceType, id: string): boolean {
    try { requireProjectCapability(principal, capability, this.project(projectId).project.id); }
    catch { return false; }
    return this.project(projectId).access.allows(principal, capability, type, id);
  }

  listObjectAccess(actor: TeamPrincipal, projectId: string): ObjectAccessPolicy[] {
    const stores = this.project(projectId);
    requireProjectCapability(actor, "manage-access", stores.project.id);
    return stores.access.list();
  }

  async setObjectAccess(actor: TeamPrincipal, projectId: string, type: ObjectResourceType, id: string, grants: ObjectAccessGrant[], expectedRevision?: number): Promise<ObjectAccessPolicy> {
    const stores = this.project(projectId);
    requireProjectCapability(actor, "manage-access", stores.project.id);
    const config = this.config();
    for (const grant of grants) {
      const exists = grant.subject.type === "key"
        ? config.keys.some((key) => key.id === grant.subject.id && !key.revokedAt)
        : grant.subject.type === "group"
          ? config.groups?.some((group) => group.id === grant.subject.id)
          : config.members?.some((member) => member.id === grant.subject.id && member.status === "active");
      if (!exists) throw new Error(`Unknown or inactive ${grant.subject.type} access subject: ${grant.subject.id}`);
    }
    const policy = await stores.access.set(type, id, grants, expectedRevision);
    await this.audit(actor, "object-access.set", { projectId: stores.project.id, target: policy.id, details: { resourceType: type, resourceId: id, revision: policy.revision, grants: policy.grants.length } });
    return policy;
  }

  async removeObjectAccess(actor: TeamPrincipal, projectId: string, type: ObjectResourceType, id: string, expectedRevision?: number): Promise<void> {
    const stores = this.project(projectId);
    requireProjectCapability(actor, "manage-access", stores.project.id);
    await stores.access.remove(type, id, expectedRevision);
    await this.audit(actor, "object-access.remove", { projectId: stores.project.id, details: { resourceType: type, resourceId: id } });
  }

  async createKey(actor: TeamPrincipal, name: string, role: TeamRole, projectIds?: string[]): Promise<IssuedTeamKey> {
    requireWorkspaceCapability(actor, "manage-keys");
    if (!name.trim() || name.length > 128) throw new Error("API key name must contain 1-128 characters");
    assertRole(role);
    const file = this.configFile;
    let created!: ReturnType<typeof issueKey>;
    await withFileLock(file, () => {
      const config = validateTeamConfig(readJsonFile(file));
      const scopes = projectIds ? uniqueProjectIds(config, projectIds) : undefined;
      created = issueKey(name, role, scopes);
      config.keys.push(created.stored);
      config.updatedAt = new Date().toISOString();
      atomicWriteJson(file, config);
    });
    await this.audit(actor, "key.create", { target: created.stored.id, details: { name, role, projectIds: created.stored.projectIds } });
    return { key: publicKey(created.stored), token: created.token };
  }

  async revokeKey(actor: TeamPrincipal, keyId: string): Promise<void> {
    requireWorkspaceCapability(actor, "manage-keys");
    if (actor.keyId === keyId) throw new Error("Refusing to revoke the API key used for this request");
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      const key = config.keys.find((candidate) => candidate.id === keyId);
      if (!key) throw new Error(`Unknown API key: ${keyId}`);
      if (!key.revokedAt) key.revokedAt = new Date().toISOString();
      config.updatedAt = new Date().toISOString();
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "key.revoke", { target: keyId });
  }

  async revokeOwnSession(actor: TeamPrincipal): Promise<void> {
    if (!actor.memberId) throw new TeamAuthError("Only member sessions can log out", 403);
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      const key = config.keys.find((candidate) => candidate.id === actor.keyId && candidate.memberId === actor.memberId);
      if (!key) throw new TeamAuthError("Member session no longer exists", 401);
      if (!key.revokedAt) key.revokedAt = new Date().toISOString();
      config.updatedAt = new Date().toISOString();
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "member.session-revoke", { target: actor.keyId });
  }

  listKeys(actor: TeamPrincipal): Array<Omit<TeamApiKey, "tokenHash">> {
    requireWorkspaceCapability(actor, "manage-keys");
    return this.config().keys.map(publicKey);
  }

  listMembers(actor: TeamPrincipal): TeamMember[] {
    requireWorkspaceCapability(actor, "manage-members");
    return structuredClone(this.config().members ?? []);
  }

  listInvitations(actor: TeamPrincipal): Array<Omit<TeamInvitation, "tokenHash">> {
    requireWorkspaceCapability(actor, "manage-members");
    return (this.config().invitations ?? []).map(publicInvitation);
  }

  organization(actor: TeamPrincipal): TeamOrganization {
    requireCapability(actor, "read");
    return structuredClone(organizationOf(this.config()));
  }

  async updateOrganization(actor: TeamPrincipal, changes: { name: string }): Promise<TeamOrganization> {
    requireWorkspaceCapability(actor, "manage-organization");
    if (!changes.name.trim() || changes.name.trim().length > 128) throw new Error("Organization name must contain 1-128 characters");
    let organization!: TeamOrganization;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      organization = organizationOf(config);
      organization.name = changes.name.trim();
      organization.slug = slug(changes.name);
      organization.updatedAt = new Date().toISOString();
      config.organization = organization;
      config.updatedAt = organization.updatedAt;
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "organization.update", { target: organization.id, details: { name: organization.name } });
    return structuredClone(organization);
  }

  listCustomRoles(actor: TeamPrincipal): TeamCustomRole[] {
    requireWorkspaceCapability(actor, "manage-roles");
    return structuredClone(this.config().customRoles ?? []);
  }

  async createCustomRole(actor: TeamPrincipal, fields: { name: string; description?: string; baseRole: TeamRole; capabilities: TeamCapability[] }): Promise<TeamCustomRole> {
    requireWorkspaceCapability(actor, "manage-roles");
    validateRoleFields(fields);
    let role!: TeamCustomRole;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      if ((config.customRoles ?? []).some((candidate) => candidate.name.toLowerCase() === fields.name.trim().toLowerCase())) throw new Error(`Custom role already exists: ${fields.name}`);
      const now = new Date().toISOString();
      role = { id: newId("role"), name: fields.name.trim(), ...(fields.description?.trim() ? { description: fields.description.trim() } : {}), baseRole: fields.baseRole, capabilities: normalizedRoleCapabilities(fields.baseRole, fields.capabilities), createdAt: now, updatedAt: now, revision: 1 };
      (config.customRoles ??= []).push(role);
      config.updatedAt = now;
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "role.create", { target: role.id, details: { name: role.name, baseRole: role.baseRole, capabilities: role.capabilities } });
    return structuredClone(role);
  }

  async updateCustomRole(actor: TeamPrincipal, roleId: string, changes: { name?: string; description?: string | null; capabilities?: TeamCapability[]; expectedRevision?: number }): Promise<TeamCustomRole> {
    requireWorkspaceCapability(actor, "manage-roles");
    let updated!: TeamCustomRole;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      const role = (config.customRoles ?? []).find((candidate) => candidate.id === roleId);
      if (!role) throw new Error(`Unknown custom role: ${roleId}`);
      if (changes.expectedRevision != null && role.revision !== changes.expectedRevision) throw new Error(`Custom role revision conflict; current revision is ${role.revision}`);
      if (changes.name != null) {
        if (!changes.name.trim() || changes.name.trim().length > 128) throw new Error("Custom role name must contain 1-128 characters");
        if ((config.customRoles ?? []).some((candidate) => candidate.id !== roleId && candidate.name.toLowerCase() === changes.name!.trim().toLowerCase())) throw new Error(`Custom role already exists: ${changes.name}`);
        role.name = changes.name.trim();
      }
      if (changes.description !== undefined) {
        if (changes.description?.trim()) role.description = changes.description.trim();
        else delete role.description;
      }
      if (changes.capabilities) role.capabilities = normalizedRoleCapabilities(role.baseRole, changes.capabilities);
      role.revision += 1;
      role.updatedAt = new Date().toISOString();
      config.updatedAt = role.updatedAt;
      updated = structuredClone(role);
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "role.update", { target: roleId, details: { revision: updated.revision, capabilities: updated.capabilities } });
    return updated;
  }

  async deleteCustomRole(actor: TeamPrincipal, roleId: string): Promise<void> {
    requireWorkspaceCapability(actor, "manage-roles");
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      const index = (config.customRoles ?? []).findIndex((candidate) => candidate.id === roleId);
      if (index < 0) return;
      if (config.keys.some((key) => key.customRoleId === roleId) || (config.members ?? []).some((member) => member.customRoleId === roleId) || (config.groups ?? []).some((group) => group.customRoleId === roleId)) throw new Error("Custom role is still assigned");
      config.customRoles!.splice(index, 1);
      config.updatedAt = new Date().toISOString();
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "role.delete", { target: roleId });
  }

  listGroups(actor: TeamPrincipal): TeamGroup[] {
    requireWorkspaceCapability(actor, "manage-groups");
    return structuredClone(this.config().groups ?? []);
  }

  async createGroup(actor: TeamPrincipal, fields: { name: string; description?: string; memberIds?: string[]; projectIds?: string[]; customRoleId?: string }): Promise<TeamGroup> {
    requireWorkspaceCapability(actor, "manage-groups");
    if (!fields.name.trim() || fields.name.trim().length > 128) throw new Error("Group name must contain 1-128 characters");
    let group!: TeamGroup;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      if ((config.groups ?? []).some((candidate) => candidate.name.toLowerCase() === fields.name.trim().toLowerCase())) throw new Error(`Group already exists: ${fields.name}`);
      const memberIds = uniqueMemberIds(config, fields.memberIds ?? []);
      const projectIds = fields.projectIds ? uniqueProjectIds(config, fields.projectIds) : undefined;
      if (fields.customRoleId) customRole(config, fields.customRoleId);
      const now = new Date().toISOString();
      group = { id: newId("group"), name: fields.name.trim(), ...(fields.description?.trim() ? { description: fields.description.trim() } : {}), memberIds, ...(projectIds ? { projectIds } : {}), ...(fields.customRoleId ? { customRoleId: fields.customRoleId } : {}), createdAt: now, updatedAt: now, revision: 1 };
      (config.groups ??= []).push(group);
      config.updatedAt = now;
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "group.create", { target: group.id, details: { name: group.name, members: group.memberIds.length, projectIds: group.projectIds, customRoleId: group.customRoleId } });
    return structuredClone(group);
  }

  async updateGroup(actor: TeamPrincipal, groupId: string, changes: { name?: string; description?: string | null; memberIds?: string[]; projectIds?: string[] | null; customRoleId?: string | null; expectedRevision?: number }): Promise<TeamGroup> {
    requireWorkspaceCapability(actor, "manage-groups");
    let updated!: TeamGroup;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      const group = (config.groups ?? []).find((candidate) => candidate.id === groupId);
      if (!group) throw new Error(`Unknown group: ${groupId}`);
      if (changes.expectedRevision != null && group.revision !== changes.expectedRevision) throw new Error(`Group revision conflict; current revision is ${group.revision}`);
      if (changes.name != null) {
        if (!changes.name.trim() || changes.name.trim().length > 128) throw new Error("Group name must contain 1-128 characters");
        if ((config.groups ?? []).some((candidate) => candidate.id !== groupId && candidate.name.toLowerCase() === changes.name!.trim().toLowerCase())) throw new Error(`Group already exists: ${changes.name}`);
        group.name = changes.name.trim();
      }
      if (changes.description !== undefined) {
        if (changes.description?.trim()) group.description = changes.description.trim();
        else delete group.description;
      }
      if (changes.memberIds) group.memberIds = uniqueMemberIds(config, changes.memberIds);
      if (changes.projectIds !== undefined) {
        if (changes.projectIds === null) delete group.projectIds;
        else group.projectIds = uniqueProjectIds(config, changes.projectIds);
      }
      if (changes.customRoleId !== undefined) {
        if (changes.customRoleId === null) delete group.customRoleId;
        else { customRole(config, changes.customRoleId); group.customRoleId = changes.customRoleId; }
      }
      group.revision += 1;
      group.updatedAt = new Date().toISOString();
      config.updatedAt = group.updatedAt;
      updated = structuredClone(group);
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "group.update", { target: groupId, details: { revision: updated.revision, members: updated.memberIds.length, projectIds: updated.projectIds, customRoleId: updated.customRoleId } });
    return updated;
  }

  async deleteGroup(actor: TeamPrincipal, groupId: string): Promise<void> {
    requireWorkspaceCapability(actor, "manage-groups");
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      config.groups = (config.groups ?? []).filter((candidate) => candidate.id !== groupId);
      config.updatedAt = new Date().toISOString();
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "group.delete", { target: groupId });
  }

  async createServiceAccount(actor: TeamPrincipal, name: string, role: TeamRole, projectIds?: string[], customRoleId?: string): Promise<IssuedTeamKey> {
    requireWorkspaceCapability(actor, "manage-keys");
    if (!name.trim() || name.trim().length > 128) throw new Error("Service account name must contain 1-128 characters");
    assertRole(role);
    let created!: ReturnType<typeof issueKey>;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      const scopes = projectIds ? uniqueProjectIds(config, projectIds) : undefined;
      if (customRoleId) assertRoleAssignment(config, role, customRoleId);
      created = issueKey(name.trim(), role, scopes, { ...(customRoleId ? { customRoleId } : {}), serviceAccount: true });
      config.keys.push(created.stored);
      config.updatedAt = new Date().toISOString();
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "service-account.create", { target: created.stored.id, details: { name: created.stored.name, role, projectIds: created.stored.projectIds, customRoleId } });
    return { key: publicKey(created.stored), token: created.token };
  }

  async rotateKey(actor: TeamPrincipal, keyId: string, graceMinutes = 5): Promise<IssuedTeamKey> {
    requireWorkspaceCapability(actor, "manage-keys");
    if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 10_080) throw new Error("Rotation grace must be between 0 and 10080 minutes");
    let created!: ReturnType<typeof issueKey>;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      const key = config.keys.find((candidate) => candidate.id === keyId && !candidate.revokedAt);
      if (!key) throw new Error(`Unknown or revoked API key: ${keyId}`);
      const now = new Date();
      created = issueKey(key.name, key.role, key.projectIds, { memberId: key.memberId, customRoleId: key.customRoleId, serviceAccount: key.serviceAccount, rotationOfKeyId: key.id, ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}) });
      key.rotatedAt = now.toISOString();
      key.rotatedToKeyId = created.stored.id;
      if (graceMinutes === 0) key.revokedAt = now.toISOString();
      else {
        const graceExpiry = new Date(now.getTime() + graceMinutes * 60_000).toISOString();
        if (!key.expiresAt || Date.parse(key.expiresAt) > Date.parse(graceExpiry)) key.expiresAt = graceExpiry;
      }
      config.keys.push(created.stored);
      config.updatedAt = now.toISOString();
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "key.rotate", { target: keyId, details: { replacementKeyId: created.stored.id, graceMinutes } });
    return { key: publicKey(created.stored), token: created.token };
  }

  exportAudit(actor: TeamPrincipal, options: { projectId?: string; format?: "jsonl" | "csv"; limit?: number } = {}): string {
    const entries = this.readAudit(actor, { projectId: options.projectId, limit: options.limit ?? 1_000 }).reverse();
    if ((options.format ?? "jsonl") === "jsonl") return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}${entries.length ? "\n" : ""}`;
    const escape = (value: unknown): string => `"${String(value ?? "").replaceAll('"', '""')}"`;
    return ["id,timestamp,actorKeyId,actorMemberId,actorRole,action,projectId,target,details", ...entries.map((entry) => [entry.id, entry.timestamp, "system" in entry.actor ? "system" : entry.actor.keyId, "system" in entry.actor ? "" : entry.actor.memberId ?? "", "system" in entry.actor ? "system" : entry.actor.role, entry.action, entry.projectId ?? "", entry.target ?? "", JSON.stringify(entry.details ?? {})].map(escape).join(","))].join("\n") + "\n";
  }

  async createInvitation(
    actor: TeamPrincipal,
    email: string,
    role: Exclude<TeamRole, "ingest">,
    projectIds?: string[],
    expiresInDays = 7,
  ): Promise<IssuedTeamInvitation> {
    requireWorkspaceCapability(actor, "manage-members");
    const normalizedEmail = normalizeEmail(email);
    assertMemberRole(role);
    const validDays = boundedDays(expiresInDays, "Invitation expiry days");
    let issued!: ReturnType<typeof issueInvitation>;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      if ((config.members ?? []).some((member) => member.email === normalizedEmail)) throw new Error(`A member already exists for ${normalizedEmail}`);
      const now = Date.now();
      if ((config.invitations ?? []).some((invitation) => invitation.email === normalizedEmail && !invitation.acceptedAt && !invitation.revokedAt && Date.parse(invitation.expiresAt) > now)) {
        throw new Error(`A pending invitation already exists for ${normalizedEmail}`);
      }
      const scopes = projectIds ? uniqueProjectIds(config, projectIds) : undefined;
      issued = issueInvitation(normalizedEmail, role, actor.keyId, validDays, scopes);
      (config.invitations ??= []).push(issued.stored);
      config.updatedAt = new Date().toISOString();
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "member.invite", { target: issued.stored.id, details: { email: normalizedEmail, role, projectIds: issued.stored.projectIds, expiresAt: issued.stored.expiresAt } });
    return { invitation: publicInvitation(issued.stored), token: issued.token };
  }

  async revokeInvitation(actor: TeamPrincipal, invitationId: string): Promise<void> {
    requireWorkspaceCapability(actor, "manage-members");
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      const invitation = (config.invitations ?? []).find((candidate) => candidate.id === invitationId);
      if (!invitation) throw new Error(`Unknown invitation: ${invitationId}`);
      if (invitation.acceptedAt) throw new Error("Accepted invitations cannot be revoked");
      if (!invitation.revokedAt) invitation.revokedAt = new Date().toISOString();
      config.updatedAt = new Date().toISOString();
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "member.invitation-revoke", { target: invitationId });
  }

  async acceptInvitation(token: string, name: string, sessionDays = 90): Promise<{ member: TeamMember; session: IssuedTeamKey }> {
    if (!name.trim() || name.trim().length > 128) throw new Error("Member name must contain 1-128 characters");
    if (typeof token !== "string" || token.length < 20 || token.length > 512 || !token.startsWith("dri_")) throw new TeamAuthError("Invalid invitation token", 401);
    const validSessionDays = boundedDays(sessionDays, "Member session days");
    let member!: TeamMember;
    let created!: ReturnType<typeof issueKey>;
    let invitationId!: string;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      const invitation = (config.invitations ?? []).find((candidate) => token.startsWith(`dri_${candidate.id}_`));
      const actual = Buffer.from(sha256(token));
      const expected = Buffer.from(invitation?.tokenHash ?? sha256("dry-run-invalid-invitation"));
      const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
      if (!valid || !invitation || invitation.revokedAt || invitation.acceptedAt || Date.parse(invitation.expiresAt) <= Date.now()) {
        throw new TeamAuthError("Invalid or expired invitation token", 401);
      }
      invitationId = invitation.id;
      if ((config.members ?? []).some((candidate) => candidate.email === invitation.email)) throw new Error(`A member already exists for ${invitation.email}`);
      const now = new Date().toISOString();
      member = {
        id: newId("member"),
        email: invitation.email,
        name: name.trim(),
        role: invitation.role,
        ...(invitation.projectIds ? { projectIds: [...invitation.projectIds] } : {}),
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      // Member sessions resolve project scope from the live member + group
      // directory on every request. Keeping a second frozen scope on the
      // session key would prevent later group assignment from taking effect.
      created = issueKey(`member:${invitation.email}`, invitation.role, undefined, {
        memberId: member.id,
        expiresAt: new Date(Date.now() + validSessionDays * 86_400_000).toISOString(),
      });
      (config.members ??= []).push(member);
      config.keys.push(created.stored);
      invitation.acceptedAt = now;
      config.updatedAt = now;
      atomicWriteJson(this.configFile, config);
    });
    const principal: TeamPrincipal = { keyId: created.stored.id, keyName: created.stored.name, role: member.role, memberId: member.id, memberName: member.name, memberEmail: member.email, ...(member.projectIds ? { projectIds: [...member.projectIds] } : {}) };
    await this.audit(principal, "member.accept", { target: member.id, details: { invitationId, email: member.email } });
    return { member: structuredClone(member), session: { key: publicKey(created.stored), token: created.token } };
  }

  async updateMember(
    actor: TeamPrincipal,
    memberId: string,
    changes: { name?: string; role?: Exclude<TeamRole, "ingest">; projectIds?: string[] | null; status?: TeamMemberStatus },
  ): Promise<TeamMember> {
    requireWorkspaceCapability(actor, "manage-members");
    if (actor.memberId === memberId && (changes.role != null || changes.status === "suspended" || changes.projectIds !== undefined)) {
      throw new Error("Refusing to remove or reduce the current member's own access");
    }
    if (changes.name != null && (!changes.name.trim() || changes.name.trim().length > 128)) throw new Error("Member name must contain 1-128 characters");
    if (changes.role != null) assertMemberRole(changes.role);
    if (changes.status != null && !["active", "suspended"].includes(changes.status)) throw new Error("Invalid member status");
    let updated!: TeamMember;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      const member = (config.members ?? []).find((candidate) => candidate.id === memberId);
      if (!member) throw new Error(`Unknown member: ${memberId}`);
      if (changes.name != null) member.name = changes.name.trim();
      if (changes.role != null) member.role = changes.role;
      if (changes.projectIds !== undefined) {
        if (changes.projectIds === null) delete member.projectIds;
        else member.projectIds = uniqueProjectIds(config, changes.projectIds);
      }
      if (changes.status != null) member.status = changes.status;
      member.updatedAt = new Date().toISOString();
      config.updatedAt = member.updatedAt;
      updated = structuredClone(member);
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "member.update", { target: memberId, details: { name: changes.name, role: changes.role, projectIds: changes.projectIds, status: changes.status } });
    return updated;
  }

  async provisionFederatedMember(fields: {
    provider: TeamExternalIdentity["provider"];
    issuer: string;
    subject: string;
    email: string;
    name: string;
    role?: Exclude<TeamRole, "ingest">;
    projectIds?: string[];
    active?: boolean;
  }): Promise<TeamMember> {
    const email = normalizeEmail(fields.email);
    if (!fields.issuer.trim() || fields.issuer.length > 2048 || !fields.subject.trim() || fields.subject.length > 512) throw new Error("Federated identity issuer and subject are required");
    if (!fields.name.trim() || fields.name.trim().length > 128) throw new Error("Member name must contain 1-128 characters");
    const role = fields.role ?? "viewer";
    assertMemberRole(role);
    let member!: TeamMember;
    let created = false;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      const identity = { provider: fields.provider, issuer: fields.issuer, subject: fields.subject } satisfies TeamExternalIdentity;
      member = (config.members ?? []).find((candidate) => candidate.identities?.some((value) => sameIdentity(value, identity)))
        ?? (config.members ?? []).find((candidate) => candidate.email === email)!;
      if (!member) {
        const now = new Date().toISOString();
        member = {
          id: newId("member"), email, name: fields.name.trim(), role,
          ...(fields.projectIds ? { projectIds: uniqueProjectIds(config, fields.projectIds) } : {}),
          status: fields.active === false ? "suspended" : "active",
          identities: [identity], createdAt: now, updatedAt: now,
        };
        (config.members ??= []).push(member);
        created = true;
      } else {
        if (member.email !== email && (config.members ?? []).some((candidate) => candidate.id !== member.id && candidate.email === email)) throw new Error(`A member already exists for ${email}`);
        member.email = email;
        member.name = fields.name.trim();
        member.role = role;
        if (fields.projectIds) member.projectIds = uniqueProjectIds(config, fields.projectIds);
        else delete member.projectIds;
        if (fields.provider === "scim") member.status = fields.active === false ? "suspended" : "active";
        if (!member.identities?.some((value) => sameIdentity(value, identity))) (member.identities ??= []).push(identity);
        member.updatedAt = new Date().toISOString();
      }
      config.updatedAt = member.updatedAt;
      atomicWriteJson(this.configFile, config);
    });
    await this.audit({ system: true }, created ? "member.federated-create" : "member.federated-update", { target: member.id, details: { provider: fields.provider, issuer: fields.issuer, email, active: member.status === "active" } });
    return structuredClone(member);
  }

  async createMemberSession(memberId: string, name: string, sessionDays = 1): Promise<IssuedTeamKey> {
    const days = boundedDays(sessionDays, "Member session days");
    let created!: ReturnType<typeof issueKey>;
    let member!: TeamMember;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      member = (config.members ?? []).find((candidate) => candidate.id === memberId)!;
      if (!member || member.status !== "active") throw new TeamAuthError("Member is not active", 403);
      created = issueKey(name, member.role, undefined, { memberId, expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() });
      config.keys.push(created.stored);
      member.lastSeenAt = new Date().toISOString();
      member.updatedAt = member.lastSeenAt;
      config.updatedAt = member.updatedAt;
      atomicWriteJson(this.configFile, config);
    });
    await this.audit({ keyId: created.stored.id, keyName: created.stored.name, role: member.role, memberId: member.id, memberName: member.name, memberEmail: member.email, ...(member.projectIds ? { projectIds: [...member.projectIds] } : {}) }, "member.session-create", { target: member.id, details: { expiresAt: created.stored.expiresAt } });
    return { key: publicKey(created.stored), token: created.token };
  }

  async createProject(actor: TeamPrincipal, name: string): Promise<TeamProject> {
    requireWorkspaceCapability(actor, "manage-projects");
    if (!name.trim() || name.length > 128) throw new Error("Project name must contain 1-128 characters");
    let project!: TeamProject;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      const projectSlug = slug(name);
      if (config.projects.some((candidate) => candidate.slug === projectSlug)) throw new Error(`Project already exists: ${name}`);
      project = { id: newId("project"), name, slug: projectSlug, createdAt: new Date().toISOString() };
      config.projects.push(project);
      config.updatedAt = new Date().toISOString();
      atomicWriteJson(this.configFile, config);
    });
    this.project(project.id);
    await this.audit(actor, "project.create", { projectId: project.id, target: project.name });
    return structuredClone(project);
  }

  listProjects(actor: TeamPrincipal): TeamProject[] {
    requireCapability(actor, "read");
    return this.config().projects.filter((project) => !actor.projectIds || actor.projectIds.includes(project.id));
  }

  project(idOrSlug: string): TeamProjectStores {
    const config = this.config();
    const project = config.projects.find((candidate) => candidate.id === idOrSlug || candidate.slug === idOrSlug);
    if (!project) throw new Error(`Unknown project: ${idOrSlug}`);
    const root = path.join(this.dir, "projects", `${project.slug}-${sha256(project.id).slice(7, 15)}`);
    ensurePrivateDirectory(root);
    return {
      project: structuredClone(project),
      root,
      traces: new TraceStore(path.join(root, "traces")),
      experiments: new ExperimentStore(path.join(root, "experiments")),
      prompts: new PromptRegistry(path.join(root, "prompts")),
      annotations: new AnnotationStore(path.join(root, "annotations")),
      online: new OnlineEvaluationStore(path.join(root, "online")),
      playground: new PlaygroundStore(path.join(root, "playground")),
      regressions: new RegressionStore(path.join(root, "regressions")),
      monitors: new QualityMonitorStore(path.join(root, "monitors")),
      intelligence: new IntelligenceStore(path.join(root, "intelligence")),
      judges: new JudgeReliabilityStore(path.join(root, "judges")),
      access: new ObjectAccessStore(path.join(root, "access")),
      migrations: new MigrationStore(path.join(root, "migrations")),
    };
  }

  async setRetention(actor: TeamPrincipal, enabled: boolean, days: number): Promise<TeamConfig["retention"]> {
    requireWorkspaceCapability(actor, "manage-retention");
    let retention!: TeamConfig["retention"];
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      config.retention = { enabled, days: positiveDays(days) };
      config.updatedAt = new Date().toISOString();
      retention = config.retention;
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "retention.configure", { details: retention });
    return retention;
  }

  async setProjectRetention(actor: TeamPrincipal, projectId: string, enabled: boolean, days: number): Promise<NonNullable<TeamProject["retention"]>> {
    requireProjectCapability(actor, "manage-retention", projectId);
    let retention!: NonNullable<TeamProject["retention"]>;
    await withFileLock(this.configFile, () => {
      const config = validateTeamConfig(readJsonFile(this.configFile));
      const project = config.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error(`Unknown project: ${projectId}`);
      project.retention = { enabled, days: positiveDays(days) };
      config.updatedAt = new Date().toISOString();
      retention = project.retention;
      atomicWriteJson(this.configFile, config);
    });
    await this.audit(actor, "retention.project-configure", { projectId, details: retention });
    return retention;
  }

  planRetention(projectId: string, olderThanDays?: number, now = new Date()): RetentionPlan {
    const stores = this.project(projectId);
    const config = this.config();
    const project = config.projects.find((candidate) => candidate.id === stores.project.id)!;
    const days = positiveDays(olderThanDays ?? project.retention?.days ?? config.retention.days);
    const cutoffMs = now.getTime() - days * 86_400_000;
    const traces = oldJsonFiles(stores.traces.dir, cutoffMs, retentionTraceDate);
    const experiments = oldJsonFiles(stores.experiments.dir, cutoffMs, retentionExperimentDate);
    const completedAnnotations = oldJsonFiles(stores.annotations.itemsDir, cutoffMs, retentionAnnotationDate);
    const qualityMonitorResults = oldJsonFiles(stores.monitors.resultsDir, cutoffMs, retentionQualityMonitorResultDate);
    return {
      projectId: stores.project.id,
      olderThanDays: days,
      cutoff: new Date(cutoffMs).toISOString(),
      traces,
      experiments,
      completedAnnotations,
      qualityMonitorResults,
      total: traces.length + experiments.length + completedAnnotations.length + qualityMonitorResults.length,
    };
  }

  async applyRetention(actor: TeamPrincipal | { system: true }, projectId: string, opts: { olderThanDays?: number; dryRun?: boolean } = {}): Promise<RetentionPlan> {
    if (!("system" in actor)) requireProjectCapability(actor, "manage-retention", this.project(projectId).project.id);
    const plan = this.planRetention(projectId, opts.olderThanDays);
    const applied = opts.dryRun ? plan : await applyRetentionPlan(plan);
    await this.audit(actor, opts.dryRun ? "retention.plan" : "retention.apply", {
      projectId: applied.projectId,
      details: { cutoff: applied.cutoff, total: applied.total },
    });
    return applied;
  }

  async runConfiguredRetention(): Promise<RetentionPlan[]> {
    const config = this.config();
    const results: RetentionPlan[] = [];
    for (const project of config.projects) {
      const policy = project.retention ?? config.retention;
      if (policy.enabled) results.push(await this.applyRetention({ system: true }, project.id, { olderThanDays: policy.days }));
    }
    return results;
  }

  async audit(
    actor: TeamPrincipal | { system: true },
    action: string,
    fields: { projectId?: string; target?: string; details?: Record<string, unknown> } = {},
  ): Promise<AuditEntry> {
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(action)) throw new Error("Invalid audit action");
    const entry: AuditEntry = {
      id: newId("audit"),
      timestamp: new Date().toISOString(),
      actor: "system" in actor ? { system: true } : { keyId: actor.keyId, role: actor.role, ...(actor.memberId ? { memberId: actor.memberId } : {}) },
      action,
      ...(fields.projectId ? { projectId: fields.projectId } : {}),
      ...(fields.target ? { target: fields.target } : {}),
      ...(fields.details ? { details: sanitizeAudit(fields.details) } : {}),
    };
    await withFileLock(this.auditFile, () => {
      appendFileSync(this.auditFile, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    return entry;
  }

  readAudit(actor: TeamPrincipal, opts: { limit?: number; projectId?: string } = {}): AuditEntry[] {
    requireWorkspaceCapability(actor, "read-audit");
    if (!existsSync(this.auditFile)) return [];
    const limit = Math.max(1, Math.min(1_000, Math.floor(opts.limit ?? 200)));
    const entries = readLastLines(this.auditFile, Math.min(20_000, limit * (opts.projectId ? 20 : 1)), 16 * 1024 * 1024).flatMap((line) => {
      try { return [JSON.parse(line) as AuditEntry]; } catch { return []; }
    });
    return entries.filter((entry) => !opts.projectId || entry.projectId === opts.projectId).slice(-limit).reverse();
  }

  projectUsage(projectId: string): TeamProjectUsage {
    return directoryUsage(this.project(projectId).root);
  }

  async withProjectQuota<T>(
    projectId: string,
    quota: TeamProjectQuota,
    reservation: { writes?: TeamProjectWrite[]; additionalBytes?: number; additionalFiles?: number },
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const stores = this.project(projectId);
    const maxBytes = positiveInteger(quota.maxBytes, "Project byte quota");
    const maxFiles = positiveInteger(quota.maxFiles, "Project file quota");
    const extraBytes = nonNegativeInteger(reservation.additionalBytes ?? 0, "Reserved project bytes");
    const extraFiles = nonNegativeInteger(reservation.additionalFiles ?? 0, "Reserved project files");
    return withFileLock(path.join(stores.root, ".quota"), async () => {
      const usage = directoryUsage(stores.root);
      let projectedBytes = usage.bytes + extraBytes;
      let projectedFiles = usage.files + extraFiles;
      const writes = new Map<string, number>();
      for (const write of reservation.writes ?? []) {
        const file = path.resolve(write.file);
        assertContained(stores.root, file);
        writes.set(file, positiveInteger(write.bytes, "Reserved write bytes"));
      }
      for (const [file, bytes] of writes) {
        if (existsSync(file)) projectedBytes -= statSync(file).size;
        else projectedFiles += 1;
        projectedBytes += bytes;
      }
      if (projectedFiles > maxFiles || projectedBytes > maxBytes) {
        throw new TeamQuotaError({ usage, projected: { files: projectedFiles, bytes: projectedBytes }, quota: { maxFiles, maxBytes } });
      }
      return fn();
    });
  }
}

export class AnnotationStore {
  readonly dir: string;
  readonly queuesDir: string;
  readonly itemsDir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    this.queuesDir = path.join(this.dir, "queues");
    this.itemsDir = path.join(this.dir, "items");
    ensurePrivateDirectory(this.queuesDir);
    ensurePrivateDirectory(this.itemsDir);
  }

  async createQueue(name: string, description?: string, options: { mode?: AnnotationQueue["mode"]; reviewersPerTarget?: number; assignment?: AnnotationQueue["assignment"]; reviewerIds?: string[]; adjudicationQueueId?: string; slaHours?: number } = {}): Promise<AnnotationQueue> {
    if (!name.trim() || name.length > 128) throw new Error("Queue name must contain 1-128 characters");
    const now = new Date().toISOString();
    const queue: AnnotationQueue = {
      kind: "dry-run.annotation-queue",
      version: 1,
      id: newId("queue"),
      name,
      ...(description ? { description } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.reviewersPerTarget != null ? { reviewersPerTarget: reviewCount(options.reviewersPerTarget) } : {}),
      ...(options.assignment ? { assignment: options.assignment } : {}),
      ...(options.reviewerIds ? { reviewerIds: uniqueStrings(options.reviewerIds) } : {}),
      ...(options.adjudicationQueueId ? { adjudicationQueueId: options.adjudicationQueueId } : {}),
      ...(options.slaHours != null ? { slaHours: positiveHours(options.slaHours) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await withFileLock(this.queueFile(queue.id), () => atomicWriteJson(this.queueFile(queue.id), queue));
    return queue;
  }

  listQueues(): AnnotationQueue[] {
    return listValidJson(this.queuesDir, validateQueue).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  pageQueues(opts: { limit?: number; cursor?: string } = {}): AnnotationPage<AnnotationQueue> {
    return pageValidJson(this.queuesDir, validateQueue, () => true, opts.limit ?? 100, opts.cursor, opts.limit ?? 100);
  }

  loadQueue(id: string): AnnotationQueue { return validateQueue(readJsonFile(this.queueFile(id))); }

  async enqueue(queueId: string, target: AnnotationItem["target"], opts: { priority?: number; labels?: string[]; metadata?: Record<string, unknown>; assignedTo?: string } = {}): Promise<AnnotationItem> {
    this.loadQueue(queueId);
    validateTarget(target);
    const now = new Date().toISOString();
    const item: AnnotationItem = {
      kind: "dry-run.annotation-item",
      version: 1,
      id: newId("annotation"),
      queueId,
      target: structuredClone(target),
      status: "pending",
      priority: finitePriority(opts.priority ?? 0),
      labels: uniqueStrings(opts.labels ?? []),
      ...(opts.assignedTo ? { assignedTo: nonEmpty(opts.assignedTo, "Annotation assignee", 128) } : {}),
      ...(opts.metadata ? { metadata: jsonClone(opts.metadata, "Annotation metadata") } : {}),
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    await withFileLock(this.itemFile(item.id), () => atomicWriteJson(this.itemFile(item.id), item));
    return item;
  }

  listItems(opts: { queueId?: string; status?: AnnotationStatus; assignedTo?: string; limit?: number } = {}): AnnotationItem[] {
    const limit = Math.max(1, Math.min(10_000, Math.floor(opts.limit ?? 500)));
    return listValidJson(this.itemsDir, validateAnnotationItem)
      .filter((item) => !opts.queueId || item.queueId === opts.queueId)
      .filter((item) => !opts.status || item.status === opts.status)
      .filter((item) => !opts.assignedTo || item.assignedTo === opts.assignedTo)
      .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit);
  }

  pageItems(opts: { queueId?: string; status?: AnnotationStatus; assignedTo?: string; limit?: number; cursor?: string; maxScan?: number } = {}): AnnotationPage<AnnotationItem> {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
    return pageValidJson(this.itemsDir, validateAnnotationItem, (item) =>
      (!opts.queueId || item.queueId === opts.queueId)
      && (!opts.status || item.status === opts.status)
      && (!opts.assignedTo || item.assignedTo === opts.assignedTo),
    limit, opts.cursor, opts.maxScan ?? Math.max(200, limit * 20));
  }

  loadItem(id: string): AnnotationItem { return validateAnnotationItem(readJsonFile(this.itemFile(id))); }

  agreement(queueId: string): AnnotationAgreementReport {
    this.loadQueue(queueId);
    const completed = this.listItems({ queueId, status: "completed", limit: 10_000 });
    const ratings = completed.flatMap((item) => item.assignedTo && item.label
      ? [{ targetId: annotationTargetKey(item.target), reviewerId: item.assignedTo, label: item.label }]
      : []);
    const report = nominalAgreement(ratings);
    return { queueId, completedItems: completed.length, unratedItems: completed.length - ratings.length, ...report };
  }

  async claim(id: string, assignee: string, expectedRevision?: number): Promise<AnnotationItem> {
    if (!assignee.trim() || assignee.length > 128) throw new Error("Assignee must contain 1-128 characters");
    return this.mutate(id, expectedRevision, (item) => {
      if (item.assignedTo && item.assignedTo !== assignee) throw new Error("Annotation is assigned to another reviewer");
      if (item.status !== "pending" && !(item.status === "claimed" && item.assignedTo === assignee)) throw new Error(`Annotation is already ${item.status}`);
      item.status = "claimed";
      item.assignedTo = assignee;
    });
  }

  async complete(id: string, result: { score?: number; label?: string; comment?: string; status?: "completed" | "skipped" }, expectedRevision?: number): Promise<AnnotationItem> {
    if (result.score != null && (!Number.isFinite(result.score) || result.score < 0 || result.score > 1)) throw new Error("Annotation score must be between 0 and 1");
    if (result.label != null && (!result.label.trim() || result.label.length > 128)) throw new Error("Annotation label must contain 1-128 characters");
    if (result.comment != null && result.comment.length > 10_000) throw new Error("Annotation comment exceeds 10,000 characters");
    return this.mutate(id, expectedRevision, (item) => {
      if (["completed", "skipped"].includes(item.status)) throw new Error(`Annotation is already ${item.status}`);
      item.status = result.status ?? "completed";
      if (result.score != null) item.score = result.score;
      if (result.label != null) item.label = result.label;
      if (result.comment != null) item.comment = result.comment;
      item.completedAt = new Date().toISOString();
    });
  }

  private async mutate(id: string, expectedRevision: number | undefined, fn: (item: AnnotationItem) => void): Promise<AnnotationItem> {
    const file = this.itemFile(id);
    return withFileLock(file, () => {
      const item = validateAnnotationItem(readJsonFile(file));
      if (expectedRevision != null && item.revision !== expectedRevision) throw new AnnotationConflictError(item.revision);
      fn(item);
      item.revision += 1;
      item.updatedAt = new Date().toISOString();
      atomicWriteJson(file, item);
      return structuredClone(item);
    });
  }

  private queueFile(id: string): string { return safeJsonFile(this.queuesDir, id, "queue"); }
  private itemFile(id: string): string { return safeJsonFile(this.itemsDir, id, "annotation"); }
}

export class TeamAuthError extends Error {
  readonly status: 401 | 403;
  constructor(message: string, status: 401 | 403) { super(message); this.name = "TeamAuthError"; this.status = status; }
}

export class AnnotationConflictError extends Error {
  readonly status = 409;
  readonly currentRevision: number;
  constructor(currentRevision: number) { super(`Annotation revision conflict; current revision is ${currentRevision}`); this.name = "AnnotationConflictError"; this.currentRevision = currentRevision; }
}

export class TeamQuotaError extends Error {
  readonly status = 507;
  readonly usage: TeamProjectUsage;
  readonly projected: TeamProjectUsage;
  readonly quota: TeamProjectQuota;
  constructor(fields: { usage: TeamProjectUsage; projected: TeamProjectUsage; quota: TeamProjectQuota }) {
    super(`Project storage quota exceeded (${fields.projected.files}/${fields.quota.maxFiles} files, ${fields.projected.bytes}/${fields.quota.maxBytes} bytes)`);
    this.name = "TeamQuotaError";
    this.usage = fields.usage;
    this.projected = fields.projected;
    this.quota = fields.quota;
  }
}

export function validateIncomingTrace(value: unknown): TraceDocument {
  const trace = validateStoredTrace(value);
  if (Date.parse(trace.endedAt) > Date.now() + 5 * 60_000) throw new Error("Trace endedAt exceeds the allowed five-minute future skew");
  return trace;
}

export function validateIncomingExperiment(value: unknown): ExperimentDocument {
  if (!isRecord(value) || value.kind !== "dry-run.experiment" || value.version !== 1 || typeof value.id !== "string" || !safeId(value.id) || !Array.isArray(value.results)) {
    throw new Error("Unsupported experiment document");
  }
  if (typeof value.name !== "string" || !value.name.trim() || !["running", "completed", "aborted"].includes(String(value.status))) throw new Error("Experiment identity/status is invalid");
  const createdAt = isoTimestamp(value.createdAt, "Experiment createdAt");
  const updatedAt = isoTimestamp(value.updatedAt, "Experiment updatedAt");
  if (updatedAt < createdAt) throw new Error("Experiment updatedAt cannot precede createdAt");
  if (createdAt > Date.now() + 5 * 60_000) throw new Error("Experiment createdAt exceeds the allowed five-minute future skew");
  if (!Array.isArray(value.aggregates) || !Array.isArray(value.feedback) || !isRecord(value.summary) || !isRecord(value.config)) throw new Error("Experiment collections/config are incomplete");
  return value as unknown as ExperimentDocument;
}

function issueKey(
  name: string,
  role: TeamRole,
  projectIds?: string[],
  fields: { memberId?: string; expiresAt?: string; customRoleId?: string; serviceAccount?: boolean; rotationOfKeyId?: string } = {},
): { stored: TeamApiKey; token: string } {
  const id = randomBytes(9).toString("base64url");
  const token = `drk_${id}_${randomBytes(32).toString("base64url")}`;
  return {
    token,
    stored: {
      id,
      name,
      role,
      tokenHash: sha256(token),
      ...(projectIds ? { projectIds: [...projectIds] } : {}),
      ...(fields.memberId ? { memberId: fields.memberId } : {}),
      ...(fields.customRoleId ? { customRoleId: fields.customRoleId } : {}),
      ...(fields.serviceAccount ? { serviceAccount: true } : {}),
      ...(fields.rotationOfKeyId ? { rotationOfKeyId: fields.rotationOfKeyId } : {}),
      createdAt: new Date().toISOString(),
      ...(fields.expiresAt ? { expiresAt: fields.expiresAt } : {}),
    },
  };
}

function issueInvitation(
  email: string,
  role: Exclude<TeamRole, "ingest">,
  invitedByKeyId: string,
  expiresInDays: number,
  projectIds?: string[],
): { stored: TeamInvitation; token: string } {
  const id = randomBytes(9).toString("base64url");
  const token = `dri_${id}_${randomBytes(32).toString("base64url")}`;
  const createdAt = new Date().toISOString();
  return {
    token,
    stored: {
      id,
      email,
      role,
      ...(projectIds ? { projectIds: [...projectIds] } : {}),
      tokenHash: sha256(token),
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + expiresInDays * 86_400_000).toISOString(),
      invitedByKeyId,
    },
  };
}

function publicKey(key: TeamApiKey): Omit<TeamApiKey, "tokenHash"> {
  const { tokenHash: _tokenHash, ...value } = key;
  return structuredClone(value);
}

function publicInvitation(invitation: TeamInvitation): Omit<TeamInvitation, "tokenHash"> {
  const { tokenHash: _tokenHash, ...value } = invitation;
  return structuredClone(value);
}

function validateTeamConfig(value: unknown): TeamConfig {
  if (!isRecord(value) || value.kind !== "dry-run.team" || value.version !== 1 || typeof value.id !== "string" || typeof value.name !== "string" || !Array.isArray(value.keys) || !Array.isArray(value.projects)) {
    throw new Error("Unsupported team workspace");
  }
  if (!isRecord(value.retention) || typeof value.retention.enabled !== "boolean") throw new Error("Team workspace retention config is invalid");
  positiveDays(Number(value.retention.days));
  if (value.organization != null) validateOrganization(value.organization);
  const projectIds = new Set<string>();
  for (const project of value.projects) {
    if (!isRecord(project) || typeof project.id !== "string" || !safeId(project.id) || typeof project.name !== "string" || typeof project.slug !== "string") throw new Error("Team workspace contains an invalid project");
    if (projectIds.has(project.id)) throw new Error(`Duplicate team project id: ${project.id}`);
    if (project.retention != null) {
      if (!isRecord(project.retention) || typeof project.retention.enabled !== "boolean") throw new Error(`Project ${project.id} has invalid retention`);
      positiveDays(Number(project.retention.days));
    }
    projectIds.add(project.id);
  }
  const customRoles = value.customRoles ?? [];
  if (!Array.isArray(customRoles)) throw new Error("Team workspace custom roles are invalid");
  const customRoleIds = new Set<string>();
  for (const role of customRoles) {
    if (!isRecord(role) || typeof role.id !== "string" || !safeId(role.id) || typeof role.name !== "string" || !role.name.trim() || !Array.isArray(role.capabilities)) throw new Error("Team workspace contains an invalid custom role");
    assertRole(role.baseRole);
    normalizedRoleCapabilities(role.baseRole, role.capabilities as TeamCapability[]);
    if (customRoleIds.has(role.id)) throw new Error(`Duplicate custom role id: ${role.id}`);
    customRoleIds.add(role.id);
    if (!Number.isSafeInteger(role.revision) || Number(role.revision) < 1) throw new Error(`Custom role ${role.id} has an invalid revision`);
    isoTimestamp(role.createdAt, `Custom role ${role.id} createdAt`); isoTimestamp(role.updatedAt, `Custom role ${role.id} updatedAt`);
  }
  const keyIds = new Set<string>();
  for (const key of value.keys) {
    if (!isRecord(key) || typeof key.id !== "string" || typeof key.name !== "string" || typeof key.tokenHash !== "string") throw new Error("Team workspace contains an invalid API key");
    assertRole(key.role);
    if (keyIds.has(key.id)) throw new Error(`Duplicate API key id: ${key.id}`);
    keyIds.add(key.id);
    if (key.projectIds != null && (!Array.isArray(key.projectIds) || key.projectIds.some((id: unknown) => typeof id !== "string" || !projectIds.has(id)))) throw new Error(`API key ${key.id} has an invalid project scope`);
    if (key.customRoleId != null && (typeof key.customRoleId !== "string" || !customRoleIds.has(key.customRoleId) || customRole(value as unknown as TeamConfig, key.customRoleId).baseRole !== key.role)) throw new Error(`API key ${key.id} has an invalid custom role`);
    if (key.serviceAccount != null && typeof key.serviceAccount !== "boolean") throw new Error(`API key ${key.id} has an invalid service-account flag`);
    if (key.expiresAt != null) isoTimestamp(key.expiresAt, `API key ${key.id} expiresAt`);
  }
  const members = value.members ?? [];
  if (!Array.isArray(members)) throw new Error("Team workspace members are invalid");
  const memberIds = new Set<string>();
  const memberEmails = new Set<string>();
  for (const member of members) {
    if (!isRecord(member) || typeof member.id !== "string" || !safeId(member.id) || typeof member.name !== "string" || !member.name.trim() || typeof member.email !== "string" || member.email !== normalizeEmail(member.email)) throw new Error("Team workspace contains an invalid member");
    assertMemberRole(member.role);
    if (!["active", "suspended"].includes(String(member.status))) throw new Error(`Member ${member.id} has an invalid status`);
    if (memberIds.has(member.id) || memberEmails.has(member.email)) throw new Error("Team workspace contains duplicate members");
    memberIds.add(member.id); memberEmails.add(member.email);
    if (member.projectIds != null && (!Array.isArray(member.projectIds) || member.projectIds.some((id: unknown) => typeof id !== "string" || !projectIds.has(id)))) throw new Error(`Member ${member.id} has an invalid project scope`);
    if (member.customRoleId != null && (typeof member.customRoleId !== "string" || !customRoleIds.has(member.customRoleId) || customRole(value as unknown as TeamConfig, member.customRoleId).baseRole !== member.role)) throw new Error(`Member ${member.id} has an invalid custom role`);
    if (member.identities != null && (!Array.isArray(member.identities) || member.identities.some((identity: unknown) => !validExternalIdentity(identity)))) throw new Error(`Member ${member.id} has an invalid external identity`);
    isoTimestamp(member.createdAt, `Member ${member.id} createdAt`); isoTimestamp(member.updatedAt, `Member ${member.id} updatedAt`);
  }
  const groups = value.groups ?? [];
  if (!Array.isArray(groups)) throw new Error("Team workspace groups are invalid");
  const groupIds = new Set<string>();
  for (const group of groups) {
    if (!isRecord(group) || typeof group.id !== "string" || !safeId(group.id) || typeof group.name !== "string" || !group.name.trim() || !Array.isArray(group.memberIds) || group.memberIds.some((id: unknown) => typeof id !== "string" || !memberIds.has(id))) throw new Error("Team workspace contains an invalid group");
    if (groupIds.has(group.id)) throw new Error(`Duplicate group id: ${group.id}`);
    groupIds.add(group.id);
    if (new Set(group.memberIds).size !== group.memberIds.length) throw new Error(`Group ${group.id} contains duplicate members`);
    if (group.projectIds != null && (!Array.isArray(group.projectIds) || group.projectIds.some((id: unknown) => typeof id !== "string" || !projectIds.has(id)))) throw new Error(`Group ${group.id} has an invalid project scope`);
    if (group.customRoleId != null && (typeof group.customRoleId !== "string" || !customRoleIds.has(group.customRoleId))) throw new Error(`Group ${group.id} has an invalid custom role`);
    if (!Number.isSafeInteger(group.revision) || Number(group.revision) < 1) throw new Error(`Group ${group.id} has an invalid revision`);
    isoTimestamp(group.createdAt, `Group ${group.id} createdAt`); isoTimestamp(group.updatedAt, `Group ${group.id} updatedAt`);
  }
  for (const key of value.keys) if (key.memberId != null && (typeof key.memberId !== "string" || !memberIds.has(key.memberId))) throw new Error(`API key ${key.id} has an invalid member`);
  for (const key of value.keys) {
    if (key.rotatedToKeyId != null && (typeof key.rotatedToKeyId !== "string" || !keyIds.has(key.rotatedToKeyId))) throw new Error(`API key ${key.id} has an invalid rotation target`);
    if (key.rotationOfKeyId != null && (typeof key.rotationOfKeyId !== "string" || !keyIds.has(key.rotationOfKeyId))) throw new Error(`API key ${key.id} has an invalid rotation source`);
    if (key.rotatedAt != null) isoTimestamp(key.rotatedAt, `API key ${key.id} rotatedAt`);
  }
  const invitations = value.invitations ?? [];
  if (!Array.isArray(invitations)) throw new Error("Team workspace invitations are invalid");
  const invitationIds = new Set<string>();
  for (const invitation of invitations) {
    if (!isRecord(invitation) || typeof invitation.id !== "string" || typeof invitation.tokenHash !== "string" || typeof invitation.email !== "string" || invitation.email !== normalizeEmail(invitation.email) || typeof invitation.invitedByKeyId !== "string") throw new Error("Team workspace contains an invalid invitation");
    assertMemberRole(invitation.role);
    if (invitationIds.has(invitation.id)) throw new Error(`Duplicate invitation id: ${invitation.id}`);
    invitationIds.add(invitation.id);
    if (invitation.projectIds != null && (!Array.isArray(invitation.projectIds) || invitation.projectIds.some((id: unknown) => typeof id !== "string" || !projectIds.has(id)))) throw new Error(`Invitation ${invitation.id} has an invalid project scope`);
    isoTimestamp(invitation.createdAt, `Invitation ${invitation.id} createdAt`); isoTimestamp(invitation.expiresAt, `Invitation ${invitation.id} expiresAt`);
  }
  return value as unknown as TeamConfig;
}

function validateQueue(value: unknown): AnnotationQueue {
  if (!isRecord(value) || value.kind !== "dry-run.annotation-queue" || value.version !== 1 || typeof value.id !== "string" || typeof value.name !== "string") throw new Error("Unsupported annotation queue");
  if (value.mode != null && !["single", "double-blind", "adjudicated"].includes(String(value.mode))) throw new Error("Annotation queue mode is invalid");
  if (value.reviewersPerTarget != null) reviewCount(Number(value.reviewersPerTarget));
  if (value.assignment != null && !["manual", "round-robin", "deterministic-random"].includes(String(value.assignment))) throw new Error("Annotation queue assignment is invalid");
  if (value.reviewerIds != null) uniqueStrings(value.reviewerIds as string[]);
  if (value.slaHours != null) positiveHours(Number(value.slaHours));
  return value as unknown as AnnotationQueue;
}

function validateAnnotationItem(value: unknown): AnnotationItem {
  if (!isRecord(value) || value.kind !== "dry-run.annotation-item" || value.version !== 1 || typeof value.id !== "string" || !safeId(value.id) || typeof value.queueId !== "string" || !safeId(value.queueId) || !isRecord(value.target)) throw new Error("Unsupported annotation item");
  if (!["pending", "claimed", "completed", "skipped"].includes(String(value.status)) || !Number.isInteger(value.revision) || value.revision < 1) throw new Error("Invalid annotation state");
  isoTimestamp(value.createdAt, "Annotation createdAt");
  isoTimestamp(value.updatedAt, "Annotation updatedAt");
  validateTarget(value.target as AnnotationItem["target"]);
  return value as unknown as AnnotationItem;
}

function validateTarget(target: AnnotationItem["target"]): void {
  if (!target || !["trace", "span", "experiment-case"].includes(target.type) || typeof target.id !== "string" || !target.id.trim() || (target.subId != null && typeof target.subId !== "string")) {
    throw new Error("Invalid annotation target");
  }
}

function annotationTargetKey(target: AnnotationItem["target"]): string {
  return `${target.type}:${target.id}${target.subId ? `:${target.subId}` : ""}`;
}

function requireCapability(principal: TeamPrincipal, capability: TeamCapability): void {
  if (!principalCapabilities(principal).has(capability)) throw new TeamAuthError(`Role ${principal.role} cannot ${capability}`, 403);
}

function requireWorkspaceCapability(principal: TeamPrincipal, capability: TeamCapability): void {
  requireCapability(principal, capability);
  if (principal.projectIds) throw new TeamAuthError("Project-scoped API keys cannot perform workspace-wide administration", 403);
}

function requireProjectCapability(principal: TeamPrincipal, capability: TeamCapability, projectId: string): void {
  requireCapability(principal, capability);
  if (principal.projectIds && !principal.projectIds.includes(projectId)) throw new TeamAuthError("API key is not scoped to this project", 403);
}

function assertRole(value: unknown): asserts value is TeamRole {
  if (!["admin", "editor", "viewer", "ingest"].includes(String(value))) throw new Error(`Invalid team role: ${String(value)}`);
}

function assertMemberRole(value: unknown): asserts value is Exclude<TeamRole, "ingest"> {
  if (!["admin", "editor", "viewer"].includes(String(value))) throw new Error(`Invalid member role: ${String(value)}`);
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Invalid member email address");
  return normalized;
}

function intersectScopes(keyScopes?: string[], memberScopes?: string[]): string[] | undefined {
  if (!keyScopes && !memberScopes) return undefined;
  if (!keyScopes) return [...memberScopes!];
  if (!memberScopes) return [...keyScopes];
  const member = new Set(memberScopes);
  return keyScopes.filter((id) => member.has(id));
}

function principalCapabilities(principal: TeamPrincipal): ReadonlySet<TeamCapability> {
  return principal.capabilities ? new Set(principal.capabilities) : ROLE_CAPABILITIES[principal.role];
}

function organizationOf(config: TeamConfig): TeamOrganization {
  if (config.organization) return structuredClone(config.organization);
  return { id: `org_${sha256(config.id).slice(7, 31)}`, name: config.name, slug: slug(config.name), createdAt: config.createdAt, updatedAt: config.updatedAt };
}

function validateOrganization(value: unknown): asserts value is TeamOrganization {
  if (!isRecord(value) || typeof value.id !== "string" || !safeId(value.id) || typeof value.name !== "string" || !value.name.trim() || typeof value.slug !== "string" || !value.slug.trim()) throw new Error("Team organization is invalid");
  isoTimestamp(value.createdAt, "Organization createdAt"); isoTimestamp(value.updatedAt, "Organization updatedAt");
}

function validateRoleFields(fields: { name: string; description?: string; baseRole: TeamRole; capabilities: TeamCapability[] }): void {
  if (!fields.name.trim() || fields.name.trim().length > 128) throw new Error("Custom role name must contain 1-128 characters");
  if (fields.description != null && fields.description.length > 1_000) throw new Error("Custom role description is too long");
  assertRole(fields.baseRole);
  normalizedRoleCapabilities(fields.baseRole, fields.capabilities);
}

function normalizedRoleCapabilities(baseRole: TeamRole, capabilities: TeamCapability[]): TeamCapability[] {
  if (!Array.isArray(capabilities) || !capabilities.length) throw new Error("Custom role must contain at least one capability");
  const allowed = ROLE_CAPABILITIES[baseRole];
  const unique = [...new Set(capabilities)];
  for (const capability of unique) if (!allowed.has(capability)) throw new Error(`Capability ${String(capability)} exceeds base role ${baseRole}`);
  return unique.sort();
}

function customRole(config: TeamConfig, roleId: string): TeamCustomRole {
  const role = (config.customRoles ?? []).find((candidate) => candidate.id === roleId);
  if (!role) throw new Error(`Unknown custom role: ${roleId}`);
  return role;
}

function assertRoleAssignment(config: TeamConfig, baseRole: TeamRole, roleId: string): TeamCustomRole {
  const role = customRole(config, roleId);
  if (role.baseRole !== baseRole) throw new Error(`Custom role ${roleId} requires base role ${role.baseRole}`);
  return role;
}

function resolveCapabilities(config: TeamConfig, baseRole: TeamRole, directRoleId: string | undefined, groups: TeamGroup[]): TeamCapability[] {
  const ceiling = ROLE_CAPABILITIES[baseRole];
  const selected = new Set<TeamCapability>();
  if (directRoleId) for (const capability of assertRoleAssignment(config, baseRole, directRoleId).capabilities) selected.add(capability);
  else for (const capability of ceiling) selected.add(capability);
  for (const group of groups) {
    if (!group.customRoleId) continue;
    const role = customRole(config, group.customRoleId);
    for (const capability of role.capabilities) if (ceiling.has(capability)) selected.add(capability);
  }
  return [...selected].sort();
}

function effectiveMemberScopes(member: TeamMember, groups: TeamGroup[]): string[] | undefined {
  if (!member.projectIds) return undefined;
  const ids = new Set(member.projectIds);
  for (const group of groups) for (const id of group.projectIds ?? []) ids.add(id);
  return [...ids];
}

function uniqueMemberIds(config: TeamConfig, memberIds: string[]): string[] {
  const known = new Set((config.members ?? []).map((member) => member.id));
  const unique = [...new Set(memberIds)];
  for (const id of unique) if (!known.has(id)) throw new Error(`Unknown member: ${id}`);
  return unique;
}

function validExternalIdentity(value: unknown): value is TeamExternalIdentity {
  return isRecord(value) && ["oidc", "scim"].includes(String(value.provider))
    && typeof value.issuer === "string" && Boolean(value.issuer.trim()) && value.issuer.length <= 2048
    && typeof value.subject === "string" && Boolean(value.subject.trim()) && value.subject.length <= 512;
}

function sameIdentity(left: TeamExternalIdentity, right: TeamExternalIdentity): boolean {
  return left.provider === right.provider && left.issuer === right.issuer && left.subject === right.subject;
}

function uniqueProjectIds(config: TeamConfig, values: string[]): string[] {
  const ids = [...new Set(values)];
  for (const id of ids) if (!config.projects.some((project) => project.id === id)) throw new Error(`Unknown project scope: ${id}`);
  return ids;
}

function oldJsonFiles(dir: string, cutoffMs: number, date: (value: unknown) => string | undefined): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const timestamp = Date.parse(date(readJsonFile(file)) ?? "");
      if (Number.isFinite(timestamp) && timestamp < cutoffMs) files.push(file);
    } catch { /* Invalid or partial files are never deleted by retention. */ }
  }
  return files.sort();
}

async function applyRetentionPlan(plan: RetentionPlan): Promise<RetentionPlan> {
  const cutoffMs = Date.parse(plan.cutoff);
  const traces: string[] = [];
  const experiments: string[] = [];
  const completedAnnotations: string[] = [];
  const qualityMonitorResults: string[] = [];
  for (const file of plan.traces) if (await deleteIfExpired(file, cutoffMs, retentionTraceDate)) traces.push(file);
  for (const file of plan.experiments) if (await deleteIfExpired(file, cutoffMs, retentionExperimentDate)) experiments.push(file);
  for (const file of plan.completedAnnotations) if (await deleteIfExpired(file, cutoffMs, retentionAnnotationDate)) completedAnnotations.push(file);
  for (const file of plan.qualityMonitorResults) if (await deleteIfExpired(file, cutoffMs, retentionQualityMonitorResultDate)) qualityMonitorResults.push(file);
  return { ...plan, traces, experiments, completedAnnotations, qualityMonitorResults, total: traces.length + experiments.length + completedAnnotations.length + qualityMonitorResults.length };
}

async function deleteIfExpired(file: string, cutoffMs: number, date: (value: unknown) => string | undefined): Promise<boolean> {
  return withFileLock(file, () => {
    if (!existsSync(file)) return false;
    try {
      const timestamp = Date.parse(date(readJsonFile(file)) ?? "");
      if (!Number.isFinite(timestamp) || timestamp >= cutoffMs) return false;
      unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  });
}

function retentionTraceDate(value: unknown): string | undefined {
  const trace = validateStoredTrace(value);
  return trace.receivedAt ?? trace.endedAt;
}

function retentionExperimentDate(value: unknown): string | undefined { return validateIncomingExperiment(value).updatedAt; }

function retentionAnnotationDate(value: unknown): string | undefined {
  const item = validateAnnotationItem(value);
  return ["completed", "skipped"].includes(item.status) ? item.updatedAt : undefined;
}

function retentionQualityMonitorResultDate(value: unknown): string | undefined { return validateQualityMonitorResult(value).evaluatedAt; }

function validateStoredTrace(value: unknown): TraceDocument {
  if (!isRecord(value) || value.kind !== "dry-run.trace" || value.version !== 1 || typeof value.id !== "string" || !safeId(value.id) || !Array.isArray(value.spans)) throw new Error("Unsupported trace document");
  if (typeof value.name !== "string" || !value.name.trim() || !["ok", "error"].includes(String(value.status)) || typeof value.rootSpanId !== "string" || !safeId(value.rootSpanId)) throw new Error("Trace identity/status is invalid");
  const startedAt = isoTimestamp(value.startedAt, "Trace startedAt");
  const endedAt = isoTimestamp(value.endedAt, "Trace endedAt");
  if (endedAt < startedAt) throw new Error("Trace endedAt cannot precede startedAt");
  if (!Number.isFinite(value.durationMs) || Number(value.durationMs) < 0 || !Array.isArray(value.feedback)) throw new Error("Trace duration/feedback is invalid");
  if (value.receivedAt != null) isoTimestamp(value.receivedAt, "Trace receivedAt");
  let rootFound = false;
  for (const span of value.spans) {
    if (!isRecord(span) || typeof span.id !== "string" || !safeId(span.id) || span.traceId !== value.id || typeof span.name !== "string" || !["agent", "task", "llm", "tool", "retriever", "scorer", "custom"].includes(String(span.type)) || !["running", "ok", "error"].includes(String(span.status))) throw new Error("Trace contains an invalid span");
    isoTimestamp(span.startedAt, "Span startedAt");
    if (span.endedAt != null) isoTimestamp(span.endedAt, "Span endedAt");
    if (!isRecord(span.attributes) || !isRecord(span.metrics) || !Array.isArray(span.events)) throw new Error("Trace span collections are invalid");
    if (span.id === value.rootSpanId) rootFound = true;
  }
  if (!rootFound) throw new Error("Trace rootSpanId does not identify a span");
  return value as unknown as TraceDocument;
}

function isoTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is invalid`);
  return timestamp;
}

function directoryUsage(root: string): TeamProjectUsage {
  const usage: TeamProjectUsage = { files: 0, bytes: 0, resources: { traces: 0, experiments: 0, prompts: 0, annotationQueues: 0, annotationItems: 0, onlineRules: 0, onlineResults: 0, onlineJobs: 0, playgroundRuns: 0, regressionBundles: 0, qualityMonitors: 0, qualityMonitorResults: 0, intelligenceReports: 0, judgeReliabilityReports: 0, accessPolicies: 0 } };
  if (!existsSync(root)) return usage;
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // Atomic writers and lock owners can remove a transient directory after its
      // parent was enumerated. A quota scan is a point-in-time estimate, so a
      // concurrently removed path contributes zero usage to that estimate.
      if (isDisappearedPath(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.endsWith(".lock") || entry.name.endsWith(".tmp")) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) {
        let bytes: number;
        try {
          bytes = statSync(target).size;
        } catch (error) {
          // The file was atomically replaced or deleted after readdir(). The
          // subsequent writer is serialized by the project quota lock and will
          // reserve its own final size.
          if (isDisappearedPath(error)) continue;
          throw error;
        }
        usage.files += 1;
        usage.bytes += bytes;
        if (entry.name.endsWith(".json")) {
          const relative = path.relative(root, target).split(path.sep);
          if (relative[0] === "traces") usage.resources!.traces += 1;
          else if (relative[0] === "experiments") usage.resources!.experiments += 1;
          else if (relative[0] === "prompts") usage.resources!.prompts += 1;
          else if (relative[0] === "annotations" && relative[1] === "queues") usage.resources!.annotationQueues += 1;
          else if (relative[0] === "annotations" && relative[1] === "items") usage.resources!.annotationItems += 1;
          else if (relative[0] === "online" && relative[1] === "rules") usage.resources!.onlineRules += 1;
          else if (relative[0] === "online" && relative[1] === "results") usage.resources!.onlineResults += 1;
          else if (relative[0] === "online" && relative[1] === "jobs") usage.resources!.onlineJobs += 1;
          else if (relative[0] === "playground") usage.resources!.playgroundRuns += 1;
          else if (relative[0] === "regressions" && relative.at(-1) === "manifest.json") usage.resources!.regressionBundles += 1;
          else if (relative[0] === "monitors" && relative[1] === "definitions") usage.resources!.qualityMonitors += 1;
          else if (relative[0] === "monitors" && relative[1] === "results") usage.resources!.qualityMonitorResults += 1;
          else if (relative[0] === "intelligence") usage.resources!.intelligenceReports += 1;
          else if (relative[0] === "judges") usage.resources!.judgeReliabilityReports += 1;
          else if (relative[0] === "access") usage.resources!.accessPolicies += 1;
        }
      }
    }
  };
  visit(root);
  return usage;
}

function isDisappearedPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function readLastLines(file: string, maxLines: number, maxBytes: number): string[] {
  const size = statSync(file).size;
  let position = size;
  let bytesRead = 0;
  let newlines = 0;
  const chunks: Buffer[] = [];
  const descriptor = openSync(file, "r");
  try {
    while (position > 0 && bytesRead < maxBytes && newlines <= maxLines) {
      const length = Math.min(64 * 1024, position, maxBytes - bytesRead);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      readSync(descriptor, chunk, 0, length, position);
      chunks.unshift(chunk);
      bytesRead += length;
      for (const byte of chunk) if (byte === 10) newlines += 1;
    }
  } finally {
    closeSync(descriptor);
  }
  let text = Buffer.concat(chunks).toString("utf8");
  if (position > 0) text = text.slice(text.indexOf("\n") + 1);
  return text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
}

function assertContained(root: string, file: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Project quota target escapes the project root");
}

function listValidJson<T>(dir: string, validate: (value: unknown) => T): T[] {
  if (!existsSync(dir)) return [];
  const values: T[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    try { values.push(validate(readJsonFile(path.join(dir, file)))); } catch { /* Ignore unrelated or incomplete files. */ }
  }
  return values;
}

function pageValidJson<T>(
  dir: string,
  validate: (value: unknown) => T,
  matches: (value: T) => boolean,
  limitValue: number,
  cursor: string | undefined,
  maxScanValue: number,
): AnnotationPage<T> {
  const limit = boundedInteger(limitValue, 1, 500, "Annotation page limit");
  const maxScan = boundedInteger(maxScanValue, limit, 5_000, "Annotation page scan limit");
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : [];
  const after = decodePageCursor(cursor);
  let index = after ? names.findIndex((name) => name > after) : 0;
  if (index < 0) index = names.length;
  const items: T[] = [];
  let scanned = 0;
  let lastScanned: string | undefined;
  while (index < names.length && scanned < maxScan && items.length < limit) {
    const name = names[index++];
    lastScanned = name;
    scanned += 1;
    try {
      const value = validate(readJsonFile(path.join(dir, name)));
      if (matches(value)) items.push(value);
    } catch { /* Invalid files still advance the cursor. */ }
  }
  return { items, limit, scanned, hasMore: index < names.length, ...(lastScanned && index < names.length ? { nextCursor: Buffer.from(lastScanned).toString("base64url") } : {}) };
}

function decodePageCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  if (cursor.length > 512) throw new Error("Annotation cursor is invalid");
  const value = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^[a-zA-Z0-9_.-]{1,192}\.json$/.test(value)) throw new Error("Annotation cursor is invalid");
  return value;
}

function safeJsonFile(dir: string, id: string, label: string): string {
  if (!safeId(id)) throw new Error(`Invalid ${label} id`);
  return path.join(dir, `${id}.json`);
}

function safeId(value: string): boolean { return /^[a-zA-Z0-9_.-]{1,192}$/.test(value); }
function boundedInteger(value: number, minimum: number, maximum: number, label: string): number { if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`); return value; }
function positiveInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`); return value; }
function reviewCount(value: number): number { if (!Number.isSafeInteger(value) || value < 1 || value > 10) throw new Error("Reviewers per target must be between 1 and 10"); return value; }
function positiveHours(value: number): number { if (!Number.isFinite(value) || value <= 0 || value > 8_760) throw new Error("Review SLA must be between 0 and 8760 hours"); return value; }
function nonEmpty(value: string, label: string, maximum: number): string { if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label} must contain 1-${maximum} characters`); return value.trim(); }
function nonNegativeInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`); return value; }
function positiveDays(value: number): number { return boundedDays(value, "Retention days"); }
function boundedDays(value: number, label: string): number { if (!Number.isInteger(value) || value < 1 || value > 36_500) throw new Error(`${label} must be an integer between 1 and 36500`); return value; }
function finitePriority(value: number): number { if (!Number.isFinite(value) || value < -1_000_000 || value > 1_000_000) throw new Error("Priority must be a finite number between -1000000 and 1000000"); return value; }
function uniqueStrings(values: string[]): string[] { if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim() || value.length > 128)) throw new Error("Labels must contain 1-128 characters"); return [...new Set(values)]; }
function jsonClone<T>(value: T, label: string): T { try { return JSON.parse(JSON.stringify(value)) as T; } catch (error) { throw new Error(`${label} must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`); } }

function sanitizeAudit(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (key, item) => /token|secret|password|authorization|cookie|api[-_]?key/i.test(key) ? "[REDACTED]" : item)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
