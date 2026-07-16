import assert from "node:assert/strict";
import test from "node:test";
import { startWorker, type WorkerBootstrapDependencies } from "./bootstrap.js";
import type { AppConfig } from "@aio/config";
import { stopWorkerRuntime, type WorkerRuntimeDependencies } from "./worker-runtime.js";

const config = { WORKER_RELEASE: "test", WORKER_SHUTDOWN_DRAIN_MS: 1_000, WORKER_HEARTBEAT_INTERVAL_SECONDS: 30, WORKER_OUTBOX_INTERVAL_SECONDS: 5, WORKER_LEASE_RECOVERY_INTERVAL_SECONDS: 30, WORKER_WATCH_RENEWAL_INTERVAL_SECONDS: 60, WORKER_RECONCILIATION_INTERVAL_SECONDS: 60, WORKER_ORPHAN_SCAN_INTERVAL_SECONDS: 60, WORKER_OUTBOX_BATCH_LIMIT: 10, WORKER_RECONCILIATION_BATCH_LIMIT: 10, WORKER_ORPHAN_BATCH_LIMIT: 10 } as AppConfig;

function fakeDependencies(events: string[]): WorkerRuntimeDependencies {
  const consumer = { pause: async () => {}, close: async () => {}, isRunning: () => true };
  return { logger: { info: () => {}, warn: () => {}, error: () => {} }, services: { processSync: async () => {}, processCommand: async () => {}, dispatchCommandOutbox: async () => {}, recoverExpiredCommandLeases: async () => {}, renewWatches: async () => {}, scheduleReconciliation: async () => {}, repairInconsistentDraftStates: async () => [], recordWorkerStarted: async () => { events.push("heartbeat-start"); }, recordWorkerHeartbeat: async () => {}, markWorkerDraining: async () => {}, markWorkerStopped: async () => {}, checkDatabase: async () => {}, getDatabaseDiagnostics: async () => ({}), getQueueDiagnostics: async () => ({}) }, createSyncConsumer: () => consumer, createCommandConsumer: () => consumer, redis: { ping: async () => {}, quit: async () => { events.push("redis-close"); } }, closeQueues: async () => { events.push("queues-close"); }, ownsDatabasePool: false };
}

test("bootstrap starts only when invoked and installs production signal handlers after startup", async () => {
  const events: string[] = []; const signals: string[] = []; const handlers = new Map<string, () => void>();
  const overrides: Partial<WorkerBootstrapDependencies> = {
    loadEnvironment: () => { events.push("env"); }, loadConfig: () => { events.push("config"); return config; },
    createProductionWorkerDependencies: async () => { events.push("dependencies"); return fakeDependencies(events); },
    process: { once: (signal: string, handler: () => void) => { signals.push(signal); handlers.set(signal, handler); return process; }, exit: (() => undefined) as never }
  };
  const runtime = await startWorker(overrides);
  assert.deepEqual(events.slice(0, 3), ["env", "config", "dependencies"]); assert.deepEqual(signals, ["SIGINT", "SIGTERM"]);
  handlers.get("SIGTERM")?.(); await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.includes("queues-close"));
  await stopWorkerRuntime(runtime);
});
