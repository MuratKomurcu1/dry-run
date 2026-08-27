import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { OidcError, OidcService, sessionTokenFromCookies, type OidcOptions } from "./identity.ts";
import { ScimError, ScimService, type ScimOptions } from "./scim.ts";
import { AnalyticsError, type AnalyticsStore } from "./analytics.ts";
import { ObjectAccessConflictError, type ObjectAccessGrant, type ObjectResourceType } from "./access.ts";
import { ServiceMetrics, type ServiceMetricSnapshot } from "./operations.ts";
import { TEAM_STUDIO_HTML } from "./team-ui.ts";
import { OnlineEvaluationEngine, OnlineEvaluationProcessor } from "./online-evaluation.ts";
import { runPlayground, promotePlaygroundVariant, type PlaygroundProviderFactory } from "./playground.ts";
import { ReviewWorkflow } from "./review.ts";
import { ProductionIntelligenceEngine, type IntelligenceWindow } from "./intelligence.ts";
import { analyzeJudgeReliability, type JudgeObservation, type JudgeReliabilityPolicy } from "./judge-reliability.ts";
import { decodeOtlpHttp, mergeOtlpTrace, otlpToDryRunTraces } from "./otlp.ts";
import { migrateEvaluationExport, type MigrationSource } from "./integrations/migrations.ts";
import { createDemoTraces } from "./demo.ts";
import type { DistributedRuntime } from "./distributed-runtime.ts";
import type { DistributedWorkspaceState, DistributedStateStatus } from "./distributed-state.ts";
import type { DistributedScope } from "./distributed.ts";
import type { LLMProvider } from "./types.ts";
import {
  AnnotationConflictError,
  TeamAuthError,
  TeamQuotaError,
  TeamWorkspace,
  validateIncomingExperiment,
  validateIncomingTrace,
  type AnnotationStatus,
  type TeamPrincipal,
  type TeamCapability,
  type TeamMemberStatus,
  type TeamProjectQuota,
  type TeamProjectStores,
  type TeamRole,
} from "./team.ts";

export interface TeamServerOptions {
  workspace: TeamWorkspace;
  host?: string;
  port?: number;
  tls?: { cert: string | Buffer; key: string | Buffer };
  allowInsecureRemote?: boolean;
  corsOrigins?: string[];
  maxBodyBytes?: number;
  requestsPerMinute?: number;
  maxProjectBytes?: number;
  maxProjectFiles?: number;
  maxConcurrentBodies?: number;
  maxInFlightBodyBytes?: number;
  retentionIntervalMs?: number;
  monitorIntervalMs?: number;
  oidc?: OidcOptions;
  scim?: ScimOptions;
  analytics?: AnalyticsStore;
  metricsEnabled?: boolean;
  metricsToken?: string;
  gracefulShutdownMs?: number;
  localJudge?: LLMProvider;
  playgroundProvider?: PlaygroundProviderFactory;
  distributed?: DistributedRuntime;
  distributedState?: DistributedWorkspaceState;
}

export interface TeamServerHandle {
  url: string;
  host: string;
  port: number;
  secure: boolean;
  metrics(): ServiceMetricSnapshot;
  readiness(): Promise<TeamReadiness>;
  close(): Promise<void>;
}

export interface TeamReadiness {
  ok: boolean;
  checks: { workspace: { ok: boolean }; analytics: { ok: boolean; backend?: string; latencyMs?: number }; distributed?: { ok: boolean; postgres?: { latencyMs: number }; artifacts?: { latencyMs: number }; queue?: { latencyMs: number }; state?: DistributedStateStatus; error?: string } };
}

export async function startTeamServer(opts: TeamServerOptions): Promise<TeamServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4320;
  const secure = Boolean(opts.tls);
  if (!isLoopback(host) && !secure && !opts.allowInsecureRemote) {
    throw new Error("Refusing to expose team API over plaintext. Configure TLS or explicitly set allowInsecureRemote for a trusted development network.");
  }
  const maxBodyBytes = positiveInteger(opts.maxBodyBytes ?? 5 * 1024 * 1024, "maxBodyBytes");
  const limiter = new RateLimiter(positiveInteger(opts.requestsPerMinute ?? 600, "requestsPerMinute"));
  const quota: TeamProjectQuota = {
    maxBytes: positiveInteger(opts.maxProjectBytes ?? 1024 * 1024 * 1024, "maxProjectBytes"),
    maxFiles: positiveInteger(opts.maxProjectFiles ?? 100_000, "maxProjectFiles"),
  };
  const bodyBudget = new BodyBudget(
    positiveInteger(opts.maxConcurrentBodies ?? 64, "maxConcurrentBodies"),
    positiveInteger(opts.maxInFlightBodyBytes ?? 64 * 1024 * 1024, "maxInFlightBodyBytes"),
  );
  const cors = new Set(opts.corsOrigins ?? []);
  for (const origin of cors) validateOrigin(origin);
  const oidc = opts.oidc ? new OidcService(opts.workspace, opts.oidc) : undefined;
  const scim = opts.scim ? new ScimService(opts.workspace, opts.scim) : undefined;
  if (opts.analytics) await opts.analytics.initialize();
  const metrics = new ServiceMetrics();
  const metricsTokenHash = opts.metricsToken ? secretHash(validateServiceToken(opts.metricsToken, "metricsToken")) : undefined;
  const onlineProcessors = new Map<string, OnlineEvaluationProcessor>();
  const routeContext: RouteContext = { maxBodyBytes, limiter, cors, secure, quota, bodyBudget, oidc, scim, analytics: opts.analytics, distributed: opts.distributed, distributedState: opts.distributedState, metrics: opts.metricsEnabled === false ? undefined : metrics, metricsTokenHash, onlineProcessors, localJudge: opts.localJudge, playgroundProvider: opts.playgroundProvider };
  for (const project of opts.workspace.config().projects) onlineProcessor(routeContext, opts.workspace.project(project.id));
  const distributedConsumerAbort = new AbortController();
  let distributedConsumerFailed = false;
  const consumeDistributedTrace = async (job: { payload: { scope?: unknown; traceId?: unknown; traceIds?: unknown } }): Promise<void> => {
    const consume = async () => {
      if (!isRecord(job.payload) || !isRecord(job.payload.scope)) throw new Error("Distributed trace event is invalid");
      const traceIds = typeof job.payload.traceId === "string" ? [job.payload.traceId] : Array.isArray(job.payload.traceIds) && job.payload.traceIds.every((id) => typeof id === "string") ? job.payload.traceIds as string[] : [];
      if (!traceIds.length || traceIds.length > 500) throw new Error("Distributed trace event ids are invalid");
      const scope = job.payload.scope;
      if (typeof scope.organizationId !== "string" || typeof scope.workspaceId !== "string" || typeof scope.projectId !== "string") throw new Error("Distributed trace scope is invalid");
      const config = opts.workspace.config();
      const organizationId = config.organization?.id ?? config.id;
      // A stream is scoped to one workspace. Old verification events from another
      // scope can be acknowledged safely instead of poisoning this durable consumer.
      if (scope.workspaceId !== config.id || scope.organizationId !== organizationId) return;
      const stores = opts.workspace.project(scope.projectId);
      if (!stores.online.listRules().some((rule) => rule.enabled)) return;
      const traces = [];
      for (const traceId of traceIds) { const trace = await opts.distributed!.traces.get(scope as DistributedScope, traceId); if (!trace) throw new Error("Distributed trace event references a missing artifact"); traces.push(trace); await stores.traces.export(trace); }
      const processor = onlineProcessor(routeContext, stores);
      await processor.enqueue(traces.map((trace) => trace.id));
      if (opts.distributedState) await processor.drain();
      else processor.trigger();
    };
    if (opts.distributedState) await opts.distributedState.transact(consume);
    else await consume();
  };
  const distributedConsumerTask = opts.distributed ? (async () => {
    while (!distributedConsumerAbort.signal.aborted) {
      try {
        distributedConsumerFailed = false;
        await opts.distributed!.queue.consume("DRYRUN_ONLINE", consumeDistributedTrace, { filter: "trace.*", signal: distributedConsumerAbort.signal });
      } catch {
        if (distributedConsumerAbort.signal.aborted) break;
        distributedConsumerFailed = true;
        await abortableWait(1_000, distributedConsumerAbort.signal);
      }
    }
  })() : undefined;
  const inFlight = new Set<Promise<void>>();

  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const observed = metrics.observe(request, response);
    response.once("finish", observed);
    response.once("close", observed);
    const route = () => routeRequest(opts.workspace, request, response, routeContext);
    const task = opts.distributedState ? opts.distributedState.transact(route) : route();
    const tracked = task.catch((error) => {
      if (!response.writableEnded) json(response, 503, { error: "Distributed workspace state is temporarily unavailable", detail: safeRuntimeError(error) });
    }).finally(() => { inFlight.delete(tracked); });
    inFlight.add(tracked);
  };
  const server = opts.tls
    ? createHttpsServer({ cert: tlsValue(opts.tls.cert), key: tlsValue(opts.tls.key), minVersion: "TLSv1.2" }, handler)
    : createHttpServer(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  const displayHost = address.address.includes(":") ? `[${address.address}]` : address.address;
  const url = `${secure ? "https" : "http"}://${displayHost}:${address.port}`;
  const retentionIntervalMs = positiveInteger(opts.retentionIntervalMs ?? 60 * 60 * 1_000, "retentionIntervalMs");
  const retentionTimer = setInterval(() => {
    const run = () => runConfiguredRetention(opts.workspace, opts.analytics);
    void (opts.distributedState ? opts.distributedState.transact(run) : run()).catch(() => undefined);
  }, retentionIntervalMs);
  retentionTimer.unref();
  const monitorIntervalMs = positiveInteger(opts.monitorIntervalMs ?? 60_000, "monitorIntervalMs");
  const monitorTimer = opts.analytics ? setInterval(() => {
    const boundary = new Date(Math.floor(Date.now() / monitorIntervalMs) * monitorIntervalMs);
    const run = () => runConfiguredMonitors(opts.workspace, opts.analytics!, boundary, quota);
    void (opts.distributedState ? opts.distributedState.transact(run) : run()).catch(() => undefined);
  }, monitorIntervalMs) : undefined;
  monitorTimer?.unref();
  return {
    url,
    host: address.address,
    port: address.port,
    secure,
    metrics: () => metrics.snapshot(),
    readiness: async () => {
      const state = await readiness(opts.workspace, opts.analytics, opts.distributed, opts.distributedState);
      if (distributedConsumerFailed) {
        state.ok = false;
        state.checks.distributed = { ...(state.checks.distributed ?? { ok: false }), ok: false, error: "NATS trace consumer stopped" };
      }
      return state;
    },
    close: async () => {
      clearInterval(retentionTimer);
      if (monitorTimer) clearInterval(monitorTimer);
      distributedConsumerAbort.abort();
      await distributedConsumerTask?.catch(() => undefined);
      await Promise.all([...onlineProcessors.values()].map((processor) => processor.drain()));
      const shutdownMs = positiveInteger(opts.gracefulShutdownMs ?? 30_000, "gracefulShutdownMs");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => server.closeAllConnections(), shutdownMs);
        timer.unref();
        server.close((error) => { clearTimeout(timer); error ? reject(error) : resolve(); });
      });
      await Promise.allSettled([...inFlight]);
      await opts.analytics?.close?.();
      await opts.distributed?.close();
    },
  };
}

async function runConfiguredMonitors(workspace: TeamWorkspace, analytics: AnalyticsStore, now: Date, quota: TeamProjectQuota): Promise<void> {
  const workspaceId = workspace.config().id;
  for (const project of workspace.config().projects) {
    const monitors = workspace.project(project.id).monitors;
    const enabled = monitors.list().filter((monitor) => monitor.enabled).length;
    if (enabled) await workspace.withProjectQuota(project.id, quota, { additionalBytes: enabled * 8_192, additionalFiles: enabled }, () => monitors.evaluateAll(analytics, workspaceId, project.id, now));
  }
}

interface RouteContext {
  maxBodyBytes: number;
  limiter: RateLimiter;
  cors: Set<string>;
  secure: boolean;
  quota: TeamProjectQuota;
  bodyBudget: BodyBudget;
  oidc?: OidcService;
  scim?: ScimService;
  analytics?: AnalyticsStore;
  distributed?: DistributedRuntime;
  distributedState?: DistributedWorkspaceState;
  metrics?: ServiceMetrics;
  metricsTokenHash?: Buffer;
  onlineProcessors: Map<string, OnlineEvaluationProcessor>;
  localJudge?: LLMProvider;
  playgroundProvider?: PlaygroundProviderFactory;
}

async function routeRequest(workspace: TeamWorkspace, request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<void> {
  setSecurityHeaders(response, context.secure);
  try {
    const url = new URL(request.url ?? "/", "http://dry-run.local");
    const origin = request.headers.origin;
    if (origin) {
      if (!context.cors.has(origin) && !isSameOrigin(request, origin, context.secure)) return json(response, 403, { error: "Origin is not allowed" });
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    }
    if (request.method === "OPTIONS") return empty(response, 204);
    if ((url.pathname === "/api/v1/health" || url.pathname === "/api/v1/health/live") && request.method === "GET") return json(response, 200, { ok: true, service: "dry-run-team", version: 1 });
    if (url.pathname === "/api/v1/health/ready" && request.method === "GET") {
      const state = await readiness(workspace, context.analytics, context.distributed, context.distributedState);
      return json(response, state.ok ? 200 : 503, state);
    }
    if (url.pathname === "/" && request.method === "GET") return html(response, TEAM_STUDIO_HTML);
    if (url.pathname.startsWith("/scim/v2/")) {
      if (!context.scim) return scimJson(response, 404, new ScimError(undefined, "SCIM is not configured", 404).body());
      if (!context.scim.authenticate(rawBearerToken(request))) {
        response.setHeader("WWW-Authenticate", "Bearer");
        return scimJson(response, 401, new ScimError(undefined, "Invalid SCIM bearer token", 401).body());
      }
      if (!context.limiter.consume(`scim:${request.socket.remoteAddress ?? "unknown"}`)) {
        response.setHeader("Retry-After", "60");
        return scimJson(response, 429, new ScimError(undefined, "SCIM rate limit exceeded", 429).body());
      }
      if (url.pathname === "/scim/v2/ServiceProviderConfig" && request.method === "GET") return scimJson(response, 200, context.scim.serviceProviderConfig());
      if (url.pathname === "/scim/v2/ResourceTypes" && request.method === "GET") return scimJson(response, 200, context.scim.resourceTypes());
      if (url.pathname === "/scim/v2/Schemas" && request.method === "GET") return scimJson(response, 200, context.scim.schemas());
      if (url.pathname === "/scim/v2/Users") {
        if (request.method === "GET") return scimJson(response, 200, context.scim.list({ filter: url.searchParams.get("filter") ?? undefined, startIndex: optionalInt(url.searchParams.get("startIndex"), 1), count: optionalBoundedInt(url.searchParams.get("count"), 100, 500) }));
        if (request.method === "POST") return scimJson(response, 201, await context.scim.create(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget)));
      }
      const scimUser = /^\/scim\/v2\/Users\/([^/]+)$/.exec(url.pathname);
      if (scimUser) {
        const id = decodePart(scimUser[1]);
        if (request.method === "GET") return scimJson(response, 200, context.scim.get(id));
        if (request.method === "PUT") return scimJson(response, 200, await context.scim.replace(id, await readJsonBody(request, context.maxBodyBytes, context.bodyBudget)));
        if (request.method === "PATCH") return scimJson(response, 200, await context.scim.patch(id, await readJsonBody(request, context.maxBodyBytes, context.bodyBudget)));
        if (request.method === "DELETE") { await context.scim.remove(id); return empty(response, 204); }
      }
      return scimJson(response, 405, new ScimError(undefined, "SCIM method or resource is not supported", 405).body());
    }
    const standardOtlp = url.pathname === "/v1/traces";
    if (!url.pathname.startsWith("/api/v1/") && !standardOtlp) return json(response, 404, { error: "Not found" });

    if (url.pathname === "/api/v1/auth/config" && request.method === "GET") return json(response, 200, { oidc: Boolean(context.oidc) });
    if (url.pathname === "/api/v1/auth/oidc/login" && request.method === "GET") {
      if (!context.oidc) return json(response, 404, { error: "OIDC is not configured" });
      const limitKey = request.socket.remoteAddress ?? "unknown";
      if (!context.limiter.consume(`oidc:${limitKey}`)) return json(response, 429, { error: "Rate limit exceeded" });
      const login = await context.oidc.begin(url.searchParams.get("returnTo") ?? "/");
      response.writeHead(302, { Location: login.location, "Set-Cookie": login.transactionCookie, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (url.pathname === "/api/v1/auth/oidc/callback" && request.method === "GET") {
      if (!context.oidc) return json(response, 404, { error: "OIDC is not configured" });
      const limitKey = request.socket.remoteAddress ?? "unknown";
      if (!context.limiter.consume(`oidc:${limitKey}`)) return json(response, 429, { error: "Rate limit exceeded" });
      const result = await context.oidc.callback({
        code: url.searchParams.get("code") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
        errorDescription: url.searchParams.get("error_description") ?? undefined,
      }, request.headers.cookie);
      response.writeHead(302, { Location: result.returnTo, "Set-Cookie": [result.clearTransactionCookie, result.sessionCookie], "Cache-Control": "no-store" });
      response.end();
      return;
    }

    if (url.pathname === "/api/v1/metrics" && request.method === "GET") {
      if (!context.metrics) return json(response, 404, { error: "Prometheus metrics are disabled" });
      if (context.metricsTokenHash) {
        if (!secureTokenMatch(rawBearerToken(request), context.metricsTokenHash)) {
          response.setHeader("WWW-Authenticate", "Bearer");
          return json(response, 401, { error: "Invalid metrics bearer token" });
        }
      } else {
        const metricsToken = bearerToken(request);
        const metricsPrincipal = workspace.authenticate(metricsToken);
        if (!metricsPrincipal) throw new TeamAuthError("Invalid or revoked API key", 401);
        workspace.authorize(metricsToken, "read");
      }
      return prometheus(response, context.metrics.prometheus());
    }

    if (url.pathname === "/api/v1/invitations/accept" && request.method === "POST") {
      const limitKey = request.socket.remoteAddress ?? "unknown";
      if (!context.limiter.consume(`invite:${limitKey}`)) {
        response.setHeader("Retry-After", "60");
        return json(response, 429, { error: "Rate limit exceeded" });
      }
      const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
      const accepted = await workspace.acceptInvitation(
        requiredString(body.token, "token"),
        requiredString(body.name, "name"),
        body.sessionDays == null ? 90 : requiredInt(body.sessionDays, "sessionDays"),
      );
      return json(response, 201, { ...accepted, warning: "This member token is shown once. Store it securely." });
    }

    const token = bearerToken(request);
    const principal = workspace.authenticate(token);
    const limitKey = principal?.keyId ?? request.socket.remoteAddress ?? "unknown";
    if (!context.limiter.consume(limitKey)) {
      response.setHeader("Retry-After", "60");
      return json(response, 429, { error: "Rate limit exceeded" });
    }
    if (!principal) throw new TeamAuthError("Invalid or revoked API key", 401);

    const projectOtlp = /^\/api\/v1\/projects\/([^/]+)\/otel\/v1\/traces$/.exec(url.pathname);
    if ((standardOtlp || projectOtlp) && request.method === "POST") {
      const headerProject = request.headers["x-dry-run-project"];
      const projectName = projectOtlp ? decodePart(projectOtlp[1]) : typeof headerProject === "string" && headerProject.trim() ? headerProject.trim() : "default";
      const stores = workspace.project(projectName);
      workspace.authorize(token, "ingest", stores.project.id);
      const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      const raw = await readRawBody(request, context.maxBodyBytes, context.bodyBudget);
      const result = otlpToDryRunTraces(decodeOtlpHttp(raw, contentType));
      if (!result.traces.length && result.rejectedSpans) throw new Error(`All ${result.rejectedSpans} OTLP spans were rejected`);
      const scope = distributedScope(workspace, principal, stores);
      const traces = await Promise.all(result.traces.map(async (trace) => mergeOtlpTrace(context.distributed ? await context.distributed.traces.get(scope, trace.id) : safeLoadTrace(stores, trace.id), trace)));
      const processor = context.distributed ? undefined : onlineProcessor(context, stores);
      await workspace.withProjectQuota(stores.project.id, context.quota, { writes: traces.map((trace) => ({ file: stores.traces.file(trace.id), bytes: jsonBytes(trace) })), additionalBytes: traces.length * 2_048, additionalFiles: traces.length }, async () => {
        if (context.distributed) await context.distributed.traces.putMany(scope, traces);
        if (!context.distributedState) for (const trace of traces) await stores.traces.export(trace);
        if (processor) await processor.enqueue(traces.map((trace) => trace.id));
      });
      await context.analytics?.ingestTraces(workspace.config().id, stores.project.id, traces);
      processor?.trigger();
      await workspace.audit(principal, "otlp.ingest", { projectId: stores.project.id, details: { traces: traces.length, spans: result.spans, rejectedSpans: result.rejectedSpans, format: contentType } });
      if (contentType === "application/x-protobuf" || contentType === "application/protobuf") return binary(response, 200, new Uint8Array(), "application/x-protobuf");
      return json(response, 200, result.rejectedSpans ? { partialSuccess: { rejectedSpans: result.rejectedSpans, errorMessage: result.errors.join("; ") } } : {});
    }
    if (standardOtlp || projectOtlp) return json(response, 405, { error: "Method not allowed" });

    if (url.pathname === "/api/v1/auth/logout" && request.method === "POST") {
      if (principal.memberId) await workspace.revokeOwnSession(principal);
      response.setHeader("Set-Cookie", context.oidc?.clearSessionCookie() ?? "dryrun_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
      return empty(response, 204);
    }

    if (url.pathname === "/api/v1/me" && request.method === "GET") {
      workspace.authorize(token, "read");
      const config = workspace.config();
      return json(response, 200, {
        organization: workspace.organization(principal),
        workspace: { id: config.id, name: config.name, retention: config.retention },
        principal,
        projects: workspace.listProjects(principal),
      });
    }
    if (url.pathname === "/api/v1/setup/diagnostics" && request.method === "GET") {
      workspace.authorize(token, "read");
      return json(response, 200, await setupDiagnostics(workspace, context));
    }
    if (url.pathname === "/api/v1/projects") {
      if (request.method === "GET") {
        workspace.authorize(token, "read");
        return json(response, 200, { projects: workspace.listProjects(principal) });
      }
      if (request.method === "POST") {
        workspace.authorize(token, "manage-projects");
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        return json(response, 201, { project: await workspace.createProject(principal, requiredString(body.name, "name")) });
      }
    }
    if (url.pathname === "/api/v1/admin/keys") {
      if (request.method === "GET") {
        workspace.authorize(token, "manage-keys");
        return json(response, 200, { keys: workspace.listKeys(principal) });
      }
      if (request.method === "POST") {
        workspace.authorize(token, "manage-keys");
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const issued = await workspace.createKey(
          principal,
          requiredString(body.name, "name"),
          requiredRole(body.role),
          optionalStrings(body.projectIds, "projectIds"),
        );
        return json(response, 201, { ...issued, warning: "This token is shown once. Store it securely." });
      }
    }
    if (url.pathname === "/api/v1/admin/service-accounts" && request.method === "POST") {
      workspace.authorize(token, "manage-keys");
      const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
      const issued = await workspace.createServiceAccount(principal, requiredString(body.name, "name"), requiredRole(body.role), optionalStrings(body.projectIds, "projectIds"), optionalString(body.customRoleId));
      return json(response, 201, { ...issued, warning: "This service-account token is shown once. Store it securely." });
    }
    const rotateKeyMatch = /^\/api\/v1\/admin\/keys\/([^/]+)\/rotate$/.exec(url.pathname);
    if (rotateKeyMatch && request.method === "POST") {
      workspace.authorize(token, "manage-keys");
      const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
      const issued = await workspace.rotateKey(principal, decodePart(rotateKeyMatch[1]), body.graceMinutes == null ? 5 : requiredInt(body.graceMinutes, "graceMinutes"));
      return json(response, 201, { ...issued, warning: "This replacement token is shown once. Store it securely." });
    }
    const keyMatch = /^\/api\/v1\/admin\/keys\/([^/]+)$/.exec(url.pathname);
    if (keyMatch && request.method === "DELETE") {
      workspace.authorize(token, "manage-keys");
      await workspace.revokeKey(principal, decodePart(keyMatch[1]));
      return empty(response, 204);
    }
    if (url.pathname === "/api/v1/admin/members" && request.method === "GET") {
      workspace.authorize(token, "manage-members");
      return json(response, 200, { members: workspace.listMembers(principal) });
    }
    const memberMatch = /^\/api\/v1\/admin\/members\/([^/]+)$/.exec(url.pathname);
    if (memberMatch && request.method === "PATCH") {
      workspace.authorize(token, "manage-members");
      const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
      const member = await workspace.updateMember(principal, decodePart(memberMatch[1]), {
        ...(body.name == null ? {} : { name: requiredString(body.name, "name") }),
        ...(body.role == null ? {} : { role: requiredMemberRole(body.role) }),
        ...(body.projectIds === undefined ? {} : { projectIds: body.projectIds === null ? null : optionalStrings(body.projectIds, "projectIds")! }),
        ...(body.status == null ? {} : { status: requiredMemberStatus(body.status) }),
      });
      return json(response, 200, { member });
    }
    if (url.pathname === "/api/v1/admin/invitations") {
      if (request.method === "GET") {
        workspace.authorize(token, "manage-members");
        return json(response, 200, { invitations: workspace.listInvitations(principal) });
      }
      if (request.method === "POST") {
        workspace.authorize(token, "manage-members");
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const issued = await workspace.createInvitation(
          principal,
          requiredString(body.email, "email"),
          requiredMemberRole(body.role),
          optionalStrings(body.projectIds, "projectIds"),
          body.expiresInDays == null ? 7 : requiredInt(body.expiresInDays, "expiresInDays"),
        );
        return json(response, 201, { ...issued, warning: "This invitation token is shown once. Share it through a secure channel." });
      }
    }
    const invitationMatch = /^\/api\/v1\/admin\/invitations\/([^/]+)$/.exec(url.pathname);
    if (invitationMatch && request.method === "DELETE") {
      workspace.authorize(token, "manage-members");
      await workspace.revokeInvitation(principal, decodePart(invitationMatch[1]));
      return empty(response, 204);
    }
    if (url.pathname === "/api/v1/admin/audit" && request.method === "GET") {
      workspace.authorize(token, "read-audit");
      return json(response, 200, { entries: workspace.readAudit(principal, { limit: optionalInt(url.searchParams.get("limit"), 200), projectId: url.searchParams.get("project") ?? undefined }) });
    }
    if (url.pathname === "/api/v1/admin/audit/export" && request.method === "GET") {
      workspace.authorize(token, "read-audit");
      const format = url.searchParams.get("format") === "csv" ? "csv" : "jsonl";
      const output = workspace.exportAudit(principal, { format, limit: optionalInt(url.searchParams.get("limit"), 1_000), projectId: url.searchParams.get("project") ?? undefined });
      response.writeHead(200, { "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8", "Content-Disposition": `attachment; filename=\"dry-run-audit.${format}\"`, "Cache-Control": "no-store" });
      response.end(output);
      return;
    }
    if (url.pathname === "/api/v1/admin/organization") {
      if (request.method === "GET") return json(response, 200, { organization: workspace.organization(principal) });
      if (request.method === "PATCH") {
        workspace.authorize(token, "manage-organization");
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        return json(response, 200, { organization: await workspace.updateOrganization(principal, { name: requiredString(body.name, "name") }) });
      }
    }
    if (url.pathname === "/api/v1/admin/roles") {
      workspace.authorize(token, "manage-roles");
      if (request.method === "GET") return json(response, 200, { roles: workspace.listCustomRoles(principal) });
      if (request.method === "POST") {
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const role = await workspace.createCustomRole(principal, { name: requiredString(body.name, "name"), ...(optionalString(body.description) ? { description: optionalString(body.description) } : {}), baseRole: requiredRole(body.baseRole), capabilities: requiredCapabilities(body.capabilities) });
        return json(response, 201, { role });
      }
    }
    const roleMatch = /^\/api\/v1\/admin\/roles\/([^/]+)$/.exec(url.pathname);
    if (roleMatch) {
      workspace.authorize(token, "manage-roles");
      const roleId = decodePart(roleMatch[1]);
      if (request.method === "PATCH") {
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const role = await workspace.updateCustomRole(principal, roleId, { ...(body.name == null ? {} : { name: requiredString(body.name, "name") }), ...(body.description === undefined ? {} : { description: body.description === null ? null : requiredString(body.description, "description") }), ...(body.capabilities === undefined ? {} : { capabilities: requiredCapabilities(body.capabilities) }), ...(body.revision == null ? {} : { expectedRevision: requiredInt(body.revision, "revision") }) });
        return json(response, 200, { role });
      }
      if (request.method === "DELETE") { await workspace.deleteCustomRole(principal, roleId); return empty(response, 204); }
    }
    if (url.pathname === "/api/v1/admin/groups") {
      workspace.authorize(token, "manage-groups");
      if (request.method === "GET") return json(response, 200, { groups: workspace.listGroups(principal) });
      if (request.method === "POST") {
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const group = await workspace.createGroup(principal, { name: requiredString(body.name, "name"), ...(optionalString(body.description) ? { description: optionalString(body.description) } : {}), ...(body.memberIds === undefined ? {} : { memberIds: optionalStrings(body.memberIds, "memberIds") }), ...(body.projectIds === undefined ? {} : { projectIds: optionalStrings(body.projectIds, "projectIds") }), ...(optionalString(body.customRoleId) ? { customRoleId: optionalString(body.customRoleId) } : {}) });
        return json(response, 201, { group });
      }
    }
    const groupMatch = /^\/api\/v1\/admin\/groups\/([^/]+)$/.exec(url.pathname);
    if (groupMatch) {
      workspace.authorize(token, "manage-groups");
      const groupId = decodePart(groupMatch[1]);
      if (request.method === "PATCH") {
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const group = await workspace.updateGroup(principal, groupId, { ...(body.name == null ? {} : { name: requiredString(body.name, "name") }), ...(body.description === undefined ? {} : { description: body.description === null ? null : requiredString(body.description, "description") }), ...(body.memberIds === undefined ? {} : { memberIds: optionalStrings(body.memberIds, "memberIds")! }), ...(body.projectIds === undefined ? {} : { projectIds: body.projectIds === null ? null : optionalStrings(body.projectIds, "projectIds")! }), ...(body.customRoleId === undefined ? {} : { customRoleId: body.customRoleId === null ? null : requiredString(body.customRoleId, "customRoleId") }), ...(body.revision == null ? {} : { expectedRevision: requiredInt(body.revision, "revision") }) });
        return json(response, 200, { group });
      }
      if (request.method === "DELETE") { await workspace.deleteGroup(principal, groupId); return empty(response, 204); }
    }
    if (url.pathname === "/api/v1/admin/retention") {
      if (request.method === "GET") {
        workspace.authorize(token, "manage-retention");
        return json(response, 200, { retention: workspace.config().retention });
      }
      if (request.method === "PATCH") {
        workspace.authorize(token, "manage-retention");
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        return json(response, 200, { retention: await workspace.setRetention(principal, requiredBoolean(body.enabled, "enabled"), requiredInt(body.days, "days")) });
      }
    }
    const accessMatch = /^\/api\/v1\/projects\/([^/]+)\/access\/policies(?:\/([^/]+)\/([^/]+))?$/.exec(url.pathname);
    if (accessMatch) {
      const stores = workspace.project(decodePart(accessMatch[1]));
      workspace.authorize(token, "manage-access", stores.project.id);
      const resourceType = accessMatch[2] ? requiredObjectResourceType(decodePart(accessMatch[2])) : undefined;
      const resourceId = accessMatch[3] ? decodePart(accessMatch[3]) : undefined;
      if (request.method === "GET" && !resourceType) return json(response, 200, { policies: workspace.listObjectAccess(principal, stores.project.id) });
      if (!resourceType || !resourceId) return json(response, 405, { error: "Method not allowed" });
      if (request.method === "GET") {
        const policy = stores.access.load(resourceType, resourceId);
        return policy ? json(response, 200, { policy }) : json(response, 404, { error: "Resource not found" });
      }
      if (request.method === "PUT") {
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const grants = requiredArray(body.grants, "grants") as ObjectAccessGrant[];
        const policy = await workspace.withProjectQuota(stores.project.id, context.quota, { additionalBytes: jsonBytes(body) + 4_096, additionalFiles: stores.access.load(resourceType, resourceId) ? 0 : 1 }, () => workspace.setObjectAccess(principal, stores.project.id, resourceType, resourceId, grants, optionalNumber(body.revision)));
        return json(response, 200, { policy });
      }
      if (request.method === "DELETE") {
        const revision = url.searchParams.get("revision");
        await workspace.removeObjectAccess(principal, stores.project.id, resourceType, resourceId, revision == null ? undefined : requiredInt(Number(revision), "revision"));
        return empty(response, 204);
      }
      return json(response, 405, { error: "Method not allowed" });
    }
    const usageMatch = /^\/api\/v1\/projects\/([^/]+)\/usage$/.exec(url.pathname);
    if (usageMatch && request.method === "GET") {
      const stores = workspace.project(decodePart(usageMatch[1]));
      workspace.authorize(token, "read", stores.project.id);
      return json(response, 200, { usage: workspace.projectUsage(stores.project.id), quota: context.quota });
    }
    const analyticsMatch = /^\/api\/v1\/projects\/([^/]+)\/analytics\/summary$/.exec(url.pathname);
    if (analyticsMatch && request.method === "GET") {
      if (!context.analytics) return json(response, 404, { error: "Shared analytics is not configured" });
      const stores = workspace.project(decodePart(analyticsMatch[1]));
      workspace.authorize(token, "read", stores.project.id);
      return json(response, 200, { summary: await context.analytics.summary(workspace.config().id, stores.project.id, { since: url.searchParams.get("since") ?? undefined, until: url.searchParams.get("until") ?? undefined }) });
    }
    const analyticsCollectionMatch = /^\/api\/v1\/projects\/([^/]+)\/analytics\/(events|timeseries|facets)$/.exec(url.pathname);
    if (analyticsCollectionMatch && request.method === "GET") {
      if (!context.analytics) return json(response, 404, { error: "Shared analytics is not configured" });
      const stores = workspace.project(decodePart(analyticsCollectionMatch[1]));
      workspace.authorize(token, "read", stores.project.id);
      const query = analyticsQuery(url);
      if (analyticsCollectionMatch[2] === "events") {
        if (!context.analytics.queryEvents) return json(response, 501, { error: "The analytics backend does not support event queries" });
        return json(response, 200, { events: await context.analytics.queryEvents(workspace.config().id, stores.project.id, query) });
      }
      if (analyticsCollectionMatch[2] === "timeseries") {
        if (!context.analytics.timeseries) return json(response, 501, { error: "The analytics backend does not support time series" });
        return json(response, 200, { series: await context.analytics.timeseries(workspace.config().id, stores.project.id, { ...query, interval: optionalAnalyticsInterval(url.searchParams.get("interval")) }) });
      }
      if (!context.analytics.facets) return json(response, 501, { error: "The analytics backend does not support facets" });
      return json(response, 200, { facets: await context.analytics.facets(workspace.config().id, stores.project.id, query) });
    }
    const analyticsResourceMatch = /^\/api\/v1\/projects\/([^/]+)\/analytics\/resources\/(trace|experiment)\/([^/]+)$/.exec(url.pathname);
    if (analyticsResourceMatch && request.method === "GET") {
      if (!context.analytics?.resource) return json(response, 404, { error: "Analytics resource storage is not configured" });
      const stores = workspace.project(decodePart(analyticsResourceMatch[1]));
      const type = analyticsResourceMatch[2] as "trace" | "experiment";
      const id = decodePart(analyticsResourceMatch[3]);
      workspace.authorizeObject(token, "read", stores.project.id, type, id);
      const resource = await context.analytics.resource(workspace.config().id, stores.project.id, type, id);
      return resource ? json(response, 200, { resource }) : json(response, 404, { error: "Resource not found" });
    }
    const intelligenceMatch = /^\/api\/v1\/projects\/([^/]+)\/intelligence(?:\/([^/]+))?$/.exec(url.pathname);
    if (intelligenceMatch) {
      const stores = workspace.project(decodePart(intelligenceMatch[1]));
      const reportId = intelligenceMatch[2] ? decodePart(intelligenceMatch[2]) : undefined;
      if (request.method === "GET" && !reportId) {
        workspace.authorize(token, "read", stores.project.id);
        return json(response, 200, { reports: stores.intelligence.list(optionalBoundedInt(url.searchParams.get("limit"), 100, 2_000)) });
      }
      if (request.method === "GET" && reportId) {
        workspace.authorize(token, "read", stores.project.id);
        return json(response, 200, { report: stores.intelligence.load(reportId) });
      }
      if (request.method === "POST" && !reportId) {
        workspace.authorize(token, "annotate", stores.project.id);
        if (!context.analytics) return json(response, 503, { error: "Shared analytics is required for production intelligence" });
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const engine = new ProductionIntelligenceEngine(context.analytics, stores.intelligence);
        const report = await workspace.withProjectQuota(stores.project.id, context.quota, { additionalBytes: 256 * 1_024, additionalFiles: 1 }, () => engine.analyze(workspace.config().id, stores.project.id, {
          baseline: requiredIntelligenceWindow(body.baseline, "baseline"), candidate: requiredIntelligenceWindow(body.candidate, "candidate"),
          ...(body.minimumEvents == null ? {} : { minimumEvents: requiredInt(body.minimumEvents, "minimumEvents") }),
          ...(body.driftThreshold == null ? {} : { driftThreshold: requiredNumber(body.driftThreshold, "driftThreshold") }),
          ...(body.anomalyThreshold == null ? {} : { anomalyThreshold: requiredNumber(body.anomalyThreshold, "anomalyThreshold") }),
          ...(body.maxEvents == null ? {} : { maxEvents: requiredInt(body.maxEvents, "maxEvents") }),
        }));
        await workspace.audit(principal, "intelligence.analyze", { projectId: stores.project.id, target: report.id, details: { verdict: report.verdict, baseline: report.sample.baseline, candidate: report.sample.candidate } });
        return json(response, 201, { report });
      }
      return json(response, 405, { error: "Method not allowed" });
    }
    const judgeReliabilityMatch = /^\/api\/v1\/projects\/([^/]+)\/judge-reliability(?:\/([^/]+))?$/.exec(url.pathname);
    if (judgeReliabilityMatch) {
      const stores = workspace.project(decodePart(judgeReliabilityMatch[1]));
      const reportId = judgeReliabilityMatch[2] ? decodePart(judgeReliabilityMatch[2]) : undefined;
      if (request.method === "GET" && !reportId) {
        workspace.authorize(token, "read", stores.project.id);
        return json(response, 200, { reports: stores.judges.list(optionalBoundedInt(url.searchParams.get("limit"), 100, 2_000)) });
      }
      if (request.method === "GET" && reportId) {
        workspace.authorize(token, "read", stores.project.id);
        return json(response, 200, { report: stores.judges.load(reportId) });
      }
      if (request.method === "POST" && !reportId) {
        workspace.authorize(token, "annotate", stores.project.id);
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const observations = requiredArray(body.observations, "observations") as JudgeObservation[];
        if (observations.length > 100_000) throw new Error("observations cannot exceed 100000 items");
        const baseline = body.baseline == null ? undefined : requiredArray(body.baseline, "baseline") as JudgeObservation[];
        if (baseline && baseline.length > 100_000) throw new Error("baseline cannot exceed 100000 items");
        const report = analyzeJudgeReliability(observations, { ...(baseline ? { baseline } : {}), ...(isRecord(body.policy) ? { policy: body.policy as JudgeReliabilityPolicy } : {}), ...(body.bootstrapSamples == null ? {} : { bootstrapSamples: requiredInt(body.bootstrapSamples, "bootstrapSamples") }) });
        await workspace.withProjectQuota(stores.project.id, context.quota, { additionalBytes: jsonBytes(report) + 4_096, additionalFiles: 1 }, () => stores.judges.save(report));
        await workspace.audit(principal, "judge-reliability.analyze", { projectId: stores.project.id, target: report.id, details: { gate: report.gate.passed, judges: report.judges, targets: report.targets } });
        return json(response, 201, { report });
      }
      return json(response, 405, { error: "Method not allowed" });
    }
    const onboardingMatch = /^\/api\/v1\/projects\/([^/]+)\/(import|demo)$/.exec(url.pathname);
    if (onboardingMatch && request.method === "POST") {
      const stores = workspace.project(decodePart(onboardingMatch[1]));
      workspace.authorize(token, "ingest", stores.project.id);
      if (onboardingMatch[2] === "demo") {
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const count = body.count == null ? 24 : requiredInt(body.count, "count");
        const traces = createDemoTraces(stores.project.id, count);
        await persistImportedTraces(workspace, principal, stores, traces, context);
        if (!stores.annotations.listQueues().some((queue) => queue.name === "Demo regressions")) await stores.annotations.createQueue("Demo regressions", "Example human-review queue; safe to delete.", { mode: "double-blind", reviewersPerTarget: 2, assignment: "manual", slaHours: 24 });
        if (!stores.online.listRules().some((rule) => rule.name === "Demo production gate")) await stores.online.create({ name: "Demo production gate", description: "Provider-free example gate; safe to delete.", filter: { tags: ["demo"], sampleRate: 1 }, checks: [{ type: "maxDuration", ms: 1_000 }, { type: "noToolErrors" }], action: { queueName: "Demo regressions", priority: 50 } });
        await workspace.audit(principal, "demo.seed", { projectId: stores.project.id, details: { traces: traces.length, costUsd: 0 } });
        return json(response, 201, { traces: traces.length, releases: ["v1", "v2"], providerCostUsd: 0 });
      }
      const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
      const source = requiredMigrationSource(body.source);
      const bundle = migrateEvaluationExport(source, body.input, typeof body.name === "string" ? body.name : `${source}-import`);
      if (body.dryRun === true) return json(response, 200, { preview: bundle.summary, warnings: bundle.warnings });
      await persistImportedTraces(workspace, principal, stores, bundle.traces.map((trace) => validateIncomingTrace({ ...trace, receivedAt: new Date().toISOString() })), context);
      const stored = await workspace.withProjectQuota(stores.project.id, context.quota, { additionalBytes: jsonBytes(bundle) + 4_096, additionalFiles: 1 }, () => stores.migrations.save(bundle));
      await workspace.audit(principal, "migration.import", { projectId: stores.project.id, target: stored.id, details: { source, ...bundle.summary, warnings: bundle.warnings.length } });
      return json(response, 201, { migration: { id: stored.id, importedAt: stored.importedAt, source }, summary: bundle.summary, warnings: bundle.warnings });
    }

    const projectRetentionMatch = /^\/api\/v1\/projects\/([^/]+)\/retention$/.exec(url.pathname);
    if (projectRetentionMatch) {
      const stores = workspace.project(decodePart(projectRetentionMatch[1]));
      workspace.authorize(token, "manage-retention", stores.project.id);
      if (request.method === "GET") {
        const config = workspace.config();
        const project = config.projects.find((candidate) => candidate.id === stores.project.id)!;
        return json(response, 200, { retention: project.retention ?? config.retention, inherited: project.retention == null });
      }
      if (request.method === "PATCH") {
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        return json(response, 200, { retention: await workspace.setProjectRetention(principal, stores.project.id, requiredBoolean(body.enabled, "enabled"), requiredInt(body.days, "days")), inherited: false });
      }
    }
    const retentionMatch = /^\/api\/v1\/projects\/([^/]+)\/retention\/(plan|apply)$/.exec(url.pathname);
    if (retentionMatch && request.method === "POST") {
      const stores = workspace.project(decodePart(retentionMatch[1]));
      workspace.authorize(token, "manage-retention", stores.project.id);
      const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
      const plan = await workspace.applyRetention(principal, stores.project.id, {
        ...(body.days == null ? {} : { olderThanDays: requiredInt(body.days, "days") }),
        dryRun: retentionMatch[2] === "plan",
      });
      if (retentionMatch[2] === "apply") await context.analytics?.deleteBefore?.(workspace.config().id, stores.project.id, plan.cutoff);
      return json(response, 200, { plan: publicRetentionPlan(plan) });
    }

    const monitorMatch = /^\/api\/v1\/projects\/([^/]+)\/monitors(?:\/([^/]+))?(?:\/(evaluate|results))?$/.exec(url.pathname);
    if (monitorMatch) {
      const stores = workspace.project(decodePart(monitorMatch[1]));
      const monitorId = monitorMatch[2] ? decodePart(monitorMatch[2]) : undefined;
      const action = monitorMatch[3];
      if (request.method === "GET" && !monitorId) {
        workspace.authorize(token, "read", stores.project.id);
        return json(response, 200, { monitors: stores.monitors.list().filter((monitor) => stores.access.allows(principal, "read", "quality-monitor", monitor.id)) });
      }
      if (request.method === "POST" && !monitorId) {
        workspace.authorize(token, "annotate", stores.project.id);
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const monitor = await workspace.withProjectQuota(stores.project.id, context.quota, { additionalBytes: jsonBytes(body) + 4_096, additionalFiles: 1 }, () => stores.monitors.create({
          name: requiredString(body.name, "name"),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(body.windowMinutes == null ? {} : { windowMinutes: requiredInt(body.windowMinutes, "windowMinutes") }),
          ...(body.minEvents == null ? {} : { minEvents: requiredInt(body.minEvents, "minEvents") }),
          thresholds: asRecord(body.thresholds),
        }));
        await workspace.audit(principal, "quality-monitor.create", { projectId: stores.project.id, target: monitor.id });
        return json(response, 201, { monitor });
      }
      if (!monitorId) return json(response, 405, { error: "Method not allowed" });
      if (request.method === "GET" && !action) {
        workspace.authorizeObject(token, "read", stores.project.id, "quality-monitor", monitorId);
        return json(response, 200, { monitor: stores.monitors.load(monitorId) });
      }
      if (request.method === "PATCH" && !action) {
        workspace.authorizeObject(token, "annotate", stores.project.id, "quality-monitor", monitorId);
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const monitor = await stores.monitors.update(monitorId, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(body.windowMinutes == null ? {} : { windowMinutes: requiredInt(body.windowMinutes, "windowMinutes") }),
          ...(body.minEvents == null ? {} : { minEvents: requiredInt(body.minEvents, "minEvents") }),
          ...(isRecord(body.thresholds) ? { thresholds: body.thresholds } : {}),
        });
        await workspace.audit(principal, "quality-monitor.update", { projectId: stores.project.id, target: monitor.id, details: { revision: monitor.revision } });
        return json(response, 200, { monitor });
      }
      if (request.method === "DELETE" && !action) {
        workspace.authorizeObject(token, "annotate", stores.project.id, "quality-monitor", monitorId);
        await stores.monitors.remove(monitorId);
        await workspace.audit(principal, "quality-monitor.delete", { projectId: stores.project.id, target: monitorId });
        return empty(response, 204);
      }
      if (request.method === "GET" && action === "results") {
        workspace.authorizeObject(token, "read", stores.project.id, "quality-monitor", monitorId);
        return json(response, 200, { results: stores.monitors.listResults({ monitorId, status: optionalMonitorStatus(url.searchParams.get("status")), limit: optionalBoundedInt(url.searchParams.get("limit"), 100, 2_000) }) });
      }
      if (request.method === "POST" && action === "evaluate") {
        workspace.authorizeObject(token, "annotate", stores.project.id, "quality-monitor", monitorId);
        if (!context.analytics) return json(response, 503, { error: "Shared analytics is required to evaluate quality monitors" });
        const result = await workspace.withProjectQuota(stores.project.id, context.quota, { additionalBytes: 8_192, additionalFiles: 1 }, () => stores.monitors.evaluate(monitorId, context.analytics!, workspace.config().id, stores.project.id));
        await workspace.audit(principal, "quality-monitor.evaluate", { projectId: stores.project.id, target: monitorId, details: { status: result.status, violations: result.violations.length } });
        return json(response, 200, { result });
      }
      return json(response, 405, { error: "Method not allowed" });
    }

    const onlineMatch = /^\/api\/v1\/projects\/([^/]+)\/online\/(rules|results|batch)(?:\/([^/]+))?$/.exec(url.pathname);
    if (onlineMatch) {
      const stores = workspace.project(decodePart(onlineMatch[1]));
      const collection = onlineMatch[2];
      const resourceId = onlineMatch[3] ? decodePart(onlineMatch[3]) : undefined;
      if (collection === "rules" && request.method === "GET") {
        workspace.authorize(token, "read", stores.project.id);
        if (resourceId) {
          workspace.authorizeObject(token, "read", stores.project.id, "online-rule", resourceId);
          return json(response, 200, { rules: [stores.online.loadRule(resourceId)] });
        }
        return json(response, 200, { rules: stores.online.listRules().filter((rule) => stores.access.allows(principal, "read", "online-rule", rule.id)) });
      }
      if (collection === "rules" && request.method === "POST" && !resourceId) {
        workspace.authorize(token, "annotate", stores.project.id);
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const rule = await workspace.withProjectQuota(stores.project.id, context.quota, { additionalBytes: jsonBytes(body) + 8_192, additionalFiles: 1 }, () => stores.online.create({
          name: requiredString(body.name, "name"),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(isRecord(body.filter) ? { filter: body.filter } : {}),
          checks: requiredArray(body.checks, "checks") as any,
          ...(isRecord(body.action) ? { action: body.action } : {}),
          ...(body.unavailable === "skip" ? { unavailable: "skip" as const } : {}),
        }));
        await workspace.audit(principal, "online-rule.create", { projectId: stores.project.id, target: rule.id });
        return json(response, 201, { rule });
      }
      if (collection === "rules" && resourceId && request.method === "PATCH") {
        workspace.authorizeObject(token, "annotate", stores.project.id, "online-rule", resourceId);
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const rule = await stores.online.update(resourceId, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(isRecord(body.filter) ? { filter: body.filter } : {}),
          ...(Array.isArray(body.checks) ? { checks: body.checks as any } : {}),
          ...(isRecord(body.action) ? { action: body.action } : {}),
          ...(body.unavailable === "fail" || body.unavailable === "skip" ? { unavailable: body.unavailable } : {}),
        });
        await workspace.audit(principal, "online-rule.update", { projectId: stores.project.id, target: rule.id, details: { revision: rule.revision } });
        return json(response, 200, { rule });
      }
      if (collection === "rules" && resourceId && request.method === "DELETE") {
        workspace.authorizeObject(token, "annotate", stores.project.id, "online-rule", resourceId);
        await stores.online.remove(resourceId);
        await workspace.audit(principal, "online-rule.delete", { projectId: stores.project.id, target: resourceId });
        return empty(response, 204);
      }
      if (collection === "results" && request.method === "GET") {
        workspace.authorize(token, "read", stores.project.id);
        const passed = url.searchParams.get("passed");
        const results = stores.online.listResults({ ruleId: url.searchParams.get("ruleId") ?? resourceId, traceId: url.searchParams.get("traceId") ?? undefined, ...(passed === "true" || passed === "false" ? { passed: passed === "true" } : {}), limit: optionalBoundedInt(url.searchParams.get("limit"), 200, 2_000) });
        return json(response, 200, { results: results.filter((result) => stores.access.allows(principal, "read", "online-rule", result.ruleId) && stores.access.allows(principal, "read", "trace", result.traceId)) });
      }
      if (collection === "batch" && request.method === "POST") {
        workspace.authorize(token, "annotate", stores.project.id);
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const ids = body.traceIds == null
          ? stores.traces.list().filter((trace) => stores.access.allows(principal, "annotate", "trace", trace.id)).slice(0, 500).map((trace) => trace.id)
          : optionalStrings(body.traceIds, "traceIds")!;
        if (ids.length > 500) throw new Error("Online batch cannot exceed 500 traces");
        for (const id of ids) workspace.authorizeObject(token, "annotate", stores.project.id, "trace", id);
        const engine = new OnlineEvaluationEngine(stores.online, { judge: context.localJudge, annotations: stores.annotations });
        const summary = await engine.evaluateMany(ids.map((id) => stores.traces.load(id)));
        await workspace.audit(principal, "online-evaluation.batch", { projectId: stores.project.id, details: { traces: ids.length, evaluated: summary.evaluated, failed: summary.failed } });
        return json(response, 200, { summary });
      }
      return json(response, 405, { error: "Method not allowed" });
    }

    const promoteTraceMatch = /^\/api\/v1\/projects\/([^/]+)\/traces\/([^/]+)\/promote$/.exec(url.pathname);
    if (promoteTraceMatch && request.method === "POST") {
      const stores = workspace.project(decodePart(promoteTraceMatch[1]));
      const traceId = decodePart(promoteTraceMatch[2]);
      workspace.authorizeObject(token, "annotate", stores.project.id, "trace", traceId);
      const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
      const trace = stores.traces.load(traceId);
      const bundle = await workspace.withProjectQuota(stores.project.id, context.quota, { additionalBytes: jsonBytes(trace) * 5 + 65_536, additionalFiles: 4 }, () => stores.regressions.promote(trace, {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.onlineResultId === "string" ? { onlineResultId: body.onlineResultId } : {}),
        ...(typeof body.annotationItemId === "string" ? { annotationItemId: body.annotationItemId } : {}),
      }));
      await workspace.audit(principal, "regression.promote", { projectId: stores.project.id, target: bundle.manifest.id, details: { traceId: trace.id, cassette: Boolean(bundle.cassette) } });
      return json(response, 201, { regression: bundle });
    }

    const regressionMatch = /^\/api\/v1\/projects\/([^/]+)\/regressions(?:\/([^/]+))?$/.exec(url.pathname);
    if (regressionMatch && request.method === "GET") {
      const stores = workspace.project(decodePart(regressionMatch[1]));
      workspace.authorize(token, "read", stores.project.id);
      const id = regressionMatch[2] ? decodePart(regressionMatch[2]) : undefined;
      if (id) {
        workspace.authorizeObject(token, "read", stores.project.id, "regression", id);
        return json(response, 200, { regressions: [stores.regressions.load(id)] });
      }
      return json(response, 200, { regressions: stores.regressions.list().filter((regression) => stores.access.allows(principal, "read", "regression", regression.id)) });
    }

    const playgroundMatch = /^\/api\/v1\/projects\/([^/]+)\/playground\/runs(?:\/([^/]+))?(?:\/(promote))?$/.exec(url.pathname);
    if (playgroundMatch) {
      const stores = workspace.project(decodePart(playgroundMatch[1]));
      const runId = playgroundMatch[2] ? decodePart(playgroundMatch[2]) : undefined;
      const action = playgroundMatch[3];
      if (request.method === "GET" && !action) {
        workspace.authorize(token, "read", stores.project.id);
        if (runId) {
          workspace.authorizeObject(token, "read", stores.project.id, "playground-run", runId);
          return json(response, 200, { runs: [stores.playground.load(runId)] });
        }
        return json(response, 200, { runs: stores.playground.list().filter((run) => stores.access.allows(principal, "read", "playground-run", run.id)) });
      }
      if (request.method === "POST" && !runId) {
        workspace.authorize(token, "manage-prompts", stores.project.id);
        if (!context.playgroundProvider) return json(response, 503, { error: "Local playground provider is not configured; run team serve with a detected local judge" });
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const run = await runPlayground(body as any, { provider: context.playgroundProvider, judge: context.localJudge, persist: false });
        await workspace.withProjectQuota(stores.project.id, context.quota, { writes: [{ file: stores.playground.file(run.id), bytes: jsonBytes(run) }] }, () => stores.playground.save(run));
        await workspace.audit(principal, "playground.run", { projectId: stores.project.id, target: run.id, details: { variants: run.variants.length, cases: run.dataset.cases.length, winner: run.winner } });
        return json(response, 201, { run });
      }
      if (request.method === "POST" && runId && action === "promote") {
        workspace.authorizeObject(token, "manage-prompts", stores.project.id, "playground-run", runId);
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const promoted = await workspace.withProjectQuota(stores.project.id, context.quota, { additionalBytes: 256 * 1024, additionalFiles: 2 }, () => promotePlaygroundVariant(stores.playground.load(runId), requiredString(body.variantId, "variantId"), stores.prompts, stores.experiments, { ...(typeof body.label === "string" ? { label: body.label } : {}) }));
        await workspace.audit(principal, "playground.promote", { projectId: stores.project.id, target: runId, details: { variantId: body.variantId, promptVersion: promoted.prompt.version, experimentId: promoted.experiment.id } });
        return json(response, 201, { promoted });
      }
      return json(response, 405, { error: "Method not allowed" });
    }

    const reviewWorkflowMatch = /^\/api\/v1\/projects\/([^/]+)\/queues\/([^/]+)\/(assign|decision|adjudicate|calibration|aging|bulk)$/.exec(url.pathname);
    if (reviewWorkflowMatch) {
      const stores = workspace.project(decodePart(reviewWorkflowMatch[1]));
      const queueId = decodePart(reviewWorkflowMatch[2]);
      const action = reviewWorkflowMatch[3];
      const reviews = new ReviewWorkflow(stores.annotations);
      if (["decision", "calibration", "aging"].includes(action) && request.method === "GET") {
        workspace.authorizeObject(token, "read", stores.project.id, "annotation-queue", queueId);
        if (action === "decision") return json(response, 200, { decision: reviews.decision(queueId, requiredString(url.searchParams.get("group"), "group")) });
        if (action === "calibration") return json(response, 200, { calibration: reviews.calibration(queueId) });
        return json(response, 200, { aging: reviews.aging(queueId) });
      }
      workspace.authorizeObject(token, "annotate", stores.project.id, "annotation-queue", queueId);
      if (action === "assign" && request.method === "POST") {
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const target = asRecord(body.target);
        const queue = stores.annotations.loadQueue(queueId);
        const files = queue.mode === "single" || !queue.mode ? 1 : queue.reviewersPerTarget ?? 2;
        const assignment = await workspace.withProjectQuota(stores.project.id, context.quota, { additionalBytes: files * (jsonBytes(body) + 4_096), additionalFiles: files }, () => reviews.assign(queueId, { type: requiredReviewTargetType(target.type), id: requiredString(target.id, "target.id"), ...(typeof target.subId === "string" ? { subId: target.subId } : {}) }, { ...(body.reviewerIds === undefined ? {} : { reviewerIds: optionalStrings(body.reviewerIds, "reviewerIds") }), ...(body.priority == null ? {} : { priority: requiredNumber(body.priority, "priority") }), ...(Array.isArray(body.labels) ? { labels: optionalStrings(body.labels, "labels") } : {}), ...(isRecord(body.metadata) ? { metadata: body.metadata } : {}), ...(typeof body.goldLabel === "string" ? { goldLabel: body.goldLabel } : {}) }));
        await workspace.audit(principal, "annotation.assign", { projectId: stores.project.id, target: assignment.groupId, details: { queueId, reviewers: assignment.reviewers.length } });
        return json(response, 201, { assignment });
      }
      if (action === "adjudicate" && request.method === "POST") {
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const decision = await workspace.withProjectQuota(stores.project.id, context.quota, { additionalBytes: jsonBytes(body) + 4_096, additionalFiles: 1 }, () => reviews.routeAdjudication(queueId, requiredString(body.groupId, "groupId")));
        await workspace.audit(principal, "annotation.adjudicate-route", { projectId: stores.project.id, target: decision.groupId });
        return json(response, 200, { decision });
      }
      if (action === "bulk" && request.method === "POST") {
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const decisions = requiredArray(body.decisions, "decisions") as any[];
        const result = await reviews.bulkComplete(principal.memberId ?? principal.keyId, decisions.map((decision) => ({ id: requiredString(decision.id, "decision.id"), revision: requiredInt(decision.revision, "decision.revision"), ...(decision.score == null ? {} : { score: requiredNumber(decision.score, "decision.score") }), ...(typeof decision.label === "string" ? { label: decision.label } : {}), ...(typeof decision.comment === "string" ? { comment: decision.comment } : {}), ...(decision.status === "skipped" ? { status: "skipped" as const } : {}) })));
        await workspace.audit(principal, "annotation.bulk-complete", { projectId: stores.project.id, target: queueId, details: { completed: result.completed.length, conflicts: result.conflicts.length } });
        return json(response, result.conflicts.length ? 207 : 200, result);
      }
      return json(response, 405, { error: "Method not allowed" });
    }

    const match = /^\/api\/v1\/projects\/([^/]+)\/(traces|experiments|prompts|queues)(?:\/([^/]+))?(?:\/(items|claim|complete|agreement))?$/.exec(url.pathname);
    if (!match) return json(response, 404, { error: "Not found" });
    const stores = workspace.project(decodePart(match[1]));
    const resource = match[2];
    const resourceId = match[3] ? decodePart(match[3]) : undefined;
    const action = match[4];

    if (resource === "traces") {
      if (request.method === "GET") {
        workspace.authorize(token, "read", stores.project.id);
        if (resourceId) {
          workspace.authorizeObject(token, "read", stores.project.id, "trace", resourceId);
          if (context.distributed) {
            const trace = await context.distributed.traces.get(distributedScope(workspace, principal, stores), resourceId);
            return trace ? json(response, 200, { traces: [trace] }) : json(response, 404, { error: "Resource not found" });
          }
          return json(response, 200, { traces: [stores.traces.load(resourceId)] });
        }
        if (context.distributed) {
          const page = await context.distributed.traces.page(distributedScope(workspace, principal, stores), { limit: optionalBoundedInt(url.searchParams.get("limit"), 100, 500), cursor: url.searchParams.get("cursor") ?? undefined });
          const query = url.searchParams.get("q")?.toLowerCase(), tag = url.searchParams.get("tag"), status = optionalTraceStatus(url.searchParams.get("status"));
          const traces = page.items.filter((trace) => (!query || `${trace.name} ${trace.spans.map((span) => span.name).join(" ")}`.toLowerCase().includes(query)) && (!tag || trace.tags?.includes(tag)) && (!status || trace.status === status)).filter((trace) => stores.access.allows(principal, "read", "trace", trace.id));
          return json(response, 200, { traces, page: { limit: optionalBoundedInt(url.searchParams.get("limit"), 100, 500), hasMore: page.hasMore, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) } });
        }
        const page = stores.traces.page({
          query: url.searchParams.get("q") ?? undefined,
          tag: url.searchParams.get("tag") ?? undefined,
          status: optionalTraceStatus(url.searchParams.get("status")),
          limit: optionalBoundedInt(url.searchParams.get("limit"), 100, 500),
          cursor: url.searchParams.get("cursor") ?? undefined,
        });
        return json(response, 200, { traces: page.items.filter((trace) => stores.access.allows(principal, "read", "trace", trace.id)), page: publicPage(page) });
      }
      const idempotentUpsert = request.method === "PUT" && Boolean(resourceId);
      if ((request.method === "POST" && !resourceId) || idempotentUpsert) {
        workspace.authorize(token, "ingest", stores.project.id);
        const body = await readJsonBody(request, context.maxBodyBytes, context.bodyBudget);
        const candidates = idempotentUpsert ? [body] : isRecord(body) && Array.isArray(body.traces) ? body.traces : [body];
        if (candidates.length < 1 || candidates.length > 500) throw new Error("Trace batch must contain 1-500 documents");
        const receivedAt = new Date().toISOString();
        const traces = candidates.map((candidate) => ({ ...structuredClone(validateIncomingTrace(candidate)), receivedAt }));
        if (idempotentUpsert && traces[0].id !== resourceId) throw new Error("Trace body id must match the request path");
        const processor = context.distributed ? undefined : onlineProcessor(context, stores);
        await workspace.withProjectQuota(stores.project.id, context.quota, {
          writes: traces.map((trace) => ({ file: stores.traces.file(trace.id), bytes: jsonBytes(trace) })),
          additionalBytes: traces.length * 2_048,
          additionalFiles: traces.length,
        }, async () => {
          if (context.distributed) await context.distributed.traces.putMany(distributedScope(workspace, principal, stores), traces);
          if (!context.distributedState) for (const trace of traces) await stores.traces.export(trace);
          if (processor) await processor.enqueue(traces.map((trace) => trace.id));
        });
        await context.analytics?.ingestTraces(workspace.config().id, stores.project.id, traces);
        processor?.trigger();
        await workspace.audit(principal, "trace.ingest", { projectId: stores.project.id, ...(resourceId ? { target: resourceId } : {}), details: { count: traces.length, idempotent: idempotentUpsert } });
        return json(response, 202, { accepted: traces.length, ids: traces.map((trace) => trace.id) });
      }
    }

    if (resource === "experiments") {
      if (request.method === "GET") {
        workspace.authorize(token, "read", stores.project.id);
        if (resourceId) {
          workspace.authorizeObject(token, "read", stores.project.id, "experiment", resourceId);
          return json(response, 200, { experiments: [stores.experiments.load(resourceId)] });
        }
        const page = stores.experiments.page({ limit: optionalBoundedInt(url.searchParams.get("limit"), 100, 500), cursor: url.searchParams.get("cursor") ?? undefined });
        return json(response, 200, { experiments: page.items.filter((experiment) => stores.access.allows(principal, "read", "experiment", experiment.id)), page: publicPage(page) });
      }
      if (request.method === "POST" && !resourceId) {
        workspace.authorize(token, "ingest", stores.project.id);
        const body = await readJsonBody(request, context.maxBodyBytes, context.bodyBudget);
        const candidates = isRecord(body) && Array.isArray(body.experiments) ? body.experiments : [body];
        if (candidates.length < 1 || candidates.length > 100) throw new Error("Experiment batch must contain 1-100 documents");
        const experiments = candidates.map((candidate) => structuredClone(validateIncomingExperiment(candidate)));
        const updatedAt = new Date().toISOString();
        for (const experiment of experiments) experiment.updatedAt = updatedAt;
        await workspace.withProjectQuota(stores.project.id, context.quota, {
          writes: experiments.map((experiment) => ({ file: stores.experiments.file(experiment.id), bytes: jsonBytes(experiment) })),
        }, async () => { for (const experiment of experiments) await stores.experiments.save(experiment); });
        await context.analytics?.ingestExperiments(workspace.config().id, stores.project.id, experiments);
        await workspace.audit(principal, "experiment.ingest", { projectId: stores.project.id, details: { count: experiments.length } });
        return json(response, 202, { accepted: experiments.length, ids: experiments.map((experiment) => experiment.id) });
      }
    }

    if (resource === "prompts") {
      if (request.method === "GET") {
        workspace.authorize(token, "read", stores.project.id);
        if (resourceId) {
          workspace.authorizeObject(token, "read", stores.project.id, "prompt", resourceId);
          return json(response, 200, { prompts: [stores.prompts.load(resourceId)] });
        }
        const page = stores.prompts.page({ limit: optionalBoundedInt(url.searchParams.get("limit"), 100, 500), cursor: url.searchParams.get("cursor") ?? undefined });
        return json(response, 200, { prompts: page.items.filter((prompt) => stores.access.allows(principal, "read", "prompt", prompt.name)), page: publicPage(page) });
      }
      if (request.method === "POST" && !resourceId) {
        workspace.authorize(token, "manage-prompts", stores.project.id);
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const name = requiredString(body.name, "name");
        workspace.authorizeObject(token, "manage-prompts", stores.project.id, "prompt", name);
        const version = await workspace.withProjectQuota(stores.project.id, context.quota, {
          additionalBytes: jsonBytes(body) + 8_192,
          additionalFiles: 1,
        }, () => stores.prompts.publish(name, requiredString(body.template, "template"), {
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(typeof body.label === "string" ? { label: body.label } : {}),
            ...(Array.isArray(body.tags) ? { tags: optionalStrings(body.tags, "tags") } : {}),
            ...(isRecord(body.metadata) ? { metadata: body.metadata } : {}),
          }));
        await workspace.audit(principal, "prompt.publish", { projectId: stores.project.id, target: name, details: { version: version.version } });
        return json(response, 201, { version });
      }
    }

    if (resource === "queues") {
      if (!resourceId && !action && request.method === "GET") {
        workspace.authorize(token, "read", stores.project.id);
        const page = stores.annotations.pageQueues({ limit: optionalBoundedInt(url.searchParams.get("limit"), 100, 500), cursor: url.searchParams.get("cursor") ?? undefined });
        return json(response, 200, { queues: page.items.filter((queue) => stores.access.allows(principal, "read", "annotation-queue", queue.id)), page: publicPage(page) });
      }
      if (!resourceId && !action && request.method === "POST") {
        workspace.authorize(token, "annotate", stores.project.id);
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const queue = await workspace.withProjectQuota(stores.project.id, context.quota, {
          additionalBytes: jsonBytes(body) + 4_096,
          additionalFiles: 1,
        }, () => stores.annotations.createQueue(requiredString(body.name, "name"), typeof body.description === "string" ? body.description : undefined, {
          ...(body.mode == null ? {} : { mode: requiredReviewMode(body.mode) }),
          ...(body.reviewersPerTarget == null ? {} : { reviewersPerTarget: requiredInt(body.reviewersPerTarget, "reviewersPerTarget") }),
          ...(body.assignment == null ? {} : { assignment: requiredAssignmentMode(body.assignment) }),
          ...(body.reviewerIds === undefined ? {} : { reviewerIds: optionalStrings(body.reviewerIds, "reviewerIds") }),
          ...(body.adjudicationQueueId == null ? {} : { adjudicationQueueId: requiredString(body.adjudicationQueueId, "adjudicationQueueId") }),
          ...(body.slaHours == null ? {} : { slaHours: requiredNumber(body.slaHours, "slaHours") }),
        }));
        await workspace.audit(principal, "annotation-queue.create", { projectId: stores.project.id, target: queue.id });
        return json(response, 201, { queue });
      }
      if (resourceId && action === "items" && request.method === "GET") {
        workspace.authorizeObject(token, "read", stores.project.id, "annotation-queue", resourceId);
        const page = stores.annotations.pageItems({ queueId: resourceId, status: optionalStatus(url.searchParams.get("status")), assignedTo: url.searchParams.get("assignedTo") ?? undefined, limit: optionalBoundedInt(url.searchParams.get("limit"), 100, 500), cursor: url.searchParams.get("cursor") ?? undefined });
        const reviews = new ReviewWorkflow(stores.annotations);
        const viewerId = principal.memberId ?? principal.keyId;
        return json(response, 200, { items: page.items.map((item) => reviews.blindView(item, viewerId)), page: publicPage(page) });
      }
      if (resourceId && action === "items" && request.method === "POST") {
        workspace.authorizeObject(token, "annotate", stores.project.id, "annotation-queue", resourceId);
        const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
        const target = asRecord(body.target);
        const item = await workspace.withProjectQuota(stores.project.id, context.quota, {
          additionalBytes: jsonBytes(body) + 4_096,
          additionalFiles: 1,
        }, () => stores.annotations.enqueue(resourceId, {
            type: requiredString(target.type, "target.type") as any,
            id: requiredString(target.id, "target.id"),
            ...(typeof target.subId === "string" ? { subId: target.subId } : {}),
          }, {
            ...(body.priority == null ? {} : { priority: requiredNumber(body.priority, "priority") }),
            ...(Array.isArray(body.labels) ? { labels: optionalStrings(body.labels, "labels") } : {}),
            ...(isRecord(body.metadata) ? { metadata: body.metadata } : {}),
            ...(typeof body.assignedTo === "string" ? { assignedTo: body.assignedTo } : {}),
          }));
        await workspace.audit(principal, "annotation.enqueue", { projectId: stores.project.id, target: item.id, details: { queueId: resourceId } });
        return json(response, 201, { item });
      }
      if (resourceId && action === "agreement" && request.method === "GET") {
        workspace.authorizeObject(token, "read", stores.project.id, "annotation-queue", resourceId);
        return json(response, 200, { agreement: stores.annotations.agreement(resourceId) });
      }
    }

    if (resource === "queues" && resourceId && action === "claim" && request.method === "POST") {
      const queueId = stores.annotations.loadItem(resourceId).queueId;
      workspace.authorizeObject(token, "annotate", stores.project.id, "annotation-queue", queueId);
      const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
      const reviewerId = principal.memberId ?? principal.keyId;
      const requestedAssignee = body.assignee == null ? reviewerId : requiredString(body.assignee, "assignee");
      if (requestedAssignee !== reviewerId) throw new TeamAuthError("Reviewers cannot claim work for another identity", 403);
      const item = await workspace.withProjectQuota(stores.project.id, context.quota, {
        additionalBytes: jsonBytes(body) + 4_096,
      }, () => stores.annotations.claim(resourceId, reviewerId, optionalNumber(body.revision)));
      await workspace.audit(principal, "annotation.claim", { projectId: stores.project.id, target: item.id });
      return json(response, 200, { item });
    }
    if (resource === "queues" && resourceId && action === "complete" && request.method === "POST") {
      const queueId = stores.annotations.loadItem(resourceId).queueId;
      workspace.authorizeObject(token, "annotate", stores.project.id, "annotation-queue", queueId);
      const body = asRecord(await readJsonBody(request, context.maxBodyBytes, context.bodyBudget));
      const current = stores.annotations.loadItem(resourceId);
      if (current.assignedTo && current.assignedTo !== (principal.memberId ?? principal.keyId)) throw new TeamAuthError("Review is assigned to another identity", 403);
      const item = await workspace.withProjectQuota(stores.project.id, context.quota, {
        additionalBytes: jsonBytes(body) + 4_096,
      }, () => stores.annotations.complete(resourceId, {
          ...(body.score == null ? {} : { score: requiredNumber(body.score, "score") }),
          ...(typeof body.label === "string" ? { label: body.label } : {}),
          ...(typeof body.comment === "string" ? { comment: body.comment } : {}),
          ...(body.status === "skipped" ? { status: "skipped" } : {}),
        }, optionalNumber(body.revision)));
      await workspace.audit(principal, "annotation.complete", { projectId: stores.project.id, target: item.id, details: { status: item.status } });
      return json(response, 200, { item });
    }

    return json(response, 405, { error: "Method not allowed" });
  } catch (error) {
    if (error instanceof ScimError || (request.url ?? "").startsWith("/scim/v2/")) {
      const scimError = error instanceof ScimError ? error : new ScimError(undefined, publicErrorMessage(error, workspace.dir, 400), 400);
      return scimJson(response, scimError.status, scimError.body());
    }
    const status = error instanceof TeamAuthError ? error.status
      : error instanceof OidcError ? error.status
      : error instanceof AnalyticsError ? error.status
      : error instanceof AnnotationConflictError ? 409
      : error instanceof ObjectAccessConflictError ? 409
      : error instanceof TeamQuotaError ? 507
      : error instanceof BodyCapacityError ? 503
      : isBodyTooLarge(error) ? 413
      : isNotFound(error) ? 404
      : 400;
    return json(response, status, {
      error: publicErrorMessage(error, workspace.dir, status),
      ...(error instanceof AnnotationConflictError ? { currentRevision: error.currentRevision } : {}),
      ...(error instanceof ObjectAccessConflictError ? { currentRevision: error.currentRevision } : {}),
      ...(error instanceof TeamQuotaError ? { usage: error.usage, projected: error.projected, quota: error.quota } : {}),
    });
  }
}

async function persistImportedTraces(workspace: TeamWorkspace, principal: TeamPrincipal, stores: TeamProjectStores, traces: ReturnType<typeof createDemoTraces>, context: RouteContext): Promise<void> {
  const normalized = traces.map((trace) => validateIncomingTrace({ ...trace, receivedAt: trace.receivedAt ?? new Date().toISOString() }));
  const scope = distributedScope(workspace, principal, stores);
  const processor = context.distributed ? undefined : onlineProcessor(context, stores);
  await workspace.withProjectQuota(stores.project.id, context.quota, {
    writes: normalized.map((trace) => ({ file: stores.traces.file(trace.id), bytes: jsonBytes(trace) })),
    additionalBytes: normalized.length * 2_048, additionalFiles: normalized.length,
  }, async () => {
    if (context.distributed) await context.distributed.traces.putMany(scope, normalized);
    if (!context.distributedState) for (const trace of normalized) await stores.traces.export(trace);
    if (processor) await processor.enqueue(normalized.map((trace) => trace.id));
  });
  await context.analytics?.ingestTraces(workspace.config().id, stores.project.id, normalized);
  processor?.trigger();
}

async function setupDiagnostics(workspace: TeamWorkspace, context: RouteContext): Promise<Record<string, unknown>> {
  const checks: Array<{ id: string; status: "pass" | "warn" | "fail"; title: string; detail: string }> = [];
  const config = workspace.config();
  checks.push({ id: "workspace", status: "pass", title: "Workspace", detail: `${config.projects.length} project(s); configuration is readable` });
  if (context.distributed) {
    const health = await context.distributed.health();
    const schemaVersion = health.ok ? await context.distributed.control.schemaVersion() : 0;
    checks.push({ id: "distributed", status: health.ok ? "pass" : "fail", title: "Distributed dependencies", detail: health.ok ? `PostgreSQL schema v${schemaVersion}, object storage, and JetStream are reachable` : health.error ?? "Dependency check failed" });
    checks.push({ id: "state", status: context.distributedState ? "pass" : "fail", title: "Stateless nodes", detail: context.distributedState ? `Encrypted snapshot r${context.distributedState.status().revision}; shared POSIX is not required` : "Distributed dependencies are enabled but workspace state coordination is not" });
  } else checks.push({ id: "distributed", status: "warn", title: "Local mode", detail: "Good for one-node development; enable the free PostgreSQL, MinIO, and NATS profile for HA" });
  if (context.analytics) {
    const health = await context.analytics.health().catch(() => ({ ok: false, backend: context.analytics!.backend, latencyMs: 0 }));
    checks.push({ id: "analytics", status: health.ok ? "pass" : "fail", title: "Production analytics", detail: health.ok ? `${health.backend} reachable in ${health.latencyMs} ms` : `${health.backend} is unavailable` });
  } else checks.push({ id: "analytics", status: "warn", title: "Production analytics", detail: "In-memory/local views work; configure free ClickHouse for multi-node retention" });
  checks.push({ id: "otlp", status: "pass", title: "Drop-in telemetry", detail: "OTLP HTTP JSON/protobuf and OpenInference mapping are enabled at /v1/traces" });
  checks.push({ id: "judge", status: context.localJudge ? "pass" : "warn", title: "Semantic judge", detail: context.localJudge ? "A loopback local judge is available" : "Deterministic checks work; connect Ollama, vLLM, or LM Studio for local semantic scoring" });
  const actions = checks.filter((check) => check.status !== "pass").map((check) => ({ check: check.id, severity: check.status, recommendation: check.detail }));
  return { generatedAt: new Date().toISOString(), ready: !checks.some((check) => check.status === "fail"), mode: context.distributedState ? "stateless-distributed" : context.distributed ? "distributed-traces" : "local", checks, actions, costs: { requiredHostedServices: 0, providerCostUsd: 0 } };
}

function requiredMigrationSource(value: unknown): MigrationSource {
  if (value !== "deepeval" && value !== "langfuse" && value !== "braintrust") throw new Error("source must be deepeval, langfuse, or braintrust");
  return value;
}

class RateLimiter {
  private readonly requests = new Map<string, { minute: number; count: number }>();
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  consume(key: string): boolean {
    const minute = Math.floor(Date.now() / 60_000);
    const current = this.requests.get(key);
    if (!current || current.minute !== minute) {
      this.requests.set(key, { minute, count: 1 });
      if (this.requests.size > 10_000) for (const [candidate, value] of this.requests) if (value.minute < minute) this.requests.delete(candidate);
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}

class BodyBudget {
  private requests = 0;
  private bytes = 0;
  private readonly maxRequests: number;
  private readonly maxBytes: number;
  constructor(maxRequests: number, maxBytes: number) { this.maxRequests = maxRequests; this.maxBytes = maxBytes; }
  begin(): void {
    if (this.requests >= this.maxRequests) throw new BodyCapacityError("Too many concurrent request bodies");
    this.requests += 1;
  }
  reserve(bytes: number): void {
    if (this.bytes + bytes > this.maxBytes) throw new BodyCapacityError("Concurrent request body budget exceeded");
    this.bytes += bytes;
  }
  release(bytes: number): void { this.bytes = Math.max(0, this.bytes - bytes); this.requests = Math.max(0, this.requests - 1); }
}

class BodyCapacityError extends Error {
  constructor(message: string) { super(message); this.name = "BodyCapacityError"; }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number, budget: BodyBudget): Promise<unknown> {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/scim+json") throw new Error("Content-Type must be application/json or application/scim+json");
  let size = 0;
  let reserved = 0;
  const chunks: Buffer[] = [];
  budget.begin();
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw Object.assign(new Error(`Request body exceeds ${maxBytes} bytes`), { code: "BODY_TOO_LARGE" });
      budget.reserve(buffer.length);
      reserved += buffer.length;
      chunks.push(buffer);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("Request body is not valid JSON"); }
  } finally {
    budget.release(reserved);
  }
}

async function readRawBody(request: IncomingMessage, maxBytes: number, budget: BodyBudget): Promise<Uint8Array> {
  let size = 0, reserved = 0; const chunks: Buffer[] = [];
  budget.begin();
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
      if (size > maxBytes) throw Object.assign(new Error(`Request body exceeds ${maxBytes} bytes`), { code: "BODY_TOO_LARGE" });
      budget.reserve(buffer.length); reserved += buffer.length; chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  } finally { budget.release(reserved); }
}

function bearerToken(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (value?.startsWith("Bearer ") && value.slice(7).trim()) return value.slice(7).trim();
  return sessionTokenFromCookies(request.headers.cookie) ?? "";
}

function rawBearerToken(request: IncomingMessage): string {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function setSecurityHeaders(response: ServerResponse, secure: boolean): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader("Cache-Control", "no-store");
  if (secure) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  const value = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(value) });
  response.end(value);
}
function binary(response: ServerResponse, status: number, body: Uint8Array, contentType: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", String(body.byteLength));
  response.end(body);
}
function safeLoadTrace(stores: TeamProjectStores, id: string) {
  try { return stores.traces.load(id); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
function scimJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  const value = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/scim+json; charset=utf-8", "Content-Length": Buffer.byteLength(value) });
  response.end(value);
}
function prometheus(response: ServerResponse, body: string): void {
  if (response.writableEnded) return;
  response.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}
function html(response: ServerResponse, body: string): void { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body) }); response.end(body); }
function empty(response: ServerResponse, status: number): void { response.writeHead(status); response.end(); }

async function readiness(workspace: TeamWorkspace, analytics?: AnalyticsStore, distributed?: DistributedRuntime, distributedState?: DistributedWorkspaceState): Promise<TeamReadiness> {
  let workspaceOk = true;
  try { workspace.config(); } catch { workspaceOk = false; }
  let analyticsCheck: TeamReadiness["checks"]["analytics"] = { ok: true, backend: "disabled", latencyMs: 0 };
  if (analytics) try { const health = await analytics.health(); analyticsCheck = { ok: health.ok, backend: health.backend, latencyMs: health.latencyMs }; } catch { analyticsCheck = { ok: false, backend: analytics.backend }; }
  let distributedCheck: NonNullable<TeamReadiness["checks"]["distributed"]> | undefined;
  if (distributed) {
    const health = await distributed.health();
    distributedCheck = { ok: health.ok, ...(health.postgres ? { postgres: health.postgres } : {}), ...(health.artifacts ? { artifacts: health.artifacts } : {}), ...(health.queue ? { queue: health.queue } : {}), ...(distributedState ? { state: distributedState.status() } : {}) };
  }
  return { ok: workspaceOk && analyticsCheck.ok && (!distributedCheck || distributedCheck.ok), checks: { workspace: { ok: workspaceOk }, analytics: analyticsCheck, ...(distributedCheck ? { distributed: distributedCheck } : {}) } };
}

function safeRuntimeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/(?:postgres(?:ql)?|nats|https?):\/\/[^\s@]+@/gi, (value) => value.replace(/\/\/.*@/, "//[redacted]@")).slice(0, 300); }

async function runConfiguredRetention(workspace: TeamWorkspace, analytics?: AnalyticsStore): Promise<void> {
  const plans = await workspace.runConfiguredRetention();
  if (!analytics?.deleteBefore) return;
  const workspaceId = workspace.config().id;
  for (const plan of plans) await analytics.deleteBefore(workspaceId, plan.projectId, plan.cutoff);
}

function analyticsQuery(url: URL): {
  since?: string; until?: string; kind?: "trace" | "experiment"; status?: string; tags?: string[];
  model?: string; provider?: string; environment?: string; release?: string; search?: string; limit: number; cursor?: string;
} {
  const kind = url.searchParams.get("kind");
  if (kind != null && kind !== "trace" && kind !== "experiment") throw new Error("Analytics kind must be trace or experiment");
  const value = (name: string): string | undefined => {
    const result = url.searchParams.get(name)?.trim();
    if (result && result.length > 512) throw new Error(`Analytics ${name} is too long`);
    return result || undefined;
  };
  const tags = url.searchParams.getAll("tag").map((tag) => tag.trim()).filter(Boolean);
  if (tags.length > 20 || tags.some((tag) => tag.length > 256)) throw new Error("Analytics tags are invalid");
  return {
    ...(value("since") ? { since: value("since") } : {}), ...(value("until") ? { until: value("until") } : {}),
    ...(kind ? { kind } : {}), ...(value("status") ? { status: value("status") } : {}), ...(tags.length ? { tags: [...new Set(tags)] } : {}),
    ...(value("model") ? { model: value("model") } : {}), ...(value("provider") ? { provider: value("provider") } : {}),
    ...(value("environment") ? { environment: value("environment") } : {}), ...(value("release") ? { release: value("release") } : {}),
    ...(value("q") ? { search: value("q") } : {}), limit: optionalBoundedInt(url.searchParams.get("limit"), 100, 500),
    ...(value("cursor") ? { cursor: value("cursor") } : {}),
  };
}

function optionalAnalyticsInterval(value: string | null): "hour" | "day" | "week" | undefined {
  if (value == null) return undefined;
  if (value !== "hour" && value !== "day" && value !== "week") throw new Error("Analytics interval must be hour, day, or week");
  return value;
}

function distributedScope(workspace: TeamWorkspace, principal: TeamPrincipal, stores: TeamProjectStores): DistributedScope {
  return { organizationId: principal.organizationId ?? workspace.config().id, workspaceId: workspace.config().id, projectId: stores.project.id };
}

function tlsValue(value: string | Buffer): string | Buffer { return typeof value === "string" ? readFileSync(value) : value; }
function isLoopback(host: string): boolean { return ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase()); }
function validateOrigin(value: string): void { const parsed = new URL(value); if (!/^https?:$/.test(parsed.protocol) || parsed.pathname !== "/") throw new Error(`Invalid CORS origin: ${value}`); }
function isSameOrigin(request: IncomingMessage, origin: string, secure: boolean): boolean {
  const host = request.headers.host;
  if (!host) return false;
  try { return new URL(origin).origin === `${secure ? "https" : "http"}://${host}`; } catch { return false; }
}
function decodePart(value: string): string { try { return decodeURIComponent(value); } catch { throw new Error("Invalid URL encoding"); } }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function asRecord(value: unknown): Record<string, any> { if (!isRecord(value)) throw new Error("Request body must be a JSON object"); return value; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`); return value; }
function requiredArray(value: unknown, name: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); return value; }
function requiredBoolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`); return value; }
function requiredNumber(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`); return value; }
function requiredInt(value: unknown, name: string): number { const number = requiredNumber(value, name); if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`); return number; }
function optionalNumber(value: unknown): number | undefined { return value == null ? undefined : requiredNumber(value, "revision"); }
function optionalInt(value: string | null, fallback: number): number { if (value == null) return fallback; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Query limit must be a positive integer"); return parsed; }
function optionalBoundedInt(value: string | null, fallback: number, maximum: number): number { const parsed = optionalInt(value, fallback); if (parsed > maximum) throw new Error(`Query limit cannot exceed ${maximum}`); return parsed; }
function optionalStrings(value: unknown, name: string): string[] | undefined { if (value == null) return undefined; if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${name} must be an array of non-empty strings`); return [...new Set(value)]; }
function optionalString(value: unknown): string | undefined { return value == null ? undefined : requiredString(value, "value"); }
function requiredCapabilities(value: unknown): TeamCapability[] {
  const capabilities = optionalStrings(value, "capabilities");
  const allowed: TeamCapability[] = ["read", "ingest", "annotate", "manage-prompts", "manage-keys", "manage-members", "manage-projects", "manage-retention", "manage-access", "manage-groups", "manage-roles", "manage-organization", "read-audit"];
  if (!capabilities?.length || capabilities.some((capability) => !allowed.includes(capability as TeamCapability))) throw new Error("capabilities contains an unsupported team capability");
  return capabilities as TeamCapability[];
}
function requiredRole(value: unknown): TeamRole { if (!["admin", "editor", "viewer", "ingest"].includes(String(value))) throw new Error("role must be admin, editor, viewer, or ingest"); return value as TeamRole; }
function requiredReviewMode(value: unknown): "single" | "double-blind" | "adjudicated" { if (!["single", "double-blind", "adjudicated"].includes(String(value))) throw new Error("mode must be single, double-blind, or adjudicated"); return value as "single" | "double-blind" | "adjudicated"; }
function requiredAssignmentMode(value: unknown): "manual" | "round-robin" | "deterministic-random" { if (!["manual", "round-robin", "deterministic-random"].includes(String(value))) throw new Error("assignment must be manual, round-robin, or deterministic-random"); return value as "manual" | "round-robin" | "deterministic-random"; }
function requiredReviewTargetType(value: unknown): "trace" | "span" | "experiment-case" { if (!["trace", "span", "experiment-case"].includes(String(value))) throw new Error("target.type must be trace, span, or experiment-case"); return value as "trace" | "span" | "experiment-case"; }
function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> { return new Promise((resolve) => { if (signal.aborted) return resolve(); const timer = setTimeout(done, milliseconds); timer.unref(); function done(): void { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); }); }
function requiredIntelligenceWindow(value: unknown, name: string): IntelligenceWindow {
  const input = asRecord(value);
  const result: IntelligenceWindow = {
    ...(typeof input.since === "string" ? { since: input.since } : {}), ...(typeof input.until === "string" ? { until: input.until } : {}),
    ...(typeof input.release === "string" ? { release: input.release } : {}), ...(typeof input.environment === "string" ? { environment: input.environment } : {}),
  };
  if (!Object.keys(result).length) throw new Error(`${name} must contain a time or release filter`);
  return result;
}
function requiredMemberRole(value: unknown): Exclude<TeamRole, "ingest"> { if (!["admin", "editor", "viewer"].includes(String(value))) throw new Error("member role must be admin, editor, or viewer"); return value as Exclude<TeamRole, "ingest">; }
function requiredMemberStatus(value: unknown): TeamMemberStatus { if (!["active", "suspended"].includes(String(value))) throw new Error("status must be active or suspended"); return value as TeamMemberStatus; }
function requiredObjectResourceType(value: unknown): ObjectResourceType { if (!["trace", "experiment", "prompt", "annotation-queue", "online-rule", "playground-run", "regression", "quality-monitor"].includes(String(value))) throw new Error("Invalid object resource type"); return value as ObjectResourceType; }
function optionalStatus(value: string | null): AnnotationStatus | undefined { if (value == null) return undefined; if (!["pending", "claimed", "completed", "skipped"].includes(value)) throw new Error("Invalid annotation status"); return value as AnnotationStatus; }
function optionalTraceStatus(value: string | null): "ok" | "error" | undefined { if (value == null) return undefined; if (value !== "ok" && value !== "error") throw new Error("Invalid trace status"); return value; }
function optionalMonitorStatus(value: string | null): "healthy" | "breached" | "insufficient-data" | undefined { if (value == null) return undefined; if (!["healthy", "breached", "insufficient-data"].includes(value)) throw new Error("Invalid quality monitor status"); return value as "healthy" | "breached" | "insufficient-data"; }
function positiveInteger(value: number, name: string): number { if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`); return value; }
function validateServiceToken(value: string, name: string): string { if (value.length < 32 || value.length > 4_096) throw new Error(`${name} must contain 32-4096 characters`); return value; }
function secretHash(value: string): Buffer { return createHash("sha256").update(value).digest(); }
function secureTokenMatch(value: string, expectedHash: Buffer): boolean { return timingSafeEqual(secretHash(value), expectedHash); }
function isBodyTooLarge(error: unknown): boolean { return isRecord(error) && error.code === "BODY_TOO_LARGE"; }
function isNotFound(error: unknown): boolean { return isRecord(error) && error.code === "ENOENT"; }
function jsonBytes(value: unknown): number { return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`); }

function onlineProcessor(context: RouteContext, stores: TeamProjectStores): OnlineEvaluationProcessor {
  const existing = context.onlineProcessors.get(stores.project.id);
  if (existing) return existing;
  const engine = new OnlineEvaluationEngine(stores.online, { judge: context.localJudge, annotations: stores.annotations });
  const processor = new OnlineEvaluationProcessor(stores.online, stores.traces, engine);
  context.onlineProcessors.set(stores.project.id, processor);
  processor.trigger();
  return processor;
}
function publicPage(page: { limit: number; scanned: number; hasMore: boolean; nextCursor?: string }): Record<string, unknown> { return { limit: page.limit, scanned: page.scanned, hasMore: page.hasMore, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }; }
function publicErrorMessage(error: unknown, workspaceDir: string, status: number): string {
  if (status === 404) return "Resource not found";
  if (status >= 500 && !(error instanceof TeamQuotaError) && !(error instanceof BodyCapacityError)) return "Internal server error";
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(workspaceDir) || /(?:^|\s)(?:\/[A-Za-z0-9_.-]+){3,}/.test(message) || /[A-Za-z]:\\[^\s]+/.test(message)) return "Request could not be completed";
  return message.slice(0, 500);
}
function publicRetentionPlan(plan: ReturnType<TeamWorkspace["planRetention"]>): Record<string, unknown> { return { projectId: plan.projectId, olderThanDays: plan.olderThanDays, cutoff: plan.cutoff, total: plan.total, counts: { traces: plan.traces.length, experiments: plan.experiments.length, completedAnnotations: plan.completedAnnotations.length } }; }
