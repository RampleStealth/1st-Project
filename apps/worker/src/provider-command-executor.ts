import type { ProviderCommandType } from "@aio/contracts";
import type { MailboxAccount } from "@aio/database";
import { InvalidCommandPayloadError, type LoadedClaimedCommand } from "@aio/database/repositories/provider-command";
import type { gmail_v1 } from "googleapis";
import type { PoolClient } from "pg";
import type { GmailMutationErrorCode } from "@aio/gmail";
import type { GmailDraftReference } from "@aio/gmail";
import type { DraftMessageIdSearch } from "@aio/gmail";
import type { StoredDraft } from "@aio/database/repositories/draft";
import { buildDraftMime } from "@aio/gmail";
import { decryptDraftContent } from "@aio/security";

type SupportedThreadCommand = Extract<ProviderCommandType, "archive_thread" | "mark_thread_unread">;
type SupportedCommand = SupportedThreadCommand | "create_draft" | "update_draft";
type CommandClaim = { claimId: string; command: { mailboxAccountId: string; commandType: ProviderCommandType } };
type LoadedCommand = LoadedClaimedCommand;

export class MissingThreadProjectionError extends Error {
  constructor() {
    super("thread projection is missing");
    this.name = "MissingThreadProjectionError";
  }
}

export type ProviderCommandExecutorDependencies = {
  encryptionKey: string;
  claimCommand: (commandId: string) => Promise<CommandClaim | null>;
  loadClaimedCommand: (client: PoolClient, commandId: string, claimId: string, encryptionKey: string) => Promise<LoadedCommand>;
  findMailboxById: (mailboxId: string) => Promise<MailboxAccount | null>;
  gmailForMailbox: (mailbox: MailboxAccount) => gmail_v1.Gmail;
  archiveThread: (gmail: gmail_v1.Gmail, providerThreadId: string) => Promise<void>;
  markThreadUnread: (gmail: gmail_v1.Gmail, providerThreadId: string) => Promise<void>;
  loadDraftForCreation: (client: PoolClient, commandId: string, mailboxId: string, draftId: string) => Promise<StoredDraft>;
  createDraft: (gmail: gmail_v1.Gmail, mime: string) => Promise<GmailDraftReference>;
  confirmDraftCreation: (client: PoolClient, draftId: string, commandId: string, provider: GmailDraftReference) => Promise<void>;
  loadDraftForUpdate: (client: PoolClient, commandId: string, mailboxId: string, draftId: string, revision: number) => Promise<StoredDraft>;
  getDraft: (gmail: gmail_v1.Gmail, draftId: string) => Promise<GmailDraftReference>;
  updateDraft: (gmail: gmail_v1.Gmail, draftId: string, mime: string) => Promise<GmailDraftReference>;
  confirmDraftUpdate: (client: PoolClient, draftId: string, commandId: string, revision: number, provider: GmailDraftReference) => Promise<void>;
  markDraftConflict: (client: PoolClient, draftId: string, commandId: string) => Promise<void>;
  markProviderExecutionStarted: (client: PoolClient, commandId: string, claimId: string) => Promise<void>;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  completeConfirmedMutation: (client: PoolClient, commandId: string, claimId: string, projection: () => Promise<void>, providerResult: string) => Promise<void>;
  completeFailedMutation: (client: PoolClient, commandId: string, claimId: string, failureCode: string, projection: () => Promise<void>) => Promise<void>;
  scheduleRetryFromClaim: (client: PoolClient, commandId: string, claimId: string, failureCode: string) => Promise<{ status: "failed" | "retryable"; delay: number }>;
  completeClaim: (commandId: string, claimId: string, status: "failed" | "recovery_required", failureCode?: string) => Promise<boolean>;
  classifyGmailMutationError: (error: unknown) => GmailMutationErrorCode;
  isStaleCommandClaimError: (error: unknown) => boolean;
};

function isSupportedCommand(commandType: ProviderCommandType): commandType is SupportedCommand {
  return commandType === "archive_thread" || commandType === "mark_thread_unread" || commandType === "create_draft" || commandType === "update_draft";
}

export async function applyConfirmedThreadProjection(
  client: PoolClient,
  mailboxId: string,
  providerThreadId: string,
  commandType: SupportedThreadCommand
) {
  const labels = commandType === "archive_thread"
    ? "array_remove(provider_labels,'INBOX')"
    : "CASE WHEN provider_labels @> ARRAY['UNREAD'] THEN provider_labels ELSE array_append(provider_labels,'UNREAD') END";
  const result = await client.query(
    `UPDATE threads
       SET provider_labels=${labels},
           unread_count=CASE WHEN $2='mark_thread_unread' THEN GREATEST(unread_count,1) ELSE unread_count END,
           updated_at=now()
     WHERE mailbox_account_id=$1 AND provider_thread_id=$3`,
    [mailboxId, commandType, providerThreadId]
  );
  if (!result.rowCount) throw new MissingThreadProjectionError();
}

export async function executeProviderCommand(commandId: string, dependencies: ProviderCommandExecutorDependencies) {
  const claim = await dependencies.claimCommand(commandId);
  if (!claim) return { outcome: "not_claimed" as const };
  let providerExecutionStarted = false;

  // Reject unsupported future command types before decrypting their payload.
  if (!isSupportedCommand(claim.command.commandType)) {
    return (await dependencies.completeClaim(commandId, claim.claimId, "failed", "unsupported_command"))
      ? { outcome: "unsupported" as const }
      : { outcome: "stale" as const };
  }

  try {
    const loaded = await dependencies.withTransaction((client) =>
      dependencies.loadClaimedCommand(client, commandId, claim.claimId, dependencies.encryptionKey)
    );
    if (loaded.commandType !== "archive_thread" && loaded.commandType !== "mark_thread_unread" && loaded.commandType !== "create_draft" && loaded.commandType !== "update_draft") {
      return (await dependencies.completeClaim(commandId, claim.claimId, "failed", "unsupported_command"))
        ? { outcome: "unsupported" as const }
        : { outcome: "stale" as const };
    }
    const commandType = loaded.commandType;
    if (commandType !== claim.command.commandType) {
      return (await dependencies.completeClaim(commandId, claim.claimId, "failed", "unsupported_command"))
        ? { outcome: "unsupported" as const }
        : { outcome: "stale" as const };
    }
    const mailbox = await dependencies.findMailboxById(claim.command.mailboxAccountId);
    if (!mailbox) {
      return (await dependencies.completeClaim(commandId, claim.claimId, "failed", "mailbox_not_found"))
        ? { outcome: "failed" as const }
        : { outcome: "stale" as const };
    }

    const gmail = dependencies.gmailForMailbox(mailbox);
    if (commandType === "create_draft") {
      const draft = await dependencies.withTransaction((client) => dependencies.loadDraftForCreation(client, commandId, mailbox.id, loaded.payload.draftId));
      // The encrypted content is only opened inside this verified worker execution path.
      const content = decryptDraftContent(draft, dependencies.encryptionKey);
      const mime = buildDraftMime(content, { messageId: draft.rfc822MessageId });
      // This is deliberately committed before Gmail. A process crash after this point is recovery_required, never a blind retry.
      await dependencies.withTransaction((client) => dependencies.markProviderExecutionStarted(client, commandId, claim.claimId));
      providerExecutionStarted = true;
      const provider = await dependencies.createDraft(gmail, mime.mime);
      await dependencies.withTransaction((client) => dependencies.completeConfirmedMutation(
        client, commandId, claim.claimId,
        () => dependencies.confirmDraftCreation(client, draft.id, commandId, provider),
        "create_draft"
      ));
      return { outcome: "succeeded" as const };
    }
    if (commandType === "update_draft") {
      const draft = await dependencies.withTransaction((client) => dependencies.loadDraftForUpdate(client, commandId, mailbox.id, loaded.payload.draftId, loaded.payload.revision));
      // Metadata preflight prevents us from overwriting a Gmail-native external change.
      let providerBefore: GmailDraftReference;
      try { providerBefore = await dependencies.getDraft(gmail, draft.gmailDraftId!); }
      catch (error) {
        if (dependencies.classifyGmailMutationError(error) === "resource_deleted") {
          await dependencies.withTransaction((client) => dependencies.completeFailedMutation(
            client, commandId, claim.claimId, "resource_deleted",
            () => dependencies.markDraftConflict(client, draft.id, commandId)
          ));
          return { outcome: "failed" as const };
        }
        throw error;
      }
      if (providerBefore.messageId !== draft.gmailDraftMessageId) {
        await dependencies.withTransaction((client) => dependencies.completeFailedMutation(
          client, commandId, claim.claimId, "external_draft_conflict",
          () => dependencies.markDraftConflict(client, draft.id, commandId)
        ));
        return { outcome: "conflict" as const };
      }
      // The desired content remains encrypted at rest and is opened only after the preflight passes.
      const content = decryptDraftContent(draft, dependencies.encryptionKey);
      const mime = buildDraftMime(content, { messageId: draft.rfc822MessageId });
      await dependencies.withTransaction((client) => dependencies.markProviderExecutionStarted(client, commandId, claim.claimId));
      providerExecutionStarted = true;
      const provider = await dependencies.updateDraft(gmail, draft.gmailDraftId!, mime.mime);
      await dependencies.withTransaction((client) => dependencies.completeConfirmedMutation(
        client, commandId, claim.claimId,
        () => dependencies.confirmDraftUpdate(client, draft.id, commandId, loaded.payload.revision, provider),
        "update_draft"
      ));
      return { outcome: "succeeded" as const };
    }
    const providerThreadId = loaded.payload.providerThreadId;
    if (commandType === "archive_thread") await dependencies.archiveThread(gmail, providerThreadId);
    else await dependencies.markThreadUnread(gmail, providerThreadId);

    await dependencies.withTransaction((client) =>
      dependencies.completeConfirmedMutation(
        client,
        commandId,
        claim.claimId,
        () => applyConfirmedThreadProjection(client, mailbox.id, providerThreadId, commandType),
        commandType
      )
    );
    return { outcome: "succeeded" as const };
  } catch (error) {
    if (dependencies.isStaleCommandClaimError(error)) return { outcome: "stale" as const };
    if (error instanceof InvalidCommandPayloadError) {
      return (await dependencies.completeClaim(commandId, claim.claimId, "failed", "invalid_command_payload"))
        ? { outcome: "failed" as const }
        : { outcome: "stale" as const };
    }
    const code = dependencies.classifyGmailMutationError(error);
    // Draft create/update calls may have reached Gmail once their durable execution marker exists. Never retry that uncertainty automatically.
    if (providerExecutionStarted) {
      return (await dependencies.completeClaim(commandId, claim.claimId, "recovery_required", code))
        ? { outcome: "recovery_required" as const }
        : { outcome: "stale" as const };
    }
    if (code === "rate_limited" || code === "transient_provider_failure") {
      try {
        const retry = await dependencies.withTransaction((client) => dependencies.scheduleRetryFromClaim(client, commandId, claim.claimId, code));
        return { outcome: retry.status === "failed" ? "failed" as const : "retryable" as const };
      } catch (retryError) {
        if (dependencies.isStaleCommandClaimError(retryError)) return { outcome: "stale" as const };
        throw retryError;
      }
    }
    if (code === "resource_deleted") {
      return (await dependencies.completeClaim(commandId, claim.claimId, "failed", code))
        ? { outcome: "failed" as const }
        : { outcome: "stale" as const };
    }
    return (await dependencies.completeClaim(commandId, claim.claimId, "recovery_required", code))
      ? { outcome: "recovery_required" as const }
      : { outcome: "stale" as const };
  }
}

export type CreateDraftRecoveryDependencies = {
  claimCreateDraftRecovery: (commandId: string) => Promise<CommandClaim | null>;
  releaseCreateDraftRecoveryClaim: (commandId: string, claimId: string, failureCode: string) => Promise<boolean>;
  completeRecoveredDraftCreation: (client: PoolClient, commandId: string, claimId: string, projection: () => Promise<void>) => Promise<void>;
  loadDraftForRecovery: (client: PoolClient, commandId: string, mailboxId: string) => Promise<{ id: string; rfc822MessageId: string }>;
  findMailboxById: (mailboxId: string) => Promise<MailboxAccount | null>;
  gmailForMailbox: (mailbox: MailboxAccount) => gmail_v1.Gmail;
  findDraftByRfc822MessageId: (gmail: gmail_v1.Gmail, messageId: string) => Promise<DraftMessageIdSearch>;
  confirmDraftCreation: (client: PoolClient, draftId: string, commandId: string, provider: GmailDraftReference) => Promise<void>;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  classifyGmailMutationError: (error: unknown) => GmailMutationErrorCode;
  isStaleCommandClaimError: (error: unknown) => boolean;
};

/** Read-only, explicitly invoked verification. It never calls Gmail drafts.create or requeues the original command. */
export async function verifyCreateDraftRecovery(commandId: string, dependencies: CreateDraftRecoveryDependencies) {
  const claim = await dependencies.claimCreateDraftRecovery(commandId);
  if (!claim) return { outcome: "not_claimed" as const };
  try {
    const mailbox = await dependencies.findMailboxById(claim.command.mailboxAccountId);
    if (!mailbox || mailbox.status !== "active") {
      await dependencies.releaseCreateDraftRecoveryClaim(commandId, claim.claimId, "reauthorization_required");
      return { outcome: "reauthorization_required" as const };
    }
    const draft = await dependencies.withTransaction((client) => dependencies.loadDraftForRecovery(client, commandId, mailbox.id));
    const result = await dependencies.findDraftByRfc822MessageId(dependencies.gmailForMailbox(mailbox), draft.rfc822MessageId);
    if (result.kind === "none") { await dependencies.releaseCreateDraftRecoveryClaim(commandId, claim.claimId, "draft_recovery_not_found"); return { outcome: "not_found" as const }; }
    if (result.kind === "ambiguous") { await dependencies.releaseCreateDraftRecoveryClaim(commandId, claim.claimId, "draft_recovery_ambiguous"); return { outcome: "ambiguous" as const }; }
    await dependencies.withTransaction((client) => dependencies.completeRecoveredDraftCreation(client, commandId, claim.claimId, () => dependencies.confirmDraftCreation(client, draft.id, commandId, result.draft)));
    return { outcome: "succeeded" as const };
  } catch (error) {
    if (dependencies.isStaleCommandClaimError(error)) return { outcome: "stale" as const };
    const failure = dependencies.classifyGmailMutationError(error);
    await dependencies.releaseCreateDraftRecoveryClaim(commandId, claim.claimId, failure);
    return { outcome: failure === "write_scope_required" ? "permission_required" as const : failure === "reauthorization_required" ? "reauthorization_required" as const : "unavailable" as const };
  }
}

export type UpdateDraftRecoveryDependencies = {
  claimUpdateDraftRecovery: (commandId: string) => Promise<CommandClaim | null>;
  releaseUpdateDraftRecoveryClaim: (commandId: string, claimId: string, failureCode: string) => Promise<boolean>;
  loadDraftForUpdateRecovery: (client: PoolClient, commandId: string, mailboxId: string) => Promise<{ id: string; rfc822MessageId: string; gmailDraftId: string | null; gmailDraftMessageId: string | null }>;
  findMailboxById: (mailboxId: string) => Promise<MailboxAccount | null>;
  gmailForMailbox: (mailbox: MailboxAccount) => gmail_v1.Gmail;
  getDraft: (gmail: gmail_v1.Gmail, draftId: string) => Promise<GmailDraftReference>;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  classifyGmailMutationError: (error: unknown) => GmailMutationErrorCode;
  isStaleCommandClaimError: (error: unknown) => boolean;
};

/**
 * Gmail metadata cannot bind an updated draft-message ID to this local content
 * fingerprint: the application Message-ID is stable by design and raw MIME is
 * forbidden here. This read-only check is intentionally conservative.
 */
export async function verifyUpdateDraftRecovery(commandId: string, dependencies: UpdateDraftRecoveryDependencies) {
  const claim = await dependencies.claimUpdateDraftRecovery(commandId);
  if (!claim) return { outcome: "not_claimed" as const };
  try {
    const mailbox = await dependencies.findMailboxById(claim.command.mailboxAccountId);
    if (!mailbox || mailbox.status !== "active") {
      await dependencies.releaseUpdateDraftRecoveryClaim(commandId, claim.claimId, "reauthorization_required");
      return { outcome: "reauthorization_required" as const };
    }
    const draft = await dependencies.withTransaction((client) => dependencies.loadDraftForUpdateRecovery(client, commandId, mailbox.id));
    // Read only the known Gmail Draft resource. Neither the Message-ID nor provider IDs are logged or exposed.
    const current = await dependencies.getDraft(dependencies.gmailForMailbox(mailbox), draft.gmailDraftId!);
    // Gmail Draft metadata exposes no Message-ID header selector. The local stable
    // identity is therefore retained for future proof, but cannot prove content.
    const evidence = Boolean(draft.rfc822MessageId) && current.messageId === draft.gmailDraftMessageId
      ? "provider_version_unchanged"
      : "provider_version_changed";
    await dependencies.releaseUpdateDraftRecoveryClaim(commandId, claim.claimId, `draft_update_verification_${evidence}_inconclusive`);
    return { outcome: "inconclusive" as const };
  } catch (error) {
    if (dependencies.isStaleCommandClaimError(error)) return { outcome: "stale" as const };
    const failure = dependencies.classifyGmailMutationError(error);
    await dependencies.releaseUpdateDraftRecoveryClaim(commandId, claim.claimId, failure);
    return { outcome: failure === "write_scope_required" ? "permission_required" as const : failure === "reauthorization_required" ? "reauthorization_required" as const : "unavailable" as const };
  }
}
