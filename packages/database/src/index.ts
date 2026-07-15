import dotenv from "dotenv";

const result = dotenv.config({
  path: "../../.env",
});


import pg from "pg";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type MailboxAccount = {
  id: string; user_id: string; provider_account_id: string; email_address: string;
  status: "active" | "reauthorization_required" | "disconnected" | "sync_failed";
  encrypted_refresh_token: string; granted_scopes: string[]; last_history_id: string | null;
  watch_expires_at: Date | null; last_sync_error: string | null;
};

export async function findMailboxByEmail(email: string): Promise<MailboxAccount | null> {
  const result = await pool.query<MailboxAccount>(
    "SELECT * FROM mailbox_accounts WHERE lower(email_address) = lower($1) AND status <> 'disconnected'", [email]
  );
  return result.rows[0] ?? null;
}

export async function findMailboxById(id: string): Promise<MailboxAccount | null> {
  const result = await pool.query<MailboxAccount>("SELECT * FROM mailbox_accounts WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}
