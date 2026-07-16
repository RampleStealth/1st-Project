# Security incident checklist

1. Declare the incident, preserve correlation IDs and deployment revision, and avoid copying raw OAuth, Gmail, draft, or session data into tickets.
2. For suspected session compromise, revoke affected session rows immediately; if scope is unknown, revoke all active sessions for the user or service population. Rotate `SESSION_SECRET`, retaining the old value only in `SESSION_SECRET_PREVIOUS` for the planned grace window.
3. For suspected OAuth/token compromise, disconnect the mailbox, revoke the Google grant where appropriate, rotate OAuth client credentials if impacted, and require a new consent flow. Do not log token values.
4. For encryption-secret exposure, stop writes, restrict database/Redis access, rotate the master key through a planned migration procedure, and assess encrypted historical data. Envelope-key rotation is not automatic.
5. For webhook abuse, verify Pub/Sub audience/service account configuration, inspect only safe rejection counts, and apply upstream network controls. Do not disable JWT verification to restore service.
6. For rate-limit failures, confirm Redis health. Production intentionally fails closed for browser-facing sensitive operations; restore Redis or explicitly use a time-limited, reviewed configuration change.
7. For diagnostics exposure, remove public routing, rotate `DIAGNOSTICS_TOKEN`, and review ingress/network policy. Diagnostics should never be enabled without its secret.
8. Re-run configuration validation and the security regression suite after containment. Record only safe identifiers, timestamps, correlation IDs, and remediation decisions.

`SEC-001` remains the planned coordinated upgrade of Google runtime dependencies. Do not use forced audit fixes during an incident.
