import { Queue } from "bullmq";
import type { SyncJob } from "@aio/contracts";

export const syncQueue = new Queue<SyncJob, void, "sync-mailbox">("gmail-sync", {
  connection: { url: process.env.REDIS_URL ?? "", maxRetriesPerRequest: null },
  defaultJobOptions: { attempts: 8, backoff: { type: "exponential", delay: 1_000 }, removeOnComplete: 1_000, removeOnFail: 5_000 }
});

export async function enqueueSync(job: SyncJob) {
  return syncQueue.add("sync-mailbox", job, {
    priority: job.reason === "notification" ? 1 : 5
  });
}

export async function closeQueues() { await syncQueue.close(); }
