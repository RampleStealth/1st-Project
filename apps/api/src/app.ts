import { randomUUID } from "node:crypto";
import { metrics } from "@aio/observability";
import Fastify, { LogController, type FastifyBaseLogger } from "fastify";
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
import { registerDraftRoutes } from "./routes/drafts.js";
import { registerWritePermissionRoutes } from "./routes/permissions.js";
import { authenticatedUser } from "./route-helpers/session.js";
import { allowAllRateLimiter, policyForRoute, type RateLimiter } from "./rate-limit.js";
import { applySecurityHeaders, declaredContentLength, hasAllowedContentType, isBrowserMutationRequest, requiresEmptyBody, trustedOrigin } from "./security-policy.js";

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
  insertProviderCommand: (input: { mailboxId: string; commandType: "archive_thread" | "mark_thread_unread"; encryptedPayload: string; fingerprint: string; idempotencyKey: string; correlationId?: string }) => Promise<{ id: string; commandType: string; status: string }>;
  createDraftWithCommand: (input: any) => Promise<{ id: string; commandType: string; status: string; draftId: string }>;
  updateDraftWithCommand: (input: any) => Promise<{ id: string; commandType: string; status: string; draftId: string }>;
  sendDraftWithCommand: (input: any) => Promise<{ id: string; commandType: string; status: string; draftId: string }>;
  findDraftForUser: (mailboxId: string, draftId: string, userId: string) => Promise<any | null>;
  findSendRecoveryCommandForUser: (mailboxId: string, draftId: string, userId: string) => Promise<{ id: string; status: string } | null>;
  enqueueSendDraftVerification: (commandId: string) => Promise<unknown>;
  isIdempotencyConflictError: (error: unknown) => boolean;
  isDraftRevisionConflictError: (error: unknown) => boolean;
  isDraftStateConflictError: (error: unknown) => boolean;
  isActiveDraftCommandError: (error: unknown) => boolean;
  rateLimiter?: RateLimiter;
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
    createDraftWithCommand,
    updateDraftWithCommand,
    sendDraftWithCommand,
    findDraftForUser,
    findSendRecoveryCommandForUser,
    enqueueSendDraftVerification,
    isIdempotencyConflictError,
    isDraftRevisionConflictError,
    isDraftStateConflictError,
    isActiveDraftCommandError
  } = dependencies;
  const rateLimiter = dependencies.rateLimiter ?? allowAllRateLimiter;
  // Fastify's default request logs include the complete URL, which can contain OAuth code/state values.
  // Application logging is deliberately explicit and safe instead.
  const app = Fastify({ loggerInstance: logger, logController: new LogController({ disableRequestLogging: true }), trustProxy: config.TRUST_PROXY, bodyLimit: config.API_BODY_LIMIT_BYTES, routerOptions: { maxParamLength: 1_024 } });

  await app.register(cookie, { secret: config.SESSION_SECRET_PREVIOUS ? [config.SESSION_SECRET, config.SESSION_SECRET_PREVIOUS] : config.SESSION_SECRET, hook: "onRequest" });
  await app.register(cors, { origin: config.APP_ORIGIN, credentials: true, methods: ["GET", "POST", "PUT", "DELETE"] });

  app.addHook("onRequest", async (request, reply) => {
    const suppliedCorrelationId = request.headers["x-correlation-id"];
    request.headers["x-correlation-id"] = typeof suppliedCorrelationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedCorrelationId) ? suppliedCorrelationId : randomUUID();
    (request as any).telemetryStartedAt = Date.now();
    const declared = declaredContentLength(request);
    const route = request.routeOptions.url ?? request.url.split("?")[0];
    const bodyLimit = route === "/v1/webhooks/gmail" ? config.WEBHOOK_BODY_LIMIT_BYTES : config.API_BODY_LIMIT_BYTES;
    if (declared === -1 || (declared !== null && declared > bodyLimit)) return reply.code(413).send({ code: "request_too_large" });
    if (!hasAllowedContentType(request)) return reply.code(415).send({ code: "unsupported_content_type" });
    if (requiresEmptyBody(request) && declared !== null && declared > 0) return reply.code(400).send({ code: "unexpected_request_body" });
    if (isBrowserMutationRequest(request) && !trustedOrigin(request.headers.origin, config)) return reply.code(403).send({ code: "origin_forbidden" });
  });
  app.addHook("preHandler", async (request, reply) => {
    const policy = policyForRoute(request.method, request.routeOptions.url ?? request.url.split("?")[0]);
    if (!policy) return;
    const user = request.cookies.aio_session ? await authenticatedUser(request, pool) : null;
    const mailboxId = (request.params as { mailboxId?: string }).mailboxId;
    const dimensions: Array<["ip" | "user" | "mailbox", string | undefined]> = [
      ["ip", request.ip], ["user", user?.id], ["mailbox", mailboxId]
    ];
    for (const [dimension, identifier] of dimensions) {
      if (!identifier || !policy.dimensions.includes(dimension)) continue;
      const decision = await rateLimiter.consume({ ...policy, dimension, identifier });
      if (!decision.allowed) {
        reply.header("retry-after", String(decision.retryAfterSeconds));
        return reply.code(429).send({ code: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds });
      }
    }
  });
  app.addHook("onSend", async (_request, reply, payload) => { applySecurityHeaders(reply, config); return payload; });
  app.addHook("onResponse", async (request, reply) => {
    const duration = Math.max(0, Date.now() - Number((request as any).telemetryStartedAt ?? Date.now()));
    const route = request.routeOptions.url ?? "unmatched";
    metrics().counter("api_requests_total", 1, { method: request.method, route, status: reply.statusCode });
    metrics().histogram("api_request_duration_ms", duration, { method: request.method, route, status: reply.statusCode });
  });
  registerHealthRoutes(app, { config, pool, redis });
  registerMailboxWorkspaceRoutes(app, { config, pool, withTransaction, sanitizedThreadCache, findMailboxForUser });
  registerProviderCommandRoutes(app, { pool });
  registerThreadMutationRoutes(app, { config, pool, findMailboxForUser, insertProviderCommand, isIdempotencyConflictError });
  registerDraftRoutes(app, { config, pool, findMailboxForUser, createDraftWithCommand, updateDraftWithCommand, sendDraftWithCommand, findDraftForUser, findSendRecoveryCommandForUser, enqueueSendDraftVerification, isIdempotencyConflictError, isDraftRevisionConflictError, isDraftStateConflictError, isActiveDraftCommandError });
  registerWritePermissionRoutes(app, { config, pool, redis, withTransaction, findMailboxForUser });
  registerMailboxLifecycleRoutes(app, { config, pool, withTransaction });
  registerAuthRoutes(app, { config, pool });
  registerGoogleAuthRoutes(app, { config, pool, redis, withTransaction, ensureMailboxSyncState, enqueueSync });
  registerGmailWebhookRoutes(app, { config, pool, pubsubVerifier, recordPendingHistory, enqueueSync });

  return app;
}
