import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { Redis } from "ioredis";
import { OAuth2Client } from "google-auth-library";
import { loadConfig } from "@aio/config";
import { pool, withTransaction } from "@aio/database";
import { ensureMailboxSyncState, recordPendingHistory } from "@aio/database/repositories/mailbox-sync";
import { findMailboxForUser } from "@aio/database/repositories/mailbox-account";
import { upsertThreadProjection } from "@aio/database/repositories/thread-projection";
import { authorizationUrl, classifyGmailError, exchangeCode, exchangeWriteUpgradeCode, getThreadFull, gmailForMailbox, hydrateThreadMetadata, isGmailProviderError, listThreads, normalizeThreadDisplay, SanitizedThreadCache, sanitizeGmailProviderError, stopWatch, watchMailbox, writeUpgradeAuthorizationUrl } from "@aio/gmail";
import { enqueueSync } from "@aio/jobs";
import { logger } from "@aio/observability";
import { encryptSecret } from "@aio/security";
import { gmailNotificationSchema } from "@aio/contracts";
import { CursorError, decodeThreadCursor, encodeThreadCursor, threadListQuerySchema } from "./mailbox-list.js";
import { threadReadProviderFailure } from "./thread-read.js";
import { challenge, cookieOptions, correlationId, hash, requireCsrf } from "./route-helpers/security.js";
import { authenticatedUser } from "./route-helpers/session.js";

const config = loadConfig();
const redis = new Redis(config.REDIS_URL);
const app = Fastify({ loggerInstance: logger, trustProxy: config.NODE_ENV === "production" });
const sanitizedThreadCache = new SanitizedThreadCache();
const pubsubVerifier = new OAuth2Client();
await app.register(cookie, { secret: config.SESSION_SECRET, hook: "onRequest" });
await app.register(cors, { origin: config.APP_ORIGIN, credentials: true, methods: ["GET", "POST", "DELETE"] });


app.addHook("onRequest", async (request) => { request.headers["x-correlation-id"] ??= randomUUID(); });
app.get("/health", async () => ({ status: "ok" }));

app.get("/v1/mailboxes", async (request, reply) => {
  const user = await authenticatedUser(request, pool);
  if (!user) return reply.code(401).send({ code: "unauthenticated", message: "Sign in to manage your connection." });
  const result = await pool.query("SELECT m.id,m.email_address,m.status,m.last_synced_at,m.last_sync_error,m.watch_expires_at,m.created_at,COALESCE(p.write_capability,'read_only') AS write_capability FROM mailbox_accounts m LEFT JOIN mailbox_permission_state p ON p.mailbox_account_id=m.id WHERE m.user_id=$1 AND m.status <> 'disconnected' ORDER BY m.created_at DESC", [user.id]);
  return result.rows;
});

app.get<{ Params: { mailboxId: string }; Querystring: { view?: string; cursor?: string; limit?: string } }>("/v1/mailboxes/:mailboxId/threads", async (request, reply) => {
  const user = await authenticatedUser(request, pool);
  if (!user) return reply.code(401).send({ code: "unauthenticated", message: "Sign in to view your mailbox." });
  const query = threadListQuerySchema.safeParse(request.query);
  if (!query.success) return reply.code(400).send({ code: "invalid_thread_list_request", message: "Choose a valid mailbox view and page size." });
  const mailbox = await findMailboxForUser(request.params.mailboxId, user.id);
  if (!mailbox) return reply.code(404).send({ code: "mailbox_not_found", message: "Mailbox connection not found." });
  if (mailbox.status !== "active") return reply.code(409).send({ code: "provider_reauthentication_required", message: "Reconnect Gmail before loading your mailbox.", retryable: false });
  const context = { userId: user.id, mailboxId: mailbox.id, view: query.data.view, limit: query.data.limit };
  let providerPageToken: string | undefined;
  try {
    providerPageToken = query.data.cursor ? decodeThreadCursor(query.data.cursor, context, config.TOKEN_ENCRYPTION_KEY_BASE64) : undefined;
  } catch (error) {
    if (error instanceof CursorError) return reply.code(400).send({ code: "invalid_cursor", message: "This page link is no longer valid. Reload the mailbox view." });
    throw error;
  }
  let page: Awaited<ReturnType<typeof listThreads>>;
  let hydrated: Awaited<ReturnType<typeof hydrateThreadMetadata>>;
  try {
    const gmail = gmailForMailbox(config, mailbox.encrypted_refresh_token);
    page = await listThreads(gmail, query.data.view, providerPageToken, query.data.limit);
    hydrated = await hydrateThreadMetadata(gmail, page.threadIds, 5);
  } catch (error) {
    const failure = classifyGmailError(error, "resource");
    if (failure === "reauthorization_required") return reply.code(409).send({ code: "provider_reauthentication_required", message: "Reconnect Gmail before loading your mailbox.", retryable: false });
    if (failure === "rate_limited" || failure === "transient_provider_failure") return reply.code(503).send({ code: "provider_temporarily_unavailable", message: "Gmail is temporarily unavailable. Try again shortly.", retryable: true });
    return reply.code(502).send({ code: "provider_thread_list_failed", message: "We could not load this Gmail view.", retryable: true });
  }
  try {
    const items = await withTransaction(async (client) => {
      const projected = [];
      for (const thread of hydrated) projected.push(await upsertThreadProjection(client, mailbox.id, thread));
      return projected.filter((thread): thread is NonNullable<typeof thread> => Boolean(thread));
    });
    const nextCursor = page.nextPageToken ? encodeThreadCursor({ ...context, providerPageToken: page.nextPageToken, expiresAt: Date.now() + 15 * 60_000 }, config.TOKEN_ENCRYPTION_KEY_BASE64) : null;
    return { items, nextCursor, source: "gmail", fetchedAt: new Date() };
  } catch (error) {
    request.log.error({ err: error, mailboxId: mailbox.id }, "thread projection update failed");
    return reply.code(503).send({ code: "projection_temporarily_unavailable", message: "We loaded Gmail but could not prepare this mailbox view. Try again shortly.", retryable: true });
  }
});

app.get<{ Params: { mailboxId: string; threadId: string } }>("/v1/mailboxes/:mailboxId/threads/:threadId", async (request, reply) => {
  const user = await authenticatedUser(request, pool);
  if (!user) return reply.code(401).send({ code: "unauthenticated", message: "Sign in to read your mailbox." });
  // This lookup proves ownership before credentials are decrypted or Gmail is contacted.
  const mailbox = await findMailboxForUser(request.params.mailboxId, user.id);
  if (!mailbox) return reply.code(404).send({ code: "mailbox_not_found", message: "Mailbox connection not found." });
  if (mailbox.status !== "active") return reply.code(409).send({ code: "provider_reauthentication_required", message: "Reconnect Gmail before reading this conversation.", retryable: false });
  try {
    const providerThread = await getThreadFull(gmailForMailbox(config, mailbox.encrypted_refresh_token), request.params.threadId);
    const cacheKey = sanitizedThreadCache.key(mailbox.id, providerThread);
    const cached = sanitizedThreadCache.get(cacheKey);
    if (cached) return cached;
    const display = normalizeThreadDisplay(providerThread);
    sanitizedThreadCache.set(cacheKey, display);
    return display;
  } catch (error) {
    if (isGmailProviderError(error)) {
      request.log.warn(sanitizeGmailProviderError(error, { operation: "gmail_thread_read", mailboxId: mailbox.id, correlationId: correlationId(request) }), "gmail thread read failed");
      const failure = threadReadProviderFailure(error);
      return reply.code(failure.status).send(failure.body);
    }
    // MIME rendering errors carry no provider content into logs or responses.
    request.log.error({ mailboxId: mailbox.id, correlationId: correlationId(request), errorCode: "safe_rendering_failed" }, "safe thread rendering failed");
    return reply.code(422).send({ code: "safe_rendering_failed", message: "This conversation could not be rendered safely.", retryable: true });
  }
});
app.get<{ Params: { mailboxId: string; commandId: string } }>("/v1/mailboxes/:mailboxId/provider-commands/:commandId", async (request, reply) => {
  const user = await authenticatedUser(request, pool); if (!user) return reply.code(401).send({ code: "unauthenticated", message: "Sign in to view command status." });
  const result = await pool.query("SELECT c.id,c.command_type,c.status,c.attempt_count,c.next_attempt_at,c.failure_code,c.failure_detail,c.created_at,c.updated_at,c.completed_at FROM provider_commands c JOIN mailbox_accounts m ON m.id=c.mailbox_account_id WHERE c.id=$1 AND c.mailbox_account_id=$2 AND m.user_id=$3", [request.params.commandId, request.params.mailboxId, user.id]);
  if (!result.rowCount) return reply.code(404).send({ code: "provider_command_not_found", message: "Command not found." }); return result.rows[0];
});

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

app.delete<{ Params: { mailboxId: string } }>("/v1/mailboxes/:mailboxId", async (request, reply) => {
  const user = await authenticatedUser(request, pool);
  if (!user) return reply.code(401).send({ code: "unauthenticated", message: "Sign in to manage your connection." });
  if (!requireCsrf(request)) return reply.code(403).send({ code: "csrf_failed", message: "Refresh the page and try again." });
  const account = await pool.query<{ id: string; encrypted_refresh_token: string }>("SELECT id,encrypted_refresh_token FROM mailbox_accounts WHERE id=$1 AND user_id=$2 AND status <> 'disconnected'", [request.params.mailboxId, user.id]);
  if (!account.rowCount) return reply.code(404).send({ code: "mailbox_not_found", message: "Mailbox connection not found." });
  try { await stopWatch(gmailForMailbox(config, account.rows[0].encrypted_refresh_token)); } catch (error) {
    if (isGmailProviderError(error)) request.log.warn(sanitizeGmailProviderError(error, { operation: "gmail_watch_stop", mailboxId: account.rows[0].id, correlationId: correlationId(request) }), "gmail watch stop failed during disconnect");
    else request.log.warn({ err: error }, "gmail watch stop failed during disconnect");
  }
  await withTransaction(async (client) => {
    await client.query("UPDATE mailbox_accounts SET status='disconnected',disconnected_at=now(),encrypted_refresh_token='' WHERE id=$1", [account.rows[0].id]);
    await client.query("INSERT INTO audit_events(actor_type,actor_id,event_type,object_type,object_id,correlation_id) VALUES('user',$1,'gmail.disconnected','mailbox_account',$2,$3)", [user.id, account.rows[0].id, correlationId(request)]);
  });
  return reply.code(204).send();
});

app.post("/v1/auth/logout", async (request, reply) => {
  const user = await authenticatedUser(request, pool);
  if (!user) return reply.code(204).clearCookie("aio_session", cookieOptions(config)).clearCookie("aio_csrf", { path: "/" }).send();
  if (!requireCsrf(request)) return reply.code(403).send({ code: "csrf_failed", message: "Refresh the page and try again." });
  const signed = request.unsignCookie(request.cookies.aio_session ?? "");
  await pool.query("UPDATE sessions SET revoked_at=now() WHERE token_hash=$1", [hash(signed.value!)]);
  return reply.code(204).clearCookie("aio_session", cookieOptions(config)).clearCookie("aio_csrf", { path: "/" }).send();
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
