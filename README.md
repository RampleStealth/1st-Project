# AI Email Organizer

Milestone 1 provides secure Gmail connection lifecycle and reliable metadata synchronization.

## Local setup

1. Copy `.env.example` to `.env` and populate Google OAuth, Pub/Sub, encryption, and session values.
2. Start PostgreSQL and Redis with `docker compose up -d`.
3. Install dependencies with `npm install`.
4. Run `npm run db:migrate`.
5. Run the API and worker from their workspace scripts.

No mailbox content is logged. Gmail remains the source of truth; this milestone stores metadata and encrypted token references only.
