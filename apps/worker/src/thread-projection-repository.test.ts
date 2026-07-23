import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { pool, withTransaction } from "@aio/database";
import { findMailboxForUser } from "@aio/database/repositories/mailbox-account";
import { upsertThreadProjection } from "@aio/database/repositories/thread-projection";
import { normalizeThreadProjection } from "@aio/gmail";

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
    const firstProjection = normalizeThreadProjection({ id: "provider-thread", messages: [{ id: "message-1", internalDate: "1700000000000", labelIds: ["INBOX", "UNREAD"], snippet: "First preview", payload: { headers: [{ name: "From", value: "First Sender <first@example.test>" }, { name: "Subject", value: "First subject" }] } }] });
    const secondProjection = normalizeThreadProjection({ id: "provider-thread", messages: [{ id: "message-1", internalDate: "1700000000000", labelIds: ["INBOX"], snippet: "Updated preview", payload: { headers: [{ name: "From", value: "Second Sender <second@example.test>" }, { name: "Subject", value: "Updated subject" }] } }, { id: "message-2", internalDate: "1700000001000", labelIds: ["INBOX"], snippet: "Latest preview", payload: { headers: [{ name: "From", value: "Latest Sender <latest@example.test>" }, { name: "To", value: '"Owner" <OWNER@example.test>' }, { name: "Cc", value: "copy@example.test" }, { name: "Subject", value: "Updated subject" }], parts: [{ filename: "report.pdf", mimeType: "application/pdf" }] } }] });
    assert.ok(firstProjection && secondProjection);
    const first = await withTransaction((client) => upsertThreadProjection(client, data.mailboxId, firstProjection));
    const second = await withTransaction((client) => upsertThreadProjection(client, data.mailboxId, secondProjection));
    assert.equal(first?.id, second?.id);
    assert.equal(second?.subject, "Updated subject");
    assert.equal(second?.latestSender, "Latest Sender");
    assert.equal(second?.preview, "Latest preview");
    assert.equal(second?.messageCount, 2);
    assert.equal(second?.unreadCount, 0);
    assert.equal(second?.hasAttachments, true);
    const messages = await pool.query<{ provider_message_id: string; from_address: string | null; from_display_name: string | null; to_addresses: unknown; cc_addresses: unknown; has_attachments: boolean }>("SELECT provider_message_id,from_address,from_display_name,to_addresses,cc_addresses,has_attachments FROM messages WHERE thread_id=$1 ORDER BY provider_message_id", [second?.id]);
    assert.equal(messages.rowCount, 2);
    assert.deepEqual(messages.rows[1], {
      provider_message_id: "message-2",
      from_address: "latest@example.test",
      from_display_name: "Latest Sender",
      to_addresses: [{ displayName: "Owner", address: "owner@example.test" }],
      cc_addresses: [{ displayName: null, address: "copy@example.test" }],
      has_attachments: true
    });
    const storedThread = await pool.query<{ latest_sender_address: string; participant_summary: string; has_attachments: boolean }>("SELECT latest_sender_address,participant_summary,has_attachments FROM threads WHERE id=$1", [second?.id]);
    assert.equal(storedThread.rows[0].latest_sender_address, "latest@example.test");
    assert.equal(storedThread.rows[0].participant_summary, "copy@example.test, Latest Sender <latest@example.test>, Owner <owner@example.test>, Second Sender <second@example.test>");
    assert.equal(storedThread.rows[0].has_attachments, true);
  } finally { await pool.query("DELETE FROM users WHERE id=$1", [data.userId]); }
});

test("unchanged thread metadata does not advance the projection version", { skip: !databaseAvailable }, async () => {
  const data = await fixture();
  const providerThread = normalizeThreadProjection({ id: "stable-provider-thread", messages: [{ id: "stable-message", internalDate: "1700000000000", labelIds: ["INBOX"], snippet: "Stable preview", payload: { headers: [{ name: "From", value: "Sender <sender@example.test>" }, { name: "Subject", value: "Stable subject" }] } }] });
  try {
    assert.ok(providerThread);
    const initial = await withTransaction((client) => upsertThreadProjection(client, data.mailboxId, providerThread));
    assert.ok(initial);
    const before = await pool.query<{ sync_version: string }>("SELECT sync_version FROM threads WHERE id=$1", [initial.id]);
    const repeat = await withTransaction((client) => upsertThreadProjection(client, data.mailboxId, providerThread));
    const after = await pool.query<{ sync_version: string }>("SELECT sync_version FROM threads WHERE id=$1", [initial.id]);
    assert.equal(repeat?.id, initial.id);
    assert.equal(after.rows[0].sync_version, before.rows[0].sync_version);
  } finally { await pool.query("DELETE FROM users WHERE id=$1", [data.userId]); }
});

test("missing and future timestamps persist safely without ordering instability", { skip: !databaseAvailable }, async () => {
  const data = await fixture();
  const missing = { providerMessageId: "message-missing", internalTimestamp: null, labels: ["INBOX"], snippet: null, subject: "Unknown time", from: null, to: [], cc: [], hasAttachments: false };
  const future = { providerMessageId: "message-future", internalTimestamp: "2100-01-01T00:00:00.000Z", labels: ["INBOX"], snippet: null, subject: "Future time", from: { displayName: null, address: "future@example.test" }, to: [], cc: [], hasAttachments: false };
  try {
    const initial = await withTransaction((client) => upsertThreadProjection(client, data.mailboxId, { providerThreadId: "timestamp-thread", messages: [future, missing] }));
    assert.ok(initial);
    assert.equal(new Date(initial.lastMessageAt!).toISOString(), future.internalTimestamp);
    const before = await pool.query<{ sync_version: string }>("SELECT sync_version FROM threads WHERE id=$1", [initial.id]);
    await withTransaction((client) => upsertThreadProjection(client, data.mailboxId, { providerThreadId: "timestamp-thread", messages: [missing, future] }));
    const after = await pool.query<{ sync_version: string }>("SELECT sync_version FROM threads WHERE id=$1", [initial.id]);
    assert.equal(after.rows[0].sync_version, before.rows[0].sync_version);
    const timestamps = await pool.query<{ provider_message_id: string; internal_timestamp: Date | null }>("SELECT provider_message_id,internal_timestamp FROM messages WHERE thread_id=$1 ORDER BY provider_message_id", [initial.id]);
    assert.equal(timestamps.rows[1].internal_timestamp, null);
    assert.equal(timestamps.rows[0].internal_timestamp?.toISOString(), future.internalTimestamp);
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
