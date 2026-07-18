import type { AppConfig } from "@aio/config";
import type { MailboxSearchCriteria } from "@aio/contracts";
import type { MailboxAccount } from "@aio/database";
import type { ApiAppDependencies } from "./app.js";
import { createRedisRateLimiter } from "./rate-limit.js";

export type ProductionDependencyFactories = {
  createRedis: (url: string) => ApiAppDependencies["redis"];
  createPubsubVerifier: () => ApiAppDependencies["pubsubVerifier"];
  createSanitizedThreadCache: () => ApiAppDependencies["sanitizedThreadCache"];
  logger: ApiAppDependencies["logger"];
  pool: ApiAppDependencies["pool"];
  withTransaction: ApiAppDependencies["withTransaction"];
  findMailboxForUser: ApiAppDependencies["findMailboxForUser"];
  searchMailboxThreads: (config: AppConfig, mailbox: MailboxAccount, criteria: MailboxSearchCriteria, pageToken: string | undefined, limit: number) => ReturnType<ApiAppDependencies["searchMailboxThreads"]>;
  ensureMailboxSyncState: ApiAppDependencies["ensureMailboxSyncState"];
  recordPendingHistory: ApiAppDependencies["recordPendingHistory"];
  enqueueSync: ApiAppDependencies["enqueueSync"];
  insertProviderCommand: ApiAppDependencies["insertProviderCommand"];
  createDraftWithCommand: ApiAppDependencies["createDraftWithCommand"];
  updateDraftWithCommand: ApiAppDependencies["updateDraftWithCommand"];
  sendDraftWithCommand: ApiAppDependencies["sendDraftWithCommand"];
  findDraftForUser: ApiAppDependencies["findDraftForUser"];
  findDraftEditEligibilityForUser: ApiAppDependencies["findDraftEditEligibilityForUser"];
  findSendRecoveryCommandForUser: ApiAppDependencies["findSendRecoveryCommandForUser"];
  enqueueSendDraftVerification: ApiAppDependencies["enqueueSendDraftVerification"];
  isIdempotencyConflictError: ApiAppDependencies["isIdempotencyConflictError"];
  isDraftRevisionConflictError: ApiAppDependencies["isDraftRevisionConflictError"];
  isDraftStateConflictError: ApiAppDependencies["isDraftStateConflictError"];
  isActiveDraftCommandError: ApiAppDependencies["isActiveDraftCommandError"];
  verifySchemaCompatibility: () => Promise<string | null>;
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
    { createDraftWithCommand, updateDraftWithCommand, sendDraftWithCommand, findDraftForUser, findDraftEditEligibilityForUser, findSendRecoveryCommandForUser, DraftRevisionConflictError, DraftStateConflictError, ActiveDraftCommandError },
    { SanitizedThreadCache, gmailForMailbox, hydrateThreadMetadata, searchThreads },
    { enqueueSync, enqueueSendDraftVerification },
    { logger },
    { verifySchemaCompatibility }
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
    import("@aio/observability"),
    import("@aio/database/migrations")
  ]);

  return {
    createRedis: (url) => new Redis(url),
    createPubsubVerifier: () => new OAuth2Client(),
    createSanitizedThreadCache: () => new SanitizedThreadCache(),
    logger,
    pool,
    withTransaction,
    findMailboxForUser,
    searchMailboxThreads: async (config, mailbox, criteria, pageToken, limit) => {
      const gmail = gmailForMailbox(config, mailbox.encrypted_refresh_token);
      const page = await searchThreads(gmail, criteria, pageToken, limit);
      return { threads: await hydrateThreadMetadata(gmail, page.threadIds, 5), nextPageToken: page.nextPageToken };
    },
    ensureMailboxSyncState,
    recordPendingHistory,
    enqueueSync,
    insertProviderCommand,
    createDraftWithCommand,
    updateDraftWithCommand,
    sendDraftWithCommand,
    findDraftForUser,
    findDraftEditEligibilityForUser,
    findSendRecoveryCommandForUser,
    enqueueSendDraftVerification,
    isIdempotencyConflictError: (error) => error instanceof IdempotencyConflictError,
    isDraftRevisionConflictError: (error) => error instanceof DraftRevisionConflictError,
    isDraftStateConflictError: (error) => error instanceof DraftStateConflictError,
    isActiveDraftCommandError: (error) => error instanceof ActiveDraftCommandError,
    verifySchemaCompatibility: () => verifySchemaCompatibility(pool)
  };
}

/** Creates every production-only API dependency after configuration has been loaded. */
export async function createProductionApiDependencies(config: AppConfig, loadFactories: ProductionDependencyFactoryLoader = loadProductionDependencyFactories): Promise<ApiAppDependencies> {
  const factories = await loadFactories();
  let redis: ApiAppDependencies["redis"] | undefined;
  try {
    await factories.verifySchemaCompatibility();
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
      searchMailboxThreads: (mailbox, criteria, pageToken, limit) => factories.searchMailboxThreads(config, mailbox, criteria, pageToken, limit),
      ensureMailboxSyncState: factories.ensureMailboxSyncState,
      recordPendingHistory: factories.recordPendingHistory,
      enqueueSync: factories.enqueueSync,
      insertProviderCommand: factories.insertProviderCommand,
      createDraftWithCommand: factories.createDraftWithCommand,
      updateDraftWithCommand: factories.updateDraftWithCommand,
      sendDraftWithCommand: factories.sendDraftWithCommand,
      findDraftForUser: factories.findDraftForUser,
      findDraftEditEligibilityForUser: factories.findDraftEditEligibilityForUser,
      findSendRecoveryCommandForUser: factories.findSendRecoveryCommandForUser,
      enqueueSendDraftVerification: factories.enqueueSendDraftVerification,
      isIdempotencyConflictError: factories.isIdempotencyConflictError,
      isDraftRevisionConflictError: factories.isDraftRevisionConflictError,
      isDraftStateConflictError: factories.isDraftStateConflictError,
      isActiveDraftCommandError: factories.isActiveDraftCommandError,
      rateLimiter: createRedisRateLimiter(redis, config.RATE_LIMIT_FAILURE_MODE ?? (config.NODE_ENV === "production" ? "fail_closed" : "fail_open"))
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
