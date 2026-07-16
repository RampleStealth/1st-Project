-- Command outbox dispatch claims filter by event type and publication state, then order by creation time.
-- The partial index avoids scanning unrelated event types while retaining lease recovery semantics.
CREATE INDEX outbox_events_command_dispatch_due
  ON outbox_events(event_type, created_at)
  WHERE published_at IS NULL;

-- Guarded publish/release uses the dispatcher claim ID after enqueue confirmation or failure.
CREATE INDEX outbox_events_active_dispatch_claim
  ON outbox_events(dispatch_claim_id)
  WHERE published_at IS NULL AND dispatch_claim_id IS NOT NULL;
