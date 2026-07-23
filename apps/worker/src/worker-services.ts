import type { AppConfig } from "@aio/config";
import { findMailboxById, pool, withTransaction, type MailboxAccount } from "@aio/database";
import { applyProcessedHistory, beginInitialSync, claimDueReconciliations, ensureMailboxSyncState, getMailboxSyncState, recordSyncFailure, releaseReconciliationClaim } from "@aio/database/repositories/mailbox-sync";
import { upsertThreadProjection } from "@aio/database/repositories/thread-projection";
import { getWorkerDatabaseDiagnostics, markWorkerDraining, markWorkerStopped, recordWorkerHeartbeat, recordWorkerStarted, repairInconsistentDraftStates } from "@aio/database/repositories/worker-runtime";
import { archiveThread, changedMessageIds, classifyGmailError, classifyGmailMutationError, createDraft, currentHistoryId, findDraftByRfc822MessageId, findSentMessageByRfc822MessageId, getDraft, getMessage, gmailForMailbox, hydrateThreadMetadata, initialThreadIds, isGmailProviderError, markThreadUnread, sanitizeGmailMutationError, sanitizeGmailProviderError, sendDraft, updateDraft, watchMailbox } from "@aio/gmail";
import { closeQueues, enqueueProviderCommand, enqueueSync, gmailCommandsQueue, syncQueue } from "@aio/jobs";
import { logger, metrics } from "@aio/observability";
import type { SyncErrorCode, SyncJob, ThreadProjectionInput } from "@aio/contracts";
import { hasUnprocessedPendingHistory, shouldRetryForUnavailableHistory } from "./sync-state.js";
import { claimCommand, claimCreateDraftRecovery, claimOutboxEvents, claimSendDraftRecovery, claimUpdateDraftRecovery, completeClaim, completeConfirmedMutation, completeFailedMutation, completeRecoveredDraftCreation, completeRecoveredDraftSend, completeRecoveryRequiredMutation, loadClaimedCommand, markOutboxPublished, markProviderExecutionStarted, recoverExpiredLeases, releaseCreateDraftRecoveryClaim, releaseOutboxClaim, releaseSendDraftRecoveryClaim, releaseUpdateDraftRecoveryClaim, scheduleRetryFromClaim, StaleCommandClaimError } from "@aio/database/repositories/provider-command";
import { executeProviderCommand, verifyCreateDraftRecovery, verifySendDraftRecovery, verifyUpdateDraftRecovery } from "./provider-command-executor.js";
import { confirmDraftCreation, confirmDraftSent, confirmDraftUpdate, loadDraftForCreation, loadDraftForRecovery, loadDraftForSend, loadDraftForSendRecovery, loadDraftForUpdate, loadDraftForUpdateRecovery, markDraftConflict, markDraftSendConflict, markDraftSendRecoveryRequired } from "@aio/database/repositories/draft";
import type { WorkerRuntimeServices } from "./worker-runtime.js";

class MailboxLeaseUnavailable extends Error {}

async function withMailboxLease<T>(mailboxId: string, work: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [mailboxId]);
    if (!lock.rows[0].locked) throw new MailboxLeaseUnavailable(`Mailbox ${mailboxId} is already synchronizing`);
    return await work();
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [mailboxId]).catch(() => undefined);
    client.release();
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await mapper(items[index]); } }));
  return results;
}

const outboxDispatchConcurrency = 5;

type HistoryBatch = { processedHistoryId: string; deletedMessageIds: string[]; threads: ThreadProjectionInput[] };

export function createWorkerServices(config: AppConfig): WorkerRuntimeServices {
  const commandDependencies = {
    encryptionKey: config.TOKEN_ENCRYPTION_KEY_BASE64, claimCommand, loadClaimedCommand, findMailboxById,
    gmailForMailbox: (mailbox: MailboxAccount) => gmailForMailbox(config, mailbox.encrypted_refresh_token), archiveThread, markThreadUnread,
    loadDraftForCreation, createDraft, confirmDraftCreation, loadDraftForUpdate, getDraft, updateDraft, confirmDraftUpdate, markDraftConflict,
    loadDraftForSend, sendDraft, confirmDraftSent, markDraftSendConflict, markDraftSendRecoveryRequired, markProviderExecutionStarted,
    withTransaction, completeConfirmedMutation, completeFailedMutation, completeRecoveryRequiredMutation, scheduleRetryFromClaim, completeClaim,
    classifyGmailMutationError,
    logGmailMutationFailure: (error: unknown, context: { commandId: string; correlationId?: string; mailboxId: string; operation: string }) => {
      if (isGmailProviderError(error)) logger.warn(sanitizeGmailMutationError(error, context), "Gmail provider command failed");
    },
    isStaleCommandClaimError: (error: unknown) => error instanceof StaleCommandClaimError
  };
  const fetchThreads = (gmail: ReturnType<typeof gmailForMailbox>, ids: string[]) => hydrateThreadMetadata(gmail, ids, 5);
  const collectHistoryChanges = async (gmail: ReturnType<typeof gmailForMailbox>, startHistoryId: string): Promise<HistoryBatch> => {
    const changes = await changedMessageIds(gmail, startHistoryId);
    const ids = await mapWithConcurrency(changes.messageIds, 5, async (messageId) => {
      try { return (await getMessage(gmail, messageId)).threadId; }
      catch (error) { if (classifyGmailError(error, "resource") === "resource_deleted") return undefined; throw error; }
    });
    return { processedHistoryId: changes.latestHistoryId ?? startHistoryId, deletedMessageIds: changes.deletedMessageIds, threads: await fetchThreads(gmail, [...new Set(ids.filter(Boolean) as string[])]) };
  };
  const persistHistoryBatch = async (client: Parameters<typeof upsertThreadProjection>[0], mailboxId: string, batch: HistoryBatch) => {
    if (batch.deletedMessageIds.length) {
      await client.query("DELETE FROM messages USING threads WHERE messages.thread_id=threads.id AND threads.mailbox_account_id=$1 AND messages.provider_message_id = ANY($2)", [mailboxId, batch.deletedMessageIds]);
      await client.query("DELETE FROM threads WHERE mailbox_account_id=$1 AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.thread_id=threads.id)", [mailboxId]);
    }
    for (const thread of batch.threads) await upsertThreadProjection(client, mailboxId, thread);
  };
  const runInitialSync = async (mailboxId: string, gmail: ReturnType<typeof gmailForMailbox>, forceNewBaseline: boolean) => {
    const state = await getMailboxSyncState(mailboxId); if (!state) throw new Error(`Mailbox sync state missing for ${mailboxId}`);
    const baseline = forceNewBaseline || !state.initialBaselineHistoryId ? await currentHistoryId(gmail) : state.initialBaselineHistoryId;
    await beginInitialSync(mailboxId, baseline);
    const initialThreads = await fetchThreads(gmail, await initialThreadIds(gmail, config.GMAIL_INITIAL_SYNC_LIMIT));
    const batch = await collectHistoryChanges(gmail, baseline);
    return (await withTransaction(async (client) => { for (const thread of initialThreads) await upsertThreadProjection(client, mailboxId, thread); await persistHistoryBatch(client, mailboxId, batch); return applyProcessedHistory(client, mailboxId, batch.processedHistoryId, config.SYNC_RECONCILIATION_INTERVAL_MINUTES, true); })).state;
  };
  const runIncrementalSync = async (mailboxId: string, gmail: ReturnType<typeof gmailForMailbox>) => {
    for (;;) {
      const state = await getMailboxSyncState(mailboxId); if (!state?.appliedHistoryId) return runInitialSync(mailboxId, gmail, false);
      const batch = await collectHistoryChanges(gmail, state.appliedHistoryId);
      if (shouldRetryForUnavailableHistory(batch.processedHistoryId, state.appliedHistoryId, state.pendingHistoryId)) throw new Error("Gmail notification is ahead of the available history range; retry required");
      const applied = await withTransaction(async (client) => { await persistHistoryBatch(client, mailboxId, batch); return applyProcessedHistory(client, mailboxId, batch.processedHistoryId, config.SYNC_RECONCILIATION_INTERVAL_MINUTES, false); });
      if (!hasUnprocessedPendingHistory(applied.state.pendingHistoryId, applied.state.appliedHistoryId!)) return applied.state;
    }
  };
  const recordFailure = async (mailboxId: string, failure: SyncErrorCode) => {
    await recordSyncFailure(mailboxId, failure);
    await pool.query(failure === "reauthorization_required" ? "UPDATE mailbox_accounts SET status='reauthorization_required',last_sync_error=$2 WHERE id=$1" : "UPDATE mailbox_accounts SET last_sync_error=$2 WHERE id=$1", [mailboxId, failure]);
  };
  const processSync = async (job: SyncJob) => withMailboxLease(job.mailboxAccountId, async () => {
    const mailbox = await findMailboxById(job.mailboxAccountId); if (!mailbox || mailbox.status !== "active") return;
    await ensureMailboxSyncState(mailbox.id); const gmail = gmailForMailbox(config, mailbox.encrypted_refresh_token);
    try {
      const state = job.reason === "history_expired" ? await runInitialSync(mailbox.id, gmail, true) : await runIncrementalSync(mailbox.id, gmail);
      await pool.query("INSERT INTO audit_events(actor_type,event_type,object_type,object_id,correlation_id,metadata) VALUES('system','gmail.sync.succeeded','mailbox_account',$1,gen_random_uuid(),$2)", [mailbox.id, JSON.stringify({ reason: job.reason, appliedHistoryId: state.appliedHistoryId })]);
    } catch (error) { const failure = classifyGmailError(error, "history"); if (failure === "history_expired" && job.reason !== "history_expired") { await enqueueSync({ mailboxAccountId: mailbox.id, reason: "history_expired" }); return; } await recordFailure(mailbox.id, failure); throw error; }
  });
  return {
    processSync,
    processCommand: async (job) => {
      const commandContext = { command_id: job.data.commandId, correlation_id: job.data.correlationId, operation: "provider_command" };
      if (job.name === "verify-create-draft") { await verifyCreateDraftRecovery(job.data.commandId, { ...commandDependencies, claimCreateDraftRecovery, releaseCreateDraftRecoveryClaim, completeRecoveredDraftCreation, loadDraftForRecovery, findDraftByRfc822MessageId }); return; }
      if (job.name === "verify-update-draft") { await verifyUpdateDraftRecovery(job.data.commandId, { ...commandDependencies, claimUpdateDraftRecovery, releaseUpdateDraftRecoveryClaim, loadDraftForUpdateRecovery }); return; }
      if (job.name === "verify-send-draft") { await verifySendDraftRecovery(job.data.commandId, { ...commandDependencies, claimSendDraftRecovery, releaseSendDraftRecoveryClaim, completeRecoveredDraftSend, loadDraftForSendRecovery, findSentMessageByRfc822MessageId }); return; }
      await executeProviderCommand(job.data.commandId, commandDependencies);
      logger.info(commandContext, "provider command processed");
    },
    dispatchCommandOutbox: async (limit) => {
      const claimed = await claimOutboxEvents(limit); metrics().gauge("unpublished_outbox", claimed.events.length);
      await mapWithConcurrency(claimed.events, outboxDispatchConcurrency, async (event) => {
        try {
          if (!event.command_type || !event.correlation_id) { await releaseOutboxClaim(event.id, claimed.claimId); return; }
          await enqueueProviderCommand(event.aggregate_id, event.command_type, event.correlation_id);
          const published = await markOutboxPublished(event.id, claimed.claimId);
          metrics().counter("queue_enqueues_total", 1, { queue: "commands", result: published ? "success" : "lost_claim" });
        } catch {
          await releaseOutboxClaim(event.id, claimed.claimId);
          metrics().counter("queue_enqueues_total", 1, { queue: "commands", result: "failure" });
          logger.warn({ errorCode: "command_outbox_enqueue_failed", operation: "command_outbox_dispatch" }, "provider command outbox enqueue failed");
        }
      });
    },
    recoverExpiredCommandLeases: async () => { await recoverExpiredLeases(); },
    renewWatches: async () => {
      const accounts = await pool.query<{ id: string; encrypted_refresh_token: string }>("SELECT id,encrypted_refresh_token FROM mailbox_accounts WHERE status='active' AND (watch_expires_at IS NULL OR watch_expires_at < now() + interval '48 hours')");
      for (const account of accounts.rows) try { const result = await watchMailbox(gmailForMailbox(config, account.encrypted_refresh_token), config.GOOGLE_PUBSUB_TOPIC); await pool.query("UPDATE mailbox_accounts SET watch_expires_at=$2 WHERE id=$1", [account.id, result.expiration ? new Date(Number(result.expiration)) : null]); }
      catch (error) { if (isGmailProviderError(error)) logger.error(sanitizeGmailProviderError(error, { operation: "gmail_watch_renewal", mailboxId: account.id }), "gmail watch renewal failed"); else logger.error({ mailboxId: account.id, err: error }, "gmail watch renewal failed"); }
    },
    scheduleReconciliation: async (limit) => {
      const ids = await claimDueReconciliations(limit, config.SYNC_RECONCILIATION_INTERVAL_MINUTES);
      await Promise.all(ids.map(async (mailboxAccountId) => { try { await enqueueSync({ mailboxAccountId, reason: "reconciliation" }); } catch (error) { logger.error({ mailboxId: mailboxAccountId, err: error }, "reconciliation queue handoff failed; releasing claim"); await releaseReconciliationClaim(mailboxAccountId).catch((releaseError) => logger.error({ mailboxId: mailboxAccountId, err: releaseError }, "reconciliation claim release failed")); } }));
    },
    repairInconsistentDraftStates,
    recordWorkerStarted: async (input) => { await recordWorkerStarted(input); },
    recordWorkerHeartbeat: async (input) => { await recordWorkerHeartbeat(input); },
    markWorkerDraining: async (workerId) => { await markWorkerDraining(workerId); },
    markWorkerStopped: async (workerId) => { await markWorkerStopped(workerId); },
    checkDatabase: async () => { await pool.query("SELECT 1"); },
    getDatabaseDiagnostics: async () => getWorkerDatabaseDiagnostics(),
    getQueueDiagnostics: async () => {
      const summarize = async (queue: { getJobCounts: (...states: any[]) => Promise<{ [key: string]: number }>; getJobs: (types: any[], start: number, end: number, asc: boolean) => Promise<Array<{ timestamp?: number }>> }) => {
        const [counts, oldest] = await Promise.all([queue.getJobCounts("waiting", "active", "delayed", "failed"), queue.getJobs(["waiting"], 0, 0, true)]);
        return { waiting: counts.waiting ?? 0, active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0, stalled: null, oldestWaitingAgeMs: oldest[0]?.timestamp ? Math.max(0, Date.now() - oldest[0].timestamp) : null };
      };
      const [sync, commands] = await Promise.all([summarize(syncQueue), summarize(gmailCommandsQueue)]);
      return { sync, commands };
    }
  };
}

export { MailboxLeaseUnavailable, closeQueues, logger, pool };
