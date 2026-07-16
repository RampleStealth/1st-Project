# Worker runtime

The worker has a composition root matching the API runtime.

`worker.ts` is the production executable. It invokes `startWorker()` and is the only worker module that starts process work. `bootstrap.ts` loads the local environment, validates configuration, creates production dependencies, starts the runtime, and installs signal handlers. Importing `worker-runtime.ts`, `dependencies.ts`, or `bootstrap.ts` creates no Redis client, BullMQ consumer, queue, timer, Gmail client, or database work.

`createWorkerRuntime(dependencies, options)` owns the sync and provider-command consumers and the scheduler handles for outbox dispatch, command-lease recovery, Gmail watch renewal, reconciliation, conservative draft inconsistency repair, and heartbeat. Production-only construction is deferred until `createProductionWorkerDependencies(config)` is called.

The worker process owns its diagnostic Redis client, its BullMQ queue objects, its BullMQ consumers, and the shared PostgreSQL pool it constructs. The runtime closes those resources in that order after consumer draining. It does not create Gmail clients until an individual job runs.

## Lifecycle

Startup records a durable `worker_heartbeats` row, creates both consumers, writes a healthy heartbeat, and starts each scheduler once. Repeated scheduler ticks do not overlap. Watch renewal and reconciliation retain their existing initial run; other schedulers run on their configured cadence.

On shutdown the runtime enters `draining`, clears every timer, pauses both consumers, gives active jobs the configured drain period, closes both consumers, records `stopped` where possible, then closes queues, Redis, and its owned database pool. A shutdown deadline never changes Gmail command state: any provider call that was interrupted remains protected by the existing execution marker, lease, and recovery-required rules.

## Diagnostics

The runtime exports internal liveness, readiness, and diagnostics functions rather than a public HTTP listener. Liveness only reports local process state. Readiness requires the runtime to be running, both consumers to be accepting work, all scheduler handles to be active, and bounded PostgreSQL and Redis checks; it never calls Gmail.

Diagnostics return safe counts and timestamps only: worker ID and release, uptime, consumer/scheduler state, last successful heartbeat, BullMQ waiting/active/delayed/failed counts and oldest waiting age, plus unpublished-outbox, reconciliation, stale-command, and recovery-required counts. No job data, provider responses, Gmail identifiers, tokens, addresses, or message content are included.

## Conservative repair

The existing type-aware lease recovery remains responsible for expired commands. Inconsistent active draft projections with no corresponding active or recovery command are moved to `recovery_required` with a secret-free audit event. This never infers provider success, recreates a draft, or re-sends a message. Repeated scans are idempotent.
