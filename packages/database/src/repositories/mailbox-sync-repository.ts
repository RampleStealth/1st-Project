import { pool, withTransaction } from "../index.js";
import type { MailboxSyncState } from "@aio/contracts";

type SyncStateRow = { mailbox_account_id: string; applied_history_id: string | null; pending_history_id: string | null; initial_baseline_history_id: string | null; initial_sync_status: "pending" | "running" | "complete" | "failed"; reconciliation_due_at: Date | null; last_successful_sync_at: Date | null; };

function toState(row: SyncStateRow): MailboxSyncState {
  return { mailboxAccountId: row.mailbox_account_id, appliedHistoryId: row.applied_history_id, pendingHistoryId: row.pending_history_id, initialBaselineHistoryId: row.initial_baseline_history_id, initialSyncStatus: row.initial_sync_status, reconciliationDueAt: row.reconciliation_due_at, lastSuccessfulSyncAt: row.last_successful_sync_at };
}

export async function ensureMailboxSyncState(mailboxAccountId: string, baselineHistoryId: string | null) {
  const result = await pool.query<SyncStateRow>(`INSERT INTO mailbox_sync_state(mailbox_account_id, initial_baseline_history_id, reconciliation_due_at) VALUES($1, $2, now()) ON CONFLICT(mailbox_account_id) DO NOTHING RETURNING *`, [mailboxAccountId, baselineHistoryId]);
  return result.rows[0] ? toState(result.rows[0]) : getMailboxSyncState(mailboxAccountId);
}

export async function getMailboxSyncState(mailboxAccountId: string): Promise<MailboxSyncState | null> {
  const result = await pool.query<SyncStateRow>("SELECT * FROM mailbox_sync_state WHERE mailbox_account_id=$1", [mailboxAccountId]);
  return result.rows[0] ? toState(result.rows[0]) : null;
}

export async function recordPendingHistory(mailboxAccountId: string, historyId: string): Promise<void> {
  await pool.query(`UPDATE mailbox_sync_state SET pending_history_id=CASE WHEN pending_history_id IS NULL OR pending_history_id::numeric < $2::numeric THEN $2 ELSE pending_history_id END,updated_at=now() WHERE mailbox_account_id=$1`, [mailboxAccountId, historyId]);
}

export async function markInitialSyncRunning(mailboxAccountId: string): Promise<void> {
  await pool.query("UPDATE mailbox_sync_state SET initial_sync_status='running',updated_at=now() WHERE mailbox_account_id=$1", [mailboxAccountId]);
}

export async function beginInitialSync(mailboxAccountId: string, baselineHistoryId: string): Promise<void> {
  await pool.query("UPDATE mailbox_sync_state SET applied_history_id=NULL,initial_baseline_history_id=$2,initial_sync_status='running',updated_at=now() WHERE mailbox_account_id=$1", [mailboxAccountId, baselineHistoryId]);
}

export async function applyProcessedHistory(mailboxAccountId: string, processedHistoryId: string, reconciliationMinutes: number, initial: boolean): Promise<MailboxSyncState> {
  return withTransaction(async (client) => {
    const result = await client.query<SyncStateRow>(`UPDATE mailbox_sync_state SET applied_history_id=$2,pending_history_id=CASE WHEN pending_history_id IS NOT NULL AND pending_history_id::numeric <= $2::numeric THEN NULL ELSE pending_history_id END,initial_sync_status=CASE WHEN $4 THEN 'complete'::initial_sync_status ELSE initial_sync_status END,reconciliation_due_at=now() + ($3 * interval '1 minute'),last_successful_sync_at=now(),last_failure_code=NULL,updated_at=now() WHERE mailbox_account_id=$1 RETURNING *`, [mailboxAccountId, processedHistoryId, reconciliationMinutes, initial]);
    await client.query("UPDATE mailbox_accounts SET last_history_id=$2,last_synced_at=now(),last_sync_error=NULL,status='active' WHERE id=$1", [mailboxAccountId, processedHistoryId]);
    return toState(result.rows[0]);
  });
}

export async function recordSyncFailure(mailboxAccountId: string, failureCode: string): Promise<void> {
  await pool.query("UPDATE mailbox_sync_state SET last_failure_code=$2,updated_at=now() WHERE mailbox_account_id=$1", [mailboxAccountId, failureCode]);
}

export async function claimDueReconciliations(limit: number, reconciliationMinutes: number): Promise<string[]> {
  return withTransaction(async (client) => {
    const result = await client.query<{ mailbox_account_id: string }>(`WITH due AS (SELECT state.mailbox_account_id FROM mailbox_sync_state state JOIN mailbox_accounts account ON account.id=state.mailbox_account_id WHERE state.reconciliation_due_at <= now() AND account.status='active' ORDER BY state.reconciliation_due_at ASC FOR UPDATE OF state SKIP LOCKED LIMIT $1) UPDATE mailbox_sync_state state SET reconciliation_due_at=now() + ($2 * interval '1 minute'),updated_at=now() FROM due WHERE state.mailbox_account_id=due.mailbox_account_id RETURNING state.mailbox_account_id`, [limit, reconciliationMinutes]);
    return result.rows.map((row) => row.mailbox_account_id);
  });
}
