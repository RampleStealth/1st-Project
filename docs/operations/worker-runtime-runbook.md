# Worker runtime runbook

## Startup and readiness

Run the worker through its production executable. Startup must produce a current `worker_heartbeats` row with both consumer statuses `running`. A worker is ready only when both consumers are active, the scheduler handles are present, and bounded PostgreSQL and Redis checks succeed.

Useful safe checks are the durable heartbeat table and the runtime diagnostics module. Investigate a heartbeat that is older than `WORKER_HEARTBEAT_STALE_SECONDS`, an accumulating unpublished outbox count, stale running commands, or an increasing `recovery_required` count. Do not inspect command payloads or provider responses to diagnose these conditions.

## Graceful deployment

Send `SIGTERM` and allow at least `WORKER_SHUTDOWN_DRAIN_MS` before forcefully terminating the process. The worker pauses consumers before draining active work, then closes consumers, queues, Redis, and its own database pool. If the deadline expires, command lease and provider-execution markers—not shutdown code—determine subsequent recovery. Never manually change an uncertain Gmail command to failed or retryable.

## Scheduler failures

Each scheduler records safe timestamps in runtime diagnostics and logs a safe `worker_scheduled_task_failed` error. It retries on its next configured interval without overlapping another run. Reconciliation keeps its existing immediate claim release after queue-handoff failure. Outbox events remain unpublished after enqueue failure and can be reclaimed under their existing lease rules.

## Conservative draft repair

The orphan scan only detects a draft in `creating`, `updating`, or `sending` that has no matching active/recovery command. It changes that local projection to `recovery_required` and writes a secret-free audit event. It does not call Gmail, recreate drafts, or resend messages. Investigate recovery through the existing explicit verification paths.

## Configuration

Worker configuration values are validated and bounded: identity, release, drain deadline, heartbeat period/staleness threshold, scheduler periods and batch limits, and consumer concurrency. The documented defaults are intentionally conservative. Do not put credentials, Gmail identifiers, addresses, or message content in worker metadata or diagnostics.

## Known limitations

Phase 8A has no public worker diagnostics endpoint, metrics backend, distributed tracing, dead-letter queue, or automated Gmail recovery beyond the existing explicit command recovery rules. Those remain later production-hardening work.
