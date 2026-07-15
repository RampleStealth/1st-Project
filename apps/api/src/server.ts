import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { Redis } from "ioredis";
import { OAuth2Client } from "google-auth-library";
import { loadConfig } from "@aio/config";
import { pool, withTransaction } from "@aio/database";
import { ensureMailboxSyncState, recordPendingHistory } from "@aio/database/repositories/mailbox-sync";
import { authorizationUrl, exchangeCode, gmailForMailbox, isGmailProviderError, SanitizedThreadCache, sanitizeGmailProviderError, stopWatch, watchMailbox } from "@aio/gmail";
import { enqueueSync } from "@aio/jobs";
import { logger } from "@aio/observability";
import { encryptSecret } from "@aio/security";
import { gmailNotificationSchema } from "@aio/contracts";
import { challenge, cookieOptions, correlationId, hash } from "./route-helpers/security.js";
import { authenticatedUser } from "./route-helpers/session.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMailboxLifecycleRoutes } from "./routes/mailbox-lifecycle.js";
import { registerProviderCommandRoutes } from "./routes/provider-commands.js";
import { registerMailboxWorkspaceRoutes } from "./routes/mailbox-workspace.js";
import { registerWritePermissionRoutes } from "./routes/permissions.js";

const config = loadConfig();
const redis = new Redis(config.REDIS_URL);
const app = Fastify({ loggerInstance: logger, trustProxy: config.NODE_ENV === "production" });
const sanitizedThreadCache = new SanitizedThreadCache();
const pubsubVerifier = new OAuth2Client();
await app.register(cookie, { secret: config.SESSION_SECRET, hook: "onRequest" });
await app.register(cors, { origin: config.APP_ORIGIN, credentials: true, methods: ["GET", "POST", "DELETE"] });


app.addHook("onRequest", async (request) => { request.headers["x-correlation-id"] ??= randomUUID(); });
registerHealthRoutes(app);

registerMailboxWorkspaceRoutes(app,{config,pool,withTransaction,sanitizedThreadCache});
registerProviderCommandRoutes(app,{pool});
registerWritePermissionRoutes(app,{config,pool,redis,withTransaction});

registerMailboxLifecycleRoutes(app,{config,pool,withTransaction});

registerAuthRoutes(app, { config, pool });

app.post("/v1/auth/google/start", async (_request, reply) => {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(64).toString("base64url");
  await redis.set(`oauth:${state}`, JSON.stringify({ verifier, createdAt: Date.now() }), "EX", 600, "NX");
  return reply.redirect(authorizationUrl(config, state, challenge(verifier)));
});

app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/v1/auth/google/callback", async (request, reply) => {
  const { code, state, error } = request.query;
  if (error || !code || !state) return reply.code(400).send({ code: "oauth_denied", message: "Gmail connection was not completed." });
  const stored = await redis.getdel(`oauth:${state}`);
  if (!stored) return reply.code(400).send({ code: "invalid_oauth_state", message: "The connection request expired. Please try again." });
  try {
    const { verifier } = JSON.parse(stored) as { verifier: string };
    const { tokens, profile } = await exchangeCode(config, code, verifier);
    if (!profile.emailAddress || !profile.historyId || !tokens.refresh_token) throw new Error("Incomplete Gmail profile");
    const email = profile.emailAddress.toLowerCase();
    const refreshToken = tokens.refresh_token;
    const sessionToken = randomBytes(48).toString("base64url");
    const expiresAt = new Date(Date.now() + 1_209_600_000);
    const mailbox = await withTransaction(async (client) => {
      const user = await client.query<{ id: string }>("INSERT INTO users(email_normalized) VALUES($1) ON CONFLICT(email_normalized) DO UPDATE SET deleted_at = NULL RETURNING id", [email]);
      const account = await client.query<{ id: string; encrypted_refresh_token: string }>(
        `INSERT INTO mailbox_accounts(user_id, provider, provider_account_id, email_address, encrypted_refresh_token, granted_scopes)
         VALUES($1, 'gmail', $2, $3, $4, $5)
         ON CONFLICT(provider, provider_account_id) DO UPDATE SET encrypted_refresh_token = EXCLUDED.encrypted_refresh_token, granted_scopes = EXCLUDED.granted_scopes, status = 'active', disconnected_at = NULL
         RETURNING id, encrypted_refresh_token`,
        [user.rows[0].id, email, email, encryptSecret(refreshToken, config.TOKEN_ENCRYPTION_KEY_BASE64), tokens.scope?.split(" ") ?? []]
      );
      await client.query("INSERT INTO sessions(user_id, token_hash, expires_at) VALUES($1, $2, $3)", [user.rows[0].id, hash(sessionToken), expiresAt]);
      await client.query("INSERT INTO audit_events(actor_type, actor_id, event_type, object_type, object_id, correlation_id) VALUES('user',$1,'gmail.connected','mailbox_account',$2,$3)", [user.rows[0].id, account.rows[0].id, correlationId(request)]);
      return account.rows[0];
    });
    await ensureMailboxSyncState(mailbox.id);
    let syncDelayed = false;
    try {
      const watch = await watchMailbox(gmailForMailbox(config, mailbox.encrypted_refresh_token), config.GOOGLE_PUBSUB_TOPIC);
      await pool.query("UPDATE mailbox_accounts SET watch_expires_at=$2,last_sync_error=NULL WHERE id=$1", [mailbox.id, watch.expiration ? new Date(Number(watch.expiration)) : null]);
    } catch (watchError) {
      syncDelayed = true;
      if (isGmailProviderError(watchError)) request.log.warn(sanitizeGmailProviderError(watchError, { operation: "gmail_watch_setup", mailboxId: mailbox.id, correlationId: correlationId(request) }), "gmail watch setup delayed");
      else request.log.warn({ err: watchError, mailboxId: mailbox.id }, "gmail watch setup delayed");
      await pool.query("UPDATE mailbox_accounts SET last_sync_error='watch_setup_failed' WHERE id=$1", [mailbox.id]);
    }
    await enqueueSync({ mailboxAccountId: mailbox.id, reason: "initial" });
    reply.setCookie("aio_session", sessionToken, { ...cookieOptions(config), expires: expiresAt });
    reply.setCookie("aio_csrf", randomBytes(32).toString("base64url"), { httpOnly: false, secure: config.NODE_ENV === "production", sameSite: "lax", path: "/", expires: expiresAt });
    return reply.redirect(`${config.APP_ORIGIN}/connect/complete${syncDelayed ? "?sync=delayed" : ""}`);
  } catch (cause) {
    if (isGmailProviderError(cause)) request.log.error(sanitizeGmailProviderError(cause, { operation: "gmail_oauth_connection", correlationId: correlationId(request) }), "gmail connection failed");
    else request.log.error({ err: cause }, "gmail connection failed");
    return reply.code(502).send({ code: "gmail_connection_failed", message: "We could not connect Gmail. Your account was not changed." });
  }
});

app.post("/v1/webhooks/gmail", async (request, reply) => {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return reply.code(401).send();
  try {
    const ticket = await pubsubVerifier.verifyIdToken({ idToken: authorization.slice(7), audience: config.PUBSUB_PUSH_AUDIENCE });
    const claims = ticket.getPayload();
    if (!claims?.email_verified || claims.email !== config.PUBSUB_SERVICE_ACCOUNT_EMAIL) return reply.code(401).send();
    const body = request.body as { message?: { data?: string } };
    if (!body.message?.data) return reply.code(400).send();
    const notification = gmailNotificationSchema.parse(JSON.parse(Buffer.from(body.message.data, "base64url").toString("utf8")));
    const account = await pool.query<{ id: string }>("SELECT id FROM mailbox_accounts WHERE lower(email_address)=lower($1) AND status='active'", [notification.emailAddress]);
    if (account.rowCount) {
      await recordPendingHistory(account.rows[0].id, notification.historyId);
      await enqueueSync({ mailboxAccountId: account.rows[0].id, requestedHistoryId: notification.historyId, reason: "notification" });
    }
    return reply.code(204).send();
  } catch { request.log.warn({ correlationId: correlationId(request) }, "rejected gmail notification"); return reply.code(401).send(); }
});

app.listen({ host: "0.0.0.0", port: config.PORT }).catch((error) => { logger.fatal({ err: error }, "api startup failed"); process.exit(1); });
