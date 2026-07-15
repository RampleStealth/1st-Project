import type { PoolClient } from "pg";
import { pool, withTransaction } from "../index.js";
import type { MailboxSyncState } from "@aio/contracts";

type SyncStateRow = { mailbox_account_id: string; applied_history_id: string | null; pending_history_id: string | null; initial_baseline_history_id: string | null; initial_sync_status: "pending" | "running" | "complete" | "failed"; reconciliation_due_at: Date | null; last_successful_sync_at: Date | null; };
type SyncStateUpdateRow = SyncStateRow & { previous_applied_history_id: string | null };
export type HistoryApplyResult = { state: MailboxSyncState; outcome: "advanced" | "idempotent" | "stale" };

export class InvalidHistoryIdError extends Error {
  constructor(value: string, field: string) {
    super(`${field} must be a non-empty decimal Gmail history ID`);
    this.name = "InvalidHistoryIdError";
  }
}

export class MissingMailboxSyncStateError extends Error {
  constructor(mailboxAccountId: string) {
    super(`Mailbox sync state is missing for ${mailboxAccountId}`);
    this.name = "MissingMailboxSyncStateError";
  }
}

function requireHistoryId(value: string, field: string): string {
  if (!/^\d+$/.test(value)) throw new InvalidHistoryIdError(value, field);
  return value;
}

function requireStateMutation(rowCount: number | null, mailboxAccountId: string) {
  if (rowCount !== 1) throw new MissingMailboxSyncStateError(mailboxAccountId);
}

function toState(row: SyncStateRow): MailboxSyncState {
  return { mailboxAccountId: row.mailbox_account_id, appliedHistoryId: row.applied_history_id, pendingHistoryId: row.pending_history_id, initialBaselineHistoryId: row.initial_baseline_history_id, initialSyncStatus: row.initial_sync_status, reconciliationDueAt: row.reconciliation_due_at, lastSuccessfulSyncAt: row.last_successful_sync_at };
}

/** Creates only a pending state. A Gmail history ID becomes trusted when beginInitialSync captures it. */
export async function ensureMailboxSyncState(mailboxAccountId: string): Promise<MailboxSyncState> {
  const result = await pool.query<SyncStateRow>(`INSERT INTO mailbox_sync_state(mailbox_account_id, reconciliation_due_at) VALUES($1, now()) ON CONFLICT(mailbox_account_id) DO NOTHING RETURNING *`, [mailboxAccountId]);
  if (result.rows[0]) return toState(result.rows[0]);
  const state = await getMailboxSyncState(mailboxAccountId);
  if (!state) throw new MissingMailboxSyncStateError(mailboxAccountId);
  return state;
}

export async function getMailboxSyncState(mailboxAccountId: string): Promise<MailboxSyncState | null> {
  const result = await pool.query<SyncStateRow>("SELECT * FROM mailbox_sync_state WHERE mailbox_account_id=$1", [mailboxAccountId]);
  return result.rows[0] ? toState(result.rows[0]) : null;
}

export async function recordPendingHistory(mailboxAccountId: string, historyId: string): Promise<void> {
  requireHistoryId(historyId, "pending history ID");
  const result = await pool.query(`UPDATE mailbox_sync_state SET pending_history_id=CASE WHEN pending_history_id IS NULL OR pending_history_id::numeric < $2::numeric THEN $2::text ELSE pending_history_id END,updated_at=now() WHERE mailbox_account_id=$1`, [mailboxAccountId, historyId]);
  requireStateMutation(result.rowCount, mailboxAccountId);
}

export async function markInitialSyncRunning(mailboxAccountId: string): Promise<void> {
  const result = await pool.query("UPDATE mailbox_sync_state SET initial_sync_status='running',updated_at=now() WHERE mailbox_account_id=$1", [mailboxAccountId]);
  requireStateMutation(result.rowCount, mailboxAccountId);
}

/**
 * Starts a baseline/recovery pass. Pending notifications and prior diagnostics stay intact:
 * the worker drains pending history after the baseline commits, and a successful commit clears
 * failure state. This avoids discarding notifications received while recovery is being prepared.
 */
export async function beginInitialSync(mailboxAccountId: string, baselineHistoryId: string): Promise<void> {
  requireHistoryId(baselineHistoryId, "initial baseline history ID");
  const result = await pool.query("UPDATE mailbox_sync_state SET applied_history_id=NULL,initial_baseline_history_id=$2,initial_sync_status='running',updated_at=now() WHERE mailbox_account_id=$1", [mailboxAccountId, baselineHistoryId]);
  requireStateMutation(result.rowCount, mailboxAccountId);
}

/** Must be called with the transaction that persisted the corresponding Gmail projection changes. */
export async function applyProcessedHistory(client: PoolClient, mailboxAccountId: string, processedHistoryId: string, reconciliationMinutes: number, initial: boolean): Promise<HistoryApplyResult> {
  requireHistoryId(processedHistoryId, "processed history ID");
  const result = await client.query<SyncStateUpdateRow>(`WITH prior AS (
      SELECT mailbox_account_id, applied_history_id FROM mailbox_sync_state WHERE mailbox_account_id=$1 FOR UPDATE
    ), updated AS (
      UPDATE mailbox_sync_state AS state
      SET applied_history_id=CASE WHEN state.applied_history_id IS NULL OR state.applied_history_id::numeric <= $2::numeric THEN $2::text ELSE state.applied_history_id END,
          pending_history_id=CASE WHEN state.pending_history_id IS NOT NULL AND state.pending_history_id::numeric <= GREATEST(COALESCE(state.applied_history_id::numeric, 0), $2::numeric) THEN NULL ELSE state.pending_history_id END,
          initial_sync_status=CASE WHEN $4 THEN 'complete'::initial_sync_status ELSE state.initial_sync_status END,
          reconciliation_due_at=now() + ($3 * interval '1 minute'),last_successful_sync_at=now(),last_failure_code=NULL,updated_at=now()
      FROM prior
      WHERE state.mailbox_account_id=prior.mailbox_account_id
      RETURNING state.*, prior.applied_history_id AS previous_applied_history_id
    ) SELECT * FROM updated`, [mailboxAccountId, processedHistoryId, reconciliationMinutes, initial]);
  requireStateMutation(result.rowCount, mailboxAccountId);
  const state = toState(result.rows[0]);
  const mirror = await client.query("UPDATE mailbox_accounts SET last_history_id=$2,last_synced_at=now(),last_sync_error=NULL,status='active' WHERE id=$1", [mailboxAccountId, state.appliedHistoryId]);
  if (mirror.rowCount !== 1) throw new Error(`Mailbox account is missing for ${mailboxAccountId}`);
  const previous = result.rows[0].previous_applied_history_id;
  const outcome = previous === null || BigInt(processedHistoryId) > BigInt(previous)
    ? "advanced"
    : BigInt(processedHistoryId) === BigInt(previous)
      ? "idempotent"
      : "stale";
  return { state, outcome };
}

export async function recordSyncFailure(mailboxAccountId: string, failureCode: string): Promise<void> {
  const result = await pool.query("UPDATE mailbox_sync_state SET last_failure_code=$2,updated_at=now() WHERE mailbox_account_id=$1", [mailboxAccountId, failureCode]);
  requireStateMutation(result.rowCount, mailboxAccountId);
}

export async function claimDueReconciliations(limit: number, reconciliationMinutes: number): Promise<string[]> {
  return withTransaction(async (client) => {
    const result = await client.query<{ mailbox_account_id: string }>(`WITH due AS (SELECT state.mailbox_account_id FROM mailbox_sync_state state JOIN mailbox_accounts account ON account.id=state.mailbox_account_id WHERE state.reconciliation_due_at <= now() AND account.status='active' ORDER BY state.reconciliation_due_at ASC FOR UPDATE OF state SKIP LOCKED LIMIT $1) UPDATE mailbox_sync_state state SET reconciliation_due_at=now() + ($2 * interval '1 minute'),updated_at=now() FROM due WHERE state.mailbox_account_id=due.mailbox_account_id RETURNING state.mailbox_account_id`, [limit, reconciliationMinutes]);
    return result.rows.map((row) => row.mailbox_account_id);
  });
}

/** Releases a reconciliation claim immediately when its queue handoff fails. */
export async function releaseReconciliationClaim(mailboxAccountId: string): Promise<void> {
  const result = await pool.query("UPDATE mailbox_sync_state SET reconciliation_due_at=now(),updated_at=now() WHERE mailbox_account_id=$1", [mailboxAccountId]);
  requireStateMutation(result.rowCount, mailboxAccountId);
}
