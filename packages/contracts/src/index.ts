import { z } from "zod";

export const mailboxStatusSchema = z.enum(["active", "reauthorization_required", "disconnected", "sync_failed"]);
export type MailboxStatus = z.infer<typeof mailboxStatusSchema>;

export const gmailNotificationSchema = z.object({
  emailAddress: z.string().email(),
  historyId: z.string().regex(/^\d+$/)
});

export const syncJobSchema = z.object({
  mailboxAccountId: z.string().uuid(),
  requestedHistoryId: z.string().optional(),
  reason: z.enum(["initial", "notification", "reconciliation", "history_expired"])
});
export type SyncJob = z.infer<typeof syncJobSchema>;

export const syncErrorCodeSchema = z.enum(["history_expired", "resource_deleted", "reauthorization_required", "rate_limited", "transient_provider_failure", "unknown_provider_failure"]);
export type SyncErrorCode = z.infer<typeof syncErrorCodeSchema>;

export const mailboxSyncStateSchema = z.object({
  mailboxAccountId: z.string().uuid(),
  appliedHistoryId: z.string().regex(/^\d+$/).nullable(),
  pendingHistoryId: z.string().regex(/^\d+$/).nullable(),
  initialBaselineHistoryId: z.string().regex(/^\d+$/).nullable(),
  initialSyncStatus: z.enum(["pending", "running", "complete", "failed"]),
  reconciliationDueAt: z.coerce.date().nullable(),
  lastSuccessfulSyncAt: z.coerce.date().nullable()
});
export type MailboxSyncState = z.infer<typeof mailboxSyncStateSchema>;

export const auditEventSchema = z.object({
  actorType: z.enum(["user", "system"]),
  actorId: z.string().uuid().nullable(),
  eventType: z.string().min(1),
  objectType: z.string().min(1),
  objectId: z.string().min(1),
  correlationId: z.string().uuid(),
  metadata: z.record(z.string(), z.unknown()).default({})
});
