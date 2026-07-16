# Security baseline

## Browser and session policy

The API emits a deny-by-default CSP (`default-src 'none'`), `frame-ancestors 'none'`, `nosniff`, `no-referrer`, restrictive permissions policy, COOP, and same-site CORP on every response. The web static server uses an equally restrictive first-party CSP (`script-src 'self'`, `connect-src 'self'`, no objects) and the same browser isolation headers. HSTS is emitted only in production, where configuration requires HTTPS application/API origins and an explicitly trusted TLS-terminating proxy. Received email and draft HTML remain rendered only through the existing sandboxed, CSP-constrained iframe model; neither policy is relaxed for content rendering.

Session cookies are signed, HttpOnly, path-scoped, `SameSite=Lax`, and Secure in production. The CSRF cookie remains readable by the first-party browser only and is compared to the request header. `SESSION_SECRET_PREVIOUS` permits one planned cookie-signing rotation window; database session tokens remain independently hashed and revocable. A completed initial OAuth login revokes existing sessions for that user before issuing a new random session identity. A public revoke-all-sessions product control is intentionally not added in Phase 8C; operations can revoke sessions in the existing table during an incident.

Cookie-authenticated state-changing requests require both the existing CSRF token and an exact `Origin` match to `APP_ORIGIN`. The unauthenticated initial Google OAuth start also requires that same browser-origin proof to prevent login CSRF/account-linking confusion. OAuth callbacks use their signed, one-time state/PKCE trust model; Gmail Pub/Sub uses its verified JWT trust model and is excluded from browser-origin checks.

## Request boundary

Fastify has a 600 KiB default body cap (configurable as `API_BODY_LIMIT_BYTES`; accepted range 16 KiB–2 MiB), route parameter length is capped at 1,024 characters, and Gmail webhook bodies are capped at 64 KiB (`WEBHOOK_BODY_LIMIT_BYTES`; 1 KiB–256 KiB). Draft limits remain stricter at the content-validation layer. JSON is accepted only on draft create/update and Gmail webhook routes. OAuth start, logout, archive/unread, permission start, disconnect, send, and verification require empty bodies. Declared oversize and unsupported content type are rejected before route dependencies run.

## Abuse control

The API uses an injectable fixed-window limiter. Production uses a Redis Lua script so increment and expiry are atomic; keys contain only SHA-256 digests of IP/user/mailbox dimensions and are never logged or returned. Production fails closed if Redis rate-limit enforcement is unavailable; non-production defaults to fail open for developer/test resilience. Policies are documented below; `Retry-After` and a safe `429` response are returned when exceeded.

| Category | Dimensions | Limit/window |
| --- | --- | --- |
| OAuth | IP | 20/minute |
| Mailbox reads | IP, user, mailbox | 240/minute |
| Full thread reads | IP, user, mailbox | 120/minute |
| Gmail mutations | IP, user, mailbox | 30/minute |
| Draft mutations | IP, user, mailbox | 30/minute |
| Verification | IP, user, mailbox | 10/minute |
| Logout/disconnect/write upgrade | IP, user, mailbox | 20/minute |
| Protected diagnostics | IP | 20/minute |

Gmail webhooks are not subject to browser policies; verified Google identity and idempotent history processing are the protection boundary.

## OAuth, webhook, and diagnostics boundaries

OAuth uses random state, Redis one-time `GETDEL`, ten-minute expiry, PKCE S256, fixed callbacks, account identity checks, scope validation, guarded permission transitions, and token replacement only after a usable confirmed grant. Authorization codes, state, verifiers, and token responses are not logged. Gmail webhook handling verifies Bearer format, Pub/Sub JWT audience, the expected service account, bounded JSON/base64 input, and decimal history IDs. Duplicate pushes remain safe because pending history advancement is idempotent; Pub/Sub does not provide a useful bounded replay identifier beyond this correctness boundary.

`/health` and `/livez` are dependency-free. `/readyz` returns only `ready` or `unavailable`. `/diagnostics` is not registered unless `DIAGNOSTICS_TOKEN` is configured, and then requires the dedicated request header and returns only a coarse status. No health route contains mailbox, Gmail, command, user, token, or topology data.

## Configuration and secrets

Configuration validates decoded 32-byte encryption keys, non-placeholder session secrets, HTTPS production origins, callback/audience consistency, Pub/Sub project/topic consistency, bounded numeric settings, and proxy trust. Validation messages name configuration fields but never print values. Secret owners rotate `SESSION_SECRET` through `SESSION_SECRET_PREVIOUS`; OAuth client, token-encryption, Pub/Sub, and diagnostic secrets are rotated through coordinated operational change. Envelope-key rotation is not implemented and remains a planned maintenance operation.

Default Fastify request logging is disabled because query strings can contain OAuth state and authorization codes. Explicit application telemetry remains correlation-based and redacted.

## Threat model

| Threat | Asset / attacker / entry point | Existing + Phase 8C controls | Residual risk |
| --- | --- | --- | --- |
| Session theft | Browser session / XSS or device attacker / cookie | HttpOnly, Secure production cookies, SameSite, signed + hashed server sessions, logout/revocation | A compromised browser can act until detected; incident revokes sessions. |
| CSRF and login CSRF | Account linkage / hostile site / browser POST | CSRF token plus exact Origin; OAuth start requires same-origin intent; state + PKCE callback binding | Browser extensions or compromised first-party origin remain trusted. |
| OAuth replay/account confusion | Tokens/mailbox / callback attacker / OAuth redirect | One-time expiring state, PKCE, fixed redirects, Gmail identity comparison, scope validation | OAuth provider compromise is out of scope. |
| Cross-mailbox access | Mail metadata/content / authenticated attacker / route IDs | Owner-scoped repository lookups before decrypt/provider access | Authorization regressions require ongoing regression coverage. |
| Webhook forgery/replay | Sync correctness / internet attacker / Pub/Sub POST | JWT signature/audience/service account, bounded body, idempotent history watermark flow | Valid Google deliveries can be delayed/repeated. |
| Command/idempotency abuse | Gmail mutation / user or attacker / command routes | UUID idempotency, encrypted minimal payloads, claims/leases, rate limits | A legitimate user can still consume their assigned Gmail quota. |
| Queue poisoning | Worker / internal attacker / outbox jobs | Typed payload registry, claim-verified decryption, safe unsupported-command failure | Redis/database administrative compromise remains high impact. |
| Content/XSS/SSRF | Email/draft content / sender / HTML | Server sanitization, plain-text fallback, sandboxed no-network iframe, strict API CSP | Sanitizer defects need dependency and regression review. |
| Leakage | Tokens/content / operator or log reader / logs/metrics/audits | Safe provider sanitizers, redaction, no automatic URL logging, secret-free telemetry/audits | Application programming errors may still require incident review. |
| Large-request/rate abuse | API/Redis/Gmail quota / remote attacker / requests | Body limits, strict content type/empty body policy, IP/user/mailbox fixed-window limits | Distributed source IP abuse requires perimeter/WAF controls. |
| Operational endpoint compromise | Health data / network attacker / diagnostics | Diagnostics opt-in, dedicated secret, coarse response, rate limit | Network isolation remains deployment responsibility. |
