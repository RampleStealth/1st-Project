import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { pool } from "@aio/database";
import { findDraftEditEligibilityForUser, findDraftForUser } from "@aio/database/repositories/draft";

const databaseAvailable = Boolean(process.env.DATABASE_URL);

test("owner-scoped draft lookup executes the joined projection query with qualified columns", { skip: !databaseAvailable }, async () => {
  const suffix = randomUUID();
  const user = await pool.query<{ id: string }>("INSERT INTO users(email_normalized) VALUES($1) RETURNING id", [`draft-owner-${suffix}@example.test`]);
  const other = await pool.query<{ id: string }>("INSERT INTO users(email_normalized) VALUES($1) RETURNING id", [`draft-other-${suffix}@example.test`]);
  try {
    const mailbox = await pool.query<{ id: string }>(
      "INSERT INTO mailbox_accounts(user_id,provider,provider_account_id,email_address,encrypted_refresh_token,granted_scopes,status) VALUES($1,'gmail',$2,$3,'encrypted',ARRAY[]::text[],'active') RETURNING id",
      [user.rows[0].id, suffix, `draft-owner-${suffix}@example.test`]
    );
    const draft = await pool.query<{ id: string }>(
      `INSERT INTO drafts(mailbox_account_id,status,revision,confirmed_revision,rfc822_message_id,content_fingerprint,confirmed_content_fingerprint,encrypted_recipients,encrypted_subject,encrypted_plain_text,recipient_count,body_byte_count,has_html,gmail_draft_id,gmail_draft_message_id)
       VALUES($1,'ready',1,1,$2,'fingerprint','fingerprint','encrypted-recipients','encrypted-subject','encrypted-body',1,4,false,$3,$4) RETURNING id`,
      [mailbox.rows[0].id, `<${suffix}@drafts.example.test>`, `gmail-draft-${suffix}`, `gmail-message-${suffix}`]
    );

    const owned = await findDraftForUser(mailbox.rows[0].id, draft.rows[0].id, user.rows[0].id);
    assert.equal(owned?.id, draft.rows[0].id);
    assert.equal(owned?.mailboxAccountId, mailbox.rows[0].id);
    assert.equal(owned?.status, "ready");
    assert.equal(owned?.confirmedRevision, 1);
    assert.equal((await findDraftForUser(mailbox.rows[0].id, draft.rows[0].id, other.rows[0].id)), null);
  } finally {
    await pool.query("DELETE FROM users WHERE id IN ($1,$2)", [user.rows[0].id, other.rows[0].id]);
  }
});

test("provider-thread draft edit lookup rejects zero, ambiguous, unsafe, active, and cross-owner matches", { skip: !databaseAvailable }, async () => {
  const suffix = randomUUID();
  const user = await pool.query<{ id: string }>("INSERT INTO users(email_normalized) VALUES($1) RETURNING id", [`draft-edit-${suffix}@example.test`]);
  const other = await pool.query<{ id: string }>("INSERT INTO users(email_normalized) VALUES($1) RETURNING id", [`draft-edit-other-${suffix}@example.test`]);
  try {
    const mailbox = await pool.query<{ id: string }>(
      "INSERT INTO mailbox_accounts(user_id,provider,provider_account_id,email_address,encrypted_refresh_token,granted_scopes,status) VALUES($1,'gmail',$2,$3,'encrypted',ARRAY[]::text[],'active') RETURNING id",
      [user.rows[0].id, suffix, `draft-edit-${suffix}@example.test`]
    );
    await pool.query("INSERT INTO mailbox_permission_state(mailbox_account_id,write_capability,granted_scopes) VALUES($1,'write_granted',ARRAY['https://www.googleapis.com/auth/gmail.modify']::text[])", [mailbox.rows[0].id]);
    const threadId = `gmail-thread-${suffix}`;
    assert.equal(await findDraftEditEligibilityForUser(mailbox.rows[0].id, threadId, user.rows[0].id), null);

    const insertDraft = async (ordinal: number) => (await pool.query<{ id: string }>(
      `INSERT INTO drafts(mailbox_account_id,status,revision,confirmed_revision,rfc822_message_id,content_fingerprint,confirmed_content_fingerprint,encrypted_recipients,encrypted_subject,encrypted_plain_text,recipient_count,body_byte_count,has_html,gmail_draft_id,gmail_draft_message_id,gmail_thread_id)
       VALUES($1,'ready',1,1,$2,'fingerprint','fingerprint','encrypted-recipients','encrypted-subject','encrypted-body',1,4,false,$3,$4,$5) RETURNING id`,
      [mailbox.rows[0].id, `<${ordinal}-${suffix}@drafts.example.test>`, `gmail-draft-${ordinal}-${suffix}`, `gmail-message-${ordinal}-${suffix}`, threadId]
    )).rows[0].id;

    const first = await insertDraft(1);
    assert.deepEqual(await findDraftEditEligibilityForUser(mailbox.rows[0].id, threadId, user.rows[0].id), { draftId: first, writeGranted: true });
    assert.equal(await findDraftEditEligibilityForUser(mailbox.rows[0].id, threadId, other.rows[0].id), null);

    const second = await insertDraft(2);
    assert.equal(await findDraftEditEligibilityForUser(mailbox.rows[0].id, threadId, user.rows[0].id), null, "multiple local drafts in one Gmail thread must remain ambiguous");
    await pool.query("UPDATE drafts SET gmail_thread_id=$2 WHERE id=$1", [second, `other-${threadId}`]);

    await pool.query("UPDATE drafts SET confirmed_revision=NULL WHERE id=$1", [first]);
    assert.equal(await findDraftEditEligibilityForUser(mailbox.rows[0].id, threadId, user.rows[0].id), null);
    await pool.query("UPDATE drafts SET confirmed_revision=revision WHERE id=$1", [first]);

    await pool.query("UPDATE drafts SET status='updating' WHERE id=$1", [first]);
    assert.equal(await findDraftEditEligibilityForUser(mailbox.rows[0].id, threadId, user.rows[0].id), null);
    await pool.query("UPDATE drafts SET status='ready',gmail_draft_message_id=NULL WHERE id=$1", [first]);
    assert.equal(await findDraftEditEligibilityForUser(mailbox.rows[0].id, threadId, user.rows[0].id), null);
    await pool.query("UPDATE drafts SET gmail_draft_message_id=$2 WHERE id=$1", [first, `gmail-message-1-${suffix}`]);

    await pool.query(
      "INSERT INTO provider_commands(mailbox_account_id,draft_id,command_type,encrypted_payload,request_fingerprint,idempotency_key,status,correlation_id) VALUES($1,$2,'update_draft','encrypted','fingerprint',$3,'pending',$4)",
      [mailbox.rows[0].id, first, randomUUID(), randomUUID()]
    );
    assert.equal(await findDraftEditEligibilityForUser(mailbox.rows[0].id, threadId, user.rows[0].id), null);
    await pool.query("DELETE FROM provider_commands WHERE draft_id=$1", [first]);

    await pool.query("UPDATE mailbox_permission_state SET write_capability='read_only' WHERE mailbox_account_id=$1", [mailbox.rows[0].id]);
    assert.deepEqual(await findDraftEditEligibilityForUser(mailbox.rows[0].id, threadId, user.rows[0].id), { draftId: first, writeGranted: false });
  } finally {
    await pool.query("DELETE FROM users WHERE id IN ($1,$2)", [user.rows[0].id, other.rows[0].id]);
  }
});
