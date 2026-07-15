import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { SyncJob } from "@aio/contracts";

const connection = new IORedis(process.env.REDIS_URL ?? "", { maxRetriesPerRequest: null });
export const syncQueue = new Queue<SyncJob>("gmail-sync", { connection, defaultJobOptions: { attempts: 8, backoff: { type: "exponential", delay: 1_000 }, removeOnComplete: 1_000, removeOnFail: 5_000 } });

export async function enqueueSync(job: SyncJob) {
  return syncQueue.add("sync-mailbox", job, {
    jobId: `${job.mailboxAccountId}:${job.requestedHistoryId ?? job.reason}`,
    priority: job.reason === "notification" ? 1 : 5
  });
}

export async function closeQueues() { await syncQueue.close(); await connection.quit(); }
