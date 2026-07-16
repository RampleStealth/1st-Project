import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ProviderCommandType } from "@aio/contracts";
import { findMailboxById, pool, withTransaction } from "@aio/database";
import {
  claimCommand,
  completeClaim,
  completeFailedMutation,
  completeConfirmedMutation,
  completeRecoveredDraftCreation,
  InvalidCommandPayloadError,
  claimCreateDraftRecovery,
  claimUpdateDraftRecovery,
  loadClaimedCommand,
  markProviderExecutionStarted,
  recoverExpiredLeases,
  releaseCreateDraftRecoveryClaim,
  releaseUpdateDraftRecoveryClaim,
  scheduleRetryFromClaim,
  StaleCommandClaimError
} from "@aio/database/repositories/provider-command";
import { classifyGmailMutationError } from "@aio/gmail";
import { encryptSecret } from "@aio/security";
import { encryptDraftContent, encryptProviderCommandPayload, fingerprintDraftContent } from "@aio/security";
import { canonicalizeDraftContent, generateDraftMessageId } from "@aio/gmail";
import { confirmDraftCreation, createDraftWithCommand, loadDraftForCreation, loadDraftForRecovery, loadDraftForUpdate, loadDraftForUpdateRecovery, confirmDraftUpdate, markDraftConflict, updateDraftWithCommand } from "@aio/database/repositories/draft";
import { executeProviderCommand, verifyCreateDraftRecovery, verifyUpdateDraftRecovery } from "./provider-command-executor.js";

const available = Boolean(process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY_BASE64);
const key = process.env.TOKEN_ENCRYPTION_KEY_BASE64 ?? "";

async function fixture() {
  const suffix = randomUUID();
  const user = await pool.query<{ id: string }>("INSERT INTO users(email_normalized) VALUES($1) RETURNING id", [`mutation-${suffix}@example.test`]);
  const mailbox = await pool.query<{ id: string }>(
    "INSERT INTO mailbox_accounts(user_id,provider,provider_account_id,email_address,encrypted_refresh_token,granted_scopes) VALUES($1,'gmail',$2,$3,'encrypted',ARRAY[]::text[]) RETURNING id",
    [user.rows[0].id, suffix, `mutation-${suffix}@example.test`]
  );
  await pool.query(
    "INSERT INTO threads(mailbox_account_id,provider_thread_id,provider_labels,unread_count) VALUES($1,'archive-thread',ARRAY['INBOX','STARRED'],0),($1,'unread-thread',ARRAY['INBOX','STARRED'],0)",
    [mailbox.rows[0].id]
  );
  return {
    mailboxId: mailbox.rows[0].id,
    userId: user.rows[0].id,
    cleanup: () => pool.query("DELETE FROM users WHERE id=$1", [user.rows[0].id])
  };
}

async function command(mailboxId: string, commandType: ProviderCommandType, providerThreadId: string, suffix = randomUUID()) {
  const { insertProviderCommand } = await import("@aio/database/repositories/provider-command");
  return insertProviderCommand({
    mailboxId,
    commandType,
    encryptedPayload: encryptSecret(JSON.stringify({ providerThreadId }), key),
    fingerprint: `${commandType}:${providerThreadId}:${suffix}`,
    idempotencyKey: suffix
  });
}

async function createDraftCommand(mailboxId: string, suffix = randomUUID()) {
  const content = canonicalizeDraftContent({ to: ["recipient@example.test"], cc: [], bcc: [], subject: "Draft subject", plainText: "Draft body", html: null });
  const draftId = randomUUID();
  return createDraftWithCommand({
    draftId, mailboxId, rfc822MessageId: generateDraftMessageId("example.test", suffix), contentFingerprint: fingerprintDraftContent(content, key),
    ...encryptDraftContent(content, key), recipientCount: 1, bodyByteCount: Buffer.byteLength(content.plainText), hasHtml: false,
    encryptedCommandPayload: encryptProviderCommandPayload("create_draft", { version: 1, draftId }, key), requestFingerprint: `create_draft:${suffix}`, idempotencyKey: suffix
  });
}

async function updateDraftCommand(mailboxId: string, suffix = randomUUID()) {
  const created = await createDraftCommand(mailboxId, suffix);
  await pool.query("UPDATE provider_commands SET status='succeeded',completed_at=now() WHERE id=$1", [created.id]);
  const gmailDraftId = `confirmed-draft-${suffix}`, gmailMessageId = `confirmed-message-${suffix}`, gmailThreadId = `confirmed-thread-${suffix}`;
  await pool.query("UPDATE drafts SET status='ready',confirmed_revision=1,confirmed_content_fingerprint=content_fingerprint,gmail_draft_id=$2,gmail_draft_message_id=$3,gmail_thread_id=$4 WHERE id=$1", [created.draftId, gmailDraftId, gmailMessageId, gmailThreadId]);
  const content = canonicalizeDraftContent({ to: ["updated@example.test"], cc: [], bcc: [], subject: "Updated subject", plainText: "Updated body", html: null });
  const command = await updateDraftWithCommand({
    draftId: created.draftId, mailboxId, expectedRevision: 1, contentFingerprint: fingerprintDraftContent(content, key),
    ...encryptDraftContent(content, key), recipientCount: 1, bodyByteCount: Buffer.byteLength(content.plainText), hasHtml: false,
    encryptedCommandPayload: encryptProviderCommandPayload("update_draft", { version: 1, draftId: created.draftId, revision: 2 }, key), requestFingerprint: `update_draft:${suffix}`, idempotencyKey: `${suffix}-update`
  });
  return { ...command, gmailDraftId, gmailMessageId, gmailThreadId };
}

function executor(overrides: Partial<Parameters<typeof executeProviderCommand>[1]> = {}) {
  return {
    encryptionKey: key,
    claimCommand,
    loadClaimedCommand,
    findMailboxById,
    gmailForMailbox: () => ({}) as never,
    archiveThread: async () => undefined,
    markThreadUnread: async () => undefined,
    loadDraftForCreation: async () => { throw new Error("draft loader should not run for a thread command"); },
    createDraft: async () => { throw new Error("draft adapter should not run for a thread command"); },
    confirmDraftCreation: async () => { throw new Error("draft projection should not run for a thread command"); },
    loadDraftForUpdate: async () => { throw new Error("draft loader should not run for a thread command"); },
    getDraft: async () => { throw new Error("draft adapter should not run for a thread command"); },
    updateDraft: async () => { throw new Error("draft adapter should not run for a thread command"); },
    confirmDraftUpdate: async () => { throw new Error("draft projection should not run for a thread command"); },
    markDraftConflict: async () => { throw new Error("draft projection should not run for a thread command"); },
    markProviderExecutionStarted,
    withTransaction,
    completeConfirmedMutation,
    completeFailedMutation,
    scheduleRetryFromClaim,
    completeClaim,
    classifyGmailMutationError,
    isStaleCommandClaimError: (error: unknown) => error instanceof StaleCommandClaimError,
    ...overrides
  };
}

async function commandState(id: string) {
  return (await pool.query<{ status: string; failure_code: string | null; attempt_count: number; provider_result_reference: string | null }>(
    "SELECT status,failure_code,attempt_count,provider_result_reference FROM provider_commands WHERE id=$1", [id]
  )).rows[0];
}

test("confirmed archive and unread mutate only their intended projection state", { skip: !available }, async () => {
  const data = await fixture();
  const calls: Array<{ operation: string; providerThreadId: string }> = [];
  try {
    const archive = await command(data.mailboxId, "archive_thread", "archive-thread");
    const unread = await command(data.mailboxId, "mark_thread_unread", "unread-thread");
    const deps = executor({
      archiveThread: async (_gmail, providerThreadId) => { calls.push({ operation: "archive", providerThreadId }); },
      markThreadUnread: async (_gmail, providerThreadId) => { calls.push({ operation: "unread", providerThreadId }); }
    });

    assert.deepEqual(await executeProviderCommand(archive.id, deps), { outcome: "succeeded" });
    assert.deepEqual(await executeProviderCommand(unread.id, deps), { outcome: "succeeded" });
    assert.deepEqual(await executeProviderCommand(unread.id, deps), { outcome: "not_claimed" });
    assert.deepEqual(calls, [{ operation: "archive", providerThreadId: "archive-thread" }, { operation: "unread", providerThreadId: "unread-thread" }]);

    const projections = await pool.query<{ provider_thread_id: string; provider_labels: string[]; unread_count: number }>(
      "SELECT provider_thread_id,provider_labels,unread_count FROM threads WHERE mailbox_account_id=$1 ORDER BY provider_thread_id", [data.mailboxId]
    );
    assert.deepEqual(projections.rows, [
      { provider_thread_id: "archive-thread", provider_labels: ["STARRED"], unread_count: 0 },
      { provider_thread_id: "unread-thread", provider_labels: ["INBOX", "STARRED", "UNREAD"], unread_count: 1 }
    ]);
    assert.equal((await commandState(archive.id)).status, "succeeded");
    assert.equal((await commandState(unread.id)).status, "succeeded");
    const audit = await pool.query<{ metadata: unknown }>("SELECT metadata FROM audit_events WHERE object_id=$1", [archive.id]);
    const serialized = JSON.stringify(audit.rows[0].metadata);
    for (const secret of ["archive-thread", "encrypted", "providerThreadId", "@example.test"]) assert.equal(serialized.includes(secret), false, secret);
  } finally {
    await data.cleanup();
  }
});

test("create draft waits for Gmail confirmation before atomically confirming the encrypted draft projection", { skip: !available }, async () => {
  const data = await fixture();
  try {
    const created = await createDraftCommand(data.mailboxId);
    const result = await executeProviderCommand(created.id, executor({
      loadDraftForCreation,
      createDraft: async () => { const marked = await pool.query<{ provider_execution_started_at: Date | null }>("SELECT provider_execution_started_at FROM provider_commands WHERE id=$1", [created.id]); assert.ok(marked.rows[0].provider_execution_started_at); return { draftId: "gmail-draft", messageId: "gmail-message", threadId: "gmail-thread" }; },
      confirmDraftCreation
    }));
    assert.deepEqual(result, { outcome: "succeeded" });
    const draft = await pool.query<{ status: string; gmail_draft_id: string; confirmed_revision: number; confirmed_content_fingerprint: string }>("SELECT status,gmail_draft_id,confirmed_revision,confirmed_content_fingerprint FROM drafts WHERE id=$1", [created.draftId]);
    assert.deepEqual(draft.rows[0], { status: "ready", gmail_draft_id: "gmail-draft", confirmed_revision: 1, confirmed_content_fingerprint: (await pool.query<{ content_fingerprint: string }>("SELECT content_fingerprint FROM drafts WHERE id=$1", [created.draftId])).rows[0].content_fingerprint });
    assert.equal((await commandState(created.id)).status, "succeeded");

    const rollback = await createDraftCommand(data.mailboxId);
    const failed = await executeProviderCommand(rollback.id, executor({
      loadDraftForCreation,
      createDraft: async () => ({ draftId: "gmail-draft-rollback", messageId: "gmail-message-rollback", threadId: null }),
      confirmDraftCreation: async () => { throw new Error("projection persistence failed"); }
    }));
    assert.deepEqual(failed, { outcome: "recovery_required" });
    const unconfirmed = await pool.query<{ status: string; gmail_draft_id: string | null }>("SELECT status,gmail_draft_id FROM drafts WHERE id=$1", [rollback.draftId]);
    assert.deepEqual(unconfirmed.rows[0], { status: "creating", gmail_draft_id: null });
    assert.equal((await commandState(rollback.id)).status, "recovery_required");
  } finally { await data.cleanup(); }
});

test("draft update preflights Gmail, detects external changes, and confirms the replacement revision atomically", { skip: !available }, async () => {
  const data = await fixture();
  try {
    const updated = await updateDraftCommand(data.mailboxId);
    const calls: string[] = [];
    assert.deepEqual(await executeProviderCommand(updated.id, executor({
      loadDraftForUpdate,
      getDraft: async () => { calls.push("preflight"); return { draftId: updated.gmailDraftId, messageId: updated.gmailMessageId, threadId: updated.gmailThreadId }; },
      updateDraft: async (_gmail, id) => { calls.push(`update:${id}`); const marker = await pool.query<{ provider_execution_started_at: Date | null }>("SELECT provider_execution_started_at FROM provider_commands WHERE id=$1", [updated.id]); assert.ok(marker.rows[0].provider_execution_started_at); return { draftId: updated.gmailDraftId, messageId: "replacement-message", threadId: "replacement-thread" }; },
      confirmDraftUpdate
    })), { outcome: "succeeded" });
    assert.deepEqual(calls, ["preflight", `update:${updated.gmailDraftId}`]);
    assert.deepEqual((await pool.query<{ status: string; revision: number; confirmed_revision: number; gmail_draft_message_id: string; gmail_thread_id: string }>("SELECT status,revision,confirmed_revision,gmail_draft_message_id,gmail_thread_id FROM drafts WHERE id=$1", [updated.draftId])).rows[0], { status: "ready", revision: 2, confirmed_revision: 2, gmail_draft_message_id: "replacement-message", gmail_thread_id: "replacement-thread" });
    assert.equal((await commandState(updated.id)).status, "succeeded");
    assert.deepEqual(await executeProviderCommand(updated.id, executor()), { outcome: "not_claimed" });

    const conflict = await updateDraftCommand(data.mailboxId);
    let mutationCalled = false;
    assert.deepEqual(await executeProviderCommand(conflict.id, executor({
      loadDraftForUpdate,
      getDraft: async () => ({ draftId: conflict.gmailDraftId, messageId: "changed-elsewhere", threadId: conflict.gmailThreadId }),
      updateDraft: async () => { mutationCalled = true; return { draftId: "unexpected", messageId: "unexpected", threadId: null }; },
      markDraftConflict
    })), { outcome: "conflict" });
    assert.equal(mutationCalled, false);
    assert.deepEqual((await pool.query<{ status: string; gmail_draft_message_id: string }>("SELECT status,gmail_draft_message_id FROM drafts WHERE id=$1", [conflict.draftId])).rows[0], { status: "conflict", gmail_draft_message_id: conflict.gmailMessageId });
    assert.equal((await commandState(conflict.id)).failure_code, "external_draft_conflict");

    const deleted = await updateDraftCommand(data.mailboxId);
    assert.deepEqual(await executeProviderCommand(deleted.id, executor({ loadDraftForUpdate, getDraft: async () => { throw { response: { status: 404 } }; }, markDraftConflict })), { outcome: "failed" });
    assert.equal((await commandState(deleted.id)).failure_code, "resource_deleted");
    assert.equal((await pool.query<{ status: string }>("SELECT status FROM drafts WHERE id=$1", [deleted.draftId])).rows[0].status, "conflict");
  } finally { await data.cleanup(); }
});

test("draft update preserves safety across preflight retries, post-execution uncertainty, and lease recovery", { skip: !available }, async () => {
  const data = await fixture(); const providerError = (status: number) => ({ response: { status } });
  try {
    const retryable = await updateDraftCommand(data.mailboxId);
    assert.deepEqual(await executeProviderCommand(retryable.id, executor({ loadDraftForUpdate, getDraft: async () => { throw providerError(503); } })), { outcome: "retryable" });
    assert.equal((await commandState(retryable.id)).status, "retryable");

    const uncertain = await updateDraftCommand(data.mailboxId);
    assert.deepEqual(await executeProviderCommand(uncertain.id, executor({ loadDraftForUpdate, getDraft: async () => ({ draftId: uncertain.gmailDraftId, messageId: uncertain.gmailMessageId, threadId: null }), updateDraft: async () => { throw providerError(503); } })), { outcome: "recovery_required" });
    assert.equal((await commandState(uncertain.id)).status, "recovery_required");
    assert.equal(await claimCommand(uncertain.id), null);

    const crashed = await updateDraftCommand(data.mailboxId); const claim = await claimCommand(crashed.id); assert.ok(claim);
    await withTransaction((client) => markProviderExecutionStarted(client, crashed.id, claim.claimId));
    await pool.query("UPDATE provider_commands SET lease_expires_at=now()-interval '1 minute' WHERE id=$1", [crashed.id]); await recoverExpiredLeases();
    assert.equal((await commandState(crashed.id)).status, "recovery_required");
    assert.deepEqual(await executeProviderCommand(crashed.id, executor()), { outcome: "not_claimed" });
  } finally { await data.cleanup(); }
});

test("update recovery is read-only and remains recovery-required when metadata cannot prove content", { skip: !available }, async () => {
  const data = await fixture();
  try {
    const updated = await updateDraftCommand(data.mailboxId); const claim = await claimCommand(updated.id); assert.ok(claim);
    await withTransaction((client) => markProviderExecutionStarted(client, updated.id, claim.claimId));
    await pool.query("UPDATE provider_commands SET lease_expires_at=now()-interval '1 minute' WHERE id=$1", [updated.id]); await recoverExpiredLeases();
    assert.deepEqual(await verifyUpdateDraftRecovery(updated.id, {
      claimUpdateDraftRecovery,
      releaseUpdateDraftRecoveryClaim,
      loadDraftForUpdateRecovery,
      findMailboxById,
      gmailForMailbox: () => ({}) as never,
      getDraft: async () => ({ draftId: updated.gmailDraftId, messageId: "provider-message-after-unknown-update", threadId: updated.gmailThreadId }),
      withTransaction,
      classifyGmailMutationError,
      isStaleCommandClaimError: (error: unknown) => error instanceof StaleCommandClaimError
    }), { outcome: "inconclusive" });
    assert.equal((await commandState(updated.id)).status, "recovery_required");
    const audit = await pool.query<{ metadata: unknown }>("SELECT metadata FROM audit_events WHERE object_id=$1", [updated.id]);
    assert.equal(JSON.stringify(audit.rows).includes("Updated body"), false);
  } finally { await data.cleanup(); }
});

test("create-draft lease recovery never retries a provider execution that may have started", { skip: !available }, async () => {
  const data = await fixture();
  try {
    const created = await createDraftCommand(data.mailboxId);
    const claim = await claimCommand(created.id); assert.ok(claim);
    await withTransaction((client) => markProviderExecutionStarted(client, created.id, claim.claimId));
    await pool.query("UPDATE provider_commands SET lease_expires_at=now()-interval '1 minute' WHERE id=$1", [created.id]);
    await recoverExpiredLeases();
    const state = await commandState(created.id); assert.equal(state.status, "recovery_required"); assert.equal(await claimCommand(created.id), null);
    let providerCalled = false;
    assert.deepEqual(await executeProviderCommand(created.id, executor({ createDraft: async () => { providerCalled = true; return { draftId: "unexpected", messageId: "unexpected", threadId: null }; } })), { outcome: "not_claimed" });
    assert.equal(providerCalled, false);
  } finally { await data.cleanup(); }
});

test("execution markers reject stale claims and make post-provider failures recovery-required while pre-provider failures stay retryable", { skip: !available }, async () => {
  const data = await fixture();
  const providerError = { response: { status: 503, data: {} } };
  try {
    const stale = await createDraftCommand(data.mailboxId); const staleClaim = await claimCommand(stale.id); assert.ok(staleClaim);
    await pool.query("UPDATE provider_commands SET lease_expires_at=now()-interval '1 minute' WHERE id=$1", [stale.id]);
    await assert.rejects(() => withTransaction((client) => markProviderExecutionStarted(client, stale.id, staleClaim.claimId)), StaleCommandClaimError);

    const preProvider = await createDraftCommand(data.mailboxId);
    assert.deepEqual(await executeProviderCommand(preProvider.id, executor({ loadDraftForCreation, gmailForMailbox: () => { throw providerError; } })), { outcome: "retryable" });
    assert.equal((await commandState(preProvider.id)).status, "retryable");

    const uncertain = await createDraftCommand(data.mailboxId);
    assert.deepEqual(await executeProviderCommand(uncertain.id, executor({ loadDraftForCreation, createDraft: async () => { throw providerError; }, confirmDraftCreation })), { outcome: "recovery_required" });
    assert.equal((await commandState(uncertain.id)).status, "recovery_required");
  } finally { await data.cleanup(); }
});

function recoveryExecutor(overrides: Partial<Parameters<typeof verifyCreateDraftRecovery>[1]> = {}) {
  return {
    claimCreateDraftRecovery,
    releaseCreateDraftRecoveryClaim,
    completeRecoveredDraftCreation,
    loadDraftForRecovery,
    findMailboxById,
    gmailForMailbox: () => ({}) as never,
    findDraftByRfc822MessageId: async () => ({ kind: "none" as const }),
    confirmDraftCreation,
    withTransaction,
    classifyGmailMutationError,
    isStaleCommandClaimError: (error: unknown) => error instanceof StaleCommandClaimError,
    ...overrides
  };
}

async function uncertainDraft(data: Awaited<ReturnType<typeof fixture>>) {
  const created = await createDraftCommand(data.mailboxId); const claim = await claimCommand(created.id); assert.ok(claim);
  await withTransaction((client) => markProviderExecutionStarted(client, created.id, claim.claimId));
  await pool.query("UPDATE provider_commands SET lease_expires_at=now()-interval '1 minute' WHERE id=$1", [created.id]); await recoverExpiredLeases();
  return created;
}

test("read-only draft recovery resolves one match and safely retains no-match or ambiguous outcomes", { skip: !available }, async () => {
  const data = await fixture();
  try {
    const one = await uncertainDraft(data);
    assert.deepEqual(await verifyCreateDraftRecovery(one.id, recoveryExecutor({ findDraftByRfc822MessageId: async () => ({ kind: "one", draft: { draftId: "recovered-draft", messageId: "recovered-message", threadId: "recovered-thread" } }) })), { outcome: "succeeded" });
    assert.equal((await commandState(one.id)).status, "succeeded");
    assert.equal((await pool.query<{ gmail_draft_id: string; status: string }>("SELECT gmail_draft_id,status FROM drafts WHERE id=$1", [one.draftId])).rows[0].gmail_draft_id, "recovered-draft");
    assert.deepEqual(await verifyCreateDraftRecovery(one.id, recoveryExecutor()), { outcome: "not_claimed" });
    const audit = await pool.query<{ metadata: unknown }>("SELECT metadata FROM audit_events WHERE object_id=$1", [one.id]);
    const serialized = JSON.stringify(audit.rows); for (const secret of ["recipient@example.test", "Draft subject", "Draft body", "<", "recovered-draft", "recovered-message"]) assert.equal(serialized.includes(secret), false, secret);

    const none = await uncertainDraft(data); assert.deepEqual(await verifyCreateDraftRecovery(none.id, recoveryExecutor()), { outcome: "not_found" }); assert.equal((await commandState(none.id)).status, "recovery_required");
    const ambiguous = await uncertainDraft(data); assert.deepEqual(await verifyCreateDraftRecovery(ambiguous.id, recoveryExecutor({ findDraftByRfc822MessageId: async () => ({ kind: "ambiguous" }) })), { outcome: "ambiguous" }); assert.equal((await commandState(ambiguous.id)).status, "recovery_required");

    const rollback = await uncertainDraft(data);
    assert.deepEqual(await verifyCreateDraftRecovery(rollback.id, recoveryExecutor({ findDraftByRfc822MessageId: async () => ({ kind: "one", draft: { draftId: "rollback-draft", messageId: "rollback-message", threadId: null } }), confirmDraftCreation: async () => { throw new Error("projection failed"); } })), { outcome: "unavailable" });
    assert.equal((await commandState(rollback.id)).status, "recovery_required");
    assert.equal((await pool.query<{ gmail_draft_id: string | null }>("SELECT gmail_draft_id FROM drafts WHERE id=$1", [rollback.draftId])).rows[0].gmail_draft_id, null);

    const stale = await uncertainDraft(data); const claim = await claimCreateDraftRecovery(stale.id); assert.ok(claim); await pool.query("UPDATE provider_commands SET lease_expires_at=now()-interval '1 minute' WHERE id=$1", [stale.id]);
    await assert.rejects(() => withTransaction((client) => completeRecoveredDraftCreation(client, stale.id, claim.claimId, async () => undefined)), StaleCommandClaimError);
    const reclaimed = await claimCreateDraftRecovery(stale.id); assert.ok(reclaimed); assert.notEqual(reclaimed.claimId, claim.claimId);
  } finally { await data.cleanup(); }
});

test("completion is transactional and stale, expired, and malformed claims cannot mutate", { skip: !available }, async () => {
  const data = await fixture();
  try {
    const atomic = await command(data.mailboxId, "archive_thread", "archive-thread");
    const result = await executeProviderCommand(atomic.id, executor({
      completeConfirmedMutation: async (client, commandId, claimId, projection, providerResult) =>
        completeConfirmedMutation(client, commandId, claimId, async () => { await projection(); throw new Error("projection persistence failed"); }, providerResult)
    }));
    assert.deepEqual(result, { outcome: "recovery_required" });
    const projection = await pool.query<{ provider_labels: string[] }>("SELECT provider_labels FROM threads WHERE mailbox_account_id=$1 AND provider_thread_id='archive-thread'", [data.mailboxId]);
    assert.deepEqual(projection.rows[0].provider_labels, ["INBOX", "STARRED"]);
    const atomicState = await commandState(atomic.id);
    assert.equal(atomicState.status, "recovery_required");
    assert.equal(atomicState.provider_result_reference, null);
    assert.equal((await pool.query("SELECT 1 FROM audit_events WHERE object_id=$1", [atomic.id])).rowCount, 0);

    const stale = await command(data.mailboxId, "archive_thread", "archive-thread");
    const staleClaim = await claimCommand(stale.id);
    assert.ok(staleClaim);
    await pool.query("UPDATE provider_commands SET lease_expires_at=now()-interval '1 minute' WHERE id=$1", [stale.id]);
    await assert.rejects(() => withTransaction((client) => loadClaimedCommand(client, stale.id, staleClaim.claimId, key)), StaleCommandClaimError);
    let projectionCalled = false;
    await assert.rejects(() => withTransaction((client) => completeConfirmedMutation(client, stale.id, staleClaim.claimId, async () => { projectionCalled = true; }, "archive_thread")), StaleCommandClaimError);
    await assert.rejects(() => withTransaction((client) => scheduleRetryFromClaim(client, stale.id, staleClaim.claimId, "rate_limited")), StaleCommandClaimError);
    assert.equal(await completeClaim(stale.id, staleClaim.claimId, "failed", "resource_deleted"), false);
    assert.equal(projectionCalled, false);
    assert.equal((await commandState(stale.id)).status, "running");

    const malformed = await command(data.mailboxId, "archive_thread", "archive-thread");
    await pool.query("UPDATE provider_commands SET encrypted_payload=$2 WHERE id=$1", [malformed.id, encryptSecret(JSON.stringify({ providerThreadId: "archive-thread", ignored: "secret" }), key)]);
    const malformedClaim = await claimCommand(malformed.id);
    assert.ok(malformedClaim);
    await assert.rejects(() => withTransaction((client) => loadClaimedCommand(client, malformed.id, malformedClaim.claimId, key)), InvalidCommandPayloadError);
  } finally {
    await data.cleanup();
  }
});

test("worker error handling retries only safe failures and requires recovery for uncertain outcomes", { skip: !available }, async () => {
  const data = await fixture();
  const providerError = (status: number, data: unknown = {}) => ({ response: { status, data } });
  try {
    const retryable = await command(data.mailboxId, "archive_thread", "archive-thread");
    assert.deepEqual(await executeProviderCommand(retryable.id, executor({ archiveThread: async () => { throw providerError(503); } })), { outcome: "retryable" });
    const retryState = await commandState(retryable.id);
    assert.equal(retryState.status, "retryable");
    assert.equal(retryState.attempt_count, 1);
    assert.equal(retryState.failure_code, "transient_provider_failure");

    const limited = await command(data.mailboxId, "archive_thread", "archive-thread");
    assert.deepEqual(await executeProviderCommand(limited.id, executor({ archiveThread: async () => { throw providerError(429); } })), { outcome: "retryable" });
    assert.equal((await commandState(limited.id)).failure_code, "rate_limited");

    const exhausted = await command(data.mailboxId, "archive_thread", "archive-thread");
    await pool.query("UPDATE provider_commands SET attempt_count=7 WHERE id=$1", [exhausted.id]);
    assert.deepEqual(await executeProviderCommand(exhausted.id, executor({ archiveThread: async () => { throw providerError(429); } })), { outcome: "failed" });
    assert.equal((await commandState(exhausted.id)).status, "failed");

    const deleted = await command(data.mailboxId, "archive_thread", "archive-thread");
    assert.deepEqual(await executeProviderCommand(deleted.id, executor({ archiveThread: async () => { throw providerError(404); } })), { outcome: "failed" });
    assert.equal((await commandState(deleted.id)).failure_code, "resource_deleted");

    const scope = await command(data.mailboxId, "archive_thread", "archive-thread");
    assert.deepEqual(await executeProviderCommand(scope.id, executor({ archiveThread: async () => { throw providerError(403, { message: "insufficient authentication scopes" }); } })), { outcome: "recovery_required" });
    assert.equal((await commandState(scope.id)).failure_code, "write_scope_required");

    const revoked = await command(data.mailboxId, "archive_thread", "archive-thread");
    assert.deepEqual(await executeProviderCommand(revoked.id, executor({ archiveThread: async () => { throw providerError(401); } })), { outcome: "recovery_required" });
    assert.equal((await commandState(revoked.id)).failure_code, "reauthorization_required");

    const uncertain = await command(data.mailboxId, "archive_thread", "archive-thread");
    assert.deepEqual(await executeProviderCommand(uncertain.id, executor({ archiveThread: async () => { throw { request: { headers: { authorization: "Bearer secret" } } }; } })), { outcome: "recovery_required" });
    assert.equal((await commandState(uncertain.id)).failure_code, "uncertain_provider_outcome");
    assert.equal(await claimCommand(uncertain.id), null);

    let gmailCalled = false;
    const unsupported = await command(data.mailboxId, "send_draft", "archive-thread");
    await pool.query("UPDATE provider_commands SET encrypted_payload='not-a-valid-payload' WHERE id=$1", [unsupported.id]);
    assert.deepEqual(await executeProviderCommand(unsupported.id, executor({ archiveThread: async () => { gmailCalled = true; } })), { outcome: "unsupported" });
    assert.equal((await commandState(unsupported.id)).failure_code, "unsupported_command");
    assert.equal(gmailCalled, false);
  } finally {
    await data.cleanup();
  }
});
