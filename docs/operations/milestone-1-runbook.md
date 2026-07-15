# Gmail Sync Runbook

## Connection failures

- Verify the callback URI, OAuth consent screen, granted scope, and token encryption key.
- Do not ask for a broader Gmail scope to diagnose a failure.
- If a refresh token is revoked, mark the account `reauthorization_required` and prompt the user to reconnect.

## Sync failures

- Inspect the redacted job correlation ID and checkpoint record.
- After the legacy-watermark reset, `sync_baseline_required` is expected until the worker completes a fresh initial synchronization. Do not restore a historical checkpoint manually.
- Compare `mailbox_sync_state.applied_history_id` with `pending_history_id`; never manually advance either value.
- Retry transient provider and network failures with the queue's backoff policy.
- A Gmail history 404 requires a full metadata resync; it is expected recovery behavior, not data loss.
- Do not manually advance `last_history_id`.

## Reconciliation failures

- Reconciliation runs independently of Gmail push delivery and claims due mailboxes with database locking.
- If a mailbox has pending history newer than applied history, verify that a sync job exists or enqueue a reconciliation job; do not clear pending state.
- A lease-contention retry is expected during busy mailbox activity. It becomes actionable only when queue retries are exhausted or sync freshness breaches its service objective.

## Pub/Sub failures

- Verify the push subscription uses OIDC authentication and the expected audience.
- Verify the service account email matches `PUBSUB_SERVICE_ACCOUNT_EMAIL`.
- If notifications are delayed, reconciliation protects correctness; never add aggressive polling as a first response.
