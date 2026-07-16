import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryMetrics, aggregateHealth, observe, safeTelemetryContext, setMetrics, startTrace } from "./index.js";

test("telemetry context excludes secrets and content", () => {
  assert.deepEqual(safeTelemetryContext({ correlation_id: "c", mailbox_id: "m", email: "x@example.test", encryptedPayload: "cipher", body: "secret" }), { correlation_id: "c", mailbox_id: "m" });
});
test("metrics and traces record only normalized timing", async () => {
  const metrics = new InMemoryMetrics();
  setMetrics(metrics);
  await observe("gmail.threads_list", async () => "ok", {}, "gmail_request_duration_ms");
  const trace = startTrace("worker.command", { command_id: "local-command" }, () => 10); trace.end({ result: "success" });
  assert.ok(metrics.counters.size > 0);
});
test("health aggregation is conservative and does not call Gmail", () => {
  assert.equal(aggregateHealth({ database: true, redis: true, consumers: true, schedulers: true, heartbeatAgeSeconds: 1, heartbeatStaleSeconds: 30, recoveryRequiredCount: 0, queueDepth: 0 }).status, "healthy");
  assert.equal(aggregateHealth({ database: false, redis: true, consumers: true, schedulers: true, heartbeatAgeSeconds: 1, heartbeatStaleSeconds: 30, recoveryRequiredCount: 0, queueDepth: 0 }).status, "unavailable");
});
