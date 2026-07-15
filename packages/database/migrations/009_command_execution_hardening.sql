ALTER TABLE outbox_events ADD COLUMN dispatch_claim_id uuid NULL, ADD COLUMN dispatch_lease_expires_at timestamptz NULL, ADD COLUMN dispatch_claimed_at timestamptz NULL;
CREATE INDEX outbox_events_dispatch_due ON outbox_events(created_at) WHERE published_at IS NULL;
