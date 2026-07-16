import type { AppConfig } from "@aio/config";
import type { ApiAppDependencies } from "./app.js";

export type ProductionDependencyFactories = {
  createRedis: (url: string) => ApiAppDependencies["redis"];
  createPubsubVerifier: () => ApiAppDependencies["pubsubVerifier"];
  createSanitizedThreadCache: () => ApiAppDependencies["sanitizedThreadCache"];
  logger: ApiAppDependencies["logger"];
  pool: ApiAppDependencies["pool"];
  withTransaction: ApiAppDependencies["withTransaction"];
  findMailboxForUser: ApiAppDependencies["findMailboxForUser"];
  ensureMailboxSyncState: ApiAppDependencies["ensureMailboxSyncState"];
  recordPendingHistory: ApiAppDependencies["recordPendingHistory"];
  enqueueSync: ApiAppDependencies["enqueueSync"];
};

export type ProductionDependencyFactoryLoader = () => Promise<ProductionDependencyFactories>;

async function loadProductionDependencyFactories(): Promise<ProductionDependencyFactories> {
  const [
    { Redis },
    { OAuth2Client },
    { pool, withTransaction },
    { findMailboxForUser },
    { ensureMailboxSyncState, recordPendingHistory },
    { SanitizedThreadCache },
    { enqueueSync },
    { logger }
  ] = await Promise.all([
    import("ioredis"),
    import("google-auth-library"),
    import("@aio/database"),
    import("@aio/database/repositories/mailbox-account"),
    import("@aio/database/repositories/mailbox-sync"),
    import("@aio/gmail"),
    import("@aio/jobs"),
    import("@aio/observability")
  ]);

  return {
    createRedis: (url) => new Redis(url),
    createPubsubVerifier: () => new OAuth2Client(),
    createSanitizedThreadCache: () => new SanitizedThreadCache(),
    logger,
    pool,
    withTransaction,
    findMailboxForUser,
    ensureMailboxSyncState,
    recordPendingHistory,
    enqueueSync
  };
}

/** Creates every production-only API dependency after configuration has been loaded. */
export async function createProductionApiDependencies(config: AppConfig, loadFactories: ProductionDependencyFactoryLoader = loadProductionDependencyFactories): Promise<ApiAppDependencies> {
  const factories = await loadFactories();
  let redis: ApiAppDependencies["redis"] | undefined;
  try {
    redis = factories.createRedis(config.REDIS_URL);
    return {
      config,
      logger: factories.logger,
      pool: factories.pool,
      redis,
      pubsubVerifier: factories.createPubsubVerifier(),
      sanitizedThreadCache: factories.createSanitizedThreadCache(),
      withTransaction: factories.withTransaction,
      findMailboxForUser: factories.findMailboxForUser,
      ensureMailboxSyncState: factories.ensureMailboxSyncState,
      recordPendingHistory: factories.recordPendingHistory,
      enqueueSync: factories.enqueueSync
    };
  } catch (error) {
    if (redis) {
      try {
        await redis.quit();
      } catch {
        // Preserve the original dependency-construction failure.
      }
    }
    throw error;
  }
}
