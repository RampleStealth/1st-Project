# syntax=docker/dockerfile:1.7

FROM node:22.23.1-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /build

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run build:runtime && pnpm --filter @aio/web run build
RUN pnpm --filter @aio/api --prod deploy --legacy /deploy/api
RUN pnpm --filter @aio/worker --prod deploy --legacy /deploy/worker
RUN pnpm --filter @aio/web --prod deploy --legacy /deploy/web
RUN pnpm --filter @aio/database --prod deploy --legacy /deploy/database
RUN cp -R packages/database/migrations /deploy/api/migrations \
    && cp -R packages/database/migrations /deploy/worker/migrations

FROM node:22.23.1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S aio && adduser -S aio -G aio
COPY --from=build --chown=aio:aio /deploy/api ./api
COPY --from=build --chown=aio:aio /deploy/worker ./worker
COPY --from=build --chown=aio:aio /deploy/web ./web
COPY --from=build --chown=aio:aio /deploy/database ./database
USER aio
ENTRYPOINT ["node"]
