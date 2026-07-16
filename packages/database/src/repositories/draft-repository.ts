import type { PoolClient } from "pg";
import type { ProviderCommandStatus, ProviderCommandType } from "@aio/contracts";
import { pool, withTransaction } from "../index.js";
import { IdempotencyConflictError, type Command } from "./provider-command.js";

export type EncryptedDraftContent = {
  encryptedRecipients: string;
  encryptedSubject: string;
  encryptedPlainText: string;
  encryptedHtml: string | null;
};

export type DraftCommand = Pick<Command, "id" | "commandType" | "status"> & { draftId: string };
export type StoredDraft = EncryptedDraftContent & {
  id: string;
  mailboxAccountId: string;
  status: string;
  revision: number;
  confirmedRevision: number | null;
  rfc822MessageId: string;
  contentFingerprint: string;
  confirmedContentFingerprint: string | null;
  recipientCount: number;
  bodyByteCount: number;
  hasHtml: boolean;
  gmailDraftId: string | null;
  gmailDraftMessageId: string | null;
  gmailThreadId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type CreateDraftInput = EncryptedDraftContent & {
  draftId: string;
  mailboxId: string;
  rfc822MessageId: string;
  contentFingerprint: string;
  recipientCount: number;
  bodyByteCount: number;
  hasHtml: boolean;
  encryptedCommandPayload: string;
  requestFingerprint: string;
  idempotencyKey: string;
};

const draftColumns = `id,mailbox_account_id AS "mailboxAccountId",status,revision,confirmed_revision AS "confirmedRevision",rfc822_message_id AS "rfc822MessageId",content_fingerprint AS "contentFingerprint",confirmed_content_fingerprint AS "confirmedContentFingerprint",encrypted_recipients AS "encryptedRecipients",encrypted_subject AS "encryptedSubject",encrypted_plain_text AS "encryptedPlainText",encrypted_html AS "encryptedHtml",recipient_count AS "recipientCount",body_byte_count AS "bodyByteCount",has_html AS "hasHtml",gmail_draft_id AS "gmailDraftId",gmail_draft_message_id AS "gmailDraftMessageId",gmail_thread_id AS "gmailThreadId",created_at AS "createdAt",updated_at AS "updatedAt"`;

/** Creates the local encrypted draft, command, and durable outbox event atomically. */
export async function createDraftWithCommand(input: CreateDraftInput): Promise<DraftCommand> {
  return withTransaction(async (client) => {
    const existing = await client.query<{ id: string; command_type: ProviderCommandType; status: ProviderCommandStatus; draft_id: string; request_fingerprint: string }>(
      "SELECT id,command_type,status,draft_id,request_fingerprint FROM provider_commands WHERE mailbox_account_id=$1 AND idempotency_key=$2 FOR UPDATE",
      [input.mailboxId, input.idempotencyKey]
    );
    if (existing.rowCount) {
      const command = existing.rows[0];
      if (command.request_fingerprint !== input.requestFingerprint || command.command_type !== "create_draft" || !command.draft_id) throw new IdempotencyConflictError();
      return { id: command.id, commandType: command.command_type, status: command.status, draftId: command.draft_id };
    }
    const draft = await client.query<{ id: string }>(
      `INSERT INTO drafts(id,mailbox_account_id,status,rfc822_message_id,content_fingerprint,encrypted_recipients,encrypted_subject,encrypted_plain_text,encrypted_html,recipient_count,body_byte_count,has_html)
       VALUES($1,$2,'creating',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [input.draftId, input.mailboxId, input.rfc822MessageId, input.contentFingerprint, input.encryptedRecipients, input.encryptedSubject, input.encryptedPlainText, input.encryptedHtml, input.recipientCount, input.bodyByteCount, input.hasHtml]
    );
    const command = await client.query<{ id: string; command_type: ProviderCommandType; status: ProviderCommandStatus }>(
      `INSERT INTO provider_commands(mailbox_account_id,draft_id,command_type,encrypted_payload,request_fingerprint,idempotency_key,status)
       VALUES($1,$2,'create_draft',$3,$4,$5,'pending') RETURNING id,command_type,status`,
      [input.mailboxId, draft.rows[0].id, input.encryptedCommandPayload, input.requestFingerprint, input.idempotencyKey]
    );
    await client.query("UPDATE drafts SET last_command_id=$2,updated_at=now() WHERE id=$1", [draft.rows[0].id, command.rows[0].id]);
    await client.query("INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload) VALUES('provider_command',$1,'provider_command.requested','{}')", [command.rows[0].id]);
    await client.query("INSERT INTO audit_events(actor_type,event_type,object_type,object_id,correlation_id,metadata) VALUES('user','draft.create_requested','draft',$1,gen_random_uuid(),$2)", [draft.rows[0].id, JSON.stringify({ revision: 1 })]);
    return { id: command.rows[0].id, commandType: command.rows[0].command_type, status: command.rows[0].status, draftId: draft.rows[0].id };
  });
}

export async function findDraftForUser(mailboxId: string, draftId: string, userId: string): Promise<StoredDraft | null> {
  const result = await pool.query<StoredDraft>(`SELECT ${draftColumns} FROM drafts d JOIN mailbox_accounts m ON m.id=d.mailbox_account_id WHERE d.id=$1 AND d.mailbox_account_id=$2 AND m.user_id=$3`, [draftId, mailboxId, userId]);
  return result.rows[0] ?? null;
}

/** Returns encrypted draft content only after the command claim and payload have been verified. */
export async function loadDraftForCreation(client: PoolClient, commandId: string, mailboxId: string, draftId: string): Promise<StoredDraft> {
  const result = await client.query<StoredDraft>(`SELECT ${draftColumns} FROM drafts WHERE id=$1 AND mailbox_account_id=$2 AND last_command_id=$3 AND status='creating' FOR UPDATE`, [draftId, mailboxId, commandId]);
  if (!result.rowCount) throw new Error("draft creation projection is unavailable");
  return result.rows[0];
}

/** Recovery verification needs only the stable Message-ID and local projection identity; no content is decrypted. */
export async function loadDraftForRecovery(client: PoolClient, commandId: string, mailboxId: string): Promise<Pick<StoredDraft, "id" | "rfc822MessageId">> {
  const result = await client.query<Pick<StoredDraft, "id" | "rfc822MessageId">>("SELECT d.id,d.rfc822_message_id AS \"rfc822MessageId\" FROM drafts d JOIN provider_commands c ON c.draft_id=d.id WHERE c.id=$1 AND c.mailbox_account_id=$2 AND c.command_type='create_draft' AND c.status='recovery_required' AND d.last_command_id=c.id AND d.status='creating' FOR UPDATE", [commandId, mailboxId]);
  if (!result.rowCount) throw new Error("draft recovery projection is unavailable");
  return result.rows[0];
}

/** Must be called inside completeConfirmedMutation's transaction-scoped projection callback. */
export async function confirmDraftCreation(client: PoolClient, draftId: string, commandId: string, provider: { draftId: string; messageId: string; threadId: string | null }): Promise<void> {
  const result = await client.query(
    `UPDATE drafts SET gmail_draft_id=$3,gmail_draft_message_id=$4,gmail_thread_id=$5,status='ready',confirmed_revision=revision,confirmed_content_fingerprint=content_fingerprint,provider_updated_at=now(),provider_checked_at=now(),updated_at=now()
     WHERE id=$1 AND last_command_id=$2 AND status='creating'`,
    [draftId, commandId, provider.draftId, provider.messageId, provider.threadId]
  );
  if (!result.rowCount) throw new Error("draft confirmation projection is unavailable");
}
