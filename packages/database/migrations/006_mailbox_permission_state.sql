CREATE TABLE mailbox_permission_state (
  mailbox_account_id uuid PRIMARY KEY REFERENCES mailbox_accounts(id) ON DELETE CASCADE,
  write_capability text NOT NULL DEFAULT 'read_only' CHECK (write_capability IN ('read_only','upgrade_pending','write_granted','upgrade_declined','upgrade_failed')),
  granted_scopes text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO mailbox_permission_state(mailbox_account_id, granted_scopes)
SELECT id, granted_scopes FROM mailbox_accounts ON CONFLICT DO NOTHING;
