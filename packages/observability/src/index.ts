import pino from "pino";

export type TelemetryContext = {
  correlation_id?: string; request_id?: string; command_id?: string; mailbox_id?: string; draft_id?: string;
  worker_id?: string; scheduler?: string; operation?: string; result?: "success" | "failure" | "skipped";
  error_code?: string; duration_ms?: number;
};
export type MetricLabels = Record<string, string | number | boolean>;
export type Metrics = { counter: (name: string, value?: number, labels?: MetricLabels) => void; histogram: (name: string, value: number, labels?: MetricLabels) => void; gauge: (name: string, value: number, labels?: MetricLabels) => void };
export type Trace = { context: TelemetryContext; event: (name: string, fields?: TelemetryContext) => void; end: (fields?: TelemetryContext) => void };

const forbidden = /email|recipient|subject|body|html|mime|token|authorization|refresh|access|provider.*id|gmail.*id|message.*id|payload|encrypted|claim|url|header/i;
export function safeTelemetryContext(context: Record<string, unknown>): TelemetryContext {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (!forbidden.test(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) safe[key] = value;
  }
  return safe as TelemetryContext;
}

export class InMemoryMetrics implements Metrics {
  readonly counters = new Map<string, number>(); readonly histograms = new Map<string, number[]>(); readonly gauges = new Map<string, number>();
  counter(name: string, value = 1, labels: MetricLabels = {}) { const key = metricKey(name, labels); this.counters.set(key, (this.counters.get(key) ?? 0) + value); }
  histogram(name: string, value: number, labels: MetricLabels = {}) { const key = metricKey(name, labels); this.histograms.set(key, [...(this.histograms.get(key) ?? []), value]); }
  gauge(name: string, value: number, labels: MetricLabels = {}) { this.gauges.set(metricKey(name, labels), value); }
}
function metricKey(name: string, labels: MetricLabels) { return `${name}:${JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))}`; }
export const noopMetrics: Metrics = { counter() {}, histogram() {}, gauge() {} };
let activeMetrics: Metrics = noopMetrics;
/** Process-local only. Exporters can replace this sink later without changing instrumentation call sites. */
export function setMetrics(metrics: Metrics) { activeMetrics = metrics; }
export function metrics() { return activeMetrics; }

export type HealthLevel = "healthy" | "degraded" | "unavailable";
export type HealthInput = { database: boolean; redis: boolean; consumers: boolean; schedulers: boolean; heartbeatAgeSeconds: number | null; heartbeatStaleSeconds: number; recoveryRequiredCount: number; queueDepth: number; queueDepthDegradedAt?: number; recoveryDegradedAt?: number };
/** Pure aggregation: Gmail reachability is deliberately not part of worker health. */
export function aggregateHealth(input: HealthInput): { status: HealthLevel; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.database) reasons.push("database_unavailable"); if (!input.redis) reasons.push("redis_unavailable"); if (!input.consumers) reasons.push("consumer_unavailable"); if (!input.schedulers) reasons.push("scheduler_unavailable");
  if (input.heartbeatAgeSeconds !== null && input.heartbeatAgeSeconds > input.heartbeatStaleSeconds) reasons.push("heartbeat_stale");
  if (reasons.length) return { status: "unavailable", reasons };
  if (input.queueDepth > (input.queueDepthDegradedAt ?? 1_000)) reasons.push("queue_backlog");
  if (input.recoveryRequiredCount > (input.recoveryDegradedAt ?? 10)) reasons.push("recovery_backlog");
  return { status: reasons.length ? "degraded" : "healthy", reasons };
}

export type AlertEvent = { code: "stale_heartbeat" | "queue_growth" | "recovery_spike" | "scheduler_failure" | "redis_unavailable" | "database_unavailable" | "provider_error_spike" | "worker_restart_loop"; severity: "warning" | "critical"; occurred_at: string; metadata: Record<string, number | string | boolean> };

export function startTrace(operation: string, context: TelemetryContext = {}, clock: () => number = Date.now): Trace {
  const startedAt = clock(); const base = safeTelemetryContext({ ...context, operation });
  return { context: base, event: (name, fields = {}) => logger.debug(safeTelemetryContext({ ...base, ...fields, operation: `${operation}.${name}` }), "telemetry trace event"), end: (fields = {}) => {
    const elapsed = Math.max(0, clock() - startedAt); const event = safeTelemetryContext({ ...base, ...fields, duration_ms: elapsed });
    activeMetrics.histogram("operation_duration_ms", elapsed, { operation, result: event.result ?? "success" });
    logger.info(event, "telemetry trace completed");
  } };
}

export async function observe<T>(operation: string, action: () => Promise<T>, context: TelemetryContext = {}, metric = "operation_duration_ms"): Promise<T> {
  const startedAt = Date.now();
  try { const value = await action(); activeMetrics.counter("operations_total", 1, { operation, result: "success" }); activeMetrics.histogram(metric, Date.now() - startedAt, { operation, result: "success" }); return value; }
  catch (error) { activeMetrics.counter("operations_total", 1, { operation, result: "failure" }); activeMetrics.histogram(metric, Date.now() - startedAt, { operation, result: "failure" }); throw error; }
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: ["accessToken", "refreshToken", "authorization", "headers.authorization", "emailBody", "subject", "recipients", "payload", "encryptedPayload", "providerResponse", "messageId"], censor: "[REDACTED]" }
});
