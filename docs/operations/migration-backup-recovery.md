# Migration, backup, Redis-loss, and recovery runbook

## Migrations

`npm run db:migrate` serializes execution with PostgreSQL advisory lock `aio-schema-migrations-v1`. It validates deterministic filenames, stores SHA-256 checksums, and rejects a committed-file mismatch. `npm run db:status` reports safe name/status/checksum-match data; `npm run db:verify` requires no pending migrations. Test clean databases in an isolated database, never by deleting the development database.

The runner recognizes only two retired historical records (`003_reset_legacy_sync_watermarks.sql` and `003_reset_untrusted_legacy_watermarks.sql`) to permit upgrades from the pre-checksum local history. They are not part of a new-install manifest; any other unknown migration record fails integrity verification.

If migration fails, stop rollout, retain the failed image and database, inspect safe migration status, and repair only with a new additive migration. Never edit a committed migration or manually alter its checksum.

## Backup and restore

Use an encrypted logical PostgreSQL backup from an isolated backup identity, for example `pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > encrypted-backup.dump` where encryption is supplied by the approved backup system. Keep encryption keys out of scripts and the backup destination. V1 target: RPO 24 hours and RTO 4 hours until restore drills demonstrate a better value.

Restore only to an isolated target with an explicit database name. Run `pg_restore --clean --if-exists --no-owner --dbname "$RESTORE_DATABASE_URL" encrypted-backup.dump`, then `npm run db:verify`, verify drafts/commands/outbox counts, command-state constraints, and migration checksums. Do not point restore tooling at production without a separately reviewed, explicit change procedure.

## Redis loss and queue reconstruction

PostgreSQL remains authoritative for provider commands and the transactional outbox. Redis loss can drop sessions, OAuth state, and rate-limit windows; users reauthenticate and abandoned OAuth attempts expire safely. It cannot erase command intent or provider-confirmed projections.

After Redis recovery, inspect `npm run ops:summary`. Queue reconstruction requires an explicit `npm run ops:replay-queue -- --confirm`. It re-enqueues only existing `pending` or `retryable` command UUIDs, skips terminal and `recovery_required` commands, writes a secret-free audit event, and never calls Gmail directly. BullMQ job IDs preserve duplicate safety. Never blindly replay an uncertain Gmail send or draft creation.

## Incident containment

For readiness failures, queue backlog, worker-heartbeat loss, Redis outage, PostgreSQL outage, Gmail outage, OAuth revocation spikes, or recovery-required spikes: freeze deploys, preserve logs and migration status, assess safe diagnostics, and follow the relevant worker/draft runbooks. Prohibited actions include modifying payloads, deleting outbox rows, forcing a command to succeeded, or replaying recovery-required send commands. Suspected secret exposure requires immediate credential rotation, session revocation, diagnostics-token rotation, release freeze, and incident review.
