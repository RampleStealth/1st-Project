CREATE TABLE drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_account_id UUID NOT NULL REFERENCES mailbox_accounts(id) ON DELETE CASCADE,
  gmail_draft_id TEXT NULL,
  gmail_draft_message_id TEXT NULL,
  gmail_thread_id TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('creating','ready','updating','sending','sent','conflict','recovery_required','creation_failed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  confirmed_revision INTEGER NULL CHECK (confirmed_revision IS NULL OR (confirmed_revision >= 1 AND confirmed_revision <= revision)),
  rfc822_message_id TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  confirmed_content_fingerprint TEXT NULL,
  encrypted_recipients TEXT NOT NULL,
  encrypted_subject TEXT NOT NULL,
  encrypted_plain_text TEXT NOT NULL,
  encrypted_html TEXT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0 CHECK (recipient_count >= 0 AND recipient_count <= 50),
  body_byte_count INTEGER NOT NULL DEFAULT 0 CHECK (body_byte_count >= 0),
  has_html BOOLEAN NOT NULL DEFAULT FALSE,
  last_command_id UUID NULL REFERENCES provider_commands(id) ON DELETE SET NULL,
  provider_updated_at TIMESTAMPTZ NULL,
  provider_checked_at TIMESTAMPTZ NULL,
  conflict_observed_at TIMESTAMPTZ NULL,
  sent_gmail_message_id TEXT NULL,
  sent_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_account_id, rfc822_message_id),
  CHECK (status NOT IN ('ready','updating','sending','conflict') OR gmail_draft_id IS NOT NULL),
  CHECK (status <> 'sent' OR (sent_gmail_message_id IS NOT NULL AND sent_at IS NOT NULL))
);

CREATE UNIQUE INDEX drafts_mailbox_gmail_draft_id
  ON drafts(mailbox_account_id, gmail_draft_id)
  WHERE gmail_draft_id IS NOT NULL;
CREATE INDEX drafts_mailbox_status_updated
  ON drafts(mailbox_account_id, status, updated_at DESC);
CREATE INDEX drafts_recovery_due
  ON drafts(status, provider_checked_at)
  WHERE status IN ('recovery_required','conflict');

ALTER TABLE provider_commands
  ADD CONSTRAINT provider_commands_draft_id_fkey
  FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE SET NULL;
ALTER TABLE provider_commands
  ADD COLUMN provider_execution_started_at TIMESTAMPTZ NULL;

CREATE UNIQUE INDEX provider_commands_one_active_draft_mutation
  ON provider_commands(draft_id)
  WHERE draft_id IS NOT NULL
    AND command_type IN ('create_draft','update_draft','send_draft')
    AND status IN ('pending','running','retryable','recovery_required');
CREATE UNIQUE INDEX provider_commands_one_active_draft_send
  ON provider_commands(draft_id)
  WHERE draft_id IS NOT NULL
    AND command_type = 'send_draft'
    AND status IN ('pending','running','retryable','recovery_required');
