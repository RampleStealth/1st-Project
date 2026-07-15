CREATE TABLE provider_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mailbox_account_id uuid NOT NULL REFERENCES mailbox_accounts(id) ON DELETE CASCADE, thread_id uuid NULL REFERENCES threads(id) ON DELETE SET NULL, draft_id uuid NULL,
 command_type text NOT NULL CHECK(command_type IN ('archive_thread','mark_thread_unread','create_draft','update_draft','send_draft')), encrypted_payload text NOT NULL, request_fingerprint text NOT NULL, idempotency_key text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','running','succeeded','failed','retryable','recovery_required')), attempt_count integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), failure_code text NULL, failure_detail text NULL, provider_result_reference text NULL, active_claim_id uuid NULL, lease_expires_at timestamptz NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz NULL,
 UNIQUE(mailbox_account_id,idempotency_key)
);
CREATE INDEX provider_commands_due ON provider_commands(status,next_attempt_at) WHERE status IN ('pending','retryable');
CREATE TABLE provider_command_attempts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), command_id uuid NOT NULL REFERENCES provider_commands(id) ON DELETE CASCADE, claim_id uuid NOT NULL, attempt_number integer NOT NULL, status text NOT NULL, failure_code text NULL, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz NULL, UNIQUE(command_id,attempt_number));
