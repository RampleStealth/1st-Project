import { z } from "zod";

export const mailboxStatusSchema = z.enum(["active", "reauthorization_required", "disconnected", "sync_failed"]);
export type MailboxStatus = z.infer<typeof mailboxStatusSchema>;

export const gmailNotificationSchema = z.object({
  emailAddress: z.string().email(),
  historyId: z.string().min(1)
});

export const syncJobSchema = z.object({
  mailboxAccountId: z.string().uuid(),
  requestedHistoryId: z.string().optional(),
  reason: z.enum(["initial", "notification", "reconciliation", "history_expired"])
});
export type SyncJob = z.infer<typeof syncJobSchema>;

export const auditEventSchema = z.object({
  actorType: z.enum(["user", "system"]),
  actorId: z.string().uuid().nullable(),
  eventType: z.string().min(1),
  objectType: z.string().min(1),
  objectId: z.string().min(1),
  correlationId: z.string().uuid(),
  metadata: z.record(z.string(), z.unknown()).default({})
});
