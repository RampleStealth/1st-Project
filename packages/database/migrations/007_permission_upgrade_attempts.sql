ALTER TABLE mailbox_permission_state ADD COLUMN upgrade_attempt_id uuid NULL;
ALTER TABLE mailbox_permission_state ADD COLUMN upgrade_expires_at timestamptz NULL;
CREATE INDEX mailbox_permission_state_pending_expiry ON mailbox_permission_state(upgrade_expires_at) WHERE write_capability='upgrade_pending';
