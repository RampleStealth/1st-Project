# Milestone 1: Gmail connection and synchronization

## Scope

This release connects one Gmail account, synchronizes a bounded recent metadata window, receives change notifications, and exposes connection health. It does not render a mailbox, mutate Gmail content, or invoke AI.

## Google Cloud setup

1. Configure an OAuth web client with the exact `GOOGLE_REDIRECT_URI`.
2. Request only `gmail.readonly` for this release.
3. Create the Pub/Sub topic named by `GOOGLE_PUBSUB_TOPIC` in the same Google Cloud project as the OAuth client.
4. Grant `gmail-api-push@system.gserviceaccount.com` publisher access to that topic.
5. Create an authenticated push subscription targeting `/v1/webhooks/gmail`, configured with the `PUBSUB_SERVICE_ACCOUNT_EMAIL` and `PUBSUB_PUSH_AUDIENCE` values.
6. Complete Google OAuth consent-screen and sensitive-scope verification requirements before any external launch.

## Sync correctness

- Gmail `watch` is a trigger only; it is not the source of truth.
- The worker records a notification's history ID as pending, then advances its applied history ID only after the exact Gmail history range has been persisted.
- A mailbox with pending history newer than its applied history remains eligible for another sync pass, including when a competing worker holds the mailbox lease.
- A 404 history gap enqueues a scoped full resync.
- Watch renewal never advances the history checkpoint because doing so could skip mail changes.
- A PostgreSQL advisory lock serializes work per mailbox.
- Job IDs, provider identifiers, and database unique constraints make retries idempotent.
- Periodic reconciliation schedules an incremental sync even when no push notification is received.

## Operations

- Serve the API behind the same public hostname as the web application. In production, route `/v1/*` to the API service through the edge proxy; do not place the API on a different site.
- Renew watches every 12 hours; Gmail watches expire within seven days.
- Alert on watch expiration, last-sync freshness, repeated job failure, queue age, and token refresh failure.
- Do not log tokens, message content, subject lines, snippets, or recipient addresses.
- A transient sync error remains visible through `last_sync_error` while the account remains eligible for retries and reconciliation.

## Data retention

Milestone 1 stores connection state, encrypted refresh tokens, Gmail IDs, headers required for synchronization, labels, timestamps, and audit events. It intentionally does not persist email bodies, attachment contents, or message snippets.
