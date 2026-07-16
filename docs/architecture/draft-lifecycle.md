# Gmail Draft Lifecycle

## Authority and boundaries

Gmail is the provider authority for an application-created draft and for a sent
message. PostgreSQL is a durable, encrypted projection of the application
intent and of provider-confirmed identifiers. It is not a general Gmail Draft
mirror and it never stores raw MIME.

The browser calls only the application API. The API validates ownership, CSRF,
write permission, idempotency, and content; it writes the encrypted projection,
provider command, and outbox event in one transaction. The worker is the only
Gmail mutation boundary. It verifies a command claim and lease before loading
or decrypting a draft, builds MIME only for create/update, then records provider
confirmation and the local projection in one PostgreSQL transaction.

Provider-command queue jobs contain only the command UUID. Encrypted command
payloads contain only a local draft UUID for create, and a local draft UUID plus
revision for update/send. They never contain recipients, content, Message-ID,
or Gmail identifiers.

## Draft states

```text
creating --(Gmail create confirmed)--> ready
creating --(post-marker uncertainty)--> recovery_required

ready --(update requested)--> updating
updating --(Gmail update confirmed)--> ready
updating --(external change)--> conflict
updating --(post-marker uncertainty)--> recovery_required

ready --(send requested)--> sending
sending --(Gmail send confirmed)--> sent
sending --(external change)--> conflict
sending --(post-marker uncertainty)--> recovery_required
recovery_required --(one verified provider match)--> ready | sent
```

`sent` is terminal. `conflict` and `recovery_required` do not automatically
return to `ready`. `creation_failed` remains a reserved terminal schema value;
the current worker uses the command failure state for pre-provider creation
failures instead of transitioning a draft to it.

Repository transitions lock the draft row and reject active commands. The
partial unique index additionally prevents more than one active create, update,
or send command per draft. Provider-confirmed completion rechecks the active
claim and lease, updates the projection, transitions the command, and writes a
safe audit record in one transaction.

## Confirmation, retries, and uncertainty

Before `drafts.create`, `drafts.update`, or `drafts.send`, the worker commits a
durable execution marker under its active claim. A transient error before this
marker can use bounded exponential retry based on the persisted attempt count.
Any outcome after the marker is uncertain and becomes `recovery_required`; it
is never automatically replayed.

Create recovery searches Draft resources only by the stable application-owned
RFC 5322 Message-ID. One match confirms the original create atomically; zero or
multiple matches remain unresolved. Update verification deliberately remains
inconclusive because metadata-only Gmail reads cannot prove the encrypted local
content equals Gmail's updated MIME. Send recovery searches Sent only by that
same Message-ID. One match confirms the send atomically; zero or ambiguous
matches remain recovery-required. Recovery checks are read-only and never issue
create, update, or send operations.

## Send guarantee

The system provides duplicate resistance, not exactly-once email delivery:

- UUID idempotency keys and request fingerprints reject conflicting replays.
- A draft row lock plus a partial unique active-send index permits one active
  send command per draft.
- Only a clean, provider-confirmed `ready` revision can enter `sending`.
- The stable Message-ID supports read-only Sent verification after ambiguity.
- A worker never automatically resends after the execution marker is committed.

Gmail acceptance followed by process failure can therefore leave a draft in
`recovery_required` until verification finds exactly one Sent match. We do not
claim exactly-once delivery.

## Content safety

Structured content is Unicode-NFC normalized, recipients are normalized,
deduplicated, and ordered, and the canonical structure—not MIME—is HMAC
fingerprinted. Recipients, subject, plain text, and optional HTML are encrypted
at rest. HTML is sanitized before storage, preview, and MIME construction.
The MIME builder rejects header injection and oversized content and creates only
plain text or `multipart/alternative` messages without attachments.

Logs, audit metadata, queue payloads, command-status responses, and safe API
errors contain no draft content, fingerprint, stable Message-ID, Gmail ID,
encrypted payload, token, raw MIME, or raw provider response.

## Deliberate limitations

Only application-created Gmail drafts are in scope. There is no Gmail-native
draft import/editing, autosave, attachment, reply, forward, scheduled send,
undo-send, template, signature, or AI workflow. Update recovery remains
conservative rather than declaring content equality from Gmail metadata.
