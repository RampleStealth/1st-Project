import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ProviderCommandType } from "@aio/contracts";
import { findMailboxById, pool, withTransaction } from "@aio/database";
import {
  claimCommand,
  completeClaim,
  completeConfirmedMutation,
  InvalidCommandPayloadError,
  loadClaimedCommand,
  scheduleRetryFromClaim,
  StaleCommandClaimError
} from "@aio/database/repositories/provider-command";
import { classifyGmailMutationError } from "@aio/gmail";
import { encryptSecret } from "@aio/security";
import { executeProviderCommand } from "./provider-command-executor.js";

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

function executor(overrides: Partial<Parameters<typeof executeProviderCommand>[1]> = {}) {
  return {
    encryptionKey: key,
    claimCommand,
    loadClaimedCommand,
    findMailboxById,
    gmailForMailbox: () => ({}) as never,
    archiveThread: async () => undefined,
    markThreadUnread: async () => undefined,
    withTransaction,
    completeConfirmedMutation,
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
    const unsupported = await command(data.mailboxId, "create_draft", "archive-thread");
    await pool.query("UPDATE provider_commands SET encrypted_payload='not-a-valid-payload' WHERE id=$1", [unsupported.id]);
    assert.deepEqual(await executeProviderCommand(unsupported.id, executor({ archiveThread: async () => { gmailCalled = true; } })), { outcome: "unsupported" });
    assert.equal((await commandState(unsupported.id)).failure_code, "unsupported_command");
    assert.equal(gmailCalled, false);
  } finally {
    await data.cleanup();
  }
});
