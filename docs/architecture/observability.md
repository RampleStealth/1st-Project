# Observability architecture

Phase 8B uses an import-safe in-process telemetry interface. `Metrics` exposes counters, histograms, and gauges; the default sink is a no-op and `InMemoryMetrics` is available for tests and a future exporter adapter. There is no Prometheus, OpenTelemetry exporter, or external telemetry service in this phase.

Safe context is allowlisted: correlation, request, command, mailbox, draft, worker, scheduler, operation, result, duration, and safe error code. Content, provider identifiers, emails, OAuth material, raw responses, payloads, claim tokens, and encryption data are rejected before telemetry context is produced.

## Correlation

API request correlation is stored with each new provider command and its outbox event. The dispatcher carries it in the BullMQ command job and the worker logs command completion with that same correlation. Durable audit events remain the source of record for the command lifecycle. Existing jobs without a stored correlation retain a generated migration-safe correlation value.

## Metrics catalog

- `api_requests_total`, `api_request_duration_ms`
- `gmail_requests_total`, `gmail_errors_total`, `gmail_request_duration_ms`
- `worker_jobs_total`, `worker_job_duration_ms`
- `scheduler_runs_total`, `scheduler_failures_total`, `scheduler_duration_ms`
- `queue_enqueues_total`, `queue_depth`, `unpublished_outbox`
- `active_workers`, `heartbeat_age_seconds`, `recovery_required_count`, `stale_commands`

Metric labels are limited to operation, route template, status, scheduler, queue, result, and safe error code. No business content or provider identity is a label.

## Health and alerts

The pure health model returns `healthy`, `degraded`, or `unavailable`. PostgreSQL, Redis, consumers, schedulers, heartbeat freshness, queue backlog, and recovery backlog participate. Gmail reachability does not. Normalized alert-event types are documented for stale heartbeats, queue/recovery growth, scheduler failures, dependency failure, provider-error spikes, and restart loops; external delivery is intentionally deferred.
