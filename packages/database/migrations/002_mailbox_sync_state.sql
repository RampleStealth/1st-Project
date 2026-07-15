CREATE TYPE initial_sync_status AS ENUM ('pending', 'running', 'complete', 'failed');

CREATE TABLE mailbox_sync_state (
  mailbox_account_id UUID PRIMARY KEY REFERENCES mailbox_accounts(id) ON DELETE CASCADE,
  applied_history_id TEXT,
  pending_history_id TEXT,
  initial_baseline_history_id TEXT,
  initial_sync_status initial_sync_status NOT NULL DEFAULT 'pending',
  reconciliation_due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_successful_sync_at TIMESTAMPTZ,
  last_failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (applied_history_id IS NULL OR applied_history_id ~ '^[0-9]+$'),
  CHECK (pending_history_id IS NULL OR pending_history_id ~ '^[0-9]+$'),
  CHECK (initial_baseline_history_id IS NULL OR initial_baseline_history_id ~ '^[0-9]+$')
);

INSERT INTO mailbox_sync_state (mailbox_account_id, applied_history_id, initial_baseline_history_id, initial_sync_status, reconciliation_due_at, last_successful_sync_at)
SELECT id, last_history_id, last_history_id, CASE WHEN last_synced_at IS NULL THEN 'pending'::initial_sync_status ELSE 'complete'::initial_sync_status END, now(), last_synced_at
FROM mailbox_accounts;

CREATE INDEX mailbox_sync_state_reconciliation_due ON mailbox_sync_state(reconciliation_due_at) WHERE initial_sync_status <> 'failed';
