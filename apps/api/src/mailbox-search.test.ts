import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AppConfig } from "@aio/config";
import type { MailboxAccount } from "@aio/database";
import { logger } from "@aio/observability";
import { decryptSecret, deriveSearchCursorKey, encryptSecret } from "@aio/security";
import type { Pool, PoolClient } from "pg";
import { createApiApp, type ApiAppDependencies } from "./app.js";
import { decodeSearchCursor, encodeSearchCursor, parseKeywordSearch, parseSearchRequest, SearchCursorError, SearchRequestError, searchQueryDigest } from "./mailbox-search.js";
import { policyForRoute } from "./rate-limit.js";

const config: AppConfig = {
  NODE_ENV: "test", APP_ORIGIN: "http://app.example.test", API_ORIGIN: "http://app.example.test", DRAFT_MESSAGE_ID_DOMAIN: "drafts.example.test", DATABASE_URL: "postgres://user:password@localhost:5432/aio", REDIS_URL: "redis://localhost:6379", GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REDIRECT_URI: "http://app.example.test/v1/auth/google/callback", GOOGLE_PUBSUB_TOPIC: "projects/project/topics/topic", GOOGLE_CLOUD_PROJECT: "project", PUBSUB_PUSH_AUDIENCE: "http://app.example.test/v1/webhooks/gmail", PUBSUB_SERVICE_ACCOUNT_EMAIL: "push@example.test", GMAIL_INITIAL_SYNC_LIMIT: 500, SYNC_RECONCILIATION_INTERVAL_MINUTES: 30, TOKEN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 9).toString("base64"), SESSION_SECRET: "a".repeat(32), TRUST_PROXY: false, API_BODY_LIMIT_BYTES: 600 * 1024, WEBHOOK_BODY_LIMIT_BYTES: 64 * 1024, PORT: 4000, WEB_PORT: 3000
};
const ownerId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const mailboxId = "33333333-3333-4333-8333-333333333333";
const otherMailboxId = "44444444-4444-4444-8444-444444444444";
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function mailbox(id: string, userId: string): MailboxAccount { return { id, user_id: userId, provider_account_id: id, email_address: `${id}@example.test`, status: "active", encrypted_refresh_token: "encrypted", granted_scopes: ["gmail.readonly"], last_history_id: null, watch_expires_at: null, last_sync_error: null }; }

test("keyword parser canonicalizes Unicode, whitespace, words, and quoted phrases", () => {
  assert.deepEqual(parseKeywordSearch("  cafe\u0301   invoice  \"August   statement\" "), { terms: ["café", "invoice", "August statement"], normalizedQuery: "café invoice \"August statement\"" });
  assert.deepEqual(parseKeywordSearch("\"from:literal@example.test\""), { terms: ["from:literal@example.test"], normalizedQuery: "\"from:literal@example.test\"" });
  assert.deepEqual(parseSearchRequest({ query: "invoice", limit: "10" }).terms, ["invoice"]);
});

test("keyword parser rejects empty, malformed, oversized, operator, control, and unknown input", () => {
  for (const value of ["", "   ", "from:person@example.test", "\"unterminated", "\"\"", "\"phrase\"suffix", "back\\slash", `ok\nno`, "x".repeat(201)]) {
    assert.throws(() => parseKeywordSearch(value), SearchRequestError, value);
  }
  assert.throws(() => parseSearchRequest({ query: "invoice", unknown: "field" }), SearchRequestError);
  assert.throws(() => parseSearchRequest({ query: "invoice", limit: "11" }), SearchRequestError);
});

test("search cursor is domain-separated, opaque, versioned, expiring, and fully owner-bound", () => {
  const master = config.TOKEN_ENCRYPTION_KEY_BASE64;
  assert.notEqual(deriveSearchCursorKey(master), master);
  const terms = ["invoice", "August statement"];
  const context = { userId: ownerId, mailboxId, queryDigest: searchQueryDigest(terms), limit: 10 };
  const cursor = encodeSearchCursor({ ...context, providerPageToken: "private-gmail-token", expiresAt: Date.now() + 60_000 }, master);
  assert.equal(cursor.includes("private-gmail-token"), false);
  assert.equal(decodeSearchCursor(cursor, context, master), "private-gmail-token");
  for (const mismatch of [
    { ...context, userId: otherUserId },
    { ...context, mailboxId: otherMailboxId },
    { ...context, queryDigest: searchQueryDigest(["other"]) },
    { ...context, limit: 9 }
  ]) assert.throws(() => decodeSearchCursor(cursor, mismatch, master), SearchCursorError);
  const expired = encodeSearchCursor({ ...context, providerPageToken: "token", expiresAt: Date.now() - 1 }, master);
  assert.throws(() => decodeSearchCursor(expired, context, master), SearchCursorError);
  assert.throws(() => decodeSearchCursor(`${cursor.slice(0, -1)}x`, context, master), SearchCursorError);
  for (const version of [undefined, 0, 2, "1"]) {
    const payload = { ...context, providerPageToken: "token", expiresAt: Date.now() + 60_000, ...(version === undefined ? {} : { version }) };
    const invalid = encryptSecret(JSON.stringify(payload), deriveSearchCursorKey(master));
    assert.throws(() => decodeSearchCursor(invalid, context, master), SearchCursorError);
  }
});

async function makeApp() {
  const sessions = new Map([[hash("owner-session"), ownerId], [hash("other-session"), otherUserId]]);
  const calls: Array<{ mailboxId: string; terms: string[]; pageToken: string | undefined; limit: number }> = [];
  const client = {
    query: async (text: string, values: unknown[]) => {
      if (text.startsWith("SELECT user_id AS id FROM sessions")) { const id = sessions.get(values[0] as string); return { rows: id ? [{ id }] : [], rowCount: id ? 1 : 0 }; }
      if (text.includes("WITH upsert AS")) return { rows: [{ id: "55555555-5555-4555-8555-555555555555", providerThreadId: "provider-thread", subject: "Invoice", latestSender: "Billing", preview: "August", lastMessageAt: new Date("2026-07-18T12:00:00Z"), unreadCount: 0, messageCount: 1, hasAttachments: false, hasDraft: false, labels: ["INBOX"] }], rowCount: 1 };
      if (text.includes("INSERT INTO messages")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    }
  } as unknown as PoolClient;
  const dependencies: ApiAppDependencies = {
    config, logger, pool: client as unknown as Pool,
    redis: { set: async () => "OK", getdel: async () => null, quit: async () => "OK" } as unknown as ApiAppDependencies["redis"],
    pubsubVerifier: {} as ApiAppDependencies["pubsubVerifier"],
    sanitizedThreadCache: { key: () => "", get: () => undefined, set: () => undefined } as unknown as ApiAppDependencies["sanitizedThreadCache"],
    withTransaction: async (fn) => fn(client),
    findMailboxForUser: async (id, userId) => id === mailboxId && userId === ownerId ? mailbox(mailboxId, ownerId) : null,
    searchMailboxThreads: async (selectedMailbox, terms, pageToken, limit) => {
      calls.push({ mailboxId: selectedMailbox.id, terms, pageToken, limit });
      return { threads: [{ id: "provider-thread", messages: [{ id: "provider-message", internalDate: "1784376000000", labelIds: ["INBOX"], snippet: "August", payload: { headers: [{ name: "From", value: "Billing" }, { name: "Subject", value: "Invoice" }] } }] }], nextPageToken: pageToken ? null : "private-next-token" };
    },
    ensureMailboxSyncState: async () => undefined, recordPendingHistory: async () => undefined, enqueueSync: async () => undefined,
    insertProviderCommand: async () => ({ id: "command", commandType: "archive_thread", status: "pending" }),
    createDraftWithCommand: async () => ({ id: "command", commandType: "create_draft", status: "pending", draftId: "66666666-6666-4666-8666-666666666666" }),
    updateDraftWithCommand: async () => ({ id: "command", commandType: "update_draft", status: "pending", draftId: "66666666-6666-4666-8666-666666666666" }),
    sendDraftWithCommand: async () => ({ id: "command", commandType: "send_draft", status: "pending", draftId: "66666666-6666-4666-8666-666666666666" }),
    findDraftForUser: async () => null, findDraftEditEligibilityForUser: async () => null, findSendRecoveryCommandForUser: async () => null, enqueueSendDraftVerification: async () => undefined,
    isIdempotencyConflictError: () => false, isDraftRevisionConflictError: () => false, isDraftStateConflictError: () => false, isActiveDraftCommandError: () => false
  };
  const app = await createApiApp(dependencies);
  const owner = app.signCookie("owner-session"); const other = app.signCookie("other-session");
  return { app, calls, headers: (session = owner) => ({ cookie: `aio_session=${session}` }), other };
}

test("search route is authenticated, owner-scoped, normalized, projected, and cursor-bound", async () => {
  const { app, calls, headers, other } = await makeApp();
  const route = `/v1/mailboxes/${mailboxId}/search?query=${encodeURIComponent("invoice \"August statement\"")}&limit=10`;
  assert.equal((await app.inject({ method: "GET", url: route })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: route, headers: headers(other) })).statusCode, 404);
  const first = await app.inject({ method: "GET", url: route, headers: headers() });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(calls[0], { mailboxId, terms: ["invoice", "August statement"], pageToken: undefined, limit: 10 });
  assert.equal(first.json().source, "gmail_search");
  assert.equal(first.json().items[0].providerThreadId, "provider-thread");
  assert.equal(first.json().nextCursor.includes("private-next-token"), false);
  assert.deepEqual(Object.keys(first.json()).sort(), ["fetchedAt", "items", "nextCursor", "source"]);
  const next = await app.inject({ method: "GET", url: `${route}&cursor=${encodeURIComponent(first.json().nextCursor)}`, headers: headers() });
  assert.equal(next.statusCode, 200);
  assert.equal(calls[1].pageToken, "private-next-token");
  const reused = await app.inject({ method: "GET", url: `/v1/mailboxes/${mailboxId}/search?query=other&limit=10&cursor=${encodeURIComponent(first.json().nextCursor)}`, headers: headers() });
  assert.deepEqual(reused.json(), { code: "invalid_cursor", message: "This search page is no longer valid. Run the search again." });
  await app.close();
});

test("search route rejects unsupported syntax and unknown fields before Gmail access", async () => {
  const { app, calls, headers } = await makeApp();
  for (const query of ["", "from:person@example.test", "\"unterminated", "x".repeat(201)]) {
    const response = await app.inject({ method: "GET", url: `/v1/mailboxes/${mailboxId}/search?query=${encodeURIComponent(query)}`, headers: headers() });
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().code, "invalid_search_request");
  }
  assert.equal((await app.inject({ method: "GET", url: `/v1/mailboxes/${mailboxId}/search?query=invoice&scope=inbox`, headers: headers() })).statusCode, 400);
  assert.equal(calls.length, 0);
  assert.deepEqual(policyForRoute("GET", "/v1/mailboxes/:mailboxId/search"), { category: "mailbox_search", limit: 10, windowMs: 60_000, dimensions: ["ip", "user", "mailbox"] });
  await app.close();
});
