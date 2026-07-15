# Milestone 4: explicit Gmail write upgrade

Initial Gmail connection requests `gmail.readonly` only. A mailbox owner may explicitly start a separate `gmail.modify` upgrade, which covers archive, mark unread, and draft create/edit/send in later phases; this phase executes none of them.

The server stores a random, one-time Redis state for ten minutes with the authenticated user, mailbox, requested capability, and PKCE verifier. The callback consumes it with `GETDEL`, requires the same session user, verifies the Gmail profile email equals the selected mailbox, validates the returned `gmail.modify` scope, and requires a new non-empty refresh token. Existing encrypted credentials remain untouched on every failure.

Successful replacement of the encrypted refresh token, persisted scopes, `write_granted` state, and audit event occur in one database transaction. Declined and failed transitions retain read capability. OAuth codes, state, verifier, tokens, and raw provider errors are never logged.
