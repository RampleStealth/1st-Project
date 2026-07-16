import type { AppConfig } from "@aio/config";
import type { ApiAppDependencies } from "./app.js";

/** Creates every production-only API dependency after configuration has been loaded. */
export async function createProductionApiDependencies(config: AppConfig): Promise<ApiAppDependencies> {
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
    config,
    logger,
    pool,
    redis: new Redis(config.REDIS_URL),
    pubsubVerifier: new OAuth2Client(),
    sanitizedThreadCache: new SanitizedThreadCache(),
    withTransaction,
    findMailboxForUser,
    ensureMailboxSyncState,
    recordPendingHistory,
    enqueueSync
  };
}
