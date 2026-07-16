import { randomUUID } from "node:crypto";
import type { SyncJob } from "@aio/contracts";
import { aggregateHealth, type Metrics } from "@aio/observability";

export type WorkerLogger = {
  info: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
  error: (context: Record<string, unknown>, message: string) => void;
};

export type WorkerConsumer = {
  pause: (doNotWaitActive?: boolean) => Promise<void>;
  close: (force?: boolean) => Promise<void>;
  isRunning: () => boolean;
};

export type SchedulerName = "outbox" | "leaseRecovery" | "watchRenewal" | "reconciliation" | "orphanRepair" | "heartbeat";
export type SchedulerSnapshot = { running: boolean; lastStartedAt: Date | null; lastCompletedAt: Date | null; lastFailedAt: Date | null };

export type WorkerRuntimeServices = {
  processSync: (job: SyncJob) => Promise<void>;
  processCommand: (job: { name: string; data: { commandId: string; correlationId?: string } }) => Promise<void>;
  dispatchCommandOutbox: (limit: number) => Promise<void>;
  recoverExpiredCommandLeases: () => Promise<void>;
  renewWatches: () => Promise<void>;
  scheduleReconciliation: (limit: number) => Promise<void>;
  repairInconsistentDraftStates: (limit: number) => Promise<string[]>;
  recordWorkerStarted: (input: { workerId: string; release: string }) => Promise<void>;
  recordWorkerHeartbeat: (input: { workerId: string; syncRunning: boolean; commandRunning: boolean }) => Promise<void>;
  markWorkerDraining: (workerId: string) => Promise<void>;
  markWorkerStopped: (workerId: string) => Promise<void>;
  checkDatabase: () => Promise<void>;
  getDatabaseDiagnostics: () => Promise<Record<string, number | null>>;
  getQueueDiagnostics: () => Promise<Record<string, Record<string, number | null>>>;
};

export type WorkerRuntimeDependencies = {
  logger: WorkerLogger;
  metrics?: Metrics;
  services: WorkerRuntimeServices;
  createSyncConsumer: (processor: (job: SyncJob) => Promise<void>) => WorkerConsumer;
  createCommandConsumer: (processor: (job: { name: string; data: { commandId: string; correlationId?: string } }) => Promise<void>) => WorkerConsumer;
  redis: { ping: () => Promise<unknown>; quit: () => Promise<unknown> };
  closeQueues: () => Promise<void>;
  closeDatabasePool?: () => Promise<void>;
  ownsDatabasePool: boolean;
};

export type WorkerRuntimeOptions = {
  workerId?: string;
  release: string;
  shutdownDrainMs: number;
  heartbeatIntervalMs: number;
  outboxIntervalMs: number;
  leaseRecoveryIntervalMs: number;
  watchRenewalIntervalMs: number;
  reconciliationIntervalMs: number;
  orphanScanIntervalMs: number;
  outboxBatchLimit: number;
  reconciliationBatchLimit: number;
  orphanBatchLimit: number;
  now?: () => Date;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

type RuntimeStatus = "created" | "starting" | "running" | "draining" | "stopped";
type Scheduler = SchedulerSnapshot & { handle?: ReturnType<typeof setInterval> };

export type WorkerRuntime = {
  dependencies: WorkerRuntimeDependencies;
  options: Required<Omit<WorkerRuntimeOptions, "workerId">> & { workerId: string };
  status: RuntimeStatus;
  syncConsumer?: WorkerConsumer;
  commandConsumer?: WorkerConsumer;
  schedulers: Record<SchedulerName, Scheduler>;
  startedAt?: Date;
  heartbeatLastSuccessAt?: Date;
  shutdownPromise?: Promise<void>;
};

const schedulerNames: SchedulerName[] = ["outbox", "leaseRecovery", "watchRenewal", "reconciliation", "orphanRepair", "heartbeat"];

export function createWorkerRuntime(dependencies: WorkerRuntimeDependencies, options: WorkerRuntimeOptions): WorkerRuntime {
  const now = options.now ?? (() => new Date());
  const schedulers = Object.fromEntries(schedulerNames.map((name) => [name, { running: false, lastStartedAt: null, lastCompletedAt: null, lastFailedAt: null }])) as Record<SchedulerName, Scheduler>;
  return {
    dependencies,
    options: {
      workerId: options.workerId ?? randomUUID(), release: options.release, shutdownDrainMs: options.shutdownDrainMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs, outboxIntervalMs: options.outboxIntervalMs,
      leaseRecoveryIntervalMs: options.leaseRecoveryIntervalMs, watchRenewalIntervalMs: options.watchRenewalIntervalMs,
      reconciliationIntervalMs: options.reconciliationIntervalMs, orphanScanIntervalMs: options.orphanScanIntervalMs,
      outboxBatchLimit: options.outboxBatchLimit, reconciliationBatchLimit: options.reconciliationBatchLimit,
      orphanBatchLimit: options.orphanBatchLimit, now, setInterval: options.setInterval ?? setInterval, clearInterval: options.clearInterval ?? clearInterval
    },
    status: "created", schedulers
  };
}

function logScheduledFailure(runtime: WorkerRuntime, scheduler: SchedulerName, error: unknown) {
  runtime.dependencies.logger.error({ workerId: runtime.options.workerId, scheduler, errorCode: "worker_scheduled_task_failed", error: error instanceof Error ? error.message : "unknown" }, "worker scheduled task failed");
}

function startScheduler(runtime: WorkerRuntime, name: SchedulerName, intervalMs: number, task: () => Promise<void>, runImmediately: boolean) {
  const scheduler = runtime.schedulers[name];
  const run = async () => {
    if (runtime.status !== "running" || scheduler.running) { if (scheduler.running) runtime.dependencies.metrics?.counter("scheduler_runs_total", 1, { scheduler: name, result: "skipped_overlap" }); return; }
    scheduler.running = true;
    scheduler.lastStartedAt = runtime.options.now();
    try { await task(); scheduler.lastCompletedAt = runtime.options.now(); runtime.dependencies.metrics?.counter("scheduler_runs_total", 1, { scheduler: name, result: "success" }); runtime.dependencies.metrics?.histogram("scheduler_duration_ms", scheduler.lastCompletedAt.getTime() - scheduler.lastStartedAt.getTime(), { scheduler: name, result: "success" }); }
    catch (error) { scheduler.lastFailedAt = runtime.options.now(); runtime.dependencies.metrics?.counter("scheduler_failures_total", 1, { scheduler: name }); logScheduledFailure(runtime, name, error); }
    finally { scheduler.running = false; }
  };
  scheduler.handle = runtime.options.setInterval(() => { void run(); }, intervalMs);
  scheduler.handle.unref?.();
  if (runImmediately) void run();
}

function stopSchedulers(runtime: WorkerRuntime) {
  for (const scheduler of Object.values(runtime.schedulers)) {
    if (scheduler.handle) runtime.options.clearInterval(scheduler.handle);
    scheduler.handle = undefined;
  }
}

async function heartbeat(runtime: WorkerRuntime) {
  const syncRunning = runtime.syncConsumer?.isRunning() ?? false;
  const commandRunning = runtime.commandConsumer?.isRunning() ?? false;
  await runtime.dependencies.services.recordWorkerHeartbeat({ workerId: runtime.options.workerId, syncRunning, commandRunning });
  runtime.heartbeatLastSuccessAt = runtime.options.now();
}

export async function startWorkerRuntime(runtime: WorkerRuntime): Promise<WorkerRuntime> {
  if (runtime.status === "running") return runtime;
  if (runtime.status !== "created") throw new Error("Worker runtime cannot be started after shutdown has begun");
  runtime.status = "starting";
  try {
    await runtime.dependencies.services.recordWorkerStarted({ workerId: runtime.options.workerId, release: runtime.options.release });
    runtime.syncConsumer = runtime.dependencies.createSyncConsumer(async (job) => {
      const startedAt = runtime.options.now().getTime();
      try { await runtime.dependencies.services.processSync(job); runtime.dependencies.metrics?.counter("worker_jobs_total", 1, { queue: "sync", result: "success" }); }
      catch (error) { runtime.dependencies.metrics?.counter("worker_jobs_total", 1, { queue: "sync", result: "failure" }); throw error; }
      finally { runtime.dependencies.metrics?.histogram("worker_job_duration_ms", runtime.options.now().getTime() - startedAt, { queue: "sync" }); }
    });
    runtime.commandConsumer = runtime.dependencies.createCommandConsumer(async (job) => {
      const startedAt = runtime.options.now().getTime();
      try { await runtime.dependencies.services.processCommand(job); runtime.dependencies.metrics?.counter("worker_jobs_total", 1, { queue: "commands", result: "success" }); }
      catch (error) { runtime.dependencies.metrics?.counter("worker_jobs_total", 1, { queue: "commands", result: "failure" }); throw error; }
      finally { runtime.dependencies.metrics?.histogram("worker_job_duration_ms", runtime.options.now().getTime() - startedAt, { queue: "commands" }); }
    });
    runtime.startedAt = runtime.options.now();
    runtime.status = "running";
    await heartbeat(runtime);
    startScheduler(runtime, "outbox", runtime.options.outboxIntervalMs, () => runtime.dependencies.services.dispatchCommandOutbox(runtime.options.outboxBatchLimit), false);
    startScheduler(runtime, "leaseRecovery", runtime.options.leaseRecoveryIntervalMs, () => runtime.dependencies.services.recoverExpiredCommandLeases(), false);
    startScheduler(runtime, "watchRenewal", runtime.options.watchRenewalIntervalMs, () => runtime.dependencies.services.renewWatches(), true);
    startScheduler(runtime, "reconciliation", runtime.options.reconciliationIntervalMs, () => runtime.dependencies.services.scheduleReconciliation(runtime.options.reconciliationBatchLimit), true);
    startScheduler(runtime, "orphanRepair", runtime.options.orphanScanIntervalMs, async () => { await runtime.dependencies.services.repairInconsistentDraftStates(runtime.options.orphanBatchLimit); }, false);
    startScheduler(runtime, "heartbeat", runtime.options.heartbeatIntervalMs, () => heartbeat(runtime), false);
    runtime.dependencies.logger.info({ workerId: runtime.options.workerId, release: runtime.options.release }, "worker runtime started");
    return runtime;
  } catch (error) {
    await stopWorkerRuntime(runtime).catch(() => undefined);
    throw error;
  }
}

async function waitForDrain(runtime: WorkerRuntime): Promise<void> {
  const consumers = [runtime.syncConsumer, runtime.commandConsumer].filter((consumer): consumer is WorkerConsumer => Boolean(consumer));
  await Promise.all(consumers.map((consumer) => consumer.pause(false)));
  const close = Promise.all(consumers.map((consumer) => consumer.close(false)));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let drained = false;
  try {
    await Promise.race([close.then(() => { drained = true; }), new Promise<void>((resolve) => { timeout = setTimeout(resolve, runtime.options.shutdownDrainMs); })]);
    if (timeout) clearTimeout(timeout);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (!drained) {
    runtime.dependencies.logger.warn({ workerId: runtime.options.workerId, errorCode: "worker_drain_timeout" }, "worker drain deadline elapsed; force-closing consumers while command leases protect uncertain work");
    await Promise.all(consumers.map((consumer) => consumer.close(true).catch(() => undefined)));
  }
}

export async function stopWorkerRuntime(runtime: WorkerRuntime): Promise<void> {
  if (runtime.shutdownPromise) return runtime.shutdownPromise;
  runtime.shutdownPromise = (async () => {
    if (runtime.status === "stopped") return;
    runtime.status = "draining";
    stopSchedulers(runtime);
    await runtime.dependencies.services.markWorkerDraining(runtime.options.workerId).catch((error) => logScheduledFailure(runtime, "heartbeat", error));
    const failures: unknown[] = [];
    for (const close of [
      () => waitForDrain(runtime),
      () => runtime.dependencies.services.markWorkerStopped(runtime.options.workerId),
      () => runtime.dependencies.closeQueues(),
      () => runtime.dependencies.redis.quit(),
      () => runtime.dependencies.ownsDatabasePool && runtime.dependencies.closeDatabasePool ? runtime.dependencies.closeDatabasePool() : Promise.resolve()
    ]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    runtime.status = "stopped";
    if (failures.length) throw new AggregateError(failures, "Worker shutdown completed with resource-close failures");
  })();
  return runtime.shutdownPromise;
}

export function getWorkerLiveness(runtime: WorkerRuntime) {
  return { live: runtime.status === "starting" || runtime.status === "running" || runtime.status === "draining", status: runtime.status, workerId: runtime.options.workerId };
}

export async function getWorkerReadiness(runtime: WorkerRuntime) {
  const schedulersActive = schedulerNames.every((name) => Boolean(runtime.schedulers[name].handle));
  if (runtime.status !== "running" || !runtime.syncConsumer?.isRunning() || !runtime.commandConsumer?.isRunning() || !schedulersActive) return { ready: false, reason: "worker_not_running" as const };
  try {
    const bounded = async <T>(promise: Promise<T>) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("readiness_check_timeout")), 1_000); timeout.unref?.(); })]);
      } finally { if (timeout) clearTimeout(timeout); }
    };
    await Promise.all([bounded(runtime.dependencies.services.checkDatabase()), bounded(runtime.dependencies.redis.ping())]);
    return { ready: true as const };
  } catch { return { ready: false as const, reason: "dependency_unavailable" as const }; }
}

export async function getWorkerDiagnostics(runtime: WorkerRuntime) {
  const [readiness, database, queues] = await Promise.all([getWorkerReadiness(runtime), runtime.dependencies.services.getDatabaseDiagnostics(), runtime.dependencies.services.getQueueDiagnostics()]);
  const heartbeatAgeSeconds = runtime.heartbeatLastSuccessAt ? Math.max(0, (runtime.options.now().getTime() - runtime.heartbeatLastSuccessAt.getTime()) / 1_000) : null;
  const consumers = { sync: runtime.syncConsumer?.isRunning() ?? false, commands: runtime.commandConsumer?.isRunning() ?? false };
  const schedulersActive = schedulerNames.every((name) => Boolean(runtime.schedulers[name].handle));
  const queueDepth = Object.values(queues).reduce((total, queue) => total + (queue.waiting ?? 0) + (queue.active ?? 0), 0);
  const health = aggregateHealth({ database: readiness.ready, redis: readiness.ready, consumers: consumers.sync && consumers.commands, schedulers: schedulersActive, heartbeatAgeSeconds, heartbeatStaleSeconds: runtime.options.heartbeatIntervalMs / 1_000 * 4, recoveryRequiredCount: database.recoveryRequiredCommandCount ?? 0, queueDepth });
  runtime.dependencies.metrics?.gauge("active_workers", runtime.status === "running" ? 1 : 0); runtime.dependencies.metrics?.gauge("heartbeat_age_seconds", heartbeatAgeSeconds ?? -1);
  runtime.dependencies.metrics?.gauge("queue_depth", queueDepth); runtime.dependencies.metrics?.gauge("recovery_required_count", database.recoveryRequiredCommandCount ?? 0); runtime.dependencies.metrics?.gauge("stale_commands", database.staleRunningCommandCount ?? 0); runtime.dependencies.metrics?.gauge("unpublished_outbox", database.unpublishedOutboxCount ?? 0);
  return { ...getWorkerLiveness(runtime), readiness, health, release: runtime.options.release, startedAt: runtime.startedAt ?? null, heartbeatLastSuccessAt: runtime.heartbeatLastSuccessAt ?? null, consumers, schedulers: runtime.schedulers, database, queues };
}
