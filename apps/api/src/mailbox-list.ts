import { z } from "zod";
import { decryptSecret, deriveThreadCursorKey, encryptSecret } from "@aio/security";
import { mailboxViewSchema, type MailboxView } from "@aio/contracts";

const cursorSchema = z.object({
  version: z.literal(1),
  userId: z.string().uuid(),
  mailboxId: z.string().uuid(),
  view: mailboxViewSchema,
  limit: z.number().int().min(1).max(100),
  providerPageToken: z.string().min(1),
  expiresAt: z.number().int().positive()
});
export type CursorContext = { userId: string; mailboxId: string; view: MailboxView; limit: number };
export class CursorError extends Error {
  constructor() { super("invalid_cursor"); this.name = "CursorError"; }
}

/** Versioned AES-GCM cursor payloads use only the domain-separated cursor key. */
export function encodeThreadCursor(payload: CursorContext & { providerPageToken: string; expiresAt: number }, encryptionKey: string) {
  return encryptSecret(JSON.stringify({ version: 1, ...payload }), deriveThreadCursorKey(encryptionKey));
}

export function decodeThreadCursor(cursor: string, context: CursorContext, encryptionKey: string): string {
  let payload: z.infer<typeof cursorSchema>;
  try { payload = cursorSchema.parse(JSON.parse(decryptSecret(cursor, deriveThreadCursorKey(encryptionKey)))); }
  catch { throw new CursorError(); }
  if (payload.expiresAt <= Date.now()) throw new CursorError();
  if (payload.userId !== context.userId || payload.mailboxId !== context.mailboxId || payload.view !== context.view || payload.limit !== context.limit) throw new CursorError();
  return payload.providerPageToken;
}

export const threadListQuerySchema = z.object({
  view: mailboxViewSchema.default("inbox"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});
