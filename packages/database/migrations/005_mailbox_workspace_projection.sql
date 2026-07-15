ALTER TABLE threads
  ADD COLUMN latest_provider_message_id TEXT,
  ADD COLUMN latest_sender_display TEXT,
  ADD COLUMN latest_sender_address TEXT,
  ADD COLUMN latest_snippet TEXT,
  ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  ADD COLUMN has_attachments BOOLEAN,
  ADD COLUMN has_draft BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN last_provider_updated_at TIMESTAMPTZ;

ALTER TABLE messages
  ADD COLUMN subject TEXT,
  ADD COLUMN to_address_summary TEXT,
  ADD COLUMN cc_address_summary TEXT,
  ADD COLUMN has_attachments BOOLEAN;

CREATE INDEX threads_mailbox_provider_updated
  ON threads(mailbox_account_id, last_provider_updated_at DESC, id DESC);
CREATE INDEX threads_provider_labels_gin ON threads USING GIN(provider_labels);
