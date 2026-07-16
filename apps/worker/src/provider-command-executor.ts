import type { ProviderCommandType } from "@aio/contracts";
import type { MailboxAccount } from "@aio/database";
import type { LoadedClaimedCommand } from "@aio/database/repositories/provider-command";
import type { gmail_v1 } from "googleapis";
import type { PoolClient } from "pg";
import type { GmailMutationErrorCode } from "@aio/gmail";

type SupportedThreadCommand = Extract<ProviderCommandType, "archive_thread" | "mark_thread_unread">;
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
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  completeConfirmedMutation: (client: PoolClient, commandId: string, claimId: string, projection: () => Promise<void>, providerResult: string) => Promise<void>;
  scheduleRetryFromClaim: (client: PoolClient, commandId: string, claimId: string, failureCode: string) => Promise<{ status: "failed" | "retryable"; delay: number }>;
  completeClaim: (commandId: string, claimId: string, status: "failed" | "recovery_required", failureCode?: string) => Promise<boolean>;
  classifyGmailMutationError: (error: unknown) => GmailMutationErrorCode;
  isStaleCommandClaimError: (error: unknown) => boolean;
};

function isSupportedThreadCommand(commandType: ProviderCommandType): commandType is SupportedThreadCommand {
  return commandType === "archive_thread" || commandType === "mark_thread_unread";
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

  // Reject unsupported future command types before decrypting their payload.
  if (!isSupportedThreadCommand(claim.command.commandType)) {
    return (await dependencies.completeClaim(commandId, claim.claimId, "failed", "unsupported_command"))
      ? { outcome: "unsupported" as const }
      : { outcome: "stale" as const };
  }

  try {
    const loaded = await dependencies.withTransaction((client) =>
      dependencies.loadClaimedCommand(client, commandId, claim.claimId, dependencies.encryptionKey)
    );
    if (loaded.commandType !== "archive_thread" && loaded.commandType !== "mark_thread_unread") {
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
    const providerThreadId = loaded.payload.providerThreadId;

    const mailbox = await dependencies.findMailboxById(claim.command.mailboxAccountId);
    if (!mailbox) {
      return (await dependencies.completeClaim(commandId, claim.claimId, "failed", "mailbox_not_found"))
        ? { outcome: "failed" as const }
        : { outcome: "stale" as const };
    }

    const gmail = dependencies.gmailForMailbox(mailbox);
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
    const code = dependencies.classifyGmailMutationError(error);
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
