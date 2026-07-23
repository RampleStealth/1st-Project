ALTER TABLE messages
  ALTER COLUMN internal_timestamp DROP NOT NULL,
  ADD COLUMN from_display_name TEXT,
  ADD COLUMN to_addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN cc_addresses JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE messages
  ADD CONSTRAINT messages_to_addresses_array CHECK (jsonb_typeof(to_addresses) = 'array'),
  ADD CONSTRAINT messages_cc_addresses_array CHECK (jsonb_typeof(cc_addresses) = 'array');

COMMENT ON COLUMN messages.from_address IS 'Normalized sender email address; display name is stored separately.';
COMMENT ON COLUMN messages.to_addresses IS 'Ordered normalized mailbox objects from the Gmail To header.';
COMMENT ON COLUMN messages.cc_addresses IS 'Ordered normalized mailbox objects from the Gmail Cc header.';
COMMENT ON COLUMN threads.participant_summary IS 'Deterministic display summary of up to five normalized thread participants.';
