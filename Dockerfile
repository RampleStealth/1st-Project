FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm ci && node scripts/build-runtime.mjs api && node scripts/build-runtime.mjs worker && node scripts/build-runtime.mjs web && npm run build -w @aio/web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S aio && adduser -S aio -G aio
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/runtime ./runtime
COPY --from=build /build/apps/web/dist ./runtime/web/dist
COPY --from=build /build/packages/database/migrations ./migrations
USER aio
ENTRYPOINT ["node"]
