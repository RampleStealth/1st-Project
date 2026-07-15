import { pool, type MailboxAccount } from "../index.js";

/** Returns a mailbox only when it belongs to the authenticated user. */
export async function findMailboxForUser(mailboxAccountId: string, userId: string): Promise<MailboxAccount | null> {
  const result = await pool.query<MailboxAccount>("SELECT * FROM mailbox_accounts WHERE id=$1 AND user_id=$2 AND status <> 'disconnected'", [mailboxAccountId, userId]);
  return result.rows[0] ?? null;
}
