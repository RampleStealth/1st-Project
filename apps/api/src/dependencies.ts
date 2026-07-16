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
  insertProviderCommand: ApiAppDependencies["insertProviderCommand"];
  createDraftWithCommand: ApiAppDependencies["createDraftWithCommand"];
  updateDraftWithCommand: ApiAppDependencies["updateDraftWithCommand"];
  sendDraftWithCommand: ApiAppDependencies["sendDraftWithCommand"];
  findDraftForUser: ApiAppDependencies["findDraftForUser"];
  findSendRecoveryCommandForUser: ApiAppDependencies["findSendRecoveryCommandForUser"];
  enqueueSendDraftVerification: ApiAppDependencies["enqueueSendDraftVerification"];
  isIdempotencyConflictError: ApiAppDependencies["isIdempotencyConflictError"];
  isDraftRevisionConflictError: ApiAppDependencies["isDraftRevisionConflictError"];
  isDraftStateConflictError: ApiAppDependencies["isDraftStateConflictError"];
  isActiveDraftCommandError: ApiAppDependencies["isActiveDraftCommandError"];
};

export type ProductionDependencyFactoryLoader = () => Promise<ProductionDependencyFactories>;

async function loadProductionDependencyFactories(): Promise<ProductionDependencyFactories> {
  const [
    { Redis },
    { OAuth2Client },
    { pool, withTransaction },
    { findMailboxForUser },
    { ensureMailboxSyncState, recordPendingHistory },
    { insertProviderCommand, IdempotencyConflictError },
    { createDraftWithCommand, updateDraftWithCommand, sendDraftWithCommand, findDraftForUser, findSendRecoveryCommandForUser, DraftRevisionConflictError, DraftStateConflictError, ActiveDraftCommandError },
    { SanitizedThreadCache },
    { enqueueSync, enqueueSendDraftVerification },
    { logger }
  ] = await Promise.all([
    import("ioredis"),
    import("google-auth-library"),
    import("@aio/database"),
    import("@aio/database/repositories/mailbox-account"),
    import("@aio/database/repositories/mailbox-sync"),
    import("@aio/database/repositories/provider-command"),
    import("@aio/database/repositories/draft"),
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
    enqueueSync,
    insertProviderCommand,
    createDraftWithCommand,
    updateDraftWithCommand,
    sendDraftWithCommand,
    findDraftForUser,
    findSendRecoveryCommandForUser,
    enqueueSendDraftVerification,
    isIdempotencyConflictError: (error) => error instanceof IdempotencyConflictError,
    isDraftRevisionConflictError: (error) => error instanceof DraftRevisionConflictError,
    isDraftStateConflictError: (error) => error instanceof DraftStateConflictError,
    isActiveDraftCommandError: (error) => error instanceof ActiveDraftCommandError
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
      enqueueSync: factories.enqueueSync,
      insertProviderCommand: factories.insertProviderCommand,
      createDraftWithCommand: factories.createDraftWithCommand,
      updateDraftWithCommand: factories.updateDraftWithCommand,
      sendDraftWithCommand: factories.sendDraftWithCommand,
      findDraftForUser: factories.findDraftForUser,
      findSendRecoveryCommandForUser: factories.findSendRecoveryCommandForUser,
      enqueueSendDraftVerification: factories.enqueueSendDraftVerification,
      isIdempotencyConflictError: factories.isIdempotencyConflictError,
      isDraftRevisionConflictError: factories.isDraftRevisionConflictError,
      isDraftStateConflictError: factories.isDraftStateConflictError,
      isActiveDraftCommandError: factories.isActiveDraftCommandError
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
