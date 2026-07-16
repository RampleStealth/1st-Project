import type { AppConfig } from "@aio/config";
import type { WorkerRuntimeDependencies, WorkerConsumer } from "./worker-runtime.js";

export type ProductionWorkerFactories = {
  createRedis: (url: string) => WorkerRuntimeDependencies["redis"];
  createSyncConsumer: (config: AppConfig, processor: (job: any) => Promise<void>) => WorkerConsumer;
  createCommandConsumer: (config: AppConfig, processor: (job: any) => Promise<void>) => WorkerConsumer;
  createWorkerServices: (config: AppConfig) => WorkerRuntimeDependencies["services"];
  closeQueues: () => Promise<void>;
  closeDatabasePool: () => Promise<void>;
  logger: WorkerRuntimeDependencies["logger"];
  metrics: NonNullable<WorkerRuntimeDependencies["metrics"]>;
  isGmailProviderError: (error: unknown) => boolean;
  sanitizeGmailProviderError: (error: unknown, context: { operation: string; jobId?: string; mailboxId?: string }) => Record<string, unknown>;
  isMailboxLeaseUnavailable: (error: unknown) => boolean;
};

export type ProductionWorkerFactoryLoader = () => Promise<ProductionWorkerFactories>;

async function loadProductionWorkerFactories(): Promise<ProductionWorkerFactories> {
  const [{ Redis }, { Worker }, { createWorkerServices, closeQueues, logger, pool, MailboxLeaseUnavailable }, { isGmailProviderError, sanitizeGmailProviderError }, { metrics }] = await Promise.all([
    import("ioredis"), import("bullmq"), import("./worker-services.js"), import("@aio/gmail"), import("@aio/observability")
  ]);
  return {
    createRedis: (url) => new Redis(url),
    createSyncConsumer: (config, processor) => {
      const worker = new Worker("gmail-sync", async (job) => processor(job.data), { connection: { url: config.REDIS_URL, maxRetriesPerRequest: null }, concurrency: config.SYNC_WORKER_CONCURRENCY ?? 10, limiter: { max: 25, duration: 1_000 } });
      worker.on("failed", (job, error) => {
        if (error instanceof MailboxLeaseUnavailable) logger.info({ jobId: job?.id, errorCode: "mailbox_lease_unavailable" }, "sync job deferred while mailbox lease is active");
        else if (isGmailProviderError(error)) logger.error(sanitizeGmailProviderError(error, { operation: "gmail_sync", jobId: job?.id?.toString(), mailboxId: job?.data.mailboxAccountId }), "gmail sync job failed");
        else logger.error({ jobId: job?.id, errorCode: "sync_job_failed", error: error instanceof Error ? error.message : "unknown" }, "sync job failed");
      });
      return { pause: (doNotWaitActive) => worker.pause(doNotWaitActive), close: (force) => worker.close(force), isRunning: () => worker.isRunning() };
    },
    createCommandConsumer: (config, processor) => {
      const worker = new Worker("gmail-commands", async (job) => processor({ name: job.name, data: job.data }), { connection: { url: config.REDIS_URL, maxRetriesPerRequest: null }, concurrency: config.COMMAND_WORKER_CONCURRENCY ?? 1 });
      return { pause: (doNotWaitActive) => worker.pause(doNotWaitActive), close: (force) => worker.close(force), isRunning: () => worker.isRunning() };
    },
    createWorkerServices, closeQueues, closeDatabasePool: () => pool.end(), logger,
    isGmailProviderError, sanitizeGmailProviderError, isMailboxLeaseUnavailable: (error) => error instanceof MailboxLeaseUnavailable, metrics: metrics()
  };
}

/** Creates process-owned clients only when this function is called. Importing this module is side-effect free. */
export async function createProductionWorkerDependencies(config: AppConfig, loadFactories: ProductionWorkerFactoryLoader = loadProductionWorkerFactories): Promise<WorkerRuntimeDependencies> {
  const factories = await loadFactories();
  let redis: WorkerRuntimeDependencies["redis"] | undefined;
  try {
    redis = factories.createRedis(config.REDIS_URL);
    const services = factories.createWorkerServices(config);
    return {
      logger: factories.logger, services, redis, metrics: factories.metrics,
      createSyncConsumer: (processor) => factories.createSyncConsumer(config, processor),
      createCommandConsumer: (processor) => factories.createCommandConsumer(config, processor),
      closeQueues: factories.closeQueues, closeDatabasePool: factories.closeDatabasePool, ownsDatabasePool: true
    };
  } catch (error) {
    await redis?.quit().catch(() => undefined);
    throw error;
  }
}
