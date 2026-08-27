import type { IncomingMessage, ServerResponse } from "node:http";

const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000] as const;

interface RouteMetric {
  requests: number;
  errors: number;
  durationMs: number;
  buckets: number[];
}

export interface ServiceMetricSnapshot {
  startedAt: string;
  uptimeSeconds: number;
  activeRequests: number;
  requests: number;
  errors: number;
}

export class ServiceMetrics {
  readonly startedAt = new Date().toISOString();
  private active = 0;
  private requests = 0;
  private errors = 0;
  private readonly routes = new Map<string, RouteMetric>();

  observe(request: IncomingMessage, response: ServerResponse): () => void {
    const started = performance.now();
    this.active += 1;
    let recorded = false;
    return () => {
      if (recorded) return;
      recorded = true;
      this.active = Math.max(0, this.active - 1);
      this.requests += 1;
      const method = request.method ?? "UNKNOWN";
      const route = normalizedRoute(request.url ?? "/");
      const status = response.statusCode;
      const duration = Math.max(0, performance.now() - started);
      const key = `${method}\0${route}\0${status}`;
      const metric = this.routes.get(key) ?? { requests: 0, errors: 0, durationMs: 0, buckets: LATENCY_BUCKETS_MS.map(() => 0) };
      metric.requests += 1;
      metric.durationMs += duration;
      if (status >= 500) { metric.errors += 1; this.errors += 1; }
      for (let index = 0; index < LATENCY_BUCKETS_MS.length; index++) if (duration <= LATENCY_BUCKETS_MS[index]) metric.buckets[index] += 1;
      this.routes.set(key, metric);
      if (this.routes.size > 10_000) this.routes.clear();
    };
  }

  snapshot(): ServiceMetricSnapshot {
    return { startedAt: this.startedAt, uptimeSeconds: Math.max(0, (Date.now() - Date.parse(this.startedAt)) / 1000), activeRequests: this.active, requests: this.requests, errors: this.errors };
  }

  prometheus(): string {
    const snapshot = this.snapshot();
    const lines = [
      "# HELP dryrun_up Whether the team server process is running.",
      "# TYPE dryrun_up gauge",
      "dryrun_up 1",
      "# HELP dryrun_uptime_seconds Team server process uptime.",
      "# TYPE dryrun_uptime_seconds gauge",
      `dryrun_uptime_seconds ${snapshot.uptimeSeconds.toFixed(3)}`,
      "# HELP dryrun_http_active_requests Requests currently executing.",
      "# TYPE dryrun_http_active_requests gauge",
      `dryrun_http_active_requests ${snapshot.activeRequests}`,
      "# HELP dryrun_http_requests_total Completed HTTP requests.",
      "# TYPE dryrun_http_requests_total counter",
      "# HELP dryrun_http_request_errors_total Completed HTTP requests with a 5xx status.",
      "# TYPE dryrun_http_request_errors_total counter",
      "# HELP dryrun_http_request_duration_ms HTTP request latency histogram.",
      "# TYPE dryrun_http_request_duration_ms histogram",
    ];
    for (const [key, metric] of [...this.routes].sort(([left], [right]) => left.localeCompare(right))) {
      const [method, route, status] = key.split("\0");
      const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${escapeLabel(status)}"`;
      lines.push(`dryrun_http_requests_total{${labels}} ${metric.requests}`);
      lines.push(`dryrun_http_request_errors_total{${labels}} ${metric.errors}`);
      for (let index = 0; index < LATENCY_BUCKETS_MS.length; index++) lines.push(`dryrun_http_request_duration_ms_bucket{${labels},le="${LATENCY_BUCKETS_MS[index]}"} ${metric.buckets[index]}`);
      lines.push(`dryrun_http_request_duration_ms_bucket{${labels},le="+Inf"} ${metric.requests}`);
      lines.push(`dryrun_http_request_duration_ms_sum{${labels}} ${metric.durationMs.toFixed(3)}`);
      lines.push(`dryrun_http_request_duration_ms_count{${labels}} ${metric.requests}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

function normalizedRoute(raw: string): string {
  let pathname = "/";
  try { pathname = new URL(raw, "http://dry-run.local").pathname; } catch { /* keep root */ }
  return pathname
    .replace(/\/api\/v1\/projects\/[^/]+/g, "/api/v1/projects/:project")
    .replace(/\/scim\/v2\/Users\/[^/]+/g, "/scim/v2/Users/:id")
    .replace(/\/(?:traces|experiments|prompts|queues|members|keys|invitations)\/[^/]+/g, (value) => `${value.slice(0, value.lastIndexOf("/"))}/:id`)
    .slice(0, 256);
}

function escapeLabel(value: string): string { return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"'); }
