# Controlled Gmail validation and Version 1 readiness

## Guardrails

Use dedicated isolated Gmail test accounts only. Never use a personal or production mailbox for mutation or send tests. Begin with `pnpm validate:gmail:dry-run`; it creates a local, secret-free JSON template and makes zero provider calls. The live flag deliberately blocks: a human operator must perform the documented checks and record only run ID, timestamp, environment, release, operation, pass/fail/blocked, safe reason code, correlation ID, and content-free notes.

Use a unique run ID and a non-secret subject/body marker. Do not record tokens, raw Gmail responses, recipients beyond approved aliases, Gmail IDs, Message-IDs, or message content. Separate read-only checks from archive/unread/draft/send checks. Clean up test messages and drafts manually after recording results.

## Checklist

Validate OAuth consent/decline/expiry/replay/mismatch/reconnect; watch setup, authenticated Pub/Sub, duplicate notification, incremental sync, renewal, history-gap recovery, and reconciliation; mailbox views, pagination, safe rendering, remote-image blocking, links, and deleted threads; archive/unread exact-label effects; draft create/update/send, conflict, uncertainty verification, and BCC privacy; then multi-tab/browser/external-Gmail concurrency.

Do not automatically resend, recreate, or replay `recovery_required` operations. In particular, never blindly replay an uncertain Gmail send.

## Release gate

Before limited-pilot approval, record evidence for clean build, migration verification, artifact build, API liveness/readiness, worker heartbeat, protected diagnostics, backup/restore drill (or explicit block), Redis-loss queue reconstruction drill, warning-free frontend suite, no severe accessibility findings, SEC-001 disposition, rollback readiness, incident ownership, and every controlled Gmail result. Items without evidence remain `blocked` or `not-run`; they are never treated as complete.
