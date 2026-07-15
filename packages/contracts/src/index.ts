import { z } from "zod";

export const mailboxStatusSchema = z.enum(["active", "reauthorization_required", "disconnected", "sync_failed"]);
export type MailboxStatus = z.infer<typeof mailboxStatusSchema>;
export const mailboxWriteCapabilitySchema = z.enum(["read_only", "upgrade_pending", "write_granted", "upgrade_declined", "upgrade_failed"]);
export type MailboxWriteCapability = z.infer<typeof mailboxWriteCapabilitySchema>;

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

export const mailboxViewSchema = z.enum(["inbox", "all", "sent", "drafts"]);
export type MailboxView = z.infer<typeof mailboxViewSchema>;

export const threadListItemSchema = z.object({
  id: z.string().uuid(),
  providerThreadId: z.string().min(1),
  subject: z.string().nullable(),
  latestSender: z.string().nullable(),
  preview: z.string().nullable(),
  lastMessageAt: z.coerce.date().nullable(),
  unreadCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  hasAttachments: z.boolean().nullable(),
  hasDraft: z.boolean(),
  labels: z.array(z.string())
});
export type ThreadListItem = z.infer<typeof threadListItemSchema>;

export const threadListPageSchema = z.object({
  items: z.array(threadListItemSchema),
  nextCursor: z.string().min(1).nullable(),
  source: z.literal("gmail"),
  fetchedAt: z.coerce.date()
});
export type ThreadListPage = z.infer<typeof threadListPageSchema>;

export const threadDisplayMessageSchema = z.object({
  id: z.string(), from: z.string().nullable(), to: z.array(z.string()), cc: z.array(z.string()), bcc: z.array(z.string()),
  subject: z.string().nullable(), sentAt: z.string().datetime().nullable(), labels: z.array(z.string()),
  attachments: z.array(z.object({ filename: z.string(), mimeType: z.string(), size: z.number().int().nonnegative().nullable() })),
  plainText: z.string(), sanitizedHtml: z.string().nullable(), renderingState: z.enum(["ready", "fallback", "failed"])
});
export const threadDisplaySchema = z.object({ id: z.string(), messages: z.array(threadDisplayMessageSchema) });
export type ThreadDisplay = z.infer<typeof threadDisplaySchema>;

export const auditEventSchema = z.object({
  actorType: z.enum(["user", "system"]),
  actorId: z.string().uuid().nullable(),
  eventType: z.string().min(1),
  objectType: z.string().min(1),
  objectId: z.string().min(1),
  correlationId: z.string().uuid(),
  metadata: z.record(z.string(), z.unknown()).default({})
});
