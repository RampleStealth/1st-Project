import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { pool, withTransaction } from "@aio/database";
import { findMailboxForUser } from "@aio/database/repositories/mailbox-account";
import { upsertThreadProjection } from "@aio/database/repositories/thread-projection";

const databaseAvailable = Boolean(process.env.DATABASE_URL);

async function fixture() {
  const suffix = randomUUID();
  const user = await pool.query<{ id: string }>("INSERT INTO users(email_normalized) VALUES($1) RETURNING id", [`projection-${suffix}@example.test`]);
  const mailbox = await pool.query<{ id: string }>("INSERT INTO mailbox_accounts(user_id,provider,provider_account_id,email_address,encrypted_refresh_token,granted_scopes) VALUES($1,'gmail',$2,$3,'test',ARRAY[]::text[]) RETURNING id", [user.rows[0].id, `projection-${suffix}`, `projection-${suffix}@example.test`]);
  return { userId: user.rows[0].id, mailboxId: mailbox.rows[0].id };
}

test("thread projection upserts are idempotent and refresh list metadata", { skip: !databaseAvailable }, async () => {
  const data = await fixture();
  try {
    const first = await withTransaction((client) => upsertThreadProjection(client, data.mailboxId, { id: "provider-thread", messages: [{ id: "message-1", internalDate: "1700000000000", labelIds: ["INBOX", "UNREAD"], snippet: "First preview", payload: { headers: [{ name: "From", value: "First Sender <first@example.test>" }, { name: "Subject", value: "First subject" }] } }] }));
    const second = await withTransaction((client) => upsertThreadProjection(client, data.mailboxId, { id: "provider-thread", messages: [{ id: "message-1", internalDate: "1700000000000", labelIds: ["INBOX"], snippet: "Updated preview", payload: { headers: [{ name: "From", value: "Second Sender <second@example.test>" }, { name: "Subject", value: "Updated subject" }] } }, { id: "message-2", internalDate: "1700000001000", labelIds: ["INBOX"], snippet: "Latest preview", payload: { headers: [{ name: "From", value: "Latest Sender <latest@example.test>" }, { name: "Subject", value: "Updated subject" }] } }] }));
    assert.equal(first?.id, second?.id);
    assert.equal(second?.subject, "Updated subject");
    assert.equal(second?.latestSender, "Latest Sender <latest@example.test>");
    assert.equal(second?.preview, "Latest preview");
    assert.equal(second?.messageCount, 2);
    assert.equal(second?.unreadCount, 0);
    const messages = await pool.query("SELECT provider_message_id FROM messages WHERE thread_id=$1", [second?.id]);
    assert.equal(messages.rowCount, 2);
  } finally { await pool.query("DELETE FROM users WHERE id=$1", [data.userId]); }
});

test("unchanged thread metadata does not advance the projection version", { skip: !databaseAvailable }, async () => {
  const data = await fixture();
  const providerThread = { id: "stable-provider-thread", messages: [{ id: "stable-message", internalDate: "1700000000000", labelIds: ["INBOX"], snippet: "Stable preview", payload: { headers: [{ name: "From", value: "Sender <sender@example.test>" }, { name: "Subject", value: "Stable subject" }] } }] };
  try {
    const initial = await withTransaction((client) => upsertThreadProjection(client, data.mailboxId, providerThread));
    assert.ok(initial);
    const before = await pool.query<{ sync_version: string }>("SELECT sync_version FROM threads WHERE id=$1", [initial.id]);
    const repeat = await withTransaction((client) => upsertThreadProjection(client, data.mailboxId, providerThread));
    const after = await pool.query<{ sync_version: string }>("SELECT sync_version FROM threads WHERE id=$1", [initial.id]);
    assert.equal(repeat?.id, initial.id);
    assert.equal(after.rows[0].sync_version, before.rows[0].sync_version);
  } finally { await pool.query("DELETE FROM users WHERE id=$1", [data.userId]); }
});

test("mailbox lookup is scoped to its owner", { skip: !databaseAvailable }, async () => {
  const data = await fixture();
  const other = await pool.query<{ id: string }>("INSERT INTO users(email_normalized) VALUES($1) RETURNING id", [`other-${randomUUID()}@example.test`]);
  try {
    assert.equal((await findMailboxForUser(data.mailboxId, data.userId))?.id, data.mailboxId);
    assert.equal(await findMailboxForUser(data.mailboxId, other.rows[0].id), null);
  } finally {
    await pool.query("DELETE FROM users WHERE id=$1", [data.userId]);
    await pool.query("DELETE FROM users WHERE id=$1", [other.rows[0].id]);
  }
});
