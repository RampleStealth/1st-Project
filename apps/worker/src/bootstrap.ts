import dotenv from "dotenv";
import { loadConfig } from "@aio/config";
import { createProductionWorkerDependencies } from "./dependencies.js";
import { createWorkerRuntime, startWorkerRuntime, stopWorkerRuntime, type WorkerRuntime, type WorkerRuntimeDependencies } from "./worker-runtime.js";

export type WorkerBootstrapDependencies = {
  loadEnvironment: () => void;
  loadConfig: typeof loadConfig;
  createProductionWorkerDependencies: typeof createProductionWorkerDependencies;
  process: { once: (signal: "SIGINT" | "SIGTERM", handler: () => void) => unknown; exit: (code?: number) => never };
};

const productionBootstrapDependencies: WorkerBootstrapDependencies = {
  loadEnvironment: () => { dotenv.config({ path: "../../.env" }); }, loadConfig, createProductionWorkerDependencies, process
};

function installSignalHandlers(runtime: WorkerRuntime, runtimeProcess: WorkerBootstrapDependencies["process"]) {
  const shutdown = () => { void stopWorkerRuntime(runtime).then(() => runtimeProcess.exit(0), () => runtimeProcess.exit(1)); };
  runtimeProcess.once("SIGINT", shutdown); runtimeProcess.once("SIGTERM", shutdown);
}

export async function startWorker(overrides: Partial<WorkerBootstrapDependencies> = {}): Promise<WorkerRuntime> {
  const dependencies = { ...productionBootstrapDependencies, ...overrides };
  dependencies.loadEnvironment();
  const config = dependencies.loadConfig();
  let runtime: WorkerRuntime | undefined;
  let productionDependencies: WorkerRuntimeDependencies | undefined;
  try {
    productionDependencies = await dependencies.createProductionWorkerDependencies(config);
    runtime = createWorkerRuntime(productionDependencies, {
      workerId: config.WORKER_ID, release: config.WORKER_RELEASE ?? "unknown", shutdownDrainMs: config.WORKER_SHUTDOWN_DRAIN_MS ?? 30_000,
      heartbeatIntervalMs: (config.WORKER_HEARTBEAT_INTERVAL_SECONDS ?? 30) * 1_000, outboxIntervalMs: (config.WORKER_OUTBOX_INTERVAL_SECONDS ?? 5) * 1_000,
      leaseRecoveryIntervalMs: (config.WORKER_LEASE_RECOVERY_INTERVAL_SECONDS ?? 30) * 1_000, watchRenewalIntervalMs: (config.WORKER_WATCH_RENEWAL_INTERVAL_SECONDS ?? 43_200) * 1_000,
      reconciliationIntervalMs: (config.WORKER_RECONCILIATION_INTERVAL_SECONDS ?? 60) * 1_000, orphanScanIntervalMs: (config.WORKER_ORPHAN_SCAN_INTERVAL_SECONDS ?? 60) * 1_000,
      outboxBatchLimit: config.WORKER_OUTBOX_BATCH_LIMIT ?? 20, reconciliationBatchLimit: config.WORKER_RECONCILIATION_BATCH_LIMIT ?? 100, orphanBatchLimit: config.WORKER_ORPHAN_BATCH_LIMIT ?? 100
    });
    await startWorkerRuntime(runtime); installSignalHandlers(runtime, dependencies.process); return runtime;
  } catch (error) {
    productionDependencies?.logger.error({ errorCode: "worker_startup_failed", error: error instanceof Error ? error.message : "unknown" }, "worker startup failed");
    if (runtime) await stopWorkerRuntime(runtime).catch(() => undefined);
    else if (productionDependencies) { await productionDependencies.closeQueues().catch(() => undefined); await productionDependencies.redis.quit().catch(() => undefined); if (productionDependencies.ownsDatabasePool) await productionDependencies.closeDatabasePool?.().catch(() => undefined); }
    dependencies.process.exit(1); throw error;
  }
}
