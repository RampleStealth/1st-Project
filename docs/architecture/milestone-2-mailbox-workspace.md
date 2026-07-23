# Milestone 2: Mailbox Workspace Security

## Thread pagination cursors

Thread cursors encrypt Gmail page tokens with AES-256-GCM. They never use the refresh-token encryption key directly. The application derives a dedicated 32-byte key with HKDF-SHA256 from the configured master key, using the fixed salt `aio/key-derivation-salt/v1` and info/context `aio/thread-pagination-cursor/v1`.

Cursor payloads are versioned. Version `1` binds the authenticated user ID, mailbox ID, selected view, requested page size, Gmail page token, and expiry. Missing, malformed, unsupported, expired, tampered, or mismatched cursors are all rejected through the same safe invalid-cursor response.

## Gmail list behavior

The Gmail adapter independently accepts only integer page sizes from 1 through 100 before it makes a provider request. Gmail remains the list authority in this milestone; the local thread/message projection is a read-through cache, not a complete mailbox index.

The Drafts view uses `threads.list` with Gmail's `DRAFT` system label. Gmail thread list results are provider-thread records and therefore do not create duplicate threads in the application. This phase does not call `drafts.list` and does not expose Gmail draft-resource IDs.

## Normalized projection metadata

Gmail-specific normalization occurs before PostgreSQL persistence. Projection hydration requests MIME structure, headers, labels, snippets, and attachment identifiers through a partial `threads.get` response; message body data is excluded. The database repository accepts only the provider-neutral `ThreadProjectionInput` contract.

Mailbox addresses are Unicode-normalized, safely decoded from common RFC 2047 encoded words, split into display name and lowercase email address, deduplicated by address, and retained in provider order. `To` and `Cc` are stored as structured JSON arrays while their existing deterministic display summaries remain available for compatibility. Thread participant summaries contain at most five unique addresses sorted by normalized email, followed by a `+N` remainder.

Messages are canonically ordered by valid provider timestamp and provider message ID. Missing or malformed timestamps remain `NULL`; future provider timestamps remain unchanged so repeated synchronization is deterministic. Priority evaluation must later clamp negative age to zero against its fixed evaluation timestamp. A message has attachments when any returned MIME part has a filename or attachment identifier, and a thread has attachments when any projected message does.

Existing rows are normalized on their next provider-backed hydration or synchronization. The additive migration does not guess structured addresses from legacy summary strings.

## Provider error logging

Provider-facing operations log only allowlisted metadata: classified application code, normalized status category, operation, mailbox/correlation/job identifiers, retryability, and a fixed safe message. Raw Gmail, Google API, OAuth, Gaxios, provider response, request URL, headers, tokens, email addresses, provider identifiers, and provider stack metadata must never be passed to a logger. Non-provider application errors retain normal error logging for debugging.
