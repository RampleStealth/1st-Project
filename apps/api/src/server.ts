import { Redis } from "ioredis";
import { OAuth2Client } from "google-auth-library";
import { loadConfig } from "@aio/config";
import { pool, withTransaction } from "@aio/database";
import { findMailboxForUser } from "@aio/database/repositories/mailbox-account";
import { ensureMailboxSyncState, recordPendingHistory } from "@aio/database/repositories/mailbox-sync";
import { SanitizedThreadCache } from "@aio/gmail";
import { enqueueSync } from "@aio/jobs";
import { logger } from "@aio/observability";
import { createApiApp } from "./app.js";

const config = loadConfig();
const redis = new Redis(config.REDIS_URL);
const sanitizedThreadCache = new SanitizedThreadCache();
const pubsubVerifier = new OAuth2Client();
const app = await createApiApp({ config, logger, pool, redis, pubsubVerifier, sanitizedThreadCache, withTransaction, findMailboxForUser, ensureMailboxSyncState, recordPendingHistory, enqueueSync });

app.listen({ host: "0.0.0.0", port: config.PORT }).catch((error) => { logger.fatal({ err: error }, "api startup failed"); process.exit(1); });
