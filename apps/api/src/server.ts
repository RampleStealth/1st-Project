import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { Redis } from "ioredis";
import { OAuth2Client } from "google-auth-library";
import { loadConfig } from "@aio/config";
import { pool, withTransaction } from "@aio/database";
import { ensureMailboxSyncState, recordPendingHistory } from "@aio/database/repositories/mailbox-sync";
import { authorizationUrl, exchangeCode, gmailForMailbox, stopWatch, watchMailbox } from "@aio/gmail";
import { enqueueSync } from "@aio/jobs";
import { logger } from "@aio/observability";
import { encryptSecret } from "@aio/security";
import { gmailNotificationSchema } from "@aio/contracts";

const config = loadConfig();
const redis = new Redis(config.REDIS_URL);
const app = Fastify({ loggerInstance: logger, trustProxy: config.NODE_ENV === "production" });
const pubsubVerifier = new OAuth2Client();
await app.register(cookie, { secret: config.SESSION_SECRET, hook: "onRequest" });
await app.register(cors, { origin: config.APP_ORIGIN, credentials: true, methods: ["GET", "POST", "DELETE"] });

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function challenge(verifier: string) { return createHash("sha256").update(verifier).digest("base64url"); }
function cookieOptions() { return { httpOnly: true, secure: config.NODE_ENV === "production", sameSite: "lax" as const, path: "/", signed: true }; }
function correlationId(request: FastifyRequest) { return String(request.headers["x-correlation-id"]); }
async function authenticatedUser(request: FastifyRequest) {
  const signed = request.unsignCookie(request.cookies.aio_session ?? "");
  if (!signed.valid || !signed.value) return null;
  const result = await pool.query<{ id: string }>("SELECT user_id AS id FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()", [hash(signed.value)]);
  return result.rows[0] ?? null;
}
function requireCsrf(request: FastifyRequest) {
  const expected = request.cookies.aio_csrf;
  const actual = request.headers["x-csrf-token"];
  return Boolean(expected && typeof actual === "string" && expected === actual);
}

app.addHook("onRequest", async (request) => { request.headers["x-correlation-id"] ??= randomUUID(); });
app.get("/health", async () => ({ status: "ok" }));

app.get("/v1/mailboxes", async (request, reply) => {
  const user = await authenticatedUser(request);
  if (!user) return reply.code(401).send({ code: "unauthenticated", message: "Sign in to manage your connection." });
  const result = await pool.query("SELECT id,email_address,status,last_synced_at,last_sync_error,watch_expires_at,created_at FROM mailbox_accounts WHERE user_id=$1 AND status <> 'disconnected' ORDER BY created_at DESC", [user.id]);
  return result.rows;
});

app.delete<{ Params: { mailboxId: string } }>("/v1/mailboxes/:mailboxId", async (request, reply) => {
  const user = await authenticatedUser(request);
  if (!user) return reply.code(401).send({ code: "unauthenticated", message: "Sign in to manage your connection." });
  if (!requireCsrf(request)) return reply.code(403).send({ code: "csrf_failed", message: "Refresh the page and try again." });
  const account = await pool.query<{ id: string; encrypted_refresh_token: string }>("SELECT id,encrypted_refresh_token FROM mailbox_accounts WHERE id=$1 AND user_id=$2 AND status <> 'disconnected'", [request.params.mailboxId, user.id]);
  if (!account.rowCount) return reply.code(404).send({ code: "mailbox_not_found", message: "Mailbox connection not found." });
  try { await stopWatch(gmailForMailbox(config, account.rows[0].encrypted_refresh_token)); } catch (error) { request.log.warn({ err: error }, "gmail watch stop failed during disconnect"); }
  await withTransaction(async (client) => {
    await client.query("UPDATE mailbox_accounts SET status='disconnected',disconnected_at=now(),encrypted_refresh_token='' WHERE id=$1", [account.rows[0].id]);
    await client.query("INSERT INTO audit_events(actor_type,actor_id,event_type,object_type,object_id,correlation_id) VALUES('user',$1,'gmail.disconnected','mailbox_account',$2,$3)", [user.id, account.rows[0].id, correlationId(request)]);
  });
  return reply.code(204).send();
});

app.post("/v1/auth/logout", async (request, reply) => {
  const user = await authenticatedUser(request);
  if (!user) return reply.code(204).clearCookie("aio_session", cookieOptions()).clearCookie("aio_csrf", { path: "/" }).send();
  if (!requireCsrf(request)) return reply.code(403).send({ code: "csrf_failed", message: "Refresh the page and try again." });
  const signed = request.unsignCookie(request.cookies.aio_session ?? "");
  await pool.query("UPDATE sessions SET revoked_at=now() WHERE token_hash=$1", [hash(signed.value!)]);
  return reply.code(204).clearCookie("aio_session", cookieOptions()).clearCookie("aio_csrf", { path: "/" }).send();
});

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
      request.log.warn({ err: watchError, mailboxId: mailbox.id }, "gmail watch setup delayed");
      await pool.query("UPDATE mailbox_accounts SET last_sync_error='watch_setup_failed' WHERE id=$1", [mailbox.id]);
    }
    await enqueueSync({ mailboxAccountId: mailbox.id, reason: "initial" });
    reply.setCookie("aio_session", sessionToken, { ...cookieOptions(), expires: expiresAt });
    reply.setCookie("aio_csrf", randomBytes(32).toString("base64url"), { httpOnly: false, secure: config.NODE_ENV === "production", sameSite: "lax", path: "/", expires: expiresAt });
    return reply.redirect(`${config.APP_ORIGIN}/connect/complete${syncDelayed ? "?sync=delayed" : ""}`);
  } catch (cause) {
    request.log.error({ err: cause }, "gmail connection failed");
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
  } catch (cause) { request.log.warn({ err: cause }, "rejected gmail notification"); return reply.code(401).send(); }
});

app.listen({ host: "0.0.0.0", port: config.PORT }).catch((error) => { logger.fatal({ err: error }, "api startup failed"); process.exit(1); });
