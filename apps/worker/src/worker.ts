import { setInterval } from "node:timers";
import { Worker } from "bullmq";
import { loadConfig } from "@aio/config";
import { findMailboxById, pool } from "@aio/database";
import { applyProcessedHistory, beginInitialSync, claimDueReconciliations, ensureMailboxSyncState, getMailboxSyncState, recordSyncFailure } from "@aio/database/repositories/mailbox-sync";
import { changedMessageIds, classifyGmailError, currentHistoryId, getMessage, getThread, gmailForMailbox, initialThreadIds, watchMailbox } from "@aio/gmail";
import { closeQueues, enqueueSync } from "@aio/jobs";
import { logger } from "@aio/observability";
import type { SyncErrorCode, SyncJob } from "@aio/contracts";
import { hasUnprocessedPendingHistory, shouldRetryForUnavailableHistory } from "./sync-state.js";

const config = loadConfig();
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

function header(message: { payload?: { headers?: Array<{ name?: string | null; value?: string | null }> } }, name: string) {
  return message.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
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

async function persistThread(mailboxId: string, providerThread: Awaited<ReturnType<typeof getThread>>) {
  if (!providerThread.id) return;
  const messages = providerThread.messages ?? [];
  const latest = messages.at(-1);
  const thread = await pool.query<{ id: string }>(
    `INSERT INTO threads(mailbox_account_id, provider_thread_id, subject_normalized, participant_summary, last_message_at, unread_count, provider_labels)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(mailbox_account_id,provider_thread_id) DO UPDATE SET subject_normalized=EXCLUDED.subject_normalized,participant_summary=EXCLUDED.participant_summary,last_message_at=EXCLUDED.last_message_at,unread_count=EXCLUDED.unread_count,provider_labels=EXCLUDED.provider_labels,sync_version=threads.sync_version+1,updated_at=now()
     RETURNING id`,
    [mailboxId, providerThread.id, header(latest ?? {}, "Subject"), header(latest ?? {}, "From"), latest?.internalDate ? new Date(Number(latest.internalDate)) : null, messages.filter((message) => message.labelIds?.includes("UNREAD")).length, [...new Set(messages.flatMap((message) => message.labelIds ?? []))]]
  );
  for (const message of messages) {
    if (!message.id || !message.internalDate) continue;
    await pool.query(
      `INSERT INTO messages(thread_id,provider_message_id,internal_timestamp,sent_at,from_address,snippet,provider_labels)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(thread_id,provider_message_id) DO UPDATE SET provider_labels=EXCLUDED.provider_labels`,
      [thread.rows[0].id, message.id, new Date(Number(message.internalDate)), null, header(message, "From"), null, [...new Set(message.labelIds ?? [])]]
    );
  }
}

async function syncThreadIds(mailboxId: string, gmail: ReturnType<typeof gmailForMailbox>, threadIds: string[]) {
  const threads = await mapWithConcurrency(threadIds, 5, async (threadId) => {
    try { return await getThread(gmail, threadId); }
    catch (error) { if (classifyGmailError(error, "resource") === "resource_deleted") return undefined; throw error; }
  });
  for (const thread of threads) if (thread) await persistThread(mailboxId, thread);
}

async function applyHistoryChanges(mailboxId: string, gmail: ReturnType<typeof gmailForMailbox>, startHistoryId: string): Promise<string> {
  const changes = await changedMessageIds(gmail, startHistoryId);
  if (changes.deletedMessageIds.length) {
    await pool.query("DELETE FROM messages USING threads WHERE messages.thread_id=threads.id AND threads.mailbox_account_id=$1 AND messages.provider_message_id = ANY($2)", [mailboxId, changes.deletedMessageIds]);
    await pool.query("DELETE FROM threads WHERE mailbox_account_id=$1 AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.thread_id=threads.id)", [mailboxId]);
  }
  const messageThreadIds = await mapWithConcurrency(changes.messageIds, 5, async (messageId) => {
    try { return (await getMessage(gmail, messageId)).threadId; }
    catch (error) { if (classifyGmailError(error, "resource") === "resource_deleted") return undefined; throw error; }
  });
  await syncThreadIds(mailboxId, gmail, [...new Set(messageThreadIds.filter(Boolean) as string[])]);
  return changes.latestHistoryId ?? startHistoryId;
}

async function runInitialSync(mailboxId: string, gmail: ReturnType<typeof gmailForMailbox>, forceNewBaseline: boolean) {
  let state = await getMailboxSyncState(mailboxId);
  if (!state) throw new Error(`Mailbox sync state missing for ${mailboxId}`);
  const baseline = forceNewBaseline || !state.initialBaselineHistoryId ? await currentHistoryId(gmail) : state.initialBaselineHistoryId;
  await beginInitialSync(mailboxId, baseline);
  await syncThreadIds(mailboxId, gmail, await initialThreadIds(gmail, config.GMAIL_INITIAL_SYNC_LIMIT));
  const processedHistoryId = await applyHistoryChanges(mailboxId, gmail, baseline);
  state = await applyProcessedHistory(mailboxId, processedHistoryId, config.SYNC_RECONCILIATION_INTERVAL_MINUTES, true);
  return state;
}

async function runIncrementalSync(mailboxId: string, gmail: ReturnType<typeof gmailForMailbox>) {
  for (;;) {
    const state = await getMailboxSyncState(mailboxId);
    if (!state?.appliedHistoryId) return runInitialSync(mailboxId, gmail, false);
    const processedHistoryId = await applyHistoryChanges(mailboxId, gmail, state.appliedHistoryId);
    if (shouldRetryForUnavailableHistory(processedHistoryId, state.appliedHistoryId, state.pendingHistoryId)) {
      throw new Error("Gmail notification is ahead of the available history range; retry required");
    }
    const updatedState = await applyProcessedHistory(mailboxId, processedHistoryId, config.SYNC_RECONCILIATION_INTERVAL_MINUTES, false);
    if (!hasUnprocessedPendingHistory(updatedState.pendingHistoryId, processedHistoryId)) return updatedState;
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
    await ensureMailboxSyncState(mailbox.id, mailbox.last_history_id);
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
  else logger.error({ jobId: job?.id, err: error }, "gmail sync job failed");
});

async function renewWatches() {
  const accounts = await pool.query<{ id: string; encrypted_refresh_token: string }>("SELECT id,encrypted_refresh_token FROM mailbox_accounts WHERE status='active' AND (watch_expires_at IS NULL OR watch_expires_at < now() + interval '48 hours')");
  for (const account of accounts.rows) {
    try {
      const result = await watchMailbox(gmailForMailbox(config, account.encrypted_refresh_token), config.GOOGLE_PUBSUB_TOPIC);
      await pool.query("UPDATE mailbox_accounts SET watch_expires_at=$2 WHERE id=$1", [account.id, result.expiration ? new Date(Number(result.expiration)) : null]);
    } catch (error) { logger.error({ mailboxId: account.id, err: error }, "gmail watch renewal failed"); }
  }
}

async function scheduleReconciliation() {
  const mailboxIds = await claimDueReconciliations(100, config.SYNC_RECONCILIATION_INTERVAL_MINUTES);
  await Promise.all(mailboxIds.map((mailboxAccountId) => enqueueSync({ mailboxAccountId, reason: "reconciliation" })));
}

setInterval(() => void renewWatches(), 12 * 60 * 60 * 1000).unref();
setInterval(() => void scheduleReconciliation(), 60_000).unref();
void renewWatches();
void scheduleReconciliation();

async function shutdown() { await worker.close(); await closeQueues(); await pool.end(); }
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
