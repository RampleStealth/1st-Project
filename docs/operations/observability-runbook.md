# Observability runbook

Use runtime diagnostics and safe structured logs to investigate operations. Never inspect message content, encrypted payloads, provider IDs, or raw provider responses.

- `unavailable`: restore PostgreSQL, Redis, consumers, or scheduler operation first.
- `degraded`: assess queue depth and `recovery_required` growth; do not force-retry uncertain Gmail commands.
- stale heartbeat: confirm the process lifecycle, then use graceful restart and the worker drain procedure.
- scheduler failures: inspect only scheduler name, safe error code, duration, and correlation; the next scheduled run is non-overlapping.
- provider-error spikes: use operation and safe classification to decide whether Gmail throttling or reauthorization is involved. Do not use telemetry to replay commands.

Future OpenTelemetry or Prometheus integrations should adapt the existing `Metrics`/trace interfaces rather than changing application call sites.
