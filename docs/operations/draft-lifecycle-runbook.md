# Draft Lifecycle Runbook

## Operator response to recovery-required drafts

1. Do not requeue the original create, update, or send command.
2. Inspect only safe command state, failure code, timestamps, and audit event
   names; do not add content, Message-ID, Gmail identifiers, or provider errors
   to notes or logs.
3. For an uncertain create, an operator can enqueue the existing read-only
   Message-ID Draft-verification job through internal queue tooling. One match
   completes the original command; no or multiple matches remain unresolved.
4. For an uncertain update, retain `recovery_required`. Its read-only metadata
   verification job is also operator-only, and cannot prove content equality.
5. For an uncertain send, use the explicit read-only Sent verification action.
   One match completes the original command; no match with a remaining Draft is
   unconfirmed, no match with no Draft is unknown, and multiple matches are
   ambiguous. None of these cases authorizes a resend.

## Before public launch: controlled Gmail-account checklist

Run each case against a dedicated Gmail account and record only safe result
codes/timestamps:

- Create a plain-text and a multipart draft; confirm Gmail Draft and message IDs
  are projected only after provider success.
- Update an application draft; verify Gmail replaces its message identifier.
- Edit the Gmail Draft outside the app, then attempt an update and send; confirm
  the app reports conflict without overwriting Gmail.
- Send a clean confirmed revision and confirm a single Sent match by the stable
  Message-ID.
- Simulate a timeout or worker stop after the execution marker for create and
  send; confirm no automatic duplicate operation and verify read-only recovery.
- Revoke credentials, remove write scope, delete a Gmail Draft, and exercise
  concurrent browser tabs.
- Verify Bcc delivery and recipient privacy with Gmail's actual behavior.

Automated tests validate local transactions, guarded claims, encryption,
provider-call boundaries, and fake-adapter error handling. They do not prove
Gmail's live delivery, search indexing delay, Bcc behavior, or every OAuth
provider edge case.

The current end-user recovery action is intentionally limited to send
verification. Create/update verification is an operator workflow until a future
product phase defines a safe, user-facing recovery experience.

## Deployment checks

- Run migrations on a backup-restored or fresh database before deployment.
- Confirm `drafts` has the mailbox/Message-ID and partial active-command indexes.
- Confirm worker and API use the same encryption master-key configuration.
- Verify queue workers can process `provider_command` and explicit verification
  jobs; recovery jobs must have Gmail read access but must not perform writes.
- Keep SEC-001 (Google runtime dependency upgrade) tracked separately; this
  draft lifecycle work does not change that dependency risk.
