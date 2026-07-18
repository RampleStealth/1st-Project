import type { FastifyInstance } from "fastify";
import type { AppConfig } from "@aio/config";
import type { MailboxAccount } from "@aio/database";
import type { ProviderThreadMetadata } from "@aio/database/repositories/thread-projection";
import { upsertThreadProjection } from "@aio/database/repositories/thread-projection";
import { classifyGmailError, isGmailProviderError, sanitizeGmailProviderError } from "@aio/gmail";
import type { Pool, PoolClient } from "pg";
import { decodeSearchCursor, encodeSearchCursor, parseSearchRequest, SearchCursorError, SearchRequestError, searchQueryDigest } from "../mailbox-search.js";
import { correlationId } from "../route-helpers/security.js";
import { authenticatedUser } from "../route-helpers/session.js";

export type SearchMailboxThreads = (
  mailbox: MailboxAccount,
  terms: string[],
  pageToken: string | undefined,
  limit: number
) => Promise<{ threads: ProviderThreadMetadata[]; nextPageToken: string | null }>;

type Dependencies = {
  config: AppConfig;
  pool: Pool;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  findMailboxForUser: (mailboxAccountId: string, userId: string) => Promise<MailboxAccount | null>;
  searchMailboxThreads: SearchMailboxThreads;
};

export function registerMailboxSearchRoutes(app: FastifyInstance, dependencies: Dependencies) {
  app.get<{ Params: { mailboxId: string }; Querystring: { query?: string; cursor?: string; limit?: string } }>(
    "/v1/mailboxes/:mailboxId/search",
    async (request, reply) => {
      const user = await authenticatedUser(request, dependencies.pool);
      if (!user) return reply.code(401).send({ code: "unauthenticated", message: "Sign in to search your mailbox." });
      let search: ReturnType<typeof parseSearchRequest>;
      try {
        search = parseSearchRequest(request.query);
      } catch (error) {
        if (error instanceof SearchRequestError) return reply.code(400).send({ code: "invalid_search_request", message: "Enter plain keywords or quoted phrases up to 200 characters." });
        throw error;
      }
      const mailbox = await dependencies.findMailboxForUser(request.params.mailboxId, user.id);
      if (!mailbox) return reply.code(404).send({ code: "mailbox_not_found", message: "Mailbox connection not found." });
      if (mailbox.status !== "active") return reply.code(409).send({ code: "provider_reauthentication_required", message: "Reconnect Gmail before searching your mailbox.", retryable: false });
      const context = { userId: user.id, mailboxId: mailbox.id, queryDigest: searchQueryDigest(search.terms), limit: search.limit };
      let providerPageToken: string | undefined;
      try {
        providerPageToken = search.cursor ? decodeSearchCursor(search.cursor, context, dependencies.config.TOKEN_ENCRYPTION_KEY_BASE64) : undefined;
      } catch (error) {
        if (error instanceof SearchCursorError) return reply.code(400).send({ code: "invalid_cursor", message: "This search page is no longer valid. Run the search again." });
        throw error;
      }
      let providerPage: Awaited<ReturnType<SearchMailboxThreads>>;
      try {
        providerPage = await dependencies.searchMailboxThreads(mailbox, search.terms, providerPageToken, search.limit);
      } catch (error) {
        if (isGmailProviderError(error)) {
          request.log.warn(sanitizeGmailProviderError(error, { operation: "gmail_thread_search", mailboxId: mailbox.id, correlationId: correlationId(request) }), "Gmail search failed");
        }
        const failure = classifyGmailError(error, "resource");
        if (failure === "reauthorization_required") return reply.code(409).send({ code: "provider_reauthentication_required", message: "Reconnect Gmail before searching your mailbox.", retryable: false });
        if (failure === "rate_limited" || failure === "transient_provider_failure") return reply.code(503).send({ code: "provider_temporarily_unavailable", message: "Gmail search is temporarily unavailable. Try again shortly.", retryable: true });
        return reply.code(502).send({ code: "provider_search_failed", message: "We could not search Gmail.", retryable: true });
      }
      try {
        const items = await dependencies.withTransaction(async (client) => {
          const projected = [];
          for (const thread of providerPage.threads) projected.push(await upsertThreadProjection(client, mailbox.id, thread));
          return projected.filter((thread): thread is NonNullable<typeof thread> => Boolean(thread));
        });
        const nextCursor = providerPage.nextPageToken
          ? encodeSearchCursor({ ...context, providerPageToken: providerPage.nextPageToken, expiresAt: Date.now() + 15 * 60_000 }, dependencies.config.TOKEN_ENCRYPTION_KEY_BASE64)
          : null;
        return { items, nextCursor, source: "gmail_search", fetchedAt: new Date() };
      } catch {
        request.log.error({ mailboxId: mailbox.id, correlationId: correlationId(request), errorCode: "search_projection_failed" }, "search projection update failed");
        return reply.code(503).send({ code: "projection_temporarily_unavailable", message: "Gmail found results, but we could not prepare them safely. Try again shortly.", retryable: true });
      }
    }
  );
}
