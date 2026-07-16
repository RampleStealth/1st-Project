ALTER TABLE provider_commands ADD COLUMN correlation_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE outbox_events ADD COLUMN correlation_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE INDEX provider_commands_correlation_id ON provider_commands(correlation_id);
CREATE INDEX outbox_events_correlation_id ON outbox_events(correlation_id);
