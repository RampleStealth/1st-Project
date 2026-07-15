-- Migration 002 copied historical mailbox checkpoints for continuity. Those values
-- were produced by a synchronization algorithm with a known watermark race, so
-- they cannot establish a trustworthy applied-history boundary.
--
-- This migration affects only mailbox rows that already exist at migration time.
-- Fresh installations have no rows to update, and mailbox connections created after
-- this migration continue through the normal initial-sync path.
UPDATE mailbox_sync_state
SET
  applied_history_id = NULL,
  pending_history_id = NULL,
  initial_baseline_history_id = NULL,
  initial_sync_status = 'pending',
  reconciliation_due_at = now(),
  last_successful_sync_at = NULL,
  last_failure_code = NULL,
  updated_at = now();

UPDATE mailbox_accounts
SET
  last_history_id = NULL,
  last_synced_at = NULL,
  last_sync_error = 'sync_baseline_required'
WHERE EXISTS (
  SELECT 1
  FROM mailbox_sync_state state
  WHERE state.mailbox_account_id = mailbox_accounts.id
);
