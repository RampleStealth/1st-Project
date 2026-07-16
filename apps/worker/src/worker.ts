import { setInterval } from "node:timers";
import { Worker } from "bullmq";
import { loadConfig } from "@aio/config";
import { findMailboxById, pool, withTransaction, type MailboxAccount } from "@aio/database";
import { applyProcessedHistory, beginInitialSync, claimDueReconciliations, ensureMailboxSyncState, getMailboxSyncState, recordSyncFailure, releaseReconciliationClaim } from "@aio/database/repositories/mailbox-sync";
import { upsertThreadProjection } from "@aio/database/repositories/thread-projection";
import { archiveThread, changedMessageIds, classifyGmailError, classifyGmailMutationError, createDraft, currentHistoryId, findDraftByRfc822MessageId, findSentMessageByRfc822MessageId, getDraft, getMessage, getThread, gmailForMailbox, hydrateThreadMetadata, initialThreadIds, isGmailProviderError, markThreadUnread, sanitizeGmailProviderError, sendDraft, updateDraft, watchMailbox } from "@aio/gmail";
import { closeQueues, enqueueProviderCommand, enqueueSync } from "@aio/jobs";
import { logger } from "@aio/observability";
import type { SyncErrorCode, SyncJob } from "@aio/contracts";
import { hasUnprocessedPendingHistory, shouldRetryForUnavailableHistory } from "./sync-state.js";
import { claimCommand, claimCreateDraftRecovery, claimOutboxEvents, claimSendDraftRecovery, claimUpdateDraftRecovery, completeClaim, completeConfirmedMutation, completeFailedMutation, completeRecoveredDraftCreation, completeRecoveredDraftSend, completeRecoveryRequiredMutation, loadClaimedCommand, markOutboxPublished, markProviderExecutionStarted, recoverExpiredLeases, releaseCreateDraftRecoveryClaim, releaseOutboxClaim, releaseSendDraftRecoveryClaim, releaseUpdateDraftRecoveryClaim, scheduleRetryFromClaim, StaleCommandClaimError } from "@aio/database/repositories/provider-command";
import { executeProviderCommand, verifyCreateDraftRecovery, verifySendDraftRecovery, verifyUpdateDraftRecovery } from "./provider-command-executor.js";
import { confirmDraftCreation, confirmDraftSent, confirmDraftUpdate, loadDraftForCreation, loadDraftForRecovery, loadDraftForSend, loadDraftForSendRecovery, loadDraftForUpdate, loadDraftForUpdateRecovery, markDraftConflict, markDraftSendConflict, markDraftSendRecoveryRequired } from "@aio/database/repositories/draft";

const config = loadConfig();
const commandDependencies = {
  encryptionKey: config.TOKEN_ENCRYPTION_KEY_BASE64,
  claimCommand,
  loadClaimedCommand,
  findMailboxById,
  gmailForMailbox: (mailbox: MailboxAccount) => gmailForMailbox(config, mailbox.encrypted_refresh_token),
  archiveThread,
  markThreadUnread,
  loadDraftForCreation,
  createDraft,
  confirmDraftCreation,
  loadDraftForUpdate,
  getDraft,
  updateDraft,
  confirmDraftUpdate,
  markDraftConflict,
  loadDraftForSend,
  sendDraft,
  confirmDraftSent,
  markDraftSendConflict,
  markDraftSendRecoveryRequired,
  markProviderExecutionStarted,
  withTransaction,
  completeConfirmedMutation,
  completeFailedMutation,
  completeRecoveryRequiredMutation,
  scheduleRetryFromClaim,
  completeClaim,
  classifyGmailMutationError,
  isStaleCommandClaimError: (error: unknown) => error instanceof StaleCommandClaimError
};
const commandWorker = new Worker("gmail-commands", async (job) => job.name === "verify-create-draft"
  ? verifyCreateDraftRecovery(job.data.commandId, { ...commandDependencies, claimCreateDraftRecovery, releaseCreateDraftRecoveryClaim, completeRecoveredDraftCreation, loadDraftForRecovery, findDraftByRfc822MessageId })
  : job.name === "verify-update-draft"
    ? verifyUpdateDraftRecovery(job.data.commandId, { ...commandDependencies, claimUpdateDraftRecovery, releaseUpdateDraftRecoveryClaim, loadDraftForUpdateRecovery })
    : job.name === "verify-send-draft"
      ? verifySendDraftRecovery(job.data.commandId, { ...commandDependencies, claimSendDraftRecovery, releaseSendDraftRecoveryClaim, completeRecoveredDraftSend, loadDraftForSendRecovery, findSentMessageByRfc822MessageId })
    : executeProviderCommand(job.data.commandId, commandDependencies), { connection: { url: config.REDIS_URL, maxRetriesPerRequest: null } });
async function dispatchCommandOutbox() {
  const claimed = await claimOutboxEvents();
  for (const event of claimed.events) { try { const command = await pool.query<{ command_type: import("@aio/contracts").ProviderCommandType }>("SELECT command_type FROM provider_commands WHERE id=$1", [event.aggregate_id]); if (!command.rowCount) { await releaseOutboxClaim(event.id, claimed.claimId); continue; } await enqueueProviderCommand(event.aggregate_id, command.rows[0].command_type); await markOutboxPublished(event.id, claimed.claimId); } catch (error) { await releaseOutboxClaim(event.id, claimed.claimId); logger.warn({ eventId: event.id, errorCode: "command_outbox_enqueue_failed" }, "provider command outbox enqueue failed"); } }
}
setInterval(() => { void dispatchCommandOutbox().catch((error) => logger.error({ err: error }, "provider command outbox dispatch failed")); }, 5_000).unref();
setInterval(() => { void recoverExpiredLeases().catch((error: unknown) => logger.error({ err: error }, "provider command lease recovery failed")); }, 30_000).unref();
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
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

async function fetchThreads(gmail: ReturnType<typeof gmailForMailbox>, threadIds: string[]) {
  return hydrateThreadMetadata(gmail, threadIds, 5);
}

type HistoryBatch = { processedHistoryId: string; deletedMessageIds: string[]; threads: Awaited<ReturnType<typeof getThread>>[] };

async function collectHistoryChanges(gmail: ReturnType<typeof gmailForMailbox>, startHistoryId: string): Promise<HistoryBatch> {
  const changes = await changedMessageIds(gmail, startHistoryId);
  const messageThreadIds = await mapWithConcurrency(changes.messageIds, 5, async (messageId) => {
    try { return (await getMessage(gmail, messageId)).threadId; }
    catch (error) { if (classifyGmailError(error, "resource") === "resource_deleted") return undefined; throw error; }
  });
  const threads = await fetchThreads(gmail, [...new Set(messageThreadIds.filter(Boolean) as string[])]);
  return { processedHistoryId: changes.latestHistoryId ?? startHistoryId, deletedMessageIds: changes.deletedMessageIds, threads };
}

async function persistHistoryBatch(client: Parameters<typeof upsertThreadProjection>[0], mailboxId: string, batch: HistoryBatch) {
  if (batch.deletedMessageIds.length) {
    await client.query("DELETE FROM messages USING threads WHERE messages.thread_id=threads.id AND threads.mailbox_account_id=$1 AND messages.provider_message_id = ANY($2)", [mailboxId, batch.deletedMessageIds]);
    await client.query("DELETE FROM threads WHERE mailbox_account_id=$1 AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.thread_id=threads.id)", [mailboxId]);
  }
  for (const thread of batch.threads) await upsertThreadProjection(client, mailboxId, thread);
}

async function runInitialSync(mailboxId: string, gmail: ReturnType<typeof gmailForMailbox>, forceNewBaseline: boolean) {
  let state = await getMailboxSyncState(mailboxId);
  if (!state) throw new Error(`Mailbox sync state missing for ${mailboxId}`);
  const baseline = forceNewBaseline || !state.initialBaselineHistoryId ? await currentHistoryId(gmail) : state.initialBaselineHistoryId;
  await beginInitialSync(mailboxId, baseline);
  const initialThreads = await fetchThreads(gmail, await initialThreadIds(gmail, config.GMAIL_INITIAL_SYNC_LIMIT));
  const historyBatch = await collectHistoryChanges(gmail, baseline);
  const applied = await withTransaction(async (client) => {
    for (const thread of initialThreads) await upsertThreadProjection(client, mailboxId, thread);
    await persistHistoryBatch(client, mailboxId, historyBatch);
    return applyProcessedHistory(client, mailboxId, historyBatch.processedHistoryId, config.SYNC_RECONCILIATION_INTERVAL_MINUTES, true);
  });
  return applied.state;
}

async function runIncrementalSync(mailboxId: string, gmail: ReturnType<typeof gmailForMailbox>) {
  for (;;) {
    const state = await getMailboxSyncState(mailboxId);
    if (!state?.appliedHistoryId) return runInitialSync(mailboxId, gmail, false);
    const historyBatch = await collectHistoryChanges(gmail, state.appliedHistoryId);
    if (shouldRetryForUnavailableHistory(historyBatch.processedHistoryId, state.appliedHistoryId, state.pendingHistoryId)) {
      throw new Error("Gmail notification is ahead of the available history range; retry required");
    }
    const applied = await withTransaction(async (client) => {
      await persistHistoryBatch(client, mailboxId, historyBatch);
      return applyProcessedHistory(client, mailboxId, historyBatch.processedHistoryId, config.SYNC_RECONCILIATION_INTERVAL_MINUTES, false);
    });
    const updatedState = applied.state;
    if (!hasUnprocessedPendingHistory(updatedState.pendingHistoryId, updatedState.appliedHistoryId!)) return updatedState;
  }
}

async function recordFailure(mailboxId: string, failure: SyncErrorCode) {
  await recordSyncFailure(mailboxId, failure);
  if (failure === "reauthorization_required") await pool.query("UPDATE mailbox_accounts SET status='reauthorization_required',last_sync_error=$2 WHERE id=$1", [mailboxId, failure]);
  else await pool.query("UPDATE mailbox_accounts SET last_sync_error=$2 WHERE id=$1", [mailboxId, failure]);
}

async function syncMailbox(job: SyncJob) {
  return withMailboxLease(job.mailboxAccountId, async () => {
    const mailbox = await findMailboxById(job.mailboxAccountId);
    if (!mailbox || mailbox.status !== "active") return;
    await ensureMailboxSyncState(mailbox.id);
    const gmail = gmailForMailbox(config, mailbox.encrypted_refresh_token);
    try {
      const state = job.reason === "history_expired"
        ? await runInitialSync(mailbox.id, gmail, true)
        : await runIncrementalSync(mailbox.id, gmail);
      await pool.query("INSERT INTO audit_events(actor_type,event_type,object_type,object_id,correlation_id,metadata) VALUES('system','gmail.sync.succeeded','mailbox_account',$1,gen_random_uuid(),$2)", [mailbox.id, JSON.stringify({ reason: job.reason, appliedHistoryId: state.appliedHistoryId })]);
    } catch (error) {
      const failure = classifyGmailError(error, "history");
      if (failure === "history_expired" && job.reason !== "history_expired") {
        await enqueueSync({ mailboxAccountId: mailbox.id, reason: "history_expired" });
        return;
      }
      await recordFailure(mailbox.id, failure);
      throw error;
    }
  });
}

const worker = new Worker<SyncJob, void, "sync-mailbox">("gmail-sync", async (job) => syncMailbox(job.data), { connection: { url: config.REDIS_URL, maxRetriesPerRequest: null }, concurrency: 10, limiter: { max: 25, duration: 1_000 } });
worker.on("failed", (job, error) => {
  if (error instanceof MailboxLeaseUnavailable) logger.debug({ jobId: job?.id }, "sync job deferred while mailbox lease is active");
  else if (isGmailProviderError(error)) logger.error(sanitizeGmailProviderError(error, { operation: "gmail_sync", jobId: job?.id, mailboxId: job?.data.mailboxAccountId }), "gmail sync job failed");
  else logger.error({ jobId: job?.id, err: error }, "sync job failed");
});

async function renewWatches() {
  const accounts = await pool.query<{ id: string; encrypted_refresh_token: string }>("SELECT id,encrypted_refresh_token FROM mailbox_accounts WHERE status='active' AND (watch_expires_at IS NULL OR watch_expires_at < now() + interval '48 hours')");
  for (const account of accounts.rows) {
    try {
      const result = await watchMailbox(gmailForMailbox(config, account.encrypted_refresh_token), config.GOOGLE_PUBSUB_TOPIC);
      await pool.query("UPDATE mailbox_accounts SET watch_expires_at=$2 WHERE id=$1", [account.id, result.expiration ? new Date(Number(result.expiration)) : null]);
    } catch (error) {
      if (isGmailProviderError(error)) logger.error(sanitizeGmailProviderError(error, { operation: "gmail_watch_renewal", mailboxId: account.id }), "gmail watch renewal failed");
      else logger.error({ mailboxId: account.id, err: error }, "gmail watch renewal failed");
    }
  }
}

async function scheduleReconciliation() {
  const mailboxIds = await claimDueReconciliations(100, config.SYNC_RECONCILIATION_INTERVAL_MINUTES);
  await Promise.all(mailboxIds.map(async (mailboxAccountId) => {
    try {
      await enqueueSync({ mailboxAccountId, reason: "reconciliation" });
    } catch (error) {
      logger.error({ mailboxId: mailboxAccountId, err: error }, "reconciliation queue handoff failed; releasing claim");
      await releaseReconciliationClaim(mailboxAccountId).catch((releaseError) => {
        logger.error({ mailboxId: mailboxAccountId, err: releaseError }, "reconciliation claim release failed");
      });
    }
  }));
}

setInterval(() => void renewWatches(), 12 * 60 * 60 * 1000).unref();
setInterval(() => void scheduleReconciliation(), 60_000).unref();
void renewWatches();
void scheduleReconciliation();

async function shutdown() { await worker.close(); await closeQueues(); await pool.end(); }
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
