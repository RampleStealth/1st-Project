# Security follow-ups

## SEC-001 — Upgrade Google runtime dependencies

Status: planned; not part of the Phase 2 remediation commit.

Scope:

- Upgrade `googleapis` to 173.
- Upgrade the direct `google-auth-library` dependency to 10.x in the same change.
- Confirm `uuid@9` is absent from all production dependency paths after lockfile resolution.
- Run compile checks plus OAuth callback, Gmail list/sync, Pub/Sub token verification, and integration tests.
- Review google-auth-library v10 request/type breaking changes.
- Do not use `npm audit fix --force`.
