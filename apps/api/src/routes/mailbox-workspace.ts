import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "@aio/config";
import { findMailboxForUser } from "@aio/database/repositories/mailbox-account";
import { upsertThreadProjection } from "@aio/database/repositories/thread-projection";
import { classifyGmailError, getThreadFull, gmailForMailbox, hydrateThreadMetadata, isGmailProviderError, listThreads, normalizeThreadDisplay, SanitizedThreadCache, sanitizeGmailProviderError } from "@aio/gmail";
import { CursorError, decodeThreadCursor, encodeThreadCursor, threadListQuerySchema } from "../mailbox-list.js";
import { threadReadProviderFailure } from "../thread-read.js";
import { correlationId } from "../route-helpers/security.js";
import { authenticatedUser } from "../route-helpers/session.js";

type Deps = {
  config: AppConfig;
  pool: Pool;
  withTransaction: <T>(fn: (client: any) => Promise<T>) => Promise<T>;
  sanitizedThreadCache: SanitizedThreadCache;
};

export function registerMailboxWorkspaceRoutes(
  app: FastifyInstance<any, any, any, any>,
  { config, pool, withTransaction, sanitizedThreadCache }: Deps
) {
  app.get("/v1/mailboxes",async(request,reply)=>{const user=await authenticatedUser(request,pool);if(!user)return reply.code(401).send({code:"unauthenticated",message:"Sign in to manage your connection."});const result=await pool.query("SELECT m.id,m.email_address,m.status,m.last_synced_at,m.last_sync_error,m.watch_expires_at,m.created_at,COALESCE(p.write_capability,'read_only') AS write_capability FROM mailbox_accounts m LEFT JOIN mailbox_permission_state p ON p.mailbox_account_id=m.id WHERE m.user_id=$1 AND m.status <> 'disconnected' ORDER BY m.created_at DESC",[user.id]);return result.rows;});

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
}
