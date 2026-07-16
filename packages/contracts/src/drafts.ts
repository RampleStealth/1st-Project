import { z } from "zod";

export const draftLimits = {
  maxRecipients: 50,
  maxRecipientLength: 254,
  maxSubjectLength: 512,
  maxPlainTextBytes: 256 * 1024,
  maxHtmlBytes: 256 * 1024
} as const;

export const draftStatusSchema = z.enum([
  "creating",
  "ready",
  "updating",
  "sending",
  "sent",
  "conflict",
  "recovery_required",
  "creation_failed"
]);
export type DraftStatus = z.infer<typeof draftStatusSchema>;

const recipientInputSchema = z.string().min(1).max(draftLimits.maxRecipientLength);
export const draftContentInputSchema = z.object({
  to: z.array(recipientInputSchema).max(draftLimits.maxRecipients).default([]),
  cc: z.array(recipientInputSchema).max(draftLimits.maxRecipients).default([]),
  bcc: z.array(recipientInputSchema).max(draftLimits.maxRecipients).default([]),
  subject: z.string().max(draftLimits.maxSubjectLength),
  plainText: z.string(),
  html: z.string().nullable().optional().default(null)
}).strict();
export type DraftContentInput = z.input<typeof draftContentInputSchema>;

export type CanonicalDraftContent = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  plainText: string;
  html: string | null;
};

export const createDraftPayloadSchema = z.object({ version: z.literal(1), draftId: z.string().uuid() }).strict();
export const updateDraftPayloadSchema = z.object({ version: z.literal(1), draftId: z.string().uuid(), revision: z.number().int().positive() }).strict();
export const sendDraftPayloadSchema = z.object({ version: z.literal(1), draftId: z.string().uuid(), revision: z.number().int().positive() }).strict();
