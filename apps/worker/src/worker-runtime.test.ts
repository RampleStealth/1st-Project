import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerRuntime, getWorkerDiagnostics, getWorkerReadiness, startWorkerRuntime, stopWorkerRuntime, type WorkerConsumer, type WorkerRuntimeDependencies } from "./worker-runtime.js";

function createFixture() {
  const events: string[] = [];
  const makeConsumer = (name: string): WorkerConsumer => ({
    pause: async () => { events.push(`${name}:pause`); }, close: async (force) => { events.push(`${name}:close:${Boolean(force)}`); }, isRunning: () => true
  });
  const dependencies: WorkerRuntimeDependencies = {
    logger: { info: (_c, m) => events.push(`info:${m}`), warn: (_c, m) => events.push(`warn:${m}`), error: (_c, m) => events.push(`error:${m}`) },
    services: {
      processSync: async () => { events.push("sync"); }, processCommand: async () => { events.push("command"); }, dispatchCommandOutbox: async () => { events.push("outbox"); },
      recoverExpiredCommandLeases: async () => { events.push("leases"); }, renewWatches: async () => { events.push("watch"); }, scheduleReconciliation: async () => { events.push("reconcile"); }, repairInconsistentDraftStates: async () => [],
      recordWorkerStarted: async () => { events.push("started"); }, recordWorkerHeartbeat: async () => { events.push("heartbeat"); }, markWorkerDraining: async () => { events.push("draining"); }, markWorkerStopped: async () => { events.push("stopped"); },
      checkDatabase: async () => { events.push("database"); }, getDatabaseDiagnostics: async () => ({ unpublishedOutboxCount: 0 }), getQueueDiagnostics: async () => ({ sync: { waiting: 0 }, commands: { waiting: 0 } })
    },
    createSyncConsumer: () => { events.push("sync-consumer"); return makeConsumer("sync"); }, createCommandConsumer: () => { events.push("command-consumer"); return makeConsumer("command"); },
    redis: { ping: async () => { events.push("redis-ping"); }, quit: async () => { events.push("redis-quit"); } }, closeQueues: async () => { events.push("queues-close"); }, closeDatabasePool: async () => { events.push("database-close"); }, ownsDatabasePool: true
  };
  const runtime = createWorkerRuntime(dependencies, { workerId: "11111111-1111-4111-8111-111111111111", release: "test", shutdownDrainMs: 1, heartbeatIntervalMs: 100_000, outboxIntervalMs: 100_000, leaseRecoveryIntervalMs: 100_000, watchRenewalIntervalMs: 100_000, reconciliationIntervalMs: 100_000, orphanScanIntervalMs: 100_000, outboxBatchLimit: 10, reconciliationBatchLimit: 10, orphanBatchLimit: 10 });
  return { events, runtime };
}

test("creating a runtime is import-safe and starts no consumers or timers", () => {
  const { events, runtime } = createFixture();
  assert.equal(runtime.status, "created"); assert.deepEqual(events, []);
});

test("runtime starts consumers, persists heartbeat, and exposes safe readiness", async () => {
  const { events, runtime } = createFixture();
  await startWorkerRuntime(runtime);
  assert.deepEqual(events.slice(0, 4), ["started", "sync-consumer", "command-consumer", "heartbeat"]);
  assert.deepEqual(await getWorkerReadiness(runtime), { ready: true });
  const diagnostics = await getWorkerDiagnostics(runtime);
  assert.equal(diagnostics.live, true); assert.equal(diagnostics.readiness.ready, true); assert.equal(diagnostics.queues.sync.waiting, 0);
  await stopWorkerRuntime(runtime);
});

test("shutdown is idempotent, drains consumers, then closes owned resources", async () => {
  const { events, runtime } = createFixture(); await startWorkerRuntime(runtime);
  await Promise.all([stopWorkerRuntime(runtime), stopWorkerRuntime(runtime)]);
  assert.equal(events.filter((event) => event === "sync:pause").length, 1);
  assert.ok(events.indexOf("stopped") < events.indexOf("queues-close"));
  assert.ok(events.indexOf("queues-close") < events.indexOf("redis-quit"));
  assert.ok(events.indexOf("redis-quit") < events.indexOf("database-close"));
});

test("startup failure closes resources already created", async () => {
  const { events, runtime } = createFixture();
  runtime.dependencies.createCommandConsumer = () => { throw new Error("command consumer failed"); };
  await assert.rejects(() => startWorkerRuntime(runtime));
  assert.ok(events.includes("sync:close:false")); assert.ok(events.includes("redis-quit")); assert.equal(runtime.status, "stopped");
});

test("heartbeat failures are safe and a scheduler never overlaps itself", async () => {
  const { events, runtime } = createFixture();
  const ticks: Array<() => void> = [];
  runtime.options.setInterval = ((callback: () => void) => { ticks.push(callback); return { unref() {} }; }) as typeof setInterval;
  runtime.options.clearInterval = (() => undefined) as typeof clearInterval;
  let resolveOutbox!: () => void; let outboxCalls = 0; let heartbeatCalls = 0;
  runtime.dependencies.services.dispatchCommandOutbox = () => { outboxCalls += 1; return new Promise<void>((resolve) => { resolveOutbox = resolve; }); };
  runtime.dependencies.services.recordWorkerHeartbeat = async () => { heartbeatCalls += 1; if (heartbeatCalls > 1) throw new Error("database unavailable"); };
  await startWorkerRuntime(runtime);
  const outboxTick = ticks[0]; const heartbeatTick = ticks[5];
  outboxTick(); outboxTick(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outboxCalls, 1);
  resolveOutbox(); await new Promise((resolve) => setImmediate(resolve));
  heartbeatTick(); await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.startsWith("error:worker scheduled task failed")));
  await stopWorkerRuntime(runtime);
});
