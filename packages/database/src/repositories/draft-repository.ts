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
export class DraftRevisionConflictError extends Error { constructor() { super("draft revision conflicts with the current draft"); } }
export class DraftStateConflictError extends Error { constructor() { super("draft is not ready for this operation"); } }
export class ActiveDraftCommandError extends Error { constructor() { super("draft already has an active command"); } }
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

type UpdateDraftInput = EncryptedDraftContent & {
  draftId: string;
  mailboxId: string;
  expectedRevision: number;
  contentFingerprint: string;
  recipientCount: number;
  bodyByteCount: number;
  hasHtml: boolean;
  encryptedCommandPayload: string;
  requestFingerprint: string;
  idempotencyKey: string;
};

type SendDraftInput = {
  draftId: string;
  mailboxId: string;
  expectedRevision: number;
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

/** Returns only the local command identity needed to enqueue an explicit read-only send verification. */
export async function findSendRecoveryCommandForUser(mailboxId: string, draftId: string, userId: string): Promise<{ id: string; status: string } | null> {
  const result = await pool.query<{ id: string; status: string }>(
    `SELECT c.id,c.status FROM provider_commands c
     JOIN drafts d ON d.id=c.draft_id
     JOIN mailbox_accounts m ON m.id=d.mailbox_account_id
     WHERE d.id=$1 AND d.mailbox_account_id=$2 AND m.user_id=$3
       AND c.command_type='send_draft' AND c.status='recovery_required' AND d.last_command_id=c.id AND d.status='recovery_required'`,
    [draftId, mailboxId, userId]
  );
  return result.rows[0] ?? null;
}

/**
 * Locks a ready application draft, records the desired encrypted revision, and
 * creates its update command/outbox event in one transaction.  The command
 * payload contains only local identity and the expected post-save revision.
 */
export async function updateDraftWithCommand(input: UpdateDraftInput): Promise<DraftCommand> {
  return withTransaction(async (client) => {
    const existing = await client.query<{ id: string; command_type: ProviderCommandType; status: ProviderCommandStatus; draft_id: string; request_fingerprint: string }>(
      "SELECT id,command_type,status,draft_id,request_fingerprint FROM provider_commands WHERE mailbox_account_id=$1 AND idempotency_key=$2 FOR UPDATE",
      [input.mailboxId, input.idempotencyKey]
    );
    if (existing.rowCount) {
      const command = existing.rows[0];
      if (command.request_fingerprint !== input.requestFingerprint || command.command_type !== "update_draft" || command.draft_id !== input.draftId) throw new IdempotencyConflictError();
      return { id: command.id, commandType: command.command_type, status: command.status, draftId: command.draft_id };
    }

    const draft = await client.query<StoredDraft>(
      `SELECT ${draftColumns} FROM drafts WHERE id=$1 AND mailbox_account_id=$2 FOR UPDATE`,
      [input.draftId, input.mailboxId]
    );
    if (!draft.rowCount) throw new DraftStateConflictError();
    const current = draft.rows[0];
    if (current.status !== "ready") throw new DraftStateConflictError();
    if (current.revision !== input.expectedRevision) throw new DraftRevisionConflictError();

    const active = await client.query(
      "SELECT id FROM provider_commands WHERE draft_id=$1 AND status IN ('pending','running','retryable','recovery_required') FOR UPDATE",
      [input.draftId]
    );
    if (active.rowCount) throw new ActiveDraftCommandError();

    const nextRevision = current.revision + 1;
    const prepared = await client.query<{ id: string }>(
      `UPDATE drafts
       SET status='updating',revision=$3,content_fingerprint=$4,
           encrypted_recipients=$5,encrypted_subject=$6,encrypted_plain_text=$7,encrypted_html=$8,
           recipient_count=$9,body_byte_count=$10,has_html=$11,updated_at=now()
       WHERE id=$1 AND mailbox_account_id=$2 AND status='ready' AND revision=$12
       RETURNING id`,
      [input.draftId, input.mailboxId, nextRevision, input.contentFingerprint, input.encryptedRecipients, input.encryptedSubject, input.encryptedPlainText, input.encryptedHtml, input.recipientCount, input.bodyByteCount, input.hasHtml, input.expectedRevision]
    );
    if (!prepared.rowCount) throw new DraftRevisionConflictError();
    const command = await client.query<{ id: string; command_type: ProviderCommandType; status: ProviderCommandStatus }>(
      `INSERT INTO provider_commands(mailbox_account_id,draft_id,command_type,encrypted_payload,request_fingerprint,idempotency_key,status)
       VALUES($1,$2,'update_draft',$3,$4,$5,'pending') RETURNING id,command_type,status`,
      [input.mailboxId, input.draftId, input.encryptedCommandPayload, input.requestFingerprint, input.idempotencyKey]
    );
    await client.query("UPDATE drafts SET last_command_id=$2,updated_at=now() WHERE id=$1", [input.draftId, command.rows[0].id]);
    await client.query("INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload) VALUES('provider_command',$1,'provider_command.requested','{}')", [command.rows[0].id]);
    await client.query("INSERT INTO audit_events(actor_type,event_type,object_type,object_id,correlation_id,metadata) VALUES('user','draft.update_requested','draft',$1,gen_random_uuid(),$2)", [input.draftId, JSON.stringify({ revision: nextRevision })]);
    return { id: command.rows[0].id, commandType: command.rows[0].command_type, status: command.rows[0].status, draftId: input.draftId };
  });
}

/**
 * Locks a fully confirmed Gmail draft before creating a single durable send
 * command. The command payload deliberately contains only local draft identity
 * and revision; Gmail identifiers and content stay in the local projection.
 */
export async function sendDraftWithCommand(input: SendDraftInput): Promise<DraftCommand> {
  return withTransaction(async (client) => {
    const existing = await client.query<{ id: string; command_type: ProviderCommandType; status: ProviderCommandStatus; draft_id: string; request_fingerprint: string }>(
      "SELECT id,command_type,status,draft_id,request_fingerprint FROM provider_commands WHERE mailbox_account_id=$1 AND idempotency_key=$2 FOR UPDATE",
      [input.mailboxId, input.idempotencyKey]
    );
    if (existing.rowCount) {
      const command = existing.rows[0];
      if (command.request_fingerprint !== input.requestFingerprint || command.command_type !== "send_draft" || command.draft_id !== input.draftId) throw new IdempotencyConflictError();
      return { id: command.id, commandType: command.command_type, status: command.status, draftId: command.draft_id };
    }

    const draft = await client.query<StoredDraft>(
      `SELECT ${draftColumns} FROM drafts WHERE id=$1 AND mailbox_account_id=$2 FOR UPDATE`,
      [input.draftId, input.mailboxId]
    );
    if (!draft.rowCount) throw new DraftStateConflictError();
    const current = draft.rows[0];
    if (
      current.status !== "ready" ||
      current.revision !== input.expectedRevision ||
      current.confirmedRevision !== input.expectedRevision ||
      current.confirmedContentFingerprint !== current.contentFingerprint ||
      !current.gmailDraftId ||
      !current.gmailDraftMessageId
    ) throw new DraftStateConflictError();

    const active = await client.query(
      "SELECT id FROM provider_commands WHERE draft_id=$1 AND status IN ('pending','running','retryable','recovery_required') FOR UPDATE",
      [input.draftId]
    );
    if (active.rowCount) throw new ActiveDraftCommandError();

    const command = await client.query<{ id: string; command_type: ProviderCommandType; status: ProviderCommandStatus }>(
      `INSERT INTO provider_commands(mailbox_account_id,draft_id,command_type,encrypted_payload,request_fingerprint,idempotency_key,status)
       VALUES($1,$2,'send_draft',$3,$4,$5,'pending') RETURNING id,command_type,status`,
      [input.mailboxId, input.draftId, input.encryptedCommandPayload, input.requestFingerprint, input.idempotencyKey]
    );
    const updated = await client.query(
      "UPDATE drafts SET status='sending',last_command_id=$2,updated_at=now() WHERE id=$1 AND status='ready' AND revision=$3 AND confirmed_revision=$3 AND content_fingerprint=confirmed_content_fingerprint",
      [input.draftId, command.rows[0].id, input.expectedRevision]
    );
    if (!updated.rowCount) throw new DraftStateConflictError();
    await client.query("INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload) VALUES('provider_command',$1,'provider_command.requested','{}')", [command.rows[0].id]);
    await client.query("INSERT INTO audit_events(actor_type,event_type,object_type,object_id,correlation_id,metadata) VALUES('user','draft.send_requested','draft',$1,gen_random_uuid(),$2)", [input.draftId, JSON.stringify({ revision: input.expectedRevision })]);
    return { id: command.rows[0].id, commandType: command.rows[0].command_type, status: command.rows[0].status, draftId: input.draftId };
  });
}

/** Returns encrypted draft content only after the command claim and payload have been verified. */
export async function loadDraftForCreation(client: PoolClient, commandId: string, mailboxId: string, draftId: string): Promise<StoredDraft> {
  const result = await client.query<StoredDraft>(`SELECT ${draftColumns} FROM drafts WHERE id=$1 AND mailbox_account_id=$2 AND last_command_id=$3 AND status='creating' FOR UPDATE`, [draftId, mailboxId, commandId]);
  if (!result.rowCount) throw new Error("draft creation projection is unavailable");
  return result.rows[0];
}

/** Loads the encrypted desired revision only after command claim validation. */
export async function loadDraftForUpdate(client: PoolClient, commandId: string, mailboxId: string, draftId: string, revision: number): Promise<StoredDraft> {
  const result = await client.query<StoredDraft>(
    `SELECT ${draftColumns} FROM drafts
     WHERE id=$1 AND mailbox_account_id=$2 AND last_command_id=$3
       AND status='updating' AND revision=$4 AND gmail_draft_id IS NOT NULL AND gmail_draft_message_id IS NOT NULL
     FOR UPDATE`,
    [draftId, mailboxId, commandId, revision]
  );
  if (!result.rowCount) throw new Error("draft update projection is unavailable");
  return result.rows[0];
}

/** Loads only confirmed provider identity; send never decrypts or rebuilds content. */
export async function loadDraftForSend(client: PoolClient, commandId: string, mailboxId: string, draftId: string, revision: number): Promise<StoredDraft> {
  const result = await client.query<StoredDraft>(
    `SELECT ${draftColumns} FROM drafts
     WHERE id=$1 AND mailbox_account_id=$2 AND last_command_id=$3 AND status='sending'
       AND revision=$4 AND confirmed_revision=$4 AND content_fingerprint=confirmed_content_fingerprint
       AND gmail_draft_id IS NOT NULL AND gmail_draft_message_id IS NOT NULL
     FOR UPDATE`,
    [draftId, mailboxId, commandId, revision]
  );
  if (!result.rowCount) throw new Error("draft send projection is unavailable");
  return result.rows[0];
}

/** Recovery verification needs only the stable Message-ID and local projection identity; no content is decrypted. */
export async function loadDraftForRecovery(client: PoolClient, commandId: string, mailboxId: string): Promise<Pick<StoredDraft, "id" | "rfc822MessageId">> {
  const result = await client.query<Pick<StoredDraft, "id" | "rfc822MessageId">>("SELECT d.id,d.rfc822_message_id AS \"rfc822MessageId\" FROM drafts d JOIN provider_commands c ON c.draft_id=d.id WHERE c.id=$1 AND c.mailbox_account_id=$2 AND c.command_type='create_draft' AND c.status='recovery_required' AND d.last_command_id=c.id AND d.status='creating' FOR UPDATE", [commandId, mailboxId]);
  if (!result.rowCount) throw new Error("draft recovery projection is unavailable");
  return result.rows[0];
}

/** Update verification intentionally reads only stable identity and confirmed provider metadata. */
export async function loadDraftForUpdateRecovery(client: PoolClient, commandId: string, mailboxId: string): Promise<Pick<StoredDraft, "id" | "rfc822MessageId" | "gmailDraftId" | "gmailDraftMessageId">> {
  const result = await client.query<Pick<StoredDraft, "id" | "rfc822MessageId" | "gmailDraftId" | "gmailDraftMessageId">>(
    `SELECT d.id,d.rfc822_message_id AS "rfc822MessageId",d.gmail_draft_id AS "gmailDraftId",d.gmail_draft_message_id AS "gmailDraftMessageId"
     FROM drafts d JOIN provider_commands c ON c.draft_id=d.id
     WHERE c.id=$1 AND c.mailbox_account_id=$2 AND c.command_type='update_draft' AND c.status='recovery_required'
       AND d.last_command_id=c.id AND d.status='updating' AND d.gmail_draft_id IS NOT NULL
     FOR UPDATE`,
    [commandId, mailboxId]
  );
  if (!result.rowCount) throw new Error("draft update recovery projection is unavailable");
  return result.rows[0];
}

/** Read-only send verification uses stable local identity and the last Gmail Draft resource only. */
export async function loadDraftForSendRecovery(client: PoolClient, commandId: string, mailboxId: string): Promise<Pick<StoredDraft, "id" | "revision" | "rfc822MessageId" | "gmailDraftId">> {
  const result = await client.query<Pick<StoredDraft, "id" | "revision" | "rfc822MessageId" | "gmailDraftId">>(
    `SELECT d.id,d.revision,d.rfc822_message_id AS "rfc822MessageId",d.gmail_draft_id AS "gmailDraftId"
     FROM drafts d JOIN provider_commands c ON c.draft_id=d.id
     WHERE c.id=$1 AND c.mailbox_account_id=$2 AND c.command_type='send_draft' AND c.status='recovery_required'
       AND d.last_command_id=c.id AND d.status='recovery_required'
     FOR UPDATE`,
    [commandId, mailboxId]
  );
  if (!result.rowCount) throw new Error("draft send recovery projection is unavailable");
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

/** Must run in the same transaction as provider-command success completion. */
export async function confirmDraftUpdate(client: PoolClient, draftId: string, commandId: string, revision: number, provider: { draftId: string; messageId: string; threadId: string | null }): Promise<void> {
  const result = await client.query(
    `UPDATE drafts
     SET gmail_draft_id=$4,gmail_draft_message_id=$5,gmail_thread_id=$6,status='ready',
         confirmed_revision=$3,confirmed_content_fingerprint=content_fingerprint,
         provider_updated_at=now(),provider_checked_at=now(),updated_at=now()
     WHERE id=$1 AND last_command_id=$2 AND status='updating' AND revision=$3`,
    [draftId, commandId, revision, provider.draftId, provider.messageId, provider.threadId]
  );
  if (!result.rowCount) throw new Error("draft update confirmation projection is unavailable");
}

/** Must run in the same transaction as the provider command's confirmed success. */
export async function confirmDraftSent(client: PoolClient, draftId: string, commandId: string, revision: number, provider: { messageId: string; threadId: string | null; sentAt: Date | null }): Promise<void> {
  const result = await client.query(
    `UPDATE drafts
     SET status='sent',sent_gmail_message_id=$4,sent_at=COALESCE($5,now()),
         gmail_thread_id=COALESCE($6,gmail_thread_id),gmail_draft_id=NULL,gmail_draft_message_id=NULL,
         provider_checked_at=now(),updated_at=now()
     WHERE id=$1 AND last_command_id=$2 AND status IN ('sending','recovery_required') AND revision=$3 AND confirmed_revision=$3
       AND content_fingerprint=confirmed_content_fingerprint`,
    [draftId, commandId, revision, provider.messageId, provider.sentAt, provider.threadId]
  );
  if (!result.rowCount) throw new Error("draft send confirmation projection is unavailable");
}

/** Preserves the encrypted desired revision and last confirmed provider identifiers. */
export async function markDraftConflict(client: PoolClient, draftId: string, commandId: string): Promise<void> {
  const result = await client.query(
    "UPDATE drafts SET status='conflict',conflict_observed_at=now(),provider_checked_at=now(),updated_at=now() WHERE id=$1 AND last_command_id=$2 AND status='updating'",
    [draftId, commandId]
  );
  if (!result.rowCount) throw new Error("draft conflict projection is unavailable");
}

export async function markDraftSendConflict(client: PoolClient, draftId: string, commandId: string): Promise<void> {
  const result = await client.query(
    "UPDATE drafts SET status='conflict',conflict_observed_at=now(),provider_checked_at=now(),updated_at=now() WHERE id=$1 AND last_command_id=$2 AND status='sending'",
    [draftId, commandId]
  );
  if (!result.rowCount) throw new Error("draft send conflict projection is unavailable");
}

export async function markDraftSendRecoveryRequired(client: PoolClient, draftId: string, commandId: string): Promise<void> {
  const result = await client.query(
    "UPDATE drafts SET status='recovery_required',provider_checked_at=now(),updated_at=now() WHERE id=$1 AND last_command_id=$2 AND status='sending'",
    [draftId, commandId]
  );
  if (!result.rowCount) throw new Error("draft send recovery projection is unavailable");
}
