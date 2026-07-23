# Production deployment and release guide

## Artifact model and topology

Build once in the supplied multi-stage `Dockerfile`. The builder bundles TypeScript into Node 22 runtime artifacts and produces the static web build; the runtime image contains production dependencies only, runs as the non-root `aio` user, and excludes `.env` files and source maps. Run the image with one explicit command per role:

- API: `node api/runtime/server.js`
- worker: `node worker/runtime/worker.js`
- web: `node web/runtime/server.js`

The image contains independent pnpm deployment roots for API, worker, web, and database tooling. Each root includes only its reviewed production dependency closure; runtime module resolution does not depend on a flat workspace-level `node_modules`.

The Docker build currently invokes `pnpm deploy --legacy` because the reviewed pnpm release otherwise requires workspace-package injection for deploy. This selects pnpm's legacy deploy implementation only: it does not enable hoisting or change the isolated development linker. Reassess the bridge when adopting a pnpm release whose standard deploy path can package the bundled internal workspaces without `injectWorkspacePackages`; remove it only after the same image startup and module-resolution gates pass.

Serve web, API, worker, PostgreSQL, Redis, and the protected diagnostics network separately. API and workers can scale horizontally; PostgreSQL and Redis are shared. Gmail and Pub/Sub are external integrations. V1 operates one Gmail account per user, one region, conservative worker concurrency, and a controlled cohort.

## Release sequence and rollback

1. Build and label the immutable image with `RELEASE_VERSION`, `RELEASE_COMMIT_SHA`, and `RELEASE_BUILT_AT`.
2. Run exactly one migration runner from the image: `node database/runtime/migrate.js`, then `node database/runtime/migration-verify.js`.
3. Deploy API instances, wait for `/readyz`, then drain/restart workers with `SIGTERM` and `WORKER_SHUTDOWN_DRAIN_MS`.
4. Run `node worker/runtime/operations.js summary` and protected diagnostics checks. Promote only when heartbeat and queue age are healthy.

Rollback application code only; migrations are additive and are not reversed automatically. Do not delete commands, outbox rows, or drafts. A release whose migration manifest is missing from the database fails before API or worker clients are constructed, preventing unsafe schema drift.

## Smoke checklist

Check the static web response, `/livez`, `/readyz`, protected diagnostics authorization, `db:verify`, queue summary, unpublished-outbox age, command backlog, and worker heartbeat. These checks never create, update, or send Gmail messages.

## Environment and secret operations

Required settings are validated by `loadConfig`; production rejects placeholders, insecure origins, invalid encryption keys, and unsafe proxy/rate-limit settings. Rotate session secrets with `SESSION_SECRET_PREVIOUS`. Rotate OAuth, Pub/Sub, diagnostics, Redis, and PostgreSQL credentials through the deployment secret store and roll instances gradually. The current encryption key is not envelope-rotatable: do not replace `TOKEN_ENCRYPTION_KEY_BASE64` in place; plan a future envelope-key migration and re-encryption process first.
