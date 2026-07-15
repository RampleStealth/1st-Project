# Gmail Sync Runbook

## Connection failures

- Verify the callback URI, OAuth consent screen, granted scope, and token encryption key.
- Do not ask for a broader Gmail scope to diagnose a failure.
- If a refresh token is revoked, mark the account `reauthorization_required` and prompt the user to reconnect.

## Sync failures

- Inspect the redacted job correlation ID and checkpoint record.
- Retry transient provider and network failures with the queue's backoff policy.
- A Gmail history 404 requires a full metadata resync; it is expected recovery behavior, not data loss.
- Do not manually advance `last_history_id`.

## Pub/Sub failures

- Verify the push subscription uses OIDC authentication and the expected audience.
- Verify the service account email matches `PUBSUB_SERVICE_ACCOUNT_EMAIL`.
- If notifications are delayed, reconciliation protects correctness; never add aggressive polling as a first response.
