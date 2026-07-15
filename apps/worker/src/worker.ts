import { setInterval } from "node:timers";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { loadConfig } from "@aio/config";
import { findMailboxById, pool } from "@aio/database";
import { changedMessageIds, currentHistoryId, getMessage, getThread, gmailForMailbox, initialThreadIds, watchMailbox } from "@aio/gmail";
import { closeQueues, enqueueSync } from "@aio/jobs";
import { logger } from "@aio/observability";
import type { SyncJob } from "@aio/contracts";

const config = loadConfig();
const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

async function withMailboxLock<T>(mailboxId: string, work: () => Promise<T>): Promise<T | undefined> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [mailboxId]);
    if (!lock.rows[0].locked) { logger.info({ mailboxId }, "sync skipped; mailbox is already locked"); return; }
    return await work();
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [mailboxId]).catch(() => undefined);
    client.release();
  }
}

function header(message: { payload?: { headers?: Array<{ name?: string | null; value?: string | null }> } }, name: string) {
  return message.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}
function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; response?: { status?: unknown } };
  return typeof value.code === "number" ? value.code : typeof value.response?.status === "number" ? value.response.status : undefined;
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
     ON CONFLICT(mailbox_account_id,provider_thread_id) DO UPDATE SET subject_normalized=EXCLUDED.subject_normalized, participant_summary=EXCLUDED.participant_summary, last_message_at=EXCLUDED.last_message_at, unread_count=EXCLUDED.unread_count, provider_labels=EXCLUDED.provider_labels, sync_version=threads.sync_version+1, updated_at=now()
     RETURNING id`,
    [mailboxId, providerThread.id, header(latest ?? {}, "Subject"), header(latest ?? {}, "From"), latest?.internalDate ? new Date(Number(latest.internalDate)) : null, messages.filter((message) => message.labelIds?.includes("UNREAD")).length, providerThread.messages?.flatMap((message) => message.labelIds ?? []) ?? []]
  );
  for (const message of messages) {
    if (!message.id || !message.internalDate) continue;
    await pool.query(
      `INSERT INTO messages(thread_id,provider_message_id,internal_timestamp,sent_at,from_address,snippet,provider_labels)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(thread_id,provider_message_id) DO UPDATE SET provider_labels=EXCLUDED.provider_labels, snippet=EXCLUDED.snippet`,
      [thread.rows[0].id, message.id, new Date(Number(message.internalDate)), null, header(message, "From"), null, [...new Set(message.labelIds ?? [])]]
    );
  }
}

async function syncMailbox(job: SyncJob) {
  return withMailboxLock(job.mailboxAccountId, async () => {
    const mailbox = await findMailboxById(job.mailboxAccountId);
    if (!mailbox || mailbox.status !== "active") return;
    const gmail = gmailForMailbox(config, mailbox.encrypted_refresh_token);
    const checkpoint = await pool.query<{ id: string }>("INSERT INTO sync_checkpoints(mailbox_account_id,sync_type,status,start_history_id,started_at) VALUES($1,$2,'running',$3,now()) RETURNING id", [mailbox.id, job.reason === "initial" || job.reason === "history_expired" ? "initial" : "incremental", mailbox.last_history_id]);
    try {
      let threadIds: string[];
      if (job.reason === "initial" || job.reason === "history_expired" || !mailbox.last_history_id) {
        threadIds = await initialThreadIds(gmail, config.GMAIL_INITIAL_SYNC_LIMIT);
      } else {
        const changes = await changedMessageIds(gmail, mailbox.last_history_id);
        if (changes.deletedMessageIds.length) {
          await pool.query("DELETE FROM messages USING threads WHERE messages.thread_id=threads.id AND threads.mailbox_account_id=$1 AND messages.provider_message_id = ANY($2)", [mailbox.id, changes.deletedMessageIds]);
          await pool.query("DELETE FROM threads WHERE mailbox_account_id=$1 AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.thread_id=threads.id)", [mailbox.id]);
        }
        const messageThreadIds = await mapWithConcurrency(changes.messageIds, 5, async (messageId) => {
          try { return (await getMessage(gmail, messageId)).threadId; }
          catch (error) { if (statusCode(error) === 404) return undefined; throw error; }
        });
        threadIds = [...new Set(messageThreadIds.filter(Boolean) as string[])];
      }
      for (const threadId of threadIds) await persistThread(mailbox.id, await getThread(gmail, threadId));
      const historyId = await currentHistoryId(gmail);
      await pool.query("UPDATE mailbox_accounts SET last_history_id=$2,last_synced_at=now(),last_sync_error=NULL,status='active' WHERE id=$1", [mailbox.id, historyId]);
      await pool.query("UPDATE sync_checkpoints SET status='succeeded',end_history_id=$2,completed_at=now() WHERE id=$1", [checkpoint.rows[0].id, historyId]);
      await pool.query("INSERT INTO audit_events(actor_type,event_type,object_type,object_id,correlation_id,metadata) VALUES('system','gmail.sync.succeeded','mailbox_account',$1,gen_random_uuid(),$2)", [mailbox.id, JSON.stringify({ reason: job.reason, threadCount: threadIds.length })]);
    } catch (error) {
      const historyExpired = statusCode(error) === 404;
      await pool.query("UPDATE sync_checkpoints SET status='failed',failure_code=$2,completed_at=now() WHERE id=$1", [checkpoint.rows[0].id, historyExpired ? "history_expired" : "sync_failed"]);
      if (historyExpired && job.reason !== "history_expired") { await enqueueSync({ mailboxAccountId: mailbox.id, reason: "history_expired" }); return; }
      await pool.query("UPDATE mailbox_accounts SET last_sync_error=$2 WHERE id=$1", [mailbox.id, historyExpired ? "history_expired" : "sync_failed"]);
      throw error;
    }
  });
}

const worker = new Worker<SyncJob>("gmail-sync", async (job) => syncMailbox(job.data), { connection, concurrency: 10, limiter: { max: 25, duration: 1_000 } });
worker.on("failed", (job, error) => logger.error({ jobId: job?.id, err: error }, "gmail sync job failed"));

async function renewWatches() {
  const accounts = await pool.query<{ id: string; encrypted_refresh_token: string }>("SELECT id,encrypted_refresh_token FROM mailbox_accounts WHERE status='active' AND (watch_expires_at IS NULL OR watch_expires_at < now() + interval '48 hours')");
  for (const account of accounts.rows) {
    try {
      const result = await watchMailbox(gmailForMailbox(config, account.encrypted_refresh_token), config.GOOGLE_PUBSUB_TOPIC);
      await pool.query("UPDATE mailbox_accounts SET watch_expires_at=$2 WHERE id=$1", [account.id, result.expiration ? new Date(Number(result.expiration)) : null]);
    } catch (error) { logger.error({ mailboxId: account.id, err: error }, "gmail watch renewal failed"); }
  }
}
setInterval(() => void renewWatches(), 12 * 60 * 60 * 1000).unref();
void renewWatches();

async function shutdown() { await worker.close(); await closeQueues(); await connection.quit(); await pool.end(); }
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
