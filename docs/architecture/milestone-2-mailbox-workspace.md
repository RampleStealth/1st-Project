# Milestone 2: Mailbox Workspace Security

## Thread pagination cursors

Thread cursors encrypt Gmail page tokens with AES-256-GCM. They never use the refresh-token encryption key directly. The application derives a dedicated 32-byte key with HKDF-SHA256 from the configured master key, using the fixed salt `aio/key-derivation-salt/v1` and info/context `aio/thread-pagination-cursor/v1`.

Cursor payloads are versioned. Version `1` binds the authenticated user ID, mailbox ID, selected view, requested page size, Gmail page token, and expiry. Missing, malformed, unsupported, expired, tampered, or mismatched cursors are all rejected through the same safe invalid-cursor response.

## Gmail list behavior

The Gmail adapter independently accepts only integer page sizes from 1 through 100 before it makes a provider request. Gmail remains the list authority in this milestone; the local thread/message projection is a read-through cache, not a complete mailbox index.

The Drafts view uses `threads.list` with Gmail's `DRAFT` system label. Gmail thread list results are provider-thread records and therefore do not create duplicate threads in the application. This phase does not call `drafts.list` and does not expose Gmail draft-resource IDs.

## Provider error logging

Provider-facing operations log only allowlisted metadata: classified application code, normalized status category, operation, mailbox/correlation/job identifiers, retryability, and a fixed safe message. Raw Gmail, Google API, OAuth, Gaxios, provider response, request URL, headers, tokens, email addresses, provider identifiers, and provider stack metadata must never be passed to a logger. Non-provider application errors retain normal error logging for debugging.
