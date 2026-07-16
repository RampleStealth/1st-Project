import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import type { AppConfig } from "@aio/config";
import type { MailboxAccount } from "@aio/database";
import type { SanitizedThreadCache } from "@aio/gmail";
import type { SyncJob } from "@aio/contracts";
import type { OAuth2Client } from "google-auth-library";
import type { Redis } from "ioredis";
import type { Pool, PoolClient } from "pg";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerGmailWebhookRoutes } from "./routes/gmail-webhook.js";
import { registerGoogleAuthRoutes } from "./routes/google-auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMailboxLifecycleRoutes } from "./routes/mailbox-lifecycle.js";
import { registerMailboxWorkspaceRoutes } from "./routes/mailbox-workspace.js";
import { registerProviderCommandRoutes } from "./routes/provider-commands.js";
import { registerThreadMutationRoutes } from "./routes/thread-mutations.js";
import { registerWritePermissionRoutes } from "./routes/permissions.js";

export type ApiAppDependencies = {
  config: AppConfig;
  logger: FastifyBaseLogger;
  pool: Pool;
  redis: Redis;
  pubsubVerifier: OAuth2Client;
  sanitizedThreadCache: SanitizedThreadCache;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  findMailboxForUser: (mailboxAccountId: string, userId: string) => Promise<MailboxAccount | null>;
  ensureMailboxSyncState: (mailboxAccountId: string) => Promise<unknown>;
  recordPendingHistory: (mailboxAccountId: string, historyId: string) => Promise<void>;
  enqueueSync: (job: SyncJob) => Promise<unknown>;
  insertProviderCommand: (input: { mailboxId: string; commandType: "archive_thread" | "mark_thread_unread"; encryptedPayload: string; fingerprint: string; idempotencyKey: string }) => Promise<{ id: string; commandType: string; status: string }>;
  isIdempotencyConflictError: (error: unknown) => boolean;
};

export async function createApiApp(dependencies: ApiAppDependencies) {
  const {
    config,
    logger,
    pool,
    redis,
    pubsubVerifier,
    sanitizedThreadCache,
    withTransaction,
    findMailboxForUser,
    ensureMailboxSyncState,
    recordPendingHistory,
    enqueueSync,
    insertProviderCommand,
    isIdempotencyConflictError
  } = dependencies;
  const app = Fastify({ loggerInstance: logger, trustProxy: config.NODE_ENV === "production" });

  await app.register(cookie, { secret: config.SESSION_SECRET, hook: "onRequest" });
  await app.register(cors, { origin: config.APP_ORIGIN, credentials: true, methods: ["GET", "POST", "DELETE"] });

  app.addHook("onRequest", async (request) => { request.headers["x-correlation-id"] ??= randomUUID(); });
  registerHealthRoutes(app);
  registerMailboxWorkspaceRoutes(app, { config, pool, withTransaction, sanitizedThreadCache, findMailboxForUser });
  registerProviderCommandRoutes(app, { pool });
  registerThreadMutationRoutes(app, { config, pool, findMailboxForUser, insertProviderCommand, isIdempotencyConflictError });
  registerWritePermissionRoutes(app, { config, pool, redis, withTransaction, findMailboxForUser });
  registerMailboxLifecycleRoutes(app, { config, pool, withTransaction });
  registerAuthRoutes(app, { config, pool });
  registerGoogleAuthRoutes(app, { config, pool, redis, withTransaction, ensureMailboxSyncState, enqueueSync });
  registerGmailWebhookRoutes(app, { config, pool, pubsubVerifier, recordPendingHistory, enqueueSync });

  return app;
}
