import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { pool } from "@aio/database";
import { findDraftForUser } from "@aio/database/repositories/draft";

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
