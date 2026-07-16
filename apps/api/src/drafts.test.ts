import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AppConfig } from "@aio/config";
import type { MailboxAccount } from "@aio/database";
import type { Pool, PoolClient } from "pg";
import { logger } from "@aio/observability";
import { decryptDraftContent, decryptProviderCommandPayload } from "@aio/security";
import { createApiApp, type ApiAppDependencies } from "./app.js";

const config: AppConfig = { NODE_ENV: "test", APP_ORIGIN: "http://app.example.test", API_ORIGIN: "http://app.example.test", DATABASE_URL: "postgres://user:password@localhost:5432/aio", REDIS_URL: "redis://localhost:6379", GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REDIRECT_URI: "http://app.example.test/v1/auth/google/callback", GOOGLE_PUBSUB_TOPIC: "projects/project/topics/topic", GOOGLE_CLOUD_PROJECT: "project", PUBSUB_PUSH_AUDIENCE: "http://app.example.test/webhooks/gmail", PUBSUB_SERVICE_ACCOUNT_EMAIL: "push@example.test", GMAIL_INITIAL_SYNC_LIMIT: 500, SYNC_RECONCILIATION_INTERVAL_MINUTES: 30, TOKEN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 5).toString("base64"), SESSION_SECRET: "a".repeat(32), TRUST_PROXY: false, API_BODY_LIMIT_BYTES: 600 * 1024, WEBHOOK_BODY_LIMIT_BYTES: 64 * 1024, PORT: 4000, WEB_PORT: 3000 };
const ownerId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const mailboxId = "33333333-3333-4333-8333-333333333333";
const key = "55555555-5555-4555-8555-555555555555";
const input = { to: ["recipient@example.test"], cc: [], bcc: [], subject: "Subject", plainText: "Body", html: null };
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function mailbox(userId = ownerId): MailboxAccount { return { id: mailboxId, user_id: userId, provider_account_id: "account", email_address: "owner@example.test", status: "active", encrypted_refresh_token: "encrypted", granted_scopes: [], last_history_id: null, watch_expires_at: null, last_sync_error: null }; }

async function makeApp(options: { permission?: string; draft?: any; recoveryCommand?: { id: string; status: string } | null } = {}) {
  const sessions = new Map([[hash("owner"), ownerId], [hash("other"), otherId]]);
  const captured: any[] = []; const existing = new Map<string, any>(); let storedDraft = options.draft ?? null;
  const client = { query: async (text: string, values: unknown[] = []) => {
    if (text.startsWith("SELECT user_id AS id FROM sessions")) { const id = sessions.get(values[0] as string); return { rows: id ? [{ id }] : [], rowCount: id ? 1 : 0 }; }
    if (text.startsWith("SELECT write_capability")) return { rows: [{ write_capability: options.permission ?? "write_granted" }], rowCount: 1 };
    throw new Error(`Unexpected query: ${text}`);
  } } as unknown as PoolClient;
  const dependencies: ApiAppDependencies = {
    config, logger, pool: client as unknown as Pool, redis: { set: async () => "OK", getdel: async () => null, quit: async () => "OK" } as never, pubsubVerifier: {} as never,
    sanitizedThreadCache: { key: () => "", get: () => undefined, set: () => undefined } as never, withTransaction: async (fn) => fn(client),
    findMailboxForUser: async (id, user) => id === mailboxId && user === ownerId ? mailbox() : null, ensureMailboxSyncState: async () => undefined, recordPendingHistory: async () => undefined, enqueueSync: async () => undefined,
    insertProviderCommand: async () => ({ id: "thread-command", commandType: "archive_thread", status: "pending" }),
    createDraftWithCommand: async (value: any) => { captured.push(value); const existingCommand = existing.get(value.idempotencyKey); if (existingCommand) { if (existingCommand.requestFingerprint !== value.requestFingerprint) throw new Error("idempotency conflict"); return existingCommand; } const command = { id: "draft-command", commandType: "create_draft", status: "pending", draftId: value.draftId, requestFingerprint: value.requestFingerprint }; existing.set(value.idempotencyKey, command); storedDraft = { id: value.draftId, status: "creating", revision: 1, confirmedRevision: null, recipientCount: value.recipientCount, hasHtml: value.hasHtml, createdAt: new Date(), updatedAt: new Date(), encryptedRecipients: value.encryptedRecipients, encryptedSubject: value.encryptedSubject, encryptedPlainText: value.encryptedPlainText, encryptedHtml: value.encryptedHtml }; return command; },
    updateDraftWithCommand: async (value: any) => { captured.push(value); const replay = existing.get(value.idempotencyKey); if (replay) { if (replay.requestFingerprint !== value.requestFingerprint) throw new Error("idempotency conflict"); return replay; } if (!storedDraft || storedDraft.status !== "ready") throw new Error("draft state conflict"); if (storedDraft.revision !== value.expectedRevision) throw new Error("draft revision conflict"); const command = { id: `update-${value.idempotencyKey}`, commandType: "update_draft", status: "pending", draftId: value.draftId, requestFingerprint: value.requestFingerprint }; existing.set(value.idempotencyKey, command); storedDraft = { ...storedDraft, status: "updating", revision: storedDraft.revision + 1, recipientCount: value.recipientCount, hasHtml: value.hasHtml, encryptedRecipients: value.encryptedRecipients, encryptedSubject: value.encryptedSubject, encryptedPlainText: value.encryptedPlainText, encryptedHtml: value.encryptedHtml }; return command; },
    sendDraftWithCommand: async (value: any) => { captured.push(value); const replay = existing.get(value.idempotencyKey); if (replay) { if (replay.requestFingerprint !== value.requestFingerprint) throw new Error("idempotency conflict"); return replay; } if (!storedDraft || storedDraft.status !== "ready" || storedDraft.revision !== value.expectedRevision) throw new Error("draft state conflict"); const command = { id: `send-${value.idempotencyKey}`, commandType: "send_draft", status: "pending", draftId: value.draftId, requestFingerprint: value.requestFingerprint }; existing.set(value.idempotencyKey, command); storedDraft = { ...storedDraft, status: "sending" }; return command; },
    findDraftForUser: async (id, draftId, userId) => id === mailboxId && userId === ownerId && storedDraft?.id === draftId ? storedDraft : null,
    findSendRecoveryCommandForUser: async (id, draftId, userId) => id === mailboxId && userId === ownerId && storedDraft?.id === draftId ? options.recoveryCommand ?? null : null,
    enqueueSendDraftVerification: async () => undefined,
    isIdempotencyConflictError: (error) => error instanceof Error && error.message === "idempotency conflict",
    isDraftRevisionConflictError: (error) => error instanceof Error && error.message === "draft revision conflict",
    isDraftStateConflictError: (error) => error instanceof Error && error.message === "draft state conflict",
    isActiveDraftCommandError: () => false
  };
  const app = await createApiApp(dependencies); const owner = app.signCookie("owner"); const other = app.signCookie("other");
  const headers = (session = owner, csrf = "csrf", idempotencyKey = key) => ({ cookie: `aio_session=${session}; aio_csrf=${csrf}`, "x-csrf-token": csrf, "idempotency-key": idempotencyKey, "content-type": "application/json", origin: config.APP_ORIGIN });
  return { app, captured, headers, other, getDraft: () => storedDraft };
}

test("draft creation validates ownership, csrf, permission and UUID idempotency", async () => {
  const { app, headers, other } = await makeApp(); const url = `/v1/mailboxes/${mailboxId}/drafts`;
  assert.equal((await app.inject({ method: "POST", url, payload: input })).statusCode, 401);
  assert.deepEqual((await app.inject({ method: "POST", url, headers: headers(other), payload: input })).json(), { code: "mailbox_not_found" });
  assert.deepEqual((await app.inject({ method: "POST", url, headers: { ...headers(), "x-csrf-token": "wrong" }, payload: input })).json(), { code: "csrf_failed" });
  const { ["idempotency-key"]: _unused, ...missing } = headers();
  assert.deepEqual((await app.inject({ method: "POST", url, headers: missing, payload: input })).json(), { code: "invalid_idempotency_key" });
  assert.deepEqual((await app.inject({ method: "POST", url, headers: headers(undefined, "csrf", "not-uuid"), payload: input })).json(), { code: "invalid_idempotency_key" });
  await app.close();
  const readOnly = await makeApp({ permission: "read_only" });
  assert.deepEqual((await readOnly.app.inject({ method: "POST", url, headers: readOnly.headers(), payload: input })).json(), { code: "permission_required" }); await readOnly.app.close();
});

test("draft creation stores only encrypted content and returns normalized command state", async () => {
  const { app, headers, captured, getDraft } = await makeApp(); const url = `/v1/mailboxes/${mailboxId}/drafts`;
  const first = await app.inject({ method: "POST", url, headers: headers(), payload: { ...input, labels: ["TRASH"], userId: otherId, action: "send_draft" } });
  const replay = await app.inject({ method: "POST", url, headers: headers(), payload: input });
  assert.equal(first.statusCode, 400, "strict request validation rejects mutation controls");
  const accepted = await app.inject({ method: "POST", url, headers: headers(), payload: input });
  assert.equal(accepted.statusCode, 202); assert.deepEqual(Object.keys(accepted.json()).sort(), ["commandType", "draftId", "id", "status"]);
  const acceptedReplay = await app.inject({ method: "POST", url, headers: headers(), payload: input }); assert.deepEqual(acceptedReplay.json(), accepted.json());
  const conflict = await app.inject({ method: "POST", url, headers: headers(), payload: { ...input, subject: "Different" } }); assert.deepEqual(conflict.json(), { code: "idempotency_conflict" });
  assert.equal(captured[0].encryptedPlainText.includes("Body"), false); assert.equal(captured[0].encryptedRecipients.includes("recipient@example.test"), false);
  assert.deepEqual(decryptDraftContent(getDraft(), config.TOKEN_ENCRYPTION_KEY_BASE64), input);
  assert.deepEqual(decryptProviderCommandPayload("create_draft", captured[0].encryptedCommandPayload, config.TOKEN_ENCRYPTION_KEY_BASE64), { commandType: "create_draft", payload: { version: 1, draftId: accepted.json().draftId } });
  await app.close();
});

test("draft reads are owner-scoped, decrypt after ownership, and expose no storage metadata", async () => {
  const fixture = await makeApp(); const create = await fixture.app.inject({ method: "POST", url: `/v1/mailboxes/${mailboxId}/drafts`, headers: fixture.headers(), payload: input }); const draftId = create.json().draftId;
  const other = await fixture.app.inject({ method: "GET", url: `/v1/mailboxes/${mailboxId}/drafts/${draftId}`, headers: { cookie: `aio_session=${fixture.other}` } }); assert.equal(other.statusCode, 404);
  const read = await fixture.app.inject({ method: "GET", url: `/v1/mailboxes/${mailboxId}/drafts/${draftId}`, headers: { cookie: fixture.headers().cookie } }); assert.equal(read.statusCode, 200); assert.deepEqual(read.json().to, input.to);
  assert.equal(read.json().canVerifySend, false);
  for (const internal of ["encrypted", "fingerprint", "gmailDraftId", "lastCommandId"]) assert.equal(JSON.stringify(read.json()).includes(internal), false);
  await fixture.app.close();
});

test("recovered send drafts expose only a safe verification capability", async () => {
  const fixture = await makeApp({ recoveryCommand: { id: "send-command", status: "recovery_required" } });
  const created = await fixture.app.inject({ method: "POST", url: `/v1/mailboxes/${mailboxId}/drafts`, headers: fixture.headers(), payload: input });
  fixture.getDraft().status = "recovery_required";
  const read = await fixture.app.inject({ method: "GET", url: `/v1/mailboxes/${mailboxId}/drafts/${created.json().draftId}`, headers: { cookie: fixture.headers().cookie } });
  assert.equal(read.json().canVerifySend, true);
  assert.equal(JSON.stringify(read.json()).includes("send-command"), false);
  await fixture.app.close();
});

test("ready draft updates require an exact If-Match revision and create only encrypted minimal commands", async () => {
  const ready = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "ready", revision: 1, confirmedRevision: 1, recipientCount: 1, hasHtml: false, createdAt: new Date(), updatedAt: new Date(), encryptedRecipients: "", encryptedSubject: "", encryptedPlainText: "", encryptedHtml: null };
  const fixture = await makeApp({ draft: ready });
  // Populate the otherwise encrypted fixture through the creation boundary, then mark it confirmed.
  const created = await fixture.app.inject({ method: "POST", url: `/v1/mailboxes/${mailboxId}/drafts`, headers: fixture.headers(undefined, "csrf", "66666666-6666-4666-8666-666666666666"), payload: input });
  const draftId = created.json().draftId;
  const stored = fixture.getDraft(); stored.status = "ready"; stored.confirmedRevision = 1;
  const url = `/v1/mailboxes/${mailboxId}/drafts/${draftId}`;
  const base = { ...fixture.headers(undefined, "csrf", "77777777-7777-4777-8777-777777777777"), "if-match": "\"1\"" };
  assert.equal((await fixture.app.inject({ method: "PUT", url, payload: input })).statusCode, 401);
  assert.equal((await fixture.app.inject({ method: "PUT", url, headers: { ...base, cookie: `aio_session=${fixture.other}; aio_csrf=csrf` }, payload: input })).statusCode, 404);
  assert.equal((await fixture.app.inject({ method: "PUT", url, headers: { ...base, "x-csrf-token": "wrong" }, payload: input })).statusCode, 403);
  const { ["if-match"]: _ifMatch, ...withoutIfMatch } = base;
  assert.equal((await fixture.app.inject({ method: "PUT", url, headers: withoutIfMatch, payload: input })).statusCode, 428);
  assert.deepEqual((await fixture.app.inject({ method: "PUT", url, headers: { ...base, "if-match": "1" }, payload: input })).json(), { code: "invalid_draft_revision" });
  assert.deepEqual((await fixture.app.inject({ method: "PUT", url, headers: { ...base, "if-match": "\"2\"" }, payload: input })).json(), { code: "draft_revision_conflict" });
  const rejectedBody = await fixture.app.inject({ method: "PUT", url, headers: base, payload: { ...input, gmailDraftId: "provider", action: "send_draft" } });
  assert.equal(rejectedBody.statusCode, 400);
  const accepted = await fixture.app.inject({ method: "PUT", url, headers: base, payload: { ...input, subject: "Updated" } });
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(Object.keys(accepted.json()).sort(), ["commandType", "draftId", "id", "revision", "status"]);
  const update = fixture.captured.at(-1);
  assert.equal(update.encryptedPlainText.includes("Body"), false);
  assert.deepEqual(decryptProviderCommandPayload("update_draft", update.encryptedCommandPayload, config.TOKEN_ENCRYPTION_KEY_BASE64), { commandType: "update_draft", payload: { version: 1, draftId, revision: 2 } });
  const replay = await fixture.app.inject({ method: "PUT", url, headers: base, payload: { ...input, subject: "Updated" } });
  assert.deepEqual(replay.json(), accepted.json());
  const conflict = await fixture.app.inject({ method: "PUT", url, headers: base, payload: { ...input, subject: "Different" } });
  assert.deepEqual(conflict.json(), { code: "idempotency_conflict" });
  await fixture.app.close();
  const readOnly = await makeApp({ permission: "read_only" });
  assert.deepEqual((await readOnly.app.inject({ method: "PUT", url, headers: { ...readOnly.headers(undefined, "csrf", "88888888-8888-4888-8888-888888888888"), "if-match": "\"1\"" }, payload: input })).json(), { code: "permission_required" });
  await readOnly.app.close();
});

test("confirmed ready drafts create one encrypted minimal send command and reject unconfirmed sends", async () => {
  const draft = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "ready", revision: 2, confirmedRevision: 2,
    contentFingerprint: "confirmed-fingerprint", confirmedContentFingerprint: "confirmed-fingerprint",
    gmailDraftId: "provider-draft", gmailDraftMessageId: "provider-message", recipientCount: 1, hasHtml: false,
    createdAt: new Date(), updatedAt: new Date(), encryptedRecipients: "cipher", encryptedSubject: "cipher", encryptedPlainText: "cipher", encryptedHtml: null
  };
  const fixture = await makeApp({ draft });
  const url = `/v1/mailboxes/${mailboxId}/drafts/${draft.id}/send`;
  const { ["content-type"]: _contentType, ...requestHeaders } = fixture.headers(undefined, "csrf", "88888888-8888-4888-8888-888888888888");
  const headers = { ...requestHeaders, "if-match": "\"2\"" };
  assert.equal((await fixture.app.inject({ method: "POST", url })).statusCode, 401);
  assert.equal((await fixture.app.inject({ method: "POST", url, headers: { ...headers, cookie: `aio_session=${fixture.other}; aio_csrf=csrf` } })).statusCode, 404);
  assert.equal((await fixture.app.inject({ method: "POST", url, headers: { ...headers, "x-csrf-token": "wrong" } })).statusCode, 403);
  assert.equal((await fixture.app.inject({ method: "POST", url, headers: { ...headers, "if-match": "2" } })).statusCode, 400);
  const rejectedBody = await fixture.app.inject({ method: "POST", url, headers, payload: { gmailDraftId: "attacker", labels: ["TRASH"], recipients: ["attacker@example.test"] } });
  assert.deepEqual(rejectedBody.json(), { code: "unexpected_request_body" });
  assert.deepEqual((await fixture.app.inject({ method: "POST", url, headers: { ...headers, "content-type": "application/json" }, payload: "null" })).json(), { code: "unexpected_request_body" });
  const accepted = await fixture.app.inject({ method: "POST", url, headers });
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(Object.keys(accepted.json()).sort(), ["commandType", "draftId", "id", "revision", "status"]);
  const captured = fixture.captured.at(-1);
  assert.equal(captured.encryptedCommandPayload.includes(draft.gmailDraftId), false);
  assert.deepEqual(decryptProviderCommandPayload("send_draft", captured.encryptedCommandPayload, config.TOKEN_ENCRYPTION_KEY_BASE64), { commandType: "send_draft", payload: { version: 1, draftId: draft.id, revision: 2 } });
  const replay = await fixture.app.inject({ method: "POST", url, headers });
  assert.deepEqual(replay.json(), accepted.json());
  const unconfirmed = await makeApp({ draft: { ...draft, confirmedRevision: 1 } });
  const { ["content-type"]: _unconfirmedContentType, ...unconfirmedHeaders } = unconfirmed.headers(undefined, "csrf", "99999999-9999-4999-8999-999999999999");
  assert.deepEqual((await unconfirmed.app.inject({ method: "POST", url, headers: { ...unconfirmedHeaders, "if-match": "\"2\"" } })).json(), { code: "draft_not_confirmed" });
  await fixture.app.close(); await unconfirmed.app.close();
});

test("send verification is owner-scoped, CSRF-protected, and only queues the original recovery command", async () => {
  const draft = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "recovery_required", revision: 1, confirmedRevision: 1, contentFingerprint: "f", confirmedContentFingerprint: "f" };
  const fixture = await makeApp({ draft, recoveryCommand: { id: "send-command", status: "recovery_required" } });
  const url = `/v1/mailboxes/${mailboxId}/drafts/${draft.id}/send-verification`;
  const { ["content-type"]: _contentType, ...headers } = fixture.headers();
  assert.equal((await fixture.app.inject({ method: "POST", url })).statusCode, 401);
  assert.equal((await fixture.app.inject({ method: "POST", url, headers: { ...headers, cookie: `aio_session=${fixture.other}; aio_csrf=csrf` } })).statusCode, 409);
  assert.equal((await fixture.app.inject({ method: "POST", url, headers: { ...headers, "x-csrf-token": "wrong" } })).statusCode, 403);
  assert.deepEqual((await fixture.app.inject({ method: "POST", url, headers, payload: { commandType: "send_draft" } })).json(), { code: "unexpected_request_body" });
  assert.deepEqual((await fixture.app.inject({ method: "POST", url, headers })).json(), { id: "send-command", status: "verification_pending" });
  const unavailable = await makeApp({ draft });
  const { ["content-type"]: _unavailableContentType, ...unavailableHeaders } = unavailable.headers();
  assert.deepEqual((await unavailable.app.inject({ method: "POST", url, headers: unavailableHeaders })).json(), { code: "send_verification_unavailable" });
  await fixture.app.close(); await unavailable.app.close();
});
