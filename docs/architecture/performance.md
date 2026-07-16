# Performance and capacity architecture

## Measured hot paths

Mailbox synchronization and Gmail-backed thread lists persist hydrated metadata. Before Phase 8D, every unchanged Gmail thread advanced `threads.sync_version` and rewrote its row; every unchanged message also ran an update. The projection repository now uses guarded `ON CONFLICT ... DO UPDATE` clauses, so unchanged metadata is read back without a write, WAL churn, or a version increment.

Provider-command dispatch previously claimed an outbox batch and then performed a separate command lookup for every event. The claim query now returns the immutable command type and correlation ID with the locked outbox event. Dispatch uses a bounded concurrency of five queue handoffs. Publication and release remain guarded by the dispatcher claim, so duplicate enqueue is still safe and a lost lease never overwrites another dispatcher.

## Indexing guide

`013_performance_capacity_indexes.sql` adds two partial indexes:

- `outbox_events_command_dispatch_due (event_type, created_at) WHERE published_at IS NULL` serves due command-event scans in created order without scanning published or unrelated events.
- `outbox_events_active_dispatch_claim (dispatch_claim_id) WHERE published_at IS NULL AND dispatch_claim_id IS NOT NULL` serves guarded publish and release after a queue handoff.

The existing `threads_mailbox_recent`, `threads_mailbox_provider_updated`, `messages_thread_time`, `provider_commands_due`, and partial unpublished-outbox indexes remain the primary indexes for projections, commands, and synchronization. Cursor pagination stays Gmail page-token based; offset pagination is not used.

## Scheduler and worker tuning

Schedulers already prevent overlap and use unreferenced intervals. Keep the outbox batch limit at or below 100 and raise it only with queue-latency evidence. The dispatch concurrency of five bounds Redis pressure and preserves queue ownership behavior; scale by adding worker processes rather than increasing it without observing Gmail and Redis headroom.

No new cache is introduced. The sanitized reader cache remains TTL-, entry-, and memory-bounded and is only populated after safe normalization. Gmail remains list and read authority, so thread reads never serve stale remote content from cache alone.

## Benchmark methodology

Run database migration, then execute the worker integration suite with a local PostgreSQL database. Compare `EXPLAIN (ANALYZE, BUFFERS)` for the outbox claim predicate before and after loading representative unpublished command events. Confirm the command dispatch batch performs one claim query and zero per-event provider-command lookups; queue handoffs are bounded to five concurrent operations. Projection tests assert repeated identical provider metadata does not advance `sync_version`.

Benchmarks are operational checks, not production runtime code. Record database size, PostgreSQL version, worker batch limits, and queue latency with each result; do not compare wall-clock results across different environments.

## Planning capacity limits

These are starting points, not guarantees. One API and one worker process are suitable for a single user and early pilots. At roughly 100 active users, use a dedicated worker process and monitor Gmail quota, queue wait age, outbox depth, and PostgreSQL pool saturation. At roughly 1,000 users, run multiple workers with the existing leases, tune per-process consumer concurrency conservatively, and provision PostgreSQL for projection and audit growth. At 10,000 users, Gmail quota allocation, history-sync fan-out, projection retention, and audit retention are the likely constraints; capacity testing and provider quota agreements are release gates.

The database pool, Redis, BullMQ, and Gmail quotas—not browser paging—are the first scaling limits. Do not increase concurrency beyond measured provider quota and database connection headroom.
