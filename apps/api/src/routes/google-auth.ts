import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "@aio/config";
import type { SyncJob } from "@aio/contracts";
import { authorizationUrl, exchangeCode, gmailForMailbox, isGmailProviderError, sanitizeGmailProviderError, watchMailbox } from "@aio/gmail";
import { encryptSecret } from "@aio/security";
import { challenge, cookieOptions, correlationId, hash } from "../route-helpers/security.js";

type Deps = {
  config: AppConfig;
  pool: Pool;
  redis: Redis;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  ensureMailboxSyncState: (mailboxAccountId: string) => Promise<unknown>;
  enqueueSync: (job: SyncJob) => Promise<unknown>;
};

export function registerGoogleAuthRoutes(
  app: FastifyInstance<any, any, any, any>,
  { config, pool, redis, withTransaction, ensureMailboxSyncState, enqueueSync }: Deps
) {
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
}
