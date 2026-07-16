import { Queue } from "bullmq";
import type { SyncJob } from "@aio/contracts";
import type { ProviderCommandType } from "@aio/contracts";

export const syncQueue = new Queue<SyncJob, void, "sync-mailbox">("gmail-sync", {
  connection: { url: process.env.REDIS_URL ?? "", maxRetriesPerRequest: null },
  defaultJobOptions: { attempts: 8, backoff: { type: "exponential", delay: 1_000 }, removeOnComplete: 1_000, removeOnFail: 5_000 }
});
export type GmailCommandJob = { commandId: string; commandType: ProviderCommandType };
export const gmailCommandsQueue = new Queue<GmailCommandJob, void, "execute-command" | "verify-create-draft">("gmail-commands", { connection: { url: process.env.REDIS_URL ?? "", maxRetriesPerRequest: null }, defaultJobOptions: { attempts: 1, removeOnComplete: 1_000, removeOnFail: 5_000 } });
export async function enqueueProviderCommand(commandId: string, commandType: ProviderCommandType) { return gmailCommandsQueue.add("execute-command", { commandId, commandType }, { jobId: commandId }); }
/** Explicit operator/user-triggered read-only verification; never an automatic create retry. */
export async function enqueueCreateDraftVerification(commandId: string) { return gmailCommandsQueue.add("verify-create-draft", { commandId, commandType: "create_draft" }, { jobId: `verify:${commandId}` }); }

export async function enqueueSync(job: SyncJob) {
  return syncQueue.add("sync-mailbox", job, {
    priority: job.reason === "notification" ? 1 : 5
  });
}

export async function closeQueues() { await Promise.all([syncQueue.close(), gmailCommandsQueue.close()]); }
