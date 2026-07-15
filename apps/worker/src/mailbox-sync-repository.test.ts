import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { pool, withTransaction } from "@aio/database";
import { InvalidHistoryIdError, MissingMailboxSyncStateError, applyProcessedHistory, beginInitialSync, ensureMailboxSyncState, getMailboxSyncState, markInitialSyncRunning, recordPendingHistory, recordSyncFailure } from "@aio/database/repositories/mailbox-sync";

const databaseAvailable = Boolean(process.env.DATABASE_URL);

async function createMailbox() {
  const suffix = randomUUID();
  const user = await pool.query<{ id: string }>("INSERT INTO users(email_normalized) VALUES($1) RETURNING id", [`sync-test-${suffix}@example.test`]);
  const mailbox = await pool.query<{ id: string }>("INSERT INTO mailbox_accounts(user_id,provider,provider_account_id,email_address,encrypted_refresh_token,granted_scopes) VALUES($1,'gmail',$2,$3,'test',ARRAY[]::text[]) RETURNING id", [user.rows[0].id, `sync-test-${suffix}`, `sync-test-${suffix}@example.test`]);
  return { userId: user.rows[0].id, mailboxId: mailbox.rows[0].id };
}

async function removeMailbox(userId: string) {
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
}

test("applied history watermark is monotonic and idempotent", { skip: !databaseAvailable }, async () => {
  const fixture = await createMailbox();
  try {
    await ensureMailboxSyncState(fixture.mailboxId);
    await beginInitialSync(fixture.mailboxId, "100");
    const advanced = await withTransaction((client) => applyProcessedHistory(client, fixture.mailboxId, "200", 30, true));
    const stale = await withTransaction((client) => applyProcessedHistory(client, fixture.mailboxId, "150", 30, false));
    const idempotent = await withTransaction((client) => applyProcessedHistory(client, fixture.mailboxId, "200", 30, false));
    const state = await getMailboxSyncState(fixture.mailboxId);
    const mirror = await pool.query<{ last_history_id: string | null }>("SELECT last_history_id FROM mailbox_accounts WHERE id=$1", [fixture.mailboxId]);
    assert.equal(state?.appliedHistoryId, "200");
    assert.equal(mirror.rows[0].last_history_id, "200");
    assert.equal(advanced.outcome, "advanced");
    assert.equal(stale.outcome, "stale");
    assert.equal(idempotent.outcome, "idempotent");
  } finally {
    await removeMailbox(fixture.userId);
  }
});

test("state mutations reject a missing mailbox sync state", { skip: !databaseAvailable }, async () => {
  const missingMailboxId = randomUUID();
  await assert.rejects(() => recordPendingHistory(missingMailboxId, "100"), MissingMailboxSyncStateError);
  await assert.rejects(() => markInitialSyncRunning(missingMailboxId), MissingMailboxSyncStateError);
  await assert.rejects(() => beginInitialSync(missingMailboxId, "100"), MissingMailboxSyncStateError);
  await assert.rejects(() => recordSyncFailure(missingMailboxId, "test_failure"), MissingMailboxSyncStateError);
  await assert.rejects(() => withTransaction((client) => applyProcessedHistory(client, missingMailboxId, "100", 30, false)), MissingMailboxSyncStateError);
});

test("history IDs are validated before database numeric casts", { skip: !databaseAvailable }, async () => {
  const fixture = await createMailbox();
  try {
    await ensureMailboxSyncState(fixture.mailboxId);
    await assert.rejects(() => recordPendingHistory(fixture.mailboxId, "10.5"), InvalidHistoryIdError);
    await assert.rejects(() => beginInitialSync(fixture.mailboxId, ""), InvalidHistoryIdError);
    await assert.rejects(() => withTransaction((client) => applyProcessedHistory(client, fixture.mailboxId, "abc", 30, false)), InvalidHistoryIdError);
  } finally {
    await removeMailbox(fixture.userId);
  }
});
