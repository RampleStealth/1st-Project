import { z } from "zod";
import { decryptSecret, encryptSecret } from "@aio/security";
import { mailboxViewSchema, type MailboxView } from "@aio/contracts";

const cursorSchema = z.object({
  userId: z.string().uuid(),
  mailboxId: z.string().uuid(),
  view: mailboxViewSchema,
  limit: z.number().int().min(1).max(100),
  providerPageToken: z.string().min(1),
  expiresAt: z.number().int().positive()
});
export type CursorContext = { userId: string; mailboxId: string; view: MailboxView; limit: number };
export class CursorError extends Error {
  constructor(readonly code: "invalid_cursor" | "expired_cursor" | "cursor_context_mismatch") { super(code); this.name = "CursorError"; }
}

/** AES-GCM makes Gmail page tokens confidential and authenticated outside the API. */
export function encodeThreadCursor(payload: CursorContext & { providerPageToken: string; expiresAt: number }, encryptionKey: string) {
  return encryptSecret(JSON.stringify(payload), encryptionKey);
}

export function decodeThreadCursor(cursor: string, context: CursorContext, encryptionKey: string): string {
  let payload: z.infer<typeof cursorSchema>;
  try { payload = cursorSchema.parse(JSON.parse(decryptSecret(cursor, encryptionKey))); }
  catch { throw new CursorError("invalid_cursor"); }
  if (payload.expiresAt <= Date.now()) throw new CursorError("expired_cursor");
  if (payload.userId !== context.userId || payload.mailboxId !== context.mailboxId || payload.view !== context.view || payload.limit !== context.limit) throw new CursorError("cursor_context_mismatch");
  return payload.providerPageToken;
}

export const threadListQuerySchema = z.object({
  view: mailboxViewSchema.default("inbox"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});
