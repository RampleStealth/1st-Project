CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE mailbox_status AS ENUM ('active', 'reauthorization_required', 'disconnected', 'sync_failed');
CREATE TYPE sync_status AS ENUM ('queued', 'running', 'succeeded', 'failed');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_active_by_user ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE mailbox_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'gmail'),
  provider_account_id TEXT NOT NULL,
  email_address TEXT NOT NULL,
  status mailbox_status NOT NULL DEFAULT 'active',
  encrypted_refresh_token TEXT NOT NULL,
  granted_scopes TEXT[] NOT NULL,
  last_history_id TEXT,
  last_synced_at TIMESTAMPTZ,
  last_sync_error TEXT,
  watch_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  UNIQUE(provider, provider_account_id),
  UNIQUE(user_id, provider, email_address)
);
CREATE INDEX mailbox_accounts_active_watch ON mailbox_accounts(watch_expires_at) WHERE status = 'active';

CREATE TABLE threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_account_id UUID NOT NULL REFERENCES mailbox_accounts(id) ON DELETE CASCADE,
  provider_thread_id TEXT NOT NULL,
  subject_normalized TEXT,
  participant_summary TEXT,
  last_message_at TIMESTAMPTZ,
  unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  provider_labels TEXT[] NOT NULL DEFAULT '{}',
  sync_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(mailbox_account_id, provider_thread_id)
);
CREATE INDEX threads_mailbox_recent ON threads(mailbox_account_id, last_message_at DESC);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  provider_message_id TEXT NOT NULL,
  internal_timestamp TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  from_address TEXT,
  snippet TEXT,
  provider_labels TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(thread_id, provider_message_id)
);
CREATE INDEX messages_thread_time ON messages(thread_id, internal_timestamp DESC);

CREATE TABLE sync_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_account_id UUID NOT NULL REFERENCES mailbox_accounts(id) ON DELETE CASCADE,
  sync_type TEXT NOT NULL CHECK (sync_type IN ('initial', 'incremental', 'reconciliation')),
  start_history_id TEXT,
  end_history_id TEXT,
  status sync_status NOT NULL DEFAULT 'queued',
  failure_code TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sync_checkpoints_mailbox_recent ON sync_checkpoints(mailbox_account_id, created_at DESC);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_object ON audit_events(object_type, object_id, occurred_at DESC);

CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX outbox_events_unpublished ON outbox_events(created_at) WHERE published_at IS NULL;
