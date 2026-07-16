import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "@aio/config";
import type { Pool, PoolClient } from "pg";
import { logger } from "@aio/observability";
import { createApiApp, type ApiAppDependencies } from "./app.js";
import { InMemoryRateLimiter, createRedisRateLimiter, type RateLimiter } from "./rate-limit.js";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: "test", APP_ORIGIN: "http://app.example.test", API_ORIGIN: "http://app.example.test",
    DATABASE_URL: "postgres://user:password@localhost:5432/aio", REDIS_URL: "redis://localhost:6379",
    GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret-value-not-placeholder", GOOGLE_REDIRECT_URI: "http://app.example.test/v1/auth/google/callback",
    GOOGLE_PUBSUB_TOPIC: "projects/project/topics/topic", GOOGLE_CLOUD_PROJECT: "project", PUBSUB_PUSH_AUDIENCE: "http://app.example.test/v1/webhooks/gmail", PUBSUB_SERVICE_ACCOUNT_EMAIL: "push@example.test",
    GMAIL_INITIAL_SYNC_LIMIT: 500, SYNC_RECONCILIATION_INTERVAL_MINUTES: 30, TOKEN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 8).toString("base64"), SESSION_SECRET: "a".repeat(32),
    TRUST_PROXY: false, API_BODY_LIMIT_BYTES: 16 * 1024, WEBHOOK_BODY_LIMIT_BYTES: 8 * 1024, PORT: 4000, WEB_PORT: 3000, ...overrides
  };
}

function dependencies(options: { config?: AppConfig; rateLimiter?: RateLimiter; calls?: { redisSet: number } } = {}): ApiAppDependencies {
  const currentConfig = options.config ?? config(); const calls = options.calls ?? { redisSet: 0 };
  const client = { query: async (text: string) => text.startsWith("SELECT user_id") ? ({ rows: [{ id: "11111111-1111-4111-8111-111111111111" }], rowCount: 1 }) : ({ rows: [], rowCount: 0 }) } as unknown as PoolClient;
  return {
    config: currentConfig, logger, pool: client as unknown as Pool,
    redis: { set: async () => { calls.redisSet += 1; return "OK"; }, getdel: async () => null, quit: async () => "OK", ping: async () => "PONG" } as never,
    pubsubVerifier: {} as never, sanitizedThreadCache: { key: () => "", get: () => undefined, set: () => undefined } as never,
    withTransaction: async (fn) => fn(client), findMailboxForUser: async () => null, ensureMailboxSyncState: async () => undefined, recordPendingHistory: async () => undefined, enqueueSync: async () => undefined,
    insertProviderCommand: async () => ({ id: "command", commandType: "archive_thread", status: "pending" }), createDraftWithCommand: async () => ({ id: "command", commandType: "create_draft", status: "pending", draftId: "00000000-0000-4000-8000-000000000001" }), updateDraftWithCommand: async () => ({ id: "command", commandType: "update_draft", status: "pending", draftId: "00000000-0000-4000-8000-000000000001" }), sendDraftWithCommand: async () => ({ id: "command", commandType: "send_draft", status: "pending", draftId: "00000000-0000-4000-8000-000000000001" }),
    findDraftForUser: async () => null, findSendRecoveryCommandForUser: async () => null, enqueueSendDraftVerification: async () => undefined,
    isIdempotencyConflictError: () => false, isDraftRevisionConflictError: () => false, isDraftStateConflictError: () => false, isActiveDraftCommandError: () => false,
    rateLimiter: options.rateLimiter
  };
}

test("security headers are strict in production and omit HSTS outside production", async () => {
  const production = await createApiApp(dependencies({ config: config({ NODE_ENV: "production", APP_ORIGIN: "https://app.example.test", API_ORIGIN: "https://app.example.test", GOOGLE_REDIRECT_URI: "https://app.example.test/v1/auth/google/callback", PUBSUB_PUSH_AUDIENCE: "https://app.example.test/v1/webhooks/gmail", TRUST_PROXY: true }) }));
  const response = await production.inject({ method: "GET", url: "/health" });
  assert.equal(response.headers["content-security-policy"], "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  assert.equal(response.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
  assert.equal(response.headers["x-content-type-options"], "nosniff"); assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["cross-origin-resource-policy"], "same-site"); assert.doesNotMatch(response.headers["content-security-policy"]!, /unsafe-inline|\*/);
  await production.close();
  const development = await createApiApp(dependencies()); const dev = await development.inject({ method: "GET", url: "/health" });
  assert.equal(dev.headers["strict-transport-security"], undefined); await development.close();
});

test("origin, body, and content-type guards reject before OAuth state storage", async () => {
  const calls = { redisSet: 0 }; const app = await createApiApp(dependencies({ calls }));
  for (const headers of [{}, { origin: "not-a-url" }, { origin: "https://attacker.example" }]) {
    const response = await app.inject({ method: "POST", url: "/v1/auth/google/start", headers }); assert.deepEqual(response.json(), { code: "origin_forbidden" });
  }
  assert.equal(calls.redisSet, 0);
  const oversized = await app.inject({ method: "POST", url: "/v1/auth/google/start", headers: { origin: config().APP_ORIGIN, "content-length": "16385" } });
  assert.deepEqual(oversized.json(), { code: "request_too_large" }); assert.equal(calls.redisSet, 0);
  const wrongType = await app.inject({ method: "POST", url: "/v1/auth/google/start", headers: { origin: config().APP_ORIGIN, "content-type": "text/plain" } });
  assert.deepEqual(wrongType.json(), { code: "unsupported_content_type" }); assert.equal(calls.redisSet, 0);
  const valid = await app.inject({ method: "POST", url: "/v1/auth/google/start", headers: { origin: config().APP_ORIGIN } });
  assert.equal(valid.statusCode, 302); assert.equal(calls.redisSet, 1); await app.close();
});

test("authenticated browser mutations require exact origin before route CSRF validation", async () => {
  const app = await createApiApp(dependencies()); const session = app.signCookie("session-token");
  const base = { cookie: `aio_session=${session}; aio_csrf=csrf`, "x-csrf-token": "csrf" };
  assert.deepEqual((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: base })).json(), { code: "origin_forbidden" });
  assert.deepEqual((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { ...base, origin: "https://attacker.example" } })).json(), { code: "origin_forbidden" });
  assert.deepEqual((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { ...base, origin: config().APP_ORIGIN, "x-csrf-token": "wrong" } })).json(), { code: "csrf_failed", message: "Refresh the page and try again." });
  assert.equal((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { ...base, origin: config().APP_ORIGIN } })).statusCode, 204); await app.close();
});

test("rate limiting is isolated by opaque dimensions and blocks work before OAuth state insertion", async () => {
  let now = 0; const limiter = new InMemoryRateLimiter(() => now);
  const input = { category: "oauth", dimension: "ip" as const, identifier: "127.0.0.1", limit: 2, windowMs: 1_000 };
  assert.equal((await limiter.consume(input)).allowed, true); assert.equal((await limiter.consume(input)).allowed, true); assert.equal((await limiter.consume(input)).allowed, false);
  assert.equal((await limiter.consume({ ...input, identifier: "127.0.0.2" })).allowed, true); now = 1_000; assert.equal((await limiter.consume(input)).allowed, true);
  const calls = { redisSet: 0 }; const denied: RateLimiter = { consume: async () => ({ allowed: false, retryAfterSeconds: 9 }) };
  const app = await createApiApp(dependencies({ calls, rateLimiter: denied })); const response = await app.inject({ method: "POST", url: "/v1/auth/google/start", headers: { origin: config().APP_ORIGIN } });
  assert.equal(response.statusCode, 429); assert.equal(response.headers["retry-after"], "9"); assert.deepEqual(response.json(), { code: "rate_limited", retryAfterSeconds: 9 }); assert.equal(calls.redisSet, 0); await app.close();
});

test("Redis rate limiting is atomic, opaque, and has an explicit availability policy", async () => {
  let receivedKey = "";
  const redis = { eval: async (_script: string, _keys: number, ...args: Array<string | number>) => { receivedKey = String(args[0]); return [0, 2_500]; } };
  const denied = await createRedisRateLimiter(redis, "fail_closed").consume({ category: "gmail_mutation", dimension: "mailbox", identifier: "33333333-3333-4333-8333-333333333333", limit: 1, windowMs: 60_000 });
  assert.deepEqual(denied, { allowed: false, retryAfterSeconds: 3 }); assert.match(receivedKey, /^aio:rate-limit:v1:gmail_mutation:mailbox:[A-Za-z0-9_-]+$/); assert.doesNotMatch(receivedKey, /33333333/);
  const failing = { eval: async () => { throw new Error("redis unavailable"); } };
  assert.deepEqual(await createRedisRateLimiter(failing, "fail_closed").consume({ category: "oauth", dimension: "ip", identifier: "127.0.0.1", limit: 1, windowMs: 1_000 }), { allowed: false, retryAfterSeconds: 1 });
  assert.deepEqual(await createRedisRateLimiter(failing, "fail_open").consume({ category: "oauth", dimension: "ip", identifier: "127.0.0.1", limit: 1, windowMs: 1_000 }), { allowed: true, retryAfterSeconds: 0 });
});

test("diagnostics are absent unless protected and never expose dependency detail", async () => {
  const unavailable = await createApiApp(dependencies()); assert.equal((await unavailable.inject({ method: "GET", url: "/diagnostics" })).statusCode, 404); await unavailable.close();
  const protectedApp = await createApiApp(dependencies({ config: config({ DIAGNOSTICS_TOKEN: "d".repeat(32) }) }));
  assert.equal((await protectedApp.inject({ method: "GET", url: "/diagnostics" })).statusCode, 404);
  const response = await protectedApp.inject({ method: "GET", url: "/diagnostics", headers: { "x-operational-token": "d".repeat(32) } });
  assert.deepEqual(response.json(), { status: "healthy" }); assert.equal(JSON.stringify(response.json()).match(/redis|database|token|topology/i), null); await protectedApp.close();
});
