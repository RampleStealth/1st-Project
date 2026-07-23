# AI Email Organizer

Milestone 1 provides secure Gmail connection lifecycle and reliable metadata synchronization.

## Local setup

1. Populate `.env` with Google OAuth, Pub/Sub, encryption, and session values. Set `DRAFT_MESSAGE_ID_DOMAIN=drafts.localhost.test` for local development; production must use a DNS domain controlled by the deployment owner.
2. Start PostgreSQL and Redis with `docker compose up -d`.
3. Enable Corepack and install the pinned workspace dependencies with `pnpm install --frozen-lockfile`.
4. Run `pnpm db:migrate`.
5. Run the API and worker from their workspace scripts.

No mailbox content is logged. Gmail remains the source of truth; this milestone stores metadata and encrypted token references only.
