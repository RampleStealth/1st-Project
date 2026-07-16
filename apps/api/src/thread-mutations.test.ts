import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AppConfig } from "@aio/config";
import type { MailboxAccount } from "@aio/database";
import type { Pool, PoolClient } from "pg";
import { logger } from "@aio/observability";
import { decryptSecret } from "@aio/security";
import { createApiApp, type ApiAppDependencies } from "./app.js";

const config: AppConfig = {
  NODE_ENV: "test", APP_ORIGIN: "http://app.example.test", API_ORIGIN: "http://app.example.test", DATABASE_URL: "postgres://user:password@localhost:5432/aio", REDIS_URL: "redis://localhost:6379", GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", GOOGLE_REDIRECT_URI: "http://app.example.test/v1/auth/google/callback", GOOGLE_PUBSUB_TOPIC: "projects/project/topics/topic", GOOGLE_CLOUD_PROJECT: "project", PUBSUB_PUSH_AUDIENCE: "http://app.example.test/webhooks/gmail", PUBSUB_SERVICE_ACCOUNT_EMAIL: "push@example.test", GMAIL_INITIAL_SYNC_LIMIT: 500, SYNC_RECONCILIATION_INTERVAL_MINUTES: 30, TOKEN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"), SESSION_SECRET: "a".repeat(32), PORT: 4000, WEB_PORT: 3000
};

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const mailboxId = "33333333-3333-4333-8333-333333333333";
const otherMailboxId = "44444444-4444-4444-8444-444444444444";
const idempotencyKey = "55555555-5555-4555-8555-555555555555";

type CapturedCommand = { mailboxId: string; commandType: "archive_thread" | "mark_thread_unread"; encryptedPayload: string; fingerprint: string; idempotencyKey: string };

function sessionHash(value: string) { return createHash("sha256").update(value).digest("hex"); }

function mailbox(id: string, userId: string): MailboxAccount {
  return { id, user_id: userId, provider_account_id: id, email_address: `${id}@example.test`, status: "active", encrypted_refresh_token: "encrypted", granted_scopes: [], last_history_id: null, watch_expires_at: null, last_sync_error: null };
}

async function makeApp(options: { permission?: string; threads?: Set<string>; mailboxes?: Map<string, MailboxAccount> } = {}) {
  const permission = options.permission ?? "write_granted";
  const mailboxes = options.mailboxes ?? new Map([[mailboxId, mailbox(mailboxId, ownerId)], [otherMailboxId, mailbox(otherMailboxId, otherUserId)]]);
  const threads = options.threads ?? new Set([`${mailboxId}:thread-a`, `${mailboxId}:thread-b`, `${otherMailboxId}:thread-other`]);
  const sessions = new Map([[sessionHash("owner-session"), ownerId], [sessionHash("other-session"), otherUserId]]);
  const captured: CapturedCommand[] = [];
  const commands = new Map<string, { id: string; commandType: "archive_thread" | "mark_thread_unread"; status: string; requestFingerprint: string }>();
  let commandNumber = 0;
  const client = {
    query: async (text: string, values: unknown[]) => {
      if (text.startsWith("SELECT user_id AS id FROM sessions")) {
        const userId = sessions.get(values[0] as string);
        return { rows: userId ? [{ id: userId }] : [], rowCount: userId ? 1 : 0 };
      }
      if (text.startsWith("SELECT write_capability FROM mailbox_permission_state")) return { rows: [{ write_capability: permission }], rowCount: 1 };
      if (text.startsWith("SELECT id FROM threads")) {
        const exists = threads.has(`${values[0]}:${values[1]}`);
        return { rows: exists ? [{ id: "thread-projection" }] : [], rowCount: exists ? 1 : 0 };
      }
      throw new Error(`Unexpected query: ${text}`);
    }
  } as unknown as PoolClient;
  const dependencies: ApiAppDependencies = {
    config,
    logger,
    pool: client as unknown as Pool,
    redis: { set: async () => "OK", getdel: async () => null, quit: async () => "OK" } as unknown as ApiAppDependencies["redis"],
    pubsubVerifier: {} as ApiAppDependencies["pubsubVerifier"],
    sanitizedThreadCache: { key: () => "", get: () => undefined, set: () => undefined } as unknown as ApiAppDependencies["sanitizedThreadCache"],
    withTransaction: async (fn) => fn(client),
    findMailboxForUser: async (requestedMailboxId, userId) => {
      const candidate = mailboxes.get(requestedMailboxId);
      return candidate?.user_id === userId ? candidate : null;
    },
    ensureMailboxSyncState: async () => undefined,
    recordPendingHistory: async () => undefined,
    enqueueSync: async () => undefined,
    insertProviderCommand: async (input) => {
      captured.push(input);
      const existing = commands.get(`${input.mailboxId}:${input.idempotencyKey}`);
      if (existing) {
        if (existing.requestFingerprint !== input.fingerprint) throw new Error("idempotency conflict");
        return { ...existing, encryptedPayload: input.encryptedPayload, requestFingerprint: input.fingerprint, activeClaimId: "internal-claim", leaseExpiresAt: "internal-lease", providerResultReference: "internal-provider-result" };
      }
      const command = { id: `command-${++commandNumber}`, commandType: input.commandType, status: "pending", requestFingerprint: input.fingerprint };
      commands.set(`${input.mailboxId}:${input.idempotencyKey}`, command);
      return { ...command, encryptedPayload: input.encryptedPayload, activeClaimId: "internal-claim", leaseExpiresAt: "internal-lease", providerResultReference: "internal-provider-result" };
    },
    isIdempotencyConflictError: (error) => error instanceof Error && error.message === "idempotency conflict"
  };
  const app = await createApiApp(dependencies);
  const signedOwnerSession = app.signCookie("owner-session");
  const signedOtherSession = app.signCookie("other-session");
  const headers = (session = signedOwnerSession, csrf = "csrf-token", key = idempotencyKey) => ({ cookie: `aio_session=${session}; aio_csrf=${csrf}`, "x-csrf-token": csrf, "idempotency-key": key });
  return { app, captured, headers, signedOtherSession };
}

test("thread mutation routes enforce ownership, csrf, UUID idempotency, permission and thread scope", async () => {
  const { app, headers, signedOtherSession } = await makeApp();
  const archive = `/v1/mailboxes/${mailboxId}/threads/thread-a/archive`;
  const unread = `/v1/mailboxes/${mailboxId}/threads/thread-a/mark-unread`;
  assert.equal((await app.inject({ method: "POST", url: archive })).statusCode, 401);
  assert.deepEqual((await app.inject({ method: "POST", url: archive })).json(), { code: "unauthenticated" });
  assert.deepEqual((await app.inject({ method: "POST", url: archive, headers: headers(signedOtherSession) })).json(), { code: "mailbox_not_found" });
  assert.deepEqual((await app.inject({ method: "POST", url: `/v1/mailboxes/${otherMailboxId}/threads/thread-other/archive`, headers: headers() })).json(), { code: "mailbox_not_found" });
  assert.deepEqual((await app.inject({ method: "POST", url: `/v1/mailboxes/${mailboxId}/threads/thread-other/archive`, headers: headers() })).json(), { code: "thread_not_found" });
  assert.deepEqual((await app.inject({ method: "POST", url: archive, headers: { ...headers(), "x-csrf-token": "wrong" } })).json(), { code: "csrf_failed" });
  const { ["idempotency-key"]: _idempotencyKey, ...missing } = headers();
  assert.deepEqual((await app.inject({ method: "POST", url: archive, headers: missing })).json(), { code: "invalid_idempotency_key" });
  assert.deepEqual((await app.inject({ method: "POST", url: archive, headers: headers(undefined, "csrf-token", "not-a-uuid") })).json(), { code: "invalid_idempotency_key" });
  assert.equal((await app.inject({ method: "POST", url: unread, headers: headers() })).statusCode, 202);
  await app.close();
});

test("thread mutation command creation encrypts only the provider thread ID and is idempotent", async () => {
  const { app, captured, headers } = await makeApp();
  const archive = `/v1/mailboxes/${mailboxId}/threads/thread-a/archive`;
  const body = { labels: ["TRASH"], userId: otherUserId, mailboxId: otherMailboxId, action: "send_draft", providerThreadId: "attacker-thread", arbitrary: { body: "ignored" } };
  const first = await app.inject({ method: "POST", url: archive, headers: { ...headers(), "content-type": "application/json" }, payload: body });
  const replay = await app.inject({ method: "POST", url: archive, headers: headers() });
  const conflict = await app.inject({ method: "POST", url: `/v1/mailboxes/${mailboxId}/threads/thread-a/mark-unread`, headers: headers() });
  const threadConflict = await app.inject({ method: "POST", url: `/v1/mailboxes/${mailboxId}/threads/thread-b/archive`, headers: headers() });
  assert.equal(first.statusCode, 202);
  assert.equal(replay.statusCode, 202);
  assert.deepEqual(first.json(), replay.json());
  assert.deepEqual(conflict.json(), { code: "idempotency_conflict" });
  assert.deepEqual(threadConflict.json(), { code: "idempotency_conflict" });
  assert.equal(captured[0].mailboxId, mailboxId);
  assert.equal(captured[0].commandType, "archive_thread");
  assert.equal(captured[0].encryptedPayload.includes("thread-a"), false);
  assert.deepEqual(JSON.parse(decryptSecret(captured[0].encryptedPayload, config.TOKEN_ENCRYPTION_KEY_BASE64)), { providerThreadId: "thread-a" });
  assert.deepEqual(Object.keys(first.json()).sort(), ["commandType", "id", "status"]);
  for (const forbidden of ["encryptedPayload", "providerThreadId", "requestFingerprint", "activeClaimId", "leaseExpiresAt", "providerResultReference", "mailboxId", "attemptCount", "nextAttemptAt"]) assert.equal(forbidden in first.json(), false, forbidden);
  await app.close();
});

test("non-write-granted mailbox permissions reject command creation", async () => {
  for (const permission of ["read_only", "upgrade_pending", "upgrade_declined", "upgrade_failed"]) {
    const { app, headers } = await makeApp({ permission });
    const response = await app.inject({ method: "POST", url: `/v1/mailboxes/${mailboxId}/threads/thread-a/archive`, headers: headers() });
    assert.equal(response.statusCode, 409, permission);
    assert.deepEqual(response.json(), { code: "permission_required" });
    await app.close();
  }
});
