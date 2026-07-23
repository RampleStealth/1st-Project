# pnpm migration baseline

Recorded before package-manager changes on branch `chore/pnpm-migration`.

## Toolchain

- Baseline commit: `14645f9`
- Local Node.js: `v24.18.0`
- Production target: Node.js 22
- npm: `11.16.0`
- Declared package manager: `npm@11.16.0`
- npm lockfile SHA-256: `AA24696FE30038609CE043343154066422E1D0D92122180EDB12F40E564D2068`

## Dependency state

- `npm ls --all --json`: passed with no missing or invalid dependency edges.
- `lucide-react@1.25.0` was present as an uncommitted root dependency.
- No application source imported `lucide-react`; its ownership is reviewed in the dependency-correction phase.

## Validation state

- `npm run check`: passed.
- `npm test`: infrastructure-limited.
  - Unit-only API, Gmail, configuration, observability, and worker-runtime tests passed.
  - PostgreSQL-backed tests loaded the local `.env` and could not connect to PostgreSQL on localhost.
  - The web test runner could not traverse the managed filesystem boundary while loading Vite.
- `npm run build:runtime`: not run after the aggregate test command failed.
- `npm run build -w @aio/web`: not run after the aggregate test command failed.

No database migration, Gmail provider action, Redis operation, package installation, or dependency upgrade was performed while recording this baseline.
