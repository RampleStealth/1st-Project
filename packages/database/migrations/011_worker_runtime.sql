CREATE TABLE worker_heartbeats (
  worker_id UUID PRIMARY KEY,
  service_role TEXT NOT NULL CHECK (service_role IN ('combined')),
  release TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting','running','draining','stopped')),
  sync_consumer_status TEXT NOT NULL CHECK (sync_consumer_status IN ('starting','running','stopped')),
  command_consumer_status TEXT NOT NULL CHECK (command_consumer_status IN ('starting','running','stopped')),
  started_at TIMESTAMPTZ NOT NULL,
  last_heartbeat_at TIMESTAMPTZ NOT NULL,
  shutting_down_at TIMESTAMPTZ NULL,
  stopped_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX worker_heartbeats_status_heartbeat
  ON worker_heartbeats(status, last_heartbeat_at);
