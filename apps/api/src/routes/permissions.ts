import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import type { AppConfig } from "@aio/config";
import type { MailboxAccount } from "@aio/database";
import { exchangeWriteUpgradeCode, isGmailProviderError, sanitizeGmailProviderError, writeUpgradeAuthorizationUrl } from "@aio/gmail";
import { encryptSecret } from "@aio/security";
import { challenge, correlationId, requireCsrf } from "../route-helpers/security.js";
import { authenticatedUser } from "../route-helpers/session.js";

type Deps = {
  config: AppConfig;
  pool: Pool;
  redis: Redis;
  withTransaction: <T>(fn: (client: any) => Promise<T>) => Promise<T>;
  findMailboxForUser: (mailboxAccountId: string, userId: string) => Promise<MailboxAccount | null>;
};

export function registerWritePermissionRoutes(
  app: FastifyInstance<any, any, any, any>,
  { config, pool, redis, withTransaction, findMailboxForUser }: Deps
) {
  app.post<{ Params: { mailboxId: string } }>("/v1/mailboxes/:mailboxId/permissions/write/start", async (request, reply) => {
    const user = await authenticatedUser(request, pool);
    if (!user) return reply.code(401).send({ code: "unauthenticated", message: "Sign in to request Gmail write permission." });
    if (!requireCsrf(request)) return reply.code(403).send({ code: "csrf_failed", message: "Refresh the page and try again." });
    const mailbox = await findMailboxForUser(request.params.mailboxId, user.id);
    if (!mailbox) return reply.code(404).send({ code: "mailbox_not_found", message: "Mailbox connection not found." });
    if (mailbox.status !== "active") return reply.code(409).send({ code: "provider_reauthentication_required", message: "Reconnect Gmail before changing permissions.", retryable: false });
    let state = ""; const verifier = randomBytes(64).toString("base64url"); const attemptId = randomUUID(); let stored = false;
    for (let attempt = 0; attempt < 3 && !stored; attempt++) { state = randomBytes(32).toString("base64url"); stored = (await redis.set(`write-oauth:${state}`, JSON.stringify({ userId: user.id, mailboxId: mailbox.id, capability: "gmail_write", verifier, attemptId }), "EX", 600, "NX")) === "OK"; }
    if (!stored) return reply.code(503).send({ code: "permission_state_unavailable", message: "We could not start permission setup. Try again shortly.", retryable: true });
    await withTransaction(async (client) => { await client.query("INSERT INTO mailbox_permission_state(mailbox_account_id,write_capability,upgrade_attempt_id,upgrade_expires_at,updated_at) VALUES($1,'upgrade_pending',$2,now()+interval '10 minutes',now()) ON CONFLICT(mailbox_account_id) DO UPDATE SET write_capability=CASE WHEN mailbox_permission_state.write_capability='write_granted' THEN 'write_granted' ELSE 'upgrade_pending' END,upgrade_attempt_id=CASE WHEN mailbox_permission_state.write_capability='write_granted' THEN mailbox_permission_state.upgrade_attempt_id ELSE EXCLUDED.upgrade_attempt_id END,upgrade_expires_at=CASE WHEN mailbox_permission_state.write_capability='write_granted' THEN NULL ELSE EXCLUDED.upgrade_expires_at END,updated_at=now()", [mailbox.id, attemptId]); await client.query("INSERT INTO audit_events(actor_type,actor_id,event_type,object_type,object_id,correlation_id,metadata) VALUES('user',$1,'gmail.write_permission_requested','mailbox_account',$2,$3,$4)", [user.id, mailbox.id, correlationId(request), JSON.stringify({ attemptId })]); });
    return { authorizationUrl: writeUpgradeAuthorizationUrl(config, state, challenge(verifier)) };
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/v1/auth/google/write/callback", async (request, reply) => {
    const user = await authenticatedUser(request, pool); const { code, state, error } = request.query;
    if (!state) return reply.redirect(`${config.APP_ORIGIN}/?permission=expired`);
    const stored = await redis.getdel(`write-oauth:${state}`);
    if (!stored) return reply.redirect(`${config.APP_ORIGIN}/?permission=expired`);
    let flow: { userId: string; mailboxId: string; capability: string; verifier: string; attemptId: string };
    try { flow = JSON.parse(stored); } catch { return reply.redirect(`${config.APP_ORIGIN}/?permission=expired`); }
    const closeAttempt = async (next: "read_only" | "upgrade_declined" | "upgrade_failed", event: string, reason: string) => { await withTransaction(async (client) => { const changed = await client.query("UPDATE mailbox_permission_state SET write_capability=$3,upgrade_expires_at=NULL,updated_at=now() WHERE mailbox_account_id=$1 AND write_capability='upgrade_pending' AND upgrade_attempt_id=$2 RETURNING mailbox_account_id", [flow.mailboxId, flow.attemptId, next]); if (changed.rowCount) await client.query("INSERT INTO audit_events(actor_type,event_type,object_type,object_id,correlation_id,metadata) VALUES('system',$1,'mailbox_account',$2,$3,$4)", [event, flow.mailboxId, correlationId(request), JSON.stringify({ attemptId: flow.attemptId, reason })]); }); };
    if (!user || flow.userId !== user.id || flow.capability !== "gmail_write" || !code && !error) { await closeAttempt("read_only", "gmail.write_permission_expired", "invalid_or_session_mismatch"); return reply.redirect(`${config.APP_ORIGIN}/?permission=expired`); }
    const mailbox = await findMailboxForUser(flow.mailboxId, user.id);
    if (!mailbox) return reply.redirect(`${config.APP_ORIGIN}/?permission=mismatch`);
    if (error) { await closeAttempt("upgrade_declined", "gmail.write_permission_declined", "consent_denied"); return reply.redirect(`${config.APP_ORIGIN}/?permission=declined`); }
    try {
      const { tokens, profile } = await exchangeWriteUpgradeCode(config, code!, flow.verifier);
      const scopes = tokens.scope?.split(" ").filter(Boolean) ?? [];
      if (profile.emailAddress?.toLowerCase() !== mailbox.email_address.toLowerCase()) { await closeAttempt("upgrade_failed", "gmail.write_permission_failed", "account_mismatch"); return reply.redirect(`${config.APP_ORIGIN}/?permission=mismatch`); }
      if (!scopes.includes("https://www.googleapis.com/auth/gmail.modify") || !tokens.refresh_token) { await closeAttempt("upgrade_failed", "gmail.write_permission_failed", !tokens.refresh_token ? "missing_refresh_token" : "missing_modify_scope"); return reply.redirect(`${config.APP_ORIGIN}/?permission=failed`); }
      await withTransaction(async (client) => { const changed = await client.query("UPDATE mailbox_permission_state SET write_capability='write_granted',granted_scopes=$3,upgrade_expires_at=NULL,updated_at=now() WHERE mailbox_account_id=$1 AND write_capability='upgrade_pending' AND upgrade_attempt_id=$2 RETURNING mailbox_account_id", [mailbox.id, flow.attemptId, scopes]); if (!changed.rowCount) return; await client.query("UPDATE mailbox_accounts SET encrypted_refresh_token=$2,granted_scopes=$3 WHERE id=$1", [mailbox.id, encryptSecret(tokens.refresh_token!, config.TOKEN_ENCRYPTION_KEY_BASE64), scopes]); await client.query("INSERT INTO audit_events(actor_type,actor_id,event_type,object_type,object_id,correlation_id,metadata) VALUES('user',$1,'gmail.write_permission_granted','mailbox_account',$2,$3,$4)", [user.id, mailbox.id, correlationId(request), JSON.stringify({ attemptId: flow.attemptId })]); });
      return reply.redirect(`${config.APP_ORIGIN}/?permission=success`);
    } catch (cause) { if (isGmailProviderError(cause)) request.log.warn(sanitizeGmailProviderError(cause, { operation: "gmail_write_upgrade", mailboxId: mailbox.id, correlationId: correlationId(request) }), "gmail write upgrade failed"); else request.log.error({ mailboxId: mailbox.id, correlationId: correlationId(request), errorCode: "write_upgrade_failed" }, "gmail write upgrade failed"); await closeAttempt("upgrade_failed", "gmail.write_permission_failed", "provider_or_transaction_failure"); return reply.redirect(`${config.APP_ORIGIN}/?permission=failed`); }
  });
}
